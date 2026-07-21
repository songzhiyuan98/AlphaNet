#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
MIGRATION_ROLE="${ALPHANET_MIGRATION_ROLE:-alphanet_migration}"
RUNTIME_ROLE="${ALPHANET_RUNTIME_ROLE:-alphanet_runtime}"

for role_name in "${MIGRATION_ROLE}" "${RUNTIME_ROLE}"; do
  if [[ ! "${role_name}" =~ ^alphanet_[a-z0-9_]{1,53}$ ]]; then
    echo "AlphaNet database role names must match ^alphanet_[a-z0-9_]{1,53}$." >&2
    exit 2
  fi
done
if [[ "${MIGRATION_ROLE}" == "${RUNTIME_ROLE}" ]]; then
  echo "Migration and runtime roles must be distinct." >&2
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required to verify AlphaNet runtime privileges." >&2
  exit 127
fi

psql \
  -X \
  --single-transaction \
  --set=ON_ERROR_STOP=1 \
  --set=VERBOSITY=terse \
  --set="migration_role=${MIGRATION_ROLE}" \
  --set="runtime_role=${RUNTIME_ROLE}" \
  --file="${DB_DIR}/aws/verify-runtime-privileges.sql"
