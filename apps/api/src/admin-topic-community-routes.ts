import {
  AdminTopicCommunityCreateHeadersSchema,
  AdminTopicCommunityCreateRequestSchema,
  AdminTopicCommunityMutationResponseSchema,
  AdminTopicCommunityPatchHeadersSchema,
  AdminTopicCommunityPatchRequestSchema,
  AdminTopicCommunityPathParamsSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  TopicCommunityManagementError,
  type AdminTopicCommunityContext,
  type TopicCommunityManagementService,
  type TopicCommunityMutation,
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
  service: Pick<TopicCommunityManagementService, "create" | "update">;
}

function noQuery(request: FastifyRequest): boolean {
  return new URL(request.url, "http://alphanet.invalid").searchParams.size === 0;
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
    community: {
      canonical_topic: {
        id: mutation.community.canonicalTopic.id,
        slug: mutation.community.canonicalTopic.slug,
      },
      created_at: mutation.community.createdAt.toISOString(),
      description_markdown: mutation.community.descriptionMarkdown,
      id: mutation.community.id,
      kind: mutation.community.kind,
      name: mutation.community.name,
      posting_policy: {
        allowed_content: mutation.community.postingPolicy.allowedContent,
        max_posts_per_hour: mutation.community.postingPolicy.maxPostsPerHour,
        requires_sources: mutation.community.postingPolicy.requiresSources,
      },
      slug: mutation.community.slug,
      state: mutation.community.state,
      updated_at: mutation.community.updatedAt.toISOString(),
      version: mutation.community.version,
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
  const authorization = createAdminRequestAuthorizationBoundary({
    ...options.adminRuntime,
    mode: "mutation",
    permission: "community:manage",
  });

  app.post(
    "/v1/admin/topic-communities",
    { onRequest: authorization.onRequest },
    async (request, reply) => {
      const headers = createHeaders(request);
      const body = AdminTopicCommunityCreateRequestSchema.safeParse(request.body);
      if (!headers || !body.success || !noQuery(request)) {
        return invalid(request, reply);
      }
      try {
        const mutation = await options.service.create(
          adminContext(request, authorization.getAuthorization(request)),
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
    { onRequest: authorization.onRequest },
    async (request, reply) => {
      const path = AdminTopicCommunityPathParamsSchema.safeParse(request.params);
      const headers = patchHeaders(request);
      const body = AdminTopicCommunityPatchRequestSchema.safeParse(request.body);
      if (!path.success || !headers || !body.success || !noQuery(request)) {
        return invalid(request, reply);
      }
      try {
        const mutation = await options.service.update(
          adminContext(request, authorization.getAuthorization(request)),
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
