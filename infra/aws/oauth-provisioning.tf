data "aws_iam_policy_document" "step_functions_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values = [
        "arn:${data.aws_partition.current.partition}:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-oauth-provision",
      ]
    }
  }
}

# Operators can start this state machine without receiving ecs:RunTask,
# ecs:RegisterTaskDefinition, or iam:PassRole. The trusted definition launches
# one exact Terraform-owned task revision with no command or secret overrides;
# the only caller value is a non-secret digest that the container validates
# against the uniquely approved Secrets Manager stage.
resource "aws_iam_role" "oauth_provision_launcher" {
  count = var.mcp_oauth_provisioning_enabled ? 1 : 0

  name               = "${local.name}-oauth-provision-launcher"
  assume_role_policy = data.aws_iam_policy_document.step_functions_assume.json
}

locals {
  # Keep the security-critical launcher policy and workflow as inspectable
  # values. Terraform tests assert their exact trust boundary instead of only
  # asserting that the resources happen to exist.
  oauth_provision_launcher_policy = var.mcp_oauth_provisioning_enabled ? {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RunExactOAuthProvisioningRevision"
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = [aws_ecs_task_definition.database_job["oauth-provision"].arn]
        Condition = {
          ArnEquals = {
            "ecs:cluster" = aws_ecs_cluster.main.arn
          }
        }
      },
      {
        Sid      = "ObserveOAuthProvisioningTask"
        Effect   = "Allow"
        Action   = ["ecs:DescribeTasks", "ecs:StopTask"]
        Resource = ["*"]
        Condition = {
          ArnEquals = {
            "ecs:cluster" = aws_ecs_cluster.main.arn
          }
        }
      },
      {
        Sid    = "PassOnlyOAuthProvisioningRoles"
        Effect = "Allow"
        Action = ["iam:PassRole"]
        Resource = [
          aws_iam_role.oauth_provision_execution[0].arn,
          aws_iam_role.oauth_provision_task[0].arn,
        ]
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      },
      {
        Sid    = "TrackSynchronousEcsTask"
        Effect = "Allow"
        Action = [
          "events:DescribeRule",
          "events:PutRule",
          "events:PutTargets",
        ]
        Resource = [
          "arn:${data.aws_partition.current.partition}:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/StepFunctionsGetEventsForECSTaskRule",
        ]
      },
    ]
  } : null

  oauth_provision_state_machine_definition = var.mcp_oauth_provisioning_enabled ? {
    Comment = "Run one exact, immutable AlphaNet OAuth public-client reconciliation task."
    StartAt = "RequireExpectedDigest"
    States = {
      RequireExpectedDigest = {
        Type = "Choice"
        Choices = [{
          Variable = "$.expected_manifest_sha256"
          IsString = true
          Next     = "RunProvisioningTask"
        }]
        Default = "InvalidInput"
      }
      InvalidInput = {
        Type  = "Fail"
        Error = "InvalidProvisioningInput"
        Cause = "An expected approved manifest digest is required."
      }
      RunProvisioningTask = {
        Type           = "Task"
        Resource       = "arn:${data.aws_partition.current.partition}:states:::ecs:runTask.sync"
        TimeoutSeconds = 900
        End            = true
        Parameters = {
          Cluster              = aws_ecs_cluster.main.arn
          TaskDefinition       = aws_ecs_task_definition.database_job["oauth-provision"].arn
          LaunchType           = "FARGATE"
          PlatformVersion      = "LATEST"
          PropagateTags        = "TASK_DEFINITION"
          EnableExecuteCommand = false
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              AssignPublicIp = "DISABLED"
              SecurityGroups = [aws_security_group.migration.id]
              Subnets        = [for subnet in aws_subnet.private : subnet.id]
            }
          }
          Overrides = {
            ContainerOverrides = [{
              Name = "oauth-provision"
              Environment = [{
                Name      = "ALPHANET_OAUTH_EXPECTED_APPROVED_SHA256"
                "Value.$" = "$.expected_manifest_sha256"
              }]
            }]
          }
        }
      }
    }
  } : null

  # The deploy role is a privileged production migration principal, but it
  # must never gain the dedicated manifest launch/read/pass capabilities as an
  # accidental side effect of a future broad deployment policy change.
  github_deploy_oauth_provision_deny_policy = var.mcp_oauth_provisioning_enabled ? {
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyDedicatedOAuthProvisioningWorkflow"
        Effect = "Deny"
        Action = [
          "states:DescribeExecution",
          "states:DescribeStateMachine",
          "states:StartExecution",
          "states:StopExecution",
        ]
        Resource = [
          aws_sfn_state_machine.oauth_provision[0].arn,
          "arn:${data.aws_partition.current.partition}:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-oauth-provision:*",
        ]
      },
      {
        Sid    = "DenyDedicatedOAuthProvisioningSecret"
        Effect = "Deny"
        Action = [
          "secretsmanager:DescribeSecret",
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
          "secretsmanager:UpdateSecretVersionStage",
        ]
        Resource = [aws_secretsmanager_secret.oauth_client_provisioning[0].arn]
      },
      {
        Sid      = "DenyRunningDedicatedOAuthProvisioningTask"
        Effect   = "Deny"
        Action   = ["ecs:RunTask"]
        Resource = [aws_ecs_task_definition.database_job["oauth-provision"].arn]
      },
      {
        Sid    = "DenyPassingDedicatedOAuthProvisioningRoles"
        Effect = "Deny"
        Action = ["iam:PassRole"]
        Resource = [
          aws_iam_role.oauth_provision_execution[0].arn,
          aws_iam_role.oauth_provision_task[0].arn,
          aws_iam_role.oauth_provision_launcher[0].arn,
        ]
      },
    ]
  } : null
}

resource "aws_iam_role_policy" "oauth_provision_launcher" {
  count = var.mcp_oauth_provisioning_enabled ? 1 : 0

  name   = "trusted-oauth-provisioning-launcher"
  role   = aws_iam_role.oauth_provision_launcher[0].id
  policy = jsonencode(local.oauth_provision_launcher_policy)
}

resource "aws_sfn_state_machine" "oauth_provision" {
  count = var.mcp_oauth_provisioning_enabled ? 1 : 0

  name     = "${local.name}-oauth-provision"
  role_arn = aws_iam_role.oauth_provision_launcher[0].arn
  type     = "STANDARD"

  definition = jsonencode(local.oauth_provision_state_machine_definition)

  depends_on = [aws_iam_role_policy.oauth_provision_launcher]

  tags = {
    Purpose = "trusted-operator-oauth-provisioning"
  }
}

resource "aws_iam_role_policy" "github_deploy_deny_oauth_provisioning" {
  count = var.mcp_oauth_provisioning_enabled ? 1 : 0

  name   = "deny-dedicated-oauth-provisioning"
  role   = aws_iam_role.github_deploy.id
  policy = jsonencode(local.github_deploy_oauth_provision_deny_policy)
}
