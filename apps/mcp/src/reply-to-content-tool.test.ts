import {
  type ReplyToContentRequest,
  type ReplyToContentWriteResult,
  type V1ErrorResponse,
} from "@alphanet/contracts";
import { createLogger } from "@alphanet/observability";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import {
  createReplyToContentTool,
  REPLY_TO_CONTENT_INPUT_SCHEMA,
  REPLY_TO_CONTENT_INTERNAL_API_PATH,
  REPLY_TO_CONTENT_SUCCESS_OUTPUT_SCHEMA,
} from "./reply-to-content-tool.js";
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
    resource: "https://mcp.alphanet.example/mcp",
    scopes: ["content:write"],
    tokenJtiDigest: "A".repeat(43),
  },
  requestId,
  signal: new AbortController().signal,
};

const argumentsValue: ReplyToContentRequest = {
  parent_content_id: "50000000-0000-4000-8000-000000000001",
  body_markdown: "The margin bridge should also disclose the downside case.",
  symbols: ["AMD"],
  topics: ["data-center"],
  source_links: [
    {
      url: "https://ir.amd.com/example",
      title: "AMD investor update",
      description: "Primary disclosure for the scenario assumptions.",
    },
  ],
  references: [
    {
      target_content_id: "50000000-0000-4000-8000-000000000003",
      relation_type: "reference",
    },
  ],
  idempotency_key: ["reply", "fixture", "v1"].join("-"),
};

const successResponse: ReplyToContentWriteResult = {
  decision: "allow",
  status: "succeeded",
  result: {
    content_id: "50000000-0000-4000-8000-000000000002",
    root_content_id: "50000000-0000-4000-8000-000000000004",
    revision_id: "60000000-0000-4000-8000-000000000001",
    resource_version: 1,
  },
  pending_action: null,
  error: null,
  request_id: requestId,
  schema_version: "1",
};

const pendingResponse: ReplyToContentWriteResult = {
  decision: "require_approval",
  status: "pending_approval",
  result: null,
  pending_action: {
    id: "70000000-0000-4000-8000-000000000001",
    operation: "reply_to_content",
    state: "pending_approval",
    expires_at: "2026-07-23T12:00:00.000Z",
    input_digest: `sha256:${"a".repeat(64)}`,
    requested_at: "2026-07-22T12:00:00.000Z",
    decision_id: "80000000-0000-4000-8000-000000000001",
    policy_version: "90000000-0000-4000-8000-000000000001:4",
    approval_summary: "Reply to one item in the Semiconductors discussion.",
  },
  error: null,
  request_id: requestId,
  schema_version: "1",
};

