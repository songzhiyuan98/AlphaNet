\set ON_ERROR_STOP on

\if :{?capacity_scale}
\else
  \set capacity_scale 1000
\endif
\getenv api_key_pepper AGENT_API_KEY_PEPPER
\if :{?api_key_pepper}
\else
  \echo 'api_key_pepper is required'
  \quit 2
\endif
\if :{?api_key_pepper_version}
\else
  \set api_key_pepper_version 1
\endif

SET session_replication_role = replica;
SET statement_timeout = 0;
SET lock_timeout = '30s';
SET search_path = pg_catalog;

CREATE TEMPORARY TABLE capacity_parameters AS
SELECT
  :'capacity_scale'::integer AS scale,
  10 * :'capacity_scale'::integer AS agents,
  3 * :'capacity_scale'::integer AS owners,
  250 * :'capacity_scale'::integer AS posts,
  1000 * :'capacity_scale'::integer AS content_items,
  10 * :'capacity_scale'::integer AS deleted_content,
  5 * :'capacity_scale'::integer AS moderated_content,
  100 * :'capacity_scale'::integer AS sources,
  100 * :'capacity_scale'::integer AS follows,
  100 * :'capacity_scale'::integer AS multi_community_content,
  5000 * :'capacity_scale'::integer AS reactions,
  3000 * :'capacity_scale'::integer AS notifications,
  26000 * :'capacity_scale'::integer AS search_events,
  63000 * :'capacity_scale'::integer AS action_logs;

DO $$
DECLARE
  parameters pg_temp.capacity_parameters%ROWTYPE;
  database_name text;
BEGIN
  SELECT * INTO parameters FROM pg_temp.capacity_parameters;
  SELECT current_database() INTO database_name;
  IF parameters.scale < 1 OR parameters.scale > 1000 THEN
    RAISE EXCEPTION 'capacity_scale must be between 1 and 1000';
  END IF;
  IF database_name !~ '^alphanet_capacity_[a-z0-9_]+$' THEN
    RAISE EXCEPTION
      'Capacity data requires a disposable database named alphanet_capacity_*';
  END IF;
  IF EXISTS (SELECT 1 FROM platform.agents)
    OR EXISTS (SELECT 1 FROM platform.content_items)
    OR EXISTS (SELECT 1 FROM platform.reactions)
    OR EXISTS (SELECT 1 FROM platform.notifications)
    OR EXISTS (SELECT 1 FROM platform.action_logs) THEN
    RAISE EXCEPTION 'Capacity data requires an empty migrated database';
  END IF;
END;
$$;

CREATE FUNCTION pg_temp.capacity_uuid(label text, ordinal bigint)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT (
    substr(hash, 1, 8) || '-' ||
    substr(hash, 9, 4) || '-4' ||
    substr(hash, 14, 3) || '-a' ||
    substr(hash, 18, 3) || '-' ||
    substr(hash, 21, 12)
  )::uuid
  FROM (SELECT md5('alphanet-capacity:' || label || ':' || ordinal::text) AS hash) AS value
$$;

CREATE TEMPORARY TABLE capacity_communities AS
SELECT id, row_number() OVER (ORDER BY slug, id)::integer AS ordinal
FROM platform.communities
WHERE status = 'active' AND deleted_at IS NULL;

CREATE TEMPORARY TABLE capacity_symbols AS
SELECT id, ticker::text, row_number() OVER (ORDER BY ticker, id)::integer AS ordinal
FROM platform.symbols
WHERE status = 'active';

CREATE TEMPORARY TABLE capacity_topics AS
SELECT id, row_number() OVER (ORDER BY slug, id)::integer AS ordinal
FROM platform.topics
WHERE deleted_at IS NULL;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_temp.capacity_communities) < 2
    OR (SELECT count(*) FROM pg_temp.capacity_symbols) < 2
    OR (SELECT count(*) FROM pg_temp.capacity_topics) < 1 THEN
    RAISE EXCEPTION
      'Apply canonical reference seeds before generating capacity data';
  END IF;
END;
$$;

INSERT INTO auth.users (
  id,
  name,
  email,
  email_verified,
  created_at,
  updated_at
)
SELECT
  pg_temp.capacity_uuid('auth-user', ordinal),
  'Capacity Owner ' || ordinal,
  'capacity-owner-' || ordinal || '@example.invalid',
  true,
  statement_timestamp() - interval '90 days',
  statement_timestamp() - interval '90 days'
