import { type SetFollowWriteResult, type V1ErrorResponse } from "@alphanet/contracts";
import { createLogger } from "@alphanet/observability";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import {
  createSetFollowTool,
  SET_FOLLOW_INPUT_SCHEMA,
  SET_FOLLOW_INTERNAL_API_PATH,
  SET_FOLLOW_SUCCESS_OUTPUT_SCHEMA,
} from "./set-follow-tool.js";
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
    scopes: ["follow:write"],
    tokenJtiDigest: "A".repeat(43),
  },
  requestId,
  signal: new AbortController().signal,
};

const argumentsValue = {
  active: true,
  idempotency_key: "follow-symbol-amd-v1",
  notification_level: "new_posts",
  target_id: "amd",
  target_type: "symbol",
} as const;

type FollowRequestFixture = {
  active: boolean;
  idempotency_key: string;
  notification_level?: "feed_only" | "new_posts" | "all_events";
  target_id: string;
  target_type: "actor" | "symbol" | "topic" | "content";
};

function canonicalTargetId(request: FollowRequestFixture): string {
  return request.target_type === "symbol"
    ? request.target_id.normalize("NFC").toUpperCase()
    : request.target_id.normalize("NFC").toLowerCase();
}

function succeededResponse(
  input: FollowRequestFixture = argumentsValue,
  effectiveLevel: "feed_only" | "new_posts" | "all_events" = input.notification_level ??
    "feed_only",
): SetFollowWriteResult {
  return {
    decision: "allow",
    status: "succeeded",
    result: {
      target_type: input.target_type,
      target_id: canonicalTargetId(input),
      active: input.active,
      notification_level: input.active ? effectiveLevel : null,
      updated_at: "2026-07-22T12:00:00.000Z",
    },
    pending_action: null,
    error: null,
    request_id: requestId,
    schema_version: "1",
  };
}

const policyDeniedResponse: SetFollowWriteResult = {
  decision: "deny",
  status: "denied",
  result: null,
  pending_action: null,
  error: {
    code: "POLICY_DENIED",
    message: "The Agent policy does not permit Follow writes.",
    retryable: false,
    details: { reason: "POLICY_DENIED" },
    retry_after_ms: null,
  },
  request_id: requestId,
  schema_version: "1",
};

const failedResponse: SetFollowWriteResult = {
  decision: "allow",
  status: "failed",
  result: null,
  pending_action: null,
  error: {
    code: "TARGET_NOT_FOUND",
    message: "The Follow target does not exist.",
    retryable: false,
    details: null,
    retry_after_ms: null,
  },
  request_id: requestId,
  schema_version: "1",
};

const rateLimitedResponse: SetFollowWriteResult = {
  decision: "deny",
  status: "denied",
  result: null,
  pending_action: null,
  error: {
    code: "RATE_LIMITED",
    message: "The Follow write limit has been reached.",
    retryable: true,
    details: { limit_dimension: "agent_follow" },
    retry_after_ms: 45_000,
  },
  request_id: requestId,
  schema_version: "1",
};

