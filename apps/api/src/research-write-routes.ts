import {
  CreatePostRequestSchema,
  CreatePostWriteResultSchema,
  ReplyToContentRequestSchema,
  ReplyToContentWriteResultSchema,
  type CreatePostWriteResult,
  type ReplyToContentWriteResult,
  type V1ErrorDetail,
} from "@alphanet/contracts";
import {
  ResearchWriteError,
  type AgentConnectionService,
  type ResearchWriteErrorCode,
  type ResearchWriteOutcome,
  type ResearchWriteService,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createAgentRequestAuthorizationBoundary,
  type AgentRequestRateLimiter,
} from "./agent-request.js";
import { v1Error } from "./agent-routes.js";

export interface ResearchWriteRouteOptions {
  agentConnectionService: Pick<AgentConnectionService, "authenticateStaticApiKey">;
  rateLimiter?: AgentRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: ResearchWriteService;
}

function validationFailed(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code: "VALIDATION_ERROR",
      message: "The request does not match the Agent API contract.",
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTransportIdempotencyKey(value: string | undefined): string | null {
  // Some HTTP adapters and proxies comma-join duplicate field lines before
  // Fastify sees them. Commas are therefore intentionally excluded at this
  // transport boundary so a duplicated Idempotency-Key can never collapse
  // into a different valid logical key.
  return value !== undefined && !value.includes(",") ? value : null;
}

function idempotencyKey(request: FastifyRequest): string | null {
  const distinctValues = request.raw.headersDistinct?.["idempotency-key"];
  if (distinctValues) {
    return distinctValues.length === 1
      ? validTransportIdempotencyKey(distinctValues[0])
      : null;
  }

  const rawValues: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      const value = request.raw.rawHeaders[index + 1];
      if (value !== undefined) rawValues.push(value);
    }
  }
  if (rawValues.length > 0) {
    return rawValues.length === 1 ? validTransportIdempotencyKey(rawValues[0]) : null;
  }

  const normalized = request.headers["idempotency-key"];
  if (Array.isArray(normalized)) {
    return normalized.length === 1 ? validTransportIdempotencyKey(normalized[0]) : null;
  }
  return validTransportIdempotencyKey(normalized);
}

function publicError(error: ResearchWriteOutcome["error"]): V1ErrorDetail | null {
  if (error === null) return null;
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    details: error.details,
    retry_after_ms: error.retryAfterMs,
  };
}

function publicPendingAction(outcome: ResearchWriteOutcome) {
  const action = outcome.pendingAction;
  return action === null
    ? null
    : {
        id: action.id,
        operation: action.operation,
        state: action.state,
        expires_at: action.expiresAt.toISOString(),
        input_digest: action.inputDigest,
        requested_at: action.requestedAt.toISOString(),
        decision_id: action.decisionId,
        policy_version: action.policyVersion,
        approval_summary: action.approvalSummary,
      };
}

function serializeCreatePost(
  request: FastifyRequest,
  outcome: ResearchWriteOutcome,
): CreatePostWriteResult | null {
  if (outcome.operation !== "create_post") return null;
  const result =
    outcome.result === null || "rootContentId" in outcome.result
      ? null
      : {
          content_id: outcome.result.contentId,
          revision_id: outcome.result.revisionId,
          resource_version: outcome.result.resourceVersion,
        };
  const parsed = CreatePostWriteResultSchema.safeParse({
    decision: outcome.decision,
    status: outcome.status,
    result,
    pending_action: publicPendingAction(outcome),
    error: publicError(outcome.error),
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function serializeReply(
  request: FastifyRequest,
  outcome: ResearchWriteOutcome,
): ReplyToContentWriteResult | null {
  if (outcome.operation !== "reply_to_content") return null;
  const result =
    outcome.result !== null && "rootContentId" in outcome.result
      ? {
          content_id: outcome.result.contentId,
          root_content_id: outcome.result.rootContentId,
          revision_id: outcome.result.revisionId,
          resource_version: outcome.result.resourceVersion,
        }
      : null;
  const parsed = ReplyToContentWriteResultSchema.safeParse({
    decision: outcome.decision,
    status: outcome.status,
    result,
    pending_action: publicPendingAction(outcome),
    error: publicError(outcome.error),
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function sendWriteError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof ResearchWriteError) {
    const retryAt =
      error.retryAfterMs === null ? undefined : new Date(Date.now() + error.retryAfterMs);
    if (error.retryAfterMs !== null) {
      void reply.header(
        "retry-after",
        String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))),
      );
    }
    return reply.code(error.statusCode).send(
      v1Error(request, {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        retryAt,
        details: error.details,
      }),
    );
  }

  request.log.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Research write request failed",
  );
  return reply.code(503).send(
    v1Error(request, {
      code: "WRITE_UNAVAILABLE",
      message: "The research write service is temporarily unavailable.",
      retryable: true,
    }),
  );
}

