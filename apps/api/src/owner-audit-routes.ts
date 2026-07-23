import type { AlphaNetAuthRuntime } from "@alphanet/auth";
import {
  OwnerAuditActionListRequestSchema,
  OwnerAuditActionListResponseSchema,
  OwnerAuditSearchListRequestSchema,
  OwnerAuditSearchListResponseSchema,
  type OwnerAuditActionListRequest,
  type OwnerAuditActionListResponse,
  type OwnerAuditSearchListRequest,
  type OwnerAuditSearchListResponse,
} from "@alphanet/contracts";
import {
  OwnerAuditError,
  type OwnerAuditActionView,
  type OwnerAuditListInput,
  type OwnerAuditPage,
  type OwnerAuditSearchActivityView,
  type OwnerAuditSearchListInput,
  type OwnerAuditService,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { v1Error } from "./agent-routes.js";
import {
  createOwnerRequestAuthorizationBoundary,
  type OwnerRequestRateLimiter,
} from "./owner-request.js";

export interface OwnerAuditRouteOptions {
  allowedOrigins: readonly string[];
  authRuntime: Pick<AlphaNetAuthRuntime, "getOwnerSession">;
  rateLimiter?: OwnerRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: OwnerAuditService;
}

const actionQueryNames = new Set([
  "agent_id",
  "credential_id",
  "action",
  "outcome",
  "from",
  "to",
  "limit",
  "cursor",
]);
const searchQueryNames = new Set([
  "agent_id",
  "credential_id",
  "outcome",
  "surface",
  "from",
  "to",
  "limit",
  "cursor",
]);

function parseQuery<T>(
  request: FastifyRequest,
  allowedNames: ReadonlySet<string>,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
): T | null {
  const parameters = new URL(request.url, "http://alphanet.invalid").searchParams;
  const candidate: Record<string, string | number> = {};
  for (const name of parameters.keys()) {
    if (!allowedNames.has(name) || parameters.getAll(name).length !== 1) return null;
    const value = parameters.get(name);
    if (value === null || value.length === 0) return null;
    if (name === "limit") {
      if (!/^[1-9][0-9]*$/u.test(value)) return null;
      candidate[name] = Number(value);
    } else {
      candidate[name] = value;
    }
  }
  const parsed = schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function validationFailed(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code: "INVALID_ARGUMENT",
      message: "The request does not match the Owner audit contract.",
    }),
  );
}

function sendAuditError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof OwnerAuditError) {
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
    "Owner audit request failed",
  );
  return reply.code(503).send(
    v1Error(request, {
      code: "OWNER_AUDIT_UNAVAILABLE",
      message: "Owner audit is temporarily unavailable.",
      retryable: true,
    }),
  );
}

function actionInput(request: OwnerAuditActionListRequest): OwnerAuditListInput {
  return {
    ...(request.action === undefined ? {} : { action: request.action }),
    ...(request.agent_id === undefined ? {} : { agentId: request.agent_id }),
    ...(request.credential_id === undefined
      ? {}
      : { credentialId: request.credential_id }),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.from === undefined ? {} : { from: new Date(request.from) }),
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.outcome === undefined ? {} : { outcome: request.outcome }),
    ...(request.to === undefined ? {} : { to: new Date(request.to) }),
  };
}

function searchInput(request: OwnerAuditSearchListRequest): OwnerAuditSearchListInput {
  return {
    ...(request.agent_id === undefined ? {} : { agentId: request.agent_id }),
    ...(request.credential_id === undefined
      ? {}
      : { credentialId: request.credential_id }),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.from === undefined ? {} : { from: new Date(request.from) }),
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.outcome === undefined ? {} : { outcome: request.outcome }),
    ...(request.surface === undefined ? {} : { surface: request.surface }),
    ...(request.to === undefined ? {} : { to: new Date(request.to) }),
  };
}

function serializeAction(item: OwnerAuditActionView) {
  return {
    id: item.id,
    event_class: item.eventClass,
    occurred_at: item.occurredAt.toISOString(),
    actor:
      item.actor === null
        ? null
        : {
            id: item.actor.id,
            kind: item.actor.kind,
            handle: item.actor.handle,
            display_name: item.actor.displayName,
          },
    agent:
      item.agent === null
        ? null
        : {
            id: item.agent.id,
            handle: item.agent.handle,
            display_name: item.agent.displayName,
          },
    credential:
      item.credential === null
        ? null
        : {
            id: item.credential.id,
            name: item.credential.name,
            token_prefix: item.credential.tokenPrefix,
          },
    channel: item.channel,
    action: item.action,
    target: item.target,
    decision: item.decision,
    outcome: item.outcome,
    error_code: item.errorCode,
    reason_code: item.reasonCode,
    policy_version: item.policyVersion,
    approval_method: item.approvalMethod,
    approved_by_owner: item.approvedByOwner,
    request_id: item.requestId,
    outbox_event_id: item.outboxEventId,
    retry_count: item.retryCount,
  };
}

