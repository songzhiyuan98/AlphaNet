SET LOCAL search_path = pg_catalog;

-- PendingAction execution closure ------------------------------------------
--
-- 000006 intentionally stopped at durable encrypted commands and Agent-side
-- status reads. This migration adds the Owner-decision evidence and recoverable
-- execution invariants needed before an approved command can publish content.

-- Worker and reaper transitions are materially different from an Owner's
-- approval decision. Give them a dedicated, constrained audit class instead of
-- overloading approval_transition with a synthetic Owner approver.
ALTER TABLE platform.action_logs
  DROP CONSTRAINT action_logs_event_class,
  ADD CONSTRAINT action_logs_event_class
    CHECK (
      event_class IN (
        'domain_write',
        'authorization_change',
        'approval_transition',
        'pending_action_transition',
        'governance',
        'sensitive_read',
        'security_rejection'
      )
    ),
  ADD CONSTRAINT action_logs_pending_action_transition_shape
    CHECK (
      event_class <> 'pending_action_transition'
      OR (
        owner_id IS NOT NULL
        AND agent_id IS NOT NULL
        AND target_type = 'pending_action'
        AND target_id IS NOT NULL
        AND decision = 'require_approval'
        AND reason_code IS NOT NULL
      )
    );

-- Keep a durable PendingAction identity separate from the final domain
-- resource. Older API replicas may temporarily keep resource_id=action.id;
-- the replacement update trigger below permits that value to be normalized
-- exactly once when the logical operation becomes terminal.
ALTER TABLE platform.idempotency_records
  ADD COLUMN pending_action_id uuid;

