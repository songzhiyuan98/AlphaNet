SET LOCAL search_path = pg_catalog;

-- Search v1 requires the PostgreSQL and pgvector baseline used by every
-- supported AlphaNet environment. Fail before changing the schema when an
-- operator points this forward-only migration at an unsupported database.
DO $$
DECLARE
  vector_version text;
BEGIN
  IF current_setting('server_version_num')::integer < 170000 THEN
    RAISE EXCEPTION 'AlphaNet Content Search v1 requires PostgreSQL 17 or newer'
      USING ERRCODE = '0A000';
  END IF;

  IF to_regtype('public.vector') IS NULL THEN
    RAISE EXCEPTION 'AlphaNet Content Search v1 requires the vector extension'
      USING ERRCODE = '0A000';
  END IF;

  SELECT extension.extversion
  INTO vector_version
  FROM pg_catalog.pg_extension AS extension
  WHERE extension.extname = 'vector';

  IF vector_version IS NULL
    OR (
      split_part(vector_version, '.', 1)::integer = 0
      AND split_part(vector_version, '.', 2)::integer < 8
    ) THEN
    RAISE EXCEPTION
      'AlphaNet Content Search v1 requires pgvector 0.8.0 or newer'
      USING ERRCODE = '0A000';
  END IF;
END;
$$;

-- Revision-scoped lexical index -------------------------------------------
--
-- Content Revisions are append-only. Index every Revision deterministically,
-- then make first-page searches join ContentItem.current_revision_id. Cursor
-- pages resolve the newest Revision visible in the signed pg_snapshot. Both
-- paths apply current visibility, keeping edits reliable without copying
-- mutable text into a second search projection.
ALTER TABLE platform.content_revisions
  ADD COLUMN search_document tsvector
  GENERATED ALWAYS AS (
    pg_catalog.setweight(
      pg_catalog.to_tsvector(
        'pg_catalog.simple'::pg_catalog.regconfig,
        coalesce(title, '')
      ),
      'A'
    )
    ||
    pg_catalog.setweight(
      pg_catalog.to_tsvector(
        'pg_catalog.simple'::pg_catalog.regconfig,
        coalesce(body_plain_text, '')
      ),
      'B'
    )
  ) STORED;

CREATE INDEX content_revisions_search_document_idx
  ON platform.content_revisions
  USING gin (search_document);

-- Search hydrates an immutable Revision through the mutable current pointer.
-- This index keeps that join bounded when the Content table reaches millions
-- of rows without indexing the initial NULL placeholder state.
CREATE INDEX content_items_current_revision_idx
  ON platform.content_items (current_revision_id)
  WHERE current_revision_id IS NOT NULL;

COMMENT ON COLUMN platform.content_revisions.search_document IS
  'Database-derived simple-config FTS document. Search uses the live current Revision or cursor-snapshot Revision and always enforces current ContentItem/Community visibility.';

-- Search generation identity ----------------------------------------------
--
-- Search cursors carry both the existing content-membership epoch and this
-- search-index epoch. Ordinary Revision and embedding writes are frozen by
-- the cursor's pg_snapshot/index_as_of boundary and intentionally do not bump
-- this epoch. Operators advance it only for an incompatible model, chunking,
-- or index-generation rebuild that cannot be represented by that boundary.
ALTER TABLE system.content_read_visibility_epochs
  DROP CONSTRAINT content_read_visibility_epochs_name,
  ADD CONSTRAINT content_read_visibility_epochs_name
    CHECK (
      epoch_name IN (
        'content_membership',
        'public_community_visibility',
        'search_index'
      )
    );

INSERT INTO system.content_read_visibility_epochs (epoch_name, epoch)
VALUES ('search_index', 1);

-- Semantic embedding chunks -----------------------------------------------

