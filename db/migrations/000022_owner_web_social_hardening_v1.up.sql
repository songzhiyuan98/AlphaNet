SET LOCAL search_path = pg_catalog;

-- Owner Web social forward hardening ---------------------------------------
--
-- Migration 000021 introduced the three Web/credential principal shapes.
-- Keep that migration immutable and tighten its forward contract here.

ALTER TABLE platform.action_logs
  ADD CONSTRAINT action_logs_authentication_assurance_semantics_v1
  CHECK (
    event_class <> 'domain_write'
    OR CASE approval_method
        WHEN 'policy_auto' THEN
          authentication_assurance = 'agent_credential'
        WHEN 'owner_direct' THEN
          authentication_assurance IN ('owner_session', 'fresh_owner_session')
        WHEN 'human_direct' THEN
          authentication_assurance IN ('owner_session', 'fresh_owner_session')
        WHEN 'owner_approval' THEN
          authentication_assurance = 'owner_approval_record'
        ELSE true
      END IS TRUE
  ) NOT VALID;

ALTER TABLE platform.action_logs
  VALIDATE CONSTRAINT action_logs_authentication_assurance_semantics_v1;

-- Lock and validate the current authority chain at the ActionLog insertion
-- boundary. Separate statements make the lock order deterministic:
-- Owner -> Agent -> Actor -> active Policy -> Credential.
CREATE OR REPLACE FUNCTION platform.validate_domain_write_subject()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  database_now timestamptz := statement_timestamp();
  subject_actor_id uuid;
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

  -- Historical Pending/deny/failure rows predate the assurance vocabulary and
  -- cannot be rewritten. Close the legacy nullable approval path for every new
  -- credential write at the INSERT boundary instead.
  IF NEW.actor_kind = 'agent'
    AND NEW.credential_id IS NOT NULL
    AND NEW.approval_method IS NULL
    AND NEW.authentication_assurance IS DISTINCT FROM 'agent_credential' THEN
    RAISE EXCEPTION
      'Credential domain writes require Agent credential assurance'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM platform.owners AS owner
  WHERE owner.id = NEW.owner_id
    AND owner.status = 'active'
    AND owner.email_verified_at IS NOT NULL
    AND owner.email_verified_at <= database_now
    AND owner.deleted_at IS NULL
  FOR SHARE OF owner;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Domain-write Owner must be currently active and verified'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.actor_kind = 'agent' THEN
    SELECT agent.actor_id
    INTO subject_actor_id
    FROM platform.agents AS agent
    WHERE agent.id = NEW.agent_id
      AND agent.owner_id = NEW.owner_id
      AND agent.status = 'active'
      AND agent.activated_at IS NOT NULL
      AND agent.activated_at <= database_now
      AND agent.archived_at IS NULL
      AND agent.deleted_at IS NULL
    FOR SHARE OF agent;

    IF NOT FOUND OR subject_actor_id IS DISTINCT FROM NEW.actor_id THEN
      RAISE EXCEPTION
        'Domain-write Agent must be currently active in the asserted Owner chain'
        USING ERRCODE = '23514';
    END IF;

    PERFORM 1
    FROM platform.actors AS actor
    WHERE actor.id = subject_actor_id
      AND actor.owner_id = NEW.owner_id
      AND actor.kind = 'agent'
      AND actor.status = 'active'
      AND actor.deleted_at IS NULL
    FOR SHARE OF actor;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Domain-write Agent Actor must be currently active'
        USING ERRCODE = '23514';
    END IF;

    PERFORM 1
    FROM platform.agent_policies AS policy
    WHERE policy.agent_id = NEW.agent_id
      AND policy.version = NEW.policy_version
      AND policy.configured_by_owner_id = NEW.owner_id
      AND policy.is_active
      AND policy.effective_from <= database_now
    FOR SHARE OF policy;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Domain-write policy must be the current effective Agent policy'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.credential_id IS NOT NULL THEN
      PERFORM 1
      FROM platform.credentials AS credential
      WHERE credential.id = NEW.credential_id
        AND credential.owner_id = NEW.owner_id
        AND credential.agent_id = NEW.agent_id
        AND credential.issued_at <= database_now
        AND credential.revoked_at IS NULL
        AND (
          credential.expires_at IS NULL
          OR credential.expires_at > database_now
        )
      FOR SHARE OF credential;

      IF NOT FOUND THEN
        RAISE EXCEPTION
          'Domain-write Credential must be current in the asserted Agent chain'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF NEW.actor_kind = 'human' THEN
    PERFORM 1
    FROM platform.actors AS actor
    WHERE actor.id = NEW.actor_id
      AND actor.owner_id = NEW.owner_id
      AND actor.kind = 'human'
      AND actor.status = 'active'
      AND actor.deleted_at IS NULL
    FOR SHARE OF actor;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Human-direct Actor must be currently active in the asserted Owner chain'
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

