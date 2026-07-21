#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION_ROLE="${ALPHANET_MIGRATION_ROLE:-alphanet_migration}"

if [[ ! "${MIGRATION_ROLE}" =~ ^alphanet_[a-z0-9_]{1,53}$ ]]; then
  echo "ALPHANET_MIGRATION_ROLE must match ^alphanet_[a-z0-9_]{1,53}$." >&2
  exit 2
fi
if [[ "${PGUSER:-}" != "${MIGRATION_ROLE}" ]]; then
  echo "The release database task must connect as ALPHANET_MIGRATION_ROLE." >&2
  exit 2
fi

echo "Applying forward-only AlphaNet migrations."
/bin/bash "${SCRIPT_DIR}/migrate.sh"

echo "Reconciling and atomically verifying the reviewed runtime privilege inventory."
/bin/bash "${SCRIPT_DIR}/aws-apply-runtime-privileges.sh"

echo "AlphaNet release database gate passed."
