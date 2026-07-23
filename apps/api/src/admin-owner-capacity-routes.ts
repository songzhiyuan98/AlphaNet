import {
  AdminCapacityActionHeadersSchema,
  AdminOwnerDetailResponseSchema,
  AdminOwnerListRequestSchema,
  AdminOwnerListResponseSchema,
  AdminOwnerPathParamsSchema,
  AdminOwnerQuotaActionRequestSchema,
  AdminOwnerQuotaActionResponseSchema,
  AdminRegistrationControlActionRequestSchema,
  AdminRegistrationControlActionResponseSchema,
  AdminRegistrationControlResponseSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  AdminOwnerCapacityError,
  type AdminOwnerCapacityContext,
  type AdminOwnerCapacityService,
  type AdminOwnerPage,
  type AdminOwnerQuotaMutation,
  type AdminOwnerSummaryView,
  type AdminRegistrationControlView,
  type AdminRegistrationMutation,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createAdminRequestAuthorizationBoundary,
  type AdminRequestRuntime,
  type AuthorizedAdminRequest,
} from "./admin-request.js";
import { v1Error } from "./agent-routes.js";

export interface AdminOwnerCapacityRouteOptions {
  adminRuntime: AdminRequestRuntime;
  service: Pick<
    AdminOwnerCapacityService,
    | "actOnOwnerQuota"
    | "actOnRegistration"
    | "getOwner"
    | "getRegistration"
    | "listOwners"
  >;
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
  if (statuses?.some((status) => status.length === 0)) return null;
  const parsed = AdminOwnerListRequestSchema.safeParse({
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
  const parsed = AdminCapacityActionHeadersSchema.safeParse({
    "idempotency-key": idempotencyKey,
    "if-match": ifMatch,
  });
  return parsed.success ? parsed.data : null;
}

function adminContext(
  request: FastifyRequest,
  authorization: AuthorizedAdminRequest,
): AdminOwnerCapacityContext {
  return {
    adminId: authorization.adminId,
    authenticationAssurance: authorization.authenticationAssurance,
    mfa: authorization.mfa,
    permission: "identity:quota_manage",
    permissions: authorization.permissions,
    requestId: request.id,
    roles: authorization.roles,
  };
}

function ownerProjection(owner: AdminOwnerSummaryView) {
  return {
    active_agent_count: owner.activeAgentCount,
    base_active_agent_limit: owner.baseActiveAgentLimit,
    closed_at: owner.closedAt?.toISOString() ?? null,
    created_at: owner.createdAt.toISOString(),
    credential_counts: {
      active: owner.credentialCounts.active,
      expired: owner.credentialCounts.expired,
      revoked: owner.credentialCounts.revoked,
      total: owner.credentialCounts.total,
    },
    current_override:
      owner.currentOverride === null
        ? null
        : {
            created_at: owner.currentOverride.createdAt.toISOString(),
            expires_at: owner.currentOverride.expiresAt.toISOString(),
            max_active_agents: owner.currentOverride.maxActiveAgents,
            override_id: owner.currentOverride.overrideId,
            reason_code: owner.currentOverride.reasonCode,
          },
    effective_active_agent_limit: owner.effectiveActiveAgentLimit,
    email_hint: owner.emailHint,
    email_verified: owner.emailVerified,
    owner_id: owner.ownerId,
    quota_version: owner.quotaVersion,
    restricted_at: owner.restrictedAt?.toISOString() ?? null,
    status: owner.status,
    suspended_at: owner.suspendedAt?.toISOString() ?? null,
    total_agent_count: owner.totalAgentCount,
    updated_at: owner.updatedAt.toISOString(),
  };
}

function controlProjection(control: AdminRegistrationControlView) {
  return {
    active_agent_count: control.activeAgentCount,
    active_agent_hard_limit: control.activeAgentHardLimit,
    active_agent_operating_target: control.activeAgentOperatingTarget,
    mode: control.mode,
    pause_reason_code: control.pauseReasonCode,
    paused_at: control.pausedAt?.toISOString() ?? null,
    resume_condition: control.resumeCondition,
    updated_at: control.updatedAt.toISOString(),
    version: control.version,
  };
}

function listProjection(request: FastifyRequest, page: AdminOwnerPage) {
  const parsed = AdminOwnerListResponseSchema.safeParse({
    capabilities: { can_manage_quota: page.capabilities.canManageQuota },
    items: page.items.map(ownerProjection),
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

function quotaActionProjection(
  request: FastifyRequest,
  mutation: AdminOwnerQuotaMutation,
) {
  const parsed = AdminOwnerQuotaActionResponseSchema.safeParse({
    action: {
      action: mutation.action.action,
      action_id: mutation.action.actionId,
      admin_id: mutation.action.adminId,
      occurred_at: mutation.action.occurredAt.toISOString(),
      permission_used: mutation.action.permissionUsed,
      quota_version_after: mutation.action.quotaVersionAfter,
      quota_version_before: mutation.action.quotaVersionBefore,
      reason_code: mutation.action.reasonCode,
    },
    owner: ownerProjection(mutation.owner),
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function registrationActionProjection(
  request: FastifyRequest,
  mutation: AdminRegistrationMutation,
) {
  const parsed = AdminRegistrationControlActionResponseSchema.safeParse({
    action: {
      action: mutation.action.action,
      action_id: mutation.action.actionId,
      admin_id: mutation.action.adminId,
      occurred_at: mutation.action.occurredAt.toISOString(),
      permission_used: mutation.action.permissionUsed,
      reason_code: mutation.action.reasonCode,
      version_after: mutation.action.versionAfter,
      version_before: mutation.action.versionBefore,
    },
    control: controlProjection(mutation.control),
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
  return reply.code(503).send(
    V1ErrorResponseSchema.parse(
      v1Error(request, {
        code: "OWNER_CAPACITY_UNAVAILABLE",
        message: "Identity capacity is temporarily unavailable.",
        retryable: true,
      }),
    ),
  );
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  request.log.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Admin Owner-capacity request failed",
  );
  if (error instanceof AdminOwnerCapacityError) {
    return checkedError(request, reply, error.statusCode, {
      code: error.code,
      details:
        error.currentVersion === null
          ? undefined
          : { current_version: error.currentVersion },
      message: error.message,
      retryable: error.retryable,
    });
  }
  return checkedError(request, reply, 503, {
    code: "OWNER_CAPACITY_UNAVAILABLE",
    message: "Identity capacity is temporarily unavailable.",
    retryable: true,
  });
}

function projectionFailure(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  request.log.error(
    { errorName: "AdminOwnerCapacityProjectionError" },
    "Admin Owner-capacity projection violated its contract",
  );
  return checkedError(request, reply, 503, {
    code: "OWNER_CAPACITY_UNAVAILABLE",
    message: "Identity capacity is temporarily unavailable.",
    retryable: true,
  });
}

export function registerAdminOwnerCapacityRoutes(
  app: FastifyInstance,
  options: AdminOwnerCapacityRouteOptions,
): void {
  const readAuthorization = createAdminRequestAuthorizationBoundary({
    ...options.adminRuntime,
    mode: "read",
    permission: "identity:quota_manage",
  });
  const mutationAuthorization = createAdminRequestAuthorizationBoundary({
    ...options.adminRuntime,
    mode: "mutation",
    permission: "identity:quota_manage",
  });

  app.get(
    "/v1/admin/owners",
    { onRequest: readAuthorization.onRequest },
    async (request, reply) => {
      const parsed = listRequest(request);
      if (!parsed || request.body !== undefined) {
        return checkedError(request, reply, 422, {
          code: "VALIDATION_ERROR",
          message: "The Owner list request is invalid.",
          retryable: false,
        });
      }
      try {
        const result = await options.service.listOwners(
          adminContext(request, readAuthorization.getAuthorization(request)),
          {
            ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
            ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
            ...(parsed.query === undefined ? {} : { query: parsed.query }),
            ...(parsed.statuses === undefined ? {} : { statuses: parsed.statuses }),
          },
        );
        const response = listProjection(request, result);
        return response ?? projectionFailure(request, reply);
      } catch (error) {
        return sendError(request, reply, error);
      }
    },
  );

  app.get(
    "/v1/admin/owners/:owner_id",
    { onRequest: readAuthorization.onRequest },
    async (request, reply) => {
      const parameters = AdminOwnerPathParamsSchema.safeParse(request.params);
      if (!parameters.success || request.body !== undefined || !noQuery(request)) {
        return checkedError(request, reply, 422, {
          code: "VALIDATION_ERROR",
          message: "The Owner detail request is invalid.",
          retryable: false,
        });
      }
      try {
        const owner = await options.service.getOwner(
          adminContext(request, readAuthorization.getAuthorization(request)),
          parameters.data.owner_id,
        );
        const parsed = AdminOwnerDetailResponseSchema.safeParse({
          capabilities: { can_manage_quota: true },
          owner: ownerProjection(owner),
          request_id: request.id,
          schema_version: "1",
        });
        if (!parsed.success) return projectionFailure(request, reply);
        return reply
          .header("etag", `"${owner.quotaVersion}"`)
          .code(200)
          .send(parsed.data);
      } catch (error) {
        return sendError(request, reply, error);
      }
    },
  );

  app.post(
    "/v1/admin/owners/:owner_id/quota-actions",
    { onRequest: mutationAuthorization.onRequest },
    async (request, reply) => {
      const parameters = AdminOwnerPathParamsSchema.safeParse(request.params);
      const headers = actionHeaders(request);
      const body = AdminOwnerQuotaActionRequestSchema.safeParse(request.body);
      if (!parameters.success || !headers || !body.success || !noQuery(request)) {
        return checkedError(request, reply, 422, {
          code: "VALIDATION_ERROR",
          message: "The Owner quota action is invalid.",
          retryable: false,
        });
      }
      try {
        const mutation = await options.service.actOnOwnerQuota(
          adminContext(request, mutationAuthorization.getAuthorization(request)),
          parameters.data.owner_id,
          body.data.action === "set_override"
            ? {
                action: body.data.action,
                expectedVersion: Number(headers["if-match"].slice(1, -1)),
                expiresAt: new Date(body.data.expires_at),
                idempotencyKey: headers["idempotency-key"],
                maxActiveAgents: body.data.max_active_agents,
                reasonCode: body.data.reason_code,
              }
            : {
                action: body.data.action,
                expectedVersion: Number(headers["if-match"].slice(1, -1)),
                idempotencyKey: headers["idempotency-key"],
                reasonCode: body.data.reason_code,
              },
        );
        const response = quotaActionProjection(request, mutation);
        if (!response) return projectionFailure(request, reply);
        return reply
          .header("etag", `"${mutation.owner.quotaVersion}"`)
          .code(mutation.replayed ? 200 : 201)
          .send(response);
      } catch (error) {
        return sendError(request, reply, error);
      }
    },
  );

  app.get(
    "/v1/admin/capacity",
    { onRequest: readAuthorization.onRequest },
    async (request, reply) => {
      if (request.body !== undefined || !noQuery(request)) {
        return checkedError(request, reply, 422, {
          code: "VALIDATION_ERROR",
          message: "The registration-control request is invalid.",
          retryable: false,
        });
      }
      try {
        const result = await options.service.getRegistration(
          adminContext(request, readAuthorization.getAuthorization(request)),
        );
        const parsed = AdminRegistrationControlResponseSchema.safeParse({
          capabilities: {
            can_manage_quota: result.capabilities.canManageQuota,
          },
          control: controlProjection(result.control),
          request_id: request.id,
          schema_version: "1",
        });
        if (!parsed.success) return projectionFailure(request, reply);
        return reply
          .header("etag", `"${result.control.version}"`)
          .code(200)
          .send(parsed.data);
      } catch (error) {
        return sendError(request, reply, error);
      }
    },
  );

  app.post(
    "/v1/admin/capacity/actions",
    { onRequest: mutationAuthorization.onRequest },
    async (request, reply) => {
      const headers = actionHeaders(request);
      const body = AdminRegistrationControlActionRequestSchema.safeParse(request.body);
      if (!headers || !body.success || !noQuery(request)) {
        return checkedError(request, reply, 422, {
          code: "VALIDATION_ERROR",
          message: "The registration-control action is invalid.",
          retryable: false,
        });
      }
      const expectedVersion = Number(headers["if-match"].slice(1, -1));
      const idempotencyKey = headers["idempotency-key"];
      try {
        const mutation = await options.service.actOnRegistration(
          adminContext(request, mutationAuthorization.getAuthorization(request)),
          body.data.action === "pause_registration"
            ? {
                action: body.data.action,
                expectedVersion,
                idempotencyKey,
                reasonCode: body.data.reason_code,
                resumeCondition: body.data.resume_condition,
              }
            : body.data.action === "resume_registration"
              ? {
                  action: body.data.action,
                  expectedVersion,
                  idempotencyKey,
                  reasonCode: body.data.reason_code,
                }
              : {
                  action: body.data.action,
                  activeAgentHardLimit: body.data.active_agent_hard_limit,
                  activeAgentOperatingTarget: body.data.active_agent_operating_target,
                  expectedVersion,
                  idempotencyKey,
                  reasonCode: body.data.reason_code,
                },
        );
        const response = registrationActionProjection(request, mutation);
        if (!response) return projectionFailure(request, reply);
        return reply
          .header("etag", `"${mutation.control.version}"`)
          .code(mutation.replayed ? 200 : 201)
          .send(response);
      } catch (error) {
        return sendError(request, reply, error);
      }
    },
  );
}
