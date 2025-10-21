import http from 'http';
import httpProxy from 'http-proxy';
import pino from 'pino';
import pg from 'pg';
import { verifySessionJWT } from './sessionJwt';

const { Pool } = pg;
const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const port = Number(process.env.PORT || 8080);

// Lazy load controller URL to allow tests to set it before first use
function getControllerUrl() {
  return process.env.CONTROLLER_URL || 'http://localhost:8080';
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false
});

pool.on('error', (err) => {
  log.error({ err }, 'database pool error');
});

const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

export const app = http.createServer((req, res) => {
  // Add health check endpoint
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

app.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const m = url.pathname.match(/^\/ws\/(.+)$/);
    if (!m) {
      log.warn('invalid ws path');
      return socket.destroy();
    }
    const sessionId = m[1];

    const proto = req.headers['sec-websocket-protocol'] as string | undefined;
    const fromProto = proto?.split(',').map(s=>s.trim()).find(s=>s.startsWith('bearer,'));
    const token = fromProto?.slice(7) || url.searchParams.get('token') || '';
    if (!token) {
      log.warn('missing token');
      return socket.destroy();
    }

    const jwksUrl = `${getControllerUrl()}/.well-known/jwks.json`;
    const claims: any = await verifySessionJWT(token, 'ws', jwksUrl);
    if (claims.sid !== sessionId) {
      log.warn('sid mismatch');
      return socket.destroy();
    }

    // Check JTI replay
    const { rows: jtiRows } = await pool.query('SELECT session_id FROM token_jti WHERE jti = $1', [claims.jti]);
    if (jtiRows.length === 0) {
      log.warn('jti not found');
      return socket.destroy();
    }
    // Delete JTI to prevent replay
    await pool.query('DELETE FROM token_jti WHERE jti = $1', [claims.jti]);


    const { rows } = await pool.query('SELECT pod_ip FROM sessions WHERE session_id = $1', [sessionId]);
    const session = rows[0];
    if (!session || !session.pod_ip) {
      log.warn({ sessionId }, 'session or pod_ip not found');
      return socket.destroy();
    }

    const target = `http://${session.pod_ip}:7681/`;
    proxy.ws(req, socket, head, { target });
  } catch (err) {
    log.error({ err }, 'upgrade error');
    try { socket.destroy(); } catch {}
  }
});

if (require.main === module) {
  app.listen(port, () => log.info({ port }, 'ws-gateway listening'));
}