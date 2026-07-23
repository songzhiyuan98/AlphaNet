#!/usr/bin/env bash
set -Eeuo pipefail

if ! command -v createdb >/dev/null 2>&1 ||
   ! command -v dropdb >/dev/null 2>&1 ||
   ! command -v git >/dev/null 2>&1 ||
   ! command -v psql >/dev/null 2>&1; then
  echo "createdb, dropdb, git, and psql are required to check forward migrations." >&2
  exit 127
fi

repository_root="${REPOSITORY_ROOT:-$(git rev-parse --show-toplevel)}"
readonly repository_root
readonly full_migrations_dir="${repository_root}/db/migrations"
readonly published_agent_v1_checksum="8d2aa4d3fe53bfda58b644460b386763350b38e7aaf666fb239ee7ba03a56528"
readonly content_reactions_checksum="da6750692823bb082c1c417d266fd9e1c3585356fd5a25eae256fc6e7c5441bf"
readonly agent_policy_control_checksum="5311bfde7d77bd2ddf6d7207675284a3259db1722b20e21cecb97f69b9fb6826"
readonly follow_graph_checksum="3505e7a190e266d792c4f0e7b03997a6042687f1fe12550fa80d1250fa2cf83c"
readonly content_revision_write_checksum="c0e3b1f605651e30a619caede945eb978840a725dc0585bb1e05abc9d88d484c"
readonly content_search_v1_checksum="ae8c3d68863d78b8d131129a4f3cedd4f6026e733530eaf8f6a563b7fdfeeaf2"
readonly content_delete_antispam_v1_checksum="c02af8f023edc8ab6eb58fc78afef9a5e4c0909f4833e04666ddfcfc384a2b18"
readonly web_reporting_content_moderation_v1_checksum="d5d7e900d8270914ff927c7a08ec89f677a9fcfbd71d33238756394f5ec60c3b"
readonly notifications_v1_checksum="41af3431fa6d8cbaa7ac7aea9aaf35a3791a02ec5407cda7ae159ff572fbf95e"
readonly content_ranking_v1_checksum="2fc7d315c16559f29e0688fce09a16d4053e2a09b7d7fa1a00a546fd6d572dc9"
readonly remote_mcp_v1_checksum="a43f96760a7734c6b036f74275f9a349a09f5ef8ae3328ae6c80ff2488d152a5"
readonly remote_mcp_oauth_hardening_v1_checksum="3e9fa98b188a79866db57d989bcb1b15dec5d1bfa82fff45edea1b87c06d012a"
readonly remote_mcp_oauth_lifecycle_maintenance_v1_checksum="0361f188331c627cbbce6050311f70ece5e1b767e2543573629d6277610643f4"
readonly owner_web_social_v1_checksum="77b07de89c8b44de4e933a408408e191b8fdae16476f320fe7a1adb2e61b0e01"
readonly owner_web_social_hardening_v1_checksum="96c121bf0c695bbe7a6765ac04288dc17a4552880294835977d861968531844e"
readonly suffix="${GITHUB_RUN_ID:-local}_${RANDOM}_$$"
readonly empty_database="alphanet_migration_empty_${suffix}"
readonly owner_database="alphanet_migration_owner_${suffix}"
readonly published_agent_database="alphanet_migration_agent_v1_${suffix}"
owner_migrations_dir="$(mktemp -d)"
published_agent_migrations_dir="$(mktemp -d)"

cleanup() {
  dropdb --if-exists --force "${empty_database}" >/dev/null 2>&1 || true
  dropdb --if-exists --force "${owner_database}" >/dev/null 2>&1 || true
  dropdb --if-exists --force "${published_agent_database}" >/dev/null 2>&1 || true
  rm -rf "${owner_migrations_dir}"
  rm -rf "${published_agent_migrations_dir}"
}
trap cleanup EXIT

run_migrations() {
  local database="$1"
  local migrations="$2"
  PGDATABASE="${database}" MIGRATIONS_DIR="${migrations}" \
    bash "${repository_root}/db/scripts/migrate.sh"
}

createdb "${empty_database}"
run_migrations "${empty_database}" "${full_migrations_dir}"
# A second pass proves the migration ledger is idempotent and checksum-stable.
run_migrations "${empty_database}" "${full_migrations_dir}"

createdb "${owner_database}"
for migration in \
  000001_platform_foundation.up.sql \
  000002_auth_schema.up.sql \
  000003_owner_identity.up.sql; do
  ln -s "${full_migrations_dir}/${migration}" "${owner_migrations_dir}/${migration}"
done
run_migrations "${owner_database}" "${owner_migrations_dir}"
run_migrations "${owner_database}" "${full_migrations_dir}"

createdb "${published_agent_database}"
for migration in \
  000001_platform_foundation.up.sql \
  000002_auth_schema.up.sql \
  000003_owner_identity.up.sql; do
  ln -s \
    "${full_migrations_dir}/${migration}" \
    "${published_agent_migrations_dir}/${migration}"
done
# 000004 has already shipped. Reconstruct its committed bytes instead of using
# a possibly edited worktree copy, then prove the append-only migration can
# upgrade that real release state.
git -C "${repository_root}" show \
  HEAD:db/migrations/000004_agent_identity_and_credentials.up.sql \
  >"${published_agent_migrations_dir}/000004_agent_identity_and_credentials.up.sql"
if command -v sha256sum >/dev/null 2>&1; then
  actual_agent_v1_checksum="$(
    sha256sum \
      "${published_agent_migrations_dir}/000004_agent_identity_and_credentials.up.sql" |
      awk '{print $1}'
  )"
elif command -v shasum >/dev/null 2>&1; then
  actual_agent_v1_checksum="$(
    shasum -a 256 \
      "${published_agent_migrations_dir}/000004_agent_identity_and_credentials.up.sql" |
      awk '{print $1}'
  )"
else
  echo "sha256sum or shasum is required to verify the published Agent-v1 baseline." >&2
  exit 127
fi
if [[ "${actual_agent_v1_checksum}" != "${published_agent_v1_checksum}" ]]; then
  echo "Committed 000004 no longer matches the published Agent-v1 baseline." >&2
  exit 1
fi
run_migrations "${published_agent_database}" "${published_agent_migrations_dir}"
PGDATABASE="${published_agent_database}" psql -X --set=ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DO $$
DECLARE
  legacy_actor_id uuid;
  legacy_agent_id uuid;
  legacy_auth_user_id uuid;
  legacy_owner_id uuid;
BEGIN
  INSERT INTO auth.users (
    name,
    email,
    email_verified,
    created_at,
    updated_at
  )
  VALUES (
    'Forward Migration Owner',
    'forward-migration-owner@example.test',
    true,
    clock_timestamp(),
    clock_timestamp()
  )
  RETURNING id INTO legacy_auth_user_id;

  SELECT id
  INTO STRICT legacy_owner_id
  FROM platform.owners
  WHERE auth_user_id = legacy_auth_user_id;

  INSERT INTO platform.actors (
    kind,
    owner_id,
    handle,
    display_name,
    status
  )
  VALUES (
    'agent',
    legacy_owner_id,
    'forward.migration-agent',
    'Forward Migration Agent',
    'active'
  )
  RETURNING id INTO legacy_actor_id;

  INSERT INTO platform.agents (
    actor_id,
    owner_id,
    discovery_tags,
    status,
    activated_at
  )
  VALUES (
    legacy_actor_id,
    legacy_owner_id,
    ARRAY['legacy.']::text[],
    'active',
    clock_timestamp()
  )
  RETURNING id INTO legacy_agent_id;

  INSERT INTO platform.agent_policies (
    agent_id,
    tier,
    defaults_version,
    version,
    configured_by_owner_id
  )
  VALUES (
    legacy_agent_id,
    'assisted',
    'agent-permission-defaults-v1',
    1,
    legacy_owner_id
  );

  UPDATE platform.registration_controls
  SET active_agent_count = active_agent_count + 1
  WHERE id = true;

  INSERT INTO platform.credentials (
    owner_id,
    agent_id,
    name,
    credential_type,
    token_prefix,
    secret_digest,
    scopes,
    audience,
    policy_ceiling,
    expires_at
  )
  VALUES (
    legacy_owner_id,
    legacy_agent_id,
    'CI legacy static key',
    'static_api_key',
    'aln_v1_abcdefghijkl',
    decode(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'hex'
    ),
    ARRAY['research:read']::text[],
    'urn:alphanet:api:v1',
    'assisted',
    clock_timestamp() + interval '90 days'
  );

  -- The published v1 audit rule rejected secret-shaped field names but did
  -- not inspect values stored under an innocuous key. Preserve a real legacy
  -- row across the upgrade while requiring v2 to reject equivalent new rows.
  INSERT INTO platform.action_logs (
    event_class,
    owner_id,
    channel,
    approval_method,
    approved_by_owner_id,
    authentication_assurance,
    authorization_snapshot,
    action,
    target_type,
    target_id,
    decision,
    outcome,
    request_id,
    after_state
  )
  VALUES (
    'authorization_change',
    legacy_owner_id,
    'migration',
    'owner_direct',
    legacy_owner_id,
    'migration_fixture',
    jsonb_build_object('owner_session', true),
    'migration.preserve_legacy_audit',
    'agent',
    legacy_agent_id::text,
    'allow',
    'succeeded',
    'forward-migration-legacy-action-log',
    jsonb_build_object(
      'note',
      'aln_v1_' || 'abcdefghijkl' || '_' ||
        'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
    )
  );
