# **CLI Scale — Ephemeral CLI Agents on Kubernetes**

> Run short-lived CLI jobs on Kubernetes with WebSocket streaming, PostgreSQL session management, and API key authentication.
> Access everything via a single load balancer IP address - no domain required!

## 🎯 Quick Start

**Get your load balancer IP and start using it:**

```bash
# 1. Get load balancer IP (after deployment)
export LB_IP=$(kubectl get ingress cliscale-ingress -n ws-cli -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
export API_KEY=$(kubectl get secret cliscale-api-key -n ws-cli -o jsonpath='{.data.API_KEY}' | base64 -d)

# 2. Create a session
curl -X POST "http://$LB_IP/api/sessions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"code_url": "https://github.com/user/repo/tree/main/folder", "command": "npm start"}'

# 3. Open the terminal in your browser
# http://YOUR_LB_IP/ws/{sessionId}?token={jwt}
```

**That's it!** No DNS, no domains, no TLS required for testing.

---

## 🚀 Overview

This stack runs **ephemeral CLI agents** inside Kubernetes Jobs with:
- **API Key Authentication**: Simple Bearer token auth
- **WebSocket Streaming**: Live terminal output via xterm.js
- **Session Management**: PostgreSQL tracks sessions and prevents JWT replay
- **One Load Balancer**: Single IP address handles all traffic

### How It Works

1. **Create Session**: Call `POST http://LB_IP/api/sessions` with API key
2. **Spawn Job**: Controller creates a Kubernetes Job to run your code
3. **Get URL**: Response includes `sessionId` and `sessionJWT`
4. **Open Terminal**: Navigate to `http://LB_IP/ws/{sessionId}?token={jwt}`
5. **Stream Output**: xterm.js automatically connects and streams live output

---

## 🧩 Architecture

```
                    http://YOUR_LB_IP
                           │
              ┌────────────┴────────────┐
              │  GCE Load Balancer      │
              │  (Path-based routing)   │
              └────────────┬────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   /api/* routes      /ws/* routes    /.well-known/*
        │                  │                  │
        ▼                  ▼                  │
  ┌──────────┐      ┌──────────┐            │
  │Controller│      │ Gateway  │◄───────────┘
  │ - Auth   │      │- xterm.js│
  │ - Jobs   │      │- WS Proxy│
  └─────┬────┘      └─────┬────┘
        │                  │
        └────────┬─────────┘
                 ▼
        ┌──────────────────┐
        │  PostgreSQL      │
        │  - Sessions      │
        │  - JTIs          │
        └──────────────────┘
```

### Path-Based Routing

The load balancer routes by URL path:

| Request | Backend |
|---------|---------|
| `POST /api/sessions` | Controller (creates session) |
| `GET /api/sessions/{id}` | Controller (get session info) |
| `GET /.well-known/jwks.json` | Controller (JWT verification) |
| `GET /ws/{sessionId}?token={jwt}` | Gateway (serves xterm.js HTML) |
| `WS /ws/{sessionId}` | Gateway (WebSocket proxy to runner) |

---

## ⚙️ Components

### 1. Controller
- Validates API key from `Authorization: Bearer {key}`
- Creates Kubernetes Jobs (one per session)
- Mints short-lived RS256 session JWTs with one-time JTI
- Exposes JWKS endpoint for JWT verification
- Rate limiting: 5 requests/min per IP

### 2. Gateway
- Serves self-hosted xterm.js terminal at `/ws/{sessionId}?token={jwt}`
- Verifies session JWTs via controller's JWKS endpoint
- Prevents JWT replay by consuming one-time JTI
- Proxies WebSocket traffic to runner pods
- Scales horizontally (stateless)

### 3. Runner
- Downloads code from URL (supports GitHub tree URLs like `github.com/user/repo/tree/main/folder`)
- Installs dependencies
- Runs command in isolated Kubernetes Job
- Streams output via ttyd on port 7681
- Auto-cleanup with TTL

### 4. PostgreSQL (Cloud SQL)
- Stores session metadata (`sessionId` → `podIP` mapping)
- Tracks one-time JTIs to prevent JWT replay
- Auto-prunes expired sessions

---

## ☸️ Deployment

### Prerequisites

```bash
# Install tools
brew install skaffold  # or: curl -Lo skaffold https://storage.googleapis.com/skaffold/releases/latest/skaffold-darwin-amd64
gcloud components install kubectl

# Set up GCP project
export PROJECT_ID="your-project-id"
gcloud config set project $PROJECT_ID
```

### One-Command Deployment

```bash
# Deploy everything (builds images via Cloud Build, deploys via Helm)
skaffold run \
  --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps \
  --profile=staging
```

**What this does:**
1. Builds controller, gateway, and runner Docker images
2. Pushes to Artifact Registry via Cloud Build
3. Deploys via Helm
4. Creates a GCE load balancer
5. ✅ Ready to use!

