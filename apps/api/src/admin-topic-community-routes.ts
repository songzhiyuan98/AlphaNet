import {
  AdminTopicCommunityCreateHeadersSchema,
  AdminTopicCommunityCreateRequestSchema,
  AdminTopicCommunityListRequestSchema,
  AdminTopicCommunityListResponseSchema,
  AdminTopicCommunityMutationResponseSchema,
  AdminTopicCommunityPatchHeadersSchema,
  AdminTopicCommunityPatchRequestSchema,
  AdminTopicCommunityPathParamsSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  TopicCommunityManagementError,
  type AdminTopicCommunityContext,
  type TopicCommunityPage,
  type TopicCommunityManagementService,
  type TopicCommunityMutation,
  type TopicCommunityView,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createAdminRequestAuthorizationBoundary,
  type AdminRequestRuntime,
  type AuthorizedAdminRequest,
} from "./admin-request.js";
import { v1Error } from "./agent-routes.js";

export interface AdminTopicCommunityRouteOptions {
  adminRuntime: AdminRequestRuntime;
  service: Pick<TopicCommunityManagementService, "create" | "list" | "update">;
}

const listQueryNames = new Set(["states", "query", "limit", "cursor"]);

function noQuery(request: FastifyRequest): boolean {
  return new URL(request.url, "http://alphanet.invalid").searchParams.size === 0;
}

function listRequest(request: FastifyRequest) {
  const parameters = new URL(request.url, "http://alphanet.invalid").searchParams;
  for (const name of parameters.keys()) {
    if (!listQueryNames.has(name) || parameters.getAll(name).length !== 1) return null;
  }
  const rawLimit = parameters.get("limit");
  const limit =
    rawLimit === null
      ? undefined
      : /^[1-9][0-9]*$/u.test(rawLimit)
        ? Number(rawLimit)
        : null;
  if (limit === null || (limit !== undefined && !Number.isSafeInteger(limit))) {
    return null;
  }
  const rawStates = parameters.get("states");
  const states = rawStates === null ? undefined : rawStates.split(",");
  if (states !== undefined && states.some((state) => state.length === 0)) return null;
  const parsed = AdminTopicCommunityListRequestSchema.safeParse({
    ...(parameters.has("cursor") ? { cursor: parameters.get("cursor") } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(parameters.has("query") ? { query: parameters.get("query") } : {}),
    ...(states === undefined ? {} : { states }),
  });
  return parsed.success ? parsed.data : null;
}

function createHeaders(request: FastifyRequest) {
  const idempotencyKey = request.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.includes(",")) {
    return null;
  }
  const parsed = AdminTopicCommunityCreateHeadersSchema.safeParse({
    "idempotency-key": idempotencyKey,
  });
  return parsed.success ? parsed.data : null;
}

function patchHeaders(request: FastifyRequest) {
  const idempotencyKey = request.headers["idempotency-key"];
  const ifMatch = request.headers["if-match"];
  if (
    typeof idempotencyKey !== "string" ||
    typeof ifMatch !== "string" ||
    idempotencyKey.includes(",") ||
    ifMatch.includes(",")
  ) {
    return null;
  }
  const parsed = AdminTopicCommunityPatchHeadersSchema.safeParse({
    "idempotency-key": idempotencyKey,
    "if-match": ifMatch,
  });
  return parsed.success ? parsed.data : null;
}

function adminContext(
  request: FastifyRequest,
  authorization: AuthorizedAdminRequest,
): AdminTopicCommunityContext {
  return {
    adminId: authorization.adminId,
    authenticationAssurance: authorization.authenticationAssurance,
    mfa: authorization.mfa,
    permission: "community:manage",
    permissions: authorization.permissions,
    requestId: request.id,
    roles: authorization.roles,
  };
}

function communityProjection(community: TopicCommunityView) {
  return {
    canonical_topic: {
      id: community.canonicalTopic.id,
      slug: community.canonicalTopic.slug,
    },
    created_at: community.createdAt.toISOString(),
    description_markdown: community.descriptionMarkdown,
    id: community.id,
    kind: community.kind,
    name: community.name,
    posting_policy: {
      allowed_content: community.postingPolicy.allowedContent,
      max_posts_per_hour: community.postingPolicy.maxPostsPerHour,
      requires_sources: community.postingPolicy.requiresSources,
    },
    slug: community.slug,
    state: community.state,
    updated_at: community.updatedAt.toISOString(),
    version: community.version,
  };
}

