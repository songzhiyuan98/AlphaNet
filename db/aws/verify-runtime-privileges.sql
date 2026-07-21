\set ON_ERROR_STOP on

-- This file is intentionally transaction-free. The shell wrapper executes it
-- with psql --single-transaction, either alone or after the privilege
-- reconciler. Keep the probe inside a savepoint so its cleanup does not roll
-- back a successfully verified privilege inventory.

CREATE TEMPORARY TABLE expected_table_privileges (
  schema_name name NOT NULL,
  table_name name NOT NULL,
  privilege text NOT NULL,
  PRIMARY KEY (schema_name, table_name, privilege)
) ON COMMIT DROP;

INSERT INTO expected_table_privileges (schema_name, table_name, privilege)
SELECT 'auth', table_name, privilege
FROM (
  VALUES ('accounts'::name), ('sessions'::name), ('users'::name), ('verifications'::name)
) AS auth_table(table_name)
CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS privilege;

INSERT INTO expected_table_privileges (schema_name, table_name, privilege)
SELECT 'platform', table_name, 'SELECT'
FROM (
  VALUES
    ('action_logs'::name),
    ('actors'::name),
    ('agent_policies'::name),
    ('agents'::name),
    ('communities'::name),
    ('community_symbols'::name),
    ('community_topics'::name),
    ('content_additional_communities'::name),
    ('content_items'::name),
    ('content_relations'::name),
    ('content_revisions'::name),
    ('content_symbols'::name),
    ('content_topics'::name),
    ('credentials'::name),
    ('follows'::name),
    ('idempotency_records'::name),
    ('mentions'::name),
    ('owners'::name),
    ('pending_action_attempts'::name),
    ('pending_actions'::name),
    ('reactions'::name),
    ('registration_controls'::name),
    ('source_links'::name),
    ('symbols'::name),
    ('topics'::name)
) AS platform_table(table_name);

INSERT INTO expected_table_privileges (schema_name, table_name, privilege)
SELECT 'platform', table_name, 'INSERT'
FROM (
  VALUES
    ('action_logs'::name),
    ('actors'::name),
    ('agent_policies'::name),
    ('agents'::name),
    ('communities'::name),
    ('community_symbols'::name),
    ('content_additional_communities'::name),
    ('content_items'::name),
    ('content_relations'::name),
    ('content_revisions'::name),
    ('content_symbols'::name),
    ('content_topics'::name),
    ('credentials'::name),
    ('idempotency_records'::name),
    ('mentions'::name),
    ('pending_actions'::name),
    ('reactions'::name),
    ('source_links'::name)
) AS platform_table(table_name);

INSERT INTO expected_table_privileges (schema_name, table_name, privilege)
VALUES
  ('platform', 'content_additional_communities', 'DELETE'),
  ('platform', 'content_symbols', 'DELETE'),
  ('platform', 'content_topics', 'DELETE'),
  ('platform', 'follows', 'DELETE'),
  ('platform', 'reactions', 'DELETE');

INSERT INTO expected_table_privileges (schema_name, table_name, privilege)
SELECT 'platform', table_name, 'UPDATE'
FROM (
  VALUES
    ('actors'::name),
    ('agent_policies'::name),
    ('agents'::name),
    ('credentials'::name),
    ('idempotency_records'::name),
    ('pending_action_attempts'::name),
    ('pending_actions'::name),
    ('registration_controls'::name)
) AS platform_table(table_name);

INSERT INTO expected_table_privileges (schema_name, table_name, privilege)
SELECT 'system', table_name, 'SELECT'
FROM (
  VALUES
    ('actor_follow_epochs'::name),
    ('content_read_visibility_epochs'::name),
    ('outbox_aggregate_heads'::name),
    ('outbox_consumer_deliveries'::name),
    ('outbox_consumer_receipts'::name),
    ('outbox_consumers'::name),
    ('outbox_events'::name),
    ('schema_migrations'::name)
) AS system_table(table_name);

CREATE TEMPORARY TABLE expected_column_privileges (
  schema_name name NOT NULL,
  table_name name NOT NULL,
  column_name name NOT NULL,
  privilege text NOT NULL,
  PRIMARY KEY (schema_name, table_name, column_name, privilege)
) ON COMMIT DROP;

