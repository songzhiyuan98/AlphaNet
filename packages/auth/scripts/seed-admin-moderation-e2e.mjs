#!/usr/bin/env node

import { hashPassword } from "better-auth/crypto";
import { Client } from "pg";

import { DEMO_CONTENT_IDS, DEMO_EMAIL, seedUiDemoData } from "./ui-demo-fixture.mjs";

export const ADMIN_MODERATION_E2E = Object.freeze({
  adminAssignmentId: "e4000000-0000-4000-8000-000000000502",
  agentGovernanceAssignmentId: "e4000000-0000-4000-8000-000000000504",
  communityAssignmentId: "e4000000-0000-4000-8000-000000000503",
  adminId: "e4000000-0000-4000-8000-000000000501",
  adminSubject: "alphanet-e2e-content-moderator",
  authorEmail: DEMO_EMAIL,
  contentId: DEMO_CONTENT_IDS.muPost,
  reporterAccountId: "e4000000-0000-4000-8000-000000000002",
  reporterActorId: "e4000000-0000-4000-8000-000000000101",
  reporterAgentId: "e4000000-0000-4000-8000-000000000201",
  reporterEmail: "reporter.owner@alphanet.local",
  reporterHandle: "moderation-e2e-reporter",
  reporterPolicyId: "e4000000-0000-4000-8000-000000000301",
  reporterUserId: "e4000000-0000-4000-8000-000000000001",
});

function fail(message) {
  throw new Error(`Admin moderation E2E seed: ${message}`);
}

function localDatabaseConfiguration(environment = process.env) {
  if (environment.ALPHANET_ALLOW_ADMIN_E2E_SEED !== "1") {
    fail("set ALPHANET_ALLOW_ADMIN_E2E_SEED=1 for this disposable fixture");
  }
  if (environment.NODE_ENV === "production") {
    fail("the fixture cannot run with NODE_ENV=production");
  }
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required");
  let parsedDatabaseUrl;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    fail("DATABASE_URL must be a PostgreSQL URL");
  }
  const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.replace(/^\//u, ""));
  if (
    !["postgres:", "postgresql:"].includes(parsedDatabaseUrl.protocol) ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsedDatabaseUrl.hostname) ||
    !databaseName.startsWith("alphanet") ||
    ["postgres", "template0", "template1"].includes(databaseName)
  ) {
    fail("DATABASE_URL must target a loopback disposable database named alphanet*");
  }

  const authorPassword =
    environment.E2E_AUTHOR_PASSWORD ?? "Author-owner-e2e-password-2026";
  const reporterPassword =
    environment.E2E_REPORTER_PASSWORD ?? "Reporter-owner-e2e-password-2026";
  if (
    authorPassword.length < 12 ||
    authorPassword.length > 128 ||
    reporterPassword.length < 12 ||
    reporterPassword.length > 128
  ) {
    fail("Owner fixture passwords must contain 12 to 128 characters");
  }

  const oidcIssuer = environment.E2E_ADMIN_OIDC_ISSUER?.trim();
  if (!oidcIssuer) fail("E2E_ADMIN_OIDC_ISSUER is required");
  let parsedIssuer;
  try {
    parsedIssuer = new URL(oidcIssuer);
  } catch {
    fail("E2E_ADMIN_OIDC_ISSUER must be an absolute URL");
  }
  if (
    parsedIssuer.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsedIssuer.hostname) ||
    parsedIssuer.search ||
    parsedIssuer.hash
  ) {
    fail("the E2E Admin issuer must be a loopback HTTP URL");
  }

  return Object.freeze({
    authorPassword,
    databaseName,
    databaseUrl: parsedDatabaseUrl.toString(),
    oidcIssuer,
    reporterPassword,
  });
}

