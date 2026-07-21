import type { AlphaNetAuthRuntime } from "@alphanet/auth";
import {
  OwnerActionApproveRequestSchema,
  OwnerActionApproveResponseSchema,
  OwnerActionDetailRequestSchema,
  OwnerActionDetailResponseSchema,
  OwnerActionListRequestSchema,
  OwnerActionListResponseSchema,
  OwnerActionRejectRequestSchema,
  OwnerActionRejectResponseSchema,
  OwnerActionStateSchema,
  type OwnerActionApproveResponse,
  type OwnerActionDetail,
  type OwnerActionDetailResponse,
  type OwnerActionListRequest,
  type OwnerActionListResponse,
  type OwnerActionRejectResponse,
  type OwnerActionSummary,
  type V1ErrorDetail,
  type V1ErrorResponse,
} from "@alphanet/contracts";
import {
  OwnerPendingActionError,
  type OwnerPendingActionDetailView,
  type OwnerPendingActionListInput,
  type OwnerPendingActionPage,
  type OwnerPendingActionService,
  type OwnerPendingActionSummaryView,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createOwnerRequestAuthorizationBoundary,
  type OwnerRequestRateLimiter,
} from "./owner-request.js";

export interface OwnerActionRouteOptions {
  allowedOrigins: readonly string[];
  authRuntime: Pick<AlphaNetAuthRuntime, "getOwnerSession">;
  rateLimiter?: OwnerRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: OwnerPendingActionService;
}

const listQueryNames = new Set(["agent_id", "states", "operations", "limit", "cursor"]);

function ownerV1Error(
  request: FastifyRequest,
  options: {
    code: string;
    details?: V1ErrorDetail["details"] | undefined;
    message: string;
    retryable?: boolean | undefined;
  },
): V1ErrorResponse {
  return {
    error: {
      code: options.code,
      message: options.message,
      retryable: options.retryable ?? false,
      details: options.details ?? null,
      retry_after_ms: null,
    },
    request_id: request.id,
    schema_version: "1",
  };
}

function validationFailed(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(422).send(
    ownerV1Error(request, {
      code: "INVALID_ARGUMENT",
      message: "The request does not match the Owner API contract.",
    }),
  );
}

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

function listRequest(request: FastifyRequest): OwnerActionListRequest | null {
  const parameters = new URL(request.url, "http://alphanet.invalid").searchParams;
  for (const name of parameters.keys()) {
    if (!listQueryNames.has(name) || parameters.getAll(name).length !== 1) return null;
  }

  const rawStates = oneQueryValue(parameters, "states");
  const states = commaSeparated(rawStates);
  if (parameters.has("states") && states === undefined) return null;

  const rawOperations = oneQueryValue(parameters, "operations");
  const operations = commaSeparated(rawOperations);
  if (parameters.has("operations") && operations === undefined) return null;

  const rawLimit = oneQueryValue(parameters, "limit");
  if (rawLimit !== undefined && !/^[1-9][0-9]*$/u.test(rawLimit)) return null;
  const candidate = {
    ...(parameters.has("agent_id")
      ? { agent_id: oneQueryValue(parameters, "agent_id") }
      : {}),
    ...(states === undefined ? {} : { states }),
    ...(operations === undefined ? {} : { operations }),
    ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }),
    ...(parameters.has("cursor") ? { cursor: oneQueryValue(parameters, "cursor") } : {}),
  };
  const parsed = OwnerActionListRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function listInput(request: OwnerActionListRequest): OwnerPendingActionListInput {
  return {
    ...(request.agent_id === undefined ? {} : { agentId: request.agent_id }),
    ...(request.states === undefined ? {} : { states: request.states }),
    ...(request.operations === undefined ? {} : { operations: request.operations }),
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  };
}

function actionId(request: FastifyRequest): string | null {
  const parameters = request.params as { actionId?: unknown };
  const parsed = OwnerActionDetailRequestSchema.safeParse({
    action_id: parameters.actionId,
  });
  return parsed.success ? parsed.data.action_id : null;
}

function hasNoQueryParameters(request: FastifyRequest): boolean {
  return new URL(request.url, "http://alphanet.invalid").searchParams.size === 0;
}

