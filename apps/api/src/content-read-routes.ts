import {
  BrowseContentRequestSchema,
  BrowseContentResponseSchema,
  GetContentRequestSchema,
  GetContentResponseSchema,
  GetDiscussionRequestSchema,
  GetDiscussionResponseSchema,
  type BrowseContentResponse,
  type GetContentResponse,
  type GetDiscussionResponse,
} from "@alphanet/contracts";
import {
  ContentReadError,
  type AgentConnectionService,
  type ContentAuthorProjection,
  type ContentBrowseInput,
  type ContentBrowseItem,
  type ContentBrowsePage,
  type ContentBrowseScope,
  type ContentBrowseSort,
  type ContentDetailProjection,
  type ContentReadService,
  type ContentSafetyProjection,
  type DiscussionSort,
  type DiscussionNodeProjection,
  type DiscussionProjection,
  type ReactionCountsByActorKindProjection,
  type ReactionCountsProjection,
  type RevisionProjection,
  type ViewerContentStateProjection,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createAgentRequestAuthorizationBoundary,
  type AgentRequestRateLimiter,
} from "./agent-request.js";
import { v1Error } from "./agent-routes.js";

export interface ContentReadRouteOptions {
  agentConnectionService: Pick<AgentConnectionService, "authenticateStaticApiKey">;
  rateLimiter?: AgentRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: ContentReadService;
}

export interface PublicContentReadRouteOptions {
  rateLimiter?: AgentRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: ContentReadService;
}

const PUBLIC_CONTENT_READ_RATE_LIMIT = { max: 120, window: 60 } as const;
const MAXIMUM_CONTENT_RESPONSE_BYTES = 1_048_576;

function withinContentResponseBudget<T>(value: T): T | null {
  return Buffer.byteLength(JSON.stringify(value), "utf8") <=
    MAXIMUM_CONTENT_RESPONSE_BYTES
    ? value
    : null;
}

function isSupportedBrowseScope(value: string): value is ContentBrowseScope {
  return (
    value === "global" ||
    value === "community" ||
    value === "author" ||
    value === "symbol" ||
    value === "topic"
  );
}

function isSupportedBrowseSort(value: string): value is ContentBrowseSort {
  return value === "latest" || value === "active";
}

function isSupportedDiscussionSort(value: string): value is DiscussionSort {
  return value === "oldest" || value === "latest";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function queryArray(value: unknown): unknown {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (!values.every((entry): entry is string => typeof entry === "string")) {
    return value;
  }
  return values.flatMap((entry) => entry.split(",")).filter((entry) => entry.length > 0);
}

function queryNumber(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  return Number(value);
}

function queryBoolean(value: unknown): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function normalizeBrowseQuery(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    ...(value.content_types === undefined
      ? {}
      : { content_types: queryArray(value.content_types) }),
    ...(value.symbols === undefined ? {} : { symbols: queryArray(value.symbols) }),
    ...(value.topics === undefined ? {} : { topics: queryArray(value.topics) }),
    ...(value.author_actor_ids === undefined
      ? {}
      : { author_actor_ids: queryArray(value.author_actor_ids) }),
    ...(value.limit === undefined ? {} : { limit: queryNumber(value.limit) }),
  };
}

function normalizeContentQuery(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    ...(value.include_revision_history === undefined
      ? {}
      : {
          include_revision_history: queryBoolean(value.include_revision_history),
        }),
    ...(value.revision_limit === undefined
      ? {}
      : { revision_limit: queryNumber(value.revision_limit) }),
  };
}

function normalizeDiscussionQuery(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    ...(value.limit === undefined ? {} : { limit: queryNumber(value.limit) }),
  };
}

function validationFailed(
  request: FastifyRequest,
  reply: FastifyReply,
  audience: "Agent" | "public",
): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code: "INVALID_ARGUMENT",
      message: `The request does not match the ${audience} Content API contract.`,
    }),
  );
}

function capabilityUnavailable(
  request: FastifyRequest,
  reply: FastifyReply,
  capability: string,
): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code: "CAPABILITY_NOT_AVAILABLE",
      message: `${capability} is not available in this Content API version.`,
    }),
  );
}

function serializeAuthor(author: ContentAuthorProjection) {
  return author.kind === "agent"
    ? {
        actor_id: author.actorId,
        kind: author.kind,
        handle: author.handle,
        ...(author.agentId === undefined ? {} : { agent_id: author.agentId }),
      }
    : {
        actor_id: author.actorId,
        kind: author.kind,
        handle: author.handle,
      };
}

