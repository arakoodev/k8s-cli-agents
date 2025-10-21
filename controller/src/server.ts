import express from 'express';
import cors from 'cors';
import pino from 'pino';
import pinoHttp from 'pino-http';
import * as k8s from '@kubernetes/client-node';
import { v4 as uuidv4 } from 'uuid';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { createSessionJWT, getJWKS } from './sessionJwt.js';
import { pool } from './db.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));
app.use(pinoHttp({ logger: log }));

initializeApp({ credential: applicationDefault() });

const port = Number(process.env.PORT || 8080);
const namespace = process.env.NAMESPACE || 'ws-cli';
const runnerImage = process.env.RUNNER_IMAGE || 'REPLACEME';
const ttlSeconds = Number(process.env.JOB_TTL_SECONDS || 300);
const adSeconds = Number(process.env.JOB_ACTIVE_DEADLINE_SECONDS || 3600);
const sessionExpirySeconds = 10 * 60;

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

app.get('/healthz', (_req,res)=>res.send('ok'));
app.get('/.well-known/jwks.json', async (_req, res) => {
  const jwks = await getJWKS();
  res.json(jwks);
});

app.post('/api/sessions', requireFirebaseUser, async (req,res)=>{
  const user = (req as any).user;
  const { code_url, code_checksum_sha256, command, prompt } = req.body || {};
  if (!code_url) return res.status(400).json({ error:'code_url required' });

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
          containers: [{
            name: 'runner',
            image: runnerImage,
            imagePullPolicy: 'IfNotPresent',
            env: [
              { name:'CODE_URL', value:String(code_url) },
              { name:'CODE_CHECKSUM_SHA256', value:String(code_checksum_sha256||'') },
              { name:'COMMAND', value:String(command||'npm run build && node dist/index.js run') },
              { name:'CLAUDE_PROMPT', value:String(prompt||'Analyze the authentication system and suggest improvements') },
            ],
            ports: [{ name:'ws', containerPort:7681 }],
            resources: { requests:{cpu:'200m',memory:'256Mi'}, limits:{cpu:'1',memory:'1Gi'} }
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

  // This polling is not ideal, but it's a simple way to get the pod IP.
  // A better solution would be to use a Kubernetes informer or a watch.
  let podIP: string | undefined;
  for (let i=0;i<60;i++){
    const pods = await core.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, `job-name=${jobName}`);
    const pod = pods.body.items.find(p=>p.status?.podIP);
    if (pod) {
      podIP = pod.status?.podIP;
      await pool.query(
        'UPDATE sessions SET pod_ip = $1, pod_name = $2 WHERE session_id = $3',
        [podIP, pod.metadata?.name, sessionId]
      );
      break;
    }
    await new Promise(r=>setTimeout(r,1000));
  }

  if (!podIP) {
    return res.status(500).json({ error: 'failed to get pod IP' });
  }

  const { jti, token } = await createSessionJWT({ sub:user.uid, sid:sessionId, aud:'ws', expSec:sessionExpirySeconds });
  await pool.query(
    'INSERT INTO token_jti (jti, session_id, expires_at) VALUES ($1, $2, $3)',
    [jti, sessionId, sessionExpires]
  );

  res.json({ sessionId, wsUrl:`/ws/${sessionId}`, token });
});

app.get('/api/sessions/:id', requireFirebaseUser, async (req,res)=>{
  const { rows } = await pool.query('SELECT * FROM sessions WHERE session_id = $1', [req.params.id]);
  const session = rows[0];
  if (!session) return res.status(404).json({ error:'not found' });
  if (session.owner_user_id !== (req as any).user.uid) return res.status(403).json({ error:'forbidden' });
  res.json(session);
});

const server = app.listen(port, ()=>log.info({port},'controller listening'));