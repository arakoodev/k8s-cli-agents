# Deploy to GKE from Your Laptop - App Engine Style

## The Big Picture

**Google Cloud Deploy gives you App Engine-style deployments for GKE.**

Just like `gcloud app deploy`, you can deploy directly from your laptop to GKE with a single command:

```bash
gcloud deploy releases create release-$(date +%Y%m%d-%H%M%S) \
  --delivery-pipeline=my-app \
  --region=us-central1 \
  --source=.
```

**That's it. Your local code → GKE. No Git. No CI/CD complexity. Just deploy.**

## Prerequisites - What You Need Installed

### 1. Google Cloud CLI (gcloud)
**REQUIRED**: This is your main deployment tool.

```bash
# Check if installed
gcloud version

# If not installed, download from:
# https://cloud.google.com/sdk/docs/install
```

**Installation by OS:**

**macOS:**
```bash
# Using Homebrew
brew install google-cloud-sdk

# Or download installer from Google
curl https://sdk.cloud.google.com | bash
exec -l $SHELL
```

**Ubuntu/Debian:**
```bash
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee -a /etc/apt/sources.list.d/google-cloud-sdk.list
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo apt-key --keyring /usr/share/keyrings/cloud.google.gpg add -
sudo apt-get update && sudo apt-get install google-cloud-cli
```

**Windows:**
Download installer from: https://cloud.google.com/sdk/docs/install#windows

**After installation:**
```bash
# Initialize gcloud and login
gcloud init
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

### 2. Skaffold 
**REQUIRED - WILL NOT WORK WITHOUT THIS**: Cloud Deploy uses Skaffold under the hood. This is non-negotiable.

```bash
# Check if installed
skaffold version
```

**Installation by OS:**

**Linux:**
```bash
curl -Lo skaffold https://storage.googleapis.com/skaffold/releases/latest/skaffold-linux-amd64
sudo install skaffold /usr/local/bin/
```

**macOS:**
```bash
# Using Homebrew
brew install skaffold

# Or direct download
curl -Lo skaffold https://storage.googleapis.com/skaffold/releases/latest/skaffold-darwin-amd64
sudo install skaffold /usr/local/bin/
```

**Windows:**
Download latest from: https://github.com/GoogleContainerTools/skaffold/releases

**Verify installation:**
```bash
skaffold version
# Should show: v2.x.x or higher
```

### 3. kubectl (Optional but Recommended)
**RECOMMENDED**: For debugging and verifying deployments.

```bash
# Check if installed
kubectl version --client

# Install via gcloud (easiest)
gcloud components install kubectl
```

### 4. Docker (Only for Local Testing)
**OPTIONAL**: Only if you want to test Docker builds locally. Cloud Build will handle this in the cloud.

```bash
# Check if installed
docker --version

# Not required for deployment - Cloud Build handles container building
```

### 5. A GKE Cluster
**REQUIRED**: You need a running GKE cluster.

```bash
# Option 1: Create a new cluster
gcloud container clusters create my-app-cluster \
  --zone us-central1-a \
  --num-nodes 3 \
  --machine-type e2-medium \
  --enable-autoscaling \
  --min-nodes 1 \
  --max-nodes 5

# Option 2: Use existing cluster
gcloud container clusters get-credentials YOUR_CLUSTER_NAME \
  --zone us-central1-a
```

### 6. Google Cloud APIs
**REQUIRED**: Enable these APIs (one-time per project).

```bash
# Set your project first
gcloud config set project YOUR_PROJECT_ID

# Enable all required APIs
gcloud services enable \
  clouddeploy.googleapis.com \
  cloudbuild.googleapis.com \
  container.googleapis.com \
  artifactregistry.googleapis.com
```

### 7. Artifact Registry Repository
**REQUIRED**: Where your Docker images will be stored.

```bash
# Create the repository
gcloud artifacts repositories create my-app-images \
  --repository-format=docker \
  --location=us-central1 \
  --description="Docker images for my app"
```

## Verification Checklist

Run these commands to ensure everything is ready:

```bash
echo "=== Checking Prerequisites ==="

# 1. gcloud installed and authenticated
echo "1. Checking gcloud..."
gcloud version
gcloud config get-value project

# 2. Skaffold installed (CRITICAL!)
echo "2. Checking skaffold..."
skaffold version || echo "ERROR: Skaffold not installed - THIS IS REQUIRED!"

# 3. kubectl installed
echo "3. Checking kubectl..."
kubectl version --client 2>/dev/null || echo "Warning: kubectl not installed (optional but recommended)"

# 4. APIs enabled
echo "4. Checking APIs..."
gcloud services list --enabled --filter="name:(clouddeploy|cloudbuild|container|artifactregistry)" --format="table(name)"

# 5. GKE cluster exists
echo "5. Checking GKE cluster..."
gcloud container clusters list --format="table(name,location,status)"

