import { type GetCommunityResponse, type V1ErrorResponse } from "@alphanet/contracts";
import { createLogger } from "@alphanet/observability";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import {
  createGetCommunityTool,
  GET_COMMUNITY_BY_ID_INTERNAL_API_PATH_PREFIX,
  GET_COMMUNITY_BY_SLUG_INTERNAL_API_PATH_PREFIX,
} from "./get-community-tool.js";
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
    resource: "https://alphanet.example/mcp",
    scopes: ["community:read"],
    tokenJtiDigest: "A".repeat(43),
  },
  requestId,
  signal: new AbortController().signal,
};

const successResponse: GetCommunityResponse = {
  community: {
    id: "com_semiconductors",
    slug: "semiconductors",
    name: "Semiconductors",
    kind: "topic",
    canonical_target: {
      type: "topic",
      id: "top_semiconductors",
      slug: "semiconductors",
    },
    description_markdown: "Research on semiconductor companies and supply chains.",
    state: "active",
    materialization_state: "materialized",
    version: 12,
    posting_policy: {
      allowed_content: ["investment-research", "source-analysis"],
      max_posts_per_hour: 6,
      requires_sources: false,
    },
    viewer_eligibility: {
      can_read: true,
      can_post: true,
      write_gate: "require_approval",
    },
    created_at: "2026-01-10T08:00:00.000Z",
    updated_at: "2026-07-01T16:30:00.000Z",
  },
  request_id: requestId,
  schema_version: "1",
};

