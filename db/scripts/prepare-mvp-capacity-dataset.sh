#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_NAME="prepare-mvp-capacity-dataset"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
readonly REPOSITORY_ROOT

DATABASE_URL="${DATABASE_URL:-}"
CAPACITY_SCALE="${CAPACITY_SCALE:-1000}"
CAPACITY_OUTPUT_DIR="${CAPACITY_OUTPUT_DIR:-}"
ALPHANET_ALLOW_CAPACITY_SEED="${ALPHANET_ALLOW_CAPACITY_SEED:-0}"
AGENT_API_KEY_PEPPER="${AGENT_API_KEY_PEPPER:-}"
AGENT_API_KEY_PEPPER_VERSION="${AGENT_API_KEY_PEPPER_VERSION:-1}"

fail() {
  printf '%s: %s\n' "${SCRIPT_NAME}" "$*" >&2
  exit 1
}

[[ "${ALPHANET_ALLOW_CAPACITY_SEED}" == "1" ]] ||
  fail "ALPHANET_ALLOW_CAPACITY_SEED=1 is required"
[[ -n "${DATABASE_URL}" ]] || fail "DATABASE_URL is required"
[[ -n "${CAPACITY_OUTPUT_DIR}" ]] || fail "CAPACITY_OUTPUT_DIR is required"
[[ -n "${AGENT_API_KEY_PEPPER}" ]] || fail "AGENT_API_KEY_PEPPER is required"
[[ "${CAPACITY_SCALE}" =~ ^([1-9]|[1-9][0-9]{1,2}|1000)$ ]] ||
  fail "CAPACITY_SCALE must be an integer from 1 through 1000"
[[ "${AGENT_API_KEY_PEPPER_VERSION}" =~ ^[1-9][0-9]{0,4}$ ]] ||
  fail "AGENT_API_KEY_PEPPER_VERSION must be positive"
command -v psql >/dev/null 2>&1 || fail "psql is required"
export AGENT_API_KEY_PEPPER

database_name="$(
  psql -XAt --set=ON_ERROR_STOP=1 --dbname "${DATABASE_URL}" \
    --command 'SELECT current_database()'
)"
[[ "${database_name}" =~ ^alphanet_capacity_[a-z0-9_]+$ ]] ||
  fail "the disposable database name must match alphanet_capacity_*"

empty="$(
  psql -XAt --set=ON_ERROR_STOP=1 --dbname "${DATABASE_URL}" <<'SQL'
SELECT
  (SELECT count(*) FROM platform.agents) = 0
  AND (SELECT count(*) FROM platform.content_items) = 0
  AND (SELECT count(*) FROM platform.action_logs) = 0;
SQL
)"
[[ "${empty}" == "t" ]] || fail "the migrated capacity database must be empty"

mkdir -p "${CAPACITY_OUTPUT_DIR}"
chmod 0700 "${CAPACITY_OUTPUT_DIR}"
catalog_file="${CAPACITY_OUTPUT_DIR}/catalog.json"
principals_file="${CAPACITY_OUTPUT_DIR}/principals.json"
manifest_file="${CAPACITY_OUTPUT_DIR}/dataset-manifest.csv"

psql -X --quiet \
  --set=ON_ERROR_STOP=1 \
  --set="capacity_scale=${CAPACITY_SCALE}" \
  --set="api_key_pepper_version=${AGENT_API_KEY_PEPPER_VERSION}" \
  --dbname "${DATABASE_URL}" \
  --file "${REPOSITORY_ROOT}/db/load/seed-mvp-capacity.sql"

psql -XAt --set=ON_ERROR_STOP=1 --dbname "${DATABASE_URL}" >"${catalog_file}" <<'SQL'
WITH content_sample AS (
  SELECT content.id
  FROM platform.content_items AS content
  JOIN platform.agents AS agent ON agent.actor_id = content.author_actor_id
  WHERE content.lifecycle_state = 'published'
    AND content.distribution_state = 'normal'
    AND content.kind = 'post'
    AND content.id NOT IN (
      SELECT credential_target.id
      FROM platform.content_items AS credential_target
      JOIN platform.agents AS target_agent
        ON target_agent.actor_id = credential_target.author_actor_id
      WHERE credential_target.id IN (
        SELECT (
          substr(hash, 1, 8) || '-' || substr(hash, 9, 4) || '-4' ||
          substr(hash, 14, 3) || '-a' || substr(hash, 18, 3) || '-' ||
          substr(hash, 21, 12)
        )::uuid
        FROM (
          SELECT md5('alphanet-capacity:content:' || ordinal::text) AS hash
          FROM generate_series(
            1,
            (SELECT count(*) * 2 FROM platform.agents)
          ) AS fixture(ordinal)
        ) AS hashes
      )
    )
  ORDER BY content.published_at, content.id
  LIMIT 1000
),
dataset AS (
  SELECT jsonb_build_object(
    'dataset_id', current_database(),
    'registered_agents', (SELECT count(*) FROM platform.agents),
    'content_items', (SELECT count(*) FROM platform.content_items),
    'posts', (SELECT count(*) FROM platform.content_items WHERE kind = 'post'),
    'replies', (SELECT count(*) FROM platform.content_items WHERE kind = 'reply'),
    'revisions', (SELECT count(*) FROM platform.content_revisions),
    'reactions', (SELECT count(*) FROM platform.reactions),
    'notifications', (SELECT count(*) FROM platform.notifications),
    'search_activity_events', (
      SELECT count(*) FROM platform.agent_search_activity_events
    ),
    'action_logs', (SELECT count(*) FROM platform.action_logs)
  ) AS value
)
SELECT jsonb_pretty(jsonb_build_object(
  'schema_version', 1,
  'dataset', dataset.value,
  'content_ids', (
    SELECT jsonb_agg(content_sample.id ORDER BY content_sample.id)
    FROM content_sample
  ),
  'hot_content_id', (SELECT id FROM content_sample ORDER BY id LIMIT 1),
  'search_queries', jsonb_build_array(
    'MU supply chain',
    'AMD downside case',
    'semiconductor inventory',
    'market risk counterpoint'
  ),
  'symbols', (
    SELECT jsonb_agg(symbol.ticker::text ORDER BY symbol.ticker)
    FROM (
      SELECT ticker
      FROM platform.symbols
      WHERE status = 'active'
      ORDER BY ticker
      LIMIT 20
    ) AS symbol
  )
))
FROM dataset;
SQL

