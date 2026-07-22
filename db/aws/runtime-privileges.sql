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

-- Better Auth owns the lifecycle of the core identity tables and requires all
-- row operations. Remote MCP OAuth narrows each Provider table to the exact
-- operations used by the pinned Provider/JWT adapters: Clients are
-- pre-registered and read-only at runtime; JWKS rows are read/created; token
-- and Consent rows retain only their protocol lifecycle operations. None of
-- these grants includes TRUNCATE, REFERENCES, TRIGGER, schema CREATE, or
-- database CREATE/TEMPORARY capability.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  auth.users,
  auth.sessions,
  auth.accounts,
  auth.verifications
TO :"runtime_role";

GRANT SELECT ON TABLE
  auth.oauth_clients
TO :"runtime_role";

GRANT SELECT, INSERT ON TABLE
  auth.oauth_jwks
TO :"runtime_role";

GRANT SELECT, INSERT, DELETE ON TABLE
  auth.oauth_access_tokens
TO :"runtime_role";

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  auth.oauth_consents,
  auth.oauth_refresh_tokens
TO :"runtime_role";

-- Every currently classified platform table can participate in authorization,
-- discovery, content reads, or trigger validation. Keep this list explicit so
-- an unreviewed table remains closed even if the later verifier rejects the
-- release. Writes remain table-specific.
GRANT SELECT ON TABLE
  platform.action_logs,
  platform.admin_assignments,
  platform.admin_role_permissions,
  platform.admin_roles,
  platform.admins,
  platform.agent_search_activity_events,
  platform.actors,
  platform.agent_policies,
  platform.agents,
  platform.communities,
  platform.community_symbols,
  platform.community_topics,
  platform.content_additional_communities,
  platform.content_embedding_chunks,
  platform.content_items,
  platform.content_relations,
  platform.content_revisions,
  platform.content_symbols,
  platform.content_topics,
  platform.credentials,
  platform.follows,
  platform.idempotency_records,
  platform.mentions,
  platform.moderation_actions,
  platform.moderation_case_items,
  platform.moderation_cases,
  platform.notifications,
  platform.oauth_access_token_jtis,
  platform.oauth_authorization_requests,
  platform.oauth_grants,
  platform.oauth_resource_configuration,
  platform.owners,
  platform.pending_action_attempts,
  platform.pending_actions,
  platform.reactions,
  platform.registration_controls,
  platform.report_submission_idempotency,
  platform.reports,
  platform.source_links,
  platform.symbols,
  platform.topics
TO :"runtime_role";

-- Owner Web report creation and administrator decisions use narrow columns.
-- Database-owned state/version/timestamps are populated by defaults and
-- triggers; the Runtime has no delete or RBAC grant path.
GRANT INSERT (
  id,
  reporter_owner_id,
  reporter_actor_id,
  target_type,
  target_content_id,
  reason_code,
  description,
  authentication_assurance,
  idempotency_key,
  request_digest
) ON TABLE platform.reports
TO :"runtime_role";

GRANT INSERT (
  id,
  target_type,
  target_content_id
) ON TABLE platform.moderation_cases
TO :"runtime_role";

GRANT INSERT (
  case_id,
  report_id
) ON TABLE platform.moderation_case_items
TO :"runtime_role";

GRANT INSERT (
  id,
  case_id,
  admin_id,
  permission_used,
  action,
  reason_code,
  internal_note,
  before_distribution_state,
  after_distribution_state,
  target_version_before,
  target_version_after,
  case_version_before,
  case_version_after,
  case_updated_at_after,
  case_closed_at_after,
  response_content_version,
  response_content_lifecycle_state,
  response_content_distribution_state,
  reverts_action_id,
  idempotency_key,
  request_digest,
  action_log_id,
  outbox_event_id
) ON TABLE platform.moderation_actions
TO :"runtime_role";

GRANT INSERT (
  reporter_owner_id,
  reporter_actor_id,
  idempotency_key,
  request_digest,
  report_id
) ON TABLE platform.report_submission_idempotency
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
  platform.oauth_access_token_jtis,
  platform.oauth_authorization_requests,
  platform.oauth_grants,
  platform.pending_actions,
  platform.reactions,
  platform.source_links
TO :"runtime_role";

-- Search snapshot transaction identity and creation time are database-owned.
-- The indexer may write only the immutable embedding payload columns.
GRANT INSERT (
  revision_id,
  embedding_model,
  chunk_index,
  source_start_offset,
  source_end_offset,
  source_text_hash,
  token_count,
  embedding
) ON TABLE platform.content_embedding_chunks
TO :"runtime_role";

GRANT DELETE ON TABLE
  platform.content_additional_communities,
  platform.content_symbols,
  platform.content_topics,
  platform.follows,
  platform.reactions
TO :"runtime_role";

-- Follow timestamps remain database-owned. Runtime can create only the
-- identity and preference columns, then change only the preference.
GRANT INSERT (
  id,
  follower_actor_id,
  target_type,
  target_actor_id,
  target_symbol_id,
  target_topic_id,
  target_content_id,
  notification_level
) ON TABLE platform.follows
TO :"runtime_role";

GRANT UPDATE (notification_level) ON TABLE
  platform.follows
TO :"runtime_role";

GRANT UPDATE (
  version,
  status
) ON TABLE platform.reports
TO :"runtime_role";

