# Quick Start - Deploy in 5 Minutes

Fast track to deploying cliscale with Skaffold + Helm.

---

## Prerequisites Check

```bash
# Check if tools are installed
skaffold version    # Need v2.0+
gcloud --version    # Need latest
kubectl version     # Should be installed with gcloud

# Not installed? Quick install:
# Skaffold: https://skaffold.dev/docs/install/
# gcloud: https://cloud.google.com/sdk/docs/install
```

---

## Step 1: Infrastructure (5 min)

```bash
cd infra

# Create terraform.tfvars
cat > terraform.tfvars <<EOF
project_id = "YOUR_PROJECT_ID"
region = "us-central1"
db_user = "appuser"
db_password = "$(openssl rand -base64 32)"
domain = "cliscale.yourdomain.com"
ws_domain = "ws.yourdomain.com"
EOF

# Deploy infrastructure
terraform init
terraform apply -auto-approve

# Initialize database
gcloud sql connect ws-cli-pg --user=appuser
# In psql: \i ../db/schema.sql
```

---

## Step 2: Secrets (2 min)

```bash
# Get cluster credentials
gcloud container clusters get-credentials ws-cli-cluster --region us-central1

# Create namespace
kubectl create namespace ws-cli

# Database secret
kubectl create secret generic pg -n ws-cli \
  --from-literal=DATABASE_URL="postgresql://appuser:PASSWORD@127.0.0.1:5432/wscli"

# JWT keys
openssl genrsa -out /tmp/private.pem 2048
openssl rsa -in /tmp/private.pem -pubout -out /tmp/public.pem
kubectl create secret generic jwt -n ws-cli \
  --from-file=/tmp/private.pem --from-file=/tmp/public.pem
rm /tmp/*.pem

# TLS certs (self-signed for testing - use cert-manager for prod!)
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /tmp/tls.key -out /tmp/tls.crt \
  -subj "/CN=*.yourdomain.com"
kubectl create secret tls controller-tls -n ws-cli \
  --cert=/tmp/tls.crt --key=/tmp/tls.key
kubectl create secret tls gateway-tls -n ws-cli \
  --cert=/tmp/tls.crt --key=/tmp/tls.key
rm /tmp/tls.*
```

---

## Step 3: Deploy with Skaffold (3 min)

```bash
# Set variables
export PROJECT_ID="YOUR_PROJECT_ID"
export DOMAIN="cliscale.yourdomain.com"
export WS_DOMAIN="ws.yourdomain.com"

# Deploy!
skaffold run \
  --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps \
  --profile=dev \
  --set-value domain=$DOMAIN \
  --set-value wsDomain=$WS_DOMAIN \
  --set-value controller.tls.secretName=controller-tls \
  --set-value gateway.tls.secretName=gateway-tls

# Wait for it... (2-3 minutes)
# ✅ Done!
```

---

## Step 4: Verify

```bash
# Check pods
kubectl get pods -n ws-cli

# Check ingress (wait for EXTERNAL-IP)
kubectl get ingress -n ws-cli

# Port forward for testing
kubectl port-forward -n ws-cli svc/cliscale-controller 8080:80
kubectl port-forward -n ws-cli svc/cliscale-gateway 8081:80

# Test
curl http://localhost:8080/healthz
curl http://localhost:8081/healthz
```

---

## Step 5: Update Code (30 seconds)

```bash
# Make code changes, then:
skaffold run --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps

# Or use dev mode for live reload:
skaffold dev --port-forward
```

---

## Common Commands

### Deploy
```bash
# Dev environment
skaffold run --profile=dev --default-repo=...

# Staging
skaffold run --profile=staging --default-repo=...

# Production
skaffold run --profile=production --default-repo=...
```

### Monitor
```bash
# Logs
kubectl logs -n ws-cli -l app.kubernetes.io/component=controller -f
kubectl logs -n ws-cli -l app.kubernetes.io/component=gateway -f

# Status
kubectl get all -n ws-cli
kubectl describe pod <pod-name> -n ws-cli
```

### Debug
```bash
# Port forward
kubectl port-forward -n ws-cli svc/cliscale-controller 8080:80

# Exec into pod
kubectl exec -it -n ws-cli <pod-name> -- /bin/sh

# Check secrets
kubectl get secrets -n ws-cli
```

### Cleanup
```bash
# Delete app only
skaffold delete

# Delete everything
cd infra && terraform destroy
```

---

## Troubleshooting

### "Error: chart not found"
Run from repo root where `skaffold.yaml` exists.

### "ImagePullBackOff"
```bash
gcloud auth configure-docker us-central1-docker.pkg.dev
```

### "Pending pods"
Check events: `kubectl describe pod <pod-name> -n ws-cli`

Usually missing secrets or insufficient resources.

### "Connection refused"
Wait for Load Balancer (5-10 min first time):
```bash
kubectl get ingress -n ws-cli -w
```

---

## Next Steps

- **Production Setup**: See [DEPLOYMENT.md](./DEPLOYMENT.md)
- **Security Review**: See [HELM_PLAN.md](./HELM_PLAN.md)
- **Full Docs**: See [README.md](./README.md)

---

## Pro Tips

1. **Save your config**: Create `.env` file with PROJECT_ID, DOMAIN, etc.
2. **Use profiles**: `--profile=dev` for testing, `production` for real
3. **Dev mode**: `skaffold dev` watches code changes and auto-deploys
4. **Cloud Build**: For CI/CD, use `gcloud builds submit`
5. **Secrets**: Use Google Secret Manager + External Secrets Operator in prod

---

**You're all set! 🚀**

Deploy: `skaffold run --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps`