ALTER TABLE platform.pending_actions
  DROP CONSTRAINT pending_actions_attempts,
  ADD COLUMN decision_audit_id uuid
    REFERENCES platform.action_logs(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  ADD COLUMN decision_reason_code text,
  ADD COLUMN failure_count integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT pending_actions_idempotency_action_pair_unique
    UNIQUE (idempotency_record_id, id),
  ADD CONSTRAINT pending_actions_decision_audit_shape
    CHECK (decision_audit_id IS NULL OR decided_at IS NOT NULL),
  ADD CONSTRAINT pending_actions_attempt_generation
    CHECK (attempt_count BETWEEN 0 AND 2000000000),
  ADD CONSTRAINT pending_actions_failure_budget
    CHECK (
      failure_count BETWEEN 0 AND 20
      AND failure_count <= attempt_count
    );

-- 000006 had no controlled decision reason. Populate the newly introduced
-- evidence without pretending it was part of the old row version; the trigger
-- is disabled only for this one append-only migration backfill.
ALTER TABLE platform.pending_actions
  DISABLE TRIGGER pending_actions_prepare_update;

UPDATE platform.pending_actions
SET decision_reason_code = CASE
      WHEN decided_at IS NULL THEN NULL
      WHEN state = 'rejected' THEN 'owner_rejected'
      WHEN state = 'cancelled' AND attempt_count = 0 THEN 'no_longer_needed'
      ELSE 'owner_approved'
    END,
    -- 000006 permitted approved rows with no schedule or with a schedule at
    -- or beyond expiry. Normalize both shapes before the stricter execution
    -- state and time constraints are installed below.
    next_attempt_at = CASE
      WHEN state = 'approved' THEN greatest(
        requested_at,
        least(
          coalesce(next_attempt_at, clock_timestamp()),
          expires_at - interval '1 microsecond'
        )
      )
      ELSE next_attempt_at
    END;

ALTER TABLE platform.pending_actions
  ENABLE TRIGGER pending_actions_prepare_update;

ALTER TABLE platform.pending_actions
  ADD CONSTRAINT pending_actions_decision_reason_code
    CHECK (
      (
        decided_at IS NULL
        AND decision_reason_code IS NULL
      )
      OR (
        decided_at IS NOT NULL
        AND decision_reason_code IN (
          'owner_approved',
          'owner_rejected',
          'needs_revision',
          'insufficient_evidence',
          'risk_not_accepted',
          'no_longer_needed'
        )
      )
    ),
  ADD CONSTRAINT pending_actions_decision_reason_state
    CHECK (
      (state = 'pending_approval' AND decision_reason_code IS NULL)
      OR (
        state IN ('approved', 'executing', 'succeeded', 'failed')
        AND decision_reason_code = 'owner_approved'
      )
      OR (
        state = 'rejected'
        AND decision_reason_code IN (
          'owner_rejected',
          'needs_revision',
          'insufficient_evidence',
          'risk_not_accepted',
          'no_longer_needed'
        )
      )
      OR (
        state = 'cancelled'
        AND decision_reason_code IN ('owner_approved', 'no_longer_needed')
      )
      OR (
        state IN ('expired', 'invalidated')
        AND decision_reason_code IN ('owner_approved')
      )
      OR (
        state IN ('expired', 'invalidated')
        AND decision_reason_code IS NULL
      )
    );

UPDATE platform.idempotency_records AS idempotency
SET pending_action_id = action.id
FROM platform.pending_actions AS action
WHERE idempotency.id = action.idempotency_record_id
  AND idempotency.pending_action_id IS NULL;

ALTER TABLE platform.idempotency_records
  ADD CONSTRAINT idempotency_records_pending_action
    FOREIGN KEY (id, pending_action_id)
    REFERENCES platform.pending_actions(idempotency_record_id, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT idempotency_records_resource_shape
    CHECK (
      (
        status IN ('admission_reserved', 'in_progress')
        AND resource_id IS NULL
      )
      OR (
        status = 'pending_approval'
        AND (
          resource_id IS NULL
          OR resource_id = pending_action_id
        )
      )
      OR (status = 'succeeded' AND resource_id IS NOT NULL)
      OR (status IN ('denied', 'failed') AND resource_id IS NULL)
    );

CREATE UNIQUE INDEX idempotency_records_pending_action_idx
  ON platform.idempotency_records (pending_action_id)
  WHERE pending_action_id IS NOT NULL;

COMMENT ON COLUMN platform.idempotency_records.pending_action_id IS
  'Stable authorization-workflow identity. Unlike resource_id, it remains the PendingAction ID after terminal success publishes a domain resource.';

COMMENT ON COLUMN platform.pending_actions.decision_audit_id IS
  'Owner approval or rejection ActionLog. Nullable during the 000006-to-000007 rolling deployment window; Phase 3 decision writers always populate it.';

COMMENT ON COLUMN platform.pending_actions.decision_reason_code IS
  'Controlled, immutable Owner decision reason. It contains no free-form rejection text.';

COMMENT ON COLUMN platform.pending_actions.attempt_count IS
  'Monotonic execution-lease generation used for fencing; it is not the retry failure budget.';

COMMENT ON COLUMN platform.pending_actions.failure_count IS
  'Bounded count of real transient execution failures. Rate and quota deferrals do not increment it.';

CREATE OR REPLACE FUNCTION platform.prepare_idempotency_update()
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
    OR NEW.first_received_at IS DISTINCT FROM OLD.first_received_at THEN
    RAISE EXCEPTION
      'Idempotency request identity is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.pending_action_id IS NOT NULL
    AND NEW.pending_action_id IS DISTINCT FROM OLD.pending_action_id THEN
    RAISE EXCEPTION
      'Idempotency PendingAction identity is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.pending_action_id IS NULL
    AND NEW.pending_action_id IS NOT NULL
    AND OLD.terminal_at IS NOT NULL THEN
    RAISE EXCEPTION
      'A terminal idempotency result cannot acquire a PendingAction identity'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.resource_id IS NOT NULL
    AND NEW.resource_id IS DISTINCT FROM OLD.resource_id
    AND NOT (
      OLD.status = 'pending_approval'
      AND OLD.pending_action_id = OLD.resource_id
      AND NEW.status IN ('succeeded', 'denied', 'failed')
      AND NEW.terminal_at IS NOT NULL
      AND (
        (NEW.status = 'succeeded' AND NEW.resource_id IS NOT NULL)
        OR (NEW.status IN ('denied', 'failed') AND NEW.resource_id IS NULL)
      )
    ) THEN
    RAISE EXCEPTION
      'Idempotency resource identity is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.terminal_at IS NOT NULL
    AND (
      NEW.status IS DISTINCT FROM OLD.status
      OR NEW.terminal_at IS DISTINCT FROM OLD.terminal_at
      OR NEW.response_code IS DISTINCT FROM OLD.response_code
      OR NEW.response_body IS DISTINCT FROM OLD.response_body
      OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
      OR NEW.pending_action_id IS DISTINCT FROM OLD.pending_action_id
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

REVOKE ALL ON FUNCTION platform.prepare_idempotency_update() FROM PUBLIC;

CREATE FUNCTION platform.link_pending_action_idempotency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'pending_actions'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'PendingAction idempotency linker invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  UPDATE platform.idempotency_records
  SET pending_action_id = NEW.id
  WHERE id = NEW.idempotency_record_id
    AND pending_action_id IS NULL;

  IF NOT EXISTS (
    SELECT 1
    FROM platform.idempotency_records AS idempotency
    WHERE idempotency.id = NEW.idempotency_record_id
      AND idempotency.pending_action_id = NEW.id
  ) THEN
    RAISE EXCEPTION
      'PendingAction could not establish its idempotency identity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER pending_actions_link_idempotency
AFTER INSERT ON platform.pending_actions
FOR EACH ROW
EXECUTE FUNCTION platform.link_pending_action_idempotency();

REVOKE ALL ON FUNCTION platform.link_pending_action_idempotency() FROM PUBLIC;

-- A PendingAction and its idempotency row are created in either order inside
-- one transaction. Validate the final row at commit instead of using an
-- immediate CHECK that would reject that safe deferred-FK insertion pattern.
CREATE FUNCTION platform.validate_idempotency_pending_action()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM platform.idempotency_records AS idempotency
    WHERE idempotency.id = NEW.id
      AND idempotency.status = 'pending_approval'
      AND idempotency.pending_action_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Pending approval idempotency result requires a PendingAction identity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER idempotency_records_validate_pending_action
AFTER INSERT OR UPDATE ON platform.idempotency_records
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_idempotency_pending_action();

REVOKE ALL ON FUNCTION platform.validate_idempotency_pending_action() FROM PUBLIC;

CREATE FUNCTION platform.validate_pending_action_idempotency_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  action_state text;
  expected_status text;
  linked_action_id uuid;
  linked_status text;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME NOT IN ('pending_actions', 'idempotency_records')
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION
      'PendingAction idempotency terminal validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF TG_TABLE_NAME = 'pending_actions' THEN
    IF NEW.state NOT IN (
      'succeeded',
      'rejected',
      'expired',
      'cancelled',
      'failed',
      'invalidated'
    ) THEN
      RETURN NEW;
    END IF;

    expected_status := CASE
      WHEN NEW.state = 'succeeded' THEN 'succeeded'
      WHEN NEW.state IN ('rejected', 'expired', 'cancelled') THEN 'denied'
      ELSE 'failed'
    END;

    SELECT idempotency.status, idempotency.pending_action_id
    INTO linked_status, linked_action_id
    FROM platform.idempotency_records AS idempotency
    WHERE idempotency.id = NEW.idempotency_record_id;

    IF NOT FOUND
      OR linked_status IS DISTINCT FROM expected_status
      OR linked_action_id IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION
        'Terminal PendingAction and idempotency result must commit together'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  SELECT idempotency.pending_action_id, idempotency.status
  INTO linked_action_id, linked_status
  FROM platform.idempotency_records AS idempotency
  WHERE idempotency.id = NEW.id;

  IF NOT FOUND OR linked_action_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT action.state
  INTO action_state
  FROM platform.pending_actions AS action
  WHERE action.id = linked_action_id
    AND action.idempotency_record_id = NEW.id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  expected_status := CASE
    WHEN action_state = 'succeeded' THEN 'succeeded'
    WHEN action_state IN ('rejected', 'expired', 'cancelled') THEN 'denied'
    WHEN action_state IN ('failed', 'invalidated') THEN 'failed'
    ELSE 'pending_approval'
  END;

  IF linked_status IS DISTINCT FROM expected_status THEN
    RAISE EXCEPTION
      'PendingAction idempotency status does not match the action state'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER pending_actions_validate_idempotency_terminal
AFTER INSERT OR UPDATE ON platform.pending_actions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_pending_action_idempotency_terminal();

CREATE CONSTRAINT TRIGGER idempotency_records_validate_action_terminal
AFTER INSERT OR UPDATE ON platform.idempotency_records
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_pending_action_idempotency_terminal();

REVOKE ALL ON FUNCTION platform.validate_pending_action_idempotency_terminal()
  FROM PUBLIC;

-- One row per acquired execution lease preserves history after the current
-- lease fields are cleared for backoff or invalidation.
CREATE TABLE platform.pending_action_attempts (
  action_id uuid NOT NULL
    REFERENCES platform.pending_actions(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  attempt_number integer NOT NULL,
  lease_owner text NOT NULL,
  lease_token_digest bytea NOT NULL,
  claimed_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL,
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'executing',
  error_code text,
  next_attempt_at timestamptz,
  claim_audit_id uuid
    REFERENCES platform.action_logs(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  finish_audit_id uuid
    REFERENCES platform.action_logs(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (action_id, attempt_number),
  CONSTRAINT pending_action_attempts_number
    CHECK (attempt_number BETWEEN 1 AND 2000000000),
  CONSTRAINT pending_action_attempts_lease_owner
    CHECK (length(btrim(lease_owner)) BETWEEN 1 AND 200),
  CONSTRAINT pending_action_attempts_token_digest
    CHECK (octet_length(lease_token_digest) = 32),
  CONSTRAINT pending_action_attempts_outcome
    CHECK (
      outcome IN (
        'executing',
        'deferred',
        'retry_scheduled',
        'lease_expired',
        'succeeded',
        'failed',
        'invalidated'
      )
    ),
  CONSTRAINT pending_action_attempts_error_code
    CHECK (
      error_code IS NULL
      OR error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'
    ),
  CONSTRAINT pending_action_attempts_state_shape
    CHECK (
      (
        outcome = 'executing'
        AND finished_at IS NULL
        AND error_code IS NULL
        AND next_attempt_at IS NULL
      )
      OR (
        outcome IN ('deferred', 'retry_scheduled', 'lease_expired')
        AND finished_at IS NOT NULL
        AND next_attempt_at IS NOT NULL
      )
      OR (
        outcome = 'succeeded'
        AND finished_at IS NOT NULL
        AND error_code IS NULL
        AND next_attempt_at IS NULL
      )
      OR (
        outcome IN ('failed', 'invalidated')
        AND finished_at IS NOT NULL
        AND error_code IS NOT NULL
        AND next_attempt_at IS NULL
      )
    ),
  CONSTRAINT pending_action_attempts_time_order
    CHECK (
      lease_expires_at > claimed_at
      AND last_heartbeat_at >= claimed_at
      AND lease_expires_at > last_heartbeat_at
      AND (finished_at IS NULL OR finished_at >= claimed_at)
      AND (next_attempt_at IS NULL OR next_attempt_at >= claimed_at)
      AND updated_at >= created_at
    )
);

CREATE INDEX pending_action_attempts_active_lease_idx
  ON platform.pending_action_attempts (lease_expires_at, action_id, attempt_number)
  WHERE outcome = 'executing';

CREATE INDEX pending_action_attempts_action_history_idx
  ON platform.pending_action_attempts (action_id, attempt_number DESC);

COMMENT ON TABLE platform.pending_action_attempts IS
  'Immutable execution-lease identity plus monotonic evidence. Outcomes distinguish capacity deferrals from retry failures; raw lease tokens are never persisted.';

CREATE FUNCTION platform.prepare_pending_action_attempt_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'pending_action_attempts'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'PendingAction attempt update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.action_id IS DISTINCT FROM OLD.action_id
    OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
    OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
    OR NEW.lease_token_digest IS DISTINCT FROM OLD.lease_token_digest
    OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'PendingAction attempt identity is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.claim_audit_id IS NOT NULL
    AND NEW.claim_audit_id IS DISTINCT FROM OLD.claim_audit_id THEN
    RAISE EXCEPTION
      'PendingAction attempt claim audit is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.finish_audit_id IS NOT NULL
    AND NEW.finish_audit_id IS DISTINCT FROM OLD.finish_audit_id THEN
    RAISE EXCEPTION
      'PendingAction attempt finish audit is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.finished_at IS NOT NULL
    AND (
      NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
      OR NEW.last_heartbeat_at IS DISTINCT FROM OLD.last_heartbeat_at
      OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
      OR NEW.outcome IS DISTINCT FROM OLD.outcome
      OR NEW.error_code IS DISTINCT FROM OLD.error_code
      OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
    ) THEN
    RAISE EXCEPTION
      'Finished PendingAction attempt evidence is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.lease_expires_at < OLD.lease_expires_at
    OR NEW.last_heartbeat_at < OLD.last_heartbeat_at THEN
    RAISE EXCEPTION
      'PendingAction attempt lease evidence is monotonic'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.outcome <> 'executing'
    AND NEW.outcome IS DISTINCT FROM OLD.outcome THEN
    RAISE EXCEPTION
      'PendingAction attempt outcome is terminal'
      USING ERRCODE = '22023';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER pending_action_attempts_prepare_update
BEFORE UPDATE ON platform.pending_action_attempts
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_pending_action_attempt_update();

REVOKE ALL ON FUNCTION platform.prepare_pending_action_attempt_update() FROM PUBLIC;

CREATE FUNCTION platform.prevent_pending_action_attempt_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'PendingAction attempt evidence cannot be deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER pending_action_attempts_prevent_delete
BEFORE DELETE ON platform.pending_action_attempts
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_pending_action_attempt_delete();

REVOKE ALL ON FUNCTION platform.prevent_pending_action_attempt_delete() FROM PUBLIC;

-- Replace the 000006 state shape. approved is a durable scheduled state;
-- executing represents only the currently fenced lease. Retry recovery clears
-- current lease fields while pending_action_attempts retains prior evidence.
ALTER TABLE platform.pending_actions
  DROP CONSTRAINT pending_actions_state_shape,
  DROP CONSTRAINT pending_actions_time_order,
  ADD CONSTRAINT pending_actions_state_shape
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
        AND next_attempt_at IS NOT NULL
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
  ADD CONSTRAINT pending_actions_time_order
    CHECK (
      expires_at > requested_at
      AND updated_at >= requested_at
      AND (decided_at IS NULL OR decided_at >= requested_at)
      AND (executing_at IS NULL OR executing_at >= requested_at)
      AND (completed_at IS NULL OR completed_at >= executing_at)
      AND (terminal_at IS NULL OR terminal_at >= requested_at)
      AND (lease_expires_at IS NULL OR lease_expires_at > executing_at)
      AND (last_heartbeat_at IS NULL OR last_heartbeat_at >= executing_at)
      AND (
        next_attempt_at IS NULL
        OR (
          next_attempt_at >= requested_at
          AND next_attempt_at < expires_at
        )
      )
    ),
  ADD CONSTRAINT pending_actions_public_error
    CHECK (
      (state NOT IN ('rejected', 'expired', 'cancelled', 'failed', 'invalidated')
        AND error IS NULL)
      OR (
        state = 'rejected'
        AND error = jsonb_build_object(
          'code', 'ACTION_REJECTED',
          'message', 'The Owner rejected this action.',
          'retryable', false,
          'details', NULL,
          'retry_after_ms', NULL
        )
      )
      OR (
        state = 'expired'
        AND error = jsonb_build_object(
          'code', 'ACTION_EXPIRED',
          'message', 'The action expired before it could be completed.',
          'retryable', false,
          'details', NULL,
          'retry_after_ms', NULL
        )
      )
      OR (
        state = 'cancelled'
        AND error = jsonb_build_object(
          'code', 'ACTION_CANCELLED',
          'message', 'The action was cancelled.',
          'retryable', false,
          'details', NULL,
          'retry_after_ms', NULL
        )
      )
      OR (
        state = 'failed'
        AND error = jsonb_build_object(
          'code', 'ACTION_EXECUTION_FAILED',
          'message', 'The approved action could not be completed.',
          'retryable', false,
          'details', NULL,
          'retry_after_ms', NULL
        )
      )
      OR (
        state = 'invalidated'
        AND error = jsonb_build_object(
          'code', 'ACTION_INVALIDATED',
          'message', 'The frozen action is no longer valid.',
          'retryable', false,
          'details', NULL,
          'retry_after_ms', NULL
        )
      )
    );

CREATE OR REPLACE FUNCTION platform.prepare_pending_action_update()
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

  -- Defaults preserve 000006 callers during a rolling deployment. Phase 3
  -- Owner endpoints always send the controlled reason explicitly.
  IF OLD.state = 'pending_approval'
    AND NEW.state = 'approved'
    AND NEW.decision_reason_code IS NULL THEN
    NEW.decision_reason_code := 'owner_approved';
  ELSIF OLD.state = 'pending_approval'
    AND NEW.state = 'rejected'
    AND NEW.decision_reason_code IS NULL THEN
    NEW.decision_reason_code := 'owner_rejected';
  ELSIF OLD.state = 'pending_approval'
    AND NEW.state = 'cancelled'
    AND NEW.decision_reason_code IS NULL THEN
    NEW.decision_reason_code := 'no_longer_needed';
  END IF;

  IF OLD.decided_at IS NOT NULL
    AND (
      NEW.decided_at IS DISTINCT FROM OLD.decided_at
      OR NEW.decided_by_owner_id IS DISTINCT FROM OLD.decided_by_owner_id
      OR NEW.approval_method IS DISTINCT FROM OLD.approval_method
      OR NEW.decision_reason_code IS DISTINCT FROM OLD.decision_reason_code
    ) THEN
    RAISE EXCEPTION
      'PendingAction Owner decision evidence is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.decision_audit_id IS NOT NULL
    AND NEW.decision_audit_id IS DISTINCT FROM OLD.decision_audit_id THEN
    RAISE EXCEPTION
      'PendingAction Owner decision audit is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.decision_audit_id IS NULL
    AND NEW.decision_audit_id IS NOT NULL
    AND NEW.decided_at IS NULL THEN
    RAISE EXCEPTION
      'PendingAction decision audit requires Owner decision evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state = 'approved'
    AND NEW.next_attempt_at IS NULL THEN
    NEW.next_attempt_at := clock_timestamp();
  END IF;

  IF NEW.state IN (
    'succeeded',
    'rejected',
    'expired',
    'cancelled',
    'failed',
    'invalidated'
  )
    AND NEW.terminal_at IS NULL THEN
    NEW.terminal_at := clock_timestamp();
  END IF;

  IF OLD.state = 'executing'
    AND NEW.state IN ('succeeded', 'failed')
    AND NEW.completed_at IS NULL THEN
    NEW.completed_at := clock_timestamp();
  END IF;

  IF OLD.state = 'executing'
    AND NEW.state IN ('approved', 'invalidated') THEN
    NEW.executing_at := NULL;
    NEW.completed_at := NULL;
    NEW.lease_owner := NULL;
    NEW.lease_token_digest := NULL;
    NEW.lease_expires_at := NULL;
    NEW.last_heartbeat_at := NULL;
  ELSIF OLD.state = 'executing'
    AND NEW.state IN ('succeeded', 'failed') THEN
    NEW.lease_owner := NULL;
    NEW.lease_token_digest := NULL;
    NEW.lease_expires_at := NULL;
  ELSIF OLD.state = 'approved'
    AND NEW.state = 'executing' THEN
    NEW.next_attempt_at := NULL;
  END IF;

  IF NEW.state IN (
    'succeeded',
    'rejected',
    'expired',
    'cancelled',
    'failed',
    'invalidated'
  ) THEN
    NEW.next_attempt_at := NULL;
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
        AND NEW.state IN ('approved', 'succeeded', 'failed', 'invalidated'))
    ) THEN
    RAISE EXCEPTION
      'Illegal PendingAction state transition'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state IS NOT DISTINCT FROM OLD.state
    AND NEW.state NOT IN ('approved', 'executing') THEN
    RAISE EXCEPTION
      'Only approved scheduling and executing lease heartbeats may update in place'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.state = 'pending_approval'
    AND NEW.state IN ('expired', 'invalidated')
    AND (
      NEW.decided_at IS DISTINCT FROM OLD.decided_at
      OR NEW.decided_by_owner_id IS DISTINCT FROM OLD.decided_by_owner_id
      OR NEW.approval_method IS DISTINCT FROM OLD.approval_method
      OR NEW.decision_audit_id IS DISTINCT FROM OLD.decision_audit_id
      OR NEW.decision_reason_code IS DISTINCT FROM OLD.decision_reason_code
    ) THEN
    RAISE EXCEPTION
      'System invalidation cannot fabricate Owner decision evidence'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.state = 'approved'
    AND NEW.state = 'executing' THEN
    IF OLD.next_attempt_at > clock_timestamp()
      OR OLD.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION
        'PendingAction is not due for execution'
        USING ERRCODE = '55000';
    END IF;

    IF NEW.attempt_count <> OLD.attempt_count + 1 THEN
      RAISE EXCEPTION
        'PendingAction claim must increment attempt count exactly once'
        USING ERRCODE = '22023';
    END IF;

    IF NEW.failure_count <> OLD.failure_count THEN
      RAISE EXCEPTION
        'PendingAction claim cannot consume the failure budget'
        USING ERRCODE = '22023';
    END IF;
  ELSIF OLD.state = 'executing'
    AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
    IF NEW.attempt_count <> OLD.attempt_count
      OR NEW.failure_count <> OLD.failure_count
      OR NEW.executing_at IS DISTINCT FROM OLD.executing_at
      OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
      OR NEW.lease_token_digest IS DISTINCT FROM OLD.lease_token_digest
      OR NEW.lease_expires_at < OLD.lease_expires_at
      OR NEW.last_heartbeat_at < OLD.last_heartbeat_at
      OR (
        NEW.lease_expires_at IS NOT DISTINCT FROM OLD.lease_expires_at
        AND NEW.last_heartbeat_at IS NOT DISTINCT FROM OLD.last_heartbeat_at
        AND NEW.decision_audit_id IS NOT DISTINCT FROM OLD.decision_audit_id
      ) THEN
      RAISE EXCEPTION
        'Executing PendingAction updates are limited to the current fenced heartbeat'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    IF NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION
        'PendingAction attempt count changes only when a lease is claimed'
        USING ERRCODE = '22023';
    END IF;


    IF OLD.state = 'executing'
      AND NEW.state IN ('approved', 'failed') THEN
      IF NEW.failure_count NOT IN (OLD.failure_count, OLD.failure_count + 1) THEN
        RAISE EXCEPTION
          'PendingAction execution may consume at most one failure'
          USING ERRCODE = '22023';
      END IF;
    ELSIF NEW.failure_count <> OLD.failure_count THEN
      RAISE EXCEPTION
        'PendingAction failure count changes only after execution failure'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION platform.prepare_pending_action_update() FROM PUBLIC;

CREATE FUNCTION platform.sync_pending_action_attempt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  affected_rows integer;
  finished_outcome text;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'pending_actions'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'PendingAction attempt synchronizer invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.state = 'approved' AND NEW.state = 'executing' THEN
    INSERT INTO platform.pending_action_attempts (
      action_id,
      attempt_number,
      lease_owner,
      lease_token_digest,
      claimed_at,
      lease_expires_at,
      last_heartbeat_at
    )
    VALUES (
      NEW.id,
      NEW.attempt_count,
      NEW.lease_owner,
      NEW.lease_token_digest,
      NEW.executing_at,
      NEW.lease_expires_at,
      NEW.last_heartbeat_at
    );
  ELSIF OLD.state = 'executing' AND NEW.state = 'executing' THEN
    UPDATE platform.pending_action_attempts
    SET lease_expires_at = NEW.lease_expires_at,
        last_heartbeat_at = NEW.last_heartbeat_at
    WHERE action_id = NEW.id
      AND attempt_number = NEW.attempt_count
      AND outcome = 'executing'
      AND lease_owner = NEW.lease_owner
      AND lease_token_digest = NEW.lease_token_digest;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
      RAISE EXCEPTION
        'PendingAction heartbeat has no matching execution attempt'
        USING ERRCODE = '40001';
    END IF;
  ELSIF OLD.state = 'executing'
    AND NEW.state IN ('approved', 'succeeded', 'failed', 'invalidated') THEN
    finished_outcome := CASE
      WHEN NEW.state = 'approved' AND NEW.failure_count = OLD.failure_count
        THEN 'deferred'
      WHEN NEW.state = 'approved' AND OLD.lease_expires_at <= statement_timestamp()
        THEN 'lease_expired'
      WHEN NEW.state = 'approved' THEN 'retry_scheduled'
      ELSE NEW.state
    END;

    UPDATE platform.pending_action_attempts
    SET finished_at = clock_timestamp(),
        outcome = finished_outcome,
        error_code = CASE
          WHEN NEW.state IN ('failed', 'invalidated') THEN NEW.error ->> 'code'
          ELSE NULL
        END,
        next_attempt_at = CASE
          WHEN NEW.state = 'approved' THEN NEW.next_attempt_at
          ELSE NULL
        END
    WHERE action_id = NEW.id
      AND attempt_number = NEW.attempt_count
      AND outcome = 'executing'
      AND lease_owner = OLD.lease_owner
      AND lease_token_digest = OLD.lease_token_digest;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
      RAISE EXCEPTION
        'PendingAction completion has no matching execution attempt'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER pending_actions_sync_attempt
AFTER UPDATE ON platform.pending_actions
FOR EACH ROW
EXECUTE FUNCTION platform.sync_pending_action_attempt();

REVOKE ALL ON FUNCTION platform.sync_pending_action_attempt() FROM PUBLIC;

-- Preserve an executing row if one exists during a rolling migration. No
-- Phase 2 service can create it, but the backfill keeps the schema safe for
-- operator-created staging fixtures and future partial rollouts.
INSERT INTO platform.pending_action_attempts (
  action_id,
  attempt_number,
  lease_owner,
  lease_token_digest,
  claimed_at,
  lease_expires_at,
  last_heartbeat_at
)
SELECT
  action.id,
  action.attempt_count,
  action.lease_owner,
  action.lease_token_digest,
  action.executing_at,
  action.lease_expires_at,
  action.last_heartbeat_at
FROM platform.pending_actions AS action
WHERE action.state = 'executing'
ON CONFLICT (action_id, attempt_number) DO NOTHING;

CREATE FUNCTION platform.validate_pending_action_decision_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.decision_audit_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM platform.action_logs AS audit
    WHERE audit.id = NEW.decision_audit_id
      AND audit.event_class = 'approval_transition'
      AND audit.owner_id = NEW.owner_id
      AND audit.agent_id = NEW.agent_id
      AND audit.approved_by_owner_id = NEW.owner_id
      AND audit.approval_method = 'owner_approval'
      AND audit.target_type = 'pending_action'
      AND audit.target_id = NEW.id::text
      AND audit.decision = 'require_approval'
      AND audit.reason_code = NEW.decision_reason_code
  ) THEN
    RAISE EXCEPTION
      'PendingAction decision audit does not match its Owner, Agent, and action'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER pending_actions_validate_decision_audit
AFTER INSERT OR UPDATE ON platform.pending_actions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_pending_action_decision_audit();

REVOKE ALL ON FUNCTION platform.validate_pending_action_decision_audit() FROM PUBLIC;

CREATE INDEX pending_actions_approved_due_idx
  ON platform.pending_actions (next_attempt_at, id)
  WHERE state = 'approved';

CREATE INDEX pending_actions_approval_expiry_idx
  ON platform.pending_actions (expires_at, id)
  WHERE state IN ('pending_approval', 'approved');

CREATE INDEX pending_actions_lease_reaper_idx
  ON platform.pending_actions (lease_expires_at, id)
  WHERE state = 'executing';
