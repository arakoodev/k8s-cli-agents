# Deployment Guide for CLI Scale

Deploy CLI Scale to GKE and access it via load balancer IP - no domain required!

## 🎯 TL;DR

```bash
# 1. Deploy
skaffold run --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps --profile=staging

# 2. Get load balancer IP
export LB_IP=$(kubectl get ingress cliscale-ingress -n ws-cli -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

# 3. Use it!
curl -X POST "http://$LB_IP/api/sessions" -H "Authorization: Bearer $API_KEY" ...
```

**That's it!** No DNS setup, no domain configuration, no TLS certificates needed.

---

## Prerequisites

### Required Tools

```bash
# Skaffold (for deployment)
brew install skaffold
# OR
curl -Lo skaffold https://storage.googleapis.com/skaffold/releases/latest/skaffold-linux-amd64
chmod +x skaffold && sudo mv skaffold /usr/local/bin

# kubectl (comes with gcloud)
gcloud components install kubectl

# Helm (optional, for manual operations)
brew install helm
```

### GCP Project Setup

```bash
export PROJECT_ID="your-project-id"
gcloud config set project $PROJECT_ID

# Enable required APIs
gcloud services enable \
  container.googleapis.com \
  sqladmin.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com
```

---

## Infrastructure Setup (One-Time)

### 1. Deploy Infrastructure with Terraform

```bash
cd infra
terraform init

# Create terraform.tfvars
cat > terraform.tfvars <<EOF
project_id      = "your-project-id"
region          = "us-central1"
db_user         = "appuser"
db_password     = "STRONG_PASSWORD_HERE"
db_name         = "wscli"
controller_image_tag = "latest"
gateway_image_tag    = "latest"
runner_image_tag     = "latest"
EOF

# Deploy
terraform apply
```

**Creates:**
- VPC with private GKE cluster
- Cloud SQL PostgreSQL instance
- Artifact Registry
- Service accounts with workload identity

### 2. Initialize Database

```bash
# Get connection name
export SQL_INSTANCE=$(terraform -chdir=infra output -raw instance_connection_name)

# Connect and initialize
gcloud sql connect ws-cli-pg --user=appuser
# In psql:
\i ../db/schema.sql
\q
```

### 3. Create Kubernetes Secrets

```bash
# Get GKE credentials
gcloud container clusters get-credentials ws-cli-cluster --region us-central1

# Create namespace
kubectl create namespace ws-cli

# 1. API Key
export API_KEY=$(openssl rand -base64 32)
echo "SAVE THIS: $API_KEY"
kubectl create secret generic cliscale-api-key -n ws-cli \
  --from-literal=API_KEY="$API_KEY"

# 2. Database URL
kubectl create secret generic pg -n ws-cli \
  --from-literal=DATABASE_URL="postgresql://appuser:YOUR_PASSWORD@127.0.0.1:5432/wscli"

# 3. JWT Keys
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
kubectl create secret generic jwt -n ws-cli \
  --from-file=private.pem \
  --from-file=public.pem
rm private.pem public.pem
```

---

## Deploy Application

### Simple Deployment (No Configuration Needed!)

```bash
skaffold run \
  --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps \
  --profile=staging
```

**What this does:**
1. Builds controller, gateway, and runner via Cloud Build
2. Pushes to Artifact Registry
3. Deploys via Helm
4. Creates GCE load balancer
5. ✅ Done!

### Development Mode (Live Reload)

```bash
skaffold dev \
  --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps \
  --profile=dev \
  --port-forward
```

Watches for code changes and automatically rebuilds/redeploys.

---

## Get Load Balancer IP

```bash
# Wait for provisioning (5-10 minutes after deployment)
kubectl get ingress cliscale-ingress -n ws-cli -w

# Once ADDRESS appears:
export LB_IP=$(kubectl get ingress cliscale-ingress -n ws-cli -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "Load Balancer IP: $LB_IP"
```

---

## Testing

### Get API Key

```bash
export API_KEY=$(kubectl get secret cliscale-api-key -n ws-cli -o jsonpath='{.data.API_KEY}' | base64 -d)
echo "API Key: $API_KEY"
```

### Create a Session

```bash
curl -X POST "http://$LB_IP/api/sessions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "code_url": "https://github.com/arakoodev/cliscale/tree/main/sample-cli",
    "command": "node index.js run",
    "prompt": "Test",
    "install_cmd": "npm install"
  }'
```

**Response:**
```json
{
  "sessionId": "abc-123",
  "sessionJWT": "eyJhbGc..."
}
```