### Get Your Load Balancer IP

```bash
# Wait for load balancer to provision (5-10 minutes)
kubectl get ingress cliscale-ingress -n ws-cli -w

# Once ADDRESS appears, export it
export LB_IP=$(kubectl get ingress cliscale-ingress -n ws-cli -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "Load Balancer IP: $LB_IP"
```

### Get Your API Key

```bash
export API_KEY=$(kubectl get secret cliscale-api-key -n ws-cli -o jsonpath='{.data.API_KEY}' | base64 -d)
echo "API Key: $API_KEY"
```

---

## 🧪 Testing

### Create a Session

```bash
curl -X POST "http://$LB_IP/api/sessions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "code_url": "https://github.com/arakoodev/cliscale/tree/main/sample-cli",
    "command": "node index.js run",
    "prompt": "Hello!",
    "install_cmd": "npm install"
  }'
```

**Response:**
```json
{
  "sessionId": "abc-123-def-456",
  "sessionJWT": "eyJhbGc..."
}
```

### Open Terminal

Navigate to:
```
http://YOUR_LB_IP/ws/abc-123-def-456?token=eyJhbGc...
```

✅ Terminal loads automatically
✅ Connects via WebSocket
✅ Streams live output

### Supported Code URLs

- **GitHub tree**: `https://github.com/owner/repo/tree/branch/folder`
- **Zip**: `https://example.com/code.zip`
- **Tarball**: `https://example.com/code.tar.gz`
- **Git repo**: `https://github.com/owner/repo.git`

---

## 🔒 Security

| Layer | Mechanism |
|-------|-----------|
| API Access | API key (Bearer token from K8s secret) |
| Session Access | Short-lived RS256 JWT with one-time JTI |
| Gateway | JWT verification + JTI replay prevention |
| Runner | Isolated Job with NetworkPolicy + TTL cleanup |
| Database | Private IP, unlogged tables, auto-expiry |
| Rate Limiting | 5 req/min per IP for session creation |

**Recommended Hardening:**
- Use Cloud KMS for JWT signing keys
- Enable VPC-SC for additional isolation
- Add Cloud Armor for DDoS protection
- Validate code URLs against allowlists

---

## ❓ FAQ

### Q: Do I need a domain?
**NO.** Use the load balancer IP directly: `http://34.120.45.67`

### Q: Can I add a domain later?
**YES.** Set DNS A record to LB IP, then:
```bash
skaffold run --set-value ingress.hostname=cliscale.yourdomain.com
```

### Q: Does WebSocket work over HTTP (not HTTPS)?
**YES.** WebSocket works fine over HTTP. Use `ws://` protocol.

### Q: How do I enable HTTPS?
You need a domain first, then add cert-manager. See DEPLOYMENT.md.

### Q: What's the difference between LB IP and CONTROLLER_URL?
- **LB IP** (`http://34.120.45.67`): External access - YOU use this
- **CONTROLLER_URL** (`http://cliscale-controller.ws-cli.svc.cluster.local`): Internal K8s DNS - pods use this

### Q: How long do JWTs last?
About 5 minutes. They're single-use (JTI is consumed on first WebSocket connection).

### Q: Where is the xterm.js frontend?
Embedded in the gateway. No separate deployment needed.

---

## 📂 Project Structure

```
cliscale/
├── controller/           # API + job spawning
├── ws-gateway/           # WebSocket proxy + xterm.js serving
├── runner/               # Job container (downloads code, runs CLI)
├── cliscale-chart/       # Helm chart
├── skaffold.yaml         # Build & deploy config
├── db/schema.sql         # PostgreSQL schema
└── sample-cli/           # Example CLI to run
```

---

## 🔧 Development

```bash
# Live reload during development
skaffold dev --port-forward \
  --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps \
  --profile=dev
```

---

## 📚 Documentation

- **[DEPLOYMENT.md](./DEPLOYMENT.md)**: Detailed deployment guide
- **[HELM_PLAN.md](./HELM_PLAN.md)**: Security review
- **[CODE_REVIEW_FINDINGS.md](./CODE_REVIEW_FINDINGS.md)**: Implementation verification

---

## ✅ Quick Recap

| Step | Command |
|------|---------|
| Deploy | `skaffold run --default-repo=...` |
| Get IP | `kubectl get ingress cliscale-ingress -n ws-cli` |
| Get API Key | `kubectl get secret cliscale-api-key -n ws-cli -o jsonpath='{.data.API_KEY}' \| base64 -d` |
| Create Session | `curl -X POST http://$LB_IP/api/sessions -H "Authorization: Bearer $API_KEY" ...` |
| Open Terminal | `http://$LB_IP/ws/{sessionId}?token={jwt}` |

**No domain required. No TLS required. Just works.** 🎉