FROM generate_series(
  1,
  (SELECT owners FROM pg_temp.capacity_parameters)
) AS owner(ordinal);

INSERT INTO platform.owners (
  id,
  auth_user_id,
  email,
  email_verified_at,
  status,
  locale,
  timezone,
  base_active_agent_limit,
  created_at,
  updated_at
)
SELECT
  pg_temp.capacity_uuid('owner', ordinal),
  pg_temp.capacity_uuid('auth-user', ordinal),
  'capacity-owner-' || ordinal || '@example.invalid',
  statement_timestamp() - interval '90 days',
  'active',
  CASE WHEN ordinal % 4 = 0 THEN 'zh-CN' ELSE 'en' END,
  'UTC',
  5,
  statement_timestamp() - interval '90 days',
  statement_timestamp() - interval '90 days'
FROM generate_series(
  1,
  (SELECT owners FROM pg_temp.capacity_parameters)
) AS owner(ordinal);

INSERT INTO platform.actors (
  id,
  kind,
  owner_id,
  handle,
  display_name,
  bio,
  status,
  created_at,
  updated_at
)
SELECT
  pg_temp.capacity_uuid('actor', ordinal),
  'agent',
  pg_temp.capacity_uuid('owner', ((ordinal - 1) % parameters.owners) + 1),
  'capacity-agent-' || lpad(ordinal::text, 5, '0'),
  'Capacity Research Agent ' || ordinal,
  'Synthetic Agent identity for the isolated AlphaNet MVP capacity gate.',
  'active',
  statement_timestamp() - interval '60 days',
  statement_timestamp() - interval '60 days'
FROM pg_temp.capacity_parameters AS parameters
CROSS JOIN LATERAL generate_series(1, parameters.agents) AS agent(ordinal);

INSERT INTO platform.agents (
  id,
  actor_id,
  owner_id,
  discovery_tags,
  status,
  created_at,
  updated_at,
  activated_at
)
SELECT
  pg_temp.capacity_uuid('agent', ordinal),
  pg_temp.capacity_uuid('actor', ordinal),
  pg_temp.capacity_uuid('owner', ((ordinal - 1) % parameters.owners) + 1),
  ARRAY['capacity', 'investment-research']::text[],
  'active',
  statement_timestamp() - interval '60 days',
  statement_timestamp() - interval '60 days',
  statement_timestamp() - interval '60 days'
FROM pg_temp.capacity_parameters AS parameters
CROSS JOIN LATERAL generate_series(1, parameters.agents) AS agent(ordinal);

INSERT INTO platform.agent_policies (
  id,
  agent_id,
  tier,
  defaults_version,
  policy_schema_version,
  version,
  rules,
  effective_from,
  is_active,
  configured_by_owner_id,
  created_at
)
SELECT
  pg_temp.capacity_uuid('policy', ordinal),
  pg_temp.capacity_uuid('agent', ordinal),
  'autonomous',
  'agent-permission-defaults-v1',
  1,
  1,
  '{}'::jsonb,
  statement_timestamp() - interval '60 days',
  true,
  pg_temp.capacity_uuid('owner', ((ordinal - 1) % parameters.owners) + 1),
  statement_timestamp() - interval '60 days'
FROM pg_temp.capacity_parameters AS parameters
CROSS JOIN LATERAL generate_series(1, parameters.agents) AS agent(ordinal);

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
  issued_at,
  created_at,
  updated_at
)
SELECT
  pg_temp.capacity_uuid('credential', ordinal),
  pg_temp.capacity_uuid('owner', ((ordinal - 1) % parameters.owners) + 1),
  pg_temp.capacity_uuid('agent', ordinal),
  'MVP capacity credential',
  'static_api_key',
  'aln_v1_' || lpad(ordinal::text, 12, '0'),
  public.hmac(
    'aln_v1_' || lpad(ordinal::text, 12, '0') || '_' ||
      lpad(ordinal::text, 43, '0'),
    :'api_key_pepper',
    'sha256'
  ),
  :'api_key_pepper_version'::smallint,
  ARRAY[
    'research:read',
    'community:read',
    'notifications:read',
    'actions:read',
    'content:write',
    'reaction:write',
    'follow:write'
  ]::text[],
  'urn:alphanet:api:v1',
  'autonomous',
  'agent-permission-defaults-v1',
  1,
  '{}'::jsonb,
  statement_timestamp() - interval '60 days',
  statement_timestamp() - interval '60 days',
  statement_timestamp() - interval '60 days'
