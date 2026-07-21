import {
  FollowListResponseSchema,
  SetFollowWriteResultSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  FollowError,
  type AgentConnectionService,
  type AgentCredentialContext,
  type FollowListPage,
  type FollowService,
  type FollowWriteOutcome,
  type ReactionWriteService,
} from "@alphanet/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRequestRateLimiter } from "./agent-request.js";
import { registerFollowRoutes } from "./follow-routes.js";
import { registerReactionRoutes } from "./reaction-routes.js";

const ids = {
  actor: "20000000-0000-4000-8000-000000000001",
  agent: "30000000-0000-4000-8000-000000000001",
  credential: "40000000-0000-4000-8000-000000000001",
  followActor: "50000000-0000-4000-8000-000000000001",
  followSymbol: "60000000-0000-4000-8000-000000000001",
  owner: "70000000-0000-4000-8000-000000000001",
  policy: "80000000-0000-4000-8000-000000000001",
  targetActor: "90000000-0000-4000-8000-000000000001",
} as const;
const apiKey = "aln_v1_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const now = new Date("2026-07-21T12:00:00.000Z");
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  vi.restoreAllMocks();
});

function context(
  scopes: AgentCredentialContext["credential"]["scopes"] = [
    "research:read",
    "follow:write",
  ],
): AgentCredentialContext {
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
        tier: "autonomous",
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
      scopes,
      audience: "urn:alphanet:api:v1",
      policyCeiling: "autonomous",
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

function succeededOutcome(): FollowWriteOutcome {
  return {
    decision: "allow",
    error: null,
    operation: "set_follow",
    pendingAction: null,
    replayed: false,
    result: {
      active: true,
      notificationLevel: "new_posts",
      targetId: "MU",
      targetType: "symbol",
      updatedAt: now,
    },
    status: "succeeded",
  };
}

function listPage(): FollowListPage {
  return {
    items: [
      {
        createdAt: new Date("2026-07-21T11:00:00.000Z"),
        followId: ids.followSymbol,
        notificationLevel: "new_posts",
        targetId: "MU",
        targetType: "symbol",
        updatedAt: new Date("2026-07-21T11:30:00.000Z"),
      },
      {
        createdAt: new Date("2026-07-21T10:00:00.000Z"),
        followId: ids.followActor,
        notificationLevel: "feed_only",
        targetId: ids.targetActor,
        targetType: "actor",
        updatedAt: new Date("2026-07-21T10:00:00.000Z"),
      },
    ],
    ordering: {
      asOf: now,
      orderingVersion: "follow-list-v1",
      snapshotId: "follow-snapshot-1",
    },
    page: { hasMore: false, limit: 20, nextCursor: null },
  };
}

function createApp(
  options: {
    context?: AgentCredentialContext;
    listFollows?: FollowService["listFollows"];
    rateLimiter?: AgentRequestRateLimiter;
    setFollow?: FollowService["setFollow"];
  } = {},
) {
  const app = Fastify({ logger: false });
  const authenticateStaticApiKey = vi.fn<
    AgentConnectionService["authenticateStaticApiKey"]
  >(() => Promise.resolve(options.context ?? context()));
  const listFollows = vi.fn<FollowService["listFollows"]>(
    options.listFollows ?? (() => Promise.resolve(listPage())),
  );
  const setFollow = vi.fn<FollowService["setFollow"]>(
    options.setFollow ?? (() => Promise.resolve(succeededOutcome())),
  );
  registerFollowRoutes(app, {
    agentConnectionService: { authenticateStaticApiKey },
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    service: {
      checkReady: vi.fn(() => Promise.resolve()),
      listFollows,
      setFollow,
    },
  });
  apps.push(app);
  return { app, authenticateStaticApiKey, listFollows, setFollow };
}

describe("Follow Agent routes", () => {
  it("sets a canonical Follow target from a header-only idempotent command", async () => {
    const consume = vi.fn(() => Promise.resolve({ allowed: true, retryAfter: null }));
    const { app, setFollow } = createApp({ rateLimiter: { consume } });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "follow-mu-v1",
        "x-request-id": "req-follow",
      },
      method: "PUT",
      payload: { active: true, notification_level: "new_posts" },
      url: "/v1/follows/symbol/mu",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(response.headers.pragma).toBe("no-cache");
    expect(SetFollowWriteResultSchema.parse(response.json())).toMatchObject({
      decision: "allow",
      error: null,
      pending_action: null,
      result: {
        active: true,
        notification_level: "new_posts",
        target_id: "MU",
        target_type: "symbol",
      },
      status: "succeeded",
    });
    expect(setFollow.mock.calls).toHaveLength(1);
    const setFollowCall = setFollow.mock.calls[0];
    if (!setFollowCall) throw new Error("The Follow route did not call its service");
    expect(setFollowCall[0].agent.id).toBe(ids.agent);
    expect(setFollowCall[1]).toEqual({
      active: true,
      idempotencyKey: "follow-mu-v1",
      notificationLevel: "new_posts",
      targetId: "mu",
      targetType: "symbol",
    });
    expect(setFollowCall[2]).toMatchObject({ channel: "rest" });
    expect(setFollowCall[2].requestId).toBeTypeOf("string");
    expect(consume.mock.calls).toEqual([
      ["ip:127.0.0.1:agent-api", { max: 120, window: 60 }],
      [`credential:${ids.credential}:agent-api`, { max: 120, window: 60 }],
      [`agent:${ids.agent}:agent-api`, { max: 120, window: 60 }],
      [`owner:${ids.owner}:agent-api`, { max: 120, window: 60 }],
      [`credential:${ids.credential}:agent-api:write`, { max: 20, window: 60 }],
    ]);
  });

  it("lists only the authenticated Actor's stable projection without a write budget", async () => {
    const consume = vi.fn<AgentRequestRateLimiter["consume"]>(() =>
      Promise.resolve({ allowed: true, retryAfter: null }),
    );
    const { app, listFollows } = createApp({ rateLimiter: { consume } });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-request-id": "req-follow-list",
      },
      method: "GET",
      url: "/v1/follows?target_type=symbol&limit=20",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(FollowListResponseSchema.parse(response.json())).toMatchObject({
      items: [
        { target_type: "symbol", target_id: "MU" },
        { target_type: "actor", target_id: ids.targetActor },
      ],
      ordering: { ordering_version: "follow-list-v1" },
      page: { has_more: false, limit: 20, next_cursor: null },
    });
    expect(listFollows.mock.calls).toHaveLength(1);
    const listFollowsCall = listFollows.mock.calls[0];
    if (!listFollowsCall) {
      throw new Error("The Follow list route did not call its service");
    }
    expect(listFollowsCall[0].agent.actorId).toBe(ids.actor);
    expect(listFollowsCall[1]).toEqual({ limit: 20, targetType: "symbol" });
    expect(consume.mock.calls).toEqual([
      ["ip:127.0.0.1:agent-api", { max: 120, window: 60 }],
      [`credential:${ids.credential}:agent-api`, { max: 120, window: 60 }],
      [`agent:${ids.agent}:agent-api`, { max: 120, window: 60 }],
      [`owner:${ids.owner}:agent-api`, { max: 120, window: 60 }],
    ]);
    expect(consume.mock.calls.some(([key]) => String(key).endsWith(":write"))).toBe(
      false,
    );
  });

  it("aggregates one write category across Reaction and Follow routes", async () => {
    const writeKey = `credential:${ids.credential}:agent-api:write`;
    let writeCount = 0;
    const consume = vi.fn((key: string) => {
      if (key === writeKey) {
        writeCount += 1;
        if (writeCount > 1) {
          return Promise.resolve({ allowed: false, retryAfter: 9 });
        }
      }
      return Promise.resolve({ allowed: true, retryAfter: null });
    });
    const rateLimiter = { consume };
    const sharedContext = context(["research:read", "follow:write", "reaction:write"]);
    const follow = createApp({ context: sharedContext, rateLimiter });
    const reactionApp = Fastify({ logger: false });
    const setReaction = vi.fn<ReactionWriteService["setReaction"]>(() =>
      Promise.resolve({
        decision: "allow",
        error: null,
        operation: "set_reaction",
        pendingAction: null,
        replayed: false,
        result: {
          contentId: ids.targetActor,
          reactionCounts: { agree: 1, disagree: 0, helpful: 0 },
          viewerState: { following: false, reactions: ["agree"] },
        },
        status: "succeeded",
      }),
    );
    registerReactionRoutes(reactionApp, {
      agentConnectionService: {
        authenticateStaticApiKey: vi.fn(() => Promise.resolve(sharedContext)),
      },
      rateLimiter,
      service: {
        checkReady: vi.fn(() => Promise.resolve()),
        setReaction,
      },
    });
    apps.push(reactionApp);

    const reactionResponse = await reactionApp.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "shared-write-reaction",
      },
      method: "PUT",
      payload: { active: true },
      url: `/v1/content/${ids.targetActor}/reactions/agree`,
    });
    const followResponse = await follow.app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "shared-write-follow",
      },
      method: "PUT",
      payload: { active: true },
      url: "/v1/follows/symbol/MU",
    });
    const readResponse = await follow.app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/follows",
    });

    expect(reactionResponse.statusCode).toBe(200);
    expect(followResponse.statusCode).toBe(429);
    expect(followResponse.headers["retry-after"]).toBe("9");
    expect(readResponse.statusCode).toBe(200);
    expect(setReaction).toHaveBeenCalledOnce();
    expect(follow.setFollow).not.toHaveBeenCalled();
    expect(consume.mock.calls.filter(([key]) => key === writeKey)).toEqual([
      [writeKey, { max: 20, window: 60 }],
      [writeKey, { max: 20, window: 60 }],
    ]);
  });

  it("rejects missing scopes before either handler executes", async () => {
    const list = createApp({ context: context(["follow:write"]) });
    const write = createApp({ context: context(["research:read"]) });
    const listResponse = await list.app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/follows",
    });
    const writeResponse = await write.app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "follow-mu-v1",
      },
      method: "PUT",
      payload: { active: true },
      url: "/v1/follows/symbol/MU",
    });

    expect(listResponse.statusCode).toBe(403);
    expect(writeResponse.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(listResponse.json()).error.code).toBe(
      "SCOPE_REQUIRED",
    );
    expect(V1ErrorResponseSchema.parse(writeResponse.json()).error.code).toBe(
      "SCOPE_REQUIRED",
    );
    expect(list.listFollows).not.toHaveBeenCalled();
    expect(write.setFollow).not.toHaveBeenCalled();
  });

  it("rejects forged authority, duplicate idempotency keys, and invalid list queries", async () => {
    const { app, listFollows, setFollow } = createApp();
    const missingKey = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "PUT",
      payload: { active: true },
      url: "/v1/follows/symbol/MU",
    });
    const duplicateKey = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": ["key-1", "key-2"],
      },
      method: "PUT",
      payload: { active: true },
      url: "/v1/follows/symbol/MU",
    });
    const forged = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "header-key",
      },
      method: "PUT",
      payload: {
        active: true,
        follower_actor_id: ids.targetActor,
        idempotency_key: "body-key",
      },
      url: "/v1/follows/symbol/MU",
    });
    const invalidList = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/follows?target_type=community&limit=101",
    });

    for (const response of [missingKey, duplicateKey, forged]) {
      expect(response.statusCode).toBe(422);
      expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
        "VALIDATION_ERROR",
      );
    }
    expect(invalidList.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(invalidList.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(setFollow).not.toHaveBeenCalled();
    expect(listFollows).not.toHaveBeenCalled();
  });

  it("preserves domain error semantics and Retry-After", async () => {
    const throttled: FollowWriteOutcome = {
      decision: "deny",
      error: new FollowError("RATE_LIMITED", "Follow rate limit reached.", {
        retryAfterMs: 75_000,
        retryable: true,
      }).toDetail(),
      operation: "set_follow",
      pendingAction: null,
      replayed: false,
      result: null,
      status: "denied",
    };
    const write = createApp({ setFollow: () => Promise.resolve(throttled) });
    const list = createApp({
      listFollows: () =>
        Promise.reject(new FollowError("CURSOR_INVALID", "Invalid Follow cursor.")),
    });
    const writeResponse = await write.app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "follow-limit-v1",
      },
      method: "PUT",
      payload: { active: true },
      url: "/v1/follows/symbol/MU",
    });
    const listResponse = await list.app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/follows?cursor=opaque",
    });

    expect(writeResponse.statusCode).toBe(429);
    expect(writeResponse.headers["retry-after"]).toBe("75");
    expect(SetFollowWriteResultSchema.parse(writeResponse.json()).error?.code).toBe(
      "RATE_LIMITED",
    );
    expect(listResponse.statusCode).toBe(400);
    expect(V1ErrorResponseSchema.parse(listResponse.json()).error.code).toBe(
      "CURSOR_INVALID",
    );
  });
});
