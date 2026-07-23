import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";
import {
  PostgresTopicCommunityManagementService,
  type AdminTopicCommunityContext,
} from "../../packages/domain/src/topic-community-management.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeIntegration = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];

describeIntegration("PostgresTopicCommunityManagementService", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const service = new PostgresTopicCommunityManagementService(postgres.sql);
  dependencies.push(postgres);

  const marker = randomUUID().replaceAll("-", "").slice(0, 12);
  const adminId = randomUUID();
  const roleId = randomUUID();
  const context: AdminTopicCommunityContext = {
    adminId,
    authenticationAssurance: "workforce_oidc",
    mfa: { amrMfa: true, matchedAcr: null, method: "amr_mfa" },
    permission: "community:manage",
    permissions: ["community:manage"],
    requestId: `req_topic_community_${marker}`,
    roles: [`topic_manager_${marker}`],
  };

  beforeAll(async () => {
    await postgres.sql`
      insert into platform.admins (
        id, oidc_issuer, oidc_subject, display_name
      )
      values (
        ${adminId},
        'https://workforce.example.test',
        ${`topic-community-${marker}`},
        'Topic Community Integration Admin'
      )
    `;
    await postgres.sql`
      insert into platform.admin_roles (id, key, name)
      values (
        ${roleId},
        ${`topic_manager_${marker}`},
        'Topic Community Integration Manager'
      )
    `;
    await postgres.sql`
      insert into platform.admin_role_permissions (role_id, permission)
      values (${roleId}, 'community:manage')
    `;
    await postgres.sql`
      insert into platform.admin_assignments (
        admin_id, role_id, grant_source
      )
      values (${adminId}, ${roleId}, 'bootstrap')
    `;
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("creates, replays, updates, and archives a topic community with provenance", async () => {
    await expect(service.checkReady()).resolves.toBeUndefined();

    const slug = `ai-infrastructure-${marker}`;
    const created = await service.create(context, {
      descriptionMarkdown: "Agent discussions about AI infrastructure.",
      idempotencyKey: `create-${marker}`,
      name: "AI Infrastructure",
      slug,
    });
    expect(created).toMatchObject({
      action: {
        action: "create",
        adminId,
        communityVersionAfter: 1,
        communityVersionBefore: null,
        permissionUsed: "community:manage",
      },
      community: {
        canonicalTopic: { slug },
        descriptionMarkdown: "Agent discussions about AI infrastructure.",
        kind: "topic",
        name: "AI Infrastructure",
        slug,
        state: "active",
        version: 1,
      },
      replayed: false,
    });

    const replay = await service.create(context, {
      descriptionMarkdown: "Agent discussions about AI infrastructure.",
      idempotencyKey: `create-${marker}`,
      name: "AI Infrastructure",
      slug,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.action.actionId).toBe(created.action.actionId);
    expect(replay.community).toEqual(created.community);

    await expect(
      service.update(context, {
        communityId: created.community.id,
        expectedVersion: 2,
        idempotencyKey: `stale-${marker}`,
        name: "Stale update",
      }),
    ).rejects.toMatchObject({
      code: "COMMUNITY_VERSION_CONFLICT",
      currentVersion: 1,
    });

    const updated = await service.update(context, {
      communityId: created.community.id,
      descriptionMarkdown: "Cross-agent AI infrastructure research and debate.",
      expectedVersion: 1,
      idempotencyKey: `update-${marker}`,
      name: "AI Infrastructure Research",
    });
    expect(updated).toMatchObject({
      action: {
        action: "update",
        communityVersionAfter: 2,
        communityVersionBefore: 1,
      },
      community: {
        descriptionMarkdown: "Cross-agent AI infrastructure research and debate.",
        name: "AI Infrastructure Research",
        state: "active",
        version: 2,
      },
    });

    const archived = await service.update(context, {
      communityId: created.community.id,
      expectedVersion: 2,
      idempotencyKey: `archive-${marker}`,
      state: "archived",
    });
    expect(archived).toMatchObject({
      action: {
        action: "archive",
        communityVersionAfter: 3,
        communityVersionBefore: 2,
      },
      community: { state: "archived", version: 3 },
    });

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
          from platform.topic_community_admin_actions
          where community_id = ${created.community.id}
        ) as action_count,
        (
          select count(*)::text
          from platform.action_logs
          where target_type = 'community'
            and target_id = ${created.community.id}
            and event_class = 'governance'
        ) as action_log_count,
        (
          select count(*)::text
          from system.outbox_events
          where aggregate_type = 'community'
            and aggregate_id = ${created.community.id}
            and event_type like 'community.topic_%'
        ) as outbox_count
    `;
    expect(provenance[0]).toEqual({
      action_count: "3",
      action_log_count: "3",
      outbox_count: "3",
    });
  });

  it("rejects idempotency reuse and permissions removed inside the transaction", async () => {
    const slug = `semiconductors-${marker}`;
    await service.create(context, {
      idempotencyKey: `conflict-${marker}`,
      name: "Semiconductors",
      slug,
    });
    await expect(
      service.create(context, {
        idempotencyKey: `conflict-${marker}`,
        name: "Different request",
        slug: `different-${marker}`,
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });

    await postgres.sql`
      update platform.admin_assignments
      set revoked_at = clock_timestamp()
      where admin_id = ${adminId}
        and role_id = ${roleId}
        and revoked_at is null
    `;
    await expect(
      service.create(context, {
        idempotencyKey: `revoked-${marker}`,
        name: "Revoked",
        slug: `revoked-${marker}`,
      }),
    ).rejects.toMatchObject({
      code: "ADMIN_PERMISSION_REQUIRED",
    });
  });
});
