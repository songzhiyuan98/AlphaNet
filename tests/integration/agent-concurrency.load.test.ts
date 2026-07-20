import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type PostgresDependency,
} from "../../packages/database/src/index.js";
import {
  AgentConnectionError,
  PostgresAgentConnectionService,
} from "../../packages/domain/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeConcurrencyLoad = databaseUrl ? describe : describe.skip;
const replicaCount = 3;
const serviceOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: {
    1: "replica-load-test-pepper-is-public-test-data-not-a-production-secret",
  },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

describeConcurrencyLoad("Agent connection replica-equivalent concurrency load", () => {
  const databases: PostgresDependency[] = Array.from({ length: replicaCount }, () =>
    createPostgresDependency(databaseUrl ?? ""),
  );
  const services = databases.map(
    (database) => new PostgresAgentConnectionService(database.sql, serviceOptions),
  );
  const controlDatabase = databases[0]!;

  afterAll(async () => {
    await closeDependencies(databases);
  });

  async function createOwner(): Promise<string> {
    const marker = randomUUID();
    const users = await controlDatabase.sql<{ id: string }[]>`
      insert into auth.users (
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        'Replica Load Owner',
        ${`replica-load-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id
    `;
    const userId = users[0]?.id;
    if (!userId) {
      throw new Error("Replica load Auth User insert did not return an id");
    }
    const owners = await controlDatabase.sql<{ id: string }[]>`
      select id
      from platform.owners
      where auth_user_id = ${userId}
    `;
    const ownerId = owners[0]?.id;
    if (!ownerId) {
      throw new Error("Replica load Owner projection was not provisioned");
    }
    return ownerId;
  }

  function serviceFor(index: number) {
    return services[index % services.length]!;
  }

  it("keeps one identity when replica-equivalent clients race for a handle", async () => {
    const ownerId = await createOwner();
    const handle = `collision-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const outcomes = await Promise.allSettled(
      Array.from({ length: 18 }, async (_value, index) =>
        serviceFor(index).createAgent(
          ownerId,
          { displayName: `Collision ${index}`, handle },
          randomUUID(),
        ),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(
      outcomes
        .filter(
          (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
        )
        .every(
          (outcome) =>
            outcome.reason instanceof AgentConnectionError &&
            outcome.reason.code === "AGENT_HANDLE_TAKEN",
        ),
    ).toBe(true);
    const identities = await controlDatabase.sql<
      { actor_count: number; agent_count: number }[]
    >`
      select
        (
          select count(*)::integer
          from platform.actors
          where handle = ${handle}
        ) as actor_count,
        (
          select count(*)::integer
          from platform.agents as agent
          join platform.actors as actor on actor.id = agent.actor_id
          where actor.handle = ${handle}
        ) as agent_count
    `;
    expect(identities[0]).toEqual({ actor_count: 1, agent_count: 1 });
  });

  it("does not over-activate when replicas compete for one Owner slot", async () => {
    const ownerId = await createOwner();
    await controlDatabase.sql`
      update platform.owners
      set base_active_agent_limit = 1
      where id = ${ownerId}
    `;
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const active = await services[0]!.createAgent(
      ownerId,
      { displayName: "Active slot", handle: `active-${marker}` },
      randomUUID(),
    );
    const firstDraft = await services[1]!.createAgent(
      ownerId,
      { displayName: "First draft", handle: `draft-a-${marker}` },
      randomUUID(),
    );
    const secondDraft = await services[2]!.createAgent(
      ownerId,
      { displayName: "Second draft", handle: `draft-b-${marker}` },
      randomUUID(),
    );
    expect(firstDraft.agent.status).toBe("draft");
    expect(secondDraft.agent.status).toBe("draft");
    await services[0]!.archiveAgent(ownerId, active.agent.id, randomUUID());

    const outcomes = await Promise.allSettled([
      services[1]!.activateAgent(ownerId, firstDraft.agent.id, randomUUID()),
      services[2]!.activateAgent(ownerId, secondDraft.agent.id, randomUUID()),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const activeRows = await controlDatabase.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.agents
      where owner_id = ${ownerId}
        and status = 'active'
    `;
    expect(activeRows[0]?.count).toBe(1);
  });

  it("enforces active Credential limits across independent pools", async () => {
    const ownerId = await createOwner();
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const agent = await services[0]!.createAgent(
      ownerId,
      { displayName: "Issue load", handle: `issue-${marker}` },
      randomUUID(),
    );
    const outcomes = await Promise.allSettled(
      Array.from({ length: 18 }, async (_value, index) =>
        serviceFor(index).createCredential(
          ownerId,
          agent.agent.id,
          {
            name: `Replica credential ${index}`,
            scopes: ["research:read"],
          },
          randomUUID(),
        ),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(5);
    const activeCredentials = await controlDatabase.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.credentials
      where owner_id = ${ownerId}
        and agent_id = ${agent.agent.id}
        and revoked_at is null
        and expires_at > clock_timestamp()
    `;
    expect(activeCredentials[0]?.count).toBe(5);
  });

  it("creates one replacement when replicas rotate the same Credential", async () => {
    const ownerId = await createOwner();
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const agent = await services[0]!.createAgent(
      ownerId,
      { displayName: "Rotation load", handle: `rotate-${marker}` },
      randomUUID(),
    );
    const issued = await services[0]!.createCredential(
      ownerId,
      agent.agent.id,
      { name: "Rotation target", scopes: ["research:read"] },
      randomUUID(),
    );
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, async (_value, index) =>
        serviceFor(index).rotateCredential(
          ownerId,
          issued.credential.id,
          {},
          randomUUID(),
        ),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const state = await controlDatabase.sql<
      { active_count: number; replacement_count: number }[]
    >`
      select
        count(*) filter (
          where revoked_at is null and expires_at > clock_timestamp()
        )::integer as active_count,
        count(*) filter (
          where replaces_credential_id = ${issued.credential.id}
        )::integer as replacement_count
      from platform.credentials
      where owner_id = ${ownerId}
        and agent_id = ${agent.agent.id}
    `;
    expect(state[0]).toEqual({ active_count: 1, replacement_count: 1 });
  });

  it("keeps concurrent emergency revocation idempotent", async () => {
    const ownerId = await createOwner();
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const agent = await services[0]!.createAgent(
      ownerId,
      { displayName: "Revocation load", handle: `revoke-${marker}` },
      randomUUID(),
    );
    const issued = await services[0]!.createCredential(
      ownerId,
      agent.agent.id,
      { name: "Revocation target", scopes: ["research:read"] },
      randomUUID(),
    );
    const outcomes = await Promise.allSettled(
      Array.from({ length: 18 }, async (_value, index) =>
        serviceFor(index).revokeCredential(ownerId, issued.credential.id, randomUUID()),
      ),
    );

    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    const audit = await controlDatabase.sql<
      { action_count: number; outbox_count: number }[]
    >`
      select
        (
          select count(*)::integer
          from platform.action_logs
          where credential_id = ${issued.credential.id}
            and action = 'credential.revoke'
        ) as action_count,
        (
          select count(*)::integer
          from system.outbox_events
          where aggregate_type = 'credential'
            and aggregate_id = ${issued.credential.id}
            and event_type = 'credential.revoked.v1'
        ) as outbox_count
    `;
    expect(audit[0]).toEqual({ action_count: 1, outbox_count: 1 });
  });
});
