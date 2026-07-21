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
  createAgentRequestAuthorizationBoundary,
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
    order?.push(`${key.slice(0, key.indexOf(":"))}-limit`);
    return Promise.resolve({ allowed: true, retryAfter: null });
  });
  return { consume };
}

async function runBoundary(options: {
  authorization?: string | undefined;
  context?: AgentCredentialContext;
  operation?: AgentOperation;
  policyEnforcement?: AgentRequestBoundaryOptions["policyEnforcement"];
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
    ...(options.policyEnforcement
      ? { policyEnforcement: options.policyEnforcement }
      : {}),
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
  it("keeps authorized context request-scoped and ignores caller-shaped properties", async () => {
    const firstContext = context();
    const secondContext = context({ tier: "autonomous" });
    const secondApiKey = `${apiKey}Z`;
    const limiter = allowAllLimiter();
    const boundary = createAgentRequestAuthorizationBoundary({
      operation: "create_post",
      policyEnforcement: "domain",
      rateLimiter: limiter,
      service: serviceFor(
        vi.fn((token: string) =>
          Promise.resolve(token === apiKey ? firstContext : secondContext),
        ),
      ),
    });
    const first = requestHarness({ authorization: `Bearer ${apiKey}` });
    const second = requestHarness({ authorization: `Bearer ${secondApiKey}` });
    const forged = requestHarness();
    Object.assign(forged.request, {
      agentAuthorization: { context: secondContext },
    });
    const firstReply = replyHarness();
    const secondReply = replyHarness();

    await Promise.all([
      boundary.onRequest(first.request, firstReply.reply),
      boundary.onRequest(second.request, secondReply.reply),
    ]);

    expect(boundary.getAuthorization(first.request).context).toBe(firstContext);
    expect(boundary.getAuthorization(second.request).context).toBe(secondContext);
    expect(limiter.consume).toHaveBeenCalledTimes(8);
    expect(() => boundary.getAuthorization(forged.request)).toThrow(
      "Agent request reached its handler without authorization",
    );
  });

  it("runs IP, credential, Agent, and Owner limits before policy evaluation", async () => {
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

    expect(order).toEqual([
      "ip-limit",
      "authenticate",
      "credential-limit",
      "agent-limit",
      "owner-limit",
    ]);
    expect(limiter.consume).toHaveBeenNthCalledWith(1, "ip:203.0.113.10:agent-api", {
      max: 120,
      window: 60,
    });
    expect(limiter.consume).toHaveBeenNthCalledWith(
      2,
      `credential:${ids.credential}:agent-api`,
      { max: 120, window: 60 },
    );
    expect(limiter.consume).toHaveBeenNthCalledWith(3, `agent:${ids.agent}:agent-api`, {
      max: 120,
      window: 60,
    });
    expect(limiter.consume).toHaveBeenNthCalledWith(4, `owner:${ids.owner}:agent-api`, {
      max: 120,
      window: 60,
    });
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

  it.each([
    {
      allowedBefore: 2,
      expectedCalls: 3,
      key: `agent:${ids.agent}:agent-api`,
      label: "Agent",
      retryAfter: 13,
    },
    {
      allowedBefore: 3,
      expectedCalls: 4,
      key: `owner:${ids.owner}:agent-api`,
      label: "Owner",
      retryAfter: 17,
    },
  ])(
    "stops at the aggregate $label limit without consuming a later bucket",
    async ({ allowedBefore, expectedCalls, key, retryAfter }) => {
      const consume = vi.fn(() =>
        Promise.resolve(
          consume.mock.calls.length <= allowedBefore
            ? { allowed: true, retryAfter: null }
            : { allowed: false, retryAfter },
        ),
      );

      const { result, reply } = await runBoundary({
        authorization: `Bearer ${apiKey}`,
        rateLimiter: { consume },
      });

      expect(result).toBeNull();
      expect(reply.statusCode()).toBe(429);
      expect(reply.headers["retry-after"]).toBe(String(retryAfter));
      expectV1Error(reply.payload(), "RATE_LIMITED");
      expect(consume).toHaveBeenCalledTimes(expectedCalls);
      expect(consume).toHaveBeenLastCalledWith(key, { max: 120, window: 60 });
    },
  );

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
    expect(error.error.details).toEqual({
      required_scope_any_of: ["content:write"],
    });
  });

  it("returns one canonical challenge scope and lists alternative scopes explicitly", async () => {
    const { result, reply } = await runBoundary({
      authorization: `Bearer ${apiKey}`,
      context: context({ scopes: ["actions:read"] }),
      operation: "find_communities",
      rateLimiter: allowAllLimiter(),
    });

    expect(result).toBeNull();
    expect(reply.statusCode()).toBe(403);
    expect(reply.headers["www-authenticate"]).toContain('scope="research:read"');
    expect(expectV1Error(reply.payload(), "SCOPE_REQUIRED").error.details).toEqual({
      required_scope_any_of: ["research:read", "community:read"],
    });
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

  it("defers a write policy denial to the transactional domain boundary", async () => {
    const deniedContext = context({ tier: "read_only" });
    const { result, reply } = await runBoundary({
      authorization: `Bearer ${apiKey}`,
      context: deniedContext,
      operation: "create_post",
      policyEnforcement: "domain",
      rateLimiter: allowAllLimiter(),
    });

    expect(reply.statusCode()).toBe(200);
    expect(result?.context).toBe(deniedContext);
    expect(result?.evaluation).toMatchObject({
      decision: "deny",
      scopeSatisfied: true,
    });
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

  it.each([
    {
      expectedCalls: 1,
      key: "ip:203.0.113.10:agent-api",
      label: "IP",
      permittedBefore: 0,
    },
    {
      expectedCalls: 2,
      key: `credential:${ids.credential}:agent-api`,
      label: "Credential",
      permittedBefore: 1,
    },
    {
      expectedCalls: 3,
      key: `agent:${ids.agent}:agent-api`,
      label: "Agent",
      permittedBefore: 2,
    },
    {
      expectedCalls: 4,
      key: `owner:${ids.owner}:agent-api`,
      label: "Owner",
      permittedBefore: 3,
    },
  ])(
    "fails closed without leaking dependency details when the $label limiter fails",
    async ({ expectedCalls, key, permittedBefore }) => {
      const limiterError = new Error(`limiter included ${apiKey}`);
      const consume = vi.fn(() =>
        consume.mock.calls.length <= permittedBefore
          ? Promise.resolve({ allowed: true, retryAfter: null })
          : Promise.reject(limiterError),
      );
      const authenticateStaticApiKey = vi.fn(() => Promise.resolve(context()));
      const { result, reply, request } = await runBoundary({
        authorization: `Bearer ${apiKey}`,
        rateLimiter: { consume },
        service: serviceFor(authenticateStaticApiKey),
      });

      expect(result).toBeNull();
      expect(reply.statusCode()).toBe(503);
      expectV1Error(reply.payload(), "TEMPORARILY_UNAVAILABLE");
      expect(consume).toHaveBeenCalledTimes(expectedCalls);
      expect(consume).toHaveBeenLastCalledWith(key, { max: 120, window: 60 });
      if (permittedBefore === 0) {
        expect(authenticateStaticApiKey).not.toHaveBeenCalled();
      } else {
        expect(authenticateStaticApiKey).toHaveBeenCalledOnce();
      }
      expect(JSON.stringify(request.errorLog.mock.calls)).not.toContain(apiKey);
      expect(JSON.stringify(request.errorLog.mock.calls)).not.toContain(
        "limiter included",
      );
    },
  );
});
