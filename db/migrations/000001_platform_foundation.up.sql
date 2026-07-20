CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS system;

CREATE TABLE platform.communities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug citext NOT NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT communities_slug_unique UNIQUE (slug),
  CONSTRAINT communities_slug_format
    CHECK (slug::text ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  CONSTRAINT communities_name_not_blank
    CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT communities_description_size
    CHECK (description IS NULL OR length(description) <= 2000),
  CONSTRAINT communities_status
    CHECK (status IN ('active', 'archived')),
  CONSTRAINT communities_settings_object
    CHECK (jsonb_typeof(settings) = 'object'),
  CONSTRAINT communities_updated_after_created
    CHECK (updated_at >= created_at)
);

COMMENT ON TABLE platform.communities IS
  'Canonical community records. Content-to-community placement belongs in a later domain migration.';

CREATE TABLE system.outbox_aggregate_heads (
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  last_sequence bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (aggregate_type, aggregate_id),
  CONSTRAINT outbox_heads_aggregate_type_not_blank
    CHECK (length(btrim(aggregate_type)) BETWEEN 1 AND 120),
  CONSTRAINT outbox_heads_aggregate_id_not_blank
    CHECK (length(btrim(aggregate_id)) BETWEEN 1 AND 200),
  CONSTRAINT outbox_heads_sequence_positive
    CHECK (last_sequence > 0),
  CONSTRAINT outbox_heads_updated_after_created
    CHECK (updated_at >= created_at)
);

COMMENT ON TABLE system.outbox_aggregate_heads IS
  'Persistent sequence heads used to serialize producers per aggregate and preserve ordering after event compaction.';

CREATE TABLE system.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_sequence bigint NOT NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  max_attempts integer NOT NULL DEFAULT 12,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT outbox_aggregate_order
    UNIQUE (aggregate_type, aggregate_id, aggregate_sequence),
  CONSTRAINT outbox_aggregate_type_not_blank
    CHECK (length(btrim(aggregate_type)) BETWEEN 1 AND 120),
  CONSTRAINT outbox_aggregate_id_not_blank
    CHECK (length(btrim(aggregate_id)) BETWEEN 1 AND 200),
  CONSTRAINT outbox_aggregate_sequence_positive
    CHECK (aggregate_sequence > 0),
  CONSTRAINT outbox_event_type_not_blank
    CHECK (length(btrim(event_type)) BETWEEN 1 AND 160),
  CONSTRAINT outbox_event_version_positive
    CHECK (event_version > 0),
  CONSTRAINT outbox_payload_object
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_max_attempts_positive
    CHECK (max_attempts > 0)
);

COMMENT ON TABLE system.outbox_events IS
  'Immutable transactional domain events. Delivery progress is tracked independently per consumer.';

