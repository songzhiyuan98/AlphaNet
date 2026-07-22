resource "aws_kms_key" "data" {
  description             = "AlphaNet ${var.environment} Aurora, Valkey, and session-state data encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  lifecycle {
    # Aurora final/PITR snapshots and retained Valkey snapshots remain encrypted
    # with this key after workload deletion. Retire it only through the reviewed
    # recovery-asset disposal procedure after every dependent copy has expired.
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

data "aws_iam_policy_document" "notification_key" {
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
    sid    = "MonitoringServiceEncryption"
    effect = "Allow"

    principals {
      type = "Service"
      identifiers = [
        "cloudwatch.amazonaws.com",
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

resource "aws_kms_key" "notifications" {
  description             = "AlphaNet ${var.environment} regional operations notifications"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.notification_key.json
}

resource "aws_kms_alias" "notifications" {
  name          = "alias/${local.name}-notifications"
  target_key_id = aws_kms_key.notifications.key_id
}

resource "aws_kms_key" "edge_notifications" {
  provider = aws.global

  description             = "AlphaNet ${var.environment} CloudFront operations notifications"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.notification_key.json
}

resource "aws_kms_alias" "edge_notifications" {
  provider = aws.global

  name          = "alias/${local.name}-edge-notifications"
  target_key_id = aws_kms_key.edge_notifications.key_id
}
