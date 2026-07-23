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

-- Tables in this inventory are deliberately closed to the runtime role. Keep
-- them classified separately so adding a sensitive table cannot be mistaken
-- for an omitted privilege decision.
CREATE TEMPORARY TABLE expected_closed_tables (
  schema_name name NOT NULL,
  table_name name NOT NULL,
  PRIMARY KEY (schema_name, table_name)
) ON COMMIT DROP;

INSERT INTO expected_closed_tables (schema_name, table_name)
VALUES
  ('platform', 'notification_aggregate_actors'),
  ('platform', 'oauth_grant_bootstrap_reconciliations'),
  ('system', 'oauth_grant_bootstrap_queue');

INSERT INTO expected_table_privileges (schema_name, table_name, privilege)
SELECT 'auth', table_name, privilege
FROM (
  VALUES ('accounts'::name), ('sessions'::name), ('users'::name), ('verifications'::name)
) AS auth_table(table_name)
CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS privilege;

INSERT INTO expected_table_privileges (schema_name, table_name, privilege)
VALUES ('auth', 'oauth_clients', 'SELECT');

INSERT INTO expected_table_privileges (schema_name, table_name, privilege)
SELECT 'auth', table_name, privilege
FROM (VALUES ('oauth_jwks'::name)) AS auth_table(table_name)
CROSS JOIN unnest(ARRAY['SELECT', 'INSERT']) AS privilege;

INSERT INTO expected_table_privileges (schema_name, table_name, privilege)
SELECT 'auth', table_name, privilege
FROM (VALUES ('oauth_access_tokens'::name)) AS auth_table(table_name)
CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'DELETE']) AS privilege;

INSERT INTO expected_table_privileges (schema_name, table_name, privilege)
SELECT 'auth', table_name, privilege
FROM (
  VALUES ('oauth_consents'::name), ('oauth_refresh_tokens'::name)
) AS auth_table(table_name)
CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS privilege;

INSERT INTO expected_table_privileges (schema_name, table_name, privilege)
SELECT 'platform', table_name, 'SELECT'
FROM (
  VALUES
    ('action_logs'::name),
    ('admin_assignments'::name),
    ('admin_role_permissions'::name),
    ('admin_roles'::name),
    ('admins'::name),
    ('agent_admin_actions'::name),
    ('agent_search_activity_events'::name),
    ('actors'::name),
    ('agent_policies'::name),
    ('agents'::name),
    ('communities'::name),
    ('community_symbols'::name),
    ('community_topics'::name),
    ('content_additional_communities'::name),
    ('content_embedding_chunks'::name),
    ('content_items'::name),
    ('content_relations'::name),
    ('content_revisions'::name),
    ('content_symbols'::name),
    ('content_topics'::name),
    ('credentials'::name),
    ('follows'::name),
    ('idempotency_records'::name),
    ('mentions'::name),
    ('moderation_actions'::name),
    ('moderation_case_items'::name),
    ('moderation_cases'::name),
    ('notifications'::name),
    ('oauth_access_token_jtis'::name),
    ('oauth_authorization_requests'::name),
    ('oauth_grants'::name),
    ('oauth_resource_configuration'::name),
    ('owners'::name),
    ('pending_action_attempts'::name),
    ('pending_actions'::name),
    ('reactions'::name),
    ('registration_controls'::name),
    ('report_submission_idempotency'::name),
    ('reports'::name),
    ('source_links'::name),
    ('symbols'::name),
    ('topic_community_admin_actions'::name),
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
    ('oauth_access_token_jtis'::name),
    ('oauth_authorization_requests'::name),
    ('oauth_grants'::name),
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
    ('oauth_access_token_jtis'::name),
    ('oauth_authorization_requests'::name),
    ('oauth_grants'::name),
    ('pending_action_attempts'::name),
    ('pending_actions'::name)
) AS platform_table(table_name);

