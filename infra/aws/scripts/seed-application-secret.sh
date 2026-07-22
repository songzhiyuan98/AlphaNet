#!/usr/bin/env bash
set -Eeuo pipefail
set +x
export AWS_PAGER=""

usage() {
  printf '%s\n' \
    "Usage: $0 --initial APPLICATION_SECRET_ARN DB_HOST VALKEY_HOST VALKEY_AUTH_SECRET_ARN API_INTERNAL_DNS_NAME [AWS_REGION]" \
    "       $0 --augment-mcp-oauth APPLICATION_SECRET_ARN [AWS_REGION]" \
    "" \
    "--initial refuses any existing version. --augment-mcp-oauth preserves" \
    "every existing field, adds only absent OAuth keys, and uses an AWSCURRENT" \
    "compare-and-swap so a concurrent update cannot be overwritten."
}

mode="${1:-}"
if [[ "${mode}" == "--initial" ]]; then
  if [[ $# -lt 6 || $# -gt 7 ]]; then
    usage >&2
    exit 2
  fi
elif [[ "${mode}" == "--augment-mcp-oauth" ]]; then
  if [[ $# -lt 2 || $# -gt 3 ]]; then
    usage >&2
    exit 2
  fi
else
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
if [[ "${mode}" == "--augment-mcp-oauth" ]]; then
  aws_region="${3:-${AWS_REGION:-us-west-2}}"
  pending_version_count="$(aws secretsmanager list-secret-version-ids \
    --region "${aws_region}" \
    --secret-id "${application_secret_arn}" \
    --include-deprecated \
    --output json | jq '[.Versions[] | select(.VersionStages | index("AWSPENDING"))] | length')"
  if [[ "${pending_version_count}" != "0" ]]; then
    printf '%s\n' \
      "Application secret already has AWSPENDING; finish or cancel that rotation before augmentation." >&2
    exit 1
  fi
  current_secret_response="$(aws secretsmanager get-secret-value \
    --region "${aws_region}" \
    --secret-id "${application_secret_arn}" \
    --version-stage AWSCURRENT \
    --output json)"
  current_version_id="$(jq -er '.VersionId' <<<"${current_secret_response}")"
  current_secret_json="$(jq -er '.SecretString' <<<"${current_secret_response}")"
  if ! jq -e 'type == "object"' <<<"${current_secret_json}" >/dev/null; then
    printf '%s\n' "Application SecretString must be a JSON object." >&2
    exit 1
  fi

  missing_oauth_key_count="$(jq -er '
    ([
      "MCP_OAUTH_AUTHORIZATION_BINDING_KEY_BASE64",
      "MCP_OAUTH_CONTINUATION_KEY_BASE64",
      "MCP_OAUTH_TOKEN_STORAGE_KEY_BASE64",
      "MCP_OAUTH_JWK_ENCRYPTION_KEY_BASE64",
      "MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64"
    ] - keys) | length
  ' <<<"${current_secret_json}")"
  if [[ "${missing_oauth_key_count}" == "0" ]]; then
    printf '%s\n' \
      "Application secret already contains every OAuth key; augmentation refuses to overwrite them." >&2
    exit 1
  fi

  oauth_authorization_binding_key_base64="$(openssl rand 32 | openssl base64 -A)"
  oauth_continuation_key_base64="$(openssl rand 32 | openssl base64 -A)"
  oauth_token_storage_key_base64="$(openssl rand 32 | openssl base64 -A)"
  oauth_jwk_encryption_key_base64="$(openssl rand 32 | openssl base64 -A)"
  access_token_jti_digest_key_base64="$(openssl rand 32 | openssl base64 -A)"
  pending_client_token="$(openssl rand -hex 32)"

  new_version_id="$(
    printf '%s\0' \
      "${current_secret_json}" \
      "${oauth_authorization_binding_key_base64}" \
      "${oauth_continuation_key_base64}" \
      "${oauth_token_storage_key_base64}" \
      "${oauth_jwk_encryption_key_base64}" \
      "${access_token_jti_digest_key_base64}" |
      jq -Rsc '
        split("\u0000") as $value |
        if (($value | length) != 7 or $value[6] != "") then
          error("unexpected OAuth augmentation field framing")
        else
          ($value[0] | fromjson) as $current |
          [
            { key: "MCP_OAUTH_AUTHORIZATION_BINDING_KEY_BASE64", value: $value[1] },
            { key: "MCP_OAUTH_CONTINUATION_KEY_BASE64", value: $value[2] },
            { key: "MCP_OAUTH_TOKEN_STORAGE_KEY_BASE64", value: $value[3] },
            { key: "MCP_OAUTH_JWK_ENCRYPTION_KEY_BASE64", value: $value[4] },
            { key: "MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64", value: $value[5] }
          ] |
          reduce .[] as $entry ($current;
            if has($entry.key) then . else . + { ($entry.key): $entry.value } end
          )
        end
      ' |
      aws secretsmanager put-secret-value \
        --region "${aws_region}" \
        --secret-id "${application_secret_arn}" \
        --client-request-token "${pending_client_token}" \
        --version-stages AWSPENDING \
        --secret-string file:///dev/stdin \
        --query VersionId \
        --output text
  )"
  if [[ "${new_version_id}" != "${pending_client_token}" ]]; then
    printf '%s\n' "Secrets Manager returned an unexpected pending version." >&2
    exit 1
  fi

  if ! aws secretsmanager update-secret-version-stage \
    --region "${aws_region}" \
    --secret-id "${application_secret_arn}" \
    --version-stage AWSCURRENT \
    --move-to-version-id "${new_version_id}" \
    --remove-from-version-id "${current_version_id}" \
    >/dev/null; then
    aws secretsmanager update-secret-version-stage \
      --region "${aws_region}" \
      --secret-id "${application_secret_arn}" \
      --version-stage AWSPENDING \
      --remove-from-version-id "${new_version_id}" \
      >/dev/null 2>&1 || true
    printf '%s\n' \
      "Application secret changed concurrently; augmentation left AWSCURRENT untouched." >&2
    exit 1
  fi
  aws secretsmanager update-secret-version-stage \
    --region "${aws_region}" \
    --secret-id "${application_secret_arn}" \
    --version-stage AWSPENDING \
    --remove-from-version-id "${new_version_id}" \
    >/dev/null

  unset \
    current_secret_response \
    current_secret_json \
    oauth_authorization_binding_key_base64 \
    oauth_continuation_key_base64 \
    oauth_token_storage_key_base64 \
    oauth_jwk_encryption_key_base64 \
    access_token_jti_digest_key_base64
  printf '%s\n' \
    "Application secret augmented with absent OAuth keys; existing values were preserved."
  exit 0
fi

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
oauth_authorization_binding_key_base64="$(openssl rand 32 | openssl base64 -A)"
oauth_continuation_key_base64="$(openssl rand 32 | openssl base64 -A)"
oauth_token_storage_key_base64="$(openssl rand 32 | openssl base64 -A)"
oauth_jwk_encryption_key_base64="$(openssl rand 32 | openssl base64 -A)"

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
  "${access_token_jti_digest_key_base64}" \
  "${oauth_authorization_binding_key_base64}" \
  "${oauth_continuation_key_base64}" \
  "${oauth_token_storage_key_base64}" \
  "${oauth_jwk_encryption_key_base64}" |
  jq -Rsc '
    split("\u0000") as $value |
    if (($value | length) != 29 or $value[28] != "") then
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
        MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64: $value[23],
        MCP_OAUTH_AUTHORIZATION_BINDING_KEY_BASE64: $value[24],
        MCP_OAUTH_CONTINUATION_KEY_BASE64: $value[25],
        MCP_OAUTH_TOKEN_STORAGE_KEY_BASE64: $value[26],
        MCP_OAUTH_JWK_ENCRYPTION_KEY_BASE64: $value[27]
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
  oauth_authorization_binding_key_base64 \
  oauth_continuation_key_base64 \
  oauth_token_storage_key_base64 \
  oauth_jwk_encryption_key_base64 \
  database_url \
  redis_url \
  existing_version_count

printf '%s\n' "Application secret seeded without writing values to Terraform state or disk."
