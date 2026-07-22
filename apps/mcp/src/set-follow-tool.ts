import {
  SetFollowPathParamsSchema,
  SetFollowRequestSchema,
  SetFollowWriteResultSchema,
  V1ErrorResponseSchema,
  type SetFollowWriteResult,
  type V1ErrorResponse,
} from "@alphanet/contracts";
import { z } from "zod";

import type { InternalMcpApiClient } from "./internal-api-client.js";
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

export const SET_FOLLOW_INTERNAL_API_PATH = "/internal/mcp/v1/follows";

const SetFollowMcpRequestSchema = SetFollowPathParamsSchema.extend(
  SetFollowRequestSchema.shape,
).strict();
type SetFollowMcpRequest = z.infer<typeof SetFollowMcpRequestSchema>;

const SetFollowUpstreamResponseSchema = z.union([
  SetFollowWriteResultSchema,
  V1ErrorResponseSchema,
]);

const OPAQUE_ID_JSON_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  pattern: "^[^\\s\\u0000-\\u001F\\u007F-\\u009F]+$",
} as const;

const IDEMPOTENCY_KEY_JSON_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  pattern: "^(?=.*\\S)[^,\\u0000-\\u001F\\u007F-\\u009F]+$",
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

const SET_FOLLOW_RESULT_JSON_SCHEMA = {
  type: "object",
  required: ["target_type", "target_id", "active", "notification_level", "updated_at"],
  properties: {
    target_type: {
      type: "string",
      enum: ["actor", "symbol", "topic", "content"],
    },
    target_id: OPAQUE_ID_JSON_SCHEMA,
    active: { type: "boolean" },
    notification_level: {
      anyOf: [
        {
          type: "string",
          enum: ["feed_only", "new_posts", "all_events"],
        },
        { type: "null" },
      ],
    },
    updated_at: { type: "string", format: "date-time" },
  },
  additionalProperties: false,
} as const;

export const SET_FOLLOW_INPUT_SCHEMA = {
  type: "object",
  required: ["target_type", "target_id", "active", "idempotency_key"] as string[],
  properties: {
    target_type: {
      type: "string",
      enum: ["actor", "symbol", "topic", "content"],
    },
    target_id: OPAQUE_ID_JSON_SCHEMA,
    active: { type: "boolean" },
    notification_level: {
      type: "string",
      enum: ["feed_only", "new_posts", "all_events"],
    },
    idempotency_key: IDEMPOTENCY_KEY_JSON_SCHEMA,
  },
  additionalProperties: false,
} as const;

export const SET_FOLLOW_SUCCESS_OUTPUT_SCHEMA = {
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
    decision: { type: "string", enum: ["allow", "deny"] },
    status: { type: "string", enum: ["succeeded", "denied", "failed"] },
    result: { anyOf: [SET_FOLLOW_RESULT_JSON_SCHEMA, { type: "null" }] },
    pending_action: { type: "null" },
    error: { anyOf: [WRITE_ERROR_JSON_SCHEMA, { type: "null" }] },
    request_id: { type: "string", minLength: 1, maxLength: 200 },
    schema_version: { type: "string", const: "1" },
  },
  additionalProperties: false,
} as const satisfies McpToolRegistration["successOutputSchema"];

type SetFollowUpstreamResponse = SetFollowWriteResult | V1ErrorResponse;

function asRecord(value: SetFollowUpstreamResponse): Record<string, unknown> {
  return value;
}

function parseArguments(value: unknown): Record<string, unknown> {
  return SetFollowMcpRequestSchema.parse(value);
}

function parseUpstreamResponse(value: unknown): SetFollowUpstreamResponse {
  return SetFollowUpstreamResponseSchema.parse(value);
}

function parseOutput(value: unknown): Record<string, unknown> {
  return asRecord(parseUpstreamResponse(value));
}

const statusCodeByWriteError = {
  AUTHORIZATION_CONTEXT_STALE: 401,
  FOLLOW_DATA_INVALID: 503,
  FOLLOW_LIMIT_REACHED: 409,
  FOLLOW_NOT_READY: 503,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  IDEMPOTENCY_RESULT_CORRUPT: 503,
  INVALID_ARGUMENT: 400,
  POLICY_DENIED: 403,
  RATE_LIMITED: 429,
  SCOPE_REQUIRED: 403,
  SELF_FOLLOW_NOT_ALLOWED: 409,
  TARGET_AMBIGUOUS: 409,
  TARGET_NOT_FOUND: 404,
  TARGET_NOT_VISIBLE: 403,
  VALIDATION_ERROR: 422,
} as const satisfies Readonly<Record<string, number>>;

const SET_FOLLOW_ERROR_STATUS = {
  ...PRIVATE_MCP_BOUNDARY_ERROR_STATUS,
  ...statusCodeByWriteError,
} as const satisfies Readonly<Record<string, number>>;

function expectedWriteStatusCode(payload: SetFollowWriteResult): number | null {
  if (payload.status === "succeeded") return 200;
  const code = payload.error?.code;
  if (!code || !Object.hasOwn(statusCodeByWriteError, code)) return null;
  return statusCodeByWriteError[code as keyof typeof statusCodeByWriteError];
}

function canonicalTargetId(request: SetFollowMcpRequest): string {
  const normalized = request.target_id.normalize("NFC");
  return request.target_type === "symbol"
    ? normalized.toUpperCase()
    : normalized.toLowerCase();
}

function successCorrelates(
  result: NonNullable<SetFollowWriteResult["result"]>,
  request: SetFollowMcpRequest,
): boolean {
  return (
    result.target_type === request.target_type &&
    result.target_id === canonicalTargetId(request) &&
    result.active === request.active &&
    (request.active
      ? request.notification_level === undefined ||
        result.notification_level === request.notification_level
      : result.notification_level === null)
  );
}

function normalizeExecutionResult(
  statusCode: number,
  payload: SetFollowUpstreamResponse,
  request: SetFollowMcpRequest,
  expectedRequestId: string,
): McpToolExecutionResult {
  const write = SetFollowWriteResultSchema.safeParse(payload);
  if (write.success) {
    if (
      expectedWriteStatusCode(write.data) !== statusCode ||
      (write.data.result !== null && !successCorrelates(write.data.result, request))
    ) {
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
    SET_FOLLOW_ERROR_STATUS,
  );
  return { isError: true, payload: asRecord(error) };
}

/** Sets one Follow target state through the private MCP API. */
export function createSetFollowTool(
  internalApiClient: InternalMcpApiClient,
): McpToolRegistration {
  return {
    definition: {
      name: "set_follow",
      title: "Set Follow",
      description:
        "Set or unset the authenticated Agent's Follow of an actor, symbol, topic, or content item, with an optional notification level. Following changes discovery and notifications, not target visibility, factual correctness, or source authority.",
      inputSchema: SET_FOLLOW_INPUT_SCHEMA,
      annotations: {
        title: "Set Follow",
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
      const request = SetFollowMcpRequestSchema.parse(argumentsValue);
      const response = await internalApiClient.request(
        {
          body: request,
          method: "POST",
          path: SET_FOLLOW_INTERNAL_API_PATH,
          parseResponse: parseUpstreamResponse,
        },
        context,
      );
      return normalizeExecutionResult(
        response.statusCode,
        response.payload,
        request,
        context.requestId,
      );
    },
    parseArguments,
    parseOutput,
    successOutputSchema: SET_FOLLOW_SUCCESS_OUTPUT_SCHEMA,
  };
}
