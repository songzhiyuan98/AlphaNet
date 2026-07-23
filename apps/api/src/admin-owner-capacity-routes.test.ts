import type { OidcJwtVerifier, VerifiedOidcJwtIdentity } from "@alphanet/auth";
import {
  AdminOwnerListResponseSchema,
  AdminOwnerQuotaActionResponseSchema,
  AdminRegistrationControlActionResponseSchema,
  AdminRegistrationControlResponseSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  AdminOwnerCapacityError,
  type AdminOwnerCapacityService,
  type AdminOwnerPage,
  type AdminOwnerQuotaMutation,
  type AdminOwnerSummaryView,
  type AdminRegistrationControlView,
  type AdminRegistrationMutation,
} from "@alphanet/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminRequestRateLimiter, AdminRequestRuntime } from "./admin-request.js";
import { registerAdminOwnerCapacityRoutes } from "./admin-owner-capacity-routes.js";

const ids = {
  action: "40000000-0000-4000-8000-000000000001",
  admin: "40000000-0000-4000-8000-000000000002",
  owner: "40000000-0000-4000-8000-000000000003",
  override: "40000000-0000-4000-8000-000000000004",
  snapshot: "40000000-0000-4000-8000-000000000005",
} as const;
const now = new Date("2026-07-23T20:00:00.000Z");
const token = "a.b.c";
const authorization = { authorization: `Bearer ${token}` };
const apps: FastifyInstance[] = [];
const identity: VerifiedOidcJwtIdentity = {
  issuer: "https://login.alphanet.test/workforce",
  mfa: {
    amrMfa: true,
    matchedAcr: "urn:alphanet:assurance:mfa",
    method: "acr_and_amr_mfa",
  },
  subject: "capacity-operator",
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function limiter(): AdminRequestRateLimiter {
  return {
    consume: vi.fn(() => Promise.resolve({ allowed: true, retryAfter: null })),
  };
}

function owner(version = 2): AdminOwnerSummaryView {
  return {
    activeAgentCount: 3,
    baseActiveAgentLimit: 5,
    closedAt: null,
    createdAt: now,
    credentialCounts: { active: 2, expired: 0, revoked: 1, total: 3 },
    currentOverride: {
      createdAt: now,
      expiresAt: new Date("2026-08-01T20:00:00.000Z"),
      maxActiveAgents: 8,
      overrideId: ids.override,
      reasonCode: "research_team_expansion",
    },
    effectiveActiveAgentLimit: 8,
    emailHint: "o***r@example.test",
    emailVerified: true,
    ownerId: ids.owner,
    quotaVersion: version,
    restrictedAt: null,
    status: "active",
    suspendedAt: null,
    totalAgentCount: 4,
    updatedAt: now,
  };
}

function control(version = 4): AdminRegistrationControlView {
  return {
    activeAgentCount: 3_000,
    activeAgentHardLimit: 10_000,
    activeAgentOperatingTarget: 5_000,
    mode: "open",
    pauseReasonCode: null,
    pausedAt: null,
    resumeCondition: null,
    updatedAt: now,
    version,
  };
}

function page(): AdminOwnerPage {
  return {
    asOf: now,
    capabilities: { canManageQuota: true },
    hasMore: false,
    items: [owner()],
    limit: 25,
    nextCursor: null,
    orderingVersion: "admin-owner-created-keyset-v1",
    snapshotId: ids.snapshot,
  };
}

function quotaMutation(replayed = false): AdminOwnerQuotaMutation {
  return {
    action: {
      action: "set_override",
      actionId: ids.action,
      adminId: ids.admin,
      occurredAt: now,
      permissionUsed: "identity:quota_manage",
      quotaVersionAfter: 2,
      quotaVersionBefore: 1,
      reasonCode: "research_team_expansion",
    },
    owner: owner(),
    replayed,
  };
}

function registrationMutation(replayed = false): AdminRegistrationMutation {
  return {
    action: {
      action: "pause_registration",
      actionId: ids.action,
      adminId: ids.admin,
      occurredAt: now,
      permissionUsed: "identity:quota_manage",
      reasonCode: "infrastructure_degradation",
      versionAfter: 5,
      versionBefore: 4,
    },
    control: {
      ...control(5),
      mode: "paused",
      pauseReasonCode: "infrastructure_degradation",
      pausedAt: now,
      resumeCondition: "Resume after dependencies remain healthy.",
    },
    replayed,
  };
}

function createApp(options: { quotaError?: Error; replayed?: boolean } = {}) {
  const runtime: AdminRequestRuntime = {
    audit: { recordSecurityRejection: vi.fn(() => Promise.resolve()) },
    identityVerifier: {
      verify: vi.fn<OidcJwtVerifier["verify"]>(() => Promise.resolve(identity)),
    },
    rateLimiter: limiter(),
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
    resolveClientIp: () => "203.0.113.41",
  };
  const listOwners = vi.fn<AdminOwnerCapacityService["listOwners"]>(() =>
    Promise.resolve(page()),
  );
  const getOwner = vi.fn<AdminOwnerCapacityService["getOwner"]>(() =>
    Promise.resolve(owner()),
  );
  const getRegistration = vi.fn<AdminOwnerCapacityService["getRegistration"]>(() =>
    Promise.resolve({
      capabilities: { canManageQuota: true },
      control: control(),
    }),
  );
  const actOnOwnerQuota = vi.fn<AdminOwnerCapacityService["actOnOwnerQuota"]>(() =>
    options.quotaError
      ? Promise.reject(options.quotaError)
      : Promise.resolve(quotaMutation(options.replayed)),
  );
  const actOnRegistration = vi.fn<AdminOwnerCapacityService["actOnRegistration"]>(() =>
    Promise.resolve(registrationMutation(options.replayed)),
  );
  const app = Fastify({ logger: false });
  registerAdminOwnerCapacityRoutes(app, {
    adminRuntime: runtime,
    service: {
      actOnOwnerQuota,
      actOnRegistration,
      getOwner,
      getRegistration,
      listOwners,
    },
  });
  apps.push(app);
  return {
    actOnOwnerQuota,
    actOnRegistration,
    app,
    getOwner,
    getRegistration,
    listOwners,
  };
}

describe("Admin Owner-capacity routes", () => {
  it("lists Owners and reads the registration singleton without secrets", async () => {
    const { app, listOwners } = createApp();
    const listed = await app.inject({
      headers: authorization,
      method: "GET",
      url: "/v1/admin/owners?statuses=active&query=owner&limit=25",
    });
    expect(listed.statusCode).toBe(200);
    expect(AdminOwnerListResponseSchema.parse(listed.json())).toMatchObject({
      capabilities: { can_manage_quota: true },
      items: [{ owner_id: ids.owner, quota_version: 2 }],
    });
    expect(listOwners.mock.calls[0]?.[1]).toEqual({
      limit: 25,
      query: "owner",
      statuses: ["active"],
    });
    expect(JSON.stringify(listed.json())).not.toContain("password");

    const capacity = await app.inject({
      headers: authorization,
      method: "GET",
      url: "/v1/admin/capacity",
    });
    expect(capacity.statusCode).toBe(200);
    expect(capacity.headers.etag).toBe('"4"');
    expect(AdminRegistrationControlResponseSchema.parse(capacity.json())).toMatchObject({
      control: { mode: "open", version: 4 },
    });
  });

  it("maps strong headers and strict quota bodies into domain commands", async () => {
    const { actOnOwnerQuota, app } = createApp();
    const response = await app.inject({
      headers: {
        ...authorization,
        "idempotency-key": "quota-action-0001",
        "if-match": '"1"',
      },
      method: "POST",
      payload: {
        action: "set_override",
        expires_at: "2026-08-01T20:00:00.000Z",
        max_active_agents: 8,
        reason_code: "research_team_expansion",
      },
      url: `/v1/admin/owners/${ids.owner}/quota-actions`,
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"2"');
    expect(AdminOwnerQuotaActionResponseSchema.parse(response.json())).toMatchObject({
      action: { action: "set_override", action_id: ids.action },
    });
    expect(actOnOwnerQuota.mock.calls[0]?.[0]).toMatchObject({
      adminId: ids.admin,
      permission: "identity:quota_manage",
    });
    expect(actOnOwnerQuota.mock.calls[0]?.[1]).toBe(ids.owner);
    expect(actOnOwnerQuota.mock.calls[0]?.[2]).toMatchObject({
      action: "set_override",
      expectedVersion: 1,
      idempotencyKey: "quota-action-0001",
      maxActiveAgents: 8,
      reasonCode: "research_team_expansion",
    });
  });

  it("applies registration actions and returns replay status", async () => {
    const { actOnRegistration, app } = createApp({ replayed: true });
    const response = await app.inject({
      headers: {
        ...authorization,
        "idempotency-key": "pause-registration-0001",
        "if-match": '"4"',
      },
      method: "POST",
      payload: {
        action: "pause_registration",
        reason_code: "infrastructure_degradation",
        resume_condition: "Resume after dependencies remain healthy.",
      },
      url: "/v1/admin/capacity/actions",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"5"');
    expect(
      AdminRegistrationControlActionResponseSchema.parse(response.json()),
    ).toMatchObject({
      action: { action: "pause_registration" },
      control: { mode: "paused" },
    });
    expect(actOnRegistration.mock.calls[0]?.[1]).toEqual({
      action: "pause_registration",
      expectedVersion: 4,
      idempotencyKey: "pause-registration-0001",
      reasonCode: "infrastructure_degradation",
      resumeCondition: "Resume after dependencies remain healthy.",
    });
  });

  it("rejects ambiguous inputs and exposes only stable version conflicts", async () => {
    const invalid = createApp();
    for (const url of [
      "/v1/admin/owners?statuses=active&statuses=suspended",
      "/v1/admin/owners?statuses=active,active",
      "/v1/admin/owners?limit=025",
      "/v1/admin/owners?unexpected=true",
    ]) {
      const response = await invalid.app.inject({
        headers: authorization,
        method: "GET",
        url,
      });
      expect(response.statusCode).toBe(422);
    }
    expect(invalid.listOwners).not.toHaveBeenCalled();

    const conflict = createApp({
      quotaError: new AdminOwnerCapacityError("OWNER_QUOTA_VERSION_CONFLICT", {
        currentVersion: 7,
      }),
    });
    const response = await conflict.app.inject({
      headers: {
        ...authorization,
        "idempotency-key": "stale-quota-0001",
        "if-match": '"1"',
      },
      method: "POST",
      payload: {
        action: "revoke_override",
        reason_code: "validated_operational_need",
      },
      url: `/v1/admin/owners/${ids.owner}/quota-actions`,
    });
    expect(response.statusCode).toBe(409);
    expect(V1ErrorResponseSchema.parse(response.json())).toMatchObject({
      error: {
        code: "OWNER_QUOTA_VERSION_CONFLICT",
        details: { current_version: 7 },
      },
    });
  });
});
