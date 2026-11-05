variable "environment" {
  description = "Deployment environment. Controls the Object Lock mode: COMPLIANCE in prod, GOVERNANCE elsewhere."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "bucket_name" {
  description = "Globally unique S3 bucket name for the daily Merkle-root anchors."
  type        = string
}

variable "retention_years" {
  description = "Default Object Lock retention in years. 7 matches the Consent Manager record-retention floor we adopt for audit anchors."
  type        = number
  default     = 7

  validation {
    condition     = var.retention_years >= 1
    error_message = "retention_years must be at least 1."
  }
}
