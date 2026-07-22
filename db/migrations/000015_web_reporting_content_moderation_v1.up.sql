SET LOCAL search_path = pg_catalog;

-- Workforce administrators and deny-by-default RBAC -----------------------

CREATE TABLE platform.admins (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  oidc_issuer text NOT NULL,
  oidc_subject text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_authenticated_at timestamptz,
  CONSTRAINT admins_oidc_identity_unique
    UNIQUE (oidc_issuer, oidc_subject),
  CONSTRAINT admins_oidc_issuer_size
    CHECK (
      length(oidc_issuer) BETWEEN 1 AND 2048
      AND octet_length(oidc_issuer) <= 4096
      AND oidc_issuer !~ '[[:cntrl:][:space:]]'
    ),
  CONSTRAINT admins_oidc_subject_size
    CHECK (
      length(oidc_subject) BETWEEN 1 AND 512
      AND octet_length(oidc_subject) <= 2048
      AND oidc_subject !~ '[[:cntrl:]]'
    ),
  CONSTRAINT admins_display_name_size
    CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  CONSTRAINT admins_status
    CHECK (status IN ('active', 'suspended')),
  CONSTRAINT admins_last_authenticated_after_created
    CHECK (
      last_authenticated_at IS NULL
      OR last_authenticated_at >= created_at
    )
);

CREATE INDEX admins_status_idx
  ON platform.admins (status, id);

COMMENT ON TABLE platform.admins IS
  'Workforce OIDC identities only. No administrator password, session, or IdP token is stored here.';

