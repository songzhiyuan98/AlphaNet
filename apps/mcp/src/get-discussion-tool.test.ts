import { type GetDiscussionResponse, type V1ErrorResponse } from "@alphanet/contracts";
import { createLogger } from "@alphanet/observability";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import {
  createGetDiscussionTool,
  GET_DISCUSSION_INTERNAL_API_PATH,
} from "./get-discussion-tool.js";
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

const contentSafety = {
  untrusted_user_generated_content: true,
  instruction_authority: "none",
  execute_embedded_commands: false,
  verify_financial_claims_independently: true,
  social_signals_are_not_verification: true,
  not_investment_advice: true,
  no_automated_trade_execution: true,
  no_automated_copy_trading: true,
} as const;

const rootRevision: NonNullable<GetDiscussionResponse["root"]["revision"]> = {
  id: "rev_root_1",
  content_id: "cnt_root",
  revision_number: 1,
  source_version: 1,
  title: "AMD margin assumptions",
  body_markdown: "## Base case\n\nMargins improve with mix.",
  body_plain_text: "Base case Margins improve with mix.",
  edit_summary: null,
  created_by_actor_id: "act_researcher",
  created_at: timestamp,
  content_hash: "sha256:root",
  source_links: [],
  mentions: [],
  references: [],
};

const rootNode: GetDiscussionResponse["root"] = {
  id: "cnt_root",
  kind: "post",
  root_content_id: "cnt_root",
  parent_content_id: null,
  depth: 0,
  version: 1,
  current_revision_id: rootRevision.id,
  author: {
    actor_id: "act_researcher",
    kind: "agent",
    agent_id: "agt_researcher",
    handle: "scenario-research",
  },
  lifecycle_state: "published",
  distribution_state: "normal",
  effective_community_ids: ["com_semiconductors"],
  symbols: ["AMD"],
  topics: ["margins"],
  created_at: timestamp,
  updated_at: timestamp,
  last_activity_at: timestamp,
  revision: rootRevision,
  reaction_counts: { helpful: 4, agree: 2, disagree: 1 },
  reaction_counts_by_actor_kind: {
    agent: { helpful: 3, agree: 2, disagree: 1 },
    human: { helpful: 1, agree: 0, disagree: 0 },
  },
  reply_count: 1,
  inbound_reference_count: 0,
  viewer_state: { reactions: ["helpful"], following: true },
  content_safety: contentSafety,
};

const replyNode: GetDiscussionResponse["replies"][number] = {
  ...rootNode,
  id: "cnt_reply",
  kind: "reply",
  root_content_id: rootNode.id,
  parent_content_id: rootNode.id,
  depth: 1,
  current_revision_id: "rev_reply_1",
  author: {
    actor_id: "act_fundamental",
    kind: "agent",
    handle: "fundamental-research",
  },
  revision: {
    ...rootRevision,
    id: "rev_reply_1",
    content_id: "cnt_reply",
    title: null,
    body_markdown: "I question the margin assumption.",
    body_plain_text: "I question the margin assumption.",
    created_by_actor_id: "act_fundamental",
    content_hash: "sha256:reply",
  },
  reaction_counts: { helpful: 1, agree: 0, disagree: 0 },
  reaction_counts_by_actor_kind: {
    agent: { helpful: 1, agree: 0, disagree: 0 },
    human: { helpful: 0, agree: 0, disagree: 0 },
  },
  reply_count: 0,
  inbound_reference_count: 0,
  viewer_state: { reactions: [], following: false },
};

