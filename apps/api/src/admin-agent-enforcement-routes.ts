import {
  AdminAgentActionHeadersSchema,
  AdminAgentActionRequestSchema,
  AdminAgentActionResponseSchema,
  AdminAgentDetailResponseSchema,
  AdminAgentListRequestSchema,
  AdminAgentListResponseSchema,
  AdminAgentPathParamsSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  AdminAgentEnforcementError,
  type AdminAgentContext,
  type AdminAgentDetailView,
  type AdminAgentEnforcementService,
  type AdminAgentMutation,
  type AdminAgentPage,
  type AdminAgentSummaryView,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createAdminRequestAuthorizationBoundary,
  type AdminRequestRuntime,
  type AuthorizedAdminRequest,
} from "./admin-request.js";
import { v1Error } from "./agent-routes.js";

export interface AdminAgentEnforcementRouteOptions {
  adminRuntime: AdminRequestRuntime;
  service: Pick<AdminAgentEnforcementService, "act" | "get" | "list">;
}

const listQueryNames = new Set(["statuses", "query", "limit", "cursor"]);

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
  const rawStatuses = parameters.get("statuses");
  const statuses = rawStatuses === null ? undefined : rawStatuses.split(",");
  if (statuses !== undefined && statuses.some((status) => status.length === 0)) {
    return null;
  }
  const parsed = AdminAgentListRequestSchema.safeParse({
    ...(parameters.has("cursor") ? { cursor: parameters.get("cursor") } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(parameters.has("query") ? { query: parameters.get("query") } : {}),
    ...(statuses === undefined ? {} : { statuses }),
  });
  return parsed.success ? parsed.data : null;
}

function actionHeaders(request: FastifyRequest) {
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
  const parsed = AdminAgentActionHeadersSchema.safeParse({
    "idempotency-key": idempotencyKey,
    "if-match": ifMatch,
  });
  return parsed.success ? parsed.data : null;
}

function adminContext(
  request: FastifyRequest,
  authorization: AuthorizedAdminRequest,
): AdminAgentContext {
  return {
    adminId: authorization.adminId,
    authenticationAssurance: authorization.authenticationAssurance,
    mfa: authorization.mfa,
    permission: "identity:restrict",
    permissions: authorization.permissions,
    requestId: request.id,
    roles: authorization.roles,
  };
}

function agentProjection(agent: AdminAgentSummaryView) {
  return {
    activated_at: agent.activatedAt?.toISOString() ?? null,
    actor_id: agent.actorId,
    agent_id: agent.agentId,
    archived_at: agent.archivedAt?.toISOString() ?? null,
    created_at: agent.createdAt.toISOString(),
    credential_counts: {
      active: agent.credentialCounts.active,
      expired: agent.credentialCounts.expired,
      revoked: agent.credentialCounts.revoked,
      total: agent.credentialCounts.total,
    },
    discovery_tags: agent.discoveryTags,
    display_name: agent.displayName,
    governance_version: agent.governanceVersion,
    handle: agent.handle,
    owner_id: agent.ownerId,
    restricted_at: agent.restrictedAt?.toISOString() ?? null,
    restriction_reason_code: agent.restrictionReasonCode,
    status: agent.status,
    suspended_at: agent.suspendedAt?.toISOString() ?? null,
    updated_at: agent.updatedAt.toISOString(),
  };
}

function capabilitiesProjection(capabilities: {
  canRestrict: boolean;
  canRevokeCredentials: boolean;
}) {
  return {
    can_restrict: capabilities.canRestrict,
    can_revoke_credentials: capabilities.canRevokeCredentials,
  };
}