const v1ErrorResponse: V1ErrorResponse = {
  error: {
    code: "FOLLOW_NOT_READY",
    message: "The Follow service is temporarily unavailable.",
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

describe("set_follow MCP tool", () => {
  it("publishes strict target-state schemas, Follow guidance, and write metadata", () => {
    const tool = createSetFollowTool(respondingClient(succeededResponse(), 200).client);
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validateInput = ajv.compile(tool.definition.inputSchema);
    const validateOutput = ajv.compile(tool.successOutputSchema);
    const serializedSchemas = JSON.stringify({
      input: SET_FOLLOW_INPUT_SCHEMA,
      output: SET_FOLLOW_SUCCESS_OUTPUT_SCHEMA,
    });

    expect(tool.definition).toMatchObject({
      name: "set_follow",
      title: "Set Follow",
      inputSchema: { type: "object", additionalProperties: false },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execution: { taskSupport: "forbidden" },
    });
    expect(tool.definition.description).toMatch(/visibility/iu);
    expect(tool.definition.description).toMatch(/authority/iu);
    expect(SET_FOLLOW_INPUT_SCHEMA.required).toEqual([
      "target_type",
      "target_id",
      "active",
      "idempotency_key",
    ]);
    for (const [target_type, target_id] of [
      ["actor", "50000000-0000-4000-8000-00000000000A"],
      ["symbol", "amd"],
      ["topic", "HBM-SUPPLY"],
      ["content", "60000000-0000-4000-8000-00000000000B"],
    ] as const) {
      expect(validateInput({ ...argumentsValue, target_type, target_id })).toBe(true);
    }
    for (const notification_level of ["feed_only", "new_posts", "all_events"]) {
      expect(validateInput({ ...argumentsValue, notification_level })).toBe(true);
    }
    expect(
      validateInput({
        ...argumentsValue,
        active: false,
        notification_level: "all_events",
      }),
    ).toBe(true);
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
    expect(validateInput({ ...argumentsValue, target_type: "community" })).toBe(false);
    expect(
      validateInput({ ...argumentsValue, notification_level: "important_only" }),
    ).toBe(false);
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
          service: "set-follow-tool-test",
        }),
        requestId,
        tools: [tool],
        version: "test-version",
      }),
    ).not.toThrow();
  });

  it("uses the shared Contracts parsers for the complete strict command", () => {
    const tool = createSetFollowTool(respondingClient(succeededResponse(), 200).client);

    expect(tool.parseArguments(argumentsValue)).toEqual(argumentsValue);
    for (const invalid of [
      {},
      { ...argumentsValue, actor_id: "forged" },
      { ...argumentsValue, target_id: "contains whitespace" },
      { ...argumentsValue, target_type: "community" },
      { ...argumentsValue, notification_level: "important_only" },
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
    const tool = createSetFollowTool(client);

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
      path: SET_FOLLOW_INTERNAL_API_PATH,
      parseResponse: upstreamRequest.parseResponse,
    });
    expect(typeof upstreamRequest.parseResponse).toBe("function");
    expect(executionContext).toBe(context);
  });

  it.each([
    ["actor", "50000000-0000-4000-8000-00000000000A"],
    ["symbol", "amd"],
    ["topic", "HBM-SUPPLY"],
    ["content", "60000000-0000-4000-8000-00000000000B"],
  ] as const)(
    "correlates and canonicalizes the %s target",
    async (target_type, target_id) => {
      const request: FollowRequestFixture = {
        ...argumentsValue,
        idempotency_key: `follow-${target_type}-v1`,
        target_id,
        target_type,
      };
      const response = succeededResponse(request);
      const tool = createSetFollowTool(respondingClient(response, 200).client);

      await expect(tool.execute(request, context)).resolves.toEqual({
        payload: response,
      });
    },
  );

  it.each(["feed_only", "new_posts", "all_events"] as const)(
    "correlates the explicit %s notification level",
    async (notification_level) => {
      const request = {
        ...argumentsValue,
        idempotency_key: `follow-amd-${notification_level}-v1`,
        notification_level,
      };
      const response = succeededResponse(request);
      const tool = createSetFollowTool(respondingClient(response, 200).client);

      await expect(tool.execute(request, context)).resolves.toEqual({
        payload: response,
      });
    },
  );

  it("accepts default or retained effective levels when an active command omits one", async () => {
    const request: FollowRequestFixture = {
      active: argumentsValue.active,
      idempotency_key: argumentsValue.idempotency_key,
      target_id: argumentsValue.target_id,
      target_type: argumentsValue.target_type,
    };
    for (const effectiveLevel of ["feed_only", "all_events"] as const) {
      const response = succeededResponse(request, effectiveLevel);
      const tool = createSetFollowTool(respondingClient(response, 200).client);

      await expect(tool.execute(request, context)).resolves.toEqual({
        payload: response,
      });
    }
  });

  it("ignores a supplied notification level when unsetting and requires a cleared result", async () => {
    const request = {
      ...argumentsValue,
      active: false,
      notification_level: "all_events" as const,
    };
    const response = succeededResponse(request);
    const tool = createSetFollowTool(respondingClient(response, 200).client);

    await expect(tool.execute(request, context)).resolves.toEqual({ payload: response });
    expect(response.result?.notification_level).toBeNull();
  });

  it.each([
    {
      label: "another target type",
      payload: {
        ...succeededResponse(),
        result: {
          ...succeededResponse().result!,
          target_id: "amd",
          target_type: "topic",
        },
      },
    },
    {
      label: "another target ID",
      payload: {
        ...succeededResponse(),
        result: { ...succeededResponse().result!, target_id: "MU" },
      },
    },
    {
      label: "another desired active state",
      payload: {
        ...succeededResponse(),
        result: {
          ...succeededResponse().result!,
          active: false,
          notification_level: null,
        },
      },
    },
    {
      label: "another explicit notification level",
      payload: {
        ...succeededResponse(),
        result: {
          ...succeededResponse().result!,
          notification_level: "all_events",
        },
      },
    },
    {
      label: "another request ID",
      payload: {
        ...succeededResponse(),
        request_id: "44444444-4444-4444-8444-444444444444",
      },
    },
  ])("rejects success for $label", async ({ payload }) => {
    const tool = createSetFollowTool(respondingClient(payload, 200).client);

    await expect(tool.execute(argumentsValue, context)).rejects.toMatchObject({
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
      statusCode: 404,
      isError: true,
    },
    {
      label: "authoritative write rate limit",
      payload: rateLimitedResponse,
      statusCode: 429,
      isError: true,
    },
  ])("maps $label without losing its write envelope", async (entry) => {
    const tool = createSetFollowTool(
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
    ["INVALID_ARGUMENT", 400],
    ["SCOPE_REQUIRED", 403],
    ["POLICY_DENIED", 403],
    ["TARGET_NOT_VISIBLE", 403],
    ["TARGET_NOT_FOUND", 404],
    ["FOLLOW_LIMIT_REACHED", 409],
    ["IDEMPOTENCY_CONFLICT", 409],
    ["IDEMPOTENCY_IN_PROGRESS", 409],
    ["SELF_FOLLOW_NOT_ALLOWED", 409],
    ["TARGET_AMBIGUOUS", 409],
    ["VALIDATION_ERROR", 422],
    ["RATE_LIMITED", 429],
    ["FOLLOW_DATA_INVALID", 503],
    ["FOLLOW_NOT_READY", 503],
    ["IDEMPOTENCY_RESULT_CORRUPT", 503],
    ["TEMPORARILY_UNAVAILABLE", 503],
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
    const tool = createSetFollowTool(respondingClient(payload, statusCode).client);

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
      "list-only V1 error",
      { ...v1ErrorResponse, error: { ...v1ErrorResponse.error, code: "CURSOR_INVALID" } },
      400,
    ],
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
    const tool = createSetFollowTool(respondingClient(payload, statusCode).client);

    await expect(tool.execute(argumentsValue, context)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "InternalMcpApiClientError",
    });
  });

  it("strictly parses every output branch and rejects malformed output", () => {
    const tool = createSetFollowTool(respondingClient(succeededResponse(), 200).client);

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

  it("rejects fabricated approval before status normalization", async () => {
    const tool = createSetFollowTool(
      respondingClient({ ...succeededResponse(), decision: "require_approval" }, 200)
        .client,
    );

    await expect(tool.execute(argumentsValue, context)).rejects.toThrow();
  });

  it("propagates private-client failures for protocol-level normalization", async () => {
    const upstreamError = new InternalMcpApiClientError("TIMEOUT");
    const request = vi.fn(() => Promise.reject(upstreamError));
    const tool = createSetFollowTool({ request });

    await expect(tool.execute(argumentsValue, context)).rejects.toBe(upstreamError);
    expect(request).toHaveBeenCalledOnce();
  });
});
