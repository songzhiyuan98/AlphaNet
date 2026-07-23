import type { AlphaNetAuthRuntime } from "@alphanet/auth";
import {
  OwnerAccountDataExportSchema,
  type OwnerAccountDataExport,
} from "@alphanet/contracts";
import {
  OwnerAccountExportError,
  type OwnerAccountExportService,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { v1Error } from "./agent-routes.js";
import {
  createOwnerRequestAuthorizationBoundary,
  type OwnerRequestRateLimiter,
} from "./owner-request.js";
import { isFreshOwnerSession } from "./owner-session-freshness.js";

export interface OwnerAccountExportRouteOptions {
  allowedOrigins: readonly string[];
  authRuntime: Pick<AlphaNetAuthRuntime, "getOwnerSession">;
  now?: (() => Date) | undefined;
  rateLimiter?: OwnerRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: OwnerAccountExportService;
}

function hasNoInput(request: FastifyRequest): boolean {
  return (
    new URL(request.url, "http://alphanet.invalid").searchParams.size === 0 &&
    (request.body === undefined || request.body === null)
  );
}

function sendExportError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof OwnerAccountExportError) {
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
    "Owner account data export failed",
  );
  return reply.code(503).send(
    v1Error(request, {
      code: "OWNER_ACCOUNT_EXPORT_UNAVAILABLE",
      message: "Owner account data export is temporarily unavailable.",
      retryable: true,
    }),
  );
}

function projectExport(
  snapshot: unknown,
  requestId: string,
): OwnerAccountDataExport | null {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return null;
  }
  const parsed = OwnerAccountDataExportSchema.safeParse({
    ...snapshot,
    request_id: requestId,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

export function registerOwnerAccountExportRoutes(
  app: FastifyInstance,
  options: OwnerAccountExportRouteOptions,
): void {
  const authorization = createOwnerRequestAuthorizationBoundary({
    allowedOrigins: options.allowedOrigins,
    authRuntime: options.authRuntime,
    limits: {
      mutation: { max: 3, window: 3_600 },
    },
    mode: "mutation",
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  });

  app.post(
    "/v1/owner/account-data-export",
    { onRequest: authorization.onRequest },
    async (request, reply) => {
      if (!hasNoInput(request)) {
        return reply.code(422).send(
          v1Error(request, {
            code: "INVALID_ARGUMENT",
            message: "The Owner account export request must not contain input.",
          }),
        );
      }
      const owner = authorization.getAuthorization(request);
      const now = options.now?.() ?? new Date();
      if (!isFreshOwnerSession(owner.session.createdAt, now)) {
        return reply.code(403).send(
          v1Error(request, {
            code: "OWNER_REAUTHENTICATION_REQUIRED",
            message: "A fresh Owner session is required to export account data.",
          }),
        );
      }

      try {
        const snapshot = await options.service.exportAccountData(owner.owner.id, {
          authenticatedAt: owner.session.createdAt,
          authenticationAssurance: "fresh_owner_session",
          requestId: request.id,
        });
        const response = projectExport(snapshot, request.id);
        if (response === null) {
          request.log.error(
            { ownerId: owner.owner.id },
            "Owner account export violated its response contract",
          );
          return sendExportError(request, reply, new Error("projection invalid"));
        }
        const date = now.toISOString().slice(0, 10);
        return reply
          .header("cache-control", "no-store, max-age=0")
          .header(
            "content-disposition",
            `attachment; filename="alphanet-account-data-${date}.json"`,
          )
          .header("pragma", "no-cache")
          .header("x-content-type-options", "nosniff")
          .type("application/json; charset=utf-8")
          .send(response);
      } catch (error) {
        return sendExportError(request, reply, error);
      }
    },
  );
}
