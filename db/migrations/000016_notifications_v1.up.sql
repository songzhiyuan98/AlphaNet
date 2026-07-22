SET LOCAL search_path = pg_catalog;

-- Notifications v1 --------------------------------------------------------
--
-- Notifications are recipient-scoped projections of durable domain events.
-- They contain only stable identifiers, controlled enum values, symbols and
-- bounded platform handles; source Content UGC is deliberately never copied
-- into this projection. Runtime projection writes use the SECURITY DEFINER
-- entry points at the end of this migration instead of raw table privileges.

CREATE FUNCTION platform.notification_context_is_valid(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  candidate_key text;
  matched_follow jsonb;
BEGIN
  IF candidate IS NULL
    OR jsonb_typeof(candidate) <> 'object'
    OR pg_column_size(candidate) > 8192 THEN
    RETURN false;
  END IF;

  FOR candidate_key IN SELECT jsonb_object_keys(candidate)
  LOOP
    IF candidate_key NOT IN (
      'symbols',
      'community_ids',
      'matched_follow',
      'additional_matched_follow_ids',
      'root_content_id',
      'parent_content_id',
      'revision_id',
      'reaction_type',
      'reaction_window_started_at',
      'reaction_window_ends_at',
      'recent_trigger_handles'
    ) THEN
      RETURN false;
    END IF;
  END LOOP;

  IF candidate ? 'symbols' THEN
    -- Reply notifications can carry the union of root and reply symbols. This
    -- projection capacity is intentionally independent of the API filter cap.
    IF jsonb_typeof(candidate -> 'symbols') <> 'array'
      OR jsonb_array_length(candidate -> 'symbols') > 20
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(candidate -> 'symbols') AS item(value)
        WHERE jsonb_typeof(item.value) <> 'string'
          OR item.value #>> '{}' !~ '^[A-Z0-9][A-Z0-9.-]{0,14}$'
      )
      OR (
        SELECT count(*) <> count(DISTINCT item.value)
        FROM jsonb_array_elements_text(candidate -> 'symbols') AS item(value)
      ) THEN
      RETURN false;
    END IF;
  END IF;

  IF candidate ? 'community_ids' THEN
    IF jsonb_typeof(candidate -> 'community_ids') <> 'array'
      OR jsonb_array_length(candidate -> 'community_ids') > 5
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(candidate -> 'community_ids') AS item(value)
        WHERE jsonb_typeof(item.value) <> 'string'
          OR item.value #>> '{}' !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
      OR (
        SELECT count(*) <> count(DISTINCT item.value)
        FROM jsonb_array_elements_text(candidate -> 'community_ids') AS item(value)
      ) THEN
      RETURN false;
    END IF;
  END IF;

  IF candidate ? 'matched_follow' THEN
    matched_follow := candidate -> 'matched_follow';
    IF jsonb_typeof(matched_follow) <> 'object'
      OR (
        SELECT count(*) <> 3
        FROM jsonb_object_keys(matched_follow)
      )
      OR NOT (
        matched_follow ? 'target_type'
        AND matched_follow ? 'target_id'
        AND matched_follow ? 'notification_level'
      )
      OR matched_follow ->> 'target_type' NOT IN (
        'actor', 'symbol', 'topic', 'content'
      )
      OR matched_follow ->> 'target_id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      OR matched_follow ->> 'notification_level' NOT IN (
        'new_posts', 'all_events'
      ) THEN
      RETURN false;
    END IF;
  END IF;

  IF candidate ? 'additional_matched_follow_ids' THEN
    -- A single recipient can legitimately match actor, content, topic and
    -- symbol rules at once. Reject overflow instead of truncating.
    IF NOT candidate ? 'matched_follow'
      OR jsonb_typeof(candidate -> 'additional_matched_follow_ids') <> 'array'
      OR jsonb_array_length(candidate -> 'additional_matched_follow_ids') > 40
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          candidate -> 'additional_matched_follow_ids'
        ) AS item(value)
        WHERE jsonb_typeof(item.value) <> 'string'
          OR item.value #>> '{}' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      )
      OR (
        SELECT count(*) <> count(DISTINCT item.value)
        FROM jsonb_array_elements_text(
          candidate -> 'additional_matched_follow_ids'
        ) AS item(value)
      ) THEN
      RETURN false;
    END IF;
  END IF;

  FOREACH candidate_key IN ARRAY ARRAY[
    'root_content_id',
    'parent_content_id',
    'revision_id'
  ]
  LOOP
    IF candidate ? candidate_key
      AND jsonb_typeof(candidate -> candidate_key) <> 'null' THEN
      IF jsonb_typeof(candidate -> candidate_key) <> 'string'
        OR candidate ->> candidate_key !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;

  IF candidate ? 'reaction_type'
    AND (
      jsonb_typeof(candidate -> 'reaction_type') <> 'string'
      OR candidate ->> 'reaction_type' NOT IN ('helpful', 'agree', 'disagree')
    ) THEN
    RETURN false;
  END IF;

  FOREACH candidate_key IN ARRAY ARRAY[
    'reaction_window_started_at',
    'reaction_window_ends_at'
  ]
  LOOP
    IF candidate ? candidate_key
      AND (
        jsonb_typeof(candidate -> candidate_key) <> 'string'
        OR candidate ->> candidate_key !~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
      ) THEN
      RETURN false;
    END IF;
  END LOOP;

  IF (
    (candidate ? 'reaction_type')
    OR (candidate ? 'reaction_window_started_at')
    OR (candidate ? 'reaction_window_ends_at')
  ) AND NOT (
    (candidate ? 'reaction_type')
    AND (candidate ? 'reaction_window_started_at')
    AND (candidate ? 'reaction_window_ends_at')
  ) THEN
    RETURN false;
  END IF;

  IF candidate ? 'recent_trigger_handles' THEN
    IF jsonb_typeof(candidate -> 'recent_trigger_handles') <> 'array'
      OR jsonb_array_length(candidate -> 'recent_trigger_handles') > 3
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          candidate -> 'recent_trigger_handles'
        ) AS item(value)
        WHERE jsonb_typeof(item.value) <> 'string'
          OR item.value #>> '{}' !~ '^[a-z0-9][a-z0-9_.-]{2,31}$'
      )
      OR (
        SELECT count(*) <> count(DISTINCT item.value)
        FROM jsonb_array_elements_text(
          candidate -> 'recent_trigger_handles'
        ) AS item(value)
      ) THEN
      RETURN false;
    END IF;
  END IF;

  -- Every string-bearing field above is either a UUID, canonical symbol,
  -- platform handle, fixed enum, bounded operation key or RFC3339 timestamp.
  -- No unclassified string can enter this projection as raw UGC.
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION platform.notification_context_is_valid(jsonb)
FROM PUBLIC;

CREATE FUNCTION platform.notification_symbol_ids_are_valid(candidate text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT candidate IS NOT NULL
    -- Root + reply classification unions can contain up to 20 symbols.
    AND cardinality(candidate) <= 20
    AND array_position(candidate, NULL) IS NULL
    AND platform.text_array_has_unique_values(candidate)
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(candidate) AS symbol(value)
      WHERE symbol.value !~ '^[A-Z0-9][A-Z0-9.-]{0,14}$'
    );