END;
$$;
COMMIT;
SQL

# Pause this upgrade at the published research-core boundary so 000007 proves
# that it backfills a real 000006 PendingAction whose resource_id still carries
# the legacy action identity.
for migration in \
  000005_agent_identity_hardening.up.sql \
  000006_community_research_core.up.sql; do
  ln -s \
    "${full_migrations_dir}/${migration}" \
    "${published_agent_migrations_dir}/${migration}"
done
run_migrations "${published_agent_database}" "${published_agent_migrations_dir}"
PGDATABASE="${published_agent_database}" psql -X --set=ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DO $$
DECLARE
  approved_action_id uuid;
  approved_audit_id uuid;
  approved_expires_at timestamptz;
  approved_fixture_index integer;
  approved_fixture_key text;
  approved_fixture_requested_at timestamptz;
  approved_idempotency_id uuid;
  approved_next_attempt_at timestamptz;
  approved_outbox_id uuid;
  legacy_action_id uuid := gen_random_uuid();
  legacy_actor_id uuid;
  legacy_agent_id uuid;
  legacy_audit_id uuid := gen_random_uuid();
  legacy_credential_id uuid;
  legacy_community_id uuid := gen_random_uuid();
  legacy_content_id uuid := gen_random_uuid();
  legacy_content_id_2 uuid := gen_random_uuid();
  legacy_idempotency_id uuid := gen_random_uuid();
  legacy_outbox_id uuid := gen_random_uuid();
  legacy_owner_id uuid;
  legacy_policy_id uuid;
  legacy_policy_version bigint;
  legacy_revision_id uuid := gen_random_uuid();
  legacy_revision_id_2 uuid := gen_random_uuid();
  legacy_request_digest bytea := digest(
    'forward-migration-pending-action',
    'sha256'
  );
