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

variables {
  environment                = "staging"
  app_version                = "0123456789abcdef0123456789abcdef01234567"
  domain_name                = "staging.alphanet.example"
  cloudfront_certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000001"
  alb_origin_domain_name     = "origin-staging.alphanet.example"
  alb_origin_certificate_arn = "arn:aws:acm:us-west-2:123456789012:certificate/00000000-0000-0000-0000-000000000000"
  auth_email_from            = "AlphaNet <no-reply@alphanet.example>"
  github_oidc_provider_arn   = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  github_oidc_subjects       = ["repo:songzhiyuan98@123667992/AlphaNet@1306225890:ref:refs/heads/main"]

  admin_web_enabled               = true
  admin_oidc_issuer               = "https://workforce.alphanet.example/oidc"
  admin_oidc_audience             = "https://staging.alphanet.example/v1/admin"
  admin_oidc_jwks_uri             = "https://workforce.alphanet.example/oidc/jwks.json"
  admin_web_oidc_client_id        = "alphanet-admin-web"
  admin_web_oidc_scopes           = ["openid", "profile", "email"]
  admin_web_oidc_resource         = "https://staging.alphanet.example/v1/admin"
  admin_web_session_store         = "dynamodb"
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
  target          = aws_secretsmanager_secret.application
  override_during = plan
  values = {
    arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:alphanet-staging-application"
  }
}

override_resource {
  target          = aws_dynamodb_table.admin_web_session[0]
  override_during = plan
  values = {
    arn  = "arn:aws:dynamodb:us-west-2:123456789012:table/alphanet-staging-admin-web-sessions"
    name = "alphanet-staging-admin-web-sessions"
  }
}

override_resource {
  target          = aws_iam_role.web_admin_task[0]
  override_during = plan
  values = {
    arn = "arn:aws:iam::123456789012:role/alphanet-staging-web-admin-task"
    id  = "alphanet-staging-web-admin-task"
  }
}

