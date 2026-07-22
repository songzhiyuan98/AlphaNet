import { type SetReactionWriteResult, type V1ErrorResponse } from "@alphanet/contracts";
import { createLogger } from "@alphanet/observability";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import {
  createSetReactionTool,
  SET_REACTION_INPUT_SCHEMA,
  SET_REACTION_INTERNAL_API_PATH,
  SET_REACTION_SUCCESS_OUTPUT_SCHEMA,
} from "./set-reaction-tool.js";
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
    scopes: ["reaction:write"],
    tokenJtiDigest: "A".repeat(43),
  },
  requestId,
  signal: new AbortController().signal,
};

const argumentsValue = {
  active: true,
  content_id: contentId,
  idempotency_key: "reaction-amd-helpful-v1",
  reaction: "helpful",
} as const;

type ReactionRequestFixture = {
  active: boolean;
  content_id: string;
  idempotency_key: string;
  reaction: "helpful" | "agree" | "disagree";
};

function succeededResponse(
  input: ReactionRequestFixture = argumentsValue,
): SetReactionWriteResult {
  const otherReaction = input.reaction === "disagree" ? "helpful" : "disagree";
  return {
    decision: "allow",
    status: "succeeded",
    result: {
      content_id: input.content_id.toLowerCase(),
      reaction_counts: { agree: 2, disagree: 1, helpful: 6 },
      viewer_state: {
        following: false,
        reactions: input.active ? [input.reaction, otherReaction] : [otherReaction],
      },
    },
    pending_action: null,
    error: null,
    request_id: requestId,
    schema_version: "1",
  };
}

const policyDeniedResponse: SetReactionWriteResult = {
  decision: "deny",
  status: "denied",
  result: null,
  pending_action: null,
  error: {
    code: "POLICY_DENIED",
    message: "The Agent policy does not permit Reaction writes.",
    retryable: false,
    details: { reason: "POLICY_DENIED" },
    retry_after_ms: null,
  },
  request_id: requestId,
  schema_version: "1",
};

const failedResponse: SetReactionWriteResult = {
  decision: "allow",
  status: "failed",
  result: null,
  pending_action: null,
  error: {
    code: "CONTENT_STATE_INVALID",
    message: "The content cannot receive Reactions in its current state.",
    retryable: false,
    details: null,
    retry_after_ms: null,
  },
  request_id: requestId,
  schema_version: "1",
};

const rateLimitedResponse: SetReactionWriteResult = {
  decision: "deny",
  status: "denied",
  result: null,
  pending_action: null,
  error: {
    code: "RATE_LIMITED",
    message: "The Reaction rate limit has been reached.",
    retryable: true,
    details: { limit_dimension: "agent_reaction" },
    retry_after_ms: 45_000,
  },
  request_id: requestId,
  schema_version: "1",
};

