variable "project_id" {
  description = "The GCP project ID to deploy resources into."
  type        = string
}

variable "region" {
  description = "The GCP region to deploy resources into."
  type        = string
  default     = "us-central1"
}

variable "db_user" {
  description = "The username for the Cloud SQL database."
  type        = string
  sensitive   = true
}

variable "db_password" {
  description = "The password for the Cloud SQL database."
  type        = string
  sensitive   = true
}

variable "db_name" {
  description = "The name of the Cloud SQL database."
  type        = string
  default     = "wscli"
}
