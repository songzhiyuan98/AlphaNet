provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge(var.tags, {
      ManagedBy = "terraform"
      Project   = var.project_name
      Scope     = "shared-release-assets"
    })
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  services = toset(["web", "api", "mcp", "worker", "migrate"])
  repository_names = {
    for service in local.services : service => "${var.ecr_repository_prefix}-${service}"
  }
  github_oidc_provider_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.existing_github_oidc_provider_arn
}

resource "aws_ecr_repository" "service" {
  for_each = local.services

  name                 = local.repository_names[each.key]
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Service = each.key
  }
}

resource "aws_ecr_lifecycle_policy" "service" {
  for_each = local.services

  repository = aws_ecr_repository.service[each.key].name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Remove untagged image artifacts after fourteen days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }
        action = { type = "expire" }
      },
    ]
  })
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = var.github_oidc_thumbprints

  tags = {
    Name = "github-actions"
  }
}

data "aws_iam_policy_document" "publish_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = var.github_oidc_subjects
    }
  }
}

resource "aws_iam_role" "github_publish" {
  name                 = "${var.project_name}-github-publish"
  description          = "Push immutable AlphaNet release images to shared ECR only"
  assume_role_policy   = data.aws_iam_policy_document.publish_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_publish" {
  statement {
    sid       = "EcrAuthorization"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PublishReleaseImages"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [for repository in aws_ecr_repository.service : repository.arn]
  }
}

resource "aws_iam_role_policy" "github_publish" {
  name   = "ecr-publish"
  role   = aws_iam_role.github_publish.id
  policy = data.aws_iam_policy_document.github_publish.json
}

# One unfiltered budget belongs in the account-wide shared root. Creating one
# per environment without a cost filter would duplicate the same account total
# and falsely imply environment attribution.
data "aws_iam_policy_document" "account_cost_key" {
  statement {
    sid    = "AccountAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "BudgetNotificationEncryption"
    effect = "Allow"

    principals {
      type = "Service"
      identifiers = [
        "budgets.amazonaws.com",
        "sns.amazonaws.com",
      ]
    }

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_kms_key" "account_cost" {
  description             = "AlphaNet account cost notifications"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.account_cost_key.json
}

resource "aws_kms_alias" "account_cost" {
  name          = "alias/${var.project_name}-account-cost"
  target_key_id = aws_kms_key.account_cost.key_id
}

resource "aws_sns_topic" "account_cost" {
  name              = "${var.project_name}-account-cost"
  kms_master_key_id = aws_kms_key.account_cost.arn
}

data "aws_iam_policy_document" "account_cost_topic" {
  statement {
    sid    = "AccountOwnerAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["sns:*"]
    resources = [aws_sns_topic.account_cost.arn]
  }

  statement {
    sid    = "BudgetsPublish"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }

    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.account_cost.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "account_cost" {
  arn    = aws_sns_topic.account_cost.arn
  policy = data.aws_iam_policy_document.account_cost_topic.json
}

resource "aws_sns_topic_subscription" "account_cost_email" {
  for_each = var.cost_alert_emails

  topic_arn = aws_sns_topic.account_cost.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_budgets_budget" "account_monthly" {
  name         = "${var.project_name}-account-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.account_monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = toset([50, 80, 100])

    content {
      comparison_operator       = "GREATER_THAN"
      threshold                 = notification.value
      threshold_type            = "PERCENTAGE"
      notification_type         = "ACTUAL"
      subscriber_sns_topic_arns = [aws_sns_topic.account_cost.arn]
    }
  }

  depends_on = [aws_sns_topic_policy.account_cost]
}
