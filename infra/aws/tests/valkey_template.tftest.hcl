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
      local.mcp_internal_api_port == 4443
    )
    error_message = "Private runtime enablement must open the API mTLS listener and MCP runtime without enabling the public MCP route."
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
      )
    )
    error_message = "MCP must receive only its client-side trust material and no database credential; API must receive the server key; issuer and verifier must share only the independent token-JTI digest key."
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

  expect_failures = [
    aws_ecs_task_definition.service["mcp"],
    aws_lb_listener_rule.mcp,
  ]
}
