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

run "single_node_valkey_template" {
  command = plan

  variables {
    environment                     = "staging"
    app_version                     = "0123456789abcdef0123456789abcdef01234567"
    alb_origin_domain_name          = "origin-staging.alphanet.example"
    alb_origin_certificate_arn      = "arn:aws:acm:us-west-2:123456789012:certificate/00000000-0000-0000-0000-000000000000"
    auth_email_from                 = "AlphaNet <no-reply@alphanet.example>"
    github_oidc_provider_arn        = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    github_oidc_subjects            = ["repo:songzhiyuan98@123667992/AlphaNet@1306225890:ref:refs/heads/main"]
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
      !contains(keys(aws_cloudwatch_metric_alarm.alb_unhealthy_targets), "mcp")
    )
    error_message = "Private-by-default MCP must remain off the ALB and its target-health alarms until mcp_public_enabled is explicitly true."
  }
}
