#!/usr/bin/env bash
set -Eeuo pipefail

SEEDS_DIR="${SEEDS_DIR:-/opt/alphanet/db/seeds}"

# The Compose seed job supplies PG* variables directly. During
# /docker-entrypoint-initdb.d, derive them from the official image variables.
export PGHOST="${PGHOST:-/var/run/postgresql}"
export PGPORT="${PGPORT:-5432}"
export PGDATABASE="${PGDATABASE:-${POSTGRES_DB:-postgres}}"
export PGUSER="${PGUSER:-${POSTGRES_USER:-postgres}}"
export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required to seed AlphaNet." >&2
  exit 127
fi

shopt -s nullglob
seed_files=("${SEEDS_DIR}"/*.sql)
shopt -u nullglob

if ((${#seed_files[@]} == 0)); then
  echo "No seed files found in ${SEEDS_DIR}."
  exit 0
fi

IFS=$'\n' seed_files=($(printf '%s\n' "${seed_files[@]}" | LC_ALL=C sort))
unset IFS

for seed_file in "${seed_files[@]}"; do
  echo "Applying seed $(basename "${seed_file}")"
  psql \
    -X \
    --set=ON_ERROR_STOP=1 \
    --set=VERBOSITY=terse \
    --file="${seed_file}"
done

echo "AlphaNet local seeds are current."
