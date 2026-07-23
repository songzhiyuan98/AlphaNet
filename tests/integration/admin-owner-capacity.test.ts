import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";
import {
  PostgresAdminOwnerCapacityService,
  PostgresAgentConnectionService,
  type AdminOwnerCapacityContext,
} from "../../packages/domain/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeIntegration = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];

describeIntegration("PostgresAdminOwnerCapacityService", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  dependencies.push(postgres);
  const service = new PostgresAdminOwnerCapacityService(postgres.sql, {
    cursorSigningKey: Buffer.alloc(32, 17),
  });
  const connection = new PostgresAgentConnectionService(postgres.sql, {
    activeCredentialsPerAgent: 5,
    activeCredentialsPerOwner: 20,
    apiAudience: "urn:alphanet:api:v1",
    apiKeyCurrentPepperVersion: 1,
    apiKeyPeppers: {
      1: "owner-capacity-integration-pepper-more-than-thirty-two-characters",
    },
    credentialDefaultTtlDays: 90,
    credentialIssuePerOwner24Hours: 10,
    credentialMaxTtlDays: 365,
    credentialMutationCooldownSeconds: 0,
  });

  const marker = randomUUID().replaceAll("-", "").slice(0, 12);
  const adminId = randomUUID();
  const roleId = "4b756e75-bf2d-4aa4-8ac4-5bd474290102";
  const context: AdminOwnerCapacityContext = {
    adminId,
    authenticationAssurance: "workforce_oidc",
    mfa: { amrMfa: true, matchedAcr: null, method: "amr_mfa" },
    permission: "identity:quota_manage",
    permissions: ["credential:revoke", "identity:quota_manage", "identity:restrict"],
    requestId: `req_owner_capacity_${marker}`,
    roles: ["identity_operator"],
  };

  let ownerId = "";
  let registrationVersion = 0;

  beforeAll(async () => {
    await postgres.sql`
      insert into platform.admins (
        id, oidc_issuer, oidc_subject, display_name
      )
      values (
        ${adminId},
        'https://workforce.example.test',
        ${`owner-capacity-${marker}`},
        'Owner Capacity Integration Admin'
      )
    `;
    await postgres.sql`
      insert into platform.admin_assignments (
        admin_id, role_id, grant_source
      )
      values (${adminId}, ${roleId}, 'bootstrap')
    `;
    const users = await postgres.sql<{ id: string }[]>`
      insert into auth.users (
        name, email, email_verified, created_at, updated_at
      )
      values (
        'Owner Capacity Fixture',
        ${`owner-capacity-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id::text
    `;
    const owners = await postgres.sql<{ id: string }[]>`
      select id::text
      from platform.owners
      where auth_user_id = ${users[0]!.id}
    `;
    ownerId = owners[0]?.id ?? "";
    if (!ownerId) throw new Error("Owner projection was not provisioned.");
    registrationVersion = (await service.getRegistration(context)).control.version;
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("returns bounded, masked and permission-protected capacity projections", async () => {
    await expect(service.checkReady()).resolves.toBeUndefined();
    const page = await service.listOwners(context, {
      limit: 1,
      query: marker,
      statuses: ["active"],
    });
    expect(page).toMatchObject({
      capabilities: { canManageQuota: true },
      hasMore: false,
      limit: 1,
      orderingVersion: "admin-owner-created-keyset-v1",
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      activeAgentCount: 0,
      baseActiveAgentLimit: 5,
      effectiveActiveAgentLimit: 5,
      emailVerified: true,
      ownerId,
      quotaVersion: 1,
      status: "active",
    });
    expect(page.items[0]!.emailHint).toContain("***");
    expect(JSON.stringify(page)).not.toContain(`owner-capacity-${marker}@example.test`);

    await expect(
      service.listOwners(context, {
        cursor: "invalid.cursor",
        limit: 1,
        query: marker,
        statuses: ["active"],
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
  });

  it("sets a temporary quota, enforces it in Agent activation, and records provenance", async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    const changed = await service.actOnOwnerQuota(context, ownerId, {
      action: "set_override",
      expectedVersion: 1,
      expiresAt,
      idempotencyKey: `quota-set-${marker}`,
      maxActiveAgents: 6,
      reasonCode: "research_team_expansion",
    });
    expect(changed).toMatchObject({
      action: {
        permissionUsed: "identity:quota_manage",
        quotaVersionAfter: 2,
        quotaVersionBefore: 1,
      },
      owner: {
        effectiveActiveAgentLimit: 6,
        quotaVersion: 2,
      },
      replayed: false,
    });
    expect(changed.owner.currentOverride?.expiresAt.toISOString()).toBe(
      expiresAt.toISOString(),
    );

    const replay = await service.actOnOwnerQuota(context, ownerId, {
      action: "set_override",
      expectedVersion: 1,
      expiresAt,
      idempotencyKey: `quota-set-${marker}`,
      maxActiveAgents: 6,
      reasonCode: "research_team_expansion",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.action.actionId).toBe(changed.action.actionId);

    const draftIds: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const actorId = randomUUID();
      const agentId = randomUUID();
      draftIds.push(agentId);
      await postgres.sql.begin(async (transaction) => {
        await transaction`
          insert into platform.actors (
            id, kind, owner_id, handle, display_name, status
          )
          values (
            ${actorId}, 'agent', ${ownerId},
            ${`capacity-${marker}-${index}`},
            ${`Capacity Agent ${index}`},
            'draft'
          )
        `;
        await transaction`
          insert into platform.agents (
            id, actor_id, owner_id, status
          )
          values (${agentId}, ${actorId}, ${ownerId}, 'draft')
        `;
        await transaction`
          insert into platform.agent_policies (
            agent_id, tier, defaults_version, policy_schema_version, version,
            rules, is_active, configured_by_owner_id
          )
          values (
            ${agentId}, 'assisted', 'agent-permission-defaults-v1', 1, 1,
            '{}'::jsonb, true, ${ownerId}
          )
        `;
      });
    }
    for (const agentId of draftIds.slice(0, 6)) {
      await expect(
        connection.activateAgent(ownerId, agentId, randomUUID()),
      ).resolves.toMatchObject({ agent: { status: "active" } });
    }
    await expect(
      connection.activateAgent(ownerId, draftIds[6]!, randomUUID()),
    ).rejects.toMatchObject({ code: "AGENT_ACTIVE_QUOTA_EXCEEDED" });

    const state = await postgres.sql<
      {
        action_count: string;
        action_log_count: string;
        outbox_count: string;
      }[]
    >`
      select
        (
          select count(*)::text
          from platform.owner_capacity_admin_actions
          where owner_id = ${ownerId}
            and action = 'set_override'
        ) as action_count,
        (
          select count(*)::text
          from platform.action_logs
          where owner_id = ${ownerId}
            and action = 'owner.agent_quota_override.set'
        ) as action_log_count,
        (
          select count(*)::text
          from system.outbox_events
          where aggregate_type = 'owner'
            and aggregate_id = ${ownerId}
            and event_type = 'owner.agent_quota_override_set'
        ) as outbox_count
    `;
    expect(state[0]).toEqual({
      action_count: "1",
      action_log_count: "1",
      outbox_count: "1",
    });
  });

  it("revokes the override and serializes concurrent quota changes", async () => {
    const concurrent = await Promise.allSettled([
      service.actOnOwnerQuota(context, ownerId, {
        action: "set_override",
        expectedVersion: 2,
        expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1_000),
        idempotencyKey: `quota-concurrent-a-${marker}`,
        maxActiveAgents: 8,
        reasonCode: "validated_operational_need",
      }),
      service.actOnOwnerQuota(context, ownerId, {
        action: "set_override",
        expectedVersion: 2,
        expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1_000),
        idempotencyKey: `quota-concurrent-b-${marker}`,
        maxActiveAgents: 9,
        reasonCode: "validated_operational_need",
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
    const current = await service.getOwner(context, ownerId);
    expect(current.quotaVersion).toBe(3);

    const revoked = await service.actOnOwnerQuota(context, ownerId, {
      action: "revoke_override",
      expectedVersion: 3,
      idempotencyKey: `quota-revoke-${marker}`,
      reasonCode: "validated_operational_need",
    });
    expect(revoked.owner).toMatchObject({
      currentOverride: null,
      effectiveActiveAgentLimit: 5,
      quotaVersion: 4,
    });
    await expect(
      connection.activateAgent(
        ownerId,
        (
          await postgres.sql<{ id: string }[]>`
            select id::text
            from platform.agents
            where owner_id = ${ownerId}
              and status = 'draft'
            order by created_at desc
            limit 1
          `
        )[0]!.id,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "AGENT_ACTIVE_QUOTA_EXCEEDED" });
  });

  it("pauses and resumes registration without creating a waitlist identity", async () => {
    registrationVersion = (await service.getRegistration(context)).control.version;
    const paused = await service.actOnRegistration(context, {
      action: "pause_registration",
      expectedVersion: registrationVersion,
      idempotencyKey: `registration-pause-${marker}`,
      reasonCode: "infrastructure_degradation",
      resumeCondition: "Resume after registration dependencies remain healthy.",
    });
    registrationVersion = paused.control.version;
    expect(paused.control).toMatchObject({
      mode: "paused",
      pauseReasonCode: "infrastructure_degradation",
    });

    const blockedEmail = `blocked-${marker}@example.test`;
    await expect(
      postgres.sql`
        insert into auth.users (
          name, email, email_verified, created_at, updated_at
        )
        values (
          'Blocked Registration',
          ${blockedEmail},
          false,
          clock_timestamp(),
          clock_timestamp()
        )
      `,
    ).rejects.toBeDefined();
    const orphan = await postgres.sql<{ count: string }[]>`
      select count(*)::text
      from auth.users
      where email = ${blockedEmail}
    `;
    expect(orphan[0]?.count).toBe("0");
    await expect(service.getOwner(context, ownerId)).resolves.toMatchObject({
      ownerId,
    });

    const resumed = await service.actOnRegistration(context, {
      action: "resume_registration",
      expectedVersion: registrationVersion,
      idempotencyKey: `registration-resume-${marker}`,
      reasonCode: "incident_resolved",
    });
    registrationVersion = resumed.control.version;
    expect(resumed.control).toMatchObject({
      mode: "open",
      pauseReasonCode: null,
      pausedAt: null,
      resumeCondition: null,
    });

    const operatingTarget =
      resumed.control.activeAgentOperatingTarget === 8_000 ? 7_000 : 8_000;
    const limited = await service.actOnRegistration(context, {
      action: "set_capacity_limits",
      activeAgentHardLimit: 9_000,
      activeAgentOperatingTarget: operatingTarget,
      expectedVersion: registrationVersion,
      idempotencyKey: `registration-limits-${marker}`,
      reasonCode: "validated_operational_need",
    });
    registrationVersion = limited.control.version;
    expect(limited.control).toMatchObject({
      activeAgentHardLimit: 9_000,
      activeAgentOperatingTarget: operatingTarget,
    });
  });

  it("revalidates the Admin permission inside every transaction", async () => {
    await postgres.sql`
      update platform.admin_assignments
      set revoked_at = clock_timestamp()
      where admin_id = ${adminId}
        and role_id = ${roleId}
        and revoked_at is null
    `;
    await expect(service.getRegistration(context)).rejects.toMatchObject({
      code: "ADMIN_PERMISSION_REQUIRED",
    });
    await expect(service.getOwner(context, ownerId)).rejects.toMatchObject({
      code: "ADMIN_PERMISSION_REQUIRED",
    });
  });
});
