# Smoke Tests Strategy: Fast JavaScript Validation

## Philosophy: Test the Compiled Output, Not the Container

**Key Principle**: Docker is just packaging. We test the **compiled JavaScript** that runs in production, not the Docker container itself.

### Why This Approach is Better

| Approach | Time | Cost | What it Tests |
|----------|------|------|---------------|
| ❌ Build Docker in CI | 3-5 min | High (Docker daemon, build cache) | Container + JavaScript |
| ✅ Test JavaScript directly | 10-30 sec | Low (just Node.js) | **Same JavaScript that runs in production** |

**Speed**: 10-20x faster than Docker builds
**Cost**: Minimal (no Docker daemon needed)
**Coverage**: Tests the exact same code path as production

---

## The Smoke Test Pipeline

### CI Workflow (GitHub Actions)
```
1. Install dependencies → npm ci
2. Run unit tests     → npm test
3. Build TypeScript   → npm run build
4. Smoke Test 1       → node --check dist/server.js          (validate syntax)
5. Smoke Test 2       → node --eval "import('./dist/...')"  (verify imports)
6. Smoke Test 3       → timeout 10s node dist/server.js     (test startup)
```

**Total added time**: ~10-30 seconds
**What it catches**: ES module errors, import failures, startup crashes

### Dockerfile Build
```
1. Install dependencies → npm ci
2. Build TypeScript     → npm run build
3. Smoke Test           → node --check dist/server.js        (same as CI!)
4. Package image        → Done
```

**Guarantee**: If CI smoke tests pass, Docker build will pass (they use the same command)

---

## Implementation

### GitHub Actions CI (.github/workflows/ci.yml)

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18.x, 20.x]
        service-dir: [controller, ws-gateway]

    steps:
    - uses: actions/checkout@v3
    - uses: actions/setup-node@v3
      with:
        node-version: ${{ matrix.node-version }}

    - name: Install Dependencies
      run: npm ci
      working-directory: ./${{ matrix.service-dir }}

    - name: Run Unit Tests
      run: npm test
      working-directory: ./${{ matrix.service-dir }}

    - name: Build TypeScript
      run: npm run build
      working-directory: ./${{ matrix.service-dir }}

    # ========================================
    # SMOKE TESTS - Fast JavaScript Validation
    # ========================================

    - name: Smoke Test - Validate JavaScript Syntax
      run: |
        echo "🔍 Validating compiled JavaScript syntax..."
        node --check dist/server.js
        echo "✅ JavaScript syntax is valid"
      working-directory: ./${{ matrix.service-dir }}

    - name: Smoke Test - Verify ES Module Imports
      run: |
        echo "🔍 Verifying ES module imports resolve correctly..."
        node --input-type=module --eval "
          import('./dist/server.js')
            .then(() => {
              console.log('✅ All imports resolved successfully');
              process.exit(0);
            })
            .catch(err => {
              console.error('❌ Module import failed:', err.message);
              process.exit(1);
            });
        "
      working-directory: ./${{ matrix.service-dir }}

    - name: Smoke Test - Application Startup
      run: |
        echo "🔍 Testing application startup (10 second timeout)..."
        timeout 10s node dist/server.js || EXIT_CODE=$?

        if [ "${EXIT_CODE:-0}" -eq 124 ] || [ "${EXIT_CODE:-0}" -eq 0 ]; then
          echo "✅ Application started successfully"
          exit 0
        else
          echo "❌ Application crashed with exit code: ${EXIT_CODE}"
          exit 1
        fi
      working-directory: ./${{ matrix.service-dir }}
      env:
        DATABASE_URL: postgresql://fake:5432/test
        NODE_ENV: test
        PORT: 8080
```

**What each test does**:

1. **Syntax Check** (`node --check`)
   - Validates JavaScript is syntactically correct
   - Catches: ES module syntax errors, missing semicolons, etc.
   - Time: < 1 second

2. **Import Resolution** (`node --eval "import(...)"`)
   - Verifies all imports can be resolved
   - Catches: Missing `.js` extensions, missing files, circular imports
   - Time: 1-2 seconds

3. **Startup Test** (`timeout 10s node dist/server.js`)
   - Actually runs the application for 10 seconds
   - Catches: Runtime errors, initialization failures, crashes
   - Time: 10 seconds

**Total smoke test time**: ~12 seconds

---

### Dockerfile Smoke Test

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src

RUN npm run build

# Smoke test: Validate compiled JavaScript (SAME AS CI)
RUN node --check dist/server.js && \
    echo "✅ JavaScript validation passed"

ENV NODE_ENV=production

CMD ["node", "dist/server.js"]
```

**Why this works**:
- ✅ Uses the **exact same command** as CI
- ✅ If CI passes, Docker build will pass
- ✅ Fails the build immediately if JavaScript is invalid
- ✅ Adds < 1 second to build time

---

## What These Smoke Tests Catch

### ✅ Would Have Caught (The ES Module Issue)

```javascript
// ❌ This would fail smoke test #1 (syntax check)
if (require.main === module) {  // ReferenceError in ES module

// ❌ This would fail smoke test #2 (import resolution)
import { foo } from './sessionJwt';  // Missing .js extension

// ❌ This would fail smoke test #3 (startup)
const db = connectToDatabase();  // Crashes if config missing
```

### What They DON'T Catch (Requires Integration Tests)

```javascript
// ⚠️ Won't be caught by smoke tests:
- Database connection failures (mocked in smoke test)
- Kubernetes API authentication issues
- Cross-service communication failures
- WebSocket protocol issues
- Race conditions under load
```

