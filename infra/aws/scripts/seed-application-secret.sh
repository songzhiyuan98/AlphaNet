#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' \
    "Usage: $0 --initial APPLICATION_SECRET_ARN DB_HOST VALKEY_HOST VALKEY_AUTH_SECRET_ARN [AWS_REGION]" \
    "" \
    "This is a first-deploy operation. It refuses to overwrite an existing" \
    "version; later changes require the coordinated rotation runbook."
}

if [[ "${1:-}" != "--initial" || $# -lt 5 || $# -gt 6 ]]; then
  usage >&2
  exit 2
fi

for command_name in aws jq openssl; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf '%s is required.\n' "${command_name}" >&2
    exit 127
  fi
done

application_secret_arn="$2"
database_host="$3"
valkey_host="$4"
valkey_auth_secret_arn="$5"
aws_region="${6:-${AWS_REGION:-us-west-2}}"

existing_version_count="$(aws secretsmanager list-secret-version-ids \
  --region "${aws_region}" \
  --secret-id "${application_secret_arn}" \
  --include-deprecated \
  --output json | jq '.Versions | length')"
if [[ "${existing_version_count}" != "0" ]]; then
  printf '%s\n' \
    "Application secret already has a version; --initial refuses to rotate it." \
    "Use the coordinated credential-rotation runbook instead." >&2
  exit 1
fi

if [[ -z "${RESEND_API_KEY:-}" ]]; then
  read -r -s -p "Resend API key: " RESEND_API_KEY
  printf '\n'
fi
if [[ -z "${RESEND_API_KEY}" ]]; then
  printf '%s\n' "RESEND_API_KEY cannot be empty." >&2
  exit 2
fi

valkey_secret_json="$(aws secretsmanager get-secret-value \
  --region "${aws_region}" \
  --secret-id "${valkey_auth_secret_arn}" \
  --query SecretString \
  --output text)"
valkey_auth_token="$(jq -er '.auth_token' <<<"${valkey_secret_json}")"

migration_password="$(openssl rand -hex 32)"
runtime_password="$(openssl rand -hex 32)"
better_auth_secret="$(openssl rand -hex 48)"
ssr_internal_secret="$(openssl rand -hex 48)"
agent_api_key_pepper="$(openssl rand -hex 48)"
pending_action_key="$(openssl rand -hex 32)"
community_cursor_key="$(openssl rand -hex 48)"

database_url="postgresql://alphanet_runtime:${runtime_password}@${database_host}:5432/alphanet?sslmode=verify-full"
redis_url="rediss://default:${valkey_auth_token}@${valkey_host}:6379/0"

printf '%s\0' \
  "${database_url}" \
  "${redis_url}" \
  "${migration_password}" \
  "${runtime_password}" \
  "${better_auth_secret}" \
  "${ssr_internal_secret}" \
  "${agent_api_key_pepper}" \
  "${pending_action_key}" \
  "${community_cursor_key}" \
  "${RESEND_API_KEY}" \
  "${AUTH_GOOGLE_CLIENT_ID:-}" \
  "${AUTH_GOOGLE_CLIENT_SECRET:-}" |
  jq -Rsc '
    split("\u0000") as $value |
    if (($value | length) != 13 or $value[12] != "") then
      error("unexpected application secret field framing")
    else
      {
        DATABASE_URL: $value[0],
        REDIS_URL: $value[1],
        ALPHANET_MIGRATION_PASSWORD: $value[2],
        ALPHANET_RUNTIME_PASSWORD: $value[3],
        BETTER_AUTH_SECRET: $value[4],
        SSR_INTERNAL_REQUEST_SECRET: $value[5],
        AGENT_API_KEY_PEPPER: $value[6],
        PENDING_ACTION_ENCRYPTION_KEY: $value[7],
        COMMUNITY_CURSOR_SIGNING_KEY: $value[8],
        RESEND_API_KEY: $value[9],
        AUTH_GOOGLE_CLIENT_ID: $value[10],
        AUTH_GOOGLE_CLIENT_SECRET: $value[11]
      }
    end
  ' |
  aws secretsmanager put-secret-value \
  --region "${aws_region}" \
  --secret-id "${application_secret_arn}" \
  --secret-string file:///dev/stdin \
  --query '{ARN:ARN,VersionId:VersionId}' \
  --output json

unset \
  RESEND_API_KEY \
  valkey_secret_json \
  valkey_auth_token \
  migration_password \
  runtime_password \
  better_auth_secret \
  ssr_internal_secret \
  agent_api_key_pepper \
  pending_action_key \
  community_cursor_key \
  database_url \
  redis_url \
  existing_version_count

printf '%s\n' "Application secret seeded without writing values to Terraform state or disk."
