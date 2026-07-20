import { V1ErrorResponseSchema } from "@alphanet/contracts";
import {
  AgentConnectionError,
  type AgentConnectionService,
  type AgentCredentialContext,
  type AgentOperation,
  type AgentPolicyTier,
  type AgentScope,
} from "@alphanet/domain";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  authorizeAgentRequest,
  type AgentRequestBoundaryOptions,
  type AgentRequestRateLimiter,
} from "./agent-request.js";

const ids = {
  actor: "00000000-0000-4000-8000-000000000001",
  agent: "00000000-0000-4000-8000-000000000002",
  credential: "00000000-0000-4000-8000-000000000003",
  owner: "00000000-0000-4000-8000-000000000004",
  policy: "00000000-0000-4000-8000-000000000005",
} as const;
const createdAt = new Date("2026-07-20T12:00:00.000Z");
const apiKey = "aln_v1_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";

function context(options?: {
  ceiling?: AgentPolicyTier;
  scopes?: AgentScope[];
  tier?: AgentPolicyTier;
}): AgentCredentialContext {
  return {
    agent: {
      id: ids.agent,
      actorId: ids.actor,
      ownerId: ids.owner,
      handle: "market-scout",
      displayName: "Market Scout",
      bio: null,
      discoveryTags: ["semiconductors"],
      status: "active",
      restrictionReasonCode: null,
      credentialCount: 1,
      createdAt,
      updatedAt: createdAt,
      activatedAt: createdAt,
      archivedAt: null,
      policy: {
        id: ids.policy,
        tier: options?.tier ?? "assisted",
        defaultsVersion: "agent-permission-defaults-v1",
        schemaVersion: 1,
        version: "1",
        effectiveFrom: createdAt,
      },
    },
    credential: {
      id: ids.credential,
      ownerId: ids.owner,
      agentId: ids.agent,
      name: "Research runner",
      type: "static_api_key",
      prefix: "aln_v1_abcdefghijkl",
      scopes: options?.scopes ?? ["research:read", "content:write"],
      audience: "https://api.alphanet.test/v1",
      policyCeiling: options?.ceiling ?? "assisted",
      issuedAt: createdAt,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      replacesCredentialId: null,
      status: "active",
    },
    owner: { id: ids.owner },
  };
}

interface RequestHarness {
  errorLog: ReturnType<typeof vi.fn>;
  request: FastifyRequest;
}

function requestHarness(options?: {
  authorization?: string | undefined;
  url?: string | undefined;
}): RequestHarness {
  const errorLog = vi.fn();
  return {
    errorLog,
    request: {
      headers: options?.authorization ? { authorization: options.authorization } : {},
      id: "request-1",
      ip: "203.0.113.10",
      log: { error: errorLog },
      url: options?.url ?? "/v1/test",
    } as unknown as FastifyRequest,
  };
}

interface ReplyHarness {
  headers: Record<string, string>;
  payload: () => unknown;
  reply: FastifyReply;
  statusCode: () => number;
}

function replyHarness(): ReplyHarness {
  const headers: Record<string, string> = {};
  let body: unknown;
  let status = 200;
  const replyShape = {
    code(value: number) {
      status = value;
      return replyShape;
    },
    header(name: string, value: unknown) {
      headers[name.toLowerCase()] = String(value);
      return replyShape;
    },
    send(value: unknown) {
      body = value;
      return replyShape;
    },
  };
  return {
    headers,
    payload: () => body,
    reply: replyShape as unknown as FastifyReply,
    statusCode: () => status,
  };
}

function serviceFor(
  authenticateStaticApiKey: AgentConnectionService["authenticateStaticApiKey"],
): Pick<AgentConnectionService, "authenticateStaticApiKey"> {
  return { authenticateStaticApiKey };
}

function allowAllLimiter(
  order?: string[],
): AgentRequestRateLimiter & { consume: ReturnType<typeof vi.fn> } {
  const consume = vi.fn((key: string) => {
    order?.push(key.startsWith("ip:") ? "ip-limit" : "credential-limit");
    return Promise.resolve({ allowed: true, retryAfter: null });
  });
  return { consume };
}

async function runBoundary(options: {
  authorization?: string | undefined;
  context?: AgentCredentialContext;
  operation?: AgentOperation;
  rateLimiter?: AgentRequestRateLimiter;
  service?: Pick<AgentConnectionService, "authenticateStaticApiKey">;
  url?: string | undefined;
}) {
  const request = requestHarness({
    authorization: options.authorization,
    url: options.url,
  });
  const reply = replyHarness();
  const authenticatedContext = options.context ?? context();
  const service =
    options.service ?? serviceFor(vi.fn(() => Promise.resolve(authenticatedContext)));
  const boundaryOptions: AgentRequestBoundaryOptions = {
    operation: options.operation ?? "create_post",
    service,
  };
  if (options.rateLimiter) {
    boundaryOptions.rateLimiter = options.rateLimiter;
  }
  const result = await authorizeAgentRequest(
    request.request,
    reply.reply,
    boundaryOptions,
  );
  return { reply, request, result, service };
}

