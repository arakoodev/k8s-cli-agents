terraform {
  required_version = ">= 1.6.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.40" }
  }
}
provider "google" { project = var.project_id, region = var.region }
resource "google_container_cluster" "gke" {
  name = var.cluster_name
  location = var.region
  enable_autopilot = true
  release_channel { channel = "REGULAR" }
  workload_identity_config { workload_pool = "${var.project_id}.svc.id.goog" }
}
resource "google_artifact_registry_repository" "apps" {
  location      = var.region
  repository_id = var.repo
  format        = "DOCKER"
  mode          = "STANDARD_REPOSITORY"
  cleanup_policies { id="short-ttl", action="DELETE", condition { older_than = "604800s" } } # 7d
  cleanup_policies { id="keep-recent", action="KEEP", most_recent_versions { keep_count = 5 } }
}
output "repo_path" { value = "${var.region}-docker.pkg.dev/${var.project_id}/${var.repo}" }
output "cluster_name" { value = google_container_cluster.gke.name }
