mock_provider "aws" {
  override_during = plan

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = jsonencode({
        Version = "2012-10-17"
        Statement = [{
          Effect    = "Allow"
          Action    = "sts:AssumeRole"
          Principal = { Service = "ecs-tasks.amazonaws.com" }
        }]
      })
    }
  }
}

mock_provider "aws" {
  alias           = "global"
  override_during = plan

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = jsonencode({
        Version = "2012-10-17"
        Statement = [{
          Effect    = "Allow"
          Action    = "sts:AssumeRole"
          Principal = { Service = "ecs-tasks.amazonaws.com" }
        }]
      })
    }
  }
}

mock_provider "random" {
  override_during = plan
}

override_data {
  target = data.aws_availability_zones.available
  values = {
    names = ["us-west-2a", "us-west-2b"]
  }
}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "123456789012"
  }
}

override_data {
  target = data.aws_partition.current
  values = {
    partition  = "aws"
    dns_suffix = "amazonaws.com"
  }
}

override_resource {
  target          = aws_rds_cluster.main
  override_during = plan
  values = {
    endpoint = "database.internal"
    master_user_secret = [{
      secret_arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:rds-admin"
    }]
  }
}

override_resource {
  target          = aws_cloudformation_stack.valkey
  override_during = plan
  values = {
    outputs = {
      AuthSecretArn          = "arn:aws:secretsmanager:us-west-2:123456789012:secret:valkey"
      Port                   = "6379"
      PrimaryEndpointAddress = "valkey.internal"
      ReplicationGroupId     = "alphanet-staging-valkey"
    }
  }
}

override_resource {
  target          = aws_kms_key.data
  override_during = plan
  values = {
    arn = "arn:aws:kms:us-west-2:123456789012:key/00000000-0000-0000-0000-000000000000"
  }
}

override_resource {
  target          = aws_security_group.valkey
  override_during = plan
  values = {
    id = "sg-00000000000000000"
  }
}

override_resource {
  target          = aws_security_group.migration
  override_during = plan
  values = {
    id = "sg-00000000000000003"
  }
}

override_resource {
  target          = aws_ecs_cluster.main
  override_during = plan
  values = {
    arn = "arn:aws:ecs:us-west-2:123456789012:cluster/alphanet-staging"
  }
}

override_resource {
  target          = aws_subnet.private["0"]
  override_during = plan
  values = {
    id = "subnet-00000000000000000"
  }
}

override_resource {
  target          = aws_subnet.private["1"]
  override_during = plan
  values = {
    id = "subnet-00000000000000001"
  }
}

override_resource {
  target          = aws_security_group.service["api"]
  override_during = plan
  values = {
    id = "sg-00000000000000001"
  }
}

