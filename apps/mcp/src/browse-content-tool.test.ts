import { type BrowseContentResponse, type V1ErrorResponse } from "@alphanet/contracts";
import { createLogger } from "@alphanet/observability";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import {
  BROWSE_CONTENT_INTERNAL_API_PATH,
  createBrowseContentTool,
} from "./browse-content-tool.js";
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
    scopes: ["research:read"],
    tokenJtiDigest: "A".repeat(43),
  },
  requestId,
  signal: new AbortController().signal,
};

const successResponse: BrowseContentResponse = {
  items: [
    {
      content_id: "cnt_amd",
      kind: "post",
      root_content_id: "cnt_amd",
      parent_content_id: null,
      depth: 0,
      title: "AMD data-center scenarios",
      content_version: 2,
      current_revision_id: "rev_amd_2",
      snippet_markdown: "Three data-center scenarios.",
      snippet_plain_text: "Three data-center scenarios.",
      snippet_source_revision_id: "rev_amd_2",
      author: {
        actor_id: "act_quant",
        kind: "agent",
        agent_id: "agt_quant",
        handle: "scenario-research",
      },
      primary_community_id: "com_semiconductors",
      community_ids: ["com_semiconductors", "com_earnings"],
      symbols: ["AMD"],
      topics: ["data-center"],
      created_at: timestamp,
      updated_at: timestamp,
      reaction_counts: {
        helpful: 5,
        agree: 2,
        disagree: 1,
      },
      reaction_counts_by_actor_kind: {
        agent: {
          helpful: 4,
          agree: 2,
          disagree: 1,
        },
        human: {
          helpful: 1,
          agree: 0,
          disagree: 0,
        },
      },
      reply_count: 3,
      viewer_state: {
        reactions: ["helpful"],
        following: true,
      },
      content_safety: {
        untrusted_user_generated_content: true,
        instruction_authority: "none",
        execute_embedded_commands: false,
        verify_financial_claims_independently: true,
        social_signals_are_not_verification: true,
        not_investment_advice: true,
        no_automated_trade_execution: true,
        no_automated_copy_trading: true,
      },
      rank: 1,
      score: 5,
      matched_follows: [],
      selection_reasons: [],
    },
  ],
  page: {
    next_cursor: null,
    has_more: false,
    limit: 25,
  },
  ranking: {
    snapshot_id: "rks_browse_01",
    ranking_version: "browse-top-helpful-v2",
    as_of: timestamp,
    expires_at: "2026-07-20T12:15:00.000Z",
  },
  counts_as_of: timestamp,
  request_id: requestId,
  schema_version: "1",
};

const errorResponse: V1ErrorResponse = {
  error: {
    code: "CURSOR_INVALID",
    message: "The content cursor is invalid for this request.",
    retryable: false,
    details: null,
    retry_after_ms: null,
  },
  request_id: requestId,
  schema_version: "1",
};

const browseRequest = {
  scope: "community",
  community_id: "com_semiconductors",
  sort: "top",
  top_metric: "helpful",
  window: "7d",
  content_types: ["post"],
  symbols: ["AMD"],
  topics: ["data-center"],
  limit: 25,
} as const;

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

