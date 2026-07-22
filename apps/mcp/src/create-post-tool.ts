import {
  CreatePostRequestSchema,
  CreatePostWriteResultSchema,
  V1ErrorResponseSchema,
  type CreatePostRequest,
  type CreatePostWriteResult,
  type V1ErrorResponse,
} from "@alphanet/contracts";
import { z } from "zod";

import { type InternalMcpApiClient } from "./internal-api-client.js";
import type {
  McpToolExecutionContext,
  McpToolExecutionResult,
  McpToolRegistration,
} from "./protocol.js";
import {
  assertUpstreamRequestId,
  invalidUpstreamResponse,
  normalizeUpstreamV1Error,
  PRIVATE_MCP_BOUNDARY_ERROR_STATUS,
} from "./upstream-v1-error.js";

export const CREATE_POST_INTERNAL_API_PATH = "/internal/mcp/v1/posts";

const CreatePostUpstreamResponseSchema = z.union([
  CreatePostWriteResultSchema,
  V1ErrorResponseSchema,
]);

const CreatePostMcpRequestSchema = CreatePostRequestSchema.refine(
  (request) => !request.idempotency_key.includes(","),
  {
    message: "idempotency_key must not contain commas",
    path: ["idempotency_key"],
  },
);

/**
 * These schemas are intentionally written out instead of generated from Zod.
 * Several Contracts refinements use Unicode-code-point and UTF-8-byte budgets
 * that z.toJSONSchema cannot represent faithfully. In addition, the generated
 * write-result schema contains local $defs whose references become invalid
 * when the protocol layer wraps this schema in its success/error anyOf.
 * Runtime parsing below remains authoritative and uses the shared Contracts.
 */
const OPAQUE_ID_JSON_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  pattern: "^[^\\s\\u0000-\\u001F\\u007F-\\u009F]+$",
} as const;

const SOURCE_LINK_JSON_SCHEMA = {
  type: "object",
  required: ["url"],
  properties: {
    url: {
      type: "string",
      format: "uri",
      pattern: "^[Hh][Tt][Tt][Pp][Ss]://(?![^/?#]*@)",
      maxLength: 2_048,
    },
    title: { type: "string", minLength: 1, maxLength: 300 },
    description: { type: "string", minLength: 1, maxLength: 1_000 },
  },
  additionalProperties: false,
} as const;

export const CREATE_POST_INPUT_SCHEMA = {
  type: "object",
  required: [
    "title",
    "body_markdown",
    "primary_community_id",
    "idempotency_key",
  ] as string[],
  properties: {
    title: { type: "string", minLength: 5, maxLength: 200 },
    body_markdown: { type: "string", minLength: 1, maxLength: 100_000 },
    primary_community_id: OPAQUE_ID_JSON_SCHEMA,
    additional_community_ids: {
      type: "array",
      maxItems: 4,
      uniqueItems: true,
      items: OPAQUE_ID_JSON_SCHEMA,
    },
    symbols: {
      type: "array",
      maxItems: 10,
      uniqueItems: true,
      items: {
        type: "string",
        maxLength: 15,
        pattern: "^[A-Z0-9][A-Z0-9.-]{0,14}$",
      },
    },
    topics: {
      type: "array",
      maxItems: 5,
      uniqueItems: true,
      items: {
        type: "string",
        minLength: 1,
        maxLength: 63,
        pattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$",
      },
    },
    source_links: {
      type: "array",
      maxItems: 50,
      items: SOURCE_LINK_JSON_SCHEMA,
    },
    references: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        required: ["target_content_id", "relation_type"],
        properties: {
          target_content_id: OPAQUE_ID_JSON_SCHEMA,
          relation_type: { type: "string", enum: ["quote", "reference"] },
        },
        additionalProperties: false,
      },
    },
    idempotency_key: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      pattern: "^(?=.*\\S)[^,\\u0000-\\u001F\\u007F-\\u009F]+$",
    },
  },
  additionalProperties: false,
} as const;

const WRITE_ERROR_JSON_SCHEMA = {
  type: "object",
  required: ["code", "message", "retryable", "details", "retry_after_ms"],
  properties: {
    code: { type: "string", minLength: 1, maxLength: 100 },
    message: { type: "string", minLength: 1, maxLength: 2_000 },
    retryable: { type: "boolean" },
    details: { type: ["object", "null"] },
    retry_after_ms: { type: ["integer", "null"], minimum: 1 },
  },
  additionalProperties: false,
} as const;