function actionResponse(
  request: FastifyRequest,
  query: OwnerAuditActionListRequest,
  page: OwnerAuditPage<OwnerAuditActionView>,
): OwnerAuditActionListResponse | null {
  const parsed = OwnerAuditActionListResponseSchema.safeParse({
    items: page.items.map(serializeAction),
    page: {
      limit: page.limit,
      has_more: page.hasMore,
      next_cursor: page.nextCursor,
    },
    filters: {
      agent_id: query.agent_id ?? null,
      credential_id: query.credential_id ?? null,
      action: query.action ?? null,
      outcome: query.outcome ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
    },
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function serializeSearch(item: OwnerAuditSearchActivityView) {
  return {
    id: item.id,
    occurred_at: item.occurredAt.toISOString(),
    finalized_at: item.finalizedAt?.toISOString() ?? null,
    expires_at: item.expiresAt.toISOString(),
    request_id: item.requestId,
    agent: {
      id: item.agent.id,
      handle: item.agent.handle,
      display_name: item.agent.displayName,
    },
    credential: {
      id: item.credential.id,
      name: item.credential.name,
      token_prefix: item.credential.tokenPrefix,
    },
    surface: item.surface,
    search_mode: item.searchMode,
    outcome: item.outcome,
    result_count: item.resultCount,
    latency_ms: item.latencyMs,
    fallback_reason_code: item.fallbackReasonCode,
  };
}

function searchResponse(
  request: FastifyRequest,
  query: OwnerAuditSearchListRequest,
  page: OwnerAuditPage<OwnerAuditSearchActivityView>,
): OwnerAuditSearchListResponse | null {
  const parsed = OwnerAuditSearchListResponseSchema.safeParse({
    items: page.items.map(serializeSearch),
    page: {
      limit: page.limit,
      has_more: page.hasMore,
      next_cursor: page.nextCursor,
    },
    filters: {
      agent_id: query.agent_id ?? null,
      credential_id: query.credential_id ?? null,
      outcome: query.outcome ?? null,
      surface: query.surface ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
    },
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

export function registerOwnerAuditRoutes(
  app: FastifyInstance,
  options: OwnerAuditRouteOptions,
): void {
  const authorization = createOwnerRequestAuthorizationBoundary({
    allowedOrigins: options.allowedOrigins,
    authRuntime: options.authRuntime,
    mode: "read",
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  });

  app.get(
    "/v1/owner/audit/actions",
    { onRequest: authorization.onRequest },
    async (request, reply) => {
      const owner = authorization.getAuthorization(request);
      const query = parseQuery(
        request,
        actionQueryNames,
        OwnerAuditActionListRequestSchema,
      );
      if (query === null) return validationFailed(request, reply);
      try {
        const page = await options.service.listActions(
          owner.owner.id,
          actionInput(query),
          {
            authenticationAssurance: "email_verified_owner_session",
            requestId: request.id,
          },
        );
        const response = actionResponse(request, query, page);
        if (response === null) {
          request.log.error(
            { itemCount: page.items.length },
            "Owner action audit projection violated its response contract",
          );
          return sendAuditError(request, reply, new Error("projection invalid"));
        }
        return reply.send(response);
      } catch (error) {
        return sendAuditError(request, reply, error);
      }
    },
  );

  app.get(
    "/v1/owner/audit/search-activity",
    { onRequest: authorization.onRequest },
    async (request, reply) => {
      const owner = authorization.getAuthorization(request);
      const query = parseQuery(
        request,
        searchQueryNames,
        OwnerAuditSearchListRequestSchema,
      );
      if (query === null) return validationFailed(request, reply);
      try {
        const page = await options.service.listSearchActivity(
          owner.owner.id,
          searchInput(query),
          {
            authenticationAssurance: "email_verified_owner_session",
            requestId: request.id,
          },
        );
        const response = searchResponse(request, query, page);
        if (response === null) {
          request.log.error(
            { itemCount: page.items.length },
            "Owner search audit projection violated its response contract",
          );
          return sendAuditError(request, reply, new Error("projection invalid"));
        }
        return reply.send(response);
      } catch (error) {
        return sendAuditError(request, reply, error);
      }
    },
  );
}