function serializeSafety(safety: ContentSafetyProjection) {
  return {
    untrusted_user_generated_content: safety.untrustedUserGeneratedContent,
    instruction_authority: safety.instructionAuthority,
    execute_embedded_commands: safety.executeEmbeddedCommands,
    verify_financial_claims_independently: safety.verifyFinancialClaimsIndependently,
    social_signals_are_not_verification: safety.socialSignalsAreNotVerification,
    not_investment_advice: safety.notInvestmentAdvice,
    no_automated_trade_execution: safety.noAutomatedTradeExecution,
    no_automated_copy_trading: safety.noAutomatedCopyTrading,
  };
}

function serializeReactionCounts(counts: ReactionCountsProjection) {
  return {
    helpful: counts.helpful,
    agree: counts.agree,
    disagree: counts.disagree,
  };
}

function serializeReactionCountsByActorKind(counts: ReactionCountsByActorKindProjection) {
  return {
    agent: serializeReactionCounts(counts.agent),
    human: serializeReactionCounts(counts.human),
  };
}

function serializeViewerState(state: ViewerContentStateProjection) {
  return {
    reactions: state.reactions,
    following: state.following,
  };
}

function serializeRevision(revision: RevisionProjection) {
  return {
    id: revision.id,
    content_id: revision.contentId,
    revision_number: revision.revisionNumber,
    source_version: revision.sourceVersion,
    title: revision.title,
    body_markdown: revision.bodyMarkdown,
    body_plain_text: revision.bodyPlainText,
    edit_summary: revision.editSummary,
    created_by_actor_id: revision.createdByActorId,
    created_at: revision.createdAt.toISOString(),
    content_hash: revision.contentHash,
    source_links: revision.sourceLinks.map((source) => ({
      source_link_id: source.sourceLinkId,
      url: source.url,
      ...(source.title === null ? {} : { title: source.title }),
      ...(source.description === null ? {} : { description: source.description }),
      added_revision_id: source.addedRevisionId,
      added_by_actor_id: source.addedByActorId,
      added_at: source.addedAt.toISOString(),
    })),
    mentions: revision.mentions.map(serializeAuthor),
    references: revision.references.map((reference) => ({
      target_content_id: reference.targetContentId,
      relation_type: reference.relationType,
    })),
  };
}

function serializeBrowseItem(item: ContentBrowseItem) {
  return {
    content_id: item.contentId,
    kind: item.kind,
    root_content_id: item.rootContentId,
    parent_content_id: item.parentContentId,
    depth: item.depth,
    title: item.title,
    content_version: item.contentVersion,
    current_revision_id: item.currentRevisionId,
    snippet_markdown: item.snippetMarkdown,
    snippet_plain_text: item.snippetPlainText,
    snippet_source_revision_id: item.snippetSourceRevisionId,
    author: serializeAuthor(item.author),
    primary_community_id: item.primaryCommunityId,
    community_ids: item.communityIds,
    symbols: item.symbols,
    topics: item.topics,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
    reaction_counts: serializeReactionCounts(item.reactionCounts),
    reaction_counts_by_actor_kind: serializeReactionCountsByActorKind(
      item.reactionCountsByActorKind,
    ),
    reply_count: item.replyCount,
    viewer_state: serializeViewerState(item.viewerState),
    content_safety: serializeSafety(item.contentSafety),
    rank: item.rank,
    score: item.score,
    matched_follows: [],
    selection_reasons: item.selectionReasons,
  };
}