INSERT INTO expected_column_privileges (
  schema_name,
  table_name,
  column_name,
  privilege
)
VALUES
  ('platform', 'follows', 'id', 'INSERT'),
  ('platform', 'follows', 'follower_actor_id', 'INSERT'),
  ('platform', 'follows', 'target_type', 'INSERT'),
  ('platform', 'follows', 'target_actor_id', 'INSERT'),
  ('platform', 'follows', 'target_symbol_id', 'INSERT'),
  ('platform', 'follows', 'target_topic_id', 'INSERT'),
  ('platform', 'follows', 'target_content_id', 'INSERT'),
  ('platform', 'follows', 'notification_level', 'INSERT'),
  ('platform', 'follows', 'notification_level', 'UPDATE'),
  ('platform', 'content_items', 'version', 'UPDATE'),
  ('platform', 'content_items', 'current_revision_id', 'UPDATE'),
  ('platform', 'source_links', 'removed_revision_id', 'UPDATE'),
  ('platform', 'content_relations', 'removed_revision_id', 'UPDATE');

INSERT INTO expected_table_privileges (schema_name, table_name, privilege)
SELECT 'system', table_name, 'INSERT'
FROM (
  VALUES
    ('outbox_aggregate_heads'::name),
    ('outbox_consumer_deliveries'::name),
    ('outbox_consumer_receipts'::name),
    ('outbox_consumers'::name),
    ('outbox_events'::name)
) AS system_table(table_name);

INSERT INTO expected_table_privileges (schema_name, table_name, privilege)
SELECT 'system', table_name, 'UPDATE'
FROM (
  VALUES
    ('outbox_aggregate_heads'::name),
    ('outbox_consumer_deliveries'::name)
) AS system_table(table_name);

CREATE TEMPORARY TABLE expected_function_privileges (
  schema_name name NOT NULL,
  function_name name NOT NULL,
  identity_arguments text NOT NULL,
  PRIMARY KEY (schema_name, function_name, identity_arguments)
) ON COMMIT DROP;

INSERT INTO expected_function_privileges (
  schema_name,
  function_name,
  identity_arguments
)
VALUES
  ('platform', 'agent_policy_rules_are_valid', 'tier text, defaults_version text, policy_schema_version integer, rules jsonb'),
  ('platform', 'agent_scopes_are_valid', 'candidate text[]'),
  ('platform', 'audit_json_is_secret_free', 'document jsonb'),
  ('platform', 'audit_json_is_secret_free_v2', 'document jsonb'),
  ('platform', 'canonical_discovery_tags_are_valid', 'candidate text[]'),
  ('platform', 'community_posting_rules_are_valid', 'candidate jsonb'),
  ('platform', 'discovery_tags_are_valid', 'candidate text[]'),
  ('platform', 'text_array_has_unique_values', 'candidate text[]');

SELECT set_config('alphanet.verify.migration_role', :'migration_role', false);
SELECT set_config('alphanet.verify.runtime_role', :'runtime_role', false);

DO $verification$
DECLARE
  migration_role_oid oid := to_regrole(
    current_setting('alphanet.verify.migration_role')
  );
  runtime_role_oid oid := to_regrole(
    current_setting('alphanet.verify.runtime_role')
  );
  database_owner_oid oid;
  violation text;
