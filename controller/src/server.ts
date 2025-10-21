import express from 'express';
import cors from 'cors';
import pino from 'pino';
import pinoHttp from 'pino-http';
import * as k8s from '@kubernetes/client-node';
import { v4 as uuidv4 } from 'uuid';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { createSessionJWT, getJWKS } from './sessionJwt.js';
import { pool, checkDatabaseHealth } from './db.js';
import rateLimit from 'express-rate-limit';
import { validateCodeUrl, validateCommand, validateChecksum, validatePrompt } from './validation.js';
import { asyncHandler } from './asyncHandler.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['https://yourdomain.com', 'https://app.yourdomain.com'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      log.warn({ origin }, 'CORS request from unauthorized origin');
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  maxAge: 86400 // 24 hours
}));
app.use(express.json({ limit: '1mb' }));
app.use(pinoHttp({ logger: log }));

initializeApp({ credential: applicationDefault() });

const port = Number(process.env.PORT || 8080);
const namespace = process.env.NAMESPACE || 'ws-cli';
const runnerImage = process.env.RUNNER_IMAGE || 'REPLACEME';
const ttlSeconds = Number(process.env.JOB_TTL_SECONDS || 300);
const adSeconds = Number(process.env.JOB_ACTIVE_DEADLINE_SECONDS || 3600);
const sessionExpirySeconds = 10 * 60;

// Per-user session creation rate limit
const sessionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 sessions per minute per user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Rate limit by user ID
    const user = (req as any).user;
    return user ? user.uid : req.ip;
  },
  handler: (req, res) => {
    const user = (req as any).user;
    log.warn({ userId: user?.uid, ip: req.ip }, 'Rate limit exceeded for session creation');
    res.status(429).json({
      error: 'Too many sessions created. Please wait before creating more.',
      retryAfter: 60
    });
  },
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/healthz';
  }
});

// Global rate limit (backup protection)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100, // 100 requests per minute globally
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    log.error({ ip: req.ip, path: req.path }, 'Global rate limit exceeded');
    res.status(429).json({ error: 'Server is under heavy load. Please try again later.' });
  }
});

app.use(globalLimiter);

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const batch = kc.makeApiClient(k8s.BatchV1Api);
const core = kc.makeApiClient(k8s.CoreV1Api);

async function requireFirebaseUser(req:any,res:any,next:any){
  try {
    const authz = req.headers['authorization'] || '';
    if (!authz.startsWith('Bearer ')) return res.status(401).json({ error:'missing bearer' });
    const idToken = authz.slice(7);
    const decoded = await getAuth().verifyIdToken(idToken, true);
    (req as any).user = { uid: decoded.uid, email: decoded.email, claims: decoded };
    next();
  } catch (e:any) {
    req.log?.warn({err:e}, 'firebase verify failed');
    res.status(401).json({ error: 'unauthenticated' });
  }
}

app.get('/healthz', async (req, res) => {
  const dbHealthy = await checkDatabaseHealth();
  if (dbHealthy) {
    res.status(200).json({ status: 'ok', database: 'connected' });
  } else {
    res.status(503).json({ status: 'degraded', database: 'disconnected' });
  }
});

// Add readiness check
app.get('/readyz', async (req, res) => {
  const dbHealthy = await checkDatabaseHealth();
  if (dbHealthy) {
    res.status(200).send('ready');
  } else {
    res.status(503).send('not ready');
  }
});
app.get('/.well-known/jwks.json', async (_req, res) => {
  const jwks = await getJWKS();
  res.json(jwks);
});