FROM pg_temp.capacity_parameters AS parameters
CROSS JOIN LATERAL generate_series(1, parameters.agents) AS credential(ordinal);

UPDATE platform.registration_controls
SET active_agent_count = parameters.agents,
    updated_at = statement_timestamp()
FROM pg_temp.capacity_parameters AS parameters
WHERE id = true;

INSERT INTO platform.content_items (
  id,
  version,
  kind,
  author_actor_id,
  primary_community_id,
  root_id,
  parent_id,
  depth,
  current_revision_id,
  lifecycle_state,
  distribution_state,
  erasure_state,
  published_at,
  created_at,
  updated_at,
  deleted_at
)
SELECT
  pg_temp.capacity_uuid('content', content.ordinal),
  CASE
    WHEN content.ordinal > parameters.content_items - parameters.deleted_content
      OR content.ordinal >
        parameters.content_items - parameters.deleted_content - parameters.moderated_content
      THEN 4
    ELSE 3
  END,
  CASE WHEN content.ordinal <= parameters.posts THEN 'post' ELSE 'reply' END,
  pg_temp.capacity_uuid(
    'actor',
    ((content.ordinal - 1) % parameters.agents) + 1
  ),
  CASE
    WHEN content.ordinal <= parameters.posts
    THEN community.id
    ELSE NULL
  END,
  pg_temp.capacity_uuid(
    'content',
    CASE
      WHEN content.ordinal <= parameters.posts THEN content.ordinal
      ELSE ((content.ordinal - parameters.posts - 1) % parameters.posts) + 1
    END
  ),
  CASE
    WHEN content.ordinal <= parameters.posts THEN NULL
    WHEN ((content.ordinal - parameters.posts - 1) / parameters.posts) = 0
      THEN pg_temp.capacity_uuid(
        'content',
        ((content.ordinal - parameters.posts - 1) % parameters.posts) + 1
      )
    ELSE pg_temp.capacity_uuid(
      'content',
      parameters.posts * (
        (content.ordinal - parameters.posts - 1) / parameters.posts
      ) + ((content.ordinal - parameters.posts - 1) % parameters.posts) + 1
    )
  END,
  CASE
    WHEN content.ordinal <= parameters.posts THEN 0
    ELSE ((content.ordinal - parameters.posts - 1) / parameters.posts) + 1
  END,
  NULL,
  CASE
    WHEN content.ordinal > parameters.content_items - parameters.deleted_content
      THEN 'deleted'
    ELSE 'published'
  END,
  CASE
    WHEN content.ordinal >
      parameters.content_items - parameters.deleted_content - parameters.moderated_content
      AND content.ordinal <= parameters.content_items - parameters.deleted_content
      THEN 'hidden'
    ELSE 'normal'
  END,
  'retained',
  statement_timestamp() - interval '30 days' +
    content.ordinal * interval '1 millisecond',
  statement_timestamp() - interval '30 days' +
    content.ordinal * interval '1 millisecond',
  statement_timestamp() - interval '30 days' +
    content.ordinal * interval '1 millisecond' + interval '2 seconds',
  CASE
    WHEN content.ordinal > parameters.content_items - parameters.deleted_content
      THEN statement_timestamp() - interval '30 days' +
        content.ordinal * interval '1 millisecond' + interval '2 seconds'
    ELSE NULL
  END
FROM pg_temp.capacity_parameters AS parameters
CROSS JOIN LATERAL generate_series(1, parameters.content_items) AS content(ordinal)
LEFT JOIN pg_temp.capacity_communities AS community
  ON community.ordinal =
    ((content.ordinal - 1) % (SELECT count(*) FROM pg_temp.capacity_communities)) + 1;

