import {
  FollowListRequestSchema,
  FollowListResponseSchema,
  SetFollowPathParamsSchema,
  SetFollowRequestSchema,
  SetFollowWriteResultSchema,
  type FollowListResponse,
  type SetFollowWriteResult,
  type V1ErrorDetail,
} from "@alphanet/contracts";
import {
  FollowError,
  type AgentConnectionService,
  type FollowErrorCode,
  type FollowListPage,
  type FollowService,
  type FollowWriteOutcome,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createAgentRequestAuthorizationBoundary,
  type AgentRequestRateLimiter,
} from "./agent-request.js";
import { v1Error } from "./agent-routes.js";
import { idempotencyKey } from "./research-write-routes.js";

export interface FollowRouteOptions {
  agentConnectionService: Pick<AgentConnectionService, "authenticateStaticApiKey">;
  rateLimiter?: AgentRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: FollowService;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function queryNumber(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  return Number(value);
}

function normalizeListQuery(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    ...(value.limit === undefined ? {} : { limit: queryNumber(value.limit) }),
  };
}

function validationFailed(
  request: FastifyRequest,
  reply: FastifyReply,
  code: "INVALID_ARGUMENT" | "VALIDATION_ERROR",
): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code,
      message: "The request does not match the Agent Follow API contract.",
    }),
  );
}

function publicError(error: FollowWriteOutcome["error"]): V1ErrorDetail | null {
  if (error === null) return null;
  return {
    code: error.code,
    details: error.details,
    message: error.message,
    retry_after_ms: error.retryAfterMs,
    retryable: error.retryable,
  };
}

function serializeWriteOutcome(
  request: FastifyRequest,
  outcome: FollowWriteOutcome,
): SetFollowWriteResult | null {
  const parsed = SetFollowWriteResultSchema.safeParse({
    decision: outcome.decision,
    error: publicError(outcome.error),
    pending_action: null,
    request_id: request.id,
    result:
      outcome.result === null
        ? null
        : {
            active: outcome.result.active,
            notification_level: outcome.result.notificationLevel,
            target_id: outcome.result.targetId,
            target_type: outcome.result.targetType,
            updated_at: outcome.result.updatedAt.toISOString(),
          },
    schema_version: "1",
    status: outcome.status,
  });
  return parsed.success ? parsed.data : null;
}

function serializeListPage(
  request: FastifyRequest,
  page: FollowListPage,
): FollowListResponse | null {
  const parsed = FollowListResponseSchema.safeParse({
    items: page.items.map((follow) => ({
      created_at: follow.createdAt.toISOString(),
      follow_id: follow.followId,
      notification_level: follow.notificationLevel,
      target_id: follow.targetId,
      target_type: follow.targetType,
      updated_at: follow.updatedAt.toISOString(),
    })),
    ordering: {
      as_of: page.ordering.asOf.toISOString(),
      ordering_version: page.ordering.orderingVersion,
      snapshot_id: page.ordering.snapshotId,
    },
    page: {
      has_more: page.page.hasMore,
      limit: page.page.limit,
      next_cursor: page.page.nextCursor,
    },
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function statusForError(code: FollowErrorCode | undefined): number {
  switch (code) {
    case "AUTHORIZATION_CONTEXT_STALE":
      return 401;
    case "POLICY_DENIED":
    case "SCOPE_REQUIRED":
    case "TARGET_NOT_VISIBLE":
      return 403;
    case "TARGET_NOT_FOUND":
      return 404;
    case "CURSOR_EXPIRED":
    case "SNAPSHOT_EXPIRED":
      return 410;
    case "CURSOR_INVALID":
    case "INVALID_ARGUMENT":
      return 400;
    case "FOLLOW_LIMIT_REACHED":
    case "IDEMPOTENCY_CONFLICT":
    case "IDEMPOTENCY_IN_PROGRESS":
    case "SELF_FOLLOW_NOT_ALLOWED":
    case "TARGET_AMBIGUOUS":
      return 409;
    case "RATE_LIMITED":
      return 429;
    case "VALIDATION_ERROR":
      return 422;
    case "FOLLOW_DATA_INVALID":
    case "FOLLOW_NOT_READY":
    case "IDEMPOTENCY_RESULT_CORRUPT":
    case undefined:
      return 503;
  }
}

function applyRetryAfter(reply: FastifyReply, retryAfterMs: number | null): void {
  if (retryAfterMs !== null) {
    void reply.header(
      "retry-after",
      String(Math.max(1, Math.ceil(retryAfterMs / 1_000))),
    );
  }
}

function sendFollowError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof FollowError) {
    applyRetryAfter(reply, error.retryAfterMs);
    return reply.code(error.statusCode).send(
      v1Error(request, {
        code: error.code,
        details: error.details,
        message: error.message,
        retryable: error.retryable,
        ...(error.retryAfterMs === null
          ? {}
          : { retryAt: new Date(Date.now() + error.retryAfterMs) }),
      }),
    );
  }
  request.log.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Follow request failed",
  );
  return reply.code(503).send(
    v1Error(request, {
      code: "FOLLOW_NOT_READY",
      message: "The Follow service is temporarily unavailable.",
      retryable: true,
    }),
  );
}

