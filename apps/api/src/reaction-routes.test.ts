import { SetReactionWriteResultSchema, V1ErrorResponseSchema } from "@alphanet/contracts";
import {
  ReactionWriteError,
  type AgentConnectionService,
  type AgentCredentialContext,
  type ReactionWriteErrorCode,
  type ReactionWriteOutcome,
  type ReactionWriteService,
} from "@alphanet/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRequestRateLimiter } from "./agent-request.js";
import { registerReactionRoutes } from "./reaction-routes.js";

const ids = {
  actor: "20000000-0000-4000-8000-000000000001",
  agent: "30000000-0000-4000-8000-000000000001",
  content: "50000000-0000-4000-8000-000000000001",
  credential: "60000000-0000-4000-8000-000000000001",
  owner: "70000000-0000-4000-8000-000000000001",
  policy: "80000000-0000-4000-8000-000000000001",
} as const;
const apiKey = "aln_v1_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const now = new Date("2026-07-20T12:00:00.000Z");
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function context(options?: {
  scopes?: AgentCredentialContext["credential"]["scopes"];
  tier?: AgentCredentialContext["agent"]["policy"]["tier"];
}): AgentCredentialContext {
  return {
    agent: {
      id: ids.agent,
      actorId: ids.actor,
      ownerId: ids.owner,
      handle: "market-scout",
      displayName: "Market Scout",
      bio: null,
      discoveryTags: [],
      status: "active",
      restrictionReasonCode: null,
      credentialCount: 1,
      createdAt: now,
      updatedAt: now,
      activatedAt: now,
      archivedAt: null,
      policy: {
        id: ids.policy,
        tier: options?.tier ?? "autonomous",
        defaultsVersion: "agent-permission-defaults-v1",
        schemaVersion: 1,
        version: "1",
        effectiveFrom: now,
        rules: { operations: {} },
      },
    },
    credential: {
      id: ids.credential,
      ownerId: ids.owner,
      agentId: ids.agent,
      name: "Research runner",
      type: "static_api_key",
      prefix: "aln_v1_abcdefghijkl",
      scopes: options?.scopes ?? ["reaction:write"],
      audience: "urn:alphanet:api:v1",
      policyCeiling: options?.tier ?? "autonomous",
      policyCeilingDefaultsVersion: "agent-permission-defaults-v1",
      policyCeilingRules: { operations: {} },
      policyCeilingSchemaVersion: 1,
      issuedAt: now,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      replacesCredentialId: null,
      status: "active",
    },
    owner: { id: ids.owner },
  };
}

function succeededOutcome(): ReactionWriteOutcome {
  return {
    operation: "set_reaction",
    decision: "allow",
    status: "succeeded",
    result: {
      contentId: ids.content,
      reactionCounts: { helpful: 7, agree: 3, disagree: 2 },
      viewerState: {
        following: false,
        reactions: ["helpful", "disagree"],
      },
    },
    pendingAction: null,
    error: null,
    replayed: false,
  };
}

function writeErrorOutcome(
  code: ReactionWriteErrorCode,
  options: {
    decision?: ReactionWriteOutcome["decision"] | undefined;
    retryAfterMs?: number | null | undefined;
    retryable?: boolean | undefined;
    status?: ReactionWriteOutcome["status"] | undefined;
  } = {},
): ReactionWriteOutcome {
  return {
    operation: "set_reaction",
    decision: options.decision ?? "allow",
    status: options.status ?? "failed",
    result: null,
    pendingAction: null,
    error: new ReactionWriteError(code, `Expected ${code} test failure.`, {
      retryAfterMs: options.retryAfterMs ?? null,
      retryable: options.retryable ?? false,
    }).toDetail(),
    replayed: false,
  };
}

