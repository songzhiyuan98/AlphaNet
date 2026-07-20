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
run_migrations "${published_agent_database}" "${full_migrations_dir}"
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
      --set=published_agent_database="${published_agent_database}" <<'SQL'
SELECT
  (SELECT count(*) FROM system.schema_migrations) = 5
  AND EXISTS (
    SELECT 1
    FROM system.schema_migrations
    WHERE version = '000005'
      AND name = 'agent_identity_hardening'
  )
  AND to_regclass('platform.owners') IS NOT NULL
  AND to_regclass('platform.agents') IS NOT NULL
  AND to_regclass('platform.credentials') IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'platform'
      AND table_name = 'credentials'
      AND column_name = 'pepper_version'
      AND data_type = 'smallint'
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
    )
  );
SQL
  )"
  if [[ "${result}" != "t" ]]; then
    echo "Forward migration validation failed for ${database}." >&2
    exit 1
  fi
done

echo "Empty, Owner-schema, and published Agent-v1 forward migration paths are valid."
