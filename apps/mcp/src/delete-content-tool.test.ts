import {
  type DeleteContentRequest,
  type DeleteContentWriteResult,
  type V1ErrorResponse,
} from "@alphanet/contracts";
import { createLogger } from "@alphanet/observability";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import {
  createDeleteContentTool,
  DELETE_CONTENT_INPUT_SCHEMA,
  DELETE_CONTENT_INTERNAL_API_PATH,
  DELETE_CONTENT_SUCCESS_OUTPUT_SCHEMA,
} from "./delete-content-tool.js";
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
const contentId = "50000000-0000-4000-8000-000000000001";
const context: McpToolExecutionContext = {
  authorization: {
    clientId: "agent-client",
    credentialId: "22222222-2222-4222-8222-222222222222",
    expiresAt: 1_800_000_000,
    grantId: "11111111-1111-4111-8111-111111111111",
    resource: "https://mcp.alphanet.example/mcp",
    scopes: ["content:write"],
    tokenJtiDigest: "A".repeat(43),
  },
  requestId,
  signal: new AbortController().signal,
};

const argumentsValue: DeleteContentRequest = {
  content_id: contentId,
  expected_version: 4,
  mode: "soft",
  reason: "The author is retracting a superseded research claim.",
  idempotency_key: "delete-amd-scenarios-20260722-v1",
};

const successResponse: DeleteContentWriteResult = {
  decision: "allow",
  status: "succeeded",
  result: {
    content_id: contentId,
    lifecycle_state: "deleted",
    resource_version: 5,
  },
  pending_action: null,
  error: null,
  request_id: requestId,
  schema_version: "1",
};

const pendingResponse: DeleteContentWriteResult = {
  decision: "require_approval",
  status: "pending_approval",
  result: null,
  pending_action: {
    id: "70000000-0000-4000-8000-000000000001",
    operation: "delete_content",
    state: "pending_approval",
    expires_at: "2026-07-23T12:00:00.000Z",
    input_digest: `sha256:${"a".repeat(64)}`,
    requested_at: "2026-07-22T12:00:00.000Z",
    decision_id: "80000000-0000-4000-8000-000000000001",
    policy_version: "90000000-0000-4000-8000-000000000001:4",
    approval_summary: "Delete one AlphaNet research post.",
    expected_version: 4,
  },
  error: null,
  request_id: requestId,
  schema_version: "1",
};

const approvedSuccessResponse: DeleteContentWriteResult = {
  ...successResponse,
  decision: "require_approval",
  pending_action: {
    ...pendingResponse.pending_action!,
    state: "succeeded",
  },
};

const policyDeniedResponse: DeleteContentWriteResult = {
  decision: "deny",
  status: "denied",
  result: null,
  pending_action: null,
  error: {
    code: "POLICY_DENIED",
    message: "The Agent policy does not permit this operation.",
    retryable: false,
    details: { reason: "POLICY_DENIED" },
    retry_after_ms: null,
  },
  request_id: requestId,
  schema_version: "1",
};

const approvalRejectedResponse: DeleteContentWriteResult = {
  ...pendingResponse,
  status: "denied",
  pending_action: { ...pendingResponse.pending_action!, state: "rejected" },
  error: {
    code: "ACTION_REJECTED",
    message: "The Owner rejected this action.",
    retryable: false,
    details: null,
    retry_after_ms: null,
  },
};

const failedResponse: DeleteContentWriteResult = {
  decision: "allow",
  status: "failed",
  result: null,
  pending_action: null,
  error: {
    code: "VERSION_CONFLICT",
    message: "The content changed after it was read.",
    retryable: false,
    details: { content_id: contentId, expected_version: 4 },
    retry_after_ms: null,
  },
  request_id: requestId,
  schema_version: "1",
};

const rateLimitedResponse: DeleteContentWriteResult = {
  decision: "deny",
  status: "denied",
  result: null,
  pending_action: null,
  error: {
    code: "RATE_LIMITED",
    message: "The content deletion limit has been reached.",
    retryable: true,
    details: { content_id: contentId },
    retry_after_ms: 75_000,
  },
  request_id: requestId,
  schema_version: "1",
};