override_resource {
  target          = aws_iam_role.task
  override_during = plan
  values = {
    arn = "arn:aws:iam::123456789012:role/alphanet-staging-task"
    id  = "alphanet-staging-task"
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

run "admin_web_disabled_is_inert" {
  command = plan

  variables {
    admin_web_enabled = false
  }

  assert {
    condition = (
      length(aws_dynamodb_table.admin_web_session) == 0 &&
      length(aws_iam_role.web_admin_task) == 0 &&
      length(aws_iam_role_policy.web_admin_task) == 0 &&
      length(local.github_deploy_pass_role_arns) == 3 &&
      aws_ecs_task_definition.service["web"].task_role_arn == aws_iam_role.task.arn
    )
    error_message = "The default-off Admin Web must create no session table or dedicated role and must leave the Web task on its ordinary role."
  }

  assert {
    condition = (
      contains([for item in local.web_environment : "${item.name}=${item.value}"], "ADMIN_WEB_ENABLED=false") &&
      contains([for item in local.api_environment : "${item.name}=${item.value}"], "ADMIN_API_ENABLED=false") &&
      alltrue([
        for item in local.web_environment :
        item.name == "ADMIN_WEB_ENABLED" || !startswith(item.name, "ADMIN_WEB_")
      ]) &&
      alltrue([
        for item in local.api_environment : !startswith(item.name, "ADMIN_OIDC_")
      ]) &&
      !contains([for item in local.task_secrets.web : item.name], "ADMIN_WEB_OIDC_CLIENT_SECRET") &&
      !contains([for item in local.task_secrets.web : item.name], "ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64") &&
      !contains([for item in local.task_secrets.api : item.name], "ADMIN_AUDIT_SUBJECT_DIGEST_KEY")
    )
    error_message = "Disabled Admin Web must not leak its OIDC, session, or audit tuple into ECS."
  }
}

run "admin_web_enabled_valid" {
  command = plan

  assert {
    condition = (
      length(aws_dynamodb_table.admin_web_session) == 1 &&
      aws_dynamodb_table.admin_web_session[0].billing_mode == "PAY_PER_REQUEST" &&
      aws_dynamodb_table.admin_web_session[0].hash_key == "pk" &&
      aws_dynamodb_table.admin_web_session[0].ttl[0].enabled &&
      aws_dynamodb_table.admin_web_session[0].ttl[0].attribute_name == "expires_at" &&
      aws_dynamodb_table.admin_web_session[0].server_side_encryption[0].enabled &&
      aws_dynamodb_table.admin_web_session[0].server_side_encryption[0].kms_key_arn == aws_kms_key.data.arn &&
      !aws_dynamodb_table.admin_web_session[0].deletion_protection_enabled &&
      !aws_dynamodb_table.admin_web_session[0].point_in_time_recovery[0].enabled
    )
    error_message = "Enabled staging Admin Web must create one encrypted, TTL-backed, on-demand session table without pretending it is production-protected."
  }

  assert {
    condition = (
      contains([for item in local.web_environment : "${item.name}=${item.value}"], "ADMIN_WEB_ENABLED=true") &&
      contains([for item in local.web_environment : "${item.name}=${item.value}"], "ADMIN_WEB_PUBLIC_ORIGIN=https://staging.alphanet.example") &&
      contains([for item in local.web_environment : "${item.name}=${item.value}"], "ADMIN_WEB_OIDC_ISSUER=https://workforce.alphanet.example/oidc") &&
      contains([for item in local.web_environment : "${item.name}=${item.value}"], "ADMIN_WEB_OIDC_CLIENT_ID=alphanet-admin-web") &&
      contains([for item in local.web_environment : "${item.name}=${item.value}"], "ADMIN_WEB_OIDC_SCOPES=openid profile email") &&
      contains([for item in local.web_environment : "${item.name}=${item.value}"], "ADMIN_WEB_OIDC_RESOURCE=https://staging.alphanet.example/v1/admin") &&
      contains([for item in local.web_environment : "${item.name}=${item.value}"], "ADMIN_WEB_SESSION_STORE=dynamodb") &&
      contains([for item in local.web_environment : "${item.name}=${item.value}"], "ADMIN_WEB_SESSION_TABLE=alphanet-staging-admin-web-sessions") &&
      contains([for item in local.web_environment : "${item.name}=${item.value}"], "ADMIN_WEB_SESSION_TTL_SECONDS=28800") &&
      contains([for item in local.web_environment : "${item.name}=${item.value}"], "ADMIN_WEB_LOGIN_TTL_SECONDS=600") &&
      !contains([for item in local.web_environment : item.name], "ADMIN_WEB_DYNAMODB_ENDPOINT") &&
      !contains([for item in local.web_environment : item.name], "ADMIN_WEB_OIDC_CLIENT_SECRET") &&
      !contains([for item in local.web_environment : item.name], "ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64")
    )
    error_message = "Enabled Admin Web must receive the exact non-secret workforce browser/session tuple."
  }

  assert {
    condition = (
      contains([for item in local.api_environment : "${item.name}=${item.value}"], "ADMIN_API_ENABLED=true") &&
      contains([for item in local.api_environment : "${item.name}=${item.value}"], "ADMIN_OIDC_ISSUER=https://workforce.alphanet.example/oidc") &&
      contains([for item in local.api_environment : "${item.name}=${item.value}"], "ADMIN_OIDC_AUDIENCE=https://staging.alphanet.example/v1/admin") &&
      contains([for item in local.api_environment : "${item.name}=${item.value}"], "ADMIN_OIDC_JWKS_URI=https://workforce.alphanet.example/oidc/jwks.json") &&
      contains([for item in local.api_environment : "${item.name}=${item.value}"], "ADMIN_OIDC_ALLOWED_ALGORITHMS=RS256") &&
      contains([for item in local.api_environment : "${item.name}=${item.value}"], "ADMIN_OIDC_ALLOW_AMR_MFA=true") &&
      contains(
        [for item in local.task_secrets.api : "${item.name}=${item.valueFrom}"],
        "ADMIN_AUDIT_SUBJECT_DIGEST_KEY=arn:aws:secretsmanager:us-west-2:123456789012:secret:alphanet-staging-application:ADMIN_AUDIT_SUBJECT_DIGEST_KEY::",
      ) &&
      contains(
        [for item in local.task_secrets.web : "${item.name}=${item.valueFrom}"],
        "ADMIN_WEB_OIDC_CLIENT_SECRET=arn:aws:secretsmanager:us-west-2:123456789012:secret:alphanet-staging-application:ADMIN_WEB_OIDC_CLIENT_SECRET::",
      ) &&
      contains(
        [for item in local.task_secrets.web : "${item.name}=${item.valueFrom}"],
        "ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64=arn:aws:secretsmanager:us-west-2:123456789012:secret:alphanet-staging-application:ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64::",
      ) &&
      toset([for item in local.task_secrets.web : item.name]) == toset([
        "SSR_INTERNAL_REQUEST_SECRET",
        "ADMIN_WEB_OIDC_CLIENT_SECRET",
        "ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64",
      ])
    )
    error_message = "Admin API and Web must share issuer/audience intent while receiving only their own secret fields."
  }

  assert {
    condition = (
      aws_ecs_task_definition.service["web"].task_role_arn == aws_iam_role.web_admin_task[0].arn &&
      jsondecode(aws_iam_role_policy.web_admin_task[0].policy) == local.web_admin_task_policy &&
      length(local.web_admin_task_policy.Statement) == 2 &&
      toset(local.web_admin_task_policy.Statement[0].Action) == toset([
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel",
      ]) &&
      local.web_admin_task_policy.Statement[0].Resource == ["*"] &&
      toset(local.web_admin_task_policy.Statement[1].Action) == toset([
        "dynamodb:DeleteItem",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
      ]) &&
      local.web_admin_task_policy.Statement[1].Resource == [aws_dynamodb_table.admin_web_session[0].arn] &&
      length(local.github_deploy_pass_role_arns) == 4 &&
      contains(local.github_deploy_pass_role_arns, aws_iam_role.web_admin_task[0].arn)
    )
    error_message = "The dedicated Web role must contain only ECS Exec plus Get/Put/DeleteItem on its exact session table, and CD may pass that role only when enabled."
  }
}

run "admin_web_production_protects_sessions" {
  command = plan

  variables {
    environment                     = "production"
    operations_alert_emails         = ["ops@alphanet.example"]
    valkey_multi_az                 = true
    database_deletion_protection    = true
    database_skip_final_snapshot    = false
    database_backup_retention_days  = 14
    database_cloudwatch_log_exports = ["postgresql"]
  }

  assert {
    condition = (
      aws_dynamodb_table.admin_web_session[0].deletion_protection_enabled &&
      aws_dynamodb_table.admin_web_session[0].point_in_time_recovery[0].enabled
    )
    error_message = "Production Admin Web sessions must have DynamoDB deletion protection and point-in-time recovery."
  }
}

run "reject_admin_web_without_waf" {
  command = plan

  variables {
    enable_waf = false
  }

  expect_failures = [
    aws_ecs_task_definition.service["web"],
  ]
}

run "reject_admin_web_without_fixed_domain" {
  command = plan

  variables {
    domain_name                = ""
    cloudfront_certificate_arn = ""
  }

  expect_failures = [
    aws_ecs_task_definition.service["web"],
  ]
}

run "reject_admin_web_incomplete_tuple" {
  command = plan

  variables {
    admin_web_oidc_client_id = ""
  }

  expect_failures = [
    aws_ecs_task_definition.service["web"],
  ]
}

run "reject_admin_web_memory_sessions" {
  command = plan

  variables {
    admin_web_session_store = "memory"
  }

  expect_failures = [
    aws_ecs_task_definition.service["web"],
  ]
}

run "reject_admin_web_insecure_oidc" {
  command = plan

  variables {
    admin_oidc_issuer   = "http://workforce.alphanet.example/oidc"
    admin_oidc_jwks_uri = "http://workforce.alphanet.example/oidc/jwks.json"
  }

  expect_failures = [
    aws_ecs_task_definition.service["web"],
  ]
}

run "reject_admin_web_without_mfa" {
  command = plan

  variables {
    admin_oidc_allow_amr_mfa      = false
    admin_oidc_allowed_acr_values = []
  }

  expect_failures = [
    aws_ecs_task_definition.service["web"],
  ]
}

run "reject_admin_web_resource_audience_mismatch" {
  command = plan

  variables {
    admin_web_oidc_resource = "https://staging.alphanet.example/v1/wrong-resource"
  }

  expect_failures = [
    aws_ecs_task_definition.service["web"],
  ]
}
