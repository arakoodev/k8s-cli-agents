# Migration Summary: Skaffold + Helm Deployment

**Date:** 2025-10-22
**Status:** ✅ Complete

---

## What Changed

### ✅ Added
- **`skaffold.yaml`** - Skaffold configuration for App Engine-like deployment
- **`DEPLOYMENT.md`** - Comprehensive deployment guide
- **`.skaffoldignore`** - Ignore patterns for Skaffold

### ♻️ Updated
- **`cloudbuild.yaml`** - Now uses Skaffold instead of raw kubectl
- **`README.md`** - Updated with Skaffold deployment instructions

### 🗑️ Removed
- **`k8s/`** directory - Old raw Kubernetes manifests (deprecated, insecure)

---

## New Deployment Workflow

### Before (BROKEN)
```
Code → Cloud Build → kubectl apply k8s/*.yaml → ❌ (insecure configs)
```

### After (FIXED)
```
Code → Skaffold → Cloud Build → Helm → ✅ (secure configs)
```

---

## How to Deploy Now

### From Desktop (App Engine Experience)
```bash
skaffold run --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps
```

### From CI/CD
```bash
gcloud builds submit --config=cloudbuild.yaml
```

### Dev Mode with Live Reload
```bash
skaffold dev --port-forward
```

---

## Benefits

1. **Single Source of Truth**: Helm charts only (no k8s/ vs cliscale-chart/ conflict)
2. **App Engine-like UX**: One command deploys everything
3. **Automatic Image Tags**: No manual envsubst needed
4. **Environment Profiles**: Easy dev/staging/prod configs
5. **Live Reload**: `skaffold dev` watches code changes
6. **Secure by Default**: Deploys from secure Helm templates

---

## Key Files

| File | Purpose |
|------|---------|
| `skaffold.yaml` | Main Skaffold config - defines build & deploy |
| `cloudbuild.yaml` | Cloud Build CI/CD pipeline using Skaffold |
| `cliscale-chart/` | Helm chart with all K8s resources |
| `DEPLOYMENT.md` | Step-by-step deployment guide |

---

## Environment Profiles

### Dev
```bash
skaffold run --profile=dev
```
- 1 replica each
- HPA disabled
- Port forwarding enabled

### Staging (Default)
```bash
skaffold run --profile=staging
```
- 2 replicas controller, 2 gateway
- Moderate resource limits

### Production
```bash
skaffold run --profile=production
```
- 3+ replicas with HPA
- Full resource quotas
- Security hardening enabled

---

## What Got Fixed

### Security Issues Resolved
✅ No more insecure k8s/ manifests
✅ Deployment uses secure Helm charts
✅ Single deployment path (no conflicts)
✅ Proper security contexts enforced
✅ TLS configuration included
✅ Resource limits enforced

### Workflow Issues Resolved
✅ No more manual envsubst
✅ Automatic image tag injection
✅ Simple one-command deploy
✅ Dev mode with live reload
✅ Clear documentation

---

## Migration Verification

### ✅ Verify Files
```bash
# Should exist
ls skaffold.yaml cloudbuild.yaml DEPLOYMENT.md

# Should NOT exist
ls k8s/ 2>&1 | grep "No such file or directory"
```

### ✅ Test Deployment
```bash
# Dry run to see what will be deployed
skaffold render --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps

# Actual deployment
skaffold run --default-repo=us-central1-docker.pkg.dev/$PROJECT_ID/apps --profile=dev
```

---

## Troubleshooting

### "Error: chart not found"
Make sure you're running Skaffold from the repository root where `skaffold.yaml` exists.

### "Error: unauthorized"
```bash
gcloud auth configure-docker us-central1-docker.pkg.dev
```

### "Error: missing secrets"
See DEPLOYMENT.md section "Create Kubernetes Secrets"

### "Deployment takes too long"
First deploy can take 10-15 minutes:
- Building 3 Docker images
- Pushing to Artifact Registry
- Provisioning GCP Load Balancer

---

## Next Steps

1. **Read DEPLOYMENT.md** for complete setup instructions
2. **Create Kubernetes secrets** (required before deployment)
3. **Test with dev profile** first: `skaffold run --profile=dev`
4. **Set up Cloud Build trigger** for automatic deployments
5. **Configure monitoring** (see HELM_PLAN.md Issue #16)

---

## Important Notes

⚠️ **Old k8s/ directory has been deleted**
- It contained insecure configurations
- All configs now in `cliscale-chart/`

⚠️ **Secrets must be created manually**
- See DEPLOYMENT.md for instructions
- Required: `pg`, `jwt`, TLS certificates

⚠️ **Terraform still works**
- `terraform apply` deploys via Helm
- Skaffold is for app updates only
- Use Terraform for infrastructure changes

---

## Support

- **Full Guide**: See [DEPLOYMENT.md](./DEPLOYMENT.md)
- **Security Review**: See [HELM_PLAN.md](./HELM_PLAN.md)
- **Skaffold Docs**: https://skaffold.dev/docs/
- **Helm Docs**: https://helm.sh/docs/

---

**Migration Status: ✅ COMPLETE**

You can now deploy with confidence using Skaffold!
