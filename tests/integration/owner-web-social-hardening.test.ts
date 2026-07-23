import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
  type PostgresClient,
} from "../../packages/database/src/index.js";
import { PostgresAgentConnectionService } from "../../packages/domain/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeHardening = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
type TransactionSql = Parameters<Parameters<PostgresClient["begin"]>[1]>[0];

interface AgentPrincipal {
  actorId: string;
  agentId: string;
  credentialId: string;
  ownerId: string;
  policyVersion: string;
}

const agentConnectionOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: {
    1: "owner-web-hardening-pepper-with-more-than-thirty-two-characters",
  },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

function requireId(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} was not created`);
  return value;
}

function quoteRole(role: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(role)) {
    throw new Error("Unsafe PostgreSQL role fixture name");
  }
  return `"${role}"`;
}

function publishedPayload(contentId: string, actorId: string = randomUUID()) {
  return {
    actor_id: actorId,
    community_ids: [randomUUID()],
    content_id: contentId,
    kind: "post",
    parent_content_id: null,
    revision_id: randomUUID(),
    root_content_id: contentId,
    symbol_ids: [] as string[],
    topic_ids: [] as string[],
  };
}

describeHardening("Owner Web social forward hardening", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const agentService = new PostgresAgentConnectionService(
    postgres.sql,
    agentConnectionOptions,
  );
  dependencies.push(postgres);

  let runtimeRole = "";
  let ownerId = "";
  let humanActorId = "";
  let agentActorId = "";
  let agentId = "";
  let credentialId = "";
  let policyId = "";
  let policyVersion = "";

  function agentPrincipal(): AgentPrincipal {
    return { actorId: agentActorId, agentId, credentialId, ownerId, policyVersion };
  }

  async function createOwnerWithHuman(label: string): Promise<{
    actorId: string;
    ownerId: string;
  }> {
    const userId = randomUUID();
    const actorId = randomUUID();
    await postgres.sql`
      insert into auth.users (
        id,
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        ${userId},
        ${`Owner Hardening ${label}`},
        ${`owner-hardening-${label}-${userId.slice(0, 8)}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
    `;
    const owners = await postgres.sql<{ id: string }[]>`
      select id from platform.owners where auth_user_id = ${userId}
    `;
    const createdOwnerId = requireId(owners[0]?.id, `${label} Owner`);
    await postgres.sql`
      insert into platform.actors (
        id,
        kind,
        owner_id,
        handle,
        display_name,
        status
      )
      values (
        ${actorId},
        'human',
        ${createdOwnerId},
        ${`owner-hard-${actorId.replaceAll("-", "").slice(0, 18)}`},
        ${`Owner Hardening ${label}`},
        'active'
      )
    `;
    return { actorId, ownerId: createdOwnerId };
  }

  async function setRuntimeRole(transaction: TransactionSql): Promise<void> {
    await transaction.unsafe(`set local role ${quoteRole(runtimeRole)}`);
  }

  async function insertDeniedAgentAction(
    transaction: TransactionSql,
    principal: AgentPrincipal,
    input: {
      approvalMethod?: "owner_direct" | "policy_auto" | null;
      assurance?: string | null;
      credentialId?: string | null;
    } = {},
  ): Promise<void> {
    const approvalMethod =
      input.approvalMethod === undefined ? "policy_auto" : input.approvalMethod;
    const credential =
      input.credentialId === undefined
        ? approvalMethod === "owner_direct"
          ? null
          : principal.credentialId
        : input.credentialId;
    const assurance =
      input.assurance === undefined
        ? approvalMethod === "owner_direct"
          ? "owner_session"
          : "agent_credential"
        : input.assurance;
    await transaction`
      insert into platform.action_logs (
        event_class,
        actor_id,
        actor_kind,
        owner_id,
        agent_id,
        credential_id,
        channel,
        approval_method,
        approved_by_owner_id,
        authentication_assurance,
        authorization_snapshot,
        action,
        target_type,
        target_id,
        decision,
        outcome,
        error_code,
        policy_version,
        request_id,
        reason_code
      )
      values (
        'domain_write',
        ${principal.actorId},
        'agent',
        ${principal.ownerId},
        ${principal.agentId},
        ${credential},
        ${approvalMethod === "owner_direct" ? "web" : "rest"},
        ${approvalMethod},
        ${approvalMethod === "owner_direct" ? principal.ownerId : null},
        ${assurance},
        '{"decision":"deny"}'::jsonb,
        'content.create_post',
        'community',
        ${randomUUID()},
        'deny',
        'denied',
        'POLICY_DENIED',
        ${principal.policyVersion},
        ${`hardening-${randomUUID()}`},
        'policy_denied'
      )
    `;
  }

  async function insertDeniedHumanAction(
    transaction: TransactionSql,
    assurance: string,
  ): Promise<void> {
    await transaction`
      insert into platform.action_logs (
        event_class,
        actor_id,
        actor_kind,
        owner_id,
        channel,
        approval_method,
        approved_by_owner_id,
        authentication_assurance,
        authorization_snapshot,
        action,
        target_type,
        target_id,
        decision,
        outcome,
        error_code,
        request_id,
        reason_code
      )
      values (
        'domain_write',
        ${humanActorId},
        'human',
        ${ownerId},
        'web',
        'human_direct',
        ${ownerId},
        ${assurance},
        '{"decision":"deny"}'::jsonb,
        'content.create_post',
        'community',
        ${randomUUID()},
        'deny',
        'denied',
        'POLICY_DENIED',
        ${`hardening-${randomUUID()}`},
        'policy_denied'
      )
    `;
  }

  beforeAll(async () => {
    const marker = randomUUID().replaceAll("-", "").slice(0, 8);
    const owner = await createOwnerWithHuman(marker);
    ownerId = owner.ownerId;
    humanActorId = owner.actorId;

    const created = await agentService.createAgent(
      ownerId,
      {
        displayName: "Owner Web Hardening Agent",
        handle: `owner-web-hardening-${marker}`,
      },
      randomUUID(),
    );
    agentId = created.agent.id;
    agentActorId = created.agent.actorId;
    policyId = created.agent.policy.id;
    policyVersion = created.agent.policy.version;

    const credential = await agentService.createCredential(
      ownerId,
      agentId,
      {
        name: "Owner Web hardening credential",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    credentialId = credential.credential.id;

    runtimeRole = `alphanet_owner_hard_rt_${marker}`;
    const currentRoles = await postgres.sql<{ current_user: string }[]>`
      select current_user
    `;
    const testOwnerRole = requireId(currentRoles[0]?.current_user, "test role");
    await postgres.sql.unsafe(`
      create role ${quoteRole(runtimeRole)}
        nologin noinherit nosuperuser nocreatedb nocreaterole
        noreplication nobypassrls
    `);
    await postgres.sql.unsafe(
      `grant ${quoteRole(runtimeRole)} to ${quoteRole(testOwnerRole)}`,
    );
    await postgres.sql.unsafe(
      `grant usage on schema platform, system to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant select on all tables in schema platform, system to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(`
      grant insert on table
        platform.action_logs,
        system.outbox_aggregate_heads,
        system.outbox_events
      to ${quoteRole(runtimeRole)}
    `);
    await postgres.sql.unsafe(`
      grant update on table system.outbox_aggregate_heads
      to ${quoteRole(runtimeRole)}
    `);
    await postgres.sql.unsafe(`
      grant execute on function
        platform.audit_json_is_secret_free_v2(jsonb),
        system.content_v1_outbox_payload_is_valid(text, text, text, integer, jsonb)
      to ${quoteRole(runtimeRole)}
    `);
  });

  afterAll(async () => {
    if (runtimeRole) {
      const currentRoles = await postgres.sql<{ current_user: string }[]>`
        select current_user
      `;
      const testOwnerRole = requireId(currentRoles[0]?.current_user, "test role");
      await postgres.sql.unsafe(`drop owned by ${quoteRole(runtimeRole)}`);
      await postgres.sql.unsafe(
        `revoke ${quoteRole(runtimeRole)} from ${quoteRole(testOwnerRole)}`,
      );
      await postgres.sql.unsafe(`drop role ${quoteRole(runtimeRole)}`);
    }
    await closeDependencies(dependencies);
  });

  it("pins 000022 and its validated guards", async () => {
    const migration = await readFile(
      `${process.cwd()}/db/migrations/000022_owner_web_social_hardening_v1.up.sql`,
    );
    const checksum = createHash("sha256").update(migration).digest("hex");
    const rows = await postgres.sql<
      Array<{
        assurance_validated: boolean;
        checksum: string;
        outbox_payload_validated: boolean;
        outbox_trigger_deferred: boolean;
        outbox_trigger_installed: boolean;
        subject_security_definer: boolean;
      }>
    >`
      select
        migration.checksum,
        not assurance.convalidated is false as assurance_validated,
        not payload.convalidated is false as outbox_payload_validated,
        subject.prosecdef as subject_security_definer,
        outbox_trigger.oid is not null as outbox_trigger_installed,
        outbox_trigger.tgdeferrable and outbox_trigger.tginitdeferred
          as outbox_trigger_deferred
      from system.schema_migrations as migration
      join pg_catalog.pg_constraint as assurance
        on assurance.conrelid = 'platform.action_logs'::regclass
       and assurance.conname =
         'action_logs_authentication_assurance_semantics_v1'
      join pg_catalog.pg_constraint as payload
        on payload.conrelid = 'system.outbox_events'::regclass
       and payload.conname = 'outbox_events_content_v1_payload_shape'
      join pg_catalog.pg_proc as subject
        on subject.oid = 'platform.validate_domain_write_subject()'::regprocedure
      left join pg_catalog.pg_trigger as outbox_trigger
        on outbox_trigger.tgrelid = 'system.outbox_events'::regclass
       and outbox_trigger.tgname =
         'outbox_events_validate_runtime_content_provenance'
       and outbox_trigger.tgfoid =
         'platform.validate_runtime_content_outbox_provenance()'::regprocedure
      where migration.version = '000022'
    `;
    expect(rows).toEqual([
      {
        assurance_validated: true,
        checksum,
        outbox_payload_validated: true,
        outbox_trigger_deferred: true,
        outbox_trigger_installed: true,
        subject_security_definer: true,
      },
    ]);
  });

  it("enforces the exact assurance vocabulary", async () => {
    const principal = agentPrincipal();
    for (const invalid of [null, "owner_session", "fresh_owner_session", "random"]) {
      await expect(
        postgres.sql.begin(async (transaction) => {
          await setRuntimeRole(transaction);
          await insertDeniedAgentAction(transaction, principal, {
            assurance: invalid,
          });
        }),
      ).rejects.toMatchObject({ code: "23514" });
    }

    for (const invalid of [null, "owner_session", "fresh_owner_session", "random"]) {
      await expect(
        postgres.sql.begin(async (transaction) => {
          await setRuntimeRole(transaction);
          await insertDeniedAgentAction(transaction, principal, {
            approvalMethod: null,
            assurance: invalid,
          });
        }),
      ).rejects.toMatchObject({ code: "23514" });
    }

    await expect(
      postgres.sql.begin(async (transaction) => {
        await setRuntimeRole(transaction);
        await insertDeniedAgentAction(transaction, principal);
        await insertDeniedAgentAction(transaction, principal, {
          approvalMethod: null,
          assurance: "agent_credential",
        });
        await insertDeniedAgentAction(transaction, principal, {
          approvalMethod: "owner_direct",
          assurance: "fresh_owner_session",
          credentialId: null,
        });
        await insertDeniedHumanAction(transaction, "owner_session");
      }),
    ).resolves.toBeUndefined();

    for (const invalid of ["agent_credential", "owner_approval_record", "random"]) {
      await expect(
        postgres.sql.begin(async (transaction) => {
          await setRuntimeRole(transaction);
          await insertDeniedAgentAction(transaction, principal, {
            approvalMethod: "owner_direct",
            assurance: invalid,
            credentialId: null,
          });
        }),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        postgres.sql.begin(async (transaction) => {
          await setRuntimeRole(transaction);
          await insertDeniedHumanAction(transaction, invalid);
        }),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("rejects stale Owner, Agent, Actor, Policy, and Credential state", async () => {
    const principal = agentPrincipal();
    const mutations: Array<(transaction: TransactionSql) => Promise<unknown>> = [
      (transaction) => transaction`
        update platform.owners set status = 'closed' where id = ${ownerId}
      `,
      (transaction) => transaction`
        update platform.agents
        set status = 'restricted',
            restriction_reason_code = 'hardening_test',
            restricted_at = clock_timestamp()
        where id = ${agentId}
      `,
      (transaction) => transaction`
        update platform.actors set status = 'restricted' where id = ${agentActorId}
      `,
      (transaction) => transaction`
        update platform.agent_policies set is_active = false where id = ${policyId}
      `,
      (transaction) => transaction`
        update platform.credentials
        set revoked_at = clock_timestamp()
        where id = ${credentialId}
      `,
    ];

    for (const mutate of mutations) {
      await expect(
        postgres.sql.begin(async (transaction) => {
          await mutate(transaction);
          await setRuntimeRole(transaction);
          await insertDeniedAgentAction(transaction, principal);
        }),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("holds the complete Agent authority chain through transaction end", async () => {
    await postgres.sql.begin(async (transaction) => {
      await setRuntimeRole(transaction);
      await insertDeniedAgentAction(transaction, agentPrincipal());

      const lockAttempts: Array<() => Promise<unknown>> = [
        () =>
          postgres.sql.begin(async (competitor) => {
            await competitor.unsafe("set local lock_timeout = '200ms'");
            await competitor`select 1 from platform.owners where id = ${ownerId} for update`;
          }),
        () =>
          postgres.sql.begin(async (competitor) => {
            await competitor.unsafe("set local lock_timeout = '200ms'");
            await competitor`select 1 from platform.agents where id = ${agentId} for update`;
          }),
        () =>
          postgres.sql.begin(async (competitor) => {
            await competitor.unsafe("set local lock_timeout = '200ms'");
            await competitor`select 1 from platform.actors where id = ${agentActorId} for update`;
          }),
        () =>
          postgres.sql.begin(async (competitor) => {
            await competitor.unsafe("set local lock_timeout = '200ms'");
            await competitor`
            select 1 from platform.agent_policies where id = ${policyId} for update
          `;
          }),
        () =>
          postgres.sql.begin(async (competitor) => {
            await competitor.unsafe("set local lock_timeout = '200ms'");
            await competitor`
            select 1 from platform.credentials where id = ${credentialId} for update
          `;
          }),
      ];

      for (const attempt of lockAttempts) {
        await expect(attempt()).rejects.toMatchObject({ code: "55P03" });
      }
    });
  });

  it("accepts only the production content-v1 payload closure", async () => {
    const contentId = randomUUID();
    const valid = publishedPayload(contentId, agentActorId);
    const missingRevision = Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== "revision_id"),
    );
    const revisedPayload = {
      actor_id: agentActorId,
      affected_symbol_ids: Array.from({ length: 30 }, () => randomUUID()).sort(),
      affected_topic_ids: Array.from({ length: 15 }, () => randomUUID()).sort(),
      changed_groups: ["symbols"],
      community_ids: valid.community_ids,
      content_id: contentId,
      resource_version: 2,
      revision_id: randomUUID(),
      root_content_id: contentId,
      symbol_ids: Array.from({ length: 20 }, () => randomUUID()).sort(),
      topic_ids: Array.from({ length: 10 }, () => randomUUID()).sort(),
    };
    const rows = await postgres.sql<Array<{ valid: boolean }>>`
      select system.content_v1_outbox_payload_is_valid(
        'content',
        ${contentId},
        'content.published',
        1,
        ${postgres.sql.json(valid)}
      ) as valid
      union all
      select system.content_v1_outbox_payload_is_valid(
        'content',
        ${contentId},
        'content.published',
        1,
        ${postgres.sql.json({ ...valid, extra: true })}
      )
      union all
      select system.content_v1_outbox_payload_is_valid(
        'content',
        ${contentId},
        'content.published',
        1,
        ${postgres.sql.json({ ...valid, access_token: "redacted" })}
      )
      union all
      select system.content_v1_outbox_payload_is_valid(
        'content',
        ${contentId},
        'content.published',
        1,
        ${postgres.sql.json({ ...valid, community_ids: [] })}
      )
      union all
      select system.content_v1_outbox_payload_is_valid(
        'content',
        ${contentId},
        'content.published',
        1,
        ${postgres.sql.json(missingRevision)}
      )
      union all
      select system.content_v1_outbox_payload_is_valid(
        'content',
        ${contentId},
        'content.revised',
        1,
        ${postgres.sql.json(revisedPayload)}
      )
      union all
      select system.content_v1_outbox_payload_is_valid(
        'content',
        ${contentId},
        'content.revised',
        1,
        ${postgres.sql.json({
          ...revisedPayload,
          affected_symbol_ids: [
            ...revisedPayload.affected_symbol_ids,
            randomUUID(),
          ].sort(),
        })}
      )
      union all
      select system.content_v1_outbox_payload_is_valid(
        'content',
        ${contentId},
        'content.revised',
        1,
        ${postgres.sql.json({
          ...revisedPayload,
          affected_topic_ids: [...revisedPayload.affected_topic_ids, randomUUID()].sort(),
        })}
      )
      union all
      select system.content_v1_outbox_payload_is_valid(
        'content',
        ${contentId},
        'content.revised',
        1,
        ${postgres.sql.json({
          ...revisedPayload,
          symbol_ids: [...revisedPayload.symbol_ids, randomUUID()].sort(),
        })}
      )
      union all
      select system.content_v1_outbox_payload_is_valid(
        'content',
        ${contentId},
        'content.revised',
        1,
        ${postgres.sql.json({
          ...revisedPayload,
          topic_ids: [...revisedPayload.topic_ids, randomUUID()].sort(),
        })}
      )
    `;
    expect(rows).toEqual([
      { valid: true },
      { valid: false },
      { valid: false },
      { valid: false },
      { valid: false },
      { valid: true },
      { valid: false },
      { valid: false },
      { valid: false },
      { valid: false },
    ]);

    const invalidPayloads = [
      { ...valid, extra: true },
      { ...valid, access_token: "redacted" },
      { ...valid, community_ids: [] },
      missingRevision,
    ];
    for (const payload of invalidPayloads) {
      const invalidContentId = randomUUID();
      await expect(
        postgres.sql.begin(async (transaction) => {
          const now = new Date();
          await transaction`
            insert into system.outbox_events (
              id,
              aggregate_type,
              aggregate_id,
              aggregate_sequence,
              event_type,
              event_version,
              payload,
              occurred_at,
              available_at,
              created_at
            )
            values (
              ${randomUUID()},
              'content',
              ${invalidContentId},
              1,
              'content.published',
              1,
              ${transaction.json({
                ...payload,
                content_id: invalidContentId,
                root_content_id: invalidContentId,
              })},
              ${now},
              ${now},
              ${now}
            )
          `;
        }),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("rejects an otherwise-valid orphan content event for a runtime role", async () => {
    const contentId = randomUUID();
    const now = new Date();
    await expect(
      postgres.sql.begin(async (transaction) => {
        await setRuntimeRole(transaction);
        await transaction`
          insert into system.outbox_events (
            id,
            aggregate_type,
            aggregate_id,
            aggregate_sequence,
            event_type,
            event_version,
            payload,
            occurred_at,
            available_at,
            created_at
          )
          values (
            ${randomUUID()},
            'content',
            ${contentId},
            1,
            'content.published',
            1,
            ${transaction.json(publishedPayload(contentId, agentActorId))},
            ${now},
            ${now},
            ${now}
          )
        `;
        await transaction.unsafe("set constraints all immediate");
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
