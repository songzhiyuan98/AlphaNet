#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
MIGRATION_ROLE="${ALPHANET_MIGRATION_ROLE:-alphanet_migration}"
RUNTIME_ROLE="${ALPHANET_RUNTIME_ROLE:-alphanet_runtime}"
DATABASE_GRANTEE="alphanet_acl_test_database_grantee"
OBJECT_GRANTEE="alphanet_acl_test_object_grantee"
RUNTIME_MEMBER="alphanet_acl_test_runtime_member"
MIGRATION_MEMBER="alphanet_acl_test_migration_member"
OUTBOUND_ROLE="alphanet_acl_test_outbound_role"
NONOWNER_ROLE="alphanet_acl_test_nonowner"

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
if [[ "${ALPHANET_ALLOW_DESTRUCTIVE_ACL_TEST:-}" != "1" ]]; then
  echo "Set ALPHANET_ALLOW_DESTRUCTIVE_ACL_TEST=1 only for a disposable PostgreSQL 17 database." >&2
  exit 2
fi
if [[ -z "${ALPHANET_MIGRATION_PASSWORD:-}" || -z "${ALPHANET_RUNTIME_PASSWORD:-}" ]]; then
  echo "Both AlphaNet test passwords are required so bootstrap and migration-role verification can run." >&2
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required to test AlphaNet ACL reconciliation." >&2
  exit 127
fi

admin_psql() {
  psql \
    -X \
    --set=ON_ERROR_STOP=1 \
    --set=VERBOSITY=terse \
    "$@"
}

query_scalar() {
  admin_psql --tuples-only --no-align --command="$1" | tr -d '[:space:]'
}

cleanup_database_artifacts() {
  admin_psql \
    --set="migration_role=${MIGRATION_ROLE}" \
    --set="runtime_role=${RUNTIME_ROLE}" \
    --set="database_grantee=${DATABASE_GRANTEE}" \
    --set="object_grantee=${OBJECT_GRANTEE}" \
    --set="runtime_member=${RUNTIME_MEMBER}" \
    --set="migration_member=${MIGRATION_MEMBER}" \
    --set="outbound_role=${OUTBOUND_ROLE}" \
    --set="nonowner_role=${NONOWNER_ROLE}" <<'SQL'
SELECT format('REVOKE %I FROM %I', :'outbound_role', :'migration_role')
WHERE to_regrole(:'outbound_role') IS NOT NULL
  AND to_regrole(:'migration_role') IS NOT NULL
\gexec
SELECT format('REVOKE %I FROM %I', :'outbound_role', :'runtime_role')
WHERE to_regrole(:'outbound_role') IS NOT NULL
  AND to_regrole(:'runtime_role') IS NOT NULL
\gexec
SELECT format('REVOKE %I FROM %I', :'runtime_role', :'runtime_member')
WHERE to_regrole(:'runtime_role') IS NOT NULL
  AND to_regrole(:'runtime_member') IS NOT NULL
\gexec
SELECT format('REVOKE %I FROM %I', :'migration_role', :'migration_member')
WHERE to_regrole(:'migration_role') IS NOT NULL
  AND to_regrole(:'migration_member') IS NOT NULL
\gexec

SELECT format(
  'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I',
  current_database(),
  role.rolname
)
FROM pg_catalog.pg_roles AS role
WHERE role.rolname IN (
  :'database_grantee',
  :'object_grantee',
  :'runtime_member',
  :'migration_member',
  :'outbound_role',
  :'nonowner_role'
)
ORDER BY role.rolname
\gexec

SELECT format('SET ROLE %I', :'migration_role')
WHERE to_regrole(:'migration_role') IS NOT NULL
\gexec
DROP FUNCTION IF EXISTS platform.__alphanet_acl_reconciliation_probe();
DROP SEQUENCE IF EXISTS platform.__alphanet_acl_reconciliation_probe_sequence;
RESET ROLE;

SELECT format('DROP OWNED BY %I', role.rolname)
FROM pg_catalog.pg_roles AS role
WHERE role.rolname IN (
  :'database_grantee',
  :'object_grantee',
  :'runtime_member',
  :'migration_member',
  :'outbound_role',
  :'nonowner_role'
)
ORDER BY role.rolname
\gexec
SELECT format('DROP ROLE %I', role.rolname)
FROM pg_catalog.pg_roles AS role
WHERE role.rolname IN (
  :'database_grantee',
  :'object_grantee',
  :'runtime_member',
  :'migration_member',
  :'outbound_role',
  :'nonowner_role'
)
ORDER BY role.rolname
\gexec
SQL
}

