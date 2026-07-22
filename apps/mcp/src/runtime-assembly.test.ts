import { createLogger } from "@alphanet/observability";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Request, RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createMcpApp } from "./app.js";
import { MCP_MAX_RESPONSE_BYTES } from "./protocol.js";
import { createMcpRuntimeAssembly } from "./runtime-assembly.js";

const logger = createLogger({
  environment: "test",
  level: "silent",
  service: "mcp-runtime-assembly-test",
});

const disabledEnvironment = {
  MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64: undefined,
  MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64: undefined,
  MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION: undefined,
  MCP_ACTOR_ASSERTION_PREVIOUS_KEYS: {},
  MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64: undefined,
  MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64: undefined,
  MCP_INTERNAL_API_MAX_RESPONSE_BYTES: 4 * 1_024 * 1_024,
  MCP_INTERNAL_API_SERVER_CA_PEM_BASE64: undefined,
  MCP_INTERNAL_API_TIMEOUT_MS: 15_000,
  MCP_INTERNAL_API_URL: undefined,
  MCP_OAUTH_ISSUER: undefined,
  MCP_OAUTH_JWKS_URI: undefined,
  MCP_RESOURCE: undefined,
  MCP_RUNTIME_ENABLED: false,
} as const;

const enabledEnvironment = {
  ...disabledEnvironment,
  MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64: Buffer.alloc(32, 0x44),
  MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64: Buffer.alloc(32, 0x33),
  MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION: 1,
  MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64: Buffer.from("client-cert", "utf8"),
  MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64: Buffer.from("client-key", "utf8"),
  MCP_INTERNAL_API_SERVER_CA_PEM_BASE64: Buffer.from("server-ca", "utf8"),
  MCP_INTERNAL_API_URL: "https://api.alphanet.internal",
  MCP_OAUTH_ISSUER: "https://auth.alphanet.example/",
  MCP_OAUTH_JWKS_URI: "https://auth.alphanet.example/.well-known/jwks.json",
  MCP_RESOURCE: "https://alphanet.example/mcp",
  MCP_RUNTIME_ENABLED: true,
} as const;

describe("Remote MCP runtime assembly", () => {
  it("keeps the protocol route disabled without constructing protected components", () => {
    const runtime = createMcpRuntimeAssembly(disabledEnvironment, {} as never);

    expect(runtime).toEqual({ runtimeEnabled: false, tools: [] });
    expect(runtime).not.toHaveProperty("authorizationMiddleware");
    expect(runtime).not.toHaveProperty("oauthIssuer");
    expect(runtime).not.toHaveProperty("resource");
  });

  it("assembles OAuth, rate limits, mTLS delegation, and the social-loop tool set together", () => {
    const runtime = createMcpRuntimeAssembly(enabledEnvironment, {} as never);

    expect(runtime.runtimeEnabled).toBe(true);
    if (!runtime.runtimeEnabled) throw new Error("expected enabled runtime");
    expect(runtime.oauthIssuer).toBe("https://auth.alphanet.example/");
    expect(runtime.resource).toBe("https://alphanet.example/mcp");
    expect(runtime.authorizationMiddleware).toBeTypeOf("function");
    expect(runtime.requestRateLimiter).toBeTypeOf("function");
    expect(runtime.actorRateLimiter).toBeTypeOf("function");
    expect(runtime.tools.map((tool) => tool.definition.name)).toEqual([
      "get_agent_context",
      "find_communities",
      "get_community",
      "browse_content",
      "search_content",
      "get_content",
      "get_discussion",
      "list_notifications",
      "get_action_status",
      "create_post",
      "reply_to_content",
      "update_content",
      "delete_content",
      "set_reaction",
      "set_follow",
      "list_follows",
    ]);
  });

  it("publishes the exact social-loop registry through tools/list within the wire bound", async () => {
    const runtime = createMcpRuntimeAssembly(enabledEnvironment, {} as never);

    expect(runtime.runtimeEnabled).toBe(true);
    if (!runtime.runtimeEnabled) throw new Error("expected enabled runtime");
    const resource = "https://alphanet.example/mcp";
    const authorizationMiddleware: RequestHandler = (requestValue, _response, next) => {
      (requestValue as Request & { auth?: AuthInfo }).auth = {
        clientId: "phase-b-discovery-client",
        expiresAt: Math.floor(Date.now() / 1_000) + 600,
        extra: {
          actor: {
            credentialId: "22222222-2222-4222-8222-222222222222",
            grantId: "11111111-1111-4111-8111-111111111111",
            tokenJtiDigest: "A".repeat(43),
          },
        },
        resource: new URL(resource),
        scopes: [
          "research:read",
          "community:read",
          "notifications:read",
          "actions:read",
          "content:write",
          "reaction:write",
          "follow:write",
        ],
        token: "verified-phase-b-token",
      };
      next();
    };
    const app = createMcpApp({
      actorRateLimiter: () => ({ allowed: true }),
      allowedHosts: ["127.0.0.1", "localhost"],
      authorizationMiddleware,
      host: "127.0.0.1",
      logger,
      oauthIssuer: runtime.oauthIssuer,
      requestRateLimiter: () => ({ allowed: true }),
      resolveClientIp: () => "203.0.113.10",
      resource,
      runtimeEnabled: true,
      tools: runtime.tools,
      version: "test-version",
    });

    try {
      const response = await request(app.app)
        .post("/mcp")
        .set("accept", "application/json, text/event-stream")
        .set("content-type", "application/json")
        .set("mcp-protocol-version", "2025-11-25")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      const body = response.body as {
        result?: { tools?: Array<{ name?: string }> };
      };

      expect(response.status).toBe(200);
      expect(body.result?.tools?.map(({ name }) => name)).toEqual([
        "get_agent_context",
        "find_communities",
        "get_community",
        "browse_content",
        "search_content",
        "get_content",
        "get_discussion",
        "list_notifications",
        "get_action_status",
        "create_post",
        "reply_to_content",
        "update_content",
        "delete_content",
        "set_reaction",
        "set_follow",
        "list_follows",
      ]);
      expect(JSON.stringify(body)).not.toContain("get_platform_status");
      expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeLessThanOrEqual(
        MCP_MAX_RESPONSE_BYTES,
      );
    } finally {
      await app.close();
    }
  });

  it("fails closed if an enabled tuple is incomplete despite upstream validation", () => {
    expect(() =>
      createMcpRuntimeAssembly(
        { ...enabledEnvironment, MCP_INTERNAL_API_URL: undefined },
        {} as never,
      ),
    ).toThrow("Remote MCP runtime configuration is incomplete");
  });
});