function serializeBrowsePage(
  request: FastifyRequest,
  page: ContentBrowsePage,
): BrowseContentResponse | null {
  const parsed = BrowseContentResponseSchema.safeParse({
    items: page.items.map(serializeBrowseItem),
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
    },
    counts_as_of: page.countsAsOf.toISOString(),
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? withinContentResponseBudget(parsed.data) : null;
}

function serializeContentDetail(
  request: FastifyRequest,
  detail: ContentDetailProjection,
): GetContentResponse | null {
  const content = detail.content;
  const parsed = GetContentResponseSchema.safeParse({
    content: {
      id: content.id,
      kind: content.kind,
      root_content_id: content.rootContentId,
      parent_content_id: content.parentContentId,
      depth: content.depth,
      author: serializeAuthor(content.author),
      title: content.title,
      current_revision_id: content.currentRevisionId,
      version: content.version,
      lifecycle_state: content.lifecycleState,
      distribution_state: content.distributionState,
      primary_community_id: content.primaryCommunityId,
      additional_community_ids: content.additionalCommunityIds,
      symbols: content.symbols,
      topics: content.topics,
      created_at: content.createdAt.toISOString(),
      updated_at: content.updatedAt.toISOString(),
      last_activity_at: content.lastActivityAt.toISOString(),
    },
    revision: detail.revision === null ? null : serializeRevision(detail.revision),
    effective_community_ids: detail.effectiveCommunityIds,
    reaction_counts: serializeReactionCounts(detail.reactionCounts),
    reaction_counts_by_actor_kind: serializeReactionCountsByActorKind(
      detail.reactionCountsByActorKind,
    ),
    reply_count: detail.replyCount,
    inbound_reference_count: detail.inboundReferenceCount,
    viewer_state: serializeViewerState(detail.viewerState),
    content_safety: serializeSafety(detail.contentSafety),
    counts_as_of: detail.countsAsOf.toISOString(),
    resource_version: detail.resourceVersion,
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? withinContentResponseBudget(parsed.data) : null;
}

function serializeDiscussionNode(node: DiscussionNodeProjection) {
  return {
    id: node.id,
    kind: node.kind,
    root_content_id: node.rootContentId,
    parent_content_id: node.parentContentId,
    depth: node.depth,
    version: node.version,
    current_revision_id: node.currentRevisionId,
    author: serializeAuthor(node.author),
    lifecycle_state: node.lifecycleState,
    distribution_state: node.distributionState,
    effective_community_ids: node.effectiveCommunityIds,
    symbols: node.symbols,
    topics: node.topics,
    created_at: node.createdAt.toISOString(),
    updated_at: node.updatedAt.toISOString(),
    last_activity_at: node.lastActivityAt.toISOString(),
    revision: node.revision === null ? null : serializeRevision(node.revision),
    reaction_counts: serializeReactionCounts(node.reactionCounts),
    reaction_counts_by_actor_kind: serializeReactionCountsByActorKind(
      node.reactionCountsByActorKind,
    ),
    reply_count: node.replyCount,
    inbound_reference_count: node.inboundReferenceCount,
    viewer_state: serializeViewerState(node.viewerState),
    content_safety: serializeSafety(node.contentSafety),
  };
}

function serializeDiscussion(
  request: FastifyRequest,
  discussion: DiscussionProjection,
): GetDiscussionResponse | null {
  const parsed = GetDiscussionResponseSchema.safeParse({
    root: serializeDiscussionNode(discussion.root),
    replies: discussion.replies.map(serializeDiscussionNode),
    ancestor_context: discussion.ancestorContext.map((ancestor) => ({
      id: ancestor.id,
      kind: ancestor.kind,
      root_content_id: ancestor.rootContentId,
      parent_content_id: ancestor.parentContentId,
      depth: ancestor.depth,
    })),
    page: {
      next_cursor: discussion.page.nextCursor,
      has_more: discussion.page.hasMore,
      limit: discussion.page.limit,
      truncated_by_byte_budget: discussion.page.truncatedByByteBudget,
    },
    ordering: {
      snapshot_id: discussion.ordering.snapshotId,
      ordering_version: discussion.ordering.orderingVersion,
      as_of: discussion.ordering.asOf.toISOString(),
    },
    counts_as_of: discussion.countsAsOf.toISOString(),
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? withinContentResponseBudget(parsed.data) : null;
}

function sendContentReadError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof ContentReadError) {
    return reply.code(error.statusCode).send(
      v1Error(request, {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      }),
    );
  }

  request.log.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Content read request failed",
  );
  return reply.code(503).send(
    v1Error(request, {
      code: "CONTENT_READ_NOT_READY",
      message: "The Content read service is temporarily unavailable.",
      retryable: true,
    }),
  );
}

function contentAuthorizationBoundary(
  options: ContentReadRouteOptions,
  operation: "browse_content" | "get_content" | "get_discussion",
) {
  const boundary = createAgentRequestAuthorizationBoundary({
    operation,
    service: options.agentConnectionService,
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  });
  return {
    getAuthorization: boundary.getAuthorization,
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      void reply.header("cache-control", "no-store, private");
      void reply.header("pragma", "no-cache");
      return boundary.onRequest(request, reply);
    },
  };
}

function publicContentBoundary(options: PublicContentReadRouteOptions) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> => {
    void reply.header("cache-control", "no-store");
    void reply.header("pragma", "no-cache");
    if (!options.rateLimiter) return undefined;

    try {
      const clientIp = options.resolveClientIp?.(request) ?? request.ip;
      const result = await options.rateLimiter.consume(
        `ip:${clientIp}:public-content-read`,
        PUBLIC_CONTENT_READ_RATE_LIMIT,
      );
      if (result.allowed) return undefined;

      const retryAfter = Math.max(
        1,
        Math.ceil(result.retryAfter ?? PUBLIC_CONTENT_READ_RATE_LIMIT.window),
      );
      void reply.header("retry-after", String(retryAfter));
      return reply.code(429).send(
        v1Error(request, {
          code: "RATE_LIMITED",
          message: "Too many public Content requests were made in this time window.",
          retryable: true,
          retryAt: new Date(Date.now() + retryAfter * 1_000),
        }),
      );
    } catch (error) {
      request.log.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Public Content request protection failed",
      );
      return reply.code(503).send(
        v1Error(request, {
          code: "TEMPORARILY_UNAVAILABLE",
          message: "Public Content request protection is temporarily unavailable.",
          retryable: true,
        }),
      );
    }
  };
}

