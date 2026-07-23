\set ON_ERROR_STOP on

\if :{?load_started_at}
\else
  \set load_started_at '9999-12-31T23:59:59Z'
\endif

CREATE TEMPORARY TABLE capacity_invariant_results (
  invariant text PRIMARY KEY,
  violation_count bigint NOT NULL,
  passed boolean GENERATED ALWAYS AS (violation_count = 0) STORED
);

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog;

INSERT INTO pg_temp.capacity_invariant_results (invariant, violation_count)
VALUES
  (
    'content_tree_shape',
    (
      SELECT count(*)
      FROM platform.content_items AS content
      LEFT JOIN platform.content_items AS root ON root.id = content.root_id
      LEFT JOIN platform.content_items AS parent ON parent.id = content.parent_id
      WHERE root.id IS NULL
        OR (
          content.kind = 'post'
          AND (
            content.root_id <> content.id
            OR content.parent_id IS NOT NULL
            OR content.depth <> 0
          )
        )
        OR (
          content.kind = 'reply'
          AND (
            parent.id IS NULL
            OR content.root_id = content.id
            OR content.depth <> parent.depth + 1
            OR parent.root_id <> content.root_id
          )
        )
    )
  ),
  (
    'current_revision_matches_version',
    (
      SELECT count(*)
      FROM platform.content_items AS content
      LEFT JOIN platform.content_revisions AS revision
        ON revision.id = content.current_revision_id
      WHERE revision.id IS NULL
        OR revision.content_id <> content.id
        OR revision.revision_number > content.version
        OR revision.source_version > content.version
    )
  ),
  (
    'reaction_not_self_authored',
    (
      SELECT count(*)
      FROM platform.reactions AS reaction
      JOIN platform.content_items AS content ON content.id = reaction.content_id
      WHERE reaction.actor_id = content.author_actor_id
    )
  ),
  (
    'notification_sequences_bounded',
    (
      SELECT count(*)
      FROM system.notification_recipient_sequences AS sequence
      LEFT JOIN LATERAL (
        SELECT
          max(notification.created_sequence) AS max_created,
          max(notification.change_sequence) AS max_changed
        FROM platform.notifications AS notification
        WHERE notification.recipient_actor_id = sequence.recipient_actor_id
      ) AS actual ON true
      WHERE sequence.last_created_sequence < COALESCE(actual.max_created, 0)
        OR sequence.last_change_sequence < COALESCE(actual.max_changed, 0)
    )
  ),
  (
    'social_writes_have_success_audit',
    (
      SELECT count(*)
      FROM (
        SELECT reaction.actor_id, reaction.content_id, reaction.created_at
        FROM platform.reactions AS reaction
        WHERE reaction.created_at >= :'load_started_at'::timestamptz
          AND NOT EXISTS (
          SELECT 1
          FROM platform.action_logs AS log
          WHERE log.actor_id = reaction.actor_id
            AND log.target_id = reaction.content_id::text
            AND log.action = 'reaction.set'
            AND log.outcome = 'succeeded'
            AND log.occurred_at >= :'load_started_at'::timestamptz
        )
        UNION ALL
        SELECT follow.follower_actor_id, follow.id, follow.created_at
        FROM platform.follows AS follow
        WHERE follow.updated_at >= :'load_started_at'::timestamptz
          AND NOT EXISTS (
          SELECT 1
          FROM platform.action_logs AS log
          WHERE log.actor_id = follow.follower_actor_id
            AND log.action = 'follow.set'
            AND log.outcome = 'succeeded'
            AND log.occurred_at >= :'load_started_at'::timestamptz
        )
      ) AS missing_audit
    )
  ),
  (
    'outbox_heads_not_behind',
    (
      SELECT count(*)
      FROM system.outbox_aggregate_heads AS head
      JOIN LATERAL (
        SELECT max(event.aggregate_sequence) AS maximum_version
        FROM system.outbox_events AS event
        WHERE event.aggregate_type = head.aggregate_type
          AND event.aggregate_id = head.aggregate_id
      ) AS actual ON true
      WHERE actual.maximum_version IS NOT NULL
        AND head.last_sequence < actual.maximum_version
    )
  );

DO $$
DECLARE
  failed_invariants text;
BEGIN
  SELECT string_agg(
    pg_catalog.format('%s=%s', invariant, violation_count),
    ', ' ORDER BY invariant
  )
  INTO failed_invariants
  FROM pg_temp.capacity_invariant_results
  WHERE NOT passed;

  IF failed_invariants IS NOT NULL THEN
    RAISE EXCEPTION
      'Capacity post-run invariants failed: %',
      failed_invariants
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

\copy (SELECT invariant, violation_count, passed FROM pg_temp.capacity_invariant_results ORDER BY invariant) TO STDOUT WITH (FORMAT csv, HEADER true)

ROLLBACK;

DROP TABLE pg_temp.capacity_invariant_results;
