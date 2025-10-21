output "gke_cluster_name" {
  description = "The name of the GKE cluster."
  value       = google_container_cluster.primary.name
}

output "gke_cluster_location" {
  description = "The location (region) of the GKE cluster."
  value       = google_container_cluster.primary.location
}

output "instance_connection_name" {
  description = "The connection name of the Cloud SQL instance."
  value       = google_sql_database_instance.main.connection_name
  sensitive   = true
}

output "db_name" {
  description = "The name of the Cloud SQL database."
  value       = google_sql_database.main.name
}

output "db_user" {
  description = "The user for the Cloud SQL database."
  value       = google_sql_user.main.name
}

output "artifact_registry_repository" {
  description = "The URI of the Artifact Registry repository."
  value       = "https://us-central1-docker.pkg.dev/${var.project_id}/apps"
}
