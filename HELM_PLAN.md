# CRITICAL SECURITY REVIEW: Terraform to Helm Migration
## Life-Critical System Assessment

**Review Date:** 2025-10-22
**System:** cliscale WebSocket Gateway & Controller
**Reviewer:** Security Audit
**Risk Level:** 🔴 **CRITICAL - DEPLOYMENT BLOCKED**

---

## Executive Summary

This migration from pure Terraform to Helm-based deployment contains **CRITICAL security vulnerabilities** and **architectural flaws** that make it **UNSAFE for production deployment**, especially for a life-critical system. The untrustworthy developer has introduced multiple dangerous misconfigurations and omitted essential security controls.

**RECOMMENDATION: DO NOT DEPLOY until all CRITICAL and HIGH severity issues are resolved.**

---

## CRITICAL Issues (Deployment Blockers)

### 1. ⛔ MISSING SERVICE ACCOUNT CONFIGURATION IN GATEWAY (CRITICAL)

**Location:** `cliscale-chart/templates/gateway.yaml:20-70`

**Issue:** The gateway deployment has **NO serviceAccount** specified, meaning it runs with the **default service account** which may have excessive permissions.

```yaml
# gateway.yaml - MISSING serviceAccountName field
spec:
  containers:
  - name: gateway
    # NO serviceAccountName specified!
```

**Impact:**
- Gateway inherits default namespace permissions
- Potential privilege escalation if default SA is misconfigured
- Violates principle of least privilege
- Breaks workload identity binding assumptions

**Required Fix:**
- Add dedicated service account for gateway
- Configure workload identity if needed for database access
- Explicitly define RBAC permissions

---

### 2. ⛔ MISSING SECURITY CONTEXT ON GATEWAY PODS (CRITICAL)

**Location:** `cliscale-chart/templates/gateway.yaml:20-70`

**Issue:** Gateway pods have **NO pod-level or container-level security context** defined.

**Comparison:**
- **Controller** (gateway.yaml:24-42): Has comprehensive security context with `runAsNonRoot`, `runAsUser: 1001`, `fsGroup`, seccomp profile, capabilities drop
- **Gateway** (gateway.yaml): **COMPLETELY MISSING** all security contexts

**Impact:**
- Gateway can run as root (UID 0)
- No seccomp profile protection
- Can escalate privileges
- Can write to root filesystem
- Full capability set available
- Violates Pod Security Standard "restricted" policy defined in namespace

**This creates a MASSIVE security hole in a life-critical system.**

---

### 3. ⛔ INCOMPLETE WORKLOAD IDENTITY BINDING (CRITICAL)

**Location:** `infra/main.tf:140-146`

**Issue:** The Terraform IAM policy binding for workload identity is **INCOMPLETE and INCORRECT**.

```terraform
resource "google_iam_policy_binding" "controller_workload_identity" {
  project = var.project_id
  role    = "roles/iam.workloadIdentityUser"
  members = [
    "serviceAccount:${var.project_id}.svc.id.goog[ws-cli/ws-cli-controller]",
  ]
}
```