failure_output="$(mktemp)"
cleanup() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT
  set +e
  cleanup_database_artifacts >/dev/null 2>&1 || cleanup_status=$?
  rm -f "${failure_output}"
  if (( original_status == 0 && cleanup_status != 0 )); then
    echo "Failed to clean up the ACL reconciliation test fixtures." >&2
    exit "${cleanup_status}"
  fi
  exit "${original_status}"
}
trap cleanup EXIT

server_major="$(query_scalar "SELECT current_setting('server_version_num')::integer / 10000")"
if [[ "${server_major}" != "17" ]]; then
  echo "The ACL reconciliation regression must run against PostgreSQL 17; connected major is ${server_major}." >&2
  exit 2
fi

owner_status="$(query_scalar "
  SELECT (role.rolname = current_user AND role.rolsuper)::text
  FROM pg_catalog.pg_database AS database
  JOIN pg_catalog.pg_roles AS role ON role.oid = database.datdba
  WHERE database.datname = current_database()
")"
if [[ "${owner_status}" != "true" ]]; then
  echo "The destructive ACL regression must connect as the current database owner and a disposable-test superuser." >&2
  exit 2
fi
if [[ "$(query_scalar "SELECT to_regclass('platform.communities') IS NOT NULL")" != "t" ]]; then
  echo "Run all AlphaNet migrations before the ACL reconciliation regression." >&2
  exit 2
fi
if [[ "$(query_scalar "SELECT to_regrole('${MIGRATION_ROLE}') IS NOT NULL AND to_regrole('${RUNTIME_ROLE}') IS NOT NULL")" != "t" ]]; then
  echo "Run the AlphaNet database bootstrap before the ACL reconciliation regression." >&2
  exit 2
fi

cleanup_database_artifacts >/dev/null

admin_psql \
  --set="migration_role=${MIGRATION_ROLE}" \
  --set="runtime_role=${RUNTIME_ROLE}" \
  --set="database_grantee=${DATABASE_GRANTEE}" \
  --set="object_grantee=${OBJECT_GRANTEE}" \
  --set="runtime_member=${RUNTIME_MEMBER}" \
  --set="migration_member=${MIGRATION_MEMBER}" \
  --set="outbound_role=${OUTBOUND_ROLE}" \
  --set="nonowner_role=${NONOWNER_ROLE}" <<'SQL'
SELECT current_database() AS database_name
\gset

SELECT format('CREATE ROLE %I NOLOGIN', role_name)
FROM unnest(ARRAY[
  :'database_grantee',
  :'object_grantee',
  :'runtime_member',
  :'migration_member',
  :'outbound_role',
  :'nonowner_role'
]) AS role_name
ORDER BY role_name
\gexec

-- Model a prototype deployment whose database owner created AlphaNet objects
-- before the migration role was adopted. Bootstrap must transfer ownership and
-- still remove ACLs originally granted by that legacy owner.
CREATE SEQUENCE platform.__alphanet_acl_reconciliation_probe_sequence;
CREATE FUNCTION platform.__alphanet_acl_reconciliation_probe()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS 'SELECT 1';

GRANT CONNECT, CREATE, TEMPORARY ON DATABASE :"database_name"
TO :"database_grantee";
GRANT USAGE, CREATE ON SCHEMA platform TO :"object_grantee";
GRANT SELECT, UPDATE ON TABLE platform.communities TO :"object_grantee";
GRANT SELECT ON TABLE platform.communities TO PUBLIC;
GRANT SELECT, USAGE, UPDATE
ON SEQUENCE platform.__alphanet_acl_reconciliation_probe_sequence
TO :"object_grantee", PUBLIC;
GRANT EXECUTE ON FUNCTION platform.__alphanet_acl_reconciliation_probe()
TO :"object_grantee", PUBLIC;

GRANT :"runtime_role" TO :"runtime_member";
GRANT :"migration_role" TO :"migration_member";
GRANT :"outbound_role" TO :"migration_role", :"runtime_role";
SQL

/bin/bash "${SCRIPT_DIR}/aws-bootstrap-database.sh" >/dev/null

unexpected_acl_count="$(admin_psql \
  --tuples-only \
  --no-align \
  --set="migration_role=${MIGRATION_ROLE}" \
  --set="runtime_role=${RUNTIME_ROLE}" <<'SQL'
