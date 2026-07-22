variable "project_name" {
  description = "Short lowercase project identifier used in resource names."
  type        = string
  default     = "alphanet"

  validation {
    condition = (
      can(regex("^[a-z][a-z0-9-]{0,19}[a-z0-9]$", var.project_name)) &&
      !strcontains(var.project_name, "--")
    )
    error_message = "project_name must be 2-21 lowercase alphanumeric or hyphen characters, end alphanumeric, and contain no consecutive hyphens."
  }
}

variable "environment" {
  description = "Isolated deployment environment. Use a separate backend key per value."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "aws_region" {
  description = "Primary regional workload location. AlphaNet is initially standardized on us-west-2."
  type        = string
  default     = "us-west-2"

  validation {
    condition     = var.aws_region == "us-west-2"
    error_message = "The initial AlphaNet platform is intentionally pinned to us-west-2."
  }
}

variable "search_embedding_model_id" {
  description = "Pinned Amazon Bedrock embedding model used for semantic Content Search."
  type        = string
  default     = "amazon.titan-embed-text-v2:0"

  validation {
    condition     = var.search_embedding_model_id == "amazon.titan-embed-text-v2:0"
    error_message = "The MVP Search index is dimensioned for amazon.titan-embed-text-v2:0."
  }
}

variable "vpc_cidr" {
  description = "Private address space. A /16 leaves room for in-place service growth."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrsubnet(var.vpc_cidr, 4, 15))
    error_message = "vpc_cidr must be a valid CIDR with at least four additional subnet bits."
  }
}

variable "nat_gateway_mode" {
  description = "single reduces staging cost; one_per_az removes the production AZ egress dependency."
  type        = string
  default     = "single"

  validation {
    condition     = contains(["single", "one_per_az"], var.nat_gateway_mode)
    error_message = "nat_gateway_mode must be single or one_per_az."
  }
}

variable "enable_vpc_flow_logs" {
  description = "Capture accepted and rejected VPC traffic in CloudWatch."
  type        = bool
  default     = true
}

variable "domain_name" {
  description = "Optional public hostname, for example app.alphanet.example. Empty uses CloudFront's hostname."
  type        = string
  default     = ""

  validation {
    condition     = var.domain_name == "" || can(regex("^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$", var.domain_name))
    error_message = "domain_name must be empty or a lowercase DNS hostname."
  }
}

variable "cloudfront_certificate_arn" {
  description = "ACM certificate ARN in us-east-1. Required when domain_name is set."
  type        = string
  default     = ""

  validation {
    condition = (
      (var.domain_name == "" && var.cloudfront_certificate_arn == "") ||
      (var.domain_name != "" && can(regex("^arn:[^:]+:acm:us-east-1:", var.cloudfront_certificate_arn)))
    )
    error_message = "A custom domain requires an ACM certificate from us-east-1; omit both to use the CloudFront hostname."
  }
}

variable "alb_origin_domain_name" {
  description = "Dedicated DNS name used by CloudFront for TLS to the ALB origin."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$", var.alb_origin_domain_name))
    error_message = "alb_origin_domain_name must be a lowercase DNS hostname."
  }
}

variable "alb_origin_certificate_arn" {
  description = "Optional issued ACM certificate ARN in us-west-2. Empty auto-creates/validates one when route53_zone_id is set."
  type        = string
  default     = ""

  validation {
    condition = (
      can(regex("^arn:[^:]+:acm:us-west-2:[0-9]{12}:certificate/", var.alb_origin_certificate_arn)) ||
      (var.alb_origin_certificate_arn == "" && var.route53_zone_id != "")
    )
    error_message = "Supply a us-west-2 ACM certificate ARN, or a Route53 zone so Terraform can issue one."
  }
}

variable "route53_zone_id" {
  description = "Optional Route53 public hosted-zone ID. When set with domain_name, Terraform creates A/AAAA aliases."
  type        = string
  default     = ""
}

variable "enable_waf" {
  description = "Associate a CloudFront-scoped managed WAF policy. Keep enabled for public environments."
  type        = bool
  default     = true
}