override_resource {
  target          = aws_security_group.service["mcp"]
  override_during = plan
  values = {
    id = "sg-00000000000000002"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.application
  override_during = plan
  values = {
    arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:alphanet-staging-application"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.oauth_client_provisioning[0]
  override_during = plan
  values = {
    arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:alphanet-staging-remote-mcp-oauth-client-provisioning"
  }
}

override_resource {
  target          = aws_ecs_task_definition.database_job["oauth-provision"]
  override_during = plan
  values = {
    arn = "arn:aws:ecs:us-west-2:123456789012:task-definition/alphanet-staging-oauth-provision:42"
  }
}

override_resource {
  target          = aws_iam_role.oauth_provision_execution[0]
  override_during = plan
  values = {
    arn = "arn:aws:iam::123456789012:role/alphanet-staging-oauth-provision-execution"
  }
}

override_resource {
  target          = aws_iam_role.oauth_provision_task[0]
  override_during = plan
  values = {
    arn = "arn:aws:iam::123456789012:role/alphanet-staging-oauth-provision-task"
  }
}

override_resource {
  target          = aws_iam_role.oauth_provision_launcher[0]
  override_during = plan
  values = {
    arn = "arn:aws:iam::123456789012:role/alphanet-staging-oauth-provision-launcher"
  }
}

override_resource {
  target          = aws_sfn_state_machine.oauth_provision[0]
  override_during = plan
  values = {
    arn = "arn:aws:states:us-west-2:123456789012:stateMachine:alphanet-staging-oauth-provision"
  }
}

override_data {
  target = data.aws_ecr_image.service["web"]
  values = {
    image_digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}

override_data {
  target = data.aws_ecr_image.service["api"]
  values = {
    image_digest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
}

override_data {
  target = data.aws_ecr_image.service["mcp"]
  values = {
    image_digest = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  }
}

override_data {
  target = data.aws_ecr_image.service["worker"]
  values = {
    image_digest = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  }
}

override_data {
  target = data.aws_ecr_image.service["migrate"]
  values = {
    image_digest = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  }
}

run "single_node_valkey_template" {
  command = plan

  variables {
    environment                     = "staging"
    app_version                     = "0123456789abcdef0123456789abcdef01234567"
    domain_name                     = "staging.alphanet.example"
    cloudfront_certificate_arn      = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000001"
    alb_origin_domain_name          = "origin-staging.alphanet.example"
    alb_origin_certificate_arn      = "arn:aws:acm:us-west-2:123456789012:certificate/00000000-0000-0000-0000-000000000000"
    auth_email_from                 = "AlphaNet <no-reply@alphanet.example>"
    github_oidc_provider_arn        = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    github_oidc_subjects            = ["repo:songzhiyuan98@123667992/AlphaNet@1306225890:ref:refs/heads/main"]
    mcp_runtime_enabled             = true
    mcp_oauth_owner_consent_enabled = true
    mcp_oauth_server_enabled        = true
    mcp_oauth_provisioning_enabled  = true
    mcp_oauth_issuer                = "https://staging.alphanet.example/api/auth"
    mcp_oauth_jwks_uri              = "https://staging.alphanet.example/api/auth/jwks"
    waf_rate_limit                  = 30000
    waf_oauth_jwks_rate_limit       = 777
    valkey_multi_az                 = false
    database_deletion_protection    = false
    database_skip_final_snapshot    = true
    database_cloudwatch_log_exports = []

    image_overrides = {
      web     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      api     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      mcp     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-mcp@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      worker  = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-worker@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      migrate = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-migrate@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["web"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-web"
      name           = "alphanet-web"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-web"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["api"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-api"
      name           = "alphanet-api"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-api"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["mcp"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-mcp"
      name           = "alphanet-mcp"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-mcp"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["worker"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-worker"
      name           = "alphanet-worker"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-worker"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["migrate"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-migrate"
      name           = "alphanet-migrate"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-migrate"
    }
  }

  assert {
    condition     = !contains(keys(jsondecode(aws_cloudformation_stack.valkey.template_body).Resources.ValkeyReplicationGroup.Properties), "NumCacheClusters")
    error_message = "Single-node Valkey must omit NumCacheClusters so CloudFormation can use its supported default of one."
  }

  assert {
    condition     = jsondecode(aws_cloudformation_stack.valkey.template_body).Resources.ValkeyReplicationGroup.Properties.KmsKeyId == aws_kms_key.data.arn
    error_message = "Valkey must use the environment data KMS key."
  }

  assert {
    condition     = !contains(keys(jsondecode(aws_cloudformation_stack.valkey.template_body).Outputs), "ReaderEndpointAddress")
    error_message = "The single-node stack must not resolve a replica-only reader endpoint."
  }

  assert {
    condition = (
      jsondecode(aws_cloudformation_stack.valkey.template_body).Resources.ValkeyAuthSecret.DeletionPolicy == "Retain" &&
      jsondecode(aws_cloudformation_stack.valkey.template_body).Resources.ValkeyAuthSecret.UpdateReplacePolicy == "Retain" &&
      !contains(keys(jsondecode(aws_cloudformation_stack.valkey.template_body).Resources.ValkeyAuthSecret.Properties), "Name")
    )
    error_message = "Valkey AUTH secrets must survive stack deletion/replacement and use generated physical names so recovery is not blocked by a retained fixed name."
  }

  assert {
    condition = (
      length(aws_ecs_service.app["web"].load_balancer) == 1 &&
      length(aws_ecs_service.app["api"].load_balancer) == 1 &&
      length(aws_ecs_service.app["mcp"].load_balancer) == 0 &&
      !contains(keys(aws_vpc_security_group_ingress_rule.service_from_alb), "mcp") &&
      !contains(keys(aws_vpc_security_group_egress_rule.alb_to_service), "mcp") &&
      !contains(keys(aws_cloudwatch_metric_alarm.alb_unhealthy_targets), "mcp")
    )
    error_message = "Private-by-default MCP must remain off the ALB, its security-group path, and its target-health alarms until mcp_public_enabled is explicitly true."
  }

  assert {
    condition = (
      length(aws_vpc_security_group_ingress_rule.api_internal_from_mcp) == 1 &&
      length(aws_vpc_security_group_egress_rule.mcp_to_api_internal) == 1 &&
      aws_vpc_security_group_ingress_rule.api_internal_from_mcp[0].from_port == 4443 &&
      aws_vpc_security_group_ingress_rule.api_internal_from_mcp[0].referenced_security_group_id == aws_security_group.service["mcp"].id &&
      aws_vpc_security_group_egress_rule.mcp_to_api_internal[0].referenced_security_group_id == aws_security_group.service["api"].id
    )
    error_message = "The private Remote MCP runtime must expose only the dedicated MCP-to-API mTLS security-group path."
  }

  assert {
    condition = (
      contains(
        [for item in local.api_environment : "${item.name}=${item.value}"],
        "MCP_INTERNAL_API_ENABLED=true",
      ) &&
      contains(
        [for item in local.mcp_environment : "${item.name}=${item.value}"],
        "MCP_RUNTIME_ENABLED=true",
      ) &&
      contains(
        [for item in local.mcp_environment : "${item.name}=${item.value}"],
        "MCP_PUBLIC_ENABLED=false",
      ) &&
      contains(
        [for item in local.api_environment : "${item.name}=${item.value}"],
        "MCP_OAUTH_OWNER_CONSENT_ENABLED=true",
      ) &&
      contains(
        [for item in local.api_environment : "${item.name}=${item.value}"],
        "MCP_OAUTH_SERVER_ENABLED=true",
      ) &&
      contains(
        [for item in local.web_environment : "${item.name}=${item.value}"],
        "MCP_OAUTH_OWNER_CONSENT_ENABLED=true",
      ) &&
      local.mcp_internal_api_port == 4443
    )
    error_message = "Staging OAuth consent/server and the private MCP runtime must be independently enabled without promoting the public MCP route."
  }

  assert {
    condition = (
      length(aws_cloudwatch_log_metric_filter.remote_mcp_oauth_lifecycle_backlog) == 1 &&
      length(aws_cloudwatch_log_metric_filter.remote_mcp_oauth_lifecycle_backlog_exceeded) == 1 &&
      length(aws_cloudwatch_log_metric_filter.remote_mcp_oauth_lifecycle_heartbeat) == 1 &&
      length(aws_cloudwatch_log_metric_filter.remote_mcp_oauth_lifecycle_failure) == 1 &&
      length(aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_backlog) == 1 &&
      length(aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_missing) == 1 &&
      length(aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_failure) == 1 &&
      aws_cloudwatch_log_metric_filter.remote_mcp_oauth_lifecycle_backlog[0].log_group_name == aws_cloudwatch_log_group.service["worker"].name &&
      aws_cloudwatch_log_metric_filter.remote_mcp_oauth_lifecycle_backlog_exceeded[0].pattern == "{ $.event = \"remote_mcp_oauth_lifecycle_maintenance\" && $.outcome = \"succeeded\" && $.backlog_alarm_threshold_exceeded = true }" &&
      aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_backlog[0].metric_name == "LifecycleBacklogThresholdExceeded" &&
      aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_backlog[0].threshold == 0 &&
      aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_backlog[0].evaluation_periods == 2 &&
      aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_backlog[0].datapoints_to_alarm == 2 &&
      aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_backlog[0].treat_missing_data == "notBreaching" &&
      aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_missing[0].comparison_operator == "LessThanThreshold" &&
      aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_missing[0].threshold == 1 &&
      aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_missing[0].treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_failure[0].metric_name == "LifecycleFailureCount" &&
      aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_failure[0].evaluation_periods == 1
    )
    error_message = "Enabled private MCP must publish bounded OAuth lifecycle backlog gauges and alarm only on the shared-policy threshold signal."
  }

  assert {
    condition = (
      !contains(
        [for item in local.task_secrets.mcp : item.name],
        "DATABASE_URL",
      ) &&
      contains(
        [for item in local.task_secrets.mcp : item.name],
        "MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64",
      ) &&
      contains(
        [for item in local.task_secrets.api : item.name],
        "MCP_INTERNAL_API_SERVER_KEY_PEM_BASE64",
      ) &&
      contains(
        [for item in local.task_secrets.api : item.name],
        "MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64",
      ) &&
      contains(
        [for item in local.task_secrets.mcp : item.name],
        "MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64",
      ) &&
      alltrue([
        for name in [
          "MCP_OAUTH_AUTHORIZATION_BINDING_KEY_BASE64",
          "MCP_OAUTH_CONTINUATION_KEY_BASE64",
          "MCP_OAUTH_TOKEN_STORAGE_KEY_BASE64",
          "MCP_OAUTH_JWK_ENCRYPTION_KEY_BASE64",
        ] : contains([for item in local.task_secrets.api : item.name], name)
      ]) &&
      length([
        for item in local.task_secrets.api : item
        if item.name == "MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64"
      ]) == 1
    )
    error_message = "MCP must receive no database credential, API must receive each OAuth key once, and issuer/verifier must share only the independent token-JTI digest key."
  }

  assert {
    condition = contains(
      flatten([
        for condition in aws_lb_listener_rule.api.condition :
        try(condition.path_pattern[0].values, [])
      ]),
      "/.well-known/oauth-authorization-server/api/auth"
    )
    error_message = "The API listener boundary must route the issuer-relative RFC 8414 authorization-server metadata path to the OAuth server."
  }

  assert {
    condition = strcontains(
      local.deployment_github_variables["STAGING_SMOKE_PATHS"],
      "/.well-known/oauth-authorization-server/api/auth",
    )
    error_message = "OAuth-enabled environments must include public issuer discovery in the generated deployment smoke paths."
  }

  assert {
    condition = contains(
      flatten([
        for condition in aws_lb_listener_rule.mcp.condition :
        try(condition.path_pattern[0].values, [])
      ]),
      "/.well-known/oauth-protected-resource/mcp"
    )
    error_message = "The MCP listener boundary must reserve the standard protected-resource metadata path before public exposure is enabled."
  }

  assert {
    condition = (
      strcontains(aws_cloudfront_function.sanitize_forwarding_headers.code, "x-alphanet-viewer-ip") &&
      strcontains(aws_cloudfront_function.sanitize_forwarding_headers.code, "event.viewer.ip") &&
      strcontains(aws_cloudfront_function.sanitize_forwarding_headers.code, "x-alphanet-mcp-actor-context")
    )
    error_message = "CloudFront must overwrite the dedicated viewer-IP header and remove the private ActorContext header before forwarding."
  }

  assert {
    condition = (
      length([
        for behavior in aws_cloudfront_distribution.main.ordered_cache_behavior : behavior
        if behavior.path_pattern == "/api/auth/jwks"
      ]) == 1 &&
      toset(one([
        for behavior in aws_cloudfront_distribution.main.ordered_cache_behavior : behavior
        if behavior.path_pattern == "/api/auth/jwks"
      ]).allowed_methods) == toset(["GET", "HEAD", "OPTIONS"]) &&
      toset(one([
        for behavior in aws_cloudfront_distribution.main.ordered_cache_behavior : behavior
        if behavior.path_pattern == "/api/auth/jwks"
      ]).cached_methods) == toset(["GET", "HEAD"]) &&
      one([
        for behavior in aws_cloudfront_distribution.main.ordered_cache_behavior : behavior
        if behavior.path_pattern == "/api/auth/jwks"
      ]).cache_policy_id == data.aws_cloudfront_cache_policy.caching_optimized.id
    )
    error_message = "The exact public OAuth JWKS path must be the sole dedicated CachingOptimized behavior, allow only GET/HEAD/OPTIONS, and cache only GET/HEAD."
  }

  assert {
    condition = (
      var.waf_oauth_jwks_rate_limit != var.waf_rate_limit &&
      length([
        for rule in aws_wafv2_web_acl.edge[0].rule : rule
        if rule.name == "oauth-jwks-per-ip-rate-limit"
      ]) == 1 &&
      one([
        for rule in aws_wafv2_web_acl.edge[0].rule : rule
        if rule.name == "oauth-jwks-per-ip-rate-limit"
      ]).priority == 25 &&
      length(one([
        for rule in aws_wafv2_web_acl.edge[0].rule : rule
        if rule.name == "oauth-jwks-per-ip-rate-limit"
      ]).action[0].block) == 1 &&
      one([
        for rule in aws_wafv2_web_acl.edge[0].rule : rule
        if rule.name == "oauth-jwks-per-ip-rate-limit"
      ]).statement[0].rate_based_statement[0].aggregate_key_type == "IP" &&
      one([
        for rule in aws_wafv2_web_acl.edge[0].rule : rule
        if rule.name == "oauth-jwks-per-ip-rate-limit"
      ]).statement[0].rate_based_statement[0].limit == var.waf_oauth_jwks_rate_limit &&
      one([
        for rule in aws_wafv2_web_acl.edge[0].rule : rule
        if rule.name == "oauth-jwks-per-ip-rate-limit"
      ]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].positional_constraint == "EXACTLY" &&
      one([
        for rule in aws_wafv2_web_acl.edge[0].rule : rule
        if rule.name == "oauth-jwks-per-ip-rate-limit"
      ]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].search_string == "/api/auth/jwks" &&
      length(one([
        for rule in aws_wafv2_web_acl.edge[0].rule : rule
        if rule.name == "oauth-jwks-per-ip-rate-limit"
      ]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].text_transformation) == 1 &&
      one(one([
        for rule in aws_wafv2_web_acl.edge[0].rule : rule
        if rule.name == "oauth-jwks-per-ip-rate-limit"
      ]).statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].text_transformation).type == "NONE"
    )
    error_message = "The priority-25 JWKS WAF rule must use its independent limit and an untransformed EXACTLY match for /api/auth/jwks."
  }

  assert {
    condition = (
      contains(keys(aws_ecs_task_definition.database_job), "oauth-provision") &&
      length(aws_secretsmanager_secret.oauth_client_provisioning) == 1 &&
      !contains(keys(aws_ecs_service.app), "oauth-provision") &&
      jsondecode(aws_ecs_task_definition.database_job["oauth-provision"].container_definitions)[0].name == "oauth-provision" &&
      jsondecode(aws_ecs_task_definition.database_job["oauth-provision"].container_definitions)[0].entryPoint == [
        "/bin/bash",
        "/opt/alphanet/db/scripts/aws-reconcile-remote-mcp-oauth-clients.sh",
      ] &&
      jsondecode(aws_ecs_task_definition.database_job["oauth-provision"].container_definitions)[0].command == [] &&
      jsondecode(aws_ecs_task_definition.database_job["oauth-provision"].container_definitions)[0].image == var.image_overrides["migrate"] &&
      length(aws_iam_role.oauth_provision_execution) == 1 &&
      length(aws_iam_role.oauth_provision_task) == 1 &&
      length(aws_iam_role.oauth_provision_launcher) == 1 &&
      length(aws_sfn_state_machine.oauth_provision) == 1
    )
    error_message = "OAuth provisioning must remain a digest-pinned one-off task reachable only through its trusted Step Functions launcher, with dedicated roles and no ECS service."
  }

  assert {
    condition = sort([
      for secret in jsondecode(aws_ecs_task_definition.database_job["oauth-provision"].container_definitions)[0].secrets : secret.name
      ]) == tolist([
      "ALPHANET_OAUTH_MANIFEST_BASE64",
      "ALPHANET_OAUTH_MANIFEST_SHA256",
      "PGPASSWORD",
    ])
    error_message = "The immutable OAuth provisioning task must receive only its three reviewed secret fields."
  }

  assert {
    condition = (
      [
        for secret in jsondecode(aws_ecs_task_definition.database_job["oauth-provision"].container_definitions)[0].secrets : secret.valueFrom
        if secret.name == "ALPHANET_OAUTH_MANIFEST_BASE64"
      ] == ["${aws_secretsmanager_secret.oauth_client_provisioning[0].arn}:manifest_base64:ALPHANET_OAUTH_APPROVED:"] &&
      [
        for secret in jsondecode(aws_ecs_task_definition.database_job["oauth-provision"].container_definitions)[0].secrets : secret.valueFrom
        if secret.name == "ALPHANET_OAUTH_MANIFEST_SHA256"
      ] == ["${aws_secretsmanager_secret.oauth_client_provisioning[0].arn}:manifest_sha256:ALPHANET_OAUTH_APPROVED:"]
    )
    error_message = "The immutable OAuth provisioning task must resolve both manifest fields only through the approved stage."
  }

  assert {
    condition = (
      !contains(
        [
          for item in jsondecode(aws_ecs_task_definition.database_job["oauth-provision"].container_definitions)[0].environment : item.name
        ],
        "ALPHANET_OAUTH_EXPECTED_APPROVED_SHA256",
      ) &&
      contains(
        [
          for item in jsondecode(aws_ecs_task_definition.database_job["oauth-provision"].container_definitions)[0].environment : "${item.name}=${item.value}"
        ],
        "ALPHANET_EXPECTED_OAUTH_RESOURCE=https://staging.alphanet.example/mcp",
      )
    )
    error_message = "The task baseline must not contain a caller digest and must pin the expected environment resource."
  }

  assert {
    condition = (
      local.oauth_provision_launcher_policy.Version == "2012-10-17" &&
      jsondecode(aws_iam_role_policy.oauth_provision_launcher[0].policy) == local.oauth_provision_launcher_policy &&
      length(local.oauth_provision_launcher_policy.Statement) == 4 &&
      local.oauth_provision_launcher_policy.Statement[0].Sid == "RunExactOAuthProvisioningRevision" &&
      local.oauth_provision_launcher_policy.Statement[0].Effect == "Allow" &&
      local.oauth_provision_launcher_policy.Statement[0].Action == ["ecs:RunTask"] &&
      local.oauth_provision_launcher_policy.Statement[0].Resource == [aws_ecs_task_definition.database_job["oauth-provision"].arn] &&
      local.oauth_provision_launcher_policy.Statement[0].Condition.ArnEquals["ecs:cluster"] == aws_ecs_cluster.main.arn &&
      local.oauth_provision_launcher_policy.Statement[1].Sid == "ObserveOAuthProvisioningTask" &&
      toset(local.oauth_provision_launcher_policy.Statement[1].Action) == toset(["ecs:DescribeTasks", "ecs:StopTask"]) &&
      local.oauth_provision_launcher_policy.Statement[1].Resource == ["*"] &&
      local.oauth_provision_launcher_policy.Statement[1].Condition.ArnEquals["ecs:cluster"] == aws_ecs_cluster.main.arn &&
      local.oauth_provision_launcher_policy.Statement[2].Sid == "PassOnlyOAuthProvisioningRoles" &&
      local.oauth_provision_launcher_policy.Statement[2].Action == ["iam:PassRole"] &&
      toset(local.oauth_provision_launcher_policy.Statement[2].Resource) == toset([
        aws_iam_role.oauth_provision_execution[0].arn,
        aws_iam_role.oauth_provision_task[0].arn,
      ]) &&
      local.oauth_provision_launcher_policy.Statement[2].Condition.StringEquals["iam:PassedToService"] == "ecs-tasks.amazonaws.com" &&
      local.oauth_provision_launcher_policy.Statement[3].Sid == "TrackSynchronousEcsTask" &&
      toset(local.oauth_provision_launcher_policy.Statement[3].Action) == toset([
        "events:DescribeRule",
        "events:PutRule",
        "events:PutTargets",
      ]) &&
      local.oauth_provision_launcher_policy.Statement[3].Resource == [
        "arn:aws:events:us-west-2:123456789012:rule/StepFunctionsGetEventsForECSTaskRule",
      ] &&
      !contains(flatten([
        for statement in local.oauth_provision_launcher_policy.Statement : statement.Action
      ]), "ecs:RegisterTaskDefinition")
    )
    error_message = "The trusted launcher IAM policy must run one exact revision on one cluster, pass only its dedicated roles, and contain no task-registration authority."
  }

  assert {
    condition = (
      local.oauth_provision_state_machine_definition.StartAt == "RequireExpectedDigest" &&
      aws_sfn_state_machine.oauth_provision[0].definition == jsonencode(local.oauth_provision_state_machine_definition) &&
      toset(keys(local.oauth_provision_state_machine_definition.States)) == toset([
        "InvalidInput",
        "RequireExpectedDigest",
        "RunProvisioningTask",
      ]) &&
      jsonencode(local.oauth_provision_state_machine_definition.States.RequireExpectedDigest.Choices) == jsonencode([{
        Variable = "$.expected_manifest_sha256"
        IsString = true
        Next     = "RunProvisioningTask"
      }]) &&
      local.oauth_provision_state_machine_definition.States.RequireExpectedDigest.Default == "InvalidInput" &&
      local.oauth_provision_state_machine_definition.States.RunProvisioningTask.Resource == "arn:aws:states:::ecs:runTask.sync" &&
      local.oauth_provision_state_machine_definition.States.RunProvisioningTask.TimeoutSeconds == 900 &&
      local.oauth_provision_state_machine_definition.States.RunProvisioningTask.End == true &&
      local.oauth_provision_state_machine_definition.States.RunProvisioningTask.Parameters.Cluster == aws_ecs_cluster.main.arn &&
      local.oauth_provision_state_machine_definition.States.RunProvisioningTask.Parameters.TaskDefinition == aws_ecs_task_definition.database_job["oauth-provision"].arn &&
      local.oauth_provision_state_machine_definition.States.RunProvisioningTask.Parameters.LaunchType == "FARGATE" &&
      local.oauth_provision_state_machine_definition.States.RunProvisioningTask.Parameters.EnableExecuteCommand == false &&
      local.oauth_provision_state_machine_definition.States.RunProvisioningTask.Parameters.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp == "DISABLED" &&
      toset(local.oauth_provision_state_machine_definition.States.RunProvisioningTask.Parameters.NetworkConfiguration.AwsvpcConfiguration.SecurityGroups) == toset([aws_security_group.migration.id]) &&
      toset(local.oauth_provision_state_machine_definition.States.RunProvisioningTask.Parameters.NetworkConfiguration.AwsvpcConfiguration.Subnets) == toset([for subnet in aws_subnet.private : subnet.id]) &&
      length(local.oauth_provision_state_machine_definition.States.RunProvisioningTask.Parameters.Overrides.ContainerOverrides) == 1 &&
      toset(keys(local.oauth_provision_state_machine_definition.States.RunProvisioningTask.Parameters.Overrides.ContainerOverrides[0])) == toset(["Environment", "Name"]) &&
      local.oauth_provision_state_machine_definition.States.RunProvisioningTask.Parameters.Overrides.ContainerOverrides[0].Name == "oauth-provision" &&
      jsonencode(local.oauth_provision_state_machine_definition.States.RunProvisioningTask.Parameters.Overrides.ContainerOverrides[0].Environment) == jsonencode([{
        Name      = "ALPHANET_OAUTH_EXPECTED_APPROVED_SHA256"
        "Value.$" = "$.expected_manifest_sha256"
      }])
    )
    error_message = "The trusted state machine must fix the exact task revision, private network, command surface, and sole non-secret digest override."
  }

  assert {
    condition = (
      length(aws_iam_role_policy.github_deploy_deny_oauth_provisioning) == 1 &&
      local.github_deploy_oauth_provision_deny_policy.Version == "2012-10-17" &&
      jsondecode(aws_iam_role_policy.github_deploy_deny_oauth_provisioning[0].policy) == local.github_deploy_oauth_provision_deny_policy &&
      length(local.github_deploy_oauth_provision_deny_policy.Statement) == 4 &&
      local.github_deploy_oauth_provision_deny_policy.Statement[0].Effect == "Deny" &&
      toset(local.github_deploy_oauth_provision_deny_policy.Statement[0].Action) == toset([
        "states:DescribeExecution",
        "states:DescribeStateMachine",
        "states:StartExecution",
        "states:StopExecution",
      ]) &&
      contains(local.github_deploy_oauth_provision_deny_policy.Statement[0].Resource, aws_sfn_state_machine.oauth_provision[0].arn) &&
      local.github_deploy_oauth_provision_deny_policy.Statement[1].Effect == "Deny" &&
      toset(local.github_deploy_oauth_provision_deny_policy.Statement[1].Action) == toset([
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:UpdateSecretVersionStage",
      ]) &&
      local.github_deploy_oauth_provision_deny_policy.Statement[1].Resource == [aws_secretsmanager_secret.oauth_client_provisioning[0].arn] &&
      local.github_deploy_oauth_provision_deny_policy.Statement[2].Action == ["ecs:RunTask"] &&
      local.github_deploy_oauth_provision_deny_policy.Statement[2].Resource == [aws_ecs_task_definition.database_job["oauth-provision"].arn] &&
      local.github_deploy_oauth_provision_deny_policy.Statement[3].Action == ["iam:PassRole"] &&
      toset(local.github_deploy_oauth_provision_deny_policy.Statement[3].Resource) == toset([
        aws_iam_role.oauth_provision_execution[0].arn,
        aws_iam_role.oauth_provision_task[0].arn,
        aws_iam_role.oauth_provision_launcher[0].arn,
      ])
    )
    error_message = "GitHub CD must carry an explicit deny for the dedicated provisioning workflow, secret, task, and roles."
  }

  assert {
    condition = alltrue([
      for key in keys(local.deployment_github_variables) : !strcontains(key, "OAUTH_PROVISION")
    ])
    error_message = "Ordinary GitHub CD variables must not expose or invoke OAuth provisioning."
  }
}

run "oauth_server_without_mcp_runtime_observability" {
  command = plan

  variables {
    environment                     = "staging"
    app_version                     = "0123456789abcdef0123456789abcdef01234567"
    domain_name                     = "staging.alphanet.example"
    cloudfront_certificate_arn      = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000001"
    alb_origin_domain_name          = "origin-staging.alphanet.example"
    alb_origin_certificate_arn      = "arn:aws:acm:us-west-2:123456789012:certificate/00000000-0000-0000-0000-000000000000"
    auth_email_from                 = "AlphaNet <no-reply@alphanet.example>"
    github_oidc_provider_arn        = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    github_oidc_subjects            = ["repo:songzhiyuan98@123667992/AlphaNet@1306225890:ref:refs/heads/main"]
    mcp_oauth_owner_consent_enabled = true
    mcp_oauth_server_enabled        = true
    mcp_oauth_issuer                = "https://staging.alphanet.example/api/auth"
    mcp_oauth_jwks_uri              = "https://staging.alphanet.example/api/auth/jwks"
    valkey_multi_az                 = false
    database_deletion_protection    = false
    database_skip_final_snapshot    = true
    database_cloudwatch_log_exports = []

    image_overrides = {
      web     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      api     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      mcp     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-mcp@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      worker  = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-worker@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      migrate = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-migrate@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["web"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-web"
      name           = "alphanet-web"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-web"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["api"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-api"
      name           = "alphanet-api"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-api"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["mcp"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-mcp"
      name           = "alphanet-mcp"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-mcp"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["worker"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-worker"
      name           = "alphanet-worker"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-worker"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["migrate"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-migrate"
      name           = "alphanet-migrate"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-migrate"
    }
  }

  assert {
    condition = (
      var.mcp_oauth_server_enabled &&
      !local.mcp_runtime_enabled &&
      !var.mcp_public_enabled &&
      length(aws_cloudwatch_log_metric_filter.remote_mcp_oauth_lifecycle_backlog) == 1 &&
      length(aws_cloudwatch_log_metric_filter.remote_mcp_oauth_lifecycle_backlog_exceeded) == 1 &&
      length(aws_cloudwatch_log_metric_filter.remote_mcp_oauth_lifecycle_heartbeat) == 1 &&
      length(aws_cloudwatch_log_metric_filter.remote_mcp_oauth_lifecycle_failure) == 1 &&
      length(aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_backlog) == 1 &&
      length(aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_missing) == 1 &&
      length(aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_failure) == 1
    )
    error_message = "OAuth lifecycle observability must follow its API OAuth producer even when the separate MCP runtime and public edge remain disabled."
  }
}

run "reject_oauth_server_without_waf" {
  command = plan

  variables {
    environment                     = "staging"
    app_version                     = "0123456789abcdef0123456789abcdef01234567"
    domain_name                     = "staging.alphanet.example"
    cloudfront_certificate_arn      = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000001"
    alb_origin_domain_name          = "origin-staging.alphanet.example"
    alb_origin_certificate_arn      = "arn:aws:acm:us-west-2:123456789012:certificate/00000000-0000-0000-0000-000000000000"
    auth_email_from                 = "AlphaNet <no-reply@alphanet.example>"
    github_oidc_provider_arn        = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    github_oidc_subjects            = ["repo:songzhiyuan98@123667992/AlphaNet@1306225890:ref:refs/heads/main"]
    enable_waf                      = false
    mcp_oauth_owner_consent_enabled = true
    mcp_oauth_server_enabled        = true
    mcp_oauth_issuer                = "https://staging.alphanet.example/api/auth"
    mcp_oauth_jwks_uri              = "https://staging.alphanet.example/api/auth/jwks"
    valkey_multi_az                 = false
    database_deletion_protection    = false
    database_skip_final_snapshot    = true
    database_cloudwatch_log_exports = []

    image_overrides = {
      web     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      api     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      mcp     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-mcp@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      worker  = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-worker@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      migrate = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-migrate@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["web"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-web"
      name           = "alphanet-web"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-web"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["api"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-api"
      name           = "alphanet-api"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-api"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["mcp"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-mcp"
      name           = "alphanet-mcp"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-mcp"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["worker"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-worker"
      name           = "alphanet-worker"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-worker"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["migrate"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-migrate"
      name           = "alphanet-migrate"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-migrate"
    }
  }

  expect_failures = [
    aws_ecs_task_definition.service["api"],
  ]
}

run "reject_oauth_server_without_worker_capacity" {
  command = plan

  variables {
    environment                     = "staging"
    app_version                     = "0123456789abcdef0123456789abcdef01234567"
    domain_name                     = "staging.alphanet.example"
    cloudfront_certificate_arn      = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000001"
    alb_origin_domain_name          = "origin-staging.alphanet.example"
    alb_origin_certificate_arn      = "arn:aws:acm:us-west-2:123456789012:certificate/00000000-0000-0000-0000-000000000000"
    auth_email_from                 = "AlphaNet <no-reply@alphanet.example>"
    github_oidc_provider_arn        = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    github_oidc_subjects            = ["repo:songzhiyuan98@123667992/AlphaNet@1306225890:ref:refs/heads/main"]
    mcp_oauth_owner_consent_enabled = true
    mcp_oauth_server_enabled        = true
    mcp_oauth_issuer                = "https://staging.alphanet.example/api/auth"
    mcp_oauth_jwks_uri              = "https://staging.alphanet.example/api/auth/jwks"
    valkey_multi_az                 = false
    database_deletion_protection    = false
    database_skip_final_snapshot    = true
    database_cloudwatch_log_exports = []

    service_desired_count = {
      api    = 2
      mcp    = 1
      web    = 2
      worker = 0
    }

    image_overrides = {
      web     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      api     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      mcp     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-mcp@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      worker  = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-worker@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      migrate = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-migrate@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["web"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-web"
      name           = "alphanet-web"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-web"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["api"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-api"
      name           = "alphanet-api"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-api"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["mcp"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-mcp"
      name           = "alphanet-mcp"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-mcp"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["worker"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-worker"
      name           = "alphanet-worker"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-worker"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["migrate"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-migrate"
      name           = "alphanet-migrate"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-migrate"
    }
  }

  expect_failures = [
    aws_ecs_task_definition.service["api"],
  ]
}

run "reject_oauth_server_with_worker_autoscaling_to_zero" {
  command = plan

  variables {
    environment                     = "staging"
    app_version                     = "0123456789abcdef0123456789abcdef01234567"
    domain_name                     = "staging.alphanet.example"
    cloudfront_certificate_arn      = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000001"
    alb_origin_domain_name          = "origin-staging.alphanet.example"
    alb_origin_certificate_arn      = "arn:aws:acm:us-west-2:123456789012:certificate/00000000-0000-0000-0000-000000000000"
    auth_email_from                 = "AlphaNet <no-reply@alphanet.example>"
    github_oidc_provider_arn        = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    github_oidc_subjects            = ["repo:songzhiyuan98@123667992/AlphaNet@1306225890:ref:refs/heads/main"]
    enable_service_autoscaling      = true
    mcp_oauth_owner_consent_enabled = true
    mcp_oauth_server_enabled        = true
    mcp_oauth_issuer                = "https://staging.alphanet.example/api/auth"
    mcp_oauth_jwks_uri              = "https://staging.alphanet.example/api/auth/jwks"
    valkey_multi_az                 = false
    database_deletion_protection    = false
    database_skip_final_snapshot    = true
    database_cloudwatch_log_exports = []

    service_autoscaling = {
      worker = {
        min_capacity  = 0
        max_capacity  = 2
        cpu_target    = 60
        memory_target = 70
      }
    }

    image_overrides = {
      web     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      api     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      mcp     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-mcp@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      worker  = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-worker@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      migrate = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-migrate@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["web"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-web"
      name           = "alphanet-web"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-web"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["api"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-api"
      name           = "alphanet-api"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-api"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["mcp"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-mcp"
      name           = "alphanet-mcp"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-mcp"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["worker"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-worker"
      name           = "alphanet-worker"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-worker"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["migrate"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-migrate"
      name           = "alphanet-migrate"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-migrate"
    }
  }

  expect_failures = [
    aws_ecs_task_definition.service["api"],
  ]
}

run "reject_public_mcp_without_fixed_domain" {
  command = plan

  variables {
    environment                     = "staging"
    app_version                     = "0123456789abcdef0123456789abcdef01234567"
    alb_origin_domain_name          = "origin-staging.alphanet.example"
    alb_origin_certificate_arn      = "arn:aws:acm:us-west-2:123456789012:certificate/00000000-0000-0000-0000-000000000000"
    auth_email_from                 = "AlphaNet <no-reply@alphanet.example>"
    github_oidc_provider_arn        = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    github_oidc_subjects            = ["repo:songzhiyuan98@123667992/AlphaNet@1306225890:ref:refs/heads/main"]
    mcp_public_enabled              = true
    mcp_oauth_issuer                = "https://auth.alphanet.example/"
    mcp_oauth_jwks_uri              = "https://auth.alphanet.example/.well-known/jwks.json"
    valkey_multi_az                 = false
    database_deletion_protection    = false
    database_skip_final_snapshot    = true
    database_cloudwatch_log_exports = []

    image_overrides = {
      web     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      api     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      mcp     = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-mcp@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      worker  = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-worker@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      migrate = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-migrate@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["web"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-web"
      name           = "alphanet-web"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-web"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["api"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-api"
      name           = "alphanet-api"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-api"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["mcp"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-mcp"
      name           = "alphanet-mcp"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-mcp"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["worker"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-worker"
      name           = "alphanet-worker"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-worker"
    }
  }

  override_data {
    target = data.aws_ecr_repository.service["migrate"]
    values = {
      arn            = "arn:aws:ecr:us-west-2:123456789012:repository/alphanet-migrate"
      name           = "alphanet-migrate"
      repository_url = "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-migrate"
    }
  }

  assert {
    condition = (
      !contains(keys(aws_ecs_task_definition.database_job), "oauth-provision") &&
      !contains(keys(aws_cloudwatch_log_group.service), "oauth-provision") &&
      length(aws_secretsmanager_secret.oauth_client_provisioning) == 0 &&
      length(aws_iam_role.oauth_provision_execution) == 0 &&
      length(aws_iam_role.oauth_provision_task) == 0 &&
      length(aws_iam_role.oauth_provision_launcher) == 0 &&
      length(aws_sfn_state_machine.oauth_provision) == 0
    )
    error_message = "OAuth provisioning infrastructure must remain absent when its default-off gate is omitted."
  }

  assert {
    condition = (
      !local.mcp_runtime_enabled &&
      length(aws_cloudwatch_log_metric_filter.remote_mcp_oauth_lifecycle_backlog) == 0 &&
      length(aws_cloudwatch_log_metric_filter.remote_mcp_oauth_lifecycle_backlog_exceeded) == 0 &&
      length(aws_cloudwatch_log_metric_filter.remote_mcp_oauth_lifecycle_heartbeat) == 0 &&
      length(aws_cloudwatch_log_metric_filter.remote_mcp_oauth_lifecycle_failure) == 0 &&
      length(aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_backlog) == 0 &&
      length(aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_missing) == 0 &&
      length(aws_cloudwatch_metric_alarm.remote_mcp_oauth_lifecycle_failure) == 0 &&
      contains(
        [for item in local.mcp_environment : "${item.name}=${item.value}"],
        "MCP_RUNTIME_ENABLED=false",
      )
    )
    error_message = "mcp_public_enabled must never promote the runtime or provision its OAuth lifecycle observability."
  }

  expect_failures = [
    aws_lb_listener_rule.mcp,
  ]
}