BEGIN
  IF migration_role_oid IS NULL OR runtime_role_oid IS NULL THEN
    RAISE EXCEPTION 'AlphaNet migration/runtime role is missing';
  END IF;

  SELECT database.datdba
  INTO database_owner_oid
  FROM pg_catalog.pg_database AS database
  WHERE database.datname = current_database();
  IF database_owner_oid IS NULL THEN
    RAISE EXCEPTION 'Current AlphaNet database owner is missing';
  END IF;

  SELECT string_agg(role_name, ', ' ORDER BY role_name)
  INTO violation
  FROM (
    SELECT role.rolname AS role_name
    FROM pg_catalog.pg_roles AS role
    WHERE role.oid IN (migration_role_oid, runtime_role_oid)
      AND (
        NOT role.rolcanlogin
        OR role.rolsuper
        OR role.rolcreatedb
        OR role.rolcreaterole
        OR role.rolinherit
        OR role.rolreplication
        OR role.rolbypassrls
      )
  ) AS unsafe_role;
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe AlphaNet role attributes: %', violation;
  END IF;

  IF pg_has_role(runtime_role_oid, migration_role_oid, 'MEMBER')
    OR pg_has_role(migration_role_oid, runtime_role_oid, 'MEMBER') THEN
    RAISE EXCEPTION 'Migration and runtime roles must not inherit each other';
  END IF;

  -- NOINHERIT does not prevent SET ROLE. Neither login may remain a member of
  -- any role left over from an earlier environment or manual grant.
  SELECT string_agg(
    format('%I is a member of %I', member_role.rolname, granted_role.rolname),
    ', ' ORDER BY member_role.rolname, granted_role.rolname
  )
  INTO violation
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
  JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
  WHERE membership.member IN (migration_role_oid, runtime_role_oid);
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'AlphaNet login has unexpected role membership: %', violation;
  END IF;

  SELECT string_agg(member_role.rolname, ', ' ORDER BY member_role.rolname)
  INTO violation
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
  WHERE membership.roleid = runtime_role_oid;
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Runtime role has unexpected members: %', violation;
  END IF;

  SELECT string_agg(
    format(
      '%I%s',
      member_role.rolname,
      CASE WHEN membership.admin_option THEN '' ELSE ' without ADMIN OPTION' END
    ),
    ', ' ORDER BY member_role.rolname
  )
  INTO violation
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
  WHERE membership.roleid = migration_role_oid
    AND (
      membership.member <> database_owner_oid
      OR NOT membership.admin_option
    );
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Migration role has unexpected members: %', violation;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = migration_role_oid
      AND membership.member = database_owner_oid
      AND membership.admin_option
  ) THEN
    RAISE EXCEPTION 'Database owner lacks required migration role administration';
  END IF;

  IF NOT has_database_privilege(runtime_role_oid, current_database(), 'CONNECT')
    OR has_database_privilege(runtime_role_oid, current_database(), 'CREATE')
    OR has_database_privilege(runtime_role_oid, current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION 'Runtime database CONNECT/CREATE/TEMPORARY boundary is invalid';
  END IF;

  IF NOT has_database_privilege(migration_role_oid, current_database(), 'CONNECT')
    OR NOT has_database_privilege(migration_role_oid, current_database(), 'CREATE')
    OR NOT has_database_privilege(
      migration_role_oid,
      current_database(),
      'TEMPORARY'
    ) THEN
    RAISE EXCEPTION 'Migration database CONNECT/CREATE/TEMPORARY boundary is invalid';
  END IF;

  SELECT string_agg(
    format('%s:%s', actual_acl.grantee_name, actual_acl.privilege_type),
    ', ' ORDER BY actual_acl.grantee_name, actual_acl.privilege_type
  )
  INTO violation
  FROM (
    SELECT
      CASE
        WHEN privilege.grantee = 0 THEN 'PUBLIC'
        ELSE format('%I', grantee.rolname)
      END AS grantee_name,
      privilege.privilege_type
    FROM pg_catalog.pg_database AS database
    CROSS JOIN LATERAL aclexplode(
      coalesce(database.datacl, acldefault('d', database.datdba))
    ) AS privilege
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
    WHERE database.datname = current_database()
      AND privilege.grantee NOT IN (
        database_owner_oid,
        migration_role_oid,
        runtime_role_oid
      )
  ) AS actual_acl;
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Unauthorized AlphaNet database ACL grantees: %', violation;
  END IF;

  SELECT string_agg(namespace.nspname, ', ' ORDER BY namespace.nspname)
  INTO violation
  FROM pg_catalog.pg_namespace AS namespace
  WHERE namespace.nspname IN ('auth', 'platform', 'system')
    AND (
      namespace.nspowner <> migration_role_oid
      OR NOT has_schema_privilege(runtime_role_oid, namespace.oid, 'USAGE')
      OR has_schema_privilege(runtime_role_oid, namespace.oid, 'CREATE')
    );
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid AlphaNet schema ownership/privileges: %', violation;
  END IF;

  SELECT string_agg(
    format(
      '%I->%s:%s',
      actual_acl.schema_name,
      actual_acl.grantee_name,
      actual_acl.privilege_type
    ),
    ', ' ORDER BY
      actual_acl.schema_name,
      actual_acl.grantee_name,
      actual_acl.privilege_type
  )
  INTO violation
  FROM (
    SELECT
      namespace.nspname AS schema_name,
      CASE
        WHEN privilege.grantee = 0 THEN 'PUBLIC'
        ELSE format('%I', grantee.rolname)
      END AS grantee_name,
      privilege.privilege_type
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
    ) AS privilege
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
    WHERE namespace.nspname IN ('auth', 'platform', 'system')
      AND privilege.grantee NOT IN (migration_role_oid, runtime_role_oid)
  ) AS actual_acl;
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Unauthorized AlphaNet schema ACL grantees: %', violation;
  END IF;

  SELECT string_agg(
    format('%I.%I owned by %I', namespace.nspname, relation.relname, owner.rolname),
    ', ' ORDER BY namespace.nspname, relation.relname
  )
  INTO violation
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
  WHERE namespace.nspname IN ('auth', 'platform', 'system')
    AND relation.relkind IN ('f', 'm', 'p', 'r', 'S', 'v')
    AND relation.relowner <> migration_role_oid;
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'AlphaNet relations not owned by migration role: %', violation;
  END IF;

  SELECT string_agg(
    format(
      '%I.%I->%s:%s',
      actual_acl.schema_name,
      actual_acl.relation_name,
      actual_acl.grantee_name,
      actual_acl.privilege_type
    ),
    ', ' ORDER BY
      actual_acl.schema_name,
      actual_acl.relation_name,
      actual_acl.grantee_name,
      actual_acl.privilege_type
  )
  INTO violation
  FROM (
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS relation_name,
      CASE
        WHEN privilege.grantee = 0 THEN 'PUBLIC'
        ELSE format('%I', grantee.rolname)
      END AS grantee_name,
      privilege.privilege_type
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(relation.relacl, acldefault('r', relation.relowner))
    ) AS privilege
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
    WHERE namespace.nspname IN ('auth', 'platform', 'system')
      AND relation.relkind IN ('f', 'm', 'p', 'r', 'v')
      AND privilege.grantee NOT IN (migration_role_oid, runtime_role_oid)
  ) AS actual_acl;
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Unauthorized AlphaNet relation ACL grantees: %', violation;
  END IF;

  SELECT string_agg(
    format(
      '%I.%I(%I)->%s:%s',
      actual_acl.schema_name,
      actual_acl.relation_name,
      actual_acl.column_name,
      actual_acl.grantee_name,
      actual_acl.privilege_type
    ),
    ', ' ORDER BY
      actual_acl.schema_name,
      actual_acl.relation_name,
      actual_acl.column_name,
      actual_acl.grantee_name,
      actual_acl.privilege_type
  )
  INTO violation
  FROM (
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS relation_name,
      attribute.attname AS column_name,
      CASE
        WHEN privilege.grantee = 0 THEN 'PUBLIC'
        ELSE format('%I', grantee.rolname)
      END AS grantee_name,
      privilege.privilege_type
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
      AND privilege.grantee NOT IN (migration_role_oid, runtime_role_oid)
  ) AS actual_acl;
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Unauthorized AlphaNet relation ACL grantees: %', violation;
  END IF;

  SELECT string_agg(
    format(
      '%I.%I->%s:%s',
      actual_acl.schema_name,
      actual_acl.sequence_name,
      actual_acl.grantee_name,
      actual_acl.privilege_type
    ),
    ', ' ORDER BY
      actual_acl.schema_name,
      actual_acl.sequence_name,
      actual_acl.grantee_name,
      actual_acl.privilege_type
  )
  INTO violation
  FROM (
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS sequence_name,
      CASE
        WHEN privilege.grantee = 0 THEN 'PUBLIC'
        ELSE format('%I', grantee.rolname)
      END AS grantee_name,
      privilege.privilege_type
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(relation.relacl, acldefault('S', relation.relowner))
    ) AS privilege
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
    WHERE namespace.nspname IN ('auth', 'platform', 'system')
      AND relation.relkind = 'S'
      AND privilege.grantee NOT IN (migration_role_oid, runtime_role_oid)
  ) AS actual_acl;
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Unauthorized AlphaNet sequence ACL grantees: %', violation;
  END IF;

  SELECT string_agg(
    format('%I.%I owned by %I', namespace.nspname, routine.proname, owner.rolname),
    ', ' ORDER BY namespace.nspname, routine.proname
  )
  INTO violation
  FROM pg_catalog.pg_proc AS routine
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = routine.pronamespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = routine.proowner
  WHERE namespace.nspname IN ('auth', 'platform', 'system')
    AND routine.proowner <> migration_role_oid;
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'AlphaNet routines not owned by migration role: %', violation;
  END IF;

  SELECT string_agg(
    format(
      '%I.%I(%s)->%s:%s',
      actual_acl.schema_name,
      actual_acl.routine_name,
      actual_acl.identity_arguments,
      actual_acl.grantee_name,
      actual_acl.privilege_type
    ),
    ', ' ORDER BY
      actual_acl.schema_name,
      actual_acl.routine_name,
      actual_acl.identity_arguments,
      actual_acl.grantee_name,
      actual_acl.privilege_type
  )
  INTO violation
  FROM (
    SELECT
      namespace.nspname AS schema_name,
      routine.proname AS routine_name,
      pg_get_function_identity_arguments(routine.oid) AS identity_arguments,
      CASE
        WHEN privilege.grantee = 0 THEN 'PUBLIC'
        ELSE format('%I', grantee.rolname)
      END AS grantee_name,
      privilege.privilege_type
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(routine.proacl, acldefault('f', routine.proowner))
    ) AS privilege
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
    WHERE namespace.nspname IN ('auth', 'platform', 'system')
      AND privilege.grantee NOT IN (migration_role_oid, runtime_role_oid)
  ) AS actual_acl;
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Unauthorized AlphaNet routine ACL grantees: %', violation;
  END IF;

  SELECT string_agg(
    format('%I.%I', expected.schema_name, expected.table_name),
    ', ' ORDER BY expected.schema_name, expected.table_name
  )
  INTO violation
  FROM (
    SELECT DISTINCT schema_name, table_name
    FROM expected_table_privileges
  ) AS expected
  WHERE to_regclass(format('%I.%I', expected.schema_name, expected.table_name))
    IS NULL;
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Expected AlphaNet tables are missing: %', violation;
  END IF;

  SELECT string_agg(
    format('%I.%I', namespace.nspname, relation.relname),
    ', ' ORDER BY namespace.nspname, relation.relname
  )
  INTO violation
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('auth', 'platform', 'system')
    AND relation.relkind IN ('f', 'm', 'p', 'r', 'v')
    AND NOT EXISTS (
      SELECT 1
      FROM expected_table_privileges AS expected
      WHERE expected.schema_name = namespace.nspname
        AND expected.table_name = relation.relname
    );
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Unclassified AlphaNet tables/views: %', violation;
  END IF;

  SELECT string_agg(
    format('%I.%I:%s', expected.schema_name, expected.table_name, expected.privilege),
    ', ' ORDER BY expected.schema_name, expected.table_name, expected.privilege
  )
  INTO violation
  FROM expected_table_privileges AS expected
  WHERE NOT has_table_privilege(
    runtime_role_oid,
    to_regclass(format('%I.%I', expected.schema_name, expected.table_name)),
    expected.privilege
  );
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Runtime is missing required table privileges: %', violation;
  END IF;

  SELECT string_agg(
    format('%I.%I:%s', namespace.nspname, relation.relname, privilege),
    ', ' ORDER BY namespace.nspname, relation.relname, privilege
  )
  INTO violation
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  CROSS JOIN unnest(
    ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
  ) AS privilege
  WHERE namespace.nspname IN ('auth', 'platform', 'system')
    AND relation.relkind IN ('p', 'r', 'v', 'm', 'f')
    AND has_table_privilege(runtime_role_oid, relation.oid, privilege)
    AND NOT EXISTS (
      SELECT 1
      FROM expected_table_privileges AS expected
      WHERE expected.schema_name = namespace.nspname
        AND expected.table_name = relation.relname
        AND expected.privilege = privilege
    );
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Runtime has unexpected table privileges: %', violation;
  END IF;

  SELECT string_agg(
    format(
      '%I.%I(%I):%s',
      expected.schema_name,
      expected.table_name,
      expected.column_name,
      expected.privilege
    ),
    ', ' ORDER BY
      expected.schema_name,
      expected.table_name,
      expected.column_name,
      expected.privilege
  )
  INTO violation
  FROM expected_column_privileges AS expected
  LEFT JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.nspname = expected.schema_name
  LEFT JOIN pg_catalog.pg_class AS relation
    ON relation.relnamespace = namespace.oid
   AND relation.relname = expected.table_name
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attname = expected.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE attribute.attnum IS NULL
     OR NOT has_column_privilege(
       runtime_role_oid,
       relation.oid,
       attribute.attnum,
       expected.privilege
     );
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Runtime is missing required column privileges: %', violation;
  END IF;

  IF has_column_privilege(
       runtime_role_oid,
       'platform.follows',
       'created_at',
       'INSERT'
     )
     OR has_column_privilege(
       runtime_role_oid,
       'platform.follows',
       'updated_at',
       'INSERT'
     ) THEN
    RAISE EXCEPTION
      'Runtime can override database-owned Follow timestamps';
  END IF;

  SELECT string_agg(
    format(
      '%I.%I(%I):%s',
      namespace.nspname,
      relation.relname,
      attribute.attname,
      privilege.privilege_type
    ),
    ', ' ORDER BY
      namespace.nspname,
      relation.relname,
      attribute.attname,
      privilege.privilege_type
  )
  INTO violation
  FROM pg_catalog.pg_attribute AS attribute
  JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
  WHERE namespace.nspname IN ('auth', 'platform', 'system')
    AND relation.relkind IN ('f', 'm', 'p', 'r', 'v')
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
    AND privilege.grantee = runtime_role_oid
    AND NOT EXISTS (
      SELECT 1
      FROM expected_column_privileges AS expected
      WHERE expected.schema_name = namespace.nspname
        AND expected.table_name = relation.relname
        AND expected.column_name = attribute.attname
        AND expected.privilege = privilege.privilege_type
    );
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Runtime has unexpected column privileges: %', violation;
  END IF;

  SELECT string_agg(
    format('%I.%I:%s', namespace.nspname, relation.relname, privilege),
    ', ' ORDER BY namespace.nspname, relation.relname, privilege
  )
  INTO violation
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  CROSS JOIN unnest(ARRAY['SELECT', 'USAGE', 'UPDATE']) AS privilege
  WHERE namespace.nspname IN ('auth', 'platform', 'system')
    AND relation.relkind = 'S'
    AND has_sequence_privilege(runtime_role_oid, relation.oid, privilege);
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Runtime has unexpected sequence privileges: %', violation;
  END IF;

  SELECT string_agg(
    format('%I.%I(%s)', namespace.nspname, routine.proname,
      pg_get_function_identity_arguments(routine.oid)),
    ', ' ORDER BY namespace.nspname, routine.proname, routine.oid
  )
  INTO violation
  FROM pg_catalog.pg_proc AS routine
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = routine.pronamespace
  WHERE namespace.nspname IN ('auth', 'platform', 'system')
    AND has_function_privilege(runtime_role_oid, routine.oid, 'EXECUTE')
    AND NOT EXISTS (
      SELECT 1
      FROM expected_function_privileges AS expected
      WHERE expected.schema_name = namespace.nspname
        AND expected.function_name = routine.proname
        AND expected.identity_arguments =
          pg_get_function_identity_arguments(routine.oid)
    );
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Runtime can execute unapproved AlphaNet functions: %', violation;
  END IF;

  SELECT string_agg(
    format('%I.%I(%s)', expected.schema_name, expected.function_name,
      expected.identity_arguments),
    ', ' ORDER BY expected.schema_name, expected.function_name
  )
  INTO violation
  FROM expected_function_privileges AS expected
  LEFT JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.nspname = expected.schema_name
  LEFT JOIN pg_catalog.pg_proc AS routine
    ON routine.pronamespace = namespace.oid
   AND routine.proname = expected.function_name
   AND pg_get_function_identity_arguments(routine.oid) = expected.identity_arguments
  WHERE routine.oid IS NULL
     OR NOT has_function_privilege(runtime_role_oid, routine.oid, 'EXECUTE');
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Runtime is missing approved function privileges: %', violation;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'platform'
      AND routine.proname = 'validate_runtime_content_write_provenance'
      AND routine.pronargs = 0
      AND pg_catalog.pg_get_function_identity_arguments(routine.oid) = ''
      AND NOT routine.prosecdef
      AND 'search_path=pg_catalog' = ANY (routine.proconfig)
  ) THEN
    RAISE EXCEPTION
      'Runtime content provenance guard is missing or not SECURITY INVOKER';
  END IF;

  SELECT string_agg(
    format('%I.%I[%s]', expected.table_name, expected.trigger_name, expected.tgtype),
    ', ' ORDER BY expected.table_name, expected.trigger_name
  )
  INTO violation
  FROM (
    VALUES
      (
        'content_items'::name,
        'content_items_validate_runtime_provenance'::name,
        21::smallint
      ),
      (
        'content_additional_communities'::name,
        'content_additional_communities_validate_runtime_provenance'::name,
        29::smallint
      ),
      (
        'content_symbols'::name,
        'content_symbols_validate_runtime_provenance'::name,
        29::smallint
      ),
      (
        'content_topics'::name,
        'content_topics_validate_runtime_provenance'::name,
        29::smallint
      ),
      (
        'source_links'::name,
        'source_links_validate_runtime_provenance'::name,
        21::smallint
      ),
      (
        'content_relations'::name,
        'content_relations_validate_runtime_provenance'::name,
        21::smallint
      ),
      (
        'mentions'::name,
        'mentions_validate_runtime_provenance'::name,
        5::smallint
      )
  ) AS expected(table_name, trigger_name, tgtype)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_proc AS routine ON routine.oid = trigger.tgfoid
    JOIN pg_catalog.pg_namespace AS routine_namespace
      ON routine_namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'platform'
      AND relation.relname = expected.table_name
      AND trigger.tgname = expected.trigger_name
      AND NOT trigger.tgisinternal
      AND trigger.tgconstraint <> 0
      AND trigger.tgdeferrable
      AND trigger.tginitdeferred
      AND trigger.tgenabled IN ('O', 'A')
      AND trigger.tgtype = expected.tgtype
      AND trigger.tgfoid =
        'platform.validate_runtime_content_write_provenance()'::regprocedure
      AND routine_namespace.nspname = 'platform'
      AND routine.proname = 'validate_runtime_content_write_provenance'
      AND routine.pronargs = 0
      AND pg_catalog.pg_get_function_identity_arguments(routine.oid) = ''
  );
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION
      'Runtime content provenance trigger coverage is incomplete: %', violation;
  END IF;

  SELECT string_agg(extension_name, ', ' ORDER BY extension_name)
  INTO violation
  FROM unnest(ARRAY['citext', 'pg_trgm', 'pgcrypto', 'vector']) AS extension_name
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_extension AS extension
    WHERE extension.extname = extension_name
  );
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'Required PostgreSQL extensions are missing: %', violation;
  END IF;

  IF (
    SELECT count(*) <> 2
      OR NOT bool_and(
        setting = '0'
        AND source NOT IN ('client', 'session', 'interactive', 'test')
      )
    FROM pg_catalog.pg_settings
    WHERE name IN (
      'log_parameter_max_length',
      'log_parameter_max_length_on_error'
    )
  ) THEN
    RAISE EXCEPTION 'PostgreSQL parameter logging is not disabled by a durable source';
  END IF;
