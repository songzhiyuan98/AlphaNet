SET LOCAL search_path = pg_catalog;

-- One security-administrator-only permission for platform-wide incident
-- containment. Existing roles and assignments remain unchanged.
ALTER TABLE platform.admin_role_permissions
  DROP CONSTRAINT admin_role_permissions_permission;

ALTER TABLE platform.admin_role_permissions
  ADD CONSTRAINT admin_role_permissions_permission
  CHECK (
    permission IN (
      'moderation:read',
      'moderation:decide',
      'identity:restrict',
      'identity:quota_manage',
      'credential:revoke',
      'community:manage',
      'platform:operate',
      'audit:read',
      'admin:role_assign'
    )
  );

INSERT INTO platform.admin_role_permissions (role_id, permission)
VALUES (
  '4b756e75-bf2d-4aa4-8ac4-5bd474290105',
  'platform:operate'
);

CREATE TABLE platform.community_write_controls (
  id boolean PRIMARY KEY DEFAULT true,
  mode text NOT NULL DEFAULT 'open',
  version bigint NOT NULL DEFAULT 1,
  pause_reason_code text,
  paused_at timestamptz,
  resume_condition text,
  updated_by_admin_id uuid
    REFERENCES platform.admins(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_write_controls_singleton
    CHECK (id),
  CONSTRAINT community_write_controls_mode
    CHECK (mode IN ('open', 'paused')),
  CONSTRAINT community_write_controls_version
    CHECK (version > 0),
  CONSTRAINT community_write_controls_pause_reason
    CHECK (
      pause_reason_code IS NULL
      OR pause_reason_code IN (
        'security_incident',
        'integrity_incident',
        'infrastructure_degradation',
        'emergency_maintenance'
      )
    ),
  CONSTRAINT community_write_controls_resume_condition
    CHECK (
      resume_condition IS NULL
      OR (
        length(btrim(resume_condition)) BETWEEN 1 AND 1000
        AND resume_condition !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT community_write_controls_state
    CHECK (
      (
        mode = 'open'
        AND pause_reason_code IS NULL
        AND paused_at IS NULL
        AND resume_condition IS NULL
      )
      OR (
        mode = 'paused'
        AND pause_reason_code IS NOT NULL
        AND paused_at IS NOT NULL
        AND resume_condition IS NOT NULL
        AND updated_by_admin_id IS NOT NULL
      )
    ),
  CONSTRAINT community_write_controls_updated_after_created
    CHECK (updated_at >= created_at)
);

INSERT INTO platform.community_write_controls (id)
VALUES (true);

COMMENT ON TABLE platform.community_write_controls IS
  'Versioned singleton emergency gate for new community Research, Reaction, and Follow mutations.';

CREATE FUNCTION platform.prepare_community_write_control_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'community_write_controls'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Community-write control update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
    RAISE EXCEPTION
      'Community-write control owns identity, version, and timestamps'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.mode IS NOT DISTINCT FROM OLD.mode THEN
    RAISE EXCEPTION
      'Community-write control requires a state transition'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.mode = 'open' AND NEW.mode = 'paused' THEN
    IF NEW.pause_reason_code IS NULL
      OR NEW.resume_condition IS NULL
      OR NEW.updated_by_admin_id IS NULL THEN
      RAISE EXCEPTION
        'Pausing community writes requires reason, recovery condition, and Admin'
        USING ERRCODE = '22023';
    END IF;
    NEW.paused_at := clock_timestamp();
  ELSIF OLD.mode = 'paused' AND NEW.mode = 'open' THEN
    IF NEW.updated_by_admin_id IS NULL THEN
      RAISE EXCEPTION
        'Resuming community writes requires an Admin'
        USING ERRCODE = '22023';
    END IF;
    NEW.pause_reason_code := NULL;
    NEW.paused_at := NULL;
    NEW.resume_condition := NULL;
  ELSE
    RAISE EXCEPTION
      'Unsupported community-write control transition'
      USING ERRCODE = '22023';
  END IF;

  NEW.version := OLD.version + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_write_controls_prepare_update
BEFORE UPDATE ON platform.community_write_controls
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_community_write_control_update();

REVOKE ALL ON FUNCTION platform.prepare_community_write_control_update()
  FROM PUBLIC;

CREATE FUNCTION platform.prevent_community_write_control_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'Community-write control cannot be deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER community_write_controls_prevent_delete
BEFORE DELETE ON platform.community_write_controls
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_community_write_control_delete();

REVOKE ALL ON FUNCTION platform.prevent_community_write_control_delete()
  FROM PUBLIC;

CREATE TABLE platform.community_write_control_admin_actions (
  id uuid PRIMARY KEY,
  admin_id uuid NOT NULL
    REFERENCES platform.admins(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  permission_used text NOT NULL,
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
  CONSTRAINT community_write_control_actions_idempotency_unique
    UNIQUE (admin_id, idempotency_key),
  CONSTRAINT community_write_control_actions_action_log_unique
    UNIQUE (action_log_id),
  CONSTRAINT community_write_control_actions_outbox_unique
    UNIQUE (outbox_event_id),
  CONSTRAINT community_write_control_actions_permission
    CHECK (permission_used = 'platform:operate'),
  CONSTRAINT community_write_control_actions_action
    CHECK (action IN ('pause_community_writes', 'resume_community_writes')),
  CONSTRAINT community_write_control_actions_reason
    CHECK (
      (
        action = 'pause_community_writes'
        AND reason_code IN (
          'security_incident',
          'integrity_incident',
          'infrastructure_degradation',
          'emergency_maintenance'
        )
      )
      OR (
        action = 'resume_community_writes'
        AND reason_code IN (
          'incident_resolved',
          'integrity_restored',
          'infrastructure_recovered',
          'maintenance_completed',
          'false_positive_corrected'
        )
      )
    ),
  CONSTRAINT community_write_control_actions_version_advance
    CHECK (version_before > 0 AND version_after = version_before + 1),
  CONSTRAINT community_write_control_actions_idempotency_key_size
    CHECK (
      length(idempotency_key) BETWEEN 1 AND 200
      AND idempotency_key !~ '[[:cntrl:]]'
      AND idempotency_key !~ ','
    ),
  CONSTRAINT community_write_control_actions_request_digest_sha256
    CHECK (octet_length(request_digest) = 32),
  CONSTRAINT community_write_control_actions_request_id_size
    CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  CONSTRAINT community_write_control_actions_snapshots
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
  CONSTRAINT community_write_control_actions_time
    CHECK (created_at >= occurred_at)
);

COMMENT ON TABLE platform.community_write_control_admin_actions IS
  'Append-only idempotency, response, and same-transaction provenance for platform community-write incident transitions.';

CREATE FUNCTION platform.prevent_community_write_control_action_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'Community-write control Admin actions are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER community_write_control_actions_prevent_mutation
BEFORE UPDATE OR DELETE ON platform.community_write_control_admin_actions
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_community_write_control_action_mutation();

REVOKE ALL ON FUNCTION platform.prevent_community_write_control_action_mutation()
  FROM PUBLIC;

CREATE FUNCTION platform.validate_community_write_control_action_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  action_xid xid;
  expected_log_action text;
  expected_event_type text;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'community_write_control_admin_actions'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Community-write action provenance validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  expected_log_action := CASE NEW.action
    WHEN 'pause_community_writes' THEN 'platform.community_writes.pause'
    WHEN 'resume_community_writes' THEN 'platform.community_writes.resume'
    ELSE NULL
  END;
  expected_event_type := CASE NEW.action
    WHEN 'pause_community_writes' THEN 'platform.community_writes_paused'
    WHEN 'resume_community_writes' THEN 'platform.community_writes_resumed'
    ELSE NULL
  END;

  SELECT action.xmin
  INTO action_xid
  FROM platform.community_write_control_admin_actions AS action
  WHERE action.id = NEW.id;

  IF NOT EXISTS (
    SELECT 1
    FROM platform.action_logs AS log
    WHERE log.id = NEW.action_log_id
      AND log.xmin = action_xid
      AND log.event_class = 'governance'
      AND log.admin_id = NEW.admin_id
      AND log.owner_id IS NULL
      AND log.agent_id IS NULL
      AND log.credential_id IS NULL
      AND log.channel = 'admin_web'
      AND log.approval_method = 'admin_override'
      AND log.authentication_assurance = 'workforce_oidc'
      AND log.authorization_snapshot = NEW.authorization_snapshot
      AND log.action = expected_log_action
      AND log.target_type = 'community_write_control'
      AND log.target_id = 'singleton'
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
      'Community-write Admin action requires matching ActionLog provenance'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM system.outbox_events AS event
    WHERE event.id = NEW.outbox_event_id
      AND event.xmin = action_xid
      AND event.aggregate_type = 'community_write_control'
      AND event.aggregate_id = 'singleton'
      AND event.event_type = expected_event_type
      AND event.event_version = 1
      AND event.occurred_at = NEW.occurred_at
  ) THEN
    RAISE EXCEPTION
      'Community-write Admin action requires matching Outbox provenance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER community_write_control_actions_validate_provenance
AFTER INSERT ON platform.community_write_control_admin_actions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_community_write_control_action_provenance();

REVOKE ALL ON FUNCTION platform.validate_community_write_control_action_provenance()
  FROM PUBLIC;

CREATE FUNCTION platform.validate_community_write_control_log_provenance()
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
      'platform.community_writes.pause',
      'platform.community_writes.resume'
    ) THEN
    RETURN NULL;
  END IF;

  SELECT log.xmin
  INTO log_xid
  FROM platform.action_logs AS log
  WHERE log.id = NEW.id;

  IF NOT EXISTS (
    SELECT 1
    FROM platform.community_write_control_admin_actions AS action
    WHERE action.action_log_id = NEW.id
      AND action.xmin = log_xid
  ) THEN
    RAISE EXCEPTION
      'Community-write ActionLog requires same-transaction action provenance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER action_logs_validate_community_write_control_provenance
AFTER INSERT ON platform.action_logs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_community_write_control_log_provenance();

REVOKE ALL ON FUNCTION platform.validate_community_write_control_log_provenance()
  FROM PUBLIC;

CREATE FUNCTION platform.validate_community_write_control_outbox_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  event_xid xid;
BEGIN
  IF NEW.event_type NOT IN (
    'platform.community_writes_paused',
    'platform.community_writes_resumed'
  ) THEN
    RETURN NULL;
  END IF;

  SELECT event.xmin
  INTO event_xid
  FROM system.outbox_events AS event
  WHERE event.id = NEW.id;

  IF NOT EXISTS (
    SELECT 1
    FROM platform.community_write_control_admin_actions AS action
    WHERE action.outbox_event_id = NEW.id
      AND action.xmin = event_xid
  ) THEN
    RAISE EXCEPTION
      'Community-write Outbox event requires same-transaction action provenance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER outbox_events_validate_community_write_control_provenance
AFTER INSERT ON system.outbox_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_community_write_control_outbox_provenance();

REVOKE ALL ON FUNCTION platform.validate_community_write_control_outbox_provenance()
  FROM PUBLIC;