async function assertSchema(client) {
  const result = await client.query(
    `select
       exists (
         select 1
         from system.schema_migrations
         where version = '000015'
           and name = 'web_reporting_content_moderation_v1'
       ) as moderation_ready,
       exists (
         select 1
         from system.schema_migrations
         where version = '000023'
           and name = 'admin_topic_community_v1'
       ) as community_ready,
       exists (
         select 1
         from system.schema_migrations
         where version = '000024'
           and name = 'admin_agent_enforcement_v1'
       ) as agent_governance_ready,
       exists (
         select 1
         from system.schema_migrations
         where version = '000025'
           and name = 'admin_owner_capacity_v1'
       ) as owner_capacity_ready,
       to_regclass('platform.admins') is not null as admins_ready,
       to_regclass('platform.reports') is not null as reports_ready,
       to_regclass('platform.moderation_actions') is not null as actions_ready`,
  );
  const state = result.rows[0];
  if (
    state?.moderation_ready !== true ||
    state.community_ready !== true ||
    state.agent_governance_ready !== true ||
    state.owner_capacity_ready !== true ||
    state.admins_ready !== true ||
    state.reports_ready !== true ||
    state.actions_ready !== true
  ) {
    fail("apply AlphaNet migrations through 000025 before seeding");
  }
}

async function ensureReporterOwner(client, passwordHash, base) {
  const fixture = ADMIN_MODERATION_E2E;
  const existing = await client.query(
    `select id::text as id, email, email_verified
     from auth.users
     where id = $1::uuid or email = $2
     order by (id = $1::uuid) desc`,
    [fixture.reporterUserId, fixture.reporterEmail],
  );
  if (
    existing.rows.length > 1 ||
    existing.rows.some(
      (row) => row.id !== fixture.reporterUserId || row.email !== fixture.reporterEmail,
    )
  ) {
    fail("the reserved reporter Auth User identity conflicts with local data");
  }

  if (existing.rows.length === 0) {
    await client.query(
      `insert into auth.users (id, name, email, email_verified, created_at, updated_at)
       values ($1::uuid, 'AlphaNet E2E Reporter Owner', $2, true, $3, $3)`,
      [fixture.reporterUserId, fixture.reporterEmail, base],
    );
  } else {
    await client.query(
      `update auth.users
       set email_verified = true,
           updated_at = $2
       where id = $1::uuid`,
      [fixture.reporterUserId, base],
    );
  }

  await client.query(
    `insert into auth.accounts (
       id, account_id, provider_id, user_id, password, created_at, updated_at
     ) values (
       $1::uuid, $2::text, 'credential', $2::uuid, $3, $4, $4
     )
     on conflict (provider_id, account_id) do update
       set password = excluded.password,
           updated_at = excluded.updated_at`,
    [fixture.reporterAccountId, fixture.reporterUserId, passwordHash, base],
  );

  const ownerResult = await client.query(
    `select id::text as id
     from platform.owners
     where auth_user_id = $1::uuid
       and status = 'active'
       and email_verified_at is not null
       and deleted_at is null`,
    [fixture.reporterUserId],
  );
  const ownerId = ownerResult.rows[0]?.id;
  if (!ownerId) fail("the verified reporter Owner projection is unavailable");
  return ownerId;
}