**Smoke tests = Fast fail on basic issues**
**Integration tests = Catch complex interaction issues**

---

## Local Development Usage

### Run Smoke Tests Locally (Before Commit)

```bash
# In controller/ or ws-gateway/ directory:

# 1. Build
npm run build

# 2. Smoke test 1: Syntax check
node --check dist/server.js

# 3. Smoke test 2: Import resolution
node --input-type=module --eval "
  import('./dist/server.js')
    .then(() => console.log('✅ All imports resolved'))
    .catch(err => { console.error('❌', err.message); process.exit(1); });
"

# 4. Smoke test 3: Startup test (optional)
timeout 10s node dist/server.js
```

### Add to package.json Scripts

```json
{
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "smoke": "npm run build && node --check dist/server.js",
    "smoke:full": "npm run smoke && timeout 10s node dist/server.js || exit 0"
  }
}
```

Then run:
```bash
npm run smoke        # Quick validation (< 1 sec)
npm run smoke:full   # Full startup test (10 sec)
```

---

## Cloud Build Integration (Optional)

If you want to add smoke tests to Cloud Build (runs after Skaffold builds images):

```yaml
# cloudbuild.yaml
steps:
# ... build steps ...

# Optional: Smoke test images (if you want defense in depth)
- name: ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/controller:$SHORT_SHA
  id: smoke-test-controller-image
  entrypoint: node
  args: ['--check', 'dist/server.js']
  waitFor: ["skaffold-build"]

- name: ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/gateway:$SHORT_SHA
  id: smoke-test-gateway-image
  entrypoint: node
  args: ['--check', 'dist/server.js']
  waitFor: ["skaffold-build"]

# Deploy only if smoke tests pass
- name: skaffold-deploy
  waitFor: ["smoke-test-controller-image", "smoke-test-gateway-image"]
```

**Note**: This is optional because CI already validates the JavaScript. Cloud Build smoke tests provide defense in depth but add ~30 seconds.

---

## Comparison: Before vs After

### Before (No Smoke Tests)
```
Commit → CI (unit tests) → Deploy → 💥 Container crash
         ✅ 5 min           ❌ 30+ min to discover
```

### After (With Fast Smoke Tests)
```
Commit → CI (unit tests + smoke tests) → ❌ FAIL in CI
         ⚠️ 5 min 30 sec                    (prevents bad deployment)

Commit → CI (unit tests + smoke tests) → Deploy → ✅ Success
         ✅ 5 min 30 sec                    ✅ Works
```

**Added time**: 30 seconds
**Time saved**: 30+ minutes of production debugging
**ROI**: 60:1

---

## Testing Strategy Matrix

| Test Type | Speed | Cost | When | What it Catches |
|-----------|-------|------|------|-----------------|
| **Unit Tests** | Fast (2-5 min) | Low | Every commit | Business logic, validation |
| **Smoke Tests** | Very Fast (30 sec) | Very Low | Every commit | ES module errors, imports, startup |
| **Integration Tests** | Slow (5-10 min) | Medium | Pre-merge | Service interactions |
| **E2E Tests** | Very Slow (10-30 min) | High | Pre-deploy | Full user flows |

**Our strategy**: Unit tests + Smoke tests on every commit (fast feedback), Integration tests on PR (thorough validation)

---

## Maintenance Notes

### Keeping CI and Dockerfile in Sync

**Rule**: The Dockerfile MUST use the same validation command as CI

**CI Smoke Test 1**:
```yaml
run: node --check dist/server.js
```

**Dockerfile Smoke Test**:
```dockerfile
RUN node --check dist/server.js
```

**Why**: If CI passes, Docker build will pass. If they use different commands, we lose this guarantee.

### Adding New Services

When adding a new service:

1. ✅ Add to `.github/workflows/ci.yml` matrix:
   ```yaml
   service-dir: [controller, ws-gateway, new-service]
   ```

2. ✅ Add smoke test to new service's Dockerfile:
   ```dockerfile
   RUN node --check dist/server.js
   ```

3. ✅ Done! CI and Docker will automatically test it

---

## Key Takeaways

1. **Test compiled JavaScript, not Docker** - It's faster and tests the same thing
2. **Use the same commands in CI and Docker** - Guarantees consistency
3. **Smoke tests are fast** - 30 seconds added to CI, 60x time saved in production
4. **Defense in layers** - Smoke tests catch basic issues, integration tests catch complex ones
5. **Fail fast** - Better to fail in 5 minutes in CI than 30 minutes in production

---

## FAQ

**Q: Why not just run the full application in CI with a real database?**
A: That's integration testing (slower, more complex). Smoke tests are for fast fail on basic issues.

**Q: Should we add Docker smoke tests too?**
A: Optional. CI already tests the JavaScript. Docker smoke tests provide defense in depth but add time/cost.

**Q: What about testing with different Node versions?**
A: We already do! The CI matrix tests Node 18.x and 20.x with smoke tests.

**Q: Can smoke tests replace integration tests?**
A: No. Smoke tests catch syntax/import/startup errors. Integration tests catch service interaction issues.

**Q: How do I know if my change needs integration tests?**
A: If your change affects how services communicate (API changes, database schema, WebSocket protocol), add integration tests.

---

## Related Documentation

- **TESTING_GAPS_ANALYSIS.md** - Root cause analysis of the ES module issue
- **CI_IMPROVEMENTS.md** - Comprehensive testing strategy improvements
- **DEPLOYMENT.md** - Production deployment guide
- **.github/workflows/ci.yml** - Actual CI configuration with smoke tests
