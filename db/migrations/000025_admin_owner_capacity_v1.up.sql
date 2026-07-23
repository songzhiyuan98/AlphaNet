SET LOCAL search_path = pg_catalog;

ALTER TABLE platform.owners
  ADD COLUMN quota_version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT owners_quota_version_positive
    CHECK (quota_version > 0);

CREATE TABLE platform.owner_agent_quota_overrides (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL
    REFERENCES platform.owners(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  max_active_agents integer NOT NULL,
  reason_code text NOT NULL,
  set_by_admin_id uuid NOT NULL
    REFERENCES platform.admins(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_admin_id uuid
    REFERENCES platform.admins(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT owner_agent_quota_overrides_limit
    CHECK (max_active_agents BETWEEN 1 AND 1000),
  CONSTRAINT owner_agent_quota_overrides_reason
    CHECK (
      reason_code IN (
        'validated_operational_need',
        'research_team_expansion',
        'migration_support',
        'abuse_mitigation',
        'security_incident'
      )
    ),
  CONSTRAINT owner_agent_quota_overrides_expiry
    CHECK (
      expires_at > created_at + interval '1 hour'
      AND expires_at <= created_at + interval '90 days'
    ),
  CONSTRAINT owner_agent_quota_overrides_revocation
    CHECK (
      (
        revoked_at IS NULL
        AND revoked_by_admin_id IS NULL
      )
      OR (
        revoked_at IS NOT NULL
        AND revoked_at >= created_at
        AND revoked_by_admin_id IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX owner_agent_quota_overrides_one_unrevoked
  ON platform.owner_agent_quota_overrides (owner_id)
  WHERE revoked_at IS NULL;

CREATE INDEX owner_agent_quota_overrides_owner_history
  ON platform.owner_agent_quota_overrides (
    owner_id,
    created_at DESC,
    id DESC
  );

COMMENT ON COLUMN platform.owners.quota_version IS
  'Monotonic workforce quota-governance version; ordinary Owner profile and Agent changes do not advance it.';

COMMENT ON TABLE platform.owner_agent_quota_overrides IS
  'Temporary, append-preserving workforce overrides of an Owner active-Agent limit. Expired rows are ineffective without mutation.';

CREATE FUNCTION platform.guard_owner_agent_quota_override_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'owner_agent_quota_overrides' THEN
    RAISE EXCEPTION
      'Owner quota override guard invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Owner quota override history cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP <> 'UPDATE'
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.max_active_agents IS DISTINCT FROM OLD.max_active_agents
    OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
    OR NEW.set_by_admin_id IS DISTINCT FROM OLD.set_by_admin_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL
    OR NEW.revoked_by_admin_id IS NULL THEN
    RAISE EXCEPTION
      'Owner quota overrides only allow a first revocation'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER owner_agent_quota_overrides_guard_mutation
BEFORE UPDATE OR DELETE ON platform.owner_agent_quota_overrides
FOR EACH ROW
EXECUTE FUNCTION platform.guard_owner_agent_quota_override_mutation();

REVOKE ALL ON FUNCTION platform.guard_owner_agent_quota_override_mutation()
  FROM PUBLIC;

CREATE TABLE platform.owner_capacity_admin_actions (
  id uuid PRIMARY KEY,
  admin_id uuid NOT NULL
    REFERENCES platform.admins(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  permission_used text NOT NULL,
  target_kind text NOT NULL,
  owner_id uuid
    REFERENCES platform.owners(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  action text NOT NULL,
  reason_code text NOT NULL,
  version_before bigint NOT NULL,
  version_after bigint NOT NULL,
  idempotency_key text NOT NULL,
  request_digest bytea NOT NULL,
  request_id text NOT NULL,
  authorization_snapshot jsonb NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  response_snapshot jsonb NOT NULL,
  action_log_id uuid NOT NULL
    REFERENCES platform.action_logs(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  outbox_event_id uuid NOT NULL
    REFERENCES system.outbox_events(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT owner_capacity_admin_actions_idempotency_unique
    UNIQUE (admin_id, idempotency_key),
  CONSTRAINT owner_capacity_admin_actions_action_log_unique
    UNIQUE (action_log_id),
  CONSTRAINT owner_capacity_admin_actions_outbox_unique
    UNIQUE (outbox_event_id),
  CONSTRAINT owner_capacity_admin_actions_permission
    CHECK (permission_used = 'identity:quota_manage'),
  CONSTRAINT owner_capacity_admin_actions_target
    CHECK (
      (
        target_kind = 'owner_quota'
        AND owner_id IS NOT NULL
        AND action IN ('set_override', 'revoke_override')
      )
      OR (
        target_kind = 'registration_control'
        AND owner_id IS NULL
        AND action IN (
          'pause_registration',
          'resume_registration',
          'set_capacity_limits'
        )
      )
    ),
  CONSTRAINT owner_capacity_admin_actions_reason
    CHECK (
      (
        target_kind = 'owner_quota'
        AND reason_code IN (
          'validated_operational_need',
          'research_team_expansion',
          'migration_support',
          'abuse_mitigation',
          'security_incident'
        )
      )
      OR (
        action = 'pause_registration'
        AND reason_code IN (
          'capacity_threshold_reached',
          'automated_abuse_incident',
          'security_incident',
          'infrastructure_degradation'
        )
      )
      OR (
        action = 'resume_registration'
        AND reason_code IN (
          'capacity_available',
          'incident_resolved',
          'false_positive_corrected'
        )
      )
      OR (
        action = 'set_capacity_limits'
        AND reason_code = 'validated_operational_need'
      )
    ),
  CONSTRAINT owner_capacity_admin_actions_version_advance
    CHECK (
      version_before > 0
      AND version_after = version_before + 1
    ),
  CONSTRAINT owner_capacity_admin_actions_idempotency_key_size
    CHECK (
      length(idempotency_key) BETWEEN 1 AND 200
      AND idempotency_key !~ '[[:cntrl:]]'
      AND idempotency_key !~ ','
    ),
  CONSTRAINT owner_capacity_admin_actions_request_digest_sha256
    CHECK (octet_length(request_digest) = 32),
  CONSTRAINT owner_capacity_admin_actions_request_id_size
    CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  CONSTRAINT owner_capacity_admin_actions_snapshot_objects
    CHECK (
      jsonb_typeof(authorization_snapshot) = 'object'
      AND platform.audit_json_is_secret_free(authorization_snapshot)
      AND jsonb_typeof(before_state) = 'object'
      AND platform.audit_json_is_secret_free(before_state)
      AND jsonb_typeof(after_state) = 'object'
      AND platform.audit_json_is_secret_free(after_state)
      AND jsonb_typeof(response_snapshot) = 'object'
      AND platform.audit_json_is_secret_free(response_snapshot)
    ),
  CONSTRAINT owner_capacity_admin_actions_time
    CHECK (created_at >= occurred_at)
);

CREATE INDEX owner_capacity_admin_actions_owner_occurred
  ON platform.owner_capacity_admin_actions (
    owner_id,
    occurred_at DESC,
    id DESC
  )
  WHERE owner_id IS NOT NULL;

COMMENT ON TABLE platform.owner_capacity_admin_actions IS
  'Append-only idempotency, frozen response and same-transaction provenance for Owner quota and registration capacity governance.';

CREATE FUNCTION platform.prevent_owner_capacity_admin_action_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'Owner capacity Admin actions are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER owner_capacity_admin_actions_prevent_mutation
BEFORE UPDATE OR DELETE ON platform.owner_capacity_admin_actions
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_owner_capacity_admin_action_mutation();

REVOKE ALL ON FUNCTION platform.prevent_owner_capacity_admin_action_mutation()
  FROM PUBLIC;

CREATE FUNCTION platform.validate_owner_capacity_admin_action_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  action_xid xid;
  expected_log_action text;
  expected_event_type text;
  expected_target_type text;
  expected_target_id text;
  expected_aggregate_type text;
  expected_aggregate_id text;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'owner_capacity_admin_actions'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Owner capacity Admin provenance validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  expected_log_action := CASE NEW.action
    WHEN 'set_override' THEN 'owner.agent_quota_override.set'
    WHEN 'revoke_override' THEN 'owner.agent_quota_override.revoke'
    WHEN 'pause_registration' THEN 'registration.pause'
    WHEN 'resume_registration' THEN 'registration.resume'
    WHEN 'set_capacity_limits' THEN 'registration.capacity_limits.set'
    ELSE NULL
  END;
  expected_event_type := CASE NEW.action
    WHEN 'set_override' THEN 'owner.agent_quota_override_set'
    WHEN 'revoke_override' THEN 'owner.agent_quota_override_revoked'
    WHEN 'pause_registration' THEN 'registration.paused'
    WHEN 'resume_registration' THEN 'registration.resumed'
    WHEN 'set_capacity_limits' THEN 'registration.capacity_limits_changed'
    ELSE NULL
  END;
  expected_target_type := CASE NEW.target_kind
    WHEN 'owner_quota' THEN 'owner'
    WHEN 'registration_control' THEN 'registration_control'
    ELSE NULL
  END;
  expected_target_id := CASE NEW.target_kind
    WHEN 'owner_quota' THEN NEW.owner_id::text
    WHEN 'registration_control' THEN 'singleton'
    ELSE NULL
  END;
  expected_aggregate_type := CASE NEW.target_kind
    WHEN 'owner_quota' THEN 'owner'
    WHEN 'registration_control' THEN 'registration_control'
    ELSE NULL
  END;
  expected_aggregate_id := expected_target_id;

  SELECT action.xmin
  INTO action_xid
  FROM platform.owner_capacity_admin_actions AS action
  WHERE action.id = NEW.id;

  IF NOT EXISTS (
    SELECT 1
    FROM platform.action_logs AS log
    WHERE log.id = NEW.action_log_id
      AND log.xmin = action_xid
      AND log.event_class = 'governance'
      AND log.admin_id = NEW.admin_id
      AND log.owner_id IS NOT DISTINCT FROM NEW.owner_id
      AND log.agent_id IS NULL
      AND log.credential_id IS NULL
      AND log.channel = 'admin_web'
      AND log.approval_method = 'admin_override'
      AND log.authentication_assurance = 'workforce_oidc'
      AND log.authorization_snapshot = NEW.authorization_snapshot
      AND log.action = expected_log_action
      AND log.target_type = expected_target_type
      AND log.target_id = expected_target_id
      AND log.decision = 'allow'
      AND log.outcome = 'succeeded'
      AND log.outbox_event_id = NEW.outbox_event_id
      AND log.request_id = NEW.request_id
      AND log.before_state = NEW.before_state
      AND log.after_state = NEW.after_state
      AND log.reason_code = NEW.reason_code
      AND log.occurred_at = NEW.occurred_at
  ) THEN
    RAISE EXCEPTION
      'Owner capacity Admin action requires matching ActionLog provenance'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM system.outbox_events AS event
    WHERE event.id = NEW.outbox_event_id
      AND event.xmin = action_xid
      AND event.aggregate_type = expected_aggregate_type
      AND event.aggregate_id = expected_aggregate_id
      AND event.event_type = expected_event_type
      AND event.event_version = 1
      AND event.occurred_at = NEW.occurred_at
  ) THEN
    RAISE EXCEPTION
      'Owner capacity Admin action requires matching Outbox provenance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER owner_capacity_admin_actions_validate_provenance
AFTER INSERT ON platform.owner_capacity_admin_actions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_owner_capacity_admin_action_provenance();

REVOKE ALL ON FUNCTION platform.validate_owner_capacity_admin_action_provenance()
  FROM PUBLIC;

CREATE FUNCTION platform.validate_owner_capacity_log_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  log_xid xid;
BEGIN
  IF NEW.event_class <> 'governance'
    OR NEW.action NOT IN (
      'owner.agent_quota_override.set',
      'owner.agent_quota_override.revoke',
      'registration.pause',
      'registration.resume',
      'registration.capacity_limits.set'
    ) THEN
    RETURN NULL;
  END IF;

  SELECT log.xmin
  INTO log_xid
  FROM platform.action_logs AS log
  WHERE log.id = NEW.id;

  IF NOT EXISTS (
    SELECT 1
    FROM platform.owner_capacity_admin_actions AS action
    WHERE action.action_log_id = NEW.id
      AND action.xmin = log_xid
  ) THEN
    RAISE EXCEPTION
      'Owner capacity ActionLog requires same-transaction action provenance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER action_logs_validate_owner_capacity_provenance
AFTER INSERT ON platform.action_logs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_owner_capacity_log_provenance();

REVOKE ALL ON FUNCTION platform.validate_owner_capacity_log_provenance()
  FROM PUBLIC;

CREATE FUNCTION platform.validate_owner_capacity_outbox_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  event_xid xid;
BEGIN
  IF NEW.event_type NOT IN (
    'owner.agent_quota_override_set',
    'owner.agent_quota_override_revoked',
    'registration.paused',
    'registration.resumed',
    'registration.capacity_limits_changed'
  ) THEN
    RETURN NULL;
  END IF;

  SELECT event.xmin
  INTO event_xid
  FROM system.outbox_events AS event
  WHERE event.id = NEW.id;

  IF NOT EXISTS (
    SELECT 1
    FROM platform.owner_capacity_admin_actions AS action
    WHERE action.outbox_event_id = NEW.id
      AND action.xmin = event_xid
  ) THEN
    RAISE EXCEPTION
      'Owner capacity Outbox event requires same-transaction action provenance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER outbox_events_validate_owner_capacity_provenance
AFTER INSERT ON system.outbox_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_owner_capacity_outbox_provenance();

REVOKE ALL ON FUNCTION platform.validate_owner_capacity_outbox_provenance()
  FROM PUBLIC;