variable "cloudfront_price_class" {
  description = "CloudFront edge footprint. Production should include Asian edge locations."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.cloudfront_price_class)
    error_message = "cloudfront_price_class must be PriceClass_100, PriceClass_200, or PriceClass_All."
  }
}

variable "waf_rate_limit" {
  description = "Maximum requests per source IP in a five-minute WAF window before blocking."
  type        = number
  default     = 30000

  validation {
    condition     = var.waf_rate_limit >= 100 && var.waf_rate_limit <= 2000000
    error_message = "waf_rate_limit must be between 100 and 2,000,000."
  }
}

variable "waf_oauth_jwks_rate_limit" {
  description = "Maximum public OAuth JWKS requests per source IP in a five-minute WAF window. CloudFront normally serves these from its dedicated cache."
  type        = number
  default     = 600

  validation {
    condition     = var.waf_oauth_jwks_rate_limit >= 100 && var.waf_oauth_jwks_rate_limit <= 10000
    error_message = "waf_oauth_jwks_rate_limit must be between 100 and 10,000."
  }
}

variable "allow_direct_alb_cidrs" {
  description = "At most five temporary IPv4 operator CIDRs for origin diagnostics. Empty keeps the IPv4 ALB reachable only from CloudFront."
  type        = list(string)
  default     = []

  validation {
    condition = length(var.allow_direct_alb_cidrs) <= 5 && alltrue([
      for cidr in var.allow_direct_alb_cidrs : can(cidrhost(cidr, 0)) && !strcontains(cidr, ":")
    ])
    error_message = "allow_direct_alb_cidrs must contain at most five valid IPv4 CIDRs; request an SG quota increase before adding more."
  }
}

variable "mcp_public_enabled" {
  description = "Expose /mcp only after Remote MCP OAuth, real REST-equivalent tools, and interoperability gates ship; false keeps ECS/Cloud Map internal and returns public 404."
  type        = bool
  default     = false
}

variable "mcp_runtime_enabled" {
  description = "Run the protected MCP protocol and private mTLS API path inside the VPC. Public exposure remains controlled independently by mcp_public_enabled."
  type        = bool
  default     = false
}

variable "mcp_oauth_owner_consent_enabled" {
  description = "Enable the API/Web Owner-consent flow without enabling the live OAuth server, MCP runtime, or public MCP edge."
  type        = bool
  default     = false
}

variable "mcp_oauth_server_enabled" {
  description = "Enable the live Remote MCP OAuth authorization server in API. Requires Owner consent, but does not enable the MCP runtime or public MCP edge."
  type        = bool
  default     = false
}

variable "mcp_oauth_provisioning_enabled" {
  description = "Create the inert, operator-only Remote MCP OAuth provisioning task and dedicated manifest secret. The task is never run by CD."
  type        = bool
  default     = false
}

variable "mcp_oauth_issuer" {
  description = "Exact HTTPS issuer used by the API OAuth server and expected in Remote MCP access tokens. Required when the OAuth server or MCP runtime is enabled."
  type        = string
  default     = ""

  validation {
    condition     = var.mcp_oauth_issuer == "" || can(regex("^https://[^/?#]+/[^?#]*$", var.mcp_oauth_issuer))
    error_message = "mcp_oauth_issuer must be empty or a canonical absolute HTTPS issuer (including the root slash) without query or fragment."
  }
}

variable "mcp_oauth_jwks_uri" {
  description = "Exact HTTPS JWKS endpoint published by API and used by the Remote MCP access-token verifier. Required when the OAuth server or MCP runtime is enabled."
  type        = string
  default     = ""

  validation {
    condition     = var.mcp_oauth_jwks_uri == "" || can(regex("^https://[^/?#]+/[^?#]+$", var.mcp_oauth_jwks_uri))
    error_message = "mcp_oauth_jwks_uri must be empty or a canonical absolute HTTPS URL with a path and without query or fragment."
  }
}

variable "app_version" {
  description = "Exact 40-character Git release SHA paired with image_overrides; CD patches it with each promoted release."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.app_version))
    error_message = "app_version must be the exact 40-character lowercase Git SHA for image_overrides."
  }
}

