# Agents Summary — Full Retrospective (Updated)

> This is the candid history of how the “ephemeral CLI agent” stack evolved: what we tried, what broke, how we scaled, what we secured, and what’s still left to do. It includes the latest switch to **PostgreSQL (Cloud SQL)** for sessions/JTIs, the **WS Gateway** tier, **RS256/JWKS**, and an **end-to-end Firebase Auth web demo**.

---

## 1) Timeline of Key Decisions

| Date (IST) | Decision                                                                                       | Why                                                                | Impact                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 2025-10-01 | Prototype via **k8s exec/attach** from controller                                              | Fast path to a demo                                                | Hit control-plane limits; not viable for high WS concurrency                          |
| 2025-10-03 | **One Kubernetes Job per session**                                                             | Hard isolation + TTL lifecycle                                     | Predictable teardown and resource accounting                                          |
| 2025-10-05 | **In-pod ttyd** + HTTP WS proxy (no node-pty)                                                  | Keep k8s API server out of data path                               | Horizontal scaling; fewer native deps                                                 |
| 2025-10-07 | Design **WS Gateway** tier behind GCLB                                                         | Handle 100k–1M sockets                                             | Shard by `sessionId`; stateless proxy layer                                           |
| 2025-10-08 | **Cloud Build** pipeline (App-Engine-like)                                                     | No local Docker; “upload → build → deploy”                         | Faster onboarding; reproducible images                                                |
| 2025-10-10 | **Firebase Auth** + **Session-JWT**                                                            | Identity vs capability separation                                  | Only the owner attaches; short-lived auth                                             |
| 2025-10-12 | Runner downloads CLI bundle at runtime                                                         | Decouple app from base image                                       | Faster iteration; supply-chain controls                                               |
| 2025-10-14 | Artifact Registry cleanup policies                                                             | Prevent image sprawl                                               | Lower storage costs, simple retention                                                 |
| 2025-10-16 | **SHA-256** verification & allowlist for bundles                                               | Supply-chain defense                                               | Reduce RCE/tarbomb risk                                                               |
| 2025-10-18 | (Old plan) Redis session/JTI store                                                             | Needed multi-replica correctness                                   | **Replaced by Postgres** to simplify ops                                              |
| 2025-10-21 | **Switch to PostgreSQL (Cloud SQL)** + **RS256/JWKS** + **WS Gateway** + **Firebase web demo** | Durable session/JTI, verifiable tokens at edge, full end-to-end UX | Production-leaning architecture; simpler reasoning; easier multi-service verification |

---

## 2) Pain Points / Lessons Learned

### 2.1 WebSockets & Scale

* Don’t stream via `kubectl attach`/API-server: it’s a **hard choke point** beyond a few thousand concurrent sockets.
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

### 2.4 State & Consistency

* We replaced Redis with **PostgreSQL** for sessions/JTIs:

  * **UNLOGGED** tables for speed (ephemeral state) + expiry triggers for opportunistic cleanup.
  * Works well with gateway/controller replicas and token one-time-use semantics.

### 2.5 DX & Delivery

* Cloud Build cold starts are acceptable for the benefit of **no local Docker** and reproducibility.
* Keep runner image generic; pull CLI bundle at runtime to reduce rebuild frequency.

---

## 3) What Went Well

* **Stage-wise CLI** (listr2, ora, chalk, boxen) renders beautifully both in terminal and browser via ttyd.
* **Ephemeral Job** model + TTL keeps infra tidy and costs bounded.
* **Auth layering** (Firebase + session-JWT) is easy to reason about and audit.
* **WS Gateway** + **Postgres** delivers simple, scalable lookup + proxy logic.
* **End-to-end demo** with Firebase web app makes the value obvious and debuggable.

---

## 4) Outstanding Work & Recommendations

### P0 — Now

* **KMS-backed RS256 signing** for session-JWTs; publish JWKS via controller; add key rotation policy.
* **Stronger DB cleanup**: add `pg_cron` (e.g., minutely) to prune `sessions`/`token_jti` by `expires_at` (triggers already prune on writes).
* **Cloud Armor** baseline (rate-limit `POST /api/sessions`, WAF, basic bot rules).

### P1 — Next

* **Private IP** Cloud SQL + VPC-native GKE; restrict egress to DB subnets.
* **Observability**: metrics—open WS, job spin-up latency, gateway CPU/mem/sockets, CLI stage durations; SLOs & alerts.
* **Backpressure/quotas**: per-user session caps; graceful queueing if the cluster is saturated.
* **Artifact scanning**: MIME/type checks, AV/heuristics scan, max archive size, and extraction sandbox.

