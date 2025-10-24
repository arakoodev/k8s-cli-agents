# Code Review Findings - Application Implementation

**Review Date:** 2025-10-22
**Scope:** Controller, Gateway, and Runner implementation verification

---

## Summary

Reviewed application code to verify:
1. Health check endpoint implementation
2. Database connection pooling usage
3. Runner pod label configuration
4. Security context implementation

---

## ✅ Verified - Working Correctly

### 1. Controller Health Checks (CONFIRMED)
**Location:** `controller/src/server.ts:116-133`

Both `/healthz` and `/readyz` endpoints are properly implemented:

```typescript
app.get('/healthz', async (req, res) => {
  const dbHealthy = await checkDatabaseHealth();
  if (dbHealthy) {
    res.status(200).json({ status: 'ok', database: 'connected' });
  } else {
    res.status(503).json({ status: 'degraded', database: 'disconnected' });
  }
});

app.get('/readyz', async (req, res) => {
  const dbHealthy = await checkDatabaseHealth();
  if (dbHealthy) {
    res.status(200).send('ready');
  } else {
    res.status(503).send('not ready');
  }
});
```

**Status:** ✅ Both endpoints exist and check database connectivity

---

### 2. Gateway Health Checks (CONFIRMED)
**Location:** `ws-gateway/src/server.ts:29-33`

Gateway has `/healthz` endpoint:

```typescript
if (req.url === '/healthz') {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
  return;
}
```

**Status:** ✅ Endpoint exists (basic check, does not verify DB)

**Note:** Gateway health check is simpler - doesn't check database connection. This is acceptable since gateway's primary function is WebSocket proxying, not serving requests.

---

### 3. Controller Database Connection Pool (CONFIRMED)
**Location:** `controller/src/db.ts:7-10`

Properly configured with environment variables:

```typescript
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: process.env.DB_MAX_CONNECTIONS ? parseInt(process.env.DB_MAX_CONNECTIONS) : 20,
  // ... additional config
});
```

**Status:** ✅ Pool configuration reads from environment variables correctly

---

### 4. Gateway Database Connection Pool (CONFIRMED)
**Location:** `ws-gateway/src/server.ts:16-22`

Gateway DOES use database connection pooling:

```typescript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  log.error({ err }, 'database pool error');
});
```

**Used for:**
- JTI replay prevention (line 65, 71)
- Session lookup for pod IP (line 74)

**Status:** ✅ Gateway uses connection pool for database operations

**Finding:** Issue #29 in HELM_PLAN.md was incorrect - gateway DOES need DB pool config. Should add `DB_MAX_CONNECTIONS` env var to gateway deployment.

---

### 5. Runner Pod Security Context (CONFIRMED)
**Location:** `controller/src/server.ts:180-199`

Runner pods are created with proper security context:

```typescript
securityContext: {
  runAsNonRoot: true,
  runAsUser: 1001,
  fsGroup: 1001,
  seccompProfile: { type: 'RuntimeDefault' }
},
containers: [{
  securityContext: {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: false,  // ⚠️ Note: false for runner
    runAsNonRoot: true,
    runAsUser: 1001,
    capabilities: { drop: ['ALL'] }
  }
}]
```

**Status:** ✅ Security context properly defined

**Note:** `readOnlyRootFilesystem: false` is intentional for runners since they download and execute code.

---

## 🔴 CRITICAL ISSUE FOUND

### 6. Runner Pod Label Mismatch (BROKEN)

**Issue:** Network policies won't work - label mismatch between controller code and network policy.

**Controller creates runner pods with:**
`controller/src/server.ts:177`
```typescript
metadata: { labels: { app: 'ws-cli-runner', session: sessionId } }
```

**Network policy expects:**
`cliscale-chart/templates/networkpolicy.yaml:10`
```yaml
podSelector:
  matchLabels:
    app.kubernetes.io/name: {{ include "cliscale.name" . }}-runner
```

**Template expansion:** `app.kubernetes.io/name: cliscale-runner`

**Mismatch:**
- Controller sets: `app: ws-cli-runner`
- Network policy expects: `app.kubernetes.io/name: cliscale-runner`

**Impact:**
- Network policies won't match runner pods
- Runners won't be isolated by network policies
- Security boundary not enforced

**Required Fix:**

Option A: Update controller code (recommended)
```typescript
// controller/src/server.ts:177
metadata: {
  labels: {
    'app.kubernetes.io/name': 'cliscale-runner',
    'app.kubernetes.io/component': 'runner',
    'session': sessionId
  }
}
```

Option B: Update network policy
```yaml
podSelector:
  matchLabels:
    app: ws-cli-runner
```

**Recommendation:** Use Option A (Kubernetes standard labels)

---

## Summary of Findings

| Check | Status | Notes |
|-------|--------|-------|
| Controller health checks | ✅ PASS | Both /healthz and /readyz with DB check |
| Gateway health checks | ✅ PASS | /healthz endpoint exists |
| Controller DB pool config | ✅ PASS | Reads from env vars correctly |
| Gateway DB pool usage | ✅ PASS | Gateway DOES use DB pool |
| Runner security context | ✅ PASS | Properly configured |
| Runner pod labels | 🔴 FAIL | Label mismatch - network policies broken |

---

## Required Actions

### CRITICAL (Before Any Deployment)
1. **Fix runner pod labels** - Update controller to use `app.kubernetes.io/name: cliscale-runner`
2. **Add DB pool config to gateway** - Add `DB_MAX_CONNECTIONS` and `DB_IDLE_TIMEOUT_MILLIS` env vars

### RECOMMENDED
3. **Add DB health check to gateway** `/healthz` (optional but good practice)
4. **Test network policies** after label fix
5. **Document `readOnlyRootFilesystem: false`** for runners (intentional, not a bug)

---

## Updated Issue Status

### Issue #13 (Health Checks) - ✅ RESOLVED
Both controller and gateway have health check endpoints implemented and working.

### Issue #29 (Gateway DB Pool) - ⚠️ PARTIALLY CORRECT
Gateway DOES use database pool. Should add pool configuration env vars for consistency:
- `DB_MAX_CONNECTIONS`
- `DB_IDLE_TIMEOUT_MILLIS`

### Issue #9 (Network Policies) - 🔴 BLOCKER FOUND
Network policies have **CRITICAL bug** - label mismatch will prevent policies from working.
Must fix before deployment.

---

## New Critical Issue

### 🔴 NEW ISSUE #33 - Runner Pod Label Mismatch (CRITICAL)

**Severity:** CRITICAL - Network policies won't work
**Impact:** Security boundary not enforced, runners not isolated
**Status:** Must fix before deployment
**Location:** `controller/src/server.ts:177` vs `networkpolicy.yaml:10`

---

## Confidence Assessment

**Code Quality:** ✅ Good - proper security contexts, health checks, pooling
**Configuration Match:** 🔴 Issue - label mismatch breaks network policies
**Overall:** ⚠️ **ONE CRITICAL FIX REQUIRED** before deployment is safe
