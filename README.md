

# 🧠 Full Agent Stack — GKE + WebSockets + Firebase + Claude Code CLI

This project is an **end-to-end system** for running *ephemeral AI “CLI agents”* securely on Kubernetes, streaming real-time, stage-wise output to a browser or terminal through WebSockets.
It combines:

* **GKE Autopilot (via Terraform)**
* **Google Cloud Build** for “App Engine–style” deploys (no local Docker builds)
* **Controller API** that spawns short-lived Kubernetes Jobs per session
* **Runner pods** that download user-specified CLI bundles from S3/GitHub and stream their output
* **WebSocket gateway** for live interactive feedback
* **Firebase Auth + JWT** for secure session handshakes
* **Claude Code CLI / Anthropic SDK** for AI-assisted coding
* **Stage-wise Node CLI** (via `listr2`, `ora`, `chalk`) to give the same beautiful “progressive terminal” UX you saw in the video.

---

## 🏗️ System Overview

### Architecture

```
Browser / Frontend
   ↓ (Firebase ID Token)
Controller API (Express)
   ↓ verifies token via Firebase Admin SDK
   ↓ mints short-lived session JWT
   ↓ creates Kubernetes Job with runner image + code_url
Runner Pod (ephemeral)
   ↓ downloads bundle (GitHub/S3)
   ↓ installs deps + runs CLI via ttyd
   ↓ streams logs to port 7681
Controller WS proxy
   ↔ WebSocket stream ↔ Browser
```

Each user session has:

* 1 Kubernetes Job
* 1 ephemeral Pod
* 1 session JWT (10-minute, one-time use)
* 1 WebSocket connection streaming live task stages

When the CLI finishes, the pod auto-terminates (TTL controlled by KEDA/Job TTL).

---

## 🎬 End User Experience

From the end user’s perspective, this feels like a **“live AI coding shell”**:

1. They log in using **Firebase Authentication** (Google or email/password).
2. The frontend calls `POST /api/sessions`, passing their Firebase ID token.
3. The controller spins up a new runner pod for them and returns:

   ```json
   {
     "sessionId": "abc123",
     "wsUrl": "/ws/abc123",
     "token": "<session-jwt>"
   }
   ```
4. The browser connects via WebSocket:

   ```
   wss://your-domain/ws/abc123
   Sec-WebSocket-Protocol: bearer,<session-jwt>
   ```
5. Within seconds, the user sees the **stage-wise CLI output** appear live — colored progress indicators, logs, and Claude Code commentary.

It feels like watching a real developer coding interactively inside a container.

---

## 🔒 Security Model

| Layer             | Responsibility      | Mechanism                                         |
| ----------------- | ------------------- | ------------------------------------------------- |
| **User Auth**     | Identify user       | Firebase Authentication (OIDC/JWT)                |
| **Session Auth**  | Authorize session   | Short-lived (10m) HMAC JWT                        |
| **Pod Isolation** | Sandbox execution   | K8s Job per session                               |
| **Network**       | Protect WS streams  | Only controller namespace can talk to runner pods |
| **Artifacts**     | Safe code execution | SHA-256 + domain allowlist for `code_url`         |

---

## 💻 Testing Locally

### 1️⃣ Run the Controller

```bash
cd controller
npm install
export SESSION_JWT_SECRET="dev-secret"
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/firebase-service-account.json"
npm run dev
```

This starts the Express controller at `http://localhost:8080`.

### 2️⃣ Run the Runner (Simulated)

```bash
cd runner
docker build -t local-runner .
docker run -it -p 7681:7681 \
  -e CODE_URL="https://github.com/your-org/sample-cli/archive/refs/heads/main.zip" \
  -e COMMAND="npm run build && node dist/index.js run" \
  -e CLAUDE_PROMPT="Analyze the authentication system and suggest improvements" \
  local-runner
```

