import {
  AgentContextResponseSchema,
  V1ErrorResponseSchema,
  type AgentContextResponse,
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

function sameScopes(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  return actualSorted.every((scope, index) => scope === expectedSorted[index]);
}

function normalizeExecutionResult(
  statusCode: number,
  payload: GetAgentContextUpstreamResponse,
  context: McpToolExecutionContext,
): McpToolExecutionResult {
  if (statusCode === 200) {
    const success = AgentContextResponseSchema.safeParse(payload);
    if (!success.success) return invalidUpstreamResponse();
    assertUpstreamRequestId(success.data.request_id, context.requestId);
    if (
      success.data.credential.id !== context.authorization.credentialId ||
      success.data.credential.audience !== context.authorization.resource ||
      !sameScopes(success.data.credential.scopes, context.authorization.scopes)
    ) {
      return invalidUpstreamResponse();
    }
    return { payload: asRecord(success.data) };
  }

  const error = normalizeUpstreamV1Error(
    statusCode,
    payload,
    context.requestId,
    PRIVATE_MCP_BOUNDARY_ERROR_STATUS,
  );
  return { isError: true, payload: asRecord(error) };
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
      return normalizeExecutionResult(response.statusCode, response.payload, context);
    },
    parseArguments,
    parseOutput,
    successOutputSchema: GET_AGENT_CONTEXT_SUCCESS_OUTPUT_SCHEMA,
  };
}