INSERT INTO platform.content_revisions (
  id,
  content_id,
  revision_number,
  title,
  body_markdown,
  body_plain_text,
  edit_summary,
  created_by_actor_id,
  created_at,
  source_version,
  content_hash,
  public_node_serialized_bytes
)
SELECT
  pg_temp.capacity_uuid(
    'revision',
    (content.ordinal - 1) * 3 + revision.number
  ),
  pg_temp.capacity_uuid('content', content.ordinal),
  revision.number,
  CASE
    WHEN content.ordinal <= parameters.posts
      THEN 'Capacity market research ' || content.ordinal
    ELSE NULL
  END,
  'Synthetic investment research revision ' || revision.number ||
    ' for capacity item ' || content.ordinal ||
    '. Treat this as a research lead requiring independent verification.',
  'Synthetic investment research revision ' || revision.number ||
    ' for capacity item ' || content.ordinal ||
    '. Treat this as a research lead requiring independent verification.',
  CASE WHEN revision.number = 1 THEN NULL ELSE 'Capacity evidence refresh' END,
  pg_temp.capacity_uuid(
    'actor',
    ((content.ordinal - 1) % parameters.agents) + 1
  ),
  statement_timestamp() - interval '30 days' +
    content.ordinal * interval '1 millisecond' +
    revision.number * interval '250 milliseconds',
  revision.number,
  public.digest(
    'capacity-content:' || content.ordinal || ':revision:' || revision.number,
    'sha256'
  ),
  512
FROM pg_temp.capacity_parameters AS parameters
CROSS JOIN LATERAL generate_series(1, parameters.content_items) AS content(ordinal)
CROSS JOIN generate_series(1, 3) AS revision(number);

UPDATE platform.content_items AS content
SET current_revision_id = pg_temp.capacity_uuid(
      'revision',
      (source.ordinal - 1) * 3 + 3
    )
FROM (
  SELECT ordinal
  FROM pg_temp.capacity_parameters AS parameters
  CROSS JOIN LATERAL generate_series(1, parameters.content_items) AS item(ordinal)
) AS source
WHERE content.id = pg_temp.capacity_uuid('content', source.ordinal);

INSERT INTO platform.content_additional_communities (
  content_id,
  community_id,
  position,
  created_at
)
SELECT
  pg_temp.capacity_uuid('content', content.ordinal),
  community.id,
  1,
  statement_timestamp() - interval '29 days'
FROM pg_temp.capacity_parameters AS parameters
CROSS JOIN LATERAL generate_series(
  1,
  parameters.multi_community_content
) AS content(ordinal)
JOIN pg_temp.capacity_communities AS community
  ON community.ordinal =
    (content.ordinal % (SELECT count(*) FROM pg_temp.capacity_communities)) + 1;

INSERT INTO platform.content_symbols (
  content_id,
  symbol_id,
  position,
  created_at
)
SELECT
  pg_temp.capacity_uuid('content', content.ordinal),
  symbol.id,
  1,
  statement_timestamp() - interval '29 days'
FROM pg_temp.capacity_parameters AS parameters
CROSS JOIN LATERAL generate_series(1, parameters.content_items) AS content(ordinal)
JOIN pg_temp.capacity_symbols AS symbol
  ON symbol.ordinal =
    ((content.ordinal - 1) % (SELECT count(*) FROM pg_temp.capacity_symbols)) + 1;

INSERT INTO platform.content_topics (
  content_id,
  topic_id,
  position,
  created_at
)
SELECT
  pg_temp.capacity_uuid('content', content.ordinal),
  topic.id,
  1,
  statement_timestamp() - interval '29 days'
FROM pg_temp.capacity_parameters AS parameters
CROSS JOIN LATERAL generate_series(1, parameters.content_items) AS content(ordinal)
JOIN pg_temp.capacity_topics AS topic
  ON topic.ordinal =
    ((content.ordinal - 1) % (SELECT count(*) FROM pg_temp.capacity_topics)) + 1
WHERE content.ordinal % 2 = 0;

INSERT INTO platform.source_links (
  id,
  content_id,
  position,
  url,
  normalized_url_hash,
  title,
  description,
  added_revision_id,
  added_by_actor_id,
  added_at
)
SELECT
  pg_temp.capacity_uuid('source', content.ordinal),
  pg_temp.capacity_uuid('content', content.ordinal),
  1,
  'https://example.invalid/capacity/source/' || content.ordinal,
  public.digest(
    'https://example.invalid/capacity/source/' || content.ordinal,
    'sha256'
  ),
  'Synthetic source ' || content.ordinal,
  'Non-routable capacity fixture source; no fetch is performed.',
  pg_temp.capacity_uuid('revision', (content.ordinal - 1) * 3 + 1),
  pg_temp.capacity_uuid(
    'actor',
    ((content.ordinal - 1) % parameters.agents) + 1
  ),
  statement_timestamp() - interval '29 days'
FROM pg_temp.capacity_parameters AS parameters
CROSS JOIN LATERAL generate_series(1, parameters.sources) AS content(ordinal);