WITH allowed_database_grantee AS (
  SELECT database.datdba AS role_oid
  FROM pg_catalog.pg_database AS database
  WHERE database.datname = current_database()
  UNION ALL SELECT to_regrole(:'migration_role')
  UNION ALL SELECT to_regrole(:'runtime_role')
),
actual_acl AS (
  SELECT 'database'::text AS object_kind, privilege.grantee
  FROM pg_catalog.pg_database AS database
  CROSS JOIN LATERAL aclexplode(
    coalesce(database.datacl, acldefault('d', database.datdba))
  ) AS privilege
  WHERE database.datname = current_database()
    AND privilege.grantee NOT IN (
      SELECT role_oid FROM allowed_database_grantee
    )

  UNION ALL

  SELECT 'schema', privilege.grantee
  FROM pg_catalog.pg_namespace AS namespace
  CROSS JOIN LATERAL aclexplode(
    coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
  ) AS privilege
  WHERE namespace.nspname IN ('auth', 'platform', 'system')
    AND privilege.grantee NOT IN (
      to_regrole(:'migration_role'),
      to_regrole(:'runtime_role')
    )

  UNION ALL

  SELECT 'relation', privilege.grantee
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  CROSS JOIN LATERAL aclexplode(
    coalesce(
      relation.relacl,
      acldefault(CASE relation.relkind WHEN 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
        relation.relowner)
    )
  ) AS privilege
  WHERE namespace.nspname IN ('auth', 'platform', 'system')
    AND relation.relkind IN ('f', 'm', 'p', 'r', 'S', 'v')
    AND privilege.grantee NOT IN (
      to_regrole(:'migration_role'),
      to_regrole(:'runtime_role')
    )

  UNION ALL

  SELECT 'column', privilege.grantee
  FROM pg_catalog.pg_attribute AS attribute
  JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
  WHERE namespace.nspname IN ('auth', 'platform', 'system')
    AND relation.relkind IN ('f', 'm', 'p', 'r', 'v')
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
    AND privilege.grantee NOT IN (
      to_regrole(:'migration_role'),
      to_regrole(:'runtime_role')
    )

  UNION ALL

  SELECT 'routine', privilege.grantee
  FROM pg_catalog.pg_proc AS routine
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = routine.pronamespace
  CROSS JOIN LATERAL aclexplode(
    coalesce(routine.proacl, acldefault('f', routine.proowner))
  ) AS privilege
  WHERE namespace.nspname IN ('auth', 'platform', 'system')
    AND privilege.grantee NOT IN (
      to_regrole(:'migration_role'),
      to_regrole(:'runtime_role')
    )
)
SELECT count(*) FROM actual_acl;
SQL
)"
if [[ "${unexpected_acl_count}" != "0" ]]; then
  echo "Bootstrap left ${unexpected_acl_count} unauthorized database/schema/object ACL entries." >&2
  exit 1
fi

membership_is_closed="$(admin_psql \
  --tuples-only \
  --no-align \
  --set="migration_role=${MIGRATION_ROLE}" \
  --set="runtime_role=${RUNTIME_ROLE}" <<'SQL'
WITH database_owner AS (
  SELECT database.datdba AS role_oid
  FROM pg_catalog.pg_database AS database
  WHERE database.datname = current_database()
)
SELECT
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.member IN (
      to_regrole(:'migration_role'),
      to_regrole(:'runtime_role')
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = to_regrole(:'runtime_role')
  )
  AND (
    SELECT count(*) = 1
      AND bool_and(
        membership.member = database_owner.role_oid
        AND membership.admin_option
      )
    FROM pg_catalog.pg_auth_members AS membership
    CROSS JOIN database_owner
    WHERE membership.roleid = to_regrole(:'migration_role')
  );
SQL
)"
if [[ "${membership_is_closed}" != "t" ]]; then
  echo "Bootstrap did not close AlphaNet role membership in both directions." >&2
  exit 1
fi

# Reintroduce object-only drift. The migration-owned per-release reconciler
# must be able to remove this safely without receiving database-owner powers.
admin_psql \
  --set="migration_role=${MIGRATION_ROLE}" \
  --set="object_grantee=${OBJECT_GRANTEE}" <<'SQL'
SET ROLE :"migration_role";
GRANT CREATE ON SCHEMA platform TO :"object_grantee";
GRANT SELECT (name) ON TABLE platform.communities TO :"object_grantee";
GRANT SELECT ON TABLE platform.communities TO PUBLIC;
GRANT SELECT, USAGE, UPDATE
ON SEQUENCE platform.__alphanet_acl_reconciliation_probe_sequence
TO :"object_grantee", PUBLIC;
GRANT EXECUTE ON FUNCTION platform.__alphanet_acl_reconciliation_probe()
TO :"object_grantee", PUBLIC;
RESET ROLE;
SQL