app.post('/api/sessions', sessionLimiter, requireFirebaseUser, asyncHandler(async (req,res)=>{
  const user = (req as any).user;
  const { code_url, code_checksum_sha256, command, prompt } = req.body || {};

  // Validate all inputs
  const urlValidation = validateCodeUrl(code_url);
  if (!urlValidation.valid) {
    return res.status(400).json({ error: urlValidation.error });
  }

  const checksumValidation = validateChecksum(code_checksum_sha256);
  if (!checksumValidation.valid) {
    return res.status(400).json({ error: checksumValidation.error });
  }

  const commandValidation = validateCommand(command || 'npm run build && node dist/index.js run');
  if (!commandValidation.valid) {
    return res.status(400).json({ error: commandValidation.error });
  }

  const promptValidation = validatePrompt(prompt);
  if (!promptValidation.valid) {
    return res.status(400).json({ error: promptValidation.error });
  }

  const sessionId = uuidv4();
  const jobName = `wscli-${sessionId.slice(0,13)}`;
  const sessionExpires = new Date(Date.now() + sessionExpirySeconds * 1000);

  const job:any = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: jobName, namespace },
    spec: {
      ttlSecondsAfterFinished: ttlSeconds,
      activeDeadlineSeconds: adSeconds,
      backoffLimit: 0,
      template: {
        metadata: { labels: { app: 'ws-cli-runner', session: sessionId } },
        spec: {
          restartPolicy: 'Never',
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1001,
            fsGroup: 1001,
            seccompProfile: {
              type: 'RuntimeDefault'
            }
          },
          containers: [{
            name: 'runner',
            image: runnerImage,
            imagePullPolicy: 'IfNotPresent',
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: false,
              runAsNonRoot: true,
              runAsUser: 1001,
              capabilities: {
                drop: ['ALL']
              }
            },
            env: [
              { name:'CODE_URL', value:String(code_url) },
              { name:'CODE_CHECKSUM_SHA256', value:String(code_checksum_sha256||'') },
              { name:'COMMAND', value:String(command||'npm run build && node dist/index.js run') },
              { name:'CLAUDE_PROMPT', value:String(prompt||'Analyze the authentication system and suggest improvements') },
            ],
            ports: [{ name:'ws', containerPort:7681 }],
            resources: {
              requests:{cpu:'200m',memory:'256Mi'},
              limits:{cpu:'1',memory:'1Gi'}
            }
          }]
        }
      }
    }
  };

  await batch.createNamespacedJob(namespace, job);
  await pool.query(
    'INSERT INTO sessions (session_id, owner_user_id, job_name, expires_at) VALUES ($1, $2, $3, $4)',
    [sessionId, user.uid, jobName, sessionExpires]
  );

  // Improved pod polling with timeout
  let podIP: string | undefined;
  const maxAttempts = 30; // Reduced from 60
  const delayMs = 1000;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const pods = await core.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `job-name=${jobName}`
      );
      const pod = pods.body.items.find(p => p.status?.podIP);

      if (pod) {
        podIP = pod.status?.podIP;
        await pool.query(
          'UPDATE sessions SET pod_ip = $1, pod_name = $2 WHERE session_id = $3',
          [podIP, pod.metadata?.name, sessionId]
        );
        break;
      }
    } catch (err) {
      log.warn({ err, attempt: i, jobName }, 'Error checking pod status');
    }

    await new Promise(r => setTimeout(r, delayMs));
  }

  if (!podIP) {
    log.error({ sessionId, jobName }, 'Failed to get pod IP after polling');
    return res.status(500).json({
      error: 'Failed to start session. Please try again.',
      sessionId // Include for debugging
    });
  }

  const { jti, token } = await createSessionJWT({
    sub: user.uid,
    sid: sessionId,
    aud: 'ws',
    expSec: sessionExpirySeconds
  });

  await pool.query(
    'INSERT INTO token_jti (jti, session_id, expires_at) VALUES ($1, $2, $3)',
    [jti, sessionId, sessionExpires]
  );

  res.json({ sessionId, wsUrl:`/ws/${sessionId}`, token });
}));

app.get('/api/sessions/:id', requireFirebaseUser, asyncHandler(async (req,res)=>{
  const user = (req as any).user;
  const sessionId = req.params.id;

  // Validate session ID format
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID format' });
  }

  const { rows } = await pool.query(
    'SELECT * FROM sessions WHERE session_id = $1',
    [sessionId]
  );

  const session = rows[0];
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.owner_user_id !== user.uid) {
    log.warn({ sessionId, userId: user.uid, ownerId: session.owner_user_id }, 'Unauthorized session access attempt');
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.json(session);
}));

const server = app.listen(port, ()=>log.info({port},'controller listening'));

// Global error handler (should be last)
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  log.error({ err, path: req.path, method: req.method }, 'Unhandled error');

  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});