Visit [http://localhost:7681](http://localhost:7681) to see the CLI stream in your browser.

### 3️⃣ Run the Sample CLI Locally

```bash
cd sample-cli
npm install
npm run dev
```

This shows the **stage-wise CLI** on your terminal:

* ✅ Animated spinners (`ora`)
* 🧩 Multi-stage workflow (`listr2`)
* 🎨 Beautiful output boxes (`boxen`, `chalk`)
* 🤖 Claude Code integration (via CLI or Anthropic SDK fallback)

Example output:

```
╭─────────────────────────────────────────────╮
│ Root Workflow - Stage-wise demo             │
╰─────────────────────────────────────────────╯

✔ Prepare Workspace
✔ Generate Glossaries
✔ Consolidate API Docs
⠸ AI-SECURITY-AUDIT (Claude Code/SDK)
  Preparing branch...
  Implementing code...
  Running tests...
  Assembling PRD...
  Uploading PRD...
```

If `claude` CLI is installed, it will stream real plans.
Otherwise it will fallback to Anthropic SDK (using `ANTHROPIC_API_KEY`).

---

## ☁️ Deploying to Google Cloud

1. **Provision infra:**

```bash
cd infra
terraform init
terraform apply -var="project_id=YOUR_GCP_PROJECT"
```

2. **Deploy via Cloud Build:**

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_REGION=us-central1,_CLUSTER=cli-runner-gke,_DOMAIN=ws.example.com,_NAMESPACE=ws-cli,_REPO=apps
```

3. **Verify:**

```bash
kubectl -n ws-cli get pods
kubectl -n ws-cli logs deploy/ws-cli-controller
```

4. **Access:**
   Your API will be live at `https://ws.example.com/api/sessions`.

---

## 🧩 Integrating the Sample CLI with Claude Code

The sample CLI (`sample-cli/src/lib/claude.ts`) can:

* Call `claude --permission-mode plan -p "<prompt>"` if the binary exists.
* Else fallback to the Anthropic SDK:

  ```bash
  export ANTHROPIC_API_KEY=sk-ant-...
  npm run dev
  ```
* In the runner pods, this output is streamed through `ttyd` over WebSocket.

---

## 🧰 For Developers

| Component         | Path            | Description                                   |
| ----------------- | --------------- | --------------------------------------------- |
| `controller/`     | Express API     | Auth, JWT minting, Job creation, WS proxy     |
| `runner/`         | Bash entrypoint | Downloads CLI bundle, installs, runs via ttyd |
| `sample-cli/`     | Node CLI        | Listr2 + Claude Code demo                     |
| `infra/`          | Terraform       | GKE Autopilot + Artifact Registry             |
| `k8s/`            | YAML            | Namespaces, RBAC, Controller Deployment       |
| `cloudbuild.yaml` | GCB             | Build + Deploy pipeline                       |
| `agents.md`       | Notes           | Timeline, Lessons, Recommendations            |

---

## 🧱 How the WebSocket Flow Works

1. Browser connects:
   `wss://ws.example.com/ws/<sessionId>`
   with header `Sec-WebSocket-Protocol: bearer,<session-jwt>`

2. Controller:

   * Validates the JWT (subject=userId, sid=sessionId)
   * Locates the corresponding runner pod’s IP (`podIP`)
   * Proxies the WS stream via `http-proxy`

3. Runner:

   * `ttyd` bridges `stdout` of the sample CLI to WebSocket output.
   * Every `ora` spinner or Listr2 stage update is visible live in the browser.

4. When CLI exits:

   * Pod auto-terminates (TTLSecondsAfterFinished)
   * JWT is invalidated (one-time use)
   * Controller cleans up memory map entry

---

## ⚙️ Customization

* Replace `sample-cli` with your own project zipped and uploaded to S3 or GitHub.
* Add new envs to the controller for domain, prompt templates, Claude models.
* Add your own Web UI that connects to `/api/sessions` and `/ws/<session>`.

---

## 🔐 Hardening Checklist

* [ ] Migrate JWT signing from HMAC → Cloud KMS (RS256).
* [ ] Use Redis for session + JTI storage.
* [ ] Apply NetworkPolicy to restrict ingress to runner pods.
* [ ] Scan downloaded bundles (GCS VirusTotal / Binary Authorization).
* [ ] Enable Cloud Armor rate limiting on controller ingress.

---

## 🧩 Summary

| Feature                  | What it Does                                         |
| ------------------------ | ---------------------------------------------------- |
| 🪄 **Firebase Auth**     | Handles user login and ID token issuance             |
| 🔏 **Session JWTs**      | Short-lived, session-bound authorization             |
| 🧰 **Controller API**    | Orchestrates K8s Jobs and WebSocket proxy            |
| 🧩 **Runner Pods**       | Run user CLIs securely and stream logs               |
| 💬 **WebSocket Bridge**  | Real-time stream from `ttyd` to browser              |
| 🎨 **Sample CLI**        | Beautiful stage-wise progress UI (Claude-integrated) |
| ☁️ **Cloud Build + GKE** | Seamless no-laptop deployment                        |

---
