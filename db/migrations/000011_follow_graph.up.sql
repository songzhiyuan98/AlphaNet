SET LOCAL search_path = pg_catalog;

-- Canonical Follow graph ---------------------------------------------------
--
-- A Follow is one current relationship fact owned by a follower Actor. The
-- four nullable foreign keys deliberately avoid a polymorphic target string:
-- every target remains protected by a real PostgreSQL foreign key while the
-- closed target-shape CHECK keeps the representation unambiguous.

CREATE TABLE platform.follows (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  follower_actor_id uuid NOT NULL
    REFERENCES platform.actors(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  target_type text NOT NULL,
  target_actor_id uuid
    REFERENCES platform.actors(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  target_symbol_id uuid
    REFERENCES platform.symbols(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  target_topic_id uuid
    REFERENCES platform.topics(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  target_content_id uuid
    REFERENCES platform.content_items(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  notification_level text NOT NULL DEFAULT 'feed_only',
  created_at timestamptz NOT NULL
    DEFAULT date_trunc('milliseconds', statement_timestamp()),
  updated_at timestamptz NOT NULL
    DEFAULT date_trunc('milliseconds', statement_timestamp()),
  CONSTRAINT follows_target_shape
    CHECK (
      (
        target_type = 'actor'
        AND target_actor_id IS NOT NULL
        AND target_symbol_id IS NULL
        AND target_topic_id IS NULL
        AND target_content_id IS NULL
      )
      OR (
        target_type = 'symbol'
        AND target_actor_id IS NULL
        AND target_symbol_id IS NOT NULL
        AND target_topic_id IS NULL
        AND target_content_id IS NULL
      )
      OR (
        target_type = 'topic'
        AND target_actor_id IS NULL
        AND target_symbol_id IS NULL
        AND target_topic_id IS NOT NULL
        AND target_content_id IS NULL
      )
      OR (
        target_type = 'content'
        AND target_actor_id IS NULL
        AND target_symbol_id IS NULL
        AND target_topic_id IS NULL
        AND target_content_id IS NOT NULL
      )
    ),
  CONSTRAINT follows_no_self_actor
    CHECK (
      target_actor_id IS NULL
      OR target_actor_id <> follower_actor_id
    ),
  CONSTRAINT follows_notification_level
    CHECK (notification_level IN ('feed_only', 'new_posts', 'all_events')),
  CONSTRAINT follows_updated_after_created
    CHECK (updated_at >= created_at),
  CONSTRAINT follows_timestamp_precision
    CHECK (
      created_at = date_trunc('milliseconds', created_at)
      AND updated_at = date_trunc('milliseconds', updated_at)
    )
);

CREATE UNIQUE INDEX follows_follower_actor_target_unique
  ON platform.follows (follower_actor_id, target_actor_id)
  WHERE target_type = 'actor';

CREATE UNIQUE INDEX follows_follower_symbol_target_unique
  ON platform.follows (follower_actor_id, target_symbol_id)
  WHERE target_type = 'symbol';

CREATE UNIQUE INDEX follows_follower_topic_target_unique
  ON platform.follows (follower_actor_id, target_topic_id)
  WHERE target_type = 'topic';

CREATE UNIQUE INDEX follows_follower_content_target_unique
  ON platform.follows (follower_actor_id, target_content_id)
  WHERE target_type = 'content';

CREATE INDEX follows_follower_updated_idx
  ON platform.follows (follower_actor_id, updated_at DESC, id DESC);

CREATE INDEX follows_target_actor_reverse_idx
  ON platform.follows (target_actor_id, created_at DESC, follower_actor_id)
  WHERE target_type = 'actor';

CREATE INDEX follows_target_symbol_reverse_idx
  ON platform.follows (target_symbol_id, created_at DESC, follower_actor_id)
  WHERE target_type = 'symbol';

CREATE INDEX follows_target_topic_reverse_idx
  ON platform.follows (target_topic_id, created_at DESC, follower_actor_id)
  WHERE target_type = 'topic';

CREATE INDEX follows_target_content_reverse_idx
  ON platform.follows (target_content_id, created_at DESC, follower_actor_id)
  WHERE target_type = 'content';

CREATE INDEX action_logs_follow_succeeded_agent_occurred_idx
  ON platform.action_logs (agent_id, occurred_at)
  WHERE agent_id IS NOT NULL
    AND action = 'follow.set'
    AND outcome = 'succeeded';

COMMENT ON TABLE platform.follows IS
  'Current Actor-owned Follow facts. Identity is immutable; unfollow deletes the fact while ActionLog and Outbox retain history.';

COMMENT ON COLUMN platform.follows.notification_level IS
  'Delivery preference only. It does not alter Following Feed membership.';

-- Stable Following cursor invalidation ------------------------------------

CREATE TABLE system.actor_follow_epochs (
  actor_id uuid PRIMARY KEY
    REFERENCES platform.actors(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  epoch bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT actor_follow_epochs_positive CHECK (epoch > 0)
);

COMMENT ON TABLE system.actor_follow_epochs IS
  'Lazy per-follower monotonic epochs. A missing row means no committed Follow mutation and is read as epoch zero.';

-- Runtime writes cannot create relationships to unusable identities or
-- catalog/content targets. Actor-to-Actor locking is ordered by UUID so two
-- Actors following each other concurrently do not acquire inverse locks.
CREATE FUNCTION platform.validate_follow_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  follower_status text;
  follower_deleted_at timestamptz;
  target_actor_status text;
  target_actor_deleted_at timestamptz;
  target_symbol_status text;
  target_symbol_ticker text;
  active_symbol_candidates bigint;
  target_topic_found boolean := false;
  target_topic_deleted_at timestamptz;
  target_content_found boolean := false;
  target_content_lifecycle text;
  target_content_distribution text;
  root_lifecycle text;
  root_distribution text;
  root_primary_community_id uuid;
  root_community_found boolean := false;
  root_community_status text;
  root_community_deleted_at timestamptz;
  active_follow_count bigint;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'follows'
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION
      'Follow target validator invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  IF NOT (
    (
      NEW.target_type = 'actor'
      AND NEW.target_actor_id IS NOT NULL
      AND NEW.target_symbol_id IS NULL
      AND NEW.target_topic_id IS NULL
      AND NEW.target_content_id IS NULL
    )
    OR (
      NEW.target_type = 'symbol'
      AND NEW.target_actor_id IS NULL
      AND NEW.target_symbol_id IS NOT NULL
      AND NEW.target_topic_id IS NULL
      AND NEW.target_content_id IS NULL
    )
    OR (
      NEW.target_type = 'topic'
      AND NEW.target_actor_id IS NULL
      AND NEW.target_symbol_id IS NULL
      AND NEW.target_topic_id IS NOT NULL
      AND NEW.target_content_id IS NULL
    )
    OR (
      NEW.target_type = 'content'
      AND NEW.target_actor_id IS NULL
      AND NEW.target_symbol_id IS NULL
      AND NEW.target_topic_id IS NULL
      AND NEW.target_content_id IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION
      'Follow target type and target identity are inconsistent'
      USING ERRCODE = '23514', CONSTRAINT = 'follows_target_shape';
  END IF;

  IF NEW.target_type = 'actor' THEN
    IF NEW.target_actor_id = NEW.follower_actor_id THEN
      RAISE EXCEPTION
        'Actors cannot follow themselves'
        USING ERRCODE = '23514', CONSTRAINT = 'follows_no_self_actor';
    END IF;

    PERFORM actor.id
    FROM platform.actors AS actor
    WHERE actor.id IN (NEW.follower_actor_id, NEW.target_actor_id)
    ORDER BY actor.id
    FOR SHARE;

    SELECT actor.status, actor.deleted_at
    INTO follower_status, follower_deleted_at
    FROM platform.actors AS actor
    WHERE actor.id = NEW.follower_actor_id;

    SELECT actor.status, actor.deleted_at
    INTO target_actor_status, target_actor_deleted_at
    FROM platform.actors AS actor
    WHERE actor.id = NEW.target_actor_id;

    IF follower_status IS NULL OR target_actor_status IS NULL THEN
      RAISE EXCEPTION
        'Follow follower or Actor target does not exist'
        USING ERRCODE = '23503';
    END IF;

    IF target_actor_status <> 'active' OR target_actor_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION
        'Follow Actor target must be active'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    SELECT actor.status, actor.deleted_at
    INTO follower_status, follower_deleted_at
    FROM platform.actors AS actor
    WHERE actor.id = NEW.follower_actor_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Follow follower does not exist'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF follower_status <> 'active' OR follower_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Only active Actors can own Follow relationships'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.target_type = 'symbol' THEN
    SELECT symbol.status, symbol.ticker::text
    INTO target_symbol_status, target_symbol_ticker
    FROM platform.symbols AS symbol
    WHERE symbol.id = NEW.target_symbol_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Follow Symbol target does not exist'
        USING ERRCODE = '23503';
    END IF;
    IF target_symbol_status <> 'active' THEN
      RAISE EXCEPTION
        'Follow Symbol target must be active'
        USING ERRCODE = '55000';
    END IF;

    -- A canonical ticker can still exist on multiple exchanges. Lock every
    -- current candidate and require the target ticker to resolve to exactly
    -- one active reference row; direct SQL must not pick an arbitrary row.
    PERFORM symbol.id
    FROM platform.symbols AS symbol
    WHERE symbol.ticker::text = target_symbol_ticker
    ORDER BY symbol.id
    FOR SHARE;

    SELECT count(*)
    INTO active_symbol_candidates
    FROM platform.symbols AS symbol
    WHERE symbol.ticker::text = target_symbol_ticker
      AND symbol.status = 'active';

    IF active_symbol_candidates <> 1 THEN
      RAISE EXCEPTION
        'Follow Symbol ticker does not resolve to exactly one active target'
        USING ERRCODE = '23514',
              CONSTRAINT = 'follows_symbol_target_unambiguous';
    END IF;
  ELSIF NEW.target_type = 'topic' THEN
    SELECT true, topic.deleted_at
    INTO target_topic_found, target_topic_deleted_at
    FROM platform.topics AS topic
    WHERE topic.id = NEW.target_topic_id
    FOR SHARE;

    IF target_topic_found IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'Follow Topic target does not exist'
        USING ERRCODE = '23503';
    END IF;
    IF target_topic_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION
        'Follow Topic target must not be deleted'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.target_type = 'content' THEN
    SELECT
      true,
      content.lifecycle_state,
      content.distribution_state,
      root.lifecycle_state,
      root.distribution_state,
      root.primary_community_id
    INTO
      target_content_found,
      target_content_lifecycle,
      target_content_distribution,
      root_lifecycle,
      root_distribution,
      root_primary_community_id
    FROM platform.content_items AS content
    JOIN platform.content_items AS root ON root.id = content.root_id
    WHERE content.id = NEW.target_content_id
    FOR SHARE OF content, root;

    IF target_content_found IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'Follow Content target does not exist'
        USING ERRCODE = '23503';
    END IF;
    IF target_content_lifecycle <> 'published'
      OR target_content_distribution = 'hidden'
      OR root_lifecycle <> 'published'
      OR root_distribution = 'hidden' THEN
      RAISE EXCEPTION
        'Follow Content target and discussion root must be visible and published'
        USING ERRCODE = '55000';
    END IF;

    SELECT true, community.status, community.deleted_at
    INTO
      root_community_found,
      root_community_status,
      root_community_deleted_at
    FROM platform.communities AS community
    WHERE community.id = root_primary_community_id
    FOR SHARE;

    IF root_community_found IS DISTINCT FROM true
      OR root_community_status = 'suspended'
      OR root_community_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION
        'Follow Content target requires a readable primary Community'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Serialize the cardinality decision independently for each follower. The
    -- count is a separate command after the advisory-lock wait so Read
    -- Committed observes a relationship committed by the preceding waiter.
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        'alphanet:follow-cardinality:' || NEW.follower_actor_id::text,
        0
      )
    );

    SELECT count(*)
    INTO active_follow_count
    FROM platform.follows AS follow
    WHERE follow.follower_actor_id = NEW.follower_actor_id;

    IF active_follow_count >= 1000 THEN
      RAISE EXCEPTION
        'An Actor cannot own more than 1000 Follow relationships'
        USING ERRCODE = '23514',
              CONSTRAINT = 'follows_actor_cardinality_limit';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER follows_validate_write
BEFORE INSERT OR UPDATE ON platform.follows
FOR EACH ROW
EXECUTE FUNCTION platform.validate_follow_write();

REVOKE ALL ON FUNCTION platform.validate_follow_write() FROM PUBLIC;

-- Relationship identity is permanent for the life of a fact. Changing a
-- target is an unfollow plus a new follow; UPDATE is reserved for a real
-- notification preference change and receives a database timestamp.
CREATE FUNCTION platform.prepare_follow_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'follows'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Follow update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF (to_jsonb(NEW) - ARRAY['notification_level', 'updated_at']::text[])
    IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['notification_level', 'updated_at']::text[]) THEN
    RAISE EXCEPTION
      'Follow identity is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.notification_level IS NOT DISTINCT FROM OLD.notification_level THEN
    RAISE EXCEPTION
      'Follow UPDATE must change the notification preference'
      USING ERRCODE = '22023';
  END IF;

  NEW.updated_at := date_trunc('milliseconds', clock_timestamp());
  RETURN NEW;
END;
$$;

CREATE TRIGGER follows_prepare_update
BEFORE UPDATE ON platform.follows
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_follow_update();

REVOKE ALL ON FUNCTION platform.prepare_follow_update() FROM PUBLIC;

CREATE FUNCTION platform.advance_actor_follow_epoch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  changed_actor_id uuid;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'follows'
    OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
    RAISE EXCEPTION
      'Actor Follow epoch trigger invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  changed_actor_id := CASE WHEN TG_OP = 'DELETE'
    THEN OLD.follower_actor_id
    ELSE NEW.follower_actor_id
  END;

  INSERT INTO system.actor_follow_epochs AS actor_epoch (
    actor_id,
    epoch,
    updated_at
  )
  VALUES (changed_actor_id, 1, clock_timestamp())
  ON CONFLICT (actor_id) DO UPDATE
  SET epoch = actor_epoch.epoch + 1,
      updated_at = clock_timestamp();

  RETURN NULL;
END;
$$;

CREATE TRIGGER follows_advance_actor_epoch
AFTER INSERT OR UPDATE OR DELETE ON platform.follows
FOR EACH ROW
EXECUTE FUNCTION platform.advance_actor_follow_epoch();

REVOKE ALL ON FUNCTION platform.advance_actor_follow_epoch() FROM PUBLIC;
