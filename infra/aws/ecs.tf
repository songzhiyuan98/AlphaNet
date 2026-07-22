locals {
  application_secret_arn = aws_secretsmanager_secret.application.arn

  common_service_environment = [
    { name = "APP_VERSION", value = var.app_version },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "LOG_LEVEL", value = var.log_level },
    { name = "NODE_ENV", value = "production" },
    { name = "TZ", value = "UTC" },
  ]

  api_environment = concat(local.common_service_environment, [
    { name = "HOST", value = "0.0.0.0" },
    { name = "PORT", value = "4000" },
    { name = "CORS_ORIGINS", value = local.public_origin },
    { name = "BETTER_AUTH_URL", value = local.public_origin },
    { name = "AUTH_TRUSTED_ORIGINS", value = local.public_origin },
    { name = "AUTH_SECURE_COOKIES", value = "true" },
    { name = "API_TRUSTED_PROXY_CIDRS", value = join(",", values(local.public_subnet_cidrs)) },
    { name = "AUTH_DATABASE_POOL_MAX", value = "10" },
    { name = "AUTH_EMAIL_DAILY_GLOBAL_LIMIT", value = "10000" },
    { name = "AUTH_EMAIL_MODE", value = "resend" },
    { name = "AUTH_EMAIL_FROM", value = var.auth_email_from },
    { name = "AUTH_EMAIL_REPLY_TO", value = var.auth_email_reply_to },
    { name = "AGENT_API_AUDIENCE", value = "urn:alphanet:api:v1" },
    { name = "AGENT_API_KEY_PEPPER_VERSION", value = "1" },
    { name = "AGENT_API_KEY_PREVIOUS_PEPPERS", value = "{}" },
    { name = "AGENT_CREDENTIAL_ACTIVE_PER_AGENT", value = "5" },
    { name = "AGENT_CREDENTIAL_ACTIVE_PER_OWNER", value = "20" },
    { name = "AGENT_CREDENTIAL_ISSUE_PER_OWNER_24H", value = "10" },
    { name = "AGENT_CREDENTIAL_MUTATION_COOLDOWN_SECONDS", value = "30" },
    { name = "AGENT_CREDENTIAL_DEFAULT_TTL_DAYS", value = "90" },
    { name = "AGENT_CREDENTIAL_MAX_TTL_DAYS", value = "365" },
    { name = "PENDING_ACTION_ENCRYPTION_KEY_VERSION", value = "1" },
    { name = "PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS", value = "{}" },
    { name = "SEARCH_EMBEDDING_PROVIDER", value = "bedrock" },
    { name = "SEARCH_EMBEDDING_MODEL_ID", value = var.search_embedding_model_id },
    { name = "SEARCH_EMBEDDING_DIMENSIONS", value = "512" },
    { name = "SEARCH_EMBEDDING_TIMEOUT_MS", value = "5000" },
    { name = "MCP_INTERNAL_API_ENABLED", value = tostring(local.mcp_runtime_enabled) },
    { name = "MCP_INTERNAL_API_PORT", value = tostring(local.mcp_internal_api_port) },
  ])

  web_environment = concat(local.common_service_environment, [
    { name = "PORT", value = "3000" },
    { name = "API_INTERNAL_URL", value = "http://api.${aws_service_discovery_private_dns_namespace.main.name}:4000" },
    { name = "SSR_ALLOW_MISSING_CLIENT_IP", value = "false" },
    { name = "GOOGLE_AUTH_ENABLED", value = tostring(var.google_oauth_enabled) },
    # The Web image is built with an empty public API URL so browser calls stay
    # on the CloudFront cookie origin. This runtime value documents that contract.
    { name = "NEXT_PUBLIC_API_URL", value = "" },
  ])

  mcp_environment = concat(local.common_service_environment, [
    { name = "HOST", value = "0.0.0.0" },
    { name = "PORT", value = "4100" },
    { name = "MCP_ALLOWED_HOSTS", value = local.mcp_allowed_hosts },
    { name = "MCP_RUNTIME_ENABLED", value = tostring(local.mcp_runtime_enabled) },
    { name = "MCP_PUBLIC_ENABLED", value = tostring(var.mcp_public_enabled) },
    { name = "MCP_RESOURCE", value = local.mcp_resource },
    { name = "MCP_TRUSTED_PROXY_CIDRS", value = join(",", values(local.public_subnet_cidrs)) },
    { name = "MCP_OAUTH_ISSUER", value = local.mcp_runtime_enabled ? var.mcp_oauth_issuer : "" },
    { name = "MCP_OAUTH_JWKS_URI", value = local.mcp_runtime_enabled ? var.mcp_oauth_jwks_uri : "" },
    { name = "MCP_INTERNAL_API_URL", value = local.mcp_runtime_enabled ? "https://${local.mcp_internal_api_dns_name}:${local.mcp_internal_api_port}" : "" },
    { name = "MCP_INTERNAL_API_TIMEOUT_MS", value = "5000" },
    { name = "MCP_INTERNAL_API_MAX_RESPONSE_BYTES", value = "4194304" },
  ])

  worker_environment = concat(local.common_service_environment, [
    { name = "OUTBOX_CONSUMER_NAME", value = var.outbox_consumer_name },
    { name = "OUTBOX_REPLAY_FROM", value = var.outbox_replay_from },
    { name = "WORKER_POLL_INTERVAL_MS", value = tostring(var.worker_poll_interval_ms) },
    { name = "WORKER_BATCH_SIZE", value = tostring(var.worker_batch_size) },
    { name = "RUN_ONCE", value = "false" },
    { name = "PENDING_ACTION_ENCRYPTION_KEY_VERSION", value = "1" },
    { name = "PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS", value = "{}" },
    { name = "SEARCH_EMBEDDING_PROVIDER", value = "bedrock" },
    { name = "SEARCH_EMBEDDING_MODEL_ID", value = var.search_embedding_model_id },
    { name = "SEARCH_EMBEDDING_DIMENSIONS", value = "512" },
    { name = "SEARCH_EMBEDDING_TIMEOUT_MS", value = "10000" },
    { name = "SEARCH_INDEX_BATCH_SIZE", value = "10" },
    { name = "SEARCH_INDEX_LEASE_SECONDS", value = "60" },
  ])

  task_environment = {
    api    = local.api_environment
    mcp    = local.mcp_environment
    web    = local.web_environment
    worker = local.worker_environment
  }

  api_secrets = concat(
    [
      { name = "DATABASE_URL", valueFrom = "${local.application_secret_arn}:DATABASE_URL::" },
      { name = "REDIS_URL", valueFrom = "${local.application_secret_arn}:REDIS_URL::" },
      { name = "BETTER_AUTH_SECRET", valueFrom = "${local.application_secret_arn}:BETTER_AUTH_SECRET::" },
      { name = "SSR_INTERNAL_REQUEST_SECRET", valueFrom = "${local.application_secret_arn}:SSR_INTERNAL_REQUEST_SECRET::" },
      { name = "AGENT_API_KEY_PEPPER", valueFrom = "${local.application_secret_arn}:AGENT_API_KEY_PEPPER::" },
      { name = "PENDING_ACTION_ENCRYPTION_KEY", valueFrom = "${local.application_secret_arn}:PENDING_ACTION_ENCRYPTION_KEY::" },
      { name = "COMMUNITY_CURSOR_SIGNING_KEY", valueFrom = "${local.application_secret_arn}:COMMUNITY_CURSOR_SIGNING_KEY::" },
      { name = "RESEND_API_KEY", valueFrom = "${local.application_secret_arn}:RESEND_API_KEY::" },
    ],
    local.mcp_runtime_enabled ? [
      { name = "MCP_INTERNAL_API_SERVER_CERT_PEM_BASE64", valueFrom = "${local.application_secret_arn}:MCP_INTERNAL_API_SERVER_CERT_PEM_BASE64::" },
      { name = "MCP_INTERNAL_API_SERVER_KEY_PEM_BASE64", valueFrom = "${local.application_secret_arn}:MCP_INTERNAL_API_SERVER_KEY_PEM_BASE64::" },
      { name = "MCP_INTERNAL_API_CLIENT_CA_PEM_BASE64", valueFrom = "${local.application_secret_arn}:MCP_INTERNAL_API_CLIENT_CA_PEM_BASE64::" },
      { name = "MCP_INTERNAL_API_ALLOWED_CLIENT_CERT_SHA256_FINGERPRINTS", valueFrom = "${local.application_secret_arn}:MCP_INTERNAL_API_ALLOWED_CLIENT_CERT_SHA256_FINGERPRINTS::" },
      { name = "MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION", valueFrom = "${local.application_secret_arn}:MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION::" },
      { name = "MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64", valueFrom = "${local.application_secret_arn}:MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64::" },
      { name = "MCP_ACTOR_ASSERTION_PREVIOUS_KEYS", valueFrom = "${local.application_secret_arn}:MCP_ACTOR_ASSERTION_PREVIOUS_KEYS::" },
      { name = "MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64", valueFrom = "${local.application_secret_arn}:MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64::" },
      { name = "MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64", valueFrom = "${local.application_secret_arn}:MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64::" },
    ] : [],
    var.google_oauth_enabled ? [
      { name = "AUTH_GOOGLE_CLIENT_ID", valueFrom = "${local.application_secret_arn}:AUTH_GOOGLE_CLIENT_ID::" },
      { name = "AUTH_GOOGLE_CLIENT_SECRET", valueFrom = "${local.application_secret_arn}:AUTH_GOOGLE_CLIENT_SECRET::" },
    ] : [],
  )

  task_secrets = {
    api = local.api_secrets
    mcp = concat(
      [
        { name = "REDIS_URL", valueFrom = "${local.application_secret_arn}:REDIS_URL::" },
      ],
      local.mcp_runtime_enabled ? [
        { name = "MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64", valueFrom = "${local.application_secret_arn}:MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64::" },
        { name = "MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64", valueFrom = "${local.application_secret_arn}:MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64::" },
        { name = "MCP_INTERNAL_API_SERVER_CA_PEM_BASE64", valueFrom = "${local.application_secret_arn}:MCP_INTERNAL_API_SERVER_CA_PEM_BASE64::" },
        { name = "MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION", valueFrom = "${local.application_secret_arn}:MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION::" },
        { name = "MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64", valueFrom = "${local.application_secret_arn}:MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64::" },
        { name = "MCP_ACTOR_ASSERTION_PREVIOUS_KEYS", valueFrom = "${local.application_secret_arn}:MCP_ACTOR_ASSERTION_PREVIOUS_KEYS::" },
        { name = "MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64", valueFrom = "${local.application_secret_arn}:MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64::" },
      ] : [],
    )
    web = [
      { name = "SSR_INTERNAL_REQUEST_SECRET", valueFrom = "${local.application_secret_arn}:SSR_INTERNAL_REQUEST_SECRET::" },
    ]
    worker = [
      { name = "DATABASE_URL", valueFrom = "${local.application_secret_arn}:DATABASE_URL::" },
      { name = "PENDING_ACTION_ENCRYPTION_KEY", valueFrom = "${local.application_secret_arn}:PENDING_ACTION_ENCRYPTION_KEY::" },
    ]
  }

  database_job_environment = {
    bootstrap = [
      { name = "PGHOST", value = aws_rds_cluster.main.endpoint },
      { name = "PGPORT", value = "5432" },
      { name = "PGDATABASE", value = aws_rds_cluster.main.database_name },
      { name = "PGSSLMODE", value = "verify-full" },
      { name = "PGSSLROOTCERT", value = "/opt/alphanet/certs/aws-rds-us-west-2-bundle.pem" },
      { name = "ALPHANET_MIGRATION_ROLE", value = "alphanet_migration" },
      { name = "ALPHANET_RUNTIME_ROLE", value = "alphanet_runtime" },
    ]
    migrate = [
      { name = "PGHOST", value = aws_rds_cluster.main.endpoint },
      { name = "PGPORT", value = "5432" },
      { name = "PGDATABASE", value = aws_rds_cluster.main.database_name },
      { name = "PGUSER", value = "alphanet_migration" },
      { name = "PGSSLMODE", value = "verify-full" },
      { name = "PGSSLROOTCERT", value = "/opt/alphanet/certs/aws-rds-us-west-2-bundle.pem" },
      { name = "ALPHANET_MIGRATION_ROLE", value = "alphanet_migration" },
      { name = "ALPHANET_RUNTIME_ROLE", value = "alphanet_runtime" },
    ]
    runtime-smoke = [
      { name = "PGHOST", value = aws_rds_cluster.main.endpoint },
      { name = "PGPORT", value = "5432" },
      { name = "PGDATABASE", value = aws_rds_cluster.main.database_name },
      { name = "PGUSER", value = "alphanet_runtime" },
      { name = "PGSSLMODE", value = "verify-full" },
      { name = "PGSSLROOTCERT", value = "/opt/alphanet/certs/aws-rds-us-west-2-bundle.pem" },
      { name = "ALPHANET_RUNTIME_ROLE", value = "alphanet_runtime" },
    ]
  }

  database_job_secrets = {
    bootstrap = [
      { name = "PGUSER", valueFrom = "${aws_rds_cluster.main.master_user_secret[0].secret_arn}:username::" },
      { name = "PGPASSWORD", valueFrom = "${aws_rds_cluster.main.master_user_secret[0].secret_arn}:password::" },
      { name = "ALPHANET_MIGRATION_PASSWORD", valueFrom = "${local.application_secret_arn}:ALPHANET_MIGRATION_PASSWORD::" },
      { name = "ALPHANET_RUNTIME_PASSWORD", valueFrom = "${local.application_secret_arn}:ALPHANET_RUNTIME_PASSWORD::" },
    ]
    migrate = [
      { name = "PGPASSWORD", valueFrom = "${local.application_secret_arn}:ALPHANET_MIGRATION_PASSWORD::" },
    ]
    runtime-smoke = [
      { name = "PGPASSWORD", valueFrom = "${local.application_secret_arn}:ALPHANET_RUNTIME_PASSWORD::" },
    ]
  }

  database_job_entrypoint = {
    bootstrap     = ["/bin/bash", "/opt/alphanet/db/scripts/aws-bootstrap-database.sh"]
    migrate       = ["/bin/bash", "/opt/alphanet/db/scripts/aws-migrate-release.sh"]
    runtime-smoke = ["/bin/bash", "/opt/alphanet/db/scripts/aws-smoke-runtime.sh"]
  }
}

