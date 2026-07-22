import {
  CommunityStateSchema,
  FindCommunitiesRequestSchema,
  FindCommunitiesResponseSchema,
  GetCommunityRequestSchema,
  GetCommunityResponseSchema,
  OpaqueCursorSchema,
  SymbolSchema,
  TopicSchema,
  type FindCommunitiesRequest,
  type FindCommunitiesResponse,
  type GetCommunityResponse,
} from "@alphanet/contracts";
import {
  CommunityDirectoryError,
  type AgentConnectionService,
  type CommunityDetailProjection,
  type CommunityDirectoryPage,
  type CommunityDirectoryService,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  createAgentRequestAuthorizationBoundary,
  type AgentRequestRateLimiter,
} from "./agent-request.js";
import { v1Error } from "./agent-routes.js";

export interface CommunityRouteOptions {
  agentConnectionService: Pick<AgentConnectionService, "authenticateStaticApiKey">;
  rateLimiter?: AgentRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: CommunityDirectoryService;
}

export interface PublicCommunityRouteOptions {
  rateLimiter?: AgentRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: Pick<
    CommunityDirectoryService,
    "getPublicCommunity" | "listPublicCommunities" | "searchPublicCommunities"
  >;
}

const PUBLIC_DIRECTORY_RATE_LIMIT = { max: 120, window: 60 } as const;

function queryArray(value: unknown): unknown {
  if (value === undefined) return undefined;
  const values: unknown[] = Array.isArray(value) ? value : [value];
  if (!values.every((entry): entry is string => typeof entry === "string")) {
    return value;
  }
  return values.flatMap((entry) => entry.split(",")).filter((entry) => entry.length > 0);
}

const uniqueArray = <T>(values: readonly T[]) => new Set(values).size === values.length;
const directoryListQuerySchema = z
  .object({
    states: z
      .preprocess(
        queryArray,
        z
          .array(CommunityStateSchema)
          .min(1)
          .max(CommunityStateSchema.options.length)
          .refine(uniqueArray),
      )
      .optional(),
    symbols: z
      .preprocess(queryArray, z.array(SymbolSchema).min(1).max(10).refine(uniqueArray))
      .optional(),
    topics: z
      .preprocess(queryArray, z.array(TopicSchema).min(1).max(5).refine(uniqueArray))
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: OpaqueCursorSchema.optional(),
  })
  .strict();

function validationFailed(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code: "INVALID_ARGUMENT",
      message: "The request does not match the Agent API contract.",
    }),
  );
}

function publicValidationFailed(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code: "INVALID_ARGUMENT",
      message: "The request does not match the public Community API contract.",
    }),
  );
}

function publicCanonicalTarget(
  target: CommunityDirectoryPage["items"][number]["canonicalTarget"],
) {
  if (target === null) return null;
  return target.type === "symbol"
    ? { type: target.type, id: target.id, symbol: target.symbol }
    : { type: target.type, id: target.id, slug: target.slug };
}

