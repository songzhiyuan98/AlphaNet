\set ON_ERROR_STOP on
\set ECHO none

-- Run this file as the current RDS application-database owner, never as an
-- application process or a separate CREATEROLE administrator. Role names
-- arrive through psql variables that are validated by
-- db/scripts/aws-bootstrap-database.sh. Password validation and client-side
-- SCRAM derivation stay in that wrapper, so this SQL file never receives or
-- interpolates a cleartext password.

SELECT :'migration_role' <> :'runtime_role' AS roles_are_distinct
\gset
\if :roles_are_distinct
\else
  SELECT 1 / 0 AS migration_and_runtime_roles_must_be_distinct;
\endif

SELECT current_user <> :'migration_role'
   AND current_user <> :'runtime_role' AS bootstrap_uses_admin
\gset
\if :bootstrap_uses_admin
\else
  SELECT 1 / 0 AS bootstrap_must_use_a_separate_admin_identity;
\endif

DO $bootstrap_owner$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_database AS database
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = database.datdba
    WHERE database.datname = current_database()
      AND owner.rolname = current_user
  ) THEN
    RAISE EXCEPTION 'Bootstrap must run as the current database owner';
  END IF;
END;
$bootstrap_owner$;

BEGIN;

-- Fresh roles remain NOLOGIN until the wrapper atomically installs both
-- client-derived SCRAM verifiers and enables both identities. Existing roles
-- retain their login state while an idempotent repair runs.
SELECT format(
  'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'migration_role'
)
WHERE to_regrole(:'migration_role') IS NULL
\gexec

SELECT format(
  'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'runtime_role'
)
WHERE to_regrole(:'runtime_role') IS NULL
\gexec

SELECT format(
  'ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1',
  :'migration_role'
)
\gexec

SELECT format(
  'ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1',
  :'runtime_role'
)
\gexec

-- The database owner is the only permanent member of the migration role. It
-- needs ADMIN OPTION for idempotent ownership repair and break-glass password
-- rotation. Bootstrap removes every other inbound membership and every role
-- granted to either AlphaNet login. REVOKE ... CASCADE also removes grants
-- delegated through a stale ADMIN OPTION instead of leaving a hidden path.
SELECT format(
  'GRANT %I TO %I WITH ADMIN OPTION',
  :'migration_role',
  current_user
)
\gexec

SELECT format(
  'REVOKE %I FROM %I CASCADE',
  granted_role.rolname,
  member_role.rolname
)
FROM pg_catalog.pg_auth_members AS membership
JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
WHERE membership.member IN (
  to_regrole(:'migration_role'),
  to_regrole(:'runtime_role')
)
ORDER BY member_role.rolname, granted_role.rolname
\gexec

SELECT format(
  'REVOKE %I FROM %I CASCADE',
  :'runtime_role',
  member_role.rolname
)
FROM pg_catalog.pg_auth_members AS membership
JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
WHERE membership.roleid = to_regrole(:'runtime_role')
ORDER BY member_role.rolname
\gexec

SELECT format(
  'REVOKE %I FROM %I CASCADE',
  :'migration_role',
  member_role.rolname
)
FROM pg_catalog.pg_auth_members AS membership
JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
JOIN pg_catalog.pg_database AS database
  ON database.datname = current_database()
WHERE membership.roleid = to_regrole(:'migration_role')
  AND membership.member <> database.datdba
ORDER BY member_role.rolname
\gexec

-- Reassert the exact surviving relationship in case a legacy membership
-- lacked ADMIN OPTION.
SELECT format(
  'GRANT %I TO %I WITH ADMIN OPTION',
  :'migration_role',
  current_user
)
\gexec

SELECT format('ALTER ROLE %I SET search_path TO pg_catalog, public', :'migration_role')
\gexec
SELECT format('ALTER ROLE %I SET search_path TO pg_catalog, public', :'runtime_role')
\gexec
SELECT format(
  'ALTER ROLE %I SET idle_in_transaction_session_timeout TO %L',
  :'runtime_role',
  '60s'
)
\gexec
SELECT format(
  'ALTER ROLE %I SET statement_timeout TO %L',
  :'runtime_role',
  '30s'
)
\gexec

-- AlphaNet readiness deliberately refuses traffic if PostgreSQL can log bind
-- parameter values. Database defaults apply to every new service connection
-- without embedding security settings in DATABASE_URL.
SELECT format(
  'ALTER DATABASE %I SET log_parameter_max_length TO %L',
  current_database(),
  '0'
)
\gexec
SELECT format(
  'ALTER DATABASE %I SET log_parameter_max_length_on_error TO %L',
  current_database(),
  '0'
)
\gexec

