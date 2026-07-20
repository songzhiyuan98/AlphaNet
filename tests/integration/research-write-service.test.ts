import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";
import {
  PostgresAgentConnectionService,
  type AgentCredentialContext,
  type AgentPolicyTier,
} from "../../packages/domain/src/agent-connection.js";
import { PostgresResearchWriteService } from "../../packages/domain/src/research-write.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeResearchWrite = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const apiKeyPepper = "research-write-service-pepper-is-public-integration-test-data-only";
const agentConnectionOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: { 1: apiKeyPepper },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

const generalCommunityId = "00000000-0000-4000-8000-000000000001";
const semiconductorsCommunityId = "00000000-0000-4000-8000-000000004001";
const earningsCommunityId = "00000000-0000-4000-8000-000000004002";
const amdSymbolId = "00000000-0000-4000-8000-000000001001";
const semiconductorsTopicId = "00000000-0000-4000-8000-000000003001";

function expectUuid(value: string | undefined): asserts value is string {
  expect(value).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

describeResearchWrite("PostgresResearchWriteService", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const competingPostgres = createPostgresDependency(databaseUrl ?? "");
  const agentService = new PostgresAgentConnectionService(
    postgres.sql,
    agentConnectionOptions,
  );
  const service = new PostgresResearchWriteService(postgres.sql, {
    pendingActionKeyRing: {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    },
  });
  const competingService = new PostgresResearchWriteService(competingPostgres.sql, {
    pendingActionKeyRing: {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    },
  });
  dependencies.push(postgres, competingPostgres);

  let autonomousContext: AgentCredentialContext;
  let assistedContext: AgentCredentialContext;
  let mentionActorId = "";
  let mentionHandle = "";
  let referenceContentId = "";
  let quotaCommunityId = "";
  let closedRepliesCommunityId = "";
  let autonomousSymbolId = "";
  let autonomousSymbolCandidateId = "";
  let autonomousSymbolTicker = "";
  let assistedSymbolCandidateId = "";
  let assistedSymbolTicker = "";
  let marker = "";

  async function createVerifiedOwner(testMarker: string): Promise<string> {
    const users = await postgres.sql<{ id: string }[]>`
      insert into auth.users (
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        'Research Write Integration Owner',
        ${`research-write-${testMarker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id
    `;
    const userId = users[0]?.id;
    if (!userId) {
      throw new Error("The integration Auth User was not created");
    }
    const owners = await postgres.sql<{ id: string }[]>`
      select id
      from platform.owners
      where auth_user_id = ${userId}
    `;
    const ownerId = owners[0]?.id;
    if (!ownerId) {
      throw new Error("The verified Owner projection was not created");
    }
    return ownerId;
  }

  async function activatePolicy(
    ownerId: string,
    agentId: string,
    tier: AgentPolicyTier,
  ): Promise<void> {
    await postgres.sql.begin(async (transaction) => {
      const activePolicies = await transaction<
        { defaults_version: string; policy_schema_version: number; version: number }[]
      >`
        select
          defaults_version,
          policy_schema_version,
          version::integer as version
        from platform.agent_policies
        where agent_id = ${agentId}
          and is_active
        limit 1
        for update
      `;
      const current = activePolicies[0];
      if (!current) {
        throw new Error("The Agent has no active policy");
      }
      await transaction`
        update platform.agent_policies
        set is_active = false
        where agent_id = ${agentId}
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
          ${randomUUID()},
          ${agentId},
          ${tier},
          ${current.defaults_version},
          ${current.policy_schema_version},
          ${current.version + 1},
          ${transaction.json({})},
          true,
          ${ownerId}
        )
      `;
    });
  }

  beforeAll(async () => {
    marker = randomUUID().replaceAll("-", "").slice(0, 10);
    quotaCommunityId = randomUUID();
    closedRepliesCommunityId = randomUUID();
    autonomousSymbolId = randomUUID();
    autonomousSymbolCandidateId = randomUUID();
    assistedSymbolCandidateId = randomUUID();
    autonomousSymbolTicker = `Z${marker.slice(0, 8).toUpperCase()}`;
    assistedSymbolTicker = `Y${marker.slice(0, 8).toUpperCase()}`;
    const assistedSymbolId = randomUUID();
    const quotaTopicId = randomUUID();
    const closedRepliesTopicId = randomUUID();

    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.topics (id, slug, name, description)
        values
          (
            ${quotaTopicId},
            ${`quota-${marker}`},
            'Isolated quota integration topic',
            'Used only for authoritative write-quota integration coverage.'
          ),
          (
            ${closedRepliesTopicId},
            ${`closed-${marker}`},
            'Isolated closed-replies integration topic',
            'Used only for reply-policy integration coverage.'
          )
      `;
      await transaction`
        insert into platform.communities (
          id,
          slug,
          name,
          description,
          kind,
          posting_rules,
          settings
        )
        values
          (
            ${quotaCommunityId},
            ${`quota-${marker}`},
            'Isolated quota Community',
            'A one-post-per-hour integration fixture.',
            'topic',
            ${transaction.json({
              allowed_content: ["investment-research", "discussion"],
              max_posts_per_hour: 1,
              replies_open: true,
              requires_sources: false,
            })},
            ${transaction.json({ integration_fixture: marker })}
          ),
          (
            ${closedRepliesCommunityId},
            ${`closed-${marker}`},
            'Isolated closed-replies Community',
            'An integration fixture that accepts posts but closes replies.',
            'topic',
            ${transaction.json({
              allowed_content: ["investment-research", "discussion"],
              max_posts_per_hour: 6,
              replies_open: false,
              requires_sources: false,
            })},
            ${transaction.json({ integration_fixture: marker })}
          )
      `;
      await transaction`
        insert into platform.community_topics (community_id, topic_id, is_primary)
        values
          (${quotaCommunityId}, ${quotaTopicId}, true),
          (${closedRepliesCommunityId}, ${closedRepliesTopicId}, true)
      `;
      await transaction`
        insert into platform.symbols (
          id,
          community_candidate_id,
          ticker,
          exchange,
          name
        )
        values
          (
            ${autonomousSymbolId},
            ${autonomousSymbolCandidateId},
            ${autonomousSymbolTicker},
            'TEST',
            'Autonomous materialization integration symbol'
          ),
          (
            ${assistedSymbolId},
            ${assistedSymbolCandidateId},
            ${assistedSymbolTicker},
            'TEST',
            'Assisted non-materialization integration symbol'
          )
      `;
    });

    const ownerId = await createVerifiedOwner(marker);
    const autonomous = await agentService.createAgent(
      ownerId,
      {
        displayName: "Autonomous Research Writer",
        handle: `autonomous-${marker}`,
      },
      randomUUID(),
    );
    await activatePolicy(ownerId, autonomous.agent.id, "autonomous");

    const assisted = await agentService.createAgent(
      ownerId,
      {
        displayName: "Assisted Research Writer",
        handle: `assisted-${marker}`,
      },
      randomUUID(),
    );
    mentionActorId = assisted.agent.actorId;
    mentionHandle = assisted.agent.handle;

    const autonomousCredential = await agentService.createCredential(
      ownerId,
      autonomous.agent.id,
      {
        name: "Autonomous write integration",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    autonomousContext = await agentService.authenticateStaticApiKey(
      autonomousCredential.apiKey,
    );

    const assistedCredential = await agentService.createCredential(
      ownerId,
      assisted.agent.id,
      {
        name: "Assisted write integration",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    assistedContext = await agentService.authenticateStaticApiKey(
      assistedCredential.apiKey,
    );

    const reference = await service.createPost(
      autonomousContext,
      {
        bodyMarkdown: "A published evidence node used as a reference target.",
        idempotencyKey: `reference-${randomUUID()}`,
        primaryCommunityId: generalCommunityId,
        title: "Reference evidence for integration coverage",
      },
      { requestId: `req-${randomUUID()}` },
    );
    referenceContentId = reference.result?.contentId ?? "";
    expectUuid(referenceContentId);
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("is ready on the exact migrated research schema", async () => {
    await expect(service.checkReady()).resolves.toBeUndefined();
  });

  it("atomically persists an Autonomous post and every public/audit fact", async () => {
    const idempotencyKey = `atomic-${randomUUID()}`;
    const sourceUrl = `https://evidence.example.test/${marker}/filing#risk-factors`;
    const result = await service.createPost(
      autonomousContext,
      {
        additionalCommunityIds: [earningsCommunityId],
        bodyMarkdown: `@${mentionHandle} should independently verify this filing evidence.`,
        idempotencyKey,
        primaryCommunityId: semiconductorsCommunityId,
        references: [{ relationType: "reference", targetContentId: referenceContentId }],
        sourceLinks: [
          {
            description: "Original issuer filing, risk section.",
            title: "Issuer filing",
            url: sourceUrl,
          },
        ],
        symbols: ["AMD"],
        title: "AMD filing evidence and scenario review",
        topics: ["semiconductors"],
      },
      { channel: "mcp", requestId: `req-${randomUUID()}` },
    );

    expect(result).toMatchObject({
      decision: "allow",
      error: null,
      operation: "create_post",
      pendingAction: null,
      replayed: false,
      status: "succeeded",
    });
    const contentId = result.result?.contentId;
    const revisionId = result.result?.revisionId;
    expectUuid(contentId);
    expectUuid(revisionId);

    const content = await postgres.sql<
      {
        author_actor_id: string;
        current_revision_id: string;
        depth: number;
        kind: string;
        lifecycle_state: string;
        parent_id: string | null;
        primary_community_id: string;
        root_id: string;
        version: number;
      }[]
    >`
      select
        kind,
        author_actor_id,
        primary_community_id,
        root_id,
        parent_id,
        depth,
        current_revision_id,
        lifecycle_state,
        version::integer as version
      from platform.content_items
      where id = ${contentId}
    `;
    expect(content).toEqual([
      {
        author_actor_id: autonomousContext.agent.actorId,
        current_revision_id: revisionId,
        depth: 0,
        kind: "post",
        lifecycle_state: "published",
        parent_id: null,
        primary_community_id: semiconductorsCommunityId,
        root_id: contentId,
        version: 1,
      },
    ]);

    const revision = await postgres.sql<
      {
        body_markdown: string;
        content_id: string;
        id: string;
        revision_number: number;
        title: string;
      }[]
    >`
      select
        id,
        content_id,
        revision_number::integer as revision_number,
        title,
        body_markdown
      from platform.content_revisions
      where id = ${revisionId}
    `;
    expect(revision).toEqual([
      {
        body_markdown: `@${mentionHandle} should independently verify this filing evidence.`,
        content_id: contentId,
        id: revisionId,
        revision_number: 1,
        title: "AMD filing evidence and scenario review",
      },
    ]);

    const additional = await postgres.sql<{ community_id: string; position: number }[]>`
      select community_id, position::integer as position
      from platform.content_additional_communities
      where content_id = ${contentId}
      order by position
    `;
    expect(additional).toEqual([{ community_id: earningsCommunityId, position: 1 }]);

    const symbols = await postgres.sql<{ id: string; position: number }[]>`
      select symbol.id, classification.position::integer as position
      from platform.content_symbols as classification
      join platform.symbols as symbol on symbol.id = classification.symbol_id
      where classification.content_id = ${contentId}
      order by classification.position
    `;
    expect(symbols).toEqual([{ id: amdSymbolId, position: 1 }]);

    const topics = await postgres.sql<{ id: string; position: number }[]>`
      select topic.id, classification.position::integer as position
      from platform.content_topics as classification
      join platform.topics as topic on topic.id = classification.topic_id
      where classification.content_id = ${contentId}
      order by classification.position
    `;
    expect(topics).toEqual([{ id: semiconductorsTopicId, position: 1 }]);

    const sources = await postgres.sql<
      {
        added_revision_id: string;
        description: string;
        position: number;
        title: string;
        url: string;
      }[]
    >`
      select
        position::integer as position,
        url,
        title,
        description,
        added_revision_id
      from platform.source_links
      where content_id = ${contentId}
        and removed_revision_id is null
    `;
    expect(sources).toEqual([
      {
        added_revision_id: revisionId,
        description: "Original issuer filing, risk section.",
        position: 1,
        title: "Issuer filing",
        url: sourceUrl,
      },
    ]);

    const references = await postgres.sql<
      {
        added_revision_id: string;
        relation_type: string;
        to_content_id: string;
      }[]
    >`
      select to_content_id, relation_type, added_revision_id
      from platform.content_relations
      where from_content_id = ${contentId}
        and removed_revision_id is null
    `;
    expect(references).toEqual([
      {
        added_revision_id: revisionId,
        relation_type: "reference",
        to_content_id: referenceContentId,
      },
    ]);

    const mentions = await postgres.sql<
      { mentioned_actor_id: string; position: number; revision_id: string }[]
    >`
      select revision_id, mentioned_actor_id, position::integer as position
      from platform.mentions
      where content_id = ${contentId}
    `;
    expect(mentions).toEqual([
      { mentioned_actor_id: mentionActorId, position: 1, revision_id: revisionId },
    ]);

    const outbox = await postgres.sql<
      { event_type: string; id: string; payload: unknown }[]
    >`
      select id, event_type, payload
      from system.outbox_events
      where aggregate_type = 'content'
        and aggregate_id = ${contentId}
    `;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.event_type).toBe("content.published");
    expect(asRecord(outbox[0]?.payload)).toMatchObject({
      actor_id: autonomousContext.agent.actorId,
      community_ids: [semiconductorsCommunityId, earningsCommunityId],
      content_id: contentId,
      kind: "post",
      revision_id: revisionId,
      root_content_id: contentId,
      symbol_ids: [amdSymbolId],
      topic_ids: [semiconductorsTopicId],
    });

    const audit = await postgres.sql<
      {
        action: string;
        decision: string;
        outbox_event_id: string;
        outcome: string;
        target_id: string;
      }[]
    >`
      select action, target_id, decision, outcome, outbox_event_id
      from platform.action_logs
      where event_class = 'domain_write'
        and target_type = 'content'
        and target_id = ${contentId}
    `;
    expect(audit).toEqual([
      {
        action: "content.create_post",
        decision: "allow",
        outbox_event_id: outbox[0]?.id,
        outcome: "succeeded",
        target_id: contentId,
      },
    ]);

    const idempotency = await postgres.sql<
      {
        resource_id: string;
        response_code: number;
        status: string;
        terminal_at: Date | null;
      }[]
    >`
      select status, response_code, resource_id, terminal_at
      from platform.idempotency_records
      where principal_scope_key = ${`credential:${autonomousContext.credential.id}`}
        and operation = 'create_post'
        and idempotency_key = ${idempotencyKey}
    `;
    expect(idempotency).toEqual([
      {
        resource_id: contentId,
        response_code: 201,
        status: "succeeded",
        terminal_at: expect.any(Date),
      },
    ]);
  });

  it("replays an exact key without duplicate effects and conflicts on new input", async () => {
    const idempotencyKey = `replay-${randomUUID()}`;
    const input = {
      bodyMarkdown: "A stable idempotent research body.",
      idempotencyKey,
      primaryCommunityId: generalCommunityId,
      title: "Stable idempotent research post",
    } as const;
    const first = await service.createPost(autonomousContext, input, {
      requestId: `req-${randomUUID()}`,
    });
    const replay = await service.createPost(autonomousContext, input, {
      requestId: `req-${randomUUID()}`,
    });
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    const contentId = first.result?.contentId;
    expectUuid(contentId);

    const conflict = await service.createPost(
      autonomousContext,
      { ...input, bodyMarkdown: "A different payload under the same key." },
      { requestId: `req-${randomUUID()}` },
    );
    expect(conflict).toMatchObject({
      decision: "allow",
      status: "failed",
      result: null,
      pendingAction: null,
      error: { code: "IDEMPOTENCY_CONFLICT", retryable: false },
    });

    const effects = await postgres.sql<
      {
        action_logs: number;
        content_items: number;
        idempotency_records: number;
        outbox_events: number;
        revisions: number;
      }[]
    >`
      select
        (
          select count(*)::integer
          from platform.content_items
          where id = ${contentId}
        ) as content_items,
        (
          select count(*)::integer
          from platform.content_revisions
          where content_id = ${contentId}
        ) as revisions,
        (
          select count(*)::integer
          from system.outbox_events
          where aggregate_type = 'content'
            and aggregate_id = ${contentId}
        ) as outbox_events,
        (
          select count(*)::integer
          from platform.action_logs
          where event_class = 'domain_write'
            and target_id = ${contentId}
        ) as action_logs,
        (
          select count(*)::integer
          from platform.idempotency_records
          where principal_scope_key = ${`credential:${autonomousContext.credential.id}`}
            and operation = 'create_post'
            and idempotency_key = ${idempotencyKey}
        ) as idempotency_records
    `;
    expect(effects).toEqual([
      {
        action_logs: 1,
        content_items: 1,
        idempotency_records: 1,
        outbox_events: 1,
        revisions: 1,
      },
    ]);
  });

  it("stores an Assisted command only as encrypted PendingAction state", async () => {
    const privateMarker = `plaintext-must-not-appear-${randomUUID()}`;
    const idempotencyKey = `assisted-${randomUUID()}`;
    const result = await service.createPost(
      assistedContext,
      {
        bodyMarkdown: `${privateMarker}: private unverified scenario assumptions.`,
        idempotencyKey,
        primaryCommunityId: assistedSymbolCandidateId,
        symbols: [assistedSymbolTicker],
        title: "Private scenario pending Owner review",
      },
      { requestId: `req-${randomUUID()}` },
    );
    expect(result).toMatchObject({
      decision: "require_approval",
      error: null,
      pendingAction: { operation: "create_post", state: "pending_approval" },
      replayed: false,
      result: null,
      status: "pending_approval",
    });
    const actionId = result.pendingAction?.id;
    expectUuid(actionId);

    const pending = await postgres.sql<
      {
        after_state: unknown;
        approval_summary: string;
        authorization_snapshot: unknown;
        ciphertext: Buffer;
        idempotency_response: unknown;
        nonce_bytes: number;
        outbox_payload: unknown;
        policy_snapshot: unknown;
      }[]
    >`
      select
        action.normalized_input_ciphertext as ciphertext,
        octet_length(action.normalized_input_nonce)::integer as nonce_bytes,
        action.approval_summary,
        action.policy_snapshot,
        audit.authorization_snapshot,
        audit.after_state,
        event.payload as outbox_payload,
        idempotency.response_body as idempotency_response
      from platform.pending_actions as action
      join platform.action_logs as audit on audit.id = action.audit_id
      join system.outbox_events as event on event.id = audit.outbox_event_id
      join platform.idempotency_records as idempotency
        on idempotency.id = action.idempotency_record_id
      where action.id = ${actionId}
    `;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.ciphertext).toBeInstanceOf(Buffer);
    expect(pending[0]?.ciphertext.includes(Buffer.from(privateMarker, "utf8"))).toBe(
      false,
    );
    expect(pending[0]?.nonce_bytes).toBe(12);
    const publicMetadata = JSON.stringify({
      afterState: pending[0]?.after_state,
      approvalSummary: pending[0]?.approval_summary,
      authorizationSnapshot: pending[0]?.authorization_snapshot,
      idempotencyResponse: pending[0]?.idempotency_response,
      outboxPayload: pending[0]?.outbox_payload,
      policySnapshot: pending[0]?.policy_snapshot,
    });
    expect(publicMetadata).not.toContain(privateMarker);

    const leakedRevisions = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.content_revisions
      where body_markdown like ${`%${privateMarker}%`}
         or body_plain_text like ${`%${privateMarker}%`}
    `;
    expect(leakedRevisions).toEqual([{ count: 0 }]);
    const assistedContent = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.content_items
      where author_actor_id = ${assistedContext.agent.actorId}
    `;
    expect(assistedContent).toEqual([{ count: 0 }]);
    const catalogCommunity = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.communities
      where id = ${assistedSymbolCandidateId}
    `;
    expect(catalogCommunity).toEqual([{ count: 0 }]);
  });

  it("serializes concurrent Assisted protected-action intents", async () => {
    const concurrencyMarker = randomUUID().replaceAll("-", "").slice(0, 10);
    const agent = await agentService.createAgent(
      autonomousContext.owner.id,
      {
        displayName: "Protected Intent Concurrency Agent",
        handle: `protected-race-${concurrencyMarker}`,
      },
      randomUUID(),
    );
    expect(agent.activationReason).toBeNull();
    expect(agent.agent.status).toBe("active");
    const credential = await agentService.createCredential(
      autonomousContext.owner.id,
      agent.agent.id,
      {
        name: "Protected intent concurrency credential",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    const context = await agentService.authenticateStaticApiKey(credential.apiKey);
    const protectedActionKey = randomBytes(32);
    const protectedActionOptions = {
      pendingActionKeyRing: {
        currentVersion: 1,
        keys: { 1: protectedActionKey },
      },
      protectedActionIntentsPerHour: 1,
    } as const;
    const firstService = new PostgresResearchWriteService(
      postgres.sql,
      protectedActionOptions,
    );
    const secondService = new PostgresResearchWriteService(
      competingPostgres.sql,
      protectedActionOptions,
    );
    const firstKey = `protected-race-first-${randomUUID()}`;
    const secondKey = `protected-race-second-${randomUUID()}`;
    const [first, second] = await withTimeout(
      Promise.all([
        firstService.createPost(
          context,
          {
            bodyMarkdown: "First concurrent command awaiting Owner approval.",
            idempotencyKey: firstKey,
            primaryCommunityId: generalCommunityId,
            title: "First protected-action contender",
          },
          { requestId: `req-${randomUUID()}` },
        ),
        secondService.createPost(
          context,
          {
            bodyMarkdown: "Second concurrent command awaiting Owner approval.",
            idempotencyKey: secondKey,
            primaryCommunityId: generalCommunityId,
            title: "Second protected-action contender",
          },
          { requestId: `req-${randomUUID()}` },
        ),
      ]),
      10_000,
      "Concurrent Assisted protected-action intents did not settle within 10 seconds",
    );
    const attempts = [
      { idempotencyKey: firstKey, outcome: first },
      { idempotencyKey: secondKey, outcome: second },
    ];
    expect(attempts.map(({ outcome }) => outcome.status).sort()).toEqual([
      "denied",
      "pending_approval",
    ]);
    const deniedAttempt = attempts.find(({ outcome }) => outcome.status === "denied");
    const pendingAttempt = attempts.find(
      ({ outcome }) => outcome.status === "pending_approval",
    );
    if (!deniedAttempt || !pendingAttempt) {
      throw new Error(
        "The protected-action race did not produce one PendingAction and one denial",
      );
    }
    expect(deniedAttempt.outcome).toMatchObject({
      decision: "deny",
      error: {
        code: "RATE_LIMITED",
        details: { limit: 1, limit_dimension: "protected_action_intent" },
        retryable: true,
      },
      pendingAction: null,
      result: null,
      status: "denied",
    });
    expect(pendingAttempt.outcome).toMatchObject({
      decision: "require_approval",
      error: null,
      pendingAction: { operation: "create_post", state: "pending_approval" },
      result: null,
      status: "pending_approval",
    });

    const effects = await postgres.sql<
      {
        content_items: number;
        denied_idempotency: number;
        pending_actions: number;
        winner_idempotency: number;
      }[]
    >`
      select
        (
          select count(*)::integer
          from platform.pending_actions
          where agent_id = ${context.agent.id}
            and state = 'pending_approval'
        ) as pending_actions,
        (
          select count(*)::integer
          from platform.content_items
          where author_actor_id = ${context.agent.actorId}
        ) as content_items,
        (
          select count(*)::integer
          from platform.idempotency_records
          where principal_scope_key = ${`credential:${context.credential.id}`}
            and operation = 'create_post'
            and idempotency_key = ${pendingAttempt.idempotencyKey}
        ) as winner_idempotency,
        (
          select count(*)::integer
          from platform.idempotency_records
          where principal_scope_key = ${`credential:${context.credential.id}`}
            and operation = 'create_post'
            and idempotency_key = ${deniedAttempt.idempotencyKey}
        ) as denied_idempotency
    `;
    expect(effects).toEqual([
      {
        content_items: 0,
        denied_idempotency: 0,
        pending_actions: 1,
        winner_idempotency: 1,
      },
    ]);
  }, 20_000);

  it("inherits the root Community set for replies and enforces replies_open", async () => {
    const root = await service.createPost(
      autonomousContext,
      {
        additionalCommunityIds: [earningsCommunityId],
        bodyMarkdown: "A root discussion distributed to two Communities.",
        idempotencyKey: `reply-root-${randomUUID()}`,
        primaryCommunityId: semiconductorsCommunityId,
        title: "Open multi-Community discussion root",
      },
      { requestId: `req-${randomUUID()}` },
    );
    const rootId = root.result?.contentId;
    expectUuid(rootId);
    const reply = await service.replyToContent(
      autonomousContext,
      {
        bodyMarkdown: "A reply that inherits the root distribution set.",
        idempotencyKey: `reply-${randomUUID()}`,
        parentContentId: rootId,
      },
      { requestId: `req-${randomUUID()}` },
    );
    const replyId = reply.result?.contentId;
    expectUuid(replyId);
    expect(reply).toMatchObject({
      decision: "allow",
      operation: "reply_to_content",
      result: { rootContentId: rootId },
      status: "succeeded",
    });

    const replyRows = await postgres.sql<
      {
        additional_count: number;
        depth: number;
        parent_id: string;
        primary_community_id: string | null;
        root_id: string;
      }[]
    >`
      select
        reply.root_id,
        reply.parent_id,
        reply.depth::integer as depth,
        reply.primary_community_id,
        (
          select count(*)::integer
          from platform.content_additional_communities as additional
          where additional.content_id = reply.id
        ) as additional_count
      from platform.content_items as reply
      where reply.id = ${replyId}
    `;
    expect(replyRows).toEqual([
      {
        additional_count: 0,
        depth: 1,
        parent_id: rootId,
        primary_community_id: null,
        root_id: rootId,
      },
    ]);
    const replyEvents = await postgres.sql<{ payload: unknown }[]>`
      select payload
      from system.outbox_events
      where aggregate_type = 'content'
        and aggregate_id = ${replyId}
        and event_type = 'content.reply'
    `;
    expect(replyEvents).toHaveLength(1);
    expect(asRecord(replyEvents[0]?.payload)).toMatchObject({
      community_ids: [semiconductorsCommunityId, earningsCommunityId],
      content_id: replyId,
      kind: "reply",
      parent_content_id: rootId,
      root_content_id: rootId,
    });

    const closedRoot = await service.createPost(
      autonomousContext,
      {
        bodyMarkdown: "A root post whose Community has closed replies.",
        idempotencyKey: `closed-root-${randomUUID()}`,
        primaryCommunityId: closedRepliesCommunityId,
        title: "Closed reply-policy discussion root",
      },
      { requestId: `req-${randomUUID()}` },
    );
    const closedRootId = closedRoot.result?.contentId;
    expectUuid(closedRootId);
    const rejectedReplyKey = `closed-reply-${randomUUID()}`;
    const rejectedReplyRequestId = `req-${randomUUID()}`;
    const rejectedReply = await service.replyToContent(
      autonomousContext,
      {
        bodyMarkdown: "This reply must be rejected by Community policy.",
        idempotencyKey: rejectedReplyKey,
        parentContentId: closedRootId,
      },
      { requestId: rejectedReplyRequestId },
    );
    expect(rejectedReply).toMatchObject({
      decision: "deny",
      status: "denied",
      result: null,
      pendingAction: null,
      error: { code: "REPLIES_CLOSED", retryable: false },
    });
    const rejectedReplyIdempotency = await postgres.sql<
      {
        response_body: unknown;
        response_code: number;
        status: string;
        terminal_at: Date | null;
      }[]
    >`
      select status, response_code, response_body, terminal_at
      from platform.idempotency_records
      where principal_scope_key = ${`credential:${autonomousContext.credential.id}`}
        and operation = 'reply_to_content'
        and idempotency_key = ${rejectedReplyKey}
    `;
    expect(rejectedReplyIdempotency).toHaveLength(1);
    expect(rejectedReplyIdempotency[0]).toMatchObject({
      response_code: 403,
      status: "denied",
      terminal_at: expect.any(Date),
    });
    expect(asRecord(rejectedReplyIdempotency[0]?.response_body)).toMatchObject({
      decision: "deny",
      status: "denied",
      error: { code: "REPLIES_CLOSED" },
    });
    const denialAudit = await postgres.sql<
      { decision: string; error_code: string | null; outcome: string }[]
    >`
      select decision, outcome, error_code
      from platform.action_logs
      where request_id = ${rejectedReplyRequestId}
        and action = 'content.reply_to_content'
        and target_id = ${closedRootId}
    `;
    expect(denialAudit).toEqual([
      {
        decision: "deny",
        error_code: "REPLIES_CLOSED",
        outcome: "denied",
      },
    ]);

    await postgres.sql`
      update platform.communities
      set posting_rules = jsonb_set(
            posting_rules,
            '{replies_open}',
            'true'::jsonb
          ),
          version = version + 1
      where id = ${closedRepliesCommunityId}
    `;
    const replay = await service.replyToContent(
      autonomousContext,
      {
        bodyMarkdown: "This reply must be rejected by Community policy.",
        idempotencyKey: rejectedReplyKey,
        parentContentId: closedRootId,
      },
      { requestId: `req-${randomUUID()}` },
    );
    expect(replay).toEqual({ ...rejectedReply, replayed: true });
    const stableEffects = await postgres.sql<{ action_logs: number; replies: number }[]>`
      select
        (
          select count(*)::integer
          from platform.content_items
          where parent_id = ${closedRootId}
        ) as replies,
        (
          select count(*)::integer
          from platform.action_logs
          where action = 'content.reply_to_content'
            and target_id = ${closedRootId}
            and error_code = 'REPLIES_CLOSED'
        ) as action_logs
    `;
    expect(stableEffects).toEqual([{ action_logs: 1, replies: 0 }]);
  });

  it("enforces the authoritative post quota before reserving idempotency", async () => {
    const accepted = await service.createPost(
      autonomousContext,
      {
        bodyMarkdown: "The only post admitted to this isolated hourly window.",
        idempotencyKey: `quota-first-${randomUUID()}`,
        primaryCommunityId: quotaCommunityId,
        title: "Accepted post inside isolated quota",
      },
      { requestId: `req-${randomUUID()}` },
    );
    expect(accepted.status).toBe("succeeded");

    const rejectedKey = `quota-rejected-${randomUUID()}`;
    const rejected = await service.createPost(
      autonomousContext,
      {
        bodyMarkdown: "A second post that exceeds the one-post window.",
        idempotencyKey: rejectedKey,
        primaryCommunityId: quotaCommunityId,
        title: "Rejected post outside isolated quota",
      },
      { requestId: `req-${randomUUID()}` },
    );
    expect(rejected).toMatchObject({
      decision: "deny",
      status: "denied",
      result: null,
      pendingAction: null,
      error: {
        code: "RATE_LIMITED",
        retryable: true,
      },
    });
    expect(rejected.error?.retryAfterMs).toBeTypeOf("number");
    expect(rejected.error?.retryAfterMs).toBeGreaterThan(0);

    const state = await postgres.sql<
      { admitted_content: number; rejected_idempotency: number }[]
    >`
      select
        (
          select count(*)::integer
          from platform.content_items
          where author_actor_id = ${autonomousContext.agent.actorId}
            and kind = 'post'
            and primary_community_id = ${quotaCommunityId}
        ) as admitted_content,
        (
          select count(*)::integer
          from platform.idempotency_records
          where principal_scope_key = ${`credential:${autonomousContext.credential.id}`}
            and operation = 'create_post'
            and idempotency_key = ${rejectedKey}
        ) as rejected_idempotency
    `;
    expect(state).toEqual([{ admitted_content: 1, rejected_idempotency: 0 }]);
  });

  it("serializes opposite-order cross-post quota races without deadlock", async () => {
    const concurrencyMarker = randomUUID().replaceAll("-", "").slice(0, 10);
    const firstCommunityId = randomUUID();
    const secondCommunityId = randomUUID();
    const firstTopicId = randomUUID();
    const secondTopicId = randomUUID();
    await postgres.sql.begin(async (transaction) => {
      await transaction`
          insert into platform.topics (id, slug, name, description)
          values
            (
              ${firstTopicId},
              ${`quota-race-a-${concurrencyMarker}`},
              'Cross-post quota race topic A',
              'First side of the opposite-order quota race integration fixture.'
            ),
            (
              ${secondTopicId},
              ${`quota-race-b-${concurrencyMarker}`},
              'Cross-post quota race topic B',
              'Second side of the opposite-order quota race integration fixture.'
            )
        `;
      const postingRules = {
        allowed_content: ["investment-research", "discussion"],
        max_posts_per_hour: 1,
        replies_open: true,
        requires_sources: false,
      };
      await transaction`
          insert into platform.communities (
            id,
            slug,
            name,
            description,
            kind,
            posting_rules,
            settings
          )
          values
            (
              ${firstCommunityId},
              ${`quota-race-a-${concurrencyMarker}`},
              'Cross-post quota race Community A',
              'First dynamically isolated one-post Community.',
              'topic',
              ${transaction.json(postingRules)},
              ${transaction.json({ integration_fixture: concurrencyMarker })}
            ),
            (
              ${secondCommunityId},
              ${`quota-race-b-${concurrencyMarker}`},
              'Cross-post quota race Community B',
              'Second dynamically isolated one-post Community.',
              'topic',
              ${transaction.json(postingRules)},
              ${transaction.json({ integration_fixture: concurrencyMarker })}
            )
        `;
      await transaction`
          insert into platform.community_topics (community_id, topic_id, is_primary)
          values
            (${firstCommunityId}, ${firstTopicId}, true),
            (${secondCommunityId}, ${secondTopicId}, true)
        `;
    });

    const forwardKey = `quota-race-forward-${randomUUID()}`;
    const reverseKey = `quota-race-reverse-${randomUUID()}`;
    const [forward, reverse] = await withTimeout(
      Promise.all([
        service.createPost(
          autonomousContext,
          {
            additionalCommunityIds: [secondCommunityId],
            bodyMarkdown: "Forward contender for the atomic cross-post quota window.",
            idempotencyKey: forwardKey,
            primaryCommunityId: firstCommunityId,
            title: "Forward cross-post quota contender",
          },
          { requestId: `req-${randomUUID()}` },
        ),
        competingService.createPost(
          autonomousContext,
          {
            additionalCommunityIds: [firstCommunityId],
            bodyMarkdown: "Reverse contender for the atomic cross-post quota window.",
            idempotencyKey: reverseKey,
            primaryCommunityId: secondCommunityId,
            title: "Reverse cross-post quota contender",
          },
          { requestId: `req-${randomUUID()}` },
        ),
      ]),
      10_000,
      "Opposite-order cross-post quota race did not settle within 10 seconds",
    );
    const attempts = [
      { idempotencyKey: forwardKey, outcome: forward },
      { idempotencyKey: reverseKey, outcome: reverse },
    ];
    expect(attempts.map(({ outcome }) => outcome.status).sort()).toEqual([
      "denied",
      "succeeded",
    ]);
    const deniedAttempt = attempts.find(({ outcome }) => outcome.status === "denied");
    const succeededAttempt = attempts.find(
      ({ outcome }) => outcome.status === "succeeded",
    );
    if (!deniedAttempt || !succeededAttempt) {
      throw new Error(
        "The cross-post quota race did not produce one winner and one denial",
      );
    }
    expect(deniedAttempt.outcome).toMatchObject({
      decision: "deny",
      error: { code: "RATE_LIMITED", retryable: true },
      pendingAction: null,
      result: null,
      status: "denied",
    });
    const contentId = succeededAttempt.outcome.result?.contentId;
    expectUuid(contentId);

    const effects = await postgres.sql<
      {
        additional_communities: number;
        admitted_content: number;
        denied_idempotency: number;
      }[]
    >`
        select
          (
            select count(*)::integer
            from platform.content_items
            where author_actor_id = ${autonomousContext.agent.actorId}
              and primary_community_id in (${firstCommunityId}, ${secondCommunityId})
          ) as admitted_content,
          (
            select count(*)::integer
            from platform.content_additional_communities
            where content_id = ${contentId}
              and community_id in (${firstCommunityId}, ${secondCommunityId})
          ) as additional_communities,
          (
            select count(*)::integer
            from platform.idempotency_records
            where principal_scope_key = ${`credential:${autonomousContext.credential.id}`}
              and operation = 'create_post'
              and idempotency_key = ${deniedAttempt.idempotencyKey}
          ) as denied_idempotency
      `;
    expect(effects).toEqual([
      {
        additional_communities: 1,
        admitted_content: 1,
        denied_idempotency: 0,
      },
    ]);
  }, 20_000);

  it("materializes a catalog-only symbol only in a successful Autonomous transaction", async () => {
    const initial = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.communities
      where id = ${autonomousSymbolCandidateId}
    `;
    expect(initial).toEqual([{ count: 0 }]);

    const failedKey = `materialize-rollback-${randomUUID()}`;
    const failed = await service.createPost(
      autonomousContext,
      {
        bodyMarkdown: "This command fails after catalog admission is inspected.",
        idempotencyKey: failedKey,
        primaryCommunityId: autonomousSymbolCandidateId,
        symbols: [autonomousSymbolTicker],
        title: "Catalog materialization rollback coverage",
        topics: [`missing-${marker}`],
      },
      { requestId: `req-${randomUUID()}` },
    );
    expect(failed).toMatchObject({
      decision: "allow",
      status: "failed",
      result: null,
      pendingAction: null,
      error: { code: "VALIDATION_ERROR", retryable: false },
    });
    const rolledBack = await postgres.sql<
      { communities: number; idempotency_records: number; mappings: number }[]
    >`
      select
        (
          select count(*)::integer
          from platform.communities
          where id = ${autonomousSymbolCandidateId}
        ) as communities,
        (
          select count(*)::integer
          from platform.community_symbols
          where community_id = ${autonomousSymbolCandidateId}
        ) as mappings,
        (
          select count(*)::integer
          from platform.idempotency_records
          where principal_scope_key = ${`credential:${autonomousContext.credential.id}`}
            and operation = 'create_post'
            and idempotency_key = ${failedKey}
        ) as idempotency_records
    `;
    expect(rolledBack).toEqual([{ communities: 0, idempotency_records: 0, mappings: 0 }]);

    const succeeded = await service.createPost(
      autonomousContext,
      {
        bodyMarkdown: "A valid first publication materializes this catalog Community.",
        idempotencyKey: `materialize-success-${randomUUID()}`,
        primaryCommunityId: autonomousSymbolCandidateId,
        symbols: [autonomousSymbolTicker],
        title: "Successful catalog Community materialization",
      },
      { requestId: `req-${randomUUID()}` },
    );
    const contentId = succeeded.result?.contentId;
    expectUuid(contentId);

    const materialized = await postgres.sql<
      {
        community_id: string;
        content_primary_community_id: string;
        kind: string;
        symbol_id: string;
      }[]
    >`
      select
        community.id as community_id,
        community.kind,
        mapping.symbol_id,
        content.primary_community_id as content_primary_community_id
      from platform.communities as community
      join platform.community_symbols as mapping
        on mapping.community_id = community.id
       and mapping.is_primary
      join platform.content_items as content
        on content.primary_community_id = community.id
      where community.id = ${autonomousSymbolCandidateId}
        and content.id = ${contentId}
    `;
    expect(materialized).toEqual([
      {
        community_id: autonomousSymbolCandidateId,
        content_primary_community_id: autonomousSymbolCandidateId,
        kind: "symbol",
        symbol_id: autonomousSymbolId,
      },
    ]);
  });
});
