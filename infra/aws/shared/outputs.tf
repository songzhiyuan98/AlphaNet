output "aws_region" {
  value = var.aws_region
}

output "ecr_registry" {
  value = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.${data.aws_partition.current.dns_suffix}"
}

output "ecr_repository_prefix" {
  value = var.ecr_repository_prefix
}

output "ecr_repository_urls" {
  value = { for service, repository in aws_ecr_repository.service : service => repository.repository_url }
}

output "github_oidc_provider_arn" {
  value = local.github_oidc_provider_arn
}

output "github_publish_role_arn" {
  value = aws_iam_role.github_publish.arn
}

output "account_cost_sns_topic_arn" {
  value = aws_sns_topic.account_cost.arn
}