env \
  PGUSER="${MIGRATION_ROLE}" \
  PGPASSWORD="${ALPHANET_MIGRATION_PASSWORD}" \
  /bin/bash "${SCRIPT_DIR}/aws-apply-runtime-privileges.sh" >/dev/null

# Execute the Remote MCP OAuth helper chain under the real Runtime role. The
# verifier checks the exact ACL inventory; this probe additionally catches a
# helper-to-helper EXECUTE dependency that would otherwise surface only when
# the Provider first inserts a constrained row.
oauth_runtime_acl_is_usable="$(admin_psql \
  --quiet \
  --tuples-only \
  --no-align \
  --set="runtime_role=${RUNTIME_ROLE}" <<'SQL'
SET ROLE :"runtime_role";
SELECT
  platform.oauth_requested_scopes_are_valid(
    ARRAY['research:read', 'offline_access']::text[]
  )
  AND platform.oauth_provider_scopes_are_valid(
    '["research:read", "offline_access"]'::jsonb
  )
  AND platform.oauth_redirect_uris_are_valid(
    '["https://client.example/oauth/callback"]'::jsonb
  )
  AND platform.oauth_resource_is_valid('https://mcp.example/mcp')
  AND platform.oauth_text_arrays_are_same_set(
    ARRAY['community:read', 'research:read']::text[],
    ARRAY['research:read', 'community:read']::text[]
  )
  AND has_table_privilege(current_user, 'auth.oauth_clients', 'SELECT')
  AND NOT has_table_privilege(current_user, 'auth.oauth_clients', 'INSERT,UPDATE,DELETE')
  AND has_table_privilege(current_user, 'auth.oauth_jwks', 'SELECT,INSERT')
  AND NOT has_table_privilege(current_user, 'auth.oauth_jwks', 'UPDATE,DELETE')
  AND has_table_privilege(
    current_user,
    'platform.oauth_resource_configuration',
    'SELECT'
  )
  AND NOT has_table_privilege(
    current_user,
    'platform.oauth_resource_configuration',
    'INSERT,UPDATE,DELETE'
  );
RESET ROLE;
SQL
)"
if [[ "${oauth_runtime_acl_is_usable//[[:space:]]/}" != "t" ]]; then
  echo "Remote MCP OAuth Runtime ACL or validation-helper execution is incomplete." >&2
  exit 1
fi

# Exercise the Content Outbox CHECK helper through the real table-write path,
# not only through the verifier's ACL inventory. Roll the probe back so it can
# never become application data.
admin_psql \
  --quiet \
  --set="runtime_role=${RUNTIME_ROLE}" <<'SQL'
BEGIN;
SET LOCAL ROLE :"runtime_role";
INSERT INTO system.outbox_events (
  id,
  aggregate_type,
  aggregate_id,
  aggregate_sequence,
  event_type,
  event_version,
  payload
)
VALUES (
  'ffffffff-ffff-4fff-8fff-fffffffffff1',
  'acl_probe',
  'runtime-content-helper',
  1,
  'acl.probe',
  1,
  '{}'::jsonb
);
ROLLBACK;
SQL

object_acl_is_closed="$(admin_psql \
  --tuples-only \
  --no-align \
  --set="object_grantee=${OBJECT_GRANTEE}" <<'SQL'
SELECT NOT EXISTS (
  SELECT 1
  FROM (
    SELECT privilege.grantee
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
    ) AS privilege
    WHERE namespace.nspname = 'platform'

    UNION ALL

    SELECT privilege.grantee
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(
        relation.relacl,
        acldefault(CASE relation.relkind WHEN 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
          relation.relowner)
      )
    ) AS privilege
    WHERE namespace.nspname = 'platform'
      AND relation.relname IN (
        'communities',
        '__alphanet_acl_reconciliation_probe_sequence'
      )

    UNION ALL

    SELECT privilege.grantee
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
    WHERE namespace.nspname = 'platform'
      AND relation.relname = 'communities'
      AND attribute.attname = 'name'

    UNION ALL

    SELECT privilege.grantee
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(routine.proacl, acldefault('f', routine.proowner))
    ) AS privilege
    WHERE namespace.nspname = 'platform'
      AND routine.proname = '__alphanet_acl_reconciliation_probe'
  ) AS privilege
  WHERE privilege.grantee IN (0, to_regrole(:'object_grantee'))
);
SQL
)"
if [[ "${object_acl_is_closed}" != "t" ]]; then
  echo "Per-release reconciliation left PUBLIC or legacy object ACL entries." >&2
  exit 1
