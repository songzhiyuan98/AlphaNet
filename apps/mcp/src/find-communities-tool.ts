import {
  FindCommunitiesRequestSchema,
  FindCommunitiesResponseSchema,
  V1ErrorResponseSchema,
  type FindCommunitiesRequest,
  type FindCommunitiesResponse,
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

export const FIND_COMMUNITIES_INTERNAL_API_PATH = "/internal/mcp/v1/communities/search";

const FindCommunitiesUpstreamResponseSchema = z.union([
  FindCommunitiesResponseSchema,
  V1ErrorResponseSchema,
]);

const generatedInputSchema = z.toJSONSchema(FindCommunitiesRequestSchema);
if (generatedInputSchema.type !== "object") {
  throw new TypeError("Find Communities JSON Schema must describe an object");
}

const OPAQUE_CURSOR_JSON_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 4_096,
  pattern: "^[^\\s\\u0000-\\u001F\\u007F-\\u009F]+$",
} as const;

const SYMBOL_JSON_SCHEMA = {
  type: "string",
  maxLength: 15,
  pattern: "^[A-Z0-9][A-Z0-9.-]{0,14}$",
} as const;

const TOPIC_JSON_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 63,
  pattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$",
} as const;

/**
 * Shared Contracts parsing remains authoritative for Unicode budgets and
 * custom refinements. The explicit anyOf also lets MCP hosts discover that a
 * caller must provide search text or at least one structured filter.
 */
const FIND_COMMUNITIES_INPUT_SCHEMA = {
  ...generatedInputSchema,
  properties: {
    ...generatedInputSchema.properties,
    query: { type: "string", minLength: 1, maxLength: 2_000, pattern: "\\S" },
    proposed_title: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      pattern: "\\S",
    },
    proposed_summary: {
      type: "string",
      minLength: 1,
      maxLength: 4_000,
      pattern: "\\S",
    },
    states: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      items: {
        type: "string",
        enum: ["active", "read_only", "suspended", "archived"],
      },
    },
    symbols: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      uniqueItems: true,
      items: SYMBOL_JSON_SCHEMA,
    },
    topics: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
      items: TOPIC_JSON_SCHEMA,
    },
    cursor: {
      anyOf: [OPAQUE_CURSOR_JSON_SCHEMA, { type: "null" }],
    },
  },
  anyOf: [
    { required: ["query"] },
    { required: ["proposed_title"] },
    { required: ["proposed_summary"] },
    { required: ["states"] },
    { required: ["symbols"] },
    { required: ["topics"] },
  ],
} as McpToolRegistration["definition"]["inputSchema"];

const generatedSuccessOutputSchema = z.toJSONSchema(FindCommunitiesResponseSchema);
if (generatedSuccessOutputSchema.type !== "object") {
  throw new TypeError("Find Communities output JSON Schema must describe an object");
}
const FIND_COMMUNITIES_SUCCESS_OUTPUT_SCHEMA =
  generatedSuccessOutputSchema as McpToolRegistration["successOutputSchema"];

type FindCommunitiesUpstreamResponse = FindCommunitiesResponse | V1ErrorResponse;

function asRecord(value: FindCommunitiesUpstreamResponse): Record<string, unknown> {
  return value;
}

function parseArguments(value: unknown): Record<string, unknown> {
  return FindCommunitiesRequestSchema.parse(value);
}

function parseUpstreamResponse(value: unknown): FindCommunitiesUpstreamResponse {
  return FindCommunitiesUpstreamResponseSchema.parse(value);
}

function parseOutput(value: unknown): Record<string, unknown> {
  return asRecord(parseUpstreamResponse(value));
}

const FIND_COMMUNITIES_ERROR_STATUS = {
  ...PRIVATE_MCP_BOUNDARY_ERROR_STATUS,
  CURSOR_EXPIRED: 410,
  CURSOR_INVALID: 400,
  DIRECTORY_DATA_INVALID: 503,
  DIRECTORY_NOT_READY: 503,
  INVALID_ARGUMENT: 400,
  SNAPSHOT_EXPIRED: 410,
} as const satisfies Readonly<Record<string, number>>;

function normalizeExecutionResult(
  statusCode: number,
  payload: FindCommunitiesUpstreamResponse,
  request: FindCommunitiesRequest,
  expectedRequestId: string,
): McpToolExecutionResult {
  if (statusCode === 200) {
    const success = FindCommunitiesResponseSchema.safeParse(payload);
    if (!success.success) return invalidUpstreamResponse();
    assertUpstreamRequestId(success.data.request_id, expectedRequestId);
    const communityIds = success.data.items.map((item) => item.id);
    if (
      (request.limit !== undefined && success.data.page.limit !== request.limit) ||
      success.data.items.length > success.data.page.limit ||
      new Set(communityIds).size !== communityIds.length ||
      (request.states !== undefined &&
        success.data.items.some((item) => !request.states!.includes(item.state)))
    ) {
      return invalidUpstreamResponse();
    }
    return { payload: asRecord(success.data) };
  }

  const error = normalizeUpstreamV1Error(
    statusCode,
    payload,
    expectedRequestId,
    FIND_COMMUNITIES_ERROR_STATUS,
  );
  return { isError: true, payload: asRecord(error) };
}

/** Discovers visible AlphaNet research communities without selecting one. */
export function createFindCommunitiesTool(
  internalApiClient: InternalMcpApiClient,
): McpToolRegistration {
  return {
    definition: {
      name: "find_communities",
      title: "Find Communities",
      description:
        "Discover visible AlphaNet investment-research social communities from explicit search text or structured filters. Returned candidates are suggestions only; do not silently select a posting destination.",
      inputSchema: FIND_COMMUNITIES_INPUT_SCHEMA,
      annotations: {
        title: "Find Communities",
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
      const request = FindCommunitiesRequestSchema.parse(argumentsValue);
      const response = await internalApiClient.request(
        {
          body: request,
          method: "POST",
          path: FIND_COMMUNITIES_INTERNAL_API_PATH,
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
    successOutputSchema: FIND_COMMUNITIES_SUCCESS_OUTPUT_SCHEMA,
  };
}
