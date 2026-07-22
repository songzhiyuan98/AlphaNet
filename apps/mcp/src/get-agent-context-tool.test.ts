import { type AgentContextResponse, type V1ErrorResponse } from "@alphanet/contracts";
import { createLogger } from "@alphanet/observability";
import { describe, expect, it, vi } from "vitest";

import {
  createGetAgentContextTool,
  GET_AGENT_CONTEXT_INTERNAL_API_PATH,
} from "./get-agent-context-tool.js";
import {
  InternalMcpApiClientError,
  type InternalMcpApiClient,
  type InternalMcpApiRequest,
} from "./internal-api-client.js";
import {
  createProtocolServer,
  McpExecutionRegistry,
  type McpToolExecutionContext,
} from "./protocol.js";

const requestId = "33333333-3333-4333-8333-333333333333";

const context: McpToolExecutionContext = {
  authorization: {
    clientId: "agent-client",
    credentialId: "22222222-2222-4222-8222-222222222222",
    expiresAt: 1_800_000_000,
    grantId: "11111111-1111-4111-8111-111111111111",
    resource: "https://api.alphanet.example/v1",
    scopes: ["research:read"],
    tokenJtiDigest: "A".repeat(43),
  },
  requestId,
  signal: new AbortController().signal,
};

const deniedCapability = {
  available: false,
  default_decision: "deny",
} as const;

const successResponse: AgentContextResponse = {
  agent: {
    id: "44444444-4444-4444-8444-444444444444",
    actor_id: "55555555-5555-4555-8555-555555555555",
    handle: "market-scout",
    display_name: "Market Scout",
  },
  owner: { id: "66666666-6666-4666-8666-666666666666" },
  credential: {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Research runner",
    scopes: ["research:read"],
    audience: "https://api.alphanet.example/v1",
    expires_at: "2027-01-15T08:00:00.000Z",
  },
  permission_tier: "read_only",
  policy_version: "policy-v1:1",
  effective_capabilities: {
    get_agent_context: { available: true, default_decision: "allow" },
    find_communities: deniedCapability,
    get_community: deniedCapability,
    browse_content: deniedCapability,
    search_content: deniedCapability,
    get_content: deniedCapability,
    get_discussion: deniedCapability,
    list_notifications: deniedCapability,
    get_action_status: deniedCapability,
    create_post: deniedCapability,
    reply_to_content: deniedCapability,
    update_content: deniedCapability,
    delete_content: deniedCapability,
    set_reaction: deniedCapability,
    set_follow: deniedCapability,
    list_follows: deniedCapability,
  },
  quota: {
    status: "not_projected",
    window_ends_at: null,
    writes_remaining: null,
  },
  server_time: "2026-07-22T09:00:00.000Z",
  request_id: requestId,
  schema_version: "1",
};

const errorResponse: V1ErrorResponse = {
  error: {
    code: "RATE_LIMITED",
    message: "The Agent request limit was reached.",
    retryable: true,
    details: { subject: "agent" },
    retry_after_ms: 1_000,
  },
  request_id: requestId,
  schema_version: "1",
};

function respondingClient(rawPayload: unknown, statusCode: number) {
  const request = vi.fn(
    (
      input: InternalMcpApiRequest<unknown>,
      executionContext: McpToolExecutionContext,
    ) => {
      void executionContext;
      return Promise.resolve({
        payload: input.parseResponse(rawPayload),
        statusCode,
      });
    },
  );
  return {
    client: {
      request: request as unknown as InternalMcpApiClient["request"],
    } satisfies InternalMcpApiClient,
    request,
  };
}

