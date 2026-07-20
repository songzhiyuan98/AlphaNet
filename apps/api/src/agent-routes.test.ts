import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlphaNetAuthRuntime, OwnerSession } from "@alphanet/auth";
import {
  AgentContextResponseSchema,
  type AgentContextResponse,
  OwnerAgentCreateResponseSchema,
  OwnerAgentListResponseSchema,
  OwnerCredentialCreateResponseSchema,
  type OwnerCredentialCreateResponse,
  OwnerCredentialListResponseSchema,
  OwnerCredentialRevokeResponseSchema,
  PublicAgentProfileResponseSchema,
  V1ErrorResponseSchema,
  type V1ErrorResponse,
} from "@alphanet/contracts";
import {
  AgentConnectionError,
  type AgentConnectionService,
  type CredentialView,
  type OwnerAgentView,
  type PublicAgentProfile,
} from "@alphanet/domain";

import { createApiApp } from "./app.js";

const ids = {
  owner: "00000000-0000-4000-8000-000000000001",
  actor: "00000000-0000-4000-8000-000000000002",
  agent: "00000000-0000-4000-8000-000000000003",
  policy: "00000000-0000-4000-8000-000000000004",
  credential: "00000000-0000-4000-8000-000000000005",
  session: "00000000-0000-4000-8000-000000000006",
} as const;

const timestamps = {
  created: new Date("2026-07-20T12:00:00.000Z"),
  expires: new Date("2026-08-20T12:00:00.000Z"),
  revoked: new Date("2026-07-21T12:00:00.000Z"),
  retry: new Date("2026-07-22T12:00:00.000Z"),
} as const;

const apiKey = "aln_v1_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const allowedOrigin = "https://app.alphanet.test";
const apps: Awaited<ReturnType<typeof createApiApp>>[] = [];

const ownerSession: OwnerSession = {
  owner: {
    email: "owner@example.test",
    emailVerified: true,
    id: ids.owner,
    name: "Owner",
    status: "active",
  },
  session: {
    expiresAt: timestamps.expires,
    id: ids.session,
  },
};

const ownerAgent: OwnerAgentView = {
  id: ids.agent,
  actorId: ids.actor,
  ownerId: ids.owner,
  handle: "market-scout",
  displayName: "Market Scout",
  bio: "Cross-validates market research.",
  discoveryTags: ["semiconductors", "risk"],
  status: "active",
  restrictionReasonCode: null,
  credentialCount: 1,
  createdAt: timestamps.created,
  updatedAt: timestamps.created,
  activatedAt: timestamps.created,
  archivedAt: null,
  policy: {
    id: ids.policy,
    tier: "assisted",
    defaultsVersion: "agent-permission-defaults-v1",
    schemaVersion: 1,
    version: "1",
    effectiveFrom: timestamps.created,
  },
};

const credential: CredentialView = {
  id: ids.credential,
  ownerId: ids.owner,
  agentId: ids.agent,
  name: "Research runner",
  type: "static_api_key",
  prefix: "aln_v1_abcdefghijkl",
  scopes: [
    "research:read",
    "community:read",
    "notifications:read",
    "actions:read",
    "content:write",
    "reaction:write",
    "follow:write",
  ],
  audience: "https://api.alphanet.test/v1",
  policyCeiling: "assisted",
  issuedAt: timestamps.created,
  expiresAt: timestamps.expires,
  lastUsedAt: null,
  revokedAt: null,
  replacesCredentialId: null,
  status: "active",
};

const publicAgent: PublicAgentProfile = {
  id: ids.agent,
  actorId: ids.actor,
  handle: ownerAgent.handle,
  displayName: ownerAgent.displayName,
  bio: ownerAgent.bio,
  discoveryTags: ownerAgent.discoveryTags,
  createdAt: timestamps.created,
  joinedAt: timestamps.created,
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  vi.restoreAllMocks();
});

function createAuthRuntime(
  session: OwnerSession | null = ownerSession,
): AlphaNetAuthRuntime {
  return {
    auth: { handler: vi.fn() },
    baseUrl: "https://api.alphanet.test",
    checkReady: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    getOwnerSession: vi.fn(() => Promise.resolve(session)),
    googleEnabled: false,
    handle: vi.fn(() => Promise.resolve(Response.json({ ok: true }))),
  } as unknown as AlphaNetAuthRuntime;
}

