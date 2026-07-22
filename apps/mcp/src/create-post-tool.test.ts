import {
  type CreatePostRequest,
  type CreatePostWriteResult,
  type V1ErrorResponse,
} from "@alphanet/contracts";
import { createLogger } from "@alphanet/observability";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import {
  CREATE_POST_INPUT_SCHEMA,
  CREATE_POST_INTERNAL_API_PATH,
  CREATE_POST_SUCCESS_OUTPUT_SCHEMA,
  createCreatePostTool,
} from "./create-post-tool.js";
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

const argumentsValue: CreatePostRequest = {
  title: "AMD data-center scenario review",
  body_markdown: "## Base case\n\nRevenue remains sensitive to product mix.",
  primary_community_id: "40000000-0000-4000-8000-000000000001",
  additional_community_ids: ["40000000-0000-4000-8000-000000000002"],
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
      target_content_id: "50000000-0000-4000-8000-000000000001",
      relation_type: "reference",
    },
  ],
  idempotency_key: "post-amd-scenarios-20260722-v1",
};

const successResponse: CreatePostWriteResult = {
  decision: "allow",
  status: "succeeded",
  result: {
    content_id: "50000000-0000-4000-8000-000000000002",
    revision_id: "60000000-0000-4000-8000-000000000001",
    resource_version: 1,
  },
  pending_action: null,
  error: null,
  request_id: requestId,
  schema_version: "1",
};

const pendingResponse: CreatePostWriteResult = {
  decision: "require_approval",
  status: "pending_approval",
  result: null,
  pending_action: {
    id: "70000000-0000-4000-8000-000000000001",
    operation: "create_post",
    state: "pending_approval",
    expires_at: "2026-07-23T12:00:00.000Z",
    input_digest: `sha256:${"a".repeat(64)}`,
    requested_at: "2026-07-22T12:00:00.000Z",
    decision_id: "80000000-0000-4000-8000-000000000001",
    policy_version: "90000000-0000-4000-8000-000000000001:4",
    approval_summary: "Create one post in the Semiconductors community.",
  },
  error: null,
  request_id: requestId,
  schema_version: "1",
};

