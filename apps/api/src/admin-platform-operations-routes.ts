import {
  AdminCommunityWriteControlActionRequestSchema,
  AdminCommunityWriteControlActionResponseSchema,
  AdminCommunityWriteControlResponseSchema,
  AdminPlatformActionHeadersSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  AdminPlatformOperationsError,
  type AdminCommunityWriteControlMutation,
  type AdminPlatformOperationsContext,
  type AdminPlatformOperationsService,
  type CommunityWriteControlView,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createAdminRequestAuthorizationBoundary,
  type AdminRequestRuntime,
  type AuthorizedAdminRequest,
} from "./admin-request.js";
import { v1Error } from "./agent-routes.js";

export interface AdminPlatformOperationsRouteOptions {
  adminRuntime: AdminRequestRuntime;
  service: Pick<
    AdminPlatformOperationsService,
    "actOnCommunityWrites" | "getCommunityWriteControl"
  >;
}

function noQuery(request: FastifyRequest): boolean {
  return new URL(request.url, "http://alphanet.invalid").searchParams.size === 0;
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
  const parsed = AdminPlatformActionHeadersSchema.safeParse({
    "idempotency-key": idempotencyKey,
    "if-match": ifMatch,
  });
  return parsed.success ? parsed.data : null;
}

function adminContext(
  request: FastifyRequest,
  authorization: AuthorizedAdminRequest,
): AdminPlatformOperationsContext {
  return {
    adminId: authorization.adminId,
    authenticationAssurance: authorization.authenticationAssurance,
    mfa: authorization.mfa,
    permission: "platform:operate",
    permissions: authorization.permissions,
    requestId: request.id,
    roles: authorization.roles,
  };
}

function controlProjection(control: CommunityWriteControlView) {
  return {
    mode: control.mode,
    pause_reason_code: control.pauseReasonCode,
    paused_at: control.pausedAt?.toISOString() ?? null,
    resume_condition: control.resumeCondition,
    updated_at: control.updatedAt.toISOString(),
    updated_by_admin_id: control.updatedByAdminId,
    version: control.version,
  };
}

function actionProjection(
  request: FastifyRequest,
  mutation: AdminCommunityWriteControlMutation,
) {
  const parsed = AdminCommunityWriteControlActionResponseSchema.safeParse({
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
        code: "PLATFORM_OPERATIONS_UNAVAILABLE",
        message: "Platform operations are temporarily unavailable.",
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
    "Admin platform-operations request failed",
  );
  if (error instanceof AdminPlatformOperationsError) {
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
    code: "PLATFORM_OPERATIONS_UNAVAILABLE",
    message: "Platform operations are temporarily unavailable.",
    retryable: true,
  });
}

function projectionFailure(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  request.log.error(
    { errorName: "AdminPlatformOperationsProjectionError" },
    "Admin platform-operations projection violated its contract",
  );
  return checkedError(request, reply, 503, {
    code: "PLATFORM_OPERATIONS_UNAVAILABLE",
    message: "Platform operations are temporarily unavailable.",
    retryable: true,
  });
}

export function registerAdminPlatformOperationsRoutes(
  app: FastifyInstance,
  options: AdminPlatformOperationsRouteOptions,
): void {
  const readAuthorization = createAdminRequestAuthorizationBoundary({
    ...options.adminRuntime,
    mode: "read",
    permission: "platform:operate",
  });
  const mutationAuthorization = createAdminRequestAuthorizationBoundary({
    ...options.adminRuntime,
    mode: "mutation",
    permission: "platform:operate",
  });

  app.get(
    "/v1/admin/platform/community-writes",
    { onRequest: readAuthorization.onRequest },
    async (request, reply) => {
      if (request.body !== undefined || !noQuery(request)) {
        return checkedError(request, reply, 422, {
          code: "VALIDATION_ERROR",
          message: "The community-write control request is invalid.",
          retryable: false,
        });
      }
      try {
        const result = await options.service.getCommunityWriteControl(
          adminContext(request, readAuthorization.getAuthorization(request)),
        );
        const parsed = AdminCommunityWriteControlResponseSchema.safeParse({
          capabilities: {
            can_operate_platform: result.canOperatePlatform,
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
    "/v1/admin/platform/community-writes/actions",
    { onRequest: mutationAuthorization.onRequest },
    async (request, reply) => {
      const headers = actionHeaders(request);
      const body = AdminCommunityWriteControlActionRequestSchema.safeParse(request.body);
      if (!headers || !body.success || !noQuery(request)) {
        return checkedError(request, reply, 422, {
          code: "VALIDATION_ERROR",
          message: "The community-write control action is invalid.",
          retryable: false,
        });
      }
      const expectedVersion = Number(headers["if-match"].slice(1, -1));
      const idempotencyKey = headers["idempotency-key"];
      try {
        const mutation = await options.service.actOnCommunityWrites(
          adminContext(request, mutationAuthorization.getAuthorization(request)),
          body.data.action === "pause_community_writes"
            ? {
                action: body.data.action,
                expectedVersion,
                idempotencyKey,
                reasonCode: body.data.reason_code,
                resumeCondition: body.data.resume_condition,
              }
            : {
                action: body.data.action,
                expectedVersion,
                idempotencyKey,
                reasonCode: body.data.reason_code,
              },
        );
        const response = actionProjection(request, mutation);
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
