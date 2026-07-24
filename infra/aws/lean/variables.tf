variable "aws_region" {
  description = "AWS region for the lean AlphaNet runtime."
  type        = string
  default     = "us-west-2"

  validation {
    condition     = var.aws_region == "us-west-2"
    error_message = "The reviewed lean baseline currently supports only us-west-2."
  }
}
variable "project_name" {
  description = "Stable project prefix."
  type        = string
  default     = "alphanet"
}

variable "environment" {
  description = "Environment name."
  type        = string
  default     = "early-access"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.environment))
    error_message = "environment must be a short lowercase slug."
  }
}

variable "vpc_cidr" {
  description = "Dedicated lean-runtime VPC CIDR."
  type        = string
  default     = "10.50.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be valid IPv4 CIDR."
  }
}

variable "instance_type" {
  description = "Single replaceable application-node size."
  type        = string
  default     = "t3a.medium"
}

variable "root_volume_gib" {
  description = "Encrypted EC2 root volume size."
  type        = number
  default     = 40

  validation {
    condition     = var.root_volume_gib >= 30 && var.root_volume_gib <= 200
    error_message = "root_volume_gib must be between 30 and 200."
  }
}

variable "database_instance_class" {
  description = "Single-AZ PostgreSQL instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "database_allocated_storage_gib" {
  description = "Initial encrypted gp3 PostgreSQL storage."
  type        = number
  default     = 20

  validation {
    condition     = var.database_allocated_storage_gib >= 20
    error_message = "RDS PostgreSQL requires at least 20 GiB for this baseline."
  }
}

variable "database_backup_retention_days" {
  description = "Automated RDS backup retention."
  type        = number
  default     = 7

  validation {
    condition     = var.database_backup_retention_days >= 7
    error_message = "The public lean environment keeps at least seven days of backups."
  }
}

variable "database_deletion_protection" {
  description = "Protect durable community memory from an ordinary destroy."
  type        = bool
  default     = true
}

variable "github_oidc_provider_arn" {
  description = "Account GitHub Actions OIDC provider ARN from the shared root."
  type        = string
}

variable "github_oidc_subjects" {
  description = "Exact immutable GitHub OIDC subjects allowed to deploy main."
  type        = set(string)

  validation {
    condition = length(var.github_oidc_subjects) > 0 && alltrue([
      for subject in var.github_oidc_subjects :
      can(regex("^repo:[^:]+:ref:refs/heads/main$", subject))
    ])
    error_message = "github_oidc_subjects must contain exact immutable main-branch subjects."
  }
}

variable "ecr_repository_prefix" {
  description = "Shared ECR repository prefix without the per-image suffix."
  type        = string
  default     = "alphanet"
}

variable "source_repository" {
  description = "GitHub owner/repository embedded in release manifests."
  type        = string
  default     = "songzhiyuan98/AlphaNet"
}

variable "auth_email_from" {
  description = "Verified production sender passed to the API."
  type        = string

  validation {
    condition = (
      length(var.auth_email_from) >= 6 &&
      length(var.auth_email_from) <= 254 &&
      can(regex("^[^'\\r\\n]+$", var.auth_email_from))
    )
    error_message = "auth_email_from must be a single-line sender without a single quote."
  }
}

variable "operations_alert_emails" {
  description = "Optional email recipients for high-severity runtime alarms."
  type        = set(string)
  default     = []
}

variable "log_retention_days" {
  description = "CloudWatch retention for bootstrap and operational logs."
  type        = number
  default     = 14
}

variable "tags" {
  description = "Additional common tags."
  type        = map(string)
  default = {
    Owner = "AlphaNet"
  }
}
