SET LOCAL search_path = pg_catalog;

-- Frozen Content ranking candidates ---------------------------------------
--
-- Reactions and replies can change between cursor pages. Persist the bounded,
-- already-ranked horizon from page one so continuation requests never rerun a
-- mutable rank and therefore cannot duplicate or skip candidates. This is a
-- short-lived PostgreSQL consistency primitive, not a second source of Content
-- truth or a distributed ranking service. Candidate payloads deliberately
-- contain no UGC, query text, identity metadata, or hydrated projections.
CREATE TABLE system.content_ranking_candidate_snapshots (
  snapshot_id text PRIMARY KEY,
  binding_hmac bytea NOT NULL,
  snapshot_kind text NOT NULL,
  candidates jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT content_ranking_candidate_snapshots_id
    CHECK (snapshot_id ~ '^crs_[0-9a-f]{32}$'),
  CONSTRAINT content_ranking_candidate_snapshots_binding
    CHECK (octet_length(binding_hmac) = 32),
  CONSTRAINT content_ranking_candidate_snapshots_kind
    CHECK (snapshot_kind IN ('browse', 'discussion')),
  CONSTRAINT content_ranking_candidate_snapshots_candidates
    CHECK (
      jsonb_typeof(candidates) = 'array'
      AND jsonb_array_length(candidates) BETWEEN 0 AND 2000
      AND pg_column_size(candidates) <= 1048576
    ),
  CONSTRAINT content_ranking_candidate_snapshots_retention
    CHECK (
      expires_at > created_at
      AND expires_at <= created_at + interval '1 hour'
    )
);

CREATE INDEX content_ranking_candidate_snapshots_expiry_idx
  ON system.content_ranking_candidate_snapshots (expires_at, snapshot_id);

COMMENT ON TABLE system.content_ranking_candidate_snapshots IS
  'Short-lived immutable browse/discussion ranking horizons. Candidate JSON is restricted to content_id, created_at, order_at, and score_micros; UGC and identity metadata are forbidden.';

