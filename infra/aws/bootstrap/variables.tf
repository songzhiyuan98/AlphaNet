variable "aws_region" {
  type    = string
  default = "us-west-2"

  validation {
    condition     = var.aws_region == "us-west-2"
    error_message = "The initial AlphaNet platform is pinned to us-west-2."
  }
}

variable "state_bucket_name" {
  description = "Globally unique S3 bucket name for AlphaNet Terraform state."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name must be a valid 3-63 character S3 bucket name."
  }
}

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

variable "tags" {
  type    = map(string)
  default = {}
}
