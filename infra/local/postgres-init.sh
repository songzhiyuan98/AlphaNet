#!/usr/bin/env bash
set -Eeuo pipefail

# The official Postgres entrypoint sources this file after creating an empty
# database. Existing volumes are migrated explicitly through the Compose tool
# profile; see infra/local/README.md.
export PGHOST="${PGHOST:-/var/run/postgresql}"
export PGPORT="${PGPORT:-5432}"
export PGDATABASE="${PGDATABASE:-${POSTGRES_DB}}"
export PGUSER="${PGUSER:-${POSTGRES_USER}}"
export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD}}"

/bin/bash /opt/alphanet/db/scripts/migrate.sh

case "${ALPHANET_LOAD_SEED:-true}" in
  true | TRUE | 1 | yes | YES)
    /bin/bash /opt/alphanet/db/scripts/seed.sh
    ;;
  false | FALSE | 0 | no | NO)
    echo "AlphaNet local seed disabled."
    ;;
  *)
    echo "Invalid ALPHANET_LOAD_SEED value: ${ALPHANET_LOAD_SEED}" >&2
    exit 2
    ;;
esac