async function ensureReporterAgent(client, ownerId, base) {
  const fixture = ADMIN_MODERATION_E2E;
  const conflicts = await client.query(
    `select id::text as id, owner_id::text as owner_id, handle::text as handle
     from platform.actors
     where id = $1::uuid or handle = $2`,
    [fixture.reporterActorId, fixture.reporterHandle],
  );
  if (
    conflicts.rows.some(
      (row) =>
        row.id !== fixture.reporterActorId ||
        row.owner_id !== ownerId ||
        row.handle !== fixture.reporterHandle,
    )
  ) {
    fail("the reserved reporter Agent identity conflicts with local data");
  }

  await client.query(
    `insert into platform.actors (
       id, kind, owner_id, handle, display_name, bio, status, created_at, updated_at
     ) values (
       $1::uuid, 'agent', $2::uuid, $3,
       'Moderation E2E Reporter',
       'Submits a real Owner-authenticated report for the Admin browser flow.',
       'active', $4, $4
     ) on conflict (id) do nothing`,
    [fixture.reporterActorId, ownerId, fixture.reporterHandle, base],
  );
  await client.query(
    `insert into platform.agents (
       id, actor_id, owner_id, discovery_tags, status,
       created_at, updated_at, activated_at
     ) values (
       $1::uuid, $2::uuid, $3::uuid,
       array['moderation-e2e', 'cross-validation']::text[],
       'active', $4, $4, $4
     ) on conflict (id) do nothing`,
    [fixture.reporterAgentId, fixture.reporterActorId, ownerId, base],
  );
  await client.query(
    `insert into platform.agent_policies (
       id, agent_id, tier, defaults_version, policy_schema_version,
       version, rules, effective_from, is_active, configured_by_owner_id, created_at
     ) select
       $1::uuid, $2::uuid, 'autonomous', 'agent-permission-defaults-v1', 1,
       1, '{}'::jsonb, $4, true, $3::uuid, $4
     where not exists (
       select 1 from platform.agent_policies where id = $1::uuid
     )`,
    [fixture.reporterPolicyId, fixture.reporterAgentId, ownerId, base],
  );
  await client.query(
    `update platform.registration_controls as controls
     set active_agent_count = actual.count
     from (
       select count(*)::bigint as count
       from platform.agents
       where activated_at is not null and status <> 'archived'
     ) as actual
     where controls.id = true
       and controls.active_agent_count is distinct from actual.count`,
  );
}

async function ensureContentModerator(client, oidcIssuer, base) {
  const fixture = ADMIN_MODERATION_E2E;
  await client.query(
    `insert into platform.admins (
       id, oidc_issuer, oidc_subject, display_name, status, created_at
     ) values (
       $1::uuid, $2, $3, 'E2E Content Moderator', 'active', $4
     ) on conflict (oidc_issuer, oidc_subject) do nothing`,
    [fixture.adminId, oidcIssuer, fixture.adminSubject, base],
  );
  const admin = await client.query(
    `select id::text as id, display_name, status
     from platform.admins
     where oidc_issuer = $1 and oidc_subject = $2`,
    [oidcIssuer, fixture.adminSubject],
  );
  if (
    admin.rows.length !== 1 ||
    admin.rows[0]?.id !== fixture.adminId ||
    admin.rows[0]?.display_name !== "E2E Content Moderator" ||
    admin.rows[0]?.status !== "active"
  ) {
    fail("the reserved Admin workforce identity conflicts with local data");
  }

  await client.query(
    `insert into platform.admin_assignments (
       id, admin_id, role_id, grant_source, granted_at
     ) select
       $1::uuid, $2::uuid, role.id, 'bootstrap', $3
     from platform.admin_roles as role
     where role.key = 'content_moderator'
       and role.status = 'active'
       and not exists (
         select 1
         from platform.admin_assignments as assignment
         where assignment.admin_id = $2::uuid
           and assignment.role_id = role.id
           and assignment.revoked_at is null
       )`,
    [fixture.adminAssignmentId, fixture.adminId, base],
  );
  await client.query(
    `insert into platform.admin_assignments (
       id, admin_id, role_id, grant_source, granted_at
     ) select
       $1::uuid, $2::uuid, role.id, 'bootstrap', $3
     from platform.admin_roles as role
     where role.key = 'community_operator'
       and role.status = 'active'
       and not exists (
         select 1
         from platform.admin_assignments as assignment
         where assignment.admin_id = $2::uuid
           and assignment.role_id = role.id
           and assignment.revoked_at is null
       )`,
    [fixture.communityAssignmentId, fixture.adminId, base],
  );
  await client.query(
    `insert into platform.admin_assignments (
       id, admin_id, role_id, grant_source, granted_at
     ) select
       $1::uuid, $2::uuid, role.id, 'bootstrap', $3
     from platform.admin_roles as role
     where role.key = 'identity_operator'
       and role.status = 'active'
       and not exists (
         select 1
         from platform.admin_assignments as assignment
         where assignment.admin_id = $2::uuid
           and assignment.role_id = role.id
           and assignment.revoked_at is null
       )`,
    [fixture.agentGovernanceAssignmentId, fixture.adminId, base],
  );
}

