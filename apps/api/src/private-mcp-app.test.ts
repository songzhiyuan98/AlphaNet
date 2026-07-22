import {
  createMcpActorContextAssertion,
  digestInboundMcpTokenJti,
  type McpActorAssertionKeyRing,
  type McpActorAssertionReplayStore,
} from "@alphanet/auth";
import { AgentContextResponseSchema } from "@alphanet/contracts";
import type { AgentCredentialContext, RemoteMcpAuthorityService } from "@alphanet/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPrivateMcpApp,
  PRIVATE_MCP_AGENT_CONTEXT_PATH,
  type PrivateMcpAppOptions,
} from "./private-mcp-app.js";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  agent: "20000000-0000-4000-8000-000000000002",
  credential: "30000000-0000-4000-8000-000000000003",
  grant: "40000000-0000-4000-8000-000000000004",
  owner: "50000000-0000-4000-8000-000000000005",
  policy: "60000000-0000-4000-8000-000000000006",
} as const;
const now = new Date("2026-07-22T08:00:00.000Z");
const requestId = "req_private_mcp_context";
const keyRing: McpActorAssertionKeyRing = {
  currentVersion: 1,
  keys: {
    1: { key: Buffer.alloc(32, 0x21), verificationExpiresAt: null },
  },
};
const tokenJtiDigest = digestInboundMcpTokenJti(
  "remote-mcp-access-token-jti",
  Buffer.alloc(32, 0x31),
);
const context: AgentCredentialContext = {
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
    createdAt: now,
    updatedAt: now,
    activatedAt: now,
    archivedAt: null,
    policy: {
      id: ids.policy,
      tier: "assisted",
      defaultsVersion: "agent-permission-defaults-v1",
      schemaVersion: 1,
      version: "7",
      effectiveFrom: now,
      rules: { operations: {} },
    },
  },
  credential: {
    id: ids.credential,
    ownerId: ids.owner,
    agentId: ids.agent,
    name: "Remote MCP grant",
    type: "oauth_grant",
    prefix: null,
    scopes: ["research:read", "community:read"],
    audience: "https://mcp.alphanet.test/mcp",
    policyCeiling: "assisted",
    policyCeilingDefaultsVersion: "agent-permission-defaults-v1",
    policyCeilingRules: { operations: {} },
    policyCeilingSchemaVersion: 1,
    issuedAt: now,
    expiresAt: new Date("2026-07-22T08:10:00.000Z"),
    lastUsedAt: null,
    revokedAt: null,
    replacesCredentialId: null,
    status: "active",
  },
  owner: { id: ids.owner },
};

const apps: Awaited<ReturnType<typeof createPrivateMcpApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  vi.restoreAllMocks();
});

async function actorAssertion(boundRequestId = requestId): Promise<string> {
  return createMcpActorContextAssertion(
    {
      credentialId: ids.credential,
      grantId: ids.grant,
      requestId: boundRequestId,
      scopes: context.credential.scopes,
      tokenJtiDigest,
    },
    keyRing,
    { now, ttlSeconds: 20 },
  );
}

interface AppHarness {
  app: Awaited<ReturnType<typeof createPrivateMcpApp>>;
  authenticateActorContext: ReturnType<typeof vi.fn>;
  consumeLimit: ReturnType<typeof vi.fn>;
  consumeReplay: ReturnType<typeof vi.fn>;
  transportIdentityGuard: ReturnType<typeof vi.fn>;
}

async function createApp(options?: {
  authorityFailure?: Error;
  consumeLimit?: PrivateMcpAppOptions["rateLimiter"]["consume"];
  order?: string[];
  transportIdentityGuard?: PrivateMcpAppOptions["transportIdentityGuard"];
}): Promise<AppHarness> {
  const order = options?.order;
  const consumeReplay = vi.fn<McpActorAssertionReplayStore["consume"]>(() => {
    order?.push("replay");
    return Promise.resolve(true);
  });
  const authenticateActorContext = vi.fn<
    RemoteMcpAuthorityService["authenticateActorContext"]
  >(() => {
    order?.push("authority");
    return options?.authorityFailure
      ? Promise.reject(options.authorityFailure)
      : Promise.resolve(context);
  });
  const consumeLimit = vi.fn(
    options?.consumeLimit ??
      ((key: string) => {
        order?.push(`limit:${key.split(":", 1)[0]}`);
        return Promise.resolve({ allowed: true, retryAfter: null });
      }),
  );
  const transportIdentityGuard = vi.fn(
    options?.transportIdentityGuard ??
      (() => {
        order?.push("transport");
        return Promise.resolve({
          authentication: "mutual_tls" as const,
          service: "mcp" as const,
        });
      }),
  );
  const app = await createPrivateMcpApp({
    actorAuthenticator: {
      authority: { authenticateActorContext },
      keyRing,
      now: () => now,
      replayStore: { consume: consumeReplay },
    },
    now: () => now,
    rateLimiter: { consume: consumeLimit },
    transportIdentityGuard,
  });
  apps.push(app);
  return {
    app,
    authenticateActorContext,
    consumeLimit,
    consumeReplay,
    transportIdentityGuard,
  };
}

