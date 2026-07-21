import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  AgentConnectionError,
  PostgresAgentConnectionService,
} from "../../packages/domain/src/index.js";
import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describePolicyControl = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const serviceOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: {
    1: "policy-control-integration-pepper-with-at-least-thirty-two-bytes",
  },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

describePolicyControl("Agent Owner policy control", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const service = new PostgresAgentConnectionService(postgres.sql, serviceOptions);
  dependencies.push(postgres);

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  async function createOwner(): Promise<string> {
    const users = await postgres.sql<{ id: string }[]>`
      insert into auth.users (
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        'Agent Policy Integration Owner',
        ${`agent-policy-${randomUUID()}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id
    `;
    const userId = users[0]?.id;
    if (!userId) throw new Error("Auth User insert did not return an id");
    const owners = await postgres.sql<{ id: string }[]>`
      select id
      from platform.owners
      where auth_user_id = ${userId}
    `;
    const ownerId = owners[0]?.id;
    if (!ownerId) throw new Error("Owner projection was not provisioned");
    return ownerId;
  }

  async function createAgent(ownerId: string) {
    const marker = randomUUID().replaceAll("-", "").slice(0, 12);
    return service.createAgent(
      ownerId,
      {
        displayName: "Policy Control Agent",
        handle: `policy-${marker}`,
      },
      randomUUID(),
    );
  }

  it("requires acknowledgement and a fresh DB-clock-bounded Owner session", async () => {
    const ownerId = await createOwner();
    const created = await createAgent(ownerId);
    const base = {
      expectedVersion: "1",
      rules: {},
      tier: "autonomous" as const,
    };

    await expect(
      service.updateAgentPolicy(
        ownerId,
        created.agent.id,
        {
          ...base,
          authenticatedAt: new Date(),
          authenticationAssurance: "fresh_owner_session",
          autonomousAcknowledged: false,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "AUTONOMOUS_ACKNOWLEDGEMENT_REQUIRED" });

    for (const attempted of [
      {
        authenticatedAt: new Date(),
        authenticationAssurance: "owner_session" as const,
      },
      {
        authenticatedAt: new Date(Date.now() - 10 * 60_000 - 5_000),
        authenticationAssurance: "fresh_owner_session" as const,
      },
      {
        authenticatedAt: new Date(Date.now() + 65_000),
        authenticationAssurance: "fresh_owner_session" as const,
      },
    ]) {
      await expect(
        service.updateAgentPolicy(
          ownerId,
          created.agent.id,
          {
            ...base,
            ...attempted,
            autonomousAcknowledged: true,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: "OWNER_REAUTHENTICATION_REQUIRED" });
    }

    const requestId = randomUUID();
    const changed = await service.updateAgentPolicy(
      ownerId,
      created.agent.id,
      {
        ...base,
        authenticatedAt: new Date(),
        authenticationAssurance: "fresh_owner_session",
        autonomousAcknowledged: true,
      },
      requestId,
    );
    expect(changed).toMatchObject({
      changed: true,
      credentialImpact: {
        ceilingCounts: {
          assisted: 0,
          autonomous: 0,
          custom: 0,
          read_only: 0,
        },
        retainedCredentialCount: 0,
      },
      previousPolicy: { tier: "assisted", version: "1" },
      agent: {
        policy: {
          tier: "autonomous",
          version: "2",
          rules: { operations: { content_write: "allow" } },
        },
      },
    });

    const effects = await postgres.sql<
      {
        audit_count: number;
        linked_event_type: string;
        assurance: string;
        acknowledged: boolean;
      }[]
    >`
      select
        count(*)::integer as audit_count,
        min(event.event_type) as linked_event_type,
        min(log.authentication_assurance) as assurance,
        bool_and(
          (log.authorization_snapshot
            ->> 'autonomous_content_write_acknowledged')::boolean
        ) as acknowledged
      from platform.action_logs as log
      join system.outbox_events as event on event.id = log.outbox_event_id
      where log.request_id = ${requestId}
        and log.action = 'agent.policy.update'
    `;
    expect(effects[0]).toEqual({
      acknowledged: true,
      assurance: "fresh_owner_session",
      audit_count: 1,
      linked_event_type: "agent.permission_policy_changed.v1",
    });

    const convergedRequestId = randomUUID();
    const converged = await service.updateAgentPolicy(
      ownerId,
      created.agent.id,
      {
        ...base,
        authenticatedAt: new Date(0),
        authenticationAssurance: "owner_session",
        autonomousAcknowledged: false,
      },
      convergedRequestId,
    );
    expect(converged).toMatchObject({
      changed: false,
      agent: { policy: { version: "2" } },
    });
    const convergedEffects = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.action_logs
      where request_id = ${convergedRequestId}
    `;
    expect(convergedEffects[0]?.count).toBe(0);
  });

  it("reports optimistic conflicts with the current policy head", async () => {
    const ownerId = await createOwner();
    const created = await createAgent(ownerId);
    await service.updateAgentPolicy(
      ownerId,
      created.agent.id,
      {
        authenticatedAt: new Date(),
        authenticationAssurance: "owner_session",
        autonomousAcknowledged: false,
        expectedVersion: "1",
        rules: {},
        tier: "read_only",
      },
      randomUUID(),
    );

    await expect(
      service.updateAgentPolicy(
        ownerId,
        created.agent.id,
        {
          authenticatedAt: new Date(),
          authenticationAssurance: "owner_session",
          autonomousAcknowledged: false,
          expectedVersion: "1",
          rules: {},
          tier: "assisted",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_POLICY_VERSION_CONFLICT",
      currentPolicyTier: "read_only",
      currentPolicyVersion: "2",
    });
  });

  it("serializes identical and conflicting concurrent policy updates", async () => {
    const ownerId = await createOwner();
    const identicalAgent = await createAgent(ownerId);
    const identical = await Promise.all(
      Array.from({ length: 2 }, () =>
        service.updateAgentPolicy(
          ownerId,
          identicalAgent.agent.id,
          {
            authenticatedAt: new Date(),
            authenticationAssurance: "owner_session",
            autonomousAcknowledged: false,
            expectedVersion: "1",
            rules: {},
            tier: "read_only",
          },
          randomUUID(),
        ),
      ),
    );
    expect(identical.map((result) => result.changed).sort()).toEqual([false, true]);

    const conflictingAgent = await createAgent(ownerId);
    const conflicting = await Promise.allSettled([
      service.updateAgentPolicy(
        ownerId,
        conflictingAgent.agent.id,
        {
          authenticatedAt: new Date(),
          authenticationAssurance: "owner_session",
          autonomousAcknowledged: false,
          expectedVersion: "1",
          rules: {},
          tier: "read_only",
        },
        randomUUID(),
      ),
      service.updateAgentPolicy(
        ownerId,
        conflictingAgent.agent.id,
        {
          authenticatedAt: new Date(),
          authenticationAssurance: "fresh_owner_session",
          autonomousAcknowledged: true,
          expectedVersion: "1",
          rules: {},
          tier: "autonomous",
        },
        randomUUID(),
      ),
    ]);
    expect(conflicting.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = conflicting.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(AgentConnectionError);
    expect(rejected?.reason).toMatchObject({ code: "AGENT_POLICY_VERSION_CONFLICT" });
  });

  it("snapshots immutable credential ceilings and preserves them through rotation", async () => {
    const ownerId = await createOwner();
    const created = await createAgent(ownerId);
    const assisted = await service.createCredential(
      ownerId,
      created.agent.id,
      { name: "Assisted key", scopes: ["research:read", "content:write"] },
      randomUUID(),
    );
    expect(assisted.credential).toMatchObject({
      policyCeiling: "assisted",
      policyCeilingDefaultsVersion: "agent-permission-defaults-v1",
      policyCeilingRules: { operations: {} },
      policyCeilingSchemaVersion: 1,
    });

    const autonomous = await service.updateAgentPolicy(
      ownerId,
      created.agent.id,
      {
        authenticatedAt: new Date(),
        authenticationAssurance: "fresh_owner_session",
        autonomousAcknowledged: true,
        expectedVersion: "1",
        rules: {},
        tier: "autonomous",
      },
      randomUUID(),
    );
    expect(autonomous.credentialImpact).toMatchObject({
      ceilingCounts: { assisted: 1, autonomous: 0, custom: 0, read_only: 0 },
      retainedCredentialCount: 1,
    });

    const autonomousKey = await service.createCredential(
      ownerId,
      created.agent.id,
      { name: "Autonomous key", scopes: ["research:read", "content:write"] },
      randomUUID(),
    );
    expect(autonomousKey.credential.policyCeiling).toBe("autonomous");

    const customRules = {
      operations: {
        browse: "deny" as const,
        content_write: "allow" as const,
        reaction_write: "deny" as const,
      },
    };
    const custom = await service.updateAgentPolicy(
      ownerId,
      created.agent.id,
      {
        authenticatedAt: new Date(),
        authenticationAssurance: "fresh_owner_session",
        autonomousAcknowledged: true,
        expectedVersion: "2",
        rules: customRules,
        tier: "custom",
      },
      randomUUID(),
    );
    expect(custom.credentialImpact).toMatchObject({
      ceilingCounts: { assisted: 1, autonomous: 1, custom: 0, read_only: 0 },
      retainedCredentialCount: 2,
    });

    const customKey = await service.createCredential(
      ownerId,
      created.agent.id,
      {
        name: "Custom key",
        scopes: ["research:read", "content:write", "reaction:write"],
      },
      randomUUID(),
    );
    expect(customKey.credential).toMatchObject({
      policyCeiling: "custom",
      policyCeilingRules: customRules,
    });

    const rotationRequestId = randomUUID();
    const rotated = await service.rotateCredential(
      ownerId,
      customKey.credential.id,
      {},
      rotationRequestId,
    );
    expect(rotated.credential).toMatchObject({
      policyCeiling: "custom",
      policyCeilingDefaultsVersion: customKey.credential.policyCeilingDefaultsVersion,
      policyCeilingRules: customKey.credential.policyCeilingRules,
      policyCeilingSchemaVersion: customKey.credential.policyCeilingSchemaVersion,
      replacesCredentialId: customKey.credential.id,
    });
    const rotationAudit = await postgres.sql<
      { after_state: unknown; before_state: unknown }[]
    >`
      select before_state, after_state
      from platform.action_logs
      where request_id = ${rotationRequestId}
        and action = 'credential.rotate'
    `;
    expect(rotationAudit).toHaveLength(1);
    expect(rotationAudit[0]).toMatchObject({
      before_state: {
        policy_ceiling: "custom",
        policy_ceiling_defaults_version: "agent-permission-defaults-v1",
        policy_ceiling_rules: customRules.operations,
        policy_ceiling_schema_version: 1,
      },
      after_state: {
        policy_ceiling: "custom",
        policy_ceiling_defaults_version: "agent-permission-defaults-v1",
        policy_ceiling_rules: customRules.operations,
        policy_ceiling_schema_version: 1,
      },
    });
    const rotationEvent = await postgres.sql<{ payload: unknown }[]>`
      select payload
      from system.outbox_events
      where aggregate_type = 'credential'
        and aggregate_id = ${customKey.credential.id}
        and event_type = 'credential.rotated.v1'
        and payload ->> 'replacement_credential_id' = ${rotated.credential.id}
    `;
    expect(rotationEvent).toHaveLength(1);
    expect(rotationEvent[0]?.payload).toMatchObject({
      policy_ceiling: "custom",
      policy_ceiling_defaults_version: "agent-permission-defaults-v1",
      policy_ceiling_rules: customRules.operations,
      policy_ceiling_schema_version: 1,
    });

    const authenticatedAssisted = await service.authenticateStaticApiKey(assisted.apiKey);
    expect(authenticatedAssisted).toMatchObject({
      agent: { policy: { tier: "custom", version: "3" } },
      credential: { policyCeiling: "assisted" },
    });
  });

  it("rejects invalid policy heads and credential ceiling mutation at the DB boundary", async () => {
    const ownerId = await createOwner();
    const created = await createAgent(ownerId);

    await expect(
      postgres.sql`
        insert into platform.agent_policies (
          id,
          agent_id,
          tier,
          defaults_version,
          policy_schema_version,
          version,
          rules,
          is_active,
          configured_by_owner_id
        )
        values (
          ${randomUUID()},
          ${created.agent.id},
          'custom',
          'agent-permission-defaults-v1',
          1,
          2,
          ${postgres.sql.json({ reaction_write: "require_approval" })},
          true,
          ${ownerId}
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    const issued = await service.createCredential(
      ownerId,
      created.agent.id,
      { name: "Immutable authority", scopes: ["research:read"] },
      randomUUID(),
    );
    await expect(
      postgres.sql`
        update platform.credentials
        set policy_ceiling_rules = ${postgres.sql.json({ browse: "deny" })}
        where id = ${issued.credential.id}
      `,
    ).rejects.toMatchObject({ code: "22023" });
  });

  it("binds direct Credential inserts to the active policy and predecessor snapshot", async () => {
    const ownerId = await createOwner();
    const created = await createAgent(ownerId);
    const assisted = await service.createCredential(
      ownerId,
      created.agent.id,
      { name: "Assisted source", scopes: ["research:read", "content:write"] },
      randomUUID(),
    );

    const compatibleId = randomUUID();
    const compatiblePrefix = `aln_v1_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const compatibleDigest = randomBytes(32);
    const compatible = await postgres.sql<
      {
        policy_ceiling: string;
        policy_ceiling_rules: unknown;
      }[]
    >`
      insert into platform.credentials (
        id,
        owner_id,
        agent_id,
        name,
        credential_type,
        token_prefix,
        secret_digest,
        pepper_version,
        scopes,
        audience,
        policy_ceiling,
        expires_at
      )
      select
        ${compatibleId},
        credential.owner_id,
        credential.agent_id,
        'Rolling standard key',
        credential.credential_type,
        ${compatiblePrefix},
        ${compatibleDigest},
        credential.pepper_version,
        credential.scopes,
        credential.audience,
        credential.policy_ceiling,
        credential.expires_at
      from platform.credentials as credential
      where credential.id = ${assisted.credential.id}
      returning policy_ceiling, policy_ceiling_rules
    `;
    expect(compatible[0]).toEqual({
      policy_ceiling: "assisted",
      policy_ceiling_rules: {},
    });

    await service.updateAgentPolicy(
      ownerId,
      created.agent.id,
      {
        authenticatedAt: new Date(),
        authenticationAssurance: "fresh_owner_session",
        autonomousAcknowledged: true,
        expectedVersion: "1",
        rules: {
          operations: { content_write: "allow", reaction_write: "deny" },
        },
        tier: "custom",
      },
      randomUUID(),
    );

    const custom = await service.createCredential(
      ownerId,
      created.agent.id,
      { name: "Custom source", scopes: ["research:read", "content:write"] },
      randomUUID(),
    );
    await service.revokeCredential(ownerId, custom.credential.id, randomUUID());

    const legacyRotationPrefix = `aln_v1_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 12)}`;
    const legacyRotationDigest = randomBytes(32);
    await expect(
      postgres.sql`
        insert into platform.credentials (
          id,
          owner_id,
          agent_id,
          name,
          credential_type,
          token_prefix,
          secret_digest,
          pepper_version,
          scopes,
          audience,
          policy_ceiling,
          expires_at,
          replaces_credential_id
        )
        select
          ${randomUUID()},
          credential.owner_id,
          credential.agent_id,
          credential.name,
          credential.credential_type,
          ${legacyRotationPrefix},
          ${legacyRotationDigest},
          credential.pepper_version,
          credential.scopes,
          credential.audience,
          credential.policy_ceiling,
          credential.expires_at,
          credential.id
        from platform.credentials as credential
        where credential.id = ${custom.credential.id}
      `,
    ).rejects.toMatchObject({ code: "23514" });

    const mismatchedIssuancePrefix = `aln_v1_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 12)}`;
    const mismatchedIssuanceDigest = randomBytes(32);
    await expect(
      postgres.sql`
        insert into platform.credentials (
          id,
          owner_id,
          agent_id,
          name,
          credential_type,
          token_prefix,
          secret_digest,
          pepper_version,
          scopes,
          audience,
          policy_ceiling,
          expires_at
        )
        select
          ${randomUUID()},
          credential.owner_id,
          credential.agent_id,
          'Stale Custom issuance',
          credential.credential_type,
          ${mismatchedIssuancePrefix},
          ${mismatchedIssuanceDigest},
          credential.pepper_version,
          credential.scopes,
          credential.audience,
          'custom',
          credential.expires_at
        from platform.credentials as credential
        where credential.id = ${assisted.credential.id}
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("never freezes a stale Credential ceiling behind a concurrent policy update", async () => {
    const ownerId = await createOwner();
    const created = await createAgent(ownerId);
    const source = await service.createCredential(
      ownerId,
      created.agent.id,
      { name: "Race source", scopes: ["research:read", "content:write"] },
      randomUUID(),
    );
    const issuerApplicationName = `policy-race-${randomUUID()}`;
    const issuerUrl = new URL(databaseUrl ?? "postgresql://unused.invalid");
    issuerUrl.searchParams.set("application_name", issuerApplicationName);
    const issuer = createPostgresDependency(issuerUrl.toString());

    let signalPolicyReady: (() => void) | undefined;
    const policyReady = new Promise<void>((resolve) => {
      signalPolicyReady = resolve;
    });
    let releasePolicy: (() => void) | undefined;
    const policyRelease = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    const nextPolicyId = randomUUID();
    const policyTransaction = postgres.sql.begin(async (transaction) => {
      await transaction`
        select id
        from platform.agents
        where id = ${created.agent.id}
        for update
      `;
      await transaction`
        update platform.agent_policies
        set is_active = false
        where agent_id = ${created.agent.id}
          and is_active
      `;
      await transaction`
        insert into platform.agent_policies (
          id,
          agent_id,
          tier,
          defaults_version,
          policy_schema_version,
          version,
          rules,
          is_active,
          configured_by_owner_id
        )
        values (
          ${nextPolicyId},
          ${created.agent.id},
          'read_only',
          'agent-permission-defaults-v1',
          1,
          2,
          '{}'::jsonb,
          true,
          ${ownerId}
        )
      `;
      signalPolicyReady?.();
      await policyRelease;
    });

    await policyReady;
    const staleCredentialId = randomUUID();
    const staleInsertOutcome = issuer.sql`
      insert into platform.credentials (
        id,
        owner_id,
        agent_id,
        name,
        credential_type,
        token_prefix,
        secret_digest,
        pepper_version,
        scopes,
        audience,
        policy_ceiling,
        expires_at
      )
      select
        ${staleCredentialId},
        credential.owner_id,
        credential.agent_id,
        'Concurrent stale issuance',
        credential.credential_type,
        ${`aln_v1_${randomUUID().replaceAll("-", "").slice(0, 12)}`},
        ${randomBytes(32)},
        credential.pepper_version,
        credential.scopes,
        credential.audience,
        credential.policy_ceiling,
        credential.expires_at
      from platform.credentials as credential
      where credential.id = ${source.credential.id}
    `.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    );

    try {
      let observedLockWait = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await postgres.sql<{ wait_event_type: string | null }[]>`
          select wait_event_type
          from pg_catalog.pg_stat_activity
          where application_name = ${issuerApplicationName}
            and state = 'active'
        `;
        if (activity.some((row) => row.wait_event_type === "Lock")) {
          observedLockWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedLockWait).toBe(true);
    } finally {
      releasePolicy?.();
      await policyTransaction;
    }

    try {
      const outcome = await staleInsertOutcome;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.error).toMatchObject({ code: "23514" });
      }
      const retained = await postgres.sql<{ count: number }[]>`
        select count(*)::integer as count
        from platform.credentials
        where id = ${staleCredentialId}
      `;
      expect(retained[0]?.count).toBe(0);
    } finally {
      await issuer.close();
    }
  });
});
