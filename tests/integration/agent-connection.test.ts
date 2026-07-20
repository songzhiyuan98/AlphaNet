import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  AgentConnectionError,
  generateStaticApiKey,
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

const describeAgentConnection = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const apiKeyPepperV1 =
  "integration-Agent-Key-pepper-with-more-than-thirty-two-characters";
const baseAgentConnectionOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: { 1: apiKeyPepperV1 },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

describeAgentConnection("Agent connection", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  dependencies.push(postgres);
  const service = new PostgresAgentConnectionService(
    postgres.sql,
    baseAgentConnectionOptions,
  );

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  async function createOwner(verified: boolean): Promise<string> {
    const marker = randomUUID();
    const inserted = await postgres.sql<{ id: string }[]>`
      insert into auth.users (
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        'Agent Connection Owner',
        ${`agent-connection-${marker}@example.test`},
        ${verified},
        clock_timestamp(),
        clock_timestamp()
      )
      returning id
    `;
    const authUserId = inserted[0]?.id;
    if (!authUserId) {
      throw new Error("Auth User insert did not return an id");
    }
    const owners = await postgres.sql<{ id: string }[]>`
      select id
      from platform.owners
      where auth_user_id = ${authUserId}
    `;
    const ownerId = owners[0]?.id;
    if (!ownerId) {
      throw new Error("Owner projection was not provisioned");
    }
    return ownerId;
  }

  it("withdraws readiness when the Agent migration ledger entry is missing", async () => {
    const rows = await postgres.sql<
      {
        applied_at: Date;
        applied_by: string;
        checksum: string;
        name: string;
        version: string;
      }[]
    >`
      delete from system.schema_migrations
      where version = '000005'
      returning version, name, checksum, applied_at, applied_by
    `;
    const migration = rows[0];
    if (!migration) {
      throw new Error("Agent migration ledger entry was not present");
    }

    try {
      await expect(service.checkReady()).rejects.toThrow(
        "Agent connection schema is not ready",
      );
    } finally {
      await postgres.sql`
        insert into system.schema_migrations (
          version,
          name,
          checksum,
          applied_at,
          applied_by
        )
        values (
          ${migration.version},
          ${migration.name},
          ${migration.checksum},
          ${migration.applied_at},
          ${migration.applied_by}
        )
      `;
    }
    await expect(service.checkReady()).resolves.toBeUndefined();
  });

  it("rejects an unverified Owner without creating a partial Agent", async () => {
    const ownerId = await createOwner(false);
    const before = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.agents
      where owner_id = ${ownerId}
    `;

    await expect(
      service.createAgent(
        ownerId,
        {
          handle: `pending-${randomUUID().slice(0, 8)}`,
          displayName: "Pending Agent",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      code: "OWNER_EMAIL_VERIFICATION_REQUIRED",
    });
    const after = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.agents
      where owner_id = ${ownerId}
    `;
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  it("serializes concurrent Agent creation at the rolling 24-hour limit", async () => {
    const ownerId = await createOwner(true);
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, async (_value, index) =>
        service.createAgent(
          ownerId,
          {
            handle: `c${marker}-${index}`,
            displayName: `Concurrent Agent ${index}`,
          },
          randomUUID(),
        ),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(3);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejected).toHaveLength(17);
    expect(
      rejected.every(
        (outcome) =>
          outcome.reason instanceof AgentConnectionError &&
          outcome.reason.code === "AGENT_CREATE_RATE_LIMITED",
      ),
    ).toBe(true);

    const state = await postgres.sql<
      {
        actors: number;
        active_agents: number;
        agents: number;
        active_policies: number;
      }[]
    >`
      select
        (
          select count(*)::integer
          from platform.agents
          where owner_id = ${ownerId}
        ) as agents,
        (
          select count(*)::integer
          from platform.agents
          where owner_id = ${ownerId}
            and status = 'active'
        ) as active_agents,
        (
          select count(*)::integer
          from platform.actors
          where owner_id = ${ownerId}
            and kind = 'agent'
        ) as actors,
        (
          select count(*)::integer
          from platform.agent_policies as policy
          join platform.agents as agent on agent.id = policy.agent_id
          where agent.owner_id = ${ownerId}
            and policy.is_active
        ) as active_policies
    `;
    expect(state[0]).toEqual({
      actors: 3,
      active_agents: 3,
      agents: 3,
      active_policies: 3,
    });
  });

  it("issues a show-once key, authenticates it, and invalidates rotations immediately", async () => {
    const ownerId = await createOwner(true);
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const created = await service.createAgent(
      ownerId,
      {
        handle: `key-${marker}`,
        displayName: "Credential Agent",
        bio: "A public research identity.",
        discoveryTags: ["semiconductors", "risk"],
      },
      randomUUID(),
    );
    expect(created.agent.status).toBe("active");
    expect(created.agent.policy.tier).toBe("assisted");

    const issued = await service.createCredential(
      ownerId,
      created.agent.id,
      {
        name: "Local research workflow",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    expect(issued.apiKey).toMatch(/^aln_v1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/);
    const authenticated = await Promise.all(
      Array.from({ length: 20 }, () => service.authenticateStaticApiKey(issued.apiKey)),
    );
    expect(
      authenticated.every(
        (context) =>
          context.agent.id === created.agent.id &&
          context.credential.id === issued.credential.id &&
          context.owner.id === ownerId,
      ),
    ).toBe(true);

    const stored = await postgres.sql<
      {
        action_log_contains_key: boolean;
        audit_value_rejected: boolean;
        credential_contains_key: boolean;
        credential_last_used: boolean;
        outbox_contains_key: boolean;
      }[]
    >`
      select
        exists (
          select 1
          from platform.action_logs
          where owner_id = ${ownerId}
            and row_to_json(action_logs)::text like ${`%${issued.apiKey}%`}
        ) as action_log_contains_key,
        exists (
          select 1
          from platform.credentials
          where owner_id = ${ownerId}
            and row_to_json(credentials)::text like ${`%${issued.apiKey}%`}
        ) as credential_contains_key,
        exists (
          select 1
          from platform.credentials
          where id = ${issued.credential.id}
            and last_used_at is not null
        ) as credential_last_used,
        exists (
          select 1
          from system.outbox_events
          where payload->>'owner_id' = ${ownerId}
            and row_to_json(outbox_events)::text like ${`%${issued.apiKey}%`}
        ) as outbox_contains_key,
        not platform.audit_json_is_secret_free_v2(
          jsonb_build_object('note', ${issued.apiKey}::text)
        ) as audit_value_rejected
    `;
    expect(stored[0]).toEqual({
      action_log_contains_key: false,
      audit_value_rejected: true,
      credential_contains_key: false,
      credential_last_used: true,
      outbox_contains_key: false,
    });

    const rotated = await service.rotateCredential(
      ownerId,
      issued.credential.id,
      {},
      randomUUID(),
    );
    expect(rotated.credential.replacesCredentialId).toBe(issued.credential.id);
    await expect(service.authenticateStaticApiKey(issued.apiKey)).rejects.toMatchObject({
      code: "INVALID_CREDENTIAL",
    });
    await expect(service.authenticateStaticApiKey(rotated.apiKey)).resolves.toMatchObject(
      {
        credential: { id: rotated.credential.id },
      },
    );

    const revoked = await service.revokeCredential(
      ownerId,
      rotated.credential.id,
      randomUUID(),
    );
    expect(revoked.status).toBe("revoked");
    await expect(service.authenticateStaticApiKey(rotated.apiKey)).rejects.toMatchObject({
      code: "INVALID_CREDENTIAL",
    });
    const listed = await service.listCredentials(ownerId, created.agent.id);
    expect(listed).toHaveLength(2);
    expect(listed.every((credential) => credential.status === "revoked")).toBe(true);

    const publicProfile = await service.getPublicAgentByHandle(created.agent.handle);
    expect(publicProfile).toMatchObject({
      id: created.agent.id,
      bio: "A public research identity.",
    });

    const actionLogs = await postgres.sql<
      {
        authority_snapshot_complete: boolean;
        count: number;
        owner_direct_actor_correct: boolean;
      }[]
    >`
      select
        count(*)::integer as count,
        bool_and(
          actor_id is null
          and actor_kind is null
          and approved_by_owner_id = owner_id
        ) as owner_direct_actor_correct,
        bool_and(
          case
            when action in ('credential.create', 'credential.rotate')
            then after_state ?& ARRAY[
              'audience',
              'credential_id',
              'expires_at',
              'policy_ceiling',
              'scopes'
            ]
            else true
          end
        ) as authority_snapshot_complete
      from platform.action_logs
      where owner_id = ${ownerId}
        and action in (
          'agent.create',
          'credential.create',
          'credential.rotate',
          'credential.revoke'
        )
    `;
    expect(actionLogs[0]).toEqual({
      authority_snapshot_complete: true,
      count: 4,
      owner_direct_actor_correct: true,
    });
  });

  it("keeps previous-version keys valid only while their pepper remains in the key ring", async () => {
    const ownerId = await createOwner(true);
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const created = await service.createAgent(
      ownerId,
      {
        handle: `pepper-${marker}`,
        displayName: "Pepper Rotation Agent",
      },
      randomUUID(),
    );
    const versionOne = await service.createCredential(
      ownerId,
      created.agent.id,
      {
        name: "Version one",
        scopes: ["research:read"],
      },
      randomUUID(),
    );
    const apiKeyPepperV2 = "integration-Agent-Key-pepper-version-two-Q7m3X9p5V2k8";
    const rotatingService = new PostgresAgentConnectionService(postgres.sql, {
      ...baseAgentConnectionOptions,
      apiKeyCurrentPepperVersion: 2,
      apiKeyPeppers: {
        1: apiKeyPepperV1,
        2: apiKeyPepperV2,
      },
    });
    await expect(
      rotatingService.authenticateStaticApiKey(versionOne.apiKey),
    ).resolves.toMatchObject({
      credential: { id: versionOne.credential.id },
    });

    const versionTwo = await rotatingService.createCredential(
      ownerId,
      created.agent.id,
      {
        name: "Version two",
        scopes: ["research:read"],
      },
      randomUUID(),
    );
    const storedVersions = await postgres.sql<{ id: string; pepper_version: number }[]>`
      select id, pepper_version
      from platform.credentials
      where id in (${versionOne.credential.id}, ${versionTwo.credential.id})
      order by pepper_version
    `;
    expect(storedVersions).toEqual([
      { id: versionOne.credential.id, pepper_version: 1 },
      { id: versionTwo.credential.id, pepper_version: 2 },
    ]);

    const versionTwoOnlyService = new PostgresAgentConnectionService(postgres.sql, {
      ...baseAgentConnectionOptions,
      apiKeyCurrentPepperVersion: 2,
      apiKeyPeppers: { 2: apiKeyPepperV2 },
    });
    await expect(
      versionTwoOnlyService.authenticateStaticApiKey(versionOne.apiKey),
    ).rejects.toMatchObject({
      code: "INVALID_CREDENTIAL",
    });
    await expect(
      versionTwoOnlyService.authenticateStaticApiKey(versionTwo.apiKey),
    ).resolves.toMatchObject({
      credential: { id: versionTwo.credential.id },
    });
  });

  it("orders concurrent authentication and revocation without deadlocks", async () => {
    const ownerId = await createOwner(true);
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const created = await service.createAgent(
      ownerId,
      {
        handle: `revoke-race-${marker}`,
        displayName: "Revocation Race Agent",
      },
      randomUUID(),
    );
    const issued = await service.createCredential(
      ownerId,
      created.agent.id,
      {
        name: "Revocation race key",
        scopes: ["research:read"],
      },
      randomUUID(),
    );

    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 40 }, () =>
        service.authenticateStaticApiKey(issued.apiKey),
      ),
      service.revokeCredential(ownerId, issued.credential.id, randomUUID()),
    ]);
    const revocation = outcomes.at(-1);
    const authenticationOutcomes = outcomes.slice(0, -1);

    expect(revocation?.status).toBe("fulfilled");
    expect(
      authenticationOutcomes.every(
        (outcome) =>
          outcome.status === "fulfilled" ||
          (outcome.reason instanceof AgentConnectionError &&
            outcome.reason.code === "INVALID_CREDENTIAL"),
      ),
    ).toBe(true);
    await expect(service.authenticateStaticApiKey(issued.apiKey)).rejects.toMatchObject({
      code: "INVALID_CREDENTIAL",
    });
  });

  it("returns one authentication result for malformed, forged, expired, inactive, and deleted-owner keys", async () => {
    const ownerId = await createOwner(true);
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const created = await service.createAgent(
      ownerId,
      {
        handle: `authn-${marker}`,
        displayName: "Authentication Boundary Agent",
      },
      randomUUID(),
    );
    const issued = await service.createCredential(
      ownerId,
      created.agent.id,
      {
        name: "Authentication boundary",
        scopes: ["research:read"],
      },
      randomUUID(),
    );
    const forged = issued.apiKey.slice(0, -1) + (issued.apiKey.endsWith("A") ? "B" : "A");
    const expired = generateStaticApiKey(apiKeyPepperV1);
    const expiredCredentialId = randomUUID();
    const expiredIssuedAt = new Date(Date.now() - 7_200_000);
    const expiredAt = new Date(Date.now() - 3_600_000);
    await postgres.sql`
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
        issued_at,
        expires_at,
        created_at
      )
      values (
        ${expiredCredentialId},
        ${ownerId},
        ${created.agent.id},
        'Expired authentication boundary',
        'static_api_key',
        ${expired.prefix},
        ${expired.digest},
        1,
        ${["research:read"]},
        'urn:alphanet:api:v1',
        'assisted',
        ${expiredIssuedAt},
        ${expiredAt},
        ${expiredIssuedAt}
      )
    `;

    for (const token of ["malformed", forged, expired.token]) {
      await expect(service.authenticateStaticApiKey(token)).rejects.toMatchObject({
        code: "INVALID_CREDENTIAL",
        message: "The Agent credential is invalid.",
      });
    }

    await postgres.sql.begin(async (transaction) => {
      await transaction`
        update platform.agents
        set status = 'suspended',
            restriction_reason_code = 'test_suspension',
            suspended_at = clock_timestamp(),
            updated_at = clock_timestamp()
        where id = ${created.agent.id}
      `;
      await transaction`
        update platform.actors
        set status = 'suspended',
            updated_at = clock_timestamp()
        where id = ${created.agent.actorId}
      `;
    });
    await expect(service.authenticateStaticApiKey(issued.apiKey)).rejects.toMatchObject({
      code: "INVALID_CREDENTIAL",
      message: "The Agent credential is invalid.",
    });

    const deletedOwnerId = await createOwner(true);
    const deletedMarker = randomUUID().replaceAll("-", "").slice(0, 10);
    const deletedAgent = await service.createAgent(
      deletedOwnerId,
      {
        handle: `deleted-${deletedMarker}`,
        displayName: "Deleted Owner Agent",
      },
      randomUUID(),
    );
    const deletedOwnerKey = await service.createCredential(
      deletedOwnerId,
      deletedAgent.agent.id,
      {
        name: "Deleted Owner key",
        scopes: ["research:read"],
      },
      randomUUID(),
    );
    await postgres.sql`
      update platform.owners
      set status = 'closed',
          deleted_at = clock_timestamp(),
          updated_at = clock_timestamp()
      where id = ${deletedOwnerId}
    `;
    await expect(
      service.authenticateStaticApiKey(deletedOwnerKey.apiKey),
    ).rejects.toMatchObject({
      code: "INVALID_CREDENTIAL",
      message: "The Agent credential is invalid.",
    });
    await expect(
      service.getPublicAgentByHandle(deletedAgent.agent.handle),
    ).resolves.toBeNull();
  });

  it("always permits emergency revocation and applies its cooldown to the next issue", async () => {
    const cooldownService = new PostgresAgentConnectionService(postgres.sql, {
      ...baseAgentConnectionOptions,
      credentialMutationCooldownSeconds: 30,
    });
    const ownerId = await createOwner(true);
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const created = await cooldownService.createAgent(
      ownerId,
      {
        handle: `cooldown-${marker}`,
        displayName: "Cooldown Agent",
      },
      randomUUID(),
    );
    const issued = await cooldownService.createCredential(
      ownerId,
      created.agent.id,
      {
        name: "Cooldown key",
        scopes: ["research:read"],
      },
      randomUUID(),
    );

    await expect(
      cooldownService.revokeCredential(ownerId, issued.credential.id, randomUUID()),
    ).resolves.toMatchObject({
      id: issued.credential.id,
      status: "revoked",
    });

    await expect(
      cooldownService.createCredential(
        ownerId,
        created.agent.id,
        {
          name: "Too soon after revoke",
          scopes: ["research:read"],
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      code: "CREDENTIAL_MUTATION_COOLDOWN",
    });
  });

  it("enforces active credential quota under concurrent issuance", async () => {
    const ownerId = await createOwner(true);
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const created = await service.createAgent(
      ownerId,
      {
        handle: `quota-${marker}`,
        displayName: "Credential Quota Agent",
      },
      randomUUID(),
    );

    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, async (_value, index) =>
        service.createCredential(
          ownerId,
          created.agent.id,
          {
            name: `Concurrent key ${index}`,
            scopes: ["research:read"],
          },
          randomUUID(),
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(5);
    const credentials = await service.listCredentials(ownerId, created.agent.id);
    expect(
      credentials.filter((credential) => credential.status === "active"),
    ).toHaveLength(5);
  });

  it("keeps over-quota Agents private drafts and activates them after capacity is released", async () => {
    const ownerId = await createOwner(true);
    await postgres.sql`
      update platform.owners
      set base_active_agent_limit = 1
      where id = ${ownerId}
    `;
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const first = await service.createAgent(
      ownerId,
      {
        handle: `slot-a-${marker}`,
        displayName: "Active Slot Agent",
      },
      randomUUID(),
    );
    const second = await service.createAgent(
      ownerId,
      {
        handle: `slot-b-${marker}`,
        displayName: "Deferred Slot Agent",
      },
      randomUUID(),
    );
    expect(first.agent.status).toBe("active");
    expect(second).toMatchObject({
      activationReason: "OWNER_ACTIVE_AGENT_QUOTA_EXCEEDED",
      agent: { status: "draft" },
    });
    const deferredAudit = await postgres.sql<
      { action_count: number; outbox_count: number }[]
    >`
      select
        (
          select count(*)::integer
          from platform.action_logs
          where owner_id = ${ownerId}
            and agent_id = ${second.agent.id}
            and action = 'agent.activation_deferred'
            and reason_code = 'owner_active_agent_quota_exceeded'
            and after_state->>'status' = 'draft'
        ) as action_count,
        (
          select count(*)::integer
          from system.outbox_events
          where aggregate_type = 'agent'
            and aggregate_id = ${second.agent.id}
            and event_type = 'agent.activation_deferred.v1'
            and payload->>'reason_code' =
              'owner_active_agent_quota_exceeded'
        ) as outbox_count
    `;
    expect(deferredAudit[0]).toEqual({
      action_count: 1,
      outbox_count: 1,
    });
    await expect(
      service.createCredential(
        ownerId,
        second.agent.id,
        { name: "Draft key", scopes: ["research:read"] },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_STATE_CONFLICT",
    });
    await expect(service.getPublicAgentByHandle(second.agent.handle)).resolves.toBeNull();

    const firstKey = await service.createCredential(
      ownerId,
      first.agent.id,
      { name: "Active key", scopes: ["research:read"] },
      randomUUID(),
    );
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        update platform.agents
        set status = 'restricted',
            restriction_reason_code = 'test_restriction',
            restricted_at = clock_timestamp(),
            updated_at = clock_timestamp()
        where id = ${first.agent.id}
      `;
      await transaction`
        update platform.actors
        set status = 'restricted',
            updated_at = clock_timestamp()
        where id = ${first.agent.actorId}
      `;
    });
    await expect(service.listOwnerAgents(ownerId)).resolves.toMatchObject({
      quota: { active: 1 },
    });
    await service.archiveAgent(ownerId, first.agent.id, randomUUID());
    await expect(service.authenticateStaticApiKey(firstKey.apiKey)).rejects.toMatchObject(
      {
        code: "INVALID_CREDENTIAL",
      },
    );
    const archiveRevocation = await postgres.sql<
      { action_count: number; outbox_count: number }[]
    >`
      select
        (
          select count(*)::integer
          from platform.action_logs
          where credential_id = ${firstKey.credential.id}
            and action = 'credential.revoke'
            and after_state->>'reason' = 'agent_archived'
        ) as action_count,
        (
          select count(*)::integer
          from system.outbox_events
          where aggregate_type = 'credential'
            and aggregate_id = ${firstKey.credential.id}
            and event_type = 'credential.revoked.v1'
            and payload->>'reason' = 'agent_archived'
        ) as outbox_count
    `;
    expect(archiveRevocation[0]).toEqual({
      action_count: 1,
      outbox_count: 1,
    });
    const activated = await service.activateAgent(ownerId, second.agent.id, randomUUID());
    expect(activated.agent.status).toBe("active");
    await expect(
      service.getPublicAgentByHandle(second.agent.handle),
    ).resolves.toMatchObject({
      id: second.agent.id,
    });

    const capacity = await postgres.sql<{ actual: number; reserved: string }[]>`
      select
        controls.active_agent_count::text as reserved,
        (
          select count(*)::integer
          from platform.agents
          where activated_at is not null
            and status <> 'archived'
        ) as actual
      from platform.registration_controls as controls
      where controls.id = true
    `;
    expect(Number(capacity[0]?.reserved)).toBe(capacity[0]?.actual);
  });

  it("keeps cross-Owner Agent and credential identifiers private", async () => {
    const [ownerA, ownerB] = await Promise.all([createOwner(true), createOwner(true)]);
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const agent = await service.createAgent(
      ownerA,
      {
        handle: `idor-${marker}`,
        displayName: "Owner A Agent",
      },
      randomUUID(),
    );
    const credential = await service.createCredential(
      ownerA,
      agent.agent.id,
      {
        name: "Owner A key",
        scopes: ["research:read"],
      },
      randomUUID(),
    );

    await expect(service.listCredentials(ownerB, agent.agent.id)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(
      service.revokeCredential(ownerB, credential.credential.id, randomUUID()),
    ).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
  });
});