### Open Terminal

Navigate to:
```
http://YOUR_LB_IP/ws/abc-123?token=eyJhbGc...
```

**You should see:**
- ✅ Terminal interface loads
- ✅ Status shows "Connected" (green)
- ✅ Live CLI output streaming

---

## Profiles

### Dev Profile
- 1 replica each
- HPA disabled
- Good for local testing

```bash
skaffold run --profile=dev
```

### Staging Profile (Default)
- 2 replicas each
- HPA enabled
- Good for testing

```bash
skaffold run --profile=staging
```

### Production Profile
- 3+ replicas
- Resource quotas enabled
- Full hardening

```bash
skaffold run --profile=production
```

---

## Updating

```bash
# Rebuild and redeploy
skaffold run \
  --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps \
  --profile=staging
```

---

## Rollback

```bash
# Via Helm
helm rollback cliscale -n ws-cli

# Via kubectl
kubectl rollout undo deployment/cliscale-controller -n ws-cli
kubectl rollout undo deployment/cliscale-gateway -n ws-cli
```

---

## Troubleshooting

### Pods not starting

```bash
# Check events
kubectl describe pod -n ws-cli

# Check logs
kubectl logs -n ws-cli -l app.kubernetes.io/component=controller --tail=50
kubectl logs -n ws-cli -l app.kubernetes.io/component=gateway --tail=50

# Common issues:
# - Missing secrets (api-key, pg, jwt)
# - Wrong database URL
# - Cloud SQL proxy not connecting
```

### Load balancer has no IP

```bash
# Check ingress status
kubectl describe ingress cliscale-ingress -n ws-cli

# Takes 5-10 minutes to provision
# Check GCP Console: Network Services → Load Balancing
```

### WebSocket not connecting

```bash
# Check JWT hasn't expired (they're short-lived, ~5 min)
# Check gateway logs
kubectl logs -n ws-cli -l app.kubernetes.io/component=gateway --tail=100

# Check if session exists
kubectl get jobs -n ws-cli
```

---

## ❓ FAQ

### Do I need a domain?
**NO.** Use the load balancer IP: `http://34.120.45.67`

### Can I add a domain later?
**YES.** Point DNS A record to the LB IP, then redeploy with:
```bash
skaffold run --set-value ingress.hostname=your.domain.com
```

### How do I enable HTTPS?
You need a domain first, then install cert-manager:
```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.3/cert-manager.yaml
```
See cert-manager docs for ClusterIssuer configuration.

### What's CONTROLLER_URL in the logs?
That's the internal Kubernetes DNS name. Pods use it to talk to each other. You never use it - you use the load balancer IP.

### How do I change the API key?
```bash
kubectl delete secret cliscale-api-key -n ws-cli
export NEW_KEY=$(openssl rand -base64 32)
kubectl create secret generic cliscale-api-key -n ws-cli --from-literal=API_KEY="$NEW_KEY"
kubectl rollout restart deployment/cliscale-controller -n ws-cli
```

---

## Clean Up

### Delete Application Only

```bash
skaffold delete -n ws-cli
# OR
helm uninstall cliscale -n ws-cli
kubectl delete namespace ws-cli
```

### Delete Everything (Infrastructure + App)

```bash
cd infra
terraform destroy
```

---

## Useful Commands

```bash
# Quick deploy
skaffold run --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps --profile=staging

# Dev mode
skaffold dev --port-forward --profile=dev

# Build only
skaffold build --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps

# Check status
kubectl get all -n ws-cli
kubectl get ingress cliscale-ingress -n ws-cli

# View logs
kubectl logs -n ws-cli -l app.kubernetes.io/component=controller --tail=100 -f
kubectl logs -n ws-cli -l app.kubernetes.io/component=gateway --tail=100 -f

# Port forward (for local testing)
kubectl port-forward -n ws-cli svc/cliscale-controller 8080:80
kubectl port-forward -n ws-cli svc/cliscale-gateway 8081:80
```

---

## Production Checklist

Before going to production:

- [ ] API key generated with strong randomness
- [ ] Database password is strong (not default)
- [ ] Secrets stored in Google Secret Manager (not kubectl)
- [ ] Resource quotas and limits configured
- [ ] HPA tested and working
- [ ] Pod anti-affinity rules added
- [ ] Network policies tested
- [ ] Load balancer provisioned successfully
- [ ] Backup and disaster recovery plan
- [ ] Monitoring and alerting configured
- [ ] Cloud Armor configured (DDoS protection)
- [ ] Consider adding domain + TLS for production
