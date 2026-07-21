variable "project_name" {
  type    = string
  default = "alphanet"

  validation {
    condition = (
      can(regex("^[a-z][a-z0-9-]{0,19}[a-z0-9]$", var.project_name)) &&
      !strcontains(var.project_name, "--")
    )
    error_message = "project_name must be 2-21 lowercase alphanumeric or hyphen characters, end alphanumeric, and contain no consecutive hyphens."
  }
}

variable "aws_region" {
  type    = string
  default = "us-west-2"

  validation {
    condition     = var.aws_region == "us-west-2"
    error_message = "The initial AlphaNet platform is pinned to us-west-2."
  }
}

variable "ecr_repository_prefix" {
  type    = string
  default = "alphanet"
}

variable "github_oidc_subjects" {
  description = "Exact full GitHub OIDC sub claims allowed to publish. Read the repository's authoritative sub_claim_prefix from GitHub; wildcards and inferred name-only subjects are forbidden."
  type        = list(string)

  validation {
    condition = length(var.github_oidc_subjects) > 0 && alltrue([
      for subject in var.github_oidc_subjects :
      can(regex("^repo:[A-Za-z0-9_.-]+@[0-9]+/[A-Za-z0-9_.-]+@[0-9]+:ref:refs/heads/main$", subject))
    ])
    error_message = "github_oidc_subjects must contain exact immutable GitHub owner-ID/repository-ID main-branch sub claims and no wildcards."
  }
}

variable "create_github_oidc_provider" {
  description = "Set false only if the account already has GitHub's OIDC provider."
  type        = bool
  default     = true
}

variable "existing_github_oidc_provider_arn" {
  type    = string
  default = ""
}

variable "github_oidc_thumbprints" {
  type    = list(string)
  default = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

variable "account_monthly_budget_usd" {
  description = "Single all-account monthly cost budget. Notifications fire at 50, 80, and 100 percent."
  type        = number
  default     = 650

  validation {
    condition     = var.account_monthly_budget_usd >= 10
    error_message = "account_monthly_budget_usd must be at least 10."
  }
}

variable "cost_alert_emails" {
  description = "Email endpoints for the account-wide budget SNS topic; every address must confirm the subscription."
  type        = set(string)

  validation {
    condition     = length(var.cost_alert_emails) > 0
    error_message = "At least one cost_alert_emails endpoint is required for the account-wide budget."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
