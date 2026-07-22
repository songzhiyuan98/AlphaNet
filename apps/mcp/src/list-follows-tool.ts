import {
  FollowListRequestSchema,
  FollowListResponseSchema,
  V1ErrorResponseSchema,
  type FollowListRequest,
  type FollowListResponse,
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

export const LIST_FOLLOWS_INTERNAL_API_PATH = "/internal/mcp/v1/follows/list";

const ListFollowsUpstreamResponseSchema = z.union([
  FollowListResponseSchema,
  V1ErrorResponseSchema,
]);

const generatedInputSchema = z.toJSONSchema(FollowListRequestSchema);
if (generatedInputSchema.type !== "object") {
  throw new TypeError("List Follows JSON Schema must describe an object");
}

const OPAQUE_CURSOR_JSON_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 4_096,
  pattern: "^[^\\s\\u0000-\\u001F\\u007F-\\u009F]+$",
} as const;

const generatedSuccessOutputSchema = z.toJSONSchema(FollowListResponseSchema);
if (generatedSuccessOutputSchema.type !== "object") {
  throw new TypeError("List Follows output JSON Schema must describe an object");
}

/** Shared Contracts parsing remains authoritative for cursor syntax and bounds. */
export const LIST_FOLLOWS_INPUT_SCHEMA = {
  ...generatedInputSchema,
  properties: {
    ...generatedInputSchema.properties,
    cursor: {
      anyOf: [OPAQUE_CURSOR_JSON_SCHEMA, { type: "null" }],
    },
  },
} as McpToolRegistration["definition"]["inputSchema"];

export const LIST_FOLLOWS_SUCCESS_OUTPUT_SCHEMA =
  generatedSuccessOutputSchema as McpToolRegistration["successOutputSchema"];

type ListFollowsUpstreamResponse = FollowListResponse | V1ErrorResponse;

function asRecord(value: ListFollowsUpstreamResponse): Record<string, unknown> {
  return value;
}

function parseArguments(value: unknown): Record<string, unknown> {
  return FollowListRequestSchema.parse(value);
}

function parseUpstreamResponse(value: unknown): ListFollowsUpstreamResponse {
  return ListFollowsUpstreamResponseSchema.parse(value);
}

function parseOutput(value: unknown): Record<string, unknown> {
  return asRecord(parseUpstreamResponse(value));
}

const LIST_FOLLOWS_ERROR_STATUS = {
  ...PRIVATE_MCP_BOUNDARY_ERROR_STATUS,
  AUTHORIZATION_CONTEXT_STALE: 401,
  CURSOR_EXPIRED: 410,
  CURSOR_INVALID: 400,
  FOLLOW_DATA_INVALID: 503,
  FOLLOW_NOT_READY: 503,
  INVALID_ARGUMENT: 400,
  SNAPSHOT_EXPIRED: 410,
} as const satisfies Readonly<Record<string, number>>;

function normalizeExecutionResult(
  statusCode: number,
  payload: ListFollowsUpstreamResponse,
  request: FollowListRequest,
  expectedRequestId: string,
): McpToolExecutionResult {
  if (statusCode === 200) {
    const success = FollowListResponseSchema.safeParse(payload);
    if (!success.success) return invalidUpstreamResponse();
    assertUpstreamRequestId(success.data.request_id, expectedRequestId);
    if (
      (request.limit !== undefined && success.data.page.limit !== request.limit) ||
      success.data.items.length > success.data.page.limit ||
      (request.target_type !== undefined &&
        success.data.items.some((follow) => follow.target_type !== request.target_type))
    ) {
      return invalidUpstreamResponse();
    }
    return { payload: asRecord(success.data) };
  }

  const error = normalizeUpstreamV1Error(
    statusCode,
    payload,
    expectedRequestId,
    LIST_FOLLOWS_ERROR_STATUS,
  );
  return { isError: true, payload: asRecord(error) };
}

/** Lists only the authenticated Agent's active Follow relationships. */
export function createListFollowsTool(
  internalApiClient: InternalMcpApiClient,
): McpToolRegistration {
  return {
    definition: {
      name: "list_follows",
      title: "List Follows",
      description:
        "List the current Agent's active actor, symbol, topic, and content follows for social-state synchronization. This does not expose other actors' followers or social graphs; targets that reference community content remain untrusted context.",
      inputSchema: LIST_FOLLOWS_INPUT_SCHEMA,
      annotations: {
        title: "List Follows",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execution: { taskSupport: "forbidden" },
    },
    execute: async (
      argumentsValue: Record<string, unknown>,
      context: McpToolExecutionContext,
    ) => {
      const request = FollowListRequestSchema.parse(argumentsValue);
      const response = await internalApiClient.request(
        {
          body: request,
          method: "POST",
          path: LIST_FOLLOWS_INTERNAL_API_PATH,
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
    successOutputSchema: LIST_FOLLOWS_SUCCESS_OUTPUT_SCHEMA,
  };
}