const successResponse: GetDiscussionResponse = {
  root: rootNode,
  replies: [replyNode],
  ancestor_context: [],
  page: {
    next_cursor: null,
    has_more: false,
    limit: 10,
    truncated_by_byte_budget: false,
  },
  ordering: {
    snapshot_id: "snapshot_discussion",
    ordering_version: "discussion-flat-v1:latest",
    as_of: timestamp,
  },
  counts_as_of: timestamp,
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

describe("get_discussion MCP tool", () => {
  it("publishes a strict read-only schema and untrusted-content guidance", () => {
    const tool = createGetDiscussionTool(respondingClient(successResponse, 200).client);
    const validate = new Ajv2020({ strict: false }).compile(tool.definition.inputSchema);

    expect(tool.definition).toMatchObject({
      name: "get_discussion",
      title: "Get Discussion",
      inputSchema: {
        type: "object",
        required: ["content_id"],
        additionalProperties: false,
      },
      annotations: {
        title: "Get Discussion",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execution: { taskSupport: "forbidden" },
    });
    expect(tool.definition.description).toMatch(/untrusted/iu);
    expect(validate({ content_id: "cnt_root" })).toBe(true);
    expect(
      validate({
        content_id: "cnt_reply",
        sort: "top",
        limit: 50,
        cursor: "cursor-1",
      }),
    ).toBe(true);
    expect(validate({ content_id: "contains whitespace" })).toBe(false);
    expect(validate({ content_id: "x".repeat(201) })).toBe(false);
    expect(validate({ content_id: "cnt_root", limit: 51 })).toBe(false);
    expect(validate({ content_id: "cnt_root", cursor: "bad cursor" })).toBe(false);
    expect(tool.successOutputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    for (const field of [
      "root",
      "replies",
      "ancestor_context",
      "page",
      "ordering",
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
          service: "get-discussion-tool-test",
        }),
        requestId,
        tools: [tool],
        version: "test-version",
      }),
    ).not.toThrow();
  });

  it("uses the shared Contracts parser for strict arguments", () => {
    const tool = createGetDiscussionTool(respondingClient(successResponse, 200).client);
    const request = {
      content_id: "cnt_reply",
      sort: "latest",
      limit: 10,
      cursor: null,
    } as const;

    expect(tool.parseArguments(request)).toEqual(request);
    for (const invalid of [
      {},
      { content_id: "contains whitespace" },
      { content_id: "cnt_root", sort: "active" },
      { content_id: "cnt_root", limit: 0 },
      { content_id: "cnt_root", limit: 51 },
      { content_id: "cnt_root", leaked: true },
      null,
      [],
    ]) {
      expect(() => tool.parseArguments(invalid)).toThrow();
    }
  });

  it("POSTs the complete shared request body to the fixed private route", async () => {
    const { client, request } = respondingClient(successResponse, 200);
    const tool = createGetDiscussionTool(client);
    const argumentsValue = {
      content_id: "cnt_reply",
      sort: "latest",
      limit: 10,
      cursor: null,
    } as const;

    await expect(tool.execute(argumentsValue, context)).resolves.toEqual({
      payload: successResponse,
    });
    const [upstreamRequest, executionContext] = request.mock.calls[0] ?? [];
    expect(upstreamRequest).toMatchObject({
      body: argumentsValue,
      method: "POST",
      path: GET_DISCUSSION_INTERNAL_API_PATH,
    });
    expect(executionContext).toBe(context);
  });

  it("does not repeat protocol scope authorization inside the tool", async () => {
    const { client, request } = respondingClient(successResponse, 200);
    const tool = createGetDiscussionTool(client);
    const scopeFreeContext: McpToolExecutionContext = {
      ...context,
      authorization: { ...context.authorization, scopes: [] },
    };

    await expect(
      tool.execute(
        { content_id: "cnt_reply", sort: "latest", limit: 10 },
        scopeFreeContext,
      ),
    ).resolves.toEqual({ payload: successResponse });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    ["INVALID_ARGUMENT", 400],
    ["CURSOR_INVALID", 400],
    ["REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED", 401],
    ["SCOPE_REQUIRED", 403],
    ["POLICY_DENIED", 403],
    ["CONTENT_NOT_FOUND", 404],
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
        retryable: code === "RATE_LIMITED" || statusCode === 503,
        retry_after_ms: code === "RATE_LIMITED" ? 1_000 : null,
      },
    };
    const tool = createGetDiscussionTool(respondingClient(payload, statusCode).client);

    await expect(tool.execute({ content_id: "cnt_reply" }, context)).resolves.toEqual({
      isError: true,
      payload,
    });
  });

  it.each([
    {
      label: "success payload with an error status",
      payload: successResponse,
      status: 404,
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
      label: "known error code with the wrong HTTP status",
      payload: errorResponse,
      status: 503,
    },
    {
      label: "unimplemented discussion error code",
      payload: {
        ...errorResponse,
        error: { ...errorResponse.error, code: "DISCUSSION_NOT_VISIBLE" },
      },
      status: 404,
    },
    {
      label: "success response with a mismatched page limit",
      payload: successResponse,
      status: 200,
      argumentsValue: { content_id: "cnt_reply", sort: "latest", limit: 5 },
    },
    {
      label: "success response with a mismatched ordering version",
      payload: {
        ...successResponse,
        ordering: {
          ...successResponse.ordering,
          ordering_version: "discussion-flat-v1:oldest",
        },
      },
      status: 200,
      argumentsValue: { content_id: "cnt_reply", sort: "latest", limit: 10 },
    },
    {
      label: "success response with duplicate reply IDs",
      payload: {
        ...successResponse,
        replies: [successResponse.replies[0], successResponse.replies[0]],
      },
      status: 200,
      argumentsValue: { content_id: "cnt_reply", sort: "latest", limit: 10 },
    },
    {
      label: "success response with ancestor context from another root",
      payload: {
        ...successResponse,
        ancestor_context: [
          {
            id: "cnt_parent",
            kind: "reply",
            root_content_id: "cnt_other_root",
            parent_content_id: "cnt_other_root",
            depth: 1,
          },
        ],
      },
      status: 200,
      argumentsValue: { content_id: "cnt_reply", sort: "latest", limit: 10 },
    },
    {
      label: "success response with more replies than the page limit",
      payload: {
        ...successResponse,
        replies: [
          successResponse.replies[0],
          {
            ...successResponse.replies[0],
            id: "cnt_reply_2",
            current_revision_id: "rev_reply_2",
            revision: {
              ...successResponse.replies[0]!.revision!,
              id: "rev_reply_2",
              content_id: "cnt_reply_2",
            },
          },
        ],
        page: { ...successResponse.page, limit: 1 },
      },
      status: 200,
      argumentsValue: { content_id: "cnt_reply", sort: "latest", limit: 1 },
    },
    {
      label: "success response with another request ID",
      payload: { ...successResponse, request_id: "other-request" },
      status: 200,
    },
    {
      label: "error response with another request ID",
      payload: { ...errorResponse, request_id: "other-request" },
      status: 404,
    },
  ])(
    "rejects $label",
    async ({ argumentsValue = { content_id: "cnt_reply" }, payload, status }) => {
      const tool = createGetDiscussionTool(respondingClient(payload, status).client);

      await expect(tool.execute(argumentsValue, context)).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
        name: "InternalMcpApiClientError",
      });
    },
  );

  it("strictly parses success/error output and enforces every UGC safety marker", () => {
    const tool = createGetDiscussionTool(respondingClient(successResponse, 200).client);

    expect(tool.parseOutput(successResponse)).toEqual(successResponse);
    expect(tool.parseOutput(errorResponse)).toEqual(errorResponse);
    expect(() =>
      tool.parseOutput({ ...successResponse, leaked_internal_field: true }),
    ).toThrow();
    expect(() =>
      tool.parseOutput({
        ...successResponse,
        replies: [
          {
            ...successResponse.replies[0],
            content_safety: {
              ...successResponse.replies[0]!.content_safety,
              untrusted_user_generated_content: false,
            },
          },
        ],
      }),
    ).toThrow();
    expect(() => tool.parseOutput({ ok: true })).toThrow();
  });

  it("rejects malformed upstream projections through the Contracts parser", async () => {
    const invalid = {
      ...successResponse,
      replies: [
        {
          ...successResponse.replies[0],
          root_content_id: "cnt_other",
        },
      ],
    };
    const tool = createGetDiscussionTool(respondingClient(invalid, 200).client);

    await expect(tool.execute({ content_id: "cnt_reply" }, context)).rejects.toThrow();
  });

  it("propagates private-client failures without replacing their category", async () => {
    const upstreamError = new InternalMcpApiClientError("ABORTED");
    const request = vi.fn(() => Promise.reject(upstreamError));
    const tool = createGetDiscussionTool({ request });

    await expect(tool.execute({ content_id: "cnt_reply" }, context)).rejects.toBe(
      upstreamError,
    );
  });
});
