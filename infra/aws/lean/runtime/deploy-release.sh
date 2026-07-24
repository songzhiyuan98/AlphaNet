#!/usr/bin/env bash
set -Eeuo pipefail
set +x
export AWS_PAGER=""

usage() {
  cat >&2 <<'USAGE'
Usage:
  deploy-release.sh MANIFEST_BASE64 EXPECTED_SHA

Required environment:
  ALPHANET_APPLICATION_SECRET_ARN
  ALPHANET_AUTH_EMAIL_FROM
  ALPHANET_DATABASE_SECRET_ARN
  ALPHANET_ECR_IMAGE_PREFIX
  ALPHANET_ORIGIN_HEADER_PARAMETER
  ALPHANET_PUBLIC_ORIGIN
  ALPHANET_REDIS_SECRET_ARN
  ALPHANET_REPOSITORY
  AWS_REGION
USAGE
}

manifest_base64="${1:-}"
expected_sha="${2:-}"
if [[ -z "${manifest_base64}" || -z "${expected_sha}" || $# -ne 2 ]]; then
  usage
  exit 2
fi
if [[ ! "${expected_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "EXPECTED_SHA must be a full lowercase Git SHA." >&2
  exit 2
fi

required_variables=(
  ALPHANET_APPLICATION_SECRET_ARN
  ALPHANET_AUTH_EMAIL_FROM
  ALPHANET_DATABASE_SECRET_ARN
  ALPHANET_ECR_IMAGE_PREFIX
  ALPHANET_ORIGIN_HEADER_PARAMETER
  ALPHANET_PUBLIC_ORIGIN
  ALPHANET_REDIS_SECRET_ARN
  ALPHANET_REPOSITORY
  AWS_REGION
)
for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "${variable_name} is required." >&2
    exit 2
  fi
done
if [[ ! "${ALPHANET_PUBLIC_ORIGIN}" =~ ^https://[a-z0-9.-]+$ ]]; then
  echo "ALPHANET_PUBLIC_ORIGIN must be an origin-only HTTPS URL." >&2
  exit 2
fi

for command_name in aws base64 curl docker envsubst flock jq nginx sha256sum systemctl; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "${command_name} is required." >&2
    exit 127
  fi
done
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required." >&2
  exit 127
fi

readonly runtime_root="/opt/alphanet"
readonly release_root="${runtime_root}/releases"
readonly current_link="${runtime_root}/current"
readonly previous_link="${runtime_root}/previous"
readonly release_directory="${release_root}/${expected_sha}"
readonly compose_file="${release_directory}/compose.yaml"
readonly nginx_template="${release_directory}/nginx.conf.template"
readonly nginx_proxy_headers="${release_directory}/alphanet-proxy-headers.conf"
readonly runtime_env="${release_directory}/runtime.env"
readonly manifest_path="${release_directory}/release-manifest.json"
readonly validator="${runtime_root}/bin/validate-release-manifest.sh"
readonly lock_file="${runtime_root}/deploy.lock"

install -d -m 0750 "${release_directory}" "${runtime_root}/bin"
exec 9>"${lock_file}"
if ! flock -n 9; then
  echo "Another AlphaNet release is already running." >&2
  exit 1
fi

if ! printf '%s' "${manifest_base64}" | base64 --decode >"${manifest_path}"; then
  echo "Release manifest is not valid base64." >&2
  exit 2
fi
chmod 0440 "${manifest_path}"
bash "${validator}" \
  "${manifest_path}" \
  "${expected_sha}" \
  "${ALPHANET_REPOSITORY}" \
  "${ALPHANET_ECR_IMAGE_PREFIX}"

manifest_reference() {
  jq -er --arg target "$1" '.images[$target].reference' "${manifest_path}"
}

application_secret_json="$(
  aws secretsmanager get-secret-value \
    --region "${AWS_REGION}" \
    --secret-id "${ALPHANET_APPLICATION_SECRET_ARN}" \
    --version-stage AWSCURRENT \
    --query SecretString \
    --output text
)"
database_secret_json="$(
  aws secretsmanager get-secret-value \
    --region "${AWS_REGION}" \
    --secret-id "${ALPHANET_DATABASE_SECRET_ARN}" \
    --version-stage AWSCURRENT \
    --query SecretString \
    --output text
)"
redis_secret_json="$(
  aws secretsmanager get-secret-value \
    --region "${AWS_REGION}" \
    --secret-id "${ALPHANET_REDIS_SECRET_ARN}" \
    --version-stage AWSCURRENT \
    --query SecretString \
    --output text
)"
origin_verify_header="$(
  aws ssm get-parameter \
    --region "${AWS_REGION}" \
    --name "${ALPHANET_ORIGIN_HEADER_PARAMETER}" \
    --with-decryption \
    --query Parameter.Value \
    --output text
)"

for secret_name in application_secret_json database_secret_json redis_secret_json; do
  if ! jq -e 'type == "object"' <<<"${!secret_name}" >/dev/null; then
    echo "${secret_name%_json} must contain one JSON object." >&2
    exit 1
  fi
done

required_application_keys=(
  ALPHANET_MIGRATION_PASSWORD
  ALPHANET_RUNTIME_PASSWORD
  AGENT_API_KEY_PEPPER
  BETTER_AUTH_SECRET
  COMMUNITY_CURSOR_SIGNING_KEY
  DATABASE_URL
  MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64
  MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64
  MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION
  MCP_ACTOR_ASSERTION_PREVIOUS_KEYS
  MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64
  MCP_INTERNAL_API_ALLOWED_CLIENT_CERT_SHA256_FINGERPRINTS
  MCP_INTERNAL_API_CLIENT_CA_PEM_BASE64
  MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64
  MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64
  MCP_INTERNAL_API_SERVER_CA_PEM_BASE64
  MCP_INTERNAL_API_SERVER_CERT_PEM_BASE64
  MCP_INTERNAL_API_SERVER_KEY_PEM_BASE64
  PENDING_ACTION_ENCRYPTION_KEY
  REDIS_URL
  RESEND_API_KEY
  SSR_INTERNAL_REQUEST_SECRET
)
for key in "${required_application_keys[@]}"; do
  if ! jq -e --arg key "${key}" '
    has($key) and (.[$key] | type == "string" and length > 0)
  ' <<<"${application_secret_json}" >/dev/null; then
    echo "Application secret is missing non-empty ${key}." >&2
    exit 1
  fi
done
if ! jq -e '
  (.username | type == "string" and length > 0)
  and (.password | type == "string" and length > 0)
  and (.host | type == "string" and length > 0)
  and (.port | type == "number")
' <<<"${database_secret_json}" >/dev/null; then
  echo "RDS managed secret is incomplete." >&2
  exit 1
fi
if ! jq -e '
  .auth_token | type == "string" and length >= 32
' <<<"${redis_secret_json}" >/dev/null; then
  echo "Redis secret must contain an auth_token of at least 32 characters." >&2
  exit 1
fi
if ((${#origin_verify_header} < 32)); then
  echo "Origin verification header is too short." >&2
  exit 1
fi

public_host="${ALPHANET_PUBLIC_ORIGIN#https://}"
database_host="$(jq -er '.host' <<<"${database_secret_json}")"
database_port="$(jq -er '.port' <<<"${database_secret_json}")"
database_master_user="$(jq -er '.username' <<<"${database_secret_json}")"
database_master_password="$(jq -er '.password' <<<"${database_secret_json}")"
redis_password="$(jq -er '.auth_token' <<<"${redis_secret_json}")"

umask 077
runtime_env_temporary="$(mktemp "${release_directory}/runtime.env.XXXXXX")"
rollback_required="false"
old_current=""

cleanup() {
  unset \
    application_secret_json \
    database_secret_json \
    redis_secret_json \
    database_master_password \
    redis_password \
    origin_verify_header \
    manifest_base64
  if [[ -n "${runtime_env_temporary:-}" && -e "${runtime_env_temporary}" ]]; then
    rm -f "${runtime_env_temporary}"
  fi
}
trap cleanup EXIT

rollback_release() {
  local exit_code="${1:-1}"

  trap - ERR
  set +e
  if [[ "${rollback_required}" == "true" &&
        -n "${old_current}" &&
        -f "${old_current}/runtime.env" &&
        -f "${old_current}/compose.yaml" ]]; then
    echo "Restoring the previous AlphaNet release." >&2
    ln -sfn "${old_current}" "${current_link}"
    docker compose \
      --env-file "${old_current}/runtime.env" \
      --file "${old_current}/compose.yaml" \
      up --detach --remove-orphans --wait --wait-timeout 180 \
      api web mcp worker redis
  fi
  exit "${exit_code}"
}
trap 'rollback_release $?' ERR

{
  printf '%s\n' \
    "APP_VERSION=${expected_sha}" \
    "AWS_REGION=${AWS_REGION}" \
    "NODE_ENV=production" \
    "TZ=UTC" \
    "LOG_LEVEL=info" \
    "API_IMAGE=$(manifest_reference api)" \
    "WEB_IMAGE=$(manifest_reference web)" \
    "MCP_IMAGE=$(manifest_reference mcp)" \
    "WORKER_IMAGE=$(manifest_reference worker)" \
    "MIGRATE_IMAGE=$(manifest_reference migrate)" \
    "REDIS_IMAGE=redis:7.4.2-alpine@sha256:02419de7eddf55aa5bcf49efb74e88fa8d931b4d77c07eff8a6b2144472b6952" \
    "REDIS_PASSWORD=$(jq -Rn --arg value "${redis_password}" '$value | @json')" \
    "PGHOST=${database_host}" \
    "PGPORT=${database_port}" \
    "PGDATABASE=alphanet" \
    "PGUSER=alphanet_migration" \
    "PGPASSWORD=$(jq -Rn --arg value "$(jq -er '.ALPHANET_MIGRATION_PASSWORD' <<<"${application_secret_json}")" '$value | @json')" \
    "PGSSLMODE=verify-full" \
    "PGSSLROOTCERT=/opt/alphanet/certs/aws-rds-us-west-2-bundle.pem" \
    "ALPHANET_MIGRATION_ROLE=alphanet_migration" \
    "ALPHANET_RUNTIME_ROLE=alphanet_runtime" \
    "CORS_ORIGINS=${ALPHANET_PUBLIC_ORIGIN}" \
    "BETTER_AUTH_URL=${ALPHANET_PUBLIC_ORIGIN}" \
    "AUTH_TRUSTED_ORIGINS=${ALPHANET_PUBLIC_ORIGIN}" \
    "AUTH_SECURE_COOKIES=true" \
    "API_TRUSTED_PROXY_CIDRS=172.30.0.0/24" \
    "SSR_ALLOW_MISSING_CLIENT_IP=false" \
    "NEXT_PUBLIC_API_URL=" \
    "AUTH_EMAIL_MODE=resend" \
    "AUTH_EMAIL_FROM=$(jq -Rn --arg value "${ALPHANET_AUTH_EMAIL_FROM}" '$value | @json')" \
    "AUTH_EMAIL_REPLY_TO=" \
    "AUTH_DATABASE_POOL_MAX=10" \
    "AUTH_EMAIL_DAILY_GLOBAL_LIMIT=100" \
    "GOOGLE_AUTH_ENABLED=false" \
    "MCP_RUNTIME_ENABLED=true" \
    "MCP_PUBLIC_ENABLED=false" \
    "MCP_ALLOWED_HOSTS=${public_host}" \
    "MCP_TRUSTED_PROXY_CIDRS=172.30.0.0/24" \
    "MCP_RESOURCE=${ALPHANET_PUBLIC_ORIGIN}/mcp" \
    "MCP_OAUTH_ISSUER=${ALPHANET_PUBLIC_ORIGIN}/api/auth" \
    "MCP_OAUTH_JWKS_URI=${ALPHANET_PUBLIC_ORIGIN}/api/auth/jwks" \
    "MCP_OAUTH_OWNER_CONSENT_ENABLED=false" \
    "MCP_OAUTH_SERVER_ENABLED=false" \
    "MCP_INTERNAL_API_ENABLED=true" \
    "MCP_INTERNAL_API_PORT=4443" \
    "MCP_INTERNAL_API_TIMEOUT_MS=15000" \
    "MCP_INTERNAL_API_MAX_RESPONSE_BYTES=4194304" \
    "ADMIN_WEB_ENABLED=false" \
    "AGENT_API_AUDIENCE=urn:alphanet:api:v1" \
    "AGENT_API_KEY_PEPPER_VERSION=1" \
    "AGENT_API_KEY_PREVIOUS_PEPPERS={}" \
    "AGENT_CREDENTIAL_ACTIVE_PER_AGENT=5" \
    "AGENT_CREDENTIAL_ACTIVE_PER_OWNER=20" \
    "AGENT_CREDENTIAL_ISSUE_PER_OWNER_24H=10" \
    "AGENT_CREDENTIAL_MUTATION_COOLDOWN_SECONDS=30" \
    "AGENT_CREDENTIAL_DEFAULT_TTL_DAYS=90" \
    "AGENT_CREDENTIAL_MAX_TTL_DAYS=365" \
    "PENDING_ACTION_ENCRYPTION_KEY_VERSION=1" \
    "PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS={}" \
    "SEARCH_EMBEDDING_PROVIDER=disabled" \
    "SEARCH_EMBEDDING_MODEL_ID=amazon.titan-embed-text-v2:0" \
    "SEARCH_EMBEDDING_DIMENSIONS=512" \
    "SEARCH_EMBEDDING_TIMEOUT_MS=5000" \
    "OUTBOX_CONSUMER_NAME=alphanet-worker:v2" \
    "OUTBOX_REPLAY_FROM=2026-07-20T00:00:00.000Z" \
    "WORKER_POLL_INTERVAL_MS=1000" \
    "WORKER_BATCH_SIZE=20" \
    "SEARCH_INDEX_BATCH_SIZE=10" \
    "SEARCH_INDEX_LEASE_SECONDS=60" \
    "RUN_ONCE=false"

  jq -r '
    to_entries[]
    | select(.key != "DATABASE_URL" and .key != "REDIS_URL")
    | "\(.key)=\(.value | tostring | @json)"
  ' <<<"${application_secret_json}"

  jq -r '
    "DATABASE_URL=\(.DATABASE_URL | @json)",
    "REDIS_URL=\(.REDIS_URL | @json)"
  ' <<<"${application_secret_json}"
} >"${runtime_env_temporary}"
chmod 0400 "${runtime_env_temporary}"
mv "${runtime_env_temporary}" "${runtime_env}"
runtime_env_temporary=""

aws ecr get-login-password --region "${AWS_REGION}" |
  docker login \
    --username AWS \
    --password-stdin \
    "${ALPHANET_ECR_IMAGE_PREFIX%%/*}" \
    >/dev/null

compose() {
  docker compose \
    --env-file "${runtime_env}" \
    --file "${compose_file}" \
    "$@"
}

for target in api web mcp worker migrate; do
  docker pull "$(manifest_reference "${target}")" >/dev/null
done
docker pull \
  "redis:7.4.2-alpine@sha256:02419de7eddf55aa5bcf49efb74e88fa8d931b4d77c07eff8a6b2144472b6952" \
  >/dev/null

if [[ ! -e "${runtime_root}/database-bootstrapped" ]]; then
  compose --profile database-bootstrap run --rm \
    -e "PGUSER=${database_master_user}" \
    -e "PGPASSWORD=${database_master_password}" \
    bootstrap
  install -m 0440 /dev/null "${runtime_root}/database-bootstrapped"
fi

compose --profile release run --rm migrate
compose --profile release run --rm \
  -e "PGUSER=alphanet_runtime" \
  -e "PGPASSWORD=$(jq -er '.ALPHANET_RUNTIME_PASSWORD' <<<"${application_secret_json}")" \
  runtime-smoke

if [[ -L "${current_link}" ]]; then
  old_current="$(readlink -f "${current_link}")"
fi
if [[ -n "${old_current}" && "${old_current}" != "${release_directory}" ]]; then
  ln -sfn "${old_current}" "${previous_link}"
fi
ln -sfn "${release_directory}" "${current_link}"
rollback_required="true"

if ! compose up --detach --remove-orphans --wait --wait-timeout 180 \
  api web mcp worker redis; then
  echo "New release failed container readiness." >&2
  rollback_release 1
fi

for health_url in \
  http://127.0.0.1:3000/health \
  http://127.0.0.1:4000/health/ready \
  http://127.0.0.1:4100/health/ready; do
  curl \
    --fail \
    --silent \
    --show-error \
    --connect-timeout 3 \
    --max-time 10 \
    "${health_url}" \
    >/dev/null
done
rollback_required="false"

export ORIGIN_VERIFY_HEADER="${origin_verify_header}"
envsubst '${ORIGIN_VERIFY_HEADER}' \
  <"${nginx_template}" \
  >"${release_directory}/nginx.conf"
unset ORIGIN_VERIFY_HEADER
install -m 0600 "${release_directory}/nginx.conf" /etc/nginx/nginx.conf
install -m 0644 \
  "${nginx_proxy_headers}" \
  /etc/nginx/alphanet-proxy-headers.conf
nginx -t
systemctl reload nginx
printf '%s\n' "${expected_sha}" >"${runtime_root}/deployed-sha"
chmod 0440 "${runtime_root}/deployed-sha"
echo "AlphaNet lean release ${expected_sha} is healthy."
