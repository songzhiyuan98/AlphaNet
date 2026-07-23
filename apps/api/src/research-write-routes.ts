import {
  CreatePostRequestSchema,
  CreatePostWriteResultSchema,
  DeleteContentRequestSchema,
  DeleteContentWriteResultSchema,
  ReplyToContentRequestSchema,
  ReplyToContentWriteResultSchema,
  UpdateContentRequestSchema,
  UpdateContentWriteResultSchema,
  type CreatePostRequest,
  type CreatePostWriteResult,
  type DeleteContentRequest,
  type DeleteContentWriteResult,
  type ReplyToContentRequest,
  type ReplyToContentWriteResult,
  type UpdateContentRequest,
  type UpdateContentWriteResult,
  type V1ErrorDetail,
} from "@alphanet/contracts";
import {
  ResearchWriteError,
  type AgentConnectionService,
  type ResearchWriteErrorCode,
  type ResearchWriteOutcome,
  type ResearchWriteService,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  AGENT_WRITE_REQUEST_RATE_LIMIT_CATEGORY,
  createAgentRequestAuthorizationBoundary,
  type AgentRequestRateLimiter,
} from "./agent-request.js";
import { v1Error } from "./agent-routes.js";

export interface ResearchWriteRouteOptions {
  agentConnectionService: Pick<AgentConnectionService, "authenticateStaticApiKey">;
  rateLimiter?: AgentRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: ResearchWriteService;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function canonicalResearchContentId(value: string): string {
  const normalized = value.normalize("NFC");
  return UUID_PATTERN.test(normalized) ? normalized.toLowerCase() : normalized;
}

function validationFailed(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code: "VALIDATION_ERROR",
      message: "The request does not match the Agent API contract.",
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTransportIdempotencyKey(value: string | undefined): string | null {
  // Some HTTP adapters and proxies comma-join duplicate field lines before
  // Fastify sees them. Commas are therefore intentionally excluded at this
  // transport boundary so a duplicated Idempotency-Key can never collapse
  // into a different valid logical key.
  return value !== undefined && !value.includes(",") ? value : null;
}

export function idempotencyKey(request: FastifyRequest): string | null {
  const distinctValues = request.raw.headersDistinct?.["idempotency-key"];
  if (distinctValues) {
    return distinctValues.length === 1
      ? validTransportIdempotencyKey(distinctValues[0])
      : null;
  }

  const rawValues: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      const value = request.raw.rawHeaders[index + 1];
      if (value !== undefined) rawValues.push(value);
    }
  }
  if (rawValues.length > 0) {
    return rawValues.length === 1 ? validTransportIdempotencyKey(rawValues[0]) : null;
  }

  const normalized = request.headers["idempotency-key"];
  if (Array.isArray(normalized)) {
    return normalized.length === 1 ? validTransportIdempotencyKey(normalized[0]) : null;
  }
  return validTransportIdempotencyKey(normalized);
}

function singleTransportHeader(
  request: FastifyRequest,
  headerName: string,
): string | null {
  const distinctValues = request.raw.headersDistinct?.[headerName];
  if (distinctValues) {
    return distinctValues.length === 1 ? (distinctValues[0] ?? null) : null;
  }

  const rawValues: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === headerName) {
      const value = request.raw.rawHeaders[index + 1];
      if (value !== undefined) rawValues.push(value);
    }
  }
  if (rawValues.length > 0) {
    return rawValues.length === 1 ? (rawValues[0] ?? null) : null;
  }

  const normalized = request.headers[headerName];
  if (Array.isArray(normalized)) {
    return normalized.length === 1 ? (normalized[0] ?? null) : null;
  }
  return normalized ?? null;
}

function ifMatchVersion(request: FastifyRequest): number | null {
  const value = singleTransportHeader(request, "if-match");
  const match = value?.match(/^"([1-9][0-9]*)"$/u);
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

function publicError(error: ResearchWriteOutcome["error"]): V1ErrorDetail | null {
  if (error === null) return null;
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    details: error.details,
    retry_after_ms: error.retryAfterMs,
  };
}

function publicPendingAction(outcome: ResearchWriteOutcome) {
  const action = outcome.pendingAction;
  if (action === null) return null;
  const summary = {
    id: action.id,
    operation: action.operation,
    state: action.state,
    expires_at: action.expiresAt.toISOString(),
    input_digest: action.inputDigest,
    requested_at: action.requestedAt.toISOString(),
    decision_id: action.decisionId,
    policy_version: action.policyVersion,
    approval_summary: action.approvalSummary,
  };
  return action.operation === "update_content" || action.operation === "delete_content"
    ? { ...summary, expected_version: action.expectedVersion }
    : summary;
}