variable "ecr_repository_prefix" {
  description = "Account/region-wide immutable release repository prefix created by infra/aws/shared."
  type        = string
  default     = "alphanet"

  validation {
    condition     = can(regex("^[a-z][a-z0-9/_-]{1,100}$", var.ecr_repository_prefix))
    error_message = "ecr_repository_prefix must be a valid lowercase ECR path prefix."
  }
}

variable "image_overrides" {
  description = "Required release references for web, api, mcp, worker, and migrate; every value must be an ECR @sha256 reference."
  type        = map(string)

  validation {
    condition = (
      toset(keys(var.image_overrides)) == toset(["web", "api", "mcp", "worker", "migrate"]) &&
      alltrue([
        for reference in values(var.image_overrides) :
        can(regex("^[0-9]{12}\\.dkr\\.ecr\\.us-west-2\\.amazonaws\\.com/[a-z0-9][a-z0-9/_-]*@sha256:[0-9a-f]{64}$", reference))
      ])
    )
    error_message = "image_overrides must contain exactly web, api, mcp, worker, and migrate, each as a full us-west-2 ECR repository@sha256:<64 lowercase hex> reference."
  }
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture, locked to the CI-published linux/amd64 artifact."
  type        = string
  default     = "X86_64"

  validation {
    condition     = var.cpu_architecture == "X86_64"
    error_message = "cpu_architecture must remain X86_64 until CI publishes and verifies multi-architecture images."
  }
}

variable "task_cpu" {
  description = "Fargate CPU units by task."
  type        = map(number)
  default = {
    api     = 512
    mcp     = 256
    migrate = 512
    web     = 512
    worker  = 512
  }
}

variable "task_memory" {
  description = "Fargate memory MiB by task."
  type        = map(number)
  default = {
    api     = 1024
    mcp     = 512
    migrate = 1024
    web     = 1024
    worker  = 1024
  }
}

variable "service_desired_count" {
  description = "Desired tasks by long-running service. Set zero during first bootstrap, seed secrets, then raise."
  type        = map(number)
  default = {
    api    = 2
    mcp    = 1
    web    = 2
    worker = 1
  }

  validation {
    condition = alltrue([
      for service in ["web", "api", "mcp", "worker"] :
      contains(keys(var.service_desired_count), service) && var.service_desired_count[service] >= 0
    ])
    error_message = "service_desired_count must contain non-negative web, api, mcp, and worker values."
  }
}

variable "service_capacity_provider" {
  description = "Capacity provider per service. Use FARGATE_SPOT only for interruption-tolerant workloads."
  type        = map(string)
  default = {
    api    = "FARGATE"
    mcp    = "FARGATE"
    web    = "FARGATE"
    worker = "FARGATE"
  }

  validation {
    condition = alltrue([
      for service in ["web", "api", "mcp", "worker"] :
      contains(["FARGATE", "FARGATE_SPOT"], lookup(var.service_capacity_provider, service, ""))
    ])
    error_message = "Every service_capacity_provider value must be FARGATE or FARGATE_SPOT."
  }
}

variable "enable_service_autoscaling" {
  description = "Enable CPU and memory target tracking for web, api, and mcp."
  type        = bool
  default     = false
}

variable "service_autoscaling" {
  description = "Autoscaling bounds and utilization targets. Worker scaling remains manual until queue metrics exist."
  type = map(object({
    min_capacity  = number
    max_capacity  = number
    cpu_target    = number
    memory_target = number
  }))
  default = {
    api = {
      min_capacity  = 2
      max_capacity  = 8
      cpu_target    = 60
      memory_target = 70
    }
    mcp = {
      min_capacity  = 1
      max_capacity  = 4
      cpu_target    = 60
      memory_target = 70
    }
    web = {
      min_capacity  = 2
      max_capacity  = 6
      cpu_target    = 60
      memory_target = 70
    }
  }
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 30
}

variable "enable_enhanced_container_insights" {
  description = "Use enhanced per-task Container Insights instead of standard cluster metrics."
  type        = bool
  default     = false
}

variable "log_level" {
  description = "Runtime application log level."
  type        = string
  default     = "info"

  validation {
    condition     = contains(["fatal", "error", "warn", "info", "debug", "trace", "silent"], var.log_level)
    error_message = "log_level is not supported by AlphaNet."
  }
}

