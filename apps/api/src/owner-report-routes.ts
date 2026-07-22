import type { AlphaNetAuthRuntime } from "@alphanet/auth";
import {
  OwnerContentReportCreateRequestSchema,
  OwnerContentReportCreateResponseSchema,
  OwnerContentReportHeadersSchema,
  OwnerContentReportPathParamsSchema,
  type OwnerContentReportCreateResponse,
} from "@alphanet/contracts";
import {
  ContentReportError,
  type ContentReportProjection,
  type ContentReportService,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { v1Error } from "./agent-routes.js";
import {
  createOwnerRequestAuthorizationBoundary,
  type OwnerRequestRateLimiter,
} from "./owner-request.js";

export interface OwnerReportRouteOptions {
  allowedOrigins: readonly string[];
  authRuntime: Pick<AlphaNetAuthRuntime, "getOwnerSession">;
  rateLimiter?: OwnerRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: Pick<ContentReportService, "createReport">;
}

function hasNoQueryParameters(request: FastifyRequest): boolean {
  return new URL(request.url, "http://alphanet.invalid").searchParams.size === 0;
}

function reportHeaders(request: FastifyRequest): { "idempotency-key": string } | null {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || key.includes(",")) return null;
  const parsed = OwnerContentReportHeadersSchema.safeParse({
    "idempotency-key": key,
  });
  return parsed.success ? parsed.data : null;
}

function validationFailed(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code: "INVALID_ARGUMENT",
      message: "The request does not match the Owner content-report contract.",
    }),
  );
}

function serializeReport(
  request: FastifyRequest,
  created: boolean,
  report: ContentReportProjection,
): OwnerContentReportCreateResponse | null {
  const parsed = OwnerContentReportCreateResponseSchema.safeParse({
    created,
    report: {
      report_id: report.id,
      report_version: report.version,
      case_id: report.caseId,
      content_id: report.contentId,
      reporter_actor_id: report.reporterActorId,
      reason_code: report.reasonCode,
      details: report.details,
      status: report.status,
      submitted_at: report.submittedAt.toISOString(),
      updated_at: report.updatedAt.toISOString(),
      resolved_at: report.resolvedAt?.toISOString() ?? null,
    },
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function sendReportError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof ContentReportError) {
    if (error.retryAt !== null) {
      void reply.header(
        "retry-after",
        String(Math.max(1, Math.ceil((error.retryAt.valueOf() - Date.now()) / 1_000))),
      );
    }
    return reply.code(error.code === "VALIDATION_ERROR" ? 422 : error.statusCode).send(
      v1Error(request, {
        code: error.code,
        message: error.message,
        retryable: error.code === "REPORT_LIMIT_REACHED",
        ...(error.retryAt === null ? {} : { retryAt: error.retryAt }),
      }),
    );
  }

  request.log.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Owner content-report request failed",
  );
  return reply.code(503).send(
    v1Error(request, {
      code: "CONTENT_REPORTING_UNAVAILABLE",
      message: "Content reporting is temporarily unavailable.",
      retryable: true,
    }),
  );
}

export function registerOwnerReportRoutes(
  app: FastifyInstance,
  options: OwnerReportRouteOptions,
): void {
  const authorization = createOwnerRequestAuthorizationBoundary({
    allowedOrigins: options.allowedOrigins,
    authRuntime: options.authRuntime,
    mode: "mutation",
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  });

  app.post(
    "/v1/owner/content/:content_id/reports",
    { onRequest: authorization.onRequest },
    async (request, reply) => {
      const owner = authorization.getAuthorization(request);
      const path = OwnerContentReportPathParamsSchema.safeParse(request.params);
      const headers = reportHeaders(request);
      const body = OwnerContentReportCreateRequestSchema.safeParse(request.body);
      if (
        !path.success ||
        headers === null ||
        !body.success ||
        !hasNoQueryParameters(request)
      ) {
        return validationFailed(request, reply);
      }

      try {
        const outcome = await options.service.createReport(
          {
            authenticationAssurance: "email_verified_owner_session",
            ownerId: owner.owner.id,
            requestId: request.id,
          },
          {
            contentId: path.data.content_id,
            ...(body.data.details === undefined ? {} : { details: body.data.details }),
            idempotencyKey: headers["idempotency-key"],
            reasonCode: body.data.reason_code,
            reporterActorId: body.data.reporter_actor_id,
          },
        );
        const response = serializeReport(request, outcome.created, outcome.report);
        if (response === null) {
          request.log.error(
            { created: outcome.created },
            "Content report result violated its public response contract",
          );
          return sendReportError(request, reply, new Error("projection invalid"));
        }
        return reply.code(outcome.created ? 201 : 200).send(response);
      } catch (error) {
        return sendReportError(request, reply, error);
      }
    },
  );
}
