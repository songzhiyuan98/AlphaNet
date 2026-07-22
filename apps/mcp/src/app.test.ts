import { gzipSync } from "node:zlib";
import { createServer } from "node:http";

import {
  AGENT_SCOPES,
  AGENT_TOOL_NAMES,
  V1ErrorResponseSchema,
  type AgentScope,
  type AgentToolName,
} from "@alphanet/contracts";
import { createLogger } from "@alphanet/observability";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Request, RequestHandler } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createMcpApp,
  MCP_MAX_REQUEST_BYTES,
  MCP_PRM_MAX_RESPONSE_BYTES,
  type McpActorRateLimitContext,
  type McpApp,
  type McpAppOptions,
  type McpRequestRateLimitContext,
} from "./app.js";
import { InvalidForwardedForError } from "./client-ip.js";
import {
  MCP_MAX_RESPONSE_BYTES,
  type McpToolExecutionContext,
  type McpToolRegistration,
} from "./protocol.js";

const apps: McpApp[] = [];
const logger = createLogger({
  environment: "test",
  level: "silent",
  service: "mcp-test",
});
const resource = "https://mcp.alphanet.test/mcp";
const oauthIssuer = "https://auth.alphanet.test/";
const resourceMetadataPath = "/.well-known/oauth-protected-resource/mcp";
const grantId = "11111111-1111-4111-8111-111111111111";
const credentialId = "22222222-2222-4222-8222-222222222222";
const tokenJtiDigest = "A".repeat(43);
const defaultScopes: AgentScope[] = ["research:read", "community:read", "content:write"];

interface RequestWithAuth extends Request {
  auth?: AuthInfo;
}

interface TestJsonRpcBody {
  error?: {
    code: number;
    data?: Record<string, unknown>;
    message: string;
  };
  id?: number | string | null;
  result?: {
    content?: Array<{
      text: string;
      type: string;
    }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    tools?: Array<Record<string, unknown>>;
  };
}

interface TestToolOptions {
  execute?: McpToolRegistration["execute"];
  name?: AgentToolName;
  parseArguments?: McpToolRegistration["parseArguments"];
  parseOutput?: McpToolRegistration["parseOutput"];
}

function asJsonRpcBody(body: unknown): TestJsonRpcBody {
  return body as TestJsonRpcBody;
}

function validAuthInfo(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    clientId: "test-client",
    expiresAt: Math.floor(Date.now() / 1_000) + 600,
    extra: {
      actor: {
        credentialId,
        grantId,
        tokenJtiDigest,
      },
    },
    resource: new URL(resource),
    scopes: defaultScopes,
    token: "verified-test-token",
    ...overrides,
  };
}

function authorizationFor(authInfo: AuthInfo | undefined): RequestHandler {
  return (requestValue, _response, next) => {
    if (authInfo) {
      (requestValue as RequestWithAuth).auth = authInfo;
    }
    next();
  };
}

const authorizationMiddleware = authorizationFor(validAuthInfo());

function parseObject(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}

function parseAnySuccessOrV1Error(value: unknown): Record<string, unknown> {
  const error = V1ErrorResponseSchema.safeParse(value);
  return error.success ? error.data : parseObject(value);
}

