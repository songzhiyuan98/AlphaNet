import {
  GetActionStatusRequestSchema,
  GetActionStatusResponseSchema,
  type GetActionStatusResponse,
} from "@alphanet/contracts";
import {
  PendingActionStatusError,
  type AgentConnectionService,
  type AgentPendingActionView,
  type PendingActionStatusService,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createAgentRequestAuthorizationBoundary,
  type AgentRequestRateLimiter,
} from "./agent-request.js";
import { v1Error } from "./agent-routes.js";

export interface PendingActionRouteOptions {
  agentConnectionService: Pick<AgentConnectionService, "authenticateStaticApiKey">;
  rateLimiter?: AgentRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: PendingActionStatusService;
}

function validationFailed(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code: "INVALID_ARGUMENT",
      message: "The request does not match the Agent API contract.",
    }),
  );
}

function serializeAction(
  request: FastifyRequest,
  action: AgentPendingActionView,
): GetActionStatusResponse | null {
  const expectedVersion =
    action.operation === "update_content" || action.operation === "delete_content"
      ? { expected_version: action.expectedVersion }
      : {};
  const parsed = GetActionStatusResponseSchema.safeParse({
    action: {
      id: action.id,
      operation: action.operation,
      ...expectedVersion,
      decision: action.decision,
      status: action.status,
      state: action.state,
      decision_id: action.decisionId,
      policy_version: action.policyVersion,
      requested_at: action.requestedAt.toISOString(),
      expires_at: action.expiresAt.toISOString(),
      decided_at: action.decidedAt?.toISOString() ?? null,
      executing_at: action.executingAt?.toISOString() ?? null,
      completed_at: action.completedAt?.toISOString() ?? null,
      terminal_at: action.terminalAt?.toISOString() ?? null,
      input_digest: action.inputDigest,
      approval_summary: action.approvalSummary,
      approval_outcome: action.approvalOutcome,
      approval_method: action.approvalMethod,
      decided_by_owner_id: action.decidedByOwnerId,
      result: action.result,
      error: action.error,
    },
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function sendActionError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof PendingActionStatusError) {
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
    "PendingAction status request failed",
  );
  return reply.code(503).send(
    v1Error(request, {
      code: "ACTION_STATUS_UNAVAILABLE",
      message: "Action status is temporarily unavailable.",
      retryable: true,
    }),
  );
}

export function registerPendingActionRoutes(
  app: FastifyInstance,
  options: PendingActionRouteOptions,
): void {
  const authorizationBoundary = createAgentRequestAuthorizationBoundary({
    operation: "get_action_status",
    service: options.agentConnectionService,
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  });

  app.get(
    "/v1/actions/:actionId",
    {
      async onRequest(request, reply) {
        void reply.header("cache-control", "no-store, private");
        void reply.header("pragma", "no-cache");
        return authorizationBoundary.onRequest(request, reply);
      },
    },
    async (request, reply) => {
      const authorization = authorizationBoundary.getAuthorization(request);

      const rawParameters = request.params as { actionId?: unknown };
      const parameters = GetActionStatusRequestSchema.safeParse({
        action_id: rawParameters.actionId,
      });
      if (!parameters.success) {
        return validationFailed(request, reply);
      }

      try {
        const action = await options.service.getActionStatus(
          {
            ownerId: authorization.context.owner.id,
            agentId: authorization.context.agent.id,
          },
          parameters.data.action_id,
        );
        const response = serializeAction(request, action);
        if (!response) {
          request.log.error(
            { actionState: action.state, operation: action.operation },
            "PendingAction public projection violated its response contract",
          );
          return sendActionError(request, reply, new Error("projection invalid"));
        }
        return response;
      } catch (error) {
        return sendActionError(request, reply, error);
      }
    },
  );
}
