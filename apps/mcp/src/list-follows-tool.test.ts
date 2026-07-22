import {
  type FollowListRequest,
  type FollowListResponse,
  type V1ErrorResponse,
} from "@alphanet/contracts";
import { createLogger } from "@alphanet/observability";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import {
  createListFollowsTool,
  LIST_FOLLOWS_INPUT_SCHEMA,
  LIST_FOLLOWS_INTERNAL_API_PATH,
  LIST_FOLLOWS_SUCCESS_OUTPUT_SCHEMA,
} from "./list-follows-tool.js";
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

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  content: "20000000-0000-4000-8000-000000000001",
  followActor: "30000000-0000-4000-8000-000000000001",
  followContent: "30000000-0000-4000-8000-000000000002",
} as const;

const requestId = "33333333-3333-4333-8333-333333333333";
const context: McpToolExecutionContext = {
  authorization: {
    clientId: "agent-client",
    credentialId: "22222222-2222-4222-8222-222222222222",
    expiresAt: 1_800_000_000,
    grantId: "11111111-1111-4111-8111-111111111111",
    resource: "https://mcp.alphanet.example/mcp",
    scopes: ["research:read"],
    tokenJtiDigest: "A".repeat(43),
  },
  requestId,
  signal: new AbortController().signal,
};

const argumentsValue: FollowListRequest = {
  target_type: "actor",
  limit: 20,
  cursor: "flc_page_01",
};

const successResponse: FollowListResponse = {
  items: [
    {
      follow_id: ids.followContent,
      target_type: "content",
      target_id: ids.content,
      notification_level: "all_events",
      created_at: "2026-07-20T18:00:00.000Z",
      updated_at: "2026-07-21T19:00:00.000Z",
    },
    {
      follow_id: ids.followActor,
      target_type: "actor",
      target_id: ids.actor,
      notification_level: "new_posts",
      created_at: "2026-07-19T18:00:00.000Z",
      updated_at: "2026-07-21T18:00:00.000Z",
    },
  ],
  page: {
    next_cursor: null,
    has_more: false,
    limit: 20,
  },
  ordering: {
    snapshot_id: "fls_snapshot_01",
    ordering_version: "follow-list-v1",
    as_of: "2026-07-21T20:00:00.000Z",
  },
  request_id: requestId,
  schema_version: "1",
};

const filteredSuccessResponse: FollowListResponse = {
  ...successResponse,
  items: [successResponse.items[1]!],
};

