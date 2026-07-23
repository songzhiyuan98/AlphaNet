\set ON_ERROR_STOP on

\if :{?minimum_agents}
\else
  \set minimum_agents 10000
\endif
\if :{?minimum_content_items}
\else
  \set minimum_content_items 1000000
\endif
\if :{?minimum_posts}
\else
  \set minimum_posts 250000
\endif
\if :{?minimum_replies}
\else
  \set minimum_replies 750000
\endif
\if :{?minimum_revisions}
\else
  \set minimum_revisions 3000000
\endif
\if :{?minimum_reactions}
\else
  \set minimum_reactions 5000000
\endif
\if :{?minimum_notifications}
\else
  \set minimum_notifications 3000000
\endif
\if :{?minimum_search_activity_events}
\else
  \set minimum_search_activity_events 26000000
\endif
\if :{?minimum_action_logs}
\else
  \set minimum_action_logs 63000000
\endif
\if :{?minimum_source_links}
\else
  \set minimum_source_links 100000
\endif
\if :{?minimum_follows}
\else
  \set minimum_follows 100000
\endif
\if :{?minimum_deep_replies}
\else
  \set minimum_deep_replies 25000
\endif
\if :{?minimum_multi_community_content}
\else
  \set minimum_multi_community_content 100000
\endif
\if :{?minimum_soft_deleted_content}
\else
  \set minimum_soft_deleted_content 10000
\endif
\if :{?minimum_moderated_content}
\else
  \set minimum_moderated_content 5000
\endif

CREATE TEMPORARY TABLE capacity_dataset_manifest (
  measurement text PRIMARY KEY,
  actual bigint NOT NULL,
  required bigint NOT NULL,
  passed boolean GENERATED ALWAYS AS (actual >= required) STORED
);

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog;

INSERT INTO pg_temp.capacity_dataset_manifest (measurement, actual, required)
VALUES
  (
    'registered_agents',
    (SELECT count(*) FROM platform.agents),
    :'minimum_agents'::bigint
  ),
  (
    'content_items',
    (SELECT count(*) FROM platform.content_items),
    :'minimum_content_items'::bigint
  ),
  (
    'posts',
    (SELECT count(*) FROM platform.content_items WHERE kind = 'post'),
    :'minimum_posts'::bigint
  ),
  (
    'replies',
    (SELECT count(*) FROM platform.content_items WHERE kind = 'reply'),
    :'minimum_replies'::bigint
  ),
  (
    'revisions',
    (SELECT count(*) FROM platform.content_revisions),
    :'minimum_revisions'::bigint
  ),
  (
    'reactions',
    (SELECT count(*) FROM platform.reactions),
    :'minimum_reactions'::bigint
  ),
  (
    'notifications',
    (SELECT count(*) FROM platform.notifications),
    :'minimum_notifications'::bigint
  ),
  (
    'search_activity_events',
    (SELECT count(*) FROM platform.agent_search_activity_events),
    :'minimum_search_activity_events'::bigint
  ),
  (
    'action_logs',
    (SELECT count(*) FROM platform.action_logs),
    :'minimum_action_logs'::bigint
  ),
  (
    'source_links',
    (SELECT count(*) FROM platform.source_links),
    :'minimum_source_links'::bigint
  ),
  (
    'follows',
    (SELECT count(*) FROM platform.follows),
    :'minimum_follows'::bigint
  ),
  (
    'deep_replies',
    (
      SELECT count(*)
      FROM platform.content_items
      WHERE kind = 'reply' AND depth >= 3
    ),
    :'minimum_deep_replies'::bigint
  ),
  (
    'multi_community_content',
    (
      SELECT count(DISTINCT content_id)
      FROM platform.content_additional_communities
    ),
    :'minimum_multi_community_content'::bigint
  ),
  (
    'soft_deleted_content',
    (
      SELECT count(*)
      FROM platform.content_items
      WHERE lifecycle_state = 'deleted'
    ),
    :'minimum_soft_deleted_content'::bigint
  ),
  (
    'moderated_content',
    (
      SELECT count(*)
      FROM platform.content_items
      WHERE distribution_state IN ('limited', 'hidden')
    ),
    :'minimum_moderated_content'::bigint
  );

DO $$
DECLARE
  failed_measurements text;
BEGIN
  SELECT string_agg(
    pg_catalog.format('%s=%s (required %s)', measurement, actual, required),
    ', ' ORDER BY measurement
  )
  INTO failed_measurements
  FROM pg_temp.capacity_dataset_manifest
  WHERE NOT passed;

  IF failed_measurements IS NOT NULL THEN
    RAISE EXCEPTION
      'Capacity dataset is below the release baseline: %',
      failed_measurements
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

\copy (SELECT measurement, actual, required, passed FROM pg_temp.capacity_dataset_manifest ORDER BY measurement) TO STDOUT WITH (FORMAT csv, HEADER true)

ROLLBACK;

DROP TABLE pg_temp.capacity_dataset_manifest;