INSERT INTO expected_table_privileges (schema_name, table_name, privilege)
SELECT 'system', table_name, 'SELECT'
FROM (
  VALUES
    ('actor_follow_epochs'::name),
    ('content_embedding_jobs'::name),
    ('content_ranking_candidate_snapshots'::name),
    ('content_search_candidate_snapshots'::name),
    ('content_read_visibility_epochs'::name),
    ('notification_change_journal'::name),
    ('notification_recipient_sequences'::name),
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
  ('platform', 'registration_controls', 'active_agent_count', 'UPDATE'),
  ('platform', 'content_items', 'version', 'UPDATE'),
  ('platform', 'content_items', 'current_revision_id', 'UPDATE'),
  ('platform', 'content_items', 'lifecycle_state', 'UPDATE'),
  ('platform', 'content_items', 'distribution_state', 'UPDATE'),
  ('platform', 'content_items', 'deleted_at', 'UPDATE'),
  ('platform', 'source_links', 'removed_revision_id', 'UPDATE'),
  ('platform', 'content_relations', 'removed_revision_id', 'UPDATE');

INSERT INTO expected_column_privileges (
  schema_name,
  table_name,
  column_name,
  privilege
)
SELECT 'platform', 'reports', column_name, 'INSERT'
FROM (
  VALUES
    ('id'::name),
    ('reporter_owner_id'::name),
    ('reporter_actor_id'::name),
    ('target_type'::name),
    ('target_content_id'::name),
    ('reason_code'::name),
    ('description'::name),
    ('authentication_assurance'::name),
    ('idempotency_key'::name),
    ('request_digest'::name)
) AS report_insert_column(column_name);

INSERT INTO expected_column_privileges (
  schema_name,
  table_name,
  column_name,
  privilege
)
SELECT 'platform', 'reports', column_name, 'UPDATE'
FROM (
  VALUES
    ('version'::name),
    ('status'::name)
) AS report_update_column(column_name);

INSERT INTO expected_column_privileges (
  schema_name,
  table_name,
  column_name,
  privilege
)
SELECT 'platform', 'moderation_cases', column_name, 'INSERT'
FROM (
  VALUES
    ('id'::name),
    ('target_type'::name),
    ('target_content_id'::name)
) AS moderation_case_insert_column(column_name);

INSERT INTO expected_column_privileges (
  schema_name,
  table_name,
  column_name,
  privilege
)
SELECT 'platform', 'moderation_cases', column_name, 'UPDATE'
FROM (
  VALUES
    ('version'::name),
    ('status'::name),
    ('assigned_admin_id'::name),
    ('resolution_code'::name)
) AS moderation_case_update_column(column_name);

INSERT INTO expected_column_privileges (
  schema_name,
  table_name,
  column_name,
  privilege
)
SELECT 'platform', 'report_submission_idempotency', column_name, 'INSERT'
FROM (
  VALUES
    ('reporter_owner_id'::name),
    ('reporter_actor_id'::name),
    ('idempotency_key'::name),
    ('request_digest'::name),
    ('report_id'::name)
) AS report_idempotency_insert_column(column_name);

INSERT INTO expected_column_privileges (
  schema_name,
  table_name,
  column_name,
  privilege
)
VALUES
  ('platform', 'moderation_case_items', 'case_id', 'INSERT'),
  ('platform', 'moderation_case_items', 'report_id', 'INSERT');

INSERT INTO expected_column_privileges (
  schema_name,
  table_name,
  column_name,
  privilege
)
SELECT 'platform', 'moderation_actions', column_name, 'INSERT'
FROM (
  VALUES
    ('id'::name),
    ('case_id'::name),
    ('admin_id'::name),
    ('permission_used'::name),
    ('action'::name),
    ('reason_code'::name),
    ('internal_note'::name),
    ('before_distribution_state'::name),
    ('after_distribution_state'::name),
    ('target_version_before'::name),
    ('target_version_after'::name),
    ('case_version_before'::name),
    ('case_version_after'::name),
    ('case_updated_at_after'::name),
    ('case_closed_at_after'::name),
    ('response_content_version'::name),
    ('response_content_lifecycle_state'::name),
    ('response_content_distribution_state'::name),
    ('reverts_action_id'::name),
    ('idempotency_key'::name),
    ('request_digest'::name),
    ('action_log_id'::name),
    ('outbox_event_id'::name)
) AS moderation_action_insert_column(column_name);

INSERT INTO expected_column_privileges (
  schema_name,
  table_name,
  column_name,
  privilege
)
VALUES
  ('platform', 'community_topics', 'community_id', 'INSERT'),
  ('platform', 'community_topics', 'topic_id', 'INSERT'),
  ('platform', 'topics', 'id', 'INSERT'),
  ('platform', 'topics', 'slug', 'INSERT'),
  ('platform', 'topics', 'name', 'INSERT'),
  ('platform', 'topics', 'description', 'INSERT'),
  ('platform', 'communities', 'name', 'UPDATE'),
  ('platform', 'communities', 'description', 'UPDATE'),
  ('platform', 'communities', 'status', 'UPDATE'),
  ('platform', 'communities', 'version', 'UPDATE'),
  ('platform', 'topics', 'name', 'UPDATE'),
  ('platform', 'topics', 'description', 'UPDATE'),
  ('platform', 'topics', 'updated_at', 'UPDATE');

INSERT INTO expected_column_privileges (
  schema_name,
  table_name,
  column_name,
  privilege
)
SELECT 'platform', 'agent_admin_actions', column_name, 'INSERT'
FROM (
  VALUES
    ('id'::name),
    ('admin_id'::name),
    ('permission_used'::name),
    ('action'::name),
    ('reason_code'::name),
    ('internal_note'::name),
    ('agent_id'::name),
    ('owner_id'::name),
    ('governance_version_before'::name),
    ('governance_version_after'::name),
    ('revoked_credential_count'::name),
    ('idempotency_key'::name),
    ('request_digest'::name),
    ('request_id'::name),
    ('authorization_snapshot'::name),
    ('before_state'::name),
    ('after_state'::name),
    ('response_snapshot'::name),
    ('action_log_id'::name),
    ('outbox_event_id'::name),
    ('occurred_at'::name)
) AS agent_admin_action_insert_column(column_name);

INSERT INTO expected_column_privileges (
  schema_name,
  table_name,
  column_name,
  privilege
)
SELECT 'platform', 'topic_community_admin_actions', column_name, 'INSERT'
FROM (
  VALUES
    ('id'::name),
    ('admin_id'::name),
    ('permission_used'::name),
    ('action'::name),
    ('community_id'::name),
    ('community_version_before'::name),
    ('community_version_after'::name),
    ('idempotency_key'::name),
    ('request_digest'::name),
    ('request_id'::name),
    ('authorization_snapshot'::name),
    ('before_state'::name),
    ('after_state'::name),
    ('response_snapshot'::name),
    ('action_log_id'::name),
    ('outbox_event_id'::name),
    ('occurred_at'::name)
) AS topic_community_action_insert_column(column_name);

INSERT INTO expected_column_privileges (
  schema_name,
  table_name,
  column_name,
  privilege
)
SELECT
  'platform',
  'content_embedding_chunks',
  column_name,
  'INSERT'
FROM (
  VALUES
    ('revision_id'::name),
    ('embedding_model'::name),
    ('chunk_index'::name),
    ('source_start_offset'::name),
    ('source_end_offset'::name),
    ('source_text_hash'::name),
    ('token_count'::name),
    ('embedding'::name)
) AS embedding_insert_column(column_name);

INSERT INTO expected_column_privileges (
  schema_name,
  table_name,
  column_name,
  privilege
)
SELECT
  'platform',
  'agent_search_activity_events',
  column_name,
  'INSERT'
FROM (
  VALUES
    ('id'::name),
    ('request_id'::name),
    ('agent_id'::name),
    ('actor_id'::name),
    ('credential_id'::name),
    ('query_hmac'::name),
    ('query_key_version'::name),
    ('surface'::name),
    ('search_mode'::name),
    ('community_id'::name),
    ('symbol_id'::name),
    ('topic_id'::name)
) AS search_insert_column(column_name);

INSERT INTO expected_column_privileges (
  schema_name,
  table_name,
  column_name,
  privilege
)
SELECT
  'platform',
  'agent_search_activity_events',
  column_name,
  'UPDATE'
FROM (
  VALUES
    ('outcome'::name),
    ('result_count'::name),
    ('latency_ms'::name),
    ('fallback_reason_code'::name)
) AS search_finalize_column(column_name);

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
  ('platform', 'oauth_provider_scopes_are_valid', 'candidate jsonb'),
  ('platform', 'oauth_redirect_uris_are_valid', 'candidate jsonb'),
  ('platform', 'oauth_requested_scopes_are_valid', 'candidate text[]'),
  ('platform', 'oauth_resource_is_valid', 'candidate text'),
  ('platform', 'oauth_text_arrays_are_same_set', 'left_values text[], right_values text[]'),
  ('platform', 'purge_expired_agent_search_activity_events', 'candidate_batch_size integer'),
  ('platform', 'text_array_has_unique_values', 'candidate text[]'),
  ('system', 'claim_content_embedding_jobs', 'candidate_lease_owner text, candidate_lease_token_digest bytea, candidate_batch_size integer, candidate_lease_seconds integer'),
  ('system', 'complete_content_embedding_job', 'candidate_job_id uuid, candidate_lease_owner text, candidate_lease_token_digest bytea'),
  ('system', 'content_v1_outbox_payload_is_valid', 'aggregate_type text, aggregate_id text, event_type text, event_version integer, payload jsonb'),
  ('system', 'enqueue_content_embedding_job', 'candidate_revision_id uuid, candidate_embedding_model text, candidate_priority smallint'),
  ('system', 'expire_remote_mcp_oauth_authorization_requests', 'candidate_batch_size integer'),
  ('system', 'inspect_remote_mcp_oauth_lifecycle_backlog', 'candidate_grace_seconds integer, candidate_retention_seconds integer, candidate_count_cap integer'),
  ('system', 'mark_all_notifications_read', 'candidate_recipient_actor_id uuid'),
  ('system', 'project_notification', 'candidate_notification_id uuid, candidate_recipient_actor_id uuid, candidate_type text, candidate_trigger_actor_id uuid, candidate_object_type text, candidate_object_id uuid, candidate_symbol_ids text[], candidate_community_ids uuid[], candidate_matched_follow_target_type text, candidate_matched_follow_target_id text, candidate_matched_follow_notification_level text, candidate_context jsonb, candidate_summary_template_key text, candidate_occurred_at timestamp with time zone, candidate_dedupe_key text'),
  ('system', 'project_reaction_notification', 'candidate_notification_id uuid, candidate_recipient_actor_id uuid, candidate_content_id uuid, candidate_reaction_type text, candidate_bucket_start timestamp with time zone, candidate_trigger_actor_id uuid, candidate_active boolean, candidate_event_occurred_at timestamp with time zone, candidate_event_sequence bigint'),
  ('system', 'purge_expired_content_ranking_candidate_snapshots', 'candidate_batch_size integer'),
  ('system', 'purge_expired_content_search_candidate_snapshots', 'candidate_batch_size integer'),
  ('system', 'purge_expired_notifications', 'candidate_batch_size integer'),
  ('system', 'purge_terminal_remote_mcp_oauth_authorization_requests', 'candidate_batch_size integer, candidate_retention_seconds integer'),
  ('system', 'reconcile_remote_mcp_oauth_grant_bootstraps', 'candidate_batch_size integer, candidate_grace_seconds integer'),
  ('system', 'renew_content_embedding_job_lease', 'candidate_job_id uuid, candidate_lease_owner text, candidate_lease_token_digest bytea, candidate_lease_seconds integer'),
  ('system', 'retry_content_embedding_job', 'candidate_job_id uuid, candidate_lease_owner text, candidate_lease_token_digest bytea, candidate_error_code text, candidate_retry_seconds integer'),
  ('system', 'set_notification_read_state', 'candidate_notification_id uuid, candidate_recipient_actor_id uuid, candidate_is_read boolean'),
  ('system', 'store_content_ranking_candidate_snapshot', 'candidate_snapshot_id text, candidate_binding_hmac bytea, candidate_kind text, candidate_candidates jsonb, candidate_expires_at timestamp with time zone'),
  ('system', 'store_content_search_candidate_snapshot', 'candidate_snapshot_id text, candidate_binding_hmac bytea, candidate_candidates jsonb, candidate_expires_at timestamp with time zone');

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
    UNION
    SELECT schema_name, table_name
    FROM expected_closed_tables
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
    )
    AND NOT EXISTS (
      SELECT 1
      FROM expected_closed_tables AS expected
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

  IF has_column_privilege(
       runtime_role_oid,
       'platform.agent_search_activity_events',
       'occurred_at',
       'INSERT'
     )
     OR has_column_privilege(
       runtime_role_oid,
       'platform.agent_search_activity_events',
       'expires_at',
       'INSERT'
     )
     OR has_column_privilege(
       runtime_role_oid,
       'platform.agent_search_activity_events',
       'finalized_at',
       'UPDATE'
     ) THEN
    RAISE EXCEPTION
      'Runtime can override database-owned Agent Search retention timestamps';
  END IF;

  IF has_column_privilege(
       runtime_role_oid,
       'platform.content_embedding_chunks',
       'id',
       'INSERT'
     )
     OR has_column_privilege(
       runtime_role_oid,
       'platform.content_embedding_chunks',
       'search_index_created_xid',
       'INSERT'
     )
     OR has_column_privilege(
       runtime_role_oid,
       'platform.content_embedding_chunks',
       'created_at',
       'INSERT'
     ) THEN
    RAISE EXCEPTION
      'Runtime can override database-owned embedding chunk identity';
  END IF;

  IF has_column_privilege(
       runtime_role_oid,
       'platform.reports',
       'created_at',
       'INSERT'
     )
     OR has_column_privilege(
       runtime_role_oid,
       'platform.reports',
       'status',
       'INSERT'
     )
     OR has_column_privilege(
       runtime_role_oid,
       'platform.moderation_cases',
       'opened_at',
       'INSERT'
     )
     OR has_column_privilege(
       runtime_role_oid,
       'platform.reports',
       'resolved_at',
       'UPDATE'
     )
     OR has_column_privilege(
       runtime_role_oid,
       'platform.moderation_cases',
       'priority',
       'UPDATE'
     )
     OR has_column_privilege(
       runtime_role_oid,
       'platform.moderation_cases',
       'closed_at',
       'UPDATE'
     )
     OR has_table_privilege(
       runtime_role_oid,
       'platform.report_submission_idempotency',
       'UPDATE,DELETE'
     )
     OR has_column_privilege(
       runtime_role_oid,
       'platform.moderation_actions',
       'occurred_at',
       'INSERT'
     )
     OR has_column_privilege(
       runtime_role_oid,
       'platform.moderation_actions',
       'result_state',
       'INSERT'
     ) THEN
    RAISE EXCEPTION
      'Runtime can override database-owned moderation state or timestamps';
  END IF;

  IF has_table_privilege(
       runtime_role_oid,
       'platform.admin_assignments',
       'INSERT,UPDATE,DELETE'
     )
     OR has_table_privilege(
       runtime_role_oid,
       'platform.admin_roles',
       'INSERT,UPDATE,DELETE'
     )
     OR has_table_privilege(
       runtime_role_oid,
       'platform.admin_role_permissions',
       'INSERT,UPDATE,DELETE'
     ) THEN
    RAISE EXCEPTION 'Runtime can grant or mutate administrator roles';
  END IF;

  IF has_table_privilege(
       runtime_role_oid,
       'platform.notifications',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR has_table_privilege(
       runtime_role_oid,
       'platform.notification_aggregate_actors',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR has_table_privilege(
       runtime_role_oid,
       'system.notification_change_journal',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR has_table_privilege(
       runtime_role_oid,
       'system.notification_recipient_sequences',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION
      'Runtime can bypass notification projection/read-state entry points';
  END IF;

  IF has_function_privilege(
       runtime_role_oid,
       'system.redrive_content_embedding_job(uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'Runtime can execute the migration/ops-only embedding redrive function';
  END IF;

  IF has_function_privilege(
       runtime_role_oid,
       'system.enqueue_content_embedding_job_from_revision()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'Runtime can directly execute the Revision embedding enqueue trigger';
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

  IF (
    SELECT count(*) <> 5
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'system'
      AND routine.proname IN (
        'mark_all_notifications_read',
        'project_notification',
        'project_reaction_notification',
        'purge_expired_notifications',
        'set_notification_read_state'
      )
      AND routine.prosecdef
      AND 'search_path=pg_catalog' = ANY (routine.proconfig)
  ) THEN
    RAISE EXCEPTION
      'Notification runtime entry points are missing or not hardened SECURITY DEFINER functions';
  END IF;

  IF (
    SELECT count(*) <> 4
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'system'
      AND routine.proname IN (
        'expire_remote_mcp_oauth_authorization_requests',
        'inspect_remote_mcp_oauth_lifecycle_backlog',
        'purge_terminal_remote_mcp_oauth_authorization_requests',
        'reconcile_remote_mcp_oauth_grant_bootstraps'
      )
      AND routine.prosecdef
      AND 'search_path=pg_catalog' = ANY (routine.proconfig)
  ) THEN
    RAISE EXCEPTION
      'Remote MCP OAuth maintenance entry points are missing or not hardened SECURITY DEFINER functions';
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
      AND position(
        'content.moderation_changed' IN pg_get_functiondef(routine.oid)
      ) > 0
  ) THEN
    RAISE EXCEPTION
      'Runtime content provenance guard is missing or not SECURITY INVOKER';
  END IF;

  IF (
    SELECT count(*) <> 7
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'platform'
      AND routine.proname IN (
        'validate_runtime_report_idempotency_provenance',
        'validate_runtime_report_creation_provenance',
        'validate_runtime_case_creation_provenance',
        'validate_runtime_moderation_action_provenance',
        'validate_runtime_moderation_resolution_provenance',
        'validate_runtime_governance_outbox_provenance',
        'validate_runtime_governance_action_log_provenance'
      )
      AND routine.pronargs = 0
      AND NOT routine.prosecdef
      AND 'search_path=pg_catalog' = ANY (routine.proconfig)
  ) THEN
    RAISE EXCEPTION
      'Runtime moderation provenance guards are missing or unsafe';
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

  SELECT string_agg(
    format(
      '%I.%I.%I[%s=>%s]',
      expected.table_schema,
      expected.table_name,
      expected.trigger_name,
      expected.tgtype,
      expected.function_name
    ),
    ', ' ORDER BY expected.table_schema, expected.table_name, expected.trigger_name
  )
  INTO violation
  FROM (
    VALUES
      ('platform'::name, 'report_submission_idempotency'::name, 'report_submission_idempotency_validate_runtime_provenance'::name, 5::smallint, 'platform.validate_runtime_report_idempotency_provenance()'::text),
      ('platform'::name, 'reports'::name, 'reports_validate_runtime_creation_provenance'::name, 5::smallint, 'platform.validate_runtime_report_creation_provenance()'::text),
      ('platform'::name, 'moderation_cases'::name, 'moderation_cases_validate_runtime_creation_provenance'::name, 5::smallint, 'platform.validate_runtime_case_creation_provenance()'::text),
      ('platform'::name, 'moderation_actions'::name, 'moderation_actions_validate_runtime_provenance'::name, 5::smallint, 'platform.validate_runtime_moderation_action_provenance()'::text),
      ('system'::name, 'outbox_events'::name, 'outbox_events_validate_governance_provenance'::name, 5::smallint, 'platform.validate_runtime_governance_outbox_provenance()'::text),
      ('platform'::name, 'action_logs'::name, 'action_logs_validate_governance_provenance'::name, 5::smallint, 'platform.validate_runtime_governance_action_log_provenance()'::text),
      ('platform'::name, 'reports'::name, 'reports_validate_runtime_resolution_provenance'::name, 17::smallint, 'platform.validate_runtime_moderation_resolution_provenance()'::text),
      ('platform'::name, 'moderation_cases'::name, 'moderation_cases_validate_runtime_resolution_provenance'::name, 17::smallint, 'platform.validate_runtime_moderation_resolution_provenance()'::text)
  ) AS expected(table_schema, table_name, trigger_name, tgtype, function_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = expected.table_schema
      AND relation.relname = expected.table_name
      AND trigger.tgname = expected.trigger_name
      AND trigger.tgtype = expected.tgtype
      AND trigger.tgfoid = pg_catalog.to_regprocedure(expected.function_name)
      AND NOT trigger.tgisinternal
      AND trigger.tgconstraint <> 0
      AND trigger.tgdeferrable
      AND trigger.tginitdeferred
      AND trigger.tgenabled IN ('O', 'A')
  );
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION
      'Runtime moderation provenance trigger coverage is incomplete: %', violation;
  END IF;

  IF (SELECT count(*) FROM platform.admin_roles) <> 5
    OR (SELECT count(DISTINCT permission) FROM platform.admin_role_permissions) <> 8 THEN
    RAISE EXCEPTION 'Administrator RBAC seed inventory is incomplete';
  END IF;

  IF current_setting('server_version_num')::integer < 170000 THEN
    RAISE EXCEPTION 'AlphaNet runtime requires PostgreSQL 17 or newer';
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