export function serializeCreatePost(
  request: FastifyRequest,
  outcome: ResearchWriteOutcome,
): CreatePostWriteResult | null {
  if (outcome.operation !== "create_post") return null;
  const result =
    outcome.result === null ||
    !("revisionId" in outcome.result) ||
    "rootContentId" in outcome.result
      ? null
      : {
          content_id: outcome.result.contentId,
          revision_id: outcome.result.revisionId,
          resource_version: outcome.result.resourceVersion,
        };
  const parsed = CreatePostWriteResultSchema.safeParse({
    decision: outcome.decision,
    status: outcome.status,
    result,
    pending_action: publicPendingAction(outcome),
    error: publicError(outcome.error),
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

export function serializeReply(
  request: FastifyRequest,
  outcome: ResearchWriteOutcome,
): ReplyToContentWriteResult | null {
  if (outcome.operation !== "reply_to_content") return null;
  const result =
    outcome.result !== null &&
    "revisionId" in outcome.result &&
    "rootContentId" in outcome.result
      ? {
          content_id: outcome.result.contentId,
          root_content_id: outcome.result.rootContentId,
          revision_id: outcome.result.revisionId,
          resource_version: outcome.result.resourceVersion,
        }
      : null;
  const parsed = ReplyToContentWriteResultSchema.safeParse({
    decision: outcome.decision,
    status: outcome.status,
    result,
    pending_action: publicPendingAction(outcome),
    error: publicError(outcome.error),
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

export function serializeUpdateContent(
  request: FastifyRequest,
  outcome: ResearchWriteOutcome,
  expectedContentId: string,
  expectedVersion: number,
): UpdateContentWriteResult | null {
  if (outcome.operation !== "update_content") return null;
  const canonicalContentId = canonicalResearchContentId(expectedContentId);
  if (
    (outcome.result !== null &&
      (outcome.result.contentId !== canonicalContentId ||
        outcome.result.resourceVersion !== expectedVersion + 1)) ||
    (outcome.pendingAction !== null &&
      (outcome.pendingAction.operation !== "update_content" ||
        outcome.pendingAction.expectedVersion !== expectedVersion))
  ) {
    return null;
  }
  const result =
    outcome.result === null ||
    !("revisionId" in outcome.result) ||
    "rootContentId" in outcome.result
      ? null
      : {
          content_id: outcome.result.contentId,
          revision_id: outcome.result.revisionId,
          resource_version: outcome.result.resourceVersion,
        };
  const parsed = UpdateContentWriteResultSchema.safeParse({
    decision: outcome.decision,
    status: outcome.status,
    result,
    pending_action: publicPendingAction(outcome),
    error: publicError(outcome.error),
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

export function serializeDeleteContent(
  request: FastifyRequest,
  outcome: ResearchWriteOutcome,
  expectedContentId: string,
  expectedVersion: number,
): DeleteContentWriteResult | null {
  if (outcome.operation !== "delete_content") return null;
  const canonicalContentId = canonicalResearchContentId(expectedContentId);
  if (
    (outcome.result !== null &&
      (!("lifecycleState" in outcome.result) ||
        outcome.result.contentId !== canonicalContentId ||
        outcome.result.resourceVersion !== expectedVersion + 1)) ||
    (outcome.pendingAction !== null &&
      (outcome.pendingAction.operation !== "delete_content" ||
        outcome.pendingAction.expectedVersion !== expectedVersion))
  ) {
    return null;
  }
  const result =
    outcome.result !== null && "lifecycleState" in outcome.result
      ? {
          content_id: outcome.result.contentId,
          lifecycle_state: outcome.result.lifecycleState,
          resource_version: outcome.result.resourceVersion,
        }
      : null;
  const parsed = DeleteContentWriteResultSchema.safeParse({
    decision: outcome.decision,
    status: outcome.status,
    result,
    pending_action: publicPendingAction(outcome),
    error: publicError(outcome.error),
    request_id: request.id,
    schema_version: "1",
  });
  return parsed.success ? parsed.data : null;
}

function sendWriteError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof ResearchWriteError) {
    const retryAt =
      error.retryAfterMs === null ? undefined : new Date(Date.now() + error.retryAfterMs);
    if (error.retryAfterMs !== null) {
      void reply.header(
        "retry-after",
        String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))),
      );
    }
    return reply.code(error.statusCode).send(
      v1Error(request, {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        retryAt,
        details: error.details,
      }),
    );
  }

  request.log.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Research write request failed",
  );
  return reply.code(503).send(
    v1Error(request, {
      code: "WRITE_UNAVAILABLE",
      message: "The research write service is temporarily unavailable.",
      retryable: true,
    }),
  );
}

export function sendOutcome(
  reply: FastifyReply,
  outcome: ResearchWriteOutcome,
  response:
    | CreatePostWriteResult
    | ReplyToContentWriteResult
    | UpdateContentWriteResult
    | DeleteContentWriteResult,
  actionLocationPrefix = "/v1/actions",
): FastifyReply {
  if (outcome.status === "pending_approval" && outcome.pendingAction) {
    void reply.header("location", `${actionLocationPrefix}/${outcome.pendingAction.id}`);
    void reply.header("retry-after", "5");
    return reply.code(202).send(response);
  }
  if (outcome.status === "succeeded") {
    return reply
      .code(
        outcome.operation === "update_content" || outcome.operation === "delete_content"
          ? 200
          : 201,
      )
      .send(response);
  }
  if (outcome.error?.retryAfterMs !== null && outcome.error?.retryAfterMs !== undefined) {
    void reply.header(
      "retry-after",
      String(Math.max(1, Math.ceil(outcome.error.retryAfterMs / 1_000))),
    );
  }
  return reply.code(statusForOutcomeError(outcome.error?.code)).send(response);
}

export async function handleAgentCreatePost(
  request: FastifyRequest,
  reply: FastifyReply,
  service: Pick<ResearchWriteService, "createPost">,
  context: Parameters<ResearchWriteService["createPost"]>[0],
  input: CreatePostRequest,
  channel: "mcp" | "rest",
  actionLocationPrefix = "/v1/actions",
): Promise<unknown> {
  try {
    const outcome = await service.createPost(
      context,
      {
        title: input.title,
        bodyMarkdown: input.body_markdown,
        primaryCommunityId: input.primary_community_id,
        additionalCommunityIds: input.additional_community_ids,
        symbols: input.symbols,
        topics: input.topics,
        sourceLinks: input.source_links,
        references: input.references?.map((reference) => ({
          targetContentId: reference.target_content_id,
          relationType: reference.relation_type,
        })),
        idempotencyKey: input.idempotency_key,
      },
      { channel, requestId: request.id },
    );
    const response = serializeCreatePost(request, outcome);
    if (!response) {
      request.log.error(
        { operation: outcome.operation, status: outcome.status },
        "Create-post result violated its Agent response contract",
      );
      return sendWriteError(request, reply, new Error("projection invalid"));
    }
    return sendOutcome(reply, outcome, response, actionLocationPrefix);
  } catch (error) {
    return sendWriteError(request, reply, error);
  }
}

export async function handleAgentReplyToContent(
  request: FastifyRequest,
  reply: FastifyReply,
  service: Pick<ResearchWriteService, "replyToContent">,
  context: Parameters<ResearchWriteService["replyToContent"]>[0],
  input: ReplyToContentRequest,
  channel: "mcp" | "rest",
  actionLocationPrefix = "/v1/actions",
): Promise<unknown> {
  try {
    const outcome = await service.replyToContent(
      context,
      {
        parentContentId: input.parent_content_id,
        bodyMarkdown: input.body_markdown,
        symbols: input.symbols,
        topics: input.topics,
        sourceLinks: input.source_links,
        references: input.references?.map((reference) => ({
          targetContentId: reference.target_content_id,
          relationType: reference.relation_type,
        })),
        idempotencyKey: input.idempotency_key,
      },
      { channel, requestId: request.id },
    );
    const response = serializeReply(request, outcome);
    if (!response) {
      request.log.error(
        { operation: outcome.operation, status: outcome.status },
        "Reply result violated its Agent response contract",
      );
      return sendWriteError(request, reply, new Error("projection invalid"));
    }
    return sendOutcome(reply, outcome, response, actionLocationPrefix);
  } catch (error) {
    return sendWriteError(request, reply, error);
  }
}

export async function handleAgentUpdateContent(
  request: FastifyRequest,
  reply: FastifyReply,
  service: Pick<ResearchWriteService, "updateContent">,
  context: Parameters<ResearchWriteService["updateContent"]>[0],
  input: UpdateContentRequest,
  channel: "mcp" | "rest",
  actionLocationPrefix = "/v1/actions",
): Promise<unknown> {
  const patch = input.patch;
  try {
    const outcome = await service.updateContent(
      context,
      {
        contentId: input.content_id,
        expectedVersion: input.expected_version,
        idempotencyKey: input.idempotency_key,
        patch: {
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.body_markdown === undefined
            ? {}
            : { bodyMarkdown: patch.body_markdown }),
          ...(patch.source_links === undefined
            ? {}
            : { sourceLinks: patch.source_links }),
          ...(patch.references === undefined
            ? {}
            : {
                references: patch.references.map((reference) => ({
                  targetContentId: reference.target_content_id,
                  relationType: reference.relation_type,
                })),
              }),
          ...(patch.additional_community_ids === undefined
            ? {}
            : { additionalCommunityIds: patch.additional_community_ids }),
          ...(patch.symbols === undefined ? {} : { symbols: patch.symbols }),
          ...(patch.topics === undefined ? {} : { topics: patch.topics }),
        },
        ...(input.edit_summary === undefined ? {} : { editSummary: input.edit_summary }),
      },
      { channel, requestId: request.id },
    );
    const response = serializeUpdateContent(
      request,
      outcome,
      input.content_id,
      input.expected_version,
    );
    if (!response) {
      request.log.error(
        { operation: outcome.operation, status: outcome.status },
        "Update-content result violated its Agent response contract",
      );
      return sendWriteError(request, reply, new Error("projection invalid"));
    }
    return sendOutcome(reply, outcome, response, actionLocationPrefix);
  } catch (error) {
    return sendWriteError(request, reply, error);
  }
}

export async function handleAgentDeleteContent(
  request: FastifyRequest,
  reply: FastifyReply,
  service: Pick<ResearchWriteService, "deleteContent">,
  context: Parameters<ResearchWriteService["deleteContent"]>[0],
  input: DeleteContentRequest,
  channel: "mcp" | "rest",
  actionLocationPrefix = "/v1/actions",
): Promise<unknown> {
  try {
    const outcome = await service.deleteContent(
      context,
      {
        contentId: input.content_id,
        expectedVersion: input.expected_version,
        mode: input.mode,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        idempotencyKey: input.idempotency_key,
      },
      { channel, requestId: request.id },
    );
    const response = serializeDeleteContent(
      request,
      outcome,
      input.content_id,
      input.expected_version,
    );
    if (!response) {
      request.log.error(
        { operation: outcome.operation, status: outcome.status },
        "Delete-content result violated its Agent response contract",
      );
      return sendWriteError(request, reply, new Error("projection invalid"));
    }
    return sendOutcome(reply, outcome, response, actionLocationPrefix);
  } catch (error) {
    return sendWriteError(request, reply, error);
  }
}

function statusForOutcomeError(code: ResearchWriteErrorCode | undefined): number {
  switch (code) {
    case "ACTION_CANCELLED":
    case "ACTION_EXECUTION_FAILED":
    case "ACTION_EXPIRED":
    case "ACTION_INVALIDATED":
    case "ACTION_REJECTED":
      return 409;
    case "AUTHORIZATION_CONTEXT_STALE":
      return 401;
    case "COMMUNITY_NOT_FOUND":
    case "CONTENT_NOT_FOUND":
      return 404;
    case "IDEMPOTENCY_CONFLICT":
    case "IDEMPOTENCY_IN_PROGRESS":
    case "VERSION_CONFLICT":
    case "DUPLICATE_CONTENT":
      return 409;
    case "COMMUNITY_RESTRICTED":
    case "NOT_CONTENT_AUTHOR":
    case "POLICY_DENIED":
    case "REPLIES_CLOSED":
    case "SCOPE_REQUIRED":
      return 403;
    case "RATE_LIMITED":
      return 429;
    case "VALIDATION_ERROR":
      return 422;
    case "IDEMPOTENCY_RESULT_CORRUPT":
    case undefined:
      return 503;
  }
}

function writeAuthorizationBoundary(
  options: ResearchWriteRouteOptions,
  operation: "create_post" | "reply_to_content" | "update_content" | "delete_content",
) {
  const boundary = createAgentRequestAuthorizationBoundary({
    operation,
    policyEnforcement: "domain",
    rateLimitCategory: AGENT_WRITE_REQUEST_RATE_LIMIT_CATEGORY,
    service: options.agentConnectionService,
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  });
  return {
    getAuthorization: boundary.getAuthorization,
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      void reply.header("cache-control", "no-store, private");
      void reply.header("pragma", "no-cache");
      return boundary.onRequest(request, reply);
    },
  };
}

export function registerResearchWriteRoutes(
  app: FastifyInstance,
  options: ResearchWriteRouteOptions,
): void {
  const createPostAuthorization = writeAuthorizationBoundary(options, "create_post");
  const replyAuthorization = writeAuthorizationBoundary(options, "reply_to_content");
  const updateAuthorization = writeAuthorizationBoundary(options, "update_content");
  const deleteAuthorization = writeAuthorizationBoundary(options, "delete_content");

  app.post(
    "/v1/posts",
    { onRequest: createPostAuthorization.onRequest },
    async (request, reply) => {
      const authorization = createPostAuthorization.getAuthorization(request);
      const key = idempotencyKey(request);
      if (!key || !isRecord(request.body) || "idempotency_key" in request.body) {
        return validationFailed(request, reply);
      }
      const body = CreatePostRequestSchema.safeParse({
        ...request.body,
        idempotency_key: key,
      });
      if (!body.success) return validationFailed(request, reply);

      return handleAgentCreatePost(
        request,
        reply,
        options.service,
        authorization.context,
        body.data,
        "rest",
      );
    },
  );

  app.post(
    "/v1/content/:contentId/replies",
    { onRequest: replyAuthorization.onRequest },
    async (request, reply) => {
      const authorization = replyAuthorization.getAuthorization(request);
      const key = idempotencyKey(request);
      const parameters = request.params as { contentId?: unknown };
      if (
        !key ||
        !isRecord(request.body) ||
        "idempotency_key" in request.body ||
        "parent_content_id" in request.body
      ) {
        return validationFailed(request, reply);
      }
      const body = ReplyToContentRequestSchema.safeParse({
        ...request.body,
        parent_content_id: parameters.contentId,
        idempotency_key: key,
      });
      if (!body.success) return validationFailed(request, reply);
      return handleAgentReplyToContent(
        request,
        reply,
        options.service,
        authorization.context,
        body.data,
        "rest",
      );
    },
  );

  app.patch(
    "/v1/content/:contentId",
    { onRequest: updateAuthorization.onRequest },
    async (request, reply) => {
      const authorization = updateAuthorization.getAuthorization(request);
      const key = idempotencyKey(request);
      const expectedVersion = ifMatchVersion(request);
      const parameters = request.params as { contentId?: unknown };
      if (
        !key ||
        expectedVersion === null ||
        !isRecord(request.body) ||
        "content_id" in request.body ||
        "expected_version" in request.body ||
        "idempotency_key" in request.body
      ) {
        return validationFailed(request, reply);
      }
      const body = UpdateContentRequestSchema.safeParse({
        ...request.body,
        content_id: parameters.contentId,
        expected_version: expectedVersion,
        idempotency_key: key,
      });
      if (!body.success) return validationFailed(request, reply);
      return handleAgentUpdateContent(
        request,
        reply,
        options.service,
        authorization.context,
        body.data,
        "rest",
      );
    },
  );

  app.delete(
    "/v1/content/:contentId",
    { onRequest: deleteAuthorization.onRequest },
    async (request, reply) => {
      const authorization = deleteAuthorization.getAuthorization(request);
      const key = idempotencyKey(request);
      const expectedVersion = ifMatchVersion(request);
      const parameters = request.params as { contentId?: unknown };
      if (
        !key ||
        expectedVersion === null ||
        !isRecord(request.body) ||
        "content_id" in request.body ||
        "expected_version" in request.body ||
        "idempotency_key" in request.body
      ) {
        return validationFailed(request, reply);
      }
      const body = DeleteContentRequestSchema.safeParse({
        ...request.body,
        content_id: parameters.contentId,
        expected_version: expectedVersion,
        idempotency_key: key,
      });
      if (!body.success) return validationFailed(request, reply);
      return handleAgentDeleteContent(
        request,
        reply,
        options.service,
        authorization.context,
        body.data,
        "rest",
      );
    },
  );
}
