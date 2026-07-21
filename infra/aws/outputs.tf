locals {
  deployment_environment_prefix = upper(var.environment)
  deployment_github_variables = {
    AWS_ECR_PUBLISH_ENABLED                                                                 = "true"
    AWS_DEPLOY_ENABLED                                                                      = "false"
    AWS_REGION                                                                              = var.aws_region
    AWS_ECR_REGISTRY                                                                        = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.${data.aws_partition.current.dns_suffix}"
    AWS_ECR_REPOSITORY_PREFIX                                                               = var.ecr_repository_prefix
    AWS_CI_PUBLISH_ROLE_ARN                                                                 = var.github_publish_role_arn
    STAGING_AWS_DEPLOY_ROLE_ARN                                                             = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.project_name}-staging-github-deploy"
    PRODUCTION_AWS_DEPLOY_ROLE_ARN                                                          = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.project_name}-production-github-deploy"
    "${local.deployment_environment_prefix}_AWS_DEPLOY_ROLE_ARN"                            = aws_iam_role.github_deploy.arn
    "${local.deployment_environment_prefix}_ECS_CLUSTER"                                    = aws_ecs_cluster.main.name
    "${local.deployment_environment_prefix}_ECS_WEB_SERVICE"                                = aws_ecs_service.app["web"].name
    "${local.deployment_environment_prefix}_ECS_API_SERVICE"                                = aws_ecs_service.app["api"].name
    "${local.deployment_environment_prefix}_ECS_MCP_SERVICE"                                = aws_ecs_service.app["mcp"].name
    "${local.deployment_environment_prefix}_ECS_WORKER_SERVICE"                             = aws_ecs_service.app["worker"].name
    "${local.deployment_environment_prefix}_ECS_WEB_TASK_FAMILY"                            = aws_ecs_task_definition.service["web"].family
    "${local.deployment_environment_prefix}_ECS_API_TASK_FAMILY"                            = aws_ecs_task_definition.service["api"].family
    "${local.deployment_environment_prefix}_ECS_MCP_TASK_FAMILY"                            = aws_ecs_task_definition.service["mcp"].family
    "${local.deployment_environment_prefix}_ECS_WORKER_TASK_FAMILY"                         = aws_ecs_task_definition.service["worker"].family
    "${local.deployment_environment_prefix}_ECS_MIGRATE_TASK_FAMILY"                        = aws_ecs_task_definition.database_job["migrate"].family
    "${local.deployment_environment_prefix}_ECS_RUNTIME_SMOKE_TASK_FAMILY"                  = aws_ecs_task_definition.database_job["runtime-smoke"].family
    "${local.deployment_environment_prefix}_ECS_WEB_BASELINE_TASK_DEFINITION_ARN"           = aws_ecs_task_definition.service["web"].arn
    "${local.deployment_environment_prefix}_ECS_API_BASELINE_TASK_DEFINITION_ARN"           = aws_ecs_task_definition.service["api"].arn
    "${local.deployment_environment_prefix}_ECS_MCP_BASELINE_TASK_DEFINITION_ARN"           = aws_ecs_task_definition.service["mcp"].arn
    "${local.deployment_environment_prefix}_ECS_WORKER_BASELINE_TASK_DEFINITION_ARN"        = aws_ecs_task_definition.service["worker"].arn
    "${local.deployment_environment_prefix}_ECS_MIGRATE_BASELINE_TASK_DEFINITION_ARN"       = aws_ecs_task_definition.database_job["migrate"].arn
    "${local.deployment_environment_prefix}_ECS_RUNTIME_SMOKE_BASELINE_TASK_DEFINITION_ARN" = aws_ecs_task_definition.database_job["runtime-smoke"].arn
    "${local.deployment_environment_prefix}_ECS_SUBNET_IDS"                                 = join(",", [for subnet in aws_subnet.private : subnet.id])
    "${local.deployment_environment_prefix}_ECS_SECURITY_GROUP_IDS"                         = aws_security_group.migration.id
    "${local.deployment_environment_prefix}_PUBLIC_BASE_URL"                                = local.public_origin
    "${local.deployment_environment_prefix}_SMOKE_PATHS"                                    = "/health/ready,/v1/public/communities?limit=1,/v1/public/content?scope=global&sort=latest&limit=1"
  }
}

output "aws_region" {
  value = var.aws_region
}

output "public_origin" {
  value = local.public_origin
}

output "public_smoke_url" {
  value = "${local.public_origin}/health/ready"
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.main.id
}

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "ecr_registry" {
  value = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.${data.aws_partition.current.dns_suffix}"
}

output "ecr_repository_prefix" {
  value = var.ecr_repository_prefix
}

output "ecr_repository_urls" {
  value = { for service, repository in data.aws_ecr_repository.service : service => repository.repository_url }
}

output "github_publish_role_arn" {
  value = var.github_publish_role_arn
}

output "github_deploy_role_arn" {
  value = aws_iam_role.github_deploy.arn
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_cluster_arn" {
  value = aws_ecs_cluster.main.arn
}

output "ecs_service_names" {
  value = { for service, resource in aws_ecs_service.app : service => resource.name }
}

output "ecs_task_definition_families" {
  value = merge(
    { for service, definition in aws_ecs_task_definition.service : service => definition.family },
    { for job, definition in aws_ecs_task_definition.database_job : job => definition.family },
  )
}

output "ecs_terraform_baseline_task_definition_arns" {
  description = "Exact, ACTIVE Terraform-owned revisions that CD may verify and clone; never resolve these through family latest."
  value = merge(
    { for service, definition in aws_ecs_task_definition.service : service => definition.arn },
    { for job, definition in aws_ecs_task_definition.database_job : job => definition.arn },
  )
}

output "migrate_task_definition_arn" {
  value = aws_ecs_task_definition.database_job["migrate"].arn
}

output "bootstrap_task_definition_arn" {
  value = aws_ecs_task_definition.database_job["bootstrap"].arn
}

output "runtime_smoke_task_definition_arn" {
  value = aws_ecs_task_definition.database_job["runtime-smoke"].arn
}

output "private_subnet_ids" {
  value = [for subnet in aws_subnet.private : subnet.id]
}

output "migration_security_group_id" {
  value = aws_security_group.migration.id
}

output "database_cluster_endpoint" {
  value = aws_rds_cluster.main.endpoint
}

output "database_admin_secret_arn" {
  value     = aws_rds_cluster.main.master_user_secret[0].secret_arn
  sensitive = true
}

output "application_secret_arn" {
  value = aws_secretsmanager_secret.application.arn
}

output "valkey_primary_endpoint" {
  value = aws_cloudformation_stack.valkey.outputs["PrimaryEndpointAddress"]
}

output "valkey_auth_secret_arn" {
  value     = aws_cloudformation_stack.valkey.outputs["AuthSecretArn"]
  sensitive = true
}

output "data_kms_key_arn" {
  description = "Destroy-protected CMK required to restore Aurora and Valkey recovery assets."
  value       = aws_kms_key.data.arn
}

output "operations_sns_topic_arn" {
  value = aws_sns_topic.operations.arn
}

output "edge_operations_sns_topic_arn" {
  value = aws_sns_topic.edge_operations.arn
}

output "deployment_github_variables" {
  description = "Repository/environment variable values consumed by the AWS CD workflow."
  value       = local.deployment_github_variables
}