BEGIN
  SELECT
    actor.id,
    actor.owner_id,
    agent.id,
    credential.id,
    policy.id,
    policy.version
  INTO STRICT
    legacy_actor_id,
    legacy_owner_id,
    legacy_agent_id,
    legacy_credential_id,
    legacy_policy_id,
    legacy_policy_version
  FROM platform.actors AS actor
  JOIN platform.agents AS agent ON agent.actor_id = actor.id
  JOIN platform.credentials AS credential ON credential.agent_id = agent.id
  JOIN platform.agent_policies AS policy
    ON policy.agent_id = agent.id
   AND policy.is_active
  WHERE actor.handle = 'forward.migration-agent'
    AND credential.name = 'CI legacy static key';

  -- Prove 000013 creates a low-priority embedding backfill job for a real
  -- Revision that existed before Search v1, rather than only validating an
  -- empty-table upgrade.
  INSERT INTO platform.communities (
    id,
    slug,
    name,
    description,
    status,
    kind
  )
  VALUES (
    legacy_community_id,
    'forward-search-' || left(replace(legacy_community_id::text, '-', ''), 20),
    'Forward Search Fixture',
    'Content created before Search v1 for embedding backfill verification.',
    'active',
    'general'
  );

  INSERT INTO platform.content_items (
    id,
    kind,
    author_actor_id,
    primary_community_id,
    root_id,
    parent_id,
    depth
  )
  VALUES (
    legacy_content_id,
    'post',
    legacy_actor_id,
    legacy_community_id,
    legacy_content_id,
    NULL,
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
    legacy_revision_id,
    legacy_content_id,
    1,
    'Forward Search Research',
    'Pre-Search Revision for deterministic historical backfill.',
    'Pre-Search Revision for deterministic historical backfill.',
    legacy_actor_id,
    1,
    digest(
      'Pre-Search Revision for deterministic historical backfill.',
      'sha256'
    ),
    512
  );

  UPDATE platform.content_items
  SET current_revision_id = legacy_revision_id
  WHERE id = legacy_content_id;

  INSERT INTO platform.content_items (
    id,
    kind,
    author_actor_id,
    primary_community_id,
    root_id,
    parent_id,
    depth
  )
  VALUES (
    legacy_content_id_2,
    'post',
    legacy_actor_id,
    legacy_community_id,
    legacy_content_id_2,
    NULL,
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
    legacy_revision_id_2,
    legacy_content_id_2,
    1,
    'Second Forward Search Research',
    'Second pre-Search Revision verifies multirow backfill timestamps.',
    'Second pre-Search Revision verifies multirow backfill timestamps.',
    legacy_actor_id,
    1,
    digest(
      'Second pre-Search Revision verifies multirow backfill timestamps.',
      'sha256'
    ),
    512
  );

  UPDATE platform.content_items
  SET current_revision_id = legacy_revision_id_2
  WHERE id = legacy_content_id_2;

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
    legacy_idempotency_id,
    'credential:' || legacy_credential_id::text,
    legacy_owner_id,
    legacy_agent_id,
    legacy_actor_id,
    legacy_credential_id,
    'create_post',
    'forward-migration-pending-action',
    legacy_request_digest,
    'in_progress',
    clock_timestamp() + interval '8 days'
  );

  INSERT INTO system.outbox_events (
    id,
    aggregate_type,
    aggregate_id,
    aggregate_sequence,
    event_type,
    payload
  )
  VALUES (
    legacy_outbox_id,
    'pending_action',
    legacy_action_id,
    1,
    'action.pending_approval',
    jsonb_build_object('action_id', legacy_action_id)
  );

  INSERT INTO platform.action_logs (
    id,
    event_class,
    actor_id,
    actor_kind,
    owner_id,
    agent_id,
    credential_id,
    channel,
    authorization_snapshot,
    action,
    target_type,
    target_id,
    decision,
    outcome,
    outbox_event_id,
    policy_version,
    request_id,
    reason_code
  )
  VALUES (
    legacy_audit_id,
    'domain_write',
    legacy_actor_id,
    'agent',
    legacy_owner_id,
    legacy_agent_id,
    legacy_credential_id,
    'migration',
    jsonb_build_object('scope', 'content:write'),
    'content.create_post',
    'pending_action',
    legacy_action_id,
    'require_approval',
    'pending',
    legacy_outbox_id,
    legacy_policy_version,
    'forward-migration-pending-action',
    'assisted_policy'
  );

  INSERT INTO platform.pending_actions (
    id,
    owner_id,
    agent_id,
    credential_id,
    principal_scope_key,
    operation,
    normalized_input_ciphertext,
    normalized_input_nonce,
    normalized_input_key_version,
    input_digest,
    idempotency_key,
    idempotency_record_id,
    decision_id,
    policy_id,
    policy_version,
    policy_snapshot,
    approval_summary,
    expires_at,
    audit_id
  )
  VALUES (
    legacy_action_id,
    legacy_owner_id,
    legacy_agent_id,
    legacy_credential_id,
    'credential:' || legacy_credential_id::text,
    'create_post',
    decode(repeat('ab', 48), 'hex'),
    decode(repeat('cd', 12), 'hex'),
    1,
    legacy_request_digest,
    'forward-migration-pending-action',
    legacy_idempotency_id,
    gen_random_uuid(),
    legacy_policy_id,
    legacy_policy_version,
    jsonb_build_object('decision', 'require_approval', 'layers', '[]'::jsonb),
    'Create one post after Owner approval.',
    clock_timestamp() + interval '1 day',
    legacy_audit_id
  );

  UPDATE platform.idempotency_records
  SET status = 'pending_approval',
      response_code = 202,
      response_body = jsonb_build_object('status', 'pending_approval'),
      resource_id = legacy_action_id
  WHERE id = legacy_idempotency_id;

  -- 000006 allowed both approved scheduling shapes below. Keep real rows at
  -- that published boundary so 000007 must normalize them before installing
  -- its stricter approved-state and time-order constraints.
  FOR approved_fixture_index IN 1..2 LOOP
    approved_action_id := gen_random_uuid();
    approved_audit_id := gen_random_uuid();
    approved_idempotency_id := gen_random_uuid();
    approved_outbox_id := gen_random_uuid();
    approved_fixture_key := CASE approved_fixture_index
      WHEN 1 THEN 'forward-migration-approved-null'
      ELSE 'forward-migration-approved-late'
    END;
    approved_fixture_requested_at := clock_timestamp();
    approved_expires_at := approved_fixture_requested_at + interval '1 day';
    approved_next_attempt_at := CASE approved_fixture_index
      WHEN 1 THEN NULL
      ELSE approved_expires_at + interval '1 hour'
    END;

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
      approved_idempotency_id,
      'credential:' || legacy_credential_id::text,
      legacy_owner_id,
      legacy_agent_id,
      legacy_actor_id,
      legacy_credential_id,
      'create_post',
      approved_fixture_key,
      digest(approved_fixture_key, 'sha256'),
      'in_progress',
      approved_fixture_requested_at + interval '8 days'
    );

    INSERT INTO system.outbox_events (
      id,
      aggregate_type,
      aggregate_id,
      aggregate_sequence,
      event_type,
      payload
    )
    VALUES (
      approved_outbox_id,
      'pending_action',
      approved_action_id,
      1,
      'action.pending_approval',
      jsonb_build_object('action_id', approved_action_id)
    );

    INSERT INTO platform.action_logs (
      id,
      event_class,
      actor_id,
      actor_kind,
      owner_id,
      agent_id,
      credential_id,
      channel,
      authorization_snapshot,
      action,
      target_type,
      target_id,
      decision,
      outcome,
      outbox_event_id,
      policy_version,
      request_id,
      reason_code
    )
    VALUES (
      approved_audit_id,
      'domain_write',
      legacy_actor_id,
      'agent',
      legacy_owner_id,
      legacy_agent_id,
      legacy_credential_id,
      'migration',
      jsonb_build_object('scope', 'content:write'),
      'content.create_post',
      'pending_action',
      approved_action_id,
      'require_approval',
      'pending',
      approved_outbox_id,
      legacy_policy_version,
      approved_fixture_key,
      'assisted_policy'
    );

    INSERT INTO platform.pending_actions (
      id,
      owner_id,
      agent_id,
      credential_id,
      principal_scope_key,
      operation,
      normalized_input_ciphertext,
      normalized_input_nonce,
      normalized_input_key_version,
      input_digest,
      idempotency_key,
      idempotency_record_id,
      decision_id,
      policy_id,
      policy_version,
      policy_snapshot,
      approval_summary,
      state,
      requested_at,
      expires_at,
      decided_at,
      decided_by_owner_id,
      approval_method,
      next_attempt_at,
      audit_id
    )
    VALUES (
      approved_action_id,
      legacy_owner_id,
      legacy_agent_id,
      legacy_credential_id,
      'credential:' || legacy_credential_id::text,
      'create_post',
      decode(repeat('ef', 48), 'hex'),
      decode(repeat('01', 12), 'hex'),
      1,
      digest(approved_fixture_key, 'sha256'),
      approved_fixture_key,
      approved_idempotency_id,
      gen_random_uuid(),
      legacy_policy_id,
      legacy_policy_version,
      jsonb_build_object(
        'decision',
        'require_approval',
        'layers',
        '[]'::jsonb
      ),
      'Create one post after Owner approval.',
      'approved',
      approved_fixture_requested_at,
      approved_expires_at,
      approved_fixture_requested_at + interval '1 second',
      legacy_owner_id,
      'owner_approval',
      approved_next_attempt_at,
      approved_audit_id
    );

    UPDATE platform.idempotency_records
    SET status = 'pending_approval',
        response_code = 202,
        response_body = jsonb_build_object('status', 'pending_approval'),
        resource_id = approved_action_id
    WHERE id = approved_idempotency_id;
  END LOOP;
END;
$$;
COMMIT;
SQL
run_migrations "${published_agent_database}" "${full_migrations_dir}"
PGDATABASE="${published_agent_database}" psql -X --set=ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DO $$
DECLARE
  claimed record;
  post_search_actor_id uuid;
  post_search_content_id uuid;
  post_search_revision_id uuid := gen_random_uuid();
  redriven boolean;
  retry_status text;
  persisted record;
  token_digest bytea := public.digest(
    'forward-search-redrive-token',
    'sha256'
  );
BEGIN
  SELECT *
  INTO claimed
  FROM system.claim_content_embedding_jobs(
    'forward-search-redrive',
    token_digest,
    1,
    60
  );

  IF claimed.job_id IS NULL THEN
    RAISE EXCEPTION 'forward Search redrive fixture could not claim a job';
  END IF;

  SELECT system.retry_content_embedding_job(
    claimed.job_id,
    'forward-search-redrive',
    token_digest,
    'NONRETRYABLE_FORWARD_TEST',
    30
  )
  INTO retry_status;
  IF retry_status IS DISTINCT FROM 'dead_lettered' THEN
    RAISE EXCEPTION
      'forward Search redrive fixture did not enter dead letter';
  END IF;

  SELECT system.redrive_content_embedding_job(claimed.job_id)
  INTO redriven;
  IF redriven IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'dead-lettered Search job was not redriven';
  END IF;

  SELECT
    job.status,
    job.attempts,
    job.available_at,
    job.created_at,
    job.lease_owner,
    job.lease_token_digest,
    job.lease_expires_at,
    job.last_error_code,
    job.completed_at,
    job.failed_at
  INTO STRICT persisted
  FROM system.content_embedding_jobs AS job
  WHERE job.id = claimed.job_id;

  IF persisted.status <> 'ready'
    OR persisted.attempts <> 0
    OR persisted.available_at < persisted.created_at
    OR persisted.lease_owner IS NOT NULL
    OR persisted.lease_token_digest IS NOT NULL
    OR persisted.lease_expires_at IS NOT NULL
    OR persisted.last_error_code IS NOT NULL
    OR persisted.completed_at IS NOT NULL
    OR persisted.failed_at IS NOT NULL THEN
    RAISE EXCEPTION 'redriven Search job retained terminal state';
  END IF;

  SELECT system.redrive_content_embedding_job(claimed.job_id)
  INTO redriven;
  IF redriven IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Search job redrive was not idempotent';
  END IF;

  SELECT content.id, content.author_actor_id
  INTO STRICT post_search_content_id, post_search_actor_id
  FROM platform.content_items AS content
  JOIN platform.content_revisions AS revision
    ON revision.id = content.current_revision_id
  WHERE revision.title = 'Forward Search Research';

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
    post_search_revision_id,
    post_search_content_id,
    2,
    'Post-Search Trigger Research',
    'A post-migration Revision must synchronously enqueue embedding work.',
    'A post-migration Revision must synchronously enqueue embedding work.',
    post_search_actor_id,
    2,
    digest(
      'A post-migration Revision must synchronously enqueue embedding work.',
      'sha256'
    ),
    512
  );

  IF NOT EXISTS (
    SELECT 1
    FROM system.content_embedding_jobs AS job
    WHERE job.revision_id = post_search_revision_id
      AND job.embedding_model = 'amazon.titan-embed-text-v2:0:512'
      AND job.status = 'ready'
      AND job.priority = 100
      AND job.attempts = 0
  ) THEN
    RAISE EXCEPTION
      'post-migration Revision was not synchronously enqueued for Search';
  END IF;