$$;

REVOKE ALL ON FUNCTION platform.notification_symbol_ids_are_valid(text[])
FROM PUBLIC;

CREATE FUNCTION platform.notification_community_ids_are_valid(candidate uuid[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT candidate IS NOT NULL
    AND cardinality(candidate) <= 5
    AND array_position(candidate, NULL) IS NULL
    AND cardinality(candidate) = (
      SELECT count(DISTINCT community_id)
      FROM unnest(candidate) AS community(community_id)
    );
$$;

REVOKE ALL ON FUNCTION platform.notification_community_ids_are_valid(uuid[])
FROM PUBLIC;

CREATE TABLE system.notification_recipient_sequences (
  recipient_actor_id uuid PRIMARY KEY
    REFERENCES platform.actors(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  last_created_sequence bigint NOT NULL DEFAULT 0,
  last_change_sequence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL
    DEFAULT date_trunc('milliseconds', statement_timestamp()),
  updated_at timestamptz NOT NULL
    DEFAULT date_trunc('milliseconds', statement_timestamp()),
  CONSTRAINT notification_recipient_sequences_nonnegative
    CHECK (last_created_sequence >= 0 AND last_change_sequence >= 0),
  CONSTRAINT notification_recipient_sequences_order
    CHECK (last_change_sequence >= last_created_sequence),
  CONSTRAINT notification_recipient_sequences_time_order
    CHECK (updated_at >= created_at)
);

COMMENT ON TABLE system.notification_recipient_sequences IS
  'Database-owned per-recipient sequence heads. Missing rows have an implicit zero high-water mark.';

CREATE TABLE platform.notifications (
  id uuid PRIMARY KEY,
  version bigint NOT NULL DEFAULT 1,
  created_sequence bigint NOT NULL,
  change_sequence bigint NOT NULL,
  recipient_actor_id uuid NOT NULL
    REFERENCES platform.actors(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  type text NOT NULL,
  trigger_actor_id uuid
    REFERENCES platform.actors(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  object_type text NOT NULL,
  object_id uuid NOT NULL,
  symbol_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  community_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  matched_follow_target_type text,
  matched_follow_target_id text,
  matched_follow_notification_level text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary_template_key text NOT NULL,
  occurred_at timestamptz NOT NULL,
  last_occurred_at timestamptz,
  aggregate_distinct_actor_count bigint,
  aggregate_agent_count bigint,
  aggregate_human_count bigint,
  dedupe_key text NOT NULL,
  schema_version text NOT NULL DEFAULT 'notification-v1',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  read_at timestamptz,
  CONSTRAINT notifications_recipient_dedupe_unique
    UNIQUE (recipient_actor_id, dedupe_key),
  CONSTRAINT notifications_recipient_created_sequence_unique
    UNIQUE (recipient_actor_id, created_sequence),
  CONSTRAINT notifications_recipient_change_sequence_unique
    UNIQUE (recipient_actor_id, change_sequence),
  CONSTRAINT notifications_id_recipient_unique
    UNIQUE (id, recipient_actor_id),
  CONSTRAINT notifications_version_positive CHECK (version > 0),
  CONSTRAINT notifications_sequences_positive
    CHECK (created_sequence > 0 AND change_sequence >= created_sequence),
  CONSTRAINT notifications_type
    CHECK (
      type IN (
        'content.published',
        'content.reply',
        'content.mention',
        'reaction.changed',
        'follow.started',
        'content.revised',
        'moderation.changed',
        'action.pending_approval',
        'action.resolved'
      )
    ),
  CONSTRAINT notifications_object_type
    CHECK (object_type IN ('content', 'actor', 'community', 'pending_action')),
  CONSTRAINT notifications_type_object_shape
    CHECK (
      (type IN (
        'content.published',
        'content.reply',
        'content.mention',
        'reaction.changed',
        'content.revised'
      ) AND object_type = 'content')
      OR (type = 'follow.started' AND object_type = 'actor')
      OR (
        type = 'moderation.changed'
        AND object_type IN ('content', 'community')
      )
      OR (
        type IN ('action.pending_approval', 'action.resolved')
        AND object_type = 'pending_action'
      )
    ),
  CONSTRAINT notifications_symbols
    CHECK (platform.notification_symbol_ids_are_valid(symbol_ids)),
  CONSTRAINT notifications_communities
    CHECK (platform.notification_community_ids_are_valid(community_ids)),
  CONSTRAINT notifications_matched_follow_shape
    CHECK (
      (
        matched_follow_target_type IS NULL
        AND matched_follow_target_id IS NULL
        AND matched_follow_notification_level IS NULL
      )
      OR (
        matched_follow_target_type IS NOT NULL
        AND matched_follow_target_id IS NOT NULL
        AND matched_follow_notification_level IS NOT NULL
        AND matched_follow_target_type IN ('actor', 'symbol', 'topic', 'content')
        AND matched_follow_target_id ~
          '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND matched_follow_notification_level IN ('new_posts', 'all_events')
      )
    ),
  CONSTRAINT notifications_context_valid
    CHECK (platform.notification_context_is_valid(context)),
  CONSTRAINT notifications_context_symbols_match
    CHECK (
      CASE
        WHEN cardinality(symbol_ids) = 0
          THEN NOT context ? 'symbols' OR context -> 'symbols' = '[]'::jsonb
        ELSE context -> 'symbols' = to_jsonb(symbol_ids)
      END
    ),
  CONSTRAINT notifications_context_communities_match
    CHECK (
      CASE
        WHEN cardinality(community_ids) = 0
          THEN NOT context ? 'community_ids'
            OR context -> 'community_ids' = '[]'::jsonb
        ELSE context -> 'community_ids' = to_jsonb(community_ids)
      END
    ),
  CONSTRAINT notifications_context_matched_follow_matches
    CHECK (
      CASE
        WHEN matched_follow_target_type IS NULL
          THEN NOT context ? 'matched_follow'
        ELSE
          context -> 'matched_follow' = jsonb_build_object(
            'target_type', matched_follow_target_type,
            'target_id', matched_follow_target_id,
            'notification_level', matched_follow_notification_level
          )
      END
    ),
  CONSTRAINT notifications_aggregate_shape
    CHECK (
      (
        type = 'reaction.changed'
        AND trigger_actor_id IS NULL
        AND last_occurred_at IS NOT NULL
        AND aggregate_distinct_actor_count IS NOT NULL
        AND aggregate_agent_count IS NOT NULL
        AND aggregate_human_count IS NOT NULL
        AND aggregate_distinct_actor_count >= 0
        AND aggregate_agent_count >= 0
        AND aggregate_human_count >= 0
        AND aggregate_agent_count + aggregate_human_count =
          aggregate_distinct_actor_count
        AND context ? 'reaction_type'
        AND (context ->> 'reaction_window_started_at')::timestamptz
          + interval '10 minutes' =
          (context ->> 'reaction_window_ends_at')::timestamptz
        AND occurred_at >=
          (context ->> 'reaction_window_started_at')::timestamptz
        AND occurred_at <
          (context ->> 'reaction_window_ends_at')::timestamptz
      )
      OR (
        type <> 'reaction.changed'
        AND last_occurred_at IS NULL
        AND aggregate_distinct_actor_count IS NULL
        AND aggregate_agent_count IS NULL
        AND aggregate_human_count IS NULL
        AND NOT context ? 'reaction_type'
        AND NOT context ? 'recent_trigger_handles'
      )
    ),
  CONSTRAINT notifications_summary_template
    CHECK (
      summary_template_key = CASE type
        WHEN 'content.published' THEN 'notification.content_published'
        WHEN 'content.reply' THEN 'notification.content_reply'
        WHEN 'content.mention' THEN 'notification.content_mention'
        WHEN 'reaction.changed' THEN 'notification.reaction_changed'
        WHEN 'follow.started' THEN 'notification.follow_started'
        WHEN 'content.revised' THEN 'notification.content_revised'
        WHEN 'moderation.changed' THEN 'notification.moderation_changed'
        WHEN 'action.pending_approval' THEN
          'notification.action_pending_approval'
        WHEN 'action.resolved' THEN 'notification.action_resolved'
      END
    ),
  CONSTRAINT notifications_dedupe_key
    CHECK (
      length(dedupe_key) BETWEEN 1 AND 1000
      AND dedupe_key = btrim(dedupe_key)
      AND dedupe_key !~ '[[:cntrl:]]'
    ),
  CONSTRAINT notifications_schema_version
    CHECK (schema_version = 'notification-v1'),
  CONSTRAINT notifications_time_order
    CHECK (
      updated_at >= created_at
      AND (read_at IS NULL OR read_at >= created_at)
      AND (
        last_occurred_at IS NULL
        OR last_occurred_at >= occurred_at
      )
    )
);

CREATE INDEX notifications_recipient_history_idx
  ON platform.notifications (recipient_actor_id, created_at DESC, id DESC);

CREATE INDEX notifications_recipient_unread_history_idx
  ON platform.notifications (recipient_actor_id, created_at DESC, id DESC)
  WHERE read_at IS NULL;

CREATE INDEX notifications_recipient_type_history_idx
  ON platform.notifications (
    recipient_actor_id,
    type,
    created_at DESC,
    id DESC
  );

CREATE INDEX notifications_recipient_occurred_idx
  ON platform.notifications (recipient_actor_id, occurred_at DESC, id DESC);

CREATE INDEX notifications_retention_idx
  ON platform.notifications (created_at, id);

CREATE INDEX notifications_symbol_ids_idx
  ON platform.notifications USING gin (symbol_ids);

CREATE INDEX notifications_community_ids_idx
  ON platform.notifications USING gin (community_ids);

CREATE INDEX notifications_recipient_follow_history_idx
  ON platform.notifications (
    recipient_actor_id,
    matched_follow_target_type,
    created_at DESC,
    id DESC
  )
  WHERE matched_follow_target_type IS NOT NULL;

COMMENT ON TABLE platform.notifications IS
  'Current recipient-scoped notification projections. Rows are pointers to independently authorized resources and never copy raw UGC.';

COMMENT ON COLUMN platform.notifications.occurred_at IS
  'Immutable domain-event time. It is intentionally distinct from projection created_at.';

COMMENT ON COLUMN platform.notifications.context IS
  'Strict 8 KiB structured context: stable IDs, enums, symbols, time windows and bounded platform handles only.';

CREATE TABLE system.notification_change_journal (
  recipient_actor_id uuid NOT NULL,
  change_sequence bigint NOT NULL,
  notification_id uuid NOT NULL,
  notification_version bigint NOT NULL,
  recorded_at timestamptz NOT NULL
    DEFAULT date_trunc('milliseconds', statement_timestamp()),
  PRIMARY KEY (recipient_actor_id, change_sequence),
  CONSTRAINT notification_change_journal_notification_version_unique
    UNIQUE (notification_id, notification_version),
  CONSTRAINT notification_change_journal_notification
    FOREIGN KEY (notification_id, recipient_actor_id)
    REFERENCES platform.notifications(id, recipient_actor_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT notification_change_journal_sequence_positive
    CHECK (change_sequence > 0),
  CONSTRAINT notification_change_journal_version_positive
    CHECK (notification_version > 0)
);

CREATE INDEX notification_change_journal_notification_idx
  ON system.notification_change_journal (
    notification_id,
    notification_version DESC
  );

COMMENT ON TABLE system.notification_change_journal IS
  'Immutable per-recipient material projection changes for lossless incremental polling. Read-state-only changes are intentionally excluded.';

CREATE TABLE platform.notification_aggregate_actors (
  notification_id uuid NOT NULL
    REFERENCES platform.notifications(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  content_id uuid NOT NULL
    REFERENCES platform.content_items(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  reaction_type text NOT NULL,
  actor_id uuid NOT NULL
    REFERENCES platform.actors(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  actor_kind text NOT NULL,
  active boolean NOT NULL,
  first_positive_at timestamptz NOT NULL,
  latest_event_at timestamptz NOT NULL,
  latest_event_sequence bigint NOT NULL,
  PRIMARY KEY (notification_id, actor_id),
  CONSTRAINT notification_aggregate_actors_authoritative_member_unique
    UNIQUE (content_id, reaction_type, actor_id),
  CONSTRAINT notification_aggregate_actors_kind
    CHECK (actor_kind IN ('agent', 'human')),
  CONSTRAINT notification_aggregate_actors_reaction_type
    CHECK (reaction_type IN ('helpful', 'agree', 'disagree')),
  CONSTRAINT notification_aggregate_actors_event_sequence_positive
    CHECK (latest_event_sequence > 0)
);

CREATE INDEX notification_aggregate_actors_active_idx
  ON platform.notification_aggregate_actors (
    notification_id,
    latest_event_sequence DESC,
    actor_id
  )
  WHERE active;

COMMENT ON TABLE platform.notification_aggregate_actors IS
  'Authoritative Content/reaction/Actor membership across notification windows. Outbox aggregate sequence, never event wall-clock time, fences replay, revoke and restore ordering.';

-- Database-owned sequencing and journal ----------------------------------

CREATE FUNCTION system.allocate_notification_sequences(
  candidate_recipient_actor_id uuid,
  allocate_created_sequence boolean
)
RETURNS TABLE (created_sequence bigint, change_sequence bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF candidate_recipient_actor_id IS NULL
    OR allocate_created_sequence IS NULL THEN
    RAISE EXCEPTION
      'Notification sequence allocation requires a recipient and mode'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO system.notification_recipient_sequences AS sequence_head (
    recipient_actor_id,
    last_created_sequence,
    last_change_sequence
  )
  VALUES (
    candidate_recipient_actor_id,
    CASE WHEN allocate_created_sequence THEN 1 ELSE 0 END,
    1
  )
  ON CONFLICT (recipient_actor_id) DO UPDATE
    SET last_created_sequence =
          sequence_head.last_created_sequence
          + CASE WHEN allocate_created_sequence THEN 1 ELSE 0 END,
        last_change_sequence = sequence_head.last_change_sequence + 1,
        updated_at = date_trunc('milliseconds', statement_timestamp())
  RETURNING
    sequence_head.last_created_sequence,
    sequence_head.last_change_sequence
  INTO created_sequence, change_sequence;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION system.allocate_notification_sequences(uuid, boolean)
FROM PUBLIC;

CREATE FUNCTION platform.prepare_notification_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  allocated_created_sequence bigint;
  allocated_change_sequence bigint;
  material_changed boolean;
  read_state_changed boolean;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'notifications'
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION
      'Notification write trigger invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.created_sequence IS NOT NULL OR NEW.change_sequence IS NOT NULL THEN
      RAISE EXCEPTION
        'Notification sequence values are database-owned'
        USING ERRCODE = '22023';
    END IF;

    IF NEW.version <> 1
      OR NEW.schema_version <> 'notification-v1'
      OR NEW.read_at IS NOT NULL THEN
      RAISE EXCEPTION
        'A new notification must use initial version, schema, and unread state'
        USING ERRCODE = '22023';
    END IF;

    SELECT allocation.created_sequence, allocation.change_sequence
    INTO allocated_created_sequence, allocated_change_sequence
    FROM system.allocate_notification_sequences(
      NEW.recipient_actor_id,
      true
    ) AS allocation;

    NEW.created_sequence := allocated_created_sequence;
    NEW.change_sequence := allocated_change_sequence;
    NEW.created_at := date_trunc('milliseconds', statement_timestamp());
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.recipient_actor_id IS DISTINCT FROM OLD.recipient_actor_id
    OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.trigger_actor_id IS DISTINCT FROM OLD.trigger_actor_id
    OR NEW.object_type IS DISTINCT FROM OLD.object_type
    OR NEW.object_id IS DISTINCT FROM OLD.object_id
    OR NEW.symbol_ids IS DISTINCT FROM OLD.symbol_ids
    OR NEW.community_ids IS DISTINCT FROM OLD.community_ids
    OR NEW.matched_follow_target_type IS DISTINCT FROM
      OLD.matched_follow_target_type
    OR NEW.matched_follow_target_id IS DISTINCT FROM
      OLD.matched_follow_target_id
    OR NEW.matched_follow_notification_level IS DISTINCT FROM
      OLD.matched_follow_notification_level
    OR NEW.summary_template_key IS DISTINCT FROM OLD.summary_template_key
    OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
    OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
    OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
    OR NEW.created_sequence IS DISTINCT FROM OLD.created_sequence
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Notification identity and initial event facts are immutable'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.version IS DISTINCT FROM OLD.version
    OR NEW.change_sequence IS DISTINCT FROM OLD.change_sequence
    OR NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
    RAISE EXCEPTION
      'Notification version, change sequence, and update time are database-owned'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.type <> 'reaction.changed'
    AND (
      NEW.context IS DISTINCT FROM OLD.context
      OR NEW.last_occurred_at IS DISTINCT FROM OLD.last_occurred_at
      OR NEW.aggregate_distinct_actor_count IS DISTINCT FROM
        OLD.aggregate_distinct_actor_count
      OR NEW.aggregate_agent_count IS DISTINCT FROM OLD.aggregate_agent_count
      OR NEW.aggregate_human_count IS DISTINCT FROM OLD.aggregate_human_count
    ) THEN
    RAISE EXCEPTION
      'Only reaction aggregate material fields can change'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.last_occurred_at IS NOT NULL
    AND OLD.last_occurred_at IS NOT NULL
    AND NEW.last_occurred_at < OLD.last_occurred_at THEN
    RAISE EXCEPTION
      'Notification aggregate event time cannot move backwards'
      USING ERRCODE = '22023';
  END IF;

  material_changed :=
    NEW.context IS DISTINCT FROM OLD.context
    OR NEW.last_occurred_at IS DISTINCT FROM OLD.last_occurred_at
    OR NEW.aggregate_distinct_actor_count IS DISTINCT FROM
      OLD.aggregate_distinct_actor_count
    OR NEW.aggregate_agent_count IS DISTINCT FROM OLD.aggregate_agent_count
    OR NEW.aggregate_human_count IS DISTINCT FROM OLD.aggregate_human_count;
  read_state_changed := NEW.read_at IS DISTINCT FROM OLD.read_at;

  IF NOT material_changed AND NOT read_state_changed THEN
    RETURN OLD;
  END IF;

  NEW.updated_at := date_trunc('milliseconds', statement_timestamp());

  -- Read state is an Owner Web presentation preference. It deliberately does
  -- not create an Agent poll echo or advance the material projection version.
  IF NOT material_changed THEN
    RETURN NEW;
  END IF;

  SELECT allocation.change_sequence
  INTO allocated_change_sequence
  FROM system.allocate_notification_sequences(
    NEW.recipient_actor_id,
    false
  ) AS allocation;

  NEW.version := OLD.version + 1;
  NEW.change_sequence := allocated_change_sequence;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notifications_prepare_write
BEFORE INSERT OR UPDATE ON platform.notifications
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_notification_write();

REVOKE ALL ON FUNCTION platform.prepare_notification_write() FROM PUBLIC;

CREATE FUNCTION system.append_notification_change_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'notifications'
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION
      'Notification journal trigger invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' OR NEW.version IS DISTINCT FROM OLD.version THEN
    INSERT INTO system.notification_change_journal (
      recipient_actor_id,
      change_sequence,
      notification_id,
      notification_version
    )
    VALUES (
      NEW.recipient_actor_id,
      NEW.change_sequence,
      NEW.id,
      NEW.version
    );
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER notifications_append_change_journal
AFTER INSERT OR UPDATE ON platform.notifications
FOR EACH ROW
EXECUTE FUNCTION system.append_notification_change_journal();

REVOKE ALL ON FUNCTION system.append_notification_change_journal()
FROM PUBLIC;

CREATE FUNCTION system.prevent_notification_change_journal_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'system'
    OR TG_TABLE_NAME <> 'notification_change_journal'
    OR TG_OP NOT IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION
      'Notification change-journal guard invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  -- The fixed-window retention entry point is the only runtime-reachable path
  -- that may remove journal rows. Runtime has no raw DELETE privilege, and
  -- this transaction-local capability is never accepted for UPDATE.
  IF TG_OP = 'DELETE'
    AND current_setting(
      'alphanet.notification_retention_purge',
      true
    ) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'Notification change-journal rows are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER notification_change_journal_prevent_mutation
BEFORE UPDATE OR DELETE ON system.notification_change_journal
FOR EACH ROW
EXECUTE FUNCTION system.prevent_notification_change_journal_mutation();

REVOKE ALL ON FUNCTION system.prevent_notification_change_journal_mutation()
FROM PUBLIC;

-- Reaction aggregation integrity -----------------------------------------

CREATE FUNCTION platform.prepare_notification_aggregate_actor_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actual_actor_kind text;
  notification_content_id uuid;
  notification_reaction_type text;
  notification_type text;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'notification_aggregate_actors'
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION
      'Notification aggregate member trigger invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.notification_id IS DISTINCT FROM OLD.notification_id
    OR NEW.content_id IS DISTINCT FROM OLD.content_id
    OR NEW.reaction_type IS DISTINCT FROM OLD.reaction_type
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.actor_kind IS DISTINCT FROM OLD.actor_kind
    OR NEW.first_positive_at IS DISTINCT FROM OLD.first_positive_at
  ) THEN
    RAISE EXCEPTION
      'Notification aggregate member identity is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW.latest_event_sequence <= OLD.latest_event_sequence THEN
    RAISE EXCEPTION
      'Notification aggregate member source sequence must advance'
      USING ERRCODE = '22023';
  END IF;

  SELECT actor.kind
  INTO actual_actor_kind
  FROM platform.actors AS actor
  WHERE actor.id = NEW.actor_id
  FOR KEY SHARE;

  SELECT
    notification.type,
    notification.object_id,
    notification.context ->> 'reaction_type'
  INTO
    notification_type,
    notification_content_id,
    notification_reaction_type
  FROM platform.notifications AS notification
  WHERE notification.id = NEW.notification_id
  FOR KEY SHARE;

  IF actual_actor_kind IS NULL OR notification_type IS NULL THEN
    RAISE EXCEPTION
      'Notification aggregate Actor or notification does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.actor_kind <> actual_actor_kind
    OR notification_type <> 'reaction.changed'
    OR NEW.content_id <> notification_content_id
    OR NEW.reaction_type <> notification_reaction_type THEN
    RAISE EXCEPTION
      'Notification aggregate member kind or target is invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_aggregate_actors_prepare_write
BEFORE INSERT OR UPDATE ON platform.notification_aggregate_actors
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_notification_aggregate_actor_write();

REVOKE ALL ON FUNCTION platform.prepare_notification_aggregate_actor_write()
FROM PUBLIC;

CREATE FUNCTION platform.validate_notification_aggregate_counts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate_notification_id uuid;
  notification_type text;
  stored_total bigint;
  stored_agent bigint;
  stored_human bigint;
  actual_total bigint;
  actual_agent bigint;
  actual_human bigint;
BEGIN
  IF TG_TABLE_SCHEMA = 'platform'
    AND TG_TABLE_NAME = 'notifications' THEN
    candidate_notification_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSIF TG_TABLE_SCHEMA = 'platform'
    AND TG_TABLE_NAME = 'notification_aggregate_actors' THEN
    candidate_notification_id := CASE
      WHEN TG_OP = 'DELETE' THEN OLD.notification_id
      ELSE NEW.notification_id
    END;
  ELSE
    RAISE EXCEPTION
      'Notification aggregate validator invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    notification.type,
    notification.aggregate_distinct_actor_count,
    notification.aggregate_agent_count,
    notification.aggregate_human_count
  INTO
    notification_type,
    stored_total,
    stored_agent,
    stored_human
  FROM platform.notifications AS notification
  WHERE notification.id = candidate_notification_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT
    count(*) FILTER (WHERE member.active),
    count(*) FILTER (WHERE member.active AND member.actor_kind = 'agent'),
    count(*) FILTER (WHERE member.active AND member.actor_kind = 'human')
  INTO actual_total, actual_agent, actual_human
  FROM platform.notification_aggregate_actors AS member
  WHERE member.notification_id = candidate_notification_id;

  IF notification_type = 'reaction.changed' THEN
    IF stored_total IS DISTINCT FROM actual_total
      OR stored_agent IS DISTINCT FROM actual_agent
      OR stored_human IS DISTINCT FROM actual_human THEN
      RAISE EXCEPTION
        'Notification aggregate counts do not match active Actor members'
        USING ERRCODE = '23514',
              CONSTRAINT = 'notifications_aggregate_member_counts';
    END IF;
  ELSIF actual_total <> 0 THEN
    RAISE EXCEPTION
      'Only reaction notifications can own aggregate Actor members'
      USING ERRCODE = '23514',
            CONSTRAINT = 'notifications_aggregate_member_counts';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER notifications_validate_aggregate_counts
AFTER INSERT OR UPDATE ON platform.notifications
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_notification_aggregate_counts();

CREATE CONSTRAINT TRIGGER notification_aggregate_actors_validate_counts
AFTER INSERT OR UPDATE OR DELETE ON platform.notification_aggregate_actors
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_notification_aggregate_counts();

REVOKE ALL ON FUNCTION platform.validate_notification_aggregate_counts()
FROM PUBLIC;

-- Narrow runtime projection entry points ---------------------------------

CREATE FUNCTION system.project_notification(
  candidate_notification_id uuid,
  candidate_recipient_actor_id uuid,
  candidate_type text,
  candidate_trigger_actor_id uuid,
  candidate_object_type text,
  candidate_object_id uuid,
  candidate_symbol_ids text[],
  candidate_community_ids uuid[],
  candidate_matched_follow_target_type text,
  candidate_matched_follow_target_id text,
  candidate_matched_follow_notification_level text,
  candidate_context jsonb,
  candidate_summary_template_key text,
  candidate_occurred_at timestamptz,
  candidate_dedupe_key text
)
RETURNS platform.notifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  projected_notification platform.notifications%ROWTYPE;
  existing_projection boolean := false;
  normalized_symbol_ids text[] := coalesce(
    candidate_symbol_ids,
    ARRAY[]::text[]
  );
  normalized_community_ids uuid[] := coalesce(
    candidate_community_ids,
    ARRAY[]::uuid[]
  );
  normalized_context jsonb := coalesce(candidate_context, '{}'::jsonb);
BEGIN
  IF candidate_notification_id IS NULL
    OR candidate_recipient_actor_id IS NULL
    OR candidate_type IS NULL
    OR candidate_object_type IS NULL
    OR candidate_object_id IS NULL
    OR candidate_summary_template_key IS NULL
    OR candidate_occurred_at IS NULL
    OR candidate_dedupe_key IS NULL THEN
    RAISE EXCEPTION
      'Notification projection requires complete event identity'
      USING ERRCODE = '22023';
  END IF;

  IF candidate_type = 'reaction.changed' THEN
    RAISE EXCEPTION
      'Reaction notifications require the aggregate projection entry point'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(normalized_context) <> 'object' THEN
    RAISE EXCEPTION
      'Notification context must be a structured object'
      USING ERRCODE = '22023';
  END IF;

  normalized_context := normalized_context - 'symbols' - 'community_ids';
  IF cardinality(normalized_symbol_ids) > 0 THEN
    normalized_context := normalized_context
      || jsonb_build_object('symbols', normalized_symbol_ids);
  END IF;
  IF cardinality(normalized_community_ids) > 0 THEN
    normalized_context := normalized_context
      || jsonb_build_object('community_ids', normalized_community_ids);
  END IF;

  IF candidate_matched_follow_target_type IS NULL
    AND candidate_matched_follow_target_id IS NULL
    AND candidate_matched_follow_notification_level IS NULL THEN
    normalized_context := normalized_context - 'matched_follow';
  ELSE
    normalized_context := normalized_context || jsonb_build_object(
      'matched_follow',
      jsonb_build_object(
        'target_type', candidate_matched_follow_target_type,
        'target_id', candidate_matched_follow_target_id,
        'notification_level', candidate_matched_follow_notification_level
      )
    );
  END IF;

  -- Serialize one idempotency identity before the BEFORE INSERT sequence
  -- trigger runs. A duplicate delivery must not consume a recipient sequence
  -- merely because PostgreSQL evaluated an INSERT before ON CONFLICT.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'alphanet:notification-dedupe:'
        || candidate_recipient_actor_id::text
        || ':'
        || octet_length(candidate_dedupe_key)::text
        || ':'
        || candidate_dedupe_key,
      0
    )
  );

  SELECT notification.*
  INTO projected_notification
  FROM platform.notifications AS notification
  WHERE notification.recipient_actor_id = candidate_recipient_actor_id
    AND notification.dedupe_key = candidate_dedupe_key
  FOR UPDATE;
  existing_projection := FOUND;

  IF NOT existing_projection THEN
    INSERT INTO platform.notifications (
    id,
    recipient_actor_id,
    type,
    trigger_actor_id,
    object_type,
    object_id,
    symbol_ids,
    community_ids,
    matched_follow_target_type,
    matched_follow_target_id,
    matched_follow_notification_level,
    context,
    summary_template_key,
    occurred_at,
    dedupe_key
    )
    VALUES (
    candidate_notification_id,
    candidate_recipient_actor_id,
    candidate_type,
    candidate_trigger_actor_id,
    candidate_object_type,
    candidate_object_id,
    normalized_symbol_ids,
    normalized_community_ids,
    candidate_matched_follow_target_type,
    candidate_matched_follow_target_id,
    candidate_matched_follow_notification_level,
    normalized_context,
    candidate_summary_template_key,
    candidate_occurred_at,
    candidate_dedupe_key
    )
    RETURNING * INTO projected_notification;
  ELSE
    IF projected_notification.type IS DISTINCT FROM candidate_type
      OR projected_notification.trigger_actor_id IS DISTINCT FROM
        candidate_trigger_actor_id
      OR projected_notification.object_type IS DISTINCT FROM candidate_object_type
      OR projected_notification.object_id IS DISTINCT FROM candidate_object_id
      OR projected_notification.symbol_ids IS DISTINCT FROM normalized_symbol_ids
      OR projected_notification.community_ids IS DISTINCT FROM
        normalized_community_ids
      OR projected_notification.matched_follow_target_type IS DISTINCT FROM
        candidate_matched_follow_target_type
      OR projected_notification.matched_follow_target_id IS DISTINCT FROM
        candidate_matched_follow_target_id
      OR projected_notification.matched_follow_notification_level IS DISTINCT FROM
        candidate_matched_follow_notification_level
      OR projected_notification.context IS DISTINCT FROM normalized_context
      OR projected_notification.summary_template_key IS DISTINCT FROM
        candidate_summary_template_key
      OR projected_notification.occurred_at IS DISTINCT FROM candidate_occurred_at
      OR projected_notification.schema_version <> 'notification-v1' THEN
      RAISE EXCEPTION
        'Notification dedupe key was reused for a different projection'
        USING ERRCODE = '23505',
              CONSTRAINT = 'notifications_recipient_dedupe_unique';
    END IF;
  END IF;

  RETURN projected_notification;
END;
$$;

REVOKE ALL ON FUNCTION system.project_notification(
  uuid,
  uuid,
  text,
  uuid,
  text,
  uuid,
  text[],
  uuid[],
  text,
  text,
  text,
  jsonb,
  text,
  timestamptz,
  text
) FROM PUBLIC;

CREATE FUNCTION system.project_reaction_notification(
  candidate_notification_id uuid,
  candidate_recipient_actor_id uuid,
  candidate_content_id uuid,
  candidate_reaction_type text,
  candidate_bucket_start timestamptz,
  candidate_trigger_actor_id uuid,
  candidate_active boolean,
  candidate_event_occurred_at timestamptz,
  candidate_event_sequence bigint
)
RETURNS SETOF platform.notifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  projected_notification platform.notifications%ROWTYPE;
  aggregate_member platform.notification_aggregate_actors%ROWTYPE;
  content_author_actor_id uuid;
  content_root_id uuid;
  trigger_actor_kind text;
  trigger_actor_handle text;
  projected_symbol_ids text[];
  projected_community_ids uuid[];
  projected_context jsonb;
  recent_trigger_handles jsonb;
  aggregate_total bigint;
  aggregate_agents bigint;
  aggregate_humans bigint;
  aggregate_dedupe_key text;
  authoritative_notification_id uuid;
  authoritative_member_found boolean := false;
  candidate_bucket_end timestamptz;
  projection_bucket_start timestamptz;
  projection_bucket_end timestamptz;
  created_notification boolean := false;
  first_distinct_actor boolean := false;
BEGIN
  IF candidate_notification_id IS NULL
    OR candidate_recipient_actor_id IS NULL
    OR candidate_content_id IS NULL
    OR candidate_trigger_actor_id IS NULL
    OR candidate_active IS NULL
    OR candidate_bucket_start IS NULL
    OR candidate_event_occurred_at IS NULL
    OR candidate_event_sequence IS NULL
    OR candidate_event_sequence <= 0 THEN
    RAISE EXCEPTION
      'Reaction notification projection requires complete event identity'
      USING ERRCODE = '22023';
  END IF;

  IF candidate_reaction_type NOT IN ('helpful', 'agree', 'disagree') THEN
    RAISE EXCEPTION
      'Reaction notification type is invalid'
      USING ERRCODE = '22023';
  END IF;

  candidate_bucket_end := candidate_bucket_start + interval '10 minutes';
  projection_bucket_start := candidate_bucket_start;
  projection_bucket_end := candidate_bucket_end;
  IF candidate_bucket_start IS DISTINCT FROM to_timestamp(
      floor(extract(epoch FROM candidate_bucket_start) / 600) * 600
    )
    OR candidate_event_occurred_at < candidate_bucket_start
    OR candidate_event_occurred_at >= candidate_bucket_end THEN
    RAISE EXCEPTION
      'Reaction notification requires its fixed UTC ten-minute bucket'
      USING ERRCODE = '22023';
  END IF;

  SELECT content.author_actor_id, content.root_id
  INTO content_author_actor_id, content_root_id
  FROM platform.content_items AS content
  WHERE content.id = candidate_content_id
  FOR KEY SHARE;

  IF NOT FOUND OR content_author_actor_id <> candidate_recipient_actor_id THEN
    RAISE EXCEPTION
      'Reaction notification recipient must be the Content author'
      USING ERRCODE = '23514';
  END IF;

  IF candidate_trigger_actor_id = candidate_recipient_actor_id THEN
    RAISE EXCEPTION
      'A Content author cannot trigger their own reaction notification'
      USING ERRCODE = '23514';
  END IF;

  SELECT actor.kind, actor.handle::text
  INTO trigger_actor_kind, trigger_actor_handle
  FROM platform.actors AS actor
  WHERE actor.id = candidate_trigger_actor_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Reaction notification trigger Actor does not exist'
      USING ERRCODE = '23503';
  END IF;

  SELECT coalesce(
    array_agg(symbol.ticker::text ORDER BY classification.position),
    ARRAY[]::text[]
  )
  INTO projected_symbol_ids
  FROM platform.content_symbols AS classification
  JOIN platform.symbols AS symbol ON symbol.id = classification.symbol_id
  WHERE classification.content_id = content_root_id;

  SELECT coalesce(
    array_agg(placement.community_id ORDER BY placement.position),
    ARRAY[]::uuid[]
  )
  INTO projected_community_ids
  FROM (
    SELECT root.primary_community_id AS community_id, 0 AS position
    FROM platform.content_items AS root
    WHERE root.id = content_root_id
    UNION ALL
    SELECT additional.community_id, additional.position::integer
    FROM platform.content_additional_communities AS additional
    WHERE additional.content_id = content_root_id
  ) AS placement;

  aggregate_dedupe_key := format(
    'reaction.changed:%s:%s:%s',
    candidate_content_id,
    candidate_reaction_type,
    extract(epoch FROM candidate_bucket_start)::bigint
  );

  -- One authoritative membership spans every ten-minute notification bucket
  -- for a Content/reaction/Actor tuple. This lock serializes cross-window
  -- revoke/restore before any window-local notification lock is acquired.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'alphanet:notification-reaction-member:'
        || candidate_content_id::text
        || ':'
        || candidate_reaction_type
        || ':'
        || candidate_trigger_actor_id::text,
      0
    )
  );

  SELECT member.notification_id
  INTO authoritative_notification_id
  FROM platform.notification_aggregate_actors AS member
  WHERE member.content_id = candidate_content_id
    AND member.reaction_type = candidate_reaction_type
    AND member.actor_id = candidate_trigger_actor_id;

  authoritative_member_found := FOUND;
  IF authoritative_member_found THEN
    -- Match the purge lock order: notification first, member second.
    SELECT notification.*
    INTO projected_notification
    FROM platform.notifications AS notification
    WHERE notification.id = authoritative_notification_id
    FOR UPDATE;

    authoritative_member_found := FOUND;
    IF authoritative_member_found THEN
      SELECT member.*
      INTO aggregate_member
      FROM platform.notification_aggregate_actors AS member
      WHERE member.notification_id = authoritative_notification_id
        AND member.content_id = candidate_content_id
        AND member.reaction_type = candidate_reaction_type
        AND member.actor_id = candidate_trigger_actor_id
      FOR UPDATE;
      authoritative_member_found := FOUND;
    END IF;
  END IF;

  IF authoritative_member_found THEN
    IF projected_notification.recipient_actor_id <>
        candidate_recipient_actor_id
      OR projected_notification.type <> 'reaction.changed'
      OR projected_notification.object_type <> 'content'
      OR projected_notification.object_id <> candidate_content_id
      OR projected_notification.context ->> 'reaction_type' <>
        candidate_reaction_type
      OR projected_notification.schema_version <> 'notification-v1' THEN
      RAISE EXCEPTION
        'Authoritative reaction membership resolved to a different notification'
        USING ERRCODE = '23505',
              CONSTRAINT =
                'notification_aggregate_actors_authoritative_member_unique';
    END IF;

    IF candidate_event_sequence <= aggregate_member.latest_event_sequence THEN
      RETURN NEXT projected_notification;
      RETURN;
    END IF;

    -- Cross-window revoke/restore events update the authoritative membership
    -- in its origin notification. The notification window remains immutable
    -- context even when last_occurred_at advances beyond that window.
    projection_bucket_start := (
      projected_notification.context ->> 'reaction_window_started_at'
    )::timestamptz;
    projection_bucket_end := (
      projected_notification.context ->> 'reaction_window_ends_at'
    )::timestamptz;

    UPDATE platform.notification_aggregate_actors AS member
    SET active = candidate_active,
        latest_event_at = candidate_event_occurred_at,
        latest_event_sequence = candidate_event_sequence
    WHERE member.notification_id = projected_notification.id
      AND member.actor_id = candidate_trigger_actor_id;
  ELSE
    -- A negative event without retained positive membership has no user-facing
    -- notification to update. The ordered Outbox consumer prevents an older
    -- positive event from overtaking it within the replay horizon.
    IF NOT candidate_active THEN
      RETURN;
    END IF;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        'alphanet:notification-dedupe:'
          || candidate_recipient_actor_id::text
          || ':'
          || octet_length(aggregate_dedupe_key)::text
          || ':'
          || aggregate_dedupe_key,
        0
      )
    );

    projected_context := jsonb_build_object(
      'symbols', projected_symbol_ids,
      'community_ids', projected_community_ids,
      'reaction_type', candidate_reaction_type,
      'reaction_window_started_at', to_char(
        projection_bucket_start AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'reaction_window_ends_at', to_char(
        projection_bucket_end AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'recent_trigger_handles', jsonb_build_array(trigger_actor_handle)
    );

    SELECT notification.*
    INTO projected_notification
    FROM platform.notifications AS notification
    WHERE notification.recipient_actor_id = candidate_recipient_actor_id
      AND notification.dedupe_key = aggregate_dedupe_key
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO platform.notifications (
        id,
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
        last_occurred_at,
        aggregate_distinct_actor_count,
        aggregate_agent_count,
        aggregate_human_count,
        dedupe_key
      )
      VALUES (
        candidate_notification_id,
        candidate_recipient_actor_id,
        'reaction.changed',
        NULL,
        'content',
        candidate_content_id,
        projected_symbol_ids,
        projected_community_ids,
        projected_context,
        'notification.reaction_changed',
        candidate_event_occurred_at,
        candidate_event_occurred_at,
        1,
        CASE WHEN trigger_actor_kind = 'agent' THEN 1 ELSE 0 END,
        CASE WHEN trigger_actor_kind = 'human' THEN 1 ELSE 0 END,
        aggregate_dedupe_key
      )
      ON CONFLICT (recipient_actor_id, dedupe_key) DO NOTHING
      RETURNING * INTO projected_notification;

      created_notification := FOUND;
      IF NOT created_notification THEN
        SELECT notification.*
        INTO projected_notification
        FROM platform.notifications AS notification
        WHERE notification.recipient_actor_id = candidate_recipient_actor_id
          AND notification.dedupe_key = aggregate_dedupe_key
        FOR UPDATE;
      END IF;
    END IF;

    IF projected_notification.type <> 'reaction.changed'
      OR projected_notification.object_type <> 'content'
      OR projected_notification.object_id <> candidate_content_id
      OR projected_notification.context ->> 'reaction_type' <>
        candidate_reaction_type
      OR (projected_notification.context ->>
        'reaction_window_started_at')::timestamptz <> candidate_bucket_start
      OR projected_notification.schema_version <> 'notification-v1' THEN
      RAISE EXCEPTION
        'Reaction aggregation key resolved to a different notification'
        USING ERRCODE = '23505',
              CONSTRAINT = 'notifications_recipient_dedupe_unique';
    END IF;

    INSERT INTO platform.notification_aggregate_actors (
      notification_id,
      content_id,
      reaction_type,
      actor_id,
      actor_kind,
      active,
      first_positive_at,
      latest_event_at,
      latest_event_sequence
    )
    VALUES (
      projected_notification.id,
      candidate_content_id,
      candidate_reaction_type,
      candidate_trigger_actor_id,
      trigger_actor_kind,
      true,
      candidate_event_occurred_at,
      candidate_event_occurred_at,
      candidate_event_sequence
    );

    IF created_notification THEN
      RETURN NEXT projected_notification;
      RETURN;
    END IF;

    first_distinct_actor := true;
  END IF;

  SELECT
    count(*) FILTER (WHERE member.active),
    count(*) FILTER (WHERE member.active AND member.actor_kind = 'agent'),
    count(*) FILTER (WHERE member.active AND member.actor_kind = 'human')
  INTO aggregate_total, aggregate_agents, aggregate_humans
  FROM platform.notification_aggregate_actors AS member
  WHERE member.notification_id = projected_notification.id;

  SELECT coalesce(
    jsonb_agg(
      recent.handle
      ORDER BY recent.latest_event_sequence DESC, recent.actor_id
    ),
    '[]'
  )
  INTO recent_trigger_handles
  FROM (
    SELECT
      actor.handle::text AS handle,
      member.latest_event_sequence,
      member.actor_id
    FROM platform.notification_aggregate_actors AS member
    JOIN platform.actors AS actor ON actor.id = member.actor_id
    WHERE member.notification_id = projected_notification.id
      AND member.active
    ORDER BY member.latest_event_sequence DESC, member.actor_id
    LIMIT 3
  ) AS recent;

  projected_context := jsonb_build_object(
    'symbols', projected_notification.symbol_ids,
    'community_ids', projected_notification.community_ids,
    'reaction_type', candidate_reaction_type,
    'reaction_window_started_at', to_char(
      projection_bucket_start AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'reaction_window_ends_at', to_char(
      projection_bucket_end AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'recent_trigger_handles', recent_trigger_handles
  );

  UPDATE platform.notifications AS notification
  SET context = projected_context,
      last_occurred_at = greatest(
        notification.last_occurred_at,
        candidate_event_occurred_at
      ),
      aggregate_distinct_actor_count = aggregate_total,
      aggregate_agent_count = aggregate_agents,
      aggregate_human_count = aggregate_humans,
      read_at = CASE
        WHEN first_distinct_actor THEN NULL
        ELSE notification.read_at
      END
  WHERE notification.id = projected_notification.id
  RETURNING notification.* INTO projected_notification;

  RETURN NEXT projected_notification;
END;
$$;

REVOKE ALL ON FUNCTION system.project_reaction_notification(
  uuid,
  uuid,
  uuid,
  text,
  timestamptz,
  uuid,
  boolean,
  timestamptz,
  bigint
) FROM PUBLIC;

-- Owner Web read-state entry points --------------------------------------

CREATE FUNCTION system.set_notification_read_state(
  candidate_notification_id uuid,
  candidate_recipient_actor_id uuid,
  candidate_is_read boolean
)
RETURNS SETOF platform.notifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  projected_notification platform.notifications%ROWTYPE;
BEGIN
  IF candidate_notification_id IS NULL
    OR candidate_recipient_actor_id IS NULL
    OR candidate_is_read IS NULL THEN
    RAISE EXCEPTION
      'Notification read-state mutation requires complete identity and state'
      USING ERRCODE = '22023';
  END IF;

  SELECT notification.*
  INTO projected_notification
  FROM platform.notifications AS notification
  WHERE notification.id = candidate_notification_id
    AND notification.recipient_actor_id = candidate_recipient_actor_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF (candidate_is_read AND projected_notification.read_at IS NULL)
    OR (NOT candidate_is_read AND projected_notification.read_at IS NOT NULL) THEN
    UPDATE platform.notifications AS notification
    SET read_at = CASE
      WHEN candidate_is_read
        THEN date_trunc('milliseconds', statement_timestamp())
      ELSE NULL
    END
    WHERE notification.id = candidate_notification_id
      AND notification.recipient_actor_id = candidate_recipient_actor_id
    RETURNING notification.* INTO projected_notification;
  END IF;

  RETURN NEXT projected_notification;
END;
$$;

REVOKE ALL ON FUNCTION system.set_notification_read_state(
  uuid,
  uuid,
  boolean
) FROM PUBLIC;

CREATE FUNCTION system.mark_all_notifications_read(
  candidate_recipient_actor_id uuid
)
RETURNS TABLE (marked_count bigint, read_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  marked_at timestamptz := date_trunc(
    'milliseconds',
    statement_timestamp()
  );
BEGIN
  IF candidate_recipient_actor_id IS NULL THEN
    RAISE EXCEPTION
      'Notification bulk read-state mutation requires a recipient'
      USING ERRCODE = '22023';
  END IF;

  UPDATE platform.notifications AS notification
  SET read_at = marked_at
  WHERE notification.recipient_actor_id = candidate_recipient_actor_id
    AND notification.read_at IS NULL;

  GET DIAGNOSTICS marked_count = ROW_COUNT;
  read_at := marked_at;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION system.mark_all_notifications_read(uuid)
FROM PUBLIC;

-- Fixed-window retention -------------------------------------------------

CREATE FUNCTION system.purge_expired_notifications(
  candidate_batch_size integer
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  notification_ids uuid[];
  purged_count bigint := 0;
  retention_cutoff timestamptz := statement_timestamp() - interval '90 days';
BEGIN
  IF candidate_batch_size IS NULL
    OR candidate_batch_size < 1
    OR candidate_batch_size > 10000 THEN
    RAISE EXCEPTION
      'Notification purge batch size must be between 1 and 10000'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(candidate.id ORDER BY candidate.created_at, candidate.id)
  INTO notification_ids
  FROM (
    SELECT notification.id, notification.created_at
    FROM platform.notifications AS notification
    WHERE notification.created_at < retention_cutoff
    ORDER BY notification.created_at, notification.id
    FOR UPDATE SKIP LOCKED
    LIMIT candidate_batch_size
  ) AS candidate;

  IF coalesce(cardinality(notification_ids), 0) = 0 THEN
    RETURN 0;
  END IF;

  BEGIN
    PERFORM set_config(
      'alphanet.notification_retention_purge',
      'on',
      true
    );

    -- Foreign-key dependents are removed explicitly and in a reviewed order;
    -- source Content, Follow, ActionLog and Outbox facts remain untouched.
    DELETE FROM system.notification_change_journal AS journal
    WHERE journal.notification_id = ANY (notification_ids);

    DELETE FROM platform.notification_aggregate_actors AS member
    WHERE member.notification_id = ANY (notification_ids);

    DELETE FROM platform.notifications AS notification
    WHERE notification.id = ANY (notification_ids);

    GET DIAGNOSTICS purged_count = ROW_COUNT;
    PERFORM set_config(
      'alphanet.notification_retention_purge',
      'off',
      true
    );
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config(
        'alphanet.notification_retention_purge',
        'off',
        true
      );
      RAISE;
  END;

  RETURN purged_count;
END;
$$;

REVOKE ALL ON FUNCTION system.purge_expired_notifications(integer)
FROM PUBLIC;