function makeTool(options: TestToolOptions = {}): McpToolRegistration {
  const name = options.name ?? "search_content";
  return {
    definition: {
      name,
      description: `Test implementation for ${name}.`,
      inputSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
    execute: options.execute ?? (() => ({ payload: { ok: true } })),
    parseArguments: options.parseArguments ?? parseObject,
    parseOutput: options.parseOutput ?? parseAnySuccessOrV1Error,
    successOutputSchema: {
      type: "object",
      additionalProperties: true,
    },
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function makeApp(overrides: Partial<McpAppOptions> = {}): McpApp {
  const app = createMcpApp({
    actorRateLimiter: () => ({ allowed: true }),
    allowedHosts: ["127.0.0.1", "localhost", "mcp.alphanet.test"],
    authorizationMiddleware,
    host: "127.0.0.1",
    logger,
    oauthIssuer,
    runtimeEnabled: true,
    requestRateLimiter: () => ({ allowed: true }),
    resolveClientIp: () => "203.0.113.10",
    resource,
    version: "test-version",
    ...overrides,
  });
  apps.push(app);
  return app;
}

function protocolRequest(
  app: McpApp,
  body: unknown,
  accept = "application/json, text/event-stream",
) {
  return request(app.app)
    .post("/mcp")
    .set("content-type", "application/json")
    .set("mcp-protocol-version", "2025-11-25")
    .send(body as string | object | undefined)
    .set("accept", accept);
}

describe("MCP service", () => {
  it("reports liveness", async () => {
    const { app } = makeApp();

    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      service: "mcp",
      status: "ok",
      version: "test-version",
    });
  });

  it("keeps optional dependency failures non-blocking", async () => {
    const instance = makeApp({
      dependencies: [
        {
          critical: false,
          name: "redis",
          check: () => Promise.reject(new Error("unavailable")),
          close: () => Promise.resolve(),
        },
      ],
    });

    const response = await request(instance.app).get("/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "degraded",
      failedDependencies: ["redis"],
    });
  });

  it("publishes bounded RFC 9728 metadata without bearer authorization", async () => {
    const authorize = vi.fn(authorizationMiddleware);
    const actorRateLimiter = vi.fn(() => ({ allowed: true as const }));
    const requestRateLimiter = vi.fn((context: McpRequestRateLimitContext) => {
      void context;
      return { allowed: true as const };
    });
    const app = makeApp({
      actorRateLimiter,
      authorizationMiddleware: authorize,
      requestRateLimiter,
    });

    const response = await request(app.app)
      .get(resourceMetadataPath)
      .set("host", "mcp.alphanet.test")
      .set("origin", "https://mcp.alphanet.test");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(
      /^application\/json(?:;\s*charset=utf-8)?$/,
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(response.body).toEqual({
      resource,
      authorization_servers: [oauthIssuer],
      scopes_supported: AGENT_SCOPES,
      bearer_methods_supported: ["header"],
    });
    expect(Buffer.byteLength(response.text, "utf8")).toBeLessThanOrEqual(
      MCP_PRM_MAX_RESPONSE_BYTES,
    );
    expect(requestRateLimiter).toHaveBeenCalledOnce();
    const rateLimitContext = requestRateLimiter.mock.calls[0]?.[0];
    expect(rateLimitContext).toMatchObject({
      clientIp: "203.0.113.10",
    });
    expect(rateLimitContext?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(rateLimitContext?.signal).toBeInstanceOf(AbortSignal);
    expect(authorize).not.toHaveBeenCalled();
    expect(actorRateLimiter).not.toHaveBeenCalled();
  });

  it("serves the same metadata headers for HEAD without a response body", async () => {
    const authorize = vi.fn(authorizationMiddleware);
    const actorRateLimiter = vi.fn(() => ({ allowed: true as const }));
    const app = makeApp({
      actorRateLimiter,
      authorizationMiddleware: authorize,
    });

    const response = await request(app.app)
      .head(resourceMetadataPath)
      .set("host", "mcp.alphanet.test");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(
      /^application\/json(?:;\s*charset=utf-8)?$/,
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.text).toBeUndefined();
    expect(authorize).not.toHaveBeenCalled();
    expect(actorRateLimiter).not.toHaveBeenCalled();
  });

  it("does not make bearer or actor protection components a metadata dependency", async () => {
    const requestRateLimiter = vi.fn(() => ({ allowed: true as const }));
    const app = makeApp({
      actorRateLimiter: undefined,
      authorizationMiddleware: undefined,
      requestRateLimiter,
    });

    const response = await request(app.app)
      .get(resourceMetadataPath)
      .set("host", "mcp.alphanet.test");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ resource });
    expect(requestRateLimiter).toHaveBeenCalledOnce();
  });

  it.each(["post", "put", "patch", "delete", "options"] as const)(
    "returns 405 for %s on protected resource metadata after IP protection",
    async (method) => {
      const authorize = vi.fn(authorizationMiddleware);
      const actorRateLimiter = vi.fn(() => ({ allowed: true as const }));
      const requestRateLimiter = vi.fn(() => ({ allowed: true as const }));
      const app = makeApp({
        actorRateLimiter,
        authorizationMiddleware: authorize,
        requestRateLimiter,
      });

      const agent = request(app.app);
      const response = await agent[method](resourceMetadataPath).set(
        "host",
        "mcp.alphanet.test",
      );

      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe("GET, HEAD");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).toEqual({ error: "method_not_allowed" });
      expect(requestRateLimiter).toHaveBeenCalledOnce();
      expect(authorize).not.toHaveBeenCalled();
      expect(actorRateLimiter).not.toHaveBeenCalled();
    },
  );

  it("rejects hostile metadata Host and Origin values before rate limiting", async () => {
    const authorize = vi.fn(authorizationMiddleware);
    const requestRateLimiter = vi.fn(() => ({ allowed: true as const }));
    const app = makeApp({ authorizationMiddleware: authorize, requestRateLimiter });

    const [hostResponse, originResponse] = await Promise.all([
      request(app.app).get(resourceMetadataPath).set("host", "attacker.example"),
      request(app.app)
        .get(resourceMetadataPath)
        .set("host", "mcp.alphanet.test")
        .set("origin", "https://attacker.example"),
    ]);

    expect(hostResponse.status).toBe(403);
    expect(originResponse.status).toBe(403);
    expect(requestRateLimiter).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("applies IP admission to metadata without invoking bearer or actor admission", async () => {
    const authorize = vi.fn(authorizationMiddleware);
    const actorRateLimiter = vi.fn(() => ({ allowed: true as const }));
    const app = makeApp({
      actorRateLimiter,
      authorizationMiddleware: authorize,
      requestRateLimiter: () => ({ allowed: false, retryAfterSeconds: 11 }),
    });

    const response = await request(app.app)
      .get(resourceMetadataPath)
      .set("host", "mcp.alphanet.test");

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("11");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(authorize).not.toHaveBeenCalled();
    expect(actorRateLimiter).not.toHaveBeenCalled();
  });

  it("advertises the exact live metadata handler in an invalid-token challenge", async () => {
    const authorize = vi.fn(authorizationFor(undefined));
    const app = makeApp({ authorizationMiddleware: authorize });

    const unauthorizedResponse = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: "prm-challenge",
      method: "tools/list",
      params: {},
    }).set("host", "mcp.alphanet.test");
    const challenge = String(unauthorizedResponse.headers["www-authenticate"]);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];

    expect(unauthorizedResponse.status).toBe(401);
    expect(metadataUrl).toBe(
      "https://mcp.alphanet.test/.well-known/oauth-protected-resource/mcp",
    );

    const metadataResponse = await request(app.app)
      .get(new URL(metadataUrl ?? "https://invalid.test/").pathname)
      .set("host", "mcp.alphanet.test");

    expect(metadataResponse.status).toBe(200);
    expect(metadataResponse.body).toEqual({
      resource,
      authorization_servers: [oauthIssuer],
      scopes_supported: AGENT_SCOPES,
      bearer_methods_supported: ["header"],
    });
    expect(authorize).toHaveBeenCalledOnce();
  });

  it("completes the MCP initialize handshake through a stateless transport", async () => {
    const app = makeApp();

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: {
          name: "alphanet-test",
          version: "0.1.0",
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers).not.toHaveProperty("mcp-session-id");
    expect(response.body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        serverInfo: {
          name: "alphanet",
          version: "test-version",
        },
      },
    });
  });

  it("works end to end with the SDK 1.29 streamable HTTP client", async () => {
    const execute = vi.fn((argumentsValue: Record<string, unknown>) => ({
      payload: { echoed: argumentsValue.query },
    }));
    const app = makeApp({
      tools: [
        makeTool({
          execute,
          parseArguments: (value) =>
            z.object({ query: z.string() }).strict().parse(value),
        }),
      ],
    });
    const httpServer = createServer(app.app);
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("expected a TCP listener address");
    }

    const exchanges: Array<{
      contentType: string | null;
      method: string | undefined;
      sessionId: string | null;
      status: number;
    }> = [];
    const instrumentedFetch: typeof fetch = async (input, init) => {
      let method: string | undefined;
      if (typeof init?.body === "string") {
        try {
          const body = JSON.parse(init.body) as { method?: unknown };
          method = typeof body.method === "string" ? body.method : undefined;
        } catch {
          method = undefined;
        }
      }
      const response = await fetch(input, init);
      exchanges.push({
        contentType: response.headers.get("content-type"),
        method,
        sessionId: response.headers.get("mcp-session-id"),
        status: response.status,
      });
      return response;
    };
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      {
        fetch: instrumentedFetch,
        requestInit: {
          headers: { authorization: "Bearer sdk-smoke-token" },
        },
      },
    );
    const client = new Client(
      { name: "alphanet-sdk-smoke", version: "1.0.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toEqual({
        name: "alphanet",
        version: "test-version",
      });

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["search_content"]);

      const called = await client.callTool({
        name: "search_content",
        arguments: { query: "MU HBM demand" },
      });
      expect(called.structuredContent).toEqual({ echoed: "MU HBM demand" });
      expect(execute).toHaveBeenCalledOnce();
      expect(transport.sessionId).toBeUndefined();

      for (const method of ["initialize", "tools/list", "tools/call"]) {
        const exchange = exchanges.find((candidate) => candidate.method === method);
        expect(exchange).toBeDefined();
        expect(exchange?.contentType).toContain("application/json");
        expect(exchange?.sessionId).toBeNull();
        expect(exchange?.status).toBe(200);
      }
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("publishes no placeholder tools when the injected registry is empty", async () => {
    const app = makeApp();

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    expect(response.status).toBe(200);
    expect(asJsonRpcBody(response.body as unknown).result?.tools).toEqual([]);
    expect(JSON.stringify(response.body)).not.toContain("get_platform_status");
  });

  it("publishes exactly the fixed canonical tool allowlist", async () => {
    const app = makeApp({
      tools: AGENT_TOOL_NAMES.map((name) => makeTool({ name })),
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {},
    });

    expect(response.status).toBe(200);
    expect(
      asJsonRpcBody(response.body as unknown).result?.tools?.map((tool) => tool.name),
    ).toEqual(AGENT_TOOL_NAMES);
    const publishedOutputSchema = asJsonRpcBody(response.body as unknown).result
      ?.tools?.[0]?.["outputSchema"] as
      { anyOf?: Array<Record<string, unknown>> } | undefined;
    expect(publishedOutputSchema?.anyOf).toHaveLength(2);
    expect(publishedOutputSchema?.anyOf?.[1]).toMatchObject({
      required: ["error", "request_id", "schema_version"],
      properties: {
        error: {
          required: ["code", "message", "retryable", "details", "retry_after_ms"],
        },
      },
    });
  });

  it("passes trusted actor and limiter context without exposing the bearer token", async () => {
    const requestRateLimiter = vi.fn((context: McpRequestRateLimitContext) => {
      void context;
      return { allowed: true as const };
    });
    const actorRateLimiter = vi.fn((context: McpActorRateLimitContext) => {
      void context;
      return { allowed: true as const };
    });
    const resolveClientIp = vi.fn(() => "198.51.100.44");
    const execute = vi.fn(
      (argumentsValue: Record<string, unknown>, context: McpToolExecutionContext) => {
        void context;
        return {
          payload: {
            matched: argumentsValue.query,
            score: Number.NaN,
            skipped: undefined,
          },
        };
      },
    );
    const parseOutput = (value: unknown): Record<string, unknown> => {
      const error = V1ErrorResponseSchema.safeParse(value);
      if (error.success) {
        return error.data;
      }
      return z.object({ matched: z.string(), score: z.null() }).strict().parse(value);
    };
    const expiresAt = Math.floor(Date.now() / 1_000) + 300;
    const app = makeApp({
      actorRateLimiter,
      authorizationMiddleware: authorizationFor(validAuthInfo({ expiresAt })),
      requestRateLimiter,
      resolveClientIp,
      tools: [
        makeTool({
          execute,
          parseArguments: (value) =>
            z.object({ query: z.string() }).strict().parse(value),
          parseOutput,
        }),
      ],
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: "client-json-rpc-id",
      method: "tools/call",
      params: {
        name: "search_content",
        arguments: { query: "MU HBM demand" },
      },
    });

    expect(response.status).toBe(200);
    const serverRequestId = z.uuid().parse(response.headers["x-request-id"]);
    expect(serverRequestId).not.toBe("client-json-rpc-id");
    expect(resolveClientIp).toHaveBeenCalledOnce();
    const requestLimiterContext = requestRateLimiter.mock.calls[0]?.[0];
    expect(requestLimiterContext).toMatchObject({
      clientIp: "198.51.100.44",
      requestId: serverRequestId,
    });
    expect(requestLimiterContext?.signal).toBeInstanceOf(AbortSignal);
    const actorLimiterContext = actorRateLimiter.mock.calls[0]?.[0];
    expect(actorLimiterContext).toMatchObject({
      clientId: "test-client",
      clientIp: "198.51.100.44",
      credentialId,
      grantId,
      method: "tools/call",
      requestId: serverRequestId,
      toolName: "search_content",
    });
    expect(actorLimiterContext?.signal).toBeInstanceOf(AbortSignal);
    expect(execute).toHaveBeenCalledOnce();
    const executionContext = execute.mock.calls[0]?.[1];
    expect(executionContext).toMatchObject({
      authorization: {
        clientId: "test-client",
        credentialId,
        expiresAt,
        grantId,
        resource,
        scopes: defaultScopes,
        tokenJtiDigest,
      },
      requestId: serverRequestId,
    });
    expect(executionContext?.signal).toBeInstanceOf(AbortSignal);
    expect(executionContext).not.toHaveProperty("authInfo");
    expect(executionContext?.authorization).not.toHaveProperty("token");

    const body = asJsonRpcBody(response.body as unknown);
    const structuredContent = body.result?.structuredContent;
    expect(structuredContent).toEqual({
      matched: "MU HBM demand",
      score: null,
    });
    expect(JSON.parse(body.result?.content?.[0]?.text ?? "")).toEqual(structuredContent);
  });

  it("generates unique UUID execution ids independently of repeated JSON-RPC ids", async () => {
    const executionIds: string[] = [];
    const app = makeApp({
      tools: [
        makeTool({
          execute: (_argumentsValue, context) => {
            executionIds.push(context.requestId);
            return { payload: { request_id: context.requestId } };
          },
          name: "get_agent_context",
        }),
      ],
    });
    const body = {
      jsonrpc: "2.0",
      id: 77,
      method: "tools/call",
      params: { name: "get_agent_context", arguments: {} },
    };

    const first = await protocolRequest(app, body);
    const second = await protocolRequest(app, body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(executionIds).toHaveLength(2);
    expect(executionIds.map((value) => z.uuid().parse(value))).toEqual(executionIds);
    expect(new Set(executionIds).size).toBe(2);
    expect(executionIds).not.toContain("77");
    expect(first.headers["x-request-id"]).toBe(executionIds[0]);
    expect(second.headers["x-request-id"]).toBe(executionIds[1]);
  });

  it("allows get_agent_context with authenticated-only scope policy", async () => {
    const execute = vi.fn(() => ({ payload: { agent: "current" } }));
    const app = makeApp({
      authorizationMiddleware: authorizationFor(
        validAuthInfo({ scopes: ["content:write"] }),
      ),
      tools: [makeTool({ execute, name: "get_agent_context" })],
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_agent_context", arguments: {} },
    });

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("returns HTTP 403 with one canonical challenge scope before dispatch", async () => {
    const execute = vi.fn(() => ({ payload: { hidden: true } }));
    const actorRateLimiter = vi.fn(() => ({ allowed: true as const }));
    const app = makeApp({
      actorRateLimiter,
      authorizationMiddleware: authorizationFor(
        validAuthInfo({ scopes: ["content:write"] }),
      ),
      tools: [
        makeTool({
          execute,
          name: "get_community",
        }),
      ],
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: "scope-test",
      method: "tools/call",
      params: { name: "get_community", arguments: {} },
    });

    expect(response.status).toBe(403);
    expect(response.headers["www-authenticate"]).toContain('error="insufficient_scope"');
    expect(response.headers["www-authenticate"]).toContain('scope="community:read"');
    expect(response.headers["www-authenticate"]).not.toContain(
      'scope="community:read research:read"',
    );
    expect(response.headers["www-authenticate"]).toContain(
      'resource_metadata="https://mcp.alphanet.test/.well-known/oauth-protected-resource/mcp"',
    );
    expect(asJsonRpcBody(response.body as unknown)).toMatchObject({
      id: "scope-test",
      error: {
        code: -32000,
        data: {
          code: "MCP_SCOPE_REQUIRED",
          required_scope_any_of: ["community:read", "research:read"],
        },
      },
    });
    expect(actorRateLimiter).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a hostile Origin before rate limiting or authorization", async () => {
    const authorize = vi.fn(authorizationMiddleware);
    const requestRateLimiter = vi.fn(() => ({ allowed: true as const }));
    const app = makeApp({ authorizationMiddleware: authorize, requestRateLimiter });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/list",
      params: {},
    }).set("origin", "https://attacker.example");

    expect(response.status).toBe(403);
    expect(asJsonRpcBody(response.body as unknown).error?.data).toMatchObject({
      code: "MCP_ORIGIN_FORBIDDEN",
    });
    expect(requestRateLimiter).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("fails closed for every MCP method while the runtime is disabled", async () => {
    const authorize = vi.fn(authorizationMiddleware);
    const execute = vi.fn(() => ({ payload: { hidden: true } }));
    const app = makeApp({
      authorizationMiddleware: authorize,
      runtimeEnabled: false,
      tools: [makeTool({ execute, name: "create_post" })],
    });

    const [getResponse, postResponse, deleteResponse] = await Promise.all([
      request(app.app).get("/mcp"),
      protocolRequest(app, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "create_post", arguments: {} },
      }),
      request(app.app).delete("/mcp"),
    ]);

    for (const response of [getResponse, postResponse, deleteResponse]) {
      const body = asJsonRpcBody(response.body as unknown);
      expect(response.status).toBe(503);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(body.error?.data).toMatchObject({ code: "MCP_RUNTIME_DISABLED" });
      expect(JSON.stringify(response.body)).not.toContain("create_post");
    }
    expect(authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed before authorization when runtime protection is incomplete", async () => {
    const authorize = vi.fn(authorizationMiddleware);
    const execute = vi.fn(() => ({ payload: { hidden: true } }));
    const app = makeApp({
      authorizationMiddleware: authorize,
      requestRateLimiter: undefined,
      tools: [makeTool({ execute })],
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "search_content", arguments: {} },
    });

    expect(response.status).toBe(503);
    expect(asJsonRpcBody(response.body as unknown).error?.data).toMatchObject({
      code: "MCP_PROTECTION_UNAVAILABLE",
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["missing AuthInfo", undefined],
    ["missing expiresAt", validAuthInfo({ expiresAt: undefined })],
    [
      "expired expiresAt",
      validAuthInfo({ expiresAt: Math.floor(Date.now() / 1_000) - 1 }),
    ],
    ["missing actor context", validAuthInfo({ extra: {} })],
    [
      "wrong resource",
      validAuthInfo({ resource: new URL("https://attacker.example/mcp") }),
    ],
  ])("rejects %s with an OAuth resource challenge", async (_label, authInfo) => {
    const app = makeApp({
      authorizationMiddleware: authorizationFor(authInfo),
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/list",
      params: {},
    });

    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toContain('error="invalid_token"');
    expect(response.headers["www-authenticate"]).toContain(
      'resource_metadata="https://mcp.alphanet.test/.well-known/oauth-protected-resource/mcp"',
    );
    expect(asJsonRpcBody(response.body as unknown).error?.data).toMatchObject({
      code: "MCP_INVALID_TOKEN",
    });
  });

  it.each(["access_token", "api_key", "token"])(
    "rejects the %s query credential before authorization",
    async (name) => {
      const authorize = vi.fn(authorizationMiddleware);
      const app = makeApp({ authorizationMiddleware: authorize });

      const response = await request(app.app)
        .post(`/mcp?${name}=must-not-be-accepted`)
        .set("accept", "application/json, text/event-stream")
        .set("content-type", "application/json")
        .send({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} });

      expect(response.status).toBe(400);
      expect(asJsonRpcBody(response.body as unknown).error?.data).toMatchObject({
        code: "QUERY_CREDENTIAL_FORBIDDEN",
      });
      expect(authorize).not.toHaveBeenCalled();
    },
  );

  it.each(["get", "delete"] as const)(
    "rejects authenticated %s requests at the protocol endpoint",
    async (method) => {
      const app = makeApp();

      const response = await request(app.app)[method]("/mcp");

      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe("POST");
      expect(asJsonRpcBody(response.body as unknown).error?.code).toBe(-32000);
    },
  );

  it.each([
    ["a primitive", "42"],
    ["an invalid JSON-RPC object", JSON.stringify({ hello: "world" })],
  ])("returns -32600 for %s", async (_label, body) => {
    const app = makeApp();

    const response = await protocolRequest(app, body);

    expect(response.status).toBe(400);
    expect(asJsonRpcBody(response.body as unknown)).toMatchObject({
      error: { code: -32600, message: "Invalid JSON-RPC request." },
      id: null,
    });
  });

  it("rejects JSON-RPC batches before entering the SDK", async () => {
    const app = makeApp();

    const response = await protocolRequest(app, [
      { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} },
    ]);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: -32600,
        message: "JSON-RPC batch requests are not supported.",
      },
      id: null,
    });
  });

  it("returns -32700 only for malformed JSON", async () => {
    const app = makeApp();

    const response = await protocolRequest(app, '{"jsonrpc":"2.0","id":12');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: -32700,
        message: "Parse error: Invalid JSON",
      },
      id: null,
    });
  });

  it.each([
    ["q=0", "application/json;q=0, text/event-stream"],
    ["a lookalike MIME type", "application/json-patch+json, text/event-stream"],
    ["a wildcard", "*/*"],
    ["duplicate quality parameters", "application/json;q=1;q=0.5, text/event-stream"],
    ["an invalid quality", "application/json;q=wat, text/event-stream"],
  ])("returns 406 when Accept contains %s", async (_label, accept) => {
    const app = makeApp();

    const response = await protocolRequest(
      app,
      { jsonrpc: "2.0", id: 13, method: "tools/list", params: {} },
      accept,
    );

    expect(response.status).toBe(406);
    expect(asJsonRpcBody(response.body as unknown).error?.data).toMatchObject({
      code: "MCP_ACCEPT_UNSUPPORTED",
    });
  });

  it("accepts case-insensitive exact MIME types with parameters", async () => {
    let observedAccept: string | undefined;
    const app = makeApp({
      authorizationMiddleware: (requestValue, response, next) => {
        observedAccept = requestValue.get("accept");
        authorizationMiddleware(requestValue, response, next);
      },
    });

    const response = await protocolRequest(
      app,
      { jsonrpc: "2.0", id: 14, method: "tools/list", params: {} },
      "Application/JSON; charset=utf-8; q=0.5, Text/Event-Stream; mode=live; q=1",
    );

    expect(observedAccept).toBe(
      "Application/JSON; charset=utf-8; q=0.5, Text/Event-Stream; mode=live; q=1",
    );
    expect(response.status).toBe(200);
  });

  it("rejects request bodies above one MiB", async () => {
    const app = makeApp();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/list",
      params: { padding: "x".repeat(MCP_MAX_REQUEST_BYTES) },
    });

    const response = await protocolRequest(app, body);

    expect(response.status).toBe(413);
    expect(asJsonRpcBody(response.body as unknown).error?.data).toMatchObject({
      maximum_body_bytes: MCP_MAX_REQUEST_BYTES,
    });
  });

  it("applies the one MiB limit after decompressing the request body", async () => {
    const app = makeApp();
    const compressedBody = gzipSync(
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 16,
          method: "tools/list",
          params: { padding: "x".repeat(MCP_MAX_REQUEST_BYTES) },
        }),
      ),
    );

    const response = await request(app.app)
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .set("content-encoding", "gzip")
      .set("content-type", "application/json")
      // Superagent's runtime accepts Buffer serializers, although its public
      // type declaration still narrows custom serializers to strings.
      .serialize(() => compressedBody as unknown as string)
      .send(compressedBody);

    expect(compressedBody.byteLength).toBeLessThan(MCP_MAX_REQUEST_BYTES);
    expect(response.status).toBe(413);
    expect(asJsonRpcBody(response.body as unknown).error?.data).toMatchObject({
      maximum_body_bytes: MCP_MAX_REQUEST_BYTES,
    });
  });

  it("returns INVALID_ARGUMENTS as a validated tool result without dispatch", async () => {
    const execute = vi.fn(() => ({ payload: { hidden: true } }));
    const app = makeApp({
      tools: [
        makeTool({
          execute,
          parseArguments: (value) =>
            z.object({ query: z.string() }).strict().parse(value),
        }),
      ],
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 17,
      method: "tools/call",
      params: {
        name: "search_content",
        arguments: { query: 42 },
      },
    });

    expect(response.status).toBe(200);
    const body = asJsonRpcBody(response.body as unknown);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toMatchObject({
      error: {
        code: "INVALID_ARGUMENTS",
        retryable: false,
      },
      request_id: response.headers["x-request-id"],
      schema_version: "1",
    });
    expect(JSON.parse(body.result?.content?.[0]?.text ?? "")).toEqual(
      body.result?.structuredContent,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("enforces the published input schema independently of the parser", async () => {
    const execute = vi.fn(() => ({ payload: { hidden: true } }));
    const tool = makeTool({
      execute,
      parseArguments: parseObject,
    });
    tool.definition = {
      ...tool.definition,
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" } },
        additionalProperties: false,
      },
    };
    const app = makeApp({ tools: [tool] });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 171,
      method: "tools/call",
      params: {
        name: "search_content",
        arguments: { query: 42 },
      },
    });

    expect(response.status).toBe(200);
    expect(
      asJsonRpcBody(response.body as unknown).result?.structuredContent,
    ).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates the normalized payload and returns a safe error for NaN and undefined", async () => {
    const parseOutput = vi.fn((value: unknown): Record<string, unknown> => {
      const error = V1ErrorResponseSchema.safeParse(value);
      if (error.success) {
        return error.data;
      }
      return z
        .object({ score: z.number().finite(), required: z.string() })
        .strict()
        .parse(value);
    });
    const app = makeApp({
      tools: [
        makeTool({
          execute: () => ({
            payload: { required: undefined, score: Number.NaN },
          }),
          parseOutput,
        }),
      ],
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 18,
      method: "tools/call",
      params: { name: "search_content", arguments: {} },
    });

    expect(response.status).toBe(200);
    const body = asJsonRpcBody(response.body as unknown);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toMatchObject({
      error: { code: "INTERNAL_ERROR" },
      request_id: response.headers["x-request-id"],
    });
    expect(parseOutput.mock.calls[0]?.[0]).toEqual({ score: null });
    expect(JSON.stringify(response.body)).not.toContain("ZodError");
    expect(JSON.stringify(response.body)).not.toContain("NaN");
  });

  it("validates the final parser output against the published output schema", async () => {
    const tool = makeTool({
      execute: () => ({ payload: { score: 1 } }),
      parseOutput: () => ({ score: Number.NaN }),
    });
    tool.successOutputSchema = {
      type: "object",
      required: ["score"],
      properties: { score: { type: "number" } },
      additionalProperties: false,
    };
    const app = makeApp({ tools: [tool] });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 181,
      method: "tools/call",
      params: { name: "search_content", arguments: {} },
    });

    expect(response.status).toBe(200);
    expect(asJsonRpcBody(response.body as unknown).error?.code).toBe(-32603);
    expect(response.text).not.toContain('"score":null');
  });

  it("falls back to a protocol error when even the safe error envelope is rejected", async () => {
    const app = makeApp({
      tools: [
        makeTool({
          execute: () => ({ payload: { invalid: Number.NaN } }),
          parseOutput: () => {
            throw new Error("private schema diagnostics");
          },
        }),
      ],
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 19,
      method: "tools/call",
      params: { name: "search_content", arguments: {} },
    });

    expect(response.status).toBe(200);
    expect(asJsonRpcBody(response.body as unknown).error?.code).toBe(-32603);
    expect(JSON.stringify(response.body)).not.toContain("private schema diagnostics");
  });

  it("replaces registered tool results above four MiB with a V1 error envelope", async () => {
    const app = makeApp({
      tools: [
        makeTool({
          execute: () => ({
            payload: { content: "x".repeat(MCP_MAX_RESPONSE_BYTES) },
          }),
        }),
      ],
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "search_content", arguments: {} },
    });

    expect(response.status).toBe(200);
    expect(Buffer.byteLength(response.text)).toBeLessThanOrEqual(MCP_MAX_RESPONSE_BYTES);
    const body = asJsonRpcBody(response.body as unknown);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toMatchObject({
      error: {
        code: "RESULT_TOO_LARGE",
        details: { maximum_wire_bytes: MCP_MAX_RESPONSE_BYTES },
      },
      schema_version: "1",
    });
    expect(JSON.parse(body.result?.content?.[0]?.text ?? "")).toEqual(
      body.result?.structuredContent,
    );
  });

  it("validates the parser output on the oversized-result fallback path", async () => {
    const tool = makeTool({
      execute: () => ({
        payload: { content: "x".repeat(MCP_MAX_RESPONSE_BYTES) },
      }),
      parseOutput: (value) =>
        V1ErrorResponseSchema.safeParse(value).success
          ? { score: Number.NaN }
          : parseObject(value),
    });
    tool.successOutputSchema = {
      type: "object",
      required: ["content"],
      properties: { content: { type: "string" } },
      additionalProperties: false,
    };
    const app = makeApp({ tools: [tool] });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 201,
      method: "tools/call",
      params: { name: "search_content", arguments: {} },
    });

    expect(response.status).toBe(200);
    expect(asJsonRpcBody(response.body as unknown).error?.code).toBe(-32603);
    expect(response.text).not.toContain('"score":null');
  });

  it("returns a bounded protocol error when tools/list would exceed the wire cap", async () => {
    const description = "x".repeat(
      Math.ceil(MCP_MAX_RESPONSE_BYTES / AGENT_TOOL_NAMES.length) + 1_024,
    );
    const tools = AGENT_TOOL_NAMES.map((name) => {
      const tool = makeTool({ name });
      return {
        ...tool,
        definition: { ...tool.definition, description },
      };
    });
    const app = makeApp({ tools });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/list",
      params: {},
    });

    expect(response.status).toBe(200);
    expect(Buffer.byteLength(response.text)).toBeLessThanOrEqual(MCP_MAX_RESPONSE_BYTES);
    expect(asJsonRpcBody(response.body as unknown).error?.code).toBe(-32603);
  });

  it("returns 429 before authorization when the request limiter denies", async () => {
    const authorize = vi.fn(authorizationMiddleware);
    const actorRateLimiter = vi.fn(() => ({ allowed: true as const }));
    const app = makeApp({
      actorRateLimiter,
      authorizationMiddleware: authorize,
      requestRateLimiter: () => ({ allowed: false, retryAfterSeconds: 7 }),
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/list",
      params: {},
    });

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("7");
    expect(asJsonRpcBody(response.body as unknown).error?.data).toMatchObject({
      code: "MCP_REQUEST_RATE_LIMITED",
      retry_after_seconds: 7,
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(actorRateLimiter).not.toHaveBeenCalled();
  });

  it.each([
    ["throws", () => Promise.reject(new Error("redis unavailable"))],
    ["returns an invalid decision", () => Promise.resolve(undefined)],
  ])("fails closed when the request limiter %s", async (_label, limiter) => {
    const authorize = vi.fn(authorizationMiddleware);
    const app = makeApp({
      authorizationMiddleware: authorize,
      requestRateLimiter: limiter as unknown as McpAppOptions["requestRateLimiter"],
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 23,
      method: "tools/list",
      params: {},
    });

    expect(response.status).toBe(503);
    expect(asJsonRpcBody(response.body as unknown).error?.data).toMatchObject({
      code: "MCP_PROTECTION_UNAVAILABLE",
    });
    expect(authorize).not.toHaveBeenCalled();
  });

  it("bounds a stalled request limiter and aborts its deadline signal", async () => {
    const authorize = vi.fn(authorizationMiddleware);
    let limiterSignal: AbortSignal | undefined;
    const app = makeApp({
      authorizationMiddleware: authorize,
      protectionTimeoutMilliseconds: 15,
      requestRateLimiter: ({ signal }) => {
        limiterSignal = signal;
        return new Promise(() => undefined);
      },
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 231,
      method: "tools/list",
      params: {},
    });

    expect(response.status).toBe(503);
    expect(asJsonRpcBody(response.body as unknown).error?.data).toMatchObject({
      code: "MCP_PROTECTION_UNAVAILABLE",
    });
    expect(limiterSignal?.aborted).toBe(true);
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each([
    ["throws", () => Promise.reject(new Error("redis unavailable"))],
    ["returns an invalid decision", () => undefined],
  ])("fails closed when the actor limiter %s", async (_label, limiter) => {
    const execute = vi.fn(() => ({ payload: { hidden: true } }));
    const app = makeApp({
      actorRateLimiter: limiter as McpAppOptions["actorRateLimiter"],
      tools: [makeTool({ execute })],
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 24,
      method: "tools/call",
      params: { name: "search_content", arguments: {} },
    });

    expect(response.status).toBe(503);
    expect(asJsonRpcBody(response.body as unknown).error?.data).toMatchObject({
      code: "MCP_PROTECTION_UNAVAILABLE",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("bounds a stalled actor limiter and aborts its deadline signal", async () => {
    const execute = vi.fn(() => ({ payload: { hidden: true } }));
    let limiterSignal: AbortSignal | undefined;
    const app = makeApp({
      actorRateLimiter: ({ signal }) => {
        limiterSignal = signal;
        return new Promise(() => undefined);
      },
      protectionTimeoutMilliseconds: 15,
      tools: [makeTool({ execute })],
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 241,
      method: "tools/call",
      params: { name: "search_content", arguments: {} },
    });

    expect(response.status).toBe(503);
    expect(asJsonRpcBody(response.body as unknown).error?.data).toMatchObject({
      code: "MCP_PROTECTION_UNAVAILABLE",
    });
    expect(limiterSignal?.aborted).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns 429 before dispatch when the actor limiter denies", async () => {
    const execute = vi.fn(() => ({ payload: { hidden: true } }));
    const actorRateLimiter = vi.fn(() => ({
      allowed: false as const,
      retryAfterSeconds: 11,
    }));
    const app = makeApp({
      actorRateLimiter,
      tools: [makeTool({ execute })],
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 25,
      method: "tools/call",
      params: { name: "search_content", arguments: {} },
    });

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("11");
    expect(asJsonRpcBody(response.body as unknown).error?.data).toMatchObject({
      code: "MCP_ACTOR_RATE_LIMITED",
      retry_after_seconds: 11,
    });
    expect(actorRateLimiter).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed when the client-IP resolver cannot produce an address", async () => {
    const authorize = vi.fn(authorizationMiddleware);
    const app = makeApp({
      authorizationMiddleware: authorize,
      resolveClientIp: () => "",
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 26,
      method: "tools/list",
      params: {},
    });

    expect(response.status).toBe(503);
    expect(asJsonRpcBody(response.body as unknown).error?.data).toMatchObject({
      code: "MCP_PROTECTION_UNAVAILABLE",
    });
    expect(authorize).not.toHaveBeenCalled();
  });

  it("rejects a malformed trusted-proxy chain before auth or rate limiting", async () => {
    const authorize = vi.fn(authorizationMiddleware);
    const requestRateLimiter = vi.fn(() => ({ allowed: true as const }));
    const app = makeApp({
      authorizationMiddleware: authorize,
      requestRateLimiter,
      resolveClientIp: () => {
        throw new InvalidForwardedForError();
      },
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 27,
      method: "tools/list",
      params: {},
    });

    expect(response.status).toBe(400);
    expect(asJsonRpcBody(response.body as unknown).error?.data).toMatchObject({
      code: "MCP_INVALID_FORWARDED_FOR",
    });
    expect(requestRateLimiter).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("times out a tool and aborts its execution signal", async () => {
    let executionSignal: AbortSignal | undefined;
    const app = makeApp({
      toolTimeoutMilliseconds: 15,
      tools: [
        makeTool({
          execute: (_argumentsValue, context) => {
            executionSignal = context.signal;
            return new Promise(() => undefined);
          },
        }),
      ],
    });

    const response = await protocolRequest(app, {
      jsonrpc: "2.0",
      id: 27,
      method: "tools/call",
      params: { name: "search_content", arguments: {} },
    });

    expect(response.status).toBe(200);
    expect(executionSignal?.aborted).toBe(true);
    expect(asJsonRpcBody(response.body as unknown).result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "TOOL_TIMEOUT", retryable: true } },
    });
  });

  it("cancels in-flight tool execution when shutdown begins", async () => {
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let executionSignal: AbortSignal | undefined;
    const app = makeApp({
      tools: [
        makeTool({
          execute: (_argumentsValue, context) => {
            executionSignal = context.signal;
            markEntered?.();
            return new Promise(() => undefined);
          },
        }),
      ],
    });

    const pendingResponse = protocolRequest(app, {
      jsonrpc: "2.0",
      id: 28,
      method: "tools/call",
      params: { name: "search_content", arguments: {} },
    }).then((response) => response);
    await entered;
    app.beginShutdown();
    const response = await pendingResponse;

    expect(response.status).toBe(200);
    expect(executionSignal?.aborted).toBe(true);
    expect(asJsonRpcBody(response.body as unknown).result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "CANCELLED", retryable: false } },
    });
  });

  it("allows task-IP Host headers only on health endpoints", async () => {
    const authorize = vi.fn(authorizationMiddleware);
    const app = makeApp({ authorizationMiddleware: authorize });

    const healthResponse = await request(app.app)
      .get("/health/live")
      .set("host", "10.0.12.34:4100");

    expect(healthResponse.status).toBe(200);
    expect(healthResponse.headers).not.toHaveProperty("x-powered-by");

    const protocolResponse = await request(app.app)
      .post("/mcp")
      .set("host", "attacker.example")
      .set("accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 29, method: "tools/list", params: {} });

    expect(protocolResponse.status).toBe(403);
    expect(protocolResponse.headers).not.toHaveProperty("x-powered-by");
    expect(authorize).not.toHaveBeenCalled();
  });
});
