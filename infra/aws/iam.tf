data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${local.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "task_execution" {
  statement {
    sid    = "PullExactReleaseImages"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [for repository in data.aws_ecr_repository.service : repository.arn]
  }

  statement {
    sid       = "GetEcrAuthorizationToken"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "WriteServiceLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [for log_group in aws_cloudwatch_log_group.service : "${log_group.arn}:*"]
  }

  statement {
    sid       = "ReadApplicationSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.application.arn]
  }
}

resource "aws_iam_role_policy" "task_execution" {
  name   = "ecs-runtime-bootstrap"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution.json
}

# The OAuth manifest job is never part of CD and has distinct roles. Its ECS
# agent can pull only the migration image and read only the migration password
# plus the dedicated manifest secret. The container task role has no policy and
# therefore cannot call AWS APIs itself.
resource "aws_iam_role" "oauth_provision_execution" {
  count = var.mcp_oauth_provisioning_enabled ? 1 : 0

  name               = "${local.name}-oauth-provision-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "oauth_provision_execution" {
  count = var.mcp_oauth_provisioning_enabled ? 1 : 0

  statement {
    sid    = "PullMigrationImage"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [data.aws_ecr_repository.service["migrate"].arn]
  }

  statement {
    sid       = "GetEcrAuthorizationToken"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "WriteOAuthProvisionLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.service["oauth-provision"].arn}:*"]
  }

  statement {
    sid     = "ReadOnlyProvisioningInputs"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.application.arn,
      aws_secretsmanager_secret.oauth_client_provisioning[0].arn,
    ]
  }
}

resource "aws_iam_role_policy" "oauth_provision_execution" {
  count = var.mcp_oauth_provisioning_enabled ? 1 : 0

  name   = "operator-oauth-provisioning"
  role   = aws_iam_role.oauth_provision_execution[0].id
  policy = data.aws_iam_policy_document.oauth_provision_execution[0].json
}

resource "aws_iam_role" "oauth_provision_task" {
  count = var.mcp_oauth_provisioning_enabled ? 1 : 0

  name               = "${local.name}-oauth-provision-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

# Bootstrap is deliberately outside the CD trust boundary. This execution role
# is the only ECS identity allowed to read Aurora's administrator secret.
resource "aws_iam_role" "bootstrap_execution" {
  name               = "${local.name}-bootstrap-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "bootstrap_execution" {
  statement {
    sid    = "PullMigrationImage"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [data.aws_ecr_repository.service["migrate"].arn]
  }

  statement {
    sid       = "GetEcrAuthorizationToken"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "WriteBootstrapLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.service["bootstrap"].arn}:*"]
  }

  statement {
    sid     = "ReadBootstrapCredentials"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.application.arn,
      aws_rds_cluster.main.master_user_secret[0].secret_arn,
    ]
  }
}

resource "aws_iam_role_policy" "bootstrap_execution" {
  name   = "operator-database-bootstrap"
  role   = aws_iam_role.bootstrap_execution.id
  policy = data.aws_iam_policy_document.bootstrap_execution.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role" "search_task" {
  name               = "${local.name}-search-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

# ECS Exec is operator-only and is audited through AWS control-plane logs.
data "aws_iam_policy_document" "task" {
  statement {
    sid    = "EcsExecChannels"
    effect = "Allow"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }

}

resource "aws_iam_role_policy" "task" {
  name   = "runtime"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

resource "aws_iam_role_policy" "search_task_exec" {
  name   = "ecs-exec"
  role   = aws_iam_role.search_task.id
  policy = data.aws_iam_policy_document.task.json
}

data "aws_iam_policy_document" "search_embedding" {
  statement {
    sid     = "InvokePinnedSearchEmbeddingModel"
    effect  = "Allow"
    actions = ["bedrock:InvokeModel"]
    resources = [
      "arn:${data.aws_partition.current.partition}:bedrock:${var.aws_region}::foundation-model/${var.search_embedding_model_id}",
    ]
  }
}

resource "aws_iam_role_policy" "search_embedding" {
  name   = "search-embedding"
  role   = aws_iam_role.search_task.id
  policy = data.aws_iam_policy_document.search_embedding.json
}

data "aws_iam_policy_document" "github_deploy_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.github_oidc_subjects
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name                 = "${local.name}-github-deploy"
  description          = "Digest-pinned AlphaNet ${var.environment} ECS deployment only"
  assume_role_policy   = data.aws_iam_policy_document.github_deploy_assume.json
  max_session_duration = 7200
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid    = "ReadDeploymentState"
    effect = "Allow"
    actions = [
      "ecs:DescribeClusters",
      "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition",
      "ecs:DescribeTasks",
      "ecs:ListTagsForResource",
      "ecs:ListTasks",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "RegisterReleaseTaskDefinitions"
    effect    = "Allow"
    actions   = ["ecs:RegisterTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid     = "TagOnlyReleaseTaskDefinitions"
    effect  = "Allow"
    actions = ["ecs:TagResource"]
    resources = [
      for family in ["web", "api", "mcp", "worker", "migrate", "runtime-smoke"] :
      "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-${family}:*"
    ]
  }

  statement {
    sid    = "VerifyReleaseImageDigests"
    effect = "Allow"
    actions = [
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
    ]
    resources = [for repository in data.aws_ecr_repository.service : repository.arn]
  }

  statement {
    sid    = "RollEnvironmentServices"
    effect = "Allow"
    actions = [
      "ecs:UpdateService",
    ]
    resources = [
      for service in local.long_running_services :
      "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${local.name}/${local.name}-${service}"
    ]
  }

  statement {
    sid     = "RunEnvironmentJobs"
    effect  = "Allow"
    actions = ["ecs:RunTask"]
    resources = [
      "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-migrate:*",
      "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-runtime-smoke:*",
    ]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    sid     = "StopTimedOutEnvironmentJobs"
    effect  = "Allow"
    actions = ["ecs:StopTask"]
    resources = [
      "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${local.name}/*",
    ]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    sid     = "PassOnlyAlphaNetTaskRoles"
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.search_task.arn,
      aws_iam_role.task.arn,
      aws_iam_role.task_execution.arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "ecs-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