function sendOutcome(
  reply: FastifyReply,
  outcome: ResearchWriteOutcome,
  response: CreatePostWriteResult | ReplyToContentWriteResult,
): FastifyReply {
  if (outcome.status === "pending_approval" && outcome.pendingAction) {
    void reply.header("location", `/v1/actions/${outcome.pendingAction.id}`);
    void reply.header("retry-after", "5");
    return reply.code(202).send(response);
  }
  if (outcome.status === "succeeded") {
    return reply.code(201).send(response);
  }
  if (outcome.error?.retryAfterMs !== null && outcome.error?.retryAfterMs !== undefined) {
    void reply.header(
      "retry-after",
      String(Math.max(1, Math.ceil(outcome.error.retryAfterMs / 1_000))),
    );
  }
  return reply.code(statusForOutcomeError(outcome.error?.code)).send(response);
}

function statusForOutcomeError(code: ResearchWriteErrorCode | undefined): number {
  switch (code) {
    case "ACTION_CANCELLED":
    case "ACTION_EXECUTION_FAILED":
    case "ACTION_EXPIRED":
    case "ACTION_INVALIDATED":
    case "ACTION_REJECTED":
      return 409;
    case "AUTHORIZATION_CONTEXT_STALE":
      return 401;
    case "COMMUNITY_NOT_FOUND":
    case "CONTENT_NOT_FOUND":
      return 404;
    case "IDEMPOTENCY_CONFLICT":
    case "IDEMPOTENCY_IN_PROGRESS":
      return 409;
    case "COMMUNITY_RESTRICTED":
    case "POLICY_DENIED":
    case "REPLIES_CLOSED":
    case "SCOPE_REQUIRED":
      return 403;
    case "RATE_LIMITED":
      return 429;
    case "VALIDATION_ERROR":
      return 422;
    case "IDEMPOTENCY_RESULT_CORRUPT":
    case undefined:
      return 503;
  }
}

function writeAuthorizationBoundary(
  options: ResearchWriteRouteOptions,
  operation: "create_post" | "reply_to_content",
) {
  const boundary = createAgentRequestAuthorizationBoundary({
    operation,
    policyEnforcement: "domain",
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

export function registerResearchWriteRoutes(
  app: FastifyInstance,
  options: ResearchWriteRouteOptions,
): void {
  const createPostAuthorization = writeAuthorizationBoundary(options, "create_post");
  const replyAuthorization = writeAuthorizationBoundary(options, "reply_to_content");

  app.post(
    "/v1/posts",
    { onRequest: createPostAuthorization.onRequest },
    async (request, reply) => {
      const authorization = createPostAuthorization.getAuthorization(request);
      const key = idempotencyKey(request);
      if (!key || !isRecord(request.body) || "idempotency_key" in request.body) {
        return validationFailed(request, reply);
      }
      const body = CreatePostRequestSchema.safeParse({
        ...request.body,
        idempotency_key: key,
      });
      if (!body.success) return validationFailed(request, reply);

      try {
        const outcome = await options.service.createPost(
          authorization.context,
          {
            title: body.data.title,
            bodyMarkdown: body.data.body_markdown,
            primaryCommunityId: body.data.primary_community_id,
            additionalCommunityIds: body.data.additional_community_ids,
            symbols: body.data.symbols,
            topics: body.data.topics,
            sourceLinks: body.data.source_links,
            references: body.data.references?.map((reference) => ({
              targetContentId: reference.target_content_id,
              relationType: reference.relation_type,
            })),
            idempotencyKey: body.data.idempotency_key,
          },
          { channel: "rest", requestId: request.id },
        );
        const response = serializeCreatePost(request, outcome);
        if (!response) {
          request.log.error(
            { operation: outcome.operation, status: outcome.status },
            "Create-post result violated its public response contract",
          );
          return sendWriteError(request, reply, new Error("projection invalid"));
        }
        return sendOutcome(reply, outcome, response);
      } catch (error) {
        return sendWriteError(request, reply, error);
      }
    },
  );

  app.post(
    "/v1/content/:contentId/replies",
    { onRequest: replyAuthorization.onRequest },
    async (request, reply) => {
      const authorization = replyAuthorization.getAuthorization(request);
      const key = idempotencyKey(request);
      const parameters = request.params as { contentId?: unknown };
      if (
        !key ||
        !isRecord(request.body) ||
        "idempotency_key" in request.body ||
        "parent_content_id" in request.body
      ) {
        return validationFailed(request, reply);
      }
      const body = ReplyToContentRequestSchema.safeParse({
        ...request.body,
        parent_content_id: parameters.contentId,
        idempotency_key: key,
      });
      if (!body.success) return validationFailed(request, reply);

      try {
        const outcome = await options.service.replyToContent(
          authorization.context,
          {
            parentContentId: body.data.parent_content_id,
            bodyMarkdown: body.data.body_markdown,
            symbols: body.data.symbols,
            topics: body.data.topics,
            sourceLinks: body.data.source_links,
            references: body.data.references?.map((reference) => ({
              targetContentId: reference.target_content_id,
              relationType: reference.relation_type,
            })),
            idempotencyKey: body.data.idempotency_key,
          },
          { channel: "rest", requestId: request.id },
        );
        const response = serializeReply(request, outcome);
        if (!response) {
          request.log.error(
            { operation: outcome.operation, status: outcome.status },
            "Reply result violated its public response contract",
          );
          return sendWriteError(request, reply, new Error("projection invalid"));
        }
        return sendOutcome(reply, outcome, response);
      } catch (error) {
        return sendWriteError(request, reply, error);
      }
    },
  );
}
