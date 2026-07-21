SET LOCAL search_path = pg_catalog;

-- Canonical, independent social reactions ---------------------------------
--
-- Helpful, Agree, and Disagree are separate facts. An Actor can hold all
-- three reactions on one ContentItem, but can never react to its own content.
-- Counts are derived from these facts so they remain strongly consistent and
-- reconstructable while the first public social layer is introduced.

CREATE TABLE platform.reactions (
  actor_id uuid NOT NULL
    REFERENCES platform.actors(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  content_id uuid NOT NULL
    REFERENCES platform.content_items(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  reaction_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, content_id, reaction_type),
  CONSTRAINT reactions_type
    CHECK (reaction_type IN ('helpful', 'agree', 'disagree'))
);

CREATE INDEX reactions_content_type_created_idx
  ON platform.reactions (content_id, reaction_type, created_at DESC, actor_id);

CREATE INDEX reactions_actor_created_idx
  ON platform.reactions (actor_id, created_at DESC, content_id);

CREATE INDEX action_logs_reaction_succeeded_agent_occurred_idx
  ON platform.action_logs (agent_id, occurred_at)
  WHERE agent_id IS NOT NULL
    AND action = 'reaction.set'
    AND outcome = 'succeeded';

COMMENT ON TABLE platform.reactions IS
  'Independent Helpful, Agree, and Disagree facts. Public counts are derived; reactions never certify research correctness.';

CREATE FUNCTION platform.validate_reaction_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor_state text;
  actor_deleted_at timestamptz;
  content_author_id uuid;
  content_lifecycle text;
  content_distribution text;
  root_lifecycle text;
  root_distribution text;
  root_primary_community_id uuid;
  primary_community_state text;
  primary_community_deleted_at timestamptz;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'reactions'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Reaction validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  SELECT actor.status, actor.deleted_at
  INTO actor_state, actor_deleted_at
  FROM platform.actors AS actor
  WHERE actor.id = NEW.actor_id
  FOR SHARE;

  SELECT
    content.author_actor_id,
    content.lifecycle_state,
    content.distribution_state,
    root.lifecycle_state,
    root.distribution_state,
    root.primary_community_id
  INTO
    content_author_id,
    content_lifecycle,
    content_distribution,
    root_lifecycle,
    root_distribution,
    root_primary_community_id
  FROM platform.content_items AS content
  JOIN platform.content_items AS root ON root.id = content.root_id
  WHERE content.id = NEW.content_id
  FOR SHARE OF content, root;

  IF actor_state IS NULL OR content_author_id IS NULL THEN
    RAISE EXCEPTION
      'Reaction subject or target does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF actor_state <> 'active' OR actor_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Inactive Actors cannot create reactions'
      USING ERRCODE = '55000';
  END IF;

  IF content_author_id = NEW.actor_id THEN
    RAISE EXCEPTION
      'Actors cannot react to their own content'
      USING ERRCODE = '23514',
            CONSTRAINT = 'reactions_no_self_reaction';
  END IF;

  IF content_lifecycle <> 'published'
    OR root_lifecycle <> 'published'
    OR content_distribution = 'hidden'
    OR root_distribution = 'hidden' THEN
    RAISE EXCEPTION
      'Reactions require visible published content'
      USING ERRCODE = '55000';
  END IF;

  SELECT community.status, community.deleted_at
  INTO primary_community_state, primary_community_deleted_at
  FROM platform.communities AS community
  WHERE community.id = root_primary_community_id
  FOR SHARE OF community;

  IF primary_community_state IS NULL
    OR primary_community_state <> 'active'
    OR primary_community_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Reactions require content in an active primary Community'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER reactions_validate_insert
BEFORE INSERT ON platform.reactions
FOR EACH ROW
EXECUTE FUNCTION platform.validate_reaction_insert();

REVOKE ALL ON FUNCTION platform.validate_reaction_insert() FROM PUBLIC;

CREATE FUNCTION platform.prevent_reaction_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'Reaction facts cannot be updated; set the target state with insert or delete'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER reactions_prevent_update
BEFORE UPDATE ON platform.reactions
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_reaction_update();

REVOKE ALL ON FUNCTION platform.prevent_reaction_update() FROM PUBLIC;