CREATE TABLE platform.content_embedding_chunks (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  revision_id uuid NOT NULL
    REFERENCES platform.content_revisions(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  embedding_model text NOT NULL
    DEFAULT 'amazon.titan-embed-text-v2:0:512',
  chunk_index integer NOT NULL,
  source_start_offset integer NOT NULL,
  source_end_offset integer NOT NULL,
  source_text_hash bytea NOT NULL,
  token_count integer NOT NULL,
  embedding public.vector(512) NOT NULL,
  search_index_created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT content_embedding_chunks_revision_model_chunk_unique
    UNIQUE (revision_id, embedding_model, chunk_index),
  CONSTRAINT content_embedding_chunks_model
    CHECK (embedding_model = 'amazon.titan-embed-text-v2:0:512'),
  CONSTRAINT content_embedding_chunks_index
    CHECK (chunk_index BETWEEN 0 AND 9999),
  CONSTRAINT content_embedding_chunks_source_range
    CHECK (
      source_start_offset >= 0
      AND source_end_offset > source_start_offset
      AND source_end_offset <= 200000
    ),
  CONSTRAINT content_embedding_chunks_source_hash
    CHECK (octet_length(source_text_hash) = 32),
  CONSTRAINT content_embedding_chunks_token_count
    CHECK (token_count BETWEEN 1 AND 8192),
  CONSTRAINT content_embedding_chunks_embedding_nonzero
    CHECK (public.vector_norm(embedding) > 0)
);

CREATE INDEX content_embedding_chunks_revision_idx
  ON platform.content_embedding_chunks (
    revision_id,
    embedding_model,
    chunk_index,
    id
  );

CREATE INDEX content_embedding_chunks_cosine_hnsw_idx
  ON platform.content_embedding_chunks
  USING hnsw (embedding public.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

COMMENT ON TABLE platform.content_embedding_chunks IS
  'Immutable Titan Text Embeddings v2 512-dimension chunks with database-owned snapshot identity. Plaintext is not duplicated; result hydration uses the visible live or cursor-snapshot Revision.';

COMMENT ON COLUMN platform.content_embedding_chunks.source_text_hash IS
  'SHA-256 of the exact service-derived chunk input; it is integrity metadata, not searchable text.';

COMMENT ON COLUMN platform.content_embedding_chunks.search_index_created_xid IS
  'Database-owned creating xid. Signed search cursors use pg_visible_in_snapshot with index_as_of so in-flight embedding commits cannot enter a later page.';

CREATE FUNCTION platform.prevent_content_embedding_chunk_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'content_embedding_chunks'
    OR TG_OP NOT IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION
      'Embedding chunk immutability trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  RAISE EXCEPTION
    'Content embedding chunks are immutable; use a new model identity'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER content_embedding_chunks_prevent_mutation
BEFORE UPDATE OR DELETE ON platform.content_embedding_chunks
FOR EACH ROW
EXECUTE FUNCTION platform.prevent_content_embedding_chunk_mutation();

REVOKE ALL ON FUNCTION platform.prevent_content_embedding_chunk_mutation()
FROM PUBLIC;

-- Frozen candidate snapshots ---------------------------------------------
--
-- An MVCC snapshot can freeze heap visibility, but it cannot freeze the
-- traversal path through a concurrently changing approximate HNSW graph.
-- Persist the bounded, already-ranked candidate horizon from page one and
-- serve every continuation from that immutable list. The payload contains no
-- query text, snippets, source metadata, or account data.
CREATE TABLE system.content_search_candidate_snapshots (
  snapshot_id text PRIMARY KEY,
  binding_hmac bytea NOT NULL,
  candidates jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT content_search_candidate_snapshots_id
    CHECK (snapshot_id ~ '^css_[0-9a-f]{32}$'),
  CONSTRAINT content_search_candidate_snapshots_binding
    CHECK (octet_length(binding_hmac) = 32),
  CONSTRAINT content_search_candidate_snapshots_candidates
    CHECK (
      jsonb_typeof(candidates) = 'array'
      AND jsonb_array_length(candidates) BETWEEN 0 AND 500
      AND pg_column_size(candidates) <= 524288
    ),
  CONSTRAINT content_search_candidate_snapshots_retention
    CHECK (
      expires_at > created_at
      AND expires_at <= created_at + interval '1 hour'
    )
);

CREATE INDEX content_search_candidate_snapshots_expiry_idx
  ON system.content_search_candidate_snapshots (expires_at, snapshot_id);

COMMENT ON TABLE system.content_search_candidate_snapshots IS
  'Short-lived immutable Search ranking horizons. Candidate JSON contains only content/revision IDs, timestamps, scores, and matched-field labels; query text and hydrated content are forbidden.';

CREATE FUNCTION system.store_content_search_candidate_snapshot(
  candidate_snapshot_id text,
  candidate_binding_hmac bytea,
  candidate_candidates jsonb,
  candidate_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  normalized_candidates jsonb;
  stored boolean;
BEGIN
  IF candidate_snapshot_id IS NULL
    OR candidate_snapshot_id !~ '^css_[0-9a-f]{32}$'
    OR candidate_binding_hmac IS NULL
    OR octet_length(candidate_binding_hmac) <> 32
    OR candidate_candidates IS NULL
    OR jsonb_typeof(candidate_candidates) <> 'array'
    OR jsonb_array_length(candidate_candidates) NOT BETWEEN 0 AND 500
    OR pg_column_size(candidate_candidates) > 524288
    OR candidate_expires_at IS NULL
    OR candidate_expires_at <= statement_timestamp()
    OR candidate_expires_at > statement_timestamp() + interval '1 hour' THEN
    RAISE EXCEPTION 'Invalid Content Search candidate snapshot'
      USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'content_id', item.value -> 'content_id',
        'revision_id', item.value -> 'revision_id',
        'published_at', item.value -> 'published_at',
        'score', item.value -> 'score',
        'matched_fields', item.value -> 'matched_fields'
      )
      ORDER BY item.position
    ),
    '[]'::jsonb
  )
  INTO normalized_candidates
  FROM jsonb_array_elements(candidate_candidates)
    WITH ORDINALITY AS item(value, position);

  IF pg_column_size(normalized_candidates) > 524288
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(normalized_candidates) AS item(value)
      WHERE jsonb_typeof(item.value -> 'content_id') IS DISTINCT FROM 'string'
        OR (item.value ->> 'content_id')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR jsonb_typeof(item.value -> 'revision_id') IS DISTINCT FROM 'string'
        OR (item.value ->> 'revision_id')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR jsonb_typeof(item.value -> 'published_at') IS DISTINCT FROM 'string'
        OR (item.value ->> 'published_at')
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        OR jsonb_typeof(item.value -> 'score') IS DISTINCT FROM 'number'
        OR abs((item.value ->> 'score')::numeric) > 1000000
        OR jsonb_typeof(item.value -> 'matched_fields') IS DISTINCT FROM 'array'
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(normalized_candidates) AS item(value)
      WHERE jsonb_array_length(item.value -> 'matched_fields') NOT BETWEEN 1 AND 16
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(item.value -> 'matched_fields') AS field(value)
          WHERE jsonb_typeof(field.value) IS DISTINCT FROM 'string'
            OR length(field.value #>> '{}') NOT BETWEEN 1 AND 64
            OR (field.value #>> '{}') ~ '[[:cntrl:]]'
        )
        OR (
          SELECT count(*)
          FROM jsonb_array_elements(item.value -> 'matched_fields') AS field(value)
        ) <> (
          SELECT count(DISTINCT field.value)
          FROM jsonb_array_elements(item.value -> 'matched_fields') AS field(value)
        )
    )
    OR (
      SELECT count(DISTINCT item.value ->> 'content_id')
      FROM jsonb_array_elements(normalized_candidates) AS item(value)
    ) <> jsonb_array_length(normalized_candidates) THEN
    RAISE EXCEPTION 'Invalid Content Search candidate snapshot payload'
      USING ERRCODE = '22023';
  END IF;

  WITH expired AS (
    SELECT snapshot.snapshot_id
    FROM system.content_search_candidate_snapshots AS snapshot
    WHERE snapshot.expires_at <= statement_timestamp()
    ORDER BY snapshot.expires_at, snapshot.snapshot_id
    LIMIT 500
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM system.content_search_candidate_snapshots AS snapshot
  USING expired
  WHERE snapshot.snapshot_id = expired.snapshot_id;

  INSERT INTO system.content_search_candidate_snapshots (
    snapshot_id,
    binding_hmac,
    candidates,
    expires_at
  )
  VALUES (
    candidate_snapshot_id,
    candidate_binding_hmac,
    normalized_candidates,
    candidate_expires_at
  )
  ON CONFLICT (snapshot_id) DO NOTHING;

  SELECT EXISTS (
    SELECT 1
    FROM system.content_search_candidate_snapshots AS snapshot
    WHERE snapshot.snapshot_id = candidate_snapshot_id
      AND snapshot.binding_hmac = candidate_binding_hmac
      AND snapshot.candidates = normalized_candidates
      AND snapshot.expires_at = candidate_expires_at
  )
  INTO stored;

  IF NOT stored THEN
    RAISE EXCEPTION 'Content Search candidate snapshot identity conflict'
      USING ERRCODE = '55000';
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION system.store_content_search_candidate_snapshot(
  text,
  bytea,
  jsonb,
  timestamptz
)
FROM PUBLIC;

CREATE FUNCTION system.purge_expired_content_search_candidate_snapshots(
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
    RAISE EXCEPTION 'Invalid Content Search snapshot purge batch size'
      USING ERRCODE = '22023';
  END IF;

  WITH expired AS (
    SELECT snapshot.snapshot_id
    FROM system.content_search_candidate_snapshots AS snapshot
    WHERE snapshot.expires_at <= statement_timestamp()
    ORDER BY snapshot.expires_at, snapshot.snapshot_id
    LIMIT candidate_batch_size
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM system.content_search_candidate_snapshots AS snapshot
    USING expired
    WHERE snapshot.snapshot_id = expired.snapshot_id
    RETURNING snapshot.snapshot_id
  )
  SELECT count(*)::integer INTO deleted_count FROM deleted;

  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION
  system.purge_expired_content_search_candidate_snapshots(integer)
FROM PUBLIC;

-- Durable embedding work queue --------------------------------------------
--
-- Outbox consumers enqueue new Revisions idempotently. This migration also
-- enqueues every historical Revision at low priority. Claims use SKIP LOCKED,
-- leases are fenced by an opaque 32-byte digest, and retry/dead-letter state
-- remains durable across worker crashes.
CREATE TABLE system.content_embedding_jobs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  revision_id uuid NOT NULL
    REFERENCES platform.content_revisions(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  embedding_model text NOT NULL
    DEFAULT 'amazon.titan-embed-text-v2:0:512',
  status text NOT NULL DEFAULT 'ready',
  priority smallint NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  lease_owner text,
  lease_token_digest bytea,
  lease_expires_at timestamptz,
  last_error_code text,
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT content_embedding_jobs_revision_model_unique
    UNIQUE (revision_id, embedding_model),
  CONSTRAINT content_embedding_jobs_model
    CHECK (embedding_model = 'amazon.titan-embed-text-v2:0:512'),
  CONSTRAINT content_embedding_jobs_status
    CHECK (status IN ('ready', 'leased', 'completed', 'dead_lettered')),
  CONSTRAINT content_embedding_jobs_priority
    CHECK (priority BETWEEN -100 AND 100),
  CONSTRAINT content_embedding_jobs_attempts
    CHECK (
      attempts BETWEEN 0 AND max_attempts
      AND max_attempts BETWEEN 1 AND 100
    ),
  CONSTRAINT content_embedding_jobs_lease_shape
    CHECK (
      (
        status = 'leased'
        AND length(btrim(lease_owner)) BETWEEN 1 AND 200
        AND lease_owner !~ '[[:cntrl:]]'
        AND octet_length(lease_token_digest) = 32
        AND lease_expires_at IS NOT NULL
      )
      OR (
        status <> 'leased'
        AND lease_owner IS NULL
        AND lease_token_digest IS NULL
        AND lease_expires_at IS NULL
      )
    ),
  CONSTRAINT content_embedding_jobs_error_code
    CHECK (
      last_error_code IS NULL
      OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'
    ),
  CONSTRAINT content_embedding_jobs_terminal_shape
    CHECK (
      (status IN ('ready', 'leased')
        AND completed_at IS NULL
        AND failed_at IS NULL)
      OR (status = 'completed'
        AND completed_at IS NOT NULL
        AND failed_at IS NULL
        AND last_error_code IS NULL)
      OR (status = 'dead_lettered'
        AND completed_at IS NULL
        AND failed_at IS NOT NULL
        AND last_error_code IS NOT NULL)
    ),
  CONSTRAINT content_embedding_jobs_time_order
    CHECK (
      updated_at >= created_at
      AND available_at >= created_at
      AND (lease_expires_at IS NULL OR lease_expires_at > created_at)
      AND (completed_at IS NULL OR completed_at >= created_at)
      AND (failed_at IS NULL OR failed_at >= created_at)
    )
);

CREATE INDEX content_embedding_jobs_claim_idx
  ON system.content_embedding_jobs (
    priority DESC,
    available_at,
    created_at,
    id
  )
  WHERE status = 'ready';

CREATE INDEX content_embedding_jobs_expired_lease_idx
  ON system.content_embedding_jobs (lease_expires_at, id)
  WHERE status = 'leased';

CREATE INDEX content_embedding_jobs_revision_idx
  ON system.content_embedding_jobs (revision_id, embedding_model, status, id);

-- Coverage is driven from outstanding work rather than a global Revision
-- anti-join. Completed jobs leave this compact partial index immediately.
CREATE INDEX content_embedding_jobs_revision_incomplete_idx
  ON system.content_embedding_jobs (revision_id)
  WHERE status <> 'completed';

COMMENT ON TABLE system.content_embedding_jobs IS
  'Durable concurrent claim/retry/lease state shared by the Search Outbox consumer and bounded historical backfills.';

COMMENT ON COLUMN system.content_embedding_jobs.last_error_code IS
  'Controlled operational reason code only. Provider errors, prompts, UGC, and credentials must never be persisted here.';

CREATE FUNCTION system.prepare_content_embedding_job_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  has_chunk boolean;
BEGIN
  IF TG_TABLE_SCHEMA <> 'system'
    OR TG_TABLE_NAME <> 'content_embedding_jobs'
    OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
    RAISE EXCEPTION
      'Embedding job trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Content embedding jobs are durable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ready'
      OR NEW.attempts <> 0
      OR NEW.lease_owner IS NOT NULL
      OR NEW.lease_token_digest IS NOT NULL
      OR NEW.lease_expires_at IS NOT NULL
      OR NEW.last_error_code IS NOT NULL
      OR NEW.completed_at IS NOT NULL
      OR NEW.failed_at IS NOT NULL THEN
      RAISE EXCEPTION
        'A new Content embedding job must start ready and unclaimed'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
    OR NEW.embedding_model IS DISTINCT FROM OLD.embedding_model
    OR NEW.priority IS DISTINCT FROM OLD.priority
    OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Content embedding job identity and retry policy are immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION
      'Terminal Content embedding jobs are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'dead_lettered' AND NEW.status = 'ready' THEN
    IF NEW.attempts <> 0
      OR NEW.available_at < statement_timestamp()
      OR NEW.lease_owner IS NOT NULL
      OR NEW.lease_token_digest IS NOT NULL
      OR NEW.lease_expires_at IS NOT NULL
      OR NEW.last_error_code IS NOT NULL
      OR NEW.completed_at IS NOT NULL
      OR NEW.failed_at IS NOT NULL THEN
      RAISE EXCEPTION
        'Content embedding dead-letter redrive is invalid'
        USING ERRCODE = '40001';
    END IF;
  ELSIF OLD.status = 'dead_lettered' THEN
    RAISE EXCEPTION
      'Dead-lettered Content embedding jobs require controlled redrive'
      USING ERRCODE = '55000';
  ELSIF OLD.status = 'ready' AND NEW.status = 'leased' THEN
    IF OLD.available_at > statement_timestamp()
      OR OLD.attempts >= OLD.max_attempts
      OR NEW.attempts <> OLD.attempts + 1
      OR NEW.available_at IS DISTINCT FROM OLD.available_at
      OR NEW.last_error_code IS NOT NULL
      OR NEW.lease_expires_at <= statement_timestamp() THEN
      RAISE EXCEPTION
        'Ready Content embedding job claim is invalid'
        USING ERRCODE = '40001';
    END IF;
  ELSIF OLD.status = 'leased' AND NEW.status = 'leased' THEN
    IF NEW.attempts = OLD.attempts THEN
      IF NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
        OR NEW.lease_token_digest IS DISTINCT FROM OLD.lease_token_digest
        OR NEW.lease_expires_at <= OLD.lease_expires_at
        OR NEW.available_at IS DISTINCT FROM OLD.available_at
        OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code THEN
        RAISE EXCEPTION
          'Content embedding lease renewal is invalid'
          USING ERRCODE = '40001';
      END IF;
    ELSIF NEW.attempts = OLD.attempts + 1 THEN
      IF OLD.lease_expires_at > statement_timestamp()
        OR OLD.attempts >= OLD.max_attempts
        OR NEW.lease_expires_at <= statement_timestamp()
        OR NEW.available_at IS DISTINCT FROM OLD.available_at
        OR NEW.last_error_code IS NOT NULL THEN
        RAISE EXCEPTION
          'Expired Content embedding lease reclaim is invalid'
          USING ERRCODE = '40001';
      END IF;
    ELSE
      RAISE EXCEPTION
        'Content embedding attempts must advance exactly once per claim'
        USING ERRCODE = '40001';
    END IF;
  ELSIF OLD.status = 'leased' AND NEW.status = 'ready' THEN
    IF NEW.attempts <> OLD.attempts
      OR NEW.attempts >= NEW.max_attempts
      OR NEW.available_at < statement_timestamp()
      OR NEW.last_error_code IS NULL THEN
      RAISE EXCEPTION
        'Content embedding retry transition is invalid'
        USING ERRCODE = '40001';
    END IF;
  ELSIF OLD.status = 'leased' AND NEW.status = 'completed' THEN
    IF NEW.attempts <> OLD.attempts
      OR NEW.completed_at IS NULL
      OR NEW.last_error_code IS NOT NULL THEN
      RAISE EXCEPTION
        'Content embedding completion transition is invalid'
        USING ERRCODE = '40001';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM platform.content_embedding_chunks AS chunk
      WHERE chunk.revision_id = NEW.revision_id
        AND chunk.embedding_model = NEW.embedding_model
    )
    INTO has_chunk;

    IF NOT has_chunk THEN
      RAISE EXCEPTION
        'Content embedding completion requires at least one stored chunk'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status IN ('ready', 'leased')
    AND NEW.status = 'dead_lettered' THEN
    IF NEW.attempts <> OLD.attempts
      OR (
        NEW.attempts <> NEW.max_attempts
        AND NEW.last_error_code !~ '^NONRETRYABLE_'
      )
      OR NEW.failed_at IS NULL
      OR NEW.last_error_code IS NULL THEN
      RAISE EXCEPTION
        'Content embedding dead-letter transition is invalid'
        USING ERRCODE = '40001';
    END IF;
  ELSE
    RAISE EXCEPTION
      'Unsupported Content embedding job transition'
      USING ERRCODE = '40001';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_embedding_jobs_prepare_write
BEFORE INSERT OR UPDATE OR DELETE ON system.content_embedding_jobs
FOR EACH ROW
EXECUTE FUNCTION system.prepare_content_embedding_job_update();

REVOKE ALL ON FUNCTION system.prepare_content_embedding_job_update()
FROM PUBLIC;

CREATE FUNCTION system.enqueue_content_embedding_job(
  candidate_revision_id uuid,
  candidate_embedding_model text DEFAULT 'amazon.titan-embed-text-v2:0:512',
  candidate_priority smallint DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  result_id uuid;
BEGIN
  IF candidate_revision_id IS NULL
    OR candidate_embedding_model IS DISTINCT FROM
      'amazon.titan-embed-text-v2:0:512'
    OR candidate_priority IS NULL
    OR candidate_priority NOT BETWEEN -100 AND 100 THEN
    RAISE EXCEPTION
      'Unsupported Content embedding model or priority'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO system.content_embedding_jobs (
    revision_id,
    embedding_model,
    priority
  )
  VALUES (
    candidate_revision_id,
    candidate_embedding_model,
    candidate_priority
  )
  ON CONFLICT (revision_id, embedding_model) DO NOTHING
  RETURNING id INTO result_id;

  IF result_id IS NULL THEN
    SELECT job.id
    INTO STRICT result_id
    FROM system.content_embedding_jobs AS job
    WHERE job.revision_id = candidate_revision_id
      AND job.embedding_model = candidate_embedding_model;
  END IF;

  RETURN result_id;
END;
$$;

REVOKE ALL ON FUNCTION system.enqueue_content_embedding_job(uuid, text, smallint)
FROM PUBLIC;

-- Every immutable Revision creates its semantic-index work in the same
-- transaction. Outbox enqueue remains an idempotent wake-up/priority path, not
-- the durability boundary for index coverage.
CREATE FUNCTION system.enqueue_content_embedding_job_from_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'content_revisions'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Revision embedding enqueue trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO system.content_embedding_jobs (
    revision_id,
    embedding_model,
    priority
  )
  VALUES (
    NEW.id,
    'amazon.titan-embed-text-v2:0:512',
    100
  )
  ON CONFLICT (revision_id, embedding_model) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER content_revisions_enqueue_embedding_job
AFTER INSERT ON platform.content_revisions
FOR EACH ROW
EXECUTE FUNCTION system.enqueue_content_embedding_job_from_revision();

REVOKE ALL ON FUNCTION system.enqueue_content_embedding_job_from_revision()
FROM PUBLIC;

CREATE FUNCTION system.claim_content_embedding_jobs(
  candidate_lease_owner text,
  candidate_lease_token_digest bytea,
  candidate_batch_size integer DEFAULT 1,
  candidate_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (
  job_id uuid,
  revision_id uuid,
  embedding_model text,
  attempt_number integer,
  max_attempts integer,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF candidate_lease_owner IS NULL
    OR length(btrim(candidate_lease_owner)) NOT BETWEEN 1 AND 200
    OR candidate_lease_owner ~ '[[:cntrl:]]'
    OR candidate_lease_token_digest IS NULL
    OR octet_length(candidate_lease_token_digest) <> 32
    OR candidate_batch_size IS NULL
    -- One lease token fences exactly one job. Workers obtain a batch by
    -- calling this SKIP LOCKED claim repeatedly with a fresh token per call.
    OR candidate_batch_size <> 1
    OR candidate_lease_seconds IS NULL
    OR candidate_lease_seconds NOT BETWEEN 15 AND 900 THEN
    RAISE EXCEPTION
      'Invalid Content embedding claim parameters'
      USING ERRCODE = '22023';
  END IF;

  WITH expired_final AS (
    SELECT job.id
    FROM system.content_embedding_jobs AS job
    WHERE job.status = 'leased'
      AND job.lease_expires_at <= statement_timestamp()
      AND job.attempts = job.max_attempts
    ORDER BY job.lease_expires_at, job.id
    FOR UPDATE SKIP LOCKED
    LIMIT 100
  )
  UPDATE system.content_embedding_jobs AS exhausted
  SET status = 'dead_lettered',
      lease_owner = NULL,
      lease_token_digest = NULL,
      lease_expires_at = NULL,
      last_error_code = 'LEASE_EXPIRED_AFTER_FINAL_ATTEMPT',
      failed_at = statement_timestamp()
  FROM expired_final
  WHERE exhausted.id = expired_final.id;

  RETURN QUERY
  WITH candidates AS (
    SELECT job.id
    FROM system.content_embedding_jobs AS job
    WHERE job.attempts < job.max_attempts
      AND (
        (job.status = 'ready'
          AND job.available_at <= statement_timestamp())
        OR (job.status = 'leased'
          AND job.lease_expires_at <= statement_timestamp())
      )
    ORDER BY job.priority DESC, job.available_at, job.created_at, job.id
    FOR UPDATE SKIP LOCKED
    LIMIT candidate_batch_size
  ), claimed AS (
    UPDATE system.content_embedding_jobs AS job
    SET status = 'leased',
        attempts = job.attempts + 1,
        lease_owner = candidate_lease_owner,
        lease_token_digest = candidate_lease_token_digest,
        lease_expires_at = statement_timestamp()
          + make_interval(secs => candidate_lease_seconds),
        last_error_code = NULL
    FROM candidates
    WHERE job.id = candidates.id
    RETURNING
      job.id,
      job.revision_id,
      job.embedding_model,
      job.attempts,
      job.max_attempts,
      job.lease_expires_at
  )
  SELECT
    claimed.id,
    claimed.revision_id,
    claimed.embedding_model,
    claimed.attempts,
    claimed.max_attempts,
    claimed.lease_expires_at
  FROM claimed
  ORDER BY claimed.id;
END;
$$;

REVOKE ALL ON FUNCTION
  system.claim_content_embedding_jobs(text, bytea, integer, integer)
FROM PUBLIC;

CREATE FUNCTION system.renew_content_embedding_job_lease(
  candidate_job_id uuid,
  candidate_lease_owner text,
  candidate_lease_token_digest bytea,
  candidate_lease_seconds integer DEFAULT 60
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  renewed_until timestamptz;
BEGIN
  IF candidate_job_id IS NULL
    OR candidate_lease_owner IS NULL
    OR length(btrim(candidate_lease_owner)) NOT BETWEEN 1 AND 200
    OR candidate_lease_owner ~ '[[:cntrl:]]'
    OR candidate_lease_token_digest IS NULL
    OR octet_length(candidate_lease_token_digest) <> 32
    OR candidate_lease_seconds IS NULL
    OR candidate_lease_seconds NOT BETWEEN 15 AND 900 THEN
    RAISE EXCEPTION
      'Invalid Content embedding lease renewal parameters'
      USING ERRCODE = '22023';
  END IF;

  UPDATE system.content_embedding_jobs AS job
  SET lease_expires_at = statement_timestamp()
    + make_interval(secs => candidate_lease_seconds)
  WHERE job.id = candidate_job_id
    AND job.status = 'leased'
    AND job.lease_owner = candidate_lease_owner
    AND job.lease_token_digest = candidate_lease_token_digest
    AND job.lease_expires_at > statement_timestamp()
  RETURNING job.lease_expires_at INTO renewed_until;

  RETURN renewed_until;
END;
$$;

REVOKE ALL ON FUNCTION
  system.renew_content_embedding_job_lease(uuid, text, bytea, integer)
FROM PUBLIC;

CREATE FUNCTION system.complete_content_embedding_job(
  candidate_job_id uuid,
  candidate_lease_owner text,
  candidate_lease_token_digest bytea
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  changed_rows bigint;
BEGIN
  UPDATE system.content_embedding_jobs AS job
  SET status = 'completed',
      lease_owner = NULL,
      lease_token_digest = NULL,
      lease_expires_at = NULL,
      last_error_code = NULL,
      completed_at = statement_timestamp()
  WHERE job.id = candidate_job_id
    AND job.status = 'leased'
    AND job.lease_owner = candidate_lease_owner
    AND job.lease_token_digest = candidate_lease_token_digest
    AND job.lease_expires_at > statement_timestamp();

  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  RETURN changed_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION
  system.complete_content_embedding_job(uuid, text, bytea)
FROM PUBLIC;

CREATE FUNCTION system.retry_content_embedding_job(
  candidate_job_id uuid,
  candidate_lease_owner text,
  candidate_lease_token_digest bytea,
  candidate_error_code text,
  candidate_retry_seconds integer DEFAULT 30
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  next_status text;
BEGIN
  IF candidate_job_id IS NULL
    OR candidate_lease_owner IS NULL
    OR length(btrim(candidate_lease_owner)) NOT BETWEEN 1 AND 200
    OR candidate_lease_owner ~ '[[:cntrl:]]'
    OR candidate_lease_token_digest IS NULL
    OR octet_length(candidate_lease_token_digest) <> 32
    OR candidate_error_code IS NULL
    OR candidate_error_code !~ '^[A-Z][A-Z0-9_]{0,119}$'
    OR candidate_retry_seconds IS NULL
    OR candidate_retry_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION
      'Invalid Content embedding retry parameters'
      USING ERRCODE = '22023';
  END IF;

  UPDATE system.content_embedding_jobs AS job
  SET status = CASE
        WHEN job.attempts = job.max_attempts
          OR candidate_error_code ~ '^NONRETRYABLE_'
          THEN 'dead_lettered'
        ELSE 'ready'
      END,
      available_at = CASE
        WHEN job.attempts = job.max_attempts
          OR candidate_error_code ~ '^NONRETRYABLE_'
          THEN job.available_at
        ELSE statement_timestamp()
          + make_interval(secs => candidate_retry_seconds)
      END,
      lease_owner = NULL,
      lease_token_digest = NULL,
      lease_expires_at = NULL,
      last_error_code = candidate_error_code,
      failed_at = CASE
        WHEN job.attempts = job.max_attempts
          OR candidate_error_code ~ '^NONRETRYABLE_'
          THEN statement_timestamp()
        ELSE NULL
      END
  WHERE job.id = candidate_job_id
    AND job.status = 'leased'
    AND job.lease_owner = candidate_lease_owner
    AND job.lease_token_digest = candidate_lease_token_digest
    AND job.lease_expires_at > statement_timestamp()
  RETURNING job.status INTO next_status;

  RETURN next_status;
END;
$$;

REVOKE ALL ON FUNCTION
  system.retry_content_embedding_job(uuid, text, bytea, text, integer)
FROM PUBLIC;

CREATE FUNCTION system.redrive_content_embedding_job(
  candidate_job_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  changed_rows bigint;
BEGIN
  IF candidate_job_id IS NULL THEN
    RAISE EXCEPTION
      'Invalid Content embedding redrive parameters'
      USING ERRCODE = '22023';
  END IF;

  UPDATE system.content_embedding_jobs AS job
  SET status = 'ready',
      attempts = 0,
      available_at = statement_timestamp(),
      lease_owner = NULL,
      lease_token_digest = NULL,
      lease_expires_at = NULL,
      last_error_code = NULL,
      completed_at = NULL,
      failed_at = NULL
  WHERE job.id = candidate_job_id
    AND job.status = 'dead_lettered';

  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  RETURN changed_rows = 1;
END;
$$;

-- Intentionally absent from Runtime's function allowlist. The migration/ops
-- identity uses this after inspecting and repairing a dead-letter cause.
REVOKE ALL ON FUNCTION system.redrive_content_embedding_job(uuid)
FROM PUBLIC;

INSERT INTO system.content_embedding_jobs (
  revision_id,
  embedding_model,
  priority
)
SELECT
  revision.id,
  'amazon.titan-embed-text-v2:0:512',
  -100
FROM platform.content_revisions AS revision
ON CONFLICT (revision_id, embedding_model) DO NOTHING;

-- Agent Search ActivityEvents ---------------------------------------------
--
-- A started row is the atomic rate-limit reservation. The service holds the
-- per-Actor search advisory lock while counting and inserting it, then may
-- finalize only outcome/result/latency/fallback once. Query plaintext and UGC
-- have no column in this table.
CREATE TABLE platform.agent_search_activity_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  request_id text NOT NULL,
  agent_id uuid NOT NULL
    REFERENCES platform.agents(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  actor_id uuid NOT NULL
    REFERENCES platform.agents(actor_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  credential_id uuid NOT NULL
    REFERENCES platform.credentials(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  query_hmac bytea NOT NULL,
  query_key_version smallint NOT NULL,
  surface text NOT NULL,
  search_mode text NOT NULL,
  community_id uuid
    REFERENCES platform.communities(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  symbol_id uuid
    REFERENCES platform.symbols(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  topic_id uuid
    REFERENCES platform.topics(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  outcome text NOT NULL DEFAULT 'started',
  result_count integer,
  latency_ms integer,
  fallback_reason_code text,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  finalized_at timestamptz,
  expires_at timestamptz NOT NULL
    DEFAULT (statement_timestamp() + interval '30 days'),
  CONSTRAINT agent_search_activity_events_actor_request_unique
    UNIQUE (actor_id, request_id),
  CONSTRAINT agent_search_activity_events_request_id
    CHECK (
      request_id ~ '^req[-_][A-Za-z0-9][A-Za-z0-9_-]{0,59}$'
      OR request_id ~ '^[0-9A-Fa-f]{32}$'
      OR request_id ~
        '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89AaBb][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$'
    ),
  CONSTRAINT agent_search_activity_events_query_hmac
    CHECK (octet_length(query_hmac) = 32),
  CONSTRAINT agent_search_activity_events_query_key_version
    CHECK (query_key_version > 0),
  CONSTRAINT agent_search_activity_events_surface
    CHECK (surface IN ('rest', 'mcp', 'sdk', 'web')),
  CONSTRAINT agent_search_activity_events_mode
    CHECK (search_mode IN ('lexical', 'semantic', 'hybrid')),
  CONSTRAINT agent_search_activity_events_outcome
    CHECK (outcome IN ('started', 'succeeded', 'failed')),
  CONSTRAINT agent_search_activity_events_result_count
    CHECK (result_count IS NULL OR result_count BETWEEN 0 AND 1000),
  CONSTRAINT agent_search_activity_events_latency
    CHECK (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 300000),
  CONSTRAINT agent_search_activity_events_fallback_reason
    CHECK (
      fallback_reason_code IS NULL
      OR fallback_reason_code ~ '^[A-Z][A-Z0-9_]{0,119}$'
    ),
  CONSTRAINT agent_search_activity_events_state_shape
    CHECK (
      (
        outcome = 'started'
        AND result_count IS NULL
        AND latency_ms IS NULL
        AND fallback_reason_code IS NULL
        AND finalized_at IS NULL
      )
      OR (
        outcome = 'succeeded'
        AND result_count IS NOT NULL
        AND latency_ms IS NOT NULL
        AND finalized_at IS NOT NULL
      )
      OR (
        outcome = 'failed'
        AND latency_ms IS NOT NULL
        AND finalized_at IS NOT NULL
      )
    ),
  CONSTRAINT agent_search_activity_events_retention
    CHECK (expires_at = occurred_at + interval '30 days'),
  CONSTRAINT agent_search_activity_events_time_order
    CHECK (
      (finalized_at IS NULL OR finalized_at >= occurred_at)
      AND (finalized_at IS NULL OR finalized_at <= expires_at)
    )
);

CREATE INDEX agent_search_activity_events_actor_occurred_idx
  ON platform.agent_search_activity_events (actor_id, occurred_at DESC, id);

CREATE INDEX agent_search_activity_events_expiry_idx
  ON platform.agent_search_activity_events (expires_at, id);

CREATE INDEX agent_search_activity_events_started_idx
  ON platform.agent_search_activity_events (occurred_at, id)
  WHERE outcome = 'started';

COMMENT ON TABLE platform.agent_search_activity_events IS
  'Thirty-day Agent Search admission/finalization events. Stores only keyed query HMAC and bounded safe metadata; never raw query text, results, prompts, UGC, or credentials.';

COMMENT ON COLUMN platform.agent_search_activity_events.query_hmac IS
  'HMAC-SHA-256 produced with an application-held versioned key. The key and raw query are never stored in PostgreSQL.';

CREATE FUNCTION platform.prepare_agent_search_activity_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'platform'
    OR TG_TABLE_NAME <> 'agent_search_activity_events'
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION
      'Agent Search ActivityEvent trigger invoked outside its binding'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.outcome <> 'started'
      OR NEW.result_count IS NOT NULL
      OR NEW.latency_ms IS NOT NULL
      OR NEW.fallback_reason_code IS NOT NULL
      OR NEW.finalized_at IS NOT NULL THEN
      RAISE EXCEPTION
        'Agent Search ActivityEvent must begin as a reservation'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM platform.agents AS agent
      JOIN platform.credentials AS credential
        ON credential.agent_id = agent.id
      WHERE agent.id = NEW.agent_id
        AND agent.actor_id = NEW.actor_id
        AND credential.id = NEW.credential_id
    ) THEN
      RAISE EXCEPTION
        'Agent Search ActivityEvent authority chain is inconsistent'
        USING ERRCODE = '23514';
    END IF;

    NEW.occurred_at := statement_timestamp();
    NEW.expires_at := NEW.occurred_at + interval '30 days';
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
    OR NEW.query_hmac IS DISTINCT FROM OLD.query_hmac
    OR NEW.query_key_version IS DISTINCT FROM OLD.query_key_version
    OR NEW.surface IS DISTINCT FROM OLD.surface
    OR NEW.search_mode IS DISTINCT FROM OLD.search_mode
    OR NEW.community_id IS DISTINCT FROM OLD.community_id
    OR NEW.symbol_id IS DISTINCT FROM OLD.symbol_id
    OR NEW.topic_id IS DISTINCT FROM OLD.topic_id
    OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION
      'Agent Search ActivityEvent admission identity is immutable'
      USING ERRCODE = '22023';
  END IF;

  IF OLD.outcome <> 'started'
    OR NEW.outcome NOT IN ('succeeded', 'failed')
    OR NEW.outcome IS NOT DISTINCT FROM OLD.outcome
    OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
    RAISE EXCEPTION
      'Agent Search ActivityEvent can be finalized exactly once'
      USING ERRCODE = '55000';
  END IF;

  NEW.finalized_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_search_activity_events_prepare_write
BEFORE INSERT OR UPDATE ON platform.agent_search_activity_events
FOR EACH ROW
EXECUTE FUNCTION platform.prepare_agent_search_activity_event();

REVOKE ALL ON FUNCTION platform.prepare_agent_search_activity_event()
FROM PUBLIC;

CREATE FUNCTION platform.purge_expired_agent_search_activity_events(
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
    RAISE EXCEPTION
      'Invalid Agent Search ActivityEvent purge batch size'
      USING ERRCODE = '22023';
  END IF;

  WITH expired AS (
    SELECT event.id
    FROM platform.agent_search_activity_events AS event
    WHERE event.expires_at <= statement_timestamp()
    ORDER BY event.expires_at, event.id
    FOR UPDATE SKIP LOCKED
    LIMIT candidate_batch_size
  ), deleted AS (
    DELETE FROM platform.agent_search_activity_events AS event
    USING expired
    WHERE event.id = expired.id
    RETURNING event.id
  )
  SELECT count(*)::integer INTO deleted_count
  FROM deleted;

  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION
  platform.purge_expired_agent_search_activity_events(integer)
FROM PUBLIC;
