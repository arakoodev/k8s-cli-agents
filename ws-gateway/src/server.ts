import http from 'http';
import httpProxy from 'http-proxy';
import pino from 'pino';
import pg from 'pg';
import { verifySessionJWT } from './sessionJwt.js';

const { Pool } = pg;
const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const port = Number(process.env.PORT || 8080);

// Lazy load controller URL to allow tests to set it before first use
function getControllerUrl() {
  return process.env.CONTROLLER_URL || 'http://localhost:8080';
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: process.env.DB_MAX_CONNECTIONS ? parseInt(process.env.DB_MAX_CONNECTIONS) : 20,
  idleTimeoutMillis: process.env.DB_IDLE_TIMEOUT_MILLIS ? parseInt(process.env.DB_IDLE_TIMEOUT_MILLIS) : 30000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false
});

pool.on('error', (err) => {
  log.error({ err }, 'database pool error');
});

const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

export const app = http.createServer((req, res) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);

  // Health check endpoint
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Serve xterm.js terminal page for /ws/{sessionId}
  const wsMatch = url.pathname.match(/^\/ws\/([a-f0-9-]{36})$/i);
  if (wsMatch && req.method === 'GET') {
    const sessionId = wsMatch[1];
    const token = url.searchParams.get('token') || '';

    // Serve HTML page with embedded xterm.js
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terminal - ${sessionId.slice(0, 8)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" />
  <style>
    body {
      margin: 0;
      padding: 0;
      background: #000;
      font-family: 'Courier New', monospace;
      overflow: hidden;
    }
    #terminal {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 40px;
    }
    #status {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 40px;
      background: #1a1a1a;
      color: #888;
      display: flex;
      align-items: center;
      padding: 0 15px;
      font-size: 12px;
      border-top: 1px solid #333;
    }
    #status.connected {
      color: #0f0;
    }
    #status.error {
      color: #f00;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #888;
      margin-right: 10px;
      display: inline-block;
    }
    .status-dot.connected {
      background: #0f0;
    }
    .status-dot.error {
      background: #f00;
    }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <div id="status">
    <span class="status-dot"></span>
    <span id="status-text">Connecting...</span>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
  <script>
    const sessionId = '${sessionId}';
    const token = '${token}';

    // Initialize xterm.js
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Courier New', monospace",
      theme: {
        background: '#000000',
        foreground: '#ffffff'
      }
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    // Handle window resize
    window.addEventListener('resize', () => {
      fitAddon.fit();
    });

    // Status updates
    const statusEl = document.getElementById('status');
    const statusText = document.getElementById('status-text');
    const statusDot = document.querySelector('.status-dot');

    function setStatus(message, type = 'normal') {
      statusText.textContent = message;
      statusEl.className = type;
      statusDot.className = 'status-dot ' + type;
    }

    // Connect to WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = \`\${protocol}//\${window.location.host}/ws/\${sessionId}\`;

    setStatus('Connecting to terminal...', 'normal');

    const ws = new WebSocket(wsUrl, ['bearer,' + token]);

    ws.onopen = () => {
      setStatus(\`Connected - Session: \${sessionId.slice(0, 8)}\`, 'connected');
    };

    ws.onmessage = (event) => {
      term.write(event.data);
    };

    ws.onerror = (error) => {
      setStatus('Connection error', 'error');
      console.error('WebSocket error:', error);
    };

    ws.onclose = () => {
      setStatus('Disconnected', 'error');
      term.write('\\r\\n\\r\\n[Connection closed]\\r\\n');
    };

    // Send terminal input to WebSocket
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
  </script>
</body>
</html>`;

    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(html);
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

// Only start the server if not in test mode
// In production/development, NODE_ENV will be 'production' or undefined
// In tests, NODE_ENV will be 'test'
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => log.info({ port }, 'ws-gateway listening'));
}