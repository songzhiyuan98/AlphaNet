import {
  GetActionStatusRequestSchema,
  GetActionStatusResponseSchema,
  V1ErrorResponseSchema,
  type GetActionStatusRequest,
  type GetActionStatusResponse,
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

export const GET_ACTION_STATUS_INTERNAL_API_PATH_PREFIX = "/internal/mcp/v1/actions/";

const GetActionStatusUpstreamResponseSchema = z.union([
  GetActionStatusResponseSchema,
  V1ErrorResponseSchema,
]);

const GET_ACTION_STATUS_INPUT_SCHEMA = {
  type: "object",
  required: ["action_id"] as string[],
  properties: {
    action_id: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      pattern: "^[^\\s\\u0000-\\u001F\\u007F-\\u009F]+$",
    },
  },
  additionalProperties: false,
} as const;

const generatedSuccessOutputSchema = z.toJSONSchema(GetActionStatusResponseSchema);
if (generatedSuccessOutputSchema.type !== "object") {
  throw new TypeError("Action status JSON Schema must describe an object");
}
const GET_ACTION_STATUS_SUCCESS_OUTPUT_SCHEMA =
  generatedSuccessOutputSchema as McpToolRegistration["successOutputSchema"];

type GetActionStatusUpstreamResponse = GetActionStatusResponse | V1ErrorResponse;

function asRecord(value: GetActionStatusUpstreamResponse): Record<string, unknown> {
  return value;
}

function parseArguments(value: unknown): Record<string, unknown> {
  return GetActionStatusRequestSchema.parse(value);
}

function parseUpstreamResponse(value: unknown): GetActionStatusUpstreamResponse {
  return GetActionStatusUpstreamResponseSchema.parse(value);
}

function parseOutput(value: unknown): Record<string, unknown> {
  return asRecord(parseUpstreamResponse(value));
}

const ACTION_STATUS_ERROR_STATUS = {
  ...PRIVATE_MCP_BOUNDARY_ERROR_STATUS,
  ACTION_NOT_FOUND: 404,
  ACTION_STATUS_UNAVAILABLE: 503,
} as const satisfies Readonly<Record<string, number>>;

function normalizeExecutionResult(
  statusCode: number,
  payload: GetActionStatusUpstreamResponse,
  expectedActionId: string,
  expectedRequestId: string,
): McpToolExecutionResult {
  if (statusCode === 200) {
    const success = GetActionStatusResponseSchema.safeParse(payload);
    if (!success.success || success.data.action.id !== expectedActionId) {
      return invalidUpstreamResponse();
    }
    assertUpstreamRequestId(success.data.request_id, expectedRequestId);
    // The read succeeded even when the projected action itself is terminally
    // rejected, failed, expired, cancelled, or invalidated.
    return { payload: asRecord(success.data) };
  }

  const error = normalizeUpstreamV1Error(
    statusCode,
    payload,
    expectedRequestId,
    ACTION_STATUS_ERROR_STATUS,
  );
  return { isError: true, payload: asRecord(error) };
}

function internalPath(request: GetActionStatusRequest): string {
  return `${GET_ACTION_STATUS_INTERNAL_API_PATH_PREFIX}${encodeURIComponent(request.action_id)}`;
}

/** Reads the authenticated Agent's own durable PendingAction state. */
export function createGetActionStatusTool(
  internalApiClient: InternalMcpApiClient,
): McpToolRegistration {
  return {
    definition: {
      name: "get_action_status",
      title: "Get Action Status",
      description:
        "Read the approval, execution, and terminal result state of one AlphaNet action created by the authenticated Agent.",
      inputSchema: GET_ACTION_STATUS_INPUT_SCHEMA,
      annotations: {
        title: "Get Action Status",
        readOnlyHint: true,
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
      const request = GetActionStatusRequestSchema.parse(argumentsValue);
      const response = await internalApiClient.request(
        {
          method: "GET",
          path: internalPath(request),
          parseResponse: parseUpstreamResponse,
        },
        context,
      );
      return normalizeExecutionResult(
        response.statusCode,
        response.payload,
        request.action_id,
        context.requestId,
      );
    },
    parseArguments,
    parseOutput,
    successOutputSchema: GET_ACTION_STATUS_SUCCESS_OUTPUT_SCHEMA,
  };
}