resource "aws_cloudwatch_log_group" "service" {
  for_each = toset(concat(tolist(local.services), ["bootstrap", "runtime-smoke"]))

  name              = "/aws/ecs/${local.name}/${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = var.enable_enhanced_container_insights ? "enhanced" : "enabled"
  }

  configuration {
    execute_command_configuration {
      logging = "DEFAULT"
    }
  }

  tags = {
    Name = local.name
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = "${local.name}.internal"
  description = "AlphaNet private ECS service discovery"
  vpc         = aws_vpc.main.id
}

resource "aws_service_discovery_service" "app" {
  for_each = local.load_balanced_services

  name = each.key

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {}
}

resource "aws_ecs_task_definition" "service" {
  for_each = local.long_running_services

  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.task_cpu[each.key])
  memory                   = tostring(var.task_memory[each.key])
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = contains(["api", "worker"], each.key) ? aws_iam_role.search_task.arn : aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = var.cpu_architecture
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    merge(
      {
        name        = each.key
        image       = local.container_images[each.key]
        essential   = true
        environment = local.task_environment[each.key]
        secrets     = local.task_secrets[each.key]
        portMappings = concat(
          contains(keys(local.load_balanced_services), each.key) ? [{
            name          = each.key
            containerPort = local.load_balanced_services[each.key].container_port
            hostPort      = local.load_balanced_services[each.key].container_port
            protocol      = "tcp"
          }] : [],
          each.key == "api" && local.mcp_runtime_enabled ? [{
            name          = "mcp-internal"
            containerPort = local.mcp_internal_api_port
            hostPort      = local.mcp_internal_api_port
            protocol      = "tcp"
          }] : [],
        )
        linuxParameters = {
          initProcessEnabled = true
        }
        logConfiguration = {
          logDriver = "awslogs"
          options = {
            awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
            awslogs-region        = var.aws_region
            awslogs-stream-prefix = each.key
          }
        }
        readonlyRootFilesystem = false
        stopTimeout            = 30
      },
      contains(keys(local.load_balanced_services), each.key) ? {
        healthCheck = {
          command = [
            "CMD-SHELL",
            "wget -q -O /dev/null http://127.0.0.1:${local.load_balanced_services[each.key].container_port}${local.load_balanced_services[each.key].health_path} || exit 1",
          ]
          interval    = 30
          retries     = 3
          startPeriod = 20
          timeout     = 5
        }
      } : {},
    )
  ])

  tags = {
    Service                        = each.key
    "alphanet:deployment-baseline" = "true"
    "alphanet:managed-by"          = "terraform"
  }

  lifecycle {
    precondition {
      condition     = startswith(var.image_overrides[each.key], "${data.aws_ecr_repository.service[each.key].repository_url}@sha256:")
      error_message = "${each.key} image_overrides must reference its exact shared AlphaNet ECR repository by digest."
    }

    precondition {
      condition = (
        each.key != "mcp" ||
        !local.mcp_runtime_enabled ||
        (var.domain_name != "" && var.mcp_oauth_issuer != "" && var.mcp_oauth_jwks_uri != "")
      )
      error_message = "An enabled MCP runtime requires a fixed custom domain_name plus mcp_oauth_issuer and mcp_oauth_jwks_uri."
    }
  }

  depends_on = [
    aws_iam_role_policy.search_embedding,
    aws_iam_role_policy.search_task_exec,
    aws_iam_role_policy.task_execution,
  ]
}