function createService() {
  return {
    listOwnerAgents: vi.fn<AgentConnectionService["listOwnerAgents"]>(() =>
      Promise.resolve({
        agents: [ownerAgent],
        quota: {
          active: 1,
          activeLimit: 5,
          createdLast24Hours: 2,
          createLimit: 3,
          createRetryAt: timestamps.retry,
        },
      }),
    ),
    createAgent: vi.fn<AgentConnectionService["createAgent"]>(() =>
      Promise.resolve({
        agent: ownerAgent,
        activationReason: null,
      }),
    ),
    updateAgent: vi.fn<AgentConnectionService["updateAgent"]>(() =>
      Promise.resolve(ownerAgent),
    ),
    activateAgent: vi.fn<AgentConnectionService["activateAgent"]>(() =>
      Promise.resolve({
        agent: ownerAgent,
        activationReason: null,
      }),
    ),
    archiveAgent: vi.fn<AgentConnectionService["archiveAgent"]>(() =>
      Promise.resolve(ownerAgent),
    ),
    listCredentials: vi.fn<AgentConnectionService["listCredentials"]>(() =>
      Promise.resolve([credential]),
    ),
    listOwnerCredentials: vi.fn<AgentConnectionService["listOwnerCredentials"]>(() =>
      Promise.resolve([credential]),
    ),
    createCredential: vi.fn<AgentConnectionService["createCredential"]>(() =>
      Promise.resolve({
        credential,
        apiKey,
      }),
    ),
    rotateCredential: vi.fn<AgentConnectionService["rotateCredential"]>(() =>
      Promise.resolve({
        credential,
        apiKey,
      }),
    ),
    revokeCredential: vi.fn<AgentConnectionService["revokeCredential"]>(() =>
      Promise.resolve({
        ...credential,
        status: "revoked",
        revokedAt: timestamps.revoked,
      }),
    ),
    authenticateStaticApiKey: vi.fn<AgentConnectionService["authenticateStaticApiKey"]>(
      () =>
        Promise.resolve({
          agent: ownerAgent,
          credential,
          owner: { id: ids.owner },
        }),
    ),
    getPublicAgentByHandle: vi.fn<AgentConnectionService["getPublicAgentByHandle"]>(() =>
      Promise.resolve(publicAgent),
    ),
  } satisfies AgentConnectionService;
}

async function createApp(options?: {
  ownerSession?: OwnerSession | null;
  service?: ReturnType<typeof createService>;
}) {
  const authRuntime = createAuthRuntime(
    options && "ownerSession" in options ? (options.ownerSession ?? null) : ownerSession,
  );
  const service = options?.service ?? createService();
  const app = await createApiApp({
    allowedOrigins: [allowedOrigin],
    agentConnectionService: service,
    authRuntime,
    environment: "test",
    version: "test-version",
  });
  apps.push(app);
  return { app, authRuntime, service };
}

function ownerMutationHeaders(requestId: string) {
  return {
    cookie: "alphanet.session_token=opaque-session",
    origin: allowedOrigin,
    "sec-fetch-site": "same-origin",
    "x-request-id": requestId,
  };
}

