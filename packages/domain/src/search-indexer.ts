import { createHash, randomBytes } from "node:crypto";

import type { OutboxEvent, PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import {
  EmbeddingProviderError,
  embeddingSourceHash,
  TITAN_TEXT_EMBED_V2_INDEX_MODEL,
  type TextEmbeddingProvider,
} from "./bedrock-embedding.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SUPPORTED_CONTENT_EVENTS = new Set([
  "content.published",
  "content.reply",
  "content.revised",
]);
const DEFAULT_CHUNK_CODE_POINTS = 6_000;
const DEFAULT_CHUNK_OVERLAP_CODE_POINTS = 300;
const DEFAULT_LEASE_MILLISECONDS = 60_000;
const DEFAULT_PROVIDER_TIMEOUT_MILLISECONDS = 5_000;
const LEASE_DATABASE_MARGIN_MILLISECONDS = 5_000;
const MAXIMUM_CHUNKS_PER_REVISION = 32;

type TransactionSql = postgres.TransactionSql;

export type SearchIndexErrorCode =
  | "INDEX_DATA_INVALID"
  | "INDEX_NOT_READY"
  | "INVALID_ARGUMENT"
  | "LEASE_LOST"
  | "PROVIDER_ABORTED"
  | "PROVIDER_INVALID_RESPONSE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "STORAGE_UNAVAILABLE";

export class SearchIndexError extends Error {
  readonly code: SearchIndexErrorCode;
  readonly retryable: boolean;

  constructor(code: SearchIndexErrorCode, options: { cause?: unknown } = {}) {
    super(indexErrorMessage(code), options);
    this.name = "SearchIndexError";
    this.code = code;
    this.retryable =
      code === "LEASE_LOST" ||
      code === "PROVIDER_ABORTED" ||
      code === "PROVIDER_TIMEOUT" ||
      code === "PROVIDER_UNAVAILABLE" ||
      code === "STORAGE_UNAVAILABLE";
  }
}

export interface SearchDocumentChunk {
  chunkIndex: number;
  endOffset: number;
  startOffset: number;
  text: string;
  tokenCount: number;
}

export interface SearchIndexJobLease {
  attempts: number;
  embeddingModel: string;
  jobId: string;
  leaseExpiresAt: Date;
  leaseOwner: string;
  leaseToken: string;
  maxAttempts: number;
  revisionId: string;
}

export interface SearchIndexerOptions {
  chunkCodePoints?: number | undefined;
  chunkOverlapCodePoints?: number | undefined;
  embeddingModel?: string | undefined;
  leaseMilliseconds?: number | undefined;
  providerTimeoutMilliseconds?: number | undefined;
  queryTimeoutMilliseconds?: number | undefined;
  tokenFactory?: (() => Buffer) | undefined;
}

export interface SearchIndexerRunResult {
  claimed: number;
  completed: number;
  failed: number;
}

export interface SearchIndexQueueMetrics {
  deadLetteredCount: number;
  expiredLeaseCount: number;
  leasedCount: number;
  oldestReadyAgeSeconds: number;
  readyCount: number;
}

interface ClaimedJobRow {
  attempts: number;
  embedding_model: string;
  id: string;
  lease_expires_at: Date;
  max_attempts: number;
  revision_id: string;
}

interface RevisionRow {
  body_plain_text: string;
  id: string;
  title: string | null;
}

interface ReadyRow {
  ready: boolean;
}

interface QueueMetricsRow {
  dead_lettered_count: number;
  expired_lease_count: number;
  leased_count: number;
  oldest_ready_age_seconds: number;
  ready_count: number;
}

export class SearchIndexer {
  readonly #chunkCodePoints: number;
  readonly #chunkOverlapCodePoints: number;
  readonly #embeddingModel: string;
  readonly #leaseMilliseconds: number;
  readonly #provider: TextEmbeddingProvider;
  readonly #queryTimeoutMilliseconds: number;
  readonly #sql: PostgresClient;
  readonly #tokenFactory: () => Buffer;