const policyDeniedResponse: CreatePostWriteResult = {
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

const approvalRejectedResponse: CreatePostWriteResult = {
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

const failedResponse: CreatePostWriteResult = {
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

const rateLimitedResponse: CreatePostWriteResult = {
  decision: "deny",
  status: "denied",
  result: null,
  pending_action: null,
  error: {
    code: "RATE_LIMITED",
    message: "The Community posting limit has been reached.",
    retryable: true,
    details: { community_id: argumentsValue.primary_community_id },
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

describe("create_post MCP tool", () => {
  it("publishes strict, reference-free schemas and registers with the protocol", () => {
    const tool = createCreatePostTool(respondingClient(successResponse, 201).client);
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(tool.definition.inputSchema);
    const serializedSchemas = JSON.stringify({
      input: CREATE_POST_INPUT_SCHEMA,
      output: CREATE_POST_SUCCESS_OUTPUT_SCHEMA,
    });

    expect(tool.definition).toMatchObject({
      name: "create_post",
      title: "Create Post",
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
    expect(CREATE_POST_INPUT_SCHEMA.required).toEqual([
      "title",
      "body_markdown",
      "primary_community_id",
      "idempotency_key",
    ]);
    expect(CREATE_POST_INPUT_SCHEMA.properties.title).toMatchObject({
      minLength: 5,
      maxLength: 200,
    });
    expect(CREATE_POST_INPUT_SCHEMA.properties.body_markdown).toMatchObject({
      minLength: 1,
      maxLength: 100_000,
    });
    expect(validate(argumentsValue)).toBe(true);
    expect(
      validate({ ...argumentsValue, primary_community_id: "contains whitespace" }),
    ).toBe(false);
    expect(validate({ ...argumentsValue, idempotency_key: "   " })).toBe(false);
    expect(validate({ ...argumentsValue, idempotency_key: "has,comma" })).toBe(false);
    expect(validate({ ...argumentsValue, idempotency_key: "line\nbreak" })).toBe(false);
    expect(
      validate({
        ...argumentsValue,
        source_links: [{ url: "https://user@example.test/source" }],
      }),
    ).toBe(false);
    expect(
      validate({
        ...argumentsValue,
        source_links: [{ url: "http://example.test/source" }],
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
          service: "create-post-tool-test",
        }),
        requestId,
        tools: [tool],
        version: "test-version",
      }),
    ).not.toThrow();
  });

  it("parses the complete Contracts input and rejects extra or invalid fields", () => {
    const tool = createCreatePostTool(respondingClient(successResponse, 201).client);

    expect(tool.parseArguments(argumentsValue)).toEqual(argumentsValue);
    expect(() =>
      tool.parseArguments({ ...argumentsValue, actor_id: "forged" }),
    ).toThrow();
    expect(() => tool.parseArguments({ ...argumentsValue, title: "tiny" })).toThrow();
    expect(() =>
      tool.parseArguments({
        ...argumentsValue,
        source_links: [{ url: "http://example.test/source" }],
      }),
    ).toThrow();
    expect(() =>
      tool.parseArguments({
        ...argumentsValue,
        source_links: [{ url: "https://user@example.test/source" }],
      }),
    ).toThrow();
    expect(() =>
      tool.parseArguments({ ...argumentsValue, idempotency_key: "has,comma" }),
    ).toThrow();
    expect(() =>
      tool.parseArguments({ ...argumentsValue, idempotency_key: "   " }),
    ).toThrow();
    expect(() =>
      tool.parseArguments({ ...argumentsValue, idempotency_key: "line\nbreak" }),
    ).toThrow();
    expect(() =>
      tool.parseArguments({
        ...argumentsValue,
        body_markdown: "😀".repeat(41_000),
      }),
    ).toThrow();
  });

  it("posts the exact parsed command to the fixed private endpoint", async () => {
    const { client, request } = respondingClient(successResponse, 201);
    const tool = createCreatePostTool(client);

    await expect(tool.execute(argumentsValue, context)).resolves.toEqual({
      payload: successResponse,
    });
    expect(request).toHaveBeenCalledOnce();
    const [upstreamRequest, executionContext] = request.mock.calls[0] ?? [];
    expect(upstreamRequest).toMatchObject({
      body: argumentsValue,
      method: "POST",
      path: CREATE_POST_INTERNAL_API_PATH,
    });
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
      label: "operation failure",
      payload: failedResponse,
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
    "maps $label without losing the operation-specific envelope",
    async ({ payload, statusCode, isError }) => {
      const tool = createCreatePostTool(respondingClient(payload, statusCode).client);

      await expect(tool.execute(argumentsValue, context)).resolves.toEqual({
        ...(isError ? { isError: true } : {}),
        payload,
      });
    },
  );

  it.each([
    ["REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED", 401],
    ["SCOPE_REQUIRED", 403],
    ["COMMUNITY_NOT_FOUND", 404],
    ["IDEMPOTENCY_CONFLICT", 409],
    ["VALIDATION_ERROR", 422],
    ["RATE_LIMITED", 429],
    ["WRITE_UNAVAILABLE", 503],
  ])("returns %s only with its exact HTTP %s status", async (code, statusCode) => {
    const payload: V1ErrorResponse = {
      ...v1ErrorResponse,
      error: {
        ...v1ErrorResponse.error,
        code,
        retryable: code === "RATE_LIMITED" || v1ErrorResponse.error.retryable,
        retry_after_ms: code === "RATE_LIMITED" ? 1_000 : null,
      },
    };
    const tool = createCreatePostTool(respondingClient(payload, statusCode).client);

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
      label: "V1 error with HTTP 201",
      payload: v1ErrorResponse,
      statusCode: 201,
    },
    {
      label: "success with redirect status",
      payload: successResponse,
      statusCode: 307,
    },
    {
      label: "known V1 error with the wrong HTTP status",
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
      label: "write result with another request ID",
      payload: {
        ...successResponse,
        request_id: "44444444-4444-4444-8444-444444444444",
      },
      statusCode: 201,
    },
    {
      label: "V1 error with another request ID",
      payload: {
        ...v1ErrorResponse,
        request_id: "44444444-4444-4444-8444-444444444444",
      },
      statusCode: 503,
    },
  ])("rejects $label", async ({ payload, statusCode }) => {
    const tool = createCreatePostTool(respondingClient(payload, statusCode).client);

    await expect(tool.execute(argumentsValue, context)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "InternalMcpApiClientError",
    });
  });

  it("strictly parses both output branches and rejects malformed output", () => {
    const tool = createCreatePostTool(respondingClient(successResponse, 201).client);

    expect(tool.parseOutput(successResponse)).toEqual(successResponse);
    expect(tool.parseOutput(v1ErrorResponse)).toEqual(v1ErrorResponse);
    expect(() =>
      tool.parseOutput({ ...successResponse, internal_replayed: true }),
    ).toThrow();
    expect(() =>
      tool.parseOutput({
        ...rateLimitedResponse,
        error: { ...rateLimitedResponse.error!, retry_after_ms: null },
      }),
    ).toThrow();
    expect(() => tool.parseOutput({ ok: true })).toThrow();
  });

  it("propagates private-client failures for protocol-level normalization", async () => {
    const upstreamError = new InternalMcpApiClientError("TIMEOUT");
    const request = vi.fn(() => Promise.reject(upstreamError));
    const tool = createCreatePostTool({ request });

    await expect(tool.execute(argumentsValue, context)).rejects.toBe(upstreamError);
    expect(request).toHaveBeenCalledOnce();
  });
});
