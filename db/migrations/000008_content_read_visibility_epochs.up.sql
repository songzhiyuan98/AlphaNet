SET LOCAL search_path = pg_catalog;

-- Constant-time Content read snapshot invalidation -------------------------
--
-- Content list and discussion cursors freeze their candidate membership at
-- the first request. A PostgreSQL snapshot excludes later transactions even
-- when an internal caller supplies a backdated public timestamp. Visibility,
-- placement, or classification changes to existing candidates advance a small
-- epoch row that continuation requests can compare in constant time.

CREATE TABLE system.content_read_visibility_epochs (
  epoch_name text PRIMARY KEY,
  epoch bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT content_read_visibility_epochs_name
    CHECK (
      epoch_name IN (
        'content_membership',
        'public_community_visibility'
      )
    ),
  CONSTRAINT content_read_visibility_epochs_positive
    CHECK (epoch > 0)
);

INSERT INTO system.content_read_visibility_epochs (epoch_name, epoch)
VALUES
  ('content_membership', 1),
  ('public_community_visibility', 1);

COMMENT ON TABLE system.content_read_visibility_epochs IS
  'Small monotonic epochs used to invalidate Content read cursors after an existing candidate changes visibility, placement, or classification.';

-- A signed cursor also carries the PostgreSQL snapshot captured on page one.
-- These immutable top-level transaction IDs let continuation queries reject
-- rows committed later even if an internal caller supplies a backdated public
-- timestamp. Existing rows receive the migration transaction ID and are
-- visible to every snapshot created after this migration commits.
ALTER TABLE platform.content_items
  ADD COLUMN content_read_created_xid xid8 NOT NULL
    DEFAULT pg_current_xact_id();

ALTER TABLE platform.content_revisions
  ADD COLUMN content_read_created_xid xid8 NOT NULL
    DEFAULT pg_current_xact_id();

COMMENT ON COLUMN platform.content_items.content_read_created_xid IS
  'Immutable database-assigned top-level transaction ID used only for stable Content cursor membership.';

COMMENT ON COLUMN platform.content_revisions.content_read_created_xid IS
  'Immutable database-assigned top-level transaction ID used only for stable active-order snapshots.';

CREATE FUNCTION platform.assign_content_read_created_xid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME NOT IN ('content_items', 'content_revisions')
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION
      'Content read creation transaction trigger invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.content_read_created_xid := pg_current_xact_id();
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME <> 'content_items'
    OR NEW.content_read_created_xid IS DISTINCT FROM
      OLD.content_read_created_xid THEN
    RAISE EXCEPTION
      'Content read creation transaction is immutable'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER content_items_assign_read_created_xid
BEFORE INSERT OR UPDATE ON platform.content_items
FOR EACH ROW
EXECUTE FUNCTION platform.assign_content_read_created_xid();

CREATE TRIGGER content_revisions_assign_read_created_xid
BEFORE INSERT ON platform.content_revisions
FOR EACH ROW
EXECUTE FUNCTION platform.assign_content_read_created_xid();

REVOKE ALL ON FUNCTION platform.assign_content_read_created_xid()
  FROM PUBLIC;