CREATE FUNCTION system.store_content_ranking_candidate_snapshot(
  candidate_snapshot_id text,
  candidate_binding_hmac bytea,
  candidate_kind text,
  candidate_candidates jsonb,
  candidate_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate_limit integer;
  normalized_candidates jsonb;
  stored boolean;
BEGIN
  candidate_limit := CASE candidate_kind
    WHEN 'browse' THEN 500
    WHEN 'discussion' THEN 2000
    ELSE NULL
  END;

  IF candidate_snapshot_id IS NULL
    OR candidate_snapshot_id !~ '^crs_[0-9a-f]{32}$'
    OR candidate_binding_hmac IS NULL
    OR octet_length(candidate_binding_hmac) <> 32
    OR candidate_limit IS NULL
    OR candidate_candidates IS NULL
    OR jsonb_typeof(candidate_candidates) <> 'array'
    OR jsonb_array_length(candidate_candidates) NOT BETWEEN 0 AND candidate_limit
    OR pg_column_size(candidate_candidates) > 1048576
    OR candidate_expires_at IS NULL
    OR candidate_expires_at <= statement_timestamp()
    OR candidate_expires_at > statement_timestamp() + interval '1 hour' THEN
    RAISE EXCEPTION 'Invalid Content ranking candidate snapshot'
      USING ERRCODE = '22023';
  END IF;

  -- Validate objects before invoking object-only JSON functions. PostgreSQL is
  -- free to reorder boolean predicates, so separate checks avoid scalar input
  -- reaching jsonb_object_length or key extraction.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(candidate_candidates) AS item(value)
    WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION 'Invalid Content ranking candidate snapshot payload'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(candidate_candidates) AS item(value)
    WHERE (
        SELECT count(*)
        FROM jsonb_object_keys(item.value)
      ) <> 4
      OR NOT item.value ?& ARRAY[
        'content_id',
        'created_at',
        'order_at',
        'score_micros'
      ]
  ) THEN
    RAISE EXCEPTION 'Invalid Content ranking candidate snapshot payload'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(candidate_candidates) AS item(value)
    WHERE jsonb_typeof(item.value -> 'content_id') IS DISTINCT FROM 'string'
      OR (item.value ->> 'content_id')
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR jsonb_typeof(item.value -> 'created_at') IS DISTINCT FROM 'string'
      OR (item.value ->> 'created_at')
        !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
      OR jsonb_typeof(item.value -> 'order_at') IS DISTINCT FROM 'string'
      OR (item.value ->> 'order_at')
        !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
      OR jsonb_typeof(item.value -> 'score_micros') IS DISTINCT FROM 'number'
      OR (item.value ->> 'score_micros')
        !~ '^-?(0|[1-9][0-9]{0,15})$'
  ) THEN
    RAISE EXCEPTION 'Invalid Content ranking candidate snapshot payload'
      USING ERRCODE = '22023';
  END IF;

  -- Require canonical millisecond UTC timestamps and JavaScript-safe integer
  -- scores. A cursor payload can therefore round-trip without float drift.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(candidate_candidates) AS item(value)
    WHERE to_char(
        (item.value ->> 'created_at')::timestamptz AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) <> item.value ->> 'created_at'
      OR to_char(
        (item.value ->> 'order_at')::timestamptz AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) <> item.value ->> 'order_at'
      OR abs((item.value ->> 'score_micros')::numeric) > 9007199254740991
  ) THEN
    RAISE EXCEPTION 'Invalid Content ranking candidate snapshot payload'
      USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'content_id', item.value -> 'content_id',
        'created_at', item.value -> 'created_at',
        'order_at', item.value -> 'order_at',
        'score_micros', item.value -> 'score_micros'
      )
      ORDER BY item.position
    ),
    '[]'::jsonb
  )
  INTO normalized_candidates
  FROM jsonb_array_elements(candidate_candidates)
    WITH ORDINALITY AS item(value, position);

  IF pg_column_size(normalized_candidates) > 1048576
    OR (
      SELECT count(DISTINCT item.value ->> 'content_id')
      FROM jsonb_array_elements(normalized_candidates) AS item(value)
    ) <> jsonb_array_length(normalized_candidates) THEN
    RAISE EXCEPTION 'Invalid Content ranking candidate snapshot payload'
      USING ERRCODE = '22023';
  END IF;

  -- Opportunistic cleanup is intentionally bounded so admission latency does
  -- not grow with retention backlog. The Worker/ops purge function below is
  -- the primary cleanup path.
  WITH expired AS (
    SELECT snapshot.snapshot_id
    FROM system.content_ranking_candidate_snapshots AS snapshot
    WHERE snapshot.expires_at <= statement_timestamp()
    ORDER BY snapshot.expires_at, snapshot.snapshot_id
    LIMIT 500
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM system.content_ranking_candidate_snapshots AS snapshot
  USING expired
  WHERE snapshot.snapshot_id = expired.snapshot_id;

  INSERT INTO system.content_ranking_candidate_snapshots (
    snapshot_id,
    binding_hmac,
    snapshot_kind,
    candidates,
    expires_at
  )
  VALUES (
    candidate_snapshot_id,
    candidate_binding_hmac,
    candidate_kind,
    normalized_candidates,
    candidate_expires_at
  )
  ON CONFLICT (snapshot_id) DO NOTHING;

  SELECT EXISTS (
    SELECT 1
    FROM system.content_ranking_candidate_snapshots AS snapshot
    WHERE snapshot.snapshot_id = candidate_snapshot_id
      AND snapshot.binding_hmac = candidate_binding_hmac
      AND snapshot.snapshot_kind = candidate_kind
      AND snapshot.candidates = normalized_candidates
      AND snapshot.expires_at = candidate_expires_at
  )
  INTO stored;

  IF NOT stored THEN
    RAISE EXCEPTION 'Content ranking candidate snapshot identity conflict'
      USING ERRCODE = '55000';
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION system.store_content_ranking_candidate_snapshot(
  text,
  bytea,
  text,
  jsonb,
  timestamptz
)
FROM PUBLIC;

CREATE FUNCTION system.purge_expired_content_ranking_candidate_snapshots(
  candidate_batch_size integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF candidate_batch_size IS NULL
    OR candidate_batch_size NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Invalid Content ranking snapshot purge batch size'
      USING ERRCODE = '22023';
  END IF;

  WITH expired AS (
    SELECT snapshot.snapshot_id
    FROM system.content_ranking_candidate_snapshots AS snapshot
    WHERE snapshot.expires_at <= statement_timestamp()
    ORDER BY snapshot.expires_at, snapshot.snapshot_id
    LIMIT candidate_batch_size
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM system.content_ranking_candidate_snapshots AS snapshot
    USING expired
    WHERE snapshot.snapshot_id = expired.snapshot_id
    RETURNING snapshot.snapshot_id
  )
  SELECT count(*)::integer INTO deleted_count FROM deleted;

  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION
  system.purge_expired_content_ranking_candidate_snapshots(integer)
FROM PUBLIC;

-- Time-leading indexes support bounded recent-interaction recall before the
-- service computes exact, versioned ranking scores from canonical facts.
CREATE INDEX reactions_ranking_recent_idx
  ON platform.reactions (
    created_at DESC,
    content_id,
    reaction_type,
    actor_id
  );

CREATE INDEX content_items_ranking_reply_recent_idx
  ON platform.content_items (
    published_at DESC,
    root_id,
    author_actor_id,
    id
  )
  WHERE kind = 'reply'
    AND lifecycle_state = 'published'
    AND distribution_state = 'normal';
