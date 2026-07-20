import {
  CommunityStateSchema,
  FindCommunitiesRequestSchema,
  FindCommunitiesResponseSchema,
  GetCommunityRequestSchema,
  GetCommunityResponseSchema,
  OpaqueCursorSchema,
  SymbolSchema,
  TopicSchema,
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

      try {
        const page = await options.service.searchCommunities(authorization.context, {
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
            "Community search projection violated its response contract",
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

      try {
        const community = await options.service.getCommunity(authorization.context, {
          communityId: parameters.data.community_id,
        });
        const response = serializeCommunity(request, community);
        if (!response) {
          request.log.error(
            { communityKind: community.kind },
            "Community detail projection violated its response contract",
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
