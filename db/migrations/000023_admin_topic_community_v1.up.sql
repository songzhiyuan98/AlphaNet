SET LOCAL search_path = pg_catalog;

ALTER TABLE platform.communities
  DROP CONSTRAINT communities_description_size,
  ADD CONSTRAINT communities_description_size
    CHECK (description IS NULL OR length(description) <= 4000);

CREATE TABLE platform.topic_community_admin_actions (
  id uuid PRIMARY KEY,
  admin_id uuid NOT NULL
    REFERENCES platform.admins(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  permission_used text NOT NULL,
  action text NOT NULL,
  community_id uuid NOT NULL
    REFERENCES platform.communities(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  community_version_before bigint,
  community_version_after bigint NOT NULL,
  idempotency_key text NOT NULL,
  request_digest bytea NOT NULL,
  request_id text NOT NULL,
  authorization_snapshot jsonb NOT NULL,
  before_state jsonb,
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
  CONSTRAINT topic_community_admin_actions_idempotency_unique
    UNIQUE (admin_id, idempotency_key),
  CONSTRAINT topic_community_admin_actions_action_log_unique
    UNIQUE (action_log_id),
  CONSTRAINT topic_community_admin_actions_outbox_unique
    UNIQUE (outbox_event_id),
  CONSTRAINT topic_community_admin_actions_permission
    CHECK (permission_used = 'community:manage'),
  CONSTRAINT topic_community_admin_actions_action
    CHECK (action IN ('create', 'update', 'archive')),
  CONSTRAINT topic_community_admin_actions_versions
    CHECK (
      (
        action = 'create'
        AND community_version_before IS NULL
        AND community_version_after = 1
        AND before_state IS NULL
      )
      OR (
        action IN ('update', 'archive')
        AND community_version_before > 0
        AND community_version_after = community_version_before + 1
        AND before_state IS NOT NULL
      )
    ),
  CONSTRAINT topic_community_admin_actions_idempotency_key_size
    CHECK (
      length(idempotency_key) BETWEEN 1 AND 200
      AND idempotency_key !~ '[[:cntrl:]]'
    ),
  CONSTRAINT topic_community_admin_actions_request_digest_sha256
    CHECK (octet_length(request_digest) = 32),
  CONSTRAINT topic_community_admin_actions_request_id_size
    CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  CONSTRAINT topic_community_admin_actions_snapshot_objects
    CHECK (
      jsonb_typeof(authorization_snapshot) = 'object'
      AND platform.audit_json_is_secret_free(authorization_snapshot)
      AND (before_state IS NULL OR (
        jsonb_typeof(before_state) = 'object'
        AND platform.audit_json_is_secret_free(before_state)
      ))
      AND jsonb_typeof(after_state) = 'object'
      AND platform.audit_json_is_secret_free(after_state)
      AND jsonb_typeof(response_snapshot) = 'object'
      AND platform.audit_json_is_secret_free(response_snapshot)
    ),
  CONSTRAINT topic_community_admin_actions_time
    CHECK (created_at >= occurred_at)
);

CREATE INDEX topic_community_admin_actions_community_occurred_idx
  ON platform.topic_community_admin_actions (
    community_id,
    occurred_at DESC,
    id DESC
  );

COMMENT ON TABLE platform.topic_community_admin_actions IS
  'Append-only idempotency, result, and provenance facts for workforce topic-community governance.';

CREATE FUNCTION platform.prevent_topic_community_admin_action_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'Topic Community Admin actions are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER topic_community_admin_actions_prevent_mutation
BEFORE UPDATE OR DELETE ON platform.topic_community_admin_actions
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_topic_community_admin_action_mutation();

REVOKE ALL ON FUNCTION platform.prevent_topic_community_admin_action_mutation()
  FROM PUBLIC;

CREATE FUNCTION platform.validate_topic_community_admin_action_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  action_xid xid;
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'topic_community_admin_actions'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Topic Community Admin provenance validator invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  SELECT action.xmin
  INTO action_xid
  FROM platform.topic_community_admin_actions AS action
  WHERE action.id = NEW.id;

  IF NOT EXISTS (
    SELECT 1
    FROM platform.action_logs AS log
    WHERE log.id = NEW.action_log_id
      AND log.xmin = action_xid
      AND log.event_class = 'governance'
      AND log.admin_id = NEW.admin_id
      AND log.channel = 'admin_web'
      AND log.authentication_assurance = 'workforce_oidc'
      AND log.authorization_snapshot = NEW.authorization_snapshot
      AND log.action = CASE NEW.action
        WHEN 'create' THEN 'community.topic_create'
        WHEN 'update' THEN 'community.topic_update'
        WHEN 'archive' THEN 'community.topic_archive'
        ELSE NULL
      END
      AND log.target_type = 'community'
      AND log.target_id = NEW.community_id::text
      AND log.outcome = 'succeeded'
      AND log.outbox_event_id = NEW.outbox_event_id
      AND log.request_id = NEW.request_id
      AND log.before_state IS NOT DISTINCT FROM NEW.before_state
      AND log.after_state = NEW.after_state
      AND log.reason_code = CASE NEW.action
        WHEN 'create' THEN 'topic_community_created'
        WHEN 'update' THEN 'topic_community_updated'
        WHEN 'archive' THEN 'topic_community_archived'
        ELSE NULL
      END
      AND log.occurred_at = NEW.occurred_at
  ) THEN
    RAISE EXCEPTION
      'Topic Community Admin action requires matching ActionLog provenance'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM system.outbox_events AS event
    WHERE event.id = NEW.outbox_event_id
      AND event.xmin = action_xid
      AND event.aggregate_type = 'community'
      AND event.aggregate_id = NEW.community_id::text
      AND event.event_type = CASE NEW.action
        WHEN 'create' THEN 'community.topic_created'
        WHEN 'update' THEN 'community.topic_updated'
        WHEN 'archive' THEN 'community.topic_archived'
        ELSE NULL
      END
      AND event.event_version = 1
      AND event.occurred_at = NEW.occurred_at
  ) THEN
    RAISE EXCEPTION
      'Topic Community Admin action requires matching Outbox provenance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER topic_community_admin_actions_validate_provenance
AFTER INSERT ON platform.topic_community_admin_actions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_topic_community_admin_action_provenance();

REVOKE ALL ON FUNCTION platform.validate_topic_community_admin_action_provenance()
  FROM PUBLIC;

CREATE FUNCTION platform.validate_topic_community_governance_log_provenance()
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
      'community.topic_create',
      'community.topic_update',
      'community.topic_archive'
    ) THEN
    RETURN NULL;
  END IF;

  SELECT log.xmin
  INTO log_xid
  FROM platform.action_logs AS log
  WHERE log.id = NEW.id;

  IF NOT EXISTS (
    SELECT 1
    FROM platform.topic_community_admin_actions AS action
    WHERE action.action_log_id = NEW.id
      AND action.xmin = log_xid
  ) THEN
    RAISE EXCEPTION
      'Topic Community governance ActionLog requires same-transaction action provenance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER action_logs_validate_topic_community_provenance
AFTER INSERT ON platform.action_logs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_topic_community_governance_log_provenance();

REVOKE ALL ON FUNCTION platform.validate_topic_community_governance_log_provenance()
  FROM PUBLIC;

CREATE FUNCTION platform.validate_topic_community_governance_outbox_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  event_xid xid;
BEGIN
  IF NEW.event_type NOT IN (
    'community.topic_created',
    'community.topic_updated',
    'community.topic_archived'
  ) THEN
    RETURN NULL;
  END IF;

  SELECT event.xmin
  INTO event_xid
  FROM system.outbox_events AS event
  WHERE event.id = NEW.id;

  IF NOT EXISTS (
    SELECT 1
    FROM platform.topic_community_admin_actions AS action
    WHERE action.outbox_event_id = NEW.id
      AND action.xmin = event_xid
  ) THEN
    RAISE EXCEPTION
      'Topic Community governance Outbox event requires same-transaction action provenance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER outbox_events_validate_topic_community_provenance
AFTER INSERT ON system.outbox_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_topic_community_governance_outbox_provenance();

REVOKE ALL ON FUNCTION platform.validate_topic_community_governance_outbox_provenance()
  FROM PUBLIC;
