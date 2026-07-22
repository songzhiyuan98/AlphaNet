import { type FindCommunitiesResponse, type V1ErrorResponse } from "@alphanet/contracts";
import { createLogger } from "@alphanet/observability";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import {
  createFindCommunitiesTool,
  FIND_COMMUNITIES_INTERNAL_API_PATH,
} from "./find-communities-tool.js";
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
const timestamp = "2026-07-20T12:00:00.000Z";

const context: McpToolExecutionContext = {
  authorization: {
    clientId: "agent-client",
    credentialId: "22222222-2222-4222-8222-222222222222",
    expiresAt: 1_800_000_000,
    grantId: "11111111-1111-4111-8111-111111111111",
    resource: "https://alphanet.example/mcp",
    scopes: ["community:read"],
    tokenJtiDigest: "A".repeat(43),
  },
  requestId,
  signal: new AbortController().signal,
};

const successResponse: FindCommunitiesResponse = {
  items: [
    {
      id: "com_semiconductors",
      slug: "semiconductors",
      name: "Semiconductors",
      kind: "topic",
      canonical_target: {
        type: "topic",
        id: "top_semiconductors",
        slug: "semiconductors",
      },
      state: "active",
      materialization_state: "materialized",
      matched_fields: ["description", "topics"],
      match_reasons: ["The proposed research matches this topic."],
      posting_policy_summary: {
        max_posts_per_hour: 6,
        requires_sources: false,
      },
      viewer_eligibility: {
        can_read: true,
        can_post: true,
        write_gate: "require_approval",
      },
    },
  ],
  page: {
    next_cursor: null,
    has_more: false,
    limit: 10,
  },
  ordering: {
    snapshot_id: "cms_01",
    ordering_version: "community-relevance-v1",
    as_of: timestamp,
  },
  request_id: requestId,
  schema_version: "1",
};

