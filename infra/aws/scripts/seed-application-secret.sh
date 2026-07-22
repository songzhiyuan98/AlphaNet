#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' \
    "Usage: $0 --initial APPLICATION_SECRET_ARN DB_HOST VALKEY_HOST VALKEY_AUTH_SECRET_ARN API_INTERNAL_DNS_NAME [AWS_REGION]" \
    "" \
    "This is a first-deploy operation. It refuses to overwrite an existing" \
    "version; later changes require the coordinated rotation runbook."
}

if [[ "${1:-}" != "--initial" || $# -lt 6 || $# -gt 7 ]]; then
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
api_internal_dns_name="$6"
aws_region="${7:-${AWS_REGION:-us-west-2}}"

if [[ ! "${api_internal_dns_name}" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]]; then
  printf '%s\n' "API_INTERNAL_DNS_NAME must be a lowercase DNS hostname." >&2
  exit 2
fi

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

# A self-managed private CA avoids the fixed monthly cost of ACM Private CA for
# the MVP. Its signing key lives only in this process and is deliberately not
# persisted; coordinated rotation replaces the CA, server identity, client
# identity, and trust bundles as one reviewed operation. Leaf validity is kept
# to 397 days and the operations runbook requires rotation well before expiry.
internal_ca_private_key="$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256)"
internal_ca_certificate="$(openssl req \
  -x509 \
  -new \
  -sha256 \
  -days 3650 \
  -key <(printf '%s\n' "${internal_ca_private_key}") \
  -subj '/CN=AlphaNet Remote MCP Internal Root CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -addext 'subjectKeyIdentifier=hash')"

internal_server_private_key="$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256)"
internal_server_csr="$(openssl req \
  -new \
  -sha256 \
  -key <(printf '%s\n' "${internal_server_private_key}") \
  -subj "/CN=${api_internal_dns_name}")"
internal_server_certificate="$(openssl x509 \
  -req \
  -sha256 \
  -days 397 \
  -set_serial "0x$(openssl rand -hex 16)" \
  -in <(printf '%s\n' "${internal_server_csr}") \
  -CA <(printf '%s\n' "${internal_ca_certificate}") \
  -CAkey <(printf '%s\n' "${internal_ca_private_key}") \
  -extfile <(printf '%s\n' \
    '[server_cert]' \
    'basicConstraints=critical,CA:FALSE' \
    'keyUsage=critical,digitalSignature' \
    'extendedKeyUsage=serverAuth' \
    "subjectAltName=DNS:${api_internal_dns_name}" \
    'authorityKeyIdentifier=keyid,issuer' \
    'subjectKeyIdentifier=hash') \
  -extensions server_cert)"

internal_client_private_key="$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256)"
internal_client_csr="$(openssl req \
  -new \
  -sha256 \
  -key <(printf '%s\n' "${internal_client_private_key}") \
  -subj '/CN=alphanet-mcp')"
internal_client_certificate="$(openssl x509 \
  -req \
  -sha256 \
  -days 397 \
  -set_serial "0x$(openssl rand -hex 16)" \
  -in <(printf '%s\n' "${internal_client_csr}") \
  -CA <(printf '%s\n' "${internal_ca_certificate}") \
  -CAkey <(printf '%s\n' "${internal_ca_private_key}") \
  -extfile <(printf '%s\n' \
    '[client_cert]' \
    'basicConstraints=critical,CA:FALSE' \
    'keyUsage=critical,digitalSignature' \
    'extendedKeyUsage=clientAuth' \
    'subjectAltName=URI:spiffe://alphanet.internal/service/mcp' \
    'authorityKeyIdentifier=keyid,issuer' \
    'subjectKeyIdentifier=hash') \
  -extensions client_cert)"

internal_server_certificate_bundle="$(printf '%s\n%s\n' \
  "${internal_server_certificate}" "${internal_ca_certificate}")"
internal_client_certificate_bundle="$(printf '%s\n%s\n' \
  "${internal_client_certificate}" "${internal_ca_certificate}")"
internal_client_fingerprint="$(openssl x509 \
  -in <(printf '%s\n' "${internal_client_certificate}") \
  -noout \
  -fingerprint \
  -sha256 | cut -d= -f2 | tr -d ':' | tr '[:lower:]' '[:upper:]')"

internal_server_certificate_base64="$(printf '%s' "${internal_server_certificate_bundle}" | openssl base64 -A)"
internal_server_private_key_base64="$(printf '%s' "${internal_server_private_key}" | openssl base64 -A)"
internal_client_certificate_base64="$(printf '%s' "${internal_client_certificate_bundle}" | openssl base64 -A)"
internal_client_private_key_base64="$(printf '%s' "${internal_client_private_key}" | openssl base64 -A)"
internal_ca_certificate_base64="$(printf '%s' "${internal_ca_certificate}" | openssl base64 -A)"
actor_assertion_key_base64="$(openssl rand 32 | openssl base64 -A)"
actor_assertion_replay_digest_key_base64="$(openssl rand 32 | openssl base64 -A)"
access_token_jti_digest_key_base64="$(openssl rand 32 | openssl base64 -A)"

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
  "${AUTH_GOOGLE_CLIENT_SECRET:-}" \
  "${internal_server_certificate_base64}" \
  "${internal_server_private_key_base64}" \
  "${internal_ca_certificate_base64}" \
  "${internal_client_fingerprint}" \
  "${internal_client_certificate_base64}" \
  "${internal_client_private_key_base64}" \
  "${internal_ca_certificate_base64}" \
  "${actor_assertion_key_base64}" \
  '1' \
  '{}' \
  "${actor_assertion_replay_digest_key_base64}" \
  "${access_token_jti_digest_key_base64}" |
  jq -Rsc '
    split("\u0000") as $value |
    if (($value | length) != 25 or $value[24] != "") then
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
        AUTH_GOOGLE_CLIENT_SECRET: $value[11],
        MCP_INTERNAL_API_SERVER_CERT_PEM_BASE64: $value[12],
        MCP_INTERNAL_API_SERVER_KEY_PEM_BASE64: $value[13],
        MCP_INTERNAL_API_CLIENT_CA_PEM_BASE64: $value[14],
        MCP_INTERNAL_API_ALLOWED_CLIENT_CERT_SHA256_FINGERPRINTS: $value[15],
        MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64: $value[16],
        MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64: $value[17],
        MCP_INTERNAL_API_SERVER_CA_PEM_BASE64: $value[18],
        MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64: $value[19],
        MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION: $value[20],
        MCP_ACTOR_ASSERTION_PREVIOUS_KEYS: $value[21],
        MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64: $value[22],
        MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64: $value[23]
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
  internal_ca_private_key \
  internal_ca_certificate \
  internal_server_private_key \
  internal_server_csr \
  internal_server_certificate \
  internal_client_private_key \
  internal_client_csr \
  internal_client_certificate \
  internal_server_certificate_bundle \
  internal_client_certificate_bundle \
  internal_client_fingerprint \
  internal_server_certificate_base64 \
  internal_server_private_key_base64 \
  internal_client_certificate_base64 \
  internal_client_private_key_base64 \
  internal_ca_certificate_base64 \
  actor_assertion_key_base64 \
  actor_assertion_replay_digest_key_base64 \
  access_token_jti_digest_key_base64 \
  database_url \
  redis_url \
  existing_version_count

printf '%s\n' "Application secret seeded without writing values to Terraform state or disk."
