import { type GetActionStatusResponse, type V1ErrorResponse } from "@alphanet/contracts";
import { createLogger } from "@alphanet/observability";
import { describe, expect, it, vi } from "vitest";

import {
  createGetActionStatusTool,
  GET_ACTION_STATUS_INTERNAL_API_PATH_PREFIX,
} from "./get-action-status-tool.js";
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
const actionId = "70000000-0000-4000-8000-000000000001";
const context: McpToolExecutionContext = {
  authorization: {
    clientId: "agent-client",
    credentialId: "22222222-2222-4222-8222-222222222222",
    expiresAt: 1_800_000_000,
    grantId: "11111111-1111-4111-8111-111111111111",
    resource: "https://mcp.alphanet.example/mcp",
    scopes: ["actions:read"],
    tokenJtiDigest: "A".repeat(43),
  },
  requestId,
  signal: new AbortController().signal,
};

const pendingResponse: GetActionStatusResponse = {
  action: {
    id: actionId,
    operation: "create_post",
    decision: "require_approval",
    status: "pending_approval",
    state: "pending_approval",
    decision_id: "80000000-0000-4000-8000-000000000001",
    policy_version: "90000000-0000-4000-8000-000000000001:4",
    requested_at: "2026-07-22T12:00:00.000Z",
    expires_at: "2026-07-23T12:00:00.000Z",
    decided_at: null,
    executing_at: null,
    completed_at: null,
    terminal_at: null,
    input_digest: `sha256:${"a".repeat(64)}`,
    approval_summary: "Create one post in the Semiconductors community.",
    approval_outcome: null,
    approval_method: null,
    decided_by_owner_id: null,
    result: null,
    error: null,
  },
  request_id: requestId,
  schema_version: "1",
};

const rejectedResponse: GetActionStatusResponse = {
  action: {
    ...pendingResponse.action,
    status: "denied",
    state: "rejected",
    decided_at: "2026-07-22T12:01:00.000Z",
    terminal_at: "2026-07-22T12:01:00.000Z",
    approval_outcome: "rejected",
    approval_method: "owner_approval",
    decided_by_owner_id: "a0000000-0000-4000-8000-000000000001",
    error: {
      code: "ACTION_REJECTED",
      message: "The Owner rejected this action.",
      retryable: false,
      details: null,
      retry_after_ms: null,
    },
  },
  request_id: requestId,
  schema_version: "1",
};

const succeededResponse: GetActionStatusResponse = {
  action: {
    ...pendingResponse.action,
    operation: "create_post",
    status: "succeeded",
    state: "succeeded",
    decided_at: "2026-07-22T12:01:00.000Z",
    executing_at: "2026-07-22T12:01:30.000Z",
    completed_at: "2026-07-22T12:02:00.000Z",
    terminal_at: "2026-07-22T12:02:00.000Z",
    approval_outcome: "approved",
    approval_method: "owner_approval",
    decided_by_owner_id: "a0000000-0000-4000-8000-000000000001",
    result: {
      content_id: "50000000-0000-4000-8000-000000000002",
      revision_id: "60000000-0000-4000-8000-000000000001",
      resource_version: 1,
    },
  },
  request_id: requestId,
  schema_version: "1",
};

