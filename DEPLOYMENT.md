# Deployment Guide for cliscale

This guide covers deploying cliscale using Skaffold + Helm for an App Engine-like deployment experience.

---

## Prerequisites

### Required Tools

1. **Google Cloud SDK (gcloud)**: [Install](https://cloud.google.com/sdk/docs/install)
2. **Skaffold**: [Install](https://skaffold.dev/docs/install/)
   ```bash
   # macOS
   brew install skaffold

   # Linux
   curl -Lo skaffold https://storage.googleapis.com/skaffold/releases/latest/skaffold-linux-amd64
   chmod +x skaffold
   sudo mv skaffold /usr/local/bin
   ```
3. **kubectl**: Usually comes with gcloud
   ```bash
   gcloud components install kubectl
   ```
4. **Helm** (optional, for manual operations): [Install](https://helm.sh/docs/intro/install/)

### GCP Project Setup

```bash
# Set your project
export PROJECT_ID="your-gcp-project-id"
gcloud config set project $PROJECT_ID

# Enable required APIs (done by Terraform, but verify)
gcloud services enable \
  container.googleapis.com \
  sqladmin.googleapis.com \
  artifactregistry.googleapis.com \
  servicenetworking.googleapis.com \
  compute.googleapis.com \
  cloudbuild.googleapis.com
```

---

## Infrastructure Setup (One-time)

### 1. Deploy Infrastructure with Terraform

```bash
cd infra

# Initialize Terraform
terraform init

# Create terraform.tfvars
cat > terraform.tfvars <<EOF
project_id      = "your-project-id"
region          = "us-central1"
db_user         = "appuser"
db_password     = "STRONG_PASSWORD_HERE"  # Use a secret manager in production!
db_name         = "wscli"
domain          = "cliscale.yourdomain.com"
ws_domain       = "ws.yourdomain.com"
controller_image_tag = "latest"
gateway_image_tag    = "latest"
runner_image_tag     = "latest"
EOF

# Review and apply
terraform plan
terraform apply
```

### 2. Initialize Database Schema

```bash
# Get Cloud SQL connection name
export SQL_INSTANCE=$(terraform output -raw instance_connection_name)

# Connect via Cloud SQL Proxy
gcloud sql connect ws-cli-pg --user=appuser

# In psql prompt:
\i ../db/schema.sql
\q
```

### 3. Create Kubernetes Secrets

**Important:** These secrets must be created before deploying the application.

```bash
# Get GKE credentials
gcloud container clusters get-credentials ws-cli-cluster --region us-central1

# Create namespace
kubectl create namespace ws-cli

# 1. Database connection secret
kubectl create secret generic pg -n ws-cli \
  --from-literal=DATABASE_URL="postgresql://appuser:YOUR_PASSWORD@127.0.0.1:5432/wscli"

# 2. JWT signing keys
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
kubectl create secret generic jwt -n ws-cli \
  --from-file=private.pem \
  --from-file=public.pem
rm private.pem public.pem  # Clean up local files

# 3. TLS certificates (Option A: Let's Encrypt with cert-manager - RECOMMENDED)
# Install cert-manager first:
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.3/cert-manager.yaml

# Create ClusterIssuer for Let's Encrypt
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: your-email@example.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: gce
EOF

# Update Helm values to use cert-manager annotations
# Add these to your skaffold.yaml or pass via --set:
# controller.tls.secretName=controller-tls
# gateway.tls.secretName=gateway-tls
# And add cert-manager annotations to Ingress resources

# 3. TLS certificates (Option B: Manual - for testing only)
# Create self-signed certs (NOT for production!)
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout controller.key -out controller.crt \
  -subj "/CN=cliscale.yourdomain.com"
kubectl create secret tls controller-tls -n ws-cli \
  --cert=controller.crt --key=controller.key

openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout gateway.key -out gateway.crt \
  -subj "/CN=ws.yourdomain.com"
kubectl create secret tls gateway-tls -n ws-cli \
  --cert=gateway.crt --key=gateway.key
rm *.key *.crt  # Clean up
```

---

## Deployment Methods

### Method 1: Desktop Deployment with Skaffold (Recommended)

**App Engine-like experience**: Build and deploy from your local machine.

```bash
# 1. Configure your domains in skaffold.yaml or pass via command line
export DOMAIN="cliscale.yourdomain.com"
export WS_DOMAIN="ws.yourdomain.com"

# 2. Build and deploy (one command!)
skaffold run \
  --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps \
  --profile=staging \
  --set-value domain=$DOMAIN \
  --set-value wsDomain=$WS_DOMAIN \
  --set-value controller.tls.secretName=controller-tls \
  --set-value gateway.tls.secretName=gateway-tls

# For development with live reloading:
skaffold dev \
  --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps \
  --profile=dev \
  --set-value domain=$DOMAIN \
  --set-value wsDomain=$WS_DOMAIN \
  --port-forward
```

**What this does:**
1. Builds all 3 Docker images (controller, gateway, runner)
2. Pushes images to Artifact Registry via Cloud Build
3. Deploys via Helm with the built image tags
4. Waits for rollout to complete
5. Shows you the deployment status

### Method 2: Cloud Build (CI/CD Pipeline)

**Trigger from Git or manually**:

```bash
# Submit build manually
gcloud builds submit \
  --config=cloudbuild.yaml \
  --substitutions=_DOMAIN=cliscale.yourdomain.com,_WS_DOMAIN=ws.yourdomain.com,_PROFILE=staging

# Or set up automatic triggers in Cloud Build for Git pushes
gcloud builds triggers create github \
  --repo-name=cliscale \
  --repo-owner=your-github-username \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml \
  --substitutions=_DOMAIN=cliscale.yourdomain.com,_WS_DOMAIN=ws.yourdomain.com,_PROFILE=production
```

### Method 3: Terraform (Infrastructure + Application)

**Already configured!** When you run `terraform apply`, it deploys the Helm chart automatically.

To update the application after changing code:

```bash
cd infra
terraform apply \
  -var="controller_image_tag=v1.2.3" \
  -var="gateway_image_tag=v1.2.3" \
  -var="runner_image_tag=v1.2.3"
```

---

## Environment Profiles

Skaffold supports different profiles for different environments:

### Dev Profile
- Single replica for controller and gateway
- HPA disabled
- ResourceQuota/LimitRange disabled
- Port forwarding enabled

```bash
skaffold run --profile=dev
```

### Staging Profile (Default)
- 2 replicas for controller, 2 for gateway
- HPA enabled with moderate limits
- Good for testing

```bash
skaffold run --profile=staging
```

### Production Profile
- 3+ replicas with HPA
- ResourceQuota and LimitRange enabled
- Full security hardening

```bash
skaffold run --profile=production
```

---

## Verifying Deployment

```bash
# Check pod status
kubectl get pods -n ws-cli

# Check deployments
kubectl get deployments -n ws-cli

# Check ingress (wait for IP to be assigned)
kubectl get ingress -n ws-cli

# View logs
kubectl logs -n ws-cli -l app.kubernetes.io/component=controller --tail=100
kubectl logs -n ws-cli -l app.kubernetes.io/component=gateway --tail=100

# Port forward for local testing
kubectl port-forward -n ws-cli svc/cliscale-controller 8080:80
kubectl port-forward -n ws-cli svc/cliscale-gateway 8081:80
```

---

## Updating the Application

### Quick Update (Skaffold)

```bash
# Just run again - it will rebuild and redeploy
skaffold run --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps --profile=staging
```

### Rolling Back

```bash
# Using Helm
helm rollback cliscale -n ws-cli

# Or via kubectl
kubectl rollout undo deployment/cliscale-controller -n ws-cli
kubectl rollout undo deployment/cliscale-gateway -n ws-cli
```

---

## Configuration Management

### Updating Helm Values

You can override any Helm value via Skaffold:

```bash
skaffold run \
  --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps \
  --set-value controller.replicaCount=5 \
  --set-value gateway.resources.limits.memory=1Gi \
  --set-value db.maxConnections=50
```

### Creating Environment-Specific Values Files

```bash
# Create cliscale-chart/values-prod.yaml
cat > cliscale-chart/values-prod.yaml <<EOF
controller:
  hpa:
    minReplicas: 5
    maxReplicas: 20
gateway:
  hpa:
    minReplicas: 5
    maxReplicas: 30
db:
  maxConnections: 50
  idleTimeoutMillis: 60000
resourceQuota:
  enabled: true
  requestsCpu: "100"
  limitsCpu: "200"
EOF

# Reference in skaffold.yaml or use with helm directly
helm upgrade cliscale ./cliscale-chart \
  -n ws-cli \
  -f cliscale-chart/values-prod.yaml
```

---

## Troubleshooting

### Images not pulling

```bash
# Ensure Artifact Registry is accessible
gcloud artifacts repositories describe apps --location=us-central1

# Configure docker auth
gcloud auth configure-docker us-central1-docker.pkg.dev
```

### Pods failing to start

```bash
# Check events
kubectl describe pod <pod-name> -n ws-cli

# Check logs
kubectl logs <pod-name> -n ws-cli --all-containers

# Common issues:
# - Missing secrets (pg, jwt, TLS)
# - Wrong database connection string
# - Insufficient resources
```

### Workload Identity not working

```bash
# Verify service account binding
gcloud iam service-accounts get-iam-policy ws-cli-controller@$PROJECT_ID.iam.gserviceaccount.com

# Should show binding for:
# serviceAccount:$PROJECT_ID.svc.id.goog[ws-cli/ws-cli-controller]
```

### Ingress not getting IP

```bash
# Check ingress status
kubectl describe ingress -n ws-cli

# May take 5-10 minutes for GCP Load Balancer to provision
# Check Cloud Console -> Network Services -> Load Balancing
```

---

## Clean Up

### Delete Application Only

```bash
# Via Skaffold
skaffold delete -n ws-cli

# Or via Helm
helm uninstall cliscale -n ws-cli
kubectl delete namespace ws-cli
```

### Delete Everything (Infrastructure + Application)

```bash
cd infra
terraform destroy
```

---

## Production Checklist

Before deploying to production, ensure:

- [ ] Secrets created from Google Secret Manager (not kubectl create secret)
- [ ] TLS certificates from Let's Encrypt via cert-manager
- [ ] Database password is strong and stored securely
- [ ] Cloud Armor WAF configured
- [ ] Monitoring and alerting set up
- [ ] Backup and disaster recovery tested
- [ ] Rate limiting configured
- [ ] Resource quotas and limits properly sized
- [ ] HPA properly configured and tested
- [ ] Pod anti-affinity rules added
- [ ] Network policies tested
- [ ] Domains and DNS properly configured
- [ ] Firebase Auth configured
- [ ] Runner pod labels verified in controller code

---

## Useful Commands

```bash
# Quick deploy
skaffold run --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps

# Dev mode with live reload
skaffold dev --port-forward

# Build only (no deploy)
skaffold build --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps

# Render manifests (see what will be deployed)
skaffold render --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps

# Delete deployment
skaffold delete

# View Helm release
helm list -n ws-cli
helm status cliscale -n ws-cli

# Get all resources
kubectl get all -n ws-cli
```

---

## Architecture

```
Desktop/CI → Skaffold → Cloud Build → Artifact Registry
                ↓
            Helm Chart → GKE Cluster
                            ↓
                [Controller] [Gateway] [Runners]
                            ↓
                        Cloud SQL
```

**Deployment flow:**
1. Skaffold reads `skaffold.yaml`
2. Builds 3 Docker images via Cloud Build
3. Pushes to Artifact Registry
4. Runs `helm upgrade --install` with built image tags
5. Helm creates/updates Kubernetes resources
6. GKE pulls images and starts pods
7. Ingress provisions Google Cloud Load Balancer
8. Services are live!

---

## Additional Resources

- [Skaffold Documentation](https://skaffold.dev/docs/)
- [Helm Documentation](https://helm.sh/docs/)
- [GKE Documentation](https://cloud.google.com/kubernetes-engine/docs)
- [Cloud Build Documentation](https://cloud.google.com/build/docs)