-- Install the reviewed extension set with the RDS bootstrap identity. The
-- migration principal never receives rds_superuser or rds_extension.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO PUBLIC;
SELECT format('GRANT USAGE ON SCHEMA public TO %I, %I', :'migration_role', :'runtime_role')
\gexec

-- The application database is closed to every ACL grantee except its owner and
-- the two reviewed AlphaNet roles. Enumerating the stored ACL (rather than
-- checking only PUBLIC) also repairs explicit grants left by an older setup.
SELECT format(
  'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %s CASCADE',
  current_database(),
  CASE
    WHEN privilege.grantee = 0 THEN 'PUBLIC'
    ELSE format('%I', grantee.rolname)
  END
)
FROM pg_catalog.pg_database AS database
CROSS JOIN LATERAL aclexplode(
  coalesce(database.datacl, acldefault('d', database.datdba))
) AS privilege
LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
WHERE database.datname = current_database()
  AND privilege.grantee NOT IN (
    database.datdba,
    to_regrole(:'migration_role'),
    to_regrole(:'runtime_role')
  )
GROUP BY privilege.grantee, grantee.rolname
ORDER BY privilege.grantee
\gexec
SELECT format(
  'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I CASCADE',
  current_database(),
  :'migration_role'
)
\gexec
SELECT format(
  'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I CASCADE',
  current_database(),
  :'runtime_role'
)
\gexec
SELECT format(
  'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO %I',
  current_database(),
  :'migration_role'
)
\gexec
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO %I',
  current_database(),
  :'runtime_role'
)
\gexec

SELECT format('CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION %I', :'migration_role')
\gexec
SELECT format('CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION %I', :'migration_role')
\gexec
SELECT format('CREATE SCHEMA IF NOT EXISTS system AUTHORIZATION %I', :'migration_role')
\gexec

-- Support an idempotent adoption run if a prototype database was originally
-- migrated as the bootstrap administrator. Only AlphaNet-owned schemas are in
-- scope; extension and RDS-managed objects are never reassigned.
SELECT format(
  CASE object_kind
    WHEN 'FOREIGN TABLE' THEN 'ALTER FOREIGN TABLE %I.%I OWNER TO %I'
    WHEN 'MATERIALIZED VIEW' THEN 'ALTER MATERIALIZED VIEW %I.%I OWNER TO %I'
    WHEN 'SEQUENCE' THEN 'ALTER SEQUENCE %I.%I OWNER TO %I'
    WHEN 'VIEW' THEN 'ALTER VIEW %I.%I OWNER TO %I'
    ELSE 'ALTER TABLE %I.%I OWNER TO %I'
  END,
  schema_name,
  object_name,
  :'migration_role'
)
FROM (
  SELECT
    namespace.nspname AS schema_name,
    relation.relname AS object_name,
    CASE relation.relkind
      WHEN 'f' THEN 'FOREIGN TABLE'
      WHEN 'm' THEN 'MATERIALIZED VIEW'
      WHEN 'S' THEN 'SEQUENCE'
      WHEN 'v' THEN 'VIEW'
      ELSE 'TABLE'
    END AS object_kind
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('auth', 'platform', 'system')
    AND relation.relkind IN ('f', 'm', 'p', 'r', 'S', 'v')
    AND relation.relowner <> to_regrole(:'migration_role')
  ORDER BY namespace.nspname, relation.relname
) AS owned_object
\gexec

SELECT format(
  CASE routine.prokind
    WHEN 'p' THEN 'ALTER PROCEDURE %I.%I(%s) OWNER TO %I'
    ELSE 'ALTER FUNCTION %I.%I(%s) OWNER TO %I'
  END,
  namespace.nspname,
  routine.proname,
  pg_get_function_identity_arguments(routine.oid),
  :'migration_role'
)
FROM pg_catalog.pg_proc AS routine
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = routine.pronamespace
WHERE namespace.nspname IN ('auth', 'platform', 'system')
  AND routine.proowner <> to_regrole(:'migration_role')
ORDER BY namespace.nspname, routine.proname, routine.oid
\gexec

SELECT format('ALTER SCHEMA %I OWNER TO %I', schema_name, :'migration_role')
FROM unnest(ARRAY['auth', 'platform', 'system']) AS schema_name
WHERE (
  SELECT namespace.nspowner
  FROM pg_catalog.pg_namespace AS namespace
  WHERE namespace.nspname = schema_name
) <> to_regrole(:'migration_role')
\gexec

-- Ownership is now normalized, so perform application-object ACL repair as
-- the migration owner. Keep existing runtime grants available during an
-- idempotent bootstrap/rotation, but remove PUBLIC and every unreviewed direct
-- grantee from the AlphaNet schemas and their complete object inventory.
SET LOCAL ROLE :"migration_role";

