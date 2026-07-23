#!/usr/bin/env bash
set -Eeuo pipefail

OPERATIONS_DIR="${OPERATIONS_DIR:-/opt/alphanet/db/operations}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/opt/alphanet/db/migrations}"

for command_name in psql pg_dump pg_restore cmp sha256sum awk mktemp; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "${command_name} is required to verify an AlphaNet database recovery." >&2
    exit 127
  fi
done

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
: "${RECOVERY_DATABASE_URL:?RECOVERY_DATABASE_URL is required}"

manifest_sql="${OPERATIONS_DIR}/recovery-manifest.sql"
invariants_sql="${OPERATIONS_DIR}/recovery-invariants.sql"

for required_file in "${manifest_sql}" "${invariants_sql}"; do
  if [[ ! -r "${required_file}" || ! -s "${required_file}" ]]; then
    echo "Required recovery verifier is missing: ${required_file}" >&2
    exit 2
  fi
done

shopt -s nullglob
migration_files=("${MIGRATIONS_DIR}"/*.up.sql)
shopt -u nullglob

if ((${#migration_files[@]} == 0)); then
  echo "No release migrations found in ${MIGRATIONS_DIR}." >&2
  exit 2
fi

mapfile -t migration_files < <(
  printf '%s\n' "${migration_files[@]}" | LC_ALL=C sort
)
latest_migration_index="$((${#migration_files[@]} - 1))"
latest_migration_basename="$(basename "${migration_files[${latest_migration_index}]}")"

if [[ ! "${latest_migration_basename}" =~ ^([0-9]{6})_[a-z0-9_]+\.up\.sql$ ]]; then
  echo "Latest release migration has an invalid filename." >&2
  exit 2
fi

expected_migration_version="${BASH_REMATCH[1]}"
temporary_directory="$(mktemp -d)"
dump_file="${temporary_directory}/source.dump"
source_manifest_before="${temporary_directory}/source-before.csv"
source_manifest_after="${temporary_directory}/source-after.csv"
recovery_manifest="${temporary_directory}/recovery.csv"
started_at_epoch="$(date +%s)"

cleanup() {
  rm -rf "${temporary_directory}"
}
trap cleanup EXIT

psql_options=(
  -X
  --quiet
  --set=ON_ERROR_STOP=1
  --set=VERBOSITY=terse
  --no-psqlrc
)

database_identity() {
  local database_url="$1"
  psql "${psql_options[@]}" \
    --dbname="${database_url}" \
    --tuples-only \
    --no-align \
    --field-separator='|' \
    --command="
      SELECT
        current_database(),
        COALESCE(inet_server_addr()::text, 'local'),
        inet_server_port(),
        pg_postmaster_start_time()
    "
}

migration_version() {
  local database_url="$1"
  psql "${psql_options[@]}" \
    --dbname="${database_url}" \
    --tuples-only \
    --no-align \
    --command="
      SELECT COALESCE(max(version), '')
      FROM system.schema_migrations
    "
}

table_count() {
  local database_url="$1"
  psql "${psql_options[@]}" \
    --dbname="${database_url}" \
    --tuples-only \
    --no-align \
    --command="
      SELECT count(*)
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE relation.relkind IN ('r', 'p')
        AND namespace.nspname NOT IN (
          'information_schema',
          'pg_catalog',
          'pg_toast'
        )
        AND namespace.nspname !~ '^pg_temp_'
        AND namespace.nspname !~ '^pg_toast_temp_'
    "
}

write_manifest() {
  local database_url="$1"
  local output_file="$2"
  psql "${psql_options[@]}" \
    --dbname="${database_url}" \
    --file="${manifest_sql}" \
    >"${output_file}"
}

source_identity="$(database_identity "${SOURCE_DATABASE_URL}")"
recovery_identity="$(database_identity "${RECOVERY_DATABASE_URL}")"

if [[ "${source_identity}" == "${recovery_identity}" ]]; then
  echo "Source and recovery targets resolve to the same database." >&2
  exit 2
fi

if [[ "$(table_count "${RECOVERY_DATABASE_URL}")" != "0" ]]; then
  echo "Recovery target must be an empty, isolated database." >&2
  exit 2
fi

source_migration_version="$(migration_version "${SOURCE_DATABASE_URL}")"
if [[ "${source_migration_version}" != "${expected_migration_version}" ]]; then
  echo "Source schema does not match the release migration inventory." >&2
  exit 3
fi

write_manifest "${SOURCE_DATABASE_URL}" "${source_manifest_before}"

pg_dump \
  --dbname="${SOURCE_DATABASE_URL}" \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges \
  --serializable-deferrable \
  --file="${dump_file}"

write_manifest "${SOURCE_DATABASE_URL}" "${source_manifest_after}"

if ! cmp --silent "${source_manifest_before}" "${source_manifest_after}"; then
  echo "Source changed during verification; use a quiescent snapshot/PITR clone." >&2
  exit 4
fi

pg_restore \
  --dbname="${RECOVERY_DATABASE_URL}" \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  "${dump_file}"

recovery_migration_version="$(migration_version "${RECOVERY_DATABASE_URL}")"
if [[ "${recovery_migration_version}" != "${expected_migration_version}" ]]; then
  echo "Recovered schema does not match the release migration inventory." >&2
  exit 5
fi

psql "${psql_options[@]}" \
  --dbname="${RECOVERY_DATABASE_URL}" \
  --file="${invariants_sql}" \
  >/dev/null

write_manifest "${RECOVERY_DATABASE_URL}" "${recovery_manifest}"

if ! cmp --silent "${source_manifest_before}" "${recovery_manifest}"; then
  echo "Recovered database does not match the source manifest." >&2
  exit 6
fi

manifest_sha256="$(sha256sum "${recovery_manifest}" | awk '{print $1}')"
relation_count="$(awk -F',' 'NR > 1 { count += 1 } END { print count + 0 }' "${recovery_manifest}")"
row_count="$(awk -F',' 'NR > 1 { rows += $2 } END { printf "%.0f\n", rows + 0 }' "${recovery_manifest}")"
completed_at_epoch="$(date +%s)"
elapsed_seconds="$((completed_at_epoch - started_at_epoch))"

printf '%s\n' \
  "AlphaNet recovery verification passed." \
  "migration_version=${expected_migration_version}" \
  "relation_count=${relation_count}" \
  "row_count=${row_count}" \
  "manifest_sha256=${manifest_sha256}" \
  "elapsed_seconds=${elapsed_seconds}"
