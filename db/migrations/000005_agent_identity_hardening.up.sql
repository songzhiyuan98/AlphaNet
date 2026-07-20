SET LOCAL search_path = pg_catalog;

-- Tighten discovery tags for new values while preserving the function used by
-- the already-published 000004 CHECK constraint. PostgreSQL re-evaluates a
-- CHECK on unrelated row updates, so changing that original function would
-- freeze legacy rows that were valid when written.
CREATE FUNCTION platform.canonical_discovery_tags_are_valid(candidate text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT cardinality(candidate) <= 10
    AND array_position(candidate, NULL) IS NULL
    AND platform.text_array_has_unique_values(candidate)
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(candidate) AS tags(tag)
      WHERE length(btrim(tag)) NOT BETWEEN 1 AND 40
        OR tag <> lower(tag)
        OR tag !~ '^[a-z0-9]([a-z0-9_.-]{0,38}[a-z0-9])?$'
    );
$$;

CREATE FUNCTION platform.enforce_canonical_agent_discovery_tags()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'agents'
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION
      'Agent discovery-tag validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF (
    TG_OP = 'INSERT'
    OR NEW.discovery_tags IS DISTINCT FROM OLD.discovery_tags
  )
    AND NOT platform.canonical_discovery_tags_are_valid(NEW.discovery_tags) THEN
    RAISE EXCEPTION
      'Agent discovery tags must use the canonical format'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER agents_enforce_canonical_discovery_tags
BEFORE INSERT OR UPDATE ON platform.agents
FOR EACH ROW
EXECUTE FUNCTION platform.enforce_canonical_agent_discovery_tags();

REVOKE ALL ON FUNCTION platform.enforce_canonical_agent_discovery_tags()
  FROM PUBLIC;

