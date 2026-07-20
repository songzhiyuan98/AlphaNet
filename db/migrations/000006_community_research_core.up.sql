SET LOCAL search_path = pg_catalog;

-- Community directory -------------------------------------------------------
--
-- 000001 intentionally shipped only the walking-skeleton community table.
-- Keep its stable IDs and legacy settings column while adding the canonical
-- directory fields needed by the first public research slice.

CREATE FUNCTION platform.community_posting_rules_are_valid(candidate jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT coalesce((
    jsonb_typeof(candidate) = 'object'
    AND jsonb_typeof(candidate -> 'allowed_content') = 'array'
    AND jsonb_array_length(candidate -> 'allowed_content') BETWEEN 1 AND 20
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(candidate -> 'allowed_content') AS entry(value)
      WHERE jsonb_typeof(entry.value) <> 'string'
        OR length(btrim(entry.value #>> '{}')) NOT BETWEEN 1 AND 80
    )
    AND (
      SELECT count(*) = count(DISTINCT entry.value #>> '{}')
      FROM jsonb_array_elements(candidate -> 'allowed_content') AS entry(value)
    )
    AND jsonb_typeof(candidate -> 'max_posts_per_hour') = 'number'
    AND candidate ->> 'max_posts_per_hour' ~ '^(0|[1-9][0-9]{0,3})$'
    AND (candidate ->> 'max_posts_per_hour')::integer BETWEEN 0 AND 1000
    AND jsonb_typeof(candidate -> 'requires_sources') = 'boolean'
    AND jsonb_typeof(candidate -> 'replies_open') = 'boolean'
  ), false)
$$;

REVOKE ALL ON FUNCTION platform.community_posting_rules_are_valid(jsonb)
  FROM PUBLIC;

ALTER TABLE platform.communities
  DROP CONSTRAINT communities_status;

ALTER TABLE platform.communities
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD COLUMN kind text NOT NULL DEFAULT 'general',
  ADD COLUMN posting_rules jsonb NOT NULL DEFAULT
    '{
      "allowed_content": [
        "investment-research",
        "source-analysis",
        "question",
        "discussion",
        "trade-review"
      ],
      "max_posts_per_hour": 6,
      "requires_sources": false,
      "replies_open": true
    }'::jsonb,
  ADD COLUMN deleted_at timestamptz,
  ADD CONSTRAINT communities_version_positive
    CHECK (version > 0),
  ADD CONSTRAINT communities_kind
    CHECK (kind IN ('symbol', 'topic', 'general')),
  ADD CONSTRAINT communities_status
    CHECK (status IN ('active', 'read_only', 'suspended', 'archived')),
  ADD CONSTRAINT communities_posting_rules_valid
    CHECK (platform.community_posting_rules_are_valid(posting_rules)),
  ADD CONSTRAINT communities_deleted_after_created
    CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  ADD CONSTRAINT communities_deleted_only_when_archived
    CHECK (deleted_at IS NULL OR status = 'archived');

COMMENT ON COLUMN platform.communities.settings IS
  'Legacy non-authoritative metadata from the walking skeleton. Posting decisions use posting_rules.';

COMMENT ON COLUMN platform.communities.posting_rules IS
  'Versioned, non-UGC rule configuration with database-enforced safe defaults.';

CREATE FUNCTION platform.prepare_community_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'communities'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Community update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.slug IS DISTINCT FROM OLD.slug
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Community identity is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.deleted_at IS NOT NULL
    AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION
      'Community deletion is irreversible'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION
      'Community version must advance exactly by one'
      USING ERRCODE = '40001';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER communities_prepare_update
BEFORE UPDATE ON platform.communities
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_community_update();

REVOKE ALL ON FUNCTION platform.prepare_community_update() FROM PUBLIC;

CREATE TABLE platform.symbols (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  community_candidate_id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  ticker public.citext NOT NULL,
  exchange text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT symbols_id_candidate_unique
    UNIQUE (id, community_candidate_id),
  CONSTRAINT symbols_community_candidate_unique
    UNIQUE (community_candidate_id),
  CONSTRAINT symbols_exchange_ticker_unique
    UNIQUE (exchange, ticker),
  CONSTRAINT symbols_ticker_canonical
    CHECK (
      ticker::text = upper(ticker::text)
      AND ticker::text ~ '^[A-Z0-9][A-Z0-9.-]{0,14}$'
    ),
  CONSTRAINT symbols_exchange_canonical
    CHECK (
      exchange = upper(exchange)
      AND exchange ~ '^[A-Z0-9][A-Z0-9_.-]{0,19}$'
    ),
  CONSTRAINT symbols_name_size
    CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT symbols_status
    CHECK (status IN ('active', 'inactive', 'delisted')),
  CONSTRAINT symbols_candidate_distinct
    CHECK (community_candidate_id <> id),
  CONSTRAINT symbols_updated_after_created
    CHECK (updated_at >= created_at)
);

CREATE INDEX symbols_ticker_idx
  ON platform.symbols (ticker, exchange, id);

CREATE INDEX symbols_name_trgm_idx
  ON platform.symbols
  USING gin (name public.gin_trgm_ops);

COMMENT ON TABLE platform.symbols IS
  'Curated reference-data symbols. Free-form post input cannot create rows in this table.';

COMMENT ON COLUMN platform.symbols.community_candidate_id IS
  'Stable catalog-only Community ID. First publication may materialize exactly this ID in the same content transaction.';

CREATE TABLE platform.topics (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  slug public.citext NOT NULL,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  CONSTRAINT topics_slug_unique
    UNIQUE (slug),
  CONSTRAINT topics_slug_format
    CHECK (
      slug::text = lower(slug::text)
      AND slug::text ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
    ),
  CONSTRAINT topics_name_size
    CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT topics_description_size
    CHECK (description IS NULL OR length(description) <= 4000),
  CONSTRAINT topics_updated_after_created
    CHECK (updated_at >= created_at),
  CONSTRAINT topics_deleted_after_created
    CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE INDEX topics_name_trgm_idx
  ON platform.topics
  USING gin (name public.gin_trgm_ops);

CREATE INDEX communities_directory_idx
  ON platform.communities (status, kind, slug, id)
  WHERE deleted_at IS NULL;

CREATE INDEX communities_name_trgm_idx
  ON platform.communities
  USING gin (name public.gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX communities_description_fts_idx
  ON platform.communities
  USING gin (
    to_tsvector(
      'simple'::regconfig,
      coalesce(name, '') || ' ' || coalesce(description, '')
    )
  )
  WHERE deleted_at IS NULL;

CREATE TABLE platform.community_symbols (
  community_id uuid NOT NULL
    REFERENCES platform.communities(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  symbol_id uuid NOT NULL
    REFERENCES platform.symbols(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  is_primary boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, symbol_id),
  CONSTRAINT community_symbols_canonical_target
    CHECK (is_primary),
  CONSTRAINT community_symbols_catalog_identity
    FOREIGN KEY (symbol_id, community_id)
    REFERENCES platform.symbols(id, community_candidate_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX community_symbols_one_target_per_community
  ON platform.community_symbols (community_id)
  WHERE is_primary;

CREATE UNIQUE INDEX community_symbols_one_community_per_symbol
  ON platform.community_symbols (symbol_id)
  WHERE is_primary;

CREATE TABLE platform.community_topics (
  community_id uuid NOT NULL
    REFERENCES platform.communities(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  topic_id uuid NOT NULL
    REFERENCES platform.topics(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  is_primary boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, topic_id),
  CONSTRAINT community_topics_canonical_target
    CHECK (is_primary)
);

CREATE UNIQUE INDEX community_topics_one_target_per_community
  ON platform.community_topics (community_id)
  WHERE is_primary;

CREATE UNIQUE INDEX community_topics_one_community_per_topic
  ON platform.community_topics (topic_id)
  WHERE is_primary;

CREATE FUNCTION platform.validate_community_canonical_target()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate_id uuid;
  candidate_kind text;
  symbol_targets integer;
  topic_targets integer;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME NOT IN ('communities', 'community_symbols', 'community_topics')
    OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
    RAISE EXCEPTION
      'Community target validator invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  IF TG_TABLE_NAME = 'communities' THEN
    candidate_id := COALESCE(NEW.id, OLD.id);
  ELSE
    candidate_id := COALESCE(NEW.community_id, OLD.community_id);
  END IF;

  SELECT community.kind
  INTO candidate_kind
  FROM platform.communities AS community
  WHERE community.id = candidate_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*)::integer
  INTO symbol_targets
  FROM platform.community_symbols AS mapping
  WHERE mapping.community_id = candidate_id
    AND mapping.is_primary;

  SELECT count(*)::integer
  INTO topic_targets
  FROM platform.community_topics AS mapping
  WHERE mapping.community_id = candidate_id
    AND mapping.is_primary;

  IF (candidate_kind = 'general' AND (symbol_targets <> 0 OR topic_targets <> 0))
    OR (candidate_kind = 'symbol' AND (symbol_targets <> 1 OR topic_targets <> 0))
    OR (candidate_kind = 'topic' AND (symbol_targets <> 0 OR topic_targets <> 1)) THEN
    RAISE EXCEPTION
      'Community kind and canonical target are inconsistent'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER communities_validate_canonical_target
AFTER INSERT OR UPDATE ON platform.communities
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_community_canonical_target();

CREATE CONSTRAINT TRIGGER community_symbols_validate_canonical_target
AFTER INSERT OR UPDATE OR DELETE ON platform.community_symbols
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_community_canonical_target();

CREATE CONSTRAINT TRIGGER community_topics_validate_canonical_target
AFTER INSERT OR UPDATE OR DELETE ON platform.community_topics
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_community_canonical_target();

REVOKE ALL ON FUNCTION platform.validate_community_canonical_target() FROM PUBLIC;

CREATE FUNCTION platform.prevent_community_target_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'Canonical Community targets are immutable after materialization'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER community_symbols_prevent_mutation
BEFORE UPDATE OR DELETE ON platform.community_symbols
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_community_target_mutation();

CREATE TRIGGER community_topics_prevent_mutation
BEFORE UPDATE OR DELETE ON platform.community_topics
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_community_target_mutation();

REVOKE ALL ON FUNCTION platform.prevent_community_target_mutation() FROM PUBLIC;

-- A denied or failed command has no domain event to publish. Successful and
-- pending writes still require a transactional Outbox row.
ALTER TABLE platform.action_logs
  DROP CONSTRAINT action_logs_domain_write_shape,
  ADD CONSTRAINT action_logs_domain_write_shape
    CHECK (
      event_class <> 'domain_write'
      OR (
        actor_id IS NOT NULL
        AND target_id IS NOT NULL
        AND decision IS NOT NULL
        AND policy_version IS NOT NULL
        AND (
          outcome IN ('denied', 'failed')
          OR outbox_event_id IS NOT NULL
        )
      )
    );

-- Canonical content and immutable revisions ---------------------------------

CREATE TABLE platform.content_items (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  version bigint NOT NULL DEFAULT 1,
  kind text NOT NULL,
  author_actor_id uuid NOT NULL
    REFERENCES platform.actors(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  primary_community_id uuid
    REFERENCES platform.communities(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  root_id uuid NOT NULL,
  parent_id uuid,
  depth smallint NOT NULL,
  current_revision_id uuid,
  lifecycle_state text NOT NULL DEFAULT 'published',
  distribution_state text NOT NULL DEFAULT 'normal',
  erasure_state text NOT NULL DEFAULT 'retained',
  published_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  deleted_at timestamptz,
  CONSTRAINT content_items_id_author_unique
    UNIQUE (id, author_actor_id),
  CONSTRAINT content_items_id_kind_unique
    UNIQUE (id, kind),
  CONSTRAINT content_items_root_fk
    FOREIGN KEY (root_id)
    REFERENCES platform.content_items(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT content_items_parent_fk
    FOREIGN KEY (parent_id)
    REFERENCES platform.content_items(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT content_items_version_positive
    CHECK (version > 0),
  CONSTRAINT content_items_kind
    CHECK (kind IN ('post', 'reply')),
  CONSTRAINT content_items_tree_shape
    CHECK (
      (
        kind = 'post'
        AND root_id = id
        AND parent_id IS NULL
        AND depth = 0
        AND primary_community_id IS NOT NULL
      )
      OR (
        kind = 'reply'
        AND root_id <> id
        AND parent_id IS NOT NULL
        AND depth BETWEEN 1 AND 100
        AND primary_community_id IS NULL
      )
    ),
  CONSTRAINT content_items_lifecycle
    CHECK (lifecycle_state IN ('published', 'deleted')),
  CONSTRAINT content_items_distribution
    CHECK (distribution_state IN ('normal', 'limited', 'hidden')),
  CONSTRAINT content_items_erasure
    CHECK (erasure_state IN ('retained', 'payload_erased')),
  CONSTRAINT content_items_erasure_requires_deletion
    CHECK (erasure_state = 'retained' OR lifecycle_state = 'deleted'),
  CONSTRAINT content_items_deleted_state
    CHECK ((lifecycle_state = 'deleted') = (deleted_at IS NOT NULL)),
  CONSTRAINT content_items_time_order
    CHECK (
      published_at >= created_at
      AND updated_at >= created_at
      AND (deleted_at IS NULL OR deleted_at >= created_at)
    )
);

CREATE INDEX content_items_primary_latest_idx
  ON platform.content_items (primary_community_id, published_at DESC, id DESC)
  WHERE kind = 'post'
    AND lifecycle_state = 'published'
    AND distribution_state <> 'hidden';

CREATE INDEX content_items_root_discussion_idx
  ON platform.content_items (root_id, published_at, id);

CREATE INDEX content_items_parent_discussion_idx
  ON platform.content_items (parent_id, published_at, id)
  WHERE parent_id IS NOT NULL;

CREATE INDEX content_items_author_latest_idx
  ON platform.content_items (author_actor_id, published_at DESC, id DESC);

CREATE INDEX content_items_visible_latest_idx
  ON platform.content_items (published_at DESC, id DESC)
  WHERE lifecycle_state = 'published'
    AND distribution_state <> 'hidden';

CREATE TABLE platform.content_revisions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  content_id uuid NOT NULL,
  revision_number bigint NOT NULL,
  title text,
  body_markdown text NOT NULL,
  body_plain_text text NOT NULL,
  edit_summary text,
  created_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_version bigint NOT NULL,
  content_hash bytea NOT NULL,
  public_node_serialized_bytes integer NOT NULL,
  CONSTRAINT content_revisions_id_content_unique
    UNIQUE (id, content_id),
  CONSTRAINT content_revisions_id_content_actor_unique
    UNIQUE (id, content_id, created_by_actor_id),
  CONSTRAINT content_revisions_id_content_number_unique
    UNIQUE (id, content_id, revision_number),
  CONSTRAINT content_revisions_content_number_unique
    UNIQUE (content_id, revision_number),
  CONSTRAINT content_revisions_content_source_version_unique
    UNIQUE (content_id, source_version),
  CONSTRAINT content_revisions_content_author
    FOREIGN KEY (content_id, created_by_actor_id)
    REFERENCES platform.content_items(id, author_actor_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT content_revisions_number_positive
    CHECK (revision_number > 0),
  CONSTRAINT content_revisions_source_version_positive
    CHECK (source_version > 0),
  CONSTRAINT content_revisions_body_markdown_bytes
    CHECK (
      octet_length(body_markdown) BETWEEN 1 AND 163840
      AND length(body_markdown) > 0
    ),
  CONSTRAINT content_revisions_plain_text_bytes
    CHECK (octet_length(body_plain_text) BETWEEN 1 AND 163840),
  CONSTRAINT content_revisions_edit_summary_size
    CHECK (edit_summary IS NULL OR length(edit_summary) <= 500),
  CONSTRAINT content_revisions_hash_sha256
    CHECK (octet_length(content_hash) = 32),
  CONSTRAINT content_revisions_public_projection_budget
    CHECK (public_node_serialized_bytes BETWEEN 1 AND 786432)
);

ALTER TABLE platform.content_items
  ADD CONSTRAINT content_items_current_revision
  FOREIGN KEY (current_revision_id, id)
  REFERENCES platform.content_revisions(id, content_id)
  ON UPDATE RESTRICT
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX content_revisions_history_idx
  ON platform.content_revisions (content_id, revision_number DESC, id);

COMMENT ON TABLE platform.content_revisions IS
  'Append-only author UGC. Markdown and derived plain text remain explicitly untrusted and are never executable instructions.';

COMMENT ON COLUMN platform.content_revisions.body_plain_text IS
  'Service-derived text for search/accessibility, not sanitized HTML and not an authorization or instruction channel.';

CREATE FUNCTION platform.validate_content_tree()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  parent_row platform.content_items%ROWTYPE;
  root_row platform.content_items%ROWTYPE;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'content_items'
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION
      'Content tree validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.kind = 'post' THEN
    RETURN NEW;
  END IF;

  SELECT parent.*
  INTO parent_row
  FROM platform.content_items AS parent
  WHERE parent.id = NEW.parent_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Reply parent does not exist'
      USING ERRCODE = '23503';
  END IF;

  SELECT root.*
  INTO root_row
  FROM platform.content_items AS root
  WHERE root.id = NEW.root_id
  FOR KEY SHARE;

  IF NOT FOUND
    OR root_row.kind <> 'post'
    OR root_row.root_id <> root_row.id
    OR root_row.parent_id IS NOT NULL
    OR parent_row.root_id <> NEW.root_id
    OR NEW.depth <> parent_row.depth + 1
    OR NEW.depth > 100 THEN
    RAISE EXCEPTION
      'Reply root, parent, or depth is inconsistent'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER content_items_validate_tree
BEFORE INSERT OR UPDATE ON platform.content_items
FOR EACH ROW
EXECUTE FUNCTION platform.validate_content_tree();

REVOKE ALL ON FUNCTION platform.validate_content_tree() FROM PUBLIC;

CREATE FUNCTION platform.prepare_content_item_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  initializes_revision boolean;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'content_items'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Content update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.author_actor_id IS DISTINCT FROM OLD.author_actor_id
    OR NEW.root_id IS DISTINCT FROM OLD.root_id
    OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
    OR NEW.depth IS DISTINCT FROM OLD.depth
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Content identity and discussion position are immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.lifecycle_state = 'deleted'
    AND NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state THEN
    RAISE EXCEPTION
      'Author soft deletion is irreversible'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.erasure_state = 'payload_erased'
    AND NEW.erasure_state IS DISTINCT FROM OLD.erasure_state THEN
    RAISE EXCEPTION
      'Payload erasure is irreversible'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.deleted_at IS NOT NULL
    AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION
      'Content deletion timestamp is immutable'
      USING ERRCODE = '22023';
  END IF;

  initializes_revision :=
    OLD.current_revision_id IS NULL
    AND NEW.current_revision_id IS NOT NULL
    AND NEW.version = OLD.version
    AND NEW.primary_community_id IS NOT DISTINCT FROM OLD.primary_community_id
    AND NEW.lifecycle_state IS NOT DISTINCT FROM OLD.lifecycle_state
    AND NEW.distribution_state IS NOT DISTINCT FROM OLD.distribution_state
    AND NEW.erasure_state IS NOT DISTINCT FROM OLD.erasure_state
    AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at;

  IF initializes_revision THEN
    NEW.updated_at := OLD.updated_at;
    RETURN NEW;
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION
      'Content version must advance exactly by one'
      USING ERRCODE = '40001';
  END IF;

  IF OLD.current_revision_id IS NOT NULL
    AND NEW.current_revision_id IS NULL THEN
    RAISE EXCEPTION
      'Current Revision cannot be cleared'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.lifecycle_state = 'deleted'
    AND NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id THEN
    RAISE EXCEPTION
      'Deleted content cannot receive author revisions'
      USING ERRCODE = '22023';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_items_prepare_update
BEFORE UPDATE ON platform.content_items
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_content_item_update();

REVOKE ALL ON FUNCTION platform.prepare_content_item_update() FROM PUBLIC;

CREATE FUNCTION platform.validate_content_revision_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  content_kind text;
  content_version bigint;
  previous_revision bigint;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'content_revisions'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Revision validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'alphanet:content-revision:' || NEW.content_id::text,
      0
    )
  );

  SELECT content.kind, content.version
  INTO content_kind, content_version
  FROM platform.content_items AS content
  WHERE content.id = NEW.content_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Revision content does not exist'
      USING ERRCODE = '23503';
  END IF;

  SELECT coalesce(max(revision.revision_number), 0)
  INTO previous_revision
  FROM platform.content_revisions AS revision
  WHERE revision.content_id = NEW.content_id;

  IF NEW.revision_number <> previous_revision + 1 THEN
    RAISE EXCEPTION
      'Revision number must start at one and advance exactly by one'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source_version > content_version + 1 THEN
    RAISE EXCEPTION
      'Revision source version is ahead of the content command'
      USING ERRCODE = '23514';
  END IF;

  IF content_kind = 'post' THEN
    IF NEW.title IS NULL
      OR length(NEW.title) NOT BETWEEN 5 AND 200
      OR length(NEW.body_markdown) > 100000 THEN
      RAISE EXCEPTION
        'Post Revision title or body is outside its limits'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.title IS NOT NULL
    OR length(NEW.body_markdown) > 20000 THEN
    RAISE EXCEPTION
      'Reply Revision title or body is outside its limits'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER content_revisions_validate_insert
BEFORE INSERT ON platform.content_revisions
FOR EACH ROW
EXECUTE FUNCTION platform.validate_content_revision_insert();

REVOKE ALL ON FUNCTION platform.validate_content_revision_insert() FROM PUBLIC;

CREATE FUNCTION platform.validate_content_current_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate_id uuid;
  candidate_version bigint;
  candidate_revision_id uuid;
  current_number bigint;
  current_source_version bigint;
  newest_number bigint;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'content_items'
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION
      'Current Revision validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  candidate_id := NEW.id;

  SELECT content.version, content.current_revision_id
  INTO candidate_version, candidate_revision_id
  FROM platform.content_items AS content
  WHERE content.id = candidate_id;

  IF NOT FOUND OR candidate_revision_id IS NULL THEN
    RAISE EXCEPTION
      'Published ContentItem must have a current Revision'
      USING ERRCODE = '23514';
  END IF;

  SELECT revision.revision_number, revision.source_version
  INTO current_number, current_source_version
  FROM platform.content_revisions AS revision
  WHERE revision.id = candidate_revision_id
    AND revision.content_id = candidate_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Current Revision does not belong to its ContentItem'
      USING ERRCODE = '23514';
  END IF;

  SELECT max(revision.revision_number)
  INTO newest_number
  FROM platform.content_revisions AS revision
  WHERE revision.content_id = candidate_id;

  IF current_number <> newest_number
    OR current_source_version > candidate_version THEN
    RAISE EXCEPTION
      'Current Revision must be the newest Revision at a visible content version'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER content_items_validate_current_revision
AFTER INSERT OR UPDATE ON platform.content_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_content_current_revision();

REVOKE ALL ON FUNCTION platform.validate_content_current_revision() FROM PUBLIC;

CREATE FUNCTION platform.prevent_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'Content Revisions are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER content_revisions_prevent_mutation
BEFORE UPDATE OR DELETE ON platform.content_revisions
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_revision_mutation();

REVOKE ALL ON FUNCTION platform.prevent_revision_mutation() FROM PUBLIC;

CREATE FUNCTION platform.prevent_content_item_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'ContentItems use lifecycle tombstones and cannot be physically deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER content_items_prevent_delete
BEFORE DELETE ON platform.content_items
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_content_item_delete();

REVOKE ALL ON FUNCTION platform.prevent_content_item_delete() FROM PUBLIC;

-- Multi-community placement and explicit classifications --------------------

CREATE TABLE platform.content_additional_communities (
  content_id uuid NOT NULL
    REFERENCES platform.content_items(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  community_id uuid NOT NULL
    REFERENCES platform.communities(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  position smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (content_id, community_id),
  CONSTRAINT content_additional_communities_position_unique
    UNIQUE (content_id, position),
  CONSTRAINT content_additional_communities_position
    CHECK (position BETWEEN 1 AND 4)
);

CREATE INDEX content_additional_communities_reverse_idx
  ON platform.content_additional_communities (community_id, content_id);

CREATE FUNCTION platform.validate_additional_community()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  content_kind text;
  primary_id uuid;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'content_additional_communities'
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION
      'Additional-community validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  SELECT content.kind, content.primary_community_id
  INTO content_kind, primary_id
  FROM platform.content_items AS content
  WHERE content.id = NEW.content_id
  FOR KEY SHARE;

  IF NOT FOUND
    OR content_kind <> 'post'
    OR NEW.community_id = primary_id THEN
    RAISE EXCEPTION
      'Only root posts may have distinct additional communities'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER content_additional_communities_validate
BEFORE INSERT OR UPDATE ON platform.content_additional_communities
FOR EACH ROW
EXECUTE FUNCTION platform.validate_additional_community();

REVOKE ALL ON FUNCTION platform.validate_additional_community() FROM PUBLIC;

CREATE TABLE platform.content_symbols (
  content_id uuid NOT NULL
    REFERENCES platform.content_items(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  symbol_id uuid NOT NULL
    REFERENCES platform.symbols(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  position smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (content_id, symbol_id),
  CONSTRAINT content_symbols_position_unique
    UNIQUE (content_id, position),
  CONSTRAINT content_symbols_position
    CHECK (position BETWEEN 1 AND 10)
);

CREATE INDEX content_symbols_reverse_idx
  ON platform.content_symbols (symbol_id, content_id);

CREATE TABLE platform.content_topics (
  content_id uuid NOT NULL
    REFERENCES platform.content_items(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  topic_id uuid NOT NULL
    REFERENCES platform.topics(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  position smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (content_id, topic_id),
  CONSTRAINT content_topics_position_unique
    UNIQUE (content_id, position),
  CONSTRAINT content_topics_position
    CHECK (position BETWEEN 1 AND 5)
);

CREATE INDEX content_topics_reverse_idx
  ON platform.content_topics (topic_id, content_id);

-- Revision-scoped source, reference, and mention facts ----------------------

CREATE TABLE platform.source_links (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  content_id uuid NOT NULL,
  position smallint NOT NULL,
  url text NOT NULL,
  normalized_url_hash bytea NOT NULL,
  title text,
  description text,
  added_revision_id uuid NOT NULL,
  added_by_actor_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  removed_revision_id uuid,
  CONSTRAINT source_links_added_revision
    FOREIGN KEY (added_revision_id, content_id, added_by_actor_id)
    REFERENCES platform.content_revisions(id, content_id, created_by_actor_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT source_links_removed_revision
    FOREIGN KEY (removed_revision_id, content_id)
    REFERENCES platform.content_revisions(id, content_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT source_links_position
    CHECK (position BETWEEN 1 AND 50),
  CONSTRAINT source_links_https_local_validation
    CHECK (
      octet_length(url) BETWEEN 9 AND 2048
      AND url ~ '^https://[^/[:space:][:cntrl:]]+'
      AND url !~ '[[:cntrl:]]'
    ),
  CONSTRAINT source_links_hash_sha256
    CHECK (octet_length(normalized_url_hash) = 32),
  CONSTRAINT source_links_title_size
    CHECK (title IS NULL OR length(title) <= 300),
  CONSTRAINT source_links_description_size
    CHECK (description IS NULL OR length(description) <= 1000)
);

CREATE UNIQUE INDEX source_links_current_url_unique
  ON platform.source_links (content_id, normalized_url_hash)
  WHERE removed_revision_id IS NULL;

CREATE UNIQUE INDEX source_links_current_position_unique
  ON platform.source_links (content_id, position)
  WHERE removed_revision_id IS NULL;

CREATE INDEX source_links_content_history_idx
  ON platform.source_links (content_id, added_revision_id, id);

CREATE INDEX source_links_normalized_url_idx
  ON platform.source_links (normalized_url_hash, content_id);

COMMENT ON TABLE platform.source_links IS
  'Author-provided HTTPS strings. Persistence never performs DNS, HTTP, HEAD, redirect, or preview fetches.';

CREATE TABLE platform.content_relations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  from_content_id uuid NOT NULL
    REFERENCES platform.content_items(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  to_content_id uuid NOT NULL
    REFERENCES platform.content_items(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  position smallint NOT NULL,
  relation_type text NOT NULL,
  added_revision_id uuid NOT NULL,
  removed_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT content_relations_added_revision
    FOREIGN KEY (added_revision_id, from_content_id)
    REFERENCES platform.content_revisions(id, content_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT content_relations_removed_revision
    FOREIGN KEY (removed_revision_id, from_content_id)
    REFERENCES platform.content_revisions(id, content_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT content_relations_no_self_reference
    CHECK (from_content_id <> to_content_id),
  CONSTRAINT content_relations_position
    CHECK (position BETWEEN 1 AND 20),
  CONSTRAINT content_relations_type
    CHECK (relation_type IN ('quote', 'reference'))
);

CREATE UNIQUE INDEX content_relations_current_unique
  ON platform.content_relations (
    from_content_id,
    to_content_id,
    relation_type
  )
  WHERE removed_revision_id IS NULL;

CREATE UNIQUE INDEX content_relations_current_position_unique
  ON platform.content_relations (from_content_id, position)
  WHERE removed_revision_id IS NULL;

CREATE INDEX content_relations_inbound_idx
  ON platform.content_relations (to_content_id, relation_type, from_content_id)
  WHERE removed_revision_id IS NULL;

CREATE TABLE platform.mentions (
  revision_id uuid NOT NULL,
  content_id uuid NOT NULL,
  revision_number bigint NOT NULL,
  mentioned_actor_id uuid NOT NULL
    REFERENCES platform.actors(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  position smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (revision_id, mentioned_actor_id),
  CONSTRAINT mentions_revision
    FOREIGN KEY (revision_id, content_id, revision_number)
    REFERENCES platform.content_revisions(id, content_id, revision_number)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT mentions_position_unique
    UNIQUE (revision_id, position),
  CONSTRAINT mentions_position
    CHECK (position BETWEEN 1 AND 100)
);

CREATE INDEX mentions_actor_content_idx
  ON platform.mentions (mentioned_actor_id, content_id, revision_id);

CREATE FUNCTION platform.prepare_revision_relation_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  added_number bigint;
  removed_number bigint;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME NOT IN ('source_links', 'content_relations')
    OR TG_OP NOT IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION
      'Revision relation mutation guard invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Revision-scoped source and reference facts cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME = 'source_links' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.content_id IS DISTINCT FROM OLD.content_id
      OR NEW.position IS DISTINCT FROM OLD.position
      OR NEW.url IS DISTINCT FROM OLD.url
      OR NEW.normalized_url_hash IS DISTINCT FROM OLD.normalized_url_hash
      OR NEW.title IS DISTINCT FROM OLD.title
      OR NEW.description IS DISTINCT FROM OLD.description
      OR NEW.added_revision_id IS DISTINCT FROM OLD.added_revision_id
      OR NEW.added_by_actor_id IS DISTINCT FROM OLD.added_by_actor_id
      OR NEW.added_at IS DISTINCT FROM OLD.added_at
      OR OLD.removed_revision_id IS NOT NULL
      OR NEW.removed_revision_id IS NULL THEN
      RAISE EXCEPTION
        'SourceLink is immutable except for one removal Revision'
        USING ERRCODE = '55000';
    END IF;

    SELECT revision.revision_number
    INTO added_number
    FROM platform.content_revisions AS revision
    WHERE revision.id = NEW.added_revision_id;

    SELECT revision.revision_number
    INTO removed_number
    FROM platform.content_revisions AS revision
    WHERE revision.id = NEW.removed_revision_id;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.from_content_id IS DISTINCT FROM OLD.from_content_id
      OR NEW.to_content_id IS DISTINCT FROM OLD.to_content_id
      OR NEW.position IS DISTINCT FROM OLD.position
      OR NEW.relation_type IS DISTINCT FROM OLD.relation_type
      OR NEW.added_revision_id IS DISTINCT FROM OLD.added_revision_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR OLD.removed_revision_id IS NOT NULL
      OR NEW.removed_revision_id IS NULL THEN
      RAISE EXCEPTION
        'ContentRelation is immutable except for one removal Revision'
        USING ERRCODE = '55000';
    END IF;

    SELECT revision.revision_number
    INTO added_number
    FROM platform.content_revisions AS revision
    WHERE revision.id = NEW.added_revision_id;

    SELECT revision.revision_number
    INTO removed_number
    FROM platform.content_revisions AS revision
    WHERE revision.id = NEW.removed_revision_id;
  END IF;

  IF removed_number <= added_number THEN
    RAISE EXCEPTION
      'Removal Revision must follow the addition Revision'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER source_links_prepare_update
BEFORE UPDATE OR DELETE ON platform.source_links
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_revision_relation_update();

CREATE TRIGGER content_relations_prepare_update
BEFORE UPDATE OR DELETE ON platform.content_relations
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_revision_relation_update();

REVOKE ALL ON FUNCTION platform.prepare_revision_relation_update() FROM PUBLIC;

CREATE FUNCTION platform.prevent_mention_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'Revision mentions are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER mentions_prevent_mutation
BEFORE UPDATE OR DELETE ON platform.mentions
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_mention_mutation();

REVOKE ALL ON FUNCTION platform.prevent_mention_mutation() FROM PUBLIC;

-- Principal-scoped idempotency ----------------------------------------------

CREATE TABLE platform.idempotency_records (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  principal_scope_key text NOT NULL,
  owner_id uuid NOT NULL
    REFERENCES platform.owners(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  agent_id uuid,
  actor_id uuid NOT NULL,
  credential_id uuid,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest bytea NOT NULL,
  status text NOT NULL,
  response_code integer,
  response_body jsonb,
  resource_id uuid,
  first_received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  terminal_at timestamptz,
  expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_records_principal_operation_key_unique
    UNIQUE (principal_scope_key, operation, idempotency_key),
  CONSTRAINT idempotency_records_id_chain_unique
    UNIQUE (
      id,
      principal_scope_key,
      operation,
      idempotency_key,
      request_digest
    ),
  CONSTRAINT idempotency_records_actor_owner
    FOREIGN KEY (actor_id, owner_id)
    REFERENCES platform.actors(id, owner_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT idempotency_records_agent_owner
    FOREIGN KEY (agent_id, owner_id)
    REFERENCES platform.agents(id, owner_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT idempotency_records_credential_chain
    FOREIGN KEY (credential_id, owner_id, agent_id)
    REFERENCES platform.credentials(id, owner_id, agent_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT idempotency_records_principal_size
    CHECK (length(principal_scope_key) BETWEEN 12 AND 160),
  CONSTRAINT idempotency_records_operation
    CHECK (
      operation IN (
        'create_post',
        'reply_to_content',
        'update_content',
        'delete_content',
        'set_reaction',
        'set_follow'
      )
    ),
  CONSTRAINT idempotency_records_key_size
    CHECK (
      length(idempotency_key) BETWEEN 1 AND 200
      AND idempotency_key !~ '[[:cntrl:]]'
    ),
  CONSTRAINT idempotency_records_digest_sha256
    CHECK (octet_length(request_digest) = 32),
  CONSTRAINT idempotency_records_status
    CHECK (
      status IN (
        'admission_reserved',
        'in_progress',
        'pending_approval',
        'succeeded',
        'denied',
        'failed'
      )
    ),
  CONSTRAINT idempotency_records_response_code
    CHECK (response_code IS NULL OR response_code BETWEEN 100 AND 599),
  CONSTRAINT idempotency_records_response_object
    CHECK (
      response_body IS NULL
      OR (
        jsonb_typeof(response_body) = 'object'
        AND pg_column_size(response_body) <= 1048576
        AND platform.audit_json_is_secret_free_v2(response_body)
      )
    ),
  CONSTRAINT idempotency_records_terminal_shape
    CHECK (
      (
        status IN ('admission_reserved', 'in_progress', 'pending_approval')
        AND terminal_at IS NULL
      )
      OR (
        status IN ('succeeded', 'denied', 'failed')
        AND terminal_at IS NOT NULL
      )
    ),
  CONSTRAINT idempotency_records_retention
    CHECK (
      expires_at >= first_received_at + interval '7 days'
      AND (terminal_at IS NULL OR expires_at >= terminal_at + interval '7 days')
    ),
  CONSTRAINT idempotency_records_time_order
    CHECK (
      updated_at >= first_received_at
      AND (terminal_at IS NULL OR terminal_at >= first_received_at)
    )
);

CREATE INDEX idempotency_records_expiry_idx
  ON platform.idempotency_records (expires_at, id);

CREATE INDEX idempotency_records_principal_status_idx
  ON platform.idempotency_records (
    principal_scope_key,
    status,
    first_received_at DESC,
    id
  );

COMMENT ON COLUMN platform.idempotency_records.response_body IS
  'Replay envelope limited to IDs, enums, safe errors, and status metadata; raw UGC and credentials are forbidden.';

CREATE FUNCTION platform.validate_idempotency_principal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor_kind text;
  agent_actor_id uuid;
  expected_key text;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'idempotency_records'
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION
      'Idempotency principal validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  SELECT actor.kind
  INTO actor_kind
  FROM platform.actors AS actor
  WHERE actor.id = NEW.actor_id
    AND actor.owner_id = NEW.owner_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Idempotency Actor does not belong to Owner'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.credential_id IS NOT NULL THEN
    SELECT agent.actor_id
    INTO agent_actor_id
    FROM platform.agents AS agent
    WHERE agent.id = NEW.agent_id
      AND agent.owner_id = NEW.owner_id;

    expected_key := 'credential:' || NEW.credential_id::text;

    IF actor_kind <> 'agent'
      OR agent_actor_id IS DISTINCT FROM NEW.actor_id
      OR NEW.principal_scope_key <> expected_key THEN
      RAISE EXCEPTION
        'Credential idempotency scope is inconsistent'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.agent_id IS NOT NULL THEN
    SELECT agent.actor_id
    INTO agent_actor_id
    FROM platform.agents AS agent
    WHERE agent.id = NEW.agent_id
      AND agent.owner_id = NEW.owner_id;

    expected_key :=
      'owner_direct:' || NEW.owner_id::text || ':' || NEW.agent_id::text;

    IF actor_kind <> 'agent'
      OR agent_actor_id IS DISTINCT FROM NEW.actor_id
      OR NEW.principal_scope_key <> expected_key THEN
      RAISE EXCEPTION
        'Owner-direct idempotency scope is inconsistent'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    expected_key :=
      'human_web:' || NEW.owner_id::text || ':' || NEW.actor_id::text;

    IF actor_kind <> 'human'
      OR NEW.principal_scope_key <> expected_key THEN
      RAISE EXCEPTION
        'Human-Web idempotency scope is inconsistent'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER idempotency_records_validate_principal
BEFORE INSERT OR UPDATE ON platform.idempotency_records
FOR EACH ROW
EXECUTE FUNCTION platform.validate_idempotency_principal();

REVOKE ALL ON FUNCTION platform.validate_idempotency_principal() FROM PUBLIC;

CREATE FUNCTION platform.prepare_idempotency_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'idempotency_records'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Idempotency update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.principal_scope_key IS DISTINCT FROM OLD.principal_scope_key
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
    OR NEW.operation IS DISTINCT FROM OLD.operation
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.first_received_at IS DISTINCT FROM OLD.first_received_at
    OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
      AND OLD.resource_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Idempotency request identity is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.terminal_at IS NOT NULL
    AND (
      NEW.status IS DISTINCT FROM OLD.status
      OR NEW.terminal_at IS DISTINCT FROM OLD.terminal_at
      OR NEW.response_code IS DISTINCT FROM OLD.response_code
      OR NEW.response_body IS DISTINCT FROM OLD.response_body
      OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
    ) THEN
    RAISE EXCEPTION
      'Terminal idempotency result is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.terminal_at IS NULL
    AND NEW.status IS DISTINCT FROM OLD.status
    AND NOT (
      (OLD.status = 'admission_reserved'
        AND NEW.status IN (
          'in_progress',
          'pending_approval',
          'succeeded',
          'denied',
          'failed'
        ))
      OR (OLD.status = 'in_progress'
        AND NEW.status IN ('pending_approval', 'succeeded', 'denied', 'failed'))
      OR (OLD.status = 'pending_approval'
        AND NEW.status IN ('succeeded', 'denied', 'failed'))
    ) THEN
    RAISE EXCEPTION
      'Illegal idempotency status transition'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.expires_at < OLD.expires_at THEN
    RAISE EXCEPTION
      'Idempotency retention cannot be shortened'
      USING ERRCODE = '22023';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER idempotency_records_prepare_update
BEFORE UPDATE ON platform.idempotency_records
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_idempotency_update();

REVOKE ALL ON FUNCTION platform.prepare_idempotency_update() FROM PUBLIC;

-- Frozen PendingAction commands ---------------------------------------------

ALTER TABLE platform.agent_policies
  ADD CONSTRAINT agent_policies_id_agent_version_unique
  UNIQUE (id, agent_id, version);

CREATE TABLE platform.pending_actions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  version bigint NOT NULL DEFAULT 1,
  owner_id uuid NOT NULL
    REFERENCES platform.owners(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  agent_id uuid NOT NULL,
  credential_id uuid NOT NULL,
  principal_scope_key text NOT NULL,
  operation text NOT NULL,
  target_type text,
  target_id uuid,
  normalized_input_ciphertext bytea NOT NULL,
  normalized_input_nonce bytea NOT NULL,
  normalized_input_key_version smallint NOT NULL,
  normalized_input_format_version smallint NOT NULL DEFAULT 1,
  input_digest bytea NOT NULL,
  idempotency_key text NOT NULL,
  idempotency_record_id uuid NOT NULL,
  expected_version bigint,
  decision_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  policy_version bigint NOT NULL,
  policy_snapshot jsonb NOT NULL,
  approval_summary text NOT NULL,
  state text NOT NULL DEFAULT 'pending_approval',
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by_owner_id uuid
    REFERENCES platform.owners(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  approval_method text,
  lease_owner text,
  lease_token_digest bytea,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  executing_at timestamptz,
  completed_at timestamptz,
  terminal_at timestamptz,
  result jsonb,
  error jsonb,
  audit_id uuid NOT NULL
    REFERENCES platform.action_logs(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pending_actions_agent_owner
    FOREIGN KEY (agent_id, owner_id)
    REFERENCES platform.agents(id, owner_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT pending_actions_credential_chain
    FOREIGN KEY (credential_id, owner_id, agent_id)
    REFERENCES platform.credentials(id, owner_id, agent_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT pending_actions_policy
    FOREIGN KEY (policy_id, agent_id, policy_version)
    REFERENCES platform.agent_policies(id, agent_id, version)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT pending_actions_idempotency_record
    FOREIGN KEY (
      idempotency_record_id,
      principal_scope_key,
      operation,
      idempotency_key,
      input_digest
    )
    REFERENCES platform.idempotency_records(
      id,
      principal_scope_key,
      operation,
      idempotency_key,
      request_digest
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT pending_actions_idempotency_record_unique
    UNIQUE (idempotency_record_id),
  CONSTRAINT pending_actions_principal_operation_key_unique
    UNIQUE (principal_scope_key, operation, idempotency_key),
  CONSTRAINT pending_actions_version_positive
    CHECK (version > 0),
  CONSTRAINT pending_actions_principal_credential
    CHECK (principal_scope_key = 'credential:' || credential_id::text),
  CONSTRAINT pending_actions_operation
    CHECK (
      operation IN (
        'create_post',
        'reply_to_content',
        'update_content',
        'delete_content',
        'set_reaction',
        'set_follow'
      )
    ),
  CONSTRAINT pending_actions_target_shape
    CHECK (
      (target_type IS NULL AND target_id IS NULL)
      OR (
        target_type IN ('community', 'content', 'actor', 'symbol', 'topic')
        AND target_id IS NOT NULL
      )
    ),
  CONSTRAINT pending_actions_ciphertext_shape
    CHECK (
      octet_length(normalized_input_ciphertext) BETWEEN 17 AND 1048576
      AND octet_length(normalized_input_nonce) = 12
      AND normalized_input_key_version > 0
      AND normalized_input_format_version > 0
    ),
  CONSTRAINT pending_actions_digest_sha256
    CHECK (octet_length(input_digest) = 32),
  CONSTRAINT pending_actions_idempotency_key_size
    CHECK (
      length(idempotency_key) BETWEEN 1 AND 200
      AND idempotency_key !~ '[[:cntrl:]]'
    ),
  CONSTRAINT pending_actions_expected_version
    CHECK (
      (
        operation IN ('update_content', 'delete_content')
        AND expected_version IS NOT NULL
        AND expected_version > 0
      )
      OR (
        operation NOT IN ('update_content', 'delete_content')
        AND expected_version IS NULL
      )
    ),
  CONSTRAINT pending_actions_policy_version_positive
    CHECK (policy_version > 0),
  CONSTRAINT pending_actions_policy_snapshot
    CHECK (
      jsonb_typeof(policy_snapshot) = 'object'
      AND pg_column_size(policy_snapshot) <= 65536
      AND platform.audit_json_is_secret_free_v2(policy_snapshot)
    ),
  CONSTRAINT pending_actions_approval_summary
    CHECK (
      length(btrim(approval_summary)) BETWEEN 1 AND 2000
      AND approval_summary !~ '[[:cntrl:]]'
    ),
  CONSTRAINT pending_actions_state
    CHECK (
      state IN (
        'pending_approval',
        'approved',
        'executing',
        'succeeded',
        'rejected',
        'expired',
        'cancelled',
        'failed',
        'invalidated'
      )
    ),
  CONSTRAINT pending_actions_owner_decision
    CHECK (
      (
        decided_at IS NULL
        AND decided_by_owner_id IS NULL
        AND approval_method IS NULL
      )
      OR (
        decided_at IS NOT NULL
        AND decided_by_owner_id = owner_id
        AND approval_method = 'owner_approval'
      )
    ),
  CONSTRAINT pending_actions_lease_shape
    CHECK (
      (
        lease_owner IS NULL
        AND lease_token_digest IS NULL
        AND lease_expires_at IS NULL
      )
      OR (
        state = 'executing'
        AND length(btrim(lease_owner)) BETWEEN 1 AND 200
        AND octet_length(lease_token_digest) = 32
        AND lease_expires_at IS NOT NULL
      )
    ),
  CONSTRAINT pending_actions_attempts
    CHECK (attempt_count BETWEEN 0 AND 20),
  CONSTRAINT pending_actions_result_object
    CHECK (
      result IS NULL
      OR (
        jsonb_typeof(result) = 'object'
        AND pg_column_size(result) <= 65536
        AND platform.audit_json_is_secret_free_v2(result)
      )
    ),
  CONSTRAINT pending_actions_error_object
    CHECK (
      error IS NULL
      OR (
        jsonb_typeof(error) = 'object'
        AND pg_column_size(error) <= 65536
        AND platform.audit_json_is_secret_free_v2(error)
      )
    ),
  CONSTRAINT pending_actions_state_shape
    CHECK (
      (
        state = 'pending_approval'
        AND decided_at IS NULL
        AND executing_at IS NULL
        AND completed_at IS NULL
        AND terminal_at IS NULL
        AND result IS NULL
        AND error IS NULL
        AND last_heartbeat_at IS NULL
        AND attempt_count = 0
        AND next_attempt_at IS NULL
      )
      OR (
        state = 'approved'
        AND decided_at IS NOT NULL
        AND executing_at IS NULL
        AND completed_at IS NULL
        AND terminal_at IS NULL
        AND result IS NULL
        AND error IS NULL
        AND last_heartbeat_at IS NULL
      )
      OR (
        state = 'executing'
        AND decided_at IS NOT NULL
        AND executing_at IS NOT NULL
        AND completed_at IS NULL
        AND terminal_at IS NULL
        AND result IS NULL
        AND error IS NULL
        AND last_heartbeat_at IS NOT NULL
        AND attempt_count > 0
        AND next_attempt_at IS NULL
      )
      OR (
        state = 'succeeded'
        AND decided_at IS NOT NULL
        AND executing_at IS NOT NULL
        AND completed_at IS NOT NULL
        AND terminal_at IS NOT NULL
        AND result IS NOT NULL
        AND error IS NULL
        AND last_heartbeat_at IS NOT NULL
        AND attempt_count > 0
        AND next_attempt_at IS NULL
      )
      OR (
        state = 'failed'
        AND decided_at IS NOT NULL
        AND executing_at IS NOT NULL
        AND completed_at IS NOT NULL
        AND terminal_at IS NOT NULL
        AND result IS NULL
        AND error IS NOT NULL
        AND last_heartbeat_at IS NOT NULL
        AND attempt_count > 0
        AND next_attempt_at IS NULL
      )
      OR (
        state IN ('rejected', 'cancelled')
        AND decided_at IS NOT NULL
        AND executing_at IS NULL
        AND completed_at IS NULL
        AND terminal_at IS NOT NULL
        AND result IS NULL
        AND error IS NOT NULL
        AND last_heartbeat_at IS NULL
        AND attempt_count = 0
        AND next_attempt_at IS NULL
      )
      OR (
        state IN ('expired', 'invalidated')
        AND executing_at IS NULL
        AND completed_at IS NULL
        AND terminal_at IS NOT NULL
        AND result IS NULL
        AND error IS NOT NULL
        AND last_heartbeat_at IS NULL
        AND next_attempt_at IS NULL
      )
    ),
  CONSTRAINT pending_actions_time_order
    CHECK (
      expires_at > requested_at
      AND updated_at >= requested_at
      AND (decided_at IS NULL OR decided_at >= requested_at)
      AND (executing_at IS NULL OR executing_at >= requested_at)
      AND (completed_at IS NULL OR completed_at >= executing_at)
      AND (terminal_at IS NULL OR terminal_at >= requested_at)
      AND (lease_expires_at IS NULL OR lease_expires_at > executing_at)
      AND (last_heartbeat_at IS NULL OR last_heartbeat_at >= executing_at)
      AND (next_attempt_at IS NULL OR next_attempt_at >= requested_at)
    )
);

CREATE INDEX pending_actions_owner_queue_idx
  ON platform.pending_actions (owner_id, state, requested_at, id)
  WHERE state IN ('pending_approval', 'approved');

CREATE INDEX pending_actions_agent_history_idx
  ON platform.pending_actions (owner_id, agent_id, requested_at DESC, id DESC);

CREATE INDEX pending_actions_worker_idx
  ON platform.pending_actions (state, next_attempt_at, expires_at, id)
  WHERE state IN ('pending_approval', 'approved', 'executing');

COMMENT ON COLUMN platform.pending_actions.normalized_input_ciphertext IS
  'Authenticated encryption of the frozen normalized command. Raw Markdown, source descriptions, and other UGC are never stored in plaintext PendingAction metadata.';

COMMENT ON COLUMN platform.pending_actions.approval_summary IS
  'Fixed-template plain text only. Web clients must render it as text, never Markdown or HTML; full preview is produced after authorized decryption.';

CREATE FUNCTION platform.prepare_pending_action_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'pending_actions'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'PendingAction update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
    OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
    OR NEW.principal_scope_key IS DISTINCT FROM OLD.principal_scope_key
    OR NEW.operation IS DISTINCT FROM OLD.operation
    OR NEW.target_type IS DISTINCT FROM OLD.target_type
    OR NEW.target_id IS DISTINCT FROM OLD.target_id
    OR NEW.normalized_input_ciphertext IS DISTINCT FROM OLD.normalized_input_ciphertext
    OR NEW.normalized_input_nonce IS DISTINCT FROM OLD.normalized_input_nonce
    OR NEW.normalized_input_key_version IS DISTINCT FROM OLD.normalized_input_key_version
    OR NEW.normalized_input_format_version IS DISTINCT FROM OLD.normalized_input_format_version
    OR NEW.input_digest IS DISTINCT FROM OLD.input_digest
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.idempotency_record_id IS DISTINCT FROM OLD.idempotency_record_id
    OR NEW.expected_version IS DISTINCT FROM OLD.expected_version
    OR NEW.decision_id IS DISTINCT FROM OLD.decision_id
    OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
    OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
    OR NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot
    OR NEW.approval_summary IS DISTINCT FROM OLD.approval_summary
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.audit_id IS DISTINCT FROM OLD.audit_id THEN
    RAISE EXCEPTION
      'PendingAction frozen command and authority snapshot are immutable'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION
      'PendingAction version must advance exactly by one'
      USING ERRCODE = '40001';
  END IF;

  IF OLD.terminal_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Terminal PendingAction is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.decided_at IS NOT NULL
    AND (
      NEW.decided_at IS DISTINCT FROM OLD.decided_at
      OR NEW.decided_by_owner_id IS DISTINCT FROM OLD.decided_by_owner_id
      OR NEW.approval_method IS DISTINCT FROM OLD.approval_method
    ) THEN
    RAISE EXCEPTION
      'PendingAction Owner decision evidence is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.executing_at IS NOT NULL
    AND NEW.executing_at IS DISTINCT FROM OLD.executing_at THEN
    RAISE EXCEPTION
      'PendingAction execution start is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.completed_at IS NOT NULL
    AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION
      'PendingAction completion time is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.terminal_at IS NOT NULL
    AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at THEN
    RAISE EXCEPTION
      'PendingAction terminal time is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.attempt_count < OLD.attempt_count
    OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION
      'PendingAction attempt count must be monotonic and bounded per transition'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.last_heartbeat_at IS NOT NULL
    AND (
      NEW.last_heartbeat_at IS NULL
      OR NEW.last_heartbeat_at < OLD.last_heartbeat_at
    ) THEN
    RAISE EXCEPTION
      'PendingAction heartbeat is monotonic'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state
    AND NOT (
      (OLD.state = 'pending_approval'
        AND NEW.state IN (
          'approved',
          'rejected',
          'expired',
          'cancelled',
          'invalidated'
        ))
      OR (OLD.state = 'approved'
        AND NEW.state IN (
          'executing',
          'expired',
          'cancelled',
          'invalidated'
        ))
      OR (OLD.state = 'executing'
        AND NEW.state IN ('succeeded', 'failed'))
    ) THEN
    RAISE EXCEPTION
      'Illegal PendingAction state transition'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state IS NOT DISTINCT FROM OLD.state
    AND NEW.state NOT IN ('approved', 'executing') THEN
    RAISE EXCEPTION
      'Only approved retry scheduling and executing lease heartbeats may update in place'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state IS NOT DISTINCT FROM OLD.state
    AND NEW.state = 'approved'
    AND (
      NEW.decided_at IS DISTINCT FROM OLD.decided_at
      OR NEW.decided_by_owner_id IS DISTINCT FROM OLD.decided_by_owner_id
      OR NEW.approval_method IS DISTINCT FROM OLD.approval_method
      OR NEW.executing_at IS DISTINCT FROM OLD.executing_at
      OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
      OR NEW.terminal_at IS DISTINCT FROM OLD.terminal_at
      OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
      OR NEW.lease_token_digest IS DISTINCT FROM OLD.lease_token_digest
      OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
      OR NEW.last_heartbeat_at IS DISTINCT FROM OLD.last_heartbeat_at
      OR NEW.result IS DISTINCT FROM OLD.result
      OR NEW.error IS DISTINCT FROM OLD.error
    ) THEN
    RAISE EXCEPTION
      'Approved PendingAction updates are limited to retry scheduling'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.state IS NOT DISTINCT FROM OLD.state
    AND NEW.state = 'executing'
    AND (
      NEW.decided_at IS DISTINCT FROM OLD.decided_at
      OR NEW.decided_by_owner_id IS DISTINCT FROM OLD.decided_by_owner_id
      OR NEW.approval_method IS DISTINCT FROM OLD.approval_method
      OR NEW.executing_at IS DISTINCT FROM OLD.executing_at
      OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
      OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
      OR NEW.terminal_at IS DISTINCT FROM OLD.terminal_at
      OR NEW.result IS DISTINCT FROM OLD.result
      OR NEW.error IS DISTINCT FROM OLD.error
    ) THEN
    RAISE EXCEPTION
      'Executing PendingAction updates are limited to fenced lease heartbeats'
      USING ERRCODE = '22023';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER pending_actions_prepare_update
BEFORE UPDATE ON platform.pending_actions
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_pending_action_update();

REVOKE ALL ON FUNCTION platform.prepare_pending_action_update() FROM PUBLIC;

CREATE FUNCTION platform.prevent_pending_action_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'PendingActions are durable authorization evidence and cannot be deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER pending_actions_prevent_delete
BEFORE DELETE ON platform.pending_actions
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_pending_action_delete();

REVOKE ALL ON FUNCTION platform.prevent_pending_action_delete() FROM PUBLIC;