const v1ErrorResponse: V1ErrorResponse = {
  error: {
    code: "WRITE_UNAVAILABLE",
    message: "The Reaction service is temporarily unavailable.",
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

describe("set_reaction MCP tool", () => {
  it("publishes strict target-state schemas, social-signal guidance, and write metadata", () => {
    const tool = createSetReactionTool(respondingClient(succeededResponse(), 200).client);
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validateInput = ajv.compile(tool.definition.inputSchema);
    const validateOutput = ajv.compile(tool.successOutputSchema);
    const serializedSchemas = JSON.stringify({
      input: SET_REACTION_INPUT_SCHEMA,
      output: SET_REACTION_SUCCESS_OUTPUT_SCHEMA,
    });

    expect(tool.definition).toMatchObject({
      name: "set_reaction",
      title: "Set Reaction",
      inputSchema: { type: "object", additionalProperties: false },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execution: { taskSupport: "forbidden" },
    });
    expect(tool.definition.description).toMatch(/social signal/iu);
    expect(tool.definition.description).toMatch(/independent/iu);
    expect(SET_REACTION_INPUT_SCHEMA.required).toEqual([
      "content_id",
      "reaction",
      "active",
      "idempotency_key",
    ]);
    for (const reaction of ["helpful", "agree", "disagree"]) {
      expect(validateInput({ ...argumentsValue, reaction, active: true })).toBe(true);
      expect(validateInput({ ...argumentsValue, reaction, active: false })).toBe(true);
    }
    for (const payload of [
      succeededResponse(),
      policyDeniedResponse,
      failedResponse,
      rateLimitedResponse,
    ]) {
      expect(validateOutput(payload)).toBe(true);
    }
    expect(
      validateOutput({
        ...policyDeniedResponse,
        decision: "require_approval",
        status: "pending_approval",
      }),
    ).toBe(false);
    expect(validateInput({ ...argumentsValue, reaction: "like" })).toBe(false);
    expect(validateInput({ ...argumentsValue, content_id: "contains whitespace" })).toBe(
      false,
    );
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
          service: "set-reaction-tool-test",
        }),
        requestId,
        tools: [tool],
        version: "test-version",
      }),
    ).not.toThrow();
  });

  it("uses the shared Contracts parsers for the complete strict command", () => {
    const tool = createSetReactionTool(respondingClient(succeededResponse(), 200).client);

    expect(tool.parseArguments(argumentsValue)).toEqual(argumentsValue);
    for (const invalid of [
      {},
      { ...argumentsValue, actor_id: "forged" },
      { ...argumentsValue, content_id: "contains whitespace" },
      { ...argumentsValue, reaction: "like" },
      { ...argumentsValue, active: "true" },
      { ...argumentsValue, idempotency_key: "" },
      { ...argumentsValue, idempotency_key: "   " },
      { ...argumentsValue, idempotency_key: "has,comma" },
      { ...argumentsValue, idempotency_key: "line\nbreak" },
      null,
      [],
    ]) {
      expect(() => tool.parseArguments(invalid)).toThrow();
    }
  });

  it("POSTs the exact parsed target-state body to the fixed private endpoint", async () => {
    const { client, request } = respondingClient(succeededResponse(), 200);
    const tool = createSetReactionTool(client);

    await expect(tool.execute(argumentsValue, context)).resolves.toEqual({
      payload: succeededResponse(),
    });
    expect(request).toHaveBeenCalledOnce();
    const [upstreamRequest, executionContext] = request.mock.calls[0] ?? [];
    expect(upstreamRequest).toBeDefined();
    if (upstreamRequest === undefined) throw new Error("Missing upstream request");
    expect(upstreamRequest).toEqual({
      body: argumentsValue,
      method: "POST",
      path: SET_REACTION_INTERNAL_API_PATH,
      parseResponse: upstreamRequest.parseResponse,
    });
    expect(typeof upstreamRequest.parseResponse).toBe("function");
    expect(executionContext).toBe(context);
  });

  it.each([
    ["helpful", true],
    ["helpful", false],
    ["agree", true],
    ["agree", false],
    ["disagree", true],
    ["disagree", false],
  ] as const)(
    "correlates the %s Reaction desired state active=%s",
    async (reaction, active) => {
      const request = {
        ...argumentsValue,
        active,
        idempotency_key: `reaction-${reaction}-${String(active)}-v1`,
        reaction,
      };
      const response = succeededResponse(request);
      const tool = createSetReactionTool(respondingClient(response, 200).client);

      await expect(tool.execute(request, context)).resolves.toEqual({
        payload: response,
      });
    },
  );

  it("correlates a canonical lowercase result for an uppercase UUID target", async () => {
    const request: ReactionRequestFixture = {
      ...argumentsValue,
      content_id: "50000000-0000-4000-8000-00000000000A",
      idempotency_key: "reaction-uppercase-content-v1",
    };
    const response = succeededResponse(request);
    const tool = createSetReactionTool(respondingClient(response, 200).client);

    expect(response.result?.content_id).toBe(request.content_id.toLowerCase());
    await expect(tool.execute(request, context)).resolves.toEqual({ payload: response });
  });

  it.each([
    {
      label: "another content target",
      payload: {
        ...succeededResponse(),
        result: {
          ...succeededResponse().result!,
          content_id: "50000000-0000-4000-8000-000000000099",
        },
      },
    },
    {
      label: "missing requested active Reaction",
      payload: {
        ...succeededResponse(),
        result: {
          ...succeededResponse().result!,
          viewer_state: {
            ...succeededResponse().result!.viewer_state,
            reactions: ["disagree"],
          },
        },
      },
    },
    {
      label: "requested inactive Reaction still active",
      request: { ...argumentsValue, active: false },
      payload: succeededResponse(),
    },
    {
      label: "another request ID",
      payload: {
        ...succeededResponse(),
        request_id: "44444444-4444-4444-8444-444444444444",
      },
    },
  ])("rejects success for $label", async ({ payload, request = argumentsValue }) => {
    const tool = createSetReactionTool(respondingClient(payload, 200).client);

    await expect(tool.execute(request, context)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "InternalMcpApiClientError",
    });
  });

  it.each([
    {
      label: "autonomous success",
      payload: succeededResponse(),
      statusCode: 200,
      isError: false,
    },
    {
      label: "stable policy denial",
      payload: policyDeniedResponse,
      statusCode: 403,
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
  ])("maps $label without losing its write envelope", async (entry) => {
    const tool = createSetReactionTool(
      respondingClient(entry.payload, entry.statusCode).client,
    );

    await expect(tool.execute(argumentsValue, context)).resolves.toEqual({
      ...(entry.isError ? { isError: true } : {}),
      payload: entry.payload,
    });
  });

  it.each([
    ["REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED", 401],
    ["REMOTE_MCP_ACTOR_AUTHENTICATION_UNAVAILABLE", 503],
    ["REMOTE_MCP_TRANSPORT_AUTHENTICATION_FAILED", 401],
    ["REMOTE_MCP_TRANSPORT_AUTHENTICATION_UNAVAILABLE", 503],
    ["AUTHORIZATION_CONTEXT_STALE", 401],
    ["SCOPE_REQUIRED", 403],
    ["POLICY_DENIED", 403],
    ["COMMUNITY_RESTRICTED", 403],
    ["CONTENT_NOT_FOUND", 404],
    ["CONTENT_STATE_INVALID", 409],
    ["IDEMPOTENCY_CONFLICT", 409],
    ["IDEMPOTENCY_IN_PROGRESS", 409],
    ["SELF_REACTION_NOT_ALLOWED", 409],
    ["VALIDATION_ERROR", 422],
    ["RATE_LIMITED", 429],
    ["IDEMPOTENCY_RESULT_CORRUPT", 503],
    ["TEMPORARILY_UNAVAILABLE", 503],
    ["WRITE_UNAVAILABLE", 503],
  ])("allows V1 error %s only with exact HTTP %s", async (code, statusCode) => {
    const payload: V1ErrorResponse = {
      ...v1ErrorResponse,
      error: {
        ...v1ErrorResponse.error,
        code,
        retryable: statusCode === 429 || statusCode === 503,
        retry_after_ms: statusCode === 429 ? 1_000 : null,
      },
    };
    const tool = createSetReactionTool(respondingClient(payload, statusCode).client);

    await expect(tool.execute(argumentsValue, context)).resolves.toEqual({
      isError: true,
      payload,
    });
  });

  it.each([
    ["success with HTTP 201", succeededResponse(), 201],
    ["policy denial with HTTP 422", policyDeniedResponse, 422],
    ["failure with HTTP 200", failedResponse, 200],
    ["V1 error with HTTP 201", v1ErrorResponse, 201],
    ["known V1 error with the wrong status", v1ErrorResponse, 404],
    [
      "unknown V1 error code",
      {
        ...v1ErrorResponse,
        error: { ...v1ErrorResponse.error, code: "ROUTE_NOT_FOUND" },
      },
      404,
    ],
    [
      "V1 error with another request ID",
      {
        ...v1ErrorResponse,
        request_id: "44444444-4444-4444-8444-444444444444",
      },
      503,
    ],
  ])("rejects %s", async (_label, payload, statusCode) => {
    const tool = createSetReactionTool(respondingClient(payload, statusCode).client);

    await expect(tool.execute(argumentsValue, context)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "InternalMcpApiClientError",
    });
  });

  it("rejects fabricated approval before status normalization", async () => {
    const tool = createSetReactionTool(
      respondingClient({ ...succeededResponse(), decision: "require_approval" }, 200)
        .client,
    );

    await expect(tool.execute(argumentsValue, context)).rejects.toThrow();
  });

  it("strictly parses every output branch and rejects malformed output", () => {
    const tool = createSetReactionTool(respondingClient(succeededResponse(), 200).client);

    for (const payload of [
      succeededResponse(),
      policyDeniedResponse,
      failedResponse,
      rateLimitedResponse,
      v1ErrorResponse,
    ]) {
      expect(tool.parseOutput(payload)).toEqual(payload);
    }
    expect(() =>
      tool.parseOutput({ ...succeededResponse(), internal_replayed: true }),
    ).toThrow();
    expect(() =>
      tool.parseOutput({ ...succeededResponse(), decision: "require_approval" }),
    ).toThrow();
    expect(() => tool.parseOutput({ ok: true })).toThrow();
  });

  it("propagates private-client failures for protocol-level normalization", async () => {
    const upstreamError = new InternalMcpApiClientError("TIMEOUT");
    const request = vi.fn(() => Promise.reject(upstreamError));
    const tool = createSetReactionTool({ request });

    await expect(tool.execute(argumentsValue, context)).rejects.toBe(upstreamError);
    expect(request).toHaveBeenCalledOnce();
  });
});