CREATE TABLE platform.admin_roles (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  key text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT admin_roles_key_unique
    UNIQUE (key),
  CONSTRAINT admin_roles_key_format
    CHECK (key ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  CONSTRAINT admin_roles_name_size
    CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT admin_roles_status
    CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE platform.admin_role_permissions (
  role_id uuid NOT NULL
    REFERENCES platform.admin_roles(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  permission text NOT NULL,
  PRIMARY KEY (role_id, permission),
  CONSTRAINT admin_role_permissions_permission
    CHECK (
      permission IN (
        'moderation:read',
        'moderation:decide',
        'identity:restrict',
        'identity:quota_manage',
        'credential:revoke',
        'community:manage',
        'audit:read',
        'admin:role_assign'
      )
    )
);

CREATE INDEX admin_role_permissions_permission_idx
  ON platform.admin_role_permissions (permission, role_id);

CREATE TABLE platform.admin_assignments (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  admin_id uuid NOT NULL
    REFERENCES platform.admins(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  role_id uuid NOT NULL
    REFERENCES platform.admin_roles(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  grant_source text NOT NULL,
  granted_by_admin_id uuid
    REFERENCES platform.admins(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT admin_assignments_grant_source
    CHECK (grant_source IN ('admin', 'bootstrap')),
  CONSTRAINT admin_assignments_grant_chain
    CHECK (
      (grant_source = 'bootstrap' AND granted_by_admin_id IS NULL)
      OR (grant_source = 'admin' AND granted_by_admin_id IS NOT NULL)
    ),
  CONSTRAINT admin_assignments_expiry_after_grant
    CHECK (expires_at IS NULL OR expires_at > granted_at),
  CONSTRAINT admin_assignments_revocation_after_grant
    CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

CREATE UNIQUE INDEX admin_assignments_active_unique
  ON platform.admin_assignments (admin_id, role_id)
  WHERE revoked_at IS NULL;

CREATE INDEX admin_assignments_active_admin_idx
  ON platform.admin_assignments (admin_id, expires_at, role_id)
  WHERE revoked_at IS NULL;

-- Roles are migration-owned reference data. This exhaustively maps every MVP
-- atomic permission without creating or assigning a real administrator.
INSERT INTO platform.admin_roles (id, key, name)
VALUES
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290101', 'content_moderator', 'Content moderator'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290102', 'identity_operator', 'Identity operator'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290103', 'community_operator', 'Community operator'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290104', 'audit_reader', 'Audit reader'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290105', 'security_administrator', 'Security administrator');

INSERT INTO platform.admin_role_permissions (role_id, permission)
VALUES
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290101', 'moderation:read'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290101', 'moderation:decide'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290102', 'identity:restrict'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290102', 'identity:quota_manage'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290102', 'credential:revoke'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290103', 'community:manage'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290104', 'audit:read'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290105', 'moderation:read'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290105', 'moderation:decide'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290105', 'identity:restrict'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290105', 'identity:quota_manage'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290105', 'credential:revoke'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290105', 'community:manage'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290105', 'audit:read'),
  ('4b756e75-bf2d-4aa4-8ac4-5bd474290105', 'admin:role_assign');

ALTER TABLE platform.action_logs
  ADD CONSTRAINT action_logs_admin
  FOREIGN KEY (admin_id)
  REFERENCES platform.admins(id)
  ON UPDATE RESTRICT
  ON DELETE RESTRICT;

ALTER TABLE platform.registration_controls
  ADD CONSTRAINT registration_controls_updated_by_admin
  FOREIGN KEY (updated_by_admin_id)
  REFERENCES platform.admins(id)
  ON UPDATE RESTRICT
  ON DELETE RESTRICT;

CREATE FUNCTION platform.prepare_admin_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'admins'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Admin update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.oidc_issuer IS DISTINCT FROM OLD.oidc_issuer
    OR NEW.oidc_subject IS DISTINCT FROM OLD.oidc_subject
    OR NEW.display_name IS DISTINCT FROM OLD.display_name
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Admin identity is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.last_authenticated_at IS NOT NULL
    AND OLD.last_authenticated_at IS NOT NULL
    AND NEW.last_authenticated_at < OLD.last_authenticated_at THEN
    RAISE EXCEPTION
      'Admin authentication time cannot move backwards'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER admins_prepare_update
BEFORE UPDATE ON platform.admins
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_admin_update();

REVOKE ALL ON FUNCTION platform.prepare_admin_update() FROM PUBLIC;

CREATE FUNCTION platform.prepare_admin_assignment_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'admin_assignments'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Admin assignment update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.admin_id IS DISTINCT FROM OLD.admin_id
    OR NEW.role_id IS DISTINCT FROM OLD.role_id
    OR NEW.grant_source IS DISTINCT FROM OLD.grant_source
    OR NEW.granted_by_admin_id IS DISTINCT FROM OLD.granted_by_admin_id
    OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION
      'Admin assignment grant facts are immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.revoked_at IS NOT NULL
    AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION
      'Admin assignment revocation is immutable'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER admin_assignments_prepare_update
BEFORE UPDATE ON platform.admin_assignments
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_admin_assignment_update();

REVOKE ALL ON FUNCTION platform.prepare_admin_assignment_update() FROM PUBLIC;

CREATE FUNCTION platform.prevent_admin_rbac_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME NOT IN (
      'admins',
      'admin_roles',
      'admin_role_permissions',
      'admin_assignments'
    )
    OR TG_OP <> 'DELETE' THEN
    RAISE EXCEPTION
      'Admin RBAC delete trigger invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  RAISE EXCEPTION
    'Admin and RBAC history cannot be physically deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER admins_prevent_delete
BEFORE DELETE ON platform.admins
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_admin_rbac_delete();

CREATE TRIGGER admin_roles_prevent_delete
BEFORE DELETE ON platform.admin_roles
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_admin_rbac_delete();

CREATE TRIGGER admin_role_permissions_prevent_delete
BEFORE DELETE ON platform.admin_role_permissions
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_admin_rbac_delete();

CREATE TRIGGER admin_assignments_prevent_delete
BEFORE DELETE ON platform.admin_assignments
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_admin_rbac_delete();

REVOKE ALL ON FUNCTION platform.prevent_admin_rbac_delete() FROM PUBLIC;

-- Owner-submitted reports and stable moderation cases ----------------------

CREATE TABLE platform.reports (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  version bigint NOT NULL DEFAULT 1,
  reporter_owner_id uuid NOT NULL
    REFERENCES platform.owners(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  reporter_actor_id uuid NOT NULL,
  target_type text NOT NULL,
  target_content_id uuid
    REFERENCES platform.content_items(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  target_agent_id uuid
    REFERENCES platform.agents(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  reason_code text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'open',
  authentication_assurance text NOT NULL,
  submitted_via text NOT NULL DEFAULT 'web_owner_session',
  idempotency_key text NOT NULL,
  request_digest bytea NOT NULL,
  created_at timestamptz NOT NULL
    DEFAULT date_trunc('milliseconds', clock_timestamp()),
  updated_at timestamptz NOT NULL
    DEFAULT date_trunc('milliseconds', clock_timestamp()),
  resolved_at timestamptz,
  CONSTRAINT reports_actor_owner
    FOREIGN KEY (reporter_actor_id, reporter_owner_id)
    REFERENCES platform.actors(id, owner_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT reports_owner_idempotency_unique
    UNIQUE (reporter_owner_id, idempotency_key),
  CONSTRAINT reports_version_positive
    CHECK (version > 0),
  CONSTRAINT reports_target_shape
    CHECK (
      target_type = 'content'
      AND target_content_id IS NOT NULL
      AND target_agent_id IS NULL
    ),
  CONSTRAINT reports_reason_code
    CHECK (
      reason_code IN (
        'spam',
        'harassment',
        'impersonation',
        'malicious_link',
        'privacy_exposure',
        'other_rule_violation'
      )
    ),
  CONSTRAINT reports_description_size
    CHECK (
      description IS NULL
      OR (
        length(btrim(description)) BETWEEN 1 AND 4000
        AND octet_length(description) <= 16384
      )
    ),
  CONSTRAINT reports_other_reason_description
    CHECK (reason_code <> 'other_rule_violation' OR description IS NOT NULL),
  CONSTRAINT reports_status
    CHECK (status IN ('open', 'reviewing', 'resolved_action', 'dismissed')),
  CONSTRAINT reports_authentication_assurance_size
    CHECK (length(authentication_assurance) BETWEEN 1 AND 120),
  CONSTRAINT reports_submitted_via
    CHECK (submitted_via = 'web_owner_session'),
  CONSTRAINT reports_idempotency_key_size
    CHECK (
      length(idempotency_key) BETWEEN 1 AND 200
      AND idempotency_key !~ '[[:cntrl:]]'
    ),
  CONSTRAINT reports_request_digest_sha256
    CHECK (octet_length(request_digest) = 32),
  CONSTRAINT reports_resolution_state
    CHECK (
      (
        status IN ('open', 'reviewing')
        AND resolved_at IS NULL
      )
      OR (
        status IN ('resolved_action', 'dismissed')
        AND resolved_at IS NOT NULL
      )
    ),
  CONSTRAINT reports_updated_after_created
    CHECK (updated_at >= created_at),
  CONSTRAINT reports_resolved_after_created
    CHECK (resolved_at IS NULL OR resolved_at >= created_at),
  CONSTRAINT reports_timestamp_precision
    CHECK (
      created_at = date_trunc('milliseconds', created_at)
      AND updated_at = date_trunc('milliseconds', updated_at)
      AND (
        resolved_at IS NULL
        OR resolved_at = date_trunc('milliseconds', resolved_at)
      )
    )
);

CREATE UNIQUE INDEX reports_active_owner_content_unique
  ON platform.reports (reporter_owner_id, target_content_id)
  WHERE target_type = 'content'
    AND status IN ('open', 'reviewing');

CREATE INDEX reports_status_created_idx
  ON platform.reports (status, created_at, id);

CREATE INDEX reports_owner_created_idx
  ON platform.reports (reporter_owner_id, created_at DESC, id DESC);

COMMENT ON COLUMN platform.reports.description IS
  'Private untrusted reporter UGC. It must never be copied into Outbox events or ActionLog JSON.';

CREATE TABLE platform.moderation_cases (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  version bigint NOT NULL DEFAULT 1,
  target_type text NOT NULL,
  target_content_id uuid
    REFERENCES platform.content_items(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  target_agent_id uuid
    REFERENCES platform.agents(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  priority text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'open',
  assigned_admin_id uuid
    REFERENCES platform.admins(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  resolution_code text,
  opened_at timestamptz NOT NULL
    DEFAULT date_trunc('milliseconds', clock_timestamp()),
  updated_at timestamptz NOT NULL
    DEFAULT date_trunc('milliseconds', clock_timestamp()),
  closed_at timestamptz,
  CONSTRAINT moderation_cases_version_positive
    CHECK (version > 0),
  CONSTRAINT moderation_cases_target_shape
    CHECK (
      target_type = 'content'
      AND target_content_id IS NOT NULL
      AND target_agent_id IS NULL
    ),
  CONSTRAINT moderation_cases_priority
    CHECK (priority IN ('normal', 'high', 'urgent')),
  CONSTRAINT moderation_cases_status
    CHECK (status IN ('open', 'reviewing', 'resolved_action', 'dismissed')),
  CONSTRAINT moderation_cases_resolution_code
    CHECK (
      resolution_code IS NULL
      OR resolution_code IN (
        'content_limited',
        'content_hidden',
        'content_restored',
        'insufficient_evidence',
        'no_rule_violation',
        'duplicate_case'
      )
    ),
  CONSTRAINT moderation_cases_resolution_state
    CHECK (
      (
        status IN ('open', 'reviewing')
        AND resolution_code IS NULL
        AND closed_at IS NULL
      )
      OR (
        status = 'resolved_action'
        AND resolution_code IN (
          'content_limited',
          'content_hidden',
          'content_restored'
        )
        AND closed_at IS NOT NULL
      )
      OR (
        status = 'dismissed'
        AND resolution_code IN (
          'insufficient_evidence',
          'no_rule_violation',
          'duplicate_case'
        )
        AND closed_at IS NOT NULL
      )
    ),
  CONSTRAINT moderation_cases_updated_after_opened
    CHECK (updated_at >= opened_at),
  CONSTRAINT moderation_cases_closed_after_opened
    CHECK (closed_at IS NULL OR closed_at >= opened_at),
  CONSTRAINT moderation_cases_timestamp_precision
    CHECK (
      opened_at = date_trunc('milliseconds', opened_at)
      AND updated_at = date_trunc('milliseconds', updated_at)
      AND (
        closed_at IS NULL
        OR closed_at = date_trunc('milliseconds', closed_at)
      )
    )
);

CREATE UNIQUE INDEX moderation_cases_active_content_unique
  ON platform.moderation_cases (target_content_id)
  WHERE target_type = 'content'
    AND status IN ('open', 'reviewing');

CREATE INDEX moderation_cases_queue_idx
  ON platform.moderation_cases (status, priority, opened_at, id);

CREATE TABLE platform.moderation_case_items (
  case_id uuid NOT NULL
    REFERENCES platform.moderation_cases(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  report_id uuid NOT NULL
    REFERENCES platform.reports(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  attached_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (case_id, report_id),
  CONSTRAINT moderation_case_items_report_unique
    UNIQUE (report_id)
);

CREATE INDEX moderation_case_items_report_idx
  ON platform.moderation_case_items (report_id, case_id);

-- Every accepted Owner request key maps permanently to the Report returned by
-- that request. This is distinct from Report identity because an active
-- duplicate request intentionally returns an older Report without creating a
-- second queue signal. The digest contains no report description or other UGC.
CREATE TABLE platform.report_submission_idempotency (
  reporter_owner_id uuid NOT NULL
    REFERENCES platform.owners(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  reporter_actor_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_digest bytea NOT NULL,
  report_id uuid NOT NULL
    REFERENCES platform.reports(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (reporter_owner_id, idempotency_key),
  CONSTRAINT report_submission_idempotency_actor_owner
    FOREIGN KEY (reporter_actor_id, reporter_owner_id)
    REFERENCES platform.actors(id, owner_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT report_submission_idempotency_key_size
    CHECK (
      length(idempotency_key) BETWEEN 1 AND 200
      AND idempotency_key !~ '[[:cntrl:]]'
    ),
  CONSTRAINT report_submission_idempotency_digest_sha256
    CHECK (octet_length(request_digest) = 32)
);

CREATE INDEX report_submission_idempotency_report_idx
  ON platform.report_submission_idempotency (report_id);

CREATE INDEX report_submission_idempotency_owner_created_idx
  ON platform.report_submission_idempotency (
    reporter_owner_id,
    created_at DESC
  );

CREATE INDEX report_submission_idempotency_owner_actor_created_idx
  ON platform.report_submission_idempotency (
    reporter_owner_id,
    reporter_actor_id,
    created_at DESC
  );

COMMENT ON TABLE platform.report_submission_idempotency IS
  'Permanent, immutable Owner request-key mapping. It records the actual submitting Actor for quota accounting plus only a digest and the stable Report identity, never report details.';

CREATE TABLE platform.moderation_actions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  case_id uuid NOT NULL
    REFERENCES platform.moderation_cases(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  admin_id uuid NOT NULL
    REFERENCES platform.admins(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  permission_used text NOT NULL,
  action text NOT NULL,
  reason_code text NOT NULL,
  internal_note text,
  before_distribution_state text,
  after_distribution_state text,
  target_version_before bigint,
  target_version_after bigint,
  case_version_before bigint NOT NULL,
  case_version_after bigint NOT NULL,
  case_updated_at_after timestamptz NOT NULL,
  case_closed_at_after timestamptz NOT NULL,
  response_content_version bigint NOT NULL,
  response_content_lifecycle_state text NOT NULL,
  response_content_distribution_state text NOT NULL,
  reverts_action_id uuid
    REFERENCES platform.moderation_actions(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  idempotency_key text NOT NULL,
  request_digest bytea NOT NULL,
  result_state text NOT NULL DEFAULT 'succeeded',
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
  occurred_at timestamptz GENERATED ALWAYS AS (case_updated_at_after) STORED,
  CONSTRAINT moderation_actions_admin_idempotency_unique
    UNIQUE (admin_id, idempotency_key),
  CONSTRAINT moderation_actions_action_log_unique
    UNIQUE (action_log_id),
  CONSTRAINT moderation_actions_outbox_event_unique
    UNIQUE (outbox_event_id),
  CONSTRAINT moderation_actions_permission
    CHECK (permission_used = 'moderation:decide'),
  CONSTRAINT moderation_actions_action
    CHECK (
      action IN (
        'dismiss',
        'limit_content',
        'hide_content',
        'restore_content'
      )
    ),
  CONSTRAINT moderation_actions_reason_code
    CHECK (
      (
        action IN ('limit_content', 'hide_content')
        AND reason_code IN (
          'confirmed_report_violation',
          'precautionary_distribution_limit'
        )
      )
      OR (
        action = 'dismiss'
        AND reason_code IN (
          'insufficient_evidence',
          'no_rule_violation',
          'duplicate_case'
        )
      )
      OR (
        action = 'restore_content'
        AND reason_code IN (
          'moderation_error_corrected',
          'appeal_granted',
          'risk_condition_resolved'
        )
      )
    ),
  CONSTRAINT moderation_actions_internal_note_size
    CHECK (
      internal_note IS NULL
      OR (
        length(btrim(internal_note)) BETWEEN 1 AND 4000
        AND octet_length(internal_note) <= 16384
      )
    ),
  CONSTRAINT moderation_actions_distribution_shape
    CHECK (
      (
        action = 'dismiss'
        AND before_distribution_state IS NULL
        AND after_distribution_state IS NULL
        AND target_version_before IS NULL
        AND target_version_after IS NULL
        AND reverts_action_id IS NULL
      )
      OR (
        action = 'limit_content'
        AND before_distribution_state IN ('normal', 'hidden')
        AND after_distribution_state = 'limited'
        AND target_version_before > 0
        AND target_version_after = target_version_before + 1
        AND reverts_action_id IS NULL
      )
      OR (
        action = 'hide_content'
        AND before_distribution_state IN ('normal', 'limited')
        AND after_distribution_state = 'hidden'
        AND target_version_before > 0
        AND target_version_after = target_version_before + 1
        AND reverts_action_id IS NULL
      )
      OR (
        action = 'restore_content'
        AND before_distribution_state IN ('limited', 'hidden')
        AND after_distribution_state = 'normal'
        AND target_version_before > 0
        AND target_version_after = target_version_before + 1
        AND reverts_action_id IS NOT NULL
      )
    ),
  CONSTRAINT moderation_actions_case_version_shape
    CHECK (
      case_version_before > 0
      AND case_version_after = case_version_before + 1
      AND case_closed_at_after = case_updated_at_after
    ),
  CONSTRAINT moderation_actions_response_content_shape
    CHECK (
      response_content_version > 0
      AND response_content_lifecycle_state IN ('published', 'deleted')
      AND response_content_distribution_state IN ('normal', 'limited', 'hidden')
      AND (
        action = 'dismiss'
        OR (
          response_content_lifecycle_state = 'published'
          AND response_content_version = target_version_after
          AND response_content_distribution_state = after_distribution_state
        )
      )
    ),
  CONSTRAINT moderation_actions_not_self_revert
    CHECK (reverts_action_id IS NULL OR reverts_action_id <> id),
  CONSTRAINT moderation_actions_idempotency_key_size
    CHECK (
      length(idempotency_key) BETWEEN 1 AND 200
      AND idempotency_key !~ '[[:cntrl:]]'
    ),
  CONSTRAINT moderation_actions_request_digest_sha256
    CHECK (octet_length(request_digest) = 32),
  CONSTRAINT moderation_actions_result_state
    CHECK (result_state = 'succeeded')
);

CREATE INDEX moderation_actions_case_occurred_idx
  ON platform.moderation_actions (case_id, occurred_at DESC, id DESC);

CREATE UNIQUE INDEX moderation_actions_case_resolution_unique
  ON platform.moderation_actions (case_id)
  WHERE action <> 'restore_content';

CREATE UNIQUE INDEX moderation_actions_case_restore_unique
  ON platform.moderation_actions (case_id)
  WHERE action = 'restore_content';

CREATE UNIQUE INDEX moderation_actions_reverted_action_unique
  ON platform.moderation_actions (reverts_action_id)
  WHERE reverts_action_id IS NOT NULL;

COMMENT ON COLUMN platform.moderation_actions.internal_note IS
  'Private untrusted workforce note. It must never be copied into Outbox events or ActionLog JSON.';

CREATE FUNCTION platform.prepare_report_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  transition_time timestamptz;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'reports'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'Report update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.reporter_owner_id IS DISTINCT FROM OLD.reporter_owner_id
    OR NEW.reporter_actor_id IS DISTINCT FROM OLD.reporter_actor_id
    OR NEW.target_type IS DISTINCT FROM OLD.target_type
    OR NEW.target_content_id IS DISTINCT FROM OLD.target_content_id
    OR NEW.target_agent_id IS DISTINCT FROM OLD.target_agent_id
    OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.authentication_assurance IS DISTINCT FROM OLD.authentication_assurance
    OR NEW.submitted_via IS DISTINCT FROM OLD.submitted_via
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Report request facts are immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.status IN ('resolved_action', 'dismissed') THEN
    RAISE EXCEPTION
      'Resolved Report state is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION
      'Report version must advance exactly by one'
      USING ERRCODE = '40001';
  END IF;

  IF NOT (
    (OLD.status = 'open' AND NEW.status IN ('reviewing', 'resolved_action', 'dismissed'))
    OR (OLD.status = 'reviewing' AND NEW.status IN ('resolved_action', 'dismissed'))
  ) THEN
    RAISE EXCEPTION
      'Invalid Report state transition'
      USING ERRCODE = '22023';
  END IF;

  transition_time := date_trunc('milliseconds', clock_timestamp());
  NEW.updated_at := transition_time;
  NEW.resolved_at := CASE
    WHEN NEW.status IN ('resolved_action', 'dismissed') THEN transition_time
    ELSE NULL
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reports_prepare_update
BEFORE UPDATE ON platform.reports
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_report_update();

REVOKE ALL ON FUNCTION platform.prepare_report_update() FROM PUBLIC;

CREATE FUNCTION platform.prepare_moderation_case_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  transition_time timestamptz;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'moderation_cases'
    OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'ModerationCase update trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.target_type IS DISTINCT FROM OLD.target_type
    OR NEW.target_content_id IS DISTINCT FROM OLD.target_content_id
    OR NEW.target_agent_id IS DISTINCT FROM OLD.target_agent_id
    OR NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
    RAISE EXCEPTION
      'ModerationCase identity is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.status = 'dismissed'
    OR (
      OLD.status = 'resolved_action'
      AND NEW.status <> 'resolved_action'
    ) THEN
    RAISE EXCEPTION
      'Closed ModerationCase state is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION
      'ModerationCase version must advance exactly by one'
      USING ERRCODE = '40001';
  END IF;

  IF NOT (
    (OLD.status = 'open' AND NEW.status IN ('open', 'reviewing', 'resolved_action', 'dismissed'))
    OR (OLD.status = 'reviewing' AND NEW.status IN ('reviewing', 'resolved_action', 'dismissed'))
    OR (
      OLD.status = 'resolved_action'
      AND OLD.resolution_code IN ('content_limited', 'content_hidden')
      AND NEW.status = 'resolved_action'
      AND NEW.resolution_code = 'content_restored'
      AND NEW.priority = OLD.priority
    )
  ) THEN
    RAISE EXCEPTION
      'Invalid ModerationCase state transition'
      USING ERRCODE = '22023';
  END IF;

  transition_time := date_trunc('milliseconds', clock_timestamp());
  NEW.updated_at := transition_time;
  NEW.closed_at := CASE
    WHEN NEW.status IN ('resolved_action', 'dismissed') THEN transition_time
    ELSE NULL
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER moderation_cases_prepare_update
BEFORE UPDATE ON platform.moderation_cases
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_moderation_case_update();

REVOKE ALL ON FUNCTION platform.prepare_moderation_case_update() FROM PUBLIC;

CREATE FUNCTION platform.validate_moderation_case_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  case_target_type text;
  case_target_content_id uuid;
  case_target_agent_id uuid;
  report_target_type text;
  report_target_content_id uuid;
  report_target_agent_id uuid;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'moderation_case_items'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'ModerationCase item validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  SELECT target_type, target_content_id, target_agent_id
  INTO case_target_type, case_target_content_id, case_target_agent_id
  FROM platform.moderation_cases
  WHERE id = NEW.case_id
  FOR KEY SHARE;

  SELECT target_type, target_content_id, target_agent_id
  INTO report_target_type, report_target_content_id, report_target_agent_id
  FROM platform.reports
  WHERE id = NEW.report_id
  FOR KEY SHARE;

  IF case_target_type IS DISTINCT FROM report_target_type
    OR case_target_content_id IS DISTINCT FROM report_target_content_id
    OR case_target_agent_id IS DISTINCT FROM report_target_agent_id THEN
    RAISE EXCEPTION
      'Report and ModerationCase targets must match'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER moderation_case_items_validate_target
BEFORE INSERT ON platform.moderation_case_items
FOR EACH ROW
EXECUTE FUNCTION platform.validate_moderation_case_item();

REVOKE ALL ON FUNCTION platform.validate_moderation_case_item() FROM PUBLIC;

CREATE FUNCTION platform.prevent_moderation_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME NOT IN (
      'moderation_case_items',
      'moderation_actions',
      'report_submission_idempotency'
    )
    OR TG_OP NOT IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION
      'Moderation history guard invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  RAISE EXCEPTION
    'Moderation attachments and actions are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER moderation_case_items_prevent_mutation
BEFORE UPDATE OR DELETE ON platform.moderation_case_items
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_moderation_history_mutation();

CREATE TRIGGER moderation_actions_prevent_mutation
BEFORE UPDATE OR DELETE ON platform.moderation_actions
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_moderation_history_mutation();

CREATE TRIGGER report_submission_idempotency_prevent_mutation
BEFORE UPDATE OR DELETE ON platform.report_submission_idempotency
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_moderation_history_mutation();

REVOKE ALL ON FUNCTION platform.prevent_moderation_history_mutation() FROM PUBLIC;

CREATE FUNCTION platform.prevent_moderation_record_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME NOT IN ('reports', 'moderation_cases')
    OR TG_OP <> 'DELETE' THEN
    RAISE EXCEPTION
      'Moderation record delete guard invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  RAISE EXCEPTION
    'Reports and ModerationCases cannot be physically deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER reports_prevent_delete
BEFORE DELETE ON platform.reports
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_moderation_record_delete();

CREATE TRIGGER moderation_cases_prevent_delete
BEFORE DELETE ON platform.moderation_cases
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_moderation_record_delete();

REVOKE ALL ON FUNCTION platform.prevent_moderation_record_delete() FROM PUBLIC;

-- Runtime report and case provenance ---------------------------------------

CREATE FUNCTION platform.validate_runtime_report_idempotency_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  privileged_writer boolean;
BEGIN
  SELECT role.rolsuper OR relation.relowner = role.oid
  INTO privileged_writer
  FROM pg_roles AS role
  CROSS JOIN pg_class AS relation
  JOIN pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE role.rolname = current_user
    AND namespace.nspname = 'platform'
    AND relation.relname = 'report_submission_idempotency'
    AND relation.relkind IN ('p', 'r');

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Report idempotency validator cannot identify the effective writer'
      USING ERRCODE = '42501';
  END IF;

  IF privileged_writer THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'report_submission_idempotency'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Report idempotency validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM platform.reports AS report
    JOIN platform.moderation_case_items AS item
      ON item.report_id = report.id
    JOIN platform.owners AS owner
      ON owner.id = NEW.reporter_owner_id
    JOIN platform.actors AS actor
      ON actor.id = NEW.reporter_actor_id
     AND actor.owner_id = owner.id
    JOIN platform.agents AS agent
      ON agent.actor_id = actor.id
     AND agent.owner_id = owner.id
    WHERE report.id = NEW.report_id
      AND report.reporter_owner_id = NEW.reporter_owner_id
      AND owner.status = 'active'
      AND owner.email_verified_at IS NOT NULL
      AND owner.deleted_at IS NULL
      AND actor.kind = 'agent'
      AND actor.status = 'active'
      AND actor.deleted_at IS NULL
      AND agent.status = 'active'
      AND agent.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'Report idempotency mapping must reference an attached Report owned by the authenticated Owner'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION platform.validate_runtime_report_idempotency_provenance()
  FROM PUBLIC;

CREATE CONSTRAINT TRIGGER report_submission_idempotency_validate_runtime_provenance
AFTER INSERT ON platform.report_submission_idempotency
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_runtime_report_idempotency_provenance();

CREATE FUNCTION platform.validate_runtime_report_creation_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  privileged_writer boolean;
  provenance_exists boolean;
  report_xid xid;
BEGIN
  SELECT role.rolsuper OR relation.relowner = role.oid
  INTO privileged_writer
  FROM pg_roles AS role
  CROSS JOIN pg_class AS relation
  JOIN pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE role.rolname = current_user
    AND namespace.nspname = 'platform'
    AND relation.relname = 'reports'
    AND relation.relkind IN ('p', 'r');

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Report provenance validator cannot identify the effective writer'
      USING ERRCODE = '42501';
  END IF;

  IF privileged_writer THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'reports'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Report provenance validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  SELECT report.xmin
  INTO report_xid
  FROM platform.reports AS report
  WHERE report.id = NEW.id;

  IF NEW.version <> 1
    OR NEW.status <> 'open'
    OR NEW.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Runtime Report must begin open at version one'
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM platform.owners AS owner
    JOIN platform.actors AS actor
      ON actor.id = NEW.reporter_actor_id
     AND actor.owner_id = owner.id
    JOIN platform.agents AS agent
      ON agent.actor_id = actor.id
     AND agent.owner_id = owner.id
    JOIN platform.moderation_case_items AS item
      ON item.report_id = NEW.id
     AND item.xmin = report_xid
    JOIN platform.report_submission_idempotency AS submission
      ON submission.reporter_owner_id = NEW.reporter_owner_id
     AND submission.reporter_actor_id = NEW.reporter_actor_id
     AND submission.idempotency_key = NEW.idempotency_key
     AND submission.request_digest = NEW.request_digest
     AND submission.report_id = NEW.id
     AND submission.xmin = report_xid
    JOIN platform.moderation_cases AS moderation_case
      ON moderation_case.id = item.case_id
     AND moderation_case.xmin = report_xid
    JOIN system.outbox_events AS event
      ON event.aggregate_type = 'report'
     AND event.aggregate_id = NEW.id::text
     AND event.aggregate_sequence = 1
     AND event.event_type = 'report.created'
     AND event.event_version = 1
     AND event.xmin = report_xid
    WHERE owner.id = NEW.reporter_owner_id
      AND owner.status = 'active'
      AND owner.email_verified_at IS NOT NULL
      AND owner.deleted_at IS NULL
      AND actor.status = 'active'
      AND actor.kind = 'agent'
      AND actor.deleted_at IS NULL
      AND agent.status = 'active'
      AND agent.deleted_at IS NULL
      AND NEW.target_type = 'content'
      AND NEW.target_agent_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM platform.content_items AS target_content
        JOIN platform.actors AS target_author
          ON target_author.id = target_content.author_actor_id
        JOIN platform.content_items AS root_content
          ON root_content.id = target_content.root_id
        WHERE target_content.id = NEW.target_content_id
          AND target_author.owner_id <> NEW.reporter_owner_id
          AND target_content.lifecycle_state = 'published'
          AND target_content.distribution_state <> 'hidden'
          AND root_content.lifecycle_state = 'published'
          AND root_content.distribution_state <> 'hidden'
      )
      AND moderation_case.target_type = NEW.target_type
      AND moderation_case.target_content_id IS NOT DISTINCT FROM
        NEW.target_content_id
      AND moderation_case.target_agent_id IS NOT DISTINCT FROM
        NEW.target_agent_id
      AND moderation_case.status = 'open'
      AND moderation_case.version = (
        SELECT count(*)
        FROM platform.moderation_case_items AS attached_item
        WHERE attached_item.case_id = moderation_case.id
      )
      AND event.occurred_at = NEW.created_at
      AND event.payload = jsonb_build_object(
        'report_id', NEW.id,
        'case_id', moderation_case.id,
        'content_id', NEW.target_content_id,
        'reason_code', NEW.reason_code
      )
  ) INTO provenance_exists;

  IF NOT provenance_exists THEN
    RAISE EXCEPTION
      'Runtime Report creation requires a matching case attachment and redacted Outbox event'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION platform.validate_runtime_report_creation_provenance()
  FROM PUBLIC;

CREATE CONSTRAINT TRIGGER reports_validate_runtime_creation_provenance
AFTER INSERT ON platform.reports
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_runtime_report_creation_provenance();

CREATE FUNCTION platform.validate_runtime_case_creation_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  privileged_writer boolean;
BEGIN
  SELECT role.rolsuper OR relation.relowner = role.oid
  INTO privileged_writer
  FROM pg_roles AS role
  CROSS JOIN pg_class AS relation
  JOIN pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE role.rolname = current_user
    AND namespace.nspname = 'platform'
    AND relation.relname = 'moderation_cases'
    AND relation.relkind IN ('p', 'r');

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'ModerationCase provenance validator cannot identify the effective writer'
      USING ERRCODE = '42501';
  END IF;

  IF privileged_writer THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'moderation_cases'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'ModerationCase provenance validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.version <> 1
    OR NEW.priority <> 'normal'
    OR NEW.status <> 'open'
    OR NEW.assigned_admin_id IS NOT NULL
    OR NEW.resolution_code IS NOT NULL
    OR NEW.closed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Runtime ModerationCase must begin open, unassigned, and normal priority at version one'
      USING ERRCODE = '23514';
  END IF;

  IF (
    SELECT count(*)
    FROM platform.moderation_case_items AS item
    JOIN platform.reports AS report ON report.id = item.report_id
    WHERE item.case_id = NEW.id
      AND item.xmin = (
        SELECT moderation_case.xmin
        FROM platform.moderation_cases AS moderation_case
        WHERE moderation_case.id = NEW.id
      )
      AND report.xmin = item.xmin
      AND report.target_type = NEW.target_type
      AND report.target_content_id IS NOT DISTINCT FROM NEW.target_content_id
      AND report.target_agent_id IS NOT DISTINCT FROM NEW.target_agent_id
  ) <> 1 THEN
    RAISE EXCEPTION
      'Runtime ModerationCase creation requires a matching Report attachment'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION platform.validate_runtime_case_creation_provenance()
  FROM PUBLIC;

CREATE CONSTRAINT TRIGGER moderation_cases_validate_runtime_creation_provenance
AFTER INSERT ON platform.moderation_cases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_runtime_case_creation_provenance();

-- Immutable moderation decisions and their redacted transactional evidence --

CREATE FUNCTION platform.validate_runtime_moderation_action_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  action_xid xid;
  case_closed_at timestamptz;
  case_resolution_code text;
  case_status text;
  case_target_agent_id uuid;
  case_target_content_id uuid;
  case_target_type text;
  case_updated_at timestamptz;
  case_version bigint;
  content_current_revision_id uuid;
  content_distribution_state text;
  content_kind text;
  content_lifecycle_state text;
  content_root_id uuid;
  content_version bigint;
  content_xid xid;
  expected_audit_action text;
  expected_case_resolution text;
  expected_case_status text;
  expected_event_payload jsonb;
  expected_event_type text;
  expected_log_after jsonb;
  expected_log_before jsonb;
  privileged_writer boolean;
  provenance_exists boolean;
BEGIN
  SELECT role.rolsuper OR relation.relowner = role.oid
  INTO privileged_writer
  FROM pg_roles AS role
  CROSS JOIN pg_class AS relation
  JOIN pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE role.rolname = current_user
    AND namespace.nspname = 'platform'
    AND relation.relname = 'moderation_actions'
    AND relation.relkind IN ('p', 'r');

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Moderation action validator cannot identify the effective writer'
      USING ERRCODE = '42501';
  END IF;

  IF privileged_writer THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'moderation_actions'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Moderation action validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  SELECT action.xmin
  INTO action_xid
  FROM platform.moderation_actions AS action
  WHERE action.id = NEW.id;

  SELECT
    moderation_case.target_type,
    moderation_case.target_content_id,
    moderation_case.target_agent_id,
    moderation_case.status,
    moderation_case.resolution_code,
    moderation_case.version,
    moderation_case.updated_at,
    moderation_case.closed_at
  INTO
    case_target_type,
    case_target_content_id,
    case_target_agent_id,
    case_status,
    case_resolution_code,
    case_version,
    case_updated_at,
    case_closed_at
  FROM platform.moderation_cases AS moderation_case
  WHERE moderation_case.id = NEW.case_id
    AND moderation_case.xmin = action_xid
    AND moderation_case.assigned_admin_id = NEW.admin_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Moderation decision must close its assigned case in the same transaction'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.case_version_after <> case_version
    OR NEW.case_version_before + 1 <> NEW.case_version_after
    OR NEW.case_updated_at_after IS DISTINCT FROM case_updated_at
    OR NEW.case_closed_at_after IS DISTINCT FROM case_closed_at
    OR NEW.occurred_at IS DISTINCT FROM case_updated_at THEN
    RAISE EXCEPTION
      'Moderation action must preserve the exact post-decision Case snapshot'
      USING ERRCODE = '23514';
  END IF;

  IF case_target_type <> 'content'
    OR case_target_content_id IS NULL
    OR case_target_agent_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Content moderation v1 requires a Content target'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.action = 'dismiss' THEN
    SELECT
      content.version,
      content.lifecycle_state,
      content.distribution_state
    INTO
      content_version,
      content_lifecycle_state,
      content_distribution_state
    FROM platform.content_items AS content
    WHERE content.id = case_target_content_id;

    IF NOT FOUND
      OR NEW.response_content_version <> content_version
      OR NEW.response_content_lifecycle_state <> content_lifecycle_state
      OR NEW.response_content_distribution_state <> content_distribution_state THEN
      RAISE EXCEPTION
        'Dismiss action must preserve the exact post-decision Content snapshot'
        USING ERRCODE = '23514';
    END IF;

    expected_audit_action := 'moderation.dismiss';
    expected_case_status := 'dismissed';
    expected_case_resolution := NEW.reason_code;
    expected_event_type := 'moderation.case_dismissed';
    expected_event_payload := jsonb_build_object(
      'case_id', NEW.case_id,
      'action_id', NEW.id,
      'target_type', case_target_type,
      'content_id', case_target_content_id,
      'resolution_code', expected_case_resolution,
      'reason_code', NEW.reason_code
    );
    expected_log_before := jsonb_build_object(
      'case_id', NEW.case_id
    );
    expected_log_after := jsonb_build_object(
      'case_id', NEW.case_id,
      'moderation_action_id', NEW.id,
      'case_status', expected_case_status,
      'resolution_code', expected_case_resolution
    );
  ELSE
    IF case_target_type <> 'content' OR case_target_content_id IS NULL THEN
      RAISE EXCEPTION
        'Content distribution actions require a Content target'
        USING ERRCODE = '23514';
    END IF;

    SELECT
      content.version,
      content.lifecycle_state,
      content.kind,
      content.root_id,
      content.current_revision_id,
      content.xmin
    INTO
      content_version,
      content_lifecycle_state,
      content_kind,
      content_root_id,
      content_current_revision_id,
      content_xid
    FROM platform.content_items AS content
    WHERE content.id = case_target_content_id
      AND content.distribution_state = NEW.after_distribution_state;

    IF NOT FOUND
      OR content_xid IS DISTINCT FROM action_xid
      OR content_lifecycle_state <> 'published'
      OR content_version <> NEW.target_version_after
      OR NEW.response_content_version <> content_version
      OR NEW.response_content_lifecycle_state <> content_lifecycle_state
      OR NEW.response_content_distribution_state <>
        NEW.after_distribution_state THEN
      RAISE EXCEPTION
        'Moderation action must match a published Content distribution update in the same transaction'
        USING ERRCODE = '23514';
    END IF;

    expected_audit_action := CASE NEW.action
      WHEN 'limit_content' THEN 'moderation.limit_content'
      WHEN 'hide_content' THEN 'moderation.hide_content'
      WHEN 'restore_content' THEN 'moderation.restore_content'
      ELSE NULL
    END;
    expected_case_status := 'resolved_action';
    expected_case_resolution := CASE NEW.action
      WHEN 'limit_content' THEN 'content_limited'
      WHEN 'hide_content' THEN 'content_hidden'
      WHEN 'restore_content' THEN 'content_restored'
      ELSE NULL
    END;
    expected_event_type := 'content.moderation_changed';
    expected_event_payload := jsonb_build_object(
      'content_id', case_target_content_id,
      'case_id', NEW.case_id,
      'moderation_action_id', NEW.id,
      'reason_code', NEW.reason_code,
      'before_distribution_state', NEW.before_distribution_state,
      'after_distribution_state', NEW.after_distribution_state,
      'resource_version', NEW.target_version_after,
      'kind', content_kind,
      'root_content_id', content_root_id,
      'current_revision_id', content_current_revision_id
    );
    expected_log_before := jsonb_build_object(
      'distribution_state', NEW.before_distribution_state,
      'resource_version', NEW.target_version_before
    );
    expected_log_after := jsonb_build_object(
      'content_id', case_target_content_id,
      'case_id', NEW.case_id,
      'moderation_action_id', NEW.id,
      'distribution_state', NEW.after_distribution_state,
      'resource_version', NEW.target_version_after
    );
  END IF;

  IF case_status IS DISTINCT FROM expected_case_status
    OR case_resolution_code IS DISTINCT FROM expected_case_resolution THEN
    RAISE EXCEPTION
      'ModerationCase resolution does not match its action'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM platform.moderation_case_items AS item
    JOIN platform.reports AS report ON report.id = item.report_id
    WHERE item.case_id = NEW.case_id
      AND (
        report.status IS DISTINCT FROM expected_case_status
        OR (
          NEW.action = 'restore_content'
          AND report.xmin IS NOT DISTINCT FROM action_xid
        )
        OR (
          NEW.action <> 'restore_content'
          AND report.xmin IS DISTINCT FROM action_xid
        )
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM platform.moderation_case_items AS item
    WHERE item.case_id = NEW.case_id
  ) THEN
    RAISE EXCEPTION
      'Moderation decision must resolve every attached Report atomically'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.action = 'restore_content'
    AND NOT EXISTS (
      SELECT 1
      FROM platform.moderation_actions AS reverted
      WHERE reverted.id = NEW.reverts_action_id
        AND reverted.case_id = NEW.case_id
        AND reverted.action IN ('limit_content', 'hide_content')
        AND reverted.after_distribution_state = NEW.before_distribution_state
        AND reverted.target_version_after <= NEW.target_version_before
        AND reverted.case_version_after = NEW.case_version_before
        AND reverted.occurred_at <= NEW.occurred_at
        AND NOT EXISTS (
          SELECT 1
          FROM platform.moderation_actions AS existing_reverter
          WHERE existing_reverter.reverts_action_id = reverted.id
            AND existing_reverter.id <> NEW.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM platform.moderation_actions AS later_action
          JOIN platform.moderation_cases AS later_case
            ON later_case.id = later_action.case_id
          WHERE later_case.target_type = 'content'
            AND later_case.target_content_id = case_target_content_id
            AND later_action.id <> NEW.id
            AND later_action.action IN (
              'limit_content',
              'hide_content',
              'restore_content'
            )
            AND later_action.target_version_after > reverted.target_version_after
        )
    ) THEN
    RAISE EXCEPTION
      'Restore action must identify the latest still-effective distribution action from the same Case'
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM platform.admins AS admin
    JOIN platform.admin_assignments AS assignment
      ON assignment.admin_id = admin.id
     AND assignment.granted_at <= NEW.occurred_at
     AND assignment.revoked_at IS NULL
     AND (
       assignment.expires_at IS NULL
       OR assignment.expires_at > NEW.occurred_at
     )
    JOIN platform.admin_roles AS role
      ON role.id = assignment.role_id
     AND role.status = 'active'
    JOIN platform.admin_role_permissions AS role_permission
      ON role_permission.role_id = role.id
     AND role_permission.permission = NEW.permission_used
    JOIN platform.action_logs AS log
      ON log.id = NEW.action_log_id
     AND log.xmin = action_xid
    JOIN system.outbox_events AS event
      ON event.id = NEW.outbox_event_id
     AND event.xmin = action_xid
    WHERE admin.id = NEW.admin_id
      AND admin.status = 'active'
      AND log.event_class = 'governance'
      AND log.actor_id IS NULL
      AND log.actor_kind IS NULL
      AND log.owner_id IS NULL
      AND log.agent_id IS NULL
      AND log.credential_id IS NULL
      AND log.admin_id = NEW.admin_id
      AND log.channel = 'admin_web'
      AND log.approval_method = 'admin_override'
      AND log.approved_by_owner_id IS NULL
      AND log.authentication_assurance = 'workforce_oidc'
      AND log.authorization_snapshot ->> 'permission' = NEW.permission_used
      AND jsonb_typeof(log.authorization_snapshot -> 'roles') = 'array'
      AND jsonb_typeof(log.authorization_snapshot -> 'permissions') = 'array'
      AND log.authorization_snapshot - ARRAY['permission', 'roles', 'permissions']::text[] = '{}'::jsonb
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(log.authorization_snapshot -> 'roles') AS entry(value)
        WHERE jsonb_typeof(entry.value) <> 'string'
          OR length(entry.value #>> '{}') NOT BETWEEN 1 AND 80
          OR entry.value #>> '{}' !~ '^[a-z][a-z0-9_.-]{0,79}$'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(log.authorization_snapshot -> 'permissions') AS entry(value)
        WHERE jsonb_typeof(entry.value) <> 'string'
          OR entry.value #>> '{}' NOT IN (
            'moderation:read',
            'moderation:decide',
            'identity:restrict',
            'identity:quota_manage',
            'credential:revoke',
            'community:manage',
            'audit:read',
            'admin:role_assign'
          )
      )
      AND log.authorization_snapshot -> 'roles' = (
        SELECT COALESCE(
          jsonb_agg(effective_role.role_key ORDER BY effective_role.role_key),
          '[]'::jsonb
        )
        FROM (
          SELECT DISTINCT exact_role.key AS role_key
          FROM platform.admin_assignments AS exact_assignment
          JOIN platform.admin_roles AS exact_role
            ON exact_role.id = exact_assignment.role_id
           AND exact_role.status = 'active'
          WHERE exact_assignment.admin_id = NEW.admin_id
            AND exact_assignment.granted_at <= NEW.occurred_at
            AND exact_assignment.revoked_at IS NULL
            AND (
              exact_assignment.expires_at IS NULL
              OR exact_assignment.expires_at > NEW.occurred_at
            )
        ) AS effective_role
      )
      AND log.authorization_snapshot -> 'permissions' = (
        SELECT COALESCE(
          jsonb_agg(
            effective_permission.permission
            ORDER BY effective_permission.permission
          ),
          '[]'::jsonb
        )
        FROM (
          SELECT DISTINCT exact_permission.permission
          FROM platform.admin_assignments AS exact_assignment
          JOIN platform.admin_roles AS exact_role
            ON exact_role.id = exact_assignment.role_id
           AND exact_role.status = 'active'
          JOIN platform.admin_role_permissions AS exact_permission
            ON exact_permission.role_id = exact_role.id
          WHERE exact_assignment.admin_id = NEW.admin_id
            AND exact_assignment.granted_at <= NEW.occurred_at
            AND exact_assignment.revoked_at IS NULL
            AND (
              exact_assignment.expires_at IS NULL
              OR exact_assignment.expires_at > NEW.occurred_at
            )
        ) AS effective_permission
      )
      AND (log.authorization_snapshot -> 'permissions') @>
        jsonb_build_array(NEW.permission_used)
      AND log.action = expected_audit_action
      AND log.target_type = case_target_type
      AND log.target_id = COALESCE(
        case_target_content_id::text,
        case_target_agent_id::text
      )
      AND log.decision = 'allow'
      AND log.outcome = 'succeeded'
      AND log.error_code IS NULL
      AND log.retry_count = 0
      AND log.outbox_event_id = NEW.outbox_event_id
      AND log.policy_version IS NULL
      AND log.security_subject_digest IS NULL
      AND log.before_state = expected_log_before
      AND log.after_state = expected_log_after
      AND log.reason_code = NEW.reason_code
      AND log.occurred_at = NEW.occurred_at
      AND event.aggregate_type = CASE NEW.action
        WHEN 'dismiss' THEN 'moderation_case'
        ELSE 'content'
      END
      AND event.aggregate_id = CASE NEW.action
        WHEN 'dismiss' THEN NEW.case_id::text
        ELSE case_target_content_id::text
      END
      AND event.event_type = expected_event_type
      AND event.event_version = 1
      AND event.occurred_at = NEW.occurred_at
      AND event.payload = expected_event_payload
  ) INTO provenance_exists;

  IF NOT provenance_exists THEN
    RAISE EXCEPTION
      'Moderation action requires active RBAC, governance audit, and redacted Outbox provenance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION platform.validate_runtime_moderation_action_provenance()
  FROM PUBLIC;

CREATE CONSTRAINT TRIGGER moderation_actions_validate_runtime_provenance
AFTER INSERT ON platform.moderation_actions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_runtime_moderation_action_provenance();

CREATE FUNCTION platform.validate_runtime_governance_outbox_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  event_xid xid;
  privileged_writer boolean;
  provenance_exists boolean;
BEGIN
  SELECT role.rolsuper OR relation.relowner = role.oid
  INTO privileged_writer
  FROM pg_roles AS role
  CROSS JOIN pg_class AS relation
  JOIN pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE role.rolname = current_user
    AND namespace.nspname = 'system'
    AND relation.relname = 'outbox_events'
    AND relation.relkind IN ('p', 'r');

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Governance Outbox validator cannot identify the effective writer'
      USING ERRCODE = '42501';
  END IF;

  IF privileged_writer THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_SCHEMA <> 'system'
    OR TG_TABLE_NAME <> 'outbox_events'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Governance Outbox validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.event_type NOT IN (
    'report.created',
    'content.moderation_changed',
    'moderation.case_dismissed'
  ) THEN
    RETURN NULL;
  END IF;

  IF NEW.event_version <> 1
    OR NEW.available_at IS DISTINCT FROM NEW.occurred_at
    OR NEW.created_at IS DISTINCT FROM NEW.occurred_at
    OR NEW.max_attempts <> 12 THEN
    RAISE EXCEPTION
      'Protected governance Outbox events require canonical delivery metadata'
      USING ERRCODE = '23514';
  END IF;

  SELECT event.xmin
  INTO event_xid
  FROM system.outbox_events AS event
  WHERE event.id = NEW.id;

  IF NEW.event_type = 'report.created' THEN
    SELECT EXISTS (
      SELECT 1
      FROM platform.reports AS report
      JOIN platform.moderation_case_items AS item
        ON item.report_id = report.id
      JOIN platform.moderation_cases AS moderation_case
        ON moderation_case.id = item.case_id
      WHERE report.id::text = NEW.aggregate_id
        AND NEW.aggregate_type = 'report'
        AND NEW.aggregate_sequence = 1
        AND report.xmin = event_xid
        AND report.target_type = 'content'
        AND report.target_agent_id IS NULL
        AND NEW.occurred_at = report.created_at
        AND NEW.payload = jsonb_build_object(
          'report_id', report.id,
          'case_id', moderation_case.id,
          'content_id', report.target_content_id,
          'reason_code', report.reason_code
        )
    ) INTO provenance_exists;
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM platform.moderation_actions AS action
      WHERE action.outbox_event_id = NEW.id
        AND action.xmin = event_xid
        AND NEW.occurred_at = action.occurred_at
        AND NEW.event_type = CASE action.action
          WHEN 'dismiss' THEN 'moderation.case_dismissed'
          ELSE 'content.moderation_changed'
        END
    ) INTO provenance_exists;
  END IF;

  IF NOT provenance_exists THEN
    RAISE EXCEPTION
      'Protected governance Outbox event requires matching domain provenance in the same transaction'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION platform.validate_runtime_governance_outbox_provenance()
  FROM PUBLIC;

CREATE CONSTRAINT TRIGGER outbox_events_validate_governance_provenance
AFTER INSERT ON system.outbox_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_runtime_governance_outbox_provenance();

CREATE FUNCTION platform.validate_runtime_governance_action_log_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  log_xid xid;
  privileged_writer boolean;
BEGIN
  SELECT role.rolsuper OR relation.relowner = role.oid
  INTO privileged_writer
  FROM pg_roles AS role
  CROSS JOIN pg_class AS relation
  JOIN pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE role.rolname = current_user
    AND namespace.nspname = 'platform'
    AND relation.relname = 'action_logs'
    AND relation.relkind IN ('p', 'r');

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Governance ActionLog validator cannot identify the effective writer'
      USING ERRCODE = '42501';
  END IF;

  IF privileged_writer THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'action_logs'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Governance ActionLog validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.event_class <> 'governance'
    OR NEW.action NOT IN (
      'moderation.dismiss',
      'moderation.limit_content',
      'moderation.hide_content',
      'moderation.restore_content'
    ) THEN
    RETURN NULL;
  END IF;

  SELECT log.xmin
  INTO log_xid
  FROM platform.action_logs AS log
  WHERE log.id = NEW.id;

  IF NOT EXISTS (
    SELECT 1
    FROM platform.moderation_actions AS action
    WHERE action.action_log_id = NEW.id
      AND action.xmin = log_xid
      AND NEW.occurred_at = action.occurred_at
      AND NEW.action = CASE action.action
        WHEN 'dismiss' THEN 'moderation.dismiss'
        WHEN 'limit_content' THEN 'moderation.limit_content'
        WHEN 'hide_content' THEN 'moderation.hide_content'
        WHEN 'restore_content' THEN 'moderation.restore_content'
        ELSE NULL
      END
  ) THEN
    RAISE EXCEPTION
      'Protected governance ActionLog requires matching moderation provenance in the same transaction'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION platform.validate_runtime_governance_action_log_provenance()
  FROM PUBLIC;

CREATE CONSTRAINT TRIGGER action_logs_validate_governance_provenance
AFTER INSERT ON platform.action_logs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_runtime_governance_action_log_provenance();

CREATE FUNCTION platform.validate_runtime_moderation_resolution_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate_case_id uuid;
  candidate_xid xid;
  matching_action_count bigint;
  privileged_writer boolean;
BEGIN
  SELECT role.rolsuper OR relation.relowner = role.oid
  INTO privileged_writer
  FROM pg_roles AS role
  CROSS JOIN pg_class AS relation
  JOIN pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE role.rolname = current_user
    AND namespace.nspname = 'platform'
    AND relation.relname = TG_TABLE_NAME
    AND relation.relkind IN ('p', 'r');

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Moderation resolution validator cannot identify the effective writer'
      USING ERRCODE = '42501';
  END IF;

  IF privileged_writer THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_OP <> 'UPDATE'
    OR TG_TABLE_NAME NOT IN ('reports', 'moderation_cases') THEN
    RAISE EXCEPTION
      'Moderation resolution validator invoked outside its bindings'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status NOT IN ('resolved_action', 'dismissed') THEN
    IF TG_TABLE_NAME <> 'moderation_cases' THEN
      RAISE EXCEPTION
        'Runtime moderation records may change only for Report attachment or an audited terminal decision transaction'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status <> 'open'
      OR NEW.status <> 'open'
      OR NEW.priority <> 'normal'
      OR NEW.assigned_admin_id IS NOT NULL
      OR NEW.resolution_code IS NOT NULL
      OR NEW.closed_at IS NOT NULL THEN
      RAISE EXCEPTION
        'Runtime moderation records may change only for Report attachment or an audited terminal decision transaction'
        USING ERRCODE = '23514';
    END IF;

    SELECT moderation_case.xmin
    INTO candidate_xid
    FROM platform.moderation_cases AS moderation_case
    WHERE moderation_case.id = NEW.id;

    IF (
      SELECT count(*)
      FROM platform.moderation_case_items AS item
      WHERE item.case_id = NEW.id
    ) <> NEW.version
      OR (
        SELECT count(*)
        FROM platform.moderation_case_items AS item
        JOIN platform.reports AS report
          ON report.id = item.report_id
         AND report.xmin = candidate_xid
        JOIN platform.report_submission_idempotency AS submission
          ON submission.report_id = report.id
         AND submission.reporter_owner_id = report.reporter_owner_id
         AND submission.xmin = candidate_xid
        JOIN system.outbox_events AS event
          ON event.aggregate_type = 'report'
         AND event.aggregate_id = report.id::text
         AND event.aggregate_sequence = 1
         AND event.event_type = 'report.created'
         AND event.event_version = 1
         AND event.xmin = candidate_xid
        WHERE item.case_id = NEW.id
          AND item.xmin = candidate_xid
      ) <> 1 THEN
      RAISE EXCEPTION
        'Runtime active ModerationCase version changes require exactly one matching Report bundle'
        USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'reports' THEN
    SELECT item.case_id, report.xmin
    INTO candidate_case_id, candidate_xid
    FROM platform.reports AS report
    JOIN platform.moderation_case_items AS item ON item.report_id = report.id
    WHERE report.id = NEW.id;
  ELSE
    candidate_case_id := NEW.id;
    SELECT moderation_case.xmin
    INTO candidate_xid
    FROM platform.moderation_cases AS moderation_case
    WHERE moderation_case.id = NEW.id;
  END IF;

  IF TG_TABLE_NAME = 'reports' THEN
    SELECT count(*)
    INTO matching_action_count
    FROM platform.moderation_actions AS action
    WHERE action.case_id = candidate_case_id
      AND action.xmin = candidate_xid
      AND (
        (NEW.status = 'dismissed' AND action.action = 'dismiss')
        OR (
          NEW.status = 'resolved_action'
          AND action.action IN ('limit_content', 'hide_content')
        )
      );
  ELSE
    SELECT count(*)
    INTO matching_action_count
    FROM platform.moderation_actions AS action
    WHERE action.case_id = candidate_case_id
      AND action.xmin = candidate_xid
      AND (
        (NEW.status = 'dismissed' AND action.action = 'dismiss')
        OR (
          NEW.status = 'resolved_action'
          AND action.action IN (
            'limit_content',
            'hide_content',
            'restore_content'
          )
        )
      )
      AND action.case_version_after = NEW.version
      AND action.case_updated_at_after = NEW.updated_at
      AND action.case_closed_at_after = NEW.closed_at;
  END IF;

  IF matching_action_count <> 1 THEN
    RAISE EXCEPTION
      'Terminal moderation state requires a matching action in the same transaction'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION platform.validate_runtime_moderation_resolution_provenance()
  FROM PUBLIC;

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
  content_distribution_state text;
  content_lifecycle_state text;
  content_root_content_id uuid;
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
  is_delete_write boolean := false;
  is_initial_write boolean;
  is_moderation_write boolean := false;
  moderation_before_distribution_state text;
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
        IF NEW.version <> 1
          OR NEW.lifecycle_state <> 'published'
          OR NEW.deleted_at IS NOT NULL THEN
          RAISE EXCEPTION
            'Runtime ContentItem must begin published at version one'
            USING ERRCODE = '23514';
        END IF;
      ELSE
        initializes_revision :=
          OLD.version = 1
          AND NEW.version = 1
          AND OLD.current_revision_id IS NULL
          AND NEW.current_revision_id IS NOT NULL;
        is_delete_write :=
          OLD.lifecycle_state = 'published'
          AND NEW.lifecycle_state = 'deleted';
        is_moderation_write :=
          NEW.distribution_state IS DISTINCT FROM OLD.distribution_state;
        moderation_before_distribution_state := OLD.distribution_state;

        IF NOT initializes_revision
          AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION
            'Runtime ContentItem update must advance exactly one version'
            USING ERRCODE = '23514';
        END IF;

        IF is_moderation_write THEN
          IF initializes_revision
            OR is_delete_write
            OR OLD.lifecycle_state <> 'published'
            OR NEW.lifecycle_state <> 'published'
            OR OLD.deleted_at IS NOT NULL
            OR NEW.deleted_at IS NOT NULL
            OR NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id
            OR NEW.primary_community_id IS DISTINCT FROM OLD.primary_community_id
            OR NEW.erasure_state IS DISTINCT FROM OLD.erasure_state THEN
            RAISE EXCEPTION
              'Runtime moderation may change only Content version and distribution state'
              USING ERRCODE = '23514';
          END IF;
        ELSIF is_delete_write THEN
          IF NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id
            OR NEW.deleted_at IS NULL
            OR OLD.deleted_at IS NOT NULL
            OR NEW.distribution_state IS DISTINCT FROM OLD.distribution_state
            OR NEW.erasure_state IS DISTINCT FROM OLD.erasure_state THEN
            RAISE EXCEPTION
              'Runtime author deletion may change only version, lifecycle state, and deletion time'
              USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
          OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
          RAISE EXCEPTION
            'Runtime ContentItem state change is not an author soft deletion'
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
    content.distribution_state,
    content.lifecycle_state,
    content.root_id,
    content.version,
    content.xmin,
    revision.revision_number,
    revision.source_version,
    revision.xmin
  INTO
    content_author_actor_id,
    content_current_revision_id,
    content_kind,
    content_distribution_state,
    content_lifecycle_state,
    content_root_content_id,
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

  -- Classification or Revision facts cannot be attached, removed, or closed
  -- under a deletion event. The tombstone changes only the ContentItem row.
  IF content_lifecycle_state = 'deleted'
    AND (TG_TABLE_NAME <> 'content_items' OR NOT is_delete_write) THEN
    RAISE EXCEPTION
      'Runtime author deletion cannot mutate content classification or Revision facts'
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


  IF is_moderation_write THEN
    IF content_lifecycle_state <> 'published'
      OR current_revision_source_version >= content_version THEN
      RAISE EXCEPTION
        'Runtime moderation cannot restore author-deleted content or create a Revision'
        USING ERRCODE = '23514';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM platform.moderation_cases AS moderation_case
      JOIN platform.moderation_actions AS moderation_action
        ON moderation_action.case_id = moderation_case.id
       AND moderation_action.xmin = content_xid
      JOIN platform.admins AS admin
        ON admin.id = moderation_action.admin_id
       AND admin.status = 'active'
      JOIN platform.admin_assignments AS assignment
        ON assignment.admin_id = admin.id
       AND assignment.granted_at <= moderation_action.occurred_at
       AND assignment.revoked_at IS NULL
       AND (
         assignment.expires_at IS NULL
         OR assignment.expires_at > moderation_action.occurred_at
       )
      JOIN platform.admin_roles AS role
        ON role.id = assignment.role_id
       AND role.status = 'active'
      JOIN platform.admin_role_permissions AS role_permission
        ON role_permission.role_id = role.id
       AND role_permission.permission = moderation_action.permission_used
      JOIN platform.action_logs AS log
        ON log.id = moderation_action.action_log_id
       AND log.xmin = content_xid
      JOIN system.outbox_events AS event
        ON event.id = moderation_action.outbox_event_id
       AND event.xmin = content_xid
      WHERE moderation_case.target_type = 'content'
        AND moderation_case.target_content_id = candidate_content_id
        AND moderation_case.target_agent_id IS NULL
        AND moderation_action.permission_used = 'moderation:decide'
        AND moderation_action.action = CASE content_distribution_state
          WHEN 'limited' THEN 'limit_content'
          WHEN 'hidden' THEN 'hide_content'
          WHEN 'normal' THEN 'restore_content'
          ELSE NULL
        END
        AND moderation_action.before_distribution_state =
          moderation_before_distribution_state
        AND moderation_action.after_distribution_state =
          content_distribution_state
        AND moderation_action.target_version_before = content_version - 1
        AND moderation_action.target_version_after = content_version
        AND moderation_action.result_state = 'succeeded'
        AND log.event_class = 'governance'
        AND log.actor_id IS NULL
        AND log.actor_kind IS NULL
        AND log.owner_id IS NULL
        AND log.agent_id IS NULL
        AND log.credential_id IS NULL
        AND log.admin_id = moderation_action.admin_id
        AND log.channel = 'admin_web'
        AND log.approval_method = 'admin_override'
        AND log.approved_by_owner_id IS NULL
        AND log.authentication_assurance = 'workforce_oidc'
        AND log.authorization_snapshot ->> 'permission' =
          moderation_action.permission_used
        AND log.action = CASE moderation_action.action
          WHEN 'limit_content' THEN 'moderation.limit_content'
          WHEN 'hide_content' THEN 'moderation.hide_content'
          WHEN 'restore_content' THEN 'moderation.restore_content'
          ELSE NULL
        END
        AND log.target_type = 'content'
        AND log.target_id = candidate_content_id::text
        AND log.decision = 'allow'
        AND log.outcome = 'succeeded'
        AND log.error_code IS NULL
        AND log.retry_count = 0
        AND log.outbox_event_id = event.id
        AND log.policy_version IS NULL
        AND log.security_subject_digest IS NULL
        AND log.before_state = jsonb_build_object(
          'distribution_state', moderation_before_distribution_state,
          'resource_version', content_version - 1
        )
        AND log.after_state = jsonb_build_object(
          'content_id', candidate_content_id,
          'case_id', moderation_case.id,
          'moderation_action_id', moderation_action.id,
          'distribution_state', content_distribution_state,
          'resource_version', content_version
        )
        AND log.reason_code = moderation_action.reason_code
        AND event.aggregate_type = 'content'
        AND event.aggregate_id = candidate_content_id::text
        AND event.event_type = 'content.moderation_changed'
        AND event.event_version = 1
        AND event.payload = jsonb_build_object(
          'content_id', candidate_content_id,
          'case_id', moderation_case.id,
          'moderation_action_id', moderation_action.id,
          'reason_code', moderation_action.reason_code,
          'before_distribution_state', moderation_before_distribution_state,
          'after_distribution_state', content_distribution_state,
          'resource_version', content_version,
          'kind', content_kind,
          'root_content_id', content_root_content_id,
          'current_revision_id', content_current_revision_id
        )
    ) INTO provenance_exists;

    IF NOT provenance_exists THEN
      RAISE EXCEPTION
        'Runtime distribution change requires moderation, RBAC, audit, and Outbox provenance'
        USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
  END IF;

  is_initial_write :=
    content_lifecycle_state = 'published'
    AND content_version = 1
    AND current_revision_number = 1
    AND current_revision_source_version = 1;
  is_revision_write :=
    is_initial_write
    OR (
      content_lifecycle_state = 'published'
      AND current_revision_source_version = content_version
    );

  IF is_revision_write
    AND current_revision_xid IS DISTINCT FROM content_xid THEN
    RAISE EXCEPTION
      'Runtime author Revision must share the ContentItem transaction id'
      USING ERRCODE = '23514';
  END IF;

  IF is_delete_write THEN
    IF content_lifecycle_state <> 'deleted'
      OR current_revision_source_version >= content_version THEN
      RAISE EXCEPTION
        'Runtime author deletion must retain the prior current Revision'
        USING ERRCODE = '23514';
    END IF;
    expected_action := 'content.delete_content';
    expected_event_type := 'content.deleted';
    expected_operation := 'delete_content';
    expected_response_code := 200;
  ELSIF is_initial_write THEN
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
    IF content_lifecycle_state <> 'published' THEN
      RAISE EXCEPTION
        'Runtime ContentItem state has no supported content command'
        USING ERRCODE = '23514';
    END IF;
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
          is_delete_write
          AND event.payload ->> 'resource_version' = content_version::text
          AND event.payload ->> 'lifecycle_state' = 'deleted'
          AND event.payload ->> 'kind' = content_kind
          AND event.payload ->> 'root_content_id' = content_root_content_id::text
          AND event.payload ->> 'current_revision_id' =
            content_current_revision_id::text
        )
        OR (
          is_initial_write
          AND event.payload ->> 'kind' = content_kind
          AND event.payload ->> 'revision_id' = content_current_revision_id::text
        )
        OR (
          NOT is_delete_write
          AND NOT is_initial_write
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
      AND (
        NOT is_delete_write
        OR log.after_state ->> 'lifecycle_state' = 'deleted'
      )
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
                NOT is_delete_write
                OR action.result ->> 'lifecycle_state' = 'deleted'
              )
              AND (
                (
                  expected_operation IN ('update_content', 'delete_content')
                  AND action.expected_version = content_version - 1
                )
                OR (
                  expected_operation NOT IN ('update_content', 'delete_content')
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


CREATE CONSTRAINT TRIGGER reports_validate_runtime_resolution_provenance
AFTER UPDATE ON platform.reports
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_runtime_moderation_resolution_provenance();

CREATE CONSTRAINT TRIGGER moderation_cases_validate_runtime_resolution_provenance
AFTER UPDATE ON platform.moderation_cases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_runtime_moderation_resolution_provenance();