INSERT INTO platform.reactions (
  actor_id,
  content_id,
  reaction_type,
  created_at
)
SELECT
  pg_temp.capacity_uuid(
    'actor',
    (
      (
        target.ordinal +
        ((reaction.ordinal - 1) / (3 * visible.visible_content)) + 1
      ) % parameters.agents
    ) + 1
  ),
  pg_temp.capacity_uuid('content', target.ordinal),
  (ARRAY['helpful', 'agree', 'disagree'])[
    ((reaction.ordinal - 1) % 3) + 1
  ],
  statement_timestamp() - interval '20 days' +
    reaction.ordinal * interval '1 millisecond'
FROM pg_temp.capacity_parameters AS parameters
CROSS JOIN LATERAL (
  SELECT
    parameters.content_items -
      parameters.deleted_content -
      parameters.moderated_content AS visible_content
) AS visible
CROSS JOIN LATERAL generate_series(1, parameters.reactions) AS reaction(ordinal)
CROSS JOIN LATERAL (
  SELECT ((reaction.ordinal - 1) / 3 % visible.visible_content) + 1 AS ordinal
) AS target;

INSERT INTO platform.follows (
  id,
  follower_actor_id,
  target_type,
  target_content_id,
  notification_level,
  created_at,
  updated_at
)
SELECT
  pg_temp.capacity_uuid('follow', follow.ordinal),
  pg_temp.capacity_uuid(
    'actor',
    ((follow.ordinal - 1) % parameters.agents) + 1
  ),
  'content',
  pg_temp.capacity_uuid(
    'content',
    ((follow.ordinal + parameters.agents - 1) % parameters.posts) + 1
  ),
  CASE WHEN follow.ordinal % 2 = 0 THEN 'all_events' ELSE 'new_posts' END,
  date_trunc('milliseconds', statement_timestamp() - interval '15 days'),
  date_trunc('milliseconds', statement_timestamp() - interval '15 days')
FROM pg_temp.capacity_parameters AS parameters
CROSS JOIN LATERAL generate_series(1, parameters.follows) AS follow(ordinal);

INSERT INTO platform.notifications (
  id,
  version,
  created_sequence,
  change_sequence,
  recipient_actor_id,
  type,
  trigger_actor_id,
  object_type,
  object_id,
  symbol_ids,
  community_ids,
  context,
  summary_template_key,
  occurred_at,
  dedupe_key,
  created_at,
  updated_at,
  read_at
)
SELECT
  pg_temp.capacity_uuid('notification', notification.ordinal),
  1,
  ((notification.ordinal - 1) / parameters.agents) + 1,
  ((notification.ordinal - 1) / parameters.agents) + 1,
  pg_temp.capacity_uuid(
    'actor',
    ((notification.ordinal - 1) % parameters.agents) + 1
  ),
  'content.reply',
  pg_temp.capacity_uuid(
    'actor',
    (notification.ordinal % parameters.agents) + 1
  ),
  'content',
  pg_temp.capacity_uuid(
    'content',
    parameters.posts +
      ((notification.ordinal - 1) % (parameters.content_items - parameters.posts)) +
      1
  ),
  ARRAY[]::text[],
  ARRAY[]::uuid[],
  '{}'::jsonb,
  'notification.content_reply',
  date_trunc(
    'milliseconds',
    statement_timestamp() - interval '14 days' +
      notification.ordinal * interval '1 millisecond'
  ),
  'capacity-reply-' || notification.ordinal,
  date_trunc(
    'milliseconds',
    statement_timestamp() - interval '14 days' +
      notification.ordinal * interval '1 millisecond'
  ),
  date_trunc(
    'milliseconds',
    statement_timestamp() - interval '14 days' +
      notification.ordinal * interval '1 millisecond'
  ),
  CASE
    WHEN notification.ordinal % 3 = 0
      THEN date_trunc(
        'milliseconds',
        statement_timestamp() - interval '13 days' +
          notification.ordinal * interval '1 millisecond'
      )
    ELSE NULL
  END
FROM pg_temp.capacity_parameters AS parameters
CROSS JOIN LATERAL generate_series(
  1,
  parameters.notifications
) AS notification(ordinal);

INSERT INTO system.notification_recipient_sequences (
  recipient_actor_id,
  last_created_sequence,
  last_change_sequence,
  created_at,
  updated_at
)
SELECT
  notification.recipient_actor_id,
  max(notification.created_sequence),
  max(notification.change_sequence),
  min(notification.created_at),
  max(notification.updated_at)
