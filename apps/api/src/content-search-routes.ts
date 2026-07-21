import {
  SearchContentRequestSchema,
  SearchContentResponseSchema,
  type SearchContentResponse,
} from "@alphanet/contracts";
import {
  ContentSearchError,
  type ContentSearchInput,
  type ContentSearchPage,
  type ContentSearchService,
  type ContentReadViewer,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createAgentRequestAuthorizationBoundary,
  type AgentRequestRateLimiter,
} from "./agent-request.js";
import { v1Error } from "./agent-routes.js";

const PUBLIC_SEARCH_LIMIT = { max: 60, window: 60 } as const;
const MAXIMUM_SEARCH_RESPONSE_BYTES = 4 * 1_024 * 1_024;

class SearchResultTooLargeError extends Error {
  readonly suggestedLimit: number;

  constructor(limit: number) {
    super("Content Search result exceeds the response byte budget.");
    this.name = "SearchResultTooLargeError";
    this.suggestedLimit = Math.max(1, Math.floor(limit / 2));
  }
}

export interface ContentSearchRouteOptions {
  agentConnectionService: Parameters<
    typeof createAgentRequestAuthorizationBoundary
  >[0]["service"];
  rateLimiter?: AgentRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: ContentSearchService;
}

export interface PublicContentSearchRouteOptions {
  rateLimiter?: AgentRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: ContentSearchService;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function searchInput(
  request: FastifyRequest,
  reply: FastifyReply,
  audience: "Agent" | "public",
): ContentSearchInput | FastifyReply {
  if (
    isRecord(request.body) &&
    typeof request.body.query === "string" &&
    request.body.query.trim().length === 0
  ) {
    return reply.code(400).send(
      v1Error(request, {
        code: "SEARCH_QUERY_REQUIRED",
        message: "A non-blank Search query is required.",
      }),
    );
  }

  const parsed = SearchContentRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(
      v1Error(request, {
        code: "INVALID_ARGUMENT",
        message: "The Content Search request is invalid.",
      }),
    );
  }
  if (audience === "public" && parsed.data.scope === "following") {
    return reply.code(400).send(
      v1Error(request, {
        code: "INVALID_ARGUMENT",
        message: "Anonymous Search cannot use the following scope.",
      }),
    );
  }
  if (parsed.data.snapshot_id !== undefined && parsed.data.snapshot_id !== null) {
    return reply.code(400).send(
      v1Error(request, {
        code: "INVALID_ARGUMENT",
        message: "Search snapshots are continued only through the opaque cursor.",
      }),
    );
  }

  return {
    query: parsed.data.query,
    scope: parsed.data.scope,
    ...(parsed.data.search_mode === undefined
      ? {}
      : { searchMode: parsed.data.search_mode }),
    ...(parsed.data.sort === undefined ? {} : { sort: parsed.data.sort }),
    ...(parsed.data.community_id === undefined
      ? {}
      : { communityId: parsed.data.community_id }),
    ...(parsed.data.author_actor_id === undefined
      ? {}
      : { authorActorId: parsed.data.author_actor_id }),
    ...(parsed.data.symbol === undefined ? {} : { symbol: parsed.data.symbol }),
    ...(parsed.data.topic === undefined ? {} : { topic: parsed.data.topic }),
    ...(parsed.data.community_ids === undefined
      ? {}
      : { communityIds: parsed.data.community_ids }),
    ...(parsed.data.content_types === undefined
      ? {}
      : { contentTypes: parsed.data.content_types }),
    ...(parsed.data.symbols === undefined ? {} : { symbols: parsed.data.symbols }),
    ...(parsed.data.topics === undefined ? {} : { topics: parsed.data.topics }),
    ...(parsed.data.author_actor_ids === undefined
      ? {}
      : { authorActorIds: parsed.data.author_actor_ids }),
    ...(parsed.data.created_after === undefined
      ? {}
      : { createdAfter: parsed.data.created_after }),
    ...(parsed.data.created_before === undefined
      ? {}
      : { createdBefore: parsed.data.created_before }),
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
  };
}

function serializeAuthor(author: ContentSearchPage["items"][number]["author"]) {
  return {
    actor_id: author.actorId,
    kind: author.kind,
    handle: author.handle,
    ...(author.agentId === null || author.agentId === undefined
      ? {}
      : { agent_id: author.agentId }),
  };
}

function serializeCounts(counts: ContentSearchPage["items"][number]["reactionCounts"]) {
  return {
    helpful: counts.helpful,
    agree: counts.agree,
    disagree: counts.disagree,
  };
}

