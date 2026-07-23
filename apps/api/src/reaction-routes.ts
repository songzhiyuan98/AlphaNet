import {
  SetReactionPathParamsSchema,
  SetReactionRequestSchema,
  SetReactionWriteResultSchema,
  type SetReactionPathParams,
  type SetReactionRequest,
  type SetReactionWriteResult,
  type V1ErrorDetail,
} from "@alphanet/contracts";
import {
  ReactionWriteError,
  type AgentConnectionService,
  type ReactionWriteErrorCode,
  type ReactionWriteOutcome,
  type ReactionWriteService,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  AGENT_WRITE_REQUEST_RATE_LIMIT_CATEGORY,
  createAgentRequestAuthorizationBoundary,
  type AgentRequestRateLimiter,
} from "./agent-request.js";
import { v1Error } from "./agent-routes.js";
import { idempotencyKey } from "./research-write-routes.js";

export interface ReactionRouteOptions {
  agentConnectionService: Pick<AgentConnectionService, "authenticateStaticApiKey">;
  rateLimiter?: AgentRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: ReactionWriteService;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validationFailed(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code: "VALIDATION_ERROR",
      message: "The request does not match the Agent Reaction API contract.",
    }),
  );
}

function publicError(error: ReactionWriteOutcome["error"]): V1ErrorDetail | null {
  if (error === null) return null;
  return {
    code: error.code,
    details: error.details,
    message: error.message,
    retry_after_ms: error.retryAfterMs,
    retryable: error.retryable,
  };
}

export interface ReactionOutcomeProjectionInput {
  active: boolean;
  contentId: string;
  reaction: SetReactionPathParams["reaction"];
}

export function serializeReactionOutcome(
  request: FastifyRequest,
  outcome: ReactionWriteOutcome,
  expected: ReactionOutcomeProjectionInput,
): SetReactionWriteResult | null {
  const expectedContentId = expected.contentId.normalize("NFC").toLowerCase();
  if (
    outcome.result !== null &&
    (outcome.result.contentId !== expectedContentId ||
      outcome.result.viewerState.reactions.includes(expected.reaction) !==
        expected.active)
  ) {
    return null;
  }
  const parsed = SetReactionWriteResultSchema.safeParse({
    decision: outcome.decision,
    error: publicError(outcome.error),
    pending_action: null,
    request_id: request.id,
    result:
      outcome.result === null
        ? null
        : {
            content_id: outcome.result.contentId,
            reaction_counts: outcome.result.reactionCounts,
            viewer_state: outcome.result.viewerState,
          },
    schema_version: "1",
    status: outcome.status,
  });
  return parsed.success ? parsed.data : null;
}

export type AgentSetReactionInput = SetReactionPathParams & SetReactionRequest;

export function statusForReactionError(code: ReactionWriteErrorCode | undefined): number {
  switch (code) {
    case "AUTHORIZATION_CONTEXT_STALE":
      return 401;
    case "COMMUNITY_RESTRICTED":
      return 403;
    case "CONTENT_NOT_FOUND":
      return 404;
    case "CONTENT_STATE_INVALID":
    case "IDEMPOTENCY_CONFLICT":
    case "IDEMPOTENCY_IN_PROGRESS":
    case "SELF_REACTION_NOT_ALLOWED":
      return 409;
    case "POLICY_DENIED":
    case "SCOPE_REQUIRED":
      return 403;
    case "RATE_LIMITED":
      return 429;
    case "PLATFORM_WRITE_PAUSED":
      return 503;
    case "VALIDATION_ERROR":
      return 422;
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

function sendThrownError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof ReactionWriteError) {
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
    "Reaction write request failed",
  );
  return reply.code(503).send(
    v1Error(request, {
      code: "WRITE_UNAVAILABLE",
      message: "The Reaction service is temporarily unavailable.",
      retryable: true,
    }),
  );
}

export function sendReactionOutcome(
  request: FastifyRequest,
  reply: FastifyReply,
  outcome: ReactionWriteOutcome,
  expected: ReactionOutcomeProjectionInput,
): FastifyReply {
  const response = serializeReactionOutcome(request, outcome, expected);
  if (response === null) {
    request.log.error(
      { decision: outcome.decision, status: outcome.status },
      "Reaction result violated its response contract",
    );
    return sendThrownError(request, reply, new Error("projection invalid"));
  }
  if (outcome.status === "succeeded") {
    return reply.code(200).send(response);
  }
  applyRetryAfter(reply, outcome.error?.retryAfterMs ?? null);
  return reply.code(statusForReactionError(outcome.error?.code)).send(response);
}

export async function handleAgentSetReaction(
  request: FastifyRequest,
  reply: FastifyReply,
  service: Pick<ReactionWriteService, "setReaction">,
  context: Parameters<ReactionWriteService["setReaction"]>[0],
  input: AgentSetReactionInput,
  channel: "mcp" | "rest",
): Promise<unknown> {
  try {
    const outcome = await service.setReaction(
      context,
      {
        active: input.active,
        contentId: input.content_id,
        idempotencyKey: input.idempotency_key,
        reaction: input.reaction,
      },
      { channel, requestId: request.id },
    );
    return sendReactionOutcome(request, reply, outcome, {
      active: input.active,
      contentId: input.content_id,
      reaction: input.reaction,
    });
  } catch (error) {
    return sendThrownError(request, reply, error);
  }
}

export function registerReactionRoutes(
  app: FastifyInstance,
  options: ReactionRouteOptions,
): void {
  const authorization = createAgentRequestAuthorizationBoundary({
    operation: "set_reaction",
    policyEnforcement: "domain",
    rateLimitCategory: AGENT_WRITE_REQUEST_RATE_LIMIT_CATEGORY,
    service: options.agentConnectionService,
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  });

  app.put(
    "/v1/content/:content_id/reactions/:reaction",
    {
      onRequest: async (request, reply) => {
        void reply.header("cache-control", "no-store, private");
        void reply.header("pragma", "no-cache");
        return authorization.onRequest(request, reply);
      },
    },
    async (request, reply) => {
      const authorized = authorization.getAuthorization(request);
      const key = idempotencyKey(request);
      const path = SetReactionPathParamsSchema.safeParse(request.params);
      if (
        !key ||
        !path.success ||
        !isRecord(request.body) ||
        "idempotency_key" in request.body
      ) {
        return validationFailed(request, reply);
      }
      const body = SetReactionRequestSchema.safeParse({
        ...request.body,
        idempotency_key: key,
      });
      if (!body.success) return validationFailed(request, reply);
      return handleAgentSetReaction(
        request,
        reply,
        options.service,
        authorized.context,
        { ...path.data, ...body.data },
        "rest",
      );
    },
  );
}
