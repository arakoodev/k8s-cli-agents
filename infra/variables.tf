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

variable "controller_image_tag" {
  description = "The image tag for the controller service."
  type        = string
  default     = "latest"
}

variable "gateway_image_tag" {
  description = "The image tag for the gateway service."
  type        = string
  default     = "latest"
}

variable "runner_image_tag" {
  description = "The image tag for the runner service."
  type        = string
  default     = "latest"
}

variable "domain" {
  description = "The domain for the controller ingress."
  type        = string
}

variable "ws_domain" {
  description = "The domain for the gateway ingress."
  type        = string
}