describe("Agent connection Owner routes", () => {
  it("requires an authenticated Owner session", async () => {
    const { app, service } = await createApp({ ownerSession: null });

    const response = await app.inject({
      headers: { "x-request-id": "req-owner-required" },
      method: "GET",
      url: "/v1/owner/agents",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "AUTHENTICATION_REQUIRED",
        message: "A valid Owner session is required.",
        retryable: false,
        details: null,
        retry_after_ms: null,
      },
      request_id: "req-owner-required",
      schema_version: "1",
    });
    expect(V1ErrorResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(service.listOwnerAgents).not.toHaveBeenCalled();
  });

  it("requires an allowed Web origin for every Owner mutation", async () => {
    const { app, service } = await createApp();

    const response = await app.inject({
      headers: {
        cookie: "alphanet.session_token=opaque-session",
        "x-request-id": "req-csrf",
      },
      method: "POST",
      payload: {
        handle: "market-scout",
        display_name: "Market Scout",
      },
      url: "/v1/owner/agents",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: "CSRF_VALIDATION_FAILED",
        message: "The Owner mutation did not come from an allowed Web origin.",
        retryable: false,
        details: null,
        retry_after_ms: null,
      },
      request_id: "req-csrf",
      schema_version: "1",
    });
    expect(service.createAgent).not.toHaveBeenCalled();
  });

  it("derives ownership from the session and rejects forged identifiers", async () => {
    const { app, service } = await createApp();
    const forged = await app.inject({
      headers: ownerMutationHeaders("req-forged-owner"),
      method: "POST",
      payload: {
        handle: "market-scout",
        display_name: "Market Scout",
        owner_id: "00000000-0000-4000-8000-000000000099",
        actor_id: "00000000-0000-4000-8000-000000000098",
      },
      url: "/v1/owner/agents",
    });

    expect(forged.statusCode).toBe(422);
    expect(forged.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" },
      request_id: "req-forged-owner",
      schema_version: "1",
    });
    expect(service.createAgent).not.toHaveBeenCalled();

    const valid = await app.inject({
      headers: ownerMutationHeaders("req-create-agent"),
      method: "POST",
      payload: {
        handle: "market-scout",
        display_name: "Market Scout",
        bio: "Cross-validates market research.",
        discovery_tags: ["semiconductors", "risk"],
      },
      url: "/v1/owner/agents",
    });

    expect(valid.statusCode).toBe(201);
    expect(service.createAgent).toHaveBeenCalledExactlyOnceWith(
      ids.owner,
      {
        handle: "market-scout",
        displayName: "Market Scout",
        bio: "Cross-validates market research.",
        discoveryTags: ["semiconductors", "risk"],
      },
      "req-create-agent",
    );
    expect(OwnerAgentCreateResponseSchema.safeParse(valid.json()).success).toBe(true);
  });

  it("returns the stable 422 envelope before invoking the domain", async () => {
    const { app, service } = await createApp();

    const response = await app.inject({
      headers: ownerMutationHeaders("req-invalid-agent"),
      method: "POST",
      payload: {
        handle: "INVALID HANDLE",
        display_name: "",
      },
      url: "/v1/owner/agents",
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "The request does not match the Agent API contract.",
        retryable: false,
        details: null,
        retry_after_ms: null,
      },
      request_id: "req-invalid-agent",
      schema_version: "1",
    });
    expect(service.createAgent).not.toHaveBeenCalled();
  });

  it("serializes the Agent list and rolling quota in one stable envelope", async () => {
    const { app, service } = await createApp();

    const response = await app.inject({
      headers: {
        cookie: "alphanet.session_token=opaque-session",
        "x-request-id": "req-list-agents",
      },
      method: "GET",
      url: "/v1/owner/agents",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      agents: [
        {
          id: ids.agent,
          actor_id: ids.actor,
          owner_id: ids.owner,
          handle: "market-scout",
          display_name: "Market Scout",
          bio: "Cross-validates market research.",
          discovery_tags: ["semiconductors", "risk"],
          status: "active",
          restriction_reason_code: null,
          policy: {
            id: ids.policy,
            tier: "assisted",
            defaults_version: "agent-permission-defaults-v1",
            policy_schema_version: "1",
            version: 1,
            effective_from: "2026-07-20T12:00:00.000Z",
          },
          credential_count: 1,
          created_at: "2026-07-20T12:00:00.000Z",
          updated_at: "2026-07-20T12:00:00.000Z",
          activated_at: "2026-07-20T12:00:00.000Z",
          archived_at: null,
        },
      ],
      next_cursor: null,
      quota: {
        active_agent_count: 1,
        active_agent_limit: 5,
        created_last_24_hours: 2,
        create_limit: 3,
        create_retry_at: "2026-07-22T12:00:00.000Z",
      },
      request_id: "req-list-agents",
      schema_version: "1",
    });
    expect(OwnerAgentListResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(service.listOwnerAgents).toHaveBeenCalledExactlyOnceWith(ids.owner);
  });

  it("does not allow an Agent API key to authenticate an Owner route", async () => {
    const service = createService();
    const { app } = await createApp({ ownerSession: null, service });

    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-request-id": "req-agent-on-owner-route",
      },
      method: "GET",
      url: "/v1/owner/agents",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" },
      request_id: "req-agent-on-owner-route",
    });
    expect(service.authenticateStaticApiKey).not.toHaveBeenCalled();
    expect(service.listOwnerAgents).not.toHaveBeenCalled();
  });

  it("shows API key plaintext once and omits it from list and revoke summaries", async () => {
    const { app } = await createApp();

    const created = await app.inject({
      headers: ownerMutationHeaders("req-create-credential"),
      method: "POST",
      payload: {
        name: "Research runner",
        scopes: credential.scopes,
        expires_at: timestamps.expires.toISOString(),
      },
      url: `/v1/owner/agents/${ids.agent}/credentials`,
    });
    const listed = await app.inject({
      headers: {
        cookie: "alphanet.session_token=opaque-session",
        "x-request-id": "req-list-credentials",
      },
      method: "GET",
      url: `/v1/owner/credentials?agent_id=${ids.agent}`,
    });
    const revoked = await app.inject({
      headers: ownerMutationHeaders("req-revoke-credential"),
      method: "DELETE",
      url: `/v1/owner/credentials/${ids.credential}`,
    });

    expect(created.statusCode).toBe(201);
    expect(created.json<OwnerCredentialCreateResponse>().api_key).toBe(apiKey);
    expect(OwnerCredentialCreateResponseSchema.safeParse(created.json()).success).toBe(
      true,
    );

    expect(listed.statusCode).toBe(200);
    expect(OwnerCredentialListResponseSchema.safeParse(listed.json()).success).toBe(true);
    expect(listed.json()).not.toHaveProperty("api_key");
    expect(listed.body).not.toContain(apiKey);

    expect(revoked.statusCode).toBe(200);
    expect(OwnerCredentialRevokeResponseSchema.safeParse(revoked.json()).success).toBe(
      true,
    );
    expect(revoked.json()).not.toHaveProperty("api_key");
    expect(revoked.body).not.toContain(apiKey);
  });
});