const v1ErrorResponse: V1ErrorResponse = {
  error: {
    code: "WRITE_UNAVAILABLE",
    message: "The research write service is temporarily unavailable.",
    retryable: true,
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

describe("delete_content MCP tool", () => {
  it("publishes strict wire-safe schemas, UGC guidance, and destructive metadata", () => {
    const tool = createDeleteContentTool(respondingClient(successResponse, 200).client);
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validateInput = ajv.compile(tool.definition.inputSchema);
    const validateOutput = ajv.compile(tool.successOutputSchema);
    const serializedSchemas = JSON.stringify({
      input: DELETE_CONTENT_INPUT_SCHEMA,
      output: DELETE_CONTENT_SUCCESS_OUTPUT_SCHEMA,
    });

    expect(tool.definition).toMatchObject({
      name: "delete_content",
      title: "Delete Content",
      inputSchema: { type: "object", additionalProperties: false },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      execution: { taskSupport: "forbidden" },
    });
    expect(tool.definition.description).toMatch(/untrusted/iu);
    expect(DELETE_CONTENT_INPUT_SCHEMA.required).toEqual([
      "content_id",
      "expected_version",
      "mode",
      "idempotency_key",
    ]);
    expect(validateInput(argumentsValue)).toBe(true);
    for (const payload of [
      successResponse,
      pendingResponse,
      approvedSuccessResponse,
      policyDeniedResponse,
      approvalRejectedResponse,
      failedResponse,
      rateLimitedResponse,
    ]) {
      expect(validateOutput(payload)).toBe(true);
    }
    expect(validateInput({ ...argumentsValue, expected_version: 0 })).toBe(false);
    expect(validateInput({ ...argumentsValue, mode: "hard" })).toBe(false);
    expect(validateInput({ ...argumentsValue, reason: " untrimmed" })).toBe(false);
    expect(validateInput({ ...argumentsValue, idempotency_key: "has,comma" })).toBe(
      false,
    );
    expect(serializedSchemas).not.toContain('"$ref"');
    expect(serializedSchemas).not.toContain('"$defs"');
    expect(() =>
      createProtocolServer({
        executionRegistry: new McpExecutionRegistry(),
        logger: createLogger({
          environment: "test",
          level: "silent",
          service: "delete-content-tool-test",
        }),
        requestId,
        tools: [tool],
        version: "test-version",
      }),
    ).not.toThrow();
  });

  it("uses the authoritative Contracts parser for the complete strict command", () => {
    const tool = createDeleteContentTool(respondingClient(successResponse, 200).client);

    expect(tool.parseArguments(argumentsValue)).toEqual(argumentsValue);
    for (const invalid of [
      {},
      { ...argumentsValue, actor_id: "forged" },
      { ...argumentsValue, content_id: "contains whitespace" },
      { ...argumentsValue, expected_version: 0 },
      { ...argumentsValue, expected_version: Number.MAX_SAFE_INTEGER + 1 },
      { ...argumentsValue, mode: "hard" },
      { ...argumentsValue, reason: " untrimmed" },
      { ...argumentsValue, idempotency_key: "has,comma" },
      null,
      [],
    ]) {
      expect(() => tool.parseArguments(invalid)).toThrow();
    }
  });

  it("POSTs the complete parsed body to the fixed private endpoint", async () => {
    const { client, request } = respondingClient(successResponse, 200);
    const tool = createDeleteContentTool(client);

    await expect(tool.execute(argumentsValue, context)).resolves.toEqual({
      payload: successResponse,
    });
    expect(request).toHaveBeenCalledOnce();
    const [upstreamRequest, executionContext] = request.mock.calls[0] ?? [];
    if (upstreamRequest === undefined) throw new Error("Missing upstream request");
    expect(upstreamRequest).toEqual({
      body: argumentsValue,
      method: "POST",
      path: DELETE_CONTENT_INTERNAL_API_PATH,
      parseResponse: upstreamRequest.parseResponse,
    });
    expect(typeof upstreamRequest.parseResponse).toBe("function");
    expect(executionContext).toBe(context);
  });

  it("correlates an uppercase UUID request with the canonical lowercase result", async () => {
    const uppercaseContentId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const request = { ...argumentsValue, content_id: uppercaseContentId };
    const response: DeleteContentWriteResult = {
      ...successResponse,
      result: {
        ...successResponse.result!,
        content_id: uppercaseContentId.toLowerCase(),
      },
    };
    const tool = createDeleteContentTool(respondingClient(response, 200).client);

    await expect(tool.execute(request, context)).resolves.toEqual({
      payload: response,
    });
  });

  it.each([
    ["autonomous success", successResponse, 200, false],
    ["assisted pending approval", pendingResponse, 202, false],
    ["approved success replay", approvedSuccessResponse, 200, false],
    ["stable policy denial", policyDeniedResponse, 403, false],
    ["terminal Owner rejection replay", approvalRejectedResponse, 409, false],
    ["version failure", failedResponse, 409, true],
    ["authoritative write rate limit", rateLimitedResponse, 429, true],
  ])(
    "maps %s without losing the delete envelope",
    async (_label, payload, statusCode, isError) => {
      const tool = createDeleteContentTool(respondingClient(payload, statusCode).client);
      await expect(tool.execute(argumentsValue, context)).resolves.toEqual({
        ...(isError ? { isError: true } : {}),
        payload,
      });
    },
  );

  it.each([
    ["REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED", 401],
    ["REMOTE_MCP_ACTOR_AUTHENTICATION_UNAVAILABLE", 503],
    ["REMOTE_MCP_TRANSPORT_AUTHENTICATION_FAILED", 401],
    ["REMOTE_MCP_TRANSPORT_AUTHENTICATION_UNAVAILABLE", 503],
    ["AUTHORIZATION_CONTEXT_STALE", 401],
    ["SCOPE_REQUIRED", 403],
    ["POLICY_DENIED", 403],
    ["COMMUNITY_RESTRICTED", 403],
    ["NOT_CONTENT_AUTHOR", 403],
    ["REPLIES_CLOSED", 403],
    ["COMMUNITY_NOT_FOUND", 404],
    ["CONTENT_NOT_FOUND", 404],
    ["ACTION_CANCELLED", 409],
    ["ACTION_EXECUTION_FAILED", 409],
    ["ACTION_EXPIRED", 409],
    ["ACTION_INVALIDATED", 409],
    ["ACTION_REJECTED", 409],
    ["DUPLICATE_CONTENT", 409],
    ["IDEMPOTENCY_CONFLICT", 409],
    ["IDEMPOTENCY_IN_PROGRESS", 409],
    ["VERSION_CONFLICT", 409],
    ["VALIDATION_ERROR", 422],
    ["RATE_LIMITED", 429],
    ["IDEMPOTENCY_RESULT_CORRUPT", 503],
    ["TEMPORARILY_UNAVAILABLE", 503],
    ["WRITE_UNAVAILABLE", 503],
  ])("allows %s only with exact HTTP %s", async (code, statusCode) => {
    const payload: V1ErrorResponse = {
      ...v1ErrorResponse,
      error: {
        ...v1ErrorResponse.error,
        code,
        retryable: statusCode === 429 || statusCode === 503,
        retry_after_ms: statusCode === 429 ? 1_000 : null,
      },
    };
    const tool = createDeleteContentTool(respondingClient(payload, statusCode).client);
    await expect(tool.execute(argumentsValue, context)).resolves.toEqual({
      isError: true,
      payload,
    });
  });

  it.each([
    ["success with HTTP 201", successResponse, 201],
    ["pending approval with HTTP 200", pendingResponse, 200],
    ["policy denial with HTTP 422", policyDeniedResponse, 422],
    ["failed result with HTTP 503", failedResponse, 503],
    [
      "success targeting another content",
      {
        ...successResponse,
        result: {
          ...successResponse.result!,
          content_id: "50000000-0000-4000-8000-000000000099",
        },
      },
      200,
    ],
    [
      "success skipping the expected version",
      {
        ...successResponse,
        result: { ...successResponse.result!, resource_version: 6 },
      },
      200,
    ],
    [
      "pending approval for another version",
      {
        ...pendingResponse,
        pending_action: { ...pendingResponse.pending_action!, expected_version: 3 },
      },
      202,
    ],
    [
      "write result with another request ID",
      { ...successResponse, request_id: "44444444-4444-4444-8444-444444444444" },
      200,
    ],
    ["V1 error with the wrong HTTP status", v1ErrorResponse, 404],
    [
      "unknown endpoint V1 error code",
      {
        ...v1ErrorResponse,
        error: { ...v1ErrorResponse.error, code: "ROUTE_NOT_FOUND" },
      },
      404,
    ],
    [
      "V1 error with another request ID",
      { ...v1ErrorResponse, request_id: "44444444-4444-4444-8444-444444444444" },
      503,
    ],
  ])("fails closed for %s", async (_label, payload, statusCode) => {
    const tool = createDeleteContentTool(respondingClient(payload, statusCode).client);
    await expect(tool.execute(argumentsValue, context)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "InternalMcpApiClientError",
    });
  });

  it("strictly parses output branches and rejects malformed payloads", () => {
    const tool = createDeleteContentTool(respondingClient(successResponse, 200).client);

    expect(tool.parseOutput(successResponse)).toEqual(successResponse);
    expect(tool.parseOutput(v1ErrorResponse)).toEqual(v1ErrorResponse);
    expect(() =>
      tool.parseOutput({ ...successResponse, internal_replayed: true }),
    ).toThrow();
    expect(() =>
      tool.parseOutput({ ...successResponse, status: "succeeded", result: null }),
    ).toThrow();
    expect(() =>
      tool.parseOutput({
        ...pendingResponse,
        pending_action: {
          ...pendingResponse.pending_action!,
          operation: "update_content",
        },
      }),
    ).toThrow();
    expect(() => tool.parseOutput({ ok: true })).toThrow();
  });

  it("rejects malformed upstream payloads before normalization", async () => {
    const tool = createDeleteContentTool(
      respondingClient({ ...successResponse, debug: true }, 200).client,
    );
    await expect(tool.execute(argumentsValue, context)).rejects.toThrow();
  });

  it("propagates private-client failures for protocol normalization", async () => {
    const upstreamError = new InternalMcpApiClientError("TIMEOUT");
    const request = vi.fn(() => Promise.reject(upstreamError));
    const tool = createDeleteContentTool({ request });

    await expect(tool.execute(argumentsValue, context)).rejects.toBe(upstreamError);
    expect(request).toHaveBeenCalledOnce();
  });
});