-- Exact content-v1 event ABI. Non-content events and future content event
-- versions remain outside this predicate so unrelated Outbox producers are
-- not frozen by the Owner Web migration.
CREATE FUNCTION system.content_v1_outbox_payload_is_valid(
  aggregate_type text,
  aggregate_id text,
  event_type text,
  event_version integer,
  payload jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  allowed_changed_groups constant text[] := ARRAY[
    'title',
    'body_markdown',
    'source_links',
    'references',
    'additional_community_ids',
    'symbols',
    'topics'
  ];
  array_name text;
  array_names text[];
  array_limit integer;
  array_value jsonb;
  changed_group text;
  changed_group_position integer;
  last_changed_group_position integer := 0;
  expected_keys text[];
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF aggregate_type <> 'content'
    OR event_version <> 1
    OR event_type NOT IN (
      'content.published',
      'content.reply',
      'content.revised',
      'content.deleted'
    ) THEN
    RETURN true;
  END IF;

  IF jsonb_typeof(payload) <> 'object'
    OR NOT platform.audit_json_is_secret_free_v2(payload)
    OR aggregate_id !~ uuid_pattern
    OR payload ->> 'content_id' IS DISTINCT FROM aggregate_id THEN
    RETURN false;
  END IF;

  IF event_type IN ('content.published', 'content.reply') THEN
    expected_keys := ARRAY[
      'actor_id',
      'community_ids',
      'content_id',
      'kind',
      'parent_content_id',
      'revision_id',
      'root_content_id',
      'symbol_ids',
      'topic_ids'
    ];
  ELSIF event_type = 'content.revised' THEN
    expected_keys := ARRAY[
      'actor_id',
      'affected_symbol_ids',
      'affected_topic_ids',
      'changed_groups',
      'community_ids',
      'content_id',
      'resource_version',
      'revision_id',
      'root_content_id',
      'symbol_ids',
      'topic_ids'
    ];
  ELSE
    expected_keys := ARRAY[
      'actor_id',
      'content_id',
      'current_revision_id',
      'kind',
      'lifecycle_state',
      'resource_version',
      'root_content_id'
    ];
  END IF;

  IF NOT payload ?& expected_keys
    OR payload - expected_keys <> '{}'::jsonb
    OR jsonb_typeof(payload -> 'actor_id') <> 'string'
    OR payload ->> 'actor_id' !~ uuid_pattern
    OR jsonb_typeof(payload -> 'content_id') <> 'string'
    OR payload ->> 'content_id' !~ uuid_pattern
    OR jsonb_typeof(payload -> 'root_content_id') <> 'string'
    OR payload ->> 'root_content_id' !~ uuid_pattern THEN
    RETURN false;
  END IF;

  IF event_type IN ('content.published', 'content.reply') THEN
    IF jsonb_typeof(payload -> 'revision_id') <> 'string'
      OR payload ->> 'revision_id' !~ uuid_pattern
      OR jsonb_typeof(payload -> 'kind') <> 'string'
      OR payload ->> 'kind' IS DISTINCT FROM (
        CASE event_type
          WHEN 'content.published' THEN 'post'
          ELSE 'reply'
        END
      )
      OR (
        event_type = 'content.published'
        AND (
          payload -> 'parent_content_id' <> 'null'::jsonb
          OR payload ->> 'root_content_id' IS DISTINCT FROM aggregate_id
        )
      )
      OR (
        event_type = 'content.reply'
        AND (
          jsonb_typeof(payload -> 'parent_content_id') <> 'string'
          OR payload ->> 'parent_content_id' !~ uuid_pattern
        )
      ) THEN
      RETURN false;
    END IF;
  ELSIF event_type = 'content.revised' THEN
    IF jsonb_typeof(payload -> 'resource_version') <> 'number'
      OR (payload ->> 'resource_version') !~ '^[2-9][0-9]*$|^1[0-9]+$'
      OR (
        payload -> 'revision_id' <> 'null'::jsonb
        AND (
          jsonb_typeof(payload -> 'revision_id') <> 'string'
          OR payload ->> 'revision_id' !~ uuid_pattern
        )
      )
      OR jsonb_typeof(payload -> 'changed_groups') <> 'array'
      OR jsonb_array_length(payload -> 'changed_groups') = 0 THEN
      RETURN false;
    END IF;

    FOR changed_group IN
      SELECT item.value #>> '{}'
      FROM jsonb_array_elements(payload -> 'changed_groups') AS item(value)
    LOOP
      IF changed_group IS NULL
        OR jsonb_typeof(to_jsonb(changed_group)) <> 'string' THEN
        RETURN false;
      END IF;
      changed_group_position := array_position(allowed_changed_groups, changed_group);
      IF changed_group_position IS NULL
        OR changed_group_position <= last_changed_group_position THEN
        RETURN false;
      END IF;
      last_changed_group_position := changed_group_position;
    END LOOP;
  ELSE
    IF jsonb_typeof(payload -> 'current_revision_id') <> 'string'
      OR payload ->> 'current_revision_id' !~ uuid_pattern
      OR jsonb_typeof(payload -> 'kind') <> 'string'
      OR payload ->> 'kind' NOT IN ('post', 'reply')
      OR payload ->> 'lifecycle_state' IS DISTINCT FROM 'deleted'
      OR jsonb_typeof(payload -> 'resource_version') <> 'number'
      OR (payload ->> 'resource_version') !~ '^[2-9][0-9]*$|^1[0-9]+$' THEN
      RETURN false;
    END IF;
  END IF;

  IF event_type IN ('content.published', 'content.reply', 'content.revised') THEN
    array_names := CASE
      WHEN event_type = 'content.revised' THEN ARRAY[
        'affected_symbol_ids',
        'affected_topic_ids',
        'community_ids',
        'symbol_ids',
        'topic_ids'
      ]
      ELSE ARRAY['community_ids', 'symbol_ids', 'topic_ids']
    END;

    FOREACH array_name IN ARRAY array_names
    LOOP
      array_value := payload -> array_name;
      array_limit := CASE array_name
        -- A reply may contribute ten/five classifications in addition to the
        -- root's ten/five. During revision, affected sets also retain the
        -- reply's prior classifications, so the closed production maxima are
        -- thirty/fifteen rather than the per-command input maxima.
        WHEN 'affected_symbol_ids' THEN 30
        WHEN 'affected_topic_ids' THEN 15
        WHEN 'community_ids' THEN 5
        WHEN 'symbol_ids' THEN 20
        WHEN 'topic_ids' THEN 10
      END;
      IF jsonb_typeof(array_value) <> 'array'
        OR jsonb_array_length(array_value) > array_limit
        OR (
          array_name = 'community_ids'
          AND jsonb_array_length(array_value) = 0
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(array_value) AS item(value)
          WHERE jsonb_typeof(item.value) <> 'string'
            OR item.value #>> '{}' !~ uuid_pattern
        )
        OR (
          SELECT count(*) <> count(DISTINCT item.value #>> '{}')
          FROM jsonb_array_elements(array_value) AS item(value)
        ) THEN
        RETURN false;
      END IF;

      -- Community order is primary first and then placement order. All other
      -- UUID arrays are emitted in lexical order by the production writer.
      IF array_name <> 'community_ids'
        AND array_value IS DISTINCT FROM (
          SELECT coalesce(
            jsonb_agg(item.value ORDER BY item.value #>> '{}'),
            '[]'::jsonb
          )
          FROM jsonb_array_elements(array_value) AS item(value)
        ) THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;

  RETURN true;
EXCEPTION
  WHEN others THEN
    RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION system.content_v1_outbox_payload_is_valid(
  text,
  text,
  text,
  integer,
  jsonb
) FROM PUBLIC;

ALTER TABLE system.outbox_events
  ADD CONSTRAINT outbox_events_content_v1_payload_shape
  CHECK (
    system.content_v1_outbox_payload_is_valid(
      aggregate_type,
      aggregate_id,
      event_type,
      event_version,
      payload
    )
  ) NOT VALID;

ALTER TABLE system.outbox_events
  VALIDATE CONSTRAINT outbox_events_content_v1_payload_shape;

-- The existing seven content-side deferred triggers prove that every runtime
-- mutation has a matching event. This reverse trigger rejects a syntactically
-- valid content event that has no same-transaction final ContentItem, audit,
-- and idempotency bundle.
CREATE FUNCTION platform.validate_runtime_content_outbox_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  event_xid xid;
  privileged_writer boolean;
  provenance_exists boolean;
BEGIN
  SELECT role.rolsuper OR relation.relowner = role.oid
  INTO privileged_writer
  FROM pg_roles AS role
  CROSS JOIN pg_class AS relation
  JOIN pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE role.rolname = current_user
    AND namespace.nspname = 'system'
    AND relation.relname = 'outbox_events'
    AND relation.relkind IN ('p', 'r');

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Content Outbox validator cannot identify the effective writer'
      USING ERRCODE = '42501';
  END IF;

  IF privileged_writer THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_SCHEMA <> 'system'
    OR TG_TABLE_NAME <> 'outbox_events'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Content Outbox validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.event_type NOT IN (
    'content.published',
    'content.reply',
    'content.revised',
    'content.deleted'
  ) THEN
    RETURN NULL;
  END IF;

  IF NEW.aggregate_type <> 'content'
    OR NEW.event_version <> 1
    OR NEW.available_at IS DISTINCT FROM NEW.occurred_at
    OR NEW.created_at IS DISTINCT FROM NEW.occurred_at
    OR NEW.max_attempts <> 12
    OR NOT system.content_v1_outbox_payload_is_valid(
      NEW.aggregate_type,
      NEW.aggregate_id,
      NEW.event_type,
      NEW.event_version,
      NEW.payload
    ) THEN
    RAISE EXCEPTION
      'Protected content Outbox event is not canonical'
      USING ERRCODE = '23514';
  END IF;

  SELECT event.xmin
  INTO event_xid
  FROM system.outbox_events AS event
  WHERE event.id = NEW.id;

  SELECT EXISTS (
    SELECT 1
    FROM platform.content_items AS content
    JOIN platform.content_revisions AS revision
      ON revision.id = content.current_revision_id
     AND revision.content_id = content.id
    JOIN platform.action_logs AS log
      ON log.outbox_event_id = NEW.id
    JOIN platform.idempotency_records AS idempotency
      ON idempotency.id = CASE
        WHEN log.after_state ->> 'idempotency_record_id' ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (log.after_state ->> 'idempotency_record_id')::uuid
        ELSE NULL
      END
    JOIN system.outbox_aggregate_heads AS aggregate_head
      ON aggregate_head.aggregate_type = NEW.aggregate_type
     AND aggregate_head.aggregate_id = NEW.aggregate_id
     AND aggregate_head.last_sequence = NEW.aggregate_sequence
    WHERE content.id::text = NEW.aggregate_id
      AND content.xmin = event_xid
      AND log.xmin = event_xid
      AND idempotency.xmin = event_xid
      AND log.event_class = 'domain_write'
      AND log.actor_id = content.author_actor_id
      AND log.target_type = 'content'
      AND log.target_id = content.id::text
      AND log.outcome = 'succeeded'
      AND log.after_state ->> 'content_id' = content.id::text
      AND log.after_state ->> 'resource_version' = content.version::text
      AND idempotency.owner_id = log.owner_id
      AND idempotency.agent_id IS NOT DISTINCT FROM log.agent_id
      AND idempotency.credential_id IS NOT DISTINCT FROM log.credential_id
      AND idempotency.actor_id = content.author_actor_id
      AND idempotency.status = 'succeeded'
      AND idempotency.resource_id = content.id
      AND idempotency.terminal_at IS NOT NULL
      AND (
        NEW.event_type = 'content.deleted'
        OR (
          ARRAY(
            SELECT item.value
            FROM jsonb_array_elements_text(
              NEW.payload -> 'community_ids'
            ) AS item(value)
            ORDER BY item.value
          ) = ARRAY(
            SELECT DISTINCT placement.community_id::text
            FROM (
              SELECT root.primary_community_id AS community_id
              FROM platform.content_items AS root
              WHERE root.id = content.root_id
              UNION
              SELECT additional.community_id
              FROM platform.content_additional_communities AS additional
              WHERE additional.content_id = content.root_id
            ) AS placement
            WHERE placement.community_id IS NOT NULL
            ORDER BY placement.community_id::text
          )
          AND ARRAY(
            SELECT item.value
            FROM jsonb_array_elements_text(
              NEW.payload -> 'symbol_ids'
            ) AS item(value)
            ORDER BY item.value
          ) = ARRAY(
            SELECT DISTINCT classification.symbol_id::text
            FROM platform.content_symbols AS classification
            WHERE classification.content_id IN (content.id, content.root_id)
            ORDER BY classification.symbol_id::text
          )
          AND ARRAY(
            SELECT item.value
            FROM jsonb_array_elements_text(
              NEW.payload -> 'topic_ids'
            ) AS item(value)
            ORDER BY item.value
          ) = ARRAY(
            SELECT DISTINCT classification.topic_id::text
            FROM platform.content_topics AS classification
            WHERE classification.content_id IN (content.id, content.root_id)
            ORDER BY classification.topic_id::text
          )
        )
      )
      AND (
        SELECT count(*) = 1
        FROM system.outbox_events AS peer
        WHERE peer.xmin = event_xid
          AND peer.aggregate_type = 'content'
          AND peer.aggregate_id = content.id::text
          AND peer.event_type IN (
            'content.published',
            'content.reply',
            'content.revised',
            'content.deleted'
          )
      )
      AND (
        (
          NEW.event_type IN ('content.published', 'content.reply')
          AND content.version = 1
          AND content.lifecycle_state = 'published'
          AND revision.source_version = 1
          AND NEW.payload ->> 'actor_id' = content.author_actor_id::text
          AND NEW.payload ->> 'kind' = content.kind
          AND NEW.payload ->> 'revision_id' = content.current_revision_id::text
          AND NEW.payload ->> 'root_content_id' = content.root_id::text
          AND NEW.payload ->> 'parent_content_id' IS NOT DISTINCT FROM
            content.parent_id::text
          AND log.action = CASE NEW.event_type
            WHEN 'content.published' THEN 'content.create_post'
            ELSE 'content.reply_to_content'
          END
          AND idempotency.operation = CASE NEW.event_type
            WHEN 'content.published' THEN 'create_post'
            ELSE 'reply_to_content'
          END
          AND idempotency.response_code = 201
        )
        OR (
          NEW.event_type = 'content.revised'
          AND content.lifecycle_state = 'published'
          AND NEW.payload ->> 'actor_id' = content.author_actor_id::text
          AND NEW.payload ->> 'resource_version' = content.version::text
          AND NEW.payload ->> 'root_content_id' = content.root_id::text
          AND (
            (
              revision.source_version = content.version
              AND NEW.payload ->> 'revision_id' = content.current_revision_id::text
            )
            OR (
              revision.source_version < content.version
              AND NEW.payload -> 'revision_id' = 'null'::jsonb
            )
          )
          AND log.action = 'content.update_content'
          AND idempotency.operation = 'update_content'
          AND idempotency.response_code = 200
          AND NOT EXISTS (
            SELECT classification.symbol_id::text
            FROM platform.content_symbols AS classification
            WHERE classification.content_id IN (content.id, content.root_id)
            EXCEPT
            SELECT item.value
            FROM jsonb_array_elements_text(
              NEW.payload -> 'affected_symbol_ids'
            ) AS item(value)
          )
          AND NOT EXISTS (
            SELECT classification.topic_id::text
            FROM platform.content_topics AS classification
            WHERE classification.content_id IN (content.id, content.root_id)
            EXCEPT
            SELECT item.value
            FROM jsonb_array_elements_text(
              NEW.payload -> 'affected_topic_ids'
            ) AS item(value)
          )
        )
        OR (
          NEW.event_type = 'content.deleted'
          AND content.lifecycle_state = 'deleted'
          AND NEW.payload ->> 'actor_id' = content.author_actor_id::text
          AND NEW.payload ->> 'kind' = content.kind
          AND NEW.payload ->> 'resource_version' = content.version::text
          AND NEW.payload ->> 'current_revision_id' =
            content.current_revision_id::text
          AND NEW.payload ->> 'root_content_id' = content.root_id::text
          AND log.action = 'content.delete_content'
          AND idempotency.operation = 'delete_content'
          AND idempotency.response_code = 200
        )
      )
  ) INTO provenance_exists;

  IF NOT provenance_exists THEN
    RAISE EXCEPTION
      'Protected content Outbox event requires matching final-state provenance in the same transaction'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION platform.validate_runtime_content_outbox_provenance()
  FROM PUBLIC;

CREATE CONSTRAINT TRIGGER outbox_events_validate_runtime_content_provenance
AFTER INSERT ON system.outbox_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_runtime_content_outbox_provenance();
