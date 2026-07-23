SET LOCAL search_path = pg_catalog;

ALTER TABLE platform.agents
  ADD COLUMN governance_version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT agents_governance_version_positive
    CHECK (governance_version > 0);

CREATE TABLE platform.agent_admin_actions (
  id uuid PRIMARY KEY,
  admin_id uuid NOT NULL
    REFERENCES platform.admins(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  permission_used text NOT NULL,
  action text NOT NULL,
  reason_code text NOT NULL,
  internal_note text,
  agent_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  governance_version_before bigint NOT NULL,
  governance_version_after bigint NOT NULL,
  revoked_credential_count integer NOT NULL DEFAULT 0,
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
  CONSTRAINT agent_admin_actions_agent_owner
    FOREIGN KEY (agent_id, owner_id)
    REFERENCES platform.agents(id, owner_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT agent_admin_actions_idempotency_unique
    UNIQUE (admin_id, idempotency_key),
  CONSTRAINT agent_admin_actions_action_log_unique
    UNIQUE (action_log_id),
  CONSTRAINT agent_admin_actions_outbox_unique
    UNIQUE (outbox_event_id),
  CONSTRAINT agent_admin_actions_action
    CHECK (
      action IN (
        'restrict_agent',
        'suspend_agent',
        'restore_agent',
        'revoke_credentials'
      )
    ),
  CONSTRAINT agent_admin_actions_permission
    CHECK (
      (
        action IN ('restrict_agent', 'suspend_agent', 'restore_agent')
        AND permission_used = 'identity:restrict'
      )
      OR (
        action = 'revoke_credentials'
        AND permission_used = 'credential:revoke'
      )
    ),
  CONSTRAINT agent_admin_actions_reason
    CHECK (
      (
        action IN ('restrict_agent', 'suspend_agent')
        AND reason_code IN (
          'spam_automation',
          'coordinated_manipulation',
          'credential_compromise',
          'security_incident',
          'platform_policy_violation'
        )
      )
      OR (
        action = 'restore_agent'
        AND reason_code IN (
          'moderation_error_corrected',
          'owner_appeal_granted',
          'risk_condition_resolved'
        )
      )
      OR (
        action = 'revoke_credentials'
        AND reason_code IN (
          'credential_compromise',
          'security_incident',
          'platform_policy_violation'
        )
      )
    ),
  CONSTRAINT agent_admin_actions_version_advance
    CHECK (
      governance_version_before > 0
      AND governance_version_after = governance_version_before + 1
    ),
  CONSTRAINT agent_admin_actions_revoked_count
    CHECK (
      revoked_credential_count >= 0
      AND (
        action = 'revoke_credentials'
        OR revoked_credential_count = 0
      )
    ),
  CONSTRAINT agent_admin_actions_note
    CHECK (
      internal_note IS NULL
      OR (
        length(internal_note) BETWEEN 1 AND 4000
        AND octet_length(internal_note) <= 16384
        AND internal_note = btrim(internal_note)
        AND internal_note !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
      )
    ),
  CONSTRAINT agent_admin_actions_idempotency_key_size
    CHECK (
      length(idempotency_key) BETWEEN 1 AND 200
      AND idempotency_key !~ '[[:cntrl:]]'
    ),
  CONSTRAINT agent_admin_actions_request_digest_sha256
    CHECK (octet_length(request_digest) = 32),
  CONSTRAINT agent_admin_actions_request_id_size
    CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  CONSTRAINT agent_admin_actions_snapshot_objects
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
  CONSTRAINT agent_admin_actions_time
    CHECK (created_at >= occurred_at)
);

CREATE INDEX agent_admin_actions_agent_occurred_idx
  ON platform.agent_admin_actions (
    agent_id,
    occurred_at DESC,
    id DESC
  );

COMMENT ON COLUMN platform.agents.governance_version IS
  'Monotonic workforce-enforcement version; profile and Owner policy edits do not advance it.';

COMMENT ON TABLE platform.agent_admin_actions IS
  'Append-only idempotency, frozen response and same-transaction provenance for workforce Agent enforcement.';

CREATE FUNCTION platform.prevent_agent_admin_action_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'Agent Admin actions are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER agent_admin_actions_prevent_mutation
BEFORE UPDATE OR DELETE ON platform.agent_admin_actions
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_agent_admin_action_mutation();

REVOKE ALL ON FUNCTION platform.prevent_agent_admin_action_mutation()
  FROM PUBLIC;

CREATE FUNCTION platform.validate_agent_admin_action_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  action_xid xid;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'agent_admin_actions'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Agent Admin provenance validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  SELECT action.xmin
  INTO action_xid
  FROM platform.agent_admin_actions AS action
  WHERE action.id = NEW.id;

  IF NOT EXISTS (
    SELECT 1
    FROM platform.action_logs AS log
    WHERE log.id = NEW.action_log_id
      AND log.xmin = action_xid
      AND log.event_class = 'governance'
      AND log.admin_id = NEW.admin_id
      AND log.owner_id = NEW.owner_id
      AND log.agent_id = NEW.agent_id
      AND log.channel = 'admin_web'
      AND log.approval_method = 'admin_override'
      AND log.authentication_assurance = 'workforce_oidc'
      AND log.authorization_snapshot = NEW.authorization_snapshot
      AND log.action = CASE NEW.action
        WHEN 'restrict_agent' THEN 'agent.restrict'
        WHEN 'suspend_agent' THEN 'agent.suspend'
        WHEN 'restore_agent' THEN 'agent.restore'
        WHEN 'revoke_credentials' THEN 'credential.revoke_all'
        ELSE NULL
      END
      AND log.target_type = 'agent'
      AND log.target_id = NEW.agent_id::text
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
      'Agent Admin action requires matching ActionLog provenance'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM system.outbox_events AS event
    WHERE event.id = NEW.outbox_event_id
      AND event.xmin = action_xid
      AND event.aggregate_type = 'agent'
      AND event.aggregate_id = NEW.agent_id::text
      AND event.event_type = CASE NEW.action
        WHEN 'restrict_agent' THEN 'agent.restricted'
        WHEN 'suspend_agent' THEN 'agent.suspended'
        WHEN 'restore_agent' THEN 'agent.restored'
        WHEN 'revoke_credentials' THEN 'agent.credentials_revoked'
        ELSE NULL
      END
      AND event.event_version = 1
      AND event.occurred_at = NEW.occurred_at
  ) THEN
    RAISE EXCEPTION
      'Agent Admin action requires matching Outbox provenance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER agent_admin_actions_validate_provenance
AFTER INSERT ON platform.agent_admin_actions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_agent_admin_action_provenance();

REVOKE ALL ON FUNCTION platform.validate_agent_admin_action_provenance()
  FROM PUBLIC;

CREATE FUNCTION platform.validate_agent_governance_log_provenance()
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
      'agent.restrict',
      'agent.suspend',
      'agent.restore',
      'credential.revoke_all'
    ) THEN
    RETURN NULL;
  END IF;

  SELECT log.xmin
  INTO log_xid
  FROM platform.action_logs AS log
  WHERE log.id = NEW.id;

  IF NOT EXISTS (
    SELECT 1
    FROM platform.agent_admin_actions AS action
    WHERE action.action_log_id = NEW.id
      AND action.xmin = log_xid
  ) THEN
    RAISE EXCEPTION
      'Agent governance ActionLog requires same-transaction action provenance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER action_logs_validate_agent_governance_provenance
AFTER INSERT ON platform.action_logs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_agent_governance_log_provenance();

REVOKE ALL ON FUNCTION platform.validate_agent_governance_log_provenance()
  FROM PUBLIC;

CREATE FUNCTION platform.validate_agent_governance_outbox_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  event_xid xid;
BEGIN
  IF NEW.event_type NOT IN (
    'agent.restricted',
    'agent.suspended',
    'agent.restored',
    'agent.credentials_revoked'
  ) THEN
    RETURN NULL;
  END IF;

  SELECT event.xmin
  INTO event_xid
  FROM system.outbox_events AS event
  WHERE event.id = NEW.id;

  IF NOT EXISTS (
    SELECT 1
    FROM platform.agent_admin_actions AS action
    WHERE action.outbox_event_id = NEW.id
      AND action.xmin = event_xid
  ) THEN
    RAISE EXCEPTION
      'Agent governance Outbox event requires same-transaction action provenance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER outbox_events_validate_agent_governance_provenance
AFTER INSERT ON system.outbox_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_agent_governance_outbox_provenance();

REVOKE ALL ON FUNCTION platform.validate_agent_governance_outbox_provenance()
  FROM PUBLIC;
