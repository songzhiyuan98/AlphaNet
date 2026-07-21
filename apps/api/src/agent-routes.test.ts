import { createHmac } from "node:crypto";

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
  OwnerCredentialRotateResponseSchema,
  PublicAgentProfileResponseSchema,
  V1ErrorResponseSchema,
  type V1ErrorResponse,
} from "@alphanet/contracts";
import {
  AgentConnectionError,
  type AgentConnectionService,
  type AgentPolicyRules,
  type CredentialView,
  type OwnerAgentView,
  type PublicAgentProfile,
} from "@alphanet/domain";

import { createApiApp, type ApiAppOptions } from "./app.js";

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
const internalSsrRequestSecret = "L8wq2Uox9sV7Gm1Xc4Kd6aJ0Ph5Rt3NyE1bZfQ7i";
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
    createdAt: timestamps.created,
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
    rules: { operations: {} },
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
  policyCeilingDefaultsVersion: "agent-permission-defaults-v1",
  policyCeilingRules: { operations: {} },
  policyCeilingSchemaVersion: 1,
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
  postsCount: 7,
  repliesCount: 11,
  followersCount: 13,
  followingCount: 17,
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
    checkReady: vi.fn<AgentConnectionService["checkReady"]>(() => Promise.resolve()),
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
    updateAgentPolicy: vi.fn<AgentConnectionService["updateAgentPolicy"]>(() =>
      Promise.reject(new Error("unexpected Agent policy update")),
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
  followService?: NonNullable<ApiAppOptions["followService"]>;
  internalSsrRequestSecret?: string;
  ownerSession?: OwnerSession | null;
  rateLimiter?: NonNullable<ApiAppOptions["agentRateLimiter"]>;
  researchWriteService?: NonNullable<ApiAppOptions["researchWriteService"]>;
  service?: ReturnType<typeof createService>;
  trustedProxyCidrs?: readonly string[];
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
    ...(options?.followService ? { followService: options.followService } : {}),
    ...(options?.internalSsrRequestSecret
      ? { internalSsrRequestSecret: options.internalSsrRequestSecret }
      : {}),
    ...(options?.rateLimiter ? { agentRateLimiter: options.rateLimiter } : {}),
    ...(options?.researchWriteService
      ? { researchWriteService: options.researchWriteService }
      : {}),
    ...(options?.trustedProxyCidrs
      ? { trustedProxyCidrs: options.trustedProxyCidrs }
      : {}),
    version: "test-version",
  });
  apps.push(app);
  return { app, authRuntime, service };
}

