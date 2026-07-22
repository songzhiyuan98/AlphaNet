import {
  AGENT_TOOL_NAMES,
  AGENT_TOOL_SCOPE_POLICIES,
  V1ErrorResponseSchema,
  type AgentToolName,
} from "@alphanet/contracts";
import { createLogger } from "@alphanet/observability";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createMcpToolScopeMap,
  createProtocolServer,
  McpExecutionRegistry,
  MCP_TOOL_TIMEOUT_MILLISECONDS,
  parseMcpActorAuthorization,
  type McpProtocolServerOptions,
  type McpToolRegistration,
} from "./protocol.js";

const logger = createLogger({
  environment: "test",
  level: "silent",
  service: "mcp-protocol-test",
});
const requestId = "33333333-3333-4333-8333-333333333333";
const grantId = "11111111-1111-4111-8111-111111111111";
const credentialId = "22222222-2222-4222-8222-222222222222";
const tokenJtiDigest = "A".repeat(43);

function parseObject(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}

function parseSuccessOrV1Error(value: unknown): Record<string, unknown> {
  const error = V1ErrorResponseSchema.safeParse(value);
  return error.success ? error.data : parseObject(value);
}

function registration(name: AgentToolName = "search_content"): McpToolRegistration {
  return {
    definition: {
      name,
      inputSchema: { type: "object", additionalProperties: true },
    },
    execute: () => ({ payload: {} }),
    parseArguments: parseObject,
    parseOutput: parseSuccessOrV1Error,
    successOutputSchema: { type: "object", additionalProperties: true },
  };
}

function serverOptions(
  overrides: Partial<McpProtocolServerOptions> = {},
): McpProtocolServerOptions {
  return {
    executionRegistry: new McpExecutionRegistry(),
    logger,
    requestId,
    version: "test-version",
    ...overrides,
  };
}

describe("MCP protocol adapter", () => {
  it("rejects duplicate registry names", () => {
    const duplicate = registration();

    expect(() =>
      createProtocolServer(
        serverOptions({
          tools: [duplicate, duplicate],
        }),
      ),
    ).toThrow("Duplicate MCP tool registration: search_content");
  });

  it.each(["get_platform_status", "search_community", "custom_tool"])(
    "rejects non-canonical tool name %s",
    (name) => {
      const tool = {
        ...registration(),
        definition: {
          ...registration().definition,
          name,
        },
      };

      expect(() => createProtocolServer(serverOptions({ tools: [tool] }))).toThrow();
    },
  );

  it("accepts all and only the 16 canonical tool names", () => {
    expect(AGENT_TOOL_NAMES).toHaveLength(16);
    expect(() =>
      createProtocolServer(
        serverOptions({ tools: AGENT_TOOL_NAMES.map((name) => registration(name)) }),
      ),
    ).not.toThrow();
  });

  it("derives authenticated and any-of policies from the contracts authority", () => {
    const map = createMcpToolScopeMap([
      registration("get_agent_context"),
      registration("get_community"),
      registration("create_post"),
    ]);

    expect(map.get("get_agent_context")).toEqual({ kind: "authenticated" });
    expect(map.get("get_community")).toEqual({
      challengeScope: "community:read",
      kind: "any_of",
      requiredScopesAnyOf: ["community:read", "research:read"],
    });
    expect(map.get("create_post")).toEqual({
      challengeScope: "content:write",
      kind: "any_of",
      requiredScopesAnyOf: ["content:write"],
    });
    expect([...map.keys()]).toEqual([
      "get_agent_context",
      "get_community",
      "create_post",
    ]);
  });

  it("ignores a forged registration-local policy and uses the contract mapping", () => {
    const forged = {
      ...registration("create_post"),
      scopePolicy: { kind: "authenticated" },
    } as McpToolRegistration & { scopePolicy: { kind: "authenticated" } };

    expect(createMcpToolScopeMap([forged]).get("create_post")).toEqual(
      AGENT_TOOL_SCOPE_POLICIES.create_post,
    );
  });

  it("requires a success output schema for every published tool", () => {
    const tool = registration();

    expect(() =>
      createProtocolServer(
        serverOptions({
          tools: [
            {
              ...tool,
              successOutputSchema: undefined,
            } as unknown as McpToolRegistration,
          ],
        }),
      ),
    ).toThrow("MCP tool successOutputSchema is required: search_content");
  });

  it("keeps the registration success schema separate from the published union", () => {
    const tool = registration();

    expect(() => createProtocolServer(serverOptions({ tools: [tool] }))).not.toThrow();
    expect(tool.definition).not.toHaveProperty("outputSchema");
  });

  it("forbids MCP Tasks in v1", () => {
    const tool = registration();

    expect(() =>
      createProtocolServer(
        serverOptions({
          tools: [
            {
              ...tool,
              definition: {
                ...tool.definition,
                execution: { taskSupport: "optional" },
              },
            },
          ],
        }),
      ),
    ).toThrow("MCP Tasks are not enabled in v1: search_content");
  });

  it("allows an explicit forbidden MCP Tasks declaration", () => {
    const tool = registration();

    expect(() =>
      createProtocolServer(
        serverOptions({
          tools: [
            {
              ...tool,
              definition: {
                ...tool.definition,
                execution: { taskSupport: "forbidden" },
              },
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it.each(["parseArguments", "parseOutput"] as const)(
    "requires the %s boundary parser",
    (parserName) => {
      const tool = { ...registration() };
      Reflect.deleteProperty(tool, parserName);

      expect(() => createProtocolServer(serverOptions({ tools: [tool] }))).toThrow(
        "MCP tool parsers are required: search_content",
      );
    },
  );

  it.each([0, -1, 30_001, 1.5, Number.NaN])(
    "rejects invalid tool timeout %s",
    (toolTimeoutMilliseconds) => {
      expect(() =>
        createProtocolServer(serverOptions({ toolTimeoutMilliseconds })),
      ).toThrow("MCP tool timeout must be between 1 and 30000 milliseconds");
    },
  );

  it("accepts the maximum bounded tool timeout", () => {
    expect(() =>
      createProtocolServer(
        serverOptions({ toolTimeoutMilliseconds: MCP_TOOL_TIMEOUT_MILLISECONDS }),
      ),
    ).not.toThrow();
  });

  it("requires the execution request id to be a UUID", () => {
    expect(() =>
      createProtocolServer(serverOptions({ requestId: "client-controlled-id" })),
    ).toThrow();
  });

  it("parses only the exact trusted actor context", () => {
    expect(parseMcpActorAuthorization({ credentialId, grantId, tokenJtiDigest })).toEqual(
      { credentialId, grantId, tokenJtiDigest },
    );
    expect(
      parseMcpActorAuthorization({
        credentialId,
        grantId,
        tokenJtiDigest,
        ownerId: "must-not-pass",
      }),
    ).toBeNull();
    expect(
      parseMcpActorAuthorization({ credentialId, grantId, tokenJtiDigest: "short" }),
    ).toBeNull();
    expect(parseMcpActorAuthorization(undefined)).toBeNull();
  });

  it("aborts registered executions and honors explicit unregister", () => {
    const registry = new McpExecutionRegistry();
    const cancelled = new AbortController();
    const completed = new AbortController();
    registry.register(cancelled);
    const unregisterCompleted = registry.register(completed);
    unregisterCompleted();

    registry.abortAll();

    expect(cancelled.signal.aborted).toBe(true);
    expect(completed.signal.aborted).toBe(false);
  });
});