const errorResponse: V1ErrorResponse = {
  error: {
    code: "CURSOR_INVALID",
    message: "The Follow list cursor is invalid.",
    retryable: false,
    details: null,
    retry_after_ms: null,
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

describe("list_follows MCP tool", () => {
  it("publishes strict Contracts schemas and read-only MCP metadata", () => {
    const tool = createListFollowsTool(
      respondingClient(filteredSuccessResponse, 200).client,
    );
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validateInput = ajv.compile(tool.definition.inputSchema);
    const validateOutput = ajv.compile(tool.successOutputSchema);
    const serializedSchemas = JSON.stringify({
      input: LIST_FOLLOWS_INPUT_SCHEMA,
      output: LIST_FOLLOWS_SUCCESS_OUTPUT_SCHEMA,
    });

    expect(tool.definition).toMatchObject({
      name: "list_follows",
      title: "List Follows",
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      annotations: {
        title: "List Follows",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execution: { taskSupport: "forbidden" },
    });
    expect(tool.definition.description).toMatch(/current Agent/iu);
    expect(tool.definition.description).toMatch(/not.*followers/iu);
    expect(validateInput({})).toBe(true);
    expect(validateInput(argumentsValue)).toBe(true);
    expect(validateInput({ target_type: "content", limit: 100, cursor: null })).toBe(
      true,
    );
    expect(validateInput({ target_type: "community" })).toBe(false);
    expect(validateInput({ limit: 101 })).toBe(false);
    expect(validateInput({ cursor: "bad cursor" })).toBe(false);
    expect(validateInput({ cursor: "x".repeat(4_097) })).toBe(false);
    expect(validateInput({ follower_actor_id: ids.actor })).toBe(false);
    expect(validateOutput(successResponse)).toBe(true);
    expect(serializedSchemas).not.toContain('"$ref"');
    expect(serializedSchemas).not.toContain('"$defs"');
    expect(() =>
      createProtocolServer({
        executionRegistry: new McpExecutionRegistry(),
        logger: createLogger({
          environment: "test",
          level: "silent",
          service: "list-follows-tool-test",
        }),
        requestId,
        tools: [tool],
        version: "test-version",
      }),
    ).not.toThrow();
  });

  it("uses the shared Contracts parser as the authority for arguments", () => {
    const tool = createListFollowsTool(
      respondingClient(filteredSuccessResponse, 200).client,
    );

    expect(tool.parseArguments({})).toEqual({});
    expect(tool.parseArguments(argumentsValue)).toEqual(argumentsValue);
    for (const invalid of [
      { target_type: "community" },
      { limit: 0 },
      { limit: 101 },
      { cursor: "bad cursor" },
      { follower_actor_id: ids.actor },
      null,
      [],
    ]) {
      expect(() => tool.parseArguments(invalid)).toThrow();
    }
  });

  it.each([
    { label: "omitted cursor", requestBody: {}, response: successResponse },
    {
      label: "explicit null cursor",
      requestBody: { cursor: null },
      response: successResponse,
    },
    {
      label: "opaque cursor with filters",
      requestBody: argumentsValue,
      response: filteredSuccessResponse,
    },
  ])(
    "POSTs the complete parsed body with $label to the fixed private endpoint",
    async ({ requestBody, response }) => {
      const { client, request } = respondingClient(response, 200);
      const tool = createListFollowsTool(client);

      await expect(tool.execute(requestBody, context)).resolves.toEqual({
        payload: response,
      });
      expect(request).toHaveBeenCalledOnce();
      const [upstreamRequest, executionContext] = request.mock.calls[0] ?? [];
      expect(upstreamRequest).toBeDefined();
      if (upstreamRequest === undefined) throw new Error("Missing upstream request");
      expect(upstreamRequest).toEqual({
        body: requestBody,
        method: "POST",
        path: LIST_FOLLOWS_INTERNAL_API_PATH,
        parseResponse: upstreamRequest.parseResponse,
      });
      expect(typeof upstreamRequest.parseResponse).toBe("function");
      expect(executionContext).toBe(context);
    },
  );

  it.each([
    ["INVALID_ARGUMENT", 400],
    ["AUTHORIZATION_CONTEXT_STALE", 401],
    ["REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED", 401],
    ["REMOTE_MCP_TRANSPORT_AUTHENTICATION_FAILED", 401],
    ["POLICY_DENIED", 403],
    ["SCOPE_REQUIRED", 403],
    ["CURSOR_INVALID", 400],
    ["CURSOR_EXPIRED", 410],
    ["SNAPSHOT_EXPIRED", 410],
    ["RATE_LIMITED", 429],
    ["FOLLOW_DATA_INVALID", 503],
    ["FOLLOW_NOT_READY", 503],
    ["REMOTE_MCP_ACTOR_AUTHENTICATION_UNAVAILABLE", 503],
    ["REMOTE_MCP_TRANSPORT_AUTHENTICATION_UNAVAILABLE", 503],
    ["TEMPORARILY_UNAVAILABLE", 503],
  ])("returns %s only with its exact HTTP %s status", async (code, statusCode) => {
    const payload: V1ErrorResponse = {
      ...errorResponse,
      error: {
        ...errorResponse.error,
        code,
        retryable: statusCode === 429 || statusCode === 503,
        retry_after_ms: code === "RATE_LIMITED" ? 1_000 : null,
      },
    };
    const tool = createListFollowsTool(respondingClient(payload, statusCode).client);

    await expect(tool.execute({}, context)).resolves.toEqual({
      isError: true,
      payload,
    });
  });

  it.each([
    {
      label: "success payload with an error status",
      payload: successResponse,
      status: 400,
    },
    {
      label: "error payload with success status",
      payload: errorResponse,
      status: 200,
    },
    {
      label: "success payload with HTTP 201",
      payload: successResponse,
      status: 201,
    },
    {
      label: "error payload with a redirect status",
      payload: errorResponse,
      status: 307,
    },
    {
      label: "known error code with the wrong HTTP status",
      payload: errorResponse,
      status: 410,
    },
    {
      label: "an error outside the operation allowlist",
      payload: {
        ...errorResponse,
        error: { ...errorResponse.error, code: "TARGET_NOT_FOUND" },
      },
      status: 404,
    },
    {
      label: "success with a different requested page limit",
      payload: {
        ...filteredSuccessResponse,
        page: { ...filteredSuccessResponse.page, limit: 10 },
      },
      status: 200,
    },
    {
      label: "success outside the requested target type",
      payload: successResponse,
      status: 200,
    },
    {
      label: "success response with another request ID",
      payload: {
        ...filteredSuccessResponse,
        request_id: "44444444-4444-4444-8444-444444444444",
      },
      status: 200,
    },
    {
      label: "error response with another request ID",
      payload: {
        ...errorResponse,
        request_id: "44444444-4444-4444-8444-444444444444",
      },
      status: 400,
    },
  ])("rejects $label", async ({ payload, status }) => {
    const tool = createListFollowsTool(respondingClient(payload, status).client);

    await expect(tool.execute(argumentsValue, context)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "InternalMcpApiClientError",
    });
  });

  it("rejects an oversized page even when the Contracts payload is otherwise valid", async () => {
    const payload: FollowListResponse = {
      ...successResponse,
      page: { ...successResponse.page, limit: 1 },
    };
    const tool = createListFollowsTool(respondingClient(payload, 200).client);

    await expect(tool.execute({}, context)).rejects.toThrow();
  });

  it("propagates private-client failures without replacing their category", async () => {
    const upstreamError = new InternalMcpApiClientError("TIMEOUT");
    const request = vi.fn(() => Promise.reject(upstreamError));
    const tool = createListFollowsTool({ request });

    await expect(tool.execute({}, context)).rejects.toBe(upstreamError);
  });

  it("strictly parses success/error output and rejects leaked fields", () => {
    const tool = createListFollowsTool(
      respondingClient(filteredSuccessResponse, 200).client,
    );

    expect(tool.parseOutput(filteredSuccessResponse)).toEqual(filteredSuccessResponse);
    expect(tool.parseOutput(errorResponse)).toEqual(errorResponse);
    expect(() =>
      tool.parseOutput({ ...filteredSuccessResponse, follower_actor_id: ids.actor }),
    ).toThrow();
    expect(() => tool.parseOutput({ ok: true })).toThrow();
  });

  it("rejects malformed upstream projections through the Contracts parser", async () => {
    const invalid = {
      ...filteredSuccessResponse,
      ordering: {
        ...filteredSuccessResponse.ordering,
        ordering_version: "follow-list-v2",
      },
    };
    const tool = createListFollowsTool(respondingClient(invalid, 200).client);

    await expect(tool.execute(argumentsValue, context)).rejects.toThrow();
  });
});
