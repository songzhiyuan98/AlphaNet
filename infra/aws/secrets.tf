resource "aws_secretsmanager_secret" "application" {
  name                    = "${local.name}/application"
  description             = "Runtime-only AlphaNet credentials and connection URLs; populated outside Terraform"
  recovery_window_in_days = var.environment == "production" ? 30 : 7

  tags = {
    Purpose = "ecs-runtime"
  }
}

# Terraform intentionally creates no aws_secretsmanager_secret_version here.
# Values are generated and written with the documented bootstrap procedure so
# they never appear in a plan file or Terraform state. Expected JSON keys:
# DATABASE_URL, REDIS_URL, ALPHANET_MIGRATION_PASSWORD,
# ALPHANET_RUNTIME_PASSWORD, BETTER_AUTH_SECRET, SSR_INTERNAL_REQUEST_SECRET,
# AGENT_API_KEY_PEPPER, PENDING_ACTION_ENCRYPTION_KEY,
# COMMUNITY_CURSOR_SIGNING_KEY, RESEND_API_KEY, optional Google OAuth keys,
# private MCP server/client certificate bundles and keys, the pinned client
# fingerprint, the ActorContext key version/ring, and independent replay/JTI
# digest keys.

data "aws_iam_policy_document" "application_secret" {
  statement {
    sid    = "DenyUnencryptedTransport"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["secretsmanager:*"]
    resources = [aws_secretsmanager_secret.application.arn]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_secretsmanager_secret_policy" "application" {
  secret_arn          = aws_secretsmanager_secret.application.arn
  policy              = data.aws_iam_policy_document.application_secret.json
  block_public_policy = true
}