variable "auth_email_from" {
  description = "Verified production sender, for example AlphaNet <no-reply@example.com>."
  type        = string
}

variable "auth_email_reply_to" {
  description = "Optional Reply-To mailbox."
  type        = string
  default     = ""
}

variable "google_oauth_enabled" {
  description = "Inject Google OAuth credentials from the application secret."
  type        = bool
  default     = false
}

variable "admin_web_enabled" {
  description = "Enable the workforce-only Admin Web and matching Admin API boundary. Disabled by default and inert unless the complete production OIDC/session gate passes."
  type        = bool
  default     = false
}

variable "admin_oidc_issuer" {
  description = "Exact workforce OIDC issuer shared by Admin Web discovery and Admin API token verification."
  type        = string
  default     = ""

  validation {
    condition     = var.admin_oidc_issuer == "" || (length(var.admin_oidc_issuer) <= 2048 && can(regex("^https?://[^/@?#]+(?:/[^?#]*)?$", var.admin_oidc_issuer)))
    error_message = "admin_oidc_issuer must be empty or an absolute HTTP(S) issuer with no query or fragment; enabled AWS environments additionally require HTTPS."
  }
}

variable "admin_oidc_audience" {
  description = "Exact workforce Admin API audience. The browser resource must match it byte for byte."
  type        = string
  default     = ""

  validation {
    condition     = var.admin_oidc_audience == "" || can(regex("^[!-~]{1,200}$", var.admin_oidc_audience))
    error_message = "admin_oidc_audience must be empty or 1-200 visible ASCII characters without spaces."
  }
}

variable "admin_oidc_jwks_uri" {
  description = "Exact workforce OIDC JWKS URI used by the Admin API verifier."
  type        = string
  default     = ""

  validation {
    condition     = var.admin_oidc_jwks_uri == "" || (length(var.admin_oidc_jwks_uri) <= 2048 && can(regex("^https?://[^/@?#]+/[^?#]+$", var.admin_oidc_jwks_uri)))
    error_message = "admin_oidc_jwks_uri must be empty or an absolute HTTP(S) URL with a path and no query or fragment; enabled AWS environments additionally require HTTPS."
  }
}

