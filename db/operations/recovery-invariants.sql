\set ON_ERROR_STOP on

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog;

DO $$
DECLARE
  violation_count bigint;
BEGIN
  SELECT count(*)
  INTO violation_count
  FROM pg_catalog.pg_constraint AS constraint_record
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = constraint_record.connamespace
  WHERE namespace.nspname IN ('auth', 'platform', 'system')
    AND NOT constraint_record.convalidated;

  IF violation_count <> 0 THEN
    RAISE EXCEPTION
      'Recovery invariant failed: % application constraints are not validated',
      violation_count
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
  INTO violation_count
  FROM platform.owners AS owner
  LEFT JOIN auth.users AS auth_user
    ON auth_user.id = owner.auth_user_id
  WHERE auth_user.id IS NULL
    OR auth_user.email IS DISTINCT FROM owner.email::text;

  IF violation_count <> 0 THEN
    RAISE EXCEPTION
      'Recovery invariant failed: % Owner authentication chains are invalid',
      violation_count
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
  INTO violation_count
  FROM platform.agents AS agent
  LEFT JOIN platform.actors AS actor
    ON actor.id = agent.actor_id
  WHERE actor.id IS NULL
    OR actor.kind <> 'agent'
    OR actor.owner_id <> agent.owner_id;

  IF violation_count <> 0 THEN
    RAISE EXCEPTION
      'Recovery invariant failed: % Agent Actor chains are invalid',
      violation_count
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
  INTO violation_count
  FROM platform.agents AS agent
  LEFT JOIN LATERAL (
    SELECT count(*) AS active_policy_count
    FROM platform.agent_policies AS policy
    WHERE policy.agent_id = agent.id
      AND policy.is_active
  ) AS policy_summary
    ON true
  WHERE agent.status = 'active'
    AND policy_summary.active_policy_count <> 1;

  IF violation_count <> 0 THEN
    RAISE EXCEPTION
      'Recovery invariant failed: % active Agents do not have exactly one active policy',
      violation_count
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
  INTO violation_count
  FROM platform.credentials AS credential
  LEFT JOIN platform.agents AS agent
    ON agent.id = credential.agent_id
  WHERE agent.id IS NULL
    OR agent.owner_id <> credential.owner_id;

  IF violation_count <> 0 THEN
    RAISE EXCEPTION
      'Recovery invariant failed: % Credential Agent chains are invalid',
      violation_count
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
  INTO violation_count
  FROM platform.pending_actions AS pending_action
  LEFT JOIN platform.agents AS agent
    ON agent.id = pending_action.agent_id
  LEFT JOIN platform.credentials AS credential
    ON credential.id = pending_action.credential_id
  WHERE agent.id IS NULL
    OR agent.owner_id <> pending_action.owner_id
    OR credential.id IS NULL
    OR credential.agent_id <> pending_action.agent_id
    OR credential.owner_id <> pending_action.owner_id;

  IF violation_count <> 0 THEN
    RAISE EXCEPTION
      'Recovery invariant failed: % PendingAction authority chains are invalid',
      violation_count
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
  INTO violation_count
  FROM platform.content_items AS content
  LEFT JOIN platform.content_revisions AS revision
    ON revision.id = content.current_revision_id
   AND revision.content_id = content.id
  WHERE content.current_revision_id IS NULL
    OR revision.id IS NULL
    OR revision.source_version > content.version
    OR EXISTS (
      SELECT 1
      FROM platform.content_revisions AS later_revision
      WHERE later_revision.content_id = content.id
        AND later_revision.revision_number > revision.revision_number
    );

  IF violation_count <> 0 THEN
    RAISE EXCEPTION
      'Recovery invariant failed: % ContentItem current revisions are invalid',
      violation_count
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
  INTO violation_count
  FROM platform.content_revisions AS revision
  LEFT JOIN platform.content_items AS content
    ON content.id = revision.content_id
  WHERE content.id IS NULL
    OR content.author_actor_id <> revision.created_by_actor_id;

  IF violation_count <> 0 THEN
    RAISE EXCEPTION
      'Recovery invariant failed: % ContentRevision author chains are invalid',
      violation_count
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
  INTO violation_count
  FROM system.outbox_events AS event
  LEFT JOIN system.outbox_aggregate_heads AS head
    ON head.aggregate_type = event.aggregate_type
   AND head.aggregate_id = event.aggregate_id
  WHERE head.aggregate_type IS NULL
    OR event.aggregate_sequence > head.last_sequence;

  IF violation_count <> 0 THEN
    RAISE EXCEPTION
      'Recovery invariant failed: % Outbox events are ahead of their aggregate heads',
      violation_count
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
  INTO violation_count
  FROM system.outbox_consumer_deliveries AS delivery
  LEFT JOIN system.outbox_events AS event
    ON event.id = delivery.event_id
  WHERE event.id IS NULL;

  IF violation_count <> 0 THEN
    RAISE EXCEPTION
      'Recovery invariant failed: % active Outbox deliveries have no event',
      violation_count
      USING ERRCODE = '23514';
  END IF;
END;
$$;

SELECT 'recovery_invariants_ok' AS recovery_status;

ROLLBACK;
