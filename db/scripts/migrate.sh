#!/usr/bin/env bash
set -Eeuo pipefail

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/opt/alphanet/db/migrations}"

# The Compose migration job supplies PG* variables directly. During
# /docker-entrypoint-initdb.d, derive them from the official image variables.
export PGHOST="${PGHOST:-/var/run/postgresql}"
export PGPORT="${PGPORT:-5432}"
export PGDATABASE="${PGDATABASE:-${POSTGRES_DB:-postgres}}"
export PGUSER="${PGUSER:-${POSTGRES_USER:-postgres}}"
export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required to run AlphaNet migrations." >&2
  exit 127
fi

if command -v sha256sum >/dev/null 2>&1; then
  checksum_file() {
    sha256sum "$1" | awk '{print $1}'
  }
elif command -v shasum >/dev/null 2>&1; then
  checksum_file() {
    shasum -a 256 "$1" | awk '{print $1}'
  }
else
  echo "sha256sum or shasum is required to verify migrations." >&2
  exit 127
fi

PSQL=(
  psql
  -X
  --set=ON_ERROR_STOP=1
  --set=VERBOSITY=terse
)

"${PSQL[@]}" <<'SQL'
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('alphanet:schema-migrations', 0));
CREATE SCHEMA IF NOT EXISTS system;
CREATE TABLE IF NOT EXISTS system.schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  checksum char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_by text NOT NULL DEFAULT current_user,
  CONSTRAINT schema_migrations_version_format
    CHECK (version ~ '^[0-9]{6}$'),
  CONSTRAINT schema_migrations_checksum_format
    CHECK (checksum ~ '^[0-9a-f]{64}$')
);
COMMIT;
SQL

shopt -s nullglob
migration_files=("${MIGRATIONS_DIR}"/*.up.sql)
shopt -u nullglob

if ((${#migration_files[@]} == 0)); then
  echo "No migrations found in ${MIGRATIONS_DIR}." >&2
  exit 2
fi

IFS=$'\n' migration_files=($(printf '%s\n' "${migration_files[@]}" | LC_ALL=C sort))
unset IFS

for migration_file in "${migration_files[@]}"; do
  migration_basename="$(basename "${migration_file}")"

  if [[ ! "${migration_basename}" =~ ^([0-9]{6})_([a-z0-9_]+)\.up\.sql$ ]]; then
    echo "Invalid migration filename: ${migration_basename}" >&2
    echo "Expected NNNNNN_lower_snake_case.up.sql." >&2
    exit 2
  fi

  migration_version="${BASH_REMATCH[1]}"
  migration_name="${BASH_REMATCH[2]}"
  migration_checksum="$(checksum_file "${migration_file}")"
  migration_plan="$(mktemp)"
  trap 'rm -f "${migration_plan:-}"' EXIT

  {
    printf '%s\n' '\set ON_ERROR_STOP on'
    printf '%s\n' 'BEGIN;'
    printf "%s\n" "SELECT pg_advisory_xact_lock(hashtextextended('alphanet:schema-migrations', 0));"
    printf "%s\n" "SELECT EXISTS (SELECT 1 FROM system.schema_migrations WHERE version = '${migration_version}') AS migration_exists,"
    printf "%s\n" "       COALESCE((SELECT checksum = '${migration_checksum}' FROM system.schema_migrations WHERE version = '${migration_version}'), false) AS checksum_matches"
    printf '%s\n' '\gset'
    printf '%s\n' '\if :migration_exists'
    printf '%s\n' '  \if :checksum_matches'
    printf "%s\n" "    \\echo 'Already applied ${migration_basename}'"
    printf '%s\n' '  \else'
    printf "%s\n" "    \\echo 'Checksum mismatch for ${migration_basename}'"
    printf '%s\n' '    \quit 3'
    printf '%s\n' '  \endif'
    printf '%s\n' '\else'
    printf "%s\n" "  \\echo 'Applying ${migration_basename}'"
    printf "%s\n" "  \\i '${migration_file}'"
    printf "%s\n" "  INSERT INTO system.schema_migrations (version, name, checksum)"
    printf "%s\n" "  VALUES ('${migration_version}', '${migration_name}', '${migration_checksum}');"
    printf '%s\n' '\endif'
    printf '%s\n' 'COMMIT;'
  } >"${migration_plan}"

  "${PSQL[@]}" --file="${migration_plan}"
  rm -f "${migration_plan}"
  trap - EXIT
done

echo "AlphaNet migrations are current."
