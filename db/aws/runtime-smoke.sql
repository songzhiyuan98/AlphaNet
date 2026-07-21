\set ON_ERROR_STOP on

SELECT current_user = :'runtime_role' AS connected_as_runtime
\gset
\if :connected_as_runtime
\else
  SELECT 1 / 0 AS smoke_test_must_connect_as_runtime_role;
\endif

BEGIN;

DO $runtime_search_boundary$
BEGIN
  IF has_function_privilege(
       current_user,
       'system.redrive_content_embedding_job(uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'Runtime unexpectedly has embedding dead-letter redrive authority';
  END IF;

  IF has_function_privilege(
       current_user,
       'system.enqueue_content_embedding_job_from_revision()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'Runtime unexpectedly has direct Revision enqueue-trigger authority';
  END IF;

  IF has_column_privilege(
       current_user,
       'platform.content_embedding_chunks',
       'search_index_created_xid',
       'INSERT'
     )
     OR has_column_privilege(
       current_user,
       'platform.content_embedding_chunks',
       'created_at',
       'INSERT'
     ) THEN
    RAISE EXCEPTION
      'Runtime can override embedding snapshot identity';
  END IF;

  IF has_table_privilege(
       current_user,
       'system.content_search_candidate_snapshots',
       'INSERT'
     )
     OR has_table_privilege(
       current_user,
       'system.content_search_candidate_snapshots',
       'UPDATE'
     )
     OR has_table_privilege(
       current_user,
       'system.content_search_candidate_snapshots',
       'DELETE'
     ) THEN
    RAISE EXCEPTION
      'Runtime can bypass the bounded Search snapshot store function';
  END IF;

  BEGIN
    PERFORM system.redrive_content_embedding_job(
      pg_catalog.gen_random_uuid()
    );
    RAISE EXCEPTION
      'Runtime executed the migration/ops-only embedding redrive function';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM system.enqueue_content_embedding_job_from_revision();
    RAISE EXCEPTION
      'Runtime directly executed the Revision embedding enqueue trigger';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END;
$runtime_search_boundary$;

SELECT
  pg_catalog.gen_random_uuid()::text AS user_id,
  pg_catalog.gen_random_uuid()::text AS actor_id,
  pg_catalog.gen_random_uuid()::text AS target_actor_id,
  pg_catalog.gen_random_uuid()::text AS agent_id,
  pg_catalog.gen_random_uuid()::text AS policy_id,
  pg_catalog.gen_random_uuid()::text AS replacement_policy_id,
  pg_catalog.gen_random_uuid()::text AS credential_id,
  pg_catalog.gen_random_uuid()::text AS replacement_credential_id,
  pg_catalog.gen_random_uuid()::text AS follow_id,
  pg_catalog.gen_random_uuid()::text AS search_event_id,
  pg_catalog.gen_random_uuid()::text AS content_community_id,
  pg_catalog.gen_random_uuid()::text AS content_id,
  pg_catalog.gen_random_uuid()::text AS content_revision_id,
  pg_catalog.gen_random_uuid()::text AS content_idempotency_id,
  pg_catalog.gen_random_uuid()::text AS content_outbox_id,
  'css_' || left(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 32)
    AS search_snapshot_id,
  pg_catalog.gen_random_uuid()::text AS search_snapshot_content_id,
  pg_catalog.gen_random_uuid()::text AS search_snapshot_revision_id,
  pg_catalog.gen_random_uuid()::text AS aggregate_id,
  pg_catalog.gen_random_uuid()::text AS consumer_suffix
\gset

INSERT INTO auth.users (
  id,
  name,
  email,
  email_verified,
  created_at,
  updated_at
)
VALUES (
  :'user_id',
  'AWS runtime smoke',
  :'user_id' || '@runtime-smoke.invalid',
  true,
  clock_timestamp(),
  clock_timestamp()
);

SELECT id::text AS owner_id
FROM platform.owners
WHERE auth_user_id = :'user_id'
\gset

INSERT INTO auth.verifications (
  id,
  identifier,
  value,
  expires_at,
  created_at,
  updated_at
)
VALUES (
  pg_catalog.gen_random_uuid(),
  'runtime-smoke:' || :'user_id',
  :'user_id',
  clock_timestamp() + interval '5 minutes',
  clock_timestamp(),
  clock_timestamp()
);

DELETE FROM auth.verifications
WHERE identifier = 'runtime-smoke:' || :'user_id';

INSERT INTO platform.actors (
  id,
  kind,
  owner_id,
  handle,
  display_name,
  status
)
VALUES (
  :'actor_id',
  'agent',
  :'owner_id',
  'smoke-' || left(replace(:'actor_id', '-', ''), 20),
  'AWS runtime smoke Agent',
  'active'
);

INSERT INTO platform.agents (
  id,
  actor_id,
  owner_id,
  discovery_tags,
  status,
  activated_at
)
VALUES (
  :'agent_id',
  :'actor_id',
  :'owner_id',
  ARRAY['risk']::text[],
  'active',
  clock_timestamp()
);

INSERT INTO platform.actors (
  id,
  kind,
  owner_id,
  handle,
  display_name,
  status
)
VALUES (
  :'target_actor_id',
  'human',
  :'owner_id',
  'smoke-target-' || left(replace(:'target_actor_id', '-', ''), 16),
  'AWS runtime smoke Follow target',
  'active'
);

INSERT INTO platform.agent_policies (
  id,
  agent_id,
  tier,
  defaults_version,
  policy_schema_version,
  version,
  rules,
  is_active,
  configured_by_owner_id
)
VALUES (
  :'policy_id',
  :'agent_id',
  'assisted',
  'agent-permission-defaults-v1',
  1,
  1,
  '{}'::jsonb,
  true,
  :'owner_id'
);

UPDATE platform.registration_controls
SET active_agent_count = active_agent_count + 1
WHERE id = true;

INSERT INTO platform.credentials (
  id,
  owner_id,
  agent_id,
  name,
  credential_type,
  token_prefix,
  secret_digest,
  pepper_version,
  scopes,
  audience,
  policy_ceiling,
  policy_ceiling_defaults_version,
  policy_ceiling_schema_version,
  policy_ceiling_rules,
  expires_at
)
VALUES (
  :'credential_id',
  :'owner_id',
  :'agent_id',
  'AWS runtime smoke credential',
  'static_api_key',
  'aln_v1_' || left(replace(:'credential_id', '-', ''), 12),
  public.digest('runtime-smoke:' || :'credential_id', 'sha256'),
  1,
  ARRAY['research:read']::text[],
  'urn:alphanet:api:v1',
  'assisted',
  'agent-permission-defaults-v1',
  1,
  '{}'::jsonb,
  clock_timestamp() + interval '1 day'
);

INSERT INTO platform.follows (
  id,
  follower_actor_id,
  target_type,
  target_actor_id,
  notification_level
)
VALUES (
  :'follow_id',
  :'actor_id',
  'actor',
  :'target_actor_id',
  'feed_only'
);

UPDATE platform.follows
SET notification_level = 'all_events'
WHERE id = :'follow_id'
  AND follower_actor_id = :'actor_id';

DELETE FROM platform.follows
WHERE id = :'follow_id'
  AND follower_actor_id = :'actor_id';

UPDATE platform.actors
SET bio = 'Least-privilege runtime smoke test'
WHERE id = :'actor_id';

UPDATE platform.agents
SET discovery_tags = ARRAY['risk', 'valuation']::text[]
WHERE id = :'agent_id';

UPDATE platform.agent_policies
SET is_active = false
WHERE id = :'policy_id'
  AND agent_id = :'agent_id'
  AND is_active;

INSERT INTO platform.agent_policies (
  id,
  agent_id,
  tier,
  defaults_version,
  policy_schema_version,
  version,
  rules,
  is_active,
  configured_by_owner_id
)
VALUES (
  :'replacement_policy_id',
  :'agent_id',
  'read_only',
  'agent-permission-defaults-v1',
  1,
  2,
  '{}'::jsonb,
  true,
  :'owner_id'
);

UPDATE platform.credentials
SET revoked_at = clock_timestamp()
WHERE id = :'credential_id'
  AND owner_id = :'owner_id'
  AND agent_id = :'agent_id';

INSERT INTO platform.credentials (
  id,
  owner_id,
  agent_id,
  name,
  credential_type,
  token_prefix,
  secret_digest,
  pepper_version,
  scopes,
  audience,
  policy_ceiling,
  policy_ceiling_defaults_version,
  policy_ceiling_schema_version,
  policy_ceiling_rules,
  expires_at,
  replaces_credential_id
)
SELECT
  :'replacement_credential_id',
  credential.owner_id,
  credential.agent_id,
  credential.name,
  credential.credential_type,
  'aln_v1_' || left(replace(:'replacement_credential_id', '-', ''), 12),
  public.digest(
    'runtime-smoke:' || :'replacement_credential_id',
    'sha256'
  ),
  credential.pepper_version,
  credential.scopes,
  credential.audience,
  credential.policy_ceiling,
  credential.policy_ceiling_defaults_version,
  credential.policy_ceiling_schema_version,
  credential.policy_ceiling_rules,
  credential.expires_at,
  credential.id
FROM platform.credentials AS credential
WHERE credential.id = :'credential_id'
  AND credential.revoked_at IS NOT NULL;

SET CONSTRAINTS ALL IMMEDIATE;

-- Build one complete Runtime create-post bundle, then prove that possession of
-- the narrow soft-delete columns is not an independent write path. Switching
-- the deferred guard to IMMEDIATE exercises the same validation PostgreSQL
-- performs at COMMIT while the surrounding smoke transaction remains cleanly
-- rollbackable.
SET CONSTRAINTS ALL DEFERRED;

INSERT INTO platform.communities (
  id,
  slug,
  name,
  description,
  kind
)
VALUES (
  :'content_community_id',
  'runtime-smoke-' || left(replace(:'content_community_id', '-', ''), 20),
  'AWS runtime smoke Community',
  'Temporary Runtime content provenance fixture.',
  'general'
);

INSERT INTO platform.idempotency_records (
  id,
  principal_scope_key,
  owner_id,
  agent_id,
  actor_id,
  credential_id,
  operation,
  idempotency_key,
  request_digest,
  status,
  expires_at
)
VALUES (
  :'content_idempotency_id',
  'credential:' || :'replacement_credential_id',
  :'owner_id',
  :'agent_id',
  :'actor_id',
  :'replacement_credential_id',
  'create_post',
  'runtime-smoke-create-' || :'content_id',
  public.digest('runtime-smoke-create:' || :'content_id', 'sha256'),
  'in_progress',
  clock_timestamp() + interval '30 days'
);

INSERT INTO platform.content_items (
  id,
  kind,
  author_actor_id,
  primary_community_id,
  root_id,
  depth
)
VALUES (
  :'content_id',
  'post',
  :'actor_id',
  :'content_community_id',
  :'content_id',
  0
);

INSERT INTO platform.content_revisions (
  id,
  content_id,
  revision_number,
  title,
  body_markdown,
  body_plain_text,
  created_by_actor_id,
  source_version,
  content_hash,
  public_node_serialized_bytes
)
VALUES (
  :'content_revision_id',
  :'content_id',
  1,
  'AWS Runtime provenance smoke',
  'A complete Runtime bundle creates this rollback-only post.',
  'A complete Runtime bundle creates this rollback-only post.',
  :'actor_id',
  1,
  public.digest('runtime-smoke-revision:' || :'content_id', 'sha256'),
  512
);

UPDATE platform.content_items
SET current_revision_id = :'content_revision_id'
WHERE id = :'content_id'
  AND version = 1
  AND current_revision_id IS NULL;

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
  :'content_outbox_id',
  'content',
  :'content_id',
  1,
  'content.published',
  1,
  jsonb_build_object(
    'actor_id', :'actor_id',
    'content_id', :'content_id',
    'kind', 'post',
    'revision_id', :'content_revision_id'
  )
);

INSERT INTO platform.action_logs (
  event_class,
  actor_id,
  actor_kind,
  owner_id,
  agent_id,
  credential_id,
  channel,
  approval_method,
  authentication_assurance,
  authorization_snapshot,
  action,
  target_type,
  target_id,
  decision,
  outcome,
  outbox_event_id,
  policy_version,
  request_id,
  after_state
)
VALUES (
  'domain_write',
  :'actor_id',
  'agent',
  :'owner_id',
  :'agent_id',
  :'replacement_credential_id',
  'rest',
  'policy_auto',
  'agent_credential',
  '{"decision":"allow"}'::jsonb,
  'content.create_post',
  'content',
  :'content_id',
  'allow',
  'succeeded',
  :'content_outbox_id',
  2,
  'runtime-smoke-create-' || :'content_id',
  jsonb_build_object(
    'content_id', :'content_id',
    'idempotency_record_id', :'content_idempotency_id',
    'resource_version', 1,
    'revision_id', :'content_revision_id'
  )
);

UPDATE platform.idempotency_records
SET status = 'succeeded',
    response_code = 201,
    response_body = '{"operation":"create_post","status":"succeeded"}'::jsonb,
    resource_id = :'content_id',
    terminal_at = clock_timestamp()
WHERE id = :'content_idempotency_id'
  AND status = 'in_progress';

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

SAVEPOINT runtime_raw_delete_probe;
UPDATE platform.content_items
SET version = version + 1,
    lifecycle_state = 'deleted',
    deleted_at = clock_timestamp()
WHERE id = :'content_id'
  AND version = 1
  AND lifecycle_state = 'published';

\set ON_ERROR_STOP off
SET CONSTRAINTS ALL IMMEDIATE;
\set raw_delete_sqlstate :SQLSTATE
ROLLBACK TO SAVEPOINT runtime_raw_delete_probe;
\set raw_delete_rollback_sqlstate :SQLSTATE
\set ON_ERROR_STOP on

SELECT (
  :'raw_delete_sqlstate' = '23514'
  AND :'raw_delete_rollback_sqlstate' = '00000'
) AS raw_delete_rejected_by_deferred_provenance
\gset

\if :raw_delete_rejected_by_deferred_provenance
\else
  SELECT 1 / 0 AS raw_runtime_delete_bypassed_commit_provenance;
\endif

RELEASE SAVEPOINT runtime_raw_delete_probe;

INSERT INTO platform.agent_search_activity_events (
  id,
  request_id,
  agent_id,
  actor_id,
  credential_id,
  query_hmac,
  query_key_version,
  surface,
  search_mode
)
VALUES (
  :'search_event_id',
  'req_' || left(replace(:'search_event_id', '-', ''), 32),
  :'agent_id',
  :'actor_id',
  :'replacement_credential_id',
  public.digest('runtime-smoke-query:' || :'search_event_id', 'sha256'),
  1,
  'rest',
  'hybrid'
);

UPDATE platform.agent_search_activity_events
SET outcome = 'succeeded',
    result_count = 1,
    latency_ms = 1,
    fallback_reason_code = 'SEMANTIC_INDEX_NOT_READY'
WHERE id = :'search_event_id'
  AND actor_id = :'actor_id'
  AND outcome = 'started';

SELECT system.store_content_search_candidate_snapshot(
  :'search_snapshot_id',
  public.digest('runtime-smoke-binding:' || :'search_snapshot_id', 'sha256'),
  jsonb_build_array(jsonb_build_object(
    'content_id', :'search_snapshot_content_id',
    'revision_id', :'search_snapshot_revision_id',
    'published_at', '2026-07-21T00:00:00.000Z',
    'score', 1.0,
    'matched_fields', jsonb_build_array('body', 'semantic')
  )),
  clock_timestamp() + interval '5 minutes'
) AS search_snapshot_stored
\gset

SELECT system.purge_expired_content_search_candidate_snapshots(1000)
  AS expired_search_snapshot_purge_count
\gset

INSERT INTO system.outbox_events (
  aggregate_type,
  aggregate_id,
  aggregate_sequence,
  event_type,
  payload
)
VALUES (
  'aws_runtime_smoke',
  :'aggregate_id',
  1,
  'aws_runtime_smoke.created',
  '{}'::jsonb
)
RETURNING id::text AS event_id
\gset

INSERT INTO system.outbox_consumers (
  consumer_name,
  event_types,
  replay_from
)
VALUES (
  'aws-runtime-smoke:' || :'consumer_suffix',
  ARRAY['aws_runtime_smoke.created']::text[],
  '-infinity'::timestamptz
);

INSERT INTO system.outbox_consumer_deliveries (
  consumer_name,
  event_id,
  max_attempts,
  available_at
)
VALUES (
  'aws-runtime-smoke:' || :'consumer_suffix',
  :'event_id',
  3,
  clock_timestamp()
);

UPDATE system.outbox_consumer_deliveries
SET lease_owner = 'runtime-smoke',
    lease_expires_at = clock_timestamp() + interval '30 seconds',
    attempts = 1,
    updated_at = clock_timestamp()
WHERE consumer_name = 'aws-runtime-smoke:' || :'consumer_suffix'
  AND event_id = :'event_id';

INSERT INTO system.outbox_consumer_receipts (
  consumer_name,
  event_id,
  result
)
VALUES (
  'aws-runtime-smoke:' || :'consumer_suffix',
  :'event_id',
  '{"smoke":"passed"}'::jsonb
);

SELECT (
  EXISTS (
    SELECT 1
    FROM platform.agents
    WHERE id = :'agent_id'
      AND discovery_tags = ARRAY['risk', 'valuation']::text[]
  )
  AND EXISTS (
    SELECT 1
    FROM platform.agent_policies
    WHERE id = :'replacement_policy_id'
      AND agent_id = :'agent_id'
      AND tier = 'read_only'
      AND version = 2
      AND is_active
  )
  AND EXISTS (
    SELECT 1
    FROM platform.credentials AS replacement
    JOIN platform.credentials AS predecessor
      ON predecessor.id = replacement.replaces_credential_id
    WHERE replacement.id = :'replacement_credential_id'
      AND replacement.owner_id = :'owner_id'
      AND replacement.agent_id = :'agent_id'
      AND replacement.policy_ceiling = 'assisted'
      AND replacement.policy_ceiling_defaults_version =
        'agent-permission-defaults-v1'
      AND replacement.policy_ceiling_schema_version = 1
      AND replacement.policy_ceiling_rules = '{}'::jsonb
      AND replacement.revoked_at IS NULL
      AND predecessor.id = :'credential_id'
      AND predecessor.revoked_at IS NOT NULL
      AND predecessor.policy_ceiling = replacement.policy_ceiling
      AND predecessor.policy_ceiling_defaults_version =
        replacement.policy_ceiling_defaults_version
      AND predecessor.policy_ceiling_schema_version =
        replacement.policy_ceiling_schema_version
      AND predecessor.policy_ceiling_rules =
        replacement.policy_ceiling_rules
  )
  AND NOT EXISTS (
    SELECT 1
    FROM platform.follows
    WHERE id = :'follow_id'
  )
  AND EXISTS (
    SELECT 1
    FROM platform.content_items
    WHERE id = :'content_id'
      AND version = 1
      AND current_revision_id = :'content_revision_id'
      AND lifecycle_state = 'published'
      AND deleted_at IS NULL
  )
  AND EXISTS (
    SELECT 1
    FROM system.actor_follow_epochs
    WHERE actor_id = :'actor_id'
      AND epoch = 3
  )
  AND EXISTS (
    SELECT 1
    FROM platform.agent_search_activity_events
    WHERE id = :'search_event_id'
      AND actor_id = :'actor_id'
      AND outcome = 'succeeded'
      AND result_count = 1
      AND latency_ms = 1
      AND fallback_reason_code = 'SEMANTIC_INDEX_NOT_READY'
      AND finalized_at IS NOT NULL
      AND expires_at = occurred_at + interval '30 days'
  )
  AND :'search_snapshot_stored'::boolean
  AND :'expired_search_snapshot_purge_count'::integer BETWEEN 0 AND 1000
  AND EXISTS (
    SELECT 1
    FROM system.content_search_candidate_snapshots
    WHERE snapshot_id = :'search_snapshot_id'
      AND binding_hmac = public.digest(
        'runtime-smoke-binding:' || :'search_snapshot_id',
        'sha256'
      )
      AND jsonb_array_length(candidates) = 1
  )
  AND EXISTS (
    SELECT 1
    FROM system.outbox_aggregate_heads
    WHERE aggregate_type = 'aws_runtime_smoke'
      AND aggregate_id = :'aggregate_id'
      AND last_sequence = 1
  )
  AND EXISTS (
    SELECT 1
    FROM system.outbox_consumer_receipts
    WHERE consumer_name = 'aws-runtime-smoke:' || :'consumer_suffix'
      AND event_id = :'event_id'
  )
) AS runtime_smoke_passed
\gset

\if :runtime_smoke_passed
\else
  SELECT 1 / 0 AS runtime_smoke_invariant_failed;
\endif

ROLLBACK;

\echo 'AlphaNet AWS runtime SQL smoke test passed and rolled back.'
