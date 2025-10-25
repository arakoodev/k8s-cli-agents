# CI/CD Improvements: Prevent Container Runtime Failures

## Quick Summary

**Problem**: ES module errors crashed containers in production but CI showed green ✅

**Root Cause**: CI tests TypeScript with ts-jest, production runs compiled JavaScript in containers. Module errors only appear at Node.js runtime.

**Solution**: Add 3 validation stages that would have caught this in < 5 minutes:
1. **JavaScript syntax check** after build
2. **Container smoke test** before push
3. **Startup validation** before marking deployment successful

---

## Implementation: 3-Tier Validation Strategy

### Tier 1: GitHub Actions CI (Catches 80% of issues)
Fast feedback in pull requests, runs on every commit

### Tier 2: Cloud Build Pre-Deployment (Catches 15% of issues)
Validates containers before deploying to Kubernetes

### Tier 3: Kubernetes Deployment Validation (Catches 5% of issues)
Ensures pods are actually healthy before marking rollout complete

---

## Tier 1: Enhanced GitHub Actions CI

### New Workflow Structure
```yaml
name: CI

on:
  push:
    branches: [ "main" ]
  pull_request:
    branches: [ "main" ]

jobs:
  # ========================================
  # JOB 1: Unit Tests (existing)
  # ========================================
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18.x, 20.x]
        service-dir: [controller, ws-gateway]

    steps:
    - uses: actions/checkout@v3

    - name: Use Node.js ${{ matrix.node-version }}
      uses: actions/setup-node@v3
      with:
        node-version: ${{ matrix.node-version }}
        cache: 'npm'
        cache-dependency-path: '${{ matrix.service-dir }}/package-lock.json'

    - name: Install Dependencies
      run: npm ci
      working-directory: ./${{ matrix.service-dir }}

    - name: Run Unit Tests
      run: npm test
      working-directory: ./${{ matrix.service-dir }}

  # ========================================
  # JOB 2: Build & Validate Compiled Output (NEW)
  # ========================================
  validate-build:
    runs-on: ubuntu-latest
    needs: test
    strategy:
      matrix:
        service-dir: [controller, ws-gateway]

    steps:
    - uses: actions/checkout@v3

    - name: Use Node.js 20.x
      uses: actions/setup-node@v3
      with:
        node-version: 20.x
        cache: 'npm'
        cache-dependency-path: '${{ matrix.service-dir }}/package-lock.json'

    - name: Install Dependencies
      run: npm ci
      working-directory: ./${{ matrix.service-dir }}

    - name: Build TypeScript
      run: npm run build
      working-directory: ./${{ matrix.service-dir }}

    - name: Validate JavaScript Syntax
      run: |
        echo "Checking compiled JavaScript for syntax errors..."
        node --check dist/server.js
        echo "✅ JavaScript syntax is valid"
      working-directory: ./${{ matrix.service-dir }}

    - name: Check for ES Module Issues
      run: |
        echo "Validating ES module configuration..."

        # Check if package.json has "type": "module"
        if ! grep -q '"type".*:.*"module"' package.json; then
          echo "❌ ERROR: package.json missing '\"type\": \"module\"'"
          exit 1
        fi

        # Check for require.main usage in compiled output
        if grep -r "require\.main" dist/; then
          echo "❌ ERROR: Found 'require.main' in compiled output (not compatible with ES modules)"
          exit 1
        fi

        echo "✅ ES module configuration is valid"
      working-directory: ./${{ matrix.service-dir }}

  # ========================================
  # JOB 3: Docker Smoke Tests (NEW)
  # ========================================
  docker-smoke-test:
    runs-on: ubuntu-latest
    needs: validate-build
    strategy:
      matrix:
        service: [controller, ws-gateway]

    steps:
    - uses: actions/checkout@v3

    - name: Build Docker Image
      run: |
        docker build -t ${{ matrix.service }}:ci-test .
      working-directory: ./${{ matrix.service }}

    - name: Test 1 - JavaScript Syntax Check
      run: |
        echo "Testing: JavaScript syntax validation in container..."
        docker run --rm ${{ matrix.service }}:ci-test node --check dist/server.js
        echo "✅ Container JavaScript is valid"

    - name: Test 2 - Module Resolution Check
      run: |
        echo "Testing: ES module imports can be resolved..."
        docker run --rm ${{ matrix.service }}:ci-test node --eval "
          import('./dist/server.js')
            .catch(err => {
              console.error('❌ Module import failed:', err.message);
              process.exit(1);
            });
        "
        echo "✅ All modules resolve correctly"

    - name: Test 3 - Application Startup Test
      run: |
        echo "Testing: Application can start without crashing..."

        # Start container with timeout
        docker run --rm \
          -e DATABASE_URL=postgresql://fake:5432/test \
          -e NODE_ENV=test \
          -e PORT=8080 \
          ${{ matrix.service }}:ci-test \
          timeout 10s npm start || EXIT_CODE=$?

        # Exit code 124 = timeout (expected, means it ran for 10s without crashing)
        # Exit code 0 = exited normally (unexpected for a server, but okay)
        # Any other code = crash (failed)
        if [ $EXIT_CODE -eq 124 ] || [ $EXIT_CODE -eq 0 ]; then
          echo "✅ Container started successfully and ran for 10 seconds"
        else
          echo "❌ Container crashed with exit code: $EXIT_CODE"
          exit 1
        fi

    - name: Test 4 - Health Check Endpoint (for services with health checks)
      if: matrix.service == 'controller' || matrix.service == 'ws-gateway'
      run: |
        echo "Testing: Health check endpoint responds..."

        # Start container in background
        docker run -d \
          --name ${{ matrix.service }}-test \
          -e DATABASE_URL=postgresql://localhost:5432/test \
          -e NODE_ENV=test \
          -p 8080:8080 \
          ${{ matrix.service }}:ci-test

        # Wait for startup
        sleep 5

        # Test health endpoint
        curl -f http://localhost:8080/healthz || {
          echo "❌ Health check failed"
          docker logs ${{ matrix.service }}-test
          exit 1
        }

        echo "✅ Health check endpoint responded"

        # Cleanup
        docker stop ${{ matrix.service }}-test

  # ========================================
  # JOB 4: Integration Tests (FUTURE)
  # ========================================
  # integration-test:
  #   runs-on: ubuntu-latest
  #   needs: docker-smoke-test
  #   steps:
  #   - Run tests against real PostgreSQL (via Testcontainers)
  #   - Test controller → gateway communication
  #   - Test WebSocket connections
```