variable "admin_oidc_allowed_algorithms" {
  description = "Asymmetric JWT algorithms accepted by the workforce Admin API verifier."
  type        = list(string)
  default     = ["RS256"]

  validation {
    condition = (
      length(var.admin_oidc_allowed_algorithms) > 0 &&
      length(distinct(var.admin_oidc_allowed_algorithms)) == length(var.admin_oidc_allowed_algorithms) &&
      alltrue([
        for algorithm in var.admin_oidc_allowed_algorithms :
        contains(["EdDSA", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512", "RS256", "RS384", "RS512"], algorithm)
      ])
    )
    error_message = "admin_oidc_allowed_algorithms must contain unique supported asymmetric EdDSA/ES/PS/RS algorithms."
  }
}

variable "admin_oidc_allowed_acr_values" {
  description = "Exact workforce acr values accepted as MFA evidence; may be empty only while amr=mfa evidence is accepted."
  type        = list(string)
  default     = []

  validation {
    condition = (
      length(var.admin_oidc_allowed_acr_values) <= 20 &&
      length(distinct(var.admin_oidc_allowed_acr_values)) == length(var.admin_oidc_allowed_acr_values) &&
      alltrue([
        for value in var.admin_oidc_allowed_acr_values :
        can(regex("^[!-~]{1,200}$", value))
      ])
    )
    error_message = "admin_oidc_allowed_acr_values must contain at most 20 unique visible-ASCII values no longer than 200 characters."
  }
}

variable "admin_oidc_allow_amr_mfa" {
  description = "Accept an amr claim containing mfa as strong workforce authentication evidence."
  type        = bool
  default     = true
}

variable "admin_oidc_clock_tolerance_seconds" {
  description = "Maximum workforce OIDC token clock skew accepted by the Admin API verifier."
  type        = number
  default     = 5

  validation {
    condition     = var.admin_oidc_clock_tolerance_seconds >= 0 && var.admin_oidc_clock_tolerance_seconds <= 60
    error_message = "admin_oidc_clock_tolerance_seconds must be between 0 and 60."
  }
}

variable "admin_web_oidc_client_id" {
  description = "Confidential workforce OIDC browser client ID; its client secret remains only in the application secret."
  type        = string
  default     = ""

  validation {
    condition     = var.admin_web_oidc_client_id == "" || can(regex("^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$", var.admin_web_oidc_client_id))
    error_message = "admin_web_oidc_client_id must be empty or a safe identifier no longer than 200 characters."
  }
}

variable "admin_web_oidc_scopes" {
  description = "Workforce browser authorization scopes. An enabled Admin Web must include openid."
  type        = list(string)
  default     = ["openid", "profile", "email"]

  validation {
    condition = (
      length(var.admin_web_oidc_scopes) <= 20 &&
      length(distinct(var.admin_web_oidc_scopes)) == length(var.admin_web_oidc_scopes) &&
      !contains(var.admin_web_oidc_scopes, "offline_access") &&
      alltrue([
        for scope in var.admin_web_oidc_scopes :
        can(regex("^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$", scope))
      ])
    )
    error_message = "admin_web_oidc_scopes must contain at most 20 unique OAuth scope tokens, include no offline_access token, and use at most 200 safe characters per token."
  }
}

variable "admin_web_oidc_resource" {
  description = "Resource requested by Admin Web. It must equal admin_oidc_audience when enabled."
  type        = string
  default     = ""

  validation {
    condition     = var.admin_web_oidc_resource == "" || can(regex("^https?://[^/@?#]+(?:/[^?#]*)?$", var.admin_web_oidc_resource))
    error_message = "admin_web_oidc_resource must be empty or an absolute HTTP(S) URL without credentials, query, or fragment; enabled AWS environments additionally require HTTPS."
  }
}

variable "admin_web_session_store" {
  description = "Admin Web session backend. AWS permits only DynamoDB when the Admin surface is enabled; memory exists solely to make unsafe plans fail explicitly."
  type        = string
  default     = "dynamodb"

  validation {
    condition     = contains(["dynamodb", "memory"], var.admin_web_session_store)
    error_message = "admin_web_session_store must be dynamodb or memory."
  }
}

variable "admin_web_session_ttl_seconds" {
  description = "Absolute lifetime of an authenticated workforce Admin Web session."
  type        = number
  default     = 28800

  validation {
    condition     = var.admin_web_session_ttl_seconds >= 900 && var.admin_web_session_ttl_seconds <= 43200
    error_message = "admin_web_session_ttl_seconds must be between 900 and 43200."
  }
}

variable "admin_web_login_ttl_seconds" {
  description = "Lifetime of a one-time workforce OIDC browser login transaction."
  type        = number
  default     = 600

  validation {
    condition     = var.admin_web_login_ttl_seconds >= 60 && var.admin_web_login_ttl_seconds <= 600
    error_message = "admin_web_login_ttl_seconds must be between 60 and 600."
  }
}

variable "mcp_additional_allowed_hosts" {
  description = "Additional exact MCP Host header values, comma separated."
  type        = string
  default     = ""
}

variable "outbox_consumer_name" {
  description = "Immutable outbox subscription name."
  type        = string
  default     = "alphanet-worker:v2"
}

variable "outbox_replay_from" {
  description = "Explicit UTC replay watermark for a new outbox consumer."
  type        = string
  default     = "2026-07-20T00:00:00.000Z"
}

variable "worker_poll_interval_ms" {
  type    = number
  default = 1000
}

variable "worker_batch_size" {
  type    = number
  default = 20
}

variable "aurora_engine_version" {
  description = "Aurora PostgreSQL 17 engine version available in us-west-2."
  type        = string
  default     = "17.5"

  validation {
    condition     = startswith(var.aurora_engine_version, "17.")
    error_message = "AlphaNet requires an Aurora PostgreSQL 17.x engine."
  }
}

variable "aurora_instance_count" {
  description = "One saves staging cost; two provides a production failover target."
  type        = number
  default     = 1

  validation {
    condition     = var.aurora_instance_count >= 1 && var.aurora_instance_count <= 4
    error_message = "aurora_instance_count must be between 1 and 4."
  }
}

variable "aurora_min_acu" {
  type    = number
  default = 0.5
}

variable "aurora_max_acu" {
  type    = number
  default = 8

  validation {
    condition     = var.aurora_max_acu >= var.aurora_min_acu
    error_message = "aurora_max_acu must be greater than or equal to aurora_min_acu."
  }
}

variable "aurora_auto_pause_seconds" {
  description = "Auto-pause delay when aurora_min_acu is zero; null disables auto-pause."
  type        = number
  default     = null
  nullable    = true

  validation {
    condition     = var.aurora_auto_pause_seconds == null || (var.aurora_auto_pause_seconds >= 300 && var.aurora_auto_pause_seconds <= 86400)
    error_message = "aurora_auto_pause_seconds must be null or between 300 and 86,400."
  }
}

variable "database_backup_retention_days" {
  type    = number
  default = 7

  validation {
    condition     = var.database_backup_retention_days >= 1 && var.database_backup_retention_days <= 35
    error_message = "database_backup_retention_days must be between 1 and 35."
  }
}

variable "database_cloudwatch_log_exports" {
  description = "Aurora log exports. Use [] for scale-to-zero staging; PostgreSQL export can keep Serverless v2 above its configured minimum."
  type        = list(string)
  default     = ["postgresql"]

  validation {
    condition     = alltrue([for value in var.database_cloudwatch_log_exports : value == "postgresql"])
    error_message = "Aurora PostgreSQL supports only the postgresql export in this baseline."
  }
}

variable "database_deletion_protection" {
  type    = bool
  default = true
}

variable "database_skip_final_snapshot" {
  type    = bool
  default = false
}

variable "database_performance_insights" {
  description = "Legacy Performance Insights switch. Keep false for the low-ACU baseline; enabling it requires aurora_min_acu >= 2 and a fresh cost review."
  type        = bool
  default     = false
}

variable "database_performance_insights_retention_days" {
  type    = number
  default = 7

  validation {
    condition     = contains([7, 31, 62, 93, 124, 155, 186, 217, 248, 279, 310, 341, 372, 403, 434, 465, 496, 527, 558, 589, 620, 651, 682, 713, 731], var.database_performance_insights_retention_days)
    error_message = "Use an RDS-supported Performance Insights retention period."
  }
}

variable "valkey_engine_version" {
  type    = string
  default = "8.0"
}

variable "valkey_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "valkey_multi_az" {
  description = "Create a replica with automatic failover in another AZ."
  type        = bool
  default     = true
}

variable "valkey_snapshot_retention_days" {
  type    = number
  default = 7
}

variable "alb_deletion_protection" {
  type    = bool
  default = true
}

variable "operations_alert_emails" {
  description = "Email endpoints subscribed to the operations SNS topic. Each address must confirm AWS's email."
  type        = set(string)
  default     = []
}

variable "github_oidc_provider_arn" {
  description = "Account-wide GitHub OIDC provider ARN created by infra/aws/shared."
  type        = string

  validation {
    condition     = can(regex("^arn:[^:]+:iam::[0-9]{12}:oidc-provider/token.actions.githubusercontent.com$", var.github_oidc_provider_arn))
    error_message = "github_oidc_provider_arn must be the shared token.actions.githubusercontent.com provider ARN."
  }
}

variable "github_publish_role_arn" {
  description = "Shared ECR-only publisher role ARN, surfaced for GitHub variable wiring."
  type        = string
  default     = ""
}

variable "github_oidc_subjects" {
  description = "Exact full GitHub OIDC sub claims allowed to deploy. Read the repository's authoritative sub_claim_prefix from GitHub; wildcards and inferred name-only subjects are forbidden."
  type        = list(string)

  validation {
    condition = length(var.github_oidc_subjects) > 0 && alltrue([
      for subject in var.github_oidc_subjects :
      can(regex("^repo:[A-Za-z0-9_.-]+@[0-9]+/[A-Za-z0-9_.-]+@[0-9]+:ref:refs/heads/main$", subject))
    ])
    error_message = "github_oidc_subjects must contain exact immutable GitHub owner-ID/repository-ID main-branch sub claims and no wildcards."
  }
}

variable "tags" {
  description = "Additional tags applied through provider default_tags."
  type        = map(string)
  default     = {}
}