END;
$$;
ROLLBACK;
SQL
PGDATABASE="${published_agent_database}" psql -X --set=ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  legacy_actor_id uuid;
  legacy_owner_id uuid;
  updated_rows bigint;
BEGIN
  SELECT actor.id, actor.owner_id
  INTO STRICT legacy_actor_id, legacy_owner_id
  FROM platform.actors AS actor
  WHERE actor.handle = 'forward.migration-agent';

  -- Agent-facing display name and bio live on the public Actor row. These
  -- unrelated profile edits must not revalidate the grandfathered handle.
  UPDATE platform.actors
  SET display_name = 'Updated Forward Migration Agent',
      bio = 'Legacy identity remains editable after the forward migration.'
  WHERE id = legacy_actor_id;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  IF updated_rows <> 1 THEN
    RAISE EXCEPTION 'legacy Actor profile update did not affect exactly one row';
  END IF;

  -- Exercise the Agent UPDATE trigger without changing discovery_tags. A
  -- grandfathered tag must not freeze otherwise-valid Agent updates.
  UPDATE platform.agents
  SET updated_at = clock_timestamp()
  WHERE actor_id = legacy_actor_id;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  IF updated_rows <> 1 THEN
    RAISE EXCEPTION 'legacy Agent update did not affect exactly one row';
  END IF;

  BEGIN
    INSERT INTO platform.actors (
      kind,
      owner_id,
      handle,
      display_name,
      status
    )
    VALUES (
      'agent',
      legacy_owner_id,
      'new.invalid-handle',
      'Invalid New Handle',
      'draft'
    );
    RAISE EXCEPTION 'new non-canonical Actor handle was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO platform.actors (
      kind,
      owner_id,
      handle,
      display_name,
      status
    )
    VALUES (
      'agent',
      legacy_owner_id,
      'canonical-new-agent',
      'Invalid New Discovery Tag',
      'draft'
    )
    RETURNING id INTO legacy_actor_id;

    INSERT INTO platform.agents (
      actor_id,
      owner_id,
      discovery_tags,
      status
    )
    VALUES (
      legacy_actor_id,
      legacy_owner_id,
      ARRAY['new.']::text[],
      'draft'
    );
    RAISE EXCEPTION 'new non-canonical Agent discovery tag was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO platform.action_logs (
      event_class,
      owner_id,
      channel,
      approval_method,
      approved_by_owner_id,
      authentication_assurance,
      authorization_snapshot,
      action,
      target_type,
      target_id,
      decision,
      outcome,
      request_id,
      after_state
    )
    VALUES (
      'authorization_change',
      legacy_owner_id,
      'migration',
      'owner_direct',
      legacy_owner_id,
      'migration_fixture',
      jsonb_build_object('owner_session', true),
      'migration.reject_new_secret_value',
      'agent',
      legacy_actor_id::text,
      'allow',
      'succeeded',
      'forward-migration-rejected-action-log',
      jsonb_build_object(
        'note',
        'aln_v1_' || 'abcdefghijkl' || '_' ||
          'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
      )
    );
    RAISE EXCEPTION 'new secret-shaped ActionLog value was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;
SQL

for database in \
  "${empty_database}" \
  "${owner_database}" \
  "${published_agent_database}"; do
  result="$(
    PGDATABASE="${database}" psql -X -At \
      --set=ON_ERROR_STOP=1 \
      --set=published_agent_database="${published_agent_database}" \
      --set=content_reactions_checksum="${content_reactions_checksum}" \
      --set=agent_policy_control_checksum="${agent_policy_control_checksum}" \
      --set=follow_graph_checksum="${follow_graph_checksum}" \
      --set=content_revision_write_checksum="${content_revision_write_checksum}" \
      --set=content_search_v1_checksum="${content_search_v1_checksum}" \
      --set=content_delete_antispam_v1_checksum="${content_delete_antispam_v1_checksum}" \
      --set=web_reporting_content_moderation_v1_checksum="${web_reporting_content_moderation_v1_checksum}" \
      --set=notifications_v1_checksum="${notifications_v1_checksum}" \
      --set=content_ranking_v1_checksum="${content_ranking_v1_checksum}" \
      --set=remote_mcp_v1_checksum="${remote_mcp_v1_checksum}" \
      --set=remote_mcp_oauth_hardening_v1_checksum="${remote_mcp_oauth_hardening_v1_checksum}" \
      --set=remote_mcp_oauth_lifecycle_maintenance_v1_checksum="${remote_mcp_oauth_lifecycle_maintenance_v1_checksum}" \
      --set=owner_web_social_v1_checksum="${owner_web_social_v1_checksum}" \
      --set=owner_web_social_hardening_v1_checksum="${owner_web_social_hardening_v1_checksum}" <<'SQL'