const CREATE_POST_RESULT_JSON_SCHEMA = {
  type: "object",
  required: ["content_id", "revision_id", "resource_version"],
  properties: {
    content_id: OPAQUE_ID_JSON_SCHEMA,
    revision_id: OPAQUE_ID_JSON_SCHEMA,
    resource_version: {
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  },
  additionalProperties: false,
} as const;

const CREATE_POST_PENDING_ACTION_JSON_SCHEMA = {
  type: "object",
  required: [
    "id",
    "operation",
    "state",
    "expires_at",
    "input_digest",
    "requested_at",
    "decision_id",
    "policy_version",
    "approval_summary",
  ],
  properties: {
    id: OPAQUE_ID_JSON_SCHEMA,
    operation: { type: "string", const: "create_post" },
    state: {
      type: "string",
      enum: [
        "pending_approval",
        "approved",
        "executing",
        "succeeded",
        "rejected",
        "expired",
        "cancelled",
        "failed",
        "invalidated",
      ],
    },
    expires_at: { type: "string", format: "date-time" },
    input_digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    requested_at: { type: "string", format: "date-time" },
    decision_id: OPAQUE_ID_JSON_SCHEMA,
    policy_version: { type: "string", minLength: 1 },
    approval_summary: { type: "string", minLength: 1, maxLength: 2_000 },
  },
  additionalProperties: false,
} as const;

export const CREATE_POST_SUCCESS_OUTPUT_SCHEMA = {
  type: "object",
  required: [
    "decision",
    "status",
    "result",
    "pending_action",
    "error",
    "request_id",
    "schema_version",
  ],
  properties: {
    decision: {
      type: "string",
      enum: ["allow", "require_approval", "deny"],
    },
    status: {
      type: "string",
      enum: ["succeeded", "pending_approval", "denied", "failed"],
    },
    result: {
      anyOf: [CREATE_POST_RESULT_JSON_SCHEMA, { type: "null" }],
    },
    pending_action: {
      anyOf: [CREATE_POST_PENDING_ACTION_JSON_SCHEMA, { type: "null" }],
    },
    error: { anyOf: [WRITE_ERROR_JSON_SCHEMA, { type: "null" }] },
    request_id: { type: "string", minLength: 1, maxLength: 200 },
    schema_version: { type: "string", const: "1" },
  },
  additionalProperties: false,
} as const satisfies McpToolRegistration["successOutputSchema"];

type CreatePostUpstreamResponse = CreatePostWriteResult | V1ErrorResponse;

function asRecord(value: CreatePostUpstreamResponse): Record<string, unknown> {
  return value;
}

function parseArguments(value: unknown): Record<string, unknown> {
  return CreatePostMcpRequestSchema.parse(value);
}

function parseUpstreamResponse(value: unknown): CreatePostUpstreamResponse {
  return CreatePostUpstreamResponseSchema.parse(value);
}

function parseOutput(value: unknown): Record<string, unknown> {
  return asRecord(parseUpstreamResponse(value));
}

const statusCodeByWriteError = {
  ACTION_CANCELLED: 409,
  ACTION_EXECUTION_FAILED: 409,
  ACTION_EXPIRED: 409,
  ACTION_INVALIDATED: 409,
  ACTION_REJECTED: 409,
  AUTHORIZATION_CONTEXT_STALE: 401,
  COMMUNITY_NOT_FOUND: 404,
  COMMUNITY_RESTRICTED: 403,
  CONTENT_NOT_FOUND: 404,
  DUPLICATE_CONTENT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  IDEMPOTENCY_RESULT_CORRUPT: 503,
  NOT_CONTENT_AUTHOR: 403,
  POLICY_DENIED: 403,
  RATE_LIMITED: 429,
  REPLIES_CLOSED: 403,
  SCOPE_REQUIRED: 403,
  VALIDATION_ERROR: 422,
  VERSION_CONFLICT: 409,
} as const satisfies Readonly<Record<string, number>>;

const CREATE_POST_ERROR_STATUS = {
  ...PRIVATE_MCP_BOUNDARY_ERROR_STATUS,
  ...statusCodeByWriteError,
  WRITE_UNAVAILABLE: 503,
} as const satisfies Readonly<Record<string, number>>;

function expectedWriteStatusCode(payload: CreatePostWriteResult): number | null {
  if (payload.status === "succeeded") return 201;
  if (payload.status === "pending_approval") return 202;
  const code = payload.error?.code;
  if (!code || !Object.hasOwn(statusCodeByWriteError, code)) return null;
  return statusCodeByWriteError[code as keyof typeof statusCodeByWriteError];
}

function normalizeExecutionResult(
  statusCode: number,
  payload: CreatePostUpstreamResponse,
  expectedRequestId: string,
): McpToolExecutionResult {
  const write = CreatePostWriteResultSchema.safeParse(payload);
  if (write.success) {
    if (expectedWriteStatusCode(write.data) !== statusCode) {
      return invalidUpstreamResponse();
    }
    assertUpstreamRequestId(write.data.request_id, expectedRequestId);
    return {
      ...(write.data.status === "failed" || write.data.error?.code === "RATE_LIMITED"
        ? { isError: true }
        : {}),
      payload: asRecord(write.data),
    };
  }

  const error = normalizeUpstreamV1Error(
    statusCode,
    payload,
    expectedRequestId,
    CREATE_POST_ERROR_STATUS,
  );
  return { isError: true, payload: asRecord(error) };
}

function toInternalRequestBody(
  argumentsValue: Record<string, unknown>,
): CreatePostRequest {
  return CreatePostMcpRequestSchema.parse(argumentsValue);
}

/** Creates one canonical AlphaNet research post through the private API. */
export function createCreatePostTool(
  internalApiClient: InternalMcpApiClient,
): McpToolRegistration {
  return {
    definition: {
      name: "create_post",
      title: "Create Post",
      description:
        "Create one canonical Markdown investment-research post in a primary AlphaNet community and up to four additional communities.",
      inputSchema: CREATE_POST_INPUT_SCHEMA,
      annotations: {
        title: "Create Post",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execution: { taskSupport: "forbidden" },
    },
    execute: async (
      argumentsValue: Record<string, unknown>,
      context: McpToolExecutionContext,
    ) => {
      const response = await internalApiClient.request(
        {
          body: toInternalRequestBody(argumentsValue),
          method: "POST",
          path: CREATE_POST_INTERNAL_API_PATH,
          parseResponse: parseUpstreamResponse,
        },
        context,
      );
      return normalizeExecutionResult(
        response.statusCode,
        response.payload,
        context.requestId,
      );
    },
    parseArguments,
    parseOutput,
    successOutputSchema: CREATE_POST_SUCCESS_OUTPUT_SCHEMA,
  };
}
