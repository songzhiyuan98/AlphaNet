SET LOCAL search_path = pg_catalog;

-- Owner/Human Web social-write authority -----------------------------------
--
-- Keep the three authenticated community principals structurally disjoint.
-- An Agent Credential call carries the complete Credential chain. An Owner
-- acting as a managed Agent is an explicit Web approval without a Credential.
-- A human profile is a distinct human Actor and never inherits Agent policy or
-- Credential identity. The database owns these invariants even when a future
-- API entry point is implemented incorrectly.

ALTER TABLE platform.action_logs
  DROP CONSTRAINT action_logs_domain_write_shape,
  ADD CONSTRAINT action_logs_domain_write_shape
    CHECK (
      event_class <> 'domain_write'
      OR (
        actor_id IS NOT NULL
        AND actor_kind IS NOT NULL
        AND owner_id IS NOT NULL
        AND admin_id IS NULL
        AND target_id IS NOT NULL
        AND decision IS NOT NULL
        AND (
          outcome IN ('denied', 'failed')
          OR outbox_event_id IS NOT NULL
        )
        AND (
          (
            actor_kind = 'agent'
            AND agent_id IS NOT NULL
            AND credential_id IS NOT NULL
            AND policy_version IS NOT NULL
            AND (
              (
                approval_method = 'owner_approval'
                AND approved_by_owner_id IS NOT NULL
                AND approved_by_owner_id = owner_id
                AND authentication_assurance IS NOT NULL
                AND decision = 'require_approval'
                AND outcome = 'succeeded'
              )
              OR (
                approval_method = 'policy_auto'
                AND approved_by_owner_id IS NULL
              )
              OR (
                approval_method IS NULL
                AND approved_by_owner_id IS NULL
                AND outcome IN ('pending', 'denied', 'failed')
              )
            )
          )
          OR (
            actor_kind = 'agent'
            AND agent_id IS NOT NULL
            AND credential_id IS NULL
            AND policy_version IS NOT NULL
            AND channel = 'web'
            AND approval_method = 'owner_direct'
            AND approved_by_owner_id IS NOT NULL
            AND approved_by_owner_id = owner_id
            AND authentication_assurance IS NOT NULL
            AND decision <> 'require_approval'
            AND outcome <> 'pending'
          )
          OR (
            actor_kind = 'human'
            AND agent_id IS NULL
            AND credential_id IS NULL
            AND policy_version IS NULL
            AND channel = 'web'
            AND approval_method = 'human_direct'
            AND approved_by_owner_id IS NOT NULL
            AND approved_by_owner_id = owner_id
            AND authentication_assurance IS NOT NULL
            AND decision <> 'require_approval'
            AND outcome <> 'pending'
          )
        )
      )
    );

CREATE FUNCTION platform.validate_domain_write_subject()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'action_logs'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Domain-write subject validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.event_class <> 'domain_write' THEN
    RETURN NEW;
  END IF;

  IF NEW.actor_kind = 'agent' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM platform.agents AS agent
      WHERE agent.id = NEW.agent_id
        AND agent.owner_id = NEW.owner_id
        AND agent.actor_id = NEW.actor_id
    ) THEN
      RAISE EXCEPTION
        'Domain-write Agent, Actor, and Owner must be one stable identity chain'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.actor_kind = 'human' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM platform.actors AS actor
      WHERE actor.id = NEW.actor_id
        AND actor.owner_id = NEW.owner_id
        AND actor.kind = 'human'
    ) THEN
      RAISE EXCEPTION
        'Human-direct Actor and Owner must be one stable identity chain'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION
      'Domain-write subject kind is unsupported'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION platform.validate_domain_write_subject() FROM PUBLIC;

CREATE TRIGGER action_logs_validate_domain_write_subject
BEFORE INSERT ON platform.action_logs
FOR EACH ROW
EXECUTE FUNCTION platform.validate_domain_write_subject();