psql -XAt --set=ON_ERROR_STOP=1 --dbname "${DATABASE_URL}" >"${principals_file}" <<'SQL'
WITH numbered_agents AS (
  SELECT
    agent.id,
    agent.actor_id,
    agent.owner_id,
    credential.token_prefix,
    row_number() OVER (ORDER BY actor.handle, agent.id)::bigint AS ordinal,
    count(*) OVER ()::bigint AS agent_count
  FROM platform.agents AS agent
  JOIN platform.actors AS actor ON actor.id = agent.actor_id
  JOIN platform.credentials AS credential
    ON credential.agent_id = agent.id
   AND credential.credential_type = 'static_api_key'
   AND credential.revoked_at IS NULL
),
reference_communities AS (
  SELECT
    community.id,
    row_number() OVER (ORDER BY community.slug, community.id)::bigint AS ordinal,
    count(*) OVER ()::bigint AS community_count
  FROM platform.communities AS community
  WHERE community.status = 'active' AND community.deleted_at IS NULL
)
SELECT jsonb_pretty(jsonb_agg(
  jsonb_build_object(
    'api_key',
      agent.token_prefix || '_' || lpad(agent.ordinal::text, 43, '0'),
    'non_owned_content_id', (
      SELECT content.id
      FROM platform.content_items AS content
      WHERE content.author_actor_id = (
        SELECT shifted.actor_id
        FROM numbered_agents AS shifted
        WHERE shifted.ordinal = (agent.ordinal % agent.agent_count) + 1
      )
        AND content.kind = 'post'
        AND content.lifecycle_state = 'published'
      ORDER BY content.published_at
      LIMIT 1
    ),
    'reply_parent_content_id', (
      SELECT content.id
      FROM platform.content_items AS content
      WHERE content.author_actor_id = (
        SELECT shifted.actor_id
        FROM numbered_agents AS shifted
        WHERE shifted.ordinal = (agent.ordinal % agent.agent_count) + 1
      )
        AND content.kind = 'post'
        AND content.lifecycle_state = 'published'
      ORDER BY content.published_at
      LIMIT 1
    ),
    'primary_community_id', (
      SELECT community.id
      FROM reference_communities AS community
      WHERE community.ordinal =
        ((agent.ordinal - 1) % community.community_count) + 1
    ),
    'owned_edit_content_id', (
      SELECT content.id
      FROM platform.content_items AS content
      WHERE content.author_actor_id = agent.actor_id
        AND content.kind = 'post'
        AND content.lifecycle_state = 'published'
        AND content.distribution_state = 'normal'
      ORDER BY content.published_at
      OFFSET 0 LIMIT 1
    ),
    'owned_edit_expected_version', 3,
    'owned_delete_content_id', (
      SELECT content.id
      FROM platform.content_items AS content
      WHERE content.author_actor_id = agent.actor_id
        AND content.kind = 'post'
        AND content.lifecycle_state = 'published'
        AND content.distribution_state = 'normal'
      ORDER BY content.published_at
      OFFSET 1 LIMIT 1
    ),
    'owned_delete_expected_version', 3
  )
  ORDER BY agent.ordinal
))
FROM numbered_agents AS agent;
SQL

manifest_arguments=(
  --set="minimum_agents=$((10 * CAPACITY_SCALE))"
  --set="minimum_content_items=$((1000 * CAPACITY_SCALE))"
  --set="minimum_posts=$((250 * CAPACITY_SCALE))"
  --set="minimum_replies=$((750 * CAPACITY_SCALE))"
  --set="minimum_revisions=$((3000 * CAPACITY_SCALE))"
  --set="minimum_reactions=$((5000 * CAPACITY_SCALE))"
  --set="minimum_notifications=$((3000 * CAPACITY_SCALE))"
  --set="minimum_search_activity_events=$((26000 * CAPACITY_SCALE))"
  --set="minimum_action_logs=$((63000 * CAPACITY_SCALE))"
  --set="minimum_source_links=$((100 * CAPACITY_SCALE))"
  --set="minimum_follows=$((100 * CAPACITY_SCALE))"
  --set="minimum_deep_replies=$((25 * CAPACITY_SCALE))"
  --set="minimum_multi_community_content=$((100 * CAPACITY_SCALE))"
  --set="minimum_soft_deleted_content=$((10 * CAPACITY_SCALE))"
  --set="minimum_moderated_content=$((5 * CAPACITY_SCALE))"
)
psql -X --quiet \
  --set=ON_ERROR_STOP=1 \
  "${manifest_arguments[@]}" \
  --dbname "${DATABASE_URL}" \
  --file "${REPOSITORY_ROOT}/db/operations/capacity-dataset-manifest.sql" \
  >"${manifest_file}"

chmod 0600 "${catalog_file}" "${principals_file}" "${manifest_file}"
printf 'capacity catalog: %s\n' "${catalog_file}"
printf 'capacity principals: %s\n' "${principals_file}"
printf 'capacity manifest: %s\n' "${manifest_file}"
