resource "aws_dynamodb_table" "admin_web_session" {
  count = var.admin_web_enabled ? 1 : 0

  name         = "${local.name}-admin-web-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.data.arn
  }

  deletion_protection_enabled = var.environment == "production"

  point_in_time_recovery {
    enabled = var.environment == "production"
  }

  tags = {
    Purpose = "workforce-admin-web-sessions"
  }
}

resource "aws_iam_role" "web_admin_task" {
  count = var.admin_web_enabled ? 1 : 0

  name               = "${local.name}-web-admin-task"
  description        = "Admin Web session access and ECS Exec only"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

locals {
  web_admin_task_policy = var.admin_web_enabled ? {
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EcsExecChannels"
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ]
        Resource = ["*"]
      },
      {
        Sid    = "ManageAdminWebSessions"
        Effect = "Allow"
        Action = [
          "dynamodb:DeleteItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
        ]
        Resource = [aws_dynamodb_table.admin_web_session[0].arn]
      },
    ]
  } : null
}

resource "aws_iam_role_policy" "web_admin_task" {
  count = var.admin_web_enabled ? 1 : 0

  name   = "admin-web-session-runtime"
  role   = aws_iam_role.web_admin_task[0].id
  policy = jsonencode(local.web_admin_task_policy)
}
