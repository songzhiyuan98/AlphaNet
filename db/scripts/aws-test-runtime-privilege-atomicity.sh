#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION_ROLE="${ALPHANET_MIGRATION_ROLE:-alphanet_migration}"
RUNTIME_ROLE="${ALPHANET_RUNTIME_ROLE:-alphanet_runtime}"
PROBE_TABLE="__alphanet_privilege_atomicity_probe"

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
if [[ "${PGUSER:-}" != "${MIGRATION_ROLE}" ]]; then
  echo "The atomicity test must connect as ALPHANET_MIGRATION_ROLE." >&2
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required to test AlphaNet runtime privilege atomicity." >&2
  exit 127
fi

failure_output="$(mktemp)"
cleanup() {
  local cleanup_status=0
  set +e
  psql \
    -X \
    --set=ON_ERROR_STOP=1 \
    --set=VERBOSITY=terse \
    --command="DROP TABLE IF EXISTS platform.${PROBE_TABLE}" \
    >/dev/null 2>&1 || cleanup_status=$?
  rm -f "${failure_output}"
  return "${cleanup_status}"
}
trap cleanup EXIT

psql \
  -X \
  --set=ON_ERROR_STOP=1 \
  --set=VERBOSITY=terse \
  --set="runtime_role=${RUNTIME_ROLE}" <<'SQL'
DROP TABLE IF EXISTS platform.__alphanet_privilege_atomicity_probe;
CREATE TABLE platform.__alphanet_privilege_atomicity_probe (
  id integer PRIMARY KEY
);
GRANT SELECT ON TABLE platform.__alphanet_privilege_atomicity_probe
TO :"runtime_role";
SQL

if /bin/bash "${SCRIPT_DIR}/aws-apply-runtime-privileges.sh" \
  >"${failure_output}" 2>&1; then
  echo "A stale privilege inventory unexpectedly passed verification." >&2
  exit 1
fi
if ! grep -Fq "Unclassified AlphaNet tables/views" "${failure_output}"; then
  echo "The stale privilege inventory failed for an unexpected reason." >&2
  exit 1
fi

probe_privilege="$({
  psql \
    -X \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --set="runtime_role=${RUNTIME_ROLE}" <<'SQL'
SELECT has_table_privilege(
  :'runtime_role',
  'platform.__alphanet_privilege_atomicity_probe',
  'SELECT'
);
SQL
} | tr -d '[:space:]')"
if [[ "${probe_privilege}" != "t" ]]; then
  echo "Failed privilege verification did not roll back the reconciler." >&2
  exit 1
fi

psql \
  -X \
  --set=ON_ERROR_STOP=1 \
  --set=VERBOSITY=terse \
  --command="DROP TABLE platform.${PROBE_TABLE}" \
  >/dev/null
trap - EXIT
rm -f "${failure_output}"

/bin/bash "${SCRIPT_DIR}/aws-verify-runtime-privileges.sh"
echo "AlphaNet runtime privilege reconciliation is atomic on verification failure."
