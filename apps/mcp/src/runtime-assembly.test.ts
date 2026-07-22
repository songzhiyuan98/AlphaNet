import { describe, expect, it } from "vitest";

import { createMcpRuntimeAssembly } from "./runtime-assembly.js";

const disabledEnvironment = {
  MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64: undefined,
  MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64: undefined,
  MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION: undefined,
  MCP_ACTOR_ASSERTION_PREVIOUS_KEYS: {},
  MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64: undefined,
  MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64: undefined,
  MCP_INTERNAL_API_MAX_RESPONSE_BYTES: 4 * 1_024 * 1_024,
  MCP_INTERNAL_API_SERVER_CA_PEM_BASE64: undefined,
  MCP_INTERNAL_API_TIMEOUT_MS: 5_000,
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
    expect(runtime).not.toHaveProperty("resource");
  });

  it("assembles OAuth, rate limits, mTLS delegation, and the first real tool together", () => {
    const runtime = createMcpRuntimeAssembly(enabledEnvironment, {} as never);

    expect(runtime.runtimeEnabled).toBe(true);
    if (!runtime.runtimeEnabled) throw new Error("expected enabled runtime");
    expect(runtime.resource).toBe("https://alphanet.example/mcp");
    expect(runtime.authorizationMiddleware).toBeTypeOf("function");
    expect(runtime.requestRateLimiter).toBeTypeOf("function");
    expect(runtime.actorRateLimiter).toBeTypeOf("function");
    expect(runtime.tools.map((tool) => tool.definition.name)).toEqual([
      "get_agent_context",
    ]);
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