function createApp(options?: {
  bodyLimit?: number;
  context?: AgentCredentialContext;
  rateLimiter?: AgentRequestRateLimiter;
  setReaction?: ReactionWriteService["setReaction"];
}) {
  const app = Fastify({
    ...(options?.bodyLimit ? { bodyLimit: options.bodyLimit } : {}),
    logger: false,
  });
  const setReaction = vi.fn<ReactionWriteService["setReaction"]>(
    options?.setReaction ?? (() => Promise.resolve(succeededOutcome())),
  );
  const authenticateStaticApiKey = vi.fn<
    AgentConnectionService["authenticateStaticApiKey"]
  >(() => Promise.resolve(options?.context ?? context()));
  registerReactionRoutes(app, {
    agentConnectionService: { authenticateStaticApiKey },
    ...(options?.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    service: {
      checkReady: vi.fn(() => Promise.resolve()),
      setReaction,
    },
  });
  apps.push(app);
  return { app, authenticateStaticApiKey, setReaction };
}

describe("Reaction Agent route", () => {
  it.each([
    {
      bodyLimit: undefined,
      expectedParseStatus: 400,
      headers: { "content-type": "application/json" },
      label: "malformed JSON",
      payload: "{",
    },
    {
      bodyLimit: undefined,
      expectedParseStatus: 415,
      headers: { "content-type": "application/xml" },
      label: "an unsupported media type",
      payload: "<reaction />",
    },
    {
      bodyLimit: 64,
      expectedParseStatus: 413,
      headers: { "content-type": "application/json" },
      label: "an oversized body",
      payload: JSON.stringify({ active: true, padding: "x".repeat(128) }),
    },
  ])(
    "applies limiting, authentication, and reaction:write scope before $label parsing",
    async ({ bodyLimit, expectedParseStatus, headers, payload }) => {
      const unauthenticatedLimit = vi.fn(() =>
        Promise.resolve({ allowed: true, retryAfter: null }),
      );
      const unauthenticated = createApp({
        ...(bodyLimit ? { bodyLimit } : {}),
        rateLimiter: { consume: unauthenticatedLimit },
      });
      const unauthenticatedResponse = await unauthenticated.app.inject({
        headers,
        method: "PUT",
        payload,
        url: `/v1/content/${ids.content}/reactions/helpful`,
      });

      expect(unauthenticatedResponse.statusCode).toBe(401);
      expect(V1ErrorResponseSchema.parse(unauthenticatedResponse.json()).error.code).toBe(
        "AUTHENTICATION_REQUIRED",
      );
      expect(unauthenticatedLimit).toHaveBeenCalledOnce();
      expect(unauthenticated.authenticateStaticApiKey).not.toHaveBeenCalled();
      expect(unauthenticated.setReaction).not.toHaveBeenCalled();

      const insufficientScopeLimit = vi.fn(() =>
        Promise.resolve({ allowed: true, retryAfter: null }),
      );
      const insufficientScope = createApp({
        ...(bodyLimit ? { bodyLimit } : {}),
        context: context({ scopes: ["research:read"] }),
        rateLimiter: { consume: insufficientScopeLimit },
      });
      const insufficientScopeResponse = await insufficientScope.app.inject({
        headers: { ...headers, authorization: `Bearer ${apiKey}` },
        method: "PUT",
        payload,
        url: `/v1/content/${ids.content}/reactions/helpful`,
      });

      expect(insufficientScopeResponse.statusCode).toBe(403);
      expect(
        V1ErrorResponseSchema.parse(insufficientScopeResponse.json()).error.code,
      ).toBe("SCOPE_REQUIRED");
      expect(insufficientScopeResponse.headers["www-authenticate"]).toContain(
        'scope="reaction:write"',
      );
      expect(insufficientScopeLimit).toHaveBeenCalledTimes(4);
      expect(insufficientScope.authenticateStaticApiKey).toHaveBeenCalledOnce();
      expect(insufficientScope.setReaction).not.toHaveBeenCalled();

      const authorizedLimit = vi.fn(() =>
        Promise.resolve({ allowed: true, retryAfter: null }),
      );
      const authorized = createApp({
        ...(bodyLimit ? { bodyLimit } : {}),
        rateLimiter: { consume: authorizedLimit },
      });
      const authorizedResponse = await authorized.app.inject({
        headers: { ...headers, authorization: `Bearer ${apiKey}` },
        method: "PUT",
        payload,
        url: `/v1/content/${ids.content}/reactions/helpful`,
      });

      expect(authorizedResponse.statusCode).toBe(expectedParseStatus);
      expect(authorizedLimit).toHaveBeenCalledTimes(4);
      expect(authorized.authenticateStaticApiKey).toHaveBeenCalledOnce();
      expect(authorized.setReaction).not.toHaveBeenCalled();
    },
  );

  it("serializes a successful target-state write and applies the route credential limit", async () => {
    const consume = vi.fn(() => Promise.resolve({ allowed: true, retryAfter: null }));
    const { app, setReaction } = createApp({ rateLimiter: { consume } });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "reaction-helpful-v1",
        "x-request-id": "req-reaction",
      },
      method: "PUT",
      payload: { active: true },
      url: `/v1/content/${ids.content}/reactions/helpful`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(response.headers.pragma).toBe("no-cache");
    expect(SetReactionWriteResultSchema.parse(response.json())).toMatchObject({
      decision: "allow",
      status: "succeeded",
      pending_action: null,
      error: null,
      result: {
        content_id: ids.content,
        reaction_counts: { helpful: 7, agree: 3, disagree: 2 },
        viewer_state: {
          following: false,
          reactions: ["helpful", "disagree"],
        },
      },
    });
    expect(setReaction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ owner: { id: ids.owner } }),
      {
        active: true,
        contentId: ids.content,
        idempotencyKey: "reaction-helpful-v1",
        reaction: "helpful",
      },
      { channel: "rest", requestId: setReaction.mock.calls[0]?.[2].requestId },
    );
    expect(setReaction.mock.calls[0]?.[2].requestId).toBeTypeOf("string");
    expect(consume).toHaveBeenCalledTimes(4);
    expect(consume.mock.calls).toEqual([
      ["ip:127.0.0.1:agent-api", { max: 120, window: 60 }],
      [`credential:${ids.credential}:agent-api`, { max: 20, window: 60 }],
      [`agent:${ids.agent}:agent-api`, { max: 120, window: 60 }],
      [`owner:${ids.owner}:agent-api`, { max: 120, window: 60 }],
    ]);
  });

  it("requires exactly one header key and rejects path/body authority forgery", async () => {
    const { app, setReaction } = createApp();
    const baseRequest = {
      headers: { authorization: `Bearer ${apiKey}` },
      method: "PUT" as const,
      payload: { active: true },
    };
    const missing = await app.inject({
      ...baseRequest,
      url: `/v1/content/${ids.content}/reactions/helpful`,
    });
    const duplicated = await app.inject({
      ...baseRequest,
      headers: {
        ...baseRequest.headers,
        "idempotency-key": ["first-key", "second-key"],
      },
      url: `/v1/content/${ids.content}/reactions/helpful`,
    });
    const commaJoined = await app.inject({
      ...baseRequest,
      headers: {
        ...baseRequest.headers,
        "idempotency-key": "first-key,second-key",
      },
      url: `/v1/content/${ids.content}/reactions/helpful`,
    });
    const forgedBody = await app.inject({
      ...baseRequest,
      headers: {
        ...baseRequest.headers,
        "idempotency-key": "header-key",
      },
      payload: {
        active: true,
        idempotency_key: "body-key",
        content_id: "cnt_forged",
      },
      url: `/v1/content/${ids.content}/reactions/helpful`,
    });
    const unknownReaction = await app.inject({
      ...baseRequest,
      headers: {
        ...baseRequest.headers,
        "idempotency-key": "unknown-reaction",
      },
      url: `/v1/content/${ids.content}/reactions/like`,
    });

    for (const response of [
      missing,
      duplicated,
      commaJoined,
      forgedBody,
      unknownReaction,
    ]) {
      expect(response.statusCode).toBe(422);
      expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
        "VALIDATION_ERROR",
      );
    }
    expect(setReaction).not.toHaveBeenCalled();
  });

  it("returns authoritative domain throttling in the Reaction result shape", async () => {
    const { app } = createApp({
      setReaction: () =>
        Promise.resolve(
          writeErrorOutcome("RATE_LIMITED", {
            decision: "deny",
            retryAfterMs: 75_000,
            retryable: true,
            status: "denied",
          }),
        ),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "reaction-rate-limited",
      },
      method: "PUT",
      payload: { active: true },
      url: `/v1/content/${ids.content}/reactions/agree`,
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("75");
    expect(SetReactionWriteResultSchema.parse(response.json())).toMatchObject({
      decision: "deny",
      status: "denied",
      result: null,
      pending_action: null,
      error: {
        code: "RATE_LIMITED",
        retryable: true,
        retry_after_ms: 75_000,
      },
    });
  });

  it.each([
    { code: "AUTHORIZATION_CONTEXT_STALE" as const, statusCode: 401 },
    { code: "CONTENT_NOT_FOUND" as const, statusCode: 404 },
    { code: "CONTENT_STATE_INVALID" as const, statusCode: 409 },
    { code: "IDEMPOTENCY_CONFLICT" as const, statusCode: 409 },
    { code: "IDEMPOTENCY_IN_PROGRESS" as const, statusCode: 409 },
    { code: "SELF_REACTION_NOT_ALLOWED" as const, statusCode: 409 },
    { code: "POLICY_DENIED" as const, statusCode: 403 },
    { code: "SCOPE_REQUIRED" as const, statusCode: 403 },
    { code: "VALIDATION_ERROR" as const, statusCode: 422 },
    { code: "IDEMPOTENCY_RESULT_CORRUPT" as const, statusCode: 503 },
  ])("returns $code in the Reaction write-result shape", async ({ code, statusCode }) => {
    const { app } = createApp({
      setReaction: () => Promise.resolve(writeErrorOutcome(code)),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": `reaction-${code.toLowerCase()}`,
      },
      method: "PUT",
      payload: { active: false },
      url: `/v1/content/${ids.content}/reactions/disagree`,
    });

    expect(response.statusCode).toBe(statusCode);
    expect(SetReactionWriteResultSchema.parse(response.json())).toMatchObject({
      decision: "allow",
      status: "failed",
      result: null,
      pending_action: null,
      error: { code },
    });
  });

  it("returns a Community governance refusal as a stable denial", async () => {
    const { app } = createApp({
      setReaction: () =>
        Promise.resolve({
          decision: "deny",
          error: {
            code: "COMMUNITY_RESTRICTED",
            details: { community_state: "suspended" },
            message: "The primary Community is not accepting social writes.",
            retryAfterMs: null,
            retryable: false,
          },
          operation: "set_reaction",
          pendingAction: null,
          replayed: false,
          result: null,
          status: "denied",
        }),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "reaction-community-restricted",
      },
      method: "PUT",
      payload: { active: true },
      url: `/v1/content/${ids.content}/reactions/helpful`,
    });

    expect(response.statusCode).toBe(403);
    expect(SetReactionWriteResultSchema.parse(response.json())).toMatchObject({
      decision: "deny",
      error: {
        code: "COMMUNITY_RESTRICTED",
        details: { community_state: "suspended" },
      },
      status: "denied",
    });
  });

  it("projects a thrown retryable domain error with Retry-After", async () => {
    const { app } = createApp({
      setReaction: () =>
        Promise.reject(
          new ReactionWriteError("RATE_LIMITED", "Reaction writes are throttled.", {
            retryable: true,
            retryAfterMs: 4_500,
            details: { limit_dimension: "agent_reaction" },
          }),
        ),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "reaction-thrown-rate-limit",
      },
      method: "PUT",
      payload: { active: true },
      url: `/v1/content/${ids.content}/reactions/helpful`,
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("5");
    expect(V1ErrorResponseSchema.parse(response.json())).toMatchObject({
      error: {
        code: "RATE_LIMITED",
        retryable: true,
        details: { limit_dimension: "agent_reaction" },
      },
    });
  });

  it("fails closed when a domain outcome violates the public contract", async () => {
    const invalid = succeededOutcome();
    invalid.result = {
      ...invalid.result!,
      reactionCounts: { helpful: -1, agree: 3, disagree: 2 },
    };
    const { app } = createApp({ setReaction: () => Promise.resolve(invalid) });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "reaction-invalid-projection",
      },
      method: "PUT",
      payload: { active: true },
      url: `/v1/content/${ids.content}/reactions/helpful`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('"helpful":-1');
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "WRITE_UNAVAILABLE",
    );
  });
});
