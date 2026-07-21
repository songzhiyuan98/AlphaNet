SET LOCAL search_path = pg_catalog;

-- Author revision writes ---------------------------------------------------
--
-- 000006 made Revision rows append-only and serialized their numbers, but a
-- direct writer could still commit a newer orphan Revision without touching
-- ContentItem (and therefore without firing its deferred current-pointer
-- constraint). It also allowed a Revision source_version older than the next
-- command version. This forward migration closes both gaps while preserving
-- classification-only ContentItem version advances that intentionally do not
-- create a new author Revision.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM platform.content_items AS content
    LEFT JOIN platform.content_revisions AS current_revision
      ON current_revision.id = content.current_revision_id
     AND current_revision.content_id = content.id
    LEFT JOIN LATERAL (
      SELECT revision.id, revision.revision_number
      FROM platform.content_revisions AS revision
      WHERE revision.content_id = content.id
      ORDER BY revision.revision_number DESC, revision.id DESC
      LIMIT 1
    ) AS newest_revision ON true
    WHERE current_revision.id IS NULL
       OR newest_revision.id IS DISTINCT FROM current_revision.id
       OR current_revision.source_version > content.version
  ) THEN
    RAISE EXCEPTION
      'Existing Content Revision pointers are inconsistent; repair with a reviewed forward migration'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION platform.prepare_content_item_update()
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
    OR NEW.primary_community_id IS DISTINCT FROM OLD.primary_community_id
    OR NEW.root_id IS DISTINCT FROM OLD.root_id
    OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
    OR NEW.depth IS DISTINCT FROM OLD.depth
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Content identity, primary Community, and discussion position are immutable'
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

REVOKE ALL ON FUNCTION platform.prepare_content_item_update() FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform.validate_content_revision_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  content_kind text;
  content_version bigint;
  content_current_revision_id uuid;
  content_lifecycle_state text;
  previous_revision_id uuid;
  previous_revision_number bigint;
  expected_revision_number bigint;
  expected_source_version bigint;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'content_revisions'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Revision validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    content.kind,
    content.version,
    content.current_revision_id,
    content.lifecycle_state
  INTO
    content_kind,
    content_version,
    content_current_revision_id,
    content_lifecycle_state
  FROM platform.content_items AS content
  WHERE content.id = NEW.content_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Revision content does not exist'
      USING ERRCODE = '23503';
  END IF;

  -- ContentItem is the first serialization point used by the application.
  -- Acquire the legacy per-content advisory lock only after that row lock so
  -- direct SQL and the service cannot form an inverse lock order.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'alphanet:content-revision:' || NEW.content_id::text,
      0
    )
  );

  IF content_lifecycle_state = 'deleted' THEN
    RAISE EXCEPTION
      'Deleted content cannot receive author revisions'
      USING ERRCODE = '55000';
  END IF;

  SELECT revision.id, revision.revision_number
  INTO previous_revision_id, previous_revision_number
  FROM platform.content_revisions AS revision
  WHERE revision.content_id = NEW.content_id
  ORDER BY revision.revision_number DESC, revision.id DESC
  LIMIT 1;

  IF content_current_revision_id IS NULL THEN
    IF previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION
        'Initial Revision cannot follow an unpointed Revision'
        USING ERRCODE = '23514';
    END IF;
    IF content_version <> 1 THEN
      RAISE EXCEPTION
        'Initial Content and Revision version must be one'
        USING ERRCODE = '23514';
    END IF;
    expected_revision_number := 1;
    expected_source_version := 1;
  ELSE
    IF previous_revision_id IS NULL
      OR previous_revision_id IS DISTINCT FROM content_current_revision_id THEN
      RAISE EXCEPTION
        'Current Revision must be the newest Revision before an edit'
        USING ERRCODE = '23514';
    END IF;
    expected_revision_number := previous_revision_number + 1;
    expected_source_version := content_version + 1;
  END IF;

  IF NEW.revision_number <> expected_revision_number THEN
    RAISE EXCEPTION
      'Revision number must start at one and advance exactly by one'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source_version <> expected_source_version THEN
    RAISE EXCEPTION
      'Revision source version must equal the Content command version'
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