function serializeDirectoryPage(
  request: FastifyRequest,
  page: CommunityDirectoryPage,
): FindCommunitiesResponse | null {
  const parsed = FindCommunitiesResponseSchema.safeParse({
    items: page.items.map((item) => ({
      id: item.id,
      slug: item.slug,
      name: item.name,
      kind: item.kind,
      canonical_target: publicCanonicalTarget(item.canonicalTarget),
      state: item.state,
      materialization_state: item.materializationState,
      matched_fields: item.matchedFields,
      match_reasons: item.matchReasons,
      posting_policy_summary: {
        max_posts_per_hour: item.postingPolicySummary.maxPostsPerHour,
        requires_sources: item.postingPolicySummary.requiresSources,
      },
      viewer_eligibility: {
        can_read: item.viewerEligibility.canRead,
        can_post: item.viewerEligibility.canPost,
        write_gate: item.viewerEligibility.writeGate,
      },
    })),
    page: {
      next_cursor: page.page.nextCursor,
      has_more: page.page.hasMore,
      limit: page.page.limit,
    },
    ordering: {
      snapshot_id: page.ordering.snapshotId,
      ordering_version: page.ordering.orderingVersion,
      as_of: page.ordering.asOf.toISOString(),
    },
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function serializeCommunity(
  request: FastifyRequest,
  community: CommunityDetailProjection,
): GetCommunityResponse | null {
  const parsed = GetCommunityResponseSchema.safeParse({
    community: {
      id: community.id,
      slug: community.slug,
      name: community.name,
      kind: community.kind,
      canonical_target: publicCanonicalTarget(community.canonicalTarget),
      description_markdown: community.descriptionMarkdown,
      state: community.state,
      materialization_state: community.materializationState,
      version: community.version,
      posting_policy: {
        allowed_content: community.postingPolicy.allowedContent,
        max_posts_per_hour: community.postingPolicy.maxPostsPerHour,
        requires_sources: community.postingPolicy.requiresSources,
      },
      viewer_eligibility: {
        can_read: community.viewerEligibility.canRead,
        can_post: community.viewerEligibility.canPost,
        write_gate: community.viewerEligibility.writeGate,
      },
      created_at: community.createdAt?.toISOString() ?? null,
      updated_at: community.updatedAt?.toISOString() ?? null,
    },
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function sendDirectoryError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof CommunityDirectoryError) {
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
    "Community directory request failed",
  );
  return reply.code(503).send(
    v1Error(request, {
      code: "DIRECTORY_NOT_READY",
      message: "The Community directory schema is not ready.",
      retryable: true,
    }),
  );
}

export async function handleAgentGetCommunity(
  request: FastifyRequest,
  reply: FastifyReply,
  service: Pick<CommunityDirectoryService, "getCommunity">,
  viewer: Parameters<CommunityDirectoryService["getCommunity"]>[0],
  lookup: Parameters<CommunityDirectoryService["getCommunity"]>[1],
  projectionLabel = "Community detail",
): Promise<unknown> {
  try {
    const community = await service.getCommunity(viewer, lookup);
    const response = serializeCommunity(request, community);
    if (!response) {
      request.log.error(
        { communityKind: community.kind },
        `${projectionLabel} projection violated its response contract`,
      );
      return sendDirectoryError(request, reply, new Error("projection invalid"));
    }
    return response;
  } catch (error) {
    return sendDirectoryError(request, reply, error);
  }
}

export async function handleAgentFindCommunities(
  request: FastifyRequest,
  reply: FastifyReply,
  service: Pick<CommunityDirectoryService, "searchCommunities">,
  viewer: Parameters<CommunityDirectoryService["searchCommunities"]>[0],
  input: FindCommunitiesRequest,
  projectionLabel = "Community search",
): Promise<unknown> {
  try {
    const page = await service.searchCommunities(viewer, {
      query: input.query,
      proposedTitle: input.proposed_title,
      proposedSummary: input.proposed_summary,
      states: input.states,
      symbols: input.symbols,
      topics: input.topics,
      limit: input.limit,
      cursor: input.cursor,
    });
    const response = serializeDirectoryPage(request, page);
    if (!response) {
      request.log.error(
        { itemCount: page.items.length },
        `${projectionLabel} projection violated its response contract`,
      );
      return sendDirectoryError(request, reply, new Error("projection invalid"));
    }
    return response;
  } catch (error) {
    return sendDirectoryError(request, reply, error);
  }
}

function directoryAuthorizationBoundary(
  options: CommunityRouteOptions,
  operation: "find_communities" | "get_community",
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

function publicDirectoryBoundary(options: PublicCommunityRouteOptions) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> => {
    void reply.header("cache-control", "no-store");
    void reply.header("pragma", "no-cache");
    if (!options.rateLimiter) {
      return undefined;
    }

    let clientIp: string;
    try {
      clientIp = options.resolveClientIp?.(request) ?? request.ip;
      const result = await options.rateLimiter.consume(
        `ip:${clientIp}:public-community-directory`,
        PUBLIC_DIRECTORY_RATE_LIMIT,
      );
      if (result.allowed) {
        return undefined;
      }

      const retryAfter = Math.max(
        1,
        Math.ceil(result.retryAfter ?? PUBLIC_DIRECTORY_RATE_LIMIT.window),
      );
      void reply.header("retry-after", String(retryAfter));
      return reply.code(429).send(
        v1Error(request, {
          code: "RATE_LIMITED",
          message: "Too many public Community requests were made in this time window.",
          retryable: true,
          retryAt: new Date(Date.now() + retryAfter * 1_000),
        }),
      );
    } catch (error) {
      request.log.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Public Community request protection failed",
      );
      return reply.code(503).send(
        v1Error(request, {
          code: "TEMPORARILY_UNAVAILABLE",
          message: "Public Community request protection is temporarily unavailable.",
          retryable: true,
        }),
      );
    }
  };
}

export function registerPublicCommunityRoutes(
  app: FastifyInstance,
  options: PublicCommunityRouteOptions,
): void {
  const onRequest = publicDirectoryBoundary(options);

  app.get("/v1/public/communities", { onRequest }, async (request, reply) => {
    const query = directoryListQuerySchema.safeParse(request.query);
    if (!query.success) return publicValidationFailed(request, reply);

    try {
      const page = await options.service.listPublicCommunities(query.data);
      const response = serializeDirectoryPage(request, page);
      if (!response) {
        request.log.error(
          { itemCount: page.items.length },
          "Public Community directory projection violated its response contract",
        );
        return sendDirectoryError(request, reply, new Error("projection invalid"));
      }
      return response;
    } catch (error) {
      return sendDirectoryError(request, reply, error);
    }
  });

  app.post("/v1/public/communities/search", { onRequest }, async (request, reply) => {
    const body = FindCommunitiesRequestSchema.safeParse(request.body);
    if (!body.success) return publicValidationFailed(request, reply);

    try {
      const page = await options.service.searchPublicCommunities({
        query: body.data.query,
        proposedTitle: body.data.proposed_title,
        proposedSummary: body.data.proposed_summary,
        states: body.data.states,
        symbols: body.data.symbols,
        topics: body.data.topics,
        limit: body.data.limit,
        cursor: body.data.cursor,
      });
      const response = serializeDirectoryPage(request, page);
      if (!response) {
        request.log.error(
          { itemCount: page.items.length },
          "Public Community search projection violated its response contract",
        );
        return sendDirectoryError(request, reply, new Error("projection invalid"));
      }
      return response;
    } catch (error) {
      return sendDirectoryError(request, reply, error);
    }
  });

  app.get(
    "/v1/public/communities/by-slug/:slug",
    { onRequest },
    async (request, reply) => {
      const rawParameters = request.params as { slug?: unknown };
      const parameters = GetCommunityRequestSchema.safeParse({
        slug: rawParameters.slug,
      });
      if (!parameters.success || !parameters.data.slug) {
        return publicValidationFailed(request, reply);
      }

      try {
        const community = await options.service.getPublicCommunity({
          slug: parameters.data.slug,
        });
        const response = serializeCommunity(request, community);
        if (!response) {
          request.log.error(
            { communityKind: community.kind },
            "Public Community slug projection violated its response contract",
          );
          return sendDirectoryError(request, reply, new Error("projection invalid"));
        }
        return response;
      } catch (error) {
        return sendDirectoryError(request, reply, error);
      }
    },
  );

  app.get(
    "/v1/public/communities/:communityId",
    { onRequest },
    async (request, reply) => {
      const rawParameters = request.params as { communityId?: unknown };
      const parameters = GetCommunityRequestSchema.safeParse({
        community_id: rawParameters.communityId,
      });
      if (!parameters.success || !parameters.data.community_id) {
        return publicValidationFailed(request, reply);
      }

      try {
        const community = await options.service.getPublicCommunity({
          communityId: parameters.data.community_id,
        });
        const response = serializeCommunity(request, community);
        if (!response) {
          request.log.error(
            { communityKind: community.kind },
            "Public Community detail projection violated its response contract",
          );
          return sendDirectoryError(request, reply, new Error("projection invalid"));
        }
        return response;
      } catch (error) {
        return sendDirectoryError(request, reply, error);
      }
    },
  );
}

export function registerCommunityRoutes(
  app: FastifyInstance,
  options: CommunityRouteOptions,
): void {
  const findAuthorization = directoryAuthorizationBoundary(options, "find_communities");
  const getAuthorization = directoryAuthorizationBoundary(options, "get_community");

  app.get(
    "/v1/communities",
    { onRequest: findAuthorization.onRequest },
    async (request, reply) => {
      const authorization = findAuthorization.getAuthorization(request);
      const query = directoryListQuerySchema.safeParse(request.query);
      if (!query.success) return validationFailed(request, reply);

      try {
        const page = await options.service.listCommunities(
          authorization.context,
          query.data,
        );
        const response = serializeDirectoryPage(request, page);
        if (!response) {
          request.log.error(
            { itemCount: page.items.length },
            "Community directory projection violated its response contract",
          );
          return sendDirectoryError(request, reply, new Error("projection invalid"));
        }
        return response;
      } catch (error) {
        return sendDirectoryError(request, reply, error);
      }
    },
  );

  app.post(
    "/v1/communities/search",
    { onRequest: findAuthorization.onRequest },
    async (request, reply) => {
      const authorization = findAuthorization.getAuthorization(request);
      const body = FindCommunitiesRequestSchema.safeParse(request.body);
      if (!body.success) return validationFailed(request, reply);
      return handleAgentFindCommunities(
        request,
        reply,
        options.service,
        authorization.context,
        body.data,
      );
    },
  );

  // Keep this static route ahead of /:communityId so "by-slug" can never be
  // interpreted as an opaque Community ID by this or another HTTP adapter.
  app.get(
    "/v1/communities/by-slug/:slug",
    { onRequest: getAuthorization.onRequest },
    async (request, reply) => {
      const authorization = getAuthorization.getAuthorization(request);
      const rawParameters = request.params as { slug?: unknown };
      const parameters = GetCommunityRequestSchema.safeParse({
        slug: rawParameters.slug,
      });
      if (!parameters.success || !parameters.data.slug) {
        return validationFailed(request, reply);
      }

      return handleAgentGetCommunity(
        request,
        reply,
        options.service,
        authorization.context,
        { slug: parameters.data.slug },
        "Community slug",
      );
    },
  );

  app.get(
    "/v1/communities/:communityId",
    { onRequest: getAuthorization.onRequest },
    async (request, reply) => {
      const authorization = getAuthorization.getAuthorization(request);
      const rawParameters = request.params as { communityId?: unknown };
      const parameters = GetCommunityRequestSchema.safeParse({
        community_id: rawParameters.communityId,
      });
      if (!parameters.success || !parameters.data.community_id) {
        return validationFailed(request, reply);
      }

      return handleAgentGetCommunity(
        request,
        reply,
        options.service,
        authorization.context,
        { communityId: parameters.data.community_id },
      );
    },
  );
}