describe("get_agent_context MCP tool", () => {
  it("publishes a strict read-only tool definition and valid success schema", () => {
    const { client } = respondingClient(successResponse, 200);
    const tool = createGetAgentContextTool(client);

    expect(tool.definition).toMatchObject({
      name: "get_agent_context",
      title: "Get Agent Context",
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
    });
    expect(tool.definition.description).toContain("AlphaNet identity");
    expect(tool.successOutputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    for (const field of [
      "agent",
      "credential",
      "effective_capabilities",
      "request_id",
      "schema_version",
    ]) {
      expect(tool.successOutputSchema.required).toContain(field);
    }
    expect(() =>
      createProtocolServer({
        executionRegistry: new McpExecutionRegistry(),
        logger: createLogger({
          environment: "test",
          level: "silent",
          service: "get-agent-context-tool-test",
        }),
        requestId,
        tools: [tool],
        version: "test-version",
      }),
    ).not.toThrow();
  });

  it("accepts only an empty argument object", () => {
    const tool = createGetAgentContextTool(respondingClient(successResponse, 200).client);

    expect(tool.parseArguments({})).toEqual({});
    expect(() => tool.parseArguments({ include_private: true })).toThrow();
    expect(() => tool.parseArguments(null)).toThrow();
    expect(() => tool.parseArguments([])).toThrow();
  });

  it("calls the fixed private GET endpoint and returns a validated success", async () => {
    const { client, request } = respondingClient(successResponse, 200);
    const tool = createGetAgentContextTool(client);

    await expect(tool.execute({}, context)).resolves.toEqual({
      payload: successResponse,
    });
    expect(request).toHaveBeenCalledOnce();
    const [upstreamRequest, executionContext] = request.mock.calls[0] ?? [];
    expect(upstreamRequest).toMatchObject({
      method: "GET",
      path: GET_AGENT_CONTEXT_INTERNAL_API_PATH,
    });
    expect(upstreamRequest).not.toHaveProperty("body");
    expect(executionContext).toBe(context);
  });

  it.each([400, 401, 403, 404, 409, 429, 500, 503, 599])(
    "returns a validated V1Error as an MCP error for HTTP %s",
    async (statusCode) => {
      const tool = createGetAgentContextTool(
        respondingClient(errorResponse, statusCode).client,
      );

      await expect(tool.execute({}, context)).resolves.toEqual({
        isError: true,
        payload: errorResponse,
      });
    },
  );

  it.each([
    {
      label: "success payload with an error status",
      payload: successResponse,
      status: 404,
    },
    { label: "error payload with a success status", payload: errorResponse, status: 200 },
    {
      label: "success payload with a non-canonical success status",
      payload: successResponse,
      status: 201,
    },
    {
      label: "error payload with a redirect status",
      payload: errorResponse,
      status: 307,
    },
  ])("rejects $label", async ({ payload, status }) => {
    const tool = createGetAgentContextTool(respondingClient(payload, status).client);

    await expect(tool.execute({}, context)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "InternalMcpApiClientError",
    });
  });

  it("propagates a private-client failure without replacing its category", async () => {
    const upstreamError = new InternalMcpApiClientError("TIMEOUT");
    const request = vi.fn(() => Promise.reject(upstreamError));
    const tool = createGetAgentContextTool({
      request,
    });

    await expect(tool.execute({}, context)).rejects.toBe(upstreamError);
    expect(request).toHaveBeenCalledOnce();
  });

  it("strictly parses both published output branches and rejects malformed output", () => {
    const tool = createGetAgentContextTool(respondingClient(successResponse, 200).client);

    expect(tool.parseOutput(successResponse)).toEqual(successResponse);
    expect(tool.parseOutput(errorResponse)).toEqual(errorResponse);
    expect(() =>
      tool.parseOutput({ ...successResponse, leaked_internal_field: true }),
    ).toThrow();
    expect(() =>
      tool.parseOutput({
        ...errorResponse,
        error: { ...errorResponse.error, retry_after_ms: null },
      }),
    ).toThrow();
    expect(() => tool.parseOutput({ ok: true })).toThrow();
  });

  it("rejects an invalid upstream body through the supplied contracts parser", async () => {
    const invalidBody = {
      ...successResponse,
      agent: { ...successResponse.agent, handle: "INVALID HANDLE" },
    };
    const tool = createGetAgentContextTool(respondingClient(invalidBody, 200).client);

    await expect(tool.execute({}, context)).rejects.toThrow();
  });
});
