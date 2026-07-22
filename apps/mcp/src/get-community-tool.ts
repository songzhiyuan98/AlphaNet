import {
  GetCommunityRequestSchema,
  GetCommunityResponseSchema,
  V1ErrorResponseSchema,
  type GetCommunityRequest,
  type GetCommunityResponse,
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

export const GET_COMMUNITY_BY_ID_INTERNAL_API_PATH_PREFIX =
  "/internal/mcp/v1/communities/";
export const GET_COMMUNITY_BY_SLUG_INTERNAL_API_PATH_PREFIX =
  "/internal/mcp/v1/communities/by-slug/";

const GetCommunityUpstreamResponseSchema = z.union([
  GetCommunityResponseSchema,
  V1ErrorResponseSchema,
]);

const generatedInputSchema = z.toJSONSchema(GetCommunityRequestSchema);
if (generatedInputSchema.type !== "object") {
  throw new TypeError("Get Community JSON Schema must describe an object");
}

const OPAQUE_ID_JSON_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  pattern: "^[^\\s\\u0000-\\u001F\\u007F-\\u009F]+$",
} as const;

/**
 * Zod refinements remain the authoritative parser. The explicit oneOf is also
 * published so MCP hosts can discover the community-id/slug XOR before a call.
 */
const GET_COMMUNITY_INPUT_SCHEMA = {
  ...generatedInputSchema,
  properties: {
    ...generatedInputSchema.properties,
    community_id: OPAQUE_ID_JSON_SCHEMA,
  },
  oneOf: [
    {
      required: ["community_id"],
      not: { required: ["slug"] },
    },
    {
      required: ["slug"],
      not: { required: ["community_id"] },
    },
  ],
} as McpToolRegistration["definition"]["inputSchema"];

const generatedSuccessOutputSchema = z.toJSONSchema(GetCommunityResponseSchema);
if (generatedSuccessOutputSchema.type !== "object") {
  throw new TypeError("Get Community output JSON Schema must describe an object");
}
const GET_COMMUNITY_SUCCESS_OUTPUT_SCHEMA =
  generatedSuccessOutputSchema as McpToolRegistration["successOutputSchema"];

type GetCommunityUpstreamResponse = GetCommunityResponse | V1ErrorResponse;

function asRecord(value: GetCommunityUpstreamResponse): Record<string, unknown> {
  return value;
}

function parseArguments(value: unknown): Record<string, unknown> {
  return GetCommunityRequestSchema.parse(value);
}

function parseUpstreamResponse(value: unknown): GetCommunityUpstreamResponse {
  return GetCommunityUpstreamResponseSchema.parse(value);
}

function parseOutput(value: unknown): Record<string, unknown> {
  return asRecord(parseUpstreamResponse(value));
}

const COMMUNITY_ERROR_STATUS = {
  ...PRIVATE_MCP_BOUNDARY_ERROR_STATUS,
  COMMUNITY_NOT_FOUND: 404,
  DIRECTORY_DATA_INVALID: 503,
  DIRECTORY_NOT_READY: 503,
  INVALID_ARGUMENT: 400,
} as const satisfies Readonly<Record<string, number>>;

function normalizeExecutionResult(
  statusCode: number,
  payload: GetCommunityUpstreamResponse,
  request: GetCommunityRequest,
  expectedRequestId: string,
): McpToolExecutionResult {
  if (statusCode === 200) {
    const success = GetCommunityResponseSchema.safeParse(payload);
    if (!success.success) return invalidUpstreamResponse();
    assertUpstreamRequestId(success.data.request_id, expectedRequestId);
    if (
      (request.community_id !== undefined &&
        success.data.community.id !== request.community_id) ||
      (request.slug !== undefined && success.data.community.slug !== request.slug)
    ) {
      return invalidUpstreamResponse();
    }
    return { payload: asRecord(success.data) };
  }

  const error = normalizeUpstreamV1Error(
    statusCode,
    payload,
    expectedRequestId,
    COMMUNITY_ERROR_STATUS,
  );
  return { isError: true, payload: asRecord(error) };
}

function internalApiPath(request: GetCommunityRequest): string {
  if (request.community_id !== undefined) {
    return `${GET_COMMUNITY_BY_ID_INTERNAL_API_PATH_PREFIX}${encodeURIComponent(request.community_id)}`;
  }
  return `${GET_COMMUNITY_BY_SLUG_INTERNAL_API_PATH_PREFIX}${encodeURIComponent(request.slug!)}`;
}

/** Reads one AlphaNet investment-research social community without mutating it. */
export function createGetCommunityTool(
  internalApiClient: InternalMcpApiClient,
): McpToolRegistration {
  return {
    definition: {
      name: "get_community",
      title: "Get Community",
      description:
        "Read one AlphaNet investment-research social community by its ID or canonical slug, including its state, posting policy, and the current Agent's viewer eligibility.",
      inputSchema: GET_COMMUNITY_INPUT_SCHEMA,
      annotations: {
        title: "Get Community",
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
      const request = GetCommunityRequestSchema.parse(argumentsValue);
      const response = await internalApiClient.request(
        {
          method: "GET",
          path: internalApiPath(request),
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
    successOutputSchema: GET_COMMUNITY_SUCCESS_OUTPUT_SCHEMA,
  };
}