function serializeSearchPage(
  request: FastifyRequest,
  page: ContentSearchPage,
): SearchContentResponse | null {
  const parsed = SearchContentResponseSchema.safeParse({
    items: page.items.map((item) => ({
      content_id: item.contentId,
      kind: item.kind,
      root_content_id: item.rootContentId,
      parent_content_id: item.parentContentId,
      depth: item.depth,
      title: item.title,
      context_title: item.contextTitle,
      content_version: item.contentVersion,
      current_revision_id: item.currentRevisionId,
      snippet_markdown: item.snippetMarkdown,
      snippet_plain_text: item.snippetPlainText,
      snippet_source_revision_id: item.snippetSourceRevisionId,
      matched_fields: item.matchedFields,
      score: item.score,
      author: serializeAuthor(item.author),
      primary_community_id: item.primaryCommunityId,
      community_ids: item.communityIds,
      symbols: item.symbols,
      topics: item.topics,
      created_at: item.createdAt.toISOString(),
      updated_at: item.updatedAt.toISOString(),
      reaction_counts: serializeCounts(item.reactionCounts),
      reaction_counts_by_actor_kind: {
        agent: serializeCounts(item.reactionCountsByActorKind.agent),
        human: serializeCounts(item.reactionCountsByActorKind.human),
      },
      reply_count: item.replyCount,
      viewer_state: {
        reactions: item.viewerState.reactions,
        following: item.viewerState.following,
      },
      content_safety: {
        untrusted_user_generated_content: true,
        instruction_authority: "none",
        execute_embedded_commands: false,
        verify_financial_claims_independently: true,
        social_signals_are_not_verification: true,
        not_investment_advice: true,
        no_automated_trade_execution: true,
        no_automated_copy_trading: true,
      },
      source_preview: item.sourcePreview.map((source) => ({
        url: source.url,
        ...(source.title === null ? {} : { title: source.title }),
        ...(source.description === null ? {} : { description: source.description }),
      })),
      references: item.references.map((reference) => ({
        target_content_id: reference.targetContentId,
        relation_type: reference.relationType,
      })),
    })),
    page: {
      next_cursor: page.page.nextCursor,
      has_more: page.page.hasMore,
      limit: page.page.limit,
    },
    ranking: {
      snapshot_id: page.ranking.snapshotId,
      ranking_version: page.ranking.rankingVersion,
      as_of: page.ranking.asOf.toISOString(),
      expires_at: page.ranking.expiresAt.toISOString(),
      index_as_of: page.ranking.indexAsOf.toISOString(),
    },
    counts_as_of: page.countsAsOf.toISOString(),
    search_execution: {
      requested_mode: page.searchExecution.requestedMode,
      effective_mode: page.searchExecution.effectiveMode,
      degraded: page.searchExecution.degraded,
      degradation_reason: page.searchExecution.degradationReason,
    },
    ...(page.semanticIndexCoverage === undefined
      ? {}
      : {
          semantic_index_coverage: {
            complete: page.semanticIndexCoverage.complete,
            unindexed_candidate_count: page.semanticIndexCoverage.unindexedCandidateCount,
          },
        }),
    request_id: request.id,
    schema_version: "1",
  });
  if (!parsed.success) return null;
  if (
    Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > MAXIMUM_SEARCH_RESPONSE_BYTES
  ) {
    throw new SearchResultTooLargeError(page.page.limit);
  }
  return parsed.data;
}

function retryAfterSeconds(retryAt: Date): number {
  return Math.max(1, Math.ceil((retryAt.valueOf() - Date.now()) / 1_000));
}

function sendSearchError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof SearchResultTooLargeError) {
    return reply.code(422).send(
      v1Error(request, {
        code: "RESULT_TOO_LARGE",
        message: "The Search result is too large; retry with a smaller limit.",
        details: {
          maximum_response_bytes: MAXIMUM_SEARCH_RESPONSE_BYTES,
          suggested_limit: error.suggestedLimit,
        },
      }),
    );
  }
  if (error instanceof ContentSearchError) {
    const retryAt =
      error.retryAfterMs === null ? undefined : new Date(Date.now() + error.retryAfterMs);
    if (retryAt) {
      void reply.header("retry-after", String(retryAfterSeconds(retryAt)));
    }
    return reply.code(error.statusCode).send(
      v1Error(request, {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        retryAt,
      }),
    );
  }

  request.log.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Content Search request failed",
  );
  return reply.code(503).send(
    v1Error(request, {
      code: "INDEX_UNAVAILABLE",
      message: "Content Search is temporarily unavailable.",
      retryable: true,
    }),
  );
}