async function verifyFixture(client) {
  const fixture = ADMIN_MODERATION_E2E;
  const result = await client.query(
    `select
       (select count(*)::integer
        from auth.users
        where email in ($1, $2) and email_verified) as verified_users,
       (select count(*)::integer
        from platform.owners as owner
        join auth.users as auth_user on auth_user.id = owner.auth_user_id
        where auth_user.email in ($1, $2)
          and owner.status = 'active'
          and owner.email_verified_at is not null
          and owner.deleted_at is null) as active_owners,
       (select count(*)::integer
        from platform.agents
        where id = $3::uuid and status = 'active') as reporter_agents,
       (select count(*)::integer
        from platform.content_items
        where id = $4::uuid
          and lifecycle_state = 'published'
          and distribution_state = 'normal') as visible_content,
       (select count(distinct permission)::integer
        from platform.admin_assignments as assignment
        join platform.admin_roles as role on role.id = assignment.role_id
        join platform.admin_role_permissions as role_permission
          on role_permission.role_id = role.id
        where assignment.admin_id = $5::uuid
          and assignment.revoked_at is null
          and role.status = 'active'
          and role_permission.permission in (
            'moderation:read',
            'moderation:decide',
            'community:manage',
            'identity:quota_manage',
            'identity:restrict',
            'credential:revoke'
          ))
          as admin_permissions`,
    [
      fixture.authorEmail,
      fixture.reporterEmail,
      fixture.reporterAgentId,
      fixture.contentId,
      fixture.adminId,
    ],
  );
  const state = result.rows[0];
  if (
    state?.verified_users !== 2 ||
    state.active_owners !== 2 ||
    state.reporter_agents !== 1 ||
    state.visible_content !== 1 ||
    state.admin_permissions !== 6
  ) {
    fail(`fixture verification failed: ${JSON.stringify(state)}`);
  }
}

export async function seedAdminModerationE2e(environment = process.env) {
  const configuration = localDatabaseConfiguration(environment);
  await seedUiDemoData({
    databaseName: configuration.databaseName,
    databaseUrl: configuration.databaseUrl,
    password: configuration.authorPassword,
  });
  const reporterPasswordHash = await hashPassword(configuration.reporterPassword);
  const client = new Client({ connectionString: configuration.databaseUrl });
  await client.connect();
  try {
    await assertSchema(client);
    await client.query("begin");
    try {
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended('alphanet:admin-moderation-e2e-seed', 0))",
      );
      const base = new Date();
      const reporterOwnerId = await ensureReporterOwner(
        client,
        reporterPasswordHash,
        base,
      );
      await ensureReporterAgent(client, reporterOwnerId, base);
      await ensureContentModerator(client, configuration.oidcIssuer, base);
      await verifyFixture(client);
      await client.query("commit");
      return Object.freeze({
        adminSubject: ADMIN_MODERATION_E2E.adminSubject,
        authorEmail: ADMIN_MODERATION_E2E.authorEmail,
        contentId: ADMIN_MODERATION_E2E.contentId,
        reporterEmail: ADMIN_MODERATION_E2E.reporterEmail,
        reporterHandle: ADMIN_MODERATION_E2E.reporterHandle,
      });
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    await client.end();
  }
}

try {
  const result = await seedAdminModerationE2e();
  process.stdout.write(
    [
      "AlphaNet Admin moderation E2E fixture is ready.",
      `Author Owner: ${result.authorEmail}`,
      `Reporter Owner: ${result.reporterEmail}`,
      `Reporter Agent: @${result.reporterHandle}`,
      `Content: ${result.contentId}`,
      `Admin subject: ${result.adminSubject}`,
      "Passwords remain only in E2E_AUTHOR_PASSWORD and E2E_REPORTER_PASSWORD.",
    ].join("\n") + "\n",
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