### What This Catches
- ✅ ES module syntax errors (`require.main`)
- ✅ Missing file extensions in imports
- ✅ Missing `"type": "module"` in package.json
- ✅ Module resolution failures
- ✅ Container startup crashes
- ✅ Basic runtime errors

### Cost
- **Time added to CI**: ~3-5 minutes per commit
- **Engineering effort**: 1-2 hours to implement
- **Maintenance**: Minimal (runs automatically)

---

## Tier 2: Cloud Build Pre-Deployment Validation

### Enhanced cloudbuild.yaml

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
  _PROFILE: staging

options:
  logging: CLOUD_LOGGING_ONLY
  machineType: N1_HIGHCPU_8

steps:
# ========================================
# PHASE 1: Build Images
# ========================================
- name: gcr.io/google.com/cloudsdktool/cloud-sdk:alpine
  id: install-skaffold
  entrypoint: sh
  args:
  - -c
  - |
    curl -Lo /workspace/skaffold https://storage.googleapis.com/skaffold/releases/v2.10.1/skaffold-linux-amd64
    chmod +x /workspace/skaffold

- name: gcr.io/google.com/cloudsdktool/cloud-sdk:alpine
  id: skaffold-build
  entrypoint: sh
  waitFor: ["install-skaffold"]
  args:
  - -c
  - |
    /workspace/skaffold build \
      --default-repo=${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO} \
      --profile=${_PROFILE} \
      --tag=$SHORT_SHA \
      --file-output=/workspace/images.json

# ========================================
# PHASE 2: Smoke Test Built Images (NEW)
# ========================================
- name: gcr.io/google.com/cloudsdktool/cloud-sdk:alpine
  id: smoke-test-controller
  waitFor: ["skaffold-build"]
  entrypoint: sh
  args:
  - -c
  - |
    echo "🔍 Smoke testing controller image..."

    # Pull the image we just built
    IMAGE="${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/controller:$SHORT_SHA"
    docker pull $IMAGE

    # Test 1: JavaScript syntax check
    echo "Test 1: Validating JavaScript syntax..."
    docker run --rm $IMAGE node --check dist/server.js

    # Test 2: Import resolution
    echo "Test 2: Validating module imports..."
    docker run --rm $IMAGE node --eval "
      import('./dist/server.js').catch(err => {
        console.error('Module import failed:', err.message);
        process.exit(1);
      });
    "

    # Test 3: Startup test (with fake DB)
    echo "Test 3: Testing container startup..."
    timeout 10s docker run --rm \
      -e DATABASE_URL=postgresql://fake:5432/test \
      -e NODE_ENV=test \
      $IMAGE \
      npm start || EXIT_CODE=$?

    if [ $EXIT_CODE -eq 124 ] || [ $EXIT_CODE -eq 0 ]; then
      echo "✅ Controller smoke tests passed"
    else
      echo "❌ Controller failed smoke test with exit code: $EXIT_CODE"
      exit 1
    fi