const errorResponse: V1ErrorResponse = {
  error: {
    code: "CURSOR_INVALID",
    message: "The Community directory cursor is invalid for this request.",
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

describe("find_communities MCP tool", () => {
  it("publishes explicit discovery intent and a read-only definition", () => {
    const tool = createFindCommunitiesTool(respondingClient(successResponse, 200).client);
    const validate = new Ajv2020({ strict: false }).compile(tool.definition.inputSchema);

    expect(tool.definition).toMatchObject({
      name: "find_communities",
      title: "Find Communities",
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      annotations: {
        title: "Find Communities",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execution: { taskSupport: "forbidden" },
    });
    expect(Array.isArray(tool.definition.inputSchema.anyOf)).toBe(true);
    expect(tool.definition.inputSchema.anyOf).toHaveLength(6);
    expect(validate({ query: "*" })).toBe(true);
    expect(validate({ symbols: ["AMD"] })).toBe(true);
    expect(validate({ topics: ["data-center"], cursor: null })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ query: "   " })).toBe(false);
    expect(validate({ query: "q".repeat(2_001) })).toBe(false);
    expect(validate({ symbols: ["AMD", "AMD"] })).toBe(false);
    expect(validate({ topics: ["data-center", "data-center"] })).toBe(false);
    expect(validate({ states: ["active", "active"] })).toBe(false);
    expect(validate({ query: "*", cursor: "bad cursor" })).toBe(false);
    expect(validate({ query: "*", cursor: "x".repeat(4_097) })).toBe(false);
    expect(validate({ query: "*", leaked: true })).toBe(false);
    expect(tool.successOutputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    for (const field of ["items", "page", "ordering", "request_id", "schema_version"]) {
      expect(tool.successOutputSchema.required).toContain(field);
    }
    expect(() =>
      createProtocolServer({
        executionRegistry: new McpExecutionRegistry(),
        logger: createLogger({
          environment: "test",
          level: "silent",
          service: "find-communities-tool-test",
        }),
        requestId,
        tools: [tool],
        version: "test-version",
      }),
    ).not.toThrow();
  });

  it("uses the shared Contracts parser as the authority for discovery inputs", () => {
    const tool = createFindCommunitiesTool(respondingClient(successResponse, 200).client);
    const request = {
      proposed_title: "AMD data-center scenarios",
      proposed_summary: "Supply-chain and margin assumptions.",
      states: ["active"],
      symbols: ["AMD"],
      topics: ["scenario-analysis"],
      limit: 10,
      cursor: null,
    };

    expect(tool.parseArguments(request)).toEqual(request);
    expect(tool.parseArguments({ query: "*" })).toEqual({ query: "*" });
    for (const invalid of [
      {},
      { query: "   " },
      { query: "*", limit: 101 },
      { symbols: ["AMD", "AMD"] },
      { topics: ["Data-Center"] },
      { query: "*", cursor: "bad cursor" },
      { query: "*", leaked: true },
      null,
      [],
    ]) {
      expect(() => tool.parseArguments(invalid)).toThrow();
    }
  });

  it("posts the complete parsed request to the fixed private route", async () => {
    const requestBody = {
      proposed_title: "AMD data-center scenarios",
      symbols: ["AMD"],
      limit: 10,
    };
    const { client, request } = respondingClient(successResponse, 200);
    const tool = createFindCommunitiesTool(client);
    const contextWithoutScopes: McpToolExecutionContext = {
      ...context,
      authorization: { ...context.authorization, scopes: [] },
    };

    await expect(tool.execute(requestBody, contextWithoutScopes)).resolves.toEqual({
      payload: successResponse,
    });
    const [upstreamRequest, executionContext] = request.mock.calls[0] ?? [];
    expect(upstreamRequest).toMatchObject({
      body: requestBody,
      method: "POST",
      path: FIND_COMMUNITIES_INTERNAL_API_PATH,
    });
    expect(executionContext).toBe(contextWithoutScopes);
  });

  it.each([
    ["INVALID_ARGUMENT", 400],
    ["REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED", 401],
    ["POLICY_DENIED", 403],
    ["CURSOR_INVALID", 400],
    ["CURSOR_EXPIRED", 410],
    ["SNAPSHOT_EXPIRED", 410],
    ["RATE_LIMITED", 429],
    ["DIRECTORY_DATA_INVALID", 503],
    ["DIRECTORY_NOT_READY", 503],
  ])("returns %s only with its exact HTTP %s status", async (code, statusCode) => {
    const payload: V1ErrorResponse = {
      ...errorResponse,
      error: {
        ...errorResponse.error,
        code,
        retryable:
          code === "RATE_LIMITED" ||
          code === "DIRECTORY_DATA_INVALID" ||
          code === "DIRECTORY_NOT_READY",
        retry_after_ms: code === "RATE_LIMITED" ? 1_000 : null,
      },
    };
    const tool = createFindCommunitiesTool(respondingClient(payload, statusCode).client);

    await expect(tool.execute({ query: "*" }, context)).resolves.toEqual({
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
      label: "error payload with redirect status",
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
        error: { ...errorResponse.error, code: "COMMUNITY_NOT_FOUND" },
      },
      status: 404,
    },
    {
      label: "success with a different requested page limit",
      payload: {
        ...successResponse,
        page: { ...successResponse.page, limit: 20 },
      },
      status: 200,
    },
    {
      label: "success response with another request ID",
      payload: {
        ...successResponse,
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
    const tool = createFindCommunitiesTool(respondingClient(payload, status).client);

    await expect(tool.execute({ query: "*", limit: 10 }, context)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "InternalMcpApiClientError",
    });
  });

  it.each([
    {
      label: "more items than the response page limit",
      argumentsValue: { query: "*" },
      payload: {
        ...successResponse,
        items: [
          successResponse.items[0]!,
          {
            ...successResponse.items[0]!,
            id: "com_energy",
            slug: "energy",
            name: "Energy",
            canonical_target: {
              type: "topic" as const,
              id: "top_energy",
              slug: "energy",
            },
          },
        ],
        page: { ...successResponse.page, limit: 1 },
      },
    },
    {
      label: "duplicate Community IDs",
      argumentsValue: { query: "*" },
      payload: {
        ...successResponse,
        items: [successResponse.items[0]!, successResponse.items[0]!],
      },
    },
    {
      label: "an item outside the requested state filter",
      argumentsValue: { states: ["archived"] },
      payload: successResponse,
    },
  ])("rejects success with $label", async ({ argumentsValue, payload }) => {
    const tool = createFindCommunitiesTool(respondingClient(payload, 200).client);

    await expect(tool.execute(argumentsValue, context)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "InternalMcpApiClientError",
    });
  });

  it("propagates private-client failures without replacing their category", async () => {
    const upstreamError = new InternalMcpApiClientError("TIMEOUT");
    const request = vi.fn(() => Promise.reject(upstreamError));
    const tool = createFindCommunitiesTool({ request });

    await expect(tool.execute({ query: "*" }, context)).rejects.toBe(upstreamError);
  });

  it("strictly parses success/error output and rejects leaked fields", () => {
    const tool = createFindCommunitiesTool(respondingClient(successResponse, 200).client);

    expect(tool.parseOutput(successResponse)).toEqual(successResponse);
    expect(tool.parseOutput(errorResponse)).toEqual(errorResponse);
    expect(() =>
      tool.parseOutput({ ...successResponse, selected_community_id: "com_hidden" }),
    ).toThrow();
    expect(() => tool.parseOutput({ ok: true })).toThrow();
  });

  it("rejects malformed upstream projections through the Contracts parser", async () => {
    const invalid = {
      ...successResponse,
      page: { ...successResponse.page, has_more: true },
    };
    const tool = createFindCommunitiesTool(respondingClient(invalid, 200).client);

    await expect(tool.execute({ query: "*" }, context)).rejects.toThrow();
  });
});
