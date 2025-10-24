# Agents Summary — Full Retrospective (Updated: Helm Migration + Security Review)

> This is the candid history of how the "ephemeral CLI agent" stack evolved: what we tried, what broke, how we scaled, what we secured, and what's still left to do. It includes the switch to **PostgreSQL (Cloud SQL)** for sessions/JTIs, the **WS Gateway** tier, **RS256/JWKS**, an **end-to-end Firebase Auth web demo**, the **Helm migration**, **Skaffold deployment**, and a **comprehensive security review**.

---

## 1) Timeline of Key Decisions

| Date (IST) | Decision                                                                                       | Why                                                                | Impact                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 2025-10-01 | Prototype via **k8s exec/attach** from controller                                              | Fast path to a demo                                                | Hit control-plane limits; not viable for high WS concurrency                          |
| 2025-10-03 | **One Kubernetes Job per session**                                                             | Hard isolation + TTL lifecycle                                     | Predictable teardown and resource accounting                                          |
| 2025-10-05 | **In-pod ttyd** + HTTP WS proxy (no node-pty)                                                  | Keep k8s API server out of data path                               | Horizontal scaling; fewer native deps                                                 |
| 2025-10-07 | Design **WS Gateway** tier behind GCLB                                                         | Handle 100k–1M sockets                                             | Shard by `sessionId`; stateless proxy layer                                           |
| 2025-10-08 | **Cloud Build** pipeline (App-Engine-like)                                                     | No local Docker; "upload → build → deploy"                         | Faster onboarding; reproducible images                                                |
| 2025-10-10 | **Firebase Auth** + **Session-JWT**                                                            | Identity vs capability separation                                  | Only the owner attaches; short-lived auth                                             |
| 2025-10-12 | Runner downloads CLI bundle at runtime                                                         | Decouple app from base image                                       | Faster iteration; supply-chain controls                                               |
| 2025-10-14 | Artifact Registry cleanup policies                                                             | Prevent image sprawl                                               | Lower storage costs, simple retention                                                 |
| 2025-10-16 | **SHA-256** verification & allowlist for bundles                                               | Supply-chain defense                                               | Reduce RCE/tarbomb risk                                                               |
| 2025-10-18 | (Old plan) Redis session/JTI store                                                             | Needed multi-replica correctness                                   | **Replaced by Postgres** to simplify ops                                              |
| 2025-10-21 | **Switch to PostgreSQL (Cloud SQL)** + **RS256/JWKS** + **WS Gateway** + **Firebase web demo** | Durable session/JTI, verifiable tokens at edge, full end-to-end UX | Production-leaning architecture; simpler reasoning; easier multi-service verification |
| 2025-10-21 | **Full-stack security refactor** (IaC + App)                                                 | Address vulnerabilities, align with docs, and adopt best practices | **Private VPC/GKE/SQL**, **RS256/JWKS** implemented, JTI replay, hardened runner script |
| 2025-10-22 | **Migrate to Helm charts** for Kubernetes deployments                                         | Consistent, parameterized configs; easier management                | Single source of truth; eliminated raw manifest drift                                  |
| 2025-10-22 | **Add Skaffold** for App Engine-like deployment experience                                     | Simple desktop → GKE deployment; dev mode with live reload          | `skaffold run` replaces complex build/deploy steps                                    |
| 2025-10-22 | **Comprehensive security review** + code verification                                          | Ensure production readiness for life-critical system                | All 9 CRITICAL issues resolved; 24/29 total issues fixed (83%)                        |

---

## 2) Pain Points / Lessons Learned

### 2.1 WebSockets & Scale

* Don't stream via `kubectl attach`/API-server: it's a **hard choke point** beyond a few thousand concurrent sockets.
* **In-pod ttyd** is the right primitive: traffic is client → gateway → pod, **not** through the control plane.
* **WS Gateway** must be **stateless**: verify JWT and look up `{sessionId→podIP}` in the DB; then plain TCP proxy.
* Memory budgeting: ~30–60 KB/idle WS across the gateway tier; plan ~40–60 GB for ~1M idle sockets spread across 40–80 pods.
* GCLB needs **long timeouts** and **pings**; set BackendConfig `timeoutSec ≥ 3600` and client heartbeats.

### 2.2 Control Plane & Pod Churn

* Avoid per-session Services/Ingress. Pod IP discovery via labels (or DB) is simpler and cheaper.
* Use Job `ttlSecondsAfterFinished`, sensible backoff, and `activeDeadlineSeconds` to avoid scheduler stress.

### 2.3 Security

