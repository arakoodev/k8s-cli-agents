import express from 'express';
import cors from 'cors';
import pino from 'pino';
import pinoHttp from 'pino-http';
import * as k8s from '@kubernetes/client-node';
import { v4 as uuidv4 } from 'uuid';
import httpProxy from 'http-proxy';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { createSessionJWT, verifySessionJWT } from './sessionJwt.js';

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

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const batch = kc.makeApiClient(k8s.BatchV1Api);
const core = kc.makeApiClient(k8s.CoreV1Api);

type Session = { ownerUserId: string; jobName: string; podName?: string; podIP?: string; };
const sessions = new Map<string, Session>();

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

app.post('/api/sessions', requireFirebaseUser, async (req,res)=>{
  const user = (req as any).user;
  const { code_url, code_checksum_sha256, command, prompt } = req.body || {};
  if (!code_url) return res.status(400).json({ error:'code_url required' });

  const sessionId = uuidv4();
  const jobName = `wscli-${sessionId.slice(0,8)}`;

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
              // { name:'ANTHROPIC_API_KEY', valueFrom:{ secretKeyRef:{ name:'anthropic', key:'apiKey' } } }
            ],
            ports: [{ name:'ws', containerPort:7681 }],
            resources: { requests:{cpu:'200m',memory:'256Mi'}, limits:{cpu:'1',memory:'1Gi'} }
          }]
        }
      }
    }
  };

  await batch.createNamespacedJob(namespace, job);
  sessions.set(sessionId, { ownerUserId: user.uid, jobName });

  // wait for podIP (light polling) or let client poll /api/sessions/:id
  for (let i=0;i<60;i++){
    const pods = await core.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, `job-name=${jobName}`);
    const pod = pods.body.items.find(p=>p.status?.podIP);
    if (pod) {
      const s = sessions.get(sessionId)!;
      s.podName = pod.metadata?.name;
      s.podIP = pod.status?.podIP || undefined;
      sessions.set(sessionId, s);
      break;
    }
    await new Promise(r=>setTimeout(r,1000));
  }

  const token = await createSessionJWT({ sub:user.uid, sid:sessionId, aud:'ws', expSec:10*60 });
  res.json({ sessionId, wsUrl:`/ws/${sessionId}`, token });
});

app.get('/api/sessions/:id', requireFirebaseUser, async (req,res)=>{
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error:'not found' });
  if (s.ownerUserId !== (req as any).user.uid) return res.status(403).json({ error:'forbidden' });
  res.json(s);
});

const proxy = httpProxy.createProxyServer({ ws:true, changeOrigin:true });
const server = app.listen(port, ()=>log.info({port},'controller listening'));

server.on('upgrade', async (req:any, socket:any, head:any)=>{
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const m = url.pathname.match(/^\/ws\/(.+)$/);
    if (!m) return socket.destroy();
    const sessionId = m[1];

    const authz = req.headers['authorization'] || '';
    const proto = req.headers['sec-websocket-protocol'] as string | undefined;
    const fromHeader = authz.startsWith('Bearer ')?authz.slice(7):undefined;
    const fromProto = proto?.split(',').map(s=>s.trim()).find(s=>s && s!=='bearer');
    const token = fromHeader || fromProto || url.searchParams.get('token') || '';
    if (!token) return socket.destroy();

    const claims:any = await verifySessionJWT(token, 'ws');
    if (claims.sid !== sessionId) return socket.destroy();

    const s = sessions.get(sessionId);
    if (!s || !s.podIP) return socket.destroy();

    const target = `http://${s.podIP}:7681/`;
    proxy.ws(req, socket, head, { target });
  } catch {
    try { socket.destroy(); } catch {}
  }
});