function expectV1Error(payload: unknown, code: string) {
  const parsed = V1ErrorResponseSchema.parse(payload);
  expect(parsed.schema_version).toBe("1");
  expect(parsed.request_id).toBe("request-1");
  expect(parsed.error.code).toBe(code);
  return parsed;
}

describe("authorizeAgentRequest", () => {
  it("runs IP limit, authentication, credential limit, and policy evaluation in order", async () => {
    const order: string[] = [];
    const authenticatedContext = context();
    const limiter = allowAllLimiter(order);
    const authenticateStaticApiKey = vi.fn((token: string) => {
      order.push("authenticate");
      expect(token).toBe(apiKey);
      return Promise.resolve(authenticatedContext);
    });

    const { result, reply } = await runBoundary({
      authorization: `Bearer ${apiKey}`,
      context: authenticatedContext,
      rateLimiter: limiter,
      service: serviceFor(authenticateStaticApiKey),
    });

    expect(order).toEqual(["ip-limit", "authenticate", "credential-limit"]);
    expect(limiter.consume).toHaveBeenNthCalledWith(1, "ip:203.0.113.10:agent-api", {
      max: 120,
      window: 60,
    });
    expect(limiter.consume).toHaveBeenNthCalledWith(
      2,
      `credential:${ids.credential}:agent-api`,
      { max: 120, window: 60 },
    );
    expect(reply.statusCode()).toBe(200);
    expect(result?.context).toBe(authenticatedContext);
    expect(result?.evaluation).toMatchObject({
      decision: "require_approval",
      matchedScope: "content:write",
      reason: "OWNER_APPROVAL_REQUIRED",
      scopeSatisfied: true,
    });
  });

  it.each([
    { label: "a missing credential", authorization: undefined },
    { label: "a lowercase scheme", authorization: `bearer ${apiKey}` },
    { label: "extra bearer whitespace", authorization: `Bearer  ${apiKey}` },
    { label: "a non-bearer scheme", authorization: `Basic ${apiKey}` },
  ])("rejects $label after the IP limit", async ({ authorization }) => {
    const limiter = allowAllLimiter();
    const authenticateStaticApiKey = vi.fn(() => Promise.resolve(context()));
    const { result, reply } = await runBoundary({
      authorization,
      rateLimiter: limiter,
      service: serviceFor(authenticateStaticApiKey),
    });

    expect(result).toBeNull();
    expect(reply.statusCode()).toBe(401);
    expect(reply.headers["www-authenticate"]).toBe("Bearer");
    expectV1Error(reply.payload(), "AUTHENTICATION_REQUIRED");
    expect(limiter.consume).toHaveBeenCalledTimes(1);
    expect(authenticateStaticApiKey).not.toHaveBeenCalled();
  });

  it.each(["access_token", "api_key", "token", "ToKeN"])(
    "rejects the %s query credential even when a valid header is present",
    async (parameter) => {
      const limiter = allowAllLimiter();
      const authenticateStaticApiKey = vi.fn(() => Promise.resolve(context()));
      const { result, reply, request } = await runBoundary({
        authorization: `Bearer ${apiKey}`,
        rateLimiter: limiter,
        service: serviceFor(authenticateStaticApiKey),
        url: `/v1/test?${parameter}=do-not-use`,
      });

      expect(result).toBeNull();
      expect(reply.statusCode()).toBe(401);
      expectV1Error(reply.payload(), "AUTHENTICATION_REQUIRED");
      expect(authenticateStaticApiKey).not.toHaveBeenCalled();
      expect(JSON.stringify(request.errorLog.mock.calls)).not.toContain("do-not-use");
    },
  );

  it("stops before authentication when the IP limit is exhausted", async () => {
    const consume = vi.fn(() => Promise.resolve({ allowed: false, retryAfter: 7 }));
    const authenticateStaticApiKey = vi.fn(() => Promise.resolve(context()));
    const { result, reply } = await runBoundary({
      authorization: `Bearer ${apiKey}`,
      rateLimiter: { consume },
      service: serviceFor(authenticateStaticApiKey),
    });

    expect(result).toBeNull();
    expect(reply.statusCode()).toBe(429);
    expect(reply.headers["retry-after"]).toBe("7");
    expectV1Error(reply.payload(), "RATE_LIMITED");
    expect(consume).toHaveBeenCalledTimes(1);
    expect(authenticateStaticApiKey).not.toHaveBeenCalled();
  });

  it("stops after authentication when the credential limit is exhausted", async () => {
    const consume = vi
      .fn()
      .mockResolvedValueOnce({ allowed: true, retryAfter: null })
      .mockResolvedValueOnce({ allowed: false, retryAfter: 11 });
    const authenticateStaticApiKey = vi.fn(() => Promise.resolve(context()));
    const { result, reply } = await runBoundary({
      authorization: `Bearer ${apiKey}`,
      rateLimiter: { consume },
      service: serviceFor(authenticateStaticApiKey),
    });

    expect(result).toBeNull();
    expect(reply.statusCode()).toBe(429);
    expect(reply.headers["retry-after"]).toBe("11");
    expectV1Error(reply.payload(), "RATE_LIMITED");
    expect(consume).toHaveBeenCalledTimes(2);
    expect(authenticateStaticApiKey).toHaveBeenCalledOnce();
  });

  it("returns SCOPE_REQUIRED with the standard insufficient_scope challenge", async () => {
    const { result, reply } = await runBoundary({
      authorization: `Bearer ${apiKey}`,
      context: context({ scopes: ["research:read"] }),
      rateLimiter: allowAllLimiter(),
    });

    expect(result).toBeNull();
    expect(reply.statusCode()).toBe(403);
    expect(reply.headers["www-authenticate"]).toBe(
      'Bearer error="insufficient_scope", error_description="The Agent credential lacks a required scope.", scope="content:write"',
    );
    const error = expectV1Error(reply.payload(), "SCOPE_REQUIRED");
    expect(error.error.details).toEqual({ required_scopes: "content:write" });
  });

  it.each([
    {
      label: "a read-only write denial",
      operation: "create_post" as const,
      requestContext: context({ tier: "read_only" }),
    },
    {
      label: "unavailable custom read rules",
      operation: "browse_content" as const,
      requestContext: context({ ceiling: "autonomous", tier: "custom" }),
    },
  ])("fails closed with POLICY_DENIED for $label", async (testCase) => {
    const { result, reply } = await runBoundary({
      authorization: `Bearer ${apiKey}`,
      context: testCase.requestContext,
      operation: testCase.operation,
      rateLimiter: allowAllLimiter(),
    });

    expect(result).toBeNull();
    expect(reply.statusCode()).toBe(403);
    expectV1Error(reply.payload(), "POLICY_DENIED");
  });

  it("preserves AgentConnectionError as a stable V1 credential error", async () => {
    const authenticateStaticApiKey = vi.fn(() =>
      Promise.reject(new AgentConnectionError("CREDENTIAL_REVOKED")),
    );
    const { result, reply } = await runBoundary({
      authorization: `Bearer ${apiKey}`,
      rateLimiter: allowAllLimiter(),
      service: serviceFor(authenticateStaticApiKey),
    });

    expect(result).toBeNull();
    expect(reply.statusCode()).toBe(409);
    const error = expectV1Error(reply.payload(), "CREDENTIAL_REVOKED");
    expect(error.error).toMatchObject({
      message: "The Agent credential has been revoked.",
      retryable: false,
    });
  });

  it("fails closed with 503 and never logs a credential when authentication fails", async () => {
    const authenticateStaticApiKey = vi.fn(() =>
      Promise.reject(new Error(`backend included ${apiKey}`)),
    );
    const { result, reply, request } = await runBoundary({
      authorization: `Bearer ${apiKey}`,
      rateLimiter: allowAllLimiter(),
      service: serviceFor(authenticateStaticApiKey),
    });

    expect(result).toBeNull();
    expect(reply.statusCode()).toBe(503);
    expectV1Error(reply.payload(), "TEMPORARILY_UNAVAILABLE");
    expect(request.errorLog).toHaveBeenCalledWith(
      { errorName: "Error" },
      "Agent credential authentication failed",
    );
    const externallyVisible = JSON.stringify({
      body: reply.payload(),
      headers: reply.headers,
      logs: request.errorLog.mock.calls,
    });
    expect(externallyVisible).not.toContain(apiKey);
    expect(externallyVisible).not.toContain("backend included");
  });

  it("fails closed with 503 when the limiter dependency fails", async () => {
    const limiterError = new Error(`limiter included ${apiKey}`);
    const consume = vi.fn(() => Promise.reject(limiterError));
    const authenticateStaticApiKey = vi.fn(() => Promise.resolve(context()));
    const { result, reply, request } = await runBoundary({
      authorization: `Bearer ${apiKey}`,
      rateLimiter: { consume },
      service: serviceFor(authenticateStaticApiKey),
    });

    expect(result).toBeNull();
    expect(reply.statusCode()).toBe(503);
    expectV1Error(reply.payload(), "TEMPORARILY_UNAVAILABLE");
    expect(authenticateStaticApiKey).not.toHaveBeenCalled();
    expect(JSON.stringify(request.errorLog.mock.calls)).not.toContain(apiKey);
    expect(JSON.stringify(request.errorLog.mock.calls)).not.toContain("limiter included");
  });
});