function responseProjection(request: FastifyRequest, mutation: TopicCommunityMutation) {
  const parsed = AdminTopicCommunityMutationResponseSchema.safeParse({
    action: {
      action: mutation.action.action,
      action_id: mutation.action.actionId,
      admin_id: mutation.action.adminId,
      community_version_after: mutation.action.communityVersionAfter,
      community_version_before: mutation.action.communityVersionBefore,
      occurred_at: mutation.action.occurredAt.toISOString(),
      permission_used: mutation.action.permissionUsed,
    },
    community: communityProjection(mutation.community),
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function listProjection(request: FastifyRequest, page: TopicCommunityPage) {
  const parsed = AdminTopicCommunityListResponseSchema.safeParse({
    capabilities: { can_manage: true },
    items: page.items.map((community) => ({
      ...communityProjection(community),
      content_count: community.contentCount,
    })),
    ordering: {
      as_of: page.asOf.toISOString(),
      ordering_version: page.orderingVersion,
      snapshot_id: page.snapshotId,
    },
    page: {
      has_more: page.hasMore,
      limit: page.limit,
      next_cursor: page.nextCursor,
    },
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function checkedError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  options: Parameters<typeof v1Error>[1],
): FastifyReply {
  const parsed = V1ErrorResponseSchema.safeParse(v1Error(request, options));
  if (parsed.success) return reply.code(statusCode).send(parsed.data);
  request.log.error(
    { errorName: "AdminTopicCommunityErrorProjectionError" },
    "Topic-community error projection was invalid",
  );
  return reply.code(503).send(
    V1ErrorResponseSchema.parse(
      v1Error(request, {
        code: "TOPIC_COMMUNITY_UNAVAILABLE",
        message: "Topic-community management is temporarily unavailable.",
        retryable: true,
      }),
    ),
  );
}

function invalid(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return checkedError(request, reply, 422, {
    code: "INVALID_ARGUMENT",
    message: "The request does not match the topic-community API contract.",
  });
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof TopicCommunityManagementError) {
    if (error.statusCode === 401) {
      void reply.header("www-authenticate", 'Bearer realm="alphanet-admin"');
    }
    return checkedError(request, reply, error.statusCode, {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.currentVersion === null
        ? {}
        : { details: { current_version: error.currentVersion } }),
    });
  }
  request.log.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Topic-community request failed",
  );
  return checkedError(request, reply, 503, {
    code: "TOPIC_COMMUNITY_UNAVAILABLE",
    message: "Topic-community management is temporarily unavailable.",
    retryable: true,
  });
}

function sendMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  mutation: TopicCommunityMutation,
): FastifyReply {
  const response = responseProjection(request, mutation);
  if (!response) {
    return sendError(request, reply, new Error("Invalid topic-community projection."));
  }
  void reply.header("etag", `"${response.community.version}"`);
  return reply.code(mutation.replayed ? 200 : 201).send(response);
}

export function registerAdminTopicCommunityRoutes(
  app: FastifyInstance,
  options: AdminTopicCommunityRouteOptions,
): void {
  const readAuthorization = createAdminRequestAuthorizationBoundary({
    ...options.adminRuntime,
    mode: "read",
    permission: "community:manage",
  });
  const mutationAuthorization = createAdminRequestAuthorizationBoundary({
    ...options.adminRuntime,
    mode: "mutation",
    permission: "community:manage",
  });

  app.get(
    "/v1/admin/topic-communities",
    { onRequest: readAuthorization.onRequest },
    async (request, reply) => {
      const query = listRequest(request);
      if (!query || request.body !== undefined) return invalid(request, reply);
      try {
        const page = await options.service.list(
          adminContext(request, readAuthorization.getAuthorization(request)),
          {
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query.limit === undefined ? {} : { limit: query.limit }),
            ...(query.query === undefined ? {} : { query: query.query }),
            ...(query.states === undefined ? {} : { states: query.states }),
          },
        );
        const response = listProjection(request, page);
        return response
          ? reply.code(200).send(response)
          : sendError(request, reply, new Error("Invalid list projection."));
      } catch (error) {
        return sendError(request, reply, error);
      }
    },
  );

  app.post(
    "/v1/admin/topic-communities",
    { onRequest: mutationAuthorization.onRequest },
    async (request, reply) => {
      const headers = createHeaders(request);
      const body = AdminTopicCommunityCreateRequestSchema.safeParse(request.body);
      if (!headers || !body.success || !noQuery(request)) {
        return invalid(request, reply);
      }
      try {
        const mutation = await options.service.create(
          adminContext(request, mutationAuthorization.getAuthorization(request)),
          {
            ...(body.data.description_markdown === undefined
              ? {}
              : { descriptionMarkdown: body.data.description_markdown }),
            idempotencyKey: headers["idempotency-key"],
            name: body.data.name,
            slug: body.data.slug,
          },
        );
        return sendMutation(request, reply, mutation);
      } catch (error) {
        return sendError(request, reply, error);
      }
    },
  );

  app.patch(
    "/v1/admin/topic-communities/:community_id",
    { onRequest: mutationAuthorization.onRequest },
    async (request, reply) => {
      const path = AdminTopicCommunityPathParamsSchema.safeParse(request.params);
      const headers = patchHeaders(request);
      const body = AdminTopicCommunityPatchRequestSchema.safeParse(request.body);
      if (!path.success || !headers || !body.success || !noQuery(request)) {
        return invalid(request, reply);
      }
      try {
        const mutation = await options.service.update(
          adminContext(request, mutationAuthorization.getAuthorization(request)),
          {
            communityId: path.data.community_id,
            ...(body.data.description_markdown === undefined
              ? {}
              : { descriptionMarkdown: body.data.description_markdown }),
            expectedVersion: Number(headers["if-match"].slice(1, -1)),
            idempotencyKey: headers["idempotency-key"],
            ...(body.data.name === undefined ? {} : { name: body.data.name }),
            ...(body.data.state === undefined ? {} : { state: body.data.state }),
          },
        );
        return sendMutation(request, reply, mutation);
      } catch (error) {
        return sendError(request, reply, error);
      }
    },
  );
}