* **Identity ≠ Capability**: Firebase ID token proves *who*. **Session-JWT** (short-lived, one-time) proves *who + which session*.
* **RS256 + JWKS** lets any tier verify tokens independently; easy rotation later via KMS.
* Lock down runner pods with **NetworkPolicies**: allow ingress only from gateway; restrict egress to Anthropic + artifact hosts.
* Verify artifacts: **domain allowlist**, **SHA-256**, size limits; defend against tarbombs.
* **Label consistency matters**: Runner pods must use Kubernetes standard labels (`app.kubernetes.io/name`) for network policies to work.
* **Connection pooling is critical**: Both controller and gateway need database connection pool limits to prevent exhaustion.

### 2.4 State & Consistency

* We replaced Redis with **PostgreSQL** for sessions/JTIs:
  * **UNLOGGED** tables for speed (ephemeral state) + expiry triggers for opportunistic cleanup.
  * Works well with gateway/controller replicas and token one-time-use semantics.

### 2.5 DX & Delivery

* Cloud Build cold starts are acceptable for the benefit of **no local Docker** and reproducibility.
* Keep runner image generic; pull CLI bundle at runtime to reduce rebuild frequency.
* **Skaffold + Helm** delivers true App Engine-like experience: `skaffold run` builds, pushes, and deploys in one command.
* **Helm charts** eliminate configuration drift between environments.

### 2.6 Migration & Security Review Lessons

* **Don't trust unverified developers** for life-critical systems - comprehensive review is essential.
* **Raw K8s manifests vs Helm**: Maintaining two sources of truth (k8s/ and Helm) creates dangerous drift.
* **Code verification matters**: Even good configs can have implementation bugs (e.g., label mismatches).
* **Security contexts must be consistent**: Controller and gateway should have identical hardening.
* **Health checks should verify dependencies**: Don't just return "ok" - actually check database connectivity.

---

## 3) What Went Well

* **Stage-wise CLI** (listr2, ora, chalk, boxen) renders beautifully both in terminal and browser via ttyd.
* **Ephemeral Job** model + TTL keeps infra tidy and costs bounded.
* **Auth layering** (Firebase + session-JWT) is easy to reason about and audit.
* **WS Gateway** + **Postgres** delivers simple, scalable lookup + proxy logic.
* **End-to-end demo** with Firebase web app makes the value obvious and debuggable.
* **Helm migration** succeeded: Single source of truth, parameterized configs, environment profiles.
* **Skaffold integration** delivers promised App Engine-like UX: `skaffold run` → deployed.
* **Security review** caught critical issues before production: network policy bugs, missing configs, deployment workflow issues.
* **Code verification** found and fixed implementation bugs that config review missed.

---

## 4) Outstanding Work & Recommendations

### ✅ COMPLETED (2025-10-22)

* ✅ **Helm chart migration** - All Kubernetes resources now managed via Helm
* ✅ **Skaffold deployment** - App Engine-like `skaffold run` experience
* ✅ **Security hardening** - All 9 CRITICAL issues resolved
* ✅ **Network policy fixes** - Runner pod labels corrected
* ✅ **Connection pooling** - Both controller and gateway properly configured
* ✅ **Health checks verified** - All endpoints implemented and working
* ✅ **Deployment workflow fixed** - Single secure path via Skaffold + Helm

### P0 — Now (For Production)

* **Secret management automation** - Use External Secrets Operator or Google Secret Manager integration (documented in DEPLOYMENT.md)
* **KMS-backed RS256 signing** for session-JWTs; publish JWKS via controller; add key rotation policy
* **Stronger DB cleanup**: add `pg_cron` (e.g., minutely) to prune `sessions`/`token_jti` by `expires_at`
* **Cloud Armor** baseline (rate-limit `POST /api/sessions`, WAF, basic bot rules)
* **Monitoring & alerting** - Add Prometheus ServiceMonitors, Grafana dashboards, alerting rules
* **Disaster recovery documentation** - Backup procedures, RTO/RPO, restore runbooks

### P1 — Next

* **Observability**: metrics—open WS, job spin-up latency, gateway CPU/mem/sockets, CLI stage durations; SLOs & alerts
* **Backpressure/quotas**: per-user session caps; graceful queueing if the cluster is saturated
* **Artifact scanning**: MIME/type checks, AV/heuristics scan, max archive size, and extraction sandbox
* **Pod anti-affinity rules** - Spread replicas across nodes/zones for HA
* **Update ingress annotations** - Replace deprecated `kubernetes.io/ingress.class` with `spec.ingressClassName`

### P2 — Soon

* **Autoscaling**: HPA on gateway with custom metric `open_ws_connections`; KEDA ScaledJobs if we adopt a queued dispatcher
* **Multi-region** active/active: replicate only session metadata needed for routing; DNS-based client affinity
* **Runner hardening**: Continued improvements (already strong: runAsNonRoot, capabilities drop, seccomp profile)
* **Separate infrastructure and application Terraform** - Reduce blast radius, enable different update cadences

---

## 5) Security Review Status

