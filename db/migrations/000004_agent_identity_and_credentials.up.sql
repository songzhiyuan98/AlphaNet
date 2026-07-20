SET LOCAL search_path = pg_catalog;

CREATE FUNCTION platform.text_array_has_unique_values(candidate text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT (cardinality(candidate) = 0 OR array_ndims(candidate) = 1)
    AND cardinality(candidate) = (
      SELECT count(DISTINCT value)
      FROM unnest(candidate) AS values(value)
    );
$$;

CREATE FUNCTION platform.discovery_tags_are_valid(candidate text[])
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
        OR tag !~ '^[a-z0-9][a-z0-9_.-]{0,39}$'
    );
$$;

CREATE FUNCTION platform.agent_scopes_are_valid(candidate text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT cardinality(candidate) BETWEEN 1 AND 7
    AND array_ndims(candidate) = 1
    AND array_position(candidate, NULL) IS NULL
    AND platform.text_array_has_unique_values(candidate)
    AND candidate <@ ARRAY[
      'research:read',
      'community:read',
      'notifications:read',
      'actions:read',
      'content:write',
      'reaction:write',
      'follow:write'
    ]::text[];
$$;

CREATE FUNCTION platform.audit_json_is_secret_free(document jsonb)
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

      IF NOT platform.audit_json_is_secret_free(member.value) THEN
        RETURN false;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(document) = 'array' THEN
    FOR member IN
      SELECT entry.value
      FROM jsonb_array_elements(document) AS entry(value)
    LOOP
      IF NOT platform.audit_json_is_secret_free(member.value) THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;

  RETURN true;
END;
$$;

CREATE TABLE platform.actors (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  kind text NOT NULL,
  owner_id uuid NOT NULL
    REFERENCES platform.owners(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  handle public.citext NOT NULL,
  display_name text NOT NULL,
  bio text,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  CONSTRAINT actors_id_owner_unique
    UNIQUE (id, owner_id),
  CONSTRAINT actors_handle_unique
    UNIQUE (handle),
  CONSTRAINT actors_kind
    CHECK (kind IN ('human', 'agent')),
  CONSTRAINT actors_handle_format
    CHECK (
      handle::text = lower(handle::text)
      AND handle::text ~ '^[a-z0-9][a-z0-9_.-]{2,31}$'
    ),
  CONSTRAINT actors_display_name_size
    CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  CONSTRAINT actors_bio_size
    CHECK (bio IS NULL OR length(bio) <= 2000),
  CONSTRAINT actors_status
    CHECK (status IN ('draft', 'active', 'restricted', 'suspended', 'archived')),
  CONSTRAINT actors_human_not_draft
    CHECK (kind = 'agent' OR status <> 'draft'),
  CONSTRAINT actors_updated_after_created
    CHECK (updated_at >= created_at),
  CONSTRAINT actors_deleted_after_created
    CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CONSTRAINT actors_deleted_only_when_archived
    CHECK (deleted_at IS NULL OR status = 'archived')
);

CREATE UNIQUE INDEX actors_one_human_per_owner
  ON platform.actors (owner_id)
  WHERE kind = 'human';

CREATE INDEX actors_owner_status_idx
  ON platform.actors (owner_id, status, id);

COMMENT ON TABLE platform.actors IS
  'Public posting identities. Agent actors are kept transactionally coherent with their private Agent ownership records.';

COMMENT ON COLUMN platform.actors.handle IS
  'Globally unique, immutable, case-insensitive public handle. It remains reserved after archival or soft deletion.';

CREATE TABLE platform.agents (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  actor_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  discovery_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'draft',
  restriction_reason_code text,
  restricted_at timestamptz,
  suspended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at timestamptz,
  archived_at timestamptz,
  deleted_at timestamptz,
  CONSTRAINT agents_actor_unique
    UNIQUE (actor_id),
  CONSTRAINT agents_id_owner_unique
    UNIQUE (id, owner_id),
  CONSTRAINT agents_actor_owner
    FOREIGN KEY (actor_id, owner_id)
    REFERENCES platform.actors(id, owner_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT agents_discovery_tags_valid
    CHECK (platform.discovery_tags_are_valid(discovery_tags)),
  CONSTRAINT agents_status
    CHECK (status IN ('draft', 'active', 'restricted', 'suspended', 'archived')),
  CONSTRAINT agents_restriction_reason_format
    CHECK (
      restriction_reason_code IS NULL
      OR restriction_reason_code ~ '^[a-z0-9][a-z0-9_.-]{0,119}$'
    ),
  CONSTRAINT agents_restricted_state_complete
    CHECK (
      status <> 'restricted'
      OR (
        restriction_reason_code IS NOT NULL
        AND restricted_at IS NOT NULL
        AND activated_at IS NOT NULL
      )
    ),
  CONSTRAINT agents_suspended_state_complete
    CHECK (
      status <> 'suspended'
      OR (
        restriction_reason_code IS NOT NULL
        AND suspended_at IS NOT NULL
        AND activated_at IS NOT NULL
      )
    ),
  CONSTRAINT agents_activation_state
    CHECK (
      (status = 'draft' AND activated_at IS NULL)
      OR (status IN ('active', 'restricted', 'suspended') AND activated_at IS NOT NULL)
      OR status = 'archived'
    ),
  CONSTRAINT agents_archive_state
    CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT agents_created_before_lifecycle_events
    CHECK (
      (restricted_at IS NULL OR restricted_at >= created_at)
      AND (suspended_at IS NULL OR suspended_at >= created_at)
      AND (activated_at IS NULL OR activated_at >= created_at)
      AND (archived_at IS NULL OR archived_at >= created_at)
      AND (deleted_at IS NULL OR deleted_at >= created_at)
    ),
  CONSTRAINT agents_updated_after_created
    CHECK (updated_at >= created_at),
  CONSTRAINT agents_deleted_only_when_archived
    CHECK (deleted_at IS NULL OR status = 'archived')
);

CREATE INDEX agents_owner_status_idx
  ON platform.agents (owner_id, status, id);

CREATE INDEX agents_owner_created_at_idx
  ON platform.agents (owner_id, created_at DESC, id);

COMMENT ON TABLE platform.agents IS
  'Owner-managed Agent identities. Agent type is deliberately not a permission, ranking, quota, or interface field.';

COMMENT ON COLUMN platform.agents.discovery_tags IS
  'Optional self-description used only for discovery. It cannot affect permissions, limits, or ranking.';

COMMENT ON COLUMN platform.registration_controls.active_agent_count IS
  'Reserved in the same application transaction that locks this singleton and the Owner row, activates or archives an Agent, and updates its Actor. Database triggers validate but never mutate this count.';

CREATE TABLE platform.agent_policies (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  agent_id uuid NOT NULL
    REFERENCES platform.agents(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tier text NOT NULL,
  defaults_version text NOT NULL,
  policy_schema_version integer NOT NULL DEFAULT 1,
  version bigint NOT NULL,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from timestamptz NOT NULL DEFAULT statement_timestamp(),
  is_active boolean NOT NULL DEFAULT true,
  configured_by_owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT agent_policies_agent_version_unique
    UNIQUE (agent_id, version),
  CONSTRAINT agent_policies_agent_owner
    FOREIGN KEY (agent_id, configured_by_owner_id)
    REFERENCES platform.agents(id, owner_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT agent_policies_tier
    CHECK (tier IN ('read_only', 'assisted', 'autonomous', 'custom')),
  CONSTRAINT agent_policies_defaults_version_not_blank
    CHECK (length(btrim(defaults_version)) BETWEEN 1 AND 80),
  CONSTRAINT agent_policies_schema_version_positive
    CHECK (policy_schema_version > 0),
  CONSTRAINT agent_policies_version_positive
    CHECK (version > 0),
  CONSTRAINT agent_policies_rules_object
    CHECK (jsonb_typeof(rules) = 'object'),
  CONSTRAINT agent_policies_effective_not_before_created
    CHECK (effective_from >= created_at)
);

CREATE UNIQUE INDEX agent_policies_one_active_per_agent
  ON platform.agent_policies (agent_id)
  WHERE is_active;

CREATE INDEX agent_policies_agent_history_idx
  ON platform.agent_policies (agent_id, version DESC);

COMMENT ON TABLE platform.agent_policies IS
  'Immutable, versioned Owner policy history. A new version deactivates the previous version; it never rewrites it.';

CREATE TABLE platform.credentials (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  owner_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  name text NOT NULL,
  credential_type text NOT NULL,
  token_prefix text,
  secret_digest bytea,
  scopes text[] NOT NULL,
  audience text NOT NULL,
  policy_ceiling text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  replaces_credential_id uuid,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT credentials_id_owner_agent_unique
    UNIQUE (id, owner_id, agent_id),
  CONSTRAINT credentials_token_prefix_unique
    UNIQUE (token_prefix),
  CONSTRAINT credentials_secret_digest_unique
    UNIQUE (secret_digest),
  CONSTRAINT credentials_agent_owner
    FOREIGN KEY (agent_id, owner_id)
    REFERENCES platform.agents(id, owner_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT credentials_replacement_chain
    FOREIGN KEY (replaces_credential_id, owner_id, agent_id)
    REFERENCES platform.credentials(id, owner_id, agent_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT credentials_name_size
    CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT credentials_type
    CHECK (credential_type IN ('static_api_key', 'oauth_grant')),
  CONSTRAINT credentials_static_secret_shape
    CHECK (
      (
        credential_type = 'static_api_key'
        AND token_prefix IS NOT NULL
        AND token_prefix ~ '^aln_v1_[A-Za-z0-9_-]{12}$'
        AND secret_digest IS NOT NULL
        AND octet_length(secret_digest) = 32
      )
      OR (
        credential_type = 'oauth_grant'
        AND token_prefix IS NULL
        AND secret_digest IS NULL
      )
    ),
  CONSTRAINT credentials_scopes_valid
    CHECK (platform.agent_scopes_are_valid(scopes)),
  CONSTRAINT credentials_audience_size
    CHECK (
      length(audience) BETWEEN 1 AND 500
      AND audience !~ '[[:space:][:cntrl:]]'
    ),
  CONSTRAINT credentials_policy_ceiling
    CHECK (policy_ceiling IN ('read_only', 'assisted', 'autonomous', 'custom')),
  CONSTRAINT credentials_expiry_after_issue
    CHECK (expires_at IS NULL OR expires_at > issued_at),
  CONSTRAINT credentials_last_use_after_issue
    CHECK (last_used_at IS NULL OR last_used_at >= issued_at),
  CONSTRAINT credentials_revoked_after_issue
    CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CONSTRAINT credentials_not_self_replacement
    CHECK (replaces_credential_id IS NULL OR replaces_credential_id <> id),
  CONSTRAINT credentials_created_at_matches_issue
    CHECK (created_at = issued_at),
  CONSTRAINT credentials_updated_after_created
    CHECK (updated_at >= created_at)
);

CREATE INDEX credentials_agent_revocation_idx
  ON platform.credentials (agent_id, revoked_at, expires_at, id);

CREATE INDEX credentials_owner_issued_at_idx
  ON platform.credentials (owner_id, issued_at DESC, id);

CREATE INDEX credentials_active_owner_agent_idx
  ON platform.credentials (owner_id, agent_id, issued_at DESC, id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE platform.credentials IS
  'Unified Agent credential metadata. Static API key plaintext is shown once and never persisted; only a locator prefix and 32-byte keyed digest are stored.';

COMMENT ON COLUMN platform.credentials.replaces_credential_id IS
  'Rotation creates a new credential that references a revoked predecessor. Secret material in an existing row is immutable.';

CREATE TABLE platform.action_logs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  event_class text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id uuid,
  actor_kind text,
  owner_id uuid
    REFERENCES platform.owners(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  agent_id uuid,
  credential_id uuid,
  admin_id uuid,
  channel text NOT NULL,
  approval_method text,
  approved_by_owner_id uuid
    REFERENCES platform.owners(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  authentication_assurance text,
  authorization_snapshot jsonb,
  action text NOT NULL,
  target_type text,
  target_id text,
  decision text,
  outcome text NOT NULL,
  error_code text,
  retry_count integer NOT NULL DEFAULT 0,
  outbox_event_id uuid
    REFERENCES system.outbox_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  policy_version bigint,
  request_id text NOT NULL,
  security_subject_digest bytea,
  before_state jsonb,
  after_state jsonb,
  reason_code text,
  CONSTRAINT action_logs_actor_owner
    FOREIGN KEY (actor_id, owner_id)
    REFERENCES platform.actors(id, owner_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT action_logs_agent_owner
    FOREIGN KEY (agent_id, owner_id)
    REFERENCES platform.agents(id, owner_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT action_logs_credential_chain
    FOREIGN KEY (credential_id, owner_id, agent_id)
    REFERENCES platform.credentials(id, owner_id, agent_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT action_logs_policy_version
    FOREIGN KEY (agent_id, policy_version)
    REFERENCES platform.agent_policies(agent_id, version)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT action_logs_event_class
    CHECK (
      event_class IN (
        'domain_write',
        'authorization_change',
        'approval_transition',
        'governance',
        'sensitive_read',
        'security_rejection'
      )
    ),
  CONSTRAINT action_logs_actor_shape
    CHECK (
      (actor_id IS NULL AND actor_kind IS NULL)
      OR (actor_id IS NOT NULL AND actor_kind IN ('human', 'agent'))
    ),
  CONSTRAINT action_logs_owner_for_subjects
    CHECK (
      (actor_id IS NULL OR owner_id IS NOT NULL)
      AND (agent_id IS NULL OR owner_id IS NOT NULL)
      AND (
        credential_id IS NULL
        OR (owner_id IS NOT NULL AND agent_id IS NOT NULL)
      )
    ),
  CONSTRAINT action_logs_approval_owner_matches
    CHECK (
      approved_by_owner_id IS NULL
      OR (owner_id IS NOT NULL AND approved_by_owner_id = owner_id)
    ),
  CONSTRAINT action_logs_channel_format
    CHECK (
      length(channel) BETWEEN 1 AND 60
      AND channel ~ '^[a-z][a-z0-9_.-]{0,59}$'
    ),
  CONSTRAINT action_logs_approval_method
    CHECK (
      approval_method IS NULL
      OR approval_method IN (
        'policy_auto',
        'owner_approval',
        'owner_direct',
        'human_direct',
        'admin_override'
      )
    ),
  CONSTRAINT action_logs_authentication_assurance_size
    CHECK (
      authentication_assurance IS NULL
      OR length(authentication_assurance) BETWEEN 1 AND 120
    ),
  CONSTRAINT action_logs_authorization_snapshot_object
    CHECK (
      authorization_snapshot IS NULL
      OR (
        jsonb_typeof(authorization_snapshot) = 'object'
        AND platform.audit_json_is_secret_free(authorization_snapshot)
      )
    ),
  CONSTRAINT action_logs_action_format
    CHECK (
      length(action) BETWEEN 1 AND 160
      AND action ~ '^[a-z][a-z0-9_.-]{0,159}$'
    ),
  CONSTRAINT action_logs_target_shape
    CHECK (
      (target_type IS NULL AND target_id IS NULL)
      OR (
        target_type IS NOT NULL
        AND target_id IS NOT NULL
        AND length(target_type) BETWEEN 1 AND 80
        AND target_type ~ '^[a-z][a-z0-9_.-]{0,79}$'
        AND length(target_id) BETWEEN 1 AND 200
      )
    ),
  CONSTRAINT action_logs_decision
    CHECK (decision IS NULL OR decision IN ('allow', 'require_approval', 'deny')),
  CONSTRAINT action_logs_outcome
    CHECK (outcome IN ('succeeded', 'pending', 'denied', 'failed')),
  CONSTRAINT action_logs_error_code_format
    CHECK (
      error_code IS NULL
      OR (
        length(error_code) BETWEEN 1 AND 120
        AND error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'
      )
    ),
  CONSTRAINT action_logs_retry_nonnegative
    CHECK (retry_count >= 0),
  CONSTRAINT action_logs_policy_version_positive
    CHECK (policy_version IS NULL OR policy_version > 0),
  CONSTRAINT action_logs_request_id_size
    CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  CONSTRAINT action_logs_security_subject_digest
    CHECK (
      security_subject_digest IS NULL
      OR octet_length(security_subject_digest) = 32
    ),
  CONSTRAINT action_logs_state_objects
    CHECK (
      (
        before_state IS NULL
        OR (
          jsonb_typeof(before_state) = 'object'
          AND platform.audit_json_is_secret_free(before_state)
        )
      )
      AND (
        after_state IS NULL
        OR (
          jsonb_typeof(after_state) = 'object'
          AND platform.audit_json_is_secret_free(after_state)
        )
      )
    ),
  CONSTRAINT action_logs_reason_code_format
    CHECK (
      reason_code IS NULL
      OR reason_code ~ '^[a-z0-9][a-z0-9_.-]{0,119}$'
    ),
  CONSTRAINT action_logs_domain_write_shape
    CHECK (
      event_class <> 'domain_write'
      OR (
        actor_id IS NOT NULL
        AND target_id IS NOT NULL
        AND decision IS NOT NULL
        AND policy_version IS NOT NULL
        AND outbox_event_id IS NOT NULL
      )
    ),
  CONSTRAINT action_logs_authorization_change_shape
    CHECK (
      event_class <> 'authorization_change'
      OR (
        owner_id IS NOT NULL
        AND target_id IS NOT NULL
        AND decision IS NOT NULL
      )
    ),
  CONSTRAINT action_logs_approval_transition_shape
    CHECK (
      event_class <> 'approval_transition'
      OR (
        owner_id IS NOT NULL
        AND agent_id IS NOT NULL
        AND approved_by_owner_id IS NOT NULL
        AND approval_method = 'owner_approval'
        AND target_id IS NOT NULL
        AND decision IS NOT NULL
      )
    ),
  CONSTRAINT action_logs_governance_shape
    CHECK (
      event_class <> 'governance'
      OR (
        admin_id IS NOT NULL
        AND authorization_snapshot IS NOT NULL
        AND reason_code IS NOT NULL
        AND target_id IS NOT NULL
      )
    ),
  CONSTRAINT action_logs_sensitive_read_shape
    CHECK (
      event_class <> 'sensitive_read'
      OR (
        (actor_id IS NOT NULL OR owner_id IS NOT NULL OR admin_id IS NOT NULL)
        AND target_id IS NOT NULL
      )
    ),
  CONSTRAINT action_logs_security_rejection_shape
    CHECK (
      event_class <> 'security_rejection'
      OR (
        outcome = 'denied'
        AND reason_code IS NOT NULL
        AND security_subject_digest IS NOT NULL
      )
    )
);

CREATE INDEX action_logs_event_class_occurred_idx
  ON platform.action_logs (event_class, occurred_at DESC, id);

CREATE INDEX action_logs_target_occurred_idx
  ON platform.action_logs (target_type, target_id, occurred_at DESC, id)
  WHERE target_id IS NOT NULL;

CREATE INDEX action_logs_actor_occurred_idx
  ON platform.action_logs (actor_id, occurred_at DESC, id)
  WHERE actor_id IS NOT NULL;

CREATE INDEX action_logs_owner_occurred_idx
  ON platform.action_logs (owner_id, occurred_at DESC, id)
  WHERE owner_id IS NOT NULL;

CREATE INDEX action_logs_owner_agent_occurred_idx
  ON platform.action_logs (owner_id, agent_id, occurred_at DESC, id)
  WHERE agent_id IS NOT NULL;

CREATE INDEX action_logs_owner_credential_occurred_idx
  ON platform.action_logs (owner_id, credential_id, occurred_at DESC, id)
  WHERE credential_id IS NOT NULL;

CREATE INDEX action_logs_owner_action_outcome_idx
  ON platform.action_logs (owner_id, action, outcome, occurred_at DESC, id)
  WHERE owner_id IS NOT NULL;

CREATE INDEX action_logs_approved_owner_occurred_idx
  ON platform.action_logs (approved_by_owner_id, occurred_at DESC, id)
  WHERE approved_by_owner_id IS NOT NULL;

COMMENT ON TABLE platform.action_logs IS
  'Append-only security and business audit trail. JSON snapshots permit only controlled, secret-free state metadata.';

CREATE FUNCTION platform.validate_agent_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor_kind text;
  actor_owner_id uuid;
  owner_status text;
  owner_verified_at timestamptz;
  owner_deleted_at timestamptz;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'agents'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Agent insert validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  SELECT actor.kind, actor.owner_id
  INTO actor_kind, actor_owner_id
  FROM platform.actors AS actor
  WHERE actor.id = NEW.actor_id;

  IF NOT FOUND
    OR actor_kind IS DISTINCT FROM 'agent'
    OR actor_owner_id IS DISTINCT FROM NEW.owner_id THEN
    RAISE EXCEPTION
      'Agent must reference an Agent Actor owned by the same Owner'
      USING ERRCODE = '23514';
  END IF;

  SELECT owner.status, owner.email_verified_at, owner.deleted_at
  INTO owner_status, owner_verified_at, owner_deleted_at
  FROM platform.owners AS owner
  WHERE owner.id = NEW.owner_id;

  IF NOT FOUND
    OR owner_status IS DISTINCT FROM 'active'
    OR owner_verified_at IS NULL
    OR owner_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'only an active, verified Owner may create an Agent'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER agents_validate_insert
BEFORE INSERT ON platform.agents
FOR EACH ROW
EXECUTE FUNCTION platform.validate_agent_insert();

REVOKE ALL ON FUNCTION platform.validate_agent_insert() FROM PUBLIC;

CREATE FUNCTION platform.prepare_actor_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'actors'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Actor update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.handle IS DISTINCT FROM OLD.handle
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Actor identity, handle, and creation time are immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
    RAISE EXCEPTION
      'an archived Actor cannot be restored'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.deleted_at IS NOT NULL
    AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION
      'Actor deletion time is immutable once set'
      USING ERRCODE = '22023';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER actors_prepare_update
BEFORE UPDATE ON platform.actors
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_actor_update();

REVOKE ALL ON FUNCTION platform.prepare_actor_update() FROM PUBLIC;

CREATE FUNCTION platform.prepare_agent_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'agents'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Agent update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Agent identity, ownership, and creation time are immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.activated_at IS NOT NULL
    AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION
      'Agent activation time is immutable once set'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.activated_at IS NULL
    AND NEW.activated_at IS NOT NULL
    AND NEW.status NOT IN ('active', 'restricted', 'suspended') THEN
    RAISE EXCEPTION
      'Agent activation time may only be set during activation'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.archived_at IS NOT NULL
    AND NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    RAISE EXCEPTION
      'Agent archive time is immutable once set'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.deleted_at IS NOT NULL
    AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION
      'Agent deletion time is immutable once set'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
    RAISE EXCEPTION
      'an archived Agent cannot be restored'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.status <> 'archived'
    AND NEW.status NOT IN (
      CASE OLD.status
        WHEN 'draft' THEN 'draft'
        WHEN 'active' THEN 'active'
        WHEN 'restricted' THEN 'restricted'
        WHEN 'suspended' THEN 'suspended'
        ELSE OLD.status
      END,
      'active',
      'restricted',
      'suspended',
      'archived'
    ) THEN
    RAISE EXCEPTION
      'invalid Agent lifecycle transition'
      USING ERRCODE = '22023';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER agents_prepare_update
BEFORE UPDATE ON platform.agents
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_agent_update();

REVOKE ALL ON FUNCTION platform.prepare_agent_update() FROM PUBLIC;

CREATE FUNCTION platform.validate_agent_actor_coherence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  target_actor_id uuid;
  actor_record record;
  agent_record record;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME NOT IN ('actors', 'agents')
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION
      'Agent and Actor coherence validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF TG_TABLE_NAME = 'actors' THEN
    target_actor_id := NEW.id;
  ELSE
    target_actor_id := NEW.actor_id;
  END IF;

  SELECT actor.id, actor.kind, actor.owner_id, actor.status, actor.deleted_at
  INTO actor_record
  FROM platform.actors AS actor
  WHERE actor.id = target_actor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Agent Actor identity is missing'
      USING ERRCODE = '23503';
  END IF;

  SELECT agent.id, agent.owner_id, agent.status, agent.deleted_at
  INTO agent_record
  FROM platform.agents AS agent
  WHERE agent.actor_id = target_actor_id;

  IF actor_record.kind = 'human' THEN
    IF FOUND THEN
      RAISE EXCEPTION
        'a human Actor cannot back an Agent'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'every Agent Actor must have exactly one Agent record'
      USING ERRCODE = '23514';
  END IF;

  IF agent_record.owner_id IS DISTINCT FROM actor_record.owner_id
    OR agent_record.status IS DISTINCT FROM actor_record.status
    OR (agent_record.deleted_at IS NULL) IS DISTINCT FROM
      (actor_record.deleted_at IS NULL) THEN
    RAISE EXCEPTION
      'Agent and Actor ownership, status, and deletion state must remain coherent'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER actors_validate_agent_coherence
AFTER INSERT OR UPDATE ON platform.actors
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_agent_actor_coherence();

CREATE CONSTRAINT TRIGGER agents_validate_actor_coherence
AFTER INSERT OR UPDATE ON platform.agents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_agent_actor_coherence();

REVOKE ALL ON FUNCTION platform.validate_agent_actor_coherence() FROM PUBLIC;

CREATE FUNCTION platform.validate_active_agent_capacity_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  reserved_count bigint;
  actual_count bigint;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME NOT IN ('agents', 'registration_controls')
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION
      'active Agent capacity validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  SELECT controls.active_agent_count
  INTO reserved_count
  FROM platform.registration_controls AS controls
  WHERE controls.id = true;

  SELECT count(*)
  INTO actual_count
  FROM platform.agents AS agent
  WHERE agent.activated_at IS NOT NULL
    AND agent.status <> 'archived';

  IF reserved_count IS DISTINCT FROM actual_count THEN
    RAISE EXCEPTION
      'registration active Agent count must match non-archived activated Agents'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER agents_validate_capacity_count
AFTER INSERT OR UPDATE ON platform.agents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_active_agent_capacity_count();

CREATE CONSTRAINT TRIGGER registration_controls_validate_capacity_count
AFTER UPDATE ON platform.registration_controls
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_active_agent_capacity_count();

REVOKE ALL ON FUNCTION platform.validate_active_agent_capacity_count() FROM PUBLIC;

CREATE FUNCTION platform.validate_exactly_one_active_agent_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  target_agent_id uuid;
  active_policy_count bigint;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME NOT IN ('agents', 'agent_policies')
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION
      'active Agent policy validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF TG_TABLE_NAME = 'agents' THEN
    target_agent_id := NEW.id;
  ELSE
    target_agent_id := NEW.agent_id;
  END IF;

  SELECT count(*)
  INTO active_policy_count
  FROM platform.agent_policies AS policy
  WHERE policy.agent_id = target_agent_id
    AND policy.is_active;

  IF active_policy_count <> 1 THEN
    RAISE EXCEPTION
      'every Agent must have exactly one active policy'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER agents_require_active_policy
AFTER INSERT OR UPDATE ON platform.agents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_exactly_one_active_agent_policy();

CREATE CONSTRAINT TRIGGER agent_policies_require_one_active
AFTER INSERT OR UPDATE ON platform.agent_policies
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_exactly_one_active_agent_policy();

REVOKE ALL ON FUNCTION platform.validate_exactly_one_active_agent_policy() FROM PUBLIC;

CREATE FUNCTION platform.prepare_agent_policy_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'agent_policies'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Agent policy update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
    OR NEW.tier IS DISTINCT FROM OLD.tier
    OR NEW.defaults_version IS DISTINCT FROM OLD.defaults_version
    OR NEW.policy_schema_version IS DISTINCT FROM OLD.policy_schema_version
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.rules IS DISTINCT FROM OLD.rules
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.configured_by_owner_id IS DISTINCT FROM OLD.configured_by_owner_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Agent policy versions are immutable'
      USING ERRCODE = '22023';
  END IF;

  IF NOT OLD.is_active AND NEW.is_active THEN
    RAISE EXCEPTION
      'an inactive Agent policy version cannot be reactivated'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_policies_prepare_update
BEFORE UPDATE ON platform.agent_policies
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_agent_policy_update();

REVOKE ALL ON FUNCTION platform.prepare_agent_policy_update() FROM PUBLIC;

CREATE FUNCTION platform.validate_credential_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  owner_record record;
  agent_record record;
  predecessor_record record;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'credentials'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Credential insert validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  SELECT owner.status, owner.email_verified_at, owner.deleted_at
  INTO owner_record
  FROM platform.owners AS owner
  WHERE owner.id = NEW.owner_id;

  IF NOT FOUND
    OR owner_record.status IS DISTINCT FROM 'active'
    OR owner_record.email_verified_at IS NULL
    OR owner_record.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'only an active, verified Owner may issue a Credential'
      USING ERRCODE = '42501';
  END IF;

  SELECT agent.owner_id, agent.status, agent.deleted_at
  INTO agent_record
  FROM platform.agents AS agent
  WHERE agent.id = NEW.agent_id;

  IF NOT FOUND
    OR agent_record.owner_id IS DISTINCT FROM NEW.owner_id
    OR agent_record.status IS DISTINCT FROM 'active'
    OR agent_record.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Credentials may only be issued to an active Agent owned by the Owner'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.replaces_credential_id IS NOT NULL THEN
    SELECT credential.owner_id,
           credential.agent_id,
           credential.credential_type,
           credential.revoked_at
    INTO predecessor_record
    FROM platform.credentials AS credential
    WHERE credential.id = NEW.replaces_credential_id;

    IF NOT FOUND
      OR predecessor_record.owner_id IS DISTINCT FROM NEW.owner_id
      OR predecessor_record.agent_id IS DISTINCT FROM NEW.agent_id
      OR predecessor_record.credential_type IS DISTINCT FROM NEW.credential_type
      OR predecessor_record.revoked_at IS NULL THEN
      RAISE EXCEPTION
        'a rotated Credential must replace a revoked Credential in the same ownership chain'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER credentials_validate_insert
BEFORE INSERT ON platform.credentials
FOR EACH ROW
EXECUTE FUNCTION platform.validate_credential_insert();

REVOKE ALL ON FUNCTION platform.validate_credential_insert() FROM PUBLIC;

CREATE FUNCTION platform.prepare_credential_update()
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

CREATE TRIGGER credentials_prepare_update
BEFORE UPDATE ON platform.credentials
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_credential_update();

REVOKE ALL ON FUNCTION platform.prepare_credential_update() FROM PUBLIC;

CREATE FUNCTION platform.validate_action_log_actor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actual_kind text;
  actual_owner_id uuid;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'action_logs'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'ActionLog Actor validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.actor_id IS NOT NULL THEN
    SELECT actor.kind, actor.owner_id
    INTO actual_kind, actual_owner_id
    FROM platform.actors AS actor
    WHERE actor.id = NEW.actor_id;

    IF NOT FOUND
      OR actual_kind IS DISTINCT FROM NEW.actor_kind
      OR actual_owner_id IS DISTINCT FROM NEW.owner_id THEN
      RAISE EXCEPTION
        'ActionLog Actor snapshot must match the stable Actor ownership chain'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER action_logs_validate_actor
BEFORE INSERT ON platform.action_logs
FOR EACH ROW
EXECUTE FUNCTION platform.validate_action_log_actor();

REVOKE ALL ON FUNCTION platform.validate_action_log_actor() FROM PUBLIC;

CREATE FUNCTION platform.prevent_protected_identity_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME NOT IN ('actors', 'agents', 'agent_policies', 'credentials')
    OR TG_OP <> 'DELETE' THEN
    RAISE EXCEPTION
      'protected identity delete trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  RAISE EXCEPTION
    'identity, policy, and Credential records cannot be hard deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER actors_prevent_delete
BEFORE DELETE ON platform.actors
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_protected_identity_delete();

CREATE TRIGGER agents_prevent_delete
BEFORE DELETE ON platform.agents
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_protected_identity_delete();

CREATE TRIGGER agent_policies_prevent_delete
BEFORE DELETE ON platform.agent_policies
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_protected_identity_delete();

CREATE TRIGGER credentials_prevent_delete
BEFORE DELETE ON platform.credentials
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_protected_identity_delete();

REVOKE ALL ON FUNCTION platform.prevent_protected_identity_delete() FROM PUBLIC;

CREATE FUNCTION platform.prevent_action_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'action_logs'
    OR TG_OP NOT IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION
      'ActionLog immutability trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  RAISE EXCEPTION
    'ActionLog records are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER action_logs_prevent_mutation
BEFORE UPDATE OR DELETE ON platform.action_logs
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_action_log_mutation();

REVOKE ALL ON FUNCTION platform.prevent_action_log_mutation() FROM PUBLIC;
