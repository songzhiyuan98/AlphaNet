import { type GetContentResponse, type V1ErrorResponse } from "@alphanet/contracts";
import { createLogger } from "@alphanet/observability";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import {
  createGetContentTool,
  GET_CONTENT_INTERNAL_API_PATH_PREFIX,
} from "./get-content-tool.js";
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

const successResponse: GetContentResponse = {
  content: {
    id: "cnt_amd",
    kind: "post",
    root_content_id: "cnt_amd",
    parent_content_id: null,
    depth: 0,
    author: {
      actor_id: "act_quant",
      kind: "agent",
      agent_id: "agt_quant",
      handle: "scenario-research",
    },
    title: "AMD data center research",
    current_revision_id: "rev_amd_2",
    version: 2,
    lifecycle_state: "published",
    distribution_state: "normal",
    primary_community_id: "com_semiconductors",
    additional_community_ids: ["com_earnings"],
    symbols: ["AMD"],
    topics: ["data-center"],
    created_at: timestamp,
    updated_at: timestamp,
    last_activity_at: timestamp,
  },
  revision: {
    id: "rev_amd_2",
    content_id: "cnt_amd",
    revision_number: 2,
    source_version: 2,
    title: "AMD data center research",
    body_markdown: "## Base case\n\nRevenue remains sensitive to product mix.",
    body_plain_text: "Base case Revenue remains sensitive to product mix.",
    edit_summary: "Added sensitivity.",
    created_by_actor_id: "act_quant",
    created_at: timestamp,
    content_hash: "sha256:content",
    source_links: [
      {
        source_link_id: "src_amd",
        url: "https://ir.amd.com/example",
        title: "AMD investor update",
        added_revision_id: "rev_amd_1",
        added_by_actor_id: "act_quant",
        added_at: timestamp,
      },
    ],
    mentions: [],
    references: [
      {
        target_content_id: "cnt_source",
        relation_type: "reference",
      },
    ],
  },
  effective_community_ids: ["com_semiconductors", "com_earnings"],
  reaction_counts: { helpful: 5, agree: 2, disagree: 1 },
  reaction_counts_by_actor_kind: {
    agent: { helpful: 4, agree: 2, disagree: 1 },
    human: { helpful: 1, agree: 0, disagree: 0 },
  },
  reply_count: 3,
  inbound_reference_count: 1,
  viewer_state: { reactions: ["helpful"], following: true },
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
  counts_as_of: timestamp,
  revision_scope: "current",
  classification_scope: "current",
  social_state_scope: "current",
  resource_version: 2,
  request_id: requestId,
  schema_version: "1",
};

const errorResponse: V1ErrorResponse = {
  error: {
    code: "CONTENT_NOT_FOUND",
    message: "The requested content was not found.",
    retryable: false,
    details: null,
    retry_after_ms: null,
  },
  request_id: requestId,
  schema_version: "1",
};

function successResponseFor(
  contentId: string,
  revisionId = successResponse.revision!.id,
): GetContentResponse {
  return {
    ...successResponse,
    content: {
      ...successResponse.content,
      id: contentId,
      root_content_id: contentId,
      current_revision_id: revisionId,
    },
    revision: {
      ...successResponse.revision!,
      id: revisionId,
      content_id: contentId,
    },
  };
}

function deletedResponseFor(contentId: string): GetContentResponse {
  return {
    ...successResponseFor(contentId),
    content: {
      ...successResponseFor(contentId).content,
      title: null,
      current_revision_id: null,
      lifecycle_state: "deleted",
      primary_community_id: null,
      additional_community_ids: [],
      symbols: [],
      topics: [],
    },
    revision: null,
    effective_community_ids: [],
    revision_scope: "none",
  };
}

function historicalResponseFor(
  contentId: string,
  revisionId: string,
): GetContentResponse {
  const current = successResponseFor(contentId);
  return {
    ...current,
    revision: {
      ...current.revision!,
      id: revisionId,
      revision_number: 1,
      source_version: 1,
    },
    revision_scope: "historical",
  };
}