SELECT format(
  'REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %s CASCADE',
  namespace.nspname,
  CASE
    WHEN privilege.grantee = 0 THEN 'PUBLIC'
    ELSE format('%I', grantee.rolname)
  END
)
FROM pg_catalog.pg_namespace AS namespace
CROSS JOIN LATERAL aclexplode(
  coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
) AS privilege
LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
WHERE namespace.nspname IN ('auth', 'platform', 'system')
  AND privilege.grantee NOT IN (
    to_regrole(:'migration_role'),
    to_regrole(:'runtime_role')
  )
GROUP BY namespace.nspname, privilege.grantee, grantee.rolname
ORDER BY namespace.nspname, privilege.grantee
\gexec

SELECT format(
  'REVOKE ALL PRIVILEGES ON %s %I.%I FROM %s CASCADE',
  CASE relation.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
  namespace.nspname,
  relation.relname,
  CASE
    WHEN privilege.grantee = 0 THEN 'PUBLIC'
    ELSE format('%I', grantee.rolname)
  END
)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace
CROSS JOIN LATERAL aclexplode(
  coalesce(
    relation.relacl,
    acldefault(
      CASE relation.relkind WHEN 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
      relation.relowner
    )
  )
) AS privilege
LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
WHERE namespace.nspname IN ('auth', 'platform', 'system')
  AND relation.relkind IN ('f', 'm', 'p', 'r', 'S', 'v')
  AND privilege.grantee NOT IN (
    to_regrole(:'migration_role'),
    to_regrole(:'runtime_role')
  )
GROUP BY
  namespace.nspname,
  relation.relname,
  relation.relkind,
  privilege.grantee,
  grantee.rolname
ORDER BY namespace.nspname, relation.relname, privilege.grantee
\gexec

-- Column-only grants live in pg_attribute.attacl and do not appear in relacl.
-- A table-level REVOKE ALL removes both table and column privileges for that
-- grantee, so enumerate attacl to close this otherwise invisible legacy path.
SELECT format(
  'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %s CASCADE',
  namespace.nspname,
  relation.relname,
  CASE
    WHEN privilege.grantee = 0 THEN 'PUBLIC'
    ELSE format('%I', grantee.rolname)
  END
)
FROM pg_catalog.pg_attribute AS attribute
JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace
CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
WHERE namespace.nspname IN ('auth', 'platform', 'system')
  AND relation.relkind IN ('f', 'm', 'p', 'r', 'v')
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
  AND privilege.grantee NOT IN (
    to_regrole(:'migration_role'),
    to_regrole(:'runtime_role')
  )
GROUP BY
  namespace.nspname,
  relation.relname,
  privilege.grantee,
  grantee.rolname
ORDER BY namespace.nspname, relation.relname, privilege.grantee
\gexec

SELECT format(
  'REVOKE ALL PRIVILEGES ON %s %I.%I(%s) FROM %s CASCADE',
  CASE routine.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
  namespace.nspname,
  routine.proname,
  pg_get_function_identity_arguments(routine.oid),
  CASE
    WHEN privilege.grantee = 0 THEN 'PUBLIC'
    ELSE format('%I', grantee.rolname)
  END
)
FROM pg_catalog.pg_proc AS routine
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = routine.pronamespace
CROSS JOIN LATERAL aclexplode(
  coalesce(routine.proacl, acldefault('f', routine.proowner))
) AS privilege
LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
WHERE namespace.nspname IN ('auth', 'platform', 'system')
  AND privilege.grantee NOT IN (
    to_regrole(:'migration_role'),
    to_regrole(:'runtime_role')
  )
GROUP BY
  namespace.nspname,
  routine.proname,
  routine.oid,
  routine.prokind,
  privilege.grantee,
  grantee.rolname
ORDER BY namespace.nspname, routine.proname, routine.oid, privilege.grantee
\gexec

SELECT format(
  'REVOKE ALL ON SCHEMA %I FROM %I',
  schema_name,
  :'runtime_role'
)
FROM unnest(ARRAY['auth', 'platform', 'system']) AS schema_name
\gexec
SELECT format(
  'GRANT USAGE, CREATE ON SCHEMA %I TO %I',
  schema_name,
  :'migration_role'
)
FROM unnest(ARRAY['auth', 'platform', 'system']) AS schema_name
\gexec
SELECT format(
  'GRANT USAGE ON SCHEMA %I TO %I',
  schema_name,
  :'runtime_role'
)
FROM unnest(ARRAY['auth', 'platform', 'system']) AS schema_name
\gexec

RESET ROLE;

COMMIT;

\echo 'AlphaNet AWS database roles and bootstrap settings are ready.'