-- Reject static API key material even when it is hidden under an innocuous
-- audit field name. Keep the shipped v1 function and CHECK semantics intact:
-- changing an IMMUTABLE function behind a validated CHECK would make legacy
-- rows and dump/restore validation disagree.
CREATE FUNCTION platform.audit_json_is_secret_free_v2(document jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  member record;
BEGIN
  IF document IS NULL THEN
    RETURN true;
  END IF;

  IF jsonb_typeof(document) = 'object' THEN
    FOR member IN
      SELECT entry.key, entry.value
      FROM jsonb_each(document) AS entry(key, value)
    LOOP
      IF lower(member.key) ~
        '(^|[_-])(secret|secret_digest|plaintext|password|token|access_token|refresh_token|authorization|api_key|credential_value)($|[_-])' THEN
        RETURN false;
      END IF;

      IF NOT platform.audit_json_is_secret_free_v2(member.value) THEN
        RETURN false;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(document) = 'array' THEN
    FOR member IN
      SELECT entry.value
      FROM jsonb_array_elements(document) AS entry(value)
    LOOP
      IF NOT platform.audit_json_is_secret_free_v2(member.value) THEN
        RETURN false;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(document) = 'string' THEN
    IF document #>> '{}' ~
      'aln_v1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}' THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$$;

CREATE FUNCTION platform.enforce_action_log_secret_values()
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
      'ActionLog secret-value validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NOT platform.audit_json_is_secret_free_v2(NEW.authorization_snapshot)
    OR NOT platform.audit_json_is_secret_free_v2(NEW.before_state)
    OR NOT platform.audit_json_is_secret_free_v2(NEW.after_state) THEN
    RAISE EXCEPTION
      'ActionLog JSON must not contain secret-shaped values'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER action_logs_enforce_secret_values
BEFORE INSERT ON platform.action_logs
FOR EACH ROW
EXECUTE FUNCTION platform.enforce_action_log_secret_values();

REVOKE ALL ON FUNCTION platform.enforce_action_log_secret_values() FROM PUBLIC;

-- A soft-deleted Owner is never an active authorization principal. Normalize
-- any legacy projection before making the invariant fully validated.
UPDATE platform.owners
SET status = 'closed'
WHERE deleted_at IS NOT NULL
  AND status <> 'closed';

ALTER TABLE platform.owners
  ADD CONSTRAINT owners_deleted_only_when_closed
  CHECK (deleted_at IS NULL OR status = 'closed');

-- Handles issued under 000004 may contain "." or "_" or end in punctuation.
-- Handle identity is immutable, so preserve those rows and enforce the locked
-- canonical format on every new Actor at the database boundary.
CREATE FUNCTION platform.enforce_canonical_actor_handle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'actors'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Actor handle validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.handle::text <> lower(NEW.handle::text)
    OR NEW.handle::text !~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$' THEN
    RAISE EXCEPTION
      'Actor handle must use the canonical format'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER actors_enforce_canonical_handle
BEFORE INSERT ON platform.actors
FOR EACH ROW
EXECUTE FUNCTION platform.enforce_canonical_actor_handle();

REVOKE ALL ON FUNCTION platform.enforce_canonical_actor_handle() FROM PUBLIC;

-- Before key-ring versioning, every persisted static key used the original
-- pepper. Version 1 names that historical pepper and preserves those keys
-- across this forward-only upgrade.
ALTER TABLE platform.credentials
  ADD COLUMN pepper_version smallint;

UPDATE platform.credentials
SET pepper_version = 1
WHERE credential_type = 'static_api_key';

COMMENT ON COLUMN platform.credentials.pepper_version IS
  'Identifies the external HMAC pepper required to verify this static API key; the pepper itself is never stored in PostgreSQL.';

ALTER TABLE platform.credentials
  DROP CONSTRAINT credentials_static_secret_shape;

ALTER TABLE platform.credentials
  ADD CONSTRAINT credentials_static_secret_shape
  CHECK (
    (
      credential_type = 'static_api_key'
      AND token_prefix IS NOT NULL
      AND token_prefix ~ '^aln_v1_[A-Za-z0-9_-]{12}$'
      AND secret_digest IS NOT NULL
      AND octet_length(secret_digest) = 32
      AND pepper_version IS NOT NULL
      AND pepper_version > 0
    )
    OR (
      credential_type = 'oauth_grant'
      AND token_prefix IS NULL
      AND secret_digest IS NULL
      AND pepper_version IS NULL
    )
  );

-- The existing rotation path serializes on the predecessor, so valid 000004
-- data already has at most one replacement. Fail atomically instead of
-- discarding historical links if an out-of-band writer violated that rule.
DO $$
BEGIN
  IF EXISTS (
    SELECT credential.replaces_credential_id
    FROM platform.credentials AS credential
    WHERE credential.replaces_credential_id IS NOT NULL
    GROUP BY credential.replaces_credential_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'cannot enforce one replacement per Credential: legacy duplicate replacement links exist'
      USING ERRCODE = '23505';
  END IF;
END;
$$;

ALTER TABLE platform.credentials
  ADD CONSTRAINT credentials_replaces_once
  UNIQUE (replaces_credential_id);

CREATE OR REPLACE FUNCTION platform.prepare_credential_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'credentials'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Credential update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.credential_type IS DISTINCT FROM OLD.credential_type
    OR NEW.token_prefix IS DISTINCT FROM OLD.token_prefix
    OR NEW.secret_digest IS DISTINCT FROM OLD.secret_digest
    OR NEW.pepper_version IS DISTINCT FROM OLD.pepper_version
    OR NEW.scopes IS DISTINCT FROM OLD.scopes
    OR NEW.audience IS DISTINCT FROM OLD.audience
    OR NEW.policy_ceiling IS DISTINCT FROM OLD.policy_ceiling
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.replaces_credential_id IS DISTINCT FROM OLD.replaces_credential_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Credential identity and authority are immutable; rotate by inserting a replacement'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.last_used_at IS NOT NULL
    AND (
      NEW.last_used_at IS NULL
      OR NEW.last_used_at < OLD.last_used_at
    ) THEN
    RAISE EXCEPTION
      'Credential last-used time is monotonic'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.revoked_at IS NOT NULL
    AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION
      'Credential revocation is irreversible and its time is immutable'
      USING ERRCODE = '22023';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION platform.prepare_credential_update() FROM PUBLIC;