function signedSsrHeaders(
  forwardedFor: string,
  path: string,
  options?: { timestamp?: number },
) {
  const timestamp = String(options?.timestamp ?? Date.now());
  const payload = [
    "alphanet-ssr-client-ip-v1",
    timestamp,
    "GET",
    path,
    forwardedFor,
  ].join("\n");
  return {
    "x-alphanet-ssr-forwarded-for": forwardedFor,
    "x-alphanet-ssr-signature": createHmac("sha256", internalSsrRequestSecret)
      .update(payload)
      .digest("base64url"),
    "x-alphanet-ssr-timestamp": timestamp,
  };
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
  it("withdraws readiness when the Agent schema is not current", async () => {
    const service = createService();
    service.checkReady.mockRejectedValueOnce(new Error("000004 missing"));
    const { app } = await createApp({ service });

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      failedDependencies: ["agent-schema"],
      status: "degraded",
    });
    expect(response.body).not.toContain("000004");
  });

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

  it("preserves v1 errors for malformed and oversized JSON bodies", async () => {
    const { app, service } = await createApp();

    const malformed = await app.inject({
      headers: {
        ...ownerMutationHeaders("req-malformed-json"),
        "content-type": "application/json",
      },
      method: "POST",
      payload: "{",
      url: "/v1/owner/agents",
    });
    const oversized = await app.inject({
      headers: {
        ...ownerMutationHeaders("req-oversized-json"),
        "content-type": "application/json",
      },
      method: "POST",
      payload: JSON.stringify({ body: "x".repeat(1_100_000) }),
      url: "/v1/owner/agents",
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error: {
        code: "MALFORMED_REQUEST",
        retryable: false,
      },
      request_id: "req-malformed-json",
      schema_version: "1",
    });
    expect(V1ErrorResponseSchema.safeParse(malformed.json()).success).toBe(true);

    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        retryable: false,
      },
      request_id: "req-oversized-json",
      schema_version: "1",
    });
    expect(V1ErrorResponseSchema.safeParse(oversized.json()).success).toBe(true);
    expect(service.createAgent).not.toHaveBeenCalled();
  });

  it("replaces an Agent API key request ID before it reaches durable audit", async () => {
    const { app, service } = await createApp();
    const unsafeRequestId =
      "aln_v1_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    expect(unsafeRequestId).toHaveLength(63);

    const response = await app.inject({
      headers: ownerMutationHeaders(unsafeRequestId),
      method: "POST",
      payload: {
        handle: "request-id-scout",
        display_name: "Request ID Scout",
      },
      url: "/v1/owner/agents",
    });
    const requestId = response.headers["x-request-id"];

    expect(response.statusCode).toBe(201);
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(response.body).not.toContain(unsafeRequestId);
    expect(service.createAgent).toHaveBeenCalledWith(
      ids.owner,
      expect.any(Object),
      requestId,
    );
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
            rules: {
              browse: "allow",
              content_read: "allow",
              content_write: "require_approval",
              delete_own_content: "require_approval",
              edit_own_content: "require_approval",
              follow_write: "allow",
              notification_read: "allow",
              reaction_write: "allow",
              reply_write: "require_approval",
              search: "allow",
            },
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
    const rotated = await app.inject({
      headers: ownerMutationHeaders("req-rotate-credential"),
      method: "POST",
      payload: {},
      url: `/v1/owner/credentials/${ids.credential}/rotate`,
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
    expect(created.json()).toMatchObject({
      credential: {
        policy_ceiling: "assisted",
        policy_ceiling_defaults_version: "agent-permission-defaults-v1",
        policy_ceiling_schema_version: "1",
        policy_ceiling_rules: {
          content_write: "require_approval",
          reaction_write: "allow",
        },
      },
    });

    expect(listed.statusCode).toBe(200);
    expect(OwnerCredentialListResponseSchema.safeParse(listed.json()).success).toBe(true);
    expect(listed.json()).not.toHaveProperty("api_key");
    expect(listed.body).not.toContain(apiKey);

    expect(rotated.statusCode).toBe(201);
    expect(OwnerCredentialRotateResponseSchema.safeParse(rotated.json()).success).toBe(
      true,
    );
    expect(rotated.json()).toHaveProperty("api_key", apiKey);

    expect(revoked.statusCode).toBe(200);
    expect(OwnerCredentialRevokeResponseSchema.safeParse(revoked.json()).success).toBe(
      true,
    );
    expect(revoked.json()).not.toHaveProperty("api_key");
    expect(revoked.body).not.toContain(apiKey);
  });

  it("materializes Custom credential ceilings and fails closed without a snapshot", async () => {
    const customService = createService();
    customService.listOwnerCredentials.mockResolvedValueOnce([
      {
        ...credential,
        policyCeiling: "custom",
        policyCeilingRules: {
          operations: { content_write: "allow", reaction_write: "deny" },
        },
      },
    ]);
    const customApp = await createApp({ service: customService });
    const customResponse = await customApp.app.inject({
      headers: { cookie: "alphanet.session_token=opaque-session" },
      method: "GET",
      url: `/v1/owner/credentials?agent_id=${ids.agent}`,
    });

    expect(customResponse.statusCode).toBe(200);
    expect(customResponse.json()).toMatchObject({
      credentials: [
        {
          policy_ceiling: "custom",
          policy_ceiling_rules: {
            browse: "allow",
            content_write: "allow",
            reaction_write: "deny",
            reply_write: "require_approval",
          },
        },
      ],
    });

    const invalidService = createService();
    invalidService.listOwnerCredentials.mockResolvedValueOnce([
      {
        ...credential,
        policyCeilingRules: undefined,
      } as unknown as CredentialView,
    ]);
    const invalidApp = await createApp({ service: invalidService });
    const invalidResponse = await invalidApp.app.inject({
      headers: { cookie: "alphanet.session_token=opaque-session" },
      method: "GET",
      url: `/v1/owner/credentials?agent_id=${ids.agent}`,
    });

    expect(invalidResponse.statusCode).toBe(503);
    expect(invalidResponse.json()).toMatchObject({
      error: { code: "TEMPORARILY_UNAVAILABLE" },
    });
  });
});

