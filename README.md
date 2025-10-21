# Full Agent Stack (GKE + Cloud Build + WS + Firebase + Sample CLI)

This is the **complete, integrated** solution you asked for.

## What's here
- **Terraform (`infra/`)** – GKE Autopilot + Artifact Registry with cleanup (no old images kept).
- **Cloud Build (`cloudbuild.yaml`)** – upload source → build runner & controller → deploy to GKE.
- **Kubernetes (`k8s/`)** – namespace, RBAC, controller Deployment/Service/Ingress.
- **Controller (`controller/`)** – API to create sessions (auth via Firebase ID token), mint session‑JWT, create Job, and WS‑proxy to runner pod.
- **Runner (`runner/`)** – Generic image that downloads a CLI bundle (S3 presigned/GitHub), verifies SHA‑256 (optional), installs deps, and runs it behind `ttyd` (port 7681).
- **Sample CLI (`sample-cli/`)** – Stage‑wise Node CLI (listr2/ora/chalk/boxen) with a Claude Code step. Falls back to Anthropic SDK if `claude` binary is absent.

---

## One‑command deploy (App‑Engine‑style)

```bash
gcloud builds submit --config cloudbuild.yaml   --substitutions=_REGION=us-central1,_REPO=apps,_CLUSTER=cli-runner-gke,_LOCATION=us-central1,_NAMESPACE=ws-cli,_DOMAIN=ws.example.com
```

**Cloud Build** will: build images in GCP → push to Artifact Registry (with cleanup) → `kubectl apply` manifests → wait for rollout.

---

## Using the API

1) Authenticate on the frontend with **Firebase Auth** → get **ID token**.
2) Create a session:
```bash
curl -s -X POST https://<controller-domain>/api/sessions  -H "authorization: Bearer <FIREBASE_ID_TOKEN>"  -H "content-type: application/json"  -d '{
   "code_url": "https://raw.githubusercontent.com/you/sample-cli-zip/main/sample-cli.zip",
   "code_checksum_sha256": "<optional-sha256>",
   "command": "npm run build && node dist/index.js run",
   "prompt": "Analyze the authentication system and suggest improvements"
 }'
# => { "sessionId": "...", "wsUrl": "/ws/<id>", "token": "<session-jwt>" }
```
3) Connect the **WebSocket** with the session token (subprotocol is best):
```
Sec-WebSocket-Protocol: bearer,<session-jwt>
```

You’ll see the **stage‑wise CLI UI** stream live.

---

## Notes
- Set `ANTHROPIC_API_KEY` (Secret/env) if using SDK fallback.
- To use real **Claude Code CLI**, place the `claude` binary in PATH inside the runner (extend `entrypoint.sh`).
- Tighten security with NetworkPolicies + KMS‑signed JWTs + Redis.

See `agents.md` for decisions and follow‑ups.
