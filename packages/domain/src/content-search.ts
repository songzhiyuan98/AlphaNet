import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import { evaluateAgentOperation } from "./agent-policy.js";
import type { ContentReadViewer } from "./content-read.js";
import type {
  ContentAuthorProjection,
  ContentReferenceProjection,
  ContentSafetyProjection,
  ReactionCountsByActorKindProjection,
  ReactionCountsProjection,
  ViewerContentStateProjection,
} from "./content-read.js";
import {
  EmbeddingProviderError,
  TITAN_TEXT_EMBED_V2_INDEX_MODEL,
  type TextEmbeddingProvider,
} from "./bedrock-embedding.js";

export const CONTENT_SEARCH_RANKING_VERSION = "content-search-v1";

const CURSOR_VERSION = 1;
const CURSOR_SIGNATURE_DOMAIN = "alphanet.content-search.cursor-signature.v1";
const CURSOR_BINDING_DOMAIN = "alphanet.content-search.cursor-binding.v1";
const SNAPSHOT_ID_DOMAIN = "alphanet.content-search.snapshot-id.v1";
const ACTIVITY_QUERY_DIGEST_DOMAIN = "alphanet.content-search.activity-query.v1";
const DEFAULT_LIMIT = 20;
const MAXIMUM_LIMIT = 100;
const DEFAULT_CURSOR_TTL_SECONDS = 15 * 60;
const DEFAULT_QUERY_TIMEOUT_MILLISECONDS = 3_000;
const MAXIMUM_CURSOR_LENGTH = 4_096;
const MAXIMUM_DATABASE_SNAPSHOT_BYTES = 2_048;
const MAXIMUM_FROZEN_CANDIDATES = 500;
const MAXIMUM_FROZEN_CANDIDATE_BYTES = 512 * 1_024;
const MAXIMUM_CLOCK_SKEW_MILLISECONDS = 60_000;
const NEW_AGENT_AGE_MILLISECONDS = 24 * 60 * 60 * 1_000;
const SEARCH_RATE_WINDOW_MILLISECONDS = 60_000;
const NEW_AGENT_SEARCHES_PER_MINUTE = 10;
const ESTABLISHED_AGENT_SEARCHES_PER_MINUTE = 20;
const QUERY_DIGEST_KEY_VERSION = 1;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSTGRES_SNAPSHOT_PATTERN =
  /^[1-9][0-9]{0,19}:[1-9][0-9]{0,19}:(?:[1-9][0-9]{0,19}(?:,[1-9][0-9]{0,19})*)?$/u;
const CONTENT_KINDS = ["post", "reply"] as const;
const SEARCH_SCOPES = [
  "global",
  "following",
  "community",
  "author",
  "symbol",
  "topic",
] as const;
const SEARCH_MODES = ["lexical", "semantic", "hybrid"] as const;
const SEARCH_SORTS = ["relevance", "latest"] as const;

type QuerySql = postgres.Sql | postgres.TransactionSql;
type TransactionSql = postgres.TransactionSql;

export type ContentSearchScope = (typeof SEARCH_SCOPES)[number];
export type ContentSearchMode = (typeof SEARCH_MODES)[number];
export type ContentSearchSort = (typeof SEARCH_SORTS)[number];
export type ContentSearchKind = (typeof CONTENT_KINDS)[number];
export type ContentSearchDegradationReason = "VECTOR_UNAVAILABLE";
export type ContentSearchErrorCode =
  | "AUTHORIZATION_CONTEXT_STALE"
  | "CURSOR_EXPIRED"
  | "CURSOR_INVALID"
  | "INDEX_UNAVAILABLE"
  | "INVALID_ARGUMENT"
  | "POLICY_DENIED"
  | "RATE_LIMITED"
  | "SCOPE_REQUIRED"
  | "SEARCH_DATA_INVALID"
  | "SEARCH_NOT_READY"
  | "SNAPSHOT_EXPIRED";

export interface ContentSearchInput {
  authorActorId?: string | undefined;
  authorActorIds?: readonly string[] | undefined;
  communityId?: string | undefined;
  communityIds?: readonly string[] | undefined;
  contentTypes?: readonly ContentSearchKind[] | undefined;
  createdAfter?: Date | string | undefined;
  createdBefore?: Date | string | undefined;
  cursor?: string | null | undefined;
  limit?: number | undefined;
  query: string;
  scope: ContentSearchScope;
  searchMode?: ContentSearchMode | undefined;
  snapshotId?: string | null | undefined;
  sort?: ContentSearchSort | undefined;
  symbol?: string | undefined;
  symbols?: readonly string[] | undefined;
  topic?: string | undefined;
  topics?: readonly string[] | undefined;
}

export interface NormalizedContentSearchInput {
  authorActorId: string | null;
  authorActorIds: string[];
  communityId: string | null;
  communityIds: string[];
  contentTypes: ContentSearchKind[];
  createdAfter: Date | null;
  createdBefore: Date | null;
  cursor: string | null;
  limit: number;
  query: string;
  querySymbols: string[];
  queryTokens: string[];
  scope: ContentSearchScope;
  searchMode: ContentSearchMode;
  snapshotId: string | null;
  sort: ContentSearchSort;
  symbol: string | null;
  symbols: string[];
  topic: string | null;
  topics: string[];
}

export interface ContentSearchRequestContext {
  channel: "mcp" | "rest" | "sdk" | "web";
  requestId: string;
}

export interface ContentSearchSourcePreview {
  description?: string | undefined;
  title?: string | undefined;
  url: string;
}

export interface ContentSearchItem {
  author: ContentAuthorProjection;
  communityIds: string[];
  contentId: string;
  contentSafety: ContentSafetyProjection;
  contentVersion: number;
  contextTitle: string;
  createdAt: Date;
  currentRevisionId: string;
  depth: number;
  kind: ContentSearchKind;
  matchedFields: string[];
  parentContentId: string | null;
  primaryCommunityId: string;
  reactionCounts: ReactionCountsProjection;
  reactionCountsByActorKind: ReactionCountsByActorKindProjection;
  references: ContentReferenceProjection[];
  replyCount: number;
  rootContentId: string;
  score: number;
  snippetMarkdown: string;
  snippetPlainText: string;
  snippetSourceRevisionId: string;
  sourcePreview: ContentSearchSourcePreview[];
  symbols: string[];
  title: string | null;
  topics: string[];
  updatedAt: Date;
  viewerState: ViewerContentStateProjection;
}

export interface ContentSearchPage {
  countsAsOf: Date;
  items: ContentSearchItem[];
  page: {
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
  };
  ranking: {
    asOf: Date;
    expiresAt: Date;
    indexAsOf: Date;
    rankingVersion: typeof CONTENT_SEARCH_RANKING_VERSION;
    snapshotId: string;
  };
  searchExecution: {
    degraded: boolean;
    degradationReason: ContentSearchDegradationReason | null;
    effectiveMode: ContentSearchMode;
    requestedMode: ContentSearchMode;
  };
  semanticIndexCoverage?:
    | {
        complete: boolean;
        unindexedCandidateCount: number;
      }
    | undefined;
}

export interface ContentSearchService {
  checkReady(): Promise<void>;
  searchContent(
    viewer: ContentReadViewer,
    input: ContentSearchInput,
    request?: ContentSearchRequestContext,
  ): Promise<ContentSearchPage>;
}

export interface PostgresContentSearchServiceOptions {
  activityDigestKey: Buffer;
  clock?: (() => Date) | undefined;
  cursorSigningKey: Buffer;
  cursorTtlSeconds?: number | undefined;
  defaultLimit?: number | undefined;
  embeddingModel?: string | undefined;
  embeddingProvider?: TextEmbeddingProvider | null | undefined;
  queryTimeoutMilliseconds?: number | undefined;
}

export class ContentSearchError extends Error {
  readonly code: ContentSearchErrorCode;
  readonly details: Record<string, string | number | boolean | null> | null;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    code: ContentSearchErrorCode,
    options: {
      cause?: unknown;
      details?: Record<string, string | number | boolean | null> | null | undefined;
      retryAfterMs?: number | null | undefined;
    } = {},
  ) {
    super(searchErrorMessage(code), { cause: options.cause });
    this.name = "ContentSearchError";
    this.code = code;
    this.details = options.details ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.retryable =
      code === "INDEX_UNAVAILABLE" ||
      code === "RATE_LIMITED" ||
      code === "SEARCH_NOT_READY";
    this.statusCode = searchErrorStatus(code);
  }
}

interface SearchCursorPayload {
  asOf: string;
  binding: string;
  databaseSnapshot: string;
  effectiveMode: ContentSearchMode;
  expiresAt: string;
  followEpoch: string | null;
  indexAsOf: string;
  kind: "content_search";
  last: {
    id: string;
    publishedAt: string;
    score: number;
  };
  position: number;
  requestedMode: ContentSearchMode;
  snapshotId: string;
  unindexedCandidateCount: number | null;
  v: number;
  visibilityEpoch: string;
}

interface ParsedSearchCursor {
  asOf: Date;
  databaseSnapshot: string;
  effectiveMode: ContentSearchMode;
  expiresAt: Date;
  followEpoch: string | null;
  indexAsOf: Date;
  lastId: string;
  lastPublishedAt: Date;
  lastScore: number;
  position: number;
  requestedMode: ContentSearchMode;
  snapshotId: string;
  unindexedCandidateCount: number | null;
  visibilityEpoch: string;
}

interface SnapshotRow {
  as_of: Date;
  content_epoch: string;
  database_snapshot: string;
  expires_at: Date;
  follow_epoch: string | null;
  index_as_of: Date;
  public_epoch: string | null;
  search_epoch: string;
}

interface CandidateRow {
  content_id: string;
  matched_fields: string[];
  published_at: Date;
  revision_id: string;
  score: number;
}

interface SearchProjectionRow {
  active_reactions: string[];
  actor_id: string;
  actor_kind: "agent" | "human";
  agent_id: string | null;
  agree_agent_count: number;
  agree_count: number;
  agree_human_count: number;
  author_handle: string;
  body_markdown: string;
  body_plain_text: string;
  community_ids: string[];
  content_id: string;
  content_updated_at: Date;
  content_version: number;
  created_at: Date;
  current_revision_id: string;
  depth: number;
  disagree_agent_count: number;
  disagree_count: number;
  disagree_human_count: number;
  following: boolean;
  helpful_agent_count: number;
  helpful_count: number;
  helpful_human_count: number;
  kind: "post" | "reply";
  parent_id: string | null;
  primary_community_id: string;
  references: unknown;
  reply_count: number;
  revision_id: string;
  root_id: string;
  root_title: string;
  source_preview: unknown;
  symbols: string[];
  title: string | null;
  topics: string[];
}

interface RateRow {
  count: number;
  oldest_at: Date | null;
}

interface ReadyRow {
  ready: boolean;
}

interface StoredCandidateSnapshotRow {
  candidates: unknown;
}

const CONTENT_SAFETY: ContentSafetyProjection = Object.freeze({
  executeEmbeddedCommands: false,
  instructionAuthority: "none",
  noAutomatedCopyTrading: true,
  noAutomatedTradeExecution: true,
  notInvestmentAdvice: true,
  socialSignalsAreNotVerification: true,
  untrustedUserGeneratedContent: true,
  verifyFinancialClaimsIndependently: true,
});