CREATE FUNCTION system.advance_content_read_visibility_epoch(candidate_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE system.content_read_visibility_epochs
  SET epoch = epoch + 1,
      updated_at = clock_timestamp()
  WHERE epoch_name = candidate_name;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Unknown Content read visibility epoch'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION system.advance_content_read_visibility_epoch(text)
  FROM PUBLIC;

CREATE FUNCTION platform.advance_content_membership_on_item_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'content_items'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Content membership epoch trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
    OR NEW.distribution_state IS DISTINCT FROM OLD.distribution_state
    OR NEW.primary_community_id IS DISTINCT FROM OLD.primary_community_id THEN
    PERFORM system.advance_content_read_visibility_epoch('content_membership');
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER content_items_advance_read_membership_epoch
AFTER UPDATE ON platform.content_items
FOR EACH ROW
EXECUTE FUNCTION platform.advance_content_membership_on_item_update();

REVOKE ALL ON FUNCTION platform.advance_content_membership_on_item_update()
  FROM PUBLIC;

CREATE FUNCTION platform.advance_public_visibility_on_community_update()
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
      'Public Community visibility epoch trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF (NEW.status = 'suspended') IS DISTINCT FROM (OLD.status = 'suspended') THEN
    PERFORM system.advance_content_read_visibility_epoch(
      'public_community_visibility'
    );
  END IF;

  -- Soft deletion removes the Community from both anonymous and authenticated
  -- Content reads. Agent cursors only carry content_membership, so this change
  -- must advance the shared epoch rather than only the public epoch.
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    PERFORM system.advance_content_read_visibility_epoch('content_membership');
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER communities_advance_public_read_visibility_epoch
AFTER UPDATE ON platform.communities
FOR EACH ROW
EXECUTE FUNCTION platform.advance_public_visibility_on_community_update();

REVOKE ALL ON FUNCTION platform.advance_public_visibility_on_community_update()
  FROM PUBLIC;

CREATE FUNCTION platform.advance_content_membership_on_catalog_key_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  changes_mapped_content boolean := false;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME NOT IN ('symbols', 'topics')
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Content catalog-key epoch trigger invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  IF TG_TABLE_NAME = 'symbols'
    AND (to_jsonb(NEW) ->> 'ticker') IS DISTINCT FROM
      (to_jsonb(OLD) ->> 'ticker') THEN
    SELECT EXISTS (
      SELECT 1
      FROM platform.content_symbols AS mapping
      WHERE mapping.symbol_id = NEW.id
    )
    INTO changes_mapped_content;
  ELSIF TG_TABLE_NAME = 'topics'
    AND (to_jsonb(NEW) ->> 'slug') IS DISTINCT FROM
      (to_jsonb(OLD) ->> 'slug') THEN
    SELECT EXISTS (
      SELECT 1
      FROM platform.content_topics AS mapping
      WHERE mapping.topic_id = NEW.id
    )
    INTO changes_mapped_content;
  END IF;

  IF changes_mapped_content THEN
    PERFORM system.advance_content_read_visibility_epoch('content_membership');
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER symbols_advance_read_membership_epoch
AFTER UPDATE ON platform.symbols
FOR EACH ROW
EXECUTE FUNCTION platform.advance_content_membership_on_catalog_key_update();

CREATE TRIGGER topics_advance_read_membership_epoch
AFTER UPDATE ON platform.topics
FOR EACH ROW
EXECUTE FUNCTION platform.advance_content_membership_on_catalog_key_update();

REVOKE ALL ON FUNCTION platform.advance_content_membership_on_catalog_key_update()
  FROM PUBLIC;

CREATE FUNCTION platform.advance_content_membership_on_mapping_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate_content_id uuid;
  content_created_xid xid8;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME NOT IN (
      'content_additional_communities',
      'content_symbols',
      'content_topics'
    )
    OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
    RAISE EXCEPTION
      'Content mapping epoch trigger invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    candidate_content_id := OLD.content_id;
  ELSE
    candidate_content_id := NEW.content_id;
  END IF;

  -- A mapping is initial only when its ContentItem was inserted by this same
  -- top-level transaction. Public timestamps are caller-supplied data and must
  -- never be trusted to bypass cursor invalidation.
  IF TG_OP = 'INSERT' THEN
    SELECT content.content_read_created_xid
    INTO content_created_xid
    FROM platform.content_items AS content
    WHERE content.id = candidate_content_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Content mapping epoch trigger could not resolve its ContentItem'
        USING ERRCODE = '23503';
    END IF;

    IF content_created_xid = pg_current_xact_id() THEN
      RETURN NULL;
    END IF;
  END IF;

  PERFORM system.advance_content_read_visibility_epoch('content_membership');
  RETURN NULL;
END;
$$;

CREATE TRIGGER content_additional_communities_advance_read_membership_epoch
AFTER INSERT OR UPDATE OR DELETE ON platform.content_additional_communities
FOR EACH ROW
EXECUTE FUNCTION platform.advance_content_membership_on_mapping_change();

CREATE TRIGGER content_symbols_advance_read_membership_epoch
AFTER INSERT OR UPDATE OR DELETE ON platform.content_symbols
FOR EACH ROW
EXECUTE FUNCTION platform.advance_content_membership_on_mapping_change();

CREATE TRIGGER content_topics_advance_read_membership_epoch
AFTER INSERT OR UPDATE OR DELETE ON platform.content_topics
FOR EACH ROW
EXECUTE FUNCTION platform.advance_content_membership_on_mapping_change();

REVOKE ALL ON FUNCTION platform.advance_content_membership_on_mapping_change()
  FROM PUBLIC;