**Problems:**
1. Uses `google_iam_policy_binding` which is **DANGEROUS** - it replaces ALL existing bindings for that role
2. Should use `google_service_account_iam_binding` instead to bind to the specific SA
3. Missing binding for gateway service account (doesn't exist!)
4. The binding target is the GCP SA, not a project-level role

**Impact:**
- May wipe out other workload identity bindings in the project
- Controller workload identity may not work correctly
- Gateway has no workload identity configured at all

**Correct Pattern:**
```terraform
resource "google_service_account_iam_binding" "controller_workload_identity" {
  service_account_id = google_service_account.controller.name
  role               = "roles/iam.workloadIdentityUser"
  members = [
    "serviceAccount:${var.project_id}.svc.id.goog[${var.namespace}/ws-cli-controller]"
  ]
}
```

---

### 4. ⛔ HARDCODED PLACEHOLDER VALUES (CRITICAL)

**Location:** `cliscale-chart/values.yaml:14, 18, 27, 57, 90`

**Issue:** Production configuration contains **hardcoded placeholder values** that will cause runtime failures:

```yaml
repository: "us-central1-docker.pkg.dev/your-project-id/apps/controller"
runnerImage: "us-central1-docker.pkg.dev/your-project-id/apps/runner:latest"
gcpServiceAccount: "ws-cli-controller@your-project-id.iam.gserviceaccount.com"
instanceConnectionName: "your-project-id:your-region:your-instance-name"
```

**Impact:**
- Pods will fail to pull images (ImagePullBackOff)
- Workload identity will fail (invalid SA email)
- Cloud SQL proxy will fail to connect
- Complete system failure on deployment

**Required Fix:**
- Terraform should override ALL these values dynamically
- Add validation to ensure no "your-project-id" strings exist at deploy time

---

### 5. ⛔ MISSING TLS/SSL CONFIGURATION FOR INGRESS (CRITICAL)

**Location:**
- `cliscale-chart/templates/controller.yaml:120-139`
- `cliscale-chart/templates/gateway.yaml:87-108`

**Issue:** Both Ingress resources have **NO TLS configuration**.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    kubernetes.io/ingress.class: "gce"
spec:
  rules:
  - host: {{ .Values.domain }}
    # NO tls: section!
```

**Impact:**
- Controller API exposed over **unencrypted HTTP**
- Gateway WebSocket exposed over **unencrypted WS** (not WSS)
- **Firebase ID tokens transmitted in plaintext**
- **Session JWTs transmitted in plaintext**
- **Database credentials could leak in error messages**
- Complete compromise of authentication system
- MITM attacks trivial
- **UNACCEPTABLE for any production system, let alone life-critical**

**Required Fix:**
```yaml
spec:
  tls:
  - hosts:
    - {{ .Values.domain }}
    secretName: controller-tls-cert
```

---

### 6. ⛔ DANGEROUS READONLYROOTFILESYSTEM: FALSE (HIGH)

**Location:** `cliscale-chart/templates/controller.yaml:36`

```yaml
securityContext:
  readOnlyRootFilesystem: false  # ⚠️ DANGEROUS
```

**Issue:** Controller explicitly allows writes to root filesystem.

**Impact:**
- Malicious code can modify system binaries
- Container escape vulnerabilities easier to exploit
- Persistence mechanisms available for attackers
- Runtime tampering possible

**Required Fix:**
- Set to `true`
- Mount `/tmp` and `/var/tmp` as emptyDir volumes if writes needed

---

### 7. ⛔ MISSING DATABASE CONNECTION POOL LIMITS (HIGH)

**Location:** `cliscale-chart/values.yaml` - No database configuration section

**Issue:** No configuration for database connection pooling limits.

**Impact:**
- Each pod can exhaust Cloud SQL connections
- With HPA scaling to 10 controller + 20 gateway pods = 30 pods
- Default connection pools could reach 300-1500 connections
- Cloud SQL instance will be overwhelmed
- **System-wide outage likely under load**

---

### 8. ⛔ OVERLY PERMISSIVE RBAC FOR CONTROLLER (HIGH)

**Location:** `cliscale-chart/templates/rbac.yaml:19-24`

```yaml
rules:
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["create","get","list","watch","delete"]
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get","list","watch"]
```

**Issues:**
1. **"delete" permission on jobs** - Controller should not need to delete jobs (TTL handles this)
2. **"list" and "watch" on pods** - Allows viewing ALL pods in namespace, not just owned jobs
3. Missing resource name restrictions - can manipulate any job

**Impact:**
- Controller can delete other users' jobs
- Can spy on other users' pods
- Potential DoS by deleting critical jobs

**Required Fix:**
```yaml
rules:
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["create","get","list","watch"]  # Remove delete
  # Add resource name validation in application code
```

---

## HIGH Severity Issues

### 9. ⚠️ NETWORK POLICIES WILL NOT WORK AS WRITTEN (HIGH)

**Location:** `cliscale-chart/templates/networkpolicy.yaml`

**Issues:**

#### 9a. Runner pods not created by Helm
The network policies reference runner pods with labels:
```yaml
podSelector:
  matchLabels:
    app: {{ include "cliscale.fullname" . }}-runner
```

But **runners are created as Kubernetes Jobs by the controller at runtime**, not by Helm. These jobs won't have the correct labels unless the controller explicitly sets them.

#### 9b. Egress restrictions too broad
```yaml
- to:
    - namespaceSelector: {}  # Allows ALL namespaces!
  ports:
    - protocol: TCP
      port: 443
```

This allows runner pods to connect to **ANY** pod in **ANY** namespace on port 443, defeating the security purpose.

#### 9c. Missing critical restrictions
- No restrictions on controller/gateway egress to Cloud SQL
- Gateway allowed to reach "all pods" for runner connections is overly broad
- No pod-level restrictions on metadata API access (169.254.169.254)

**Impact:**
- Runner pods can escape sandbox
- Can reach internal cluster services
- Network isolation is largely ineffective

---

### 10. ⚠️ MISSING POD SECURITY POLICIES/STANDARDS ENFORCEMENT (HIGH)

**Location:** `cliscale-chart/templates/namespace.yaml:1-9`

**Issue:** Namespace has Pod Security Standards labels, but no enforcement mechanism:

```yaml
labels:
  pod-security.kubernetes.io/enforce: restricted
  pod-security.kubernetes.io/audit: restricted
  pod-security.kubernetes.io/warn: restricted
```

**Problems:**
1. Gateway deployment **violates** "restricted" policy (no security context)
2. No admission controller verification shown
3. Unclear if GKE has PSS admission enabled
4. Should use PodSecurityPolicy or OPA Gatekeeper for enforcement

---

### 11. ⚠️ MISSING SECRETS MANAGEMENT (HIGH)

**Location:** `cliscale-chart/values.yaml:49-52, 82-84`

**Issue:** Chart references secrets that don't exist:

```yaml
secrets:
  databaseUrl: "pg"
  jwt: "jwt"
```

**Problems:**
1. No Kubernetes Secret manifests in chart
2. No documentation on how to create these secrets
3. No integration with Google Secret Manager
4. Secrets must contain JWT private keys - very sensitive
5. Database URL contains credentials in plaintext

**Impact:**
- Deployment will fail (missing secrets)
- Manual secret creation required (error-prone)
- No secret rotation mechanism
- No audit trail for secret access

**Required Fix:**
- Use External Secrets Operator with Google Secret Manager
- Or generate secrets via Terraform and inject
- Document secret creation process
- Implement secret rotation

---

### 12. ⚠️ CLOUD SQL PROXY MISSING RESOURCE GUARANTEES (MEDIUM)

**Location:** `cliscale-chart/values.yaml:91-97`

**Issue:** Cloud SQL Proxy has requests but very low limits:

```yaml
resources:
  requests:
    cpu: "50m"
    memory: "64Mi"
  limits:
    cpu: "200m"
    memory: "128Mi"
```

**Impact:**
- Under heavy database load, proxy can be OOMKilled
- Only 128Mi limit for proxy that may handle hundreds of connections
- Will cause cascading failures
- Database connection drops for all pods

**Required Fix:**
- Increase limits to at least 500m CPU / 512Mi memory
- Monitor actual usage and adjust

---

### 13. ⚠️ MISSING HEALTH CHECK ENDPOINTS VALIDATION (MEDIUM)

**Location:**
- `cliscale-chart/templates/controller.yaml:73-86`
- `cliscale-chart/templates/gateway.yaml:43-56`

**Issue:** Health checks reference `/healthz` and `/readyz` endpoints with no validation that these exist.

**Problems:**
1. No documentation of what these endpoints check
2. Gateway uses same endpoint for both liveness and readiness
3. No validation of database connectivity in health checks (likely)
4. No validation of Cloud SQL proxy health

**Impact:**
- Pods marked healthy when database is down
- Traffic routed to non-functional pods
- Cascading failures not detected early

---

### 14. ⚠️ HPA CONFLICTS WITH FIXED REPLICA COUNTS (MEDIUM)

**Location:**
- `cliscale-chart/values.yaml:12, 32, 55, 64`
- `cliscale-chart/templates/hpa.yaml`

**Issue:** Deployments have fixed `replicaCount` values that conflict with HPA:

```yaml
controller:
  replicaCount: 2  # This will be overridden by HPA
  hpa:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
```

**Impact:**
- Confusing behavior - replicaCount is ignored when HPA enabled
- If HPA is disabled, falls back to potentially wrong value
- No validation that replicaCount matches minReplicas

---

### 15. ⚠️ MISSING COST CONTROLS (MEDIUM)

**Location:** `cliscale-chart/values.yaml:105-142`

**Issue:** ResourceQuota and LimitRange are **disabled by default**:

```yaml
resourceQuota:
  enabled: false  # Should be TRUE for production!

limitRange:
  enabled: false  # Should be TRUE for production!
```

**Impact:**
- Runaway jobs can consume unlimited resources
- No protection against resource exhaustion attacks
- Cloud costs can spiral out of control
- A single malicious/buggy job can take down the cluster

---

## MEDIUM Severity Issues

### 16. ⚙️ MISSING MONITORING AND OBSERVABILITY

**Issues:**
- No Prometheus ServiceMonitor definitions
- No metrics endpoints exposed
- No PodMonitor for scraping metrics
- No alerting rules defined
- No SLO/SLI definitions

**Impact:**
- Blind to system health
- Cannot detect issues before users affected
- No capacity planning data

---

### 17. ⚙️ MISSING BACKUP AND DISASTER RECOVERY

**Issues:**
- Cloud SQL backups enabled in Terraform (good)
- But no documented restore procedure
- No testing of backup restoration
- No RTO/RPO defined
- No backup verification

**Impact:**
- May discover backups don't work during actual disaster
- Extended downtime during incidents

---

### 18. ⚙️ MISSING RATE LIMITING

**Issues:**
- No rate limiting on controller `/api/sessions` endpoint
- No Cloud Armor WAF configured
- No per-user rate limits

**Impact:**
- DDoS attack trivial
- Resource exhaustion attacks
- Cost-based attacks (spawn unlimited jobs)

---

### 19. ⚙️ INCORRECT INGRESS CONTROLLER ANNOTATION

**Location:**
- `cliscale-chart/templates/controller.yaml:126`
- `cliscale-chart/templates/gateway.yaml:93`

**Issue:**
```yaml
annotations:
  kubernetes.io/ingress.class: "gce"
```

**Problem:** The `kubernetes.io/ingress.class` annotation is **deprecated** in Kubernetes 1.18+. Should use `spec.ingressClassName` instead.

**Impact:**
- May not work on newer GKE versions
- Unclear which ingress controller handles requests

**Fix:**
```yaml
spec:
  ingressClassName: gce
```

---

### 20. ⚙️ MISSING POD ANTI-AFFINITY

**Issue:** No pod anti-affinity rules to spread replicas across nodes/zones.

**Impact:**
- All controller pods could be on same node
- Single node failure takes down service
- Poor availability for life-critical system

**Required Fix:**
```yaml
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        labelSelector:
          matchLabels:
            app.kubernetes.io/component: controller
        topologyKey: kubernetes.io/hostname
```

---

### 21. ⚙️ ALLOWED_CODE_DOMAINS TOO PERMISSIVE

**Location:** `cliscale-chart/values.yaml:46`

```yaml
allowedCodeDomains: "github.com,gitlab.com,*.github.com"
```

**Issue:** Wildcard `*.github.com` allows any subdomain including user-controlled ones.

**Impact:**
- Can load code from malicious GitHub Pages sites
- Can load from compromised GitHub Enterprise instances
- Supply chain attack vector

---

## Configuration Completeness Issues

### 22. ❓ MISSING TERRAFORM OUTPUT INTEGRATION

**Issue:** Terraform outputs exist but aren't properly wired to Helm values:

```terraform
# main.tf:166-170 passes these values:
cloudsql = {
  instanceConnectionName = google_sql_database_instance.main.connection_name
}
```

**But missing:**
- Service account emails not passed
- Artifact registry URLs not passed
- Network configuration not passed
- Cluster name/endpoint not exposed

---

### 23. ❓ INCOMPLETE HELM HELPERS

**Location:** `cliscale-chart/templates/_helpers.tpl`

**Issue:** Helper template has unused `serviceAccountName` helper that references `.Values.serviceAccount` but gateway has `.Values.gateway.serviceAccount` structure.

**Impact:**
- Copy-paste error from template
- Shows lack of testing

---

### 24. ❓ MISSING DOCUMENTATION

**Issues:**
- No NOTES.txt in Helm chart to guide users post-install
- No values.schema.json for validation
- No examples/ directory with sample configurations
- README.md not updated to reflect Helm migration details

---

### 25. ❓ MISSING TESTS

**Issues:**
- No Helm chart tests (templates/tests/)
- No CI/CD pipeline definitions
- No terraform validate in CI
- No helm lint in CI
- No kube-score or similar security scanning

---

## Architecture & Design Issues

### 26. 🏗️ HELM CHART MANAGES NAMESPACE (ANTI-PATTERN)

**Location:** `cliscale-chart/templates/namespace.yaml`

**Issue:** Helm chart creates the namespace it deploys into.

**Problems:**
1. Namespace should exist before Helm install
2. Cannot manage namespace separately from application
3. Uninstalling chart deletes namespace (data loss!)
4. Cannot set custom namespace via `helm install --namespace`

**Best Practice:** Remove namespace from chart, document that namespace must be pre-created.

---

### 27. 🏗️ MIXING INFRASTRUCTURE AND APPLICATION CONCERNS

**Issue:** Terraform manages both infrastructure (VPC, GKE, Cloud SQL) AND application deployment (Helm release).

**Problems:**
1. Changes to Helm chart require Terraform apply
2. Application updates trigger infrastructure plan
3. Blast radius unnecessarily large
4. Slower deployment cycles

**Better Architecture:**
- Terraform for infrastructure only
- Separate deployment pipeline (Cloud Build, ArgoCD, FluxCD) for application
- Terraform outputs consumed by deployment system

---

### 28. 🏗️ NO SUPPORT FOR MULTIPLE ENVIRONMENTS

**Issue:** No structure for dev/staging/prod environments.

**Problems:**
1. Single values.yaml
2. No environment-specific overrides
3. No namespace separation strategy
4. No mention of how to run multiple environments

---

## Comparison: What Was LOST in Migration

### 29. ❌ NO MIGRATION FROM TERRAFORM K8S RESOURCES SHOWN

**Problem:** The original Terraform likely had Kubernetes resources defined directly. The migration doesn't show:

1. What was the original Kubernetes configuration?
2. What changed during migration?
3. Was anything lost?
4. Were there additional resources that weren't migrated?

**This makes it impossible to verify migration completeness.**

---

## Positive Aspects (For Completeness)

Despite the numerous critical issues, some things were done correctly:

1. ✅ Pod Security Context on Controller is well-configured
2. ✅ Network Policies exist (though flawed)
3. ✅ PodDisruptionBudgets configured
4. ✅ HPA configured for both services
5. ✅ Health checks defined
6. ✅ Private GKE cluster with proper VPC setup
7. ✅ Cloud SQL private IP configuration
8. ✅ Backup configuration for Cloud SQL
9. ✅ BackendConfig for gateway timeout handling
10. ✅ Structured Helm chart layout

---

## Summary of Issues by Severity

| Severity | Count | Deployment Blocking? |
|----------|-------|---------------------|
| CRITICAL | 8 | YES |
| HIGH | 7 | YES |
| MEDIUM | 13 | Recommended |
| Total | 28 | - |

---

## Remediation Priority

### Phase 1: CRITICAL - Must Fix Before Any Deployment
1. Add TLS/SSL to both Ingress resources (#5)
2. Add security context to gateway pods (#2)
3. Add service account to gateway (#1)
4. Fix workload identity binding (#3)
5. Remove all hardcoded placeholders (#4)
6. Set readOnlyRootFilesystem: true on controller (#6)
7. Add database connection pool configuration (#7)
8. Fix RBAC permissions (#8)

**Estimated Effort:** 2-3 days

### Phase 2: HIGH - Required for Production Readiness
9. Fix network policies (#9)
10. Add secret management solution (#11)
11. Increase Cloud SQL proxy resources (#12)
12. Enable and configure ResourceQuota (#15)
13. Enable and configure LimitRange (#15)
14. Add pod anti-affinity rules (#20)
15. Implement rate limiting (#18)

**Estimated Effort:** 3-5 days

### Phase 3: MEDIUM - Operational Excellence
16. Add monitoring/alerting (#16)
17. Document backup/recovery procedures (#17)
18. Fix ingress annotations (#19)
19. Validate health check implementations (#13)
20. Add Helm chart tests (#25)
21. Separate infrastructure from application deployment (#27)

**Estimated Effort:** 5-7 days

---

## Recommended Actions

### Immediate Actions (Before Next Deploy):
1. **HALT all deployments** until CRITICAL issues resolved
2. Conduct security review with GCP security team
3. Engage with trusted Kubernetes/GCP experts
4. Create test environment to validate fixes
5. Implement automated security scanning (kube-score, checkov, tfsec)

### Architectural Recommendations:
1. Separate Terraform (infrastructure) from application deployment
2. Use GitOps (ArgoCD/FluxCD) for application deployment
3. Implement External Secrets Operator with Google Secret Manager
4. Add Cloud Armor WAF in front of ingresses
5. Implement comprehensive monitoring with Prometheus/Grafana
6. Set up automated backup testing
7. Implement proper CI/CD with security gates

### Process Recommendations:
1. **Never accept code from untrustworthy developers for life-critical systems**
2. Require security review for all infrastructure changes
3. Implement four-eyes principle for production changes
4. Automated security scanning in CI/CD
5. Regular penetration testing
6. Incident response plan and runbooks

---

## Conclusion

This migration contains **fundamental security flaws** that make it **unsuitable for production deployment**. The untrustworthy developer either:

1. Lacks basic Kubernetes security knowledge
2. Intentionally introduced vulnerabilities
3. Copied configuration without understanding it
4. Did not test the configuration

For a **life-critical system**, this level of quality is **unacceptable and dangerous**.

**RECOMMENDATION: Engage experienced Kubernetes security engineers to remediate before any production use.**

---

## Sign-off

**Status:** 🔴 **REJECTED - DO NOT DEPLOY**

**Next Review:** After CRITICAL issues remediated

**Reviewed By:** Security Audit
**Date:** 2025-10-22