# 6. Artifact Registry exists
echo "6. Checking Artifact Registry..."
gcloud artifacts repositories list --location=us-central1 --format="table(name,format)"
```

**✅ All checks passed? You're ready to deploy!**

## Project Setup

### Required Files (Add These to Your Project)

#### 1. `skaffold.yaml`
```yaml
apiVersion: skaffold/v4beta6
kind: Config
build:
  artifacts:
  - image: us-central1-docker.pkg.dev/YOUR_PROJECT_ID/my-app-images/my-app
    docker:
      dockerfile: Dockerfile
  googleCloudBuild:
    projectId: YOUR_PROJECT_ID
deploy:
  kubectl:
    manifests:
    - k8s/deployment.yaml
```

#### 2. `clouddeploy.yaml`
```yaml
apiVersion: deploy.cloud.google.com/v1
kind: DeliveryPipeline
metadata:
  name: my-app
description: Direct laptop to GKE deployment
serialPipeline:
  stages:
  - targetId: gke-prod

---
apiVersion: deploy.cloud.google.com/v1
kind: Target
metadata:
  name: gke-prod
description: Production GKE Cluster
gke:
  cluster: projects/YOUR_PROJECT_ID/locations/us-central1-a/clusters/my-app-cluster
```

#### 3. `Dockerfile`
```dockerfile
FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
```

#### 4. `k8s/deployment.yaml`
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: my-app
        image: us-central1-docker.pkg.dev/YOUR_PROJECT_ID/my-app-images/my-app
        ports:
        - containerPort: 8080
        resources:
          limits:
            memory: "512Mi"
            cpu: "500m"
---
apiVersion: v1
kind: Service
metadata:
  name: my-app-service
spec:
  type: LoadBalancer
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 8080
```

### Initialize Pipeline (One Time Only)

```bash
# Register your pipeline
gcloud deploy apply --file=clouddeploy.yaml --region=us-central1
```

## Deploy From Your Laptop

```bash
# The only command you need to remember:
gcloud deploy releases create release-$(date +%Y%m%d-%H%M%S) \
  --delivery-pipeline=my-app \
  --region=us-central1 \
  --source=.
```

**This command:**
1. Uploads everything in your current directory
2. Builds your Docker container in Cloud Build
3. Deploys to your GKE cluster
4. Done!

## Common Commands

```bash
# Deploy (run from project root)
gcloud deploy releases create release-$(date +%Y%m%d-%H%M%S) \
  --delivery-pipeline=my-app \
  --region=us-central1 \
  --source=.

# Check deployment status
gcloud deploy releases list \
  --delivery-pipeline=my-app \
  --region=us-central1

# Get your app's external IP
kubectl get service my-app-service

# View logs
kubectl logs -l app=my-app

# Rollback to previous release
gcloud deploy targets rollback \
  --delivery-pipeline=my-app \
  --release=release-20240115-143022 \
  --region=us-central1
```

## Troubleshooting

### "Skaffold not found"
```bash
# This is REQUIRED - Cloud Deploy won't work without it
curl -Lo skaffold https://storage.googleapis.com/skaffold/releases/latest/skaffold-linux-amd64
sudo install skaffold /usr/local/bin/
skaffold version
```

### "Permission denied"
```bash
# Grant Cloud Deploy service account permissions
PROJECT_NUMBER=$(gcloud projects describe $(gcloud config get-value project) --format='value(projectNumber)')
gcloud projects add-iam-policy-binding $(gcloud config get-value project) \
  --member=serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com \
  --role=roles/clouddeploy.developer
```

### "Build failed"
```bash
# Check build logs
gcloud builds list --limit=1
gcloud builds log $(gcloud builds list --limit=1 --format="value(id)")

# Common fixes:
# - Ensure Dockerfile exists in project root
# - Check YOUR_PROJECT_ID is correct in skaffold.yaml
# - Verify Artifact Registry repository exists
```

### "Cluster not found"
```bash
# List your clusters
gcloud container clusters list

# Update clouddeploy.yaml with correct cluster path:
# projects/YOUR_PROJECT_ID/locations/ZONE/clusters/CLUSTER_NAME
```

## Using .gcloudignore

Create `.gcloudignore` to exclude files from upload (just like App Engine):

```
.git
node_modules/
*.pyc
.env
.vscode/
*.log
tmp/
test/
README.md
```

## Key Documentation

- **[Deploy from Local Source - Official Docs](https://cloud.google.com/deploy/docs/deploy-app-gke#deploy_from_source_code)**
- [Cloud Deploy Quickstart](https://cloud.google.com/deploy/docs/quickstart-deploy-to-gke)
- [Skaffold Documentation](https://skaffold.dev/docs/)

## The Bottom Line

**This is App Engine-style deployment for Kubernetes:**
- ✅ Deploy from laptop with one command
- ✅ No Git required
- ✅ No CI/CD setup needed
- ✅ Automatic container builds in the cloud
- ✅ Direct source → GKE deployment

---

*This is the official, Google-supported way to deploy to GKE from your laptop.*