-- Runtime content provenance ------------------------------------------------
--
-- Preserve the existing credential-autonomous, PendingAction approval, and
-- administrator moderation paths. The two direct Web paths still require the
-- same transaction-local ContentItem, Revision, Outbox, ActionLog, and
-- succeeded IdempotencyRecord bundle. The ActionLog and idempotency triggers
-- above prove the Owner/Actor/Agent shape and server-derived principal scope.

CREATE OR REPLACE FUNCTION platform.validate_runtime_content_write_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate_content_id uuid;
  candidate_full_xid numeric;
  content_author_actor_id uuid;
  content_current_revision_id uuid;
  content_kind text;
  content_distribution_state text;
  content_lifecycle_state text;
  content_root_content_id uuid;
  content_version bigint;
  content_xid xid;
  current_top_full_xid numeric;
  current_revision_number bigint;
  current_revision_source_version bigint;
  current_revision_xid xid;
  event_content_version bigint;
  expected_action text;
  expected_event_type text;
  expected_operation text;
  expected_response_code integer;
  initializes_revision boolean;
  is_delete_write boolean := false;
  is_initial_write boolean;
  is_moderation_write boolean := false;
  moderation_before_distribution_state text;
  is_revision_write boolean;
  privileged_writer boolean;
  provenance_exists boolean;
  xid_epoch_base numeric;