**Review Date:** 2025-10-22
**Status:** ✅ **APPROVED FOR STAGING**

### Issues Resolved: 24 / 29 (83%)
- **CRITICAL:** 9/9 resolved (100%) 🎉
- **HIGH:** 5/7 resolved (71%)
- **MEDIUM:** 10/13 resolved (77%)

### Key Security Fixes:
1. ✅ Gateway security context - Now matches controller hardening
2. ✅ Workload identity - Proper IAM bindings for both services
3. ✅ TLS configuration - Both ingresses have TLS enabled
4. ✅ ReadOnlyRootFilesystem - Controller set to true
5. ✅ Database connection pooling - Configured for both services
6. ✅ RBAC permissions - Scoped down, removed delete verb
7. ✅ Network policies - Fixed runner pod label mismatch
8. ✅ ResourceQuota & LimitRange - Enabled for cost control
9. ✅ Deployment workflow - Fixed with Skaffold

### Remaining for Production:
- Secret management automation (Issue #11) - Documented but not automated
- Monitoring and alerting (Issue #16)
- Disaster recovery documentation (Issue #17)
- Rate limiting / WAF (Issue #18)

See **[HELM_PLAN.md](./HELM_PLAN.md)** for complete security review.

---

## 6) Documentation (Where to Look / How to Use)

### Infrastructure & Deployment

* **Terraform**
  * `infra/` — Private VPC, GKE Autopilot, Cloud SQL (PostgreSQL), Artifact Registry, service accounts
  * `infra/main.tf` — Now deploys via Helm chart (integrated)

* **Helm Chart**
  * `cliscale-chart/` — Complete Kubernetes application definition
  * `cliscale-chart/values.yaml` — Default configuration
  * `cliscale-chart/templates/` — All K8s resources (Deployments, Services, Ingress, NetworkPolicies, etc.)

* **Skaffold**
  * `skaffold.yaml` — Build + deploy configuration
  * Profiles: `dev`, `staging`, `production`
  * Usage: `skaffold run --default-repo=...`

* **Cloud Build**
  * `cloudbuild.yaml` — Now uses Skaffold (no more raw kubectl)
  * Builds all 3 images: runner, controller, gateway
  * Deploys via Helm automatically

### Database

* **Cloud SQL (PostgreSQL)**
  * `db/schema.sql` — UNLOGGED `sessions` + `token_jti`, indexes, and expiry triggers
  * **Sidecar** Cloud SQL Auth Proxy in controller and gateway deployments
  * Apps connect to `127.0.0.1:5432`

### Authentication

* **User Auth**: Firebase (web demo) → ID token sent to controller
* **Session Auth**: Controller mints **RS256** JWT (10-min, one-time via JTI)
* **JWKS**: Controller exposes `/.well-known/jwks.json`
* Gateway verifies JWT → DB lookup `{sessionId→podIP}` → WS proxy to runner

### Application Code

* `controller/src/server.ts` — Firebase verify → Job create → Postgres writes → mint RS256 session-JWT
  * Health checks: `/healthz` (with DB check), `/readyz`
  * Runner pod creation with proper labels

* `controller/src/sessionJwt.ts` — **RS256 signer** + **JWKS endpoint**
* `controller/src/db.ts` — Database connection pool with configurable limits

* `ws-gateway/src/server.ts` — WS upgrade handler, **JWT verify via JWKS**, DB lookup, JTI replay check, proxy
  * Health check: `/healthz`
  * Database connection pool for JTI and session lookups

* `runner/entrypoint.sh` — Fetch/verify bundle, install, launch **ttyd**

### Demo & CLI

* `sample-cli/src/index.ts` — Stage-wise progress UX
* `sample-cli/src/lib/claude.ts` — `claude` CLI shell-out + Anthropic SDK fallback
* `frontend/index.html` — Firebase Web SDK + **xterm.js** terminal; end-to-end live stream

### Deployment Documentation

* **[DEPLOYMENT.md](./DEPLOYMENT.md)** — Complete step-by-step deployment guide
  * Prerequisites and tool installation
  * Infrastructure setup with Terraform
  * Creating Kubernetes secrets (detailed instructions)
  * Skaffold deployment methods
  * Environment profiles
  * Troubleshooting

* **[QUICK_START.md](./QUICK_START.md)** — 5-minute quick start guide

* **[MIGRATION_SUMMARY.md](./MIGRATION_SUMMARY.md)** — Details of Skaffold + Helm migration

### Security Documentation

* **[HELM_PLAN.md](./HELM_PLAN.md)** — Comprehensive security review
  * All 29 issues tracked with status
  * Configuration verification
  * Code verification results
  * Deployment approval status

* **[CODE_REVIEW_FINDINGS.md](./CODE_REVIEW_FINDINGS.md)** — Application code verification
  * Health check implementation
  * Security context verification
  * Database pooling verification
  * Network policy label verification

---

## 7) Source Files Worth Knowing

| Path                                      | Why it matters                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `infra/*.tf`                              | **Private VPC**, **private GKE Autopilot**, **private Cloud SQL**, Artifact Registry, and **Helm deployment** |
| `db/schema.sql`                           | UNLOGGED `sessions` + `token_jti`, indexes, expiry triggers                                                   |
| `skaffold.yaml`                           | Build + deploy configuration with environment profiles                                                        |
| `cloudbuild.yaml`                         | CI/CD pipeline using Skaffold                                                                                 |
| `cliscale-chart/templates/controller.yaml` | Controller Deployment, Service, Ingress, Cloud SQL Proxy sidecar, security context                           |
| `cliscale-chart/templates/gateway.yaml`   | WS Gateway Deployment, Service, Ingress, BackendConfig, security context                                      |
| `cliscale-chart/templates/networkpolicy.yaml` | Default-deny runner; allow gateway→runner ingress on `:7681`; fixed labels                                    |
| `cliscale-chart/templates/rbac.yaml`      | ServiceAccount, Role, RoleBinding for controller                                                              |
| `cliscale-chart/values.yaml`              | Default configuration for Helm chart                                                                          |
| `controller/src/server.ts`                | Firebase verify → Job create → Postgres writes → mint RS256 JWT → `/healthz`, `/readyz`                      |
| `controller/src/sessionJwt.ts`            | **RS256 signer** (from secret) + **JWKS endpoint** (swap to KMS here)                                         |
| `controller/src/db.ts`                    | PostgreSQL connection pool with configurable limits                                                           |
| `ws-gateway/src/server.ts`                | WS upgrade, **JWT verify via JWKS**, DB lookup, JTI replay check, proxy to runner, connection pooling        |
| `runner/entrypoint.sh`                    | Fetch/verify bundle, install, launch **ttyd** with CLI command                                                |
| `sample-cli/src/index.ts`                 | Stage-wise progress UX                                                                                        |
| `sample-cli/src/lib/claude.ts`            | `claude` CLI shell-out + Anthropic SDK fallback                                                               |
| `frontend/index.html`                     | Firebase Web SDK + **xterm.js** terminal; end-to-end live stream                                              |

---

## 8) Deployment Quick Reference

### From Desktop (App Engine-like)
```bash
skaffold run --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps --profile=staging
```

### Dev Mode with Live Reload
```bash
skaffold dev --port-forward
```

### From Cloud Build (CI/CD)
```bash
gcloud builds submit --config=cloudbuild.yaml
```

### Via Terraform (Infrastructure + Application)
```bash
cd infra && terraform apply
```

---

### Appendix A — Capacity Cheatsheet

* **Gateway sockets**: ~30–60 KB per idle WS; 1M sockets ⇒ ~40–60 GB across 40–80 pods.
* **BackendConfig**: `timeoutSec: 3600–7200`; send WS pings.
* **Runner**: size for your CLI; set `activeDeadlineSeconds`; use `ttlSecondsAfterFinished` to reclaim quickly.
* **Database connections**: Controller + Gateway combined: ~40 connections per replica at max (20 each).

### Appendix B — Threat Model Highlights

* **Token theft** → short-lived **RS256 JWT** (verified via **JWKS** at edge) + **JTI one-time use** (in Postgres) + TLS.
* **Tarbomb/RCE** → checksum + allowlist + size limits + safe extraction; runner script hardened.
* **Pod pivot** → default-deny egress; non-root; capabilities drop; seccomp profile; network policies with correct labels.
* **Network isolation** → NetworkPolicies ensure runner pods only accept connections from gateway on port 7681.
* **Resource exhaustion** → ResourceQuota and LimitRange enabled; connection pool limits configured.

### Appendix C — Migration Milestones

1. **Oct 21**: Raw K8s manifests (k8s/ directory)
2. **Oct 22**: Helm chart migration (cliscale-chart/ directory)
3. **Oct 22**: Skaffold integration (skaffold.yaml)
4. **Oct 22**: Security review & fixes (24/29 issues resolved)
5. **Oct 22**: Code verification (runner labels, health checks, pooling)

---

**Bottom line:** We now have a **production-ready architecture** with:
- ✅ Helm-managed Kubernetes deployments
- ✅ Skaffold for App Engine-like deployment UX
- ✅ All critical security issues resolved (9/9)
- ✅ Code-verified implementation (health checks, security contexts, network policies)
- ✅ Comprehensive documentation (DEPLOYMENT.md, HELM_PLAN.md, CODE_REVIEW_FINDINGS.md)
- ✅ **Approved for staging deployment**

The remaining work is operational (monitoring, DR documentation, rate limiting) - the core system is secure and ready to use.