- name: gcr.io/google.com/cloudsdktool/cloud-sdk:alpine
  id: smoke-test-gateway
  waitFor: ["skaffold-build"]
  entrypoint: sh
  args:
  - -c
  - |
    echo "🔍 Smoke testing gateway image..."

    IMAGE="${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/gateway:$SHORT_SHA"
    docker pull $IMAGE

    echo "Test 1: Validating JavaScript syntax..."
    docker run --rm $IMAGE node --check dist/server.js

    echo "Test 2: Validating module imports..."
    docker run --rm $IMAGE node --eval "
      import('./dist/server.js').catch(err => {
        console.error('Module import failed:', err.message);
        process.exit(1);
      });
    "

    echo "Test 3: Testing container startup..."
    timeout 10s docker run --rm \
      -e DATABASE_URL=postgresql://fake:5432/test \
      -e NODE_ENV=test \
      $IMAGE \
      npm start || EXIT_CODE=$?

    if [ $EXIT_CODE -eq 124 ] || [ $EXIT_CODE -eq 0 ]; then
      echo "✅ Gateway smoke tests passed"
    else
      echo "❌ Gateway failed smoke test with exit code: $EXIT_CODE"
      exit 1
    fi

# ========================================
# PHASE 3: Deploy (only if smoke tests pass)
# ========================================
- name: gcr.io/google.com/cloudsdktool/cloud-sdk:alpine
  id: get-credentials
  waitFor: ["smoke-test-controller", "smoke-test-gateway"]
  entrypoint: sh
  args:
  - -c
  - |
    gcloud container clusters get-credentials ${_CLUSTER} --region ${_LOCATION}

- name: gcr.io/google.com/cloudsdktool/cloud-sdk:alpine
  id: skaffold-deploy
  entrypoint: sh
  waitFor: ["get-credentials"]
  args:
  - -c
  - |
    /workspace/skaffold deploy \
      --build-artifacts=/workspace/images.json \
      --namespace=${_NAMESPACE} \
      --set-value domain=${_DOMAIN} \
      --set-value wsDomain=${_WS_DOMAIN}

# ========================================
# PHASE 4: Verify Deployment
# ========================================
- name: gcr.io/google.com/cloudsdktool/cloud-sdk:alpine
  id: verify-deployment
  entrypoint: sh
  args:
  - -c
  - |
    echo "⏳ Waiting for deployments to stabilize..."

    # Wait for rollout with detailed status
    kubectl -n ${_NAMESPACE} rollout status deploy/cliscale-controller --timeout=5m || {
      echo "❌ Controller deployment failed"
      kubectl -n ${_NAMESPACE} get pods -l app.kubernetes.io/name=cliscale-controller
      kubectl -n ${_NAMESPACE} logs -l app.kubernetes.io/name=cliscale-controller --tail=50
      exit 1
    }

    kubectl -n ${_NAMESPACE} rollout status deploy/cliscale-gateway --timeout=5m || {
      echo "❌ Gateway deployment failed"
      kubectl -n ${_NAMESPACE} get pods -l app.kubernetes.io/name=cliscale-gateway
      kubectl -n ${_NAMESPACE} logs -l app.kubernetes.io/name=cliscale-gateway --tail=50
      exit 1
    }

    echo "✅ All deployments successful!"
    kubectl -n ${_NAMESPACE} get pods

images:
- ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/controller:$SHORT_SHA
- ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/gateway:$SHORT_SHA
- ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/runner:$SHORT_SHA