async function validHeaders(boundRequestId = requestId) {
  return {
    "x-alphanet-mcp-actor-context": await actorAssertion(boundRequestId),
    "x-request-id": boundRequestId,
  };
}

describe("private MCP API application boundary", () => {
  it("authenticates transport then ActorContext and projects the shared Agent context", async () => {
    const order: string[] = [];
    const harness = await createApp({ order });
    const response = await harness.app.inject({
      headers: await validHeaders(),
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });
    const body = AgentContextResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(body).toMatchObject({
      request_id: requestId,
      schema_version: "1",
      agent: {
        id: ids.agent,
        actor_id: ids.actor,
        handle: "market-scout",
        display_name: "Market Scout",
      },
      owner: { id: ids.owner },
      credential: {
        id: ids.credential,
        name: "Remote MCP grant",
        scopes: ["research:read", "community:read"],
        audience: "https://mcp.alphanet.test/mcp",
        expires_at: "2026-07-22T08:10:00.000Z",
      },
      permission_tier: "assisted",
      policy_version: `${ids.policy}:7`,
      server_time: now.toISOString(),
      effective_capabilities: {
        get_agent_context: { available: true, default_decision: "allow" },
        find_communities: { available: false, default_decision: "allow" },
        create_post: {
          available: false,
          default_decision: "deny",
        },
      },
    });
    expect(order).toEqual([
      "transport",
      "replay",
      "authority",
      "limit:agent",
      "limit:owner",
    ]);
    expect(harness.consumeLimit.mock.calls).toEqual([
      [`agent:${ids.agent}:agent-api`, { max: 120, window: 60 }],
      [`owner:${ids.owner}:agent-api`, { max: 120, window: 60 }],
    ]);
  });

  it("has no Bearer or Cookie fallback, even beside a valid assertion", async () => {
    const harness = await createApp();
    const assertion = await actorAssertion();
    const attempts = [
      { authorization: "Bearer external-token", "x-request-id": requestId },
      {
        authorization: "Bearer external-token",
        "x-alphanet-mcp-actor-context": assertion,
        "x-request-id": requestId,
      },
      {
        cookie: "owner_session=must-not-cross-this-boundary",
        "x-alphanet-mcp-actor-context": assertion,
        "x-request-id": requestId,
      },
    ];

    for (const headers of attempts) {
      const response = await harness.app.inject({
        headers,
        method: "GET",
        url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: "REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED" },
      });
      expect(response.headers["www-authenticate"]).toBeUndefined();
    }
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
    expect(harness.consumeLimit).not.toHaveBeenCalled();
  });

  it("rejects duplicate request or assertion headers using raw header cardinality", async () => {
    const harness = await createApp();
    const assertion = await actorAssertion();
    const duplicateRequestId = await harness.app.inject({
      headers: {
        "x-alphanet-mcp-actor-context": assertion,
        "x-request-id": [requestId, requestId],
      },
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });
    const duplicateAssertion = await harness.app.inject({
      headers: {
        "x-alphanet-mcp-actor-context": [assertion, assertion],
        "x-request-id": requestId,
      },
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(duplicateRequestId.statusCode).toBe(401);
    expect(duplicateAssertion.statusCode).toBe(401);
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("runs transport authentication before looking at an assertion", async () => {
    const order: string[] = [];
    const harness = await createApp({
      order,
      transportIdentityGuard: () => {
        order.push("transport-denied");
        return null;
      },
    });
    const response = await harness.app.inject({
      headers: {
        authorization: "Bearer ignored",
        "x-alphanet-mcp-actor-context": "not-a-jwt",
        "x-request-id": requestId,
      },
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "REMOTE_MCP_TRANSPORT_AUTHENTICATION_FAILED" },
    });
    expect(order).toEqual(["transport-denied"]);
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("maps transport guard failure to 503 without trying assertion authentication", async () => {
    const harness = await createApp({
      transportIdentityGuard: () =>
        Promise.reject(new Error("certificate verifier unavailable")),
    });
    const response = await harness.app.inject({
      headers: await validHeaders(),
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: "REMOTE_MCP_TRANSPORT_AUTHENTICATION_UNAVAILABLE",
        retryable: true,
      },
    });
    expect(response.body).not.toContain("certificate verifier unavailable");
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("rejects identity in query or body before authenticating ActorContext", async () => {
    const harness = await createApp();
    const headers = await validHeaders();
    const queryResponse = await harness.app.inject({
      headers,
      method: "GET",
      url: `${PRIVATE_MCP_AGENT_CONTEXT_PATH}?accessToken=do-not-use`,
    });
    const bodyResponse = await harness.app.inject({
      headers: {
        ...headers,
        "content-length": "70",
        "content-type": "application/json",
      },
      method: "GET",
      payload: { nested: { owner_id: ids.owner } },
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(queryResponse.statusCode).toBe(401);
    expect(bodyResponse.statusCode).toBe(401);
    expect(queryResponse.body).not.toContain("do-not-use");
    expect(bodyResponse.body).not.toContain(ids.owner);
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("binds the signed assertion to the one accepted request ID", async () => {
    const harness = await createApp();
    const response = await harness.app.inject({
      headers: {
        "x-alphanet-mcp-actor-context": await actorAssertion("req_other_request"),
        "x-request-id": requestId,
      },
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(response.statusCode).toBe(401);
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("never reflects a secret-shaped request ID", async () => {
    const harness = await createApp();
    const secretRequestId =
      "aln_v1_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
    const response = await harness.app.inject({
      headers: {
        "x-alphanet-mcp-actor-context": await actorAssertion(secretRequestId),
        "x-request-id": secretRequestId,
      },
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(secretRequestId);
    expect(response.headers["x-request-id"]).not.toBe(secretRequestId);
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("maps current-authority and limiter dependencies without leaking details", async () => {
    const authorityUnavailable = await createApp({
      authorityFailure: new Error("database included private authority data"),
    });
    const authorityResponse = await authorityUnavailable.app.inject({
      headers: await validHeaders(),
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    const limiterUnavailable = await createApp({
      consumeLimit: () => Promise.reject(new Error("redis details")),
    });
    const limiterResponse = await limiterUnavailable.app.inject({
      headers: await validHeaders(),
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(authorityResponse.statusCode).toBe(503);
    expect(authorityResponse.body).not.toContain("database included");
    expect(limiterResponse.statusCode).toBe(503);
    expect(limiterResponse.body).not.toContain("redis details");
  });

  it("fails closed when the limiter returns a malformed truthy result", async () => {
    const harness = await createApp({
      consumeLimit: () => Promise.resolve({ allowed: "yes", retryAfter: null } as never),
    });
    const response = await harness.app.inject({
      headers: await validHeaders(),
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "TEMPORARILY_UNAVAILABLE", retryable: true },
    });
    expect(harness.consumeLimit).toHaveBeenCalledOnce();
  });

  it("returns the shared 429 envelope when the Agent budget is exhausted", async () => {
    const harness = await createApp({
      consumeLimit: () => Promise.resolve({ allowed: false, retryAfter: 9 }),
    });
    const response = await harness.app.inject({
      headers: await validHeaders(),
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("9");
    expect(response.json()).toMatchObject({
      error: { code: "RATE_LIMITED", retryable: true },
      request_id: requestId,
      schema_version: "1",
    });
    expect(harness.consumeLimit).toHaveBeenCalledOnce();
  });

  it("exposes no public, REST, auth, or health routes on the private app", async () => {
    const harness = await createApp();
    for (const url of ["/", "/health/live", "/v1/agent/context", "/api/auth/*"]) {
      const response = await harness.app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
    }
    expect(harness.transportIdentityGuard).toHaveBeenCalledTimes(4);
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
  });
});
