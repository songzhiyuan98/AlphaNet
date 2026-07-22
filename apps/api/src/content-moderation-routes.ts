import type { AlphaNetAuthRuntime } from "@alphanet/auth";
import {
  AdminModerationCaseDetailRequestSchema,
  AdminModerationCaseDetailResponseSchema,
  AdminModerationCaseListRequestSchema,
  AdminModerationCaseListResponseSchema,
  AdminModerationCasePathParamsSchema,
  AdminModerationDecisionHeadersSchema,
  AdminModerationDecisionRequestSchema,
  AdminModerationDecisionResponseSchema,
  OwnerContentModerationListRequestSchema,
  OwnerContentModerationListResponseSchema,
  OwnerContentModerationPathParamsSchema,
  V1ErrorResponseSchema,
  type AdminModerationCaseDetailRequest,
  type AdminModerationCaseDetailResponse,
  type AdminModerationCaseListRequest,
  type AdminModerationCaseListResponse,
  type AdminModerationDecisionResponse,
  type OwnerContentModerationListRequest,
  type OwnerContentModerationListResponse,
} from "@alphanet/contracts";
import {
  ContentModerationError,
  type AdminContentReportView,
  type AdminModerationContext,
  type ContentModerationActionRecord,
  type ContentModerationService,
  type CursorPage,
  type ModerationAuthorView,
  type ModerationCaseDetailView,
  type ModerationCaseQueueItem,
  type ModerationCaseSummaryView,
  type ModerationContentSnapshotView,
  type ModerationDecisionOutcome,
  type OwnerContentModerationHistoryView,
  type OwnerContentModerationRecord,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { v1Error } from "./agent-routes.js";
import {
  createAdminRequestAuthorizationBoundary,
  type AdminRequestRuntime,
  type AuthorizedAdminRequest,
} from "./admin-request.js";
import {
  createOwnerRequestAuthorizationBoundary,
  type OwnerRequestRateLimiter,
} from "./owner-request.js";

export interface AdminContentModerationRouteOptions {
  adminRuntime: AdminRequestRuntime;
  service: Pick<ContentModerationService, "decideCase" | "getCase" | "listCases">;
}

export interface OwnerContentModerationRouteOptions {
  allowedOrigins: readonly string[];
  authRuntime: Pick<AlphaNetAuthRuntime, "getOwnerSession">;
  rateLimiter?: OwnerRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: Pick<ContentModerationService, "listContentActions">;
}

const caseListQueryNames = new Set([
  "statuses",
  "priorities",
  "reasons",
  "content_id",
  "limit",
  "cursor",
]);
const caseDetailQueryNames = new Set([
  "report_limit",
  "report_cursor",
  "action_limit",
  "action_cursor",
]);
const ownerActionQueryNames = new Set(["limit", "cursor"]);

function oneQueryValue(parameters: URLSearchParams, name: string): string | undefined {
  const values = parameters.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

function commaSeparated(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const values = value.split(",");
  return values.length > 0 && values.every((entry) => entry.length > 0)
    ? values
    : undefined;
}

function exactQuery(
  request: FastifyRequest,
  allowedNames: ReadonlySet<string>,
): URLSearchParams | null {
  const parameters = new URL(request.url, "http://alphanet.invalid").searchParams;
  for (const name of parameters.keys()) {
    if (!allowedNames.has(name) || parameters.getAll(name).length !== 1) return null;
  }
  return parameters;
}

function positiveIntegerQuery(
  parameters: URLSearchParams,
  name: string,
): number | undefined | null {
  const raw = oneQueryValue(parameters, name);
  if (raw === undefined) return parameters.has(name) ? null : undefined;
  if (!/^[1-9][0-9]*$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function caseListRequest(request: FastifyRequest): AdminModerationCaseListRequest | null {
  const parameters = exactQuery(request, caseListQueryNames);
  if (!parameters) return null;
  const statuses = commaSeparated(oneQueryValue(parameters, "statuses"));
  const priorities = commaSeparated(oneQueryValue(parameters, "priorities"));
  const reasons = commaSeparated(oneQueryValue(parameters, "reasons"));
  if (
    (parameters.has("statuses") && statuses === undefined) ||
    (parameters.has("priorities") && priorities === undefined) ||
    (parameters.has("reasons") && reasons === undefined)
  ) {
    return null;
  }
  const limit = positiveIntegerQuery(parameters, "limit");
  if (limit === null) return null;
  const candidate = {
    ...(statuses === undefined ? {} : { statuses }),
    ...(priorities === undefined ? {} : { priorities }),
    ...(reasons === undefined ? {} : { reasons }),
    ...(parameters.has("content_id")
      ? { content_id: oneQueryValue(parameters, "content_id") }
      : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(parameters.has("cursor") ? { cursor: oneQueryValue(parameters, "cursor") } : {}),
  };
  const parsed = AdminModerationCaseListRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function caseDetailRequest(
  request: FastifyRequest,
): AdminModerationCaseDetailRequest | null {
  const parameters = exactQuery(request, caseDetailQueryNames);
  if (!parameters) return null;
  const reportLimit = positiveIntegerQuery(parameters, "report_limit");
  const actionLimit = positiveIntegerQuery(parameters, "action_limit");
  if (reportLimit === null || actionLimit === null) return null;
  const candidate = {
    ...(reportLimit === undefined ? {} : { report_limit: reportLimit }),
    ...(parameters.has("report_cursor")
      ? { report_cursor: oneQueryValue(parameters, "report_cursor") }
      : {}),
    ...(actionLimit === undefined ? {} : { action_limit: actionLimit }),
    ...(parameters.has("action_cursor")
      ? { action_cursor: oneQueryValue(parameters, "action_cursor") }
      : {}),
  };
  const parsed = AdminModerationCaseDetailRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function ownerActionRequest(
  request: FastifyRequest,
): OwnerContentModerationListRequest | null {
  const parameters = exactQuery(request, ownerActionQueryNames);
  if (!parameters) return null;
  const limit = positiveIntegerQuery(parameters, "limit");
  if (limit === null) return null;
  const parsed = OwnerContentModerationListRequestSchema.safeParse({
    ...(limit === undefined ? {} : { limit }),
    ...(parameters.has("cursor") ? { cursor: oneQueryValue(parameters, "cursor") } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function hasNoBody(request: FastifyRequest): boolean {
  return request.body === undefined;
}

function validationFailed(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendCheckedError(request, reply, 422, {
    code: "INVALID_ARGUMENT",
    message: "The request does not match the content-moderation API contract.",
  });
}

function author(view: ModerationAuthorView) {
  return {
    actor_id: view.actorId,
    kind: view.kind,
    handle: view.handle,
    ...(view.kind === "agent" && view.agentId !== undefined
      ? { agent_id: view.agentId }
      : {}),
  };
}

function caseSummary(view: ModerationCaseSummaryView) {
  return {
    case_id: view.caseId,
    case_version: view.version,
    content_id: view.contentId,
    content_version: view.contentVersion,
    content_kind: view.contentKind,
    lifecycle_state: view.lifecycleState,
    distribution_state: view.distributionState,
    author: author(view.author),
    status: view.status,
    priority: view.priority,
    report_count: view.reportCount,
    reason_counts: view.reasonCounts,
    opened_at: view.openedAt.toISOString(),
    last_reported_at: view.lastReportedAt.toISOString(),
    updated_at: view.updatedAt.toISOString(),
    resolved_at: view.resolvedAt?.toISOString() ?? null,
    resolution_action: view.resolutionAction,
    latest_action_id: view.latestActionId,
  };
}

function contentSnapshot(view: ModerationContentSnapshotView) {
  return {
    content_id: view.contentId,
    root_content_id: view.rootContentId,
    parent_content_id: view.parentContentId,
    depth: view.depth,
    resource_version: view.resourceVersion,
    lifecycle_state: view.lifecycleState,
    distribution_state: view.distributionState,
    current_revision_id: view.currentRevisionId,
    author: author(view.author),
    created_at: view.createdAt.toISOString(),
    updated_at: view.updatedAt.toISOString(),
    deleted_at: view.deletedAt?.toISOString() ?? null,
    kind: view.kind,
    title: view.title,
    body_markdown: view.bodyMarkdown,
  };
}

function adminAction(view: ContentModerationActionRecord) {
  return {
    moderation_action_id: view.moderationActionId,
    action_version: view.actionVersion,
    case_id: view.caseId,
    content_id: view.contentId,
    internal_note: view.internalNote,
    decided_by_admin_id: view.decidedByAdminId,
    decided_at: view.decidedAt.toISOString(),
    action: view.action,
    reason_code: view.reasonCode,
    content_version_before: view.contentVersionBefore,
    content_version_after: view.contentVersionAfter,
    content_lifecycle_state: view.contentLifecycleState,
    distribution_before: view.distributionBefore,
    distribution_after: view.distributionAfter,
    reverted_action_id: view.revertedActionId,
  };
}

function ownerAction(view: OwnerContentModerationRecord) {
  return {
    moderation_action_id: view.moderationActionId,
    action_version: view.actionVersion,
    case_id: view.caseId,
    content_id: view.contentId,
    decided_at: view.decidedAt.toISOString(),
    action: view.action,
    reason_code: view.reasonCode,
    content_version_before: view.contentVersionBefore,
    content_version_after: view.contentVersionAfter,
    distribution_before: view.distributionBefore,
    distribution_after: view.distributionAfter,
    reverted_action_id: view.revertedActionId,
  };
}

function report(view: AdminContentReportView) {
  return {
    report_id: view.reportId,
    report_version: view.version,
    case_id: view.caseId,
    content_id: view.contentId,
    reporter_actor_id: view.reporterActorId,
    reporter_owner_id: view.reporterOwnerId,
    reason_code: view.reasonCode,
    details: view.details,
    status: view.status,
    submitted_at: view.submittedAt.toISOString(),
    updated_at: view.updatedAt.toISOString(),
    resolved_at: view.resolvedAt?.toISOString() ?? null,
  };
}

function pageProjection<T>(page: CursorPage<T>) {
  return {
    page: {
      next_cursor: page.nextCursor,
      has_more: page.hasMore,
      limit: page.limit,
    },
    ordering: {
      snapshot_id: page.snapshotId,
      ordering_version: page.orderingVersion,
      as_of: page.asOf.toISOString(),
    },
  };
}

function listResponse(
  request: FastifyRequest,
  page: CursorPage<ModerationCaseQueueItem>,
): AdminModerationCaseListResponse | null {
  const metadata = pageProjection(page);
  const parsed = AdminModerationCaseListResponseSchema.safeParse({
    items: page.items.map((item) => ({
      ...caseSummary(item),
      queue_rank: item.queueRank,
    })),
    page: metadata.page,
    ordering: metadata.ordering,
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function detailResponse(
  request: FastifyRequest,
  view: ModerationCaseDetailView,
): AdminModerationCaseDetailResponse | null {
  const reportMetadata = pageProjection(view.reports);
  const actionMetadata = pageProjection(view.actions);
  const parsed = AdminModerationCaseDetailResponseSchema.safeParse({
    case: caseSummary(view.case),
    content: contentSnapshot(view.content),
    reports: view.reports.items.map(report),
    report_page: reportMetadata.page,
    report_ordering: reportMetadata.ordering,
    actions: view.actions.items.map(adminAction),
    action_page: actionMetadata.page,
    action_ordering: actionMetadata.ordering,
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function decisionResponse(
  request: FastifyRequest,
  outcome: ModerationDecisionOutcome,
): AdminModerationDecisionResponse | null {
  const parsed = AdminModerationDecisionResponseSchema.safeParse({
    case_version_before: outcome.caseVersionBefore,
    case: caseSummary(outcome.case),
    action: adminAction(outcome.action),
    content: {
      content_id: outcome.content.contentId,
      resource_version: outcome.content.resourceVersion,
      lifecycle_state: outcome.content.lifecycleState,
      distribution_state: outcome.content.distributionState,
    },
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function ownerResponse(
  request: FastifyRequest,
  view: OwnerContentModerationHistoryView,
): OwnerContentModerationListResponse | null {
  const metadata = pageProjection(view.page);
  const parsed = OwnerContentModerationListResponseSchema.safeParse({
    content_id: view.contentId,
    content_version: view.contentVersion,
    distribution_state: view.distributionState,
    items: view.page.items.map(ownerAction),
    page: metadata.page,
    ordering: metadata.ordering,
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function sendCheckedError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  options: Parameters<typeof v1Error>[1],
): FastifyReply {
  const parsed = V1ErrorResponseSchema.safeParse(v1Error(request, options));
  if (parsed.success) return reply.code(statusCode).send(parsed.data);

  request.log.error(
    { errorName: "PublicModerationErrorProjectionError" },
    "Content-moderation error projection was invalid",
  );
  const fallback = V1ErrorResponseSchema.parse(
    v1Error(request, {
      code: "MODERATION_UNAVAILABLE",
      message: "Moderation is temporarily unavailable.",
      retryable: true,
    }),
  );
  return reply.code(503).send(fallback);
}

function sendModerationError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof ContentModerationError) {
    if (error.statusCode === 401) {
      void reply.header("www-authenticate", 'Bearer realm="alphanet-admin"');
    }
    if (error.retryAt !== null) {
      void reply.header(
        "retry-after",
        String(Math.max(1, Math.ceil((error.retryAt.valueOf() - Date.now()) / 1_000))),
      );
    }
    const exposeVersion =
      error.code === "CASE_VERSION_CONFLICT" || error.code === "CONTENT_STATE_CONFLICT";
    return sendCheckedError(request, reply, error.statusCode, {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.retryAt === null ? {} : { retryAt: error.retryAt }),
      ...(exposeVersion && error.currentVersion !== null
        ? { details: { current_version: error.currentVersion } }
        : {}),
    });
  }

  request.log.error({ errorName: errorName(error) }, "Content-moderation request failed");
  return sendCheckedError(request, reply, 503, {
    code: "MODERATION_UNAVAILABLE",
    message: "Moderation is temporarily unavailable.",
    retryable: true,
  });
}

function projectionFailed(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendModerationError(request, reply, new Error("projection invalid"));
}

function adminContext(
  request: FastifyRequest,
  authorization: AuthorizedAdminRequest,
  permission: "moderation:read" | "moderation:decide",
): AdminModerationContext {
  return {
    adminId: authorization.adminId,
    authenticationAssurance: authorization.authenticationAssurance,
    mfa: authorization.mfa,
    permission,
    permissions: authorization.permissions,
    requestId: request.id,
    roles: authorization.roles,
  };
}

function moderationDecisionHeaders(
  request: FastifyRequest,
): { "if-match": string; "idempotency-key": string } | null {
  const ifMatch = request.headers["if-match"];
  const idempotencyKey = request.headers["idempotency-key"];
  if (
    typeof ifMatch !== "string" ||
    typeof idempotencyKey !== "string" ||
    ifMatch.includes(",") ||
    idempotencyKey.includes(",")
  ) {
    return null;
  }
  const parsed = AdminModerationDecisionHeadersSchema.safeParse({
    "if-match": ifMatch,
    "idempotency-key": idempotencyKey,
  });
  return parsed.success ? parsed.data : null;
}

export function registerAdminContentModerationRoutes(
  app: FastifyInstance,
  options: AdminContentModerationRouteOptions,
): void {
  const readAuthorization = createAdminRequestAuthorizationBoundary({
    ...options.adminRuntime,
    mode: "read",
    permission: "moderation:read",
  });
  const decisionAuthorization = createAdminRequestAuthorizationBoundary({
    ...options.adminRuntime,
    mode: "mutation",
    permission: "moderation:decide",
  });

  app.get(
    "/v1/admin/moderation/cases",
    { onRequest: readAuthorization.onRequest },
    async (request, reply) => {
      const authorization = readAuthorization.getAuthorization(request);
      const query = caseListRequest(request);
      if (!query || !hasNoBody(request)) return validationFailed(request, reply);
      try {
        const page = await options.service.listCases(
          adminContext(request, authorization, "moderation:read"),
          {
            ...(query.content_id === undefined ? {} : { contentId: query.content_id }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query.limit === undefined ? {} : { limit: query.limit }),
            ...(query.priorities === undefined ? {} : { priorities: query.priorities }),
            ...(query.reasons === undefined ? {} : { reasons: query.reasons }),
            ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
          },
        );
        const response = listResponse(request, page);
        return response ?? projectionFailed(request, reply);
      } catch (error) {
        return sendModerationError(request, reply, error);
      }
    },
  );

  app.get(
    "/v1/admin/moderation/cases/:case_id",
    { onRequest: readAuthorization.onRequest },
    async (request, reply) => {
      const authorization = readAuthorization.getAuthorization(request);
      const path = AdminModerationCasePathParamsSchema.safeParse(request.params);
      const query = caseDetailRequest(request);
      if (!path.success || !query || !hasNoBody(request)) {
        return validationFailed(request, reply);
      }
      try {
        const detail = await options.service.getCase(
          adminContext(request, authorization, "moderation:read"),
          path.data.case_id,
          {
            ...(query.report_limit === undefined
              ? {}
              : { reportLimit: query.report_limit }),
            ...(query.report_cursor === undefined
              ? {}
              : { reportCursor: query.report_cursor }),
            ...(query.action_limit === undefined
              ? {}
              : { actionLimit: query.action_limit }),
            ...(query.action_cursor === undefined
              ? {}
              : { actionCursor: query.action_cursor }),
          },
        );
        const response = detailResponse(request, detail);
        if (!response) return projectionFailed(request, reply);
        void reply.header("etag", `"${response.case.case_version}"`);
        return response;
      } catch (error) {
        return sendModerationError(request, reply, error);
      }
    },
  );

  app.post(
    "/v1/admin/moderation/cases/:case_id/actions",
    { onRequest: decisionAuthorization.onRequest },
    async (request, reply) => {
      const authorization = decisionAuthorization.getAuthorization(request);
      const path = AdminModerationCasePathParamsSchema.safeParse(request.params);
      const headers = moderationDecisionHeaders(request);
      const body = AdminModerationDecisionRequestSchema.safeParse(request.body);
      if (
        !path.success ||
        headers === null ||
        !body.success ||
        new URL(request.url, "http://alphanet.invalid").searchParams.size !== 0
      ) {
        return validationFailed(request, reply);
      }
      try {
        const outcome = await options.service.decideCase(
          adminContext(request, authorization, "moderation:decide"),
          path.data.case_id,
          {
            action: body.data.action,
            expectedCaseVersion: Number(headers["if-match"].slice(1, -1)),
            idempotencyKey: headers["idempotency-key"],
            ...(body.data.internal_note === undefined
              ? {}
              : { internalNote: body.data.internal_note }),
            reasonCode: body.data.reason_code,
          },
        );
        const response = decisionResponse(request, outcome);
        if (!response) return projectionFailed(request, reply);
        void reply.header("etag", `"${response.case.case_version}"`);
        return reply.code(outcome.replayed ? 200 : 201).send(response);
      } catch (error) {
        return sendModerationError(request, reply, error);
      }
    },
  );
}

export function registerOwnerContentModerationRoutes(
  app: FastifyInstance,
  options: OwnerContentModerationRouteOptions,
): void {
  const authorization = createOwnerRequestAuthorizationBoundary({
    allowedOrigins: options.allowedOrigins,
    authRuntime: options.authRuntime,
    mode: "read",
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  });

  app.get(
    "/v1/owner/content/:content_id/moderation-actions",
    { onRequest: authorization.onRequest },
    async (request, reply) => {
      const owner = authorization.getAuthorization(request);
      const path = OwnerContentModerationPathParamsSchema.safeParse(request.params);
      const query = ownerActionRequest(request);
      if (!path.success || !query || !hasNoBody(request)) {
        return validationFailed(request, reply);
      }
      try {
        const history = await options.service.listContentActions(
          owner.owner.id,
          path.data.content_id,
          {
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query.limit === undefined ? {} : { limit: query.limit }),
          },
        );
        const response = ownerResponse(request, history);
        if (!response) return projectionFailed(request, reply);
        void reply.header("etag", `"${response.content_version}"`);
        return response;
      } catch (error) {
        return sendModerationError(request, reply, error);
      }
    },
  );
}