describe("Agent Bearer and public routes", () => {
  it("returns the exact Phase 1 context and keeps every later tool unavailable", async () => {
    const service = createService();
    const { app } = await createApp({ service });

    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-request-id": "req-agent-context",
      },
      method: "GET",
      url: "/v1/agent/context",
    });
    const body = response.json<AgentContextResponse>();
    const serverTime = String(body.server_time);
    const windowEndsAt = new Date(
      new Date(serverTime).valueOf() + 3_600_000,
    ).toISOString();

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({
      agent: {
        id: ids.agent,
        actor_id: ids.actor,
        handle: "market-scout",
        display_name: "Market Scout",
      },
      owner: { id: ids.owner },
      credential: {
        id: ids.credential,
        name: "Research runner",
        scopes: credential.scopes,
        audience: "https://api.alphanet.test/v1",
        expires_at: "2026-08-20T12:00:00.000Z",
      },
      permission_tier: "assisted",
      policy_version: `${ids.policy}:1`,
      effective_capabilities: {
        get_agent_context: { available: true, default_decision: "allow" },
        find_communities: { available: false, default_decision: "allow" },
        get_community: { available: false, default_decision: "allow" },
        browse_content: { available: false, default_decision: "allow" },
        search_content: { available: false, default_decision: "allow" },
        get_content: { available: false, default_decision: "allow" },
        get_discussion: { available: false, default_decision: "allow" },
        list_notifications: { available: false, default_decision: "allow" },
        get_action_status: { available: false, default_decision: "allow" },
        create_post: {
          available: false,
          default_decision: "require_approval",
        },
        reply_to_content: {
          available: false,
          default_decision: "require_approval",
        },
        update_content: {
          available: false,
          default_decision: "require_approval",
        },
        delete_content: {
          available: false,
          default_decision: "require_approval",
        },
        set_reaction: { available: false, default_decision: "allow" },
        set_follow: { available: false, default_decision: "allow" },
      },
      quota: {
        window_ends_at: windowEndsAt,
        writes_remaining: 0,
      },
      server_time: serverTime,
      request_id: "req-agent-context",
      schema_version: "1",
    });
    expect(AgentContextResponseSchema.safeParse(body).success).toBe(true);
    expect(service.authenticateStaticApiKey).toHaveBeenCalledExactlyOnceWith(apiKey);

    const notYetAvailable = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/agent/search",
    });
    expect(notYetAvailable.statusCode).toBe(404);
  });

  it("rejects API keys in query parameters without authenticating them", async () => {
    const service = createService();
    const { app } = await createApp({ service });

    const response = await app.inject({
      headers: { "x-request-id": "req-query-token" },
      method: "GET",
      url: `/v1/agent/context?api_key=${encodeURIComponent(apiKey)}`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "AUTHENTICATION_REQUIRED",
        message: "A valid Agent Bearer credential is required.",
        retryable: false,
        details: null,
        retry_after_ms: null,
      },
      request_id: "req-query-token",
      schema_version: "1",
    });
    expect(response.body).not.toContain(apiKey);
    expect(service.authenticateStaticApiKey).not.toHaveBeenCalled();
  });

  it("maps revoked and rolling-rate domain failures without echoing secrets", async () => {
    const service = createService();
    service.authenticateStaticApiKey.mockRejectedValueOnce(
      new AgentConnectionError("CREDENTIAL_REVOKED"),
    );
    service.createAgent.mockRejectedValueOnce(
      new AgentConnectionError("AGENT_CREATE_RATE_LIMITED", {
        retryAt: new Date(Date.now() + 300_000),
      }),
    );
    const { app } = await createApp({ service });

    const revoked = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-request-id": "req-revoked-token",
      },
      method: "GET",
      url: "/v1/agent/context",
    });
    const rateLimited = await app.inject({
      headers: ownerMutationHeaders("req-agent-rate"),
      method: "POST",
      payload: {
        handle: "second-scout",
        display_name: "Second Scout",
      },
      url: "/v1/owner/agents",
    });

    expect(revoked.statusCode).toBe(401);
    expect(revoked.json()).toEqual({
      error: {
        code: "CREDENTIAL_REVOKED",
        message: "The Agent credential has been revoked.",
        retryable: false,
        details: null,
        retry_after_ms: null,
      },
      request_id: "req-revoked-token",
      schema_version: "1",
    });
    expect(revoked.body).not.toContain(apiKey);

    expect(rateLimited.statusCode).toBe(429);
    expect(rateLimited.headers["retry-after"]).toBeDefined();
    expect(rateLimited.json()).toMatchObject({
      error: {
        code: "AGENT_CREATE_RATE_LIMITED",
        message: "The rolling Agent creation limit has been reached.",
        retryable: true,
      },
      request_id: "req-agent-rate",
      schema_version: "1",
    });
    const rateError = rateLimited.json<V1ErrorResponse>();
    expect(rateError.error.details?.retry_at).toEqual(expect.any(String));
    expect(rateError.error.retry_after_ms).toEqual(expect.any(Number));
    expect(rateLimited.body).not.toContain(apiKey);
  });

  it("projects only active public profile fields and returns a stable 404", async () => {
    const service = createService();
    service.getPublicAgentByHandle
      .mockResolvedValueOnce(publicAgent)
      .mockResolvedValueOnce(null);
    const { app } = await createApp({ service });

    const found = await app.inject({
      headers: { "x-request-id": "req-public-agent" },
      method: "GET",
      url: "/v1/public/agents/market-scout",
    });
    const missing = await app.inject({
      headers: { "x-request-id": "req-missing-agent" },
      method: "GET",
      url: "/v1/public/agents/missing-scout",
    });

    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual({
      agent: {
        id: ids.agent,
        actor_id: ids.actor,
        handle: "market-scout",
        display_name: "Market Scout",
        bio: "Cross-validates market research.",
        discovery_tags: ["semiconductors", "risk"],
        status: "active",
        created_at: "2026-07-20T12:00:00.000Z",
        activated_at: "2026-07-20T12:00:00.000Z",
      },
      stats: {
        posts_count: 0,
        replies_count: 0,
        followers_count: 0,
        following_count: 0,
      },
      request_id: "req-public-agent",
      schema_version: "1",
    });
    expect(PublicAgentProfileResponseSchema.safeParse(found.json()).success).toBe(true);
    expect(found.body).not.toContain("owner@example.test");
    expect(found.body).not.toContain(ids.owner);

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: {
        code: "AGENT_NOT_FOUND",
        message: "The Agent was not found.",
        retryable: false,
        details: null,
        retry_after_ms: null,
      },
      request_id: "req-missing-agent",
      schema_version: "1",
    });
  });
});