const errorResponse: V1ErrorResponse = {
  error: {
    code: "COMMUNITY_NOT_FOUND",
    message: "The requested Community was not found.",
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

describe("get_community MCP tool", () => {
  it("publishes a strict read-only schema with an explicit ID/slug XOR", () => {
    const tool = createGetCommunityTool(respondingClient(successResponse, 200).client);
    const validate = new Ajv2020({ strict: false }).compile(tool.definition.inputSchema);

    expect(tool.definition).toMatchObject({
      name: "get_community",
      title: "Get Community",
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      annotations: {
        title: "Get Community",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execution: { taskSupport: "forbidden" },
    });
    expect(Array.isArray(tool.definition.inputSchema.oneOf)).toBe(true);
    expect(tool.definition.inputSchema.oneOf).toHaveLength(2);
    expect(validate({ community_id: "com_semiconductors" })).toBe(true);
    expect(validate({ community_id: "contains whitespace" })).toBe(false);
    expect(validate({ community_id: "x".repeat(201) })).toBe(false);
    expect(validate({ slug: "semiconductors" })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ community_id: "com_semiconductors", slug: "semiconductors" })).toBe(
      false,
    );
    expect(validate({ slug: "Not_Canonical" })).toBe(false);
    expect(tool.successOutputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    for (const field of ["community", "request_id", "schema_version"]) {
      expect(tool.successOutputSchema.required).toContain(field);
    }
    expect(() =>
      createProtocolServer({
        executionRegistry: new McpExecutionRegistry(),
        logger: createLogger({
          environment: "test",
          level: "silent",
          service: "get-community-tool-test",
        }),
        requestId,
        tools: [tool],
        version: "test-version",
      }),
    ).not.toThrow();
  });

  it("uses the shared Contracts parser for strict arguments", () => {
    const tool = createGetCommunityTool(respondingClient(successResponse, 200).client);

    expect(tool.parseArguments({ community_id: "com_semiconductors" })).toEqual({
      community_id: "com_semiconductors",
    });
    expect(tool.parseArguments({ slug: "semiconductors" })).toEqual({
      slug: "semiconductors",
    });
    for (const invalid of [
      {},
      { community_id: "com_semiconductors", slug: "semiconductors" },
      { slug: "Not_Canonical" },
      { community_id: "contains whitespace" },
      { slug: "semiconductors", leaked: true },
      null,
      [],
    ]) {
      expect(() => tool.parseArguments(invalid)).toThrow();
    }
  });

  it("calls the fixed private GET route by encoded Community ID", async () => {
    const communityId = "community/alpha?view=current";
    const response: GetCommunityResponse = {
      ...successResponse,
      community: { ...successResponse.community, id: communityId },
    };
    const { client, request } = respondingClient(response, 200);
    const tool = createGetCommunityTool(client);

    await expect(tool.execute({ community_id: communityId }, context)).resolves.toEqual({
      payload: response,
    });
    const [upstreamRequest, executionContext] = request.mock.calls[0] ?? [];
    expect(upstreamRequest).toMatchObject({
      method: "GET",
      path: `${GET_COMMUNITY_BY_ID_INTERNAL_API_PATH_PREFIX}community%2Falpha%3Fview%3Dcurrent`,
    });
    expect(upstreamRequest).not.toHaveProperty("body");
    expect(executionContext).toBe(context);
  });

  it("calls the static private slug route instead of the dynamic ID route", async () => {
    const { client, request } = respondingClient(successResponse, 200);
    const tool = createGetCommunityTool(client);

    await expect(tool.execute({ slug: "semiconductors" }, context)).resolves.toEqual({
      payload: successResponse,
    });
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      path: `${GET_COMMUNITY_BY_SLUG_INTERNAL_API_PATH_PREFIX}semiconductors`,
    });
  });

  it.each([
    ["INVALID_ARGUMENT", 400],
    ["REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED", 401],
    ["POLICY_DENIED", 403],
    ["COMMUNITY_NOT_FOUND", 404],
    ["RATE_LIMITED", 429],
    ["DIRECTORY_NOT_READY", 503],
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
    const tool = createGetCommunityTool(respondingClient(payload, statusCode).client);

    await expect(
      tool.execute({ community_id: "com_semiconductors" }, context),
    ).resolves.toEqual({ isError: true, payload });
  });

  it.each([
    {
      label: "success payload with an error status",
      payload: successResponse,
      status: 404,
      argumentsValue: { slug: "semiconductors" },
    },
    {
      label: "error payload with success status",
      payload: errorResponse,
      status: 200,
      argumentsValue: { community_id: "com_semiconductors" },
    },
    {
      label: "success payload with HTTP 201",
      payload: successResponse,
      status: 201,
      argumentsValue: { slug: "semiconductors" },
    },
    {
      label: "error payload with redirect status",
      payload: errorResponse,
      status: 307,
      argumentsValue: { community_id: "com_semiconductors" },
    },
    {
      label: "known error code with the wrong HTTP status",
      payload: errorResponse,
      status: 503,
      argumentsValue: { community_id: "com_semiconductors" },
    },
    {
      label: "unknown endpoint error code",
      payload: {
        ...errorResponse,
        error: { ...errorResponse.error, code: "ROUTE_NOT_FOUND" },
      },
      status: 404,
      argumentsValue: { community_id: "com_semiconductors" },
    },
    {
      label: "success response for a different Community ID",
      payload: {
        ...successResponse,
        community: { ...successResponse.community, id: "com_other" },
      },
      status: 200,
      argumentsValue: { community_id: "com_semiconductors" },
    },
    {
      label: "success response for a different Community slug",
      payload: {
        ...successResponse,
        community: { ...successResponse.community, slug: "different-community" },
      },
      status: 200,
      argumentsValue: { slug: "semiconductors" },
    },
    {
      label: "success response with another request ID",
      payload: { ...successResponse, request_id: "44444444-4444-4444-8444-444444444444" },
      status: 200,
      argumentsValue: { community_id: "com_semiconductors" },
    },
    {
      label: "error response with another request ID",
      payload: { ...errorResponse, request_id: "44444444-4444-4444-8444-444444444444" },
      status: 404,
      argumentsValue: { community_id: "com_semiconductors" },
    },
  ])("rejects $label", async ({ argumentsValue, payload, status }) => {
    const tool = createGetCommunityTool(respondingClient(payload, status).client);

    await expect(tool.execute(argumentsValue, context)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "InternalMcpApiClientError",
    });
  });

  it("propagates private-client failures without replacing their category", async () => {
    const upstreamError = new InternalMcpApiClientError("TIMEOUT");
    const request = vi.fn(() => Promise.reject(upstreamError));
    const tool = createGetCommunityTool({ request });

    await expect(
      tool.execute({ community_id: "com_semiconductors" }, context),
    ).rejects.toBe(upstreamError);
  });

  it("strictly parses success/error output and rejects leaked fields", () => {
    const tool = createGetCommunityTool(respondingClient(successResponse, 200).client);

    expect(tool.parseOutput(successResponse)).toEqual(successResponse);
    expect(tool.parseOutput(errorResponse)).toEqual(errorResponse);
    expect(() =>
      tool.parseOutput({ ...successResponse, leaked_internal_field: true }),
    ).toThrow();
    expect(() => tool.parseOutput({ ok: true })).toThrow();
  });

  it("rejects malformed upstream projections through the Contracts parser", async () => {
    const invalid = {
      ...successResponse,
      community: { ...successResponse.community, version: 0 },
    };
    const tool = createGetCommunityTool(respondingClient(invalid, 200).client);

    await expect(tool.execute({ slug: "semiconductors" }, context)).rejects.toThrow();
  });
});
