import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";
import {
  PostgresAdminAgentEnforcementService,
  PostgresAgentConnectionService,
  PostgresWebSocialAuthorityResolver,
  createOwnerWebContextAuthority,
  type AdminAgentContext,
} from "../../packages/domain/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeIntegration = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const apiKeyPepper =
  "integration-Agent-governance-pepper-with-more-than-thirty-two-characters";

describeIntegration("PostgresAdminAgentEnforcementService", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  dependencies.push(postgres);
  const service = new PostgresAdminAgentEnforcementService(postgres.sql, {
    cursorSigningKey: Buffer.alloc(32, 11),
  });
  const ownerWebContextAuthority = createOwnerWebContextAuthority();
  const webAuthority = new PostgresWebSocialAuthorityResolver(
    postgres.sql,
    ownerWebContextAuthority.verifier,
  );
  const connection = new PostgresAgentConnectionService(postgres.sql, {
    activeCredentialsPerAgent: 5,
    activeCredentialsPerOwner: 20,
    apiAudience: "urn:alphanet:api:v1",
    apiKeyCurrentPepperVersion: 1,
    apiKeyPeppers: { 1: apiKeyPepper },
    credentialDefaultTtlDays: 90,
    credentialIssuePerOwner24Hours: 10,
    credentialMaxTtlDays: 365,
    credentialMutationCooldownSeconds: 0,
  });

  const marker = randomUUID().replaceAll("-", "").slice(0, 12);
  const adminId = randomUUID();
  const roleId = "4b756e75-bf2d-4aa4-8ac4-5bd474290102";
  const context: AdminAgentContext = {
    adminId,
    authenticationAssurance: "workforce_oidc",
    mfa: { amrMfa: true, matchedAcr: null, method: "amr_mfa" },
    permission: "identity:restrict",
    permissions: ["credential:revoke", "identity:quota_manage", "identity:restrict"],
    requestId: `req_agent_governance_${marker}`,
    roles: ["identity_operator"],
  };

  let ownerId = "";
  let agentId = "";
  let actorId = "";
  let activeApiKey = "";

  beforeAll(async () => {
    await postgres.sql`
      insert into platform.admins (
        id, oidc_issuer, oidc_subject, display_name
      )
      values (
        ${adminId},
        'https://workforce.example.test',
        ${`agent-governance-${marker}`},
        'Agent Governance Integration Admin'
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
        'Agent Governance Owner',
        ${`agent-governance-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id::text
    `;
    const authUserId = users[0]?.id;
    if (!authUserId) throw new Error("Auth User insert returned no ID.");
    const owners = await postgres.sql<{ id: string }[]>`
      select id::text
      from platform.owners
      where auth_user_id = ${authUserId}
    `;
    ownerId = owners[0]?.id ?? "";
    if (!ownerId) throw new Error("Owner projection was not provisioned.");

    const created = await connection.createAgent(
      ownerId,
      {
        displayName: "Governance Research Agent",
        handle: `governance-${marker}`,
      },
      randomUUID(),
    );
    agentId = created.agent.id;
    actorId = created.agent.actorId;
    const firstCredential = await connection.createCredential(
      ownerId,
      agentId,
      { name: "Primary integration key", scopes: ["research:read"] },
      randomUUID(),
    );
    activeApiKey = firstCredential.apiKey;
    await connection.createCredential(
      ownerId,
      agentId,
      { name: "Secondary integration key", scopes: ["research:read"] },
      randomUUID(),
    );
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("lists and returns a bounded, secret-free Agent projection", async () => {
    await expect(service.checkReady()).resolves.toBeUndefined();

    const first = await service.list(context, {
      limit: 1,
      query: marker,
      statuses: ["active"],
    });
    expect(first).toMatchObject({
      capabilities: { canRestrict: true, canRevokeCredentials: true },
      hasMore: false,
      limit: 1,
      orderingVersion: "admin-agent-created-keyset-v1",
    });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      agentId,
      actorId,
      ownerId,
      governanceVersion: 1,
      status: "active",
      credentialCounts: { active: 2, expired: 0, revoked: 0, total: 2 },
    });

    const detail = await service.get(context, agentId);
    expect(detail.credentials).toHaveLength(2);
    expect(detail.credentials.every((credential) => credential.status === "active")).toBe(
      true,
    );
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(activeApiKey);
    expect(serialized).not.toContain("secret_digest");
    expect(serialized).not.toContain("pepper");

    await expect(
      service.list(context, {
        cursor: "not.a.valid.cursor",
        limit: 1,
        query: marker,
        statuses: ["active"],
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
  });

  it("serializes enforcement, preserves idempotency, and records provenance", async () => {
    await expect(
      service.act(context, agentId, {
        action: "restrict_agent",
        expectedVersion: 2,
        idempotencyKey: `stale-${marker}`,
        reasonCode: "spam_automation",
      }),
    ).rejects.toMatchObject({
      code: "AGENT_VERSION_CONFLICT",
      currentVersion: 1,
    });

    const restricted = await service.act(context, agentId, {
      action: "restrict_agent",
      expectedVersion: 1,
      idempotencyKey: `restrict-${marker}`,
      internalNote: "Automated spam pattern confirmed by platform telemetry.",
      reasonCode: "spam_automation",
    });
    expect(restricted).toMatchObject({
      action: {
        governanceVersionAfter: 2,
        governanceVersionBefore: 1,
        permissionUsed: "identity:restrict",
        revokedCredentialCount: 0,
      },
      agent: {
        governanceVersion: 2,
        restrictionReasonCode: "spam_automation",
        status: "restricted",
      },
      replayed: false,
    });
    await expect(connection.authenticateStaticApiKey(activeApiKey)).rejects.toMatchObject(
      {
        code: "INVALID_CREDENTIAL",
      },
    );
    const ownerWebContext = ownerWebContextAuthority.issuer.issueMutationContext({
      authenticatedAt: new Date(),
      authenticationAssurance: "owner_session",
      ownerId,
      requestId: randomUUID(),
      sessionId: randomUUID(),
    });
    await expect(
      postgres.sql.begin((transaction) =>
        webAuthority.resolveAuthorityInTransaction(transaction, ownerWebContext, {
          agentId,
          kind: "owner_direct",
        }),
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_NOT_FOUND" });

    const replay = await service.act(context, agentId, {
      action: "restrict_agent",
      expectedVersion: 1,
      idempotencyKey: `restrict-${marker}`,
      internalNote: "Automated spam pattern confirmed by platform telemetry.",
      reasonCode: "spam_automation",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.action.actionId).toBe(restricted.action.actionId);
    expect(replay.agent).toEqual(restricted.agent);

    const concurrent = await Promise.allSettled([
      service.act(context, agentId, {
        action: "suspend_agent",
        expectedVersion: 2,
        idempotencyKey: `suspend-a-${marker}`,
        reasonCode: "platform_policy_violation",
      }),
      service.act(context, agentId, {
        action: "suspend_agent",
        expectedVersion: 2,
        idempotencyKey: `suspend-b-${marker}`,
        reasonCode: "platform_policy_violation",
      }),
    ]);
    const fulfilled = concurrent.filter(
      (
        result,
      ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.act>>> =>
        result.status === "fulfilled",
    );
    const rejected = concurrent.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.agent).toMatchObject({
      governanceVersion: 3,
      status: "suspended",
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: "AGENT_VERSION_CONFLICT",
      currentVersion: 3,
    });

    const restored = await service.act(context, agentId, {
      action: "restore_agent",
      expectedVersion: 3,
      idempotencyKey: `restore-${marker}`,
      reasonCode: "risk_condition_resolved",
    });
    expect(restored.agent).toMatchObject({
      governanceVersion: 4,
      restrictionReasonCode: null,
      status: "active",
    });
    await expect(
      connection.authenticateStaticApiKey(activeApiKey),
    ).resolves.toMatchObject({
      agent: { id: agentId, status: "active" },
    });

    const revoked = await service.act(context, agentId, {
      action: "revoke_credentials",
      expectedVersion: 4,
      idempotencyKey: `revoke-${marker}`,
      reasonCode: "credential_compromise",
    });
    expect(revoked).toMatchObject({
      action: {
        governanceVersionAfter: 5,
        governanceVersionBefore: 4,
        permissionUsed: "credential:revoke",
        revokedCredentialCount: 2,
      },
      agent: { governanceVersion: 5, status: "active" },
    });
    await expect(connection.authenticateStaticApiKey(activeApiKey)).rejects.toMatchObject(
      {
        code: "INVALID_CREDENTIAL",
      },
    );

    await expect(
      service.act(context, agentId, {
        action: "restrict_agent",
        expectedVersion: 5,
        idempotencyKey: `revoke-${marker}`,
        reasonCode: "spam_automation",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const state = await postgres.sql<
      {
        action_count: string;
        action_log_count: string;
        actor_status: string;
        agent_status: string;
        outbox_count: string;
        revoked_count: string;
      }[]
    >`
      select
        agent.status as agent_status,
        actor.status as actor_status,
        (
          select count(*)::text
          from platform.credentials
          where agent_id = ${agentId}
            and revoked_at is not null
        ) as revoked_count,
        (
          select count(*)::text
          from platform.agent_admin_actions
          where agent_id = ${agentId}
        ) as action_count,
        (
          select count(*)::text
          from platform.action_logs
          where target_type = 'agent'
            and target_id = ${agentId}
            and event_class = 'governance'
            and admin_id = ${adminId}
        ) as action_log_count,
        (
          select count(*)::text
          from system.outbox_events
          where aggregate_type = 'agent'
            and aggregate_id = ${agentId}
            and event_type = any(
              ${[
                "agent.restricted",
                "agent.suspended",
                "agent.restored",
                "agent.credentials_revoked",
              ]}
            )
        ) as outbox_count
      from platform.agents as agent
      join platform.actors as actor on actor.id = agent.actor_id
      where agent.id = ${agentId}
    `;
    expect(state[0]).toEqual({
      action_count: "4",
      action_log_count: "4",
      actor_status: "active",
      agent_status: "active",
      outbox_count: "4",
      revoked_count: "2",
    });
  });

  it("revalidates the Admin permission inside the transaction", async () => {
    await postgres.sql`
      update platform.admin_assignments
      set revoked_at = clock_timestamp()
      where admin_id = ${adminId}
        and role_id = ${roleId}
        and revoked_at is null
    `;

    await expect(service.get(context, agentId)).rejects.toMatchObject({
      code: "ADMIN_PERMISSION_REQUIRED",
    });
    await expect(
      service.act(context, agentId, {
        action: "restrict_agent",
        expectedVersion: 5,
        idempotencyKey: `permission-revoked-${marker}`,
        reasonCode: "spam_automation",
      }),
    ).rejects.toMatchObject({ code: "ADMIN_PERMISSION_REQUIRED" });
  });
});
