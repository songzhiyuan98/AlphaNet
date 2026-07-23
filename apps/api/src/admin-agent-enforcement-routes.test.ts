import type { OidcJwtVerifier, VerifiedOidcJwtIdentity } from "@alphanet/auth";
import {
  AdminAgentActionResponseSchema,
  AdminAgentDetailResponseSchema,
  AdminAgentListResponseSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  AdminAgentEnforcementError,
  type AdminAgentDetailView,
  type AdminAgentEnforcementService,
  type AdminAgentMutation,
  type AdminAgentPage,
  type AdminAgentSummaryView,
} from "@alphanet/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminRequestRateLimiter, AdminRequestRuntime } from "./admin-request.js";
import { registerAdminAgentEnforcementRoutes } from "./admin-agent-enforcement-routes.js";

const ids = {
  action: "30000000-0000-4000-8000-000000000001",
  admin: "30000000-0000-4000-8000-000000000002",
  agent: "30000000-0000-4000-8000-000000000003",
  actor: "30000000-0000-4000-8000-000000000004",
  owner: "30000000-0000-4000-8000-000000000005",
  credential: "30000000-0000-4000-8000-000000000006",
  snapshot: "30000000-0000-4000-8000-000000000007",
} as const;
const token = "a.b.c";
const now = new Date("2026-07-23T19:00:00.000Z");
const apps: FastifyInstance[] = [];
const identity: VerifiedOidcJwtIdentity = {
  issuer: "https://login.alphanet.test/workforce",
  mfa: {
    amrMfa: true,
    matchedAcr: "urn:alphanet:assurance:mfa",
    method: "acr_and_amr_mfa",
  },
  subject: "agent-governance-operator",
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function allowAllLimiter(): AdminRequestRateLimiter {
  return {
    consume: vi.fn(() => Promise.resolve({ allowed: true, retryAfter: null })),
  };
}

function agent(status: "active" | "suspended" = "active"): AdminAgentSummaryView {
  return {
    activatedAt: now,
    actorId: ids.actor,
    agentId: ids.agent,
    archivedAt: null,
    createdAt: now,
    credentialCounts: { active: 1, expired: 0, revoked: 0, total: 1 },
    discoveryTags: ["semiconductors"],
    displayName: "Semiconductor Research Agent",
    governanceVersion: status === "active" ? 3 : 4,
    handle: "semi-research",
    ownerId: ids.owner,
    restrictedAt: null,
    restrictionReasonCode: status === "suspended" ? "platform_policy_violation" : null,
    status,
    suspendedAt: status === "suspended" ? now : null,
    updatedAt: now,
  };
}

function detail(): AdminAgentDetailView {
  return {
    agent: agent(),
    capabilities: { canRestrict: true, canRevokeCredentials: true },
    credentials: [
      {
        createdAt: now,
        credentialId: ids.credential,
        credentialType: "api_key",
        expiresAt: null,
        lastUsedAt: null,
        name: "Primary key",
        prefix: "aln_v1_abcdefghijkl",
        revokedAt: null,
        scopes: ["research:read"],
        status: "active",
      },
    ],
  };
}

function page(): AdminAgentPage {
  return {
    asOf: now,
    capabilities: { canRestrict: true, canRevokeCredentials: true },
    hasMore: false,
    items: [agent()],
    limit: 25,
    nextCursor: null,
    orderingVersion: "admin-agent-created-keyset-v1",
    snapshotId: ids.snapshot,
  };
}

function mutation(replayed = false): AdminAgentMutation {
  return {
    action: {
      action: "suspend_agent",
      actionId: ids.action,
      adminId: ids.admin,
      governanceVersionAfter: 4,
      governanceVersionBefore: 3,
      occurredAt: now,
      permissionUsed: "identity:restrict",
      reasonCode: "platform_policy_violation",
      revokedCredentialCount: 0,
    },
    agent: agent("suspended"),
    replayed,
  };
}

function createApp(options: { actionError?: Error; actionReplay?: boolean } = {}) {
  const verify = vi.fn<OidcJwtVerifier["verify"]>(() => Promise.resolve(identity));
  const runtime: AdminRequestRuntime = {
    audit: { recordSecurityRejection: vi.fn(() => Promise.resolve()) },
    identityVerifier: { verify },
    rateLimiter: allowAllLimiter(),
    repository: {
      resolveActiveAuthorization: vi.fn(() =>
        Promise.resolve({
          adminId: ids.admin,
          permissions: [
            "credential:revoke",
            "identity:quota_manage",
            "identity:restrict",
          ] as const,
          roles: ["identity_operator"] as const,
        }),
      ),
    },
    resolveClientIp: () => "203.0.113.30",
  };
  const act = vi.fn<AdminAgentEnforcementService["act"]>(() => {
    if (options.actionError) return Promise.reject(options.actionError);
    return Promise.resolve(mutation(options.actionReplay));
  });
  const get = vi.fn<AdminAgentEnforcementService["get"]>(() => Promise.resolve(detail()));
  const list = vi.fn<AdminAgentEnforcementService["list"]>(() => Promise.resolve(page()));
  const app = Fastify({ logger: false });
  registerAdminAgentEnforcementRoutes(app, {
    adminRuntime: runtime,
    service: { act, get, list },
  });
  apps.push(app);
  return { act, app, get, list, verify };
}

const authorization = { authorization: `Bearer ${token}` };

describe("Admin Agent-enforcement routes", () => {
  it("lists and gets a strict secret-free Agent projection", async () => {
    const { app, get, list } = createApp();
    const listed = await app.inject({
      headers: authorization,
      method: "GET",
      url: "/v1/admin/agents?statuses=active,restricted&query=semi&limit=25",
    });
    expect(listed.statusCode).toBe(200);
    expect(AdminAgentListResponseSchema.parse(listed.json())).toMatchObject({
      capabilities: { can_restrict: true, can_revoke_credentials: true },
      items: [{ agent_id: ids.agent, governance_version: 3 }],
    });
    expect(list.mock.calls[0]?.[1]).toEqual({
      limit: 25,
      query: "semi",
      statuses: ["active", "restricted"],
    });

    const fetched = await app.inject({
      headers: authorization,
      method: "GET",
      url: `/v1/admin/agents/${ids.agent}`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers.etag).toBe('"3"');
    expect(AdminAgentDetailResponseSchema.parse(fetched.json())).toMatchObject({
      agent: { agent_id: ids.agent },
      credentials: [{ credential_id: ids.credential, prefix: "aln_v1_abcdefghijkl" }],
    });
    expect(JSON.stringify(fetched.json())).not.toContain("secret");
    expect(get).toHaveBeenCalledOnce();
  });

  it("rejects ambiguous filters, paths, headers, and bodies before the service", async () => {
    const { act, app, get, list } = createApp();
    for (const url of [
      "/v1/admin/agents?statuses=active&statuses=suspended",
      "/v1/admin/agents?statuses=active,active",
      "/v1/admin/agents?limit=025",
      "/v1/admin/agents?limit=101",
      "/v1/admin/agents?unexpected=true",
    ]) {
      const response = await app.inject({ headers: authorization, method: "GET", url });
      expect(response.statusCode).toBe(422);
    }
    const malformed = await app.inject({
      headers: {
        ...authorization,
        "idempotency-key": "suspend-agent",
        "if-match": "3",
      },
      method: "POST",
      payload: {
        action: "suspend_agent",
        reason_code: "platform_policy_violation",
        agent_id: ids.agent,
      },
      url: `/v1/admin/agents/${ids.agent}/actions`,
    });
    expect(malformed.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(malformed.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(act).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("applies an action with strong version and idempotency headers", async () => {
    const { act, app, verify } = createApp();
    const response = await app.inject({
      headers: {
        ...authorization,
        "idempotency-key": "suspend-agent",
        "if-match": '"3"',
      },
      method: "POST",
      payload: {
        action: "suspend_agent",
        internal_note: "Confirmed platform-policy violation.",
        reason_code: "platform_policy_violation",
      },
      url: `/v1/admin/agents/${ids.agent}/actions`,
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"4"');
    expect(AdminAgentActionResponseSchema.parse(response.json())).toMatchObject({
      action: { action: "suspend_agent", action_id: ids.action },
      agent: { status: "suspended" },
    });
    expect(verify).toHaveBeenCalledExactlyOnceWith(token);
    expect(act.mock.calls[0]?.[0]).toMatchObject({
      adminId: ids.admin,
      permission: "identity:restrict",
    });
    expect(act.mock.calls[0]?.[1]).toBe(ids.agent);
    expect(act.mock.calls[0]?.[2]).toEqual({
      action: "suspend_agent",
      expectedVersion: 3,
      idempotencyKey: "suspend-agent",
      internalNote: "Confirmed platform-policy violation.",
      reasonCode: "platform_policy_violation",
    });
  });

  it("returns replay and strong-version errors without exposing internals", async () => {
    const replay = createApp({ actionReplay: true });
    const replayed = await replay.app.inject({
      headers: {
        ...authorization,
        "idempotency-key": "suspend-agent-replay",
        "if-match": '"3"',
      },
      method: "POST",
      payload: {
        action: "suspend_agent",
        reason_code: "platform_policy_violation",
      },
      url: `/v1/admin/agents/${ids.agent}/actions`,
    });
    expect(replayed.statusCode).toBe(200);

    const conflict = createApp({
      actionError: new AdminAgentEnforcementError("AGENT_VERSION_CONFLICT", {
        currentVersion: 8,
      }),
    });
    const failed = await conflict.app.inject({
      headers: {
        ...authorization,
        "idempotency-key": "stale-action",
        "if-match": '"3"',
      },
      method: "POST",
      payload: {
        action: "suspend_agent",
        reason_code: "platform_policy_violation",
      },
      url: `/v1/admin/agents/${ids.agent}/actions`,
    });
    expect(failed.statusCode).toBe(409);
    expect(V1ErrorResponseSchema.parse(failed.json())).toMatchObject({
      error: {
        code: "AGENT_VERSION_CONFLICT",
        details: { current_version: 8 },
        retryable: false,
      },
    });
  });
});