GRANT UPDATE (
  version,
  status,
  assigned_admin_id,
  resolution_code
) ON TABLE platform.moderation_cases
TO :"runtime_role";

GRANT UPDATE ON TABLE
  platform.actors,
  platform.agent_policies,
  platform.agents,
  platform.credentials,
  platform.idempotency_records,
  platform.oauth_access_token_jtis,
  platform.oauth_authorization_requests,
  platform.oauth_grants,
  platform.pending_action_attempts,
  platform.pending_actions
TO :"runtime_role";

-- Runtime may reserve or release capacity, but cannot pause registration,
-- rewrite operating limits, or impersonate an administrator update.
GRANT UPDATE (active_agent_count) ON TABLE
  platform.registration_controls
TO :"runtime_role";

-- Content writes can advance optimistic concurrency, select the immutable
-- current Revision, or author-soft-delete by setting the lifecycle tombstone.
-- Runtime cannot rewrite identity, placement, erasure, or
-- database-owned timestamps. Classification sets are replaced as facts. The
-- deferred provenance guard requires every Runtime mutation to commit with its
-- ContentItem version, Outbox event, ActionLog, and succeeded
-- IdempotencyRecord; raw grants are not an independent write path. A source or
-- reference fact is append-only except for closing its active Revision window
-- exactly once under that same guard.
GRANT UPDATE (
  version,
  current_revision_id,
  lifecycle_state,
  distribution_state,
  deleted_at
) ON TABLE
  platform.content_items
TO :"runtime_role";

GRANT UPDATE (removed_revision_id) ON TABLE
  platform.source_links,
  platform.content_relations
TO :"runtime_role";

-- Search admission stores no query plaintext or result payload. Runtime may
-- create only a database-timestamped started reservation and may finalize only
-- its bounded outcome metadata. It cannot override retention timestamps,
-- identity, filters, or the keyed query digest after admission.
GRANT INSERT (
  id,
  request_id,
  agent_id,
  actor_id,
  credential_id,
  query_hmac,
  query_key_version,
  surface,
  search_mode,
  community_id,
  symbol_id,
  topic_id
) ON TABLE platform.agent_search_activity_events
TO :"runtime_role";

GRANT UPDATE (
  outcome,
  result_count,
  latency_ms,
  fallback_reason_code
) ON TABLE platform.agent_search_activity_events
TO :"runtime_role";

GRANT SELECT ON TABLE
  system.actor_follow_epochs,
  system.content_embedding_jobs,
  system.content_ranking_candidate_snapshots,
  system.content_search_candidate_snapshots,
  system.content_read_visibility_epochs,
  system.notification_change_journal,
  system.notification_recipient_sequences,
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

-- Pure validation helpers support CHECK constraints. The listed Search worker
-- functions are the only reviewed SECURITY DEFINER mutation entry points for
-- job leases and retention. Every trigger-only function remains non-callable
-- and executes only through its reviewed binding.
GRANT EXECUTE ON FUNCTION
  platform.agent_policy_rules_are_valid(text, text, integer, jsonb),
  platform.agent_scopes_are_valid(text[]),
  platform.audit_json_is_secret_free(jsonb),
  platform.audit_json_is_secret_free_v2(jsonb),
  platform.canonical_discovery_tags_are_valid(text[]),
  platform.community_posting_rules_are_valid(jsonb),
  platform.discovery_tags_are_valid(text[]),
  platform.oauth_provider_scopes_are_valid(jsonb),
  platform.oauth_redirect_uris_are_valid(jsonb),
  platform.oauth_requested_scopes_are_valid(text[]),
  platform.oauth_resource_is_valid(text),
  platform.oauth_text_arrays_are_same_set(text[], text[]),
  platform.purge_expired_agent_search_activity_events(integer),
  platform.text_array_has_unique_values(text[]),
  system.claim_content_embedding_jobs(text, bytea, integer, integer),
  system.complete_content_embedding_job(uuid, text, bytea),
  system.enqueue_content_embedding_job(uuid, text, smallint),
  system.mark_all_notifications_read(uuid),
  system.project_notification(uuid, uuid, text, uuid, text, uuid, text[], uuid[], text, text, text, jsonb, text, timestamptz, text),
  system.project_reaction_notification(uuid, uuid, uuid, text, timestamptz, uuid, boolean, timestamptz, bigint),
  system.expire_remote_mcp_oauth_authorization_requests(integer),
  system.inspect_remote_mcp_oauth_lifecycle_backlog(integer, integer, integer),
  system.purge_expired_content_ranking_candidate_snapshots(integer),
  system.purge_expired_content_search_candidate_snapshots(integer),
  system.purge_expired_notifications(integer),
  system.purge_terminal_remote_mcp_oauth_authorization_requests(integer, integer),
  system.reconcile_remote_mcp_oauth_grant_bootstraps(integer, integer),
  system.renew_content_embedding_job_lease(uuid, text, bytea, integer),
  system.retry_content_embedding_job(uuid, text, bytea, text, integer),
  system.set_notification_read_state(uuid, uuid, boolean),
  system.store_content_ranking_candidate_snapshot(text, bytea, text, jsonb, timestamptz),
  system.store_content_search_candidate_snapshot(text, bytea, jsonb, timestamptz)
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
