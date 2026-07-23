import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";
import { PostgresAgentConnectionService } from "../../packages/domain/src/agent-connection.js";
import { PostgresOwnerAuditService } from "../../packages/domain/src/owner-audit.js";
import type { OwnerAuditError } from "../../packages/domain/src/owner-audit.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeOwnerAudit = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const agentOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: { 1: "owner-audit-integration-pepper-material-v1" },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

describeOwnerAudit("PostgresOwnerAuditService", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const agentService = new PostgresAgentConnectionService(postgres.sql, agentOptions);
  const auditService = new PostgresOwnerAuditService(postgres.sql, {
    cursorSigningKey: Buffer.alloc(32, 0x5a),
  });
  dependencies.push(postgres);

  const marker = randomUUID().replaceAll("-", "").slice(0, 10);
  let ownerId = "";
  let agentId = "";
  let actorId = "";
  let credentialId = "";
  let crossOwnerId = "";
  let fixtureActionIds: string[] = [];
  let searchActivityId = "";

  async function createVerifiedOwner(label: string): Promise<string> {
    const users = await postgres.sql<{ id: string }[]>`
      insert into auth.users (
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        ${`Owner Audit ${label}`},
        ${`owner-audit-${label}-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id::text as id
    `;
    const authUserId = users[0]?.id;
    if (!authUserId) throw new Error("Owner audit Auth User was not created");
    const owners = await postgres.sql<{ id: string }[]>`
      select id::text as id
      from platform.owners
      where auth_user_id = ${authUserId}
    `;
    const id = owners[0]?.id;
    if (!id) throw new Error("Owner audit Owner projection was not created");
    return id;
  }

  beforeAll(async () => {
    ownerId = await createVerifiedOwner("primary");
    const agent = await agentService.createAgent(
      ownerId,
      {
        displayName: "Owner Audit Research Agent",
        handle: `audit-${marker}`,
      },
      `req_${randomUUID().replaceAll("-", "")}`,
    );
    agentId = agent.agent.id;
    actorId = agent.agent.actorId;
    const credential = await agentService.createCredential(
      ownerId,
      agentId,
      {
        name: "Owner audit workflow",
        scopes: ["research:read"],
      },
      `req_${randomUUID().replaceAll("-", "")}`,
    );
    credentialId = credential.credential.id;

    crossOwnerId = await createVerifiedOwner("cross");
    const crossAgent = await agentService.createAgent(
      crossOwnerId,
      {
        displayName: "Cross Owner Audit Agent",
        handle: `audit-cross-${marker}`,
      },
      `req_${randomUUID().replaceAll("-", "")}`,
    );
    const crossCredential = await agentService.createCredential(
      crossOwnerId,
      crossAgent.agent.id,
      {
        name: "Cross-owner audit workflow",
        scopes: ["research:read"],
      },
      `req_${randomUUID().replaceAll("-", "")}`,
    );

    fixtureActionIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of fixtureActionIds.entries()) {
      await postgres.sql`
        insert into platform.action_logs (
          id,
          event_class,
          owner_id,
          agent_id,
          credential_id,
          channel,
          authentication_assurance,
          authorization_snapshot,
          action,
          target_type,
          target_id,
          decision,
          outcome,
          request_id,
          occurred_at
        )
        values (
          ${id},
          'sensitive_read',
          ${ownerId},
          ${agentId},
          ${credentialId},
          'web',
          'email_verified_owner_session',
          ${postgres.sql.json({ owner_session: true })},
          'owner.audit.fixture',
          'agent',
          ${agentId},
          'allow',
          'succeeded',
          ${`req_owner_audit_fixture_${index}`},
          clock_timestamp() - ${index + 1} * interval '1 minute'
        )
      `;
    }

    await postgres.sql`
      insert into platform.action_logs (
        id,
        event_class,
        owner_id,
        agent_id,
        credential_id,
        channel,
        authentication_assurance,
        authorization_snapshot,
        action,
        target_type,
        target_id,
        decision,
        outcome,
        request_id
      )
      values (
        ${randomUUID()},
        'sensitive_read',
        ${crossOwnerId},
        ${crossAgent.agent.id},
        ${crossCredential.credential.id},
        'web',
        'email_verified_owner_session',
        ${postgres.sql.json({ owner_session: true })},
        'owner.audit.fixture',
        'agent',
        ${crossAgent.agent.id},
        'allow',
        'succeeded',
        'req_cross_owner_audit_fixture'
      )
    `;

    searchActivityId = randomUUID();
    await postgres.sql`
      insert into platform.agent_search_activity_events (
        id,
        request_id,
        agent_id,
        actor_id,
        credential_id,
        query_hmac,
        query_key_version,
        surface,
        search_mode,
        occurred_at,
        expires_at
      )
      values (
        ${searchActivityId},
        'req_owner_audit_search',
        ${agentId},
        ${actorId},
        ${credentialId},
        ${Buffer.alloc(32, 0x41)},
        1,
        'mcp',
        'hybrid',
        clock_timestamp() - interval '10 minutes',
        clock_timestamp() - interval '10 minutes' + interval '30 days'
      )
    `;
    await postgres.sql`
      update platform.agent_search_activity_events
      set
        outcome = 'succeeded',
        result_count = 20,
        latency_ms = 125
      where id = ${searchActivityId}
    `;
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("checks the immutable audit and recent search storage contract", async () => {
    await expect(auditService.checkReady()).resolves.toBeUndefined();
  });

  it("filters by owned Agent and Credential, paginates, and audits the read", async () => {
    const first = await auditService.listActions(
      ownerId,
      {
        action: "owner.audit.fixture",
        agentId,
        credentialId,
        limit: 2,
        outcome: "succeeded",
      },
      {
        authenticationAssurance: "email_verified_owner_session",
        requestId: "req_owner_audit_page_one",
      },
    );
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(first.items.every((item) => item.agent?.id === agentId)).toBe(true);
    expect(first.items.every((item) => item.credential?.id === credentialId)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("query_hmac");
    expect(JSON.stringify(first)).not.toContain("authorization_snapshot");

    const second = await auditService.listActions(
      ownerId,
      {
        action: "owner.audit.fixture",
        agentId,
        credentialId,
        cursor: first.nextCursor ?? undefined,
        limit: 2,
        outcome: "succeeded",
      },
      {
        authenticationAssurance: "email_verified_owner_session",
        requestId: "req_owner_audit_page_two",
      },
    );
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
      new Set(fixtureActionIds),
    );

    const readAudit = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.action_logs
      where owner_id = ${ownerId}
        and action = 'owner.audit.actions.read'
        and request_id in (
          'req_owner_audit_page_one',
          'req_owner_audit_page_two'
        )
        and event_class = 'sensitive_read'
        and outcome = 'succeeded'
    `;
    expect(readAudit[0]?.count).toBe(2);
  });

  it("does not leak another Owner and rejects a cursor bound to other filters", async () => {
    const invalidCursor: Partial<OwnerAuditError> = {
      code: "OWNER_AUDIT_CURSOR_INVALID",
    };
    const crossOwner = await auditService.listActions(
      ownerId,
      { action: "owner.audit.fixture", agentId, limit: 10 },
      {
        authenticationAssurance: "email_verified_owner_session",
        requestId: "req_owner_audit_isolation",
      },
    );
    expect(crossOwner.items).toHaveLength(3);
    expect(crossOwner.items.every((item) => item.agent?.id === agentId)).toBe(true);

    const cursorPage = await auditService.listActions(
      ownerId,
      { action: "owner.audit.fixture", limit: 1 },
      {
        authenticationAssurance: "email_verified_owner_session",
        requestId: "req_owner_audit_cursor_source",
      },
    );
    await expect(
      auditService.listActions(
        ownerId,
        {
          action: "owner.audit.fixture",
          cursor: `${cursorPage.nextCursor}tampered`,
          limit: 1,
        },
        {
          authenticationAssurance: "email_verified_owner_session",
          requestId: "req_owner_audit_cursor_tampered",
        },
      ),
    ).rejects.toMatchObject(invalidCursor);
    await expect(
      auditService.listActions(
        ownerId,
        {
          action: "owner.audit.fixture",
          cursor: cursorPage.nextCursor ?? undefined,
          limit: 1,
          outcome: "succeeded",
        },
        {
          authenticationAssurance: "email_verified_owner_session",
          requestId: "req_owner_audit_cursor_rebound",
        },
      ),
    ).rejects.toMatchObject(invalidCursor);
  });

  it("returns recent search activity without raw query data and audits the read", async () => {
    const page = await auditService.listSearchActivity(
      ownerId,
      {
        agentId,
        credentialId,
        outcome: "succeeded",
        surface: "mcp",
      },
      {
        authenticationAssurance: "email_verified_owner_session",
        requestId: "req_owner_search_activity_read",
      },
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: searchActivityId,
      agent: { id: agentId },
      credential: { id: credentialId },
      outcome: "succeeded",
      searchMode: "hybrid",
      surface: "mcp",
    });
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("query");
    expect(serialized).not.toContain("hmac");

    const readAudit = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.action_logs
      where owner_id = ${ownerId}
        and action = 'owner.audit.search_activity.read'
        and request_id = 'req_owner_search_activity_read'
        and event_class = 'sensitive_read'
        and outcome = 'succeeded'
    `;
    expect(readAudit[0]?.count).toBe(1);
  });
});