BEGIN
  SELECT role.rolsuper OR relation.relowner = role.oid
  INTO privileged_writer
  FROM pg_roles AS role
  CROSS JOIN pg_class AS relation
  JOIN pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE role.rolname = current_user
    AND namespace.nspname = 'platform'
    AND relation.relname = 'content_items'
    AND relation.relkind IN ('p', 'r');

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Content provenance validator cannot identify the effective writer'
      USING ERRCODE = '42501';
  END IF;

  IF privileged_writer THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_SCHEMA <> 'platform' THEN
    RAISE EXCEPTION
      'Content provenance validator invoked outside platform'
      USING ERRCODE = '42501';
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'content_items' THEN
      IF TG_OP NOT IN ('INSERT', 'UPDATE') THEN
        RAISE EXCEPTION
          'Content provenance validator received an invalid ContentItem operation'
          USING ERRCODE = '42501';
      END IF;
      candidate_content_id := NEW.id;
      event_content_version := NEW.version;

      IF TG_OP = 'INSERT' THEN
        IF NEW.version <> 1
          OR NEW.lifecycle_state <> 'published'
          OR NEW.deleted_at IS NOT NULL THEN
          RAISE EXCEPTION
            'Runtime ContentItem must begin published at version one'
            USING ERRCODE = '23514';
        END IF;
      ELSE
        initializes_revision :=
          OLD.version = 1
          AND NEW.version = 1
          AND OLD.current_revision_id IS NULL
          AND NEW.current_revision_id IS NOT NULL;
        is_delete_write :=
          OLD.lifecycle_state = 'published'
          AND NEW.lifecycle_state = 'deleted';
        is_moderation_write :=
          NEW.distribution_state IS DISTINCT FROM OLD.distribution_state;
        moderation_before_distribution_state := OLD.distribution_state;

        IF NOT initializes_revision
          AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION
            'Runtime ContentItem update must advance exactly one version'
            USING ERRCODE = '23514';
        END IF;

        IF is_moderation_write THEN
          IF initializes_revision
            OR is_delete_write
            OR OLD.lifecycle_state <> 'published'
            OR NEW.lifecycle_state <> 'published'
            OR OLD.deleted_at IS NOT NULL
            OR NEW.deleted_at IS NOT NULL
            OR NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id
            OR NEW.primary_community_id IS DISTINCT FROM OLD.primary_community_id
            OR NEW.erasure_state IS DISTINCT FROM OLD.erasure_state THEN
            RAISE EXCEPTION
              'Runtime moderation may change only Content version and distribution state'
              USING ERRCODE = '23514';
          END IF;
        ELSIF is_delete_write THEN
          IF NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id
            OR NEW.deleted_at IS NULL
            OR OLD.deleted_at IS NOT NULL
            OR NEW.distribution_state IS DISTINCT FROM OLD.distribution_state
            OR NEW.erasure_state IS DISTINCT FROM OLD.erasure_state THEN
            RAISE EXCEPTION
              'Runtime author deletion may change only version, lifecycle state, and deletion time'
              USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
          OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
          RAISE EXCEPTION
            'Runtime ContentItem state change is not an author soft deletion'
            USING ERRCODE = '23514';
        END IF;
      END IF;
    WHEN 'content_additional_communities', 'content_symbols', 'content_topics' THEN
      IF TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
        RAISE EXCEPTION
          'Content provenance validator received an invalid classification operation'
          USING ERRCODE = '42501';
      END IF;
      candidate_content_id := CASE WHEN TG_OP = 'DELETE'
        THEN OLD.content_id ELSE NEW.content_id END;
    WHEN 'source_links' THEN
      IF TG_OP NOT IN ('INSERT', 'UPDATE') THEN
        RAISE EXCEPTION
          'Content provenance validator received an invalid SourceLink operation'
          USING ERRCODE = '42501';
      END IF;
      candidate_content_id := NEW.content_id;
    WHEN 'content_relations' THEN
      IF TG_OP NOT IN ('INSERT', 'UPDATE') THEN
        RAISE EXCEPTION
          'Content provenance validator received an invalid ContentRelation operation'
          USING ERRCODE = '42501';
      END IF;
      candidate_content_id := NEW.from_content_id;
    WHEN 'mentions' THEN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION
          'Content provenance validator received an invalid Mention operation'
          USING ERRCODE = '42501';
      END IF;
      candidate_content_id := NEW.content_id;
    ELSE
      RAISE EXCEPTION
        'Content provenance validator invoked outside its bindings'
        USING ERRCODE = '42501';
  END CASE;

  SELECT
    content.author_actor_id,
    content.current_revision_id,
    content.kind,
    content.distribution_state,
    content.lifecycle_state,
    content.root_id,
    content.version,
    content.xmin,
    revision.revision_number,
    revision.source_version,
    revision.xmin
  INTO
    content_author_actor_id,
    content_current_revision_id,
    content_kind,
    content_distribution_state,
    content_lifecycle_state,
    content_root_content_id,
    content_version,
    content_xid,
    current_revision_number,
    current_revision_source_version,
    current_revision_xid
  FROM platform.content_items AS content
  JOIN platform.content_revisions AS revision
    ON revision.id = content.current_revision_id
   AND revision.content_id = content.id
  WHERE content.id = candidate_content_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Runtime content provenance requires a final ContentItem and Revision'
      USING ERRCODE = '23514';
  END IF;

  IF event_content_version IS NOT NULL
    AND content_version <> event_content_version THEN
    RAISE EXCEPTION
      'Runtime ContentItem event version was superseded in the same transaction'
      USING ERRCODE = '23514';
  END IF;

  -- Classification or Revision facts cannot be attached, removed, or closed
  -- under a deletion event. The tombstone changes only the ContentItem row.
  IF content_lifecycle_state = 'deleted'
    AND (TG_TABLE_NAME <> 'content_items' OR NOT is_delete_write) THEN
    RAISE EXCEPTION
      'Runtime author deletion cannot mutate content classification or Revision facts'
      USING ERRCODE = '23514';
  END IF;

  -- Heap xmin stores only the low 32 bits of a FullTransactionId. Reconstruct
  -- the nearest full candidate around the active top-level xid, including the
  -- adjacent epochs, then require PostgreSQL to report that top/subtransaction
  -- as still in progress. This is both wrap-safe and SAVEPOINT-safe.
  current_top_full_xid := pg_current_xact_id()::text::numeric;
  xid_epoch_base :=
    current_top_full_xid - mod(current_top_full_xid, 4294967296);
  candidate_full_xid := xid_epoch_base + content_xid::text::numeric;
  IF candidate_full_xid - current_top_full_xid > 2147483648 THEN
    candidate_full_xid := candidate_full_xid - 4294967296;
  ELSIF current_top_full_xid - candidate_full_xid > 2147483648 THEN
    candidate_full_xid := candidate_full_xid + 4294967296;
  END IF;

  IF candidate_full_xid < 0
    OR pg_xact_status(candidate_full_xid::text::xid8)
      IS DISTINCT FROM 'in progress' THEN
    RAISE EXCEPTION
      'Runtime ContentItem write is not from the active transaction tree'
      USING ERRCODE = '23514';
  END IF;


  IF is_moderation_write THEN
    IF content_lifecycle_state <> 'published'
      OR current_revision_source_version >= content_version THEN
      RAISE EXCEPTION
        'Runtime moderation cannot restore author-deleted content or create a Revision'
        USING ERRCODE = '23514';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM platform.moderation_cases AS moderation_case
      JOIN platform.moderation_actions AS moderation_action
        ON moderation_action.case_id = moderation_case.id
       AND moderation_action.xmin = content_xid
      JOIN platform.admins AS admin
        ON admin.id = moderation_action.admin_id
       AND admin.status = 'active'
      JOIN platform.admin_assignments AS assignment
        ON assignment.admin_id = admin.id
       AND assignment.granted_at <= moderation_action.occurred_at
       AND assignment.revoked_at IS NULL
       AND (
         assignment.expires_at IS NULL
         OR assignment.expires_at > moderation_action.occurred_at
       )
      JOIN platform.admin_roles AS role
        ON role.id = assignment.role_id
       AND role.status = 'active'
      JOIN platform.admin_role_permissions AS role_permission
        ON role_permission.role_id = role.id
       AND role_permission.permission = moderation_action.permission_used
      JOIN platform.action_logs AS log
        ON log.id = moderation_action.action_log_id
       AND log.xmin = content_xid
      JOIN system.outbox_events AS event
        ON event.id = moderation_action.outbox_event_id
       AND event.xmin = content_xid
      WHERE moderation_case.target_type = 'content'
        AND moderation_case.target_content_id = candidate_content_id
        AND moderation_case.target_agent_id IS NULL
        AND moderation_action.permission_used = 'moderation:decide'
        AND moderation_action.action = CASE content_distribution_state
          WHEN 'limited' THEN 'limit_content'
          WHEN 'hidden' THEN 'hide_content'
          WHEN 'normal' THEN 'restore_content'
          ELSE NULL
        END
        AND moderation_action.before_distribution_state =
          moderation_before_distribution_state
        AND moderation_action.after_distribution_state =
          content_distribution_state
        AND moderation_action.target_version_before = content_version - 1
        AND moderation_action.target_version_after = content_version
        AND moderation_action.result_state = 'succeeded'
        AND log.event_class = 'governance'
        AND log.actor_id IS NULL
        AND log.actor_kind IS NULL
        AND log.owner_id IS NULL
        AND log.agent_id IS NULL
        AND log.credential_id IS NULL
        AND log.admin_id = moderation_action.admin_id
        AND log.channel = 'admin_web'
        AND log.approval_method = 'admin_override'
        AND log.approved_by_owner_id IS NULL
        AND log.authentication_assurance = 'workforce_oidc'
        AND log.authorization_snapshot ->> 'permission' =
          moderation_action.permission_used
        AND log.action = CASE moderation_action.action
          WHEN 'limit_content' THEN 'moderation.limit_content'
          WHEN 'hide_content' THEN 'moderation.hide_content'
          WHEN 'restore_content' THEN 'moderation.restore_content'
          ELSE NULL
        END
        AND log.target_type = 'content'
        AND log.target_id = candidate_content_id::text
        AND log.decision = 'allow'
        AND log.outcome = 'succeeded'
        AND log.error_code IS NULL
        AND log.retry_count = 0
        AND log.outbox_event_id = event.id
        AND log.policy_version IS NULL
        AND log.security_subject_digest IS NULL
        AND log.before_state = jsonb_build_object(
          'distribution_state', moderation_before_distribution_state,
          'resource_version', content_version - 1
        )
        AND log.after_state = jsonb_build_object(
          'content_id', candidate_content_id,
          'case_id', moderation_case.id,
          'moderation_action_id', moderation_action.id,
          'distribution_state', content_distribution_state,
          'resource_version', content_version
        )
        AND log.reason_code = moderation_action.reason_code
        AND event.aggregate_type = 'content'
        AND event.aggregate_id = candidate_content_id::text
        AND event.event_type = 'content.moderation_changed'
        AND event.event_version = 1
        AND event.payload = jsonb_build_object(
          'content_id', candidate_content_id,
          'case_id', moderation_case.id,
          'moderation_action_id', moderation_action.id,
          'reason_code', moderation_action.reason_code,
          'before_distribution_state', moderation_before_distribution_state,
          'after_distribution_state', content_distribution_state,
          'resource_version', content_version,
          'kind', content_kind,
          'root_content_id', content_root_content_id,
          'current_revision_id', content_current_revision_id
        )
    ) INTO provenance_exists;

    IF NOT provenance_exists THEN
      RAISE EXCEPTION
        'Runtime distribution change requires moderation, RBAC, audit, and Outbox provenance'
        USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
  END IF;

  is_initial_write :=
    content_lifecycle_state = 'published'
    AND content_version = 1
    AND current_revision_number = 1
    AND current_revision_source_version = 1;
  is_revision_write :=
    is_initial_write
    OR (
      content_lifecycle_state = 'published'
      AND current_revision_source_version = content_version
    );

  IF is_revision_write
    AND current_revision_xid IS DISTINCT FROM content_xid THEN
    RAISE EXCEPTION
      'Runtime author Revision must share the ContentItem transaction id'
      USING ERRCODE = '23514';
  END IF;

  IF is_delete_write THEN
    IF content_lifecycle_state <> 'deleted'
      OR current_revision_source_version >= content_version THEN
      RAISE EXCEPTION
        'Runtime author deletion must retain the prior current Revision'
        USING ERRCODE = '23514';
    END IF;
    expected_action := 'content.delete_content';
    expected_event_type := 'content.deleted';
    expected_operation := 'delete_content';
    expected_response_code := 200;
  ELSIF is_initial_write THEN
    IF content_kind = 'post' THEN
      expected_action := 'content.create_post';
      expected_event_type := 'content.published';
      expected_operation := 'create_post';
    ELSIF content_kind = 'reply' THEN
      expected_action := 'content.reply_to_content';
      expected_event_type := 'content.reply';
      expected_operation := 'reply_to_content';
    ELSE
      RAISE EXCEPTION
        'Runtime initial content has an unsupported kind'
        USING ERRCODE = '23514';
    END IF;
    expected_response_code := 201;
  ELSE
    IF content_lifecycle_state <> 'published' THEN
      RAISE EXCEPTION
        'Runtime ContentItem state has no supported content command'
        USING ERRCODE = '23514';
    END IF;
    expected_action := 'content.update_content';
    expected_event_type := 'content.revised';
    expected_operation := 'update_content';
    expected_response_code := 200;
  END IF;

  -- Revision-scoped facts can only enter or leave under the final author
  -- Revision for this command. A classification-only version advance keeps an
  -- older current Revision and therefore cannot be used to smuggle fact DML.
  IF TG_TABLE_NAME IN ('source_links', 'content_relations', 'mentions') THEN
    IF current_revision_source_version <> content_version THEN
      RAISE EXCEPTION
        'Revision-scoped facts require the final Revision for this command'
        USING ERRCODE = '23514';
    END IF;

    IF TG_TABLE_NAME = 'source_links' THEN
      IF (
        (TG_OP = 'INSERT' AND (
          NEW.added_revision_id IS DISTINCT FROM content_current_revision_id
          OR NEW.removed_revision_id IS NOT NULL
        ))
        OR (TG_OP = 'UPDATE'
          AND NEW.removed_revision_id IS DISTINCT FROM content_current_revision_id)
      ) THEN
        RAISE EXCEPTION
          'SourceLink must use the final current Revision'
          USING ERRCODE = '23514';
      END IF;
    ELSIF TG_TABLE_NAME = 'content_relations' THEN
      IF (
        (TG_OP = 'INSERT' AND (
          NEW.added_revision_id IS DISTINCT FROM content_current_revision_id
          OR NEW.removed_revision_id IS NOT NULL
        ))
        OR (TG_OP = 'UPDATE'
          AND NEW.removed_revision_id IS DISTINCT FROM content_current_revision_id)
      ) THEN
        RAISE EXCEPTION
          'ContentRelation must use the final current Revision'
          USING ERRCODE = '23514';
      END IF;
    ELSIF TG_TABLE_NAME = 'mentions' THEN
      IF (
        NEW.revision_id IS DISTINCT FROM content_current_revision_id
        OR NEW.revision_number <> current_revision_number
      ) THEN
        RAISE EXCEPTION
          'Mention must use the final current Revision'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM system.outbox_events AS event
    JOIN platform.action_logs AS log
      ON log.outbox_event_id = event.id
    JOIN platform.idempotency_records AS idempotency
      ON idempotency.id = CASE
        WHEN log.after_state ->> 'idempotency_record_id' ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN (log.after_state ->> 'idempotency_record_id')::uuid
        ELSE NULL
      END
    WHERE event.xmin = content_xid
      AND log.xmin = content_xid
      AND idempotency.xmin = content_xid
      AND event.aggregate_type = 'content'
      AND event.aggregate_id = candidate_content_id::text
      AND event.event_type = expected_event_type
      AND event.event_version = 1
      AND event.payload ->> 'content_id' = candidate_content_id::text
      AND event.payload ->> 'actor_id' = content_author_actor_id::text
      AND (
        (
          is_delete_write
          AND event.payload ->> 'resource_version' = content_version::text
          AND event.payload ->> 'lifecycle_state' = 'deleted'
          AND event.payload ->> 'kind' = content_kind
          AND event.payload ->> 'root_content_id' = content_root_content_id::text
          AND event.payload ->> 'current_revision_id' =
            content_current_revision_id::text
        )
        OR (
          is_initial_write
          AND event.payload ->> 'kind' = content_kind
          AND event.payload ->> 'revision_id' = content_current_revision_id::text
        )
        OR (
          NOT is_delete_write
          AND NOT is_initial_write
          AND event.payload ->> 'resource_version' = content_version::text
          AND (
            (
              current_revision_source_version = content_version
              AND event.payload ->> 'revision_id' =
                content_current_revision_id::text
            )
            OR (
              current_revision_source_version < content_version
              AND event.payload ? 'revision_id'
              AND event.payload -> 'revision_id' = 'null'::jsonb
            )
          )
        )
      )
      AND log.event_class = 'domain_write'
      AND log.actor_id = content_author_actor_id
      AND log.action = expected_action
      AND log.target_type = 'content'
      AND log.target_id = candidate_content_id::text
      AND log.outcome = 'succeeded'
      AND log.after_state ->> 'content_id' = candidate_content_id::text
      AND log.after_state ->> 'resource_version' = content_version::text
      AND (
        NOT is_delete_write
        OR log.after_state ->> 'lifecycle_state' = 'deleted'
      )
      AND idempotency.owner_id = log.owner_id
      AND idempotency.agent_id IS NOT DISTINCT FROM log.agent_id
      AND idempotency.credential_id IS NOT DISTINCT FROM log.credential_id
      AND idempotency.actor_id = content_author_actor_id
      AND idempotency.operation = expected_operation
      AND idempotency.status = 'succeeded'
      AND idempotency.response_code = expected_response_code
      AND idempotency.resource_id = candidate_content_id
      AND idempotency.terminal_at IS NOT NULL
      AND (
        (
          log.decision = 'allow'
          AND log.approval_method = 'policy_auto'
          AND log.approved_by_owner_id IS NULL
          AND idempotency.pending_action_id IS NULL
        )
        OR (
          log.decision = 'require_approval'
          AND log.approval_method = 'owner_approval'
          AND log.approved_by_owner_id = log.owner_id
          AND log.authentication_assurance = 'owner_approval_record'
          AND log.authorization_snapshot ->> 'decision' = 'require_approval'
          AND log.authorization_snapshot #>> '{owner_approval,method}' =
            'owner_approval'
          AND log.authorization_snapshot #>>
            '{owner_approval,decision_audit_id}' ~
              '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND EXISTS (
            SELECT 1
            FROM platform.pending_actions AS action
            JOIN platform.action_logs AS request_log
              ON request_log.id = action.audit_id
            JOIN platform.action_logs AS decision_log
              ON decision_log.id = action.decision_audit_id
            WHERE action.id = CASE
                WHEN log.after_state ->> 'pending_action_id' ~
                  '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                THEN (log.after_state ->> 'pending_action_id')::uuid
                ELSE NULL
              END
              AND action.xmin = content_xid
              AND action.state = 'succeeded'
              AND action.owner_id = log.owner_id
              AND action.agent_id = log.agent_id
              AND action.credential_id = log.credential_id
              AND action.operation = expected_operation
              AND action.idempotency_record_id = idempotency.id
              AND idempotency.pending_action_id = action.id
              AND action.decision_reason_code = 'owner_approved'
              AND action.decided_by_owner_id = log.owner_id
              AND action.approval_method = 'owner_approval'
              AND action.decision_audit_id::text =
                log.authorization_snapshot #>>
                  '{owner_approval,decision_audit_id}'
              AND action.result ->> 'content_id' = candidate_content_id::text
              AND action.result ->> 'resource_version' = content_version::text
              AND (
                NOT is_delete_write
                OR action.result ->> 'lifecycle_state' = 'deleted'
              )
              AND (
                (
                  expected_operation IN ('update_content', 'delete_content')
                  AND action.expected_version = content_version - 1
                )
                OR (
                  expected_operation NOT IN ('update_content', 'delete_content')
                  AND action.expected_version IS NULL
                )
              )
              AND request_log.event_class = 'domain_write'
              AND request_log.actor_id = content_author_actor_id
              AND request_log.owner_id = log.owner_id
              AND request_log.agent_id = log.agent_id
              AND request_log.credential_id = log.credential_id
              AND request_log.action = expected_action
              AND request_log.decision = 'require_approval'
              AND request_log.outcome = 'pending'
              AND decision_log.event_class = 'approval_transition'
              AND decision_log.owner_id = log.owner_id
              AND decision_log.agent_id = log.agent_id
              AND decision_log.approval_method = 'owner_approval'
              AND decision_log.approved_by_owner_id = log.owner_id
              AND decision_log.action = 'pending_action.approve'
              AND decision_log.target_type = 'pending_action'
              AND decision_log.target_id = action.id::text
              AND decision_log.decision = 'require_approval'
              AND decision_log.outcome = 'succeeded'
              AND decision_log.reason_code = 'owner_approved'
          )
        )
        OR (
          log.decision = 'allow'
          AND log.approval_method = 'owner_direct'
          AND log.approved_by_owner_id = log.owner_id
          AND log.authentication_assurance IS NOT NULL
          AND idempotency.pending_action_id IS NULL
        )
        OR (
          log.decision = 'allow'
          AND log.approval_method = 'human_direct'
          AND log.approved_by_owner_id = log.owner_id
          AND log.authentication_assurance IS NOT NULL
          AND idempotency.pending_action_id IS NULL
        )
      )
  ) INTO provenance_exists;

  IF NOT provenance_exists THEN
    RAISE EXCEPTION
      'Runtime content mutation requires Outbox, audit, and idempotency provenance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION platform.validate_runtime_content_write_provenance()
  FROM PUBLIC;
