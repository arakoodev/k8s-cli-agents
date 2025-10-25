import express from 'express';
import cors from 'cors';
import pino from 'pino';
import pinoHttp from 'pino-http';
import * as k8s from '@kubernetes/client-node';
import { v4 as uuidv4 } from 'uuid';
import { createSessionJWT, getJWKS } from './sessionJwt.js';
import { pool, checkDatabaseHealth, closeDatabasePool } from './db.js';
import rateLimit from 'express-rate-limit';
import { validateCodeUrl, validateCommand, validateChecksum, validatePrompt } from './validation.js';
import { asyncHandler } from './asyncHandler.js';
import { randomUUID } from 'crypto';

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
app.use(pinoHttp({
  logger: log,
  genReqId: function (req, res) {
    const existingId = req.id ?? req.headers["x-request-id"];
    if (existingId) return existingId;
    const id = randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  }
}));

const port = Number(process.env.PORT || 8080);
const apiKey = process.env.API_KEY;
const namespace = process.env.NAMESPACE || 'ws-cli';
const runnerImage = process.env.RUNNER_IMAGE || 'REPLACEME';
const jobTtlSeconds = Number(process.env.JOB_TTL_SECONDS || 300);
const jobActiveDeadlineSeconds = Number(process.env.JOB_ACTIVE_DEADLINE_SECONDS || 3600);
const sessionExpirySeconds = Number(process.env.SESSION_EXPIRY_SECONDS || 10 * 60);

// Per-IP session creation rate limit
const sessionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 sessions per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Rate limit by IP address
    return req.ip || 'unknown';
  },
  handler: (req, res) => {
    log.warn({ ip: req.ip }, 'Rate limit exceeded for session creation');
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

// Simple API key authentication middleware
function requireApiKey(req:any,res:any,next:any){
  const authz = req.headers['authorization'] || '';
  if (!authz.startsWith('Bearer ')) {
    log.warn({ ip: req.ip }, 'Missing Bearer token');
    return res.status(401).json({ error:'Missing Authorization header with Bearer token' });
  }

  const token = authz.slice(7);

  if (!apiKey) {
    log.error('API_KEY environment variable not set');
    return res.status(500).json({ error:'Server configuration error' });
  }

  if (token !== apiKey) {
    log.warn({ ip: req.ip }, 'Invalid API key attempt');
    return res.status(401).json({ error:'Invalid API key' });
  }

  // Set req.clientId for logging (using IP as identifier)
  (req as any).clientId = req.ip || 'unknown';
  next();
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

app.post('/api/sessions', sessionLimiter, requireApiKey, asyncHandler(async (req,res)=>{
  const clientId = (req as any).clientId; // IP address
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
      ttlSecondsAfterFinished: jobTtlSeconds,
      activeDeadlineSeconds: jobActiveDeadlineSeconds,
      backoffLimit: 0,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'cliscale-runner',
            'app.kubernetes.io/component': 'runner',
            'app.kubernetes.io/instance': sessionId,
            'session': sessionId
          }
        },
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
    [sessionId, clientId, jobName, sessionExpires]
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

  // Create short-lived RS256 JWT for WebSocket authentication
  const { jti, token } = await createSessionJWT({
    sub: clientId,
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

app.get('/api/sessions/:id', requireApiKey, asyncHandler(async (req,res)=>{
  const clientId = (req as any).clientId;
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

  if (session.owner_user_id !== clientId) {
    log.warn({ sessionId, clientId, ownerId: session.owner_user_id }, 'Unauthorized session access attempt');
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.json(session);
}));

// Global error handler (should be last)
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  log.error({ err, path: req.path, method: req.method }, 'Unhandled error');

  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Export the app for testing
export { app };

// Only start the server if not in test mode
// In production/development, NODE_ENV will be 'production' or undefined
// In tests, NODE_ENV will be 'test'
if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(port, ()=>log.info({port},'controller listening'));

  const gracefulShutdown = async (signal: string) => {
    log.warn(`${signal} received, shutting down`);
    server.close(async () => {
      log.info('HTTP server closed');
      await closeDatabasePool();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}