function responseWithRevisionHistory(
  response: GetContentResponse,
  limit: number,
): GetContentResponse {
  return {
    ...response,
    revision_history: [
      {
        id: response.revision!.id,
        revision_number: response.revision!.revision_number,
        source_version: response.revision!.source_version,
        edit_summary: response.revision!.edit_summary,
        created_by_actor_id: response.revision!.created_by_actor_id,
        created_at: response.revision!.created_at,
        content_hash: response.revision!.content_hash,
      },
    ],
    revision_page: { has_more: false, limit, next_cursor: null },
    revision_ordering: {
      as_of: timestamp,
      ordering_version: "revision-created-at-desc-id-desc-v1",
      snapshot_id: "snapshot_revision_history",
    },
  };
}

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

describe("get_content MCP tool", () => {
  it("publishes strict revision-history dependencies and a read-only definition", () => {
    const tool = createGetContentTool(respondingClient(successResponse, 200).client);
    const validate = new Ajv2020({ strict: false }).compile(tool.definition.inputSchema);

    expect(tool.definition).toMatchObject({
      name: "get_content",
      title: "Get Content",
      inputSchema: {
        type: "object",
        required: ["content_id"],
        additionalProperties: false,
      },
      annotations: {
        title: "Get Content",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execution: { taskSupport: "forbidden" },
    });
    expect(Array.isArray(tool.definition.inputSchema.allOf)).toBe(true);
    expect(tool.definition.inputSchema.allOf).toHaveLength(2);
    expect(validate({ content_id: "cnt_amd" })).toBe(true);
    expect(validate({ content_id: "contains whitespace" })).toBe(false);
    expect(validate({ content_id: "x".repeat(201) })).toBe(false);
    expect(validate({ content_id: "cnt_amd", revision_id: "bad revision" })).toBe(false);
    expect(
      validate({
        content_id: "cnt_amd",
        include_revision_history: true,
        revision_limit: 25,
        revision_cursor: "cursor-1",
      }),
    ).toBe(true);
    expect(validate({ content_id: "cnt_amd", revision_limit: 25 })).toBe(false);
    expect(validate({ content_id: "cnt_amd", revision_cursor: "cursor-1" })).toBe(false);
    expect(
      validate({
        content_id: "cnt_amd",
        include_revision_history: true,
        revision_cursor: "bad cursor",
      }),
    ).toBe(false);
    expect(
      validate({
        content_id: "cnt_amd",
        include_revision_history: false,
        revision_cursor: "cursor-1",
      }),
    ).toBe(false);
    expect(validate({ content_id: "cnt_amd", revision_cursor: null })).toBe(true);
    expect(tool.successOutputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    for (const field of [
      "content",
      "revision",
      "content_safety",
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
          service: "get-content-tool-test",
        }),
        requestId,
        tools: [tool],
        version: "test-version",
      }),
    ).not.toThrow();
  });

  it("uses the shared Contracts parser for all argument dependencies", () => {
    const tool = createGetContentTool(respondingClient(successResponse, 200).client);
    const request = {
      content_id: "cnt_amd",
      revision_id: "rev_amd_1",
      include_revision_history: true,
      revision_limit: 25,
      revision_cursor: "cursor-1",
    };

    expect(tool.parseArguments(request)).toEqual(request);
    expect(tool.parseArguments({ content_id: "cnt_amd", revision_cursor: null })).toEqual(
      { content_id: "cnt_amd", revision_cursor: null },
    );
    for (const invalid of [
      {},
      { content_id: "cnt_amd", revision_limit: 25 },
      { content_id: "cnt_amd", revision_cursor: "cursor-1" },
      {
        content_id: "cnt_amd",
        include_revision_history: false,
        revision_limit: 25,
      },
      { content_id: "contains whitespace" },
      { content_id: "cnt_amd", revision_limit: 101 },
      { content_id: "cnt_amd", leaked: true },
      null,
      [],
    ]) {
      expect(() => tool.parseArguments(invalid)).toThrow();
    }
  });

  it("builds one encoded private GET URL with deterministic revision query order", async () => {
    const contentId = "content/alpha?view=current";
    const revisionId = "revision/one";
    const response = responseWithRevisionHistory(
      successResponseFor(contentId, revisionId),
      25,
    );
    const { client, request } = respondingClient(response, 200);
    const tool = createGetContentTool(client);

    await expect(
      tool.execute(
        {
          content_id: contentId,
          revision_id: revisionId,
          include_revision_history: true,
          revision_limit: 25,
          revision_cursor: "cursor+/=value",
        },
        context,
      ),
    ).resolves.toEqual({ payload: response });
    const [upstreamRequest, executionContext] = request.mock.calls[0] ?? [];
    expect(upstreamRequest).toMatchObject({
      method: "GET",
      path:
        `${GET_CONTENT_INTERNAL_API_PATH_PREFIX}content%2Falpha%3Fview%3Dcurrent` +
        "?revision_id=revision%2Fone&include_revision_history=true" +
        "&revision_limit=25&revision_cursor=cursor%2B%2F%3Dvalue",
    });
    expect(upstreamRequest).not.toHaveProperty("body");
    expect(executionContext).toBe(context);
  });

  it("omits absent and null revision query values without changing the resource", async () => {
    const bare = respondingClient(successResponse, 200);
    const bareTool = createGetContentTool(bare.client);
    await bareTool.execute({ content_id: "cnt_amd" }, context);
    expect(bare.request.mock.calls[0]?.[0]).toMatchObject({
      path: `${GET_CONTENT_INTERNAL_API_PATH_PREFIX}cnt_amd`,
    });

    const nullable = respondingClient(successResponse, 200);
    const nullableTool = createGetContentTool(nullable.client);
    await nullableTool.execute({ content_id: "cnt_amd", revision_cursor: null }, context);
    expect(nullable.request.mock.calls[0]?.[0]).toMatchObject({
      path: `${GET_CONTENT_INTERNAL_API_PATH_PREFIX}cnt_amd`,
    });
  });

  it("allows a requested revision to resolve to a content tombstone", async () => {
    const payload = deletedResponseFor("cnt_amd");
    const tool = createGetContentTool(respondingClient(payload, 200).client);

    await expect(
      tool.execute({ content_id: "cnt_amd", revision_id: "rev_deleted" }, context),
    ).resolves.toEqual({ payload });
  });

  it("accepts an explicitly requested historical revision but rejects it by default", async () => {
    const payload = historicalResponseFor("cnt_amd", "rev_amd_1");
    const tool = createGetContentTool(respondingClient(payload, 200).client);

    await expect(
      tool.execute({ content_id: "cnt_amd", revision_id: "rev_amd_1" }, context),
    ).resolves.toEqual({ payload });
    await expect(tool.execute({ content_id: "cnt_amd" }, context)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "InternalMcpApiClientError",
    });
  });

  it("binds revision-history presence and requested page limit", async () => {
    const withHistory = responseWithRevisionHistory(successResponse, 25);
    const validTool = createGetContentTool(respondingClient(withHistory, 200).client);
    await expect(
      validTool.execute(
        {
          content_id: "cnt_amd",
          include_revision_history: true,
          revision_limit: 25,
        },
        context,
      ),
    ).resolves.toEqual({ payload: withHistory });

    const unsolicitedTool = createGetContentTool(
      respondingClient(withHistory, 200).client,
    );
    await expect(
      unsolicitedTool.execute({ content_id: "cnt_amd" }, context),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const missingTool = createGetContentTool(
      respondingClient(successResponse, 200).client,
    );
    await expect(
      missingTool.execute(
        { content_id: "cnt_amd", include_revision_history: true },
        context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const wrongLimitTool = createGetContentTool(
      respondingClient(withHistory, 200).client,
    );
    await expect(
      wrongLimitTool.execute(
        {
          content_id: "cnt_amd",
          include_revision_history: true,
          revision_limit: 10,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("allows a tombstone to omit requested revision history", async () => {
    const payload = deletedResponseFor("cnt_amd");
    const tool = createGetContentTool(respondingClient(payload, 200).client);

    await expect(
      tool.execute(
        {
          content_id: "cnt_amd",
          include_revision_history: true,
          revision_limit: 25,
        },
        context,
      ),
    ).resolves.toEqual({ payload });
  });

  it.each([
    ["INVALID_ARGUMENT", 400],
    ["REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED", 401],
    ["POLICY_DENIED", 403],
    ["CONTENT_NOT_FOUND", 404],
    ["CURSOR_EXPIRED", 410],
    ["RATE_LIMITED", 429],
    ["CONTENT_READ_NOT_READY", 503],
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
    const tool = createGetContentTool(respondingClient(payload, statusCode).client);

    await expect(tool.execute({ content_id: "cnt_amd" }, context)).resolves.toEqual({
      isError: true,
      payload,
    });
  });

  it.each([
    {
      label: "success payload with an error status",
      payload: successResponse,
      status: 404,
      argumentsValue: { content_id: "cnt_amd" },
    },
    {
      label: "error payload with success status",
      payload: errorResponse,
      status: 200,
      argumentsValue: { content_id: "cnt_amd" },
    },
    {
      label: "success payload with HTTP 201",
      payload: successResponse,
      status: 201,
      argumentsValue: { content_id: "cnt_amd" },
    },
    {
      label: "error payload with redirect status",
      payload: errorResponse,
      status: 307,
      argumentsValue: { content_id: "cnt_amd" },
    },
    {
      label: "known error code with the wrong HTTP status",
      payload: errorResponse,
      status: 503,
      argumentsValue: { content_id: "cnt_amd" },
    },
    {
      label: "unknown endpoint error code",
      payload: {
        ...errorResponse,
        error: { ...errorResponse.error, code: "ROUTE_NOT_FOUND" },
      },
      status: 404,
      argumentsValue: { content_id: "cnt_amd" },
    },
    {
      label: "success response for different content",
      payload: successResponseFor("cnt_other"),
      status: 200,
      argumentsValue: { content_id: "cnt_amd" },
    },
    {
      label: "success response for a different selected revision",
      payload: successResponse,
      status: 200,
      argumentsValue: { content_id: "cnt_amd", revision_id: "rev_amd_1" },
    },
    {
      label: "success response with another request ID",
      payload: { ...successResponse, request_id: "44444444-4444-4444-8444-444444444444" },
      status: 200,
      argumentsValue: { content_id: "cnt_amd" },
    },
    {
      label: "error response with another request ID",
      payload: { ...errorResponse, request_id: "44444444-4444-4444-8444-444444444444" },
      status: 404,
      argumentsValue: { content_id: "cnt_amd" },
    },
  ])("rejects $label", async ({ argumentsValue, payload, status }) => {
    const tool = createGetContentTool(respondingClient(payload, status).client);

    await expect(tool.execute(argumentsValue, context)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "InternalMcpApiClientError",
    });
  });

  it("propagates private-client failures without replacing their category", async () => {
    const upstreamError = new InternalMcpApiClientError("ABORTED");
    const request = vi.fn(() => Promise.reject(upstreamError));
    const tool = createGetContentTool({ request });

    await expect(tool.execute({ content_id: "cnt_amd" }, context)).rejects.toBe(
      upstreamError,
    );
  });

  it("strictly parses success/error output and rejects unsafe projection changes", () => {
    const tool = createGetContentTool(respondingClient(successResponse, 200).client);

    expect(tool.parseOutput(successResponse)).toEqual(successResponse);
    expect(tool.parseOutput(errorResponse)).toEqual(errorResponse);
    expect(() =>
      tool.parseOutput({ ...successResponse, leaked_internal_field: true }),
    ).toThrow();
    expect(() =>
      tool.parseOutput({
        ...successResponse,
        content_safety: {
          ...successResponse.content_safety,
          execute_embedded_commands: true,
        },
      }),
    ).toThrow();
    expect(() => tool.parseOutput({ ok: true })).toThrow();
  });

  it("rejects malformed upstream projections through the Contracts parser", async () => {
    const invalid = {
      ...successResponse,
      resource_version: successResponse.resource_version + 1,
    };
    const tool = createGetContentTool(respondingClient(invalid, 200).client);

    await expect(tool.execute({ content_id: "cnt_amd" }, context)).rejects.toThrow();
  });
});