fi

expect_verifier_failure() {
  local expected_message="$1"
  if env \
    PGUSER="${MIGRATION_ROLE}" \
    PGPASSWORD="${ALPHANET_MIGRATION_PASSWORD}" \
    /bin/bash "${SCRIPT_DIR}/aws-verify-runtime-privileges.sh" \
    >"${failure_output}" 2>&1; then
    echo "Privilege verification unexpectedly accepted: ${expected_message}" >&2
    exit 1
  fi
  if ! grep -Fq "${expected_message}" "${failure_output}"; then
    echo "Privilege verification failed for an unexpected reason; wanted: ${expected_message}" >&2
    sed -n '1,80p' "${failure_output}" >&2
    exit 1
  fi
}

# The verifier, unlike the reconciler, must fail closed on drift that only the
# database owner can repair.
admin_psql \
  --set="database_grantee=${DATABASE_GRANTEE}" <<'SQL'
SELECT current_database() AS database_name
\gset
GRANT CONNECT ON DATABASE :"database_name" TO :"database_grantee";
SQL
expect_verifier_failure "Unauthorized AlphaNet database ACL grantees"
admin_psql \
  --set="database_grantee=${DATABASE_GRANTEE}" <<'SQL'
SELECT current_database() AS database_name
\gset
REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM :"database_grantee";
SQL

admin_psql \
  --set="runtime_role=${RUNTIME_ROLE}" \
  --set="runtime_member=${RUNTIME_MEMBER}" <<'SQL'
GRANT :"runtime_role" TO :"runtime_member";
SQL
expect_verifier_failure "Runtime role has unexpected members"
admin_psql \
  --set="runtime_role=${RUNTIME_ROLE}" \
  --set="runtime_member=${RUNTIME_MEMBER}" <<'SQL'
REVOKE :"runtime_role" FROM :"runtime_member";
SQL

admin_psql \
  --set="migration_role=${MIGRATION_ROLE}" \
  --set="migration_member=${MIGRATION_MEMBER}" <<'SQL'
GRANT :"migration_role" TO :"migration_member";
SQL
expect_verifier_failure "Migration role has unexpected members"
admin_psql \
  --set="migration_role=${MIGRATION_ROLE}" \
  --set="migration_member=${MIGRATION_MEMBER}" <<'SQL'
REVOKE :"migration_role" FROM :"migration_member";
SQL

admin_psql \
  --set="object_grantee=${OBJECT_GRANTEE}" \
  --set="migration_role=${MIGRATION_ROLE}" <<'SQL'
SET ROLE :"migration_role";
GRANT SELECT (name) ON TABLE platform.communities TO :"object_grantee";
RESET ROLE;
SQL
expect_verifier_failure "Unauthorized AlphaNet relation ACL grantees"
admin_psql \
  --set="object_grantee=${OBJECT_GRANTEE}" \
  --set="migration_role=${MIGRATION_ROLE}" <<'SQL'
SET ROLE :"migration_role";
REVOKE ALL ON TABLE platform.communities FROM :"object_grantee";
RESET ROLE;
SQL

# A role that is not the current database owner must be rejected before any
# bootstrap mutation begins.
if admin_psql \
  --set="migration_role=${MIGRATION_ROLE}" \
  --set="runtime_role=${RUNTIME_ROLE}" \
  --command="SET ROLE \"${NONOWNER_ROLE}\"" \
  --file="${DB_DIR}/aws/bootstrap.sql" \
  >"${failure_output}" 2>&1; then
  echo "Bootstrap unexpectedly accepted a non-owner identity." >&2
  exit 1
fi
if ! grep -Fq "Bootstrap must run as the current database owner" "${failure_output}"; then
  echo "Non-owner bootstrap failed for an unexpected reason." >&2
  sed -n '1,80p' "${failure_output}" >&2
  exit 1
fi

env \
  PGUSER="${MIGRATION_ROLE}" \
  PGPASSWORD="${ALPHANET_MIGRATION_PASSWORD}" \
  /bin/bash "${SCRIPT_DIR}/aws-verify-runtime-privileges.sh" >/dev/null

cleanup_database_artifacts >/dev/null
trap - EXIT
rm -f "${failure_output}"

echo "AlphaNet database ACL allowlists and bidirectional role membership are reconciled and fail closed."