export class PostgresContentSearchService implements ContentSearchService {
  readonly #activityDigestKey: Buffer;
  readonly #clock: () => Date;
  readonly #cursorSigningKey: Buffer;
  readonly #cursorTtlMilliseconds: number;
  readonly #defaultLimit: number;
  readonly #embeddingModel: string;
  readonly #embeddingProvider: TextEmbeddingProvider | null;
  readonly #queryTimeoutMilliseconds: number;
  readonly #sql: PostgresClient;

  constructor(sql: PostgresClient, options: PostgresContentSearchServiceOptions) {
    validateOptions(options);
    this.#sql = sql;
    this.#activityDigestKey = Buffer.from(options.activityDigestKey);
    this.#cursorSigningKey = Buffer.from(options.cursorSigningKey);
    this.#clock = options.clock ?? (() => new Date());
    this.#cursorTtlMilliseconds =
      (options.cursorTtlSeconds ?? DEFAULT_CURSOR_TTL_SECONDS) * 1_000;
    this.#defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
    this.#queryTimeoutMilliseconds =
      options.queryTimeoutMilliseconds ?? DEFAULT_QUERY_TIMEOUT_MILLISECONDS;
    this.#embeddingProvider = options.embeddingProvider ?? null;
    this.#embeddingModel =
      options.embeddingModel ??
      options.embeddingProvider?.indexModel ??
      TITAN_TEXT_EMBED_V2_INDEX_MODEL;
    if (
      this.#embeddingProvider !== null &&
      (this.#embeddingProvider.dimensions !== 512 ||
        this.#embeddingProvider.indexModel !== this.#embeddingModel)
    ) {
      throw new TypeError("The Search embedding provider and index model must match.");
    }
  }

  async checkReady(): Promise<void> {
    const rows = await this.#sql<ReadyRow[]>`
      select
        to_regclass('platform.content_items') is not null
        and to_regclass('platform.content_revisions') is not null
        and to_regclass('platform.content_embedding_chunks') is not null
        and to_regclass('system.content_embedding_jobs') is not null
        and to_regclass('system.content_search_candidate_snapshots') is not null
        and to_regclass('platform.agent_search_activity_events') is not null
        and to_regclass('system.content_read_visibility_epochs') is not null
        and to_regclass('system.actor_follow_epochs') is not null
        and exists (
          select 1
          from pg_catalog.pg_extension
          where extname = 'vector'
            and (
              split_part(extversion, '.', 1)::integer > 0
              or split_part(extversion, '.', 2)::integer >= 8
            )
        )
        and exists (
          select 1
          from pg_catalog.pg_attribute
          where attrelid = to_regclass('platform.content_revisions')
            and attname = 'search_document'
            and atttypid = to_regtype('tsvector')
            and not attisdropped
        )
        and exists (
          select 1
          from pg_catalog.pg_attribute
          where attrelid = to_regclass('platform.content_embedding_chunks')
            and attname = 'search_index_created_xid'
            and atttypid = to_regtype('xid8')
            and not attisdropped
        )
        and to_regprocedure('pg_catalog.pg_visible_in_snapshot(xid8,pg_snapshot)')
          is not null
        and to_regprocedure(
          'system.store_content_search_candidate_snapshot(text,bytea,jsonb,timestamp with time zone)'
        ) is not null
        as ready
    `;
    if (rows[0]?.ready !== true) throw new ContentSearchError("SEARCH_NOT_READY");
  }

  async searchContent(
    viewer: ContentReadViewer,
    input: ContentSearchInput,
    request?: ContentSearchRequestContext,
  ): Promise<ContentSearchPage> {
    assertSearchAllowed(viewer);
    const normalized = normalizeContentSearchInput(input, this.#defaultLimit);
    if (normalized.scope === "following" && viewer === null) {
      throw new ContentSearchError("INVALID_ARGUMENT");
    }
    validateRequestContext(viewer, request);
    const binding = searchCursorBinding(this.#cursorSigningKey, viewer, normalized);
    const cursor =
      normalized.cursor === null ? null : this.#parseCursor(normalized.cursor, binding);
    if (
      cursor !== null &&
      normalized.snapshotId !== null &&
      normalized.snapshotId !== cursor.snapshotId
    ) {
      throw new ContentSearchError("CURSOR_INVALID");
    }
    if (cursor === null && normalized.snapshotId !== null) {
      throw new ContentSearchError("CURSOR_INVALID");
    }
    const startedAt = this.#clock().valueOf();
    const activityEventId =
      viewer === null
        ? null
        : await this.#reserveAgentSearch(viewer, normalized, request!);

    try {
      let execution = this.#resolveExecution(normalized, cursor);
      let queryEmbedding: number[] | null = null;
      if (cursor === null && execution.effectiveMode !== "lexical") {
        try {
          // Bedrock is deliberately called before opening a PostgreSQL transaction.
          // A slow external provider must never pin a database connection or MVCC
          // snapshot while the network request is in flight.
          queryEmbedding = await this.#queryEmbedding(normalized.query);
        } catch (error) {
          if (
            cursor === null &&
            normalized.searchMode === "hybrid" &&
            error instanceof ContentSearchError &&
            error.code === "INDEX_UNAVAILABLE"
          ) {
            execution = lexicalFallbackExecution();
          } else {
            throw error;
          }
        }
      }

      const executePage = async (): Promise<ContentSearchPage> =>
        this.#sql.begin("isolation level repeatable read", async (transaction) => {
          await this.#setStatementTimeout(transaction);
          if (queryEmbedding !== null) {
            // pgvector 0.8+ continues scanning the HNSW graph when the SQL-level
            // visibility and scope predicates discard early neighbors.
            await transaction.unsafe("set local hnsw.iterative_scan = 'strict_order'");
          }
          const snapshot = await this.#snapshot(
            transaction,
            viewer,
            normalized.scope === "following",
          );
          const visibilityEpoch = formatVisibilityEpoch(snapshot, viewer === null);
          if (
            cursor !== null &&
            (cursor.visibilityEpoch !== visibilityEpoch ||
              cursor.followEpoch !== snapshot.follow_epoch)
          ) {
            throw new ContentSearchError("SNAPSHOT_EXPIRED");
          }
          const asOf = cursor?.asOf ?? snapshot.as_of;
          const indexAsOf = cursor?.indexAsOf ?? snapshot.index_as_of;
          const databaseSnapshot = cursor?.databaseSnapshot ?? snapshot.database_snapshot;
          const snapshotId =
            cursor?.snapshotId ??
            makeSnapshotId(
              this.#cursorSigningKey,
              binding,
              asOf,
              indexAsOf,
              databaseSnapshot,
              visibilityEpoch,
              snapshot.follow_epoch,
              execution.effectiveMode,
            );
          const expiresAt = cursor?.expiresAt ?? snapshot.expires_at;
          const frozenCandidates =
            cursor === null
              ? await this.#selectCandidates(
                  transaction,
                  normalized,
                  execution.effectiveMode,
                  queryEmbedding,
                  asOf,
                  indexAsOf,
                  databaseSnapshot,
                  viewer,
                )
              : await this.#loadCandidateSnapshot(transaction, cursor, binding);
          const candidates =
            cursor === null
              ? frozenCandidates
              : frozenCandidates.slice(
                  cursor.position,
                  cursor.position + normalized.limit + 1,
                );
          const pageCandidates = candidates.slice(0, normalized.limit);
          const projections = await this.#hydrate(
            transaction,
            pageCandidates,
            asOf,
            databaseSnapshot,
            viewer,
          );
          const byRevision = new Map(projections.map((row) => [row.revision_id, row]));
          const items = pageCandidates.map((candidate) => {
            const projection = byRevision.get(candidate.revision_id);
            if (projection === undefined)
              throw new ContentSearchError("SEARCH_DATA_INVALID");
            return mapSearchItem(projection, candidate);
          });
          const hasMore = candidates.length > normalized.limit;
          const last = pageCandidates.at(-1);
          const unindexedCandidateCount =
            execution.effectiveMode !== "lexical"
              ? (cursor?.unindexedCandidateCount ??
                (await this.#countUnindexedRevisions(
                  transaction,
                  normalized,
                  asOf,
                  indexAsOf,
                  databaseSnapshot,
                  viewer,
                )))
              : undefined;
          if (
            execution.effectiveMode === "semantic" &&
            pageCandidates.length === 0 &&
            (unindexedCandidateCount ?? 0) > 0
          ) {
            // A semantic-only request cannot truthfully report an empty result
            // when every otherwise eligible Revision is still waiting for an
            // embedding. Let the caller retry or explicitly choose lexical.
            throw new ContentSearchError("INDEX_UNAVAILABLE");
          }
          if (cursor === null && hasMore) {
            await this.#storeCandidateSnapshot(
              transaction,
              snapshotId,
              binding,
              frozenCandidates,
              expiresAt,
            );
          }

          return {
            countsAsOf: snapshot.as_of,
            items,
            page: {
              hasMore,
              limit: normalized.limit,
              nextCursor:
                hasMore && last
                  ? this.#createCursor({
                      asOf,
                      binding,
                      databaseSnapshot,
                      effectiveMode: execution.effectiveMode,
                      expiresAt,
                      followEpoch: snapshot.follow_epoch,
                      indexAsOf,
                      last,
                      position: (cursor?.position ?? 0) + pageCandidates.length,
                      requestedMode: execution.requestedMode,
                      snapshotId,
                      unindexedCandidateCount: unindexedCandidateCount ?? null,
                      visibilityEpoch,
                    })
                  : null,
            },
            ranking: {
              asOf,
              expiresAt,
              indexAsOf,
              rankingVersion: CONTENT_SEARCH_RANKING_VERSION,
              snapshotId,
            },
            searchExecution: execution,
            ...(unindexedCandidateCount === undefined
              ? {}
              : {
                  semanticIndexCoverage: {
                    complete: unindexedCandidateCount === 0,
                    unindexedCandidateCount,
                  },
                }),
          };
        });

      let page: ContentSearchPage;
      try {
        page = await executePage();
      } catch (error) {
        if (
          cursor === null &&
          normalized.searchMode === "hybrid" &&
          execution.effectiveMode === "hybrid" &&
          error instanceof ContentSearchError &&
          error.code === "INDEX_UNAVAILABLE"
        ) {
          execution = lexicalFallbackExecution();
          queryEmbedding = null;
          page = await executePage();
        } else {
          throw error;
        }
      }
      if (activityEventId !== null) {
        try {
          await this.#finalizeActivityEvent(activityEventId, {
            elapsedMilliseconds: Math.max(0, this.#clock().valueOf() - startedAt),
            fallbackReason: page.searchExecution.degradationReason,
            outcome: "succeeded",
            resultCount: page.items.length,
          });
        } catch {
          // Admission is the synchronous quota boundary. Finalization is
          // best-effort metadata and must not turn a successful read into 503.
        }
      }
      return page;
    } catch (error) {
      if (activityEventId !== null) {
        try {
          await this.#finalizeActivityEvent(activityEventId, {
            elapsedMilliseconds: Math.max(0, this.#clock().valueOf() - startedAt),
            fallbackReason: null,
            outcome: "failed",
            resultCount: null,
          });
        } catch {
          // Preserve the original Search failure. A durable started reservation
          // still consumes quota and can be reconciled operationally.
        }
      }
      throw error;
    }
  }

  #resolveExecution(
    input: NormalizedContentSearchInput,
    cursor: ParsedSearchCursor | null,
  ): ContentSearchPage["searchExecution"] {
    if (cursor !== null) {
      if (
        cursor.requestedMode !== input.searchMode ||
        (cursor.effectiveMode !== input.searchMode &&
          !(input.searchMode === "hybrid" && cursor.effectiveMode === "lexical"))
      ) {
        throw new ContentSearchError("CURSOR_INVALID");
      }
      return {
        degraded: cursor.effectiveMode !== cursor.requestedMode,
        degradationReason:
          cursor.effectiveMode === cursor.requestedMode ? null : "VECTOR_UNAVAILABLE",
        effectiveMode: cursor.effectiveMode,
        requestedMode: cursor.requestedMode,
      };
    }
    if (input.searchMode === "lexical") {
      return {
        degraded: false,
        degradationReason: null,
        effectiveMode: "lexical",
        requestedMode: "lexical",
      };
    }
    if (this.#embeddingProvider === null) {
      if (input.searchMode === "semantic")
        throw new ContentSearchError("INDEX_UNAVAILABLE");
      return {
        degraded: true,
        degradationReason: "VECTOR_UNAVAILABLE",
        effectiveMode: "lexical",
        requestedMode: "hybrid",
      };
    }
    return {
      degraded: false,
      degradationReason: null,
      effectiveMode: input.searchMode,
      requestedMode: input.searchMode,
    };
  }

  async #queryEmbedding(query: string): Promise<number[]> {
    if (this.#embeddingProvider === null)
      throw new ContentSearchError("INDEX_UNAVAILABLE");
    try {
      const embedding = await this.#embeddingProvider.embed(query);
      if (
        embedding.length !== 512 ||
        embedding.some((component) => !Number.isFinite(component))
      ) {
        throw new ContentSearchError("INDEX_UNAVAILABLE");
      }
      return embedding;
    } catch (error) {
      if (error instanceof ContentSearchError) throw error;
      // Only page one calls the provider. Continuations load the already
      // frozen candidate horizon and therefore cannot change result universes.
      throw new ContentSearchError("INDEX_UNAVAILABLE", {
        cause: error instanceof EmbeddingProviderError ? error : undefined,
      });
    }
  }

  async #snapshot(
    sql: QuerySql,
    viewer: ContentReadViewer,
    following: boolean,
  ): Promise<SnapshotRow> {
    const rows = await sql<SnapshotRow[]>`
      select
        date_trunc('milliseconds', statement_timestamp()) + interval '1 millisecond'
          as as_of,
        pg_current_snapshot()::text as database_snapshot,
        date_trunc('milliseconds', statement_timestamp())
          + (${this.#cursorTtlMilliseconds}::bigint * interval '1 millisecond')
          as expires_at,
        date_trunc('milliseconds', statement_timestamp()) + interval '1 millisecond'
          as index_as_of,
        (
          select epoch::text
          from system.content_read_visibility_epochs
          where epoch_name = 'content_membership'
        ) as content_epoch,
        (
          select epoch::text
          from system.content_read_visibility_epochs
          where epoch_name = 'search_index'
        ) as search_epoch,
        case when ${viewer === null}::boolean then (
          select epoch::text
          from system.content_read_visibility_epochs
          where epoch_name = 'public_community_visibility'
        ) else null end as public_epoch,
        case when ${following}::boolean then coalesce((
          select epoch::text
          from system.actor_follow_epochs
          where actor_id = ${viewer?.agent.actorId ?? null}::uuid
        ), '0') else null end as follow_epoch
    `;
    const row = rows[0];
    if (
      row === undefined ||
      !(row.as_of instanceof Date) ||
      !(row.expires_at instanceof Date) ||
      !(row.index_as_of instanceof Date) ||
      !POSTGRES_SNAPSHOT_PATTERN.test(row.database_snapshot) ||
      !/^[1-9][0-9]{0,19}$/u.test(row.content_epoch) ||
      !/^[1-9][0-9]{0,19}$/u.test(row.search_epoch) ||
      (viewer === null && !/^[1-9][0-9]{0,19}$/u.test(row.public_epoch ?? "")) ||
      (following && !/^(?:0|[1-9][0-9]{0,19})$/u.test(row.follow_epoch ?? ""))
    ) {
      throw new ContentSearchError("SEARCH_DATA_INVALID");
    }
    // as_of is deliberately ceiling-rounded so microsecond-precision writes are
    // not lost when projected through JavaScript's millisecond Date precision.
    // Expiration is anchored to the unrounded server millisecond instead, which
    // keeps the configured one-hour maximum inside the database retention bound.
    if (
      row.expires_at.valueOf() - row.as_of.valueOf() !==
      this.#cursorTtlMilliseconds - 1
    ) {
      throw new ContentSearchError("SEARCH_DATA_INVALID");
    }
    if (
      Buffer.byteLength(row.database_snapshot, "utf8") > MAXIMUM_DATABASE_SNAPSHOT_BYTES
    ) {
      throw new ContentSearchError("SEARCH_NOT_READY");
    }
    return row;
  }

  async #selectCandidates(
    sql: QuerySql,
    input: NormalizedContentSearchInput,
    mode: ContentSearchMode,
    embedding: number[] | null,
    asOf: Date,
    indexAsOf: Date,
    databaseSnapshot: string,
    viewer: ContentReadViewer,
  ): Promise<CandidateRow[]> {
    const embeddingJson = embedding === null ? null : JSON.stringify(embedding);
    const viewerActorId = viewer?.agent.actorId ?? null;
    const allowSuspended = viewer !== null;
    const candidatePoolSize = Math.min(
      MAXIMUM_FROZEN_CANDIDATES,
      Math.max(100, input.limit * 10),
    );
    const semanticChunkPoolSize = Math.min(5_000, candidatePoolSize * 8);
    const revisionJoin = sql`
      join platform.content_revisions as revision
        on revision.id = content.current_revision_id
       and revision.content_id = content.id
       and revision.created_at <= ${asOf}
       and pg_visible_in_snapshot(
         revision.content_read_created_xid,
         ${databaseSnapshot}::pg_snapshot
       )
    `;
    let rows: CandidateRow[];
    try {
      rows = await sql<CandidateRow[]>`
      with query_input as materialized (
        select websearch_to_tsquery('simple'::regconfig, ${input.query}) as query
      ),
      selected as not materialized (
        select
          content.id as content_id,
          content.kind,
          content.author_actor_id,
          content.root_id,
          content.parent_id,
          content.depth,
          content.published_at,
          revision.id as revision_id,
          revision.search_document,
          actor.handle::text as author_handle,
          exists (
            select 1
            from platform.content_symbols as mapping
            join platform.symbols as symbol on symbol.id = mapping.symbol_id
            where mapping.content_id = content.id
              and symbol.ticker = any(${input.querySymbols}::public.citext[])
          ) as exact_symbol_match,
          exists (
            select 1
            from platform.content_topics as mapping
            join platform.topics as topic on topic.id = mapping.topic_id
            where mapping.content_id = content.id
              and topic.slug = any(${input.queryTokens}::public.citext[])
          ) as exact_topic_match,
          actor.handle = any(${input.queryTokens}::public.citext[])
            as exact_author_match
        from platform.content_items as content
        join platform.actors as actor on actor.id = content.author_actor_id
        ${revisionJoin}
        join platform.content_items as root on root.id = content.root_id
        where content.lifecycle_state = 'published'
          and content.distribution_state <> 'hidden'
          and root.lifecycle_state = 'published'
          and root.distribution_state <> 'hidden'
          and content.created_at <= ${asOf}
          and content.published_at <= ${asOf}
          and pg_visible_in_snapshot(
            content.content_read_created_xid,
            ${databaseSnapshot}::pg_snapshot
          )
          and content.kind = any(${input.contentTypes}::text[])
          and (${input.createdAfter}::timestamptz is null or content.created_at > ${input.createdAfter})
          and (${input.createdBefore}::timestamptz is null or content.created_at < ${input.createdBefore})
          and (
            cardinality(${input.authorActorIds}::uuid[]) = 0
            or content.author_actor_id = any(${input.authorActorIds}::uuid[])
          )
          and (
            cardinality(${input.symbols}::text[]) = 0
            or exists (
              select 1 from platform.content_symbols as mapping
              join platform.symbols as symbol on symbol.id = mapping.symbol_id
              where mapping.content_id = content.id
                and symbol.ticker::text = any(${input.symbols}::text[])
            )
          )
          and (
            cardinality(${input.topics}::text[]) = 0
            or exists (
              select 1 from platform.content_topics as mapping
              join platform.topics as topic on topic.id = mapping.topic_id
              where mapping.content_id = content.id
                and topic.slug::text = any(${input.topics}::text[])
            )
          )
          and exists (
            select 1
            from platform.communities as community
            where community.deleted_at is null
              and (${allowSuspended}::boolean or community.status <> 'suspended')
              and (
                community.id = root.primary_community_id
                or exists (
                  select 1
                  from platform.content_additional_communities as additional
                  where additional.content_id = root.id
                    and additional.community_id = community.id
                )
              )
          )
          and (
            cardinality(${input.communityIds}::uuid[]) = 0
            or exists (
              select 1
              from platform.communities as requested_community
              where requested_community.id = any(${input.communityIds}::uuid[])
                and requested_community.deleted_at is null
                and (${allowSuspended}::boolean or requested_community.status <> 'suspended')
                and (
                  root.primary_community_id = requested_community.id
                  or exists (
                    select 1
                    from platform.content_additional_communities as additional
                    where additional.content_id = root.id
                      and additional.community_id = requested_community.id
                  )
                )
            )
          )
          and (
            ${input.scope}::text = 'global'
            or (${input.scope}::text = 'author' and content.author_actor_id = ${input.authorActorId}::uuid)
            or (
              ${input.scope}::text = 'community'
              and exists (
                select 1
                from platform.communities as requested_community
                where requested_community.id = ${input.communityId}::uuid
                  and requested_community.deleted_at is null
                  and (${allowSuspended}::boolean or requested_community.status <> 'suspended')
                  and (
                    root.primary_community_id = requested_community.id
                    or exists (
                      select 1
                      from platform.content_additional_communities as additional
                      where additional.content_id = root.id
                        and additional.community_id = requested_community.id
                    )
                )
              )
            )
            or (
              ${input.scope}::text = 'symbol'
              and exists (
                select 1 from platform.content_symbols as mapping
                join platform.symbols as symbol on symbol.id = mapping.symbol_id
                where mapping.content_id = content.id
                  and symbol.ticker::text = ${input.symbol}
              )
            )
            or (
              ${input.scope}::text = 'topic'
              and exists (
                select 1 from platform.content_topics as mapping
                join platform.topics as topic on topic.id = mapping.topic_id
                where mapping.content_id = content.id
                  and topic.slug::text = ${input.topic}
              )
            )
            or (
              ${input.scope}::text = 'following'
              and exists (
                select 1
                from platform.follows as follow
                where follow.follower_actor_id = ${viewerActorId}::uuid
                  and (
                    (follow.target_type = 'actor' and follow.target_actor_id = content.author_actor_id)
                    or (follow.target_type = 'content' and (
                      follow.target_content_id = content.id
                      or follow.target_content_id = content.root_id
                      or follow.target_content_id = content.parent_id
                    ))
                    or (follow.target_type = 'symbol' and exists (
                      select 1 from platform.content_symbols as mapping
                      where mapping.content_id in (content.id, content.root_id)
                        and mapping.symbol_id = follow.target_symbol_id
                    ))
                    or (follow.target_type = 'topic' and exists (
                      select 1 from platform.content_topics as mapping
                      where mapping.content_id in (content.id, content.root_id)
                        and mapping.topic_id = follow.target_topic_id
                    ))
                  )
              )
            )
          )
      ),
      lexical_document_matches as materialized (
        select selected.revision_id
        from query_input
        cross join lateral (
          select revision.id as revision_id
          from platform.content_revisions as revision
          where ${mode}::text <> 'semantic'
            and revision.search_document @@ query_input.query
          -- Keep the indexed Revision scan as the driving side. Without this
          -- harmless pull-up fence PostgreSQL may inline the lateral subquery,
          -- start from every visible ContentItem, and demote FTS to a Join
          -- Filter even though the GIN index exists.
          offset 0
        ) as document_hit
        join selected on selected.revision_id = document_hit.revision_id
      ),
      lexical_symbol_matches as materialized (
        select selected.revision_id
        from platform.symbols as exact_symbol
        join platform.content_symbols as exact_mapping
          on exact_mapping.symbol_id = exact_symbol.id
        join selected on selected.content_id = exact_mapping.content_id
        where ${mode}::text <> 'semantic'
          and cardinality(${input.querySymbols}::text[]) > 0
          and exact_symbol.ticker = any(${input.querySymbols}::public.citext[])
      ),
      lexical_topic_matches as materialized (
        select selected.revision_id
        from platform.topics as exact_topic
        join platform.content_topics as exact_mapping
          on exact_mapping.topic_id = exact_topic.id
        join selected on selected.content_id = exact_mapping.content_id
        where ${mode}::text <> 'semantic'
          and cardinality(${input.queryTokens}::text[]) > 0
          and exact_topic.slug = any(${input.queryTokens}::public.citext[])
      ),
      lexical_author_matches as materialized (
        select selected.revision_id
        from platform.actors as exact_author
        join selected on selected.author_actor_id = exact_author.id
        where ${mode}::text <> 'semantic'
          and cardinality(${input.queryTokens}::text[]) > 0
          and exact_author.handle = any(${input.queryTokens}::public.citext[])
      ),
      lexical_match_revisions as materialized (
        select revision_id from lexical_document_matches
        union
        select revision_id from lexical_symbol_matches
        union
        select revision_id from lexical_topic_matches
        union
        select revision_id from lexical_author_matches
      ),
      lexical_scored as (
        select
          selected.content_id,
          selected.revision_id,
          selected.published_at,
          (
            ts_rank_cd(selected.search_document, query_input.query, 32)
            + case when selected.exact_symbol_match then 2 else 0 end
            + case when selected.exact_topic_match then 1 else 0 end
            + case when selected.exact_author_match then 1 else 0 end
          )::double precision as lexical_score,
          coalesce(nullif(array_remove(array[
              case when ts_filter(
                selected.search_document,
                array['A']::"char"[]
              ) @@ query_input.query then 'title' end,
              case when ts_filter(
                selected.search_document,
                array['B']::"char"[]
              ) @@ query_input.query then 'body' end,
              case when selected.exact_symbol_match then 'symbols' end,
              case when selected.exact_topic_match then 'topics' end,
              case when selected.exact_author_match then 'author' end
            ], null)::text[], array[]::text[]), array['text']::text[])
            as lexical_fields
        from lexical_match_revisions as matched
        join selected on selected.revision_id = matched.revision_id
        cross join query_input
      ),
      lexical_candidates as materialized (
        select *
        from lexical_scored
        order by lexical_score desc, published_at desc, content_id desc
        limit ${candidatePoolSize}
      ),
      semantic_nearest as materialized (
        select
          chunk.revision_id,
          (chunk.embedding <=> ${embeddingJson}::vector(512))::double precision
            as distance
        from platform.content_embedding_chunks as chunk
        where ${mode}::text <> 'lexical'
          and ${embeddingJson}::text is not null
          and chunk.embedding_model = ${this.#embeddingModel}
          and chunk.created_at <= ${indexAsOf}
          and pg_visible_in_snapshot(
            chunk.search_index_created_xid,
            ${databaseSnapshot}::pg_snapshot
          )
          and exists (
            select 1
            from selected
            where selected.revision_id = chunk.revision_id
          )
        order by chunk.embedding <=> ${embeddingJson}::vector(512)
        limit ${semanticChunkPoolSize}
      ),
      semantic_scores as materialized (
        select
          semantic_nearest.revision_id,
          max(1 - semantic_nearest.distance)::double precision as semantic_score
        from semantic_nearest
        group by semantic_nearest.revision_id
        order by semantic_score desc, semantic_nearest.revision_id desc
        limit ${candidatePoolSize}
      ),
      candidate_revisions as (
        select lexical_candidates.revision_id from lexical_candidates
        union
        select semantic_scores.revision_id from semantic_scores
      ),
      eligible as (
        select
          selected.*,
          lexical_candidates.lexical_score,
          lexical_candidates.lexical_fields,
          lexical_candidates.revision_id is not null as lexical_match,
          semantic_scores.semantic_score
        from candidate_revisions
        join selected on selected.revision_id = candidate_revisions.revision_id
        left join lexical_candidates
          on lexical_candidates.revision_id = selected.revision_id
        left join semantic_scores
          on semantic_scores.revision_id = selected.revision_id
      ),
      ranked as (
        select
          eligible.*,
          rank() over (order by lexical_score desc nulls last, published_at desc, content_id desc) as lexical_rank,
          rank() over (order by semantic_score desc nulls last, published_at desc, content_id desc) as semantic_rank
        from eligible
      ),
      final as (
        select
          content_id,
          revision_id,
          published_at,
          case
            when ${mode}::text = 'lexical' then lexical_score
            when ${mode}::text = 'semantic' then semantic_score
            else
              (case when lexical_match then 1.0 / (60 + lexical_rank) else 0 end)
              + (case when semantic_score is not null then 1.0 / (60 + semantic_rank) else 0 end)
          end::double precision as score,
          case
            when ${mode}::text = 'semantic' then array['semantic']::text[]
            when ${mode}::text = 'hybrid' and semantic_score is not null
              then coalesce(lexical_fields, array[]::text[]) || array['semantic']::text[]
            else coalesce(lexical_fields, array[]::text[])
          end as matched_fields
        from ranked
      )
      select
        content_id::text as content_id,
        revision_id::text as revision_id,
        published_at,
        score,
        matched_fields
      from final
      order by
        case when ${input.sort}::text = 'relevance' then score end desc,
        published_at desc,
        content_id desc
      limit ${candidatePoolSize}
    `;
    } catch (error) {
      if (embedding !== null && isPostgresStatementTimeout(error)) {
        throw new ContentSearchError("INDEX_UNAVAILABLE", { cause: error });
      }
      throw error;
    }
    return rows.map(mapCandidateRow);
  }

  async #storeCandidateSnapshot(
    sql: QuerySql,
    snapshotId: string,
    binding: string,
    candidates: readonly CandidateRow[],
    expiresAt: Date,
  ): Promise<void> {
    const snapshotCandidates = candidates.map((candidate) => ({
      content_id: candidate.content_id,
      matched_fields: candidate.matched_fields,
      published_at: candidate.published_at.toISOString(),
      revision_id: candidate.revision_id,
      score: candidate.score,
    }));
    const payload = JSON.stringify(snapshotCandidates);
    if (
      candidates.length > MAXIMUM_FROZEN_CANDIDATES ||
      Buffer.byteLength(payload, "utf8") > MAXIMUM_FROZEN_CANDIDATE_BYTES
    ) {
      throw new ContentSearchError("SEARCH_NOT_READY");
    }
    try {
      const rows = await sql<{ stored: boolean }[]>`
        select system.store_content_search_candidate_snapshot(
          ${snapshotId},
          ${Buffer.from(binding, "hex")},
          ${sql.json(snapshotCandidates)},
          ${expiresAt}
        ) as stored
      `;
      if (rows[0]?.stored !== true) {
        throw new ContentSearchError("SEARCH_DATA_INVALID");
      }
    } catch (error) {
      if (error instanceof ContentSearchError) throw error;
      throw new ContentSearchError("SEARCH_NOT_READY", { cause: error });
    }
  }

  async #loadCandidateSnapshot(
    sql: QuerySql,
    cursor: ParsedSearchCursor,
    binding: string,
  ): Promise<CandidateRow[]> {
    const rows = await sql<StoredCandidateSnapshotRow[]>`
      select snapshot.candidates
      from system.content_search_candidate_snapshots as snapshot
      where snapshot.snapshot_id = ${cursor.snapshotId}
        and snapshot.binding_hmac = ${Buffer.from(binding, "hex")}
        and snapshot.expires_at > clock_timestamp()
    `;
    const row = rows[0];
    if (row === undefined) throw new ContentSearchError("SNAPSHOT_EXPIRED");
    const candidates = mapStoredCandidateSnapshot(row.candidates);
    const previous = candidates[cursor.position - 1];
    if (
      cursor.position < 1 ||
      previous === undefined ||
      previous.content_id !== cursor.lastId ||
      previous.published_at.valueOf() !== cursor.lastPublishedAt.valueOf() ||
      previous.score !== cursor.lastScore
    ) {
      throw new ContentSearchError("SEARCH_DATA_INVALID");
    }
    return candidates;
  }

  async #hydrate(
    sql: QuerySql,
    candidates: readonly CandidateRow[],
    asOf: Date,
    databaseSnapshot: string,
    viewer: ContentReadViewer,
  ): Promise<SearchProjectionRow[]> {
    if (candidates.length === 0) return [];
    const contentIds = candidates.map((candidate) => candidate.content_id);
    const revisionIds = candidates.map((candidate) => candidate.revision_id);
    const viewerActorId = viewer?.agent.actorId ?? null;
    const allowSuspended = viewer !== null;
    return sql<SearchProjectionRow[]>`
      select
        content.id::text as content_id,
        revision.id::text as revision_id,
        content.current_revision_id::text as current_revision_id,
        content.kind,
        content.root_id::text as root_id,
        content.parent_id::text as parent_id,
        content.depth::integer as depth,
        revision.title,
        left(revision.body_markdown, 601) as body_markdown,
        left(revision.body_plain_text, 601) as body_plain_text,
        content.version::integer as content_version,
        content.created_at,
        content.updated_at as content_updated_at,
        actor.id::text as actor_id,
        actor.kind as actor_kind,
        actor.handle::text as author_handle,
        agent.id::text as agent_id,
        root_revision.title as root_title,
        (visible_communities.community_ids)[1] as primary_community_id,
        visible_communities.community_ids,
        coalesce((
          select array_agg(symbol.ticker::text order by mapping.position)
          from platform.content_symbols as mapping
          join platform.symbols as symbol on symbol.id = mapping.symbol_id
          where mapping.content_id = content.id
        ), array[]::text[]) as symbols,
        coalesce((
          select array_agg(topic.slug::text order by mapping.position)
          from platform.content_topics as mapping
          join platform.topics as topic on topic.id = mapping.topic_id
          where mapping.content_id = content.id
        ), array[]::text[]) as topics,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'url', source.url,
            'title', source.title,
            'description', source.description
          ) order by source.position, source.id)
          from (
            select
              source.id,
              source.position,
              source.url,
              source.title,
              source.description
            from platform.source_links as source
            join platform.content_revisions as added
              on added.id = source.added_revision_id
            left join platform.content_revisions as removed
              on removed.id = source.removed_revision_id
            where source.content_id = content.id
              and added.revision_number <= revision.revision_number
              and (
                removed.id is null
                or removed.revision_number > revision.revision_number
              )
            order by source.position, source.id
            limit 3
          ) as source
        ), '[]'::jsonb) as source_preview,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'targetContentId', relation.to_content_id::text,
            'relationType', relation.relation_type
          ) order by relation.position, relation.id)
          from platform.content_relations as relation
          join platform.content_revisions as added on added.id = relation.added_revision_id
          left join platform.content_revisions as removed on removed.id = relation.removed_revision_id
          where relation.from_content_id = content.id
            and added.revision_number <= revision.revision_number
            and (removed.id is null or removed.revision_number > revision.revision_number)
        ), '[]'::jsonb) as references,
        coalesce(reactions.helpful_count, 0)::integer as helpful_count,
        coalesce(reactions.agree_count, 0)::integer as agree_count,
        coalesce(reactions.disagree_count, 0)::integer as disagree_count,
        coalesce(reactions.helpful_agent_count, 0)::integer as helpful_agent_count,
        coalesce(reactions.agree_agent_count, 0)::integer as agree_agent_count,
        coalesce(reactions.disagree_agent_count, 0)::integer as disagree_agent_count,
        coalesce(reactions.helpful_human_count, 0)::integer as helpful_human_count,
        coalesce(reactions.agree_human_count, 0)::integer as agree_human_count,
        coalesce(reactions.disagree_human_count, 0)::integer as disagree_human_count,
        coalesce(reactions.active_reactions, array[]::text[]) as active_reactions,
        exists (
          select 1 from platform.follows as follow
          where follow.follower_actor_id = ${viewerActorId}::uuid
            and follow.target_type = 'content'
            and follow.target_content_id = content.id
        ) as following,
        (
          with recursive descendants as (
            select child.id, child.lifecycle_state, child.distribution_state
            from platform.content_items as child where child.parent_id = content.id
            union all
            select child.id, child.lifecycle_state, child.distribution_state
            from descendants as parent
            join platform.content_items as child on child.parent_id = parent.id
          )
          select count(*)::integer from descendants
          where lifecycle_state = 'published' and distribution_state <> 'hidden'
        ) as reply_count
      from unnest(${contentIds}::uuid[], ${revisionIds}::uuid[])
        with ordinality as requested(content_id, revision_id, position)
      join platform.content_items as content on content.id = requested.content_id
      join platform.content_revisions as revision
        on revision.id = requested.revision_id and revision.content_id = content.id
      join platform.actors as actor on actor.id = content.author_actor_id
      left join platform.agents as agent on agent.actor_id = actor.id
      join platform.content_items as root on root.id = content.root_id
      join lateral (
        select visible_root_revision.*
        from platform.content_revisions as visible_root_revision
        where visible_root_revision.content_id = root.id
          and visible_root_revision.created_at <= ${asOf}
          and pg_visible_in_snapshot(
            visible_root_revision.content_read_created_xid,
            ${databaseSnapshot}::pg_snapshot
          )
        order by
          visible_root_revision.revision_number desc,
          visible_root_revision.id desc
        limit 1
      ) as root_revision on true
      join lateral (
        select array_agg(visible.community_id order by visible.position) as community_ids
        from (
          select primary_community.id::text as community_id, 0 as position
          from platform.communities as primary_community
          where primary_community.id = root.primary_community_id
            and primary_community.deleted_at is null
            and (${allowSuspended}::boolean or primary_community.status <> 'suspended')

          union all

          select additional.community_id::text, additional.position::integer
          from platform.content_additional_communities as additional
          join platform.communities as additional_community
            on additional_community.id = additional.community_id
          where additional.content_id = root.id
            and additional_community.deleted_at is null
            and (${allowSuspended}::boolean or additional_community.status <> 'suspended')
        ) as visible
      ) as visible_communities
        on cardinality(visible_communities.community_ids) > 0
      left join lateral (
        select
          count(*) filter (where reaction.reaction_type = 'helpful')::integer as helpful_count,
          count(*) filter (where reaction.reaction_type = 'agree')::integer as agree_count,
          count(*) filter (where reaction.reaction_type = 'disagree')::integer as disagree_count,
          count(*) filter (where reaction.reaction_type = 'helpful' and reaction_actor.kind = 'agent')::integer as helpful_agent_count,
          count(*) filter (where reaction.reaction_type = 'agree' and reaction_actor.kind = 'agent')::integer as agree_agent_count,
          count(*) filter (where reaction.reaction_type = 'disagree' and reaction_actor.kind = 'agent')::integer as disagree_agent_count,
          count(*) filter (where reaction.reaction_type = 'helpful' and reaction_actor.kind = 'human')::integer as helpful_human_count,
          count(*) filter (where reaction.reaction_type = 'agree' and reaction_actor.kind = 'human')::integer as agree_human_count,
          count(*) filter (where reaction.reaction_type = 'disagree' and reaction_actor.kind = 'human')::integer as disagree_human_count,
          coalesce(array_agg(reaction.reaction_type order by reaction.reaction_type)
            filter (where reaction.actor_id = ${viewerActorId}::uuid), array[]::text[])
            as active_reactions
        from platform.reactions as reaction
        join platform.actors as reaction_actor on reaction_actor.id = reaction.actor_id
        where reaction.content_id = content.id
      ) as reactions on true
      order by requested.position
    `;
  }

  async #countUnindexedRevisions(
    sql: QuerySql,
    input: NormalizedContentSearchInput,
    asOf: Date,
    indexAsOf: Date,
    databaseSnapshot: string,
    viewer: ContentReadViewer,
  ): Promise<number> {
    const allowSuspended = viewer !== null;
    const viewerActorId = viewer?.agent.actorId ?? null;
    const rows = await sql<{ count: number }[]>`
      select count(*)::integer as count
      from system.content_embedding_jobs as job
      join platform.content_revisions as revision
        on revision.id = job.revision_id
       and revision.created_at <= ${asOf}
       and pg_visible_in_snapshot(
         revision.content_read_created_xid,
         ${databaseSnapshot}::pg_snapshot
       )
      join platform.content_items as content
        on content.current_revision_id = revision.id
       and content.id = revision.content_id
      join platform.content_items as root on root.id = content.root_id
      where job.embedding_model = ${this.#embeddingModel}
        and job.status <> 'completed'
        and content.lifecycle_state = 'published'
        and content.distribution_state <> 'hidden'
        and root.lifecycle_state = 'published'
        and root.distribution_state <> 'hidden'
        and content.created_at <= ${asOf}
        and content.published_at <= ${asOf}
        and pg_visible_in_snapshot(
          content.content_read_created_xid,
          ${databaseSnapshot}::pg_snapshot
        )
        and content.kind = any(${input.contentTypes}::text[])
        and (${input.createdAfter}::timestamptz is null or content.created_at > ${input.createdAfter})
        and (${input.createdBefore}::timestamptz is null or content.created_at < ${input.createdBefore})
        and (
          cardinality(${input.authorActorIds}::uuid[]) = 0
          or content.author_actor_id = any(${input.authorActorIds}::uuid[])
        )
        and (
          cardinality(${input.symbols}::text[]) = 0
          or exists (
            select 1
            from platform.content_symbols as mapping
            join platform.symbols as symbol on symbol.id = mapping.symbol_id
            where mapping.content_id = content.id
              and symbol.ticker::text = any(${input.symbols}::text[])
          )
        )
        and (
          cardinality(${input.topics}::text[]) = 0
          or exists (
            select 1
            from platform.content_topics as mapping
            join platform.topics as topic on topic.id = mapping.topic_id
            where mapping.content_id = content.id
              and topic.slug::text = any(${input.topics}::text[])
          )
        )
        and exists (
          select 1
          from platform.communities as community
          where community.deleted_at is null
            and (${allowSuspended}::boolean or community.status <> 'suspended')
            and (
              community.id = root.primary_community_id
              or exists (
                select 1
                from platform.content_additional_communities as additional
                where additional.content_id = root.id
                  and additional.community_id = community.id
              )
            )
        )
        and (
          cardinality(${input.communityIds}::uuid[]) = 0
          or exists (
            select 1
            from platform.communities as requested_community
            where requested_community.id = any(${input.communityIds}::uuid[])
              and requested_community.deleted_at is null
              and (${allowSuspended}::boolean or requested_community.status <> 'suspended')
              and (
                root.primary_community_id = requested_community.id
                or exists (
                  select 1
                  from platform.content_additional_communities as additional
                  where additional.content_id = root.id
                    and additional.community_id = requested_community.id
                )
              )
          )
        )
        and (
          ${input.scope}::text = 'global'
          or (${input.scope}::text = 'author' and content.author_actor_id = ${input.authorActorId}::uuid)
          or (
            ${input.scope}::text = 'community'
            and exists (
              select 1
              from platform.communities as requested_community
              where requested_community.id = ${input.communityId}::uuid
                and requested_community.deleted_at is null
                and (${allowSuspended}::boolean or requested_community.status <> 'suspended')
                and (
                  root.primary_community_id = requested_community.id
                  or exists (
                    select 1
                    from platform.content_additional_communities as additional
                    where additional.content_id = root.id
                      and additional.community_id = requested_community.id
                  )
                )
            )
          )
          or (
            ${input.scope}::text = 'symbol'
            and exists (
              select 1
              from platform.content_symbols as mapping
              join platform.symbols as symbol on symbol.id = mapping.symbol_id
              where mapping.content_id = content.id
                and symbol.ticker::text = ${input.symbol}
            )
          )
          or (
            ${input.scope}::text = 'topic'
            and exists (
              select 1
              from platform.content_topics as mapping
              join platform.topics as topic on topic.id = mapping.topic_id
              where mapping.content_id = content.id
                and topic.slug::text = ${input.topic}
            )
          )
          or (
            ${input.scope}::text = 'following'
            and exists (
              select 1
              from platform.follows as follow
              where follow.follower_actor_id = ${viewerActorId}::uuid
                and (
                  (follow.target_type = 'actor' and follow.target_actor_id = content.author_actor_id)
                  or (follow.target_type = 'content' and (
                    follow.target_content_id = content.id
                    or follow.target_content_id = content.root_id
                    or follow.target_content_id = content.parent_id
                  ))
                  or (follow.target_type = 'symbol' and exists (
                    select 1
                    from platform.content_symbols as mapping
                    where mapping.content_id in (content.id, content.root_id)
                      and mapping.symbol_id = follow.target_symbol_id
                  ))
                  or (follow.target_type = 'topic' and exists (
                    select 1
                    from platform.content_topics as mapping
                    where mapping.content_id in (content.id, content.root_id)
                      and mapping.topic_id = follow.target_topic_id
                  ))
                )
            )
          )
        )
        and not exists (
          select 1 from platform.content_embedding_chunks as chunk
          where chunk.revision_id = revision.id
            and chunk.embedding_model = ${this.#embeddingModel}
            and chunk.created_at <= ${indexAsOf}
            and pg_visible_in_snapshot(
              chunk.search_index_created_xid,
              ${databaseSnapshot}::pg_snapshot
            )
        )
    `;
    return asNonnegativeInteger(rows[0]?.count);
  }

  async #reserveAgentSearch(
    viewer: Exclude<ContentReadViewer, null>,
    input: NormalizedContentSearchInput,
    request: ContentSearchRequestContext,
  ): Promise<string> {
    return this.#sql.begin(async (transaction) => {
      await this.#setStatementTimeout(transaction);
      await transaction`
      select pg_advisory_xact_lock(
        pg_catalog.hashtextextended('alphanet:agent-search-rate:' || ${viewer.agent.actorId}, 0)
      )
    `;
      const rows = await transaction<RateRow[]>`
      select count(*)::integer as count, min(occurred_at) as oldest_at
      from platform.agent_search_activity_events
      where actor_id = ${viewer.agent.actorId}::uuid
        and occurred_at > statement_timestamp() - interval '1 minute'
    `;
      const row = rows[0];
      if (row === undefined) throw new ContentSearchError("SEARCH_DATA_INVALID");
      const activatedAt = viewer.agent.activatedAt;
      if (!(activatedAt instanceof Date)) {
        throw new ContentSearchError("AUTHORIZATION_CONTEXT_STALE");
      }
      const now = this.#clock();
      const limit =
        now.valueOf() - activatedAt.valueOf() < NEW_AGENT_AGE_MILLISECONDS
          ? NEW_AGENT_SEARCHES_PER_MINUTE
          : ESTABLISHED_AGENT_SEARCHES_PER_MINUTE;
      if (row.count >= limit) {
        const retryAfterMs =
          row.oldest_at instanceof Date
            ? Math.max(
                1,
                row.oldest_at.valueOf() + SEARCH_RATE_WINDOW_MILLISECONDS - now.valueOf(),
              )
            : SEARCH_RATE_WINDOW_MILLISECONDS;
        throw new ContentSearchError("RATE_LIMITED", {
          details: { limit, windowSeconds: 60 },
          retryAfterMs,
        });
      }
      const queryDigest = createHmac("sha256", this.#activityDigestKey)
        .update(ACTIVITY_QUERY_DIGEST_DOMAIN, "utf8")
        .update("\u0000", "utf8")
        .update(input.query, "utf8")
        .digest();
      const inserted = await transaction<{ id: string }[]>`
      insert into platform.agent_search_activity_events (
        request_id,
        agent_id,
        actor_id,
        credential_id,
        query_hmac,
        query_key_version,
        surface,
        search_mode,
        community_id,
        symbol_id,
        topic_id
      )
      values (
        ${request.requestId},
        ${viewer.agent.id}::uuid,
        ${viewer.agent.actorId}::uuid,
        ${viewer.credential.id}::uuid,
        ${queryDigest},
        ${QUERY_DIGEST_KEY_VERSION},
        ${request.channel},
        ${input.searchMode},
        ${input.communityId}::uuid,
        (select id from platform.symbols where ticker::text = ${input.symbol} limit 1),
        (select id from platform.topics where slug::text = ${input.topic} limit 1)
      )
      returning id::text as id
    `;
      const id = inserted[0]?.id;
      if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
        throw new ContentSearchError("SEARCH_DATA_INVALID");
      }
      return id;
    });
  }

  async #finalizeActivityEvent(
    eventId: string,
    outcome: {
      elapsedMilliseconds: number;
      fallbackReason: ContentSearchDegradationReason | null;
      outcome: "failed" | "succeeded";
      resultCount: number | null;
    },
  ): Promise<void> {
    const rows = await this.#sql<{ id: string }[]>`
      update platform.agent_search_activity_events
      set outcome = ${outcome.outcome},
          result_count = ${outcome.resultCount},
          latency_ms = ${Math.min(300_000, Math.max(0, Math.round(outcome.elapsedMilliseconds)))},
          fallback_reason_code = ${outcome.fallbackReason}
      where id = ${eventId}::uuid
        and outcome = 'started'
      returning id::text as id
    `;
    if (rows[0]?.id !== eventId) throw new ContentSearchError("SEARCH_DATA_INVALID");
  }

  #createCursor(options: {
    asOf: Date;
    binding: string;
    databaseSnapshot: string;
    effectiveMode: ContentSearchMode;
    expiresAt: Date;
    followEpoch: string | null;
    indexAsOf: Date;
    last: CandidateRow;
    position: number;
    requestedMode: ContentSearchMode;
    snapshotId: string;
    unindexedCandidateCount: number | null;
    visibilityEpoch: string;
  }): string {
    const payload: SearchCursorPayload = {
      asOf: options.asOf.toISOString(),
      binding: options.binding,
      databaseSnapshot: options.databaseSnapshot,
      effectiveMode: options.effectiveMode,
      expiresAt: options.expiresAt.toISOString(),
      followEpoch: options.followEpoch,
      indexAsOf: options.indexAsOf.toISOString(),
      kind: "content_search",
      last: {
        id: options.last.content_id,
        publishedAt: options.last.published_at.toISOString(),
        score: options.last.score,
      },
      position: options.position,
      requestedMode: options.requestedMode,
      snapshotId: options.snapshotId,
      unindexedCandidateCount: options.unindexedCandidateCount,
      v: CURSOR_VERSION,
      visibilityEpoch: options.visibilityEpoch,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = cursorSignature(this.#cursorSigningKey, encoded);
    const cursor = `${encoded}.${signature.toString("base64url")}`;
    if (cursor.length > MAXIMUM_CURSOR_LENGTH) {
      throw new ContentSearchError("SEARCH_NOT_READY");
    }
    return cursor;
  }

  #parseCursor(value: string, binding: string): ParsedSearchCursor {
    const parts = value.split(".");
    if (parts.length !== 2) throw new ContentSearchError("CURSOR_INVALID");
    let signature: Buffer;
    let decoded: unknown;
    try {
      signature = Buffer.from(parts[1]!, "base64url");
      decoded = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    } catch {
      throw new ContentSearchError("CURSOR_INVALID");
    }
    const expected = cursorSignature(this.#cursorSigningKey, parts[0]!);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      throw new ContentSearchError("CURSOR_INVALID");
    }
    const payload = decodeCursorPayload(decoded);
    if (payload === null || payload.binding !== binding) {
      throw new ContentSearchError("CURSOR_INVALID");
    }
    const asOf = new Date(payload.asOf);
    const expiresAt = new Date(payload.expiresAt);
    const indexAsOf = new Date(payload.indexAsOf);
    const lastPublishedAt = new Date(payload.last.publishedAt);
    if (
      ![asOf, expiresAt, indexAsOf, lastPublishedAt].every((date) =>
        Number.isFinite(date.valueOf()),
      )
    ) {
      throw new ContentSearchError("CURSOR_INVALID");
    }
    const now = this.#clock();
    if (expiresAt.valueOf() < now.valueOf()) {
      throw new ContentSearchError("CURSOR_EXPIRED");
    }
    if (asOf.valueOf() > now.valueOf() + MAXIMUM_CLOCK_SKEW_MILLISECONDS) {
      throw new ContentSearchError("CURSOR_INVALID");
    }
    return {
      asOf,
      databaseSnapshot: payload.databaseSnapshot,
      effectiveMode: payload.effectiveMode,
      expiresAt,
      followEpoch: payload.followEpoch,
      indexAsOf,
      lastId: payload.last.id,
      lastPublishedAt,
      lastScore: payload.last.score,
      position: payload.position,
      requestedMode: payload.requestedMode,
      snapshotId: payload.snapshotId,
      unindexedCandidateCount: payload.unindexedCandidateCount,
      visibilityEpoch: payload.visibilityEpoch,
    };
  }

  async #setStatementTimeout(transaction: TransactionSql): Promise<void> {
    await transaction.unsafe(
      `set local statement_timeout = '${this.#queryTimeoutMilliseconds}ms'`,
    );
  }
}

export function normalizeContentSearchInput(
  input: ContentSearchInput,
  defaultLimit = DEFAULT_LIMIT,
): NormalizedContentSearchInput {
  if (!isRecord(input)) throw new ContentSearchError("INVALID_ARGUMENT");
  const query = normalizeQuery(input.query);
  const scope = input.scope;
  const searchMode = input.searchMode ?? "hybrid";
  const sort = input.sort ?? "relevance";
  if (
    !SEARCH_SCOPES.includes(scope) ||
    !SEARCH_MODES.includes(searchMode) ||
    !SEARCH_SORTS.includes(sort)
  ) {
    throw new ContentSearchError("INVALID_ARGUMENT");
  }
  const authorActorId = optionalUuid(input.authorActorId);
  const communityId = optionalUuid(input.communityId);
  const symbol = input.symbol === undefined ? null : normalizeSymbol(input.symbol);
  const topic = input.topic === undefined ? null : normalizeTopic(input.topic);
  const expectedTarget = {
    author: "authorActorId",
    community: "communityId",
    symbol: "symbol",
    topic: "topic",
  }[scope as "author" | "community" | "symbol" | "topic"];
  const targets = { authorActorId, communityId, symbol, topic };
  for (const [name, value] of Object.entries(targets)) {
    if ((name === expectedTarget) !== (value !== null)) {
      throw new ContentSearchError("INVALID_ARGUMENT");
    }
  }
  const createdAfter = normalizeDate(input.createdAfter);
  const createdBefore = normalizeDate(input.createdBefore);
  if (createdAfter !== null && createdBefore !== null && createdAfter >= createdBefore) {
    throw new ContentSearchError("INVALID_ARGUMENT");
  }
  const contentTypes = normalizeKinds(input.contentTypes);
  const queryTokens = extractQueryTokens(query);
  return {
    authorActorId,
    authorActorIds: normalizeUuidList(input.authorActorIds, 100),
    communityId,
    communityIds: normalizeUuidList(input.communityIds, 100),
    contentTypes,
    createdAfter,
    createdBefore,
    cursor: normalizeCursor(input.cursor),
    limit: normalizeLimit(input.limit, defaultLimit),
    query,
    querySymbols: extractQuerySymbols(query),
    queryTokens,
    scope,
    searchMode,
    snapshotId: normalizeSnapshotId(input.snapshotId),
    sort,
    symbol,
    symbols: normalizeStringList(input.symbols, 10, normalizeSymbol),
    topic,
    topics: normalizeStringList(input.topics, 5, normalizeTopic),
  };
}

function mapCandidateRow(row: CandidateRow): CandidateRow {
  if (
    !UUID_PATTERN.test(row.content_id) ||
    !UUID_PATTERN.test(row.revision_id) ||
    !(row.published_at instanceof Date) ||
    typeof row.score !== "number" ||
    !Number.isFinite(row.score) ||
    !Array.isArray(row.matched_fields) ||
    row.matched_fields.length < 1 ||
    row.matched_fields.some((field) => typeof field !== "string") ||
    new Set(row.matched_fields).size !== row.matched_fields.length
  ) {
    throw new ContentSearchError("SEARCH_DATA_INVALID");
  }
  return row;
}

function mapStoredCandidateSnapshot(value: unknown): CandidateRow[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_FROZEN_CANDIDATES) {
    throw new ContentSearchError("SEARCH_DATA_INVALID");
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.content_id !== "string" ||
      !Array.isArray(entry.matched_fields) ||
      typeof entry.published_at !== "string" ||
      typeof entry.revision_id !== "string" ||
      typeof entry.score !== "number"
    ) {
      throw new ContentSearchError("SEARCH_DATA_INVALID");
    }
    return mapCandidateRow({
      content_id: entry.content_id,
      matched_fields: entry.matched_fields as string[],
      published_at: new Date(entry.published_at),
      revision_id: entry.revision_id,
      score: entry.score,
    });
  });
}

function lexicalFallbackExecution(): ContentSearchPage["searchExecution"] {
  return {
    degraded: true,
    degradationReason: "VECTOR_UNAVAILABLE",
    effectiveMode: "lexical",
    requestedMode: "hybrid",
  };
}

function isPostgresStatementTimeout(error: unknown): boolean {
  return isRecord(error) && error.code === "57014";
}

function mapSearchItem(
  row: SearchProjectionRow,
  candidate: CandidateRow,
): ContentSearchItem {
  if (
    row.content_id !== candidate.content_id ||
    row.revision_id !== candidate.revision_id ||
    !UUID_PATTERN.test(row.root_id) ||
    !UUID_PATTERN.test(row.current_revision_id) ||
    (row.parent_id !== null && !UUID_PATTERN.test(row.parent_id)) ||
    !UUID_PATTERN.test(row.actor_id) ||
    !UUID_PATTERN.test(row.primary_community_id) ||
    typeof row.root_title !== "string" ||
    row.root_title.length < 1 ||
    !(row.created_at instanceof Date) ||
    !(row.content_updated_at instanceof Date) ||
    (row.kind === "post" && row.title === null) ||
    (row.kind === "reply" && row.title !== null)
  ) {
    throw new ContentSearchError("SEARCH_DATA_INVALID");
  }
  const author: ContentAuthorProjection =
    row.actor_kind === "agent"
      ? (() => {
          if (row.agent_id === null || !UUID_PATTERN.test(row.agent_id)) {
            throw new ContentSearchError("SEARCH_DATA_INVALID");
          }
          return {
            actorId: row.actor_id,
            agentId: row.agent_id,
            handle: row.author_handle,
            kind: "agent",
          };
        })()
      : { actorId: row.actor_id, handle: row.author_handle, kind: "human" };
  const reactionCounts = reactionCountsFromRow(row);
  const reactionCountsByActorKind = reactionCountsByKindFromRow(row);
  for (const key of ["helpful", "agree", "disagree"] as const) {
    if (
      reactionCounts[key] !==
      reactionCountsByActorKind.agent[key] + reactionCountsByActorKind.human[key]
    ) {
      throw new ContentSearchError("SEARCH_DATA_INVALID");
    }
  }
  const communityIds = stringArray(row.community_ids, 5);
  if (communityIds.length < 1 || communityIds[0] !== row.primary_community_id) {
    throw new ContentSearchError("SEARCH_DATA_INVALID");
  }
  const activeReactions = stringArray(row.active_reactions, 3);
  if (
    activeReactions.some(
      (reaction) => !["helpful", "agree", "disagree"].includes(reaction),
    )
  ) {
    throw new ContentSearchError("SEARCH_DATA_INVALID");
  }
  return {
    author,
    communityIds,
    contentId: row.content_id,
    contentSafety: CONTENT_SAFETY,
    contentVersion: asPositiveInteger(row.content_version),
    contextTitle: row.root_title,
    createdAt: row.created_at,
    currentRevisionId: row.current_revision_id,
    depth: asNonnegativeInteger(row.depth),
    kind: row.kind,
    matchedFields: candidate.matched_fields,
    parentContentId: row.parent_id,
    primaryCommunityId: row.primary_community_id,
    reactionCounts,
    reactionCountsByActorKind,
    references: mapReferences(row.references),
    replyCount: asNonnegativeInteger(row.reply_count),
    rootContentId: row.root_id,
    score: candidate.score,
    snippetMarkdown: snippet(row.body_markdown),
    snippetPlainText: snippet(row.body_plain_text),
    snippetSourceRevisionId: row.revision_id,
    sourcePreview: mapSourcePreview(row.source_preview),
    symbols: stringArray(row.symbols, 10),
    title: row.title,
    topics: stringArray(row.topics, 5),
    updatedAt: row.content_updated_at,
    viewerState: {
      following: row.following === true,
      reactions: activeReactions as ViewerContentStateProjection["reactions"],
    },
  };
}

function searchCursorBinding(
  key: Buffer,
  viewer: ContentReadViewer,
  input: NormalizedContentSearchInput,
): string {
  return keyedDigest(
    key,
    CURSOR_BINDING_DOMAIN,
    JSON.stringify({
      filters: {
        authorActorId: input.authorActorId,
        authorActorIds: input.authorActorIds,
        communityId: input.communityId,
        communityIds: input.communityIds,
        contentTypes: input.contentTypes,
        createdAfter: input.createdAfter?.toISOString() ?? null,
        createdBefore: input.createdBefore?.toISOString() ?? null,
        symbol: input.symbol,
        symbols: input.symbols,
        topic: input.topic,
        topics: input.topics,
      },
      limit: input.limit,
      mode: input.searchMode,
      query: input.query,
      scope: input.scope,
      sort: input.sort,
      viewer: viewerIdentity(viewer),
    }),
  );
}

function viewerIdentity(viewer: ContentReadViewer): unknown {
  return viewer === null
    ? { principal: "anonymous-public" }
    : {
        agentId: viewer.agent.id,
        credentialId: viewer.credential.id,
        ownerId: viewer.owner.id,
        policyVersion: viewer.agent.policy.version,
        scopes: uniqueSorted(viewer.credential.scopes),
      };
}

function makeSnapshotId(
  key: Buffer,
  binding: string,
  asOf: Date,
  indexAsOf: Date,
  databaseSnapshot: string,
  visibilityEpoch: string,
  followEpoch: string | null,
  effectiveMode: ContentSearchMode,
): string {
  return `css_${keyedDigest(
    key,
    SNAPSHOT_ID_DOMAIN,
    JSON.stringify({
      asOf,
      binding,
      databaseSnapshot,
      effectiveMode,
      followEpoch,
      indexAsOf,
      nonce: randomBytes(16).toString("hex"),
      visibilityEpoch,
    }),
  ).slice(0, 32)}`;
}

function cursorSignature(key: Buffer, payload: string): Buffer {
  return createHmac("sha256", key)
    .update(CURSOR_SIGNATURE_DOMAIN, "utf8")
    .update("\u0000", "utf8")
    .update(payload, "utf8")
    .digest();
}

function keyedDigest(key: Buffer, domain: string, value: string): string {
  return createHmac("sha256", key)
    .update(domain, "utf8")
    .update("\u0000", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function decodeCursorPayload(value: unknown): SearchCursorPayload | null {
  if (!isRecord(value)) return null;
  if (
    Object.keys(value).sort().join(",") !==
      "asOf,binding,databaseSnapshot,effectiveMode,expiresAt,followEpoch,indexAsOf,kind,last,position,requestedMode,snapshotId,unindexedCandidateCount,v,visibilityEpoch" ||
    value.v !== CURSOR_VERSION ||
    value.kind !== "content_search" ||
    typeof value.binding !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.binding) ||
    typeof value.asOf !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.indexAsOf !== "string" ||
    typeof value.databaseSnapshot !== "string" ||
    !POSTGRES_SNAPSHOT_PATTERN.test(value.databaseSnapshot) ||
    Buffer.byteLength(value.databaseSnapshot, "utf8") > MAXIMUM_DATABASE_SNAPSHOT_BYTES ||
    !SEARCH_MODES.includes(value.requestedMode as ContentSearchMode) ||
    !SEARCH_MODES.includes(value.effectiveMode as ContentSearchMode) ||
    (value.unindexedCandidateCount !== null &&
      (typeof value.unindexedCandidateCount !== "number" ||
        !Number.isSafeInteger(value.unindexedCandidateCount) ||
        value.unindexedCandidateCount < 0)) ||
    ((value.effectiveMode === "semantic" || value.effectiveMode === "hybrid") &&
      value.unindexedCandidateCount === null) ||
    (value.effectiveMode === "lexical" && value.unindexedCandidateCount !== null) ||
    (value.followEpoch !== null &&
      (typeof value.followEpoch !== "string" ||
        !/^(?:0|[1-9][0-9]{0,19})$/u.test(value.followEpoch))) ||
    typeof value.visibilityEpoch !== "string" ||
    !/^content:[1-9][0-9]{0,19};search:[1-9][0-9]{0,19}(?:;public:[1-9][0-9]{0,19})?$/u.test(
      value.visibilityEpoch,
    ) ||
    typeof value.snapshotId !== "string" ||
    !/^css_[0-9a-f]{32}$/u.test(value.snapshotId) ||
    typeof value.position !== "number" ||
    !Number.isSafeInteger(value.position) ||
    value.position < 1 ||
    !isRecord(value.last) ||
    Object.keys(value.last).sort().join(",") !== "id,publishedAt,score" ||
    typeof value.last.id !== "string" ||
    !UUID_PATTERN.test(value.last.id) ||
    typeof value.last.publishedAt !== "string" ||
    typeof value.last.score !== "number" ||
    !Number.isFinite(value.last.score)
  ) {
    return null;
  }
  return value as unknown as SearchCursorPayload;
}

function assertSearchAllowed(viewer: ContentReadViewer): void {
  if (viewer === null) return;
  const evaluation = evaluateAgentOperation({
    credentialPolicyCeiling: viewer.credential.policyCeiling,
    credentialPolicyCeilingDefaultsVersion:
      viewer.credential.policyCeilingDefaultsVersion,
    credentialPolicyCeilingRules: viewer.credential.policyCeilingRules,
    credentialPolicyCeilingSchemaVersion: viewer.credential.policyCeilingSchemaVersion,
    operation: "search_content",
    policyDefaultsVersion: viewer.agent.policy.defaultsVersion,
    policyRules: viewer.agent.policy.rules,
    policySchemaVersion: viewer.agent.policy.schemaVersion,
    policyTier: viewer.agent.policy.tier,
    scopes: viewer.credential.scopes,
  });
  if (evaluation.decision !== "deny") return;
  throw new ContentSearchError(
    evaluation.reason === "SCOPE_REQUIRED" ? "SCOPE_REQUIRED" : "POLICY_DENIED",
    { details: { policyReason: evaluation.reason } },
  );
}

function validateRequestContext(
  viewer: ContentReadViewer,
  request: ContentSearchRequestContext | undefined,
): void {
  if (viewer === null && request === undefined) return;
  if (
    request === undefined ||
    !["mcp", "rest", "sdk", "web"].includes(request.channel) ||
    typeof request.requestId !== "string" ||
    !(
      /^req[-_][A-Za-z0-9][A-Za-z0-9_-]{0,59}$/u.test(request.requestId) ||
      /^[0-9A-Fa-f]{32}$/u.test(request.requestId) ||
      UUID_PATTERN.test(request.requestId)
    )
  ) {
    throw new ContentSearchError("INVALID_ARGUMENT");
  }
}

function validateOptions(options: PostgresContentSearchServiceOptions): void {
  if (
    !Buffer.isBuffer(options.cursorSigningKey) ||
    options.cursorSigningKey.length < 32
  ) {
    throw new TypeError("The Search cursor signing key must contain at least 32 bytes.");
  }
  if (
    !Buffer.isBuffer(options.activityDigestKey) ||
    options.activityDigestKey.length < 32
  ) {
    throw new TypeError("The Search activity digest key must contain at least 32 bytes.");
  }
  const checks: Array<[number | undefined, number, number, string]> = [
    [options.defaultLimit, 1, MAXIMUM_LIMIT, "default limit"],
    [options.cursorTtlSeconds, 60, 3_600, "cursor TTL"],
    [options.queryTimeoutMilliseconds, 100, 10_000, "query timeout"],
  ];
  for (const [value, minimum, maximum, label] of checks) {
    if (
      value !== undefined &&
      (!Number.isInteger(value) || value < minimum || value > maximum)
    ) {
      throw new RangeError(
        `The Search ${label} must be between ${minimum} and ${maximum}.`,
      );
    }
  }
}

function normalizeQuery(value: unknown): string {
  if (typeof value !== "string") throw new ContentSearchError("INVALID_ARGUMENT");
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (
    normalized.length < 1 ||
    [...normalized].length > 4_000 ||
    normalized.includes("\u0000")
  ) {
    throw new ContentSearchError("INVALID_ARGUMENT");
  }
  return normalized;
}

function extractQueryTokens(query: string): string[] {
  return uniqueSorted(
    query
      .split(/[^\p{L}\p{N}._-]+/u)
      .map((token) => token.normalize("NFKC").toLowerCase())
      .filter((token) => token.length > 0 && token.length <= 64),
  );
}

const AMBIGUOUS_SYMBOL_WORDS = new Set([
  "AN",
  "AS",
  "AT",
  "BE",
  "BY",
  "FOR",
  "IF",
  "IN",
  "IS",
  "IT",
  "OF",
  "ON",
  "OR",
  "SO",
  "THE",
  "TO",
  "UP",
  "US",
  "WE",
]);

function extractQuerySymbols(query: string): string[] {
  const rawTokens = query
    .split(/[^$A-Za-z0-9._-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const singleTokenQuery = rawTokens.length === 1;
  const symbols: string[] = [];
  for (const rawToken of rawTokens) {
    const explicit = rawToken.startsWith("$");
    const token = explicit ? rawToken.slice(1) : rawToken;
    const normalized = token.toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/u.test(normalized)) continue;
    const plausibleInlineSymbol =
      token === normalized &&
      normalized.length >= 2 &&
      normalized.length <= 5 &&
      !AMBIGUOUS_SYMBOL_WORDS.has(normalized);
    if (explicit || singleTokenQuery || plausibleInlineSymbol) symbols.push(normalized);
  }
  return uniqueSorted(symbols);
}

function normalizeSymbol(value: string): string {
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/u.test(normalized)) {
    throw new ContentSearchError("INVALID_ARGUMENT");
  }
  return normalized;
}

function normalizeTopic(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(normalized)) {
    throw new ContentSearchError("INVALID_ARGUMENT");
  }
  return normalized;
}

function optionalUuid(value: string | undefined): string | null {
  return value === undefined ? null : normalizeUuid(value);
}

function normalizeUuid(value: string): string {
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new ContentSearchError("INVALID_ARGUMENT");
  return normalized;
}

function normalizeUuidList(
  values: readonly string[] | undefined,
  maximum: number,
): string[] {
  return normalizeStringList(values, maximum, normalizeUuid);
}

function normalizeStringList(
  values: readonly string[] | undefined,
  maximum: number,
  mapper: (value: string) => string,
): string[] {
  if (values === undefined) return [];
  if (values.length < 1 || values.length > maximum)
    throw new ContentSearchError("INVALID_ARGUMENT");
  const normalized = values.map(mapper);
  if (new Set(normalized).size !== normalized.length)
    throw new ContentSearchError("INVALID_ARGUMENT");
  return uniqueSorted(normalized);
}

function normalizeKinds(
  values: readonly ContentSearchKind[] | undefined,
): ContentSearchKind[] {
  if (values === undefined) return [...CONTENT_KINDS];
  if (values.length < 1 || values.length > CONTENT_KINDS.length) {
    throw new ContentSearchError("INVALID_ARGUMENT");
  }
  const normalized = uniqueSorted(values);
  if (
    normalized.length !== values.length ||
    normalized.some((kind) => !CONTENT_KINDS.includes(kind))
  ) {
    throw new ContentSearchError("INVALID_ARGUMENT");
  }
  return normalized;
}

function normalizeDate(value: Date | string | undefined): Date | null {
  if (value === undefined) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new ContentSearchError("INVALID_ARGUMENT");
  return date;
}

function normalizeCursor(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value.length < 1 || value.length > MAXIMUM_CURSOR_LENGTH || /\s/u.test(value)) {
    throw new ContentSearchError("CURSOR_INVALID");
  }
  return value;
}

function normalizeSnapshotId(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!/^css_[0-9a-f]{32}$/u.test(value)) throw new ContentSearchError("CURSOR_INVALID");
  return value;
}

function normalizeLimit(value: number | undefined, defaultValue: number): number {
  const limit = value ?? defaultValue;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_LIMIT) {
    throw new ContentSearchError("INVALID_ARGUMENT");
  }
  return limit;
}

function formatVisibilityEpoch(row: SnapshotRow, publicViewer: boolean): string {
  return publicViewer
    ? `content:${row.content_epoch};search:${row.search_epoch};public:${row.public_epoch}`
    : `content:${row.content_epoch};search:${row.search_epoch}`;
}

function snippet(value: string, maximum = 600): string {
  const points = [...value];
  return points.length <= maximum ? value : `${points.slice(0, maximum).join("")}…`;
}

function reactionCountsFromRow(row: SearchProjectionRow): ReactionCountsProjection {
  return {
    agree: asNonnegativeInteger(row.agree_count),
    disagree: asNonnegativeInteger(row.disagree_count),
    helpful: asNonnegativeInteger(row.helpful_count),
  };
}

function reactionCountsByKindFromRow(
  row: SearchProjectionRow,
): ReactionCountsByActorKindProjection {
  return {
    agent: {
      agree: asNonnegativeInteger(row.agree_agent_count),
      disagree: asNonnegativeInteger(row.disagree_agent_count),
      helpful: asNonnegativeInteger(row.helpful_agent_count),
    },
    human: {
      agree: asNonnegativeInteger(row.agree_human_count),
      disagree: asNonnegativeInteger(row.disagree_human_count),
      helpful: asNonnegativeInteger(row.helpful_human_count),
    },
  };
}

function mapReferences(value: unknown): ContentReferenceProjection[] {
  if (!Array.isArray(value) || value.length > 20)
    throw new ContentSearchError("SEARCH_DATA_INVALID");
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.targetContentId !== "string" ||
      !UUID_PATTERN.test(entry.targetContentId) ||
      (entry.relationType !== "quote" && entry.relationType !== "reference")
    ) {
      throw new ContentSearchError("SEARCH_DATA_INVALID");
    }
    return { relationType: entry.relationType, targetContentId: entry.targetContentId };
  });
}

function mapSourcePreview(value: unknown): ContentSearchSourcePreview[] {
  if (!Array.isArray(value) || value.length > 3)
    throw new ContentSearchError("SEARCH_DATA_INVALID");
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.url !== "string" ||
      (entry.title !== null && typeof entry.title !== "string") ||
      (entry.description !== null && typeof entry.description !== "string")
    ) {
      throw new ContentSearchError("SEARCH_DATA_INVALID");
    }
    return {
      ...(entry.description === null ? {} : { description: entry.description }),
      ...(entry.title === null ? {} : { title: entry.title }),
      url: entry.url,
    };
  });
}

function stringArray(value: unknown, maximum: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((entry) => typeof entry !== "string") ||
    new Set(value).size !== value.length
  ) {
    throw new ContentSearchError("SEARCH_DATA_INVALID");
  }
  return value as string[];
}

function asNonnegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ContentSearchError("SEARCH_DATA_INVALID");
  }
  return value;
}

function asPositiveInteger(value: unknown): number {
  const integer = asNonnegativeInteger(value);
  if (integer < 1) throw new ContentSearchError("SEARCH_DATA_INVALID");
  return integer;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function searchErrorStatus(code: ContentSearchErrorCode): number {
  if (code === "RATE_LIMITED") return 429;
  if (code === "POLICY_DENIED" || code === "SCOPE_REQUIRED") return 403;
  if (code === "INDEX_UNAVAILABLE" || code === "SEARCH_NOT_READY") return 503;
  if (code === "AUTHORIZATION_CONTEXT_STALE") return 401;
  if (code === "SEARCH_DATA_INVALID") return 500;
  if (code === "SNAPSHOT_EXPIRED" || code === "CURSOR_EXPIRED") return 409;
  return 400;
}

function searchErrorMessage(code: ContentSearchErrorCode): string {
  const messages: Record<ContentSearchErrorCode, string> = {
    AUTHORIZATION_CONTEXT_STALE: "The Agent authorization context is stale.",
    CURSOR_EXPIRED: "The Search cursor expired.",
    CURSOR_INVALID: "The Search cursor is invalid for this request.",
    INDEX_UNAVAILABLE: "The semantic Search index is unavailable.",
    INVALID_ARGUMENT: "The Search request is invalid.",
    POLICY_DENIED: "The Agent policy denies Search.",
    RATE_LIMITED: "The Agent Search rate limit was reached.",
    SCOPE_REQUIRED: "The Agent credential lacks the Search scope.",
    SEARCH_DATA_INVALID: "Stored Search data is invalid.",
    SEARCH_NOT_READY: "Search is not ready.",
    SNAPSHOT_EXPIRED: "The Search visibility snapshot changed during pagination.",
  };
  return messages[code];
}
