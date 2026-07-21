#!/usr/bin/env bash
set -Eeuo pipefail
set +x

# Passwords are supplied by ECS from Secrets Manager. Never allow an inherited
# xtrace setting to expand them into task logs.
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
MIGRATION_ROLE="${ALPHANET_MIGRATION_ROLE:-alphanet_migration}"
RUNTIME_ROLE="${ALPHANET_RUNTIME_ROLE:-alphanet_runtime}"

validate_role_name() {
  local role_name="$1"
  local variable_name="$2"
  if [[ ! "${role_name}" =~ ^alphanet_[a-z0-9_]{1,53}$ ]]; then
    echo "${variable_name} must match ^alphanet_[a-z0-9_]{1,53}$." >&2
    exit 2
  fi
}

validate_role_name "${MIGRATION_ROLE}" ALPHANET_MIGRATION_ROLE
validate_role_name "${RUNTIME_ROLE}" ALPHANET_RUNTIME_ROLE
if [[ "${MIGRATION_ROLE}" == "${RUNTIME_ROLE}" ]]; then
  echo "Migration and runtime roles must be distinct." >&2
  exit 2
fi
if [[ -z "${ALPHANET_MIGRATION_PASSWORD:-}" ]]; then
  echo "ALPHANET_MIGRATION_PASSWORD must be injected from Secrets Manager." >&2
  exit 2
fi
if [[ -z "${ALPHANET_RUNTIME_PASSWORD:-}" ]]; then
  echo "ALPHANET_RUNTIME_PASSWORD must be injected from Secrets Manager." >&2
  exit 2
fi
secret_is_valid() {
  local value="$1"
  local unique_character_count

  if (( ${#value} < 32 || ${#value} > 1024 )); then
    return 1
  fi
  if [[ "${value}" =~ [[:cntrl:]] ]]; then
    return 1
  fi
  unique_character_count="$(
    printf '%s' "${value}" | fold -w 1 | sort -u | wc -l | tr -d '[:space:]'
  )"
  [[ "${unique_character_count}" =~ ^[0-9]+$ ]] &&
    (( unique_character_count >= 12 ))
}

if ! secret_is_valid "${ALPHANET_MIGRATION_PASSWORD}"; then
  echo "ALPHANET_MIGRATION_PASSWORD must be a 32-1024 byte secret with at least 12 distinct non-control characters." >&2
  exit 2
fi
if ! secret_is_valid "${ALPHANET_RUNTIME_PASSWORD}"; then
  echo "ALPHANET_RUNTIME_PASSWORD must be a 32-1024 byte secret with at least 12 distinct non-control characters." >&2
  exit 2
fi
if [[ "${ALPHANET_MIGRATION_PASSWORD}" == "${ALPHANET_RUNTIME_PASSWORD}" ]]; then
  echo "Migration and runtime passwords must be distinct." >&2
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required to bootstrap the AlphaNet AWS database." >&2
  exit 127
fi

psql \
  -X \
  --set=ON_ERROR_STOP=1 \
  --set=VERBOSITY=terse \
  --set="migration_role=${MIGRATION_ROLE}" \
  --set="runtime_role=${RUNTIME_ROLE}" \
  --file="${DB_DIR}/aws/bootstrap.sql"

# psql's \password command derives each SCRAM verifier client-side. The four
# prompt lines travel only over stdin. Both verifier updates and LOGIN enables
# share one transaction, so a closed connection rolls the complete pair back.
# The SQL bootstrap creates a new role as NOLOGIN and preserves an existing
# role's login state until this atomic credential step succeeds.
printf '%s\n%s\n%s\n%s\n' \
  "${ALPHANET_MIGRATION_PASSWORD}" \
  "${ALPHANET_MIGRATION_PASSWORD}" \
  "${ALPHANET_RUNTIME_PASSWORD}" \
  "${ALPHANET_RUNTIME_PASSWORD}" | \
  psql \
    -X \
    --set=ON_ERROR_STOP=1 \
    --set=VERBOSITY=terse \
    --command="BEGIN" \
    --command="SET LOCAL log_statement = 'none'" \
    --command="SET LOCAL log_min_error_statement = 'panic'" \
    --command="SET LOCAL log_parameter_max_length = 0" \
    --command="SET LOCAL log_parameter_max_length_on_error = 0" \
    --command="SET LOCAL password_encryption = 'scram-sha-256'" \
    --command="\\password ${MIGRATION_ROLE}" \
    --command="\\password ${RUNTIME_ROLE}" \
    --command="ALTER ROLE ${MIGRATION_ROLE} LOGIN VALID UNTIL 'infinity'; ALTER ROLE ${RUNTIME_ROLE} LOGIN VALID UNTIL 'infinity'" \
    --command="COMMIT"

unset ALPHANET_MIGRATION_PASSWORD ALPHANET_RUNTIME_PASSWORD