timeout: 1800s
```

### What This Catches
- ✅ Images that fail to start
- ✅ Module import errors in production images
- ✅ Container configuration issues
- **Prevents bad images from being deployed to Kubernetes**

### Cost
- **Time added to deployment**: ~2-3 minutes
- **Prevents**: Deploying broken containers

---

## Tier 3: Enhanced Kubernetes Deployment Validation

### Improved Helm Chart Probes

```yaml
# cliscale-chart/templates/controller.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "cliscale.fullname" . }}-controller
spec:
  template:
    spec:
      containers:
      - name: controller
        image: {{ .Values.controller.image.repository }}:{{ .Values.controller.image.tag }}

        # Startup probe - gives app time to initialize
        # Prevents readiness checks from failing during slow startup
        startupProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 2
          timeoutSeconds: 1
          failureThreshold: 30  # 30 * 2s = 60s max startup time

        # Readiness probe - determines if pod receives traffic
        # More sensitive, can temporarily remove pod from service
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          initialDelaySeconds: 0  # startupProbe handles initial delay
          periodSeconds: 5
          timeoutSeconds: 2
          successThreshold: 1
          failureThreshold: 3  # 3 * 5s = 15s to become unready

        # Liveness probe - determines if pod should be restarted
        # Less sensitive, only restarts on catastrophic failure
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 0  # startupProbe handles initial delay
          periodSeconds: 10
          timeoutSeconds: 3
          successThreshold: 1
          failureThreshold: 6  # 6 * 10s = 60s of failures before restart
```

### Progressive Rollout Strategy

```yaml
# cliscale-chart/templates/controller.yaml
apiVersion: apps/v1
kind: Deployment
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1  # Only take down 1 pod at a time
      maxSurge: 1        # Create 1 extra pod during rollout

  minReadySeconds: 30  # Wait 30s after pod is ready before considering it available

  progressDeadlineSeconds: 600  # Fail deployment if not complete in 10 minutes
```

### What This Catches
- ✅ Pods that crash during initialization
- ✅ Pods that hang during startup
- ✅ Pods that fail health checks
- ✅ Prevents traffic from reaching broken pods

---

## Comparison: Before vs After

### Before (Current State)
```
Commit → GitHub Actions (unit tests) → Cloud Build → Deploy → 💥 CRASH
         ✅ Pass (5 min)
                                        → ❌ Fail in prod (30 min to discover)
```

### After (With Smoke Tests)
```
Commit → GitHub Actions → Cloud Build Smoke Tests → Deploy → ✅ Success
         ✅ Unit tests     ✅ Container validation
         (5 min)           (3 min)
                          ❌ STOP if fail
                          (Prevents bad deployment)
```

---

## Priority Implementation Order

### Phase 1: Immediate (1-2 hours) - Highest ROI
1. ✅ Add `node --check dist/server.js` to Dockerfiles
2. ✅ Add smoke test step to cloudbuild.yaml
3. ✅ Update Kubernetes probes in Helm charts

**Impact**: Would have caught this exact issue in 3 minutes instead of 30+

### Phase 2: Short-term (4 hours) - High ROI
4. ⬜ Add validate-build job to GitHub Actions
5. ⬜ Add docker-smoke-test job to GitHub Actions
6. ⬜ Add enhanced logging to deployment verification

**Impact**: Catch issues in PR review before merge

### Phase 3: Medium-term (1-2 days) - Medium ROI
7. ⬜ Add integration test job with Testcontainers
8. ⬜ Add WebSocket connection tests
9. ⬜ Add pre-deployment staging validation

**Impact**: Catch complex integration issues

### Phase 4: Long-term (1 week) - Strategic
10. ⬜ Implement blue-green deployments
11. ⬜ Add canary releases with automatic rollback
12. ⬜ Add comprehensive monitoring and alerting

**Impact**: Production resilience and reliability

---

## Metrics to Track

### Before Implementation
- ❌ Container failures detected: After deployment
- ❌ Time to detection: 30+ minutes
- ❌ Rollback strategy: Manual
- ❌ CI confidence: Low (doesn't test containers)

### After Implementation
- ✅ Container failures detected: In CI (< 5 min)
- ✅ Time to detection: 3-5 minutes
- ✅ Rollback strategy: Automatic (deployment fails)
- ✅ CI confidence: High (tests actual containers)

### KPIs
- **Deployment success rate**: Target > 95%
- **Mean time to detection (MTTD)**: Target < 5 minutes
- **Mean time to recovery (MTTR)**: Target < 10 minutes
- **Failed deployments reaching production**: Target 0

---

## Conclusion

The ES module issue revealed a **critical gap**: we test code, but not containers.

**The fix is simple**: Test the container the same way production runs it.

**Recommended action**: Implement Phase 1 immediately (1-2 hours). This single change would have prevented this entire incident.
