# Agents Summary

## 1. Timeline of Key Decisions
| Date | Decision | Rationale | Impact |
|------|----------|-----------|--------|
| 2025-10-01 | Moved to K8s ephemeral Jobs per session | Isolation, autoscaling, clean teardown | Predictable resource usage |
| 2025-10-05 | WebSocket secured with short‑lived session JWT | Prevent hijacks & cross‑user attach | Stronger session isolation |
| 2025-10-08 | App‑Engine‑style Cloud Build | Zero local Docker; reproducible | Faster team onboarding |
| 2025-10-12 | Runner downloads CLI bundles at runtime | Avoid baking app code into images | Flexible, safer supply chain |

## 2. Pain Points / Lessons Learned
- Avoid k8s `attach` for Internet WS scale—use sidecar/gateway and proxy.
- Verify archive SHA‑256; enforce domain allowlist when executing remote code.
- JWTs: split **identity (Firebase)** from **capability (session JWT)**.
- Tune LB/gateway idle timeouts for long WS sessions.

## 3. What Went Well
- Stage‑wise CLI UX with `listr2` + `ora` is dev‑friendly and clean.
- KEDA/Jobs + TTL keep clusters tidy.
- Cloud Build + Artifact Registry cleanup → no image bloat.

## 4. Outstanding Work & Recommendations
- Swap HMAC → **Cloud KMS** (RS256) and publish JWKS.
- Persist sessions/JTI in **Redis**.
- Add **NetworkPolicies** restricting runner pod ingress to gateway/controller only.
- Cloud Armor rate limits on `/api/sessions`.

## 5. Documentation
- Cloud Build: `cloudbuild.yaml`
- Terraform: `infra/` (GKE + Artifact Registry cleanup)
- Controller API: `controller/src/server.ts`
- Runner bootstrap: `runner/entrypoint.sh`
- Sample CLI: `sample-cli/`

## 6. Source Files Worth Knowing
| File | Purpose |
|------|---------|
| `sample-cli/src/index.ts` | Stage‑wise CLI orchestrator |
| `sample-cli/src/lib/claude.ts` | Calls `claude` CLI or falls back to Anthropic SDK |
| `controller/src/server.ts` | Session create (Firebase ID token), mint session JWT, create Job, WS proxy |
| `runner/entrypoint.sh` | Download/verify bundle; install; run via ttyd |
| `infra/*.tf` | GKE + Artifact Registry with cleanup |