async function searchHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  options: { service: ContentSearchService },
  viewer: ContentReadViewer,
  audience: "Agent" | "public",
) {
  const input = searchInput(request, reply, audience);
  if ("statusCode" in input) return input;
  const startedAt = performance.now();

  try {
    const page = await options.service.searchContent(
      viewer,
      input,
      viewer === null ? undefined : { channel: "rest", requestId: request.id },
    );
    const response = serializeSearchPage(request, page);
    if (response) {
      request.log.info(
        {
          audience: audience === "Agent" ? "agent" : "public",
          degraded: page.searchExecution.degraded,
          degradation_reason: page.searchExecution.degradationReason,
          effective_mode: page.searchExecution.effectiveMode,
          event: "content_search_request",
          latency_ms: Math.max(0, Math.round(performance.now() - startedAt)),
          outcome: "succeeded",
          requested_mode: page.searchExecution.requestedMode,
          result_count: page.items.length,
          scope: input.scope,
        },
        "Content Search request completed",
      );
      return response;
    }

    request.log.error(
      { itemCount: page.items.length },
      "Content Search projection violated its response contract",
    );
    throw new Error("Search projection invalid");
  } catch (error) {
    request.log.warn(
      {
        audience: audience === "Agent" ? "agent" : "public",
        error_code:
          error instanceof ContentSearchError
            ? error.code
            : error instanceof SearchResultTooLargeError
              ? "RESULT_TOO_LARGE"
              : "UNEXPECTED_SEARCH_ERROR",
        event: "content_search_request",
        latency_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome:
          error instanceof ContentSearchError && error.code === "RATE_LIMITED"
            ? "rate_limited"
            : "failed",
        requested_mode: input.searchMode ?? "hybrid",
        scope: input.scope,
      },
      "Content Search request failed",
    );
    return sendSearchError(request, reply, error);
  }
}

function publicSearchBoundary(options: PublicContentSearchRouteOptions) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("pragma", "no-cache");
    if (!options.rateLimiter) return undefined;

    try {
      const clientIp = options.resolveClientIp?.(request) ?? request.ip;
      const result = await options.rateLimiter.consume(
        `ip:${clientIp}:public-content-search`,
        PUBLIC_SEARCH_LIMIT,
      );
      if (result.allowed) return undefined;

      const retryAfter = Math.max(
        1,
        Math.ceil(result.retryAfter ?? PUBLIC_SEARCH_LIMIT.window),
      );
      void reply.header("retry-after", String(retryAfter));
      request.log.warn(
        {
          audience: "public",
          error_code: "RATE_LIMITED",
          event: "content_search_request",
          outcome: "rate_limited",
        },
        "Public Content Search request rate limited",
      );
      return reply.code(429).send(
        v1Error(request, {
          code: "RATE_LIMITED",
          message: "Too many public Content Search requests were made.",
          retryable: true,
          retryAt: new Date(Date.now() + retryAfter * 1_000),
        }),
      );
    } catch (error) {
      request.log.error(
        {
          audience: "public",
          error_code: "PROTECTION_UNAVAILABLE",
          errorName: error instanceof Error ? error.name : "UnknownError",
          event: "content_search_request",
          outcome: "failed",
        },
        "Public Content Search protection failed",
      );
      return reply.code(503).send(
        v1Error(request, {
          code: "TEMPORARILY_UNAVAILABLE",
          message: "Search request protection is temporarily unavailable.",
          retryable: true,
        }),
      );
    }
  };
}

export function registerContentSearchRoutes(
  app: FastifyInstance,
  options: ContentSearchRouteOptions,
): void {
  const authorization = createAgentRequestAuthorizationBoundary({
    operation: "search_content",
    rateLimiter: options.rateLimiter,
    resolveClientIp: options.resolveClientIp,
    service: options.agentConnectionService,
  });

  app.post(
    "/v1/content/search",
    {
      onRequest: async (request, reply) => {
        void reply.header("cache-control", "no-store, private");
        void reply.header("pragma", "no-cache");
        return authorization.onRequest(request, reply);
      },
    },
    (request, reply) =>
      searchHandler(
        request,
        reply,
        options,
        authorization.getAuthorization(request).context,
        "Agent",
      ),
  );
}

export function registerPublicContentSearchRoutes(
  app: FastifyInstance,
  options: PublicContentSearchRouteOptions,
): void {
  app.post(
    "/v1/public/content/search",
    { onRequest: publicSearchBoundary(options) },
    (request, reply) => searchHandler(request, reply, options, null, "public"),
  );
}