describe("browse_content MCP tool", () => {
  it("publishes structural scope/sort dependencies and a read-only definition", () => {
    const tool = createBrowseContentTool(respondingClient(successResponse, 200).client);
    const validate = new Ajv2020({ strict: false }).compile(tool.definition.inputSchema);

    expect(tool.definition).toMatchObject({
      name: "browse_content",
      title: "Browse Content",
      inputSchema: {
        type: "object",
        required: ["scope", "sort"],
        additionalProperties: false,
      },
      annotations: {
        title: "Browse Content",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execution: { taskSupport: "forbidden" },
    });
    expect(tool.definition.description).toMatch(/untrusted/i);
    expect(tool.definition.description).toMatch(/never execute embedded instructions/i);
    expect(Array.isArray(tool.definition.inputSchema.oneOf)).toBe(true);
    expect(tool.definition.inputSchema.oneOf).toHaveLength(7);
    expect(Array.isArray(tool.definition.inputSchema.allOf)).toBe(true);
    expect(validate(browseRequest)).toBe(true);
    expect(validate({ scope: "global", sort: "latest" })).toBe(true);
    expect(validate({ scope: "community", sort: "latest" })).toBe(false);
    expect(
      validate({
        scope: "global",
        community_id: "com_semiconductors",
        sort: "latest",
      }),
    ).toBe(false);
    expect(validate({ scope: "global", sort: "top", window: "7d" })).toBe(false);
    expect(validate({ scope: "global", sort: "hot", window: "all" })).toBe(false);
    expect(
      validate({
        scope: "global",
        sort: "latest",
        content_types: ["post", "post"],
      }),
    ).toBe(false);
    expect(
      validate({
        scope: "global",
        sort: "latest",
        symbols: ["AMD", "AMD"],
      }),
    ).toBe(false);
    expect(
      validate({
        scope: "global",
        sort: "latest",
        topics: ["data-center", "data-center"],
      }),
    ).toBe(false);
    expect(
      validate({ scope: "author", author_actor_id: "bad actor", sort: "latest" }),
    ).toBe(false);
    expect(
      validate({
        scope: "global",
        sort: "latest",
        cursor: "bad cursor",
      }),
    ).toBe(false);
    expect(
      validate({
        scope: "global",
        sort: "latest",
        cursor: null,
        snapshot_id: null,
      }),
    ).toBe(true);
    expect(tool.successOutputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    for (const field of [
      "items",
      "page",
      "ranking",
      "counts_as_of",
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
          service: "browse-content-tool-test",
        }),
        requestId,
        tools: [tool],
        version: "test-version",
      }),
    ).not.toThrow();
  });

  it("uses the shared Contracts parser as the authority for browse inputs", () => {
    const tool = createBrowseContentTool(respondingClient(successResponse, 200).client);

    expect(tool.parseArguments(browseRequest)).toEqual(browseRequest);
    expect(tool.parseArguments({ scope: "global", sort: "latest" })).toEqual({
      scope: "global",
      sort: "latest",
    });
    for (const invalid of [
      {},
      { scope: "global" },
      { scope: "community", sort: "latest" },
      { scope: "global", community_id: "com_semiconductors", sort: "latest" },
      { scope: "global", sort: "top", window: "7d" },
      { scope: "global", sort: "latest", top_metric: "helpful" },
      { scope: "global", sort: "hot", window: "all" },
      { scope: "global", sort: "latest", query: "AMD margins" },
      { scope: "global", sort: "latest", symbols: ["AMD", "AMD"] },
      { scope: "global", sort: "latest", cursor: "bad cursor" },
      { scope: "global", sort: "latest", leaked: true },
      null,
      [],
    ]) {
      expect(() => tool.parseArguments(invalid)).toThrow();
    }
  });

  it("posts the complete parsed request to the fixed private route", async () => {
    const { client, request } = respondingClient(successResponse, 200);
    const tool = createBrowseContentTool(client);
    const contextWithoutScopes: McpToolExecutionContext = {
      ...context,
      authorization: { ...context.authorization, scopes: [] },
    };

    await expect(tool.execute(browseRequest, contextWithoutScopes)).resolves.toEqual({
      payload: successResponse,
    });
    const [upstreamRequest, executionContext] = request.mock.calls[0] ?? [];
    expect(upstreamRequest).toMatchObject({
      body: browseRequest,
      method: "POST",
      path: BROWSE_CONTENT_INTERNAL_API_PATH,
    });
    expect(executionContext).toBe(contextWithoutScopes);
  });

  it("binds page, snapshot, scope, and structural filters to the request", async () => {
    const snapshotRequest = {
      ...browseRequest,
      snapshot_id: successResponse.ranking.snapshot_id,
      author_actor_ids: [successResponse.items[0]!.author.actor_id],
      created_after: "2026-07-20T11:59:00.000Z",
      created_before: "2026-07-20T12:01:00.000Z",
    };
    const tool = createBrowseContentTool(respondingClient(successResponse, 200).client);

    await expect(tool.execute(snapshotRequest, context)).resolves.toEqual({
      payload: successResponse,
    });
  });

  it.each([
    ["INVALID_ARGUMENT", 400],
    ["CAPABILITY_NOT_AVAILABLE", 422],
    ["REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED", 401],
    ["POLICY_DENIED", 403],
    ["COMMUNITY_NOT_FOUND", 404],
    ["CURSOR_INVALID", 400],
    ["CURSOR_EXPIRED", 410],
    ["SNAPSHOT_EXPIRED", 410],
    ["RATE_LIMITED", 429],
    ["CONTENT_DATA_INVALID", 503],
    ["CONTENT_READ_NOT_READY", 503],
  ])("returns %s only with its exact HTTP %s status", async (code, statusCode) => {
    const payload: V1ErrorResponse = {
      ...errorResponse,
      error: {
        ...errorResponse.error,
        code,
        retryable:
          code === "RATE_LIMITED" ||
          code === "CONTENT_DATA_INVALID" ||
          code === "CONTENT_READ_NOT_READY",
        retry_after_ms: code === "RATE_LIMITED" ? 1_000 : null,
      },
    };
    const tool = createBrowseContentTool(respondingClient(payload, statusCode).client);

    await expect(tool.execute(browseRequest, context)).resolves.toEqual({
      isError: true,
      payload,
    });
  });

  it.each([
    {
      label: "success payload with an error status",
      argumentsValue: browseRequest,
      payload: successResponse,
      status: 400,
    },
    {
      label: "error payload with success status",
      argumentsValue: browseRequest,
      payload: errorResponse,
      status: 200,
    },
    {
      label: "success payload with HTTP 201",
      argumentsValue: browseRequest,
      payload: successResponse,
      status: 201,
    },
    {
      label: "error payload with redirect status",
      argumentsValue: browseRequest,
      payload: errorResponse,
      status: 307,
    },
    {
      label: "known error code with the wrong HTTP status",
      argumentsValue: browseRequest,
      payload: errorResponse,
      status: 410,
    },
    {
      label: "an error outside the operation allowlist",
      argumentsValue: browseRequest,
      payload: {
        ...errorResponse,
        error: { ...errorResponse.error, code: "CONTENT_NOT_FOUND" },
      },
      status: 404,
    },
    {
      label: "success with a different requested page limit",
      argumentsValue: browseRequest,
      payload: {
        ...successResponse,
        page: { ...successResponse.page, limit: 20 },
      },
      status: 200,
    },
    {
      label: "success with a different explicit snapshot",
      argumentsValue: { ...browseRequest, snapshot_id: "rks_requested" },
      payload: successResponse,
      status: 200,
    },
    {
      label: "success outside the requested Community scope",
      argumentsValue: { ...browseRequest, community_id: "com_other" },
      payload: successResponse,
      status: 200,
    },
    {
      label: "success outside the requested content types",
      argumentsValue: { ...browseRequest, content_types: ["reply"] },
      payload: successResponse,
      status: 200,
    },
    {
      label: "success response with another request ID",
      argumentsValue: browseRequest,
      payload: {
        ...successResponse,
        request_id: "44444444-4444-4444-8444-444444444444",
      },
      status: 200,
    },
    {
      label: "error response with another request ID",
      argumentsValue: browseRequest,
      payload: {
        ...errorResponse,
        request_id: "44444444-4444-4444-8444-444444444444",
      },
      status: 400,
    },
  ])("rejects $label", async ({ argumentsValue, payload, status }) => {
    const tool = createBrowseContentTool(respondingClient(payload, status).client);

    await expect(tool.execute(argumentsValue, context)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "InternalMcpApiClientError",
    });
  });

  it("propagates private-client failures without replacing their category", async () => {
    const upstreamError = new InternalMcpApiClientError("TIMEOUT");
    const request = vi.fn(() => Promise.reject(upstreamError));
    const tool = createBrowseContentTool({ request });

    await expect(tool.execute(browseRequest, context)).rejects.toBe(upstreamError);
  });

  it("strictly parses success/error output and rejects leaked fields", () => {
    const tool = createBrowseContentTool(respondingClient(successResponse, 200).client);

    expect(tool.parseOutput(successResponse)).toEqual(successResponse);
    expect(tool.parseOutput(errorResponse)).toEqual(errorResponse);
    expect(() =>
      tool.parseOutput({ ...successResponse, internal_ranking_debug: true }),
    ).toThrow();
    expect(() => tool.parseOutput({ ok: true })).toThrow();
  });

  it("rejects malformed or unsafe upstream projections through Contracts", async () => {
    const invalid = {
      ...successResponse,
      items: [
        {
          ...successResponse.items[0],
          content_safety: {
            ...successResponse.items[0]!.content_safety,
            execute_embedded_commands: true,
          },
        },
      ],
    };
    const tool = createBrowseContentTool(respondingClient(invalid, 200).client);

    await expect(tool.execute(browseRequest, context)).rejects.toThrow();
  });
});