describe("Agent Bearer and public routes", () => {
  it("uses a verified SSR forwarding chain for distributed IP limits", async () => {
    const consume = vi.fn<NonNullable<ApiAppOptions["agentRateLimiter"]>["consume"]>(() =>
      Promise.resolve({ allowed: true, retryAfter: null }),
    );
    const { app } = await createApp({
      internalSsrRequestSecret,
      rateLimiter: { consume },
      trustedProxyCidrs: ["10.0.0.0/8"],
    });
    const forwardedFor = "198.51.100.25,10.20.0.8";

    const owner = await app.inject({
      headers: {
        cookie: "alphanet.session_token=opaque-session",
        ...signedSsrHeaders(forwardedFor, "/v1/owner/agents"),
      },
      method: "GET",
      remoteAddress: "172.20.0.4",
      url: "/v1/owner/agents",
    });
    const publicProfilePath = "/v1/public/agents/market-scout";
    const publicProfile = await app.inject({
      headers: signedSsrHeaders(forwardedFor, publicProfilePath),
      method: "GET",
      remoteAddress: "172.20.0.5",
      url: publicProfilePath,
    });
    const publicProfileFromSecondReplica = await app.inject({
      headers: signedSsrHeaders(forwardedFor, publicProfilePath),
      method: "GET",
      remoteAddress: "172.20.0.6",
      url: publicProfilePath,
    });

    expect(owner.statusCode).toBe(200);
    expect(publicProfile.statusCode).toBe(200);
    expect(publicProfileFromSecondReplica.statusCode).toBe(200);
    expect(consume).toHaveBeenCalledWith("ip:198.51.100.25:owner-api", {
      max: 240,
      window: 60,
    });
    expect(consume).toHaveBeenCalledWith("ip:198.51.100.25:public-agent", {
      max: 120,
      window: 60,
    });
    expect(
      consume.mock.calls.filter(([key]) => key === "ip:198.51.100.25:public-agent"),
    ).toHaveLength(2);
  });

  it("ignores forged or stale SSR client addresses from public callers", async () => {
    const consume = vi.fn<NonNullable<ApiAppOptions["agentRateLimiter"]>["consume"]>(() =>
      Promise.resolve({ allowed: true, retryAfter: null }),
    );
    const { app } = await createApp({
      internalSsrRequestSecret,
      rateLimiter: { consume },
      trustedProxyCidrs: ["10.0.0.0/8"],
    });
    const path = "/v1/public/agents/market-scout";

    const forged = await app.inject({
      headers: {
        ...signedSsrHeaders("198.51.100.99", path),
        "x-alphanet-ssr-signature": "A".repeat(43),
      },
      method: "GET",
      remoteAddress: "203.0.113.7",
      url: path,
    });
    const stale = await app.inject({
      headers: signedSsrHeaders("198.51.100.99", path, {
        timestamp: Date.now() - 61_000,
      }),
      method: "GET",
      remoteAddress: "203.0.113.8",
      url: path,
    });
    const wrongPath = await app.inject({
      headers: signedSsrHeaders("198.51.100.99", "/v1/owner/agents"),
      method: "GET",
      remoteAddress: "203.0.113.9",
      url: path,
    });

    expect(forged.statusCode).toBe(200);
    expect(stale.statusCode).toBe(200);
    expect(wrongPath.statusCode).toBe(200);
    expect(consume).toHaveBeenCalledWith("ip:203.0.113.7:public-agent", {
      max: 120,
      window: 60,
    });
    expect(consume).toHaveBeenCalledWith("ip:203.0.113.8:public-agent", {
      max: 120,
      window: 60,
    });
    expect(consume).toHaveBeenCalledWith("ip:203.0.113.9:public-agent", {
      max: 120,
      window: 60,
    });
    expect(consume).not.toHaveBeenCalledWith(
      "ip:198.51.100.99:public-agent",
      expect.anything(),
    );
  });

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
        list_follows: { available: false, default_decision: "allow" },
      },
      quota: {
        status: "not_projected",
        window_ends_at: null,
        writes_remaining: null,
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

  it("never expands a credential beyond its immutable policy ceiling", async () => {
    const service = createService();
    service.authenticateStaticApiKey.mockResolvedValueOnce({
      agent: {
        ...ownerAgent,
        policy: {
          ...ownerAgent.policy,
          tier: "autonomous",
          version: "2",
        },
      },
      credential: {
        ...credential,
        policyCeiling: "read_only",
      },
      owner: { id: ids.owner },
    });
    const { app } = await createApp({ service });

    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/agent/context",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<AgentContextResponse>().effective_capabilities).toMatchObject({
      create_post: { available: false, default_decision: "deny" },
      reply_to_content: { available: false, default_decision: "deny" },
      update_content: { available: false, default_decision: "deny" },
      set_follow: { available: false, default_decision: "deny" },
      set_reaction: { available: false, default_decision: "deny" },
    });
  });

  it("advertises content write capabilities only when the write service is wired", async () => {
    const researchWriteService = {
      checkReady: vi.fn(() => Promise.resolve()),
      createPost: vi.fn(() => Promise.reject(new Error("not invoked"))),
      replyToContent: vi.fn(() => Promise.reject(new Error("not invoked"))),
      updateContent: vi.fn(() => Promise.reject(new Error("not invoked"))),
    } satisfies NonNullable<ApiAppOptions["researchWriteService"]>;
    const { app } = await createApp({ researchWriteService });

    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/agent/context",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<AgentContextResponse>().effective_capabilities).toMatchObject({
      create_post: { available: true, default_decision: "require_approval" },
      reply_to_content: {
        available: true,
        default_decision: "require_approval",
      },
      update_content: {
        available: true,
        default_decision: "require_approval",
      },
    });
    expect(researchWriteService.createPost).not.toHaveBeenCalled();
    expect(researchWriteService.replyToContent).not.toHaveBeenCalled();
    expect(researchWriteService.updateContent).not.toHaveBeenCalled();
  });

  it("advertises Follow read and write capabilities only when Follow is wired", async () => {
    const followService = {
      checkReady: vi.fn(() => Promise.resolve()),
      listFollows: vi.fn(() => Promise.reject(new Error("not invoked"))),
      setFollow: vi.fn(() => Promise.reject(new Error("not invoked"))),
    } satisfies NonNullable<ApiAppOptions["followService"]>;
    const { app } = await createApp({ followService });

    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/agent/context",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<AgentContextResponse>().effective_capabilities).toMatchObject({
      list_follows: { available: true, default_decision: "allow" },
      set_follow: { available: true, default_decision: "allow" },
    });
    expect(followService.listFollows).not.toHaveBeenCalled();
    expect(followService.setFollow).not.toHaveBeenCalled();
  });

  it("fails closed when custom policy rules are not projected into context", async () => {
    const service = createService();
    service.authenticateStaticApiKey.mockResolvedValueOnce({
      agent: {
        ...ownerAgent,
        policy: {
          ...ownerAgent.policy,
          tier: "custom",
          version: "2",
          rules: undefined as unknown as AgentPolicyRules,
        },
      },
      credential,
      owner: { id: ids.owner },
    });
    const { app } = await createApp({ service });

    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/agent/context",
    });

    expect(response.statusCode).toBe(200);
    const capabilities = response.json<AgentContextResponse>().effective_capabilities;
    expect(capabilities.get_agent_context).toEqual({
      available: true,
      default_decision: "allow",
    });
    expect(
      Object.entries(capabilities)
        .filter(([name]) => name !== "get_agent_context")
        .every(([, value]) => value.default_decision === "deny"),
    ).toBe(true);
  });

  it("projects Custom policy and Credential ceiling rules into capabilities", async () => {
    const service = createService();
    service.authenticateStaticApiKey.mockResolvedValueOnce({
      agent: {
        ...ownerAgent,
        policy: {
          ...ownerAgent.policy,
          tier: "custom",
          version: "2",
          rules: {
            operations: {
              content_write: "allow",
              search: "deny",
            },
          },
        },
      },
      credential: {
        ...credential,
        policyCeiling: "custom",
        policyCeilingRules: {
          operations: { content_write: "require_approval", search: "allow" },
        },
      },
      owner: { id: ids.owner },
    });
    const { app } = await createApp({ service });

    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/agent/context",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<AgentContextResponse>().effective_capabilities).toMatchObject({
      browse_content: { default_decision: "allow" },
      create_post: { default_decision: "require_approval" },
      reply_to_content: { default_decision: "require_approval" },
      search_content: { default_decision: "deny" },
    });
  });

  it("projects community-only credentials onto both community discovery tools", async () => {
    const service = createService();
    service.authenticateStaticApiKey.mockResolvedValueOnce({
      agent: ownerAgent,
      credential: {
        ...credential,
        scopes: ["community:read"],
      },
      owner: { id: ids.owner },
    });
    const { app } = await createApp({ service });

    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/agent/context",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<AgentContextResponse>().effective_capabilities).toMatchObject({
      find_communities: { available: false, default_decision: "allow" },
      get_community: { available: false, default_decision: "allow" },
    });
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

  it("maps invalid credentials and rolling-rate failures without echoing secrets", async () => {
    const service = createService();
    service.authenticateStaticApiKey.mockRejectedValueOnce(
      new AgentConnectionError("INVALID_CREDENTIAL"),
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
        code: "INVALID_CREDENTIAL",
        message: "The Agent credential is invalid.",
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
    const invalid = await app.inject({
      headers: { "x-request-id": "req-invalid-agent" },
      method: "GET",
      url: "/v1/public/agents/INVALID_HANDLE",
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
        posts_count: 7,
        replies_count: 11,
        followers_count: 13,
        following_count: 17,
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
    expect(invalid.statusCode).toBe(422);
    expect(service.getPublicAgentByHandle).toHaveBeenCalledTimes(2);
  });
});
