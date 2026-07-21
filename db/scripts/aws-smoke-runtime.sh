#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
RUNTIME_ROLE="${ALPHANET_RUNTIME_ROLE:-alphanet_runtime}"

if [[ ! "${RUNTIME_ROLE}" =~ ^alphanet_[a-z0-9_]{1,53}$ ]]; then
  echo "ALPHANET_RUNTIME_ROLE must match ^alphanet_[a-z0-9_]{1,53}$." >&2
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required to smoke-test AlphaNet runtime privileges." >&2
  exit 127
fi

psql \
  -X \
  --set=ON_ERROR_STOP=1 \
  --set=VERBOSITY=terse \
  --set="runtime_role=${RUNTIME_ROLE}" \
  --file="${DB_DIR}/aws/runtime-smoke.sql"