function summary(view: OwnerPendingActionSummaryView): OwnerActionSummary | null {
  const parsed = OwnerActionListResponseSchema.shape.items.element.safeParse({
    id: view.id,
    version: view.version,
    agent: {
      id: view.agent.id,
      handle: view.agent.handle,
      display_name: view.agent.displayName,
      status: view.agent.status,
    },
    operation: view.operation,
    state: view.state,
    target: view.target,
    approval_summary: view.approvalSummary,
    requested_at: view.requestedAt.toISOString(),
    expires_at: view.expiresAt.toISOString(),
    updated_at: view.updatedAt.toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

function previewSourceLinks(
  sourceLinks: readonly {
    url: string;
    title?: string | undefined;
    description?: string | undefined;
  }[],
) {
  return sourceLinks.map((source) => ({
    url: source.url,
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.description === undefined ? {} : { description: source.description }),
  }));
}

function previewReferences(
  references: readonly {
    targetContentId: string;
    relationType: "quote" | "reference";
  }[],
) {
  return references.map((reference) => ({
    target_content_id: reference.targetContentId,
    relation_type: reference.relationType,
  }));
}

function preview(view: OwnerPendingActionDetailView): unknown {
  if (view.command.operation === "update_content") {
    const command = view.command;
    const baseline = command.frozenUpdateBaseline;
    if (
      view.expectedVersion !== command.expectedVersion ||
      view.target.type !== "content" ||
      view.target.id !== command.contentId ||
      baseline === undefined ||
      baseline.resourceVersion !== command.expectedVersion
    ) {
      return null;
    }

    return {
      operation: command.operation,
      content_id: command.contentId,
      expected_version: command.expectedVersion,
      baseline: {
        content_kind: baseline.contentKind,
        resource_version: baseline.resourceVersion,
        revision_id: baseline.revisionId,
        title: baseline.title,
        body_markdown: baseline.bodyMarkdown,
        primary_community_id: baseline.primaryCommunityId,
        additional_community_ids: [...baseline.additionalCommunityIds],
      },
      patch: {
        ...(command.patch.title === undefined ? {} : { title: command.patch.title }),
        ...(command.patch.bodyMarkdown === undefined
          ? {}
          : { body_markdown: command.patch.bodyMarkdown }),
        ...(command.patch.sourceLinks === undefined
          ? {}
          : { source_links: previewSourceLinks(command.patch.sourceLinks) }),
        ...(command.patch.references === undefined
          ? {}
          : { references: previewReferences(command.patch.references) }),
        ...(command.patch.additionalCommunityIds === undefined
          ? {}
          : {
              additional_community_ids: [...command.patch.additionalCommunityIds],
            }),
        ...(command.patch.symbols === undefined
          ? {}
          : { symbols: [...command.patch.symbols] }),
        ...(command.patch.topics === undefined
          ? {}
          : { topics: [...command.patch.topics] }),
      },
      ...(command.editSummary === undefined ? {} : { edit_summary: command.editSummary }),
    };
  }

  const common = {
    body_markdown: view.command.bodyMarkdown,
    symbols: view.command.symbols,
    topics: view.command.topics,
    source_links: previewSourceLinks(view.command.sourceLinks),
    references: previewReferences(view.command.references),
  };
  return view.command.operation === "create_post"
    ? {
        operation: view.command.operation,
        title: view.command.title,
        primary_community_id: view.command.primaryCommunityId,
        additional_community_ids: view.command.additionalCommunityIds,
        ...common,
      }
    : {
        operation: view.command.operation,
        parent_content_id: view.command.parentContentId,
        ...common,
      };
}

function detail(view: OwnerPendingActionDetailView): OwnerActionDetail | null {
  const serializedSummary = summary(view);
  const serializedPreview = preview(view);
  if (!serializedSummary || !serializedPreview) return null;
  const parsed = OwnerActionDetailResponseSchema.shape.action.safeParse({
    ...serializedSummary,
    preview: serializedPreview,
    input_digest: view.inputDigest,
    idempotency_key_hint: view.idempotencyKeyHint,
    approval_reason_category: view.approvalReasonCategory,
    decision_id: view.decisionId,
    policy_version: view.policyVersion,
    decided_at: view.decidedAt?.toISOString() ?? null,
    terminal_at: view.terminalAt?.toISOString() ?? null,
    approval_outcome: view.approvalOutcome,
    decision_reason_code: view.decisionReasonCode,
    public_error:
      view.publicError === null
        ? null
        : {
            code: view.publicError.code,
            message: view.publicError.message,
            retryable: view.publicError.retryable,
            details: view.publicError.details,
            retry_after_ms: view.publicError.retryAfterMs,
          },
  });
  return parsed.success ? parsed.data : null;
}

function listResponse(
  request: FastifyRequest,
  page: OwnerPendingActionPage,
): OwnerActionListResponse | null {
  const items: OwnerActionSummary[] = [];
  for (const view of page.items) {
    const item = summary(view);
    if (!item) return null;
    items.push(item);
  }
  const parsed = OwnerActionListResponseSchema.safeParse({
    items,
    page: {
      next_cursor: page.nextCursor,
      has_more: page.hasMore,
      limit: page.limit,
    },
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function detailResponse(
  request: FastifyRequest,
  view: OwnerPendingActionDetailView,
): OwnerActionDetailResponse | null {
  const action = detail(view);
  if (!action) return null;
  const parsed = OwnerActionDetailResponseSchema.safeParse({
    action,
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function approveResponse(
  request: FastifyRequest,
  view: OwnerPendingActionDetailView,
): OwnerActionApproveResponse | null {
  const action = detail(view);
  if (!action) return null;
  const parsed = OwnerActionApproveResponseSchema.safeParse({
    action,
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function rejectResponse(
  request: FastifyRequest,
  view: OwnerPendingActionDetailView,
): OwnerActionRejectResponse | null {
  const action = detail(view);
  if (!action) return null;
  const parsed = OwnerActionRejectResponseSchema.safeParse({
    action,
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function sendOwnerActionError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof OwnerPendingActionError) {
    const mayExposeCurrentValues =
      error.code === "ACTION_DECISION_CONFLICT" ||
      error.code === "ACTION_VERSION_CONFLICT";
    const currentState = OwnerActionStateSchema.safeParse(error.currentState);
    const currentVersion = error.currentVersion;
    const details = {
      ...(mayExposeCurrentValues && currentState.success
        ? { current_state: currentState.data }
        : {}),
      ...(mayExposeCurrentValues &&
      typeof currentVersion === "number" &&
      Number.isSafeInteger(currentVersion) &&
      currentVersion > 0
        ? { current_version: currentVersion }
        : {}),
    };
    return reply.code(error.statusCode).send(
      ownerV1Error(request, {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: Object.keys(details).length === 0 ? null : details,
      }),
    );
  }

  request.log.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Owner pending-action request failed",
  );
  return reply.code(503).send(
    ownerV1Error(request, {
      code: "OWNER_ACTION_UNAVAILABLE",
      message: "Owner action operations are temporarily unavailable.",
      retryable: true,
    }),
  );
}

function projectionFailed(
  request: FastifyRequest,
  reply: FastifyReply,
  projection: "approve" | "detail" | "list" | "reject",
): FastifyReply {
  request.log.error({ projection }, "Owner pending-action projection was invalid");
  return sendOwnerActionError(request, reply, new Error("projection invalid"));
}

export function registerOwnerActionRoutes(
  app: FastifyInstance,
  options: OwnerActionRouteOptions,
): void {
  const boundaryOptions = {
    allowedOrigins: options.allowedOrigins,
    authRuntime: options.authRuntime,
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  };
  const readAuthorization = createOwnerRequestAuthorizationBoundary({
    ...boundaryOptions,
    mode: "read",
  });
  const mutationAuthorization = createOwnerRequestAuthorizationBoundary({
    ...boundaryOptions,
    mode: "mutation",
  });

  app.get(
    "/v1/owner/pending-actions",
    { onRequest: readAuthorization.onRequest },
    async (request, reply) => {
      const authorization = readAuthorization.getAuthorization(request);
      const query = listRequest(request);
      if (!query) return validationFailed(request, reply);

      try {
        const page = await options.service.listActions(
          authorization.owner.id,
          listInput(query),
        );
        const response = listResponse(request, page);
        return response ?? projectionFailed(request, reply, "list");
      } catch (error) {
        return sendOwnerActionError(request, reply, error);
      }
    },
  );

  app.get(
    "/v1/owner/pending-actions/:actionId",
    { onRequest: readAuthorization.onRequest },
    async (request, reply) => {
      const authorization = readAuthorization.getAuthorization(request);
      const id = actionId(request);
      if (!id || !hasNoQueryParameters(request)) {
        return validationFailed(request, reply);
      }

      try {
        const view = await options.service.getAction(authorization.owner.id, id, {
          requestId: request.id,
        });
        const response = detailResponse(request, view);
        return response ?? projectionFailed(request, reply, "detail");
      } catch (error) {
        return sendOwnerActionError(request, reply, error);
      }
    },
  );

  app.post(
    "/v1/owner/pending-actions/:actionId/approve",
    { onRequest: mutationAuthorization.onRequest },
    async (request, reply) => {
      const authorization = mutationAuthorization.getAuthorization(request);
      const id = actionId(request);
      const body = OwnerActionApproveRequestSchema.safeParse(request.body);
      if (!id || !hasNoQueryParameters(request) || !body.success) {
        return validationFailed(request, reply);
      }

      try {
        const view = await options.service.approveAction(authorization.owner.id, id, {
          expectedVersion: body.data.expected_version,
          reasonCode: body.data.reason_code,
          requestId: request.id,
        });
        const response = approveResponse(request, view);
        if (!response) return projectionFailed(request, reply, "approve");
        void reply.header("location", `/v1/actions/${view.id}`);
        return reply.code(202).send(response);
      } catch (error) {
        return sendOwnerActionError(request, reply, error);
      }
    },
  );

  app.post(
    "/v1/owner/pending-actions/:actionId/reject",
    { onRequest: mutationAuthorization.onRequest },
    async (request, reply) => {
      const authorization = mutationAuthorization.getAuthorization(request);
      const id = actionId(request);
      const body = OwnerActionRejectRequestSchema.safeParse(request.body);
      if (!id || !hasNoQueryParameters(request) || !body.success) {
        return validationFailed(request, reply);
      }

      try {
        const view = await options.service.rejectAction(authorization.owner.id, id, {
          expectedVersion: body.data.expected_version,
          reasonCode: body.data.reason_code,
          requestId: request.id,
        });
        const response = rejectResponse(request, view);
        if (!response) return projectionFailed(request, reply, "reject");
        return reply.code(200).send(response);
      } catch (error) {
        return sendOwnerActionError(request, reply, error);
      }
    },
  );
}