function browseInput(
  request: FastifyRequest,
  reply: FastifyReply,
  audience: "Agent" | "public",
) {
  const parsed = BrowseContentRequestSchema.safeParse(
    normalizeBrowseQuery(request.query),
  );
  if (!parsed.success) {
    return { error: validationFailed(request, reply, audience) } as const;
  }
  if (!isSupportedBrowseScope(parsed.data.scope)) {
    return {
      error: capabilityUnavailable(request, reply, `Browse scope '${parsed.data.scope}'`),
    } as const;
  }
  if (!isSupportedBrowseSort(parsed.data.sort)) {
    return {
      error: capabilityUnavailable(request, reply, `Browse sort '${parsed.data.sort}'`),
    } as const;
  }
  if (parsed.data.snapshot_id !== undefined && parsed.data.snapshot_id !== null) {
    return {
      error: capabilityUnavailable(request, reply, "Explicit browse snapshots"),
    } as const;
  }

  const input: ContentBrowseInput = {
    scope: parsed.data.scope,
    sort: parsed.data.sort,
    ...(parsed.data.community_id === undefined
      ? {}
      : { communityId: parsed.data.community_id }),
    ...(parsed.data.author_actor_id === undefined
      ? {}
      : { authorActorId: parsed.data.author_actor_id }),
    ...(parsed.data.symbol === undefined ? {} : { symbol: parsed.data.symbol }),
    ...(parsed.data.topic === undefined ? {} : { topic: parsed.data.topic }),
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
    ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
  };
  return { input } as const;
}

function contentInput(
  request: FastifyRequest,
  reply: FastifyReply,
  audience: "Agent" | "public",
) {
  const parameters = request.params as { contentId?: unknown };
  const query = normalizeContentQuery(request.query);
  if (!isRecord(query)) {
    return { error: validationFailed(request, reply, audience) } as const;
  }
  const parsed = GetContentRequestSchema.safeParse({
    content_id: parameters.contentId,
    ...query,
  });
  if (!parsed.success) {
    return { error: validationFailed(request, reply, audience) } as const;
  }
  if (
    parsed.data.revision_id !== undefined ||
    parsed.data.include_revision_history === true ||
    parsed.data.revision_limit !== undefined ||
    (parsed.data.revision_cursor !== undefined && parsed.data.revision_cursor !== null)
  ) {
    return {
      error: capabilityUnavailable(request, reply, "Revision history and selection"),
    } as const;
  }
  return { input: { contentId: parsed.data.content_id } } as const;
}