const policyDeniedResponse: ReplyToContentWriteResult = {
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

const approvalRejectedResponse: ReplyToContentWriteResult = {
  ...pendingResponse,
  status: "denied",
  pending_action: {
    ...pendingResponse.pending_action!,
    state: "rejected",
  },
  error: {
    code: "ACTION_REJECTED",
    message: "The Owner rejected this action.",
    retryable: false,
    details: null,
    retry_after_ms: null,
  },
};

const idempotencyFailedResponse: ReplyToContentWriteResult = {
  decision: "allow",
  status: "failed",
  result: null,
  pending_action: null,
  error: {
    code: "IDEMPOTENCY_CONFLICT",
    message: "The idempotency key has different normalized input.",
    retryable: false,
    details: null,
    retry_after_ms: null,
  },
  request_id: requestId,
  schema_version: "1",
};

const rateLimitedResponse: ReplyToContentWriteResult = {
  decision: "deny",
  status: "denied",
  result: null,
  pending_action: null,
  error: {
    code: "RATE_LIMITED",
    message: "The Community reply limit has been reached.",
    retryable: true,
    details: { parent_content_id: argumentsValue.parent_content_id },
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

describe("reply_to_content MCP tool", () => {
  it("publishes strict wire-safe schemas, UGC guidance, and protocol metadata", () => {
    const tool = createReplyToContentTool(respondingClient(successResponse, 201).client);
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validateInput = ajv.compile(tool.definition.inputSchema);
    const validateOutput = ajv.compile(tool.successOutputSchema);
    const serializedSchemas = JSON.stringify({
      input: REPLY_TO_CONTENT_INPUT_SCHEMA,
      output: REPLY_TO_CONTENT_SUCCESS_OUTPUT_SCHEMA,
    });

    expect(tool.definition).toMatchObject({
      name: "reply_to_content",
      title: "Reply to Content",
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execution: { taskSupport: "forbidden" },
    });
    expect(tool.definition.description).toMatch(/untrusted/iu);
    expect(REPLY_TO_CONTENT_INPUT_SCHEMA.required).toEqual([
      "parent_content_id",
      "body_markdown",
      "idempotency_key",
    ]);
    expect(validateInput(argumentsValue)).toBe(true);
    for (const payload of [
      successResponse,
      pendingResponse,
      policyDeniedResponse,
      approvalRejectedResponse,
      idempotencyFailedResponse,
      rateLimitedResponse,
    ]) {
      expect(validateOutput(payload)).toBe(true);
    }
    expect(
      validateInput({ ...argumentsValue, parent_content_id: "contains whitespace" }),
    ).toBe(false);
    expect(validateInput({ ...argumentsValue, idempotency_key: "   " })).toBe(false);
    expect(validateInput({ ...argumentsValue, idempotency_key: "has,comma" })).toBe(
      false,
    );
    expect(
      validateInput({
        ...argumentsValue,
        source_links: [{ url: "http://example.test/source" }],
      }),
    ).toBe(false);
    expect(
      validateInput({
        ...argumentsValue,
        source_links: [{ url: "https://user@example.test/source" }],
      }),
    ).toBe(false);
    expect(serializedSchemas).not.toContain('"$ref"');
    expect(serializedSchemas).not.toContain('"$defs"');
    expect(() =>
      createProtocolServer({
        executionRegistry: new McpExecutionRegistry(),
        logger: createLogger({
          environment: "test",
          level: "silent",
          service: "reply-to-content-tool-test",
        }),
        requestId,
        tools: [tool],
        version: "test-version",
      }),
    ).not.toThrow();
  });

  it("uses the shared Contracts parser for the complete strict command", () => {
    const tool = createReplyToContentTool(respondingClient(successResponse, 201).client);

    expect(tool.parseArguments(argumentsValue)).toEqual(argumentsValue);
    for (const invalid of [
      {},
      { ...argumentsValue, actor_id: "forged" },
      { ...argumentsValue, parent_content_id: "contains whitespace" },
      { ...argumentsValue, body_markdown: "" },
      { ...argumentsValue, body_markdown: "x".repeat(20_001) },
      { ...argumentsValue, symbols: ["AMD", "AMD"] },
      { ...argumentsValue, idempotency_key: "has,comma" },
      { ...argumentsValue, idempotency_key: "line\nbreak" },
      {
        ...argumentsValue,
        source_links: [{ url: "http://example.test/source" }],
      },
      null,
      [],
    ]) {
      expect(() => tool.parseArguments(invalid)).toThrow();
    }
  });

  it("POSTs the complete parsed body to the fixed private endpoint", async () => {
    const { client, request } = respondingClient(successResponse, 201);
    const tool = createReplyToContentTool(client);

    await expect(tool.execute(argumentsValue, context)).resolves.toEqual({
      payload: successResponse,
    });
    expect(request).toHaveBeenCalledOnce();
    const [upstreamRequest, executionContext] = request.mock.calls[0] ?? [];
    expect(upstreamRequest).toBeDefined();
    if (upstreamRequest === undefined) throw new Error("Missing upstream request");
    expect(upstreamRequest).toEqual({
      body: argumentsValue,
      method: "POST",
      path: REPLY_TO_CONTENT_INTERNAL_API_PATH,
      parseResponse: upstreamRequest.parseResponse,
    });
    expect(typeof upstreamRequest.parseResponse).toBe("function");
    expect(executionContext).toBe(context);
  });

  it.each([
    {
      label: "autonomous success",
      payload: successResponse,
      statusCode: 201,
      isError: false,
    },
    {
      label: "assisted pending approval",
      payload: pendingResponse,
      statusCode: 202,
      isError: false,
    },
    {
      label: "stable policy denial",
      payload: policyDeniedResponse,
      statusCode: 403,
      isError: false,
    },
    {
      label: "terminal Owner rejection replay",
      payload: approvalRejectedResponse,
      statusCode: 409,
      isError: false,
    },
    {
      label: "idempotency failure",
      payload: idempotencyFailedResponse,
      statusCode: 409,
      isError: true,
    },
    {
      label: "authoritative write rate limit",
      payload: rateLimitedResponse,
      statusCode: 429,
      isError: true,
    },
  ])(
    "maps $label without losing the reply envelope",
    async ({ payload, statusCode, isError }) => {
      const tool = createReplyToContentTool(respondingClient(payload, statusCode).client);

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
    const tool = createReplyToContentTool(respondingClient(payload, statusCode).client);

    await expect(tool.execute(argumentsValue, context)).resolves.toEqual({
      isError: true,
      payload,
    });
  });

  it.each([
    {
      label: "success with HTTP 200",
      payload: successResponse,
      statusCode: 200,
    },
    {
      label: "pending approval with HTTP 201",
      payload: pendingResponse,
      statusCode: 201,
    },
    {
      label: "policy denial with HTTP 422",
      payload: policyDeniedResponse,
      statusCode: 422,
    },
    {
      label: "failed result with HTTP 503",
      payload: idempotencyFailedResponse,
      statusCode: 503,
    },
    {
      label: "success reusing its parent ID",
      payload: {
        ...successResponse,
        result: {
          ...successResponse.result!,
          content_id: argumentsValue.parent_content_id,
        },
      },
      statusCode: 201,
    },
    {
      label: "write result with another request ID",
      payload: {
        ...successResponse,
        request_id: "44444444-4444-4444-8444-444444444444",
      },
      statusCode: 201,
    },
    {
      label: "V1 error with the wrong HTTP status",
      payload: v1ErrorResponse,
      statusCode: 404,
    },
    {
      label: "unknown endpoint V1 error code",
      payload: {
        ...v1ErrorResponse,
        error: { ...v1ErrorResponse.error, code: "ROUTE_NOT_FOUND" },
      },
      statusCode: 404,
    },
    {
      label: "V1 error with another request ID",
      payload: {
        ...v1ErrorResponse,
        request_id: "44444444-4444-4444-8444-444444444444",
      },
      statusCode: 503,
    },
  ])("fails closed for $label", async ({ payload, statusCode }) => {
    const tool = createReplyToContentTool(respondingClient(payload, statusCode).client);

    await expect(tool.execute(argumentsValue, context)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "InternalMcpApiClientError",
    });
  });

  it("strictly parses wire-safe output branches and rejects malformed payloads", () => {
    const tool = createReplyToContentTool(respondingClient(successResponse, 201).client);

    expect(tool.parseOutput(successResponse)).toEqual(successResponse);
    expect(tool.parseOutput(v1ErrorResponse)).toEqual(v1ErrorResponse);
    expect(JSON.parse(JSON.stringify(tool.parseOutput(successResponse)))).toEqual(
      successResponse,
    );
    expect(() =>
      tool.parseOutput({ ...successResponse, internal_replayed: true }),
    ).toThrow();
    expect(() =>
      tool.parseOutput({
        ...rateLimitedResponse,
        error: { ...rateLimitedResponse.error!, retry_after_ms: null },
      }),
    ).toThrow();
    expect(() =>
      tool.parseOutput({
        ...successResponse,
        status: "succeeded",
        result: null,
      }),
    ).toThrow();
    expect(() => tool.parseOutput({ ok: true })).toThrow();
  });

  it("rejects malformed upstream payloads before status normalization", async () => {
    const tool = createReplyToContentTool(
      respondingClient({ ...successResponse, debug: true }, 201).client,
    );

    await expect(tool.execute(argumentsValue, context)).rejects.toThrow();
  });

  it("propagates private-client failures for protocol-level normalization", async () => {
    const upstreamError = new InternalMcpApiClientError("TIMEOUT");
    const request = vi.fn(() => Promise.reject(upstreamError));
    const tool = createReplyToContentTool({ request });

    await expect(tool.execute(argumentsValue, context)).rejects.toBe(upstreamError);
    expect(request).toHaveBeenCalledOnce();
  });
});
