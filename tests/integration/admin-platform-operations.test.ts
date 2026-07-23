import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";
import {
  PostgresAdminPlatformOperationsService,
  type AdminPlatformOperationsContext,
} from "../../packages/domain/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeIntegration = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];

describeIntegration("PostgresAdminPlatformOperationsService", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  dependencies.push(postgres);
  const service = new PostgresAdminPlatformOperationsService(postgres.sql);
  const marker = randomUUID().replaceAll("-", "").slice(0, 12);
  const adminId = randomUUID();
  const roleId = "4b756e75-bf2d-4aa4-8ac4-5bd474290105";
  const context: AdminPlatformOperationsContext = {
    adminId,
    authenticationAssurance: "workforce_oidc",
    mfa: { amrMfa: true, matchedAcr: null, method: "amr_mfa" },
    permission: "platform:operate",
    permissions: [
      "admin:role_assign",
      "audit:read",
      "community:manage",
      "credential:revoke",
      "identity:quota_manage",
      "identity:restrict",
      "moderation:decide",
      "moderation:read",
      "platform:operate",
    ],
    requestId: `req_platform_operations_${marker}`,
    roles: ["security_administrator"],
  };
  let initialVersion = 0;
  let pausedActionId = "";

  async function forceOpen(): Promise<void> {
    const rows = await postgres.sql<{ mode: string }[]>`
      select mode
      from platform.community_write_controls
      where id = true
    `;
    if (rows[0]?.mode === "paused") {
      await postgres.sql`
        update platform.community_write_controls
        set mode = 'open',
            updated_by_admin_id = ${adminId}
        where id = true
      `;
    }
  }

  beforeAll(async () => {
    await postgres.sql`
      insert into platform.admins (
        id, oidc_issuer, oidc_subject, display_name
      )
      values (
        ${adminId},
        'https://workforce.example.test',
        ${`platform-operations-${marker}`},
        'Platform Operations Integration Admin'
      )
    `;
    await postgres.sql`
      insert into platform.admin_assignments (
        admin_id, role_id, grant_source
      )
      values (${adminId}, ${roleId}, 'bootstrap')
    `;
    await forceOpen();
    initialVersion = (await service.getCommunityWriteControl(context)).control.version;
  });

  afterAll(async () => {
    try {
      await forceOpen();
    } finally {
      await closeDependencies(dependencies);
    }
  });

  it("is schema-gated and reads current platform permission inside PostgreSQL", async () => {
    await expect(service.checkReady()).resolves.toBeUndefined();
    await expect(service.getCommunityWriteControl(context)).resolves.toMatchObject({
      canOperatePlatform: true,
      control: {
        mode: "open",
        version: initialVersion,
      },
    });
  });

  it("pauses idempotently with same-transaction governance provenance", async () => {
    const idempotencyKey = `pause-community-writes-${marker}`;
    const paused = await service.actOnCommunityWrites(context, {
      action: "pause_community_writes",
      expectedVersion: initialVersion,
      idempotencyKey,
      reasonCode: "security_incident",
      resumeCondition: "Resume after containment controls are verified.",
    });
    pausedActionId = paused.action.actionId;
    expect(paused).toMatchObject({
      action: {
        permissionUsed: "platform:operate",
        versionAfter: initialVersion + 1,
        versionBefore: initialVersion,
      },
      control: {
        mode: "paused",
        pauseReasonCode: "security_incident",
        version: initialVersion + 1,
      },
      replayed: false,
    });

    const replay = await service.actOnCommunityWrites(context, {
      action: "pause_community_writes",
      expectedVersion: initialVersion,
      idempotencyKey,
      reasonCode: "security_incident",
      resumeCondition: "Resume after containment controls are verified.",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.action.actionId).toBe(pausedActionId);

    await expect(
      service.actOnCommunityWrites(context, {
        action: "pause_community_writes",
        expectedVersion: initialVersion,
        idempotencyKey,
        reasonCode: "integrity_incident",
        resumeCondition: "Resume after containment controls are verified.",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const provenance = await postgres.sql<
      {
        action_count: string;
        action_log_count: string;
        outbox_count: string;
      }[]
    >`
      select
        (
          select count(*)::text
          from platform.community_write_control_admin_actions
          where id = ${pausedActionId}
        ) as action_count,
        (
          select count(*)::text
          from platform.action_logs
          where action = 'platform.community_writes.pause'
            and admin_id = ${adminId}
        ) as action_log_count,
        (
          select count(*)::text
          from system.outbox_events
          where event_type = 'platform.community_writes_paused'
            and payload ->> 'action_id' = ${pausedActionId}
        ) as outbox_count
    `;
    expect(provenance[0]).toEqual({
      action_count: "1",
      action_log_count: "1",
      outbox_count: "1",
    });
  });

  it("resumes cleanly and fails closed after current permission revocation", async () => {
    const resumed = await service.actOnCommunityWrites(context, {
      action: "resume_community_writes",
      expectedVersion: initialVersion + 1,
      idempotencyKey: `resume-community-writes-${marker}`,
      reasonCode: "incident_resolved",
    });
    expect(resumed.control).toMatchObject({
      mode: "open",
      pauseReasonCode: null,
      pausedAt: null,
      resumeCondition: null,
      version: initialVersion + 2,
    });

    await postgres.sql`
      update platform.admin_assignments
      set revoked_at = clock_timestamp()
      where admin_id = ${adminId}
        and role_id = ${roleId}
        and revoked_at is null
    `;
    await expect(service.getCommunityWriteControl(context)).rejects.toMatchObject({
      code: "ADMIN_PERMISSION_REQUIRED",
    });
  });
});