SELECT
  (SELECT count(*) FROM system.schema_migrations) = 22
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000005'
      AND name = 'agent_identity_hardening'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000006'
      AND name = 'community_research_core'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000007'
      AND name = 'pending_action_execution'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000008'
      AND name = 'content_read_visibility_epochs'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000009'
      AND name = 'content_reactions'
      AND checksum = :'content_reactions_checksum'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000010'
      AND name = 'agent_policy_control'
      AND checksum = :'agent_policy_control_checksum'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000011'
      AND name = 'follow_graph'
      AND checksum = :'follow_graph_checksum'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000012'
      AND name = 'content_revision_write'
      AND checksum = :'content_revision_write_checksum'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000013'
      AND name = 'content_search_v1'
      AND checksum = :'content_search_v1_checksum'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000014'
      AND name = 'content_delete_antispam_v1'
      AND checksum = :'content_delete_antispam_v1_checksum'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000015'
      AND name = 'web_reporting_content_moderation_v1'
      AND checksum = :'web_reporting_content_moderation_v1_checksum'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000016'
      AND name = 'notifications_v1'
      AND checksum = :'notifications_v1_checksum'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000017'
      AND name = 'content_ranking_v1'
      AND checksum = :'content_ranking_v1_checksum'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000018'
      AND name = 'remote_mcp_oauth_v1'
      AND checksum = :'remote_mcp_v1_checksum'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000019'
      AND name = 'remote_mcp_oauth_hardening_v1'
      AND checksum = :'remote_mcp_oauth_hardening_v1_checksum'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000020'
      AND name = 'remote_mcp_oauth_lifecycle_maintenance_v1'
      AND checksum = :'remote_mcp_oauth_lifecycle_maintenance_v1_checksum'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000021'
      AND name = 'owner_web_social_v1'
      AND checksum = :'owner_web_social_v1_checksum'
  )
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000022'
      AND name = 'owner_web_social_hardening_v1'
      AND checksum = :'owner_web_social_hardening_v1_checksum'
  )
  AND (
    SELECT count(*) = 5
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'auth'
      AND relation.relkind IN ('p', 'r')
      AND relation.relname IN (
        'oauth_access_tokens',
        'oauth_clients',
        'oauth_consents',
        'oauth_jwks',
        'oauth_refresh_tokens'
      )
  )
  AND (
    SELECT count(*) = 4
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'platform'
      AND relation.relkind IN ('p', 'r')
      AND relation.relname IN (
        'oauth_access_token_jtis',
        'oauth_authorization_requests',
        'oauth_grants',
        'oauth_resource_configuration'
      )
  )
  AND to_regprocedure('platform.oauth_resource_is_valid(text)') IS NOT NULL
  AND to_regprocedure(
    'platform.expire_stale_oauth_pending_grants(uuid,text)'
  ) IS NOT NULL
  AND to_regprocedure(
    'platform.expire_stale_oauth_active_grants(uuid,text)'
  ) IS NOT NULL
  AND (
    SELECT count(*) = 3
    FROM pg_trigger AS trigger_record
    WHERE trigger_record.tgname IN (
      'oauth_consents_validate_grant_reference',
      'oauth_refresh_tokens_validate_grant_reference',
      'oauth_access_tokens_validate_grant_reference'
    )
      AND NOT trigger_record.tgisinternal
      AND trigger_record.tgenabled IN ('O', 'A')
  )
  AND (
    SELECT count(*) = 4
    FROM pg_class AS relation
    WHERE relation.oid IN (
      'platform.notifications'::regclass,
      'platform.notification_aggregate_actors'::regclass,
      'system.notification_change_journal'::regclass,
      'system.notification_recipient_sequences'::regclass
    )
  )
  AND to_regclass('platform.notifications_recipient_history_idx') IS NOT NULL
  AND to_regclass(
    'platform.notifications_recipient_unread_history_idx'
  ) IS NOT NULL
  AND to_regclass('platform.notifications_retention_idx') IS NOT NULL
  AND to_regclass('platform.notifications_symbol_ids_idx') IS NOT NULL
  AND to_regclass('platform.notifications_community_ids_idx') IS NOT NULL
  AND to_regprocedure(
    'system.project_notification(uuid,uuid,text,uuid,text,uuid,text[],uuid[],text,text,text,jsonb,text,timestamptz,text)'
  ) IS NOT NULL
  AND to_regprocedure(
    'system.project_reaction_notification(uuid,uuid,uuid,text,timestamptz,uuid,boolean,timestamptz,bigint)'
  ) IS NOT NULL
  AND to_regprocedure(
    'system.purge_expired_notifications(integer)'
  ) IS NOT NULL
  AND to_regprocedure(
    'system.set_notification_read_state(uuid,uuid,boolean)'
  ) IS NOT NULL
  AND to_regprocedure('system.mark_all_notifications_read(uuid)') IS NOT NULL
  AND to_regclass('system.content_ranking_candidate_snapshots') IS NOT NULL
  AND to_regclass(
    'system.content_ranking_candidate_snapshots_expiry_idx'
  ) IS NOT NULL
  AND to_regclass('platform.reactions_ranking_recent_idx') IS NOT NULL
  AND to_regclass(
    'platform.content_items_ranking_reply_recent_idx'
  ) IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'system'
      AND routine.proname = 'store_content_ranking_candidate_snapshot'
      AND pg_get_function_identity_arguments(routine.oid) =
        'candidate_snapshot_id text, candidate_binding_hmac bytea, candidate_kind text, candidate_candidates jsonb, candidate_expires_at timestamp with time zone'
      AND routine.prosecdef
      AND 'search_path=pg_catalog' = ANY (routine.proconfig)
  )
  AND EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'system'
      AND routine.proname =
        'purge_expired_content_ranking_candidate_snapshots'
      AND pg_get_function_identity_arguments(routine.oid) =
        'candidate_batch_size integer'
      AND routine.prosecdef
      AND 'search_path=pg_catalog' = ANY (routine.proconfig)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(routine.proacl, acldefault('f', routine.proowner))
    ) AS privilege
    WHERE namespace.nspname = 'system'
      AND routine.proname IN (
        'store_content_ranking_candidate_snapshot',
        'purge_expired_content_ranking_candidate_snapshots'
      )
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  )
  AND (
    SELECT count(*) = 5
    FROM pg_constraint AS constraint_record
    WHERE constraint_record.convalidated
      AND constraint_record.conname IN (
        'content_ranking_candidate_snapshots_id',
        'content_ranking_candidate_snapshots_binding',
        'content_ranking_candidate_snapshots_kind',
        'content_ranking_candidate_snapshots_candidates',
        'content_ranking_candidate_snapshots_retention'
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'system'
      AND table_name = 'content_ranking_candidate_snapshots'
      AND column_name IN (
        'query',
        'query_text',
        'title',
        'body',
        'body_markdown',
        'body_plain_text',
        'prompt',
        'snippet',
        'owner_id',
        'credential_id'
      )
  )
  AND (
    SELECT count(*) = 8
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'platform'
      AND relation.relkind IN ('p', 'r')
      AND relation.relname IN (
        'admins',
        'admin_roles',
        'admin_role_permissions',
        'admin_assignments',
        'reports',
        'moderation_cases',
        'moderation_case_items',
        'moderation_actions'
      )
  )
  AND (SELECT count(*) = 5 FROM platform.admin_roles)
  AND (
    SELECT count(DISTINCT permission) = 8
    FROM platform.admin_role_permissions
  )
  AND NOT EXISTS (SELECT 1 FROM platform.admins)
  AND NOT EXISTS (SELECT 1 FROM platform.admin_assignments)
  AND to_regclass('platform.reports_active_owner_content_unique') IS NOT NULL
  AND to_regclass('platform.reports_active_owner_agent_unique') IS NULL
  AND to_regclass('platform.moderation_cases_active_content_unique') IS NOT NULL
  AND to_regclass('platform.moderation_cases_active_agent_unique') IS NULL
  AND to_regclass(
    'platform.report_submission_idempotency_owner_created_idx'
  ) IS NOT NULL
  AND to_regclass(
    'platform.report_submission_idempotency_owner_actor_created_idx'
  ) IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM pg_attribute AS attribute
    JOIN pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'platform'
      AND relation.relname = 'moderation_actions'
      AND attribute.attname = 'occurred_at'
      AND attribute.attgenerated = 's'
      AND NOT attribute.attisdropped
  )
  AND position(
    'content.moderation_changed'
    in pg_get_functiondef(
      'platform.validate_runtime_content_write_provenance()'::regprocedure
    )
  ) > 0
  AND (
    SELECT count(*) = 5
    FROM pg_trigger AS trigger_record
    WHERE trigger_record.tgname = ANY (ARRAY[
      'reports_validate_runtime_creation_provenance',
      'moderation_cases_validate_runtime_creation_provenance',
      'moderation_actions_validate_runtime_provenance',
      'reports_validate_runtime_resolution_provenance',
      'moderation_cases_validate_runtime_resolution_provenance'
    ])
      AND NOT trigger_record.tgisinternal
      AND trigger_record.tgconstraint <> 0
      AND trigger_record.tgdeferrable
      AND trigger_record.tginitdeferred
      AND trigger_record.tgenabled IN ('O', 'A')
  )
  AND to_regclass('platform.content_revisions_actor_hash_recent_idx')
    IS NOT NULL
  AND to_regclass('platform.content_items_reply_root_author_published_idx')
    IS NOT NULL
  AND to_regclass(
    'platform.action_logs_owner_content_publish_succeeded_idx'
  ) IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'platform'
      AND table_name = 'content_revisions'
      AND column_name = 'search_document'
      AND udt_name = 'tsvector'
      AND is_generated = 'ALWAYS'
  )
  AND to_regclass('platform.content_revisions_search_document_idx')
    IS NOT NULL
  AND to_regclass('platform.content_embedding_chunks') IS NOT NULL
  AND to_regclass('system.content_embedding_jobs') IS NOT NULL
  AND to_regclass('system.content_search_candidate_snapshots') IS NOT NULL
  AND to_regclass('platform.agent_search_activity_events') IS NOT NULL
  AND to_regclass('platform.content_embedding_chunks_cosine_hnsw_idx')
    IS NOT NULL
  AND to_regclass('platform.content_items_current_revision_idx') IS NOT NULL
  AND to_regclass('system.content_embedding_jobs_revision_incomplete_idx')
    IS NOT NULL
  AND to_regclass('system.content_search_candidate_snapshots_expiry_idx')
    IS NOT NULL
  AND to_regclass('platform.agent_search_activity_events_started_idx') IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid =
        'platform.content_embedding_chunks'::regclass
      AND attribute.attname = 'embedding'
      AND NOT attribute.attisdropped
      AND format_type(attribute.atttypid, attribute.atttypmod) = 'vector(512)'
  )
  AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'platform'
      AND table_name = 'content_embedding_chunks'
      AND column_name = 'search_index_created_xid'
      AND udt_name = 'xid8'
      AND is_nullable = 'NO'
      AND column_default = 'pg_current_xact_id()'
  )
  AND EXISTS (
    SELECT 1
    FROM system.content_read_visibility_epochs
    WHERE epoch_name = 'search_index'
      AND epoch > 0
  )
  AND (
    SELECT count(*) = 4
    FROM pg_trigger AS trigger_record
    WHERE NOT trigger_record.tgisinternal
      AND trigger_record.tgenabled IN ('O', 'A')
      AND (
        (trigger_record.tgrelid =
            'platform.content_embedding_chunks'::regclass
          AND trigger_record.tgname =
            'content_embedding_chunks_prevent_mutation')
        OR (trigger_record.tgrelid =
              'system.content_embedding_jobs'::regclass
          AND trigger_record.tgname =
            'content_embedding_jobs_prepare_write')
        OR (trigger_record.tgrelid =
              'platform.agent_search_activity_events'::regclass
          AND trigger_record.tgname =
            'agent_search_activity_events_prepare_write')
        OR (trigger_record.tgrelid =
              'platform.content_revisions'::regclass
          AND trigger_record.tgname =
            'content_revisions_enqueue_embedding_job'
          AND trigger_record.tgfoid = to_regprocedure(
            'system.enqueue_content_embedding_job_from_revision()'
          ))
      )
  )
  AND to_regprocedure(
    'platform.advance_search_index_on_current_revision_change()'
  ) IS NULL
  AND to_regprocedure(
    'platform.advance_search_index_on_embedding_chunk_insert()'
  ) IS NULL
  AND EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'system'
      AND routine.proname = 'redrive_content_embedding_job'
      AND pg_get_function_identity_arguments(routine.oid) =
        'candidate_job_id uuid'
      AND routine.prosecdef
      AND 'search_path=pg_catalog' = ANY (routine.proconfig)
  )
  AND position(
    'content.delete_content'
    IN pg_get_functiondef(
      'platform.validate_runtime_content_write_provenance()'::regprocedure
    )
  ) > 0
  AND position(
    'content.deleted'
    IN pg_get_functiondef(
      'platform.validate_runtime_content_write_provenance()'::regprocedure
    )
  ) > 0
  AND position(
    'delete_content'
    IN pg_get_functiondef(
      'platform.validate_runtime_content_write_provenance()'::regprocedure
    )
  ) > 0
  AND EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'system'
      AND routine.proname = 'store_content_search_candidate_snapshot'
      AND pg_get_function_identity_arguments(routine.oid) =
        'candidate_snapshot_id text, candidate_binding_hmac bytea, candidate_candidates jsonb, candidate_expires_at timestamp with time zone'
      AND routine.prosecdef
      AND 'search_path=pg_catalog' = ANY (routine.proconfig)
  )
  AND EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'system'
      AND routine.proname = 'purge_expired_content_search_candidate_snapshots'
      AND pg_get_function_identity_arguments(routine.oid) =
        'candidate_batch_size integer'
      AND routine.prosecdef
      AND 'search_path=pg_catalog' = ANY (routine.proconfig)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(routine.proacl, acldefault('f', routine.proowner))
    ) AS privilege
    WHERE namespace.nspname = 'system'
      AND routine.proname = 'redrive_content_embedding_job'
      AND pg_get_function_identity_arguments(routine.oid) =
        'candidate_job_id uuid'
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'system'
      AND routine.proname = 'enqueue_content_embedding_job_from_revision'
      AND pg_get_function_identity_arguments(routine.oid) = ''
      AND routine.prosecdef
      AND routine.prorettype = 'pg_catalog.trigger'::regtype
      AND 'search_path=pg_catalog' = ANY (routine.proconfig)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(routine.proacl, acldefault('f', routine.proowner))
    ) AS privilege
    WHERE namespace.nspname = 'system'
      AND routine.proname = 'enqueue_content_embedding_job_from_revision'
      AND pg_get_function_identity_arguments(routine.oid) = ''
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  )
  AND (
    SELECT count(*) = 9
    FROM pg_constraint AS constraint_record
    WHERE constraint_record.convalidated
      AND constraint_record.conname IN (
        'content_embedding_chunks_revision_model_chunk_unique',
        'content_embedding_jobs_revision_model_unique',
        'content_search_candidate_snapshots_id',
        'content_search_candidate_snapshots_binding',
        'content_search_candidate_snapshots_candidates',
        'content_search_candidate_snapshots_retention',
        'agent_search_activity_events_actor_request_unique',
        'agent_search_activity_events_retention',
        'agent_search_activity_events_state_shape'
      )
  )
  AND (
    SELECT count(*) = 19
    FROM information_schema.columns
    WHERE table_schema = 'platform'
      AND table_name = 'agent_search_activity_events'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'platform'
      AND table_name = 'agent_search_activity_events'
      AND column_name IN (
        'query',
        'query_text',
        'normalized_query',
        'body',
        'body_markdown',
        'body_plain_text',
        'prompt',
        'results',
        'result_ids'
      )
  )
  AND (
    SELECT count(*)
    FROM system.content_embedding_jobs
    WHERE embedding_model = 'amazon.titan-embed-text-v2:0:512'
  ) = (SELECT count(*) FROM platform.content_revisions)
  AND EXISTS (
    SELECT 1
    FROM pg_trigger AS trigger_record
    WHERE trigger_record.tgrelid = 'platform.content_revisions'::regclass
      AND trigger_record.tgname = 'content_revisions_validate_current_pointer'
      AND NOT trigger_record.tgisinternal
      AND trigger_record.tgenabled IN ('O', 'A')
  )
  AND to_regclass(
    'platform.content_additional_communities_admission_rate_idx'
  ) IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    WHERE routine.oid =
        'platform.validate_domain_write_subject()'::regprocedure
      AND routine.prosecdef
      AND routine.prorettype = 'pg_catalog.trigger'::regtype
      AND 'search_path=pg_catalog' = ANY (routine.proconfig)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    CROSS JOIN LATERAL aclexplode(
      coalesce(routine.proacl, acldefault('f', routine.proowner))
    ) AS privilege
    WHERE routine.oid =
        'platform.validate_domain_write_subject()'::regprocedure
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_trigger AS trigger_record
    WHERE trigger_record.tgrelid = 'platform.action_logs'::regclass
      AND trigger_record.tgname =
        'action_logs_validate_domain_write_subject'
      AND trigger_record.tgfoid =
        'platform.validate_domain_write_subject()'::regprocedure
      AND trigger_record.tgtype = 7
      AND NOT trigger_record.tgisinternal
      AND trigger_record.tgconstraint = 0
      AND NOT trigger_record.tgdeferrable
      AND NOT trigger_record.tginitdeferred
      AND trigger_record.tgenabled IN ('O', 'A')
  )
  AND EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    WHERE constraint_record.conrelid = 'platform.action_logs'::regclass
      AND constraint_record.conname =
        'action_logs_authentication_assurance_semantics_v1'
      AND constraint_record.contype = 'c'
      AND constraint_record.convalidated
  )
  AND EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    WHERE routine.oid =
        'system.content_v1_outbox_payload_is_valid(text,text,text,integer,jsonb)'::regprocedure
      AND routine.provolatile = 'i'
      AND routine.proparallel = 's'
      AND NOT routine.prosecdef
      AND routine.prorettype = 'pg_catalog.bool'::regtype
      AND 'search_path=pg_catalog' = ANY (routine.proconfig)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    CROSS JOIN LATERAL aclexplode(
      coalesce(routine.proacl, acldefault('f', routine.proowner))
    ) AS privilege
    WHERE routine.oid =
        'system.content_v1_outbox_payload_is_valid(text,text,text,integer,jsonb)'::regprocedure
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    WHERE constraint_record.conrelid = 'system.outbox_events'::regclass
      AND constraint_record.conname =
        'outbox_events_content_v1_payload_shape'
      AND constraint_record.contype = 'c'
      AND constraint_record.convalidated
  )
  AND EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    JOIN pg_depend AS dependency
      ON dependency.classid = 'pg_catalog.pg_constraint'::regclass
     AND dependency.objid = constraint_record.oid
     AND dependency.objsubid = 0
    WHERE constraint_record.conrelid = 'system.outbox_events'::regclass
      AND constraint_record.conname =
        'outbox_events_content_v1_payload_shape'
      AND dependency.refclassid = 'pg_catalog.pg_proc'::regclass
      AND dependency.refobjid =
        'system.content_v1_outbox_payload_is_valid(text,text,text,integer,jsonb)'::regprocedure
      AND dependency.refobjsubid = 0
      AND dependency.deptype = 'n'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    WHERE routine.oid =
        'platform.validate_runtime_content_outbox_provenance()'::regprocedure
      AND NOT routine.prosecdef
      AND routine.prorettype = 'pg_catalog.trigger'::regtype
      AND 'search_path=pg_catalog' = ANY (routine.proconfig)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    CROSS JOIN LATERAL aclexplode(
      coalesce(routine.proacl, acldefault('f', routine.proowner))
    ) AS privilege
    WHERE routine.oid =
        'platform.validate_runtime_content_outbox_provenance()'::regprocedure
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_trigger AS trigger_record
    WHERE trigger_record.tgrelid = 'system.outbox_events'::regclass
      AND trigger_record.tgname =
        'outbox_events_validate_runtime_content_provenance'
      AND trigger_record.tgfoid =
        'platform.validate_runtime_content_outbox_provenance()'::regprocedure
      AND trigger_record.tgtype = 5
      AND NOT trigger_record.tgisinternal
      AND trigger_record.tgconstraint <> 0
      AND trigger_record.tgdeferrable
      AND trigger_record.tginitdeferred
      AND trigger_record.tgenabled IN ('O', 'A')
  )
  AND EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'platform'
      AND routine.proname = 'validate_runtime_content_write_provenance'
      AND routine.pronargs = 0
      AND pg_get_function_identity_arguments(routine.oid) = ''
      AND NOT routine.prosecdef
      AND 'search_path=pg_catalog' = ANY (routine.proconfig)
  )
  AND (
    SELECT count(*) = 7
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
    JOIN pg_trigger AS trigger_record
      ON trigger_record.tgname = expected.trigger_name
    JOIN pg_class AS relation
      ON relation.oid = trigger_record.tgrelid
     AND relation.relname = expected.table_name
    JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_proc AS trigger_routine
      ON trigger_routine.oid = trigger_record.tgfoid
    JOIN pg_namespace AS trigger_routine_namespace
      ON trigger_routine_namespace.oid = trigger_routine.pronamespace
    WHERE namespace.nspname = 'platform'
      AND NOT trigger_record.tgisinternal
      AND trigger_record.tgconstraint <> 0
      AND trigger_record.tgdeferrable
      AND trigger_record.tginitdeferred
      AND trigger_record.tgenabled IN ('O', 'A')
      AND trigger_record.tgtype = expected.tgtype
      AND trigger_record.tgfoid =
        'platform.validate_runtime_content_write_provenance()'::regprocedure
      AND trigger_routine_namespace.nspname = 'platform'
      AND trigger_routine.proname =
        'validate_runtime_content_write_provenance'
      AND trigger_routine.pronargs = 0
      AND pg_get_function_identity_arguments(trigger_routine.oid) = ''
  )
  AND to_regclass('platform.owners') IS NOT NULL
  AND to_regclass('platform.agents') IS NOT NULL
  AND to_regclass('platform.credentials') IS NOT NULL
  AND to_regclass('platform.content_items') IS NOT NULL
  AND to_regclass('platform.content_revisions') IS NOT NULL
  AND to_regclass('platform.reactions') IS NOT NULL
  AND to_regclass('platform.reactions_content_type_created_idx') IS NOT NULL
  AND to_regclass('platform.reactions_actor_created_idx') IS NOT NULL
  AND to_regclass('platform.follows') IS NOT NULL
  AND to_regclass('system.actor_follow_epochs') IS NOT NULL
  AND to_regclass('platform.follows_follower_updated_idx') IS NOT NULL
  AND to_regclass('platform.follows_target_actor_reverse_idx') IS NOT NULL
  AND to_regclass('platform.follows_target_symbol_reverse_idx') IS NOT NULL
  AND to_regclass('platform.follows_target_topic_reverse_idx') IS NOT NULL
  AND to_regclass('platform.follows_target_content_reverse_idx') IS NOT NULL
  AND to_regclass(
    'platform.action_logs_follow_succeeded_agent_occurred_idx'
  ) IS NOT NULL
  AND to_regclass(
    'platform.action_logs_reaction_succeeded_agent_occurred_idx'
  ) IS NOT NULL
  AND to_regclass('system.content_read_visibility_epochs') IS NOT NULL
  AND to_regclass('platform.idempotency_records') IS NOT NULL
  AND to_regclass('platform.pending_actions') IS NOT NULL
  AND to_regclass('platform.pending_action_attempts') IS NOT NULL
  AND to_regclass('platform.pending_actions_approved_due_idx') IS NOT NULL
  AND to_regclass('platform.pending_actions_approval_expiry_idx') IS NOT NULL
  AND to_regclass('platform.pending_actions_lease_reaper_idx') IS NOT NULL
  AND to_regclass('platform.idempotency_records_pending_action_idx') IS NOT NULL
  AND (
    SELECT count(*) = 1
    FROM pg_trigger
    WHERE tgrelid = 'platform.reactions'::regclass
      AND tgname = 'reactions_validate_insert'
      AND tgfoid = 'platform.validate_reaction_insert()'::regprocedure
      AND tgtype = 7
      AND NOT tgisinternal
      AND tgenabled IN ('O', 'A')
  )
  AND (
    SELECT count(*) = 1
    FROM pg_trigger
    WHERE tgrelid = 'platform.reactions'::regclass
      AND tgname = 'reactions_prevent_update'
      AND tgfoid = 'platform.prevent_reaction_update()'::regprocedure
      AND tgtype = 19
      AND NOT tgisinternal
      AND tgenabled IN ('O', 'A')
  )
  AND (
    SELECT count(*) = 2
    FROM information_schema.columns
    WHERE table_schema = 'platform'
      AND table_name IN ('content_items', 'content_revisions')
      AND column_name = 'content_read_created_xid'
      AND udt_name = 'xid8'
      AND is_nullable = 'NO'
  )
  AND (
    SELECT count(*) = 2
    FROM system.content_read_visibility_epochs
    WHERE epoch_name IN (
      'content_membership',
      'public_community_visibility'
    )
      AND epoch > 0
  )
  AND (
    SELECT count(*) = 9
    FROM pg_trigger
    WHERE tgname = ANY (ARRAY[
      'content_items_assign_read_created_xid',
      'content_revisions_assign_read_created_xid',
      'content_items_advance_read_membership_epoch',
      'communities_advance_public_read_visibility_epoch',
      'symbols_advance_read_membership_epoch',
      'topics_advance_read_membership_epoch',
      'content_additional_communities_advance_read_membership_epoch',
      'content_symbols_advance_read_membership_epoch',
      'content_topics_advance_read_membership_epoch'
    ])
      AND NOT tgisinternal
      AND tgenabled IN ('O', 'A')
  )
  AND (
    SELECT count(*) = 3
    FROM information_schema.columns
    WHERE table_schema = 'platform'
      AND (
        (table_name = 'pending_actions'
          AND column_name IN ('decision_audit_id', 'decision_reason_code'))
        OR (table_name = 'idempotency_records'
          AND column_name = 'pending_action_id')
      )
  )
  AND (
    SELECT count(*) = 5
    FROM pg_constraint AS constraint_record
    WHERE constraint_record.conrelid = 'platform.follows'::regclass
      AND constraint_record.conname IN (
        'follows_target_shape',
        'follows_no_self_actor',
        'follows_notification_level',
        'follows_updated_after_created',
        'follows_timestamp_precision'
      )
      AND constraint_record.convalidated
  )
  AND (
    SELECT count(*) = 3
    FROM pg_trigger AS trigger_record
    WHERE trigger_record.tgrelid = 'platform.follows'::regclass
      AND trigger_record.tgname IN (
        'follows_validate_write',
        'follows_prepare_update',
        'follows_advance_actor_epoch'
      )
      AND NOT trigger_record.tgisinternal
      AND trigger_record.tgenabled IN ('O', 'A')
  )
  AND (
    SELECT count(*) = 5
    FROM pg_trigger
    WHERE tgrelid = 'platform.pending_actions'::regclass
      AND tgname IN (
        'pending_actions_link_idempotency',
        'pending_actions_prepare_update',
        'pending_actions_sync_attempt',
        'pending_actions_validate_decision_audit',
        'pending_actions_validate_idempotency_terminal'
      )
      AND NOT tgisinternal
  )
  AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'platform'
      AND table_name = 'credentials'
      AND column_name = 'pepper_version'
      AND data_type = 'smallint'
  )
  AND (
    SELECT count(*) = 3
    FROM information_schema.columns
    WHERE table_schema = 'platform'
      AND table_name = 'credentials'
      AND is_nullable = 'NO'
      AND (
        (
          column_name = 'policy_ceiling_defaults_version'
          AND data_type = 'text'
          AND column_default = '''agent-permission-defaults-v1''::text'
        )
        OR (
          column_name = 'policy_ceiling_schema_version'
          AND data_type = 'integer'
          AND column_default = '1'
        )
        OR (
          column_name = 'policy_ceiling_rules'
          AND data_type = 'jsonb'
          AND column_default = '''{}''::jsonb'
        )
      )
  )
  AND (
    SELECT count(*) = 2
    FROM pg_constraint AS constraint_record
    WHERE constraint_record.contype = 'c'
      AND constraint_record.convalidated
      AND (
        (
          constraint_record.conrelid = 'platform.agent_policies'::regclass
          AND constraint_record.conname = 'agent_policies_rules_valid'
        )
        OR (
          constraint_record.conrelid = 'platform.credentials'::regclass
          AND constraint_record.conname =
            'credentials_policy_ceiling_rules_valid'
        )
      )
  )
  AND (
    SELECT count(*) = 3
    FROM pg_trigger AS trigger_record
    WHERE NOT trigger_record.tgisinternal
      AND trigger_record.tgenabled IN ('O', 'A')
      AND (
        (
          trigger_record.tgrelid = 'platform.agent_policies'::regclass
          AND trigger_record.tgname = 'agent_policies_validate_insert'
          AND trigger_record.tgfoid =
            'platform.validate_agent_policy_insert()'::regprocedure
          AND trigger_record.tgtype = 7
        )
        OR (
          trigger_record.tgrelid = 'platform.credentials'::regclass
          AND trigger_record.tgname = 'credentials_validate_insert'
          AND trigger_record.tgfoid =
            'platform.validate_credential_insert()'::regprocedure
          AND trigger_record.tgtype = 7
        )
        OR (
          trigger_record.tgrelid = 'platform.credentials'::regclass
          AND trigger_record.tgname = 'credentials_prepare_update'
          AND trigger_record.tgfoid =
            'platform.prepare_credential_update()'::regprocedure
          AND trigger_record.tgtype = 19
        )
      )
  )
  AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'platform'
      AND table_name = 'symbols'
      AND column_name = 'community_candidate_id'
      AND data_type = 'uuid'
      AND is_nullable = 'NO'
  )
  AND (
    SELECT count(*) = 4
    FROM pg_constraint AS constraint_record
    JOIN pg_class AS relation
      ON relation.oid = constraint_record.conrelid
    JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'platform'
      AND constraint_record.conname = ANY (ARRAY[
        'owners_deleted_only_when_closed',
        'actors_handle_format',
        'credentials_static_secret_shape',
        'credentials_replaces_once'
      ])
  )
  AND NOT platform.audit_json_is_secret_free_v2(
    jsonb_build_object(
      'note',
      'aln_v1_' || 'abcdefghijkl' || '_' ||
        'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
    )
  )
  AND (
    current_database() <> :'published_agent_database'
    OR (
      EXISTS (
        SELECT 1
        FROM platform.credentials AS credential
        JOIN platform.agents AS agent
          ON agent.id = credential.agent_id
        JOIN platform.actors AS actor
          ON actor.id = agent.actor_id
        WHERE credential.name = 'CI legacy static key'
          AND credential.pepper_version = 1
          AND credential.policy_ceiling_defaults_version =
            'agent-permission-defaults-v1'
          AND credential.policy_ceiling_schema_version = 1
          AND credential.policy_ceiling_rules = '{}'::jsonb
          AND actor.handle = 'forward.migration-agent'
          AND actor.display_name = 'Updated Forward Migration Agent'
          AND actor.bio =
            'Legacy identity remains editable after the forward migration.'
          AND agent.discovery_tags = ARRAY['legacy.']::text[]
      )
      AND EXISTS (
        SELECT 1
        FROM platform.action_logs AS action_log
        WHERE action_log.request_id = 'forward-migration-legacy-action-log'
          AND NOT platform.audit_json_is_secret_free_v2(
            action_log.after_state
          )
          AND action_log.after_state->>'note' =
            'aln_v1_' || 'abcdefghijkl' || '_' ||
              'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
      )
      AND EXISTS (
        SELECT 1
        FROM platform.content_items AS content
        JOIN platform.content_revisions AS revision
          ON revision.id = content.current_revision_id
         AND revision.content_id = content.id
        JOIN system.content_embedding_jobs AS job
          ON job.revision_id = revision.id
         AND job.embedding_model = 'amazon.titan-embed-text-v2:0:512'
        WHERE revision.title = 'Forward Search Research'
          AND revision.search_document @@
            websearch_to_tsquery('simple', 'historical backfill')
          AND job.status = 'ready'
          AND job.priority = -100
          AND job.attempts = 0
      )
      AND (
        SELECT count(*) = 2
        FROM system.content_embedding_jobs AS job
        JOIN platform.content_revisions AS revision
          ON revision.id = job.revision_id
        WHERE revision.title IN (
            'Forward Search Research',
            'Second Forward Search Research'
          )
          AND job.priority = -100
          AND job.available_at = job.created_at
          AND job.updated_at = job.created_at
      )
      AND EXISTS (
        SELECT 1
        FROM platform.idempotency_records AS idempotency
        JOIN platform.pending_actions AS action
          ON action.id = idempotency.pending_action_id
         AND action.idempotency_record_id = idempotency.id
        WHERE idempotency.idempotency_key =
            'forward-migration-pending-action'
          AND idempotency.status = 'pending_approval'
          AND idempotency.resource_id = action.id
          AND action.state = 'pending_approval'
          AND action.decision_reason_code IS NULL
      )
      AND (
        SELECT count(*) = 2
        FROM platform.idempotency_records AS idempotency
        JOIN platform.pending_actions AS action
          ON action.id = idempotency.pending_action_id
         AND action.idempotency_record_id = idempotency.id
        WHERE idempotency.idempotency_key IN (
            'forward-migration-approved-null',
            'forward-migration-approved-late'
          )
          AND idempotency.status = 'pending_approval'
          AND idempotency.resource_id = action.id
          AND action.state = 'approved'
          AND action.decision_reason_code = 'owner_approved'
          AND action.next_attempt_at IS NOT NULL
          AND action.next_attempt_at >= action.requested_at
          AND action.next_attempt_at < action.expires_at
      )
    )
  );
SQL
  )"
  if [[ "${result}" != "t" ]]; then
    echo "Forward migration validation failed for ${database}." >&2
    exit 1
  fi
done

echo "Empty, Owner-schema, and published Agent-v1 paths all reach the current AlphaNet schema."