resource "aws_ecs_task_definition" "database_job" {
  for_each = toset(["bootstrap", "migrate", "runtime-smoke"])

  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.task_cpu["migrate"])
  memory                   = tostring(var.task_memory["migrate"])
  execution_role_arn       = each.key == "bootstrap" ? aws_iam_role.bootstrap_execution.arn : aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = var.cpu_architecture
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name        = each.key
    image       = local.container_images["migrate"]
    essential   = true
    entryPoint  = local.database_job_entrypoint[each.key]
    command     = []
    environment = local.database_job_environment[each.key]
    secrets     = local.database_job_secrets[each.key]
    linuxParameters = {
      initProcessEnabled = true
      tmpfs = [{
        containerPath = "/tmp"
        mountOptions = [
          "nodev",
          "noexec",
          "nosuid",
          "rw",
        ]
        size = 64
      }]
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = each.key
      }
    }
    readonlyRootFilesystem = true
    stopTimeout            = 30
  }])

  tags = {
    Service                        = each.key
    "alphanet:deployment-baseline" = "true"
    "alphanet:managed-by"          = "terraform"
  }

  lifecycle {
    precondition {
      condition     = startswith(var.image_overrides["migrate"], "${data.aws_ecr_repository.service["migrate"].repository_url}@sha256:")
      error_message = "Database job image_overrides must reference the exact shared AlphaNet migrate ECR repository by digest."
    }
  }

  depends_on = [
    aws_iam_role_policy.bootstrap_execution,
    aws_iam_role_policy.task_execution,
  ]
}

