import {
  AgentContextResponseSchema,
  V1ErrorResponseSchema,
  type AgentContextResponse,
  type V1ErrorResponse,
} from "@alphanet/contracts";
import { z } from "zod";

import {
  InternalMcpApiClientError,
  type InternalMcpApiClient,
} from "./internal-api-client.js";
import type {
  McpToolExecutionContext,
  McpToolExecutionResult,
  McpToolRegistration,
} from "./protocol.js";

export const GET_AGENT_CONTEXT_INTERNAL_API_PATH = "/internal/mcp/v1/agent/context";

const GetAgentContextArgumentsSchema = z.object({}).strict();
const GetAgentContextUpstreamResponseSchema = z.union([
  AgentContextResponseSchema,
  V1ErrorResponseSchema,
]);

const generatedSuccessOutputSchema = z.toJSONSchema(AgentContextResponseSchema);
if (generatedSuccessOutputSchema.type !== "object") {
  throw new TypeError("Agent context JSON Schema must describe an object");
}
const GET_AGENT_CONTEXT_SUCCESS_OUTPUT_SCHEMA =
  generatedSuccessOutputSchema as McpToolRegistration["successOutputSchema"];

type GetAgentContextUpstreamResponse = AgentContextResponse | V1ErrorResponse;

function asRecord(value: GetAgentContextUpstreamResponse): Record<string, unknown> {
  return value;
}

function parseArguments(value: unknown): Record<string, unknown> {
  return GetAgentContextArgumentsSchema.parse(value);
}

function parseUpstreamResponse(value: unknown): GetAgentContextUpstreamResponse {
  return GetAgentContextUpstreamResponseSchema.parse(value);
}

function parseOutput(value: unknown): Record<string, unknown> {
  return asRecord(parseUpstreamResponse(value));
}

function invalidUpstreamResponse(): never {
  throw new InternalMcpApiClientError("INVALID_RESPONSE");
}

function normalizeExecutionResult(
  statusCode: number,
  payload: GetAgentContextUpstreamResponse,
): McpToolExecutionResult {
  if (statusCode === 200) {
    const success = AgentContextResponseSchema.safeParse(payload);
    if (!success.success) return invalidUpstreamResponse();
    return { payload: asRecord(success.data) };
  }

  if (statusCode >= 400 && statusCode <= 599) {
    const error = V1ErrorResponseSchema.safeParse(payload);
    if (!error.success) return invalidUpstreamResponse();
    return { isError: true, payload: asRecord(error.data) };
  }

  return invalidUpstreamResponse();
}

/**
 * Returns the authenticated Agent's authoritative platform identity and
 * effective permissions through the private MCP-to-API boundary.
 */
export function createGetAgentContextTool(
  internalApiClient: InternalMcpApiClient,
): McpToolRegistration {
  return {
    definition: {
      name: "get_agent_context",
      title: "Get Agent Context",
      description:
        "Get the authenticated Agent's AlphaNet identity, credential scope, effective capabilities, policy tier, and current quota context.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        title: "Get Agent Context",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execution: { taskSupport: "forbidden" },
    },
    execute: async (
      _argumentsValue: Record<string, unknown>,
      context: McpToolExecutionContext,
    ) => {
      const response = await internalApiClient.request(
        {
          method: "GET",
          path: GET_AGENT_CONTEXT_INTERNAL_API_PATH,
          parseResponse: parseUpstreamResponse,
        },
        context,
      );
      return normalizeExecutionResult(response.statusCode, response.payload);
    },
    parseArguments,
    parseOutput,
    successOutputSchema: GET_AGENT_CONTEXT_SUCCESS_OUTPUT_SCHEMA,
  };
}