export function registerFollowRoutes(
  app: FastifyInstance,
  options: FollowRouteOptions,
): void {
  const listAuthorization = createAgentRequestAuthorizationBoundary({
    operation: "list_follows",
    service: options.agentConnectionService,
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  });
  const writeAuthorization = createAgentRequestAuthorizationBoundary({
    operation: "set_follow",
    policyEnforcement: "domain",
    service: options.agentConnectionService,
    limits: {
      credential: { max: 20, window: 60 },
    },
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  });

  app.get(
    "/v1/follows",
    {
      onRequest: async (request, reply) => {
        void reply.header("cache-control", "no-store, private");
        void reply.header("pragma", "no-cache");
        return listAuthorization.onRequest(request, reply);
      },
    },
    async (request, reply) => {
      const parsed = FollowListRequestSchema.safeParse(normalizeListQuery(request.query));
      if (!parsed.success) {
        return validationFailed(request, reply, "INVALID_ARGUMENT");
      }
      try {
        const page = await options.service.listFollows(
          listAuthorization.getAuthorization(request).context,
          {
            ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
            ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
            ...(parsed.data.target_type === undefined
              ? {}
              : { targetType: parsed.data.target_type }),
          },
        );
        const response = serializeListPage(request, page);
        if (response === null) {
          request.log.error(
            { itemCount: page.items.length },
            "Follow list violated its public response contract",
          );
          return sendFollowError(request, reply, new Error("projection invalid"));
        }
        return response;
      } catch (error) {
        return sendFollowError(request, reply, error);
      }
    },
  );

  app.put(
    "/v1/follows/:target_type/:target_id",
    {
      onRequest: async (request, reply) => {
        void reply.header("cache-control", "no-store, private");
        void reply.header("pragma", "no-cache");
        return writeAuthorization.onRequest(request, reply);
      },
    },
    async (request, reply) => {
      const key = idempotencyKey(request);
      const path = SetFollowPathParamsSchema.safeParse(request.params);
      if (
        !key ||
        !path.success ||
        !isRecord(request.body) ||
        "idempotency_key" in request.body
      ) {
        return validationFailed(request, reply, "VALIDATION_ERROR");
      }
      const body = SetFollowRequestSchema.safeParse({
        ...request.body,
        idempotency_key: key,
      });
      if (!body.success) {
        return validationFailed(request, reply, "VALIDATION_ERROR");
      }

      try {
        const outcome = await options.service.setFollow(
          writeAuthorization.getAuthorization(request).context,
          {
            active: body.data.active,
            idempotencyKey: body.data.idempotency_key,
            ...(body.data.notification_level === undefined
              ? {}
              : { notificationLevel: body.data.notification_level }),
            targetId: path.data.target_id,
            targetType: path.data.target_type,
          },
          { channel: "rest", requestId: request.id },
        );
        const response = serializeWriteOutcome(request, outcome);
        if (response === null) {
          request.log.error(
            { decision: outcome.decision, status: outcome.status },
            "Follow write violated its public response contract",
          );
          return sendFollowError(request, reply, new Error("projection invalid"));
        }
        if (outcome.status === "succeeded") {
          return reply.code(200).send(response);
        }
        applyRetryAfter(reply, outcome.error?.retryAfterMs ?? null);
        return reply.code(statusForError(outcome.error?.code)).send(response);
      } catch (error) {
        return sendFollowError(request, reply, error);
      }
    },
  );
}