function discussionInput(
  request: FastifyRequest,
  reply: FastifyReply,
  audience: "Agent" | "public",
) {
  const parameters = request.params as { contentId?: unknown };
  const query = normalizeDiscussionQuery(request.query);
  if (!isRecord(query)) {
    return { error: validationFailed(request, reply, audience) } as const;
  }
  const parsed = GetDiscussionRequestSchema.safeParse({
    content_id: parameters.contentId,
    ...query,
  });
  if (!parsed.success) {
    return { error: validationFailed(request, reply, audience) } as const;
  }
  if (parsed.data.sort !== undefined && !isSupportedDiscussionSort(parsed.data.sort)) {
    return {
      error: capabilityUnavailable(
        request,
        reply,
        `Discussion sort '${parsed.data.sort}'`,
      ),
    } as const;
  }
  return {
    input: {
      contentId: parsed.data.content_id,
      ...(parsed.data.sort === undefined ? {} : { sort: parsed.data.sort }),
      ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
      ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
    },
  } as const;
}

async function browseHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  options: { service: ContentReadService },
  viewer: Parameters<ContentReadService["browseContent"]>[0],
  audience: "Agent" | "public",
) {
  const parsed = browseInput(request, reply, audience);
  if ("error" in parsed) return parsed.error;
  try {
    const page = await options.service.browseContent(viewer, parsed.input);
    const response = serializeBrowsePage(request, page);
    if (!response) {
      request.log.error(
        { itemCount: page.items.length },
        "Content browse projection violated its response contract",
      );
      return sendContentReadError(request, reply, new Error("projection invalid"));
    }
    return response;
  } catch (error) {
    return sendContentReadError(request, reply, error);
  }
}

async function getContentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  options: { service: ContentReadService },
  viewer: Parameters<ContentReadService["getContent"]>[0],
  audience: "Agent" | "public",
) {
  const parsed = contentInput(request, reply, audience);
  if ("error" in parsed) return parsed.error;
  try {
    const detail = await options.service.getContent(viewer, parsed.input);
    const response = serializeContentDetail(request, detail);
    if (!response) {
      request.log.error(
        { contentKind: detail.content.kind },
        "Content detail projection violated its response contract",
      );
      return sendContentReadError(request, reply, new Error("projection invalid"));
    }
    return response;
  } catch (error) {
    return sendContentReadError(request, reply, error);
  }
}

async function getDiscussionHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  options: { service: ContentReadService },
  viewer: Parameters<ContentReadService["getDiscussion"]>[0],
  audience: "Agent" | "public",
) {
  const parsed = discussionInput(request, reply, audience);
  if ("error" in parsed) return parsed.error;
  try {
    const discussion = await options.service.getDiscussion(viewer, parsed.input);
    const response = serializeDiscussion(request, discussion);
    if (!response) {
      request.log.error(
        { replyCount: discussion.replies.length },
        "Content discussion projection violated its response contract",
      );
      return sendContentReadError(request, reply, new Error("projection invalid"));
    }
    return response;
  } catch (error) {
    return sendContentReadError(request, reply, error);
  }
}

export function registerContentReadRoutes(
  app: FastifyInstance,
  options: ContentReadRouteOptions,
): void {
  const browseAuthorization = contentAuthorizationBoundary(options, "browse_content");
  const contentAuthorization = contentAuthorizationBoundary(options, "get_content");
  const discussionAuthorization = contentAuthorizationBoundary(options, "get_discussion");

  app.get("/v1/content", { onRequest: browseAuthorization.onRequest }, (request, reply) =>
    browseHandler(
      request,
      reply,
      options,
      browseAuthorization.getAuthorization(request).context,
      "Agent",
    ),
  );
  app.get(
    "/v1/content/:contentId/discussion",
    { onRequest: discussionAuthorization.onRequest },
    (request, reply) =>
      getDiscussionHandler(
        request,
        reply,
        options,
        discussionAuthorization.getAuthorization(request).context,
        "Agent",
      ),
  );
  app.get(
    "/v1/content/:contentId",
    { onRequest: contentAuthorization.onRequest },
    (request, reply) =>
      getContentHandler(
        request,
        reply,
        options,
        contentAuthorization.getAuthorization(request).context,
        "Agent",
      ),
  );
}

export function registerPublicContentReadRoutes(
  app: FastifyInstance,
  options: PublicContentReadRouteOptions,
): void {
  const onRequest = publicContentBoundary(options);
  app.get("/v1/public/content", { onRequest }, (request, reply) =>
    browseHandler(request, reply, options, null, "public"),
  );
  app.get("/v1/public/content/:contentId/discussion", { onRequest }, (request, reply) =>
    getDiscussionHandler(request, reply, options, null, "public"),
  );
  app.get("/v1/public/content/:contentId", { onRequest }, (request, reply) =>
    getContentHandler(request, reply, options, null, "public"),
  );
}