### P2 — Soon

* **Autoscaling**: HPA on gateway with custom metric `open_ws_connections`; KEDA ScaledJobs if we adopt a queued dispatcher.
* **Multi-region** active/active: replicate only session metadata needed for routing; DNS-based client affinity.
* **Runner hardening**: read-only root FS, non-root UID, seccomp/AppArmor profiles, minimal outbound CIDRs.

---

## 5) Documentation (Where to Look / How to Use)

* **Cloud SQL (PostgreSQL)**

  * `infra/` — Terraform to create Cloud SQL instance (Postgres), DB, and user; outputs `instance_connection_name`.
  * `db/schema.sql` — UNLOGGED `sessions` + `token_jti`, indexes, and expiry triggers.
  * **Sidecar** Cloud SQL Auth Proxy in `k8s/controller.yaml` and `k8s/gateway.yaml`; apps connect to `127.0.0.1:5432`.

* **Auth**

  * **User Auth**: Firebase (web demo) → ID token sent to controller.
  * **Session Auth**: controller mints **RS256** JWT (10-min, one-time via JTI) and exposes **`/.well-known/jwks.json`**.
  * Gateway verifies JWT → DB lookup `{sessionId→podIP}` → WS proxy to runner.

* **Deploy**

  * `cloudbuild.yaml` — Builds/pushes `runner`, `controller`, `ws-gateway`; applies K8s with `envsubst`.
  * `k8s/` — Namespace, RBAC, Deployments, Services, Ingress (GCLB), BackendConfig, NetworkPolicies.

* **End-to-End Demo**

  * `frontend/index.html` — Paste Firebase config; set controller (https) and gateway (wss) URLs; run a session and watch the terminal stream.

* **CLI UX**

  * `sample-cli/` — Stage-wise renderer; calls `claude` CLI if present, else **Anthropic SDK** via `ANTHROPIC_API_KEY`.

---

## 6) Source Files Worth Knowing

| Path                           | Why it matters                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `infra/*.tf`                   | Cloud SQL Postgres + GKE Autopilot + Artifact Registry cleanup                                                |
| `db/schema.sql`                | UNLOGGED `sessions` + `token_jti`, indexes, expiry triggers                                                   |
| `k8s/controller.yaml`          | Controller + Cloud SQL Proxy sidecar; service; env wiring                                                     |
| `k8s/gateway.yaml`             | WS Gateway + Cloud SQL Proxy sidecar; Ingress + BackendConfig                                                 |
| `k8s/networkpolicy.yaml`       | Default-deny runner; allow gateway→runner ingress on `:7681`                                                  |
| `controller/src/server.ts`     | Firebase verify → Job create → Postgres writes → mint RS256 session-JWT → respond `{sessionId, wsUrl, token}` |
| `controller/src/jwt.ts`        | RS256 signer + **JWKS endpoint** (swap to KMS here)                                                           |
| `ws-gateway/src/server.ts`     | WS upgrade handler, JWT verify, `{sessionId→podIP}` lookup, proxy to `podIP:7681`                             |
| `runner/entrypoint.sh`         | Fetch/verify bundle, install, launch **ttyd** with your CLI command                                           |
| `sample-cli/src/index.ts`      | Stage-wise progress UX mirroring the video                                                                    |
| `sample-cli/src/lib/claude.ts` | `claude` CLI shell-out + Anthropic SDK fallback                                                               |
| `frontend/index.html`          | Firebase Web SDK + **xterm.js** terminal; end-to-end live stream                                              |

---

### Appendix A — Capacity Cheatsheet

* **Gateway sockets**: ~30–60 KB per idle WS; 1M sockets ⇒ ~40–60 GB across 40–80 pods.
* **BackendConfig**: `timeoutSec: 3600–7200`; send WS pings.
* **Runner**: size for your CLI; set `activeDeadlineSeconds`; use `ttlSecondsAfterFinished` to reclaim quickly.

### Appendix B — Threat Model Highlights

* **Token theft** → short-lived RS256 JWT + JTI one-time use (in Postgres) + TLS.
* **Tarbomb/RCE** → checksum + allowlist + size limits + safe extraction; consider sandboxing extraction.
* **Pod pivot** → default-deny egress; non-root; read-only FS; minimal capabilities.

---

**Bottom line:** We now have a production-leaning architecture: WS at the edge via a **Gateway**, **PostgreSQL** for session/JTI truth, **RS256/JWKS** for verifiable auth across tiers, and an **end-to-end demo** showing the live, stage-wise CLI experience. The remaining P0s are KMS-backed signing, Hardened cleanup (pg_cron), and Cloud Armor.