function listProjection(request: FastifyRequest, page: AdminAgentPage) {
  const parsed = AdminAgentListResponseSchema.safeParse({
    capabilities: capabilitiesProjection(page.capabilities),
    items: page.items.map(agentProjection),
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

function detailProjection(request: FastifyRequest, detail: AdminAgentDetailView) {
  const parsed = AdminAgentDetailResponseSchema.safeParse({
    agent: agentProjection(detail.agent),
    capabilities: capabilitiesProjection(detail.capabilities),
    credentials: detail.credentials.map((credential) => ({
      created_at: credential.createdAt.toISOString(),
      credential_id: credential.credentialId,
      credential_type: credential.credentialType,
      expires_at: credential.expiresAt?.toISOString() ?? null,
      last_used_at: credential.lastUsedAt?.toISOString() ?? null,
      name: credential.name,
      prefix: credential.prefix,
      revoked_at: credential.revokedAt?.toISOString() ?? null,
      scopes: credential.scopes,
      status: credential.status,
    })),
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function actionProjection(request: FastifyRequest, mutation: AdminAgentMutation) {
  const parsed = AdminAgentActionResponseSchema.safeParse({
    action: {
      action: mutation.action.action,
      action_id: mutation.action.actionId,
      admin_id: mutation.action.adminId,
      governance_version_after: mutation.action.governanceVersionAfter,
      governance_version_before: mutation.action.governanceVersionBefore,
      occurred_at: mutation.action.occurredAt.toISOString(),
      permission_used: mutation.action.permissionUsed,
      reason_code: mutation.action.reasonCode,
      revoked_credential_count: mutation.action.revokedCredentialCount,
    },
    agent: agentProjection(mutation.agent),
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
    { errorName: "AdminAgentEnforcementErrorProjectionError" },
    "Agent-governance error projection was invalid",
  );
  return reply.code(503).send(
    V1ErrorResponseSchema.parse(
      v1Error(request, {
        code: "AGENT_ENFORCEMENT_UNAVAILABLE",
        message: "Agent governance is temporarily unavailable.",
        retryable: true,
      }),
    ),
  );
}

function invalid(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return checkedError(request, reply, 422, {
    code: "INVALID_ARGUMENT",
    message: "The request does not match the Agent-governance API contract.",
  });
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof AdminAgentEnforcementError) {
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
    "Agent-governance request failed",
  );
  return checkedError(request, reply, 503, {
    code: "AGENT_ENFORCEMENT_UNAVAILABLE",
    message: "Agent governance is temporarily unavailable.",
    retryable: true,
  });
}

export function registerAdminAgentEnforcementRoutes(
  app: FastifyInstance,
  options: AdminAgentEnforcementRouteOptions,
): void {
  const readAuthorization = createAdminRequestAuthorizationBoundary({
    ...options.adminRuntime,
    mode: "read",
    permission: "identity:restrict",
  });
  const mutationAuthorization = createAdminRequestAuthorizationBoundary({
    ...options.adminRuntime,
    mode: "mutation",
    permission: "identity:restrict",
  });

  app.get(
    "/v1/admin/agents",
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
            ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
          },
        );
        const response = listProjection(request, page);
        return response
          ? reply.code(200).send(response)
          : sendError(request, reply, new Error("Invalid Agent-list projection."));
      } catch (error) {
        return sendError(request, reply, error);
      }
    },
  );

  app.get(
    "/v1/admin/agents/:agent_id",
    { onRequest: readAuthorization.onRequest },
    async (request, reply) => {
      const path = AdminAgentPathParamsSchema.safeParse(request.params);
      if (!path.success || request.body !== undefined || !noQuery(request)) {
        return invalid(request, reply);
      }
      try {
        const detail = await options.service.get(
          adminContext(request, readAuthorization.getAuthorization(request)),
          path.data.agent_id,
        );
        const response = detailProjection(request, detail);
        if (!response) {
          return sendError(request, reply, new Error("Invalid Agent projection."));
        }
        void reply.header("etag", `"${response.agent.governance_version}"`);
        return reply.code(200).send(response);
      } catch (error) {
        return sendError(request, reply, error);
      }
    },
  );

  app.post(
    "/v1/admin/agents/:agent_id/actions",
    { onRequest: mutationAuthorization.onRequest },
    async (request, reply) => {
      const path = AdminAgentPathParamsSchema.safeParse(request.params);
      const headers = actionHeaders(request);
      const body = AdminAgentActionRequestSchema.safeParse(request.body);
      if (!path.success || !headers || !body.success || !noQuery(request)) {
        return invalid(request, reply);
      }
      try {
        const mutation = await options.service.act(
          adminContext(request, mutationAuthorization.getAuthorization(request)),
          path.data.agent_id,
          {
            action: body.data.action,
            expectedVersion: Number(headers["if-match"].slice(1, -1)),
            idempotencyKey: headers["idempotency-key"],
            ...(body.data.internal_note === undefined
              ? {}
              : { internalNote: body.data.internal_note }),
            reasonCode: body.data.reason_code,
          },
        );
        const response = actionProjection(request, mutation);
        if (!response) {
          return sendError(request, reply, new Error("Invalid Agent-action projection."));
        }
        void reply.header("etag", `"${response.agent.governance_version}"`);
        return reply.code(mutation.replayed ? 200 : 201).send(response);
      } catch (error) {
        return sendError(request, reply, error);
      }
    },
  );
}
