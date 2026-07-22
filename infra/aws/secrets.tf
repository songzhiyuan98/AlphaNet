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
# digest keys. Before admin_web_enabled is turned on, the same secret must also
# contain ADMIN_WEB_OIDC_CLIENT_SECRET,
# ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64, and the API-only
# ADMIN_AUDIT_SUBJECT_DIGEST_KEY. Terraform injects these values by JSON key;
# it never stores their plaintext in configuration or state.

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

# This container has no Terraform-managed version. An authenticated operator
# stages a reviewed manifest as a digest-addressed Secrets Manager version;
# the one-off launcher binds the ECS revision to that exact version ID.
resource "aws_secretsmanager_secret" "oauth_client_provisioning" {
  count = var.mcp_oauth_provisioning_enabled ? 1 : 0

  name                    = "${local.name}/remote-mcp-oauth-client-provisioning"
  description             = "Operator-reviewed Remote MCP OAuth public-client manifest; values are populated outside Terraform"
  recovery_window_in_days = var.environment == "production" ? 30 : 7

  tags = {
    Purpose = "operator-oauth-provisioning"
  }
}

data "aws_iam_policy_document" "oauth_client_provisioning_secret" {
  count = var.mcp_oauth_provisioning_enabled ? 1 : 0

  statement {
    sid    = "DenyUnencryptedTransport"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["secretsmanager:*"]
    resources = [aws_secretsmanager_secret.oauth_client_provisioning[0].arn]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_secretsmanager_secret_policy" "oauth_client_provisioning" {
  count = var.mcp_oauth_provisioning_enabled ? 1 : 0

  secret_arn          = aws_secretsmanager_secret.oauth_client_provisioning[0].arn
  policy              = data.aws_iam_policy_document.oauth_client_provisioning_secret[0].json
  block_public_policy = true
}
