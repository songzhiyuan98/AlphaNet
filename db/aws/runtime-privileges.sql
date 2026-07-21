\set ON_ERROR_STOP on

-- Run after every successful migration batch. New tables and functions are
-- denied by default until this reviewed inventory classifies them. This file
-- is intentionally transaction-free: callers must execute it together with
-- verify-runtime-privileges.sql inside one transaction so a rejected inventory
-- cannot leave the currently running application with partially changed
-- privileges.

SET LOCAL ROLE :"migration_role";

-- Rebuild every non-owner ACL from a closed baseline. Enumerating aclexplode
-- catches legacy explicit grantees as well as PUBLIC and runtime; the reviewed
-- grants below are then the only entries added back.
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
  AND privilege.grantee <> to_regrole(:'migration_role')
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
  AND privilege.grantee <> to_regrole(:'migration_role')
GROUP BY
  namespace.nspname,
  relation.relname,
  relation.relkind,
  privilege.grantee,
  grantee.rolname
ORDER BY namespace.nspname, relation.relname, privilege.grantee
\gexec

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
  AND privilege.grantee <> to_regrole(:'migration_role')
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
  AND privilege.grantee <> to_regrole(:'migration_role')
GROUP BY
  namespace.nspname,
  routine.proname,
  routine.oid,
  routine.prokind,
  privilege.grantee,
  grantee.rolname
ORDER BY namespace.nspname, routine.proname, routine.oid, privilege.grantee
\gexec

GRANT USAGE, CREATE ON SCHEMA auth, platform, system TO :"migration_role";
GRANT USAGE ON SCHEMA auth, platform, system TO :"runtime_role";

-- Better Auth owns the lifecycle of these four tables and requires all row
-- operations. It receives no TRUNCATE, REFERENCES, TRIGGER, schema CREATE, or
-- database CREATE/TEMPORARY capability.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  auth.users,
  auth.sessions,
  auth.accounts,
  auth.verifications
TO :"runtime_role";

-- Every currently classified platform table can participate in authorization,
-- discovery, content reads, or trigger validation. Keep this list explicit so
-- an unreviewed table remains closed even if the later verifier rejects the
-- release. Writes remain table-specific.
GRANT SELECT ON TABLE
  platform.action_logs,
  platform.actors,
  platform.agent_policies,
  platform.agents,
  platform.communities,
  platform.community_symbols,
  platform.community_topics,
  platform.content_additional_communities,
  platform.content_items,
  platform.content_relations,
  platform.content_revisions,
  platform.content_symbols,
  platform.content_topics,
  platform.credentials,
  platform.idempotency_records,
  platform.mentions,
  platform.owners,
  platform.pending_action_attempts,
  platform.pending_actions,
  platform.reactions,
  platform.registration_controls,
  platform.source_links,
  platform.symbols,
  platform.topics
TO :"runtime_role";

GRANT INSERT ON TABLE
  platform.action_logs,
  platform.actors,
  platform.agent_policies,
  platform.agents,
  platform.communities,
  platform.community_symbols,
  platform.content_additional_communities,
  platform.content_items,
  platform.content_relations,
  platform.content_revisions,
  platform.content_symbols,
  platform.content_topics,
  platform.credentials,
  platform.idempotency_records,
  platform.mentions,
  platform.pending_actions,
  platform.reactions,
  platform.source_links
TO :"runtime_role";

GRANT DELETE ON TABLE
  platform.reactions
TO :"runtime_role";

GRANT UPDATE ON TABLE
  platform.actors,
  platform.agents,
  platform.content_items,
  platform.credentials,
  platform.idempotency_records,
  platform.pending_action_attempts,
  platform.pending_actions,
  platform.registration_controls
TO :"runtime_role";

GRANT SELECT ON TABLE
  system.content_read_visibility_epochs,
  system.outbox_aggregate_heads,
  system.outbox_consumer_deliveries,
  system.outbox_consumer_receipts,
  system.outbox_consumers,
  system.outbox_events,
  system.schema_migrations
TO :"runtime_role";
GRANT INSERT ON TABLE
  system.outbox_aggregate_heads,
  system.outbox_consumer_deliveries,
  system.outbox_consumer_receipts,
  system.outbox_consumers,
  system.outbox_events
TO :"runtime_role";
GRANT UPDATE ON TABLE
  system.outbox_aggregate_heads,
  system.outbox_consumer_deliveries
TO :"runtime_role";

-- These pure validation helpers are invoked by CHECK constraints. Trigger
-- functions, especially SECURITY DEFINER functions, remain non-callable by the
-- runtime role and execute only through their reviewed trigger bindings.
GRANT EXECUTE ON FUNCTION
  platform.agent_scopes_are_valid(text[]),
  platform.audit_json_is_secret_free(jsonb),
  platform.audit_json_is_secret_free_v2(jsonb),
  platform.canonical_discovery_tags_are_valid(text[]),
  platform.community_posting_rules_are_valid(jsonb),
  platform.discovery_tags_are_valid(text[]),
  platform.text_array_has_unique_values(text[])
TO :"runtime_role";

-- PostgreSQL grants PUBLIC EXECUTE on new functions unless the owner changes
-- its default ACL. Keep future objects closed until this inventory is updated.
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA auth
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA platform
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA system
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA auth
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA platform
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA system
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
-- PUBLIC EXECUTE is PostgreSQL's global built-in function default. A
-- schema-specific REVOKE cannot subtract that global default, so this one must
-- deliberately omit IN SCHEMA.
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role"
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA auth
  REVOKE ALL ON TABLES FROM :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA platform
  REVOKE ALL ON TABLES FROM :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA system
  REVOKE ALL ON TABLES FROM :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA auth
  REVOKE ALL ON SEQUENCES FROM :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA platform
  REVOKE ALL ON SEQUENCES FROM :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA system
  REVOKE ALL ON SEQUENCES FROM :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role"
  REVOKE EXECUTE ON FUNCTIONS FROM :"runtime_role";