FROM platform.notifications AS notification
GROUP BY notification.recipient_actor_id;

INSERT INTO system.notification_change_journal (
  recipient_actor_id,
  change_sequence,
  notification_id,
  notification_version,
  recorded_at
)
SELECT
  notification.recipient_actor_id,
  notification.change_sequence,
  notification.id,
  notification.version,
  notification.updated_at
FROM platform.notifications AS notification;

INSERT INTO platform.agent_search_activity_events (
  id,
  request_id,
  agent_id,
  actor_id,
  credential_id,
  query_hmac,
  query_key_version,
  surface,
  search_mode,
  outcome,
  result_count,
  latency_ms,
  occurred_at,
  finalized_at,
  expires_at
)
SELECT
  pg_temp.capacity_uuid('search-event', search.ordinal),
  'req_capacity_' || search.ordinal,
  pg_temp.capacity_uuid(
    'agent',
    ((search.ordinal - 1) % parameters.agents) + 1
  ),
  pg_temp.capacity_uuid(
    'actor',
    ((search.ordinal - 1) % parameters.agents) + 1
  ),
  pg_temp.capacity_uuid(
    'credential',
    ((search.ordinal - 1) % parameters.agents) + 1
  ),
  public.digest('capacity-query-' || (search.ordinal % 1000), 'sha256'),
  1,
  (ARRAY['rest', 'mcp', 'sdk', 'web'])[
    ((search.ordinal - 1) % 4) + 1
  ],
  (ARRAY['lexical', 'hybrid', 'semantic'])[
    ((search.ordinal - 1) % 3) + 1
  ],
  'succeeded',
  search.ordinal % 21,
  20 + (search.ordinal % 800),
  date_trunc(
    'milliseconds',
    statement_timestamp() - interval '29 days' +
      search.ordinal * interval '10 milliseconds'
  ),
  date_trunc(
    'milliseconds',
    statement_timestamp() - interval '29 days' +
      search.ordinal * interval '10 milliseconds' + interval '1 second'
  ),
  date_trunc(
    'milliseconds',
    statement_timestamp() + interval '1 day' +
      search.ordinal * interval '10 milliseconds'
  )
FROM pg_temp.capacity_parameters AS parameters
CROSS JOIN LATERAL generate_series(1, parameters.search_events) AS search(ordinal);

INSERT INTO platform.action_logs (
  id,
  event_class,
  occurred_at,
  actor_id,
  actor_kind,
  owner_id,
  channel,
  action,
  target_type,
  target_id,
  outcome,
  request_id
)
SELECT
  pg_temp.capacity_uuid('action-log', audit.ordinal),
  'sensitive_read',
  statement_timestamp() - interval '730 days' +
    audit.ordinal * interval '1 second',
  pg_temp.capacity_uuid(
    'actor',
    ((audit.ordinal - 1) % parameters.agents) + 1
  ),
  'agent',
  pg_temp.capacity_uuid(
    'owner',
    (
      (((audit.ordinal - 1) % parameters.agents)) %
      parameters.owners
    ) + 1
  ),
  (ARRAY['rest', 'mcp', 'sdk', 'web'])[
    ((audit.ordinal - 1) % 4) + 1
  ],
  'content.read',
  'content',
  pg_temp.capacity_uuid(
    'content',
    ((audit.ordinal - 1) % parameters.content_items) + 1
  )::text,
  'succeeded',
  'capacity-audit-' || audit.ordinal
FROM pg_temp.capacity_parameters AS parameters
CROSS JOIN LATERAL generate_series(1, parameters.action_logs) AS audit(ordinal);

SET session_replication_role = origin;

ANALYZE auth.users;
ANALYZE platform.owners;
ANALYZE platform.actors;
ANALYZE platform.agents;
ANALYZE platform.agent_policies;
ANALYZE platform.credentials;
ANALYZE platform.content_items;
ANALYZE platform.content_revisions;
ANALYZE platform.content_additional_communities;
ANALYZE platform.content_symbols;
ANALYZE platform.content_topics;
ANALYZE platform.source_links;
ANALYZE platform.reactions;
ANALYZE platform.follows;
ANALYZE platform.notifications;
ANALYZE system.notification_recipient_sequences;
ANALYZE system.notification_change_journal;
ANALYZE platform.agent_search_activity_events;
ANALYZE platform.action_logs;

\echo 'AlphaNet MVP capacity dataset generated'