END;
$verification$;

-- Exercise the migration owner's default ACL inside this transaction. A new
-- object must remain unavailable until runtime-privileges.sql classifies it.
SAVEPOINT alphanet_runtime_acl_probe;
SET LOCAL ROLE :"migration_role";
CREATE TABLE platform.__alphanet_runtime_acl_probe (id integer PRIMARY KEY);
CREATE FUNCTION platform.__alphanet_runtime_acl_probe()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS 'SELECT 1';
RESET ROLE;

SELECT NOT has_table_privilege(
    :'runtime_role',
    'platform.__alphanet_runtime_acl_probe',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) AS probe_table_is_closed,
  NOT has_function_privilege(
    :'runtime_role',
    'platform.__alphanet_runtime_acl_probe()',
    'EXECUTE'
  ) AS probe_function_is_closed
\gset

\if :probe_table_is_closed
\else
  SELECT 1 / 0 AS future_table_default_acl_is_open;
\endif
\if :probe_function_is_closed
\else
  SELECT 1 / 0 AS future_function_default_acl_is_open;
\endif

ROLLBACK TO SAVEPOINT alphanet_runtime_acl_probe;
RELEASE SAVEPOINT alphanet_runtime_acl_probe;

\echo 'AlphaNet AWS runtime least-privilege verification passed.'