  constructor(
    sql: PostgresClient,
    provider: TextEmbeddingProvider,
    options: SearchIndexerOptions = {},
  ) {
    if (!sql || typeof provider?.embed !== "function") {
      throw new TypeError("SearchIndexer requires PostgreSQL and an embedding provider.");
    }
    const chunkCodePoints = options.chunkCodePoints ?? DEFAULT_CHUNK_CODE_POINTS;
    const overlap = options.chunkOverlapCodePoints ?? DEFAULT_CHUNK_OVERLAP_CODE_POINTS;
    const lease = options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
    const providerTimeout =
      options.providerTimeoutMilliseconds ?? DEFAULT_PROVIDER_TIMEOUT_MILLISECONDS;
    const timeout = options.queryTimeoutMilliseconds ?? 3_000;
    if (
      !Number.isInteger(chunkCodePoints) ||
      chunkCodePoints < 4_000 ||
      chunkCodePoints > 20_000
    ) {
      throw new RangeError(
        "Search chunks must contain between 4000 and 20000 code points.",
      );
    }
    if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkCodePoints / 2) {
      throw new RangeError(
        "Search chunk overlap must be nonnegative and below half a chunk.",
      );
    }
    if (!Number.isInteger(lease) || lease < 15_000 || lease > 15 * 60_000) {
      throw new RangeError(
        "Search index leases must be between 15 seconds and 15 minutes.",
      );
    }
    if (
      !Number.isInteger(providerTimeout) ||
      providerTimeout < 100 ||
      providerTimeout > 30_000
    ) {
      throw new RangeError(
        "Search embedding provider timeouts must be between 100 and 30000 ms.",
      );
    }
    if (lease <= providerTimeout + LEASE_DATABASE_MARGIN_MILLISECONDS) {
      throw new RangeError(
        "Search index leases must exceed the embedding timeout plus the database completion margin.",
      );
    }
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 10_000) {
      throw new RangeError("Search index SQL timeout must be between 100 and 10000 ms.");
    }
    const embeddingModel = options.embeddingModel ?? provider.indexModel;
    if (
      typeof embeddingModel !== "string" ||
      embeddingModel !== TITAN_TEXT_EMBED_V2_INDEX_MODEL ||
      provider.indexModel !== TITAN_TEXT_EMBED_V2_INDEX_MODEL
    ) {
      throw new TypeError("The index model must exactly match the embedding provider.");
    }
    if (provider.dimensions !== 512) {
      throw new TypeError("AlphaNet Search v1 only accepts 512-dimensional providers.");
    }
    this.#sql = sql;
    this.#provider = provider;
    this.#chunkCodePoints = chunkCodePoints;
    this.#chunkOverlapCodePoints = overlap;
    this.#leaseMilliseconds = lease;
    this.#queryTimeoutMilliseconds = timeout;
    this.#embeddingModel = embeddingModel;
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32));
  }

  async checkReady(): Promise<void> {
    const rows = await this.#sql<ReadyRow[]>`
      select
        to_regclass('platform.content_embedding_chunks') is not null
        and to_regclass('system.content_embedding_jobs') is not null
        and to_regclass('platform.content_revisions') is not null
        and to_regclass('platform.content_items_current_revision_idx') is not null
        and to_regclass('system.content_embedding_jobs_revision_incomplete_idx')
          is not null
        and to_regclass('platform.agent_search_activity_events_started_idx') is not null
        and ${this.#embeddingModel} = 'amazon.titan-embed-text-v2:0:512'
        and exists (
          select 1
          from pg_catalog.pg_constraint as model_constraint
          where model_constraint.conrelid =
              'system.content_embedding_jobs'::regclass
            and model_constraint.conname = 'content_embedding_jobs_model'
            and model_constraint.convalidated
            and position(
              'amazon.titan-embed-text-v2:0:512'
              in pg_catalog.pg_get_constraintdef(model_constraint.oid)
            ) > 0
        )
        and exists (
          select 1
          from pg_catalog.pg_trigger as revision_trigger
          where revision_trigger.tgrelid =
              'platform.content_revisions'::regclass
            and revision_trigger.tgname =
              'content_revisions_enqueue_embedding_job'
            and not revision_trigger.tgisinternal
            and revision_trigger.tgenabled in ('O', 'A')
            and revision_trigger.tgfoid = to_regprocedure(
              'system.enqueue_content_embedding_job_from_revision()'
            )
        )
        and exists (
          select 1
          from pg_catalog.pg_extension
          where extname = 'vector'
            and (
              split_part(extversion, '.', 1)::integer > 0
              or split_part(extversion, '.', 2)::integer >= 8
            )
        ) as ready
    `;
    if (rows[0]?.ready !== true) throw new SearchIndexError("INDEX_NOT_READY");
  }

  /** Returns bounded, query-free operational gauges for the durable index queue. */
  async inspectQueue(): Promise<SearchIndexQueueMetrics> {
    const rows = await this.#sql<QueueMetricsRow[]>`
      select
        count(*) filter (where status = 'ready')::integer as ready_count,
        count(*) filter (where status = 'leased')::integer as leased_count,
        count(*) filter (where status = 'dead_lettered')::integer
          as dead_lettered_count,
        count(*) filter (
          where status = 'leased'
            and lease_expires_at <= statement_timestamp()
        )::integer as expired_lease_count,
        coalesce(
          greatest(
            0,
            floor(extract(epoch from (
              statement_timestamp() - min(available_at) filter (where status = 'ready')
            )))
          ),
          0
        )::integer as oldest_ready_age_seconds
      from system.content_embedding_jobs
    `;
    const row = rows[0];
    if (
      row === undefined ||
      [
        row.ready_count,
        row.leased_count,
        row.dead_lettered_count,
        row.expired_lease_count,
        row.oldest_ready_age_seconds,
      ].some((value) => !Number.isInteger(value) || value < 0)
    ) {
      throw new SearchIndexError("INDEX_DATA_INVALID");
    }
    return {
      deadLetteredCount: row.dead_lettered_count,
      expiredLeaseCount: row.expired_lease_count,
      leasedCount: row.leased_count,
      oldestReadyAgeSeconds: row.oldest_ready_age_seconds,
      readyCount: row.ready_count,
    };
  }

  /** Idempotently converts a canonical Content outbox event into an index job. */
  async enqueueOutboxEvent(event: OutboxEvent): Promise<boolean> {
    if (
      event.aggregateType !== "content" ||
      event.eventVersion !== 1 ||
      !SUPPORTED_CONTENT_EVENTS.has(event.eventType)
    ) {
      return false;
    }
    const revisionId = event.payload.revision_id;
    if (revisionId === null && event.eventType === "content.revised") {
      const groups = event.payload.changed_groups;
      if (
        !Array.isArray(groups) ||
        groups.length < 1 ||
        groups.some(
          (group) =>
            group !== "additional_community_ids" &&
            group !== "symbols" &&
            group !== "topics",
        )
      ) {
        throw new SearchIndexError("INDEX_DATA_INVALID");
      }
      // A classification-only Content update has no new immutable Revision.
      // The Search visibility epoch covers its changed filter membership.
      return true;
    }
    if (typeof revisionId !== "string" || !UUID_PATTERN.test(revisionId)) {
      throw new SearchIndexError("INDEX_DATA_INVALID");
    }
    await this.enqueueRevision(revisionId, 100);
    return true;
  }

  async enqueueRevision(revisionId: string, priority = 0): Promise<void> {
    const normalizedId = normalizeUuid(revisionId);
    if (!Number.isInteger(priority) || priority < -100 || priority > 100) {
      throw new SearchIndexError("INVALID_ARGUMENT");
    }
    await this.#sql`
      select system.enqueue_content_embedding_job(
        ${normalizedId}::uuid,
        ${this.#embeddingModel}::text,
        ${priority}::smallint
      )
    `;
  }

  /** Repairs missed outbox deliveries without reopening already indexed revisions. */
  async backfillMissingRevisions(limit = 500): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
      throw new SearchIndexError("INVALID_ARGUMENT");
    }
    const rows = await this.#sql<{ job_id: string }[]>`
      with missing as (
        select revision.id
        from platform.content_revisions as revision
        where not exists (
          select 1
          from platform.content_embedding_chunks as chunk
          where chunk.revision_id = revision.id
            and chunk.embedding_model = ${this.#embeddingModel}
        )
          and not exists (
            select 1
            from system.content_embedding_jobs as job
            where job.revision_id = revision.id
              and job.embedding_model = ${this.#embeddingModel}
          )
        order by revision.created_at, revision.id
        limit ${limit}
      )
      select system.enqueue_content_embedding_job(
        missing.id,
        ${this.#embeddingModel}::text,
        -100::smallint
      )::text as job_id
      from missing
    `;
    return rows.length;
  }

  async claimJobs(workerId: string, batchSize = 10): Promise<SearchIndexJobLease[]> {
    const worker = normalizeWorkerId(workerId);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new SearchIndexError("INVALID_ARGUMENT");
    }
    return this.#sql.begin(async (transaction) => {
      await this.#setStatementTimeout(transaction);
      const leases: SearchIndexJobLease[] = [];
      for (let index = 0; index < batchSize; index += 1) {
        const token = this.#tokenFactory();
        if (!Buffer.isBuffer(token) || token.length < 32) {
          throw new Error(
            "Search index lease tokens must contain at least 32 random bytes.",
          );
        }
        const rawToken = token.toString("base64url");
        const digest = createHash("sha256").update(token).digest();
        const rows = await transaction<ClaimedJobRow[]>`
          select
            job_id::text as id,
            revision_id::text as revision_id,
            embedding_model,
            attempt_number as attempts,
            max_attempts,
            lease_expires_at
          from system.claim_content_embedding_jobs(
            ${worker}::text,
            ${digest}::bytea,
            1,
            ${Math.ceil(this.#leaseMilliseconds / 1_000)}
          )
        `;
        const row = rows[0];
        if (row === undefined) break;
        leases.push(mapLease(row, rawToken, worker));
      }
      return leases;
    });
  }

  async processJob(
    lease: SearchIndexJobLease,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<void> {
    validateLease(lease, this.#embeddingModel);
    const tokenDigest = digestLeaseToken(lease.leaseToken);
    const revision = await this.#loadLeasedRevision(lease, tokenDigest);
    const document = revision.title
      ? `${revision.title.normalize("NFKC").trim()}\n\n${revision.body_plain_text}`
      : revision.body_plain_text;
    const chunks = chunkUnicodeText(document, {
      maxCodePoints: this.#chunkCodePoints,
      overlapCodePoints: this.#chunkOverlapCodePoints,
    });
    if (chunks.length < 1 || chunks.length > MAXIMUM_CHUNKS_PER_REVISION) {
      await this.#recordFailure(lease, tokenDigest, "INDEX_DATA_INVALID", false);
      throw new SearchIndexError("INDEX_DATA_INVALID");
    }

    const embedded: Array<SearchDocumentChunk & { embedding: number[]; hash: Buffer }> =
      [];
    try {
      for (const chunk of chunks) {
        // Renew immediately before every external call. The configured lease is
        // longer than the provider timeout plus a fenced database-write margin.
        await this.#renewLease(lease, tokenDigest);
        const embedding = await this.#provider.embed(chunk.text, {
          signal: options.signal,
        });
        if (
          embedding.length !== 512 ||
          embedding.some((component) => !Number.isFinite(component))
        ) {
          throw new SearchIndexError("PROVIDER_INVALID_RESPONSE");
        }
        embedded.push({
          ...chunk,
          embedding,
          hash: embeddingSourceHash(chunk.text),
        });
      }
      // Reserve a fresh database margin for the immutable chunk transaction.
      await this.#renewLease(lease, tokenDigest);
    } catch (error) {
      const indexError = mapProviderError(error);
      await this.#recordFailure(
        lease,
        tokenDigest,
        indexError.code,
        indexError.retryable,
      );
      throw indexError;
    }

    try {
      await this.#sql.begin(async (transaction) => {
        await this.#setStatementTimeout(transaction);
        const fenced = await transaction<{ id: string }[]>`
        select id::text as id
        from system.content_embedding_jobs
        where id = ${lease.jobId}::uuid
          and revision_id = ${lease.revisionId}::uuid
          and embedding_model = ${this.#embeddingModel}
          and status = 'leased'
          and lease_owner = ${lease.leaseOwner}
          and lease_token_digest = ${tokenDigest}
          and lease_expires_at > clock_timestamp()
        for update
      `;
        if (fenced[0] === undefined) throw new SearchIndexError("LEASE_LOST");
        for (const chunk of embedded) {
          await transaction`
          insert into platform.content_embedding_chunks (
            revision_id,
            embedding_model,
            chunk_index,
            source_start_offset,
            source_end_offset,
            source_text_hash,
            token_count,
            embedding
          )
          values (
            ${lease.revisionId}::uuid,
            ${this.#embeddingModel},
            ${chunk.chunkIndex},
            ${chunk.startOffset},
            ${chunk.endOffset},
            ${chunk.hash},
            ${chunk.tokenCount},
            ${JSON.stringify(chunk.embedding)}::vector(512)
          )
          on conflict (revision_id, embedding_model, chunk_index) do nothing
        `;
          const verified = await transaction<{ exact: boolean }[]>`
          select exists (
            select 1
            from platform.content_embedding_chunks as persisted
            where persisted.revision_id = ${lease.revisionId}::uuid
              and persisted.embedding_model = ${this.#embeddingModel}
              and persisted.chunk_index = ${chunk.chunkIndex}
              and persisted.source_start_offset = ${chunk.startOffset}
              and persisted.source_end_offset = ${chunk.endOffset}
              and persisted.source_text_hash = ${chunk.hash}
              and persisted.token_count = ${chunk.tokenCount}
              and persisted.embedding = ${JSON.stringify(chunk.embedding)}::vector(512)
          ) as exact
        `;
          if (verified[0]?.exact !== true) {
            throw new SearchIndexError("INDEX_DATA_INVALID");
          }
        }
        const persisted = await transaction<{ count: number }[]>`
        select count(*)::integer as count
        from platform.content_embedding_chunks
        where revision_id = ${lease.revisionId}::uuid
          and embedding_model = ${this.#embeddingModel}
      `;
        if (persisted[0]?.count !== embedded.length) {
          throw new SearchIndexError("INDEX_DATA_INVALID");
        }
        const completed = await transaction<{ completed: boolean }[]>`
        select system.complete_content_embedding_job(
          ${lease.jobId}::uuid,
          ${lease.leaseOwner}::text,
          ${tokenDigest}::bytea
        ) as completed
      `;
        if (completed[0]?.completed !== true) throw new SearchIndexError("LEASE_LOST");
      });
    } catch (error) {
      const indexError =
        error instanceof SearchIndexError
          ? error
          : new SearchIndexError("STORAGE_UNAVAILABLE", { cause: error });
      if (indexError.code !== "LEASE_LOST") {
        await this.#recordFailure(
          lease,
          tokenDigest,
          indexError.code,
          indexError.retryable,
        );
      }
      throw indexError;
    }
  }

  /** Claims and processes a bounded batch, continuing after individual retries. */
  async runOnce(
    workerId: string,
    options: { batchSize?: number | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<SearchIndexerRunResult> {
    const worker = normalizeWorkerId(workerId);
    const batchSize = options.batchSize ?? 10;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new SearchIndexError("INVALID_ARGUMENT");
    }
    let claimed = 0;
    let completed = 0;
    let failed = 0;
    while (claimed < batchSize && options.signal?.aborted !== true) {
      const [lease] = await this.claimJobs(worker, 1);
      if (lease === undefined) break;
      claimed += 1;
      try {
        await this.processJob(lease, { signal: options.signal });
        completed += 1;
      } catch {
        failed += 1;
      }
    }
    return { claimed, completed, failed };
  }

  /** Worker-facing handler: enqueue the event, then make immediate queue progress. */
  async handleOutboxEvent(
    event: OutboxEvent,
    options: {
      batchSize?: number | undefined;
      signal?: AbortSignal | undefined;
      workerId: string;
    },
  ): Promise<{ accepted: boolean; run: SearchIndexerRunResult }> {
    const accepted = await this.enqueueOutboxEvent(event);
    const run = accepted
      ? await this.runOnce(options.workerId, options)
      : { claimed: 0, completed: 0, failed: 0 };
    return { accepted, run };
  }

  async #renewLease(lease: SearchIndexJobLease, tokenDigest: Buffer): Promise<void> {
    const rows = await this.#sql<{ lease_expires_at: Date | null }[]>`
      select system.renew_content_embedding_job_lease(
        ${lease.jobId}::uuid,
        ${lease.leaseOwner}::text,
        ${tokenDigest}::bytea,
        ${Math.ceil(this.#leaseMilliseconds / 1_000)}
      ) as lease_expires_at
    `;
    if (!(rows[0]?.lease_expires_at instanceof Date)) {
      throw new SearchIndexError("LEASE_LOST");
    }
  }

  async #loadLeasedRevision(
    lease: SearchIndexJobLease,
    tokenDigest: Buffer,
  ): Promise<RevisionRow> {
    const rows = await this.#sql<RevisionRow[]>`
      select
        revision.id::text as id,
        revision.title,
        revision.body_plain_text
      from system.content_embedding_jobs as job
      join platform.content_revisions as revision on revision.id = job.revision_id
      where job.id = ${lease.jobId}::uuid
        and job.revision_id = ${lease.revisionId}::uuid
        and job.embedding_model = ${this.#embeddingModel}
        and job.status = 'leased'
        and job.lease_owner = ${lease.leaseOwner}
        and job.lease_token_digest = ${tokenDigest}
        and job.lease_expires_at > clock_timestamp()
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) throw new SearchIndexError("LEASE_LOST");
    if (
      row.id !== lease.revisionId ||
      typeof row.body_plain_text !== "string" ||
      row.body_plain_text.length < 1 ||
      (row.title !== null && typeof row.title !== "string")
    ) {
      throw new SearchIndexError("INDEX_DATA_INVALID");
    }
    return row;
  }

  async #recordFailure(
    lease: SearchIndexJobLease,
    tokenDigest: Buffer,
    code: SearchIndexErrorCode,
    retryable: boolean,
  ): Promise<void> {
    const delaySeconds = Math.min(300, 2 ** Math.min(lease.attempts, 8));
    await this.#sql`
      select system.retry_content_embedding_job(
        ${lease.jobId}::uuid,
        ${lease.leaseOwner}::text,
        ${tokenDigest}::bytea,
        ${retryable ? code : `NONRETRYABLE_${code}`}::text,
        ${delaySeconds}
      )
    `;
  }

  async #setStatementTimeout(transaction: TransactionSql): Promise<void> {
    await transaction.unsafe(
      `set local statement_timeout = '${this.#queryTimeoutMilliseconds}ms'`,
    );
  }
}

export function chunkUnicodeText(
  text: string,
  options: {
    maxCodePoints?: number | undefined;
    overlapCodePoints?: number | undefined;
  } = {},
): SearchDocumentChunk[] {
  if (typeof text !== "string" || text.includes("\u0000")) {
    throw new SearchIndexError("INVALID_ARGUMENT");
  }
  const maximum = options.maxCodePoints ?? DEFAULT_CHUNK_CODE_POINTS;
  const overlap = options.overlapCodePoints ?? DEFAULT_CHUNK_OVERLAP_CODE_POINTS;
  if (
    !Number.isInteger(maximum) ||
    maximum < 32 ||
    maximum > 50_000 ||
    !Number.isInteger(overlap) ||
    overlap < 0 ||
    overlap >= maximum / 2
  ) {
    throw new SearchIndexError("INVALID_ARGUMENT");
  }
  const normalized = text.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) return [];
  const points = [...normalized];
  const chunks: SearchDocumentChunk[] = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(points.length, start + maximum);
    if (end < points.length) {
      const minimumBreak = start + Math.floor(maximum * 0.75);
      for (let index = end; index > minimumBreak; index -= 1) {
        if (/\s/u.test(points[index - 1]!)) {
          end = index;
          break;
        }
      }
    }
    let contentStart = start;
    let contentEnd = end;
    while (contentStart < contentEnd && /\s/u.test(points[contentStart]!)) {
      contentStart += 1;
    }
    while (contentEnd > contentStart && /\s/u.test(points[contentEnd - 1]!)) {
      contentEnd -= 1;
    }
    const value = points.slice(contentStart, contentEnd).join("");
    if (value.length > 0) {
      chunks.push({
        chunkIndex: chunks.length,
        endOffset: contentEnd,
        startOffset: contentStart,
        text: value,
        // This is intentionally an estimate for observability/capacity only;
        // Bedrock remains the token-limit authority.
        tokenCount: Math.max(1, Math.ceil([...value].length / 4)),
      });
    }
    if (end >= points.length) break;
    const nextStart = Math.max(start + 1, end - overlap);
    start = nextStart;
    if (chunks.length > MAXIMUM_CHUNKS_PER_REVISION) {
      throw new SearchIndexError("INDEX_DATA_INVALID");
    }
  }
  return chunks;
}

function normalizeUuid(value: string): string {
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new SearchIndexError("INVALID_ARGUMENT");
  return normalized;
}

function normalizeWorkerId(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/u.test(normalized)) {
    throw new SearchIndexError("INVALID_ARGUMENT");
  }
  return normalized;
}

function digestLeaseToken(value: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43,512}$/u.test(value)) {
    throw new SearchIndexError("INVALID_ARGUMENT");
  }
  let token: Buffer;
  try {
    token = Buffer.from(value, "base64url");
  } catch {
    throw new SearchIndexError("INVALID_ARGUMENT");
  }
  if (token.length < 32) throw new SearchIndexError("INVALID_ARGUMENT");
  return createHash("sha256").update(token).digest();
}

function mapLease(
  row: ClaimedJobRow,
  leaseToken: string,
  leaseOwner: string,
): SearchIndexJobLease {
  if (
    !UUID_PATTERN.test(row.id) ||
    !UUID_PATTERN.test(row.revision_id) ||
    row.embedding_model.length < 1 ||
    !(row.lease_expires_at instanceof Date) ||
    !Number.isInteger(row.attempts) ||
    row.attempts < 1 ||
    !Number.isInteger(row.max_attempts) ||
    row.max_attempts < row.attempts
  ) {
    throw new SearchIndexError("INDEX_DATA_INVALID");
  }
  return {
    attempts: row.attempts,
    embeddingModel: row.embedding_model,
    jobId: row.id,
    leaseExpiresAt: row.lease_expires_at,
    leaseOwner,
    leaseToken,
    maxAttempts: row.max_attempts,
    revisionId: row.revision_id,
  };
}

function validateLease(lease: SearchIndexJobLease, embeddingModel: string): void {
  if (
    !UUID_PATTERN.test(lease.jobId) ||
    !UUID_PATTERN.test(lease.revisionId) ||
    lease.embeddingModel !== embeddingModel ||
    normalizeWorkerId(lease.leaseOwner) !== lease.leaseOwner ||
    !(lease.leaseExpiresAt instanceof Date) ||
    !Number.isInteger(lease.attempts) ||
    lease.attempts < 1 ||
    !Number.isInteger(lease.maxAttempts) ||
    lease.maxAttempts < lease.attempts
  ) {
    throw new SearchIndexError("INVALID_ARGUMENT");
  }
  digestLeaseToken(lease.leaseToken);
}

function mapProviderError(error: unknown): SearchIndexError {
  if (error instanceof SearchIndexError) return error;
  if (error instanceof EmbeddingProviderError) {
    const code: SearchIndexErrorCode =
      error.code === "ABORTED"
        ? "PROVIDER_ABORTED"
        : error.code === "INVALID_RESPONSE" || error.code === "INVALID_INPUT"
          ? "PROVIDER_INVALID_RESPONSE"
          : error.code === "TIMEOUT"
            ? "PROVIDER_TIMEOUT"
            : "PROVIDER_UNAVAILABLE";
    return new SearchIndexError(code, { cause: error });
  }
  return new SearchIndexError("PROVIDER_UNAVAILABLE", { cause: error });
}

function indexErrorMessage(code: SearchIndexErrorCode): string {
  const messages: Record<SearchIndexErrorCode, string> = {
    INDEX_DATA_INVALID: "Search index data is invalid.",
    INDEX_NOT_READY: "The search index schema is not ready.",
    INVALID_ARGUMENT: "The search index request is invalid.",
    LEASE_LOST: "The search index job lease is no longer valid.",
    PROVIDER_ABORTED: "Embedding generation was aborted.",
    PROVIDER_INVALID_RESPONSE: "The embedding provider response was invalid.",
    PROVIDER_TIMEOUT: "The embedding provider timed out.",
    PROVIDER_UNAVAILABLE: "The embedding provider is unavailable.",
    STORAGE_UNAVAILABLE: "Search index storage is temporarily unavailable.",
  };
  return messages[code];
}

export const DEFAULT_SEARCH_EMBEDDING_MODEL = TITAN_TEXT_EMBED_V2_INDEX_MODEL;