const errorResponse: V1ErrorResponse = {
  error: {
    code: "ACTION_NOT_FOUND",
    message: "The requested action was not found.",
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

describe("get_action_status MCP tool", () => {
  it("publishes a strict read-only definition and a valid success schema", () => {
    const tool = createGetActionStatusTool(respondingClient(pendingResponse, 200).client);

    expect(tool.definition).toMatchObject({
      name: "get_action_status",
      title: "Get Action Status",
      inputSchema: {
        type: "object",
        required: ["action_id"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execution: { taskSupport: "forbidden" },
    });
    expect(tool.successOutputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(tool.successOutputSchema.required).toContain("action");
    expect(() =>
      createProtocolServer({
        executionRegistry: new McpExecutionRegistry(),
        logger: createLogger({
          environment: "test",
          level: "silent",
          service: "get-action-status-tool-test",
        }),
        requestId,
        tools: [tool],
        version: "test-version",
      }),
    ).not.toThrow();
  });

  it("accepts only one Contracts action_id", () => {
    const tool = createGetActionStatusTool(respondingClient(pendingResponse, 200).client);

    expect(tool.parseArguments({ action_id: actionId })).toEqual({
      action_id: actionId,
    });
    expect(() =>
      tool.parseArguments({ action_id: actionId, owner_id: "forged" }),
    ).toThrow();
    expect(() => tool.parseArguments({ action_id: "bad id" })).toThrow();
    expect(() => tool.parseArguments({})).toThrow();
    expect(() => tool.parseArguments(null)).toThrow();
  });

  it("calls the fixed private GET path and percent-encodes the opaque ID", async () => {
    const reservedActionId = "action/with?reserved#characters";
    const reservedResponse: GetActionStatusResponse = {
      ...pendingResponse,
      action: { ...pendingResponse.action, id: reservedActionId },
    };
    const { client, request } = respondingClient(reservedResponse, 200);
    const tool = createGetActionStatusTool(client);

    await expect(tool.execute({ action_id: reservedActionId }, context)).resolves.toEqual(
      { payload: reservedResponse },
    );
    expect(request).toHaveBeenCalledOnce();
    const [upstreamRequest, executionContext] = request.mock.calls[0] ?? [];
    expect(upstreamRequest).toMatchObject({
      method: "GET",
      path: `${GET_ACTION_STATUS_INTERNAL_API_PATH_PREFIX}${encodeURIComponent(reservedActionId)}`,
    });
    expect(upstreamRequest).not.toHaveProperty("body");
    expect(executionContext).toBe(context);
  });

  it.each([
    ["pending approval", pendingResponse],
    ["terminal rejection", rejectedResponse],
    ["successful publication", succeededResponse],
  ])("returns %s as a successful status read", async (_label, payload) => {
    const tool = createGetActionStatusTool(respondingClient(payload, 200).client);

    await expect(tool.execute({ action_id: actionId }, context)).resolves.toEqual({
      payload,
    });
  });

  it.each([
    ["REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED", 401],
    ["POLICY_DENIED", 403],
    ["ACTION_NOT_FOUND", 404],
    ["RATE_LIMITED", 429],
    ["ACTION_STATUS_UNAVAILABLE", 503],
  ])("returns %s only with its exact HTTP %s status", async (code, statusCode) => {
    const payload: V1ErrorResponse = {
      ...errorResponse,
      error: {
        ...errorResponse.error,
        code,
        retryable: code === "RATE_LIMITED",
        retry_after_ms: code === "RATE_LIMITED" ? 1_000 : null,
      },
    };
    const tool = createGetActionStatusTool(respondingClient(payload, statusCode).client);

    await expect(tool.execute({ action_id: actionId }, context)).resolves.toEqual({
      isError: true,
      payload,
    });
  });

  it.each([
    {
      label: "status response with HTTP 201",
      payload: pendingResponse,
      statusCode: 201,
    },
    {
      label: "V1 error with HTTP 200",
      payload: errorResponse,
      statusCode: 200,
    },
    {
      label: "V1 error with redirect status",
      payload: errorResponse,
      statusCode: 307,
    },
    {
      label: "response for a different action ID",
      payload: {
        ...pendingResponse,
        action: { ...pendingResponse.action, id: "different-action" },
      },
      statusCode: 200,
    },
    {
      label: "known error code with the wrong HTTP status",
      payload: errorResponse,
      statusCode: 503,
    },
    {
      label: "unknown endpoint error code",
      payload: {
        ...errorResponse,
        error: { ...errorResponse.error, code: "ROUTE_NOT_FOUND" },
      },
      statusCode: 404,
    },
    {
      label: "success response with another request ID",
      payload: {
        ...pendingResponse,
        request_id: "44444444-4444-4444-8444-444444444444",
      },
      statusCode: 200,
    },
    {
      label: "error response with another request ID",
      payload: {
        ...errorResponse,
        request_id: "44444444-4444-4444-8444-444444444444",
      },
      statusCode: 404,
    },
  ])("rejects $label", async ({ payload, statusCode }) => {
    const tool = createGetActionStatusTool(respondingClient(payload, statusCode).client);

    await expect(tool.execute({ action_id: actionId }, context)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "InternalMcpApiClientError",
    });
  });

  it("strictly parses both output branches and rejects private fields", () => {
    const tool = createGetActionStatusTool(respondingClient(pendingResponse, 200).client);

    expect(tool.parseOutput(pendingResponse)).toEqual(pendingResponse);
    expect(tool.parseOutput(errorResponse)).toEqual(errorResponse);
    expect(() =>
      tool.parseOutput({
        ...pendingResponse,
        action: { ...pendingResponse.action, normalized_input: "private draft" },
      }),
    ).toThrow();
    expect(() =>
      tool.parseOutput({
        ...rejectedResponse,
        action: { ...rejectedResponse.action, terminal_at: null },
      }),
    ).toThrow();
    expect(() => tool.parseOutput({ action: null })).toThrow();
  });

  it("propagates private-client failures for protocol-level normalization", async () => {
    const upstreamError = new InternalMcpApiClientError("TIMEOUT");
    const request = vi.fn(() => Promise.reject(upstreamError));
    const tool = createGetActionStatusTool({ request });

    await expect(tool.execute({ action_id: actionId }, context)).rejects.toBe(
      upstreamError,
    );
    expect(request).toHaveBeenCalledOnce();
  });
});