resource "aws_ecs_service" "app" {
  for_each = local.long_running_services

  name            = "${local.name}-${each.key}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  desired_count   = var.service_desired_count[each.key]

  enable_execute_command             = true
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"
  health_check_grace_period_seconds  = contains(local.alb_attached_services, each.key) ? 60 : null
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  capacity_provider_strategy {
    capacity_provider = var.service_capacity_provider[each.key]
    base              = 1
    weight            = 1
  }

  network_configuration {
    assign_public_ip = false
    subnets          = [for subnet in aws_subnet.private : subnet.id]
    security_groups  = [aws_security_group.service[each.key].id]
  }

  dynamic "load_balancer" {
    for_each = contains(local.alb_attached_services, each.key) ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.service[each.key].arn
      container_name   = each.key
      container_port   = local.load_balanced_services[each.key].container_port
    }
  }

  dynamic "service_registries" {
    for_each = contains(keys(local.load_balanced_services), each.key) ? [1] : []
    content {
      registry_arn = aws_service_discovery_service.app[each.key].arn
    }
  }

  lifecycle {
    # CD registers a new digest-pinned revision and moves the service. Terraform
    # owns the family/platform configuration without rolling code backward or
    # resetting an autoscaler-adjusted desired count.
    ignore_changes = [desired_count, task_definition]
  }

  depends_on = [
    aws_ecs_cluster_capacity_providers.main,
    aws_lb_listener.origin,
    aws_lb_listener_rule.api,
    aws_lb_listener_rule.mcp,
    aws_lb_listener_rule.web,
  ]

  tags = {
    Service = each.key
  }
}

resource "aws_appautoscaling_target" "service" {
  for_each = local.long_running_services

  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.app[each.key].name}"
  min_capacity = var.enable_service_autoscaling && contains(keys(var.service_autoscaling), each.key) ? (
    var.service_autoscaling[each.key].min_capacity
  ) : var.service_desired_count[each.key]
  max_capacity = var.enable_service_autoscaling && contains(keys(var.service_autoscaling), each.key) ? (
    var.service_autoscaling[each.key].max_capacity
  ) : var.service_desired_count[each.key]
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each = var.enable_service_autoscaling ? var.service_autoscaling : {}

  name               = "${local.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.service[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.service[each.key].scalable_dimension
  resource_id        = aws_appautoscaling_target.service[each.key].resource_id

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = var.service_autoscaling[each.key].cpu_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_policy" "memory" {
  for_each = var.enable_service_autoscaling ? var.service_autoscaling : {}

  name               = "${local.name}-${each.key}-memory"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.service[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.service[each.key].scalable_dimension
  resource_id        = aws_appautoscaling_target.service[each.key].resource_id

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
    target_value       = var.service_autoscaling[each.key].memory_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}
