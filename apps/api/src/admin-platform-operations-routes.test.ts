import type { OidcJwtVerifier, VerifiedOidcJwtIdentity } from "@alphanet/auth";
import {
  AdminCommunityWriteControlActionResponseSchema,
  AdminCommunityWriteControlResponseSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  AdminPlatformOperationsError,
  type AdminCommunityWriteControlMutation,
  type AdminPlatformOperationsService,
  type CommunityWriteControlView,
} from "@alphanet/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminRequestRuntime } from "./admin-request.js";
import { registerAdminPlatformOperationsRoutes } from "./admin-platform-operations-routes.js";

const adminId = "41000000-0000-4000-8000-000000000001";
const actionId = "41000000-0000-4000-8000-000000000002";
const now = new Date("2026-07-23T20:00:00.000Z");
const authorization = { authorization: "Bearer a.b.c" };
const apps: FastifyInstance[] = [];
const identity: VerifiedOidcJwtIdentity = {
  issuer: "https://login.alphanet.test/workforce",
  mfa: {
    amrMfa: true,
    matchedAcr: "urn:alphanet:assurance:mfa",
    method: "acr_and_amr_mfa",
  },
  subject: "security-administrator",
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function openControl(version = 3): CommunityWriteControlView {
  return {
    mode: "open",
    pauseReasonCode: null,
    pausedAt: null,
    resumeCondition: null,
    updatedAt: now,
    updatedByAdminId: adminId,
    version,
  };
}

function pausedMutation(replayed = false): AdminCommunityWriteControlMutation {
  return {
    action: {
      action: "pause_community_writes",
      actionId,
      adminId,
      occurredAt: now,
      permissionUsed: "platform:operate",
      reasonCode: "security_incident",
      versionAfter: 4,
      versionBefore: 3,
    },
    control: {
      ...openControl(4),
      mode: "paused",
      pauseReasonCode: "security_incident",
      pausedAt: now,
      resumeCondition: "Resume after containment controls are verified.",
    },
    replayed,
  };
}

function createApp(
  options: {
    error?: AdminPlatformOperationsError;
    replayed?: boolean;
  } = {},
) {
  const runtime: AdminRequestRuntime = {
    audit: { recordSecurityRejection: vi.fn(() => Promise.resolve()) },
    identityVerifier: {
      verify: vi.fn<OidcJwtVerifier["verify"]>(() => Promise.resolve(identity)),
    },
    rateLimiter: {
      consume: vi.fn(() => Promise.resolve({ allowed: true, retryAfter: null })),
    },
    repository: {
      resolveActiveAuthorization: vi.fn(() =>
        Promise.resolve({
          adminId,
          permissions: ["admin:role_assign", "audit:read", "platform:operate"] as const,
          roles: ["security_administrator"] as const,
        }),
      ),
    },
    resolveClientIp: () => "203.0.113.42",
  };
  const getCommunityWriteControl = vi.fn<
    AdminPlatformOperationsService["getCommunityWriteControl"]
  >(() =>
    Promise.resolve({
      canOperatePlatform: true,
      control: openControl(),
    }),
  );
  const actOnCommunityWrites = vi.fn<
    AdminPlatformOperationsService["actOnCommunityWrites"]
  >(() =>
    options.error
      ? Promise.reject(options.error)
      : Promise.resolve(pausedMutation(options.replayed)),
  );
  const app = Fastify({ logger: false });
  registerAdminPlatformOperationsRoutes(app, {
    adminRuntime: runtime,
    service: { actOnCommunityWrites, getCommunityWriteControl },
  });
  apps.push(app);
  return { actOnCommunityWrites, app, getCommunityWriteControl };
}

describe("Admin platform-operations routes", () => {
  it("reads the versioned community-write control", async () => {
    const { app, getCommunityWriteControl } = createApp();
    const response = await app.inject({
      headers: authorization,
      method: "GET",
      url: "/v1/admin/platform/community-writes",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"3"');
    expect(AdminCommunityWriteControlResponseSchema.parse(response.json())).toMatchObject(
      {
        capabilities: { can_operate_platform: true },
        control: { mode: "open", version: 3 },
      },
    );
    expect(getCommunityWriteControl.mock.calls[0]?.[0]).toMatchObject({
      adminId,
      permission: "platform:operate",
    });
  });

  it("maps strong transition headers and returns frozen replay semantics", async () => {
    const { actOnCommunityWrites, app } = createApp({ replayed: true });
    const response = await app.inject({
      headers: {
        ...authorization,
        "idempotency-key": "pause-community-writes-0001",
        "if-match": '"3"',
      },
      method: "POST",
      payload: {
        action: "pause_community_writes",
        reason_code: "security_incident",
        resume_condition: "Resume after containment controls are verified.",
      },
      url: "/v1/admin/platform/community-writes/actions",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"4"');
    expect(
      AdminCommunityWriteControlActionResponseSchema.parse(response.json()),
    ).toMatchObject({
      action: { action: "pause_community_writes" },
      control: { mode: "paused", version: 4 },
    });
    expect(actOnCommunityWrites.mock.calls[0]?.[1]).toEqual({
      action: "pause_community_writes",
      expectedVersion: 3,
      idempotencyKey: "pause-community-writes-0001",
      reasonCode: "security_incident",
      resumeCondition: "Resume after containment controls are verified.",
    });
  });

  it("rejects malformed commands and exposes only stable conflicts", async () => {
    const invalid = createApp();
    const malformed = await invalid.app.inject({
      headers: {
        ...authorization,
        "idempotency-key": "pause-community-writes-0002",
        "if-match": "3",
      },
      method: "POST",
      payload: {
        action: "pause_community_writes",
        reason_code: "security_incident",
        resume_condition: "Verified.",
      },
      url: "/v1/admin/platform/community-writes/actions?unexpected=true",
    });
    expect(malformed.statusCode).toBe(422);
    expect(invalid.actOnCommunityWrites).not.toHaveBeenCalled();

    const conflict = createApp({
      error: new AdminPlatformOperationsError("CONTROL_VERSION_CONFLICT", {
        currentVersion: 8,
      }),
    });
    const response = await conflict.app.inject({
      headers: {
        ...authorization,
        "idempotency-key": "pause-community-writes-0003",
        "if-match": '"3"',
      },
      method: "POST",
      payload: {
        action: "pause_community_writes",
        reason_code: "security_incident",
        resume_condition: "Verified.",
      },
      url: "/v1/admin/platform/community-writes/actions",
    });
    expect(response.statusCode).toBe(409);
    expect(V1ErrorResponseSchema.parse(response.json())).toMatchObject({
      error: {
        code: "CONTROL_VERSION_CONFLICT",
        details: { current_version: 8 },
      },
    });
  });
});