CREATE FUNCTION system.advance_outbox_aggregate_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_sequence bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'alphanet:outbox-aggregate:'
        || octet_length(NEW.aggregate_type)::text
        || ':'
        || NEW.aggregate_type
        || ':'
        || NEW.aggregate_id,
      0
    )
  );

  SELECT head.last_sequence
  INTO previous_sequence
  FROM system.outbox_aggregate_heads AS head
  WHERE head.aggregate_type = NEW.aggregate_type
    AND head.aggregate_id = NEW.aggregate_id
  FOR UPDATE;

  IF FOUND THEN
    IF NEW.aggregate_sequence <> previous_sequence + 1 THEN
      RAISE EXCEPTION
        'outbox aggregate sequence must advance exactly by one'
        USING ERRCODE = '23514';
    END IF;

    UPDATE system.outbox_aggregate_heads
    SET last_sequence = NEW.aggregate_sequence,
        updated_at = clock_timestamp()
    WHERE aggregate_type = NEW.aggregate_type
      AND aggregate_id = NEW.aggregate_id;
  ELSE
    IF NEW.aggregate_sequence <> 1 THEN
      RAISE EXCEPTION
        'first outbox aggregate sequence must be one'
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO system.outbox_aggregate_heads (
      aggregate_type,
      aggregate_id,
      last_sequence
    )
    VALUES (
      NEW.aggregate_type,
      NEW.aggregate_id,
      NEW.aggregate_sequence
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_events_advance_aggregate_head
BEFORE INSERT ON system.outbox_events
FOR EACH ROW
EXECUTE FUNCTION system.advance_outbox_aggregate_head();

CREATE INDEX outbox_events_registration_idx
  ON system.outbox_events (created_at, available_at, occurred_at, id);

CREATE TABLE system.outbox_consumers (
  consumer_name text PRIMARY KEY,
  event_types text[],
  replay_from timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT outbox_consumers_name_not_blank
    CHECK (length(btrim(consumer_name)) BETWEEN 1 AND 120),
  CONSTRAINT outbox_consumers_event_types_not_empty
    CHECK (
      event_types IS NULL
      OR (
        cardinality(event_types) > 0
        AND array_position(event_types, NULL) IS NULL
      )
    )
);

COMMENT ON TABLE system.outbox_consumers IS
  'Immutable, versioned consumer subscriptions. A null event_types array subscribes to all types; replay_from is an inclusive outbox created_at watermark.';

CREATE FUNCTION system.prevent_outbox_consumer_subscription_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'outbox consumer subscriptions are immutable; retire the version without deleting it';
  END IF;
  IF NEW.consumer_name IS DISTINCT FROM OLD.consumer_name
    OR NEW.event_types IS DISTINCT FROM OLD.event_types
    OR NEW.replay_from IS DISTINCT FROM OLD.replay_from THEN
    RAISE EXCEPTION
      'outbox consumer subscriptions are immutable; create a new consumer version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_consumers_immutable_subscription
BEFORE UPDATE OR DELETE ON system.outbox_consumers
FOR EACH ROW
EXECUTE FUNCTION system.prevent_outbox_consumer_subscription_change();

CREATE TABLE system.outbox_consumer_deliveries (
  consumer_name text NOT NULL
    REFERENCES system.outbox_consumers(consumer_name) ON DELETE RESTRICT,
  event_id uuid NOT NULL REFERENCES system.outbox_events(id) ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL,
  available_at timestamptz NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  dead_letter_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer_name, event_id),
  CONSTRAINT outbox_deliveries_consumer_not_blank
    CHECK (length(btrim(consumer_name)) BETWEEN 1 AND 120),
  CONSTRAINT outbox_deliveries_attempts_valid
    CHECK (attempts >= 0 AND max_attempts > 0 AND attempts <= max_attempts),
  CONSTRAINT outbox_deliveries_lease_complete
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT outbox_deliveries_terminal_state
    CHECK (NOT (delivered_at IS NOT NULL AND dead_lettered_at IS NOT NULL)),
  CONSTRAINT outbox_deliveries_dead_letter_reason
    CHECK (
      (dead_lettered_at IS NULL AND dead_letter_reason IS NULL)
      OR (dead_lettered_at IS NOT NULL AND length(btrim(dead_letter_reason)) > 0)
    ),
  CONSTRAINT outbox_deliveries_updated_after_created
    CHECK (updated_at >= created_at)
);

COMMENT ON TABLE system.outbox_consumer_deliveries IS
  'Per-consumer leases, retries, terminal state, and dead-letter progress for outbox events.';

CREATE INDEX outbox_consumer_deliveries_ready_idx
  ON system.outbox_consumer_deliveries (
    consumer_name,
    available_at,
    event_id
  )
  WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;

CREATE INDEX outbox_consumer_deliveries_expired_lease_idx
  ON system.outbox_consumer_deliveries (
    consumer_name,
    lease_expires_at,
    event_id
  )
  WHERE lease_expires_at IS NOT NULL
    AND delivered_at IS NULL
    AND dead_lettered_at IS NULL;

CREATE TABLE system.outbox_consumer_receipts (
  consumer_name text NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (consumer_name, event_id),
  CONSTRAINT outbox_receipts_consumer_not_blank
    CHECK (length(btrim(consumer_name)) BETWEEN 1 AND 120),
  CONSTRAINT outbox_receipts_result_object
    CHECK (jsonb_typeof(result) = 'object')
);

COMMENT ON TABLE system.outbox_consumer_receipts IS
  'Idempotency receipts intentionally have no foreign key so they may outlive compacted outbox rows.';