REVOKE ALL ON FUNCTION platform.validate_content_revision_insert() FROM PUBLIC;

-- The existing ContentItem constraint still protects classification-only
-- version changes. Binding the same deferred validator to every new Revision
-- makes it impossible to commit a Revision unless ContentItem points at the
-- newest Revision by transaction end.
CREATE OR REPLACE FUNCTION platform.validate_content_current_revision()
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
  IF TG_TABLE_SCHEMA = 'platform'
    AND TG_TABLE_NAME = 'content_items'
    AND TG_OP IN ('INSERT', 'UPDATE') THEN
    candidate_id := NEW.id;
  ELSIF TG_TABLE_SCHEMA = 'platform'
    AND TG_TABLE_NAME = 'content_revisions'
    AND TG_OP = 'INSERT' THEN
    candidate_id := NEW.content_id;
  ELSE
    RAISE EXCEPTION
      'Current Revision validator invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  SELECT content.version, content.current_revision_id
  INTO candidate_version, candidate_revision_id
  FROM platform.content_items AS content
  WHERE content.id = candidate_id;

  IF NOT FOUND OR candidate_revision_id IS NULL THEN
    RAISE EXCEPTION
      'ContentItem must have a current Revision at transaction end'
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

REVOKE ALL ON FUNCTION platform.validate_content_current_revision() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER content_revisions_validate_current_pointer
AFTER INSERT ON platform.content_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_content_current_revision();

-- Revision-window facts ----------------------------------------------------
--
-- A removal closes one immutable fact exactly once. It must reference the
-- newest Revision inserted by the active edit transaction, while ContentItem
-- still points to the previous Revision. This ordering prevents a later
-- statement from retroactively closing a fact under an already-published
-- Revision ID.

CREATE OR REPLACE FUNCTION platform.prepare_revision_relation_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate_content_id uuid;
  added_revision_id uuid;
  removed_revision_id uuid;
  added_number bigint;
  removed_number bigint;
  removed_source_version bigint;
  newest_revision_id uuid;
  content_current_revision_id uuid;
  content_version bigint;
  content_lifecycle_state text;
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

    candidate_content_id := NEW.content_id;
    added_revision_id := NEW.added_revision_id;
    removed_revision_id := NEW.removed_revision_id;
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

    candidate_content_id := NEW.from_content_id;
    added_revision_id := NEW.added_revision_id;
    removed_revision_id := NEW.removed_revision_id;
  END IF;

  SELECT revision.revision_number
  INTO added_number
  FROM platform.content_revisions AS revision
  WHERE revision.id = added_revision_id
    AND revision.content_id = candidate_content_id;

  SELECT revision.revision_number, revision.source_version
  INTO removed_number, removed_source_version
  FROM platform.content_revisions AS revision
  WHERE revision.id = removed_revision_id
    AND revision.content_id = candidate_content_id;

  IF added_number IS NULL OR removed_number IS NULL THEN
    RAISE EXCEPTION
      'Revision-scoped fact must use Revisions from its ContentItem'
      USING ERRCODE = '23514';
  END IF;

  IF removed_number <= added_number THEN
    RAISE EXCEPTION
      'Removal Revision must follow the addition Revision'
      USING ERRCODE = '23514';
  END IF;

  SELECT revision.id
  INTO newest_revision_id
  FROM platform.content_revisions AS revision
  WHERE revision.content_id = candidate_content_id
  ORDER BY revision.revision_number DESC, revision.id DESC
  LIMIT 1;

  SELECT
    content.current_revision_id,
    content.version,
    content.lifecycle_state
  INTO
    content_current_revision_id,
    content_version,
    content_lifecycle_state
  FROM platform.content_items AS content
  WHERE content.id = candidate_content_id
  FOR KEY SHARE;

  IF content_lifecycle_state <> 'published'
    OR removed_revision_id IS DISTINCT FROM newest_revision_id
    OR removed_revision_id IS NOT DISTINCT FROM content_current_revision_id
    OR removed_source_version <> content_version + 1 THEN
    RAISE EXCEPTION
      'Removal Revision must be the in-progress newest author Revision'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION platform.prepare_revision_relation_update() FROM PUBLIC;

