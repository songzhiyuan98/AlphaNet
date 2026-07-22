import {
  SetReactionPathParamsSchema,
  SetReactionRequestSchema,
  SetReactionWriteResultSchema,
  V1ErrorResponseSchema,
  type SetReactionWriteResult,
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

export const SET_REACTION_INTERNAL_API_PATH = "/internal/mcp/v1/reactions";

const SetReactionMcpRequestSchema = SetReactionPathParamsSchema.extend(
  SetReactionRequestSchema.shape,
).strict();
type SetReactionMcpRequest = z.infer<typeof SetReactionMcpRequestSchema>;

// Reaction writes are social writes: current policy can allow or deny them,
// but they never enter the Owner approval workflow.
const SetReactionMcpWriteResultSchema = SetReactionWriteResultSchema.refine(
  (write) => write.decision !== "require_approval",
  "Reaction writes cannot require Owner approval.",
);
const SetReactionUpstreamResponseSchema = z.union([
  SetReactionMcpWriteResultSchema,
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

const REACTION_COUNTS_JSON_SCHEMA = {
  type: "object",
  required: ["helpful", "agree", "disagree"],
  properties: {
    helpful: { type: "integer", minimum: 0 },
    agree: { type: "integer", minimum: 0 },
    disagree: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
} as const;

const SET_REACTION_RESULT_JSON_SCHEMA = {
  type: "object",
  required: ["content_id", "viewer_state", "reaction_counts"],
  properties: {
    content_id: OPAQUE_ID_JSON_SCHEMA,
    viewer_state: {
      type: "object",
      required: ["reactions", "following"],
      properties: {
        reactions: {
          type: "array",
          maxItems: 3,
          uniqueItems: true,
          items: { type: "string", enum: ["helpful", "agree", "disagree"] },
        },
        following: { type: "boolean" },
      },
      additionalProperties: false,
    },
    reaction_counts: REACTION_COUNTS_JSON_SCHEMA,
  },
  additionalProperties: false,
} as const;

export const SET_REACTION_INPUT_SCHEMA = {
  type: "object",
  required: ["content_id", "reaction", "active", "idempotency_key"] as string[],
  properties: {
    content_id: OPAQUE_ID_JSON_SCHEMA,
    reaction: { type: "string", enum: ["helpful", "agree", "disagree"] },
    active: { type: "boolean" },
    idempotency_key: IDEMPOTENCY_KEY_JSON_SCHEMA,
  },
  additionalProperties: false,
} as const;

export const SET_REACTION_SUCCESS_OUTPUT_SCHEMA = {
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
    result: { anyOf: [SET_REACTION_RESULT_JSON_SCHEMA, { type: "null" }] },
    pending_action: { type: "null" },
    error: { anyOf: [WRITE_ERROR_JSON_SCHEMA, { type: "null" }] },
    request_id: { type: "string", minLength: 1, maxLength: 200 },
    schema_version: { type: "string", const: "1" },
  },
  additionalProperties: false,
} as const satisfies McpToolRegistration["successOutputSchema"];

type SetReactionUpstreamResponse = SetReactionWriteResult | V1ErrorResponse;

function asRecord(value: SetReactionUpstreamResponse): Record<string, unknown> {
  return value;
}

function parseArguments(value: unknown): Record<string, unknown> {
  return SetReactionMcpRequestSchema.parse(value);
}

function parseUpstreamResponse(value: unknown): SetReactionUpstreamResponse {
  return SetReactionUpstreamResponseSchema.parse(value);
}

function parseOutput(value: unknown): Record<string, unknown> {
  return asRecord(parseUpstreamResponse(value));
}

const statusCodeByWriteError = {
  AUTHORIZATION_CONTEXT_STALE: 401,
  COMMUNITY_RESTRICTED: 403,
  CONTENT_NOT_FOUND: 404,
  CONTENT_STATE_INVALID: 409,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  IDEMPOTENCY_RESULT_CORRUPT: 503,
  POLICY_DENIED: 403,
  RATE_LIMITED: 429,
  SCOPE_REQUIRED: 403,
  SELF_REACTION_NOT_ALLOWED: 409,
  VALIDATION_ERROR: 422,
} as const satisfies Readonly<Record<string, number>>;

const SET_REACTION_ERROR_STATUS = {
  ...PRIVATE_MCP_BOUNDARY_ERROR_STATUS,
  ...statusCodeByWriteError,
  WRITE_UNAVAILABLE: 503,
} as const satisfies Readonly<Record<string, number>>;

function expectedWriteStatusCode(payload: SetReactionWriteResult): number | null {
  if (payload.decision === "require_approval") return null;
  if (payload.status === "succeeded") return 200;
  const code = payload.error?.code;
  if (!code || !Object.hasOwn(statusCodeByWriteError, code)) return null;
  return statusCodeByWriteError[code as keyof typeof statusCodeByWriteError];
}

function successCorrelates(
  result: NonNullable<SetReactionWriteResult["result"]>,
  request: SetReactionMcpRequest,
): boolean {
  const reactionIsActive = result.viewer_state.reactions.includes(request.reaction);
  return (
    result.content_id === request.content_id.normalize("NFC").toLowerCase() &&
    reactionIsActive === request.active
  );
}

function normalizeExecutionResult(
  statusCode: number,
  payload: SetReactionUpstreamResponse,
  request: SetReactionMcpRequest,
  expectedRequestId: string,
): McpToolExecutionResult {
  const write = SetReactionMcpWriteResultSchema.safeParse(payload);
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
    SET_REACTION_ERROR_STATUS,
  );
  return { isError: true, payload: asRecord(error) };
}

/** Sets one independent Reaction target state through the private MCP API. */
export function createSetReactionTool(
  internalApiClient: InternalMcpApiClient,
): McpToolRegistration {
  return {
    definition: {
      name: "set_reaction",
      title: "Set Reaction",
      description:
        "Set or unset Helpful, Agree, or Disagree on one AlphaNet content item. Reactions are independent social signals, not proof that a claim is correct; verify research independently.",
      inputSchema: SET_REACTION_INPUT_SCHEMA,
      annotations: {
        title: "Set Reaction",
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
      const request = SetReactionMcpRequestSchema.parse(argumentsValue);
      const response = await internalApiClient.request(
        {
          body: request,
          method: "POST",
          path: SET_REACTION_INTERNAL_API_PATH,
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
    successOutputSchema: SET_REACTION_SUCCESS_OUTPUT_SCHEMA,
  };
}