-- Additional-Community admission time, rather than the ContentItem creation
-- time, governs per-Community anti-spam windows when an older post is newly
-- distributed into another Community.
CREATE INDEX content_additional_communities_admission_rate_idx
  ON platform.content_additional_communities (
    community_id,
    created_at DESC,
    content_id
  );

-- Runtime content-write provenance -----------------------------------------
--
-- Runtime needs narrowly-scoped row privileges because one logical content
-- command spans several tables. Raw table grants alone must not allow a
-- caller to attach facts to an already-published Revision or silently replace
-- placement/classification rows. At transaction end every Runtime content
-- mutation therefore has to belong to the same complete command bundle:
--
--   ContentItem write + Outbox event + succeeded ActionLog + succeeded
--   IdempotencyRecord.
--
-- This is intentionally a SECURITY INVOKER constraint trigger. The effective
-- role which issued the DML, rather than the function owner, decides whether
-- the migration-owner/superuser bypass applies. Runtime cannot SET ROLE to the
-- owner under the AWS role-membership verifier.

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
  is_initial_write boolean;
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
        IF NEW.version <> 1 THEN
          RAISE EXCEPTION
            'Runtime ContentItem must begin at version one'
            USING ERRCODE = '23514';
        END IF;
      ELSE
        initializes_revision :=
          OLD.version = 1
          AND NEW.version = 1
          AND OLD.current_revision_id IS NULL
          AND NEW.current_revision_id IS NOT NULL;
        IF NOT initializes_revision
          AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION
            'Runtime ContentItem update must advance exactly one version'
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
    content.version,
    content.xmin,
    revision.revision_number,
    revision.source_version,
    revision.xmin
  INTO
    content_author_actor_id,
    content_current_revision_id,
    content_kind,
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

  is_initial_write :=
    content_version = 1
    AND current_revision_number = 1
    AND current_revision_source_version = 1;
  is_revision_write :=
    is_initial_write
    OR current_revision_source_version = content_version;

  IF is_revision_write
    AND current_revision_xid IS DISTINCT FROM content_xid THEN
    RAISE EXCEPTION
      'Runtime author Revision must share the ContentItem transaction id'
      USING ERRCODE = '23514';
  END IF;

  IF is_initial_write THEN
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
          is_initial_write
          AND event.payload ->> 'kind' = content_kind
          AND event.payload ->> 'revision_id' = content_current_revision_id::text
        )
        OR (
          NOT is_initial_write
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
                (
                  expected_operation = 'update_content'
                  AND action.expected_version = content_version - 1
                )
                OR (
                  expected_operation <> 'update_content'
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

CREATE CONSTRAINT TRIGGER content_items_validate_runtime_provenance
AFTER INSERT OR UPDATE ON platform.content_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_runtime_content_write_provenance();

CREATE CONSTRAINT TRIGGER content_additional_communities_validate_runtime_provenance
AFTER INSERT OR UPDATE OR DELETE ON platform.content_additional_communities
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_runtime_content_write_provenance();

CREATE CONSTRAINT TRIGGER content_symbols_validate_runtime_provenance
AFTER INSERT OR UPDATE OR DELETE ON platform.content_symbols
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_runtime_content_write_provenance();

CREATE CONSTRAINT TRIGGER content_topics_validate_runtime_provenance
AFTER INSERT OR UPDATE OR DELETE ON platform.content_topics
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_runtime_content_write_provenance();

CREATE CONSTRAINT TRIGGER source_links_validate_runtime_provenance
AFTER INSERT OR UPDATE ON platform.source_links
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_runtime_content_write_provenance();

CREATE CONSTRAINT TRIGGER content_relations_validate_runtime_provenance
AFTER INSERT OR UPDATE ON platform.content_relations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_runtime_content_write_provenance();

CREATE CONSTRAINT TRIGGER mentions_validate_runtime_provenance
AFTER INSERT ON platform.mentions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_runtime_content_write_provenance();
