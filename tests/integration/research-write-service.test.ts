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
import { PostgresContentReadService } from "../../packages/domain/src/content-read.js";
import { PostgresOwnerPendingActionService } from "../../packages/domain/src/owner-pending-action.js";
import { PostgresPendingActionExecutionRepository } from "../../packages/domain/src/pending-action-execution.js";
import {
  ApprovedResearchExecutionError,
  PostgresResearchWriteService,
} from "../../packages/domain/src/research-write.js";

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
const fixtureAgentContentRateLimits = {
  establishedPostsPerHour: 10_000,
  establishedRepliesPerHour: 10_000,
  newAgentPostsPerHour: 10_000,
  newAgentRepliesPerHour: 10_000,
} as const;
const fixtureResearchAntiSpamLimits = {
  duplicateContentWindowMs: 60_000,
  ownerContentWritesPerHour: 10_000,
  ownerPostsPerHour: 10_000,
  pairRepliesPerThirtyMinutes: 10_000,
  threadRepliesPerHour: 10_000,
} as const;

const generalCommunityId = "00000000-0000-4000-8000-000000000001";
const semiconductorsCommunityId = "00000000-0000-4000-8000-000000004001";
const earningsCommunityId = "00000000-0000-4000-8000-000000004002";
const amdSymbolId = "00000000-0000-4000-8000-000000001001";
const semiconductorsTopicId = "00000000-0000-4000-8000-000000003001";

function expectUuid(value: string | null | undefined): asserts value is string {
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

function revisionIdOf(value: object | null | undefined): string | null | undefined {
  if (value === null || value === undefined || !("revisionId" in value)) {
    return undefined;
  }
  const revisionId = value.revisionId;
  return typeof revisionId === "string" || revisionId === null ? revisionId : undefined;
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
  const pendingActionKeyRing = {
    currentVersion: 1,
    keys: { 1: randomBytes(32) },
  } as const;
  const agentService = new PostgresAgentConnectionService(
    postgres.sql,
    agentConnectionOptions,
  );
  const service = new PostgresResearchWriteService(postgres.sql, {
    agentContentRateLimits: fixtureAgentContentRateLimits,
    antiSpamLimits: fixtureResearchAntiSpamLimits,
    pendingActionKeyRing,
  });
  const ownerActionService = new PostgresOwnerPendingActionService(postgres.sql, {
    cursorSigningKey: randomBytes(32),
    pendingActionKeyRing,
  });
  const competingService = new PostgresResearchWriteService(competingPostgres.sql, {
    agentContentRateLimits: fixtureAgentContentRateLimits,
    antiSpamLimits: fixtureResearchAntiSpamLimits,
    pendingActionKeyRing: {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    },
  });
  const contentReadService = new PostgresContentReadService(postgres.sql, {
    cursorSigningKey: randomBytes(32),
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

  async function createIsolatedWriteContext(options: {
    label: string;
    ownerId?: string;
    tier?: AgentPolicyTier;
  }): Promise<AgentCredentialContext> {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const ownerId =
      options.ownerId ?? (await createVerifiedOwner(`${options.label}-${suffix}`));
    const created = await agentService.createAgent(
      ownerId,
      {
        displayName: `Anti-spam ${options.label} Agent`,
        handle: `anti-${options.label}-${suffix}`,
      },
      randomUUID(),
    );
    await activatePolicy(ownerId, created.agent.id, options.tier ?? "autonomous");
    const credential = await agentService.createCredential(
      ownerId,
      created.agent.id,
      {
        name: `${options.label} integration credential`,
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    return agentService.authenticateStaticApiKey(credential.apiKey);
  }

  async function createAdditionalWriteCredential(
    context: AgentCredentialContext,
    label: string,
  ): Promise<AgentCredentialContext> {
    const credential = await agentService.createCredential(
      context.owner.id,
      context.agent.id,
      {
        name: `${label} ${randomUUID()}`,
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    return agentService.authenticateStaticApiKey(credential.apiKey);
  }

  async function claimIsolatedAction(
    repository: PostgresPendingActionExecutionRepository,
    actionId: string,
  ) {
    return postgres.sql.begin(async (transaction) => {
      // Other integration files intentionally retain approved schema fixtures.
      // Lock only those foreign rows so SKIP LOCKED proves that this repository
      // claims our due action without mutating another test's queue history.
      await transaction`
        select id
        from platform.pending_actions
        where state = 'approved'
          and id <> ${actionId}
        for update
      `;
      return repository.claimNext();
    });
  }

  async function createAutonomousUpdateFixture(options: {
    communityId: string;
    label: string;
    references?: readonly {
      relationType: "quote" | "reference";
      targetContentId: string;
    }[];
    sourceLinks?: readonly {
      description?: string;
      title?: string;
      url: string;
    }[];
    symbols?: readonly string[];
    topics?: readonly string[];
  }): Promise<{ contentId: string; revisionId: string }> {
    const created = await service.createPost(
      autonomousContext,
      {
        bodyMarkdown: `Initial editable research body for ${options.label}.`,
        idempotencyKey: `update-fixture-${options.label}-${randomUUID()}`,
        primaryCommunityId: options.communityId,
        references: options.references,
        sourceLinks: options.sourceLinks,
        symbols: options.symbols,
        title: `Editable research fixture ${options.label}`,
        topics: options.topics,
      },
      { requestId: `req-${randomUUID()}` },
    );
    expect(created).toMatchObject({
      decision: "allow",
      operation: "create_post",
      status: "succeeded",
    });
    const contentId = created.result?.contentId;
    const revisionId = revisionIdOf(created.result);
    expectUuid(contentId);
    expectUuid(revisionId);
    return { contentId, revisionId };
  }

  async function insertPublishedUpdateFixture(
    actorId: string,
    label: string,
    publishedAt: Date = new Date(),
  ): Promise<{ contentId: string; revisionId: string }> {
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const body = `Direct published update fixture ${label}.`;
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.content_items (
          id,
          kind,
          author_actor_id,
          primary_community_id,
          root_id,
          depth,
          published_at,
          created_at,
          updated_at
        )
        values (
          ${contentId},
          'post',
          ${actorId},
          ${generalCommunityId},
          ${contentId},
          0,
          ${publishedAt},
          ${publishedAt},
          ${publishedAt}
        )
      `;
      await transaction`
        insert into platform.content_revisions (
          id,
          content_id,
          revision_number,
          title,
          body_markdown,
          body_plain_text,
          created_by_actor_id,
          created_at,
          source_version,
          content_hash,
          public_node_serialized_bytes
        )
        values (
          ${revisionId},
          ${contentId},
          1,
          ${`Direct update fixture ${label}`},
          ${body},
          ${body},
          ${actorId},
          ${publishedAt},
          1,
          ${randomBytes(32)},
          512
        )
      `;
      await transaction`
        update platform.content_items
        set current_revision_id = ${revisionId}
        where id = ${contentId}
      `;
    });
    return { contentId, revisionId };
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

  it("uses the database clock for IdempotencyRecord lifecycle timestamps", async () => {
    const skewedApplicationNow = new Date(Date.now() + 10 * 60 * 1_000);
    const skewedService = new PostgresResearchWriteService(postgres.sql, {
      agentContentRateLimits: fixtureAgentContentRateLimits,
      antiSpamLimits: fixtureResearchAntiSpamLimits,
      clock: () => skewedApplicationNow,
      pendingActionKeyRing,
    });
    const idempotencyKey = `database-clock-${randomUUID()}`;

    const outcome = await skewedService.createPost(
      autonomousContext,
      {
        bodyMarkdown: `Database clock regression coverage ${randomUUID()}.`,
        idempotencyKey,
        primaryCommunityId: generalCommunityId,
        title: `Database clock regression ${randomUUID()}`,
      },
      { channel: "integration-database-clock", requestId: `req-${randomUUID()}` },
    );

    expect(outcome).toMatchObject({
      replayed: false,
      status: "succeeded",
    });
    const persisted = await postgres.sql<
      {
        first_received_at: Date;
        terminal_at: Date;
        updated_at: Date;
      }[]
    >`
      select first_received_at, terminal_at, updated_at
      from platform.idempotency_records
      where principal_scope_key = ${`credential:${autonomousContext.credential.id}`}
        and operation = 'create_post'
        and idempotency_key = ${idempotencyKey}
    `;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.first_received_at.valueOf()).toBeLessThan(
      skewedApplicationNow.valueOf() - 5 * 60 * 1_000,
    );
    expect(persisted[0]!.updated_at.valueOf()).toBeGreaterThanOrEqual(
      persisted[0]!.first_received_at.valueOf(),
    );
    expect(persisted[0]!.terminal_at.valueOf()).toBeGreaterThanOrEqual(
      persisted[0]!.first_received_at.valueOf(),
    );
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
    const revisionId = revisionIdOf(result.result);
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

  it("updates authored prose, sources, and references as one immutable Revision", async () => {
    const oldSourceUrl = `https://evidence.example.test/${marker}/update-old`;
    const newSourceUrl = `https://evidence.example.test/${marker}/update-new`;
    const newBody = "Updated research body after independently checking new evidence.";
    const fixture = await createAutonomousUpdateFixture({
      communityId: semiconductorsCommunityId,
      label: `revision-${randomUUID()}`,
      references: [{ relationType: "reference", targetContentId: referenceContentId }],
      sourceLinks: [
        {
          description: "Evidence used by the original thesis.",
          title: "Original evidence",
          url: oldSourceUrl,
        },
      ],
    });

    const updated = await service.updateContent(
      autonomousContext,
      {
        contentId: fixture.contentId,
        editSummary: "Rechecked the thesis against newer primary evidence.",
        expectedVersion: 1,
        idempotencyKey: `update-revision-${randomUUID()}`,
        patch: {
          bodyMarkdown: newBody,
          references: [{ relationType: "quote", targetContentId: referenceContentId }],
          sourceLinks: [
            {
              description: "Replacement evidence supporting the revised analysis.",
              title: "Updated evidence",
              url: newSourceUrl,
            },
          ],
        },
      },
      { channel: "mcp", requestId: `req-${randomUUID()}` },
    );

    expect(updated).toMatchObject({
      decision: "allow",
      error: null,
      operation: "update_content",
      pendingAction: null,
      replayed: false,
      result: {
        contentId: fixture.contentId,
        resourceVersion: 2,
      },
      status: "succeeded",
    });
    const revisionId = revisionIdOf(updated.result);
    expectUuid(revisionId);
    expect(revisionId).not.toBe(fixture.revisionId);

    const content = await postgres.sql<
      { current_revision_id: string; version: number }[]
    >`
      select current_revision_id, version::integer as version
      from platform.content_items
      where id = ${fixture.contentId}
    `;
    expect(content).toEqual([{ current_revision_id: revisionId, version: 2 }]);

    const revisions = await postgres.sql<
      {
        body_markdown: string;
        created_by_actor_id: string;
        edit_summary: string | null;
        id: string;
        revision_number: number;
        source_version: number;
      }[]
    >`
      select
        id,
        revision_number::integer as revision_number,
        body_markdown,
        edit_summary,
        created_by_actor_id,
        source_version::integer as source_version
      from platform.content_revisions
      where content_id = ${fixture.contentId}
      order by revision_number
    `;
    expect(revisions).toEqual([
      {
        body_markdown: expect.stringContaining("Initial editable research body"),
        created_by_actor_id: autonomousContext.agent.actorId,
        edit_summary: null,
        id: fixture.revisionId,
        revision_number: 1,
        source_version: 1,
      },
      {
        body_markdown: newBody,
        created_by_actor_id: autonomousContext.agent.actorId,
        edit_summary: "Rechecked the thesis against newer primary evidence.",
        id: revisionId,
        revision_number: 2,
        source_version: 2,
      },
    ]);

    const sources = await postgres.sql<
      {
        added_revision_id: string;
        description: string | null;
        removed_revision_id: string | null;
        title: string | null;
        url: string;
      }[]
    >`
      select url, title, description, added_revision_id, removed_revision_id
      from platform.source_links
      where content_id = ${fixture.contentId}
      order by added_at, id
    `;
    expect(sources).toEqual([
      {
        added_revision_id: fixture.revisionId,
        description: "Evidence used by the original thesis.",
        removed_revision_id: revisionId,
        title: "Original evidence",
        url: oldSourceUrl,
      },
      {
        added_revision_id: revisionId,
        description: "Replacement evidence supporting the revised analysis.",
        removed_revision_id: null,
        title: "Updated evidence",
        url: newSourceUrl,
      },
    ]);

    const references = await postgres.sql<
      {
        added_revision_id: string;
        relation_type: string;
        removed_revision_id: string | null;
        to_content_id: string;
      }[]
    >`
      select
        to_content_id,
        relation_type,
        added_revision_id,
        removed_revision_id
      from platform.content_relations
      where from_content_id = ${fixture.contentId}
      order by created_at, id
    `;
    expect(references).toEqual([
      {
        added_revision_id: fixture.revisionId,
        relation_type: "reference",
        removed_revision_id: revisionId,
        to_content_id: referenceContentId,
      },
      {
        added_revision_id: revisionId,
        relation_type: "quote",
        removed_revision_id: null,
        to_content_id: referenceContentId,
      },
    ]);

    const revisedEvents = await postgres.sql<{ payload: unknown }[]>`
      select payload
      from system.outbox_events
      where aggregate_type = 'content'
        and aggregate_id = ${fixture.contentId}
        and event_type = 'content.revised'
    `;
    expect(revisedEvents).toHaveLength(1);
    expect(asRecord(revisedEvents[0]?.payload)).toEqual({
      actor_id: autonomousContext.agent.actorId,
      affected_symbol_ids: [],
      affected_topic_ids: [],
      changed_groups: ["body_markdown", "source_links", "references"],
      community_ids: [semiconductorsCommunityId],
      content_id: fixture.contentId,
      resource_version: 2,
      revision_id: revisionId,
      root_content_id: fixture.contentId,
      symbol_ids: [],
      topic_ids: [],
    });
    const operationalPayload = JSON.stringify(revisedEvents[0]?.payload);
    expect(operationalPayload).not.toContain(newBody);
    expect(operationalPayload).not.toContain(newSourceUrl);
    expect(operationalPayload).not.toContain("Rechecked the thesis");
  });

  it("advances only the resource version for a classification-only update", async () => {
    const fixture = await createAutonomousUpdateFixture({
      communityId: earningsCommunityId,
      label: `classification-${randomUUID()}`,
      symbols: ["AMD"],
    });

    const updated = await service.updateContent(
      autonomousContext,
      {
        contentId: fixture.contentId,
        expectedVersion: 1,
        idempotencyKey: `update-classification-${randomUUID()}`,
        patch: { symbols: [] },
      },
      { requestId: `req-${randomUUID()}` },
    );

    expect(updated).toMatchObject({
      decision: "allow",
      error: null,
      operation: "update_content",
      result: {
        contentId: fixture.contentId,
        resourceVersion: 2,
        revisionId: null,
      },
      status: "succeeded",
    });

    const persisted = await postgres.sql<
      {
        current_revision_id: string;
        revision_count: number;
        symbol_count: number;
        version: number;
      }[]
    >`
      select
        content.current_revision_id,
        content.version::integer as version,
        (
          select count(*)::integer
          from platform.content_revisions as revision
          where revision.content_id = content.id
        ) as revision_count,
        (
          select count(*)::integer
          from platform.content_symbols as symbol
          where symbol.content_id = content.id
        ) as symbol_count
      from platform.content_items as content
      where content.id = ${fixture.contentId}
    `;
    expect(persisted).toEqual([
      {
        current_revision_id: fixture.revisionId,
        revision_count: 1,
        symbol_count: 0,
        version: 2,
      },
    ]);

    const revisedEvents = await postgres.sql<{ payload: unknown }[]>`
      select payload
      from system.outbox_events
      where aggregate_type = 'content'
        and aggregate_id = ${fixture.contentId}
        and event_type = 'content.revised'
    `;
    expect(revisedEvents).toHaveLength(1);
    expect(asRecord(revisedEvents[0]?.payload)).toMatchObject({
      changed_groups: ["symbols"],
      content_id: fixture.contentId,
      resource_version: 2,
      revision_id: null,
    });
  });

  it("persists a version conflict without orphaning any requested facts", async () => {
    const oldSourceUrl = `https://evidence.example.test/${marker}/conflict-old`;
    const newSourceUrl = `https://evidence.example.test/${marker}/conflict-new`;
    const idempotencyKey = `update-conflict-${randomUUID()}`;
    const fixture = await createAutonomousUpdateFixture({
      communityId: semiconductorsCommunityId,
      label: `conflict-${randomUUID()}`,
      references: [{ relationType: "reference", targetContentId: referenceContentId }],
      sourceLinks: [{ url: oldSourceUrl }],
    });

    const conflicted = await service.updateContent(
      autonomousContext,
      {
        contentId: fixture.contentId,
        expectedVersion: 2,
        idempotencyKey,
        patch: {
          bodyMarkdown: "This stale update must not leave any public facts behind.",
          references: [{ relationType: "quote", targetContentId: referenceContentId }],
          sourceLinks: [{ url: newSourceUrl }],
        },
      },
      { requestId: `req-${randomUUID()}` },
    );

    expect(conflicted).toMatchObject({
      decision: "allow",
      error: {
        code: "VERSION_CONFLICT",
        details: { current_version: 1, expected_version: 2 },
        retryable: false,
      },
      operation: "update_content",
      pendingAction: null,
      result: null,
      status: "failed",
    });

    const persisted = await postgres.sql<
      {
        active_reference_count: number;
        active_source_count: number;
        current_revision_id: string;
        new_source_count: number;
        revised_event_count: number;
        revision_count: number;
        version: number;
      }[]
    >`
      select
        content.current_revision_id,
        content.version::integer as version,
        (
          select count(*)::integer
          from platform.content_revisions as revision
          where revision.content_id = content.id
        ) as revision_count,
        (
          select count(*)::integer
          from platform.source_links as source
          where source.content_id = content.id
            and source.removed_revision_id is null
        ) as active_source_count,
        (
          select count(*)::integer
          from platform.source_links as source
          where source.content_id = content.id
            and source.url = ${newSourceUrl}
        ) as new_source_count,
        (
          select count(*)::integer
          from platform.content_relations as relation
          where relation.from_content_id = content.id
            and relation.removed_revision_id is null
        ) as active_reference_count,
        (
          select count(*)::integer
          from system.outbox_events as event
          where event.aggregate_type = 'content'
            and event.aggregate_id = content.id::text
            and event.event_type = 'content.revised'
        ) as revised_event_count
      from platform.content_items as content
      where content.id = ${fixture.contentId}
    `;
    expect(persisted).toEqual([
      {
        active_reference_count: 1,
        active_source_count: 1,
        current_revision_id: fixture.revisionId,
        new_source_count: 0,
        revised_event_count: 0,
        revision_count: 1,
        version: 1,
      },
    ]);

    const terminalFailure = await postgres.sql<
      { resource_id: string | null; response_code: number; status: string }[]
    >`
      select resource_id, response_code, status
      from platform.idempotency_records
      where principal_scope_key = ${`credential:${autonomousContext.credential.id}`}
        and operation = 'update_content'
        and idempotency_key = ${idempotencyKey}
    `;
    expect(terminalFailure).toEqual([
      { resource_id: null, response_code: 409, status: "failed" },
    ]);
  });

  it("does not allow a different Agent to edit another Agent's content", async () => {
    const fixture = await createAutonomousUpdateFixture({
      communityId: earningsCommunityId,
      label: `foreign-author-${randomUUID()}`,
    });

    const attempted = await service.updateContent(
      assistedContext,
      {
        contentId: fixture.contentId,
        expectedVersion: 1,
        idempotencyKey: `update-foreign-author-${randomUUID()}`,
        patch: { bodyMarkdown: "A different Agent must not replace this body." },
      },
      { requestId: `req-${randomUUID()}` },
    );

    expect(attempted).toMatchObject({
      decision: "require_approval",
      error: { code: "NOT_CONTENT_AUTHOR", retryable: false },
      operation: "update_content",
      pendingAction: null,
      result: null,
      status: "failed",
    });

    const persisted = await postgres.sql<
      {
        current_revision_id: string;
        pending_count: number;
        revised_event_count: number;
        revision_count: number;
        version: number;
      }[]
    >`
      select
        content.current_revision_id,
        content.version::integer as version,
        (
          select count(*)::integer
          from platform.content_revisions as revision
          where revision.content_id = content.id
        ) as revision_count,
        (
          select count(*)::integer
          from platform.pending_actions as action
          where action.target_id = content.id
        ) as pending_count,
        (
          select count(*)::integer
          from system.outbox_events as event
          where event.aggregate_type = 'content'
            and event.aggregate_id = content.id::text
            and event.event_type = 'content.revised'
        ) as revised_event_count
      from platform.content_items as content
      where content.id = ${fixture.contentId}
    `;
    expect(persisted).toEqual([
      {
        current_revision_id: fixture.revisionId,
        pending_count: 0,
        revised_event_count: 0,
        revision_count: 1,
        version: 1,
      },
    ]);
  });

  it("executes an Owner-approved Assisted content update", async () => {
    const fixture = await insertPublishedUpdateFixture(
      assistedContext.agent.actorId,
      `assisted-approved-${randomUUID()}`,
    );
    const newBody = "Owner-approved Assisted Agent research revision.";
    const pending = await service.updateContent(
      assistedContext,
      {
        contentId: fixture.contentId,
        editSummary: "Owner approved this material research change.",
        expectedVersion: 1,
        idempotencyKey: `assisted-update-approved-${randomUUID()}`,
        patch: { bodyMarkdown: newBody },
      },
      { channel: "mcp", requestId: `req-${randomUUID()}` },
    );

    expect(pending).toMatchObject({
      decision: "require_approval",
      error: null,
      operation: "update_content",
      pendingAction: {
        expectedVersion: 1,
        operation: "update_content",
        state: "pending_approval",
      },
      result: null,
      status: "pending_approval",
    });
    const actionId = pending.pendingAction?.id;
    expectUuid(actionId);

    const beforeApproval = await postgres.sql<
      {
        current_revision_id: string;
        expected_version: number;
        revision_count: number;
        version: number;
      }[]
    >`
      select
        content.current_revision_id,
        content.version::integer as version,
        action.expected_version::integer as expected_version,
        (
          select count(*)::integer
          from platform.content_revisions as revision
          where revision.content_id = content.id
        ) as revision_count
      from platform.content_items as content
      join platform.pending_actions as action on action.target_id = content.id
      where content.id = ${fixture.contentId}
        and action.id = ${actionId}
    `;
    expect(beforeApproval).toEqual([
      {
        current_revision_id: fixture.revisionId,
        expected_version: 1,
        revision_count: 1,
        version: 1,
      },
    ]);

    const detail = await ownerActionService.getAction(
      assistedContext.owner.id,
      actionId,
      { requestId: `req-${randomUUID()}` },
    );
    expect(detail).toMatchObject({
      command: {
        contentId: fixture.contentId,
        editSummary: "Owner approved this material research change.",
        expectedVersion: 1,
        operation: "update_content",
        patch: { bodyMarkdown: newBody },
      },
      id: actionId,
      state: "pending_approval",
      version: 1,
    });
    await ownerActionService.approveAction(assistedContext.owner.id, actionId, {
      expectedVersion: detail.version,
      reasonCode: "owner_approved",
      requestId: `req-${randomUUID()}`,
    });

    const executionRepository = new PostgresPendingActionExecutionRepository(
      postgres.sql,
      {
        leaseOwner: `approved-update-integration:${randomUUID()}`,
        leaseSeconds: 30,
      },
    );
    const claim = await claimIsolatedAction(executionRepository, actionId);
    if (!claim) {
      throw new Error("The approved update was not available to the worker");
    }
    expect(claim).toMatchObject({ actionId, operation: "update_content" });

    const executed = await service.executeApprovedAction(executionRepository, claim);
    const revisionId = revisionIdOf(executed.content);
    expectUuid(revisionId);
    expect(executed.content).toEqual({
      contentId: fixture.contentId,
      resourceVersion: 2,
      revisionId,
    });
    expect(executed.action).toMatchObject({
      actionId,
      error: null,
      idempotencyStatus: "succeeded",
      operation: "update_content",
      resourceId: fixture.contentId,
      state: "succeeded",
    });

    const persisted = await postgres.sql<
      {
        body_markdown: string;
        current_revision_id: string;
        event_count: number;
        revision_count: number;
        source_version: number;
        version: number;
      }[]
    >`
      select
        content.current_revision_id,
        content.version::integer as version,
        revision.body_markdown,
        revision.source_version::integer as source_version,
        (
          select count(*)::integer
          from platform.content_revisions as history
          where history.content_id = content.id
        ) as revision_count,
        (
          select count(*)::integer
          from system.outbox_events as event
          where event.aggregate_type = 'content'
            and event.aggregate_id = content.id::text
            and event.event_type = 'content.revised'
        ) as event_count
      from platform.content_items as content
      join platform.content_revisions as revision
        on revision.id = content.current_revision_id
      where content.id = ${fixture.contentId}
    `;
    expect(persisted).toEqual([
      {
        body_markdown: newBody,
        current_revision_id: revisionId,
        event_count: 1,
        revision_count: 2,
        source_version: 2,
        version: 2,
      },
    ]);
  });

  it("invalidates an approved Assisted update when its version changes while waiting", async () => {
    const fixture = await insertPublishedUpdateFixture(
      assistedContext.agent.actorId,
      `assisted-stale-${randomUUID()}`,
    );
    const staleBody = "This approved body must not overwrite a newer revision.";
    const pending = await service.updateContent(
      assistedContext,
      {
        contentId: fixture.contentId,
        expectedVersion: 1,
        idempotencyKey: `assisted-update-stale-${randomUUID()}`,
        patch: { bodyMarkdown: staleBody },
      },
      { requestId: `req-${randomUUID()}` },
    );
    const actionId = pending.pendingAction?.id;
    expectUuid(actionId);
    expect(pending).toMatchObject({
      decision: "require_approval",
      operation: "update_content",
      pendingAction: { expectedVersion: 1 },
      status: "pending_approval",
    });

    const interveningRevisionId = randomUUID();
    const interveningBody = "A newer accepted revision arrived before approval.";
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.content_revisions (
          id,
          content_id,
          revision_number,
          title,
          body_markdown,
          body_plain_text,
          edit_summary,
          created_by_actor_id,
          source_version,
          content_hash,
          public_node_serialized_bytes
        )
        values (
          ${interveningRevisionId},
          ${fixture.contentId},
          2,
          'Intervening Assisted update fixture',
          ${interveningBody},
          ${interveningBody},
          'Simulated concurrent accepted revision.',
          ${assistedContext.agent.actorId},
          2,
          ${randomBytes(32)},
          512
        )
      `;
      await transaction`
        update platform.content_items
        set version = 2,
            current_revision_id = ${interveningRevisionId}
        where id = ${fixture.contentId}
      `;
    });

    const detail = await ownerActionService.getAction(
      assistedContext.owner.id,
      actionId,
      { requestId: `req-${randomUUID()}` },
    );
    await ownerActionService.approveAction(assistedContext.owner.id, actionId, {
      expectedVersion: detail.version,
      reasonCode: "owner_approved",
      requestId: `req-${randomUUID()}`,
    });

    const executionRepository = new PostgresPendingActionExecutionRepository(
      postgres.sql,
      {
        leaseOwner: `stale-update-integration:${randomUUID()}`,
        leaseSeconds: 30,
      },
    );
    const claim = await claimIsolatedAction(executionRepository, actionId);
    if (!claim) {
      throw new Error("The stale approved update was not available to the worker");
    }
    await expect(
      service.executeApprovedAction(executionRepository, claim),
    ).rejects.toMatchObject({
      code: "APPROVED_ACTION_CONTEXT_INVALID",
      disposition: "invalidate",
    });
    const invalidated = await executionRepository.markInvalidated(claim);
    expect(invalidated).toMatchObject({
      action: {
        actionId,
        error: {
          code: "ACTION_INVALIDATED",
          retryable: false,
        },
        idempotencyStatus: "failed",
        resourceId: null,
        state: "invalidated",
      },
      applied: true,
    });

    const persisted = await postgres.sql<
      {
        current_body: string;
        current_revision_id: string;
        revised_event_count: number;
        revision_count: number;
        stale_body_count: number;
        state: string;
        version: number;
      }[]
    >`
      select
        content.current_revision_id,
        content.version::integer as version,
        current_revision.body_markdown as current_body,
        action.state,
        (
          select count(*)::integer
          from platform.content_revisions as revision
          where revision.content_id = content.id
        ) as revision_count,
        (
          select count(*)::integer
          from platform.content_revisions as revision
          where revision.content_id = content.id
            and revision.body_markdown = ${staleBody}
        ) as stale_body_count,
        (
          select count(*)::integer
          from system.outbox_events as event
          where event.aggregate_type = 'content'
            and event.aggregate_id = content.id::text
            and event.event_type = 'content.revised'
        ) as revised_event_count
      from platform.content_items as content
      join platform.content_revisions as current_revision
        on current_revision.id = content.current_revision_id
      join platform.pending_actions as action on action.target_id = content.id
      where content.id = ${fixture.contentId}
        and action.id = ${actionId}
    `;
    expect(persisted).toEqual([
      {
        current_body: interveningBody,
        current_revision_id: interveningRevisionId,
        revised_event_count: 0,
        revision_count: 2,
        stale_body_count: 0,
        state: "invalidated",
        version: 2,
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
    const assistedContentBefore = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.content_items
      where author_actor_id = ${assistedContext.agent.actorId}
    `;
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
    expect(assistedContent).toEqual(assistedContentBefore);
    const catalogCommunity = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.communities
      where id = ${assistedSymbolCandidateId}
    `;
    expect(catalogCommunity).toEqual([{ count: 0 }]);
  });

  it("executes an Owner-approved Assisted post as one terminal workflow", async () => {
    const privateMarker = `owner-approved-${randomUUID()}`;
    const idempotencyKey = `approved-assisted-${randomUUID()}`;
    const createRequestId = `req-${randomUUID()}`;
    const detailRequestId = `req-${randomUUID()}`;
    const approvalRequestId = `req-${randomUUID()}`;
    const input = {
      bodyMarkdown: `${privateMarker}: publish only after explicit Owner approval.`,
      idempotencyKey,
      primaryCommunityId: generalCommunityId,
      title: "Owner-approved Assisted research",
    } as const;

    const pending = await service.createPost(assistedContext, input, {
      channel: "mcp",
      requestId: createRequestId,
    });
    expect(pending).toMatchObject({
      decision: "require_approval",
      error: null,
      operation: "create_post",
      pendingAction: {
        operation: "create_post",
        state: "pending_approval",
      },
      replayed: false,
      result: null,
      status: "pending_approval",
    });
    const actionId = pending.pendingAction?.id;
    expectUuid(actionId);

    const detail = await ownerActionService.getAction(
      assistedContext.owner.id,
      actionId,
      { requestId: detailRequestId },
    );
    expect(detail).toMatchObject({
      approvalOutcome: null,
      command: {
        bodyMarkdown: input.bodyMarkdown,
        operation: "create_post",
        primaryCommunityId: generalCommunityId,
        title: input.title,
      },
      decisionReasonCode: null,
      id: actionId,
      publicError: null,
      state: "pending_approval",
      terminalAt: null,
      version: 1,
    });
    expect(JSON.stringify(detail)).not.toContain(idempotencyKey);

    const approved = await ownerActionService.approveAction(
      assistedContext.owner.id,
      actionId,
      {
        expectedVersion: detail.version,
        reasonCode: "owner_approved",
        requestId: approvalRequestId,
      },
    );
    expect(approved).toMatchObject({
      approvalOutcome: "approved",
      decisionReasonCode: "owner_approved",
      id: actionId,
      publicError: null,
      state: "approved",
      terminalAt: null,
      version: 2,
    });

    const executionRepository = new PostgresPendingActionExecutionRepository(
      postgres.sql,
      {
        leaseOwner: `research-write-integration:${randomUUID()}`,
        leaseSeconds: 30,
      },
    );
    const claim = await claimIsolatedAction(executionRepository, actionId);
    if (!claim) {
      throw new Error("The approved Assisted action was not available to the worker");
    }
    expect(claim).toMatchObject({
      actionId,
      attemptCount: 1,
      operation: "create_post",
      version: "3",
    });

    const executed = await service.executeApprovedAction(executionRepository, claim);
    expect(executed.action).toMatchObject({
      actionId,
      attemptCount: 1,
      error: null,
      idempotencyStatus: "succeeded",
      operation: "create_post",
      state: "succeeded",
      version: "4",
    });
    const contentId = executed.content.contentId;
    const revisionId = revisionIdOf(executed.content);
    expectUuid(contentId);
    expectUuid(revisionId);
    expectUuid(executed.resolvedOutboxEventId);
    expect(executed.content).toEqual({
      contentId,
      resourceVersion: 1,
      revisionId,
    });
    expect(executed.action.resourceId).toBe(contentId);
    expect(executed.action.result).toEqual({
      content_id: contentId,
      resource_version: 1,
      revision_id: revisionId,
    });
    expect(executed.action.terminalAt).toBeInstanceOf(Date);

    const replay = await service.createPost(assistedContext, input, {
      channel: "rest",
      requestId: `req-${randomUUID()}`,
    });
    expect(replay).toMatchObject({
      decision: "require_approval",
      error: null,
      operation: "create_post",
      pendingAction: {
        id: actionId,
        operation: "create_post",
        state: "succeeded",
      },
      replayed: true,
      result: executed.content,
      status: "succeeded",
    });

    const terminal = await postgres.sql<
      {
        action_attempt_count: number;
        action_audit_id: string;
        action_completed_at: Date | null;
        action_decision_audit_id: string;
        action_error: unknown;
        action_result: unknown;
        action_state: string;
        action_terminal_at: Date | null;
        action_version: number;
        idempotency_pending_action_id: string;
        idempotency_resource_id: string;
        idempotency_response: unknown;
        idempotency_response_code: number;
        idempotency_status: string;
        idempotency_terminal_at: Date | null;
      }[]
    >`
      select
        action.state as action_state,
        action.version::integer as action_version,
        action.attempt_count as action_attempt_count,
        action.result as action_result,
        action.error as action_error,
        action.completed_at as action_completed_at,
        action.terminal_at as action_terminal_at,
        action.audit_id as action_audit_id,
        action.decision_audit_id as action_decision_audit_id,
        idempotency.status as idempotency_status,
        idempotency.response_code as idempotency_response_code,
        idempotency.response_body as idempotency_response,
        idempotency.pending_action_id as idempotency_pending_action_id,
        idempotency.resource_id as idempotency_resource_id,
        idempotency.terminal_at as idempotency_terminal_at
      from platform.pending_actions as action
      inner join platform.idempotency_records as idempotency
        on idempotency.id = action.idempotency_record_id
      where action.id = ${actionId}
    `;
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      action_attempt_count: 1,
      action_completed_at: expect.any(Date),
      action_error: null,
      action_result: {
        content_id: contentId,
        resource_version: 1,
        revision_id: revisionId,
      },
      action_state: "succeeded",
      action_terminal_at: expect.any(Date),
      action_version: 4,
      idempotency_pending_action_id: actionId,
      idempotency_resource_id: contentId,
      idempotency_response_code: 201,
      idempotency_status: "succeeded",
      idempotency_terminal_at: expect.any(Date),
    });
    expect(asRecord(terminal[0]?.idempotency_response)).toMatchObject({
      decision: "require_approval",
      operation: "create_post",
      pending_action: { id: actionId, state: "succeeded" },
      result: {
        content_id: contentId,
        resource_version: 1,
        revision_id: revisionId,
      },
      status: "succeeded",
      version: 1,
    });
    expect(terminal[0]?.action_completed_at?.valueOf()).toBe(
      terminal[0]?.action_terminal_at?.valueOf(),
    );
    expect(terminal[0]?.idempotency_terminal_at?.valueOf()).toBe(
      terminal[0]?.action_terminal_at?.valueOf(),
    );

    const content = await postgres.sql<
      {
        author_actor_id: string;
        body_markdown: string;
        content_id: string;
        current_revision_id: string;
        lifecycle_state: string;
        primary_community_id: string;
        revision_id: string;
        revision_number: number;
        title: string;
        version: number;
      }[]
    >`
      select
        item.id as content_id,
        item.author_actor_id,
        item.primary_community_id,
        item.current_revision_id,
        item.lifecycle_state,
        item.version::integer as version,
        revision.id as revision_id,
        revision.revision_number::integer as revision_number,
        revision.title,
        revision.body_markdown
      from platform.content_items as item
      inner join platform.content_revisions as revision
        on revision.id = item.current_revision_id
       and revision.content_id = item.id
      where item.id = ${contentId}
    `;
    expect(content).toEqual([
      {
        author_actor_id: assistedContext.agent.actorId,
        body_markdown: input.bodyMarkdown,
        content_id: contentId,
        current_revision_id: revisionId,
        lifecycle_state: "published",
        primary_community_id: generalCommunityId,
        revision_id: revisionId,
        revision_number: 1,
        title: input.title,
        version: 1,
      },
    ]);

    const attempt = await postgres.sql<
      {
        claim_audit_id: string;
        error_code: string | null;
        finish_audit_id: string;
        finished_at: Date | null;
        next_attempt_at: Date | null;
        outcome: string;
      }[]
    >`
      select
        outcome,
        error_code,
        finished_at,
        next_attempt_at,
        claim_audit_id,
        finish_audit_id
      from platform.pending_action_attempts
      where action_id = ${actionId}
        and attempt_number = 1
    `;
    expect(attempt).toEqual([
      {
        claim_audit_id: expect.any(String),
        error_code: null,
        finish_audit_id: expect.any(String),
        finished_at: expect.any(Date),
        next_attempt_at: null,
        outcome: "succeeded",
      },
    ]);
    expectUuid(attempt[0]?.claim_audit_id);
    expectUuid(attempt[0]?.finish_audit_id);

    const outbox = await postgres.sql<
      { aggregate_type: string; event_type: string; id: string; payload: unknown }[]
    >`
      select id, aggregate_type, event_type, payload
      from system.outbox_events
      where (aggregate_type = 'pending_action' and aggregate_id = ${actionId})
         or (aggregate_type = 'content' and aggregate_id = ${contentId})
      order by occurred_at, id
    `;
    expect(outbox.map(({ event_type }) => event_type).sort()).toEqual([
      "action.approved",
      "action.pending_approval",
      "action.resolved",
      "content.published",
    ]);
    const approvedOutbox = outbox.find(
      ({ event_type }) => event_type === "action.approved",
    );
    const contentOutbox = outbox.find(
      ({ event_type }) => event_type === "content.published",
    );
    const resolvedOutbox = outbox.find(
      ({ event_type }) => event_type === "action.resolved",
    );
    expectUuid(approvedOutbox?.id);
    expectUuid(contentOutbox?.id);
    expect(resolvedOutbox?.id);
    expect(resolvedOutbox?.id).toBe(executed.resolvedOutboxEventId);
    expect(asRecord(contentOutbox?.payload)).toMatchObject({
      actor_id: assistedContext.agent.actorId,
      content_id: contentId,
      revision_id: revisionId,
    });
    expect(asRecord(resolvedOutbox?.payload)).toMatchObject({
      action_id: actionId,
      correlated_outbox_event_id: contentOutbox?.id,
      resource_id: contentId,
      state: "succeeded",
    });

    const audits = await postgres.sql<
      {
        action: string;
        approval_method: string | null;
        approved_by_owner_id: string | null;
        authentication_assurance: string | null;
        event_class: string;
        id: string;
        outbox_event_id: string | null;
        outcome: string;
        request_id: string;
        target_id: string;
      }[]
    >`
      select
        id,
        event_class,
        action,
        target_id,
        outcome,
        request_id,
        outbox_event_id,
        approval_method,
        approved_by_owner_id,
        authentication_assurance
      from platform.action_logs
      where owner_id = ${assistedContext.owner.id}
        and (
          request_id in (${createRequestId}, ${detailRequestId}, ${approvalRequestId})
          or target_id in (${actionId}, ${contentId})
        )
      order by occurred_at, id
    `;
    expect(audits.map(({ action }) => action).sort()).toEqual([
      "content.create_post",
      "content.create_post",
      "pending_action.approve",
      "pending_action.claimed",
      "pending_action.read",
      "pending_action.succeeded",
    ]);
    const initialAudit = audits.find(({ request_id }) => request_id === createRequestId);
    const readAudit = audits.find(({ request_id }) => request_id === detailRequestId);
    const approvalAudit = audits.find(
      ({ request_id }) => request_id === approvalRequestId,
    );
    const claimAudit = audits.find(({ action }) => action === "pending_action.claimed");
    const executionAudit = audits.find(
      ({ action, outcome }) =>
        action === "content.create_post" && outcome === "succeeded",
    );
    const finishAudit = audits.find(
      ({ action }) => action === "pending_action.succeeded",
    );
    expect(initialAudit).toMatchObject({
      event_class: "domain_write",
      outcome: "pending",
      target_id: generalCommunityId,
    });
    expect(readAudit).toMatchObject({
      event_class: "sensitive_read",
      outcome: "succeeded",
      target_id: actionId,
    });
    expect(approvalAudit).toMatchObject({
      approval_method: "owner_approval",
      approved_by_owner_id: assistedContext.owner.id,
      authentication_assurance: "owner_session",
      event_class: "approval_transition",
      outbox_event_id: approvedOutbox?.id,
      outcome: "pending",
      target_id: actionId,
    });
    expect(claimAudit).toMatchObject({
      event_class: "pending_action_transition",
      outcome: "pending",
      target_id: actionId,
    });
    expect(executionAudit).toMatchObject({
      approval_method: "owner_approval",
      approved_by_owner_id: assistedContext.owner.id,
      authentication_assurance: "owner_approval_record",
      event_class: "domain_write",
      outbox_event_id: contentOutbox?.id,
      outcome: "succeeded",
      target_id: contentId,
    });
    expect(finishAudit).toMatchObject({
      event_class: "pending_action_transition",
      outbox_event_id: resolvedOutbox?.id,
      outcome: "succeeded",
      target_id: actionId,
    });
    expect(initialAudit?.id).toBe(terminal[0]?.action_audit_id);
    expect(approvalAudit?.id).toBe(terminal[0]?.action_decision_audit_id);
    expect(claimAudit?.id).toBe(attempt[0]?.claim_audit_id);
    expect(finishAudit?.id).toBe(attempt[0]?.finish_audit_id);

    const uniqueEffects = await postgres.sql<
      {
        actions: number;
        attempts: number;
        contents: number;
        idempotency_records: number;
        revisions: number;
      }[]
    >`
      select
        (
          select count(*)::integer
          from platform.pending_actions
          where id = ${actionId}
        ) as actions,
        (
          select count(*)::integer
          from platform.pending_action_attempts
          where action_id = ${actionId}
        ) as attempts,
        (
          select count(*)::integer
          from platform.content_items
          where id = ${contentId}
        ) as contents,
        (
          select count(*)::integer
          from platform.content_revisions
          where content_id = ${contentId}
        ) as revisions,
        (
          select count(*)::integer
          from platform.idempotency_records
          where principal_scope_key = ${`credential:${assistedContext.credential.id}`}
            and operation = 'create_post'
            and idempotency_key = ${idempotencyKey}
        ) as idempotency_records
    `;
    expect(uniqueEffects).toEqual([
      {
        actions: 1,
        attempts: 1,
        contents: 1,
        idempotency_records: 1,
        revisions: 1,
      },
    ]);
  });

  it("renews a live lease while a fenced execution transaction remains open", async () => {
    const privateMarker = `heartbeat-fence-${randomUUID()}`;
    const input = {
      bodyMarkdown: `${privateMarker}: a lease-renewal regression fixture.`,
      idempotencyKey: `heartbeat-fence-${randomUUID()}`,
      primaryCommunityId: generalCommunityId,
      title: "Long-running approved action heartbeat",
    } as const;
    const pending = await service.createPost(assistedContext, input, {
      requestId: `req-${randomUUID()}`,
    });
    const actionId = pending.pendingAction?.id;
    expectUuid(actionId);
    const detail = await ownerActionService.getAction(
      assistedContext.owner.id,
      actionId,
      { requestId: `req-${randomUUID()}` },
    );
    await ownerActionService.approveAction(assistedContext.owner.id, actionId, {
      expectedVersion: detail.version,
      reasonCode: "owner_approved",
      requestId: `req-${randomUUID()}`,
    });

    const executionRepository = new PostgresPendingActionExecutionRepository(
      postgres.sql,
      {
        leaseOwner: `heartbeat-fence-integration:${randomUUID()}`,
        leaseSeconds: 2,
      },
    );
    const claim = await claimIsolatedAction(executionRepository, actionId);
    if (!claim) {
      throw new Error("The heartbeat action was not available to the worker");
    }
    const originalLeaseExpiresAt = claim.leaseExpiresAt;
    let renewedLeaseExpiresAt: Date | null = null;

    const fencedResult = await withTimeout(
      executionRepository.withFencedClaim(claim, async (_transaction, action) => {
        expect(action.actionId).toBe(actionId);
        const heartbeatDelayMs = Math.max(
          0,
          originalLeaseExpiresAt.valueOf() - Date.now() - 1_000,
        );
        await new Promise<void>((resolve) => {
          setTimeout(resolve, heartbeatDelayMs);
        });
        const heartbeat = await withTimeout(
          executionRepository.renewHeartbeat(claim),
          1_500,
          "The heartbeat was blocked by the fenced execution transaction",
        );
        expect(heartbeat).toMatchObject({
          action: null,
          renewed: true,
        });
        renewedLeaseExpiresAt = heartbeat.leaseExpiresAt;
        expect(renewedLeaseExpiresAt).toBeInstanceOf(Date);
        expect(renewedLeaseExpiresAt?.valueOf()).toBeGreaterThan(
          originalLeaseExpiresAt.valueOf(),
        );

        const crossOriginalLeaseDelayMs = Math.max(
          0,
          originalLeaseExpiresAt.valueOf() - Date.now() + 100,
        );
        await new Promise<void>((resolve) => {
          setTimeout(resolve, crossOriginalLeaseDelayMs);
        });
        return action.actionId;
      }),
      7_000,
      "The fenced execution transaction did not complete after its heartbeat",
    );
    expect(fencedResult).toBe(actionId);

    await expect(
      executionRepository.withFencedClaim(claim, async (_transaction, action) =>
        Promise.resolve(action.actionId),
      ),
    ).resolves.toBe(actionId);
    const invalidated = await executionRepository.markInvalidated(claim);
    expect(invalidated).toMatchObject({
      action: {
        actionId,
        state: "invalidated",
      },
      applied: true,
    });

    const effects = await postgres.sql<{ content_count: number; state: string }[]>`
      select
        action.state,
        (
          select count(*)::integer
          from platform.content_revisions as revision
          join platform.content_items as item on item.id = revision.content_id
          where item.author_actor_id = ${assistedContext.agent.actorId}
            and revision.body_markdown = ${input.bodyMarkdown}
        ) as content_count
      from platform.pending_actions as action
      where action.id = ${actionId}
    `;
    expect(effects).toEqual([{ content_count: 0, state: "invalidated" }]);
  }, 15_000);

  it("waits for a concurrent Owner suspension and invalidates before publishing", async () => {
    const privateMarker = `suspended-owner-${randomUUID()}`;
    const input = {
      bodyMarkdown: `${privateMarker}: this must never become public content.`,
      idempotencyKey: `suspended-owner-${randomUUID()}`,
      primaryCommunityId: generalCommunityId,
      title: "Authority race must invalidate this post",
    } as const;
    const pending = await service.createPost(assistedContext, input, {
      requestId: `req-${randomUUID()}`,
    });
    const actionId = pending.pendingAction?.id;
    expectUuid(actionId);
    const detail = await ownerActionService.getAction(
      assistedContext.owner.id,
      actionId,
      { requestId: `req-${randomUUID()}` },
    );
    await ownerActionService.approveAction(assistedContext.owner.id, actionId, {
      expectedVersion: detail.version,
      reasonCode: "owner_approved",
      requestId: `req-${randomUUID()}`,
    });

    const executionRepository = new PostgresPendingActionExecutionRepository(
      postgres.sql,
      {
        leaseOwner: `authority-race-integration:${randomUUID()}`,
        leaseSeconds: 30,
      },
    );
    const claim = await claimIsolatedAction(executionRepository, actionId);
    if (!claim) {
      throw new Error("The authority-race action was not available to the worker");
    }
    expect(claim.actionId).toBe(actionId);

    try {
      const concurrent = await competingPostgres.sql.begin(async (transaction) => {
        await transaction`
          update platform.owners
          set status = 'suspended',
              restriction_reason_code = 'integration_authority_race',
              suspended_at = clock_timestamp()
          where id = ${assistedContext.owner.id}
        `;

        const executionPromise = service.executeApprovedAction(
          executionRepository,
          claim,
        );
        const settledWhileLocked = await Promise.race([
          executionPromise.then(
            () => true,
            () => true,
          ),
          new Promise<false>((resolve) => {
            setTimeout(() => resolve(false), 200);
          }),
        ]);
        return { executionPromise, settledWhileLocked };
      });

      expect(concurrent.settledWhileLocked).toBe(false);
      let executionError: unknown = null;
      try {
        await concurrent.executionPromise;
      } catch (error) {
        executionError = error;
      }
      if (!(executionError instanceof ApprovedResearchExecutionError)) {
        throw new Error("The suspended Owner did not produce a sanitized error", {
          cause: executionError,
        });
      }
      expect(executionError).toMatchObject({
        code: "APPROVED_ACTION_CONTEXT_INVALID",
        disposition: "invalidate",
        message: "The approved action is no longer valid.",
        retryAfterMs: null,
      });
      expect(executionError.message).not.toContain(privateMarker);
      expect(executionError.message).not.toContain(assistedContext.owner.id);

      const invalidated = await executionRepository.markInvalidated(claim);
      expect(invalidated).toMatchObject({
        action: {
          actionId,
          error: {
            code: "ACTION_INVALIDATED",
            details: null,
            retry_after_ms: null,
            retryable: false,
          },
          idempotencyStatus: "failed",
          resourceId: null,
          state: "invalidated",
        },
        applied: true,
      });

      const effects = await postgres.sql<
        {
          attempt_outcome: string;
          content_count: number;
          execution_audits: number;
          idempotency_resource_id: string | null;
          idempotency_status: string;
          state: string;
        }[]
      >`
        select
          action.state,
          attempt.outcome as attempt_outcome,
          idempotency.status as idempotency_status,
          idempotency.resource_id as idempotency_resource_id,
          (
            select count(*)::integer
            from platform.content_revisions as revision
            join platform.content_items as item on item.id = revision.content_id
            where item.author_actor_id = ${assistedContext.agent.actorId}
              and revision.body_markdown = ${input.bodyMarkdown}
          ) as content_count,
          (
            select count(*)::integer
            from platform.action_logs
            where request_id = ${`worker:pending-action:${actionId}:attempt:${claim.attemptCount}`}
              and event_class = 'domain_write'
          ) as execution_audits
        from platform.pending_actions as action
        join platform.pending_action_attempts as attempt
          on attempt.action_id = action.id
         and attempt.attempt_number = ${claim.attemptCount}
        join platform.idempotency_records as idempotency
          on idempotency.id = action.idempotency_record_id
        where action.id = ${actionId}
      `;
      expect(effects).toEqual([
        {
          attempt_outcome: "invalidated",
          content_count: 0,
          execution_audits: 0,
          idempotency_resource_id: null,
          idempotency_status: "failed",
          state: "invalidated",
        },
      ]);
    } finally {
      await competingPostgres.sql`
        update platform.owners
        set status = 'active',
            restriction_reason_code = null,
            restricted_at = null,
            suspended_at = null
        where id = ${assistedContext.owner.id}
      `;
    }

    const restoredOwner = await postgres.sql<
      {
        restriction_reason_code: string | null;
        status: string;
        suspended_at: Date | null;
      }[]
    >`
      select status, restriction_reason_code, suspended_at
      from platform.owners
      where id = ${assistedContext.owner.id}
    `;
    expect(restoredOwner).toEqual([
      {
        restriction_reason_code: null,
        status: "active",
        suspended_at: null,
      },
    ]);
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

  it("rolls back catalog Community materialization when later update facts are invalid", async () => {
    const catalogMarker = randomUUID().replaceAll("-", "").slice(0, 10);
    const catalogCommunityId = randomUUID();
    const catalogSymbolId = randomUUID();
    const catalogTicker = `Q${catalogMarker.slice(0, 8).toUpperCase()}`;
    await postgres.sql`
      insert into platform.symbols (
        id,
        community_candidate_id,
        ticker,
        exchange,
        name
      )
      values (
        ${catalogSymbolId},
        ${catalogCommunityId},
        ${catalogTicker},
        'TEST',
        'Failed update materialization integration symbol'
      )
    `;
    const fixture = await insertPublishedUpdateFixture(
      autonomousContext.agent.actorId,
      `catalog-rollback-${randomUUID()}`,
    );

    const invalidTopic = `missing-topic-${catalogMarker}`;
    const topicFailure = await service.updateContent(
      autonomousContext,
      {
        contentId: fixture.contentId,
        expectedVersion: 1,
        idempotencyKey: `catalog-invalid-topic-${randomUUID()}`,
        patch: {
          additionalCommunityIds: [catalogCommunityId],
          topics: [invalidTopic],
        },
      },
      { requestId: `req-${randomUUID()}` },
    );
    expect(topicFailure).toMatchObject({
      decision: "allow",
      error: {
        code: "VALIDATION_ERROR",
        details: { field: "topics", topic: invalidTopic },
      },
      operation: "update_content",
      result: null,
      status: "failed",
    });

    const invalidReferenceId = randomUUID();
    const referenceFailure = await service.updateContent(
      autonomousContext,
      {
        contentId: fixture.contentId,
        expectedVersion: 1,
        idempotencyKey: `catalog-invalid-reference-${randomUUID()}`,
        patch: {
          additionalCommunityIds: [catalogCommunityId],
          references: [
            { relationType: "reference", targetContentId: invalidReferenceId },
          ],
        },
      },
      { requestId: `req-${randomUUID()}` },
    );
    expect(referenceFailure).toMatchObject({
      decision: "allow",
      error: { code: "CONTENT_NOT_FOUND" },
      operation: "update_content",
      result: null,
      status: "failed",
    });

    const state = await postgres.sql<
      {
        additional_mapping_count: number;
        catalog_community_count: number;
        catalog_symbol_mapping_count: number;
        current_revision_id: string;
        revised_event_count: number;
        revision_count: number;
        version: number;
      }[]
    >`
      select
        content.current_revision_id,
        content.version::integer as version,
        (
          select count(*)::integer
          from platform.content_revisions as revision
          where revision.content_id = content.id
        ) as revision_count,
        (
          select count(*)::integer
          from platform.communities as community
          where community.id = ${catalogCommunityId}
        ) as catalog_community_count,
        (
          select count(*)::integer
          from platform.community_symbols as mapping
          where mapping.community_id = ${catalogCommunityId}
             or mapping.symbol_id = ${catalogSymbolId}
        ) as catalog_symbol_mapping_count,
        (
          select count(*)::integer
          from platform.content_additional_communities as additional
          where additional.content_id = content.id
            and additional.community_id = ${catalogCommunityId}
        ) as additional_mapping_count,
        (
          select count(*)::integer
          from system.outbox_events as event
          where event.aggregate_type = 'content'
            and event.aggregate_id = content.id::text
            and event.event_type = 'content.revised'
        ) as revised_event_count
      from platform.content_items as content
      where content.id = ${fixture.contentId}
    `;
    expect(state).toEqual([
      {
        additional_mapping_count: 0,
        catalog_community_count: 0,
        catalog_symbol_mapping_count: 0,
        current_revision_id: fixture.revisionId,
        revised_event_count: 0,
        revision_count: 1,
        version: 1,
      },
    ]);
  });

  it("counts a newly added Community from its admission time instead of the old post time", async () => {
    const admissionMarker = randomUUID().replaceAll("-", "").slice(0, 10);
    const admissionCommunityId = randomUUID();
    const admissionTopicId = randomUUID();
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.topics (id, slug, name, description)
        values (
          ${admissionTopicId},
          ${`admission-${admissionMarker}`},
          'Additional placement admission fixture',
          'Proves that an old post consumes quota when newly placed.'
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
        values (
          ${admissionCommunityId},
          ${`admission-${admissionMarker}`},
          'Additional placement quota Community',
          'A one-admission-per-hour integration fixture.',
          'topic',
          ${transaction.json({
            allowed_content: ["investment-research", "discussion"],
            max_posts_per_hour: 1,
            replies_open: true,
            requires_sources: false,
          })},
          ${transaction.json({ integration_fixture: admissionMarker })}
        )
      `;
      await transaction`
        insert into platform.community_topics (community_id, topic_id, is_primary)
        values (${admissionCommunityId}, ${admissionTopicId}, true)
      `;
    });

    const publishedAt = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    const fixture = await insertPublishedUpdateFixture(
      autonomousContext.agent.actorId,
      `old-community-admission-${randomUUID()}`,
      publishedAt,
    );
    const admitted = await service.updateContent(
      autonomousContext,
      {
        contentId: fixture.contentId,
        expectedVersion: 1,
        idempotencyKey: `old-community-admission-${randomUUID()}`,
        patch: { additionalCommunityIds: [admissionCommunityId] },
      },
      { requestId: `req-${randomUUID()}` },
    );
    expect(admitted).toMatchObject({
      decision: "allow",
      operation: "update_content",
      result: {
        contentId: fixture.contentId,
        resourceVersion: 2,
        revisionId: null,
      },
      status: "succeeded",
    });

    const rejectedKey = `recent-additional-admission-${randomUUID()}`;
    const rejected = await service.createPost(
      autonomousContext,
      {
        bodyMarkdown:
          "This post must be rejected because the old post was admitted recently.",
        idempotencyKey: rejectedKey,
        primaryCommunityId: admissionCommunityId,
        title: "Recent additional placement consumes Community quota",
      },
      { requestId: `req-${randomUUID()}` },
    );
    expect(rejected).toMatchObject({
      decision: "deny",
      error: {
        code: "RATE_LIMITED",
        details: { community_id: admissionCommunityId },
        retryable: true,
      },
      pendingAction: null,
      result: null,
      status: "denied",
    });
    expect(rejected.error?.retryAfterMs).toBeGreaterThan(0);

    const state = await postgres.sql<
      {
        admitted_after_publication_window: boolean;
        idempotency_count: number;
        mapping_count: number;
        primary_post_count: number;
        revision_count: number;
        version: number;
      }[]
    >`
      select
        content.version::integer as version,
        additional.created_at > content.published_at + interval '1 hour'
          as admitted_after_publication_window,
        (
          select count(*)::integer
          from platform.content_additional_communities as mapping
          where mapping.content_id = content.id
            and mapping.community_id = ${admissionCommunityId}
        ) as mapping_count,
        (
          select count(*)::integer
          from platform.content_revisions as revision
          where revision.content_id = content.id
        ) as revision_count,
        (
          select count(*)::integer
          from platform.content_items as attempted
          where attempted.author_actor_id = ${autonomousContext.agent.actorId}
            and attempted.primary_community_id = ${admissionCommunityId}
        ) as primary_post_count,
        (
          select count(*)::integer
          from platform.idempotency_records as idempotency
          where idempotency.principal_scope_key = ${`credential:${autonomousContext.credential.id}`}
            and idempotency.operation = 'create_post'
            and idempotency.idempotency_key = ${rejectedKey}
        ) as idempotency_count
      from platform.content_items as content
      join platform.content_additional_communities as additional
        on additional.content_id = content.id
       and additional.community_id = ${admissionCommunityId}
      where content.id = ${fixture.contentId}
    `;
    expect(state).toEqual([
      {
        admitted_after_publication_window: true,
        idempotency_count: 0,
        mapping_count: 1,
        primary_post_count: 0,
        revision_count: 1,
        version: 2,
      },
    ]);
  });

  it("retries the same update idempotency key after its rate window clears", async () => {
    // Keep the injected domain clock behind PostgreSQL's clock_timestamp():
    // idempotency update triggers own updated_at and require chronological rows.
    let rateClock = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    const rateService = new PostgresResearchWriteService(postgres.sql, {
      clock: () => rateClock,
      pendingActionKeyRing,
    });
    const fixture = await insertPublishedUpdateFixture(
      autonomousContext.agent.actorId,
      `update-rate-${randomUUID()}`,
    );

    for (let index = 0; index < 10; index += 1) {
      const symbols = index % 2 === 0 ? ["AMD"] : [];
      const updated = await rateService.updateContent(
        autonomousContext,
        {
          contentId: fixture.contentId,
          expectedVersion: index + 1,
          idempotencyKey: `update-rate-primer-${index}-${randomUUID()}`,
          patch: { symbols },
        },
        { requestId: `req-${randomUUID()}` },
      );
      expect(updated).toMatchObject({
        decision: "allow",
        result: {
          contentId: fixture.contentId,
          resourceVersion: index + 2,
          revisionId: null,
        },
        status: "succeeded",
      });
    }

    const idempotencyKey = `update-rate-retry-${randomUUID()}`;
    const input = {
      contentId: fixture.contentId,
      expectedVersion: 11,
      idempotencyKey,
      patch: { symbols: ["AMD"] },
    } as const;
    const limited = await rateService.updateContent(autonomousContext, input, {
      requestId: `req-${randomUUID()}`,
    });
    expect(limited).toMatchObject({
      decision: "deny",
      error: {
        code: "RATE_LIMITED",
        details: { limit: 10, limit_dimension: "content_updates" },
        retryable: true,
      },
      operation: "update_content",
      pendingAction: null,
      replayed: false,
      result: null,
      status: "denied",
    });
    expect(limited.error?.retryAfterMs).toBeGreaterThan(0);

    const limitedState = await postgres.sql<
      {
        idempotency_count: number;
        rate_limited_log_count: number;
        symbol_count: number;
        succeeded_update_log_count: number;
        version: number;
      }[]
    >`
      select
        content.version::integer as version,
        (
          select count(*)::integer
          from platform.content_symbols as symbol
          where symbol.content_id = content.id
        ) as symbol_count,
        (
          select count(*)::integer
          from platform.action_logs as log
          where log.action = 'content.update_content'
            and log.target_id = content.id::text
            and log.outcome = 'succeeded'
        ) as succeeded_update_log_count,
        (
          select count(*)::integer
          from platform.action_logs as log
          where log.action = 'content.update_content'
            and log.target_id = content.id::text
            and log.decision = 'deny'
            and log.outcome = 'denied'
            and log.error_code = 'RATE_LIMITED'
        ) as rate_limited_log_count,
        (
          select count(*)::integer
          from platform.idempotency_records as idempotency
          where idempotency.principal_scope_key = ${`credential:${autonomousContext.credential.id}`}
            and idempotency.operation = 'update_content'
            and idempotency.idempotency_key = ${idempotencyKey}
        ) as idempotency_count
      from platform.content_items as content
      where content.id = ${fixture.contentId}
    `;
    expect(limitedState).toEqual([
      {
        idempotency_count: 0,
        rate_limited_log_count: 1,
        symbol_count: 0,
        succeeded_update_log_count: 10,
        version: 11,
      },
    ]);

    rateClock = new Date(rateClock.valueOf() + 61 * 60 * 1_000);
    const retried = await rateService.updateContent(autonomousContext, input, {
      requestId: `req-${randomUUID()}`,
    });
    expect(retried).toMatchObject({
      decision: "allow",
      error: null,
      operation: "update_content",
      pendingAction: null,
      replayed: false,
      result: {
        contentId: fixture.contentId,
        resourceVersion: 12,
        revisionId: null,
      },
      status: "succeeded",
    });

    const terminal = await postgres.sql<
      {
        idempotency_count: number;
        rate_limited_log_count: number;
        resource_id: string;
        response_code: number;
        status: string;
        symbol_count: number;
        succeeded_update_log_count: number;
        version: number;
      }[]
    >`
      select
        content.version::integer as version,
        idempotency.status,
        idempotency.response_code,
        idempotency.resource_id,
        (
          select count(*)::integer
          from platform.content_symbols as symbol
          where symbol.content_id = content.id
        ) as symbol_count,
        (
          select count(*)::integer
          from platform.action_logs as log
          where log.action = 'content.update_content'
            and log.target_id = content.id::text
            and log.outcome = 'succeeded'
        ) as succeeded_update_log_count,
        (
          select count(*)::integer
          from platform.action_logs as log
          where log.action = 'content.update_content'
            and log.target_id = content.id::text
            and log.decision = 'deny'
            and log.outcome = 'denied'
            and log.error_code = 'RATE_LIMITED'
        ) as rate_limited_log_count,
        (
          select count(*)::integer
          from platform.idempotency_records as matching
          where matching.principal_scope_key = ${`credential:${autonomousContext.credential.id}`}
            and matching.operation = 'update_content'
            and matching.idempotency_key = ${idempotencyKey}
        ) as idempotency_count
      from platform.content_items as content
      join platform.idempotency_records as idempotency
        on idempotency.resource_id = content.id
       and idempotency.principal_scope_key = ${`credential:${autonomousContext.credential.id}`}
       and idempotency.operation = 'update_content'
       and idempotency.idempotency_key = ${idempotencyKey}
      where content.id = ${fixture.contentId}
    `;
    expect(terminal).toEqual([
      {
        idempotency_count: 1,
        rate_limited_log_count: 1,
        resource_id: fixture.contentId,
        response_code: 200,
        status: "succeeded",
        symbol_count: 1,
        succeeded_update_log_count: 11,
        version: 12,
      },
    ]);
  });

  it("enforces the default new-Agent post quota on real persisted writes", async () => {
    const rateMarker = randomUUID().replaceAll("-", "").slice(0, 10);
    const ownerId = await createVerifiedOwner(`agent-rate-${rateMarker}`);
    const agent = await agentService.createAgent(
      ownerId,
      {
        displayName: "Default Rate Integration Agent",
        handle: `agent-rate-${rateMarker}`,
      },
      randomUUID(),
    );
    await activatePolicy(ownerId, agent.agent.id, "autonomous");
    const credential = await agentService.createCredential(
      ownerId,
      agent.agent.id,
      {
        name: "Default Agent rate integration",
        scopes: ["research:read", "content:write"],
      },
      randomUUID(),
    );
    const context = await agentService.authenticateStaticApiKey(credential.apiKey);
    const rateService = new PostgresResearchWriteService(postgres.sql, {
      pendingActionKeyRing,
    });

    for (let index = 1; index <= 2; index += 1) {
      const accepted = await rateService.createPost(
        context,
        {
          bodyMarkdown: `Default new-Agent quota accepted post ${index}.`,
          idempotencyKey: `agent-rate-accepted-${index}-${randomUUID()}`,
          primaryCommunityId: generalCommunityId,
          title: `Accepted default Agent quota post ${index}`,
        },
        { requestId: `req-${randomUUID()}` },
      );
      expect(accepted).toMatchObject({
        decision: "allow",
        replayed: false,
        status: "succeeded",
      });
    }

    const rejectedKey = `agent-rate-rejected-${randomUUID()}`;
    const rejected = await rateService.createPost(
      context,
      {
        bodyMarkdown: "The third new-Agent post must remain outside the rolling window.",
        idempotencyKey: rejectedKey,
        primaryCommunityId: generalCommunityId,
        title: "Rejected default Agent quota post",
      },
      { requestId: `req-${randomUUID()}` },
    );
    expect(rejected).toMatchObject({
      decision: "deny",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 2,
          limit_dimension: "agent_post_hour",
          new_agent_window: true,
          rule_version: "agent-content-rate-v1",
        },
        retryable: true,
      },
      pendingAction: null,
      replayed: false,
      result: null,
      status: "denied",
    });

    const state = await postgres.sql<
      {
        admitted_content: number;
        rejected_idempotency: number;
        rate_denials: number;
        succeeded_actions: number;
      }[]
    >`
      select
        (
          select count(*)::integer
          from platform.content_items
          where author_actor_id = ${context.agent.actorId}
            and kind = 'post'
        ) as admitted_content,
        (
          select count(*)::integer
          from platform.idempotency_records
          where principal_scope_key = ${`credential:${context.credential.id}`}
            and operation = 'create_post'
            and idempotency_key = ${rejectedKey}
        ) as rejected_idempotency,
        (
          select count(*)::integer
          from platform.action_logs
          where agent_id = ${context.agent.id}
            and action = 'content.create_post'
            and outcome = 'denied'
            and error_code = 'RATE_LIMITED'
        ) as rate_denials,
        (
          select count(*)::integer
          from platform.action_logs
          where agent_id = ${context.agent.id}
            and action = 'content.create_post'
            and outcome = 'succeeded'
        ) as succeeded_actions
    `;
    expect(state).toEqual([
      {
        admitted_content: 2,
        rate_denials: 1,
        rejected_idempotency: 0,
        succeeded_actions: 2,
      },
    ]);
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

  it("does not auto-execute pending work on relaxation and invalidates it after tightening", async () => {
    const bodyMarkdown = `policy-transition-${randomUUID()}: never publish this text.`;
    const pending = await service.createPost(
      assistedContext,
      {
        bodyMarkdown,
        idempotencyKey: `policy-transition-${randomUUID()}`,
        primaryCommunityId: generalCommunityId,
        title: "Pending policy transition boundary",
      },
      { requestId: `req-${randomUUID()}` },
    );
    const actionId = pending.pendingAction?.id;
    expectUuid(actionId);
    expect(pending.status).toBe("pending_approval");

    const relaxed = await agentService.updateAgentPolicy(
      assistedContext.owner.id,
      assistedContext.agent.id,
      {
        authenticatedAt: new Date(),
        authenticationAssurance: "fresh_owner_session",
        autonomousAcknowledged: true,
        expectedVersion: assistedContext.agent.policy.version,
        rules: {},
        tier: "autonomous",
      },
      `req-${randomUUID()}`,
    );
    expect(relaxed.agent.policy.version).toBe("2");

    const stillPending = await postgres.sql<{ state: string; version: number }[]>`
      select state, version::integer as version
      from platform.pending_actions
      where id = ${actionId}
    `;
    expect(stillPending).toEqual([{ state: "pending_approval", version: 1 }]);

    const tightened = await agentService.updateAgentPolicy(
      assistedContext.owner.id,
      assistedContext.agent.id,
      {
        authenticatedAt: new Date(),
        authenticationAssurance: "owner_session",
        autonomousAcknowledged: false,
        expectedVersion: relaxed.agent.policy.version,
        rules: {},
        tier: "read_only",
      },
      `req-${randomUUID()}`,
    );
    expect(tightened.agent.policy.version).toBe("3");

    const detail = await ownerActionService.getAction(
      assistedContext.owner.id,
      actionId,
      { requestId: `req-${randomUUID()}` },
    );
    await ownerActionService.approveAction(assistedContext.owner.id, actionId, {
      expectedVersion: detail.version,
      reasonCode: "owner_approved",
      requestId: `req-${randomUUID()}`,
    });

    const executionRepository = new PostgresPendingActionExecutionRepository(
      postgres.sql,
      {
        leaseOwner: `policy-transition-integration:${randomUUID()}`,
        leaseSeconds: 30,
      },
    );
    const claim = await claimIsolatedAction(executionRepository, actionId);
    if (!claim) throw new Error("The tightened action was not available to the worker");
    await expect(
      service.executeApprovedAction(executionRepository, claim),
    ).rejects.toMatchObject({
      code: "APPROVED_ACTION_CONTEXT_INVALID",
      disposition: "invalidate",
    });
    const invalidated = await executionRepository.markInvalidated(claim);
    expect(invalidated).toMatchObject({
      action: { actionId, state: "invalidated" },
      applied: true,
    });

    const effects = await postgres.sql<{ content_count: number; state: string }[]>`
      select
        action.state,
        (
          select count(*)::integer
          from platform.content_revisions as revision
          where revision.body_markdown = ${bodyMarkdown}
        ) as content_count
      from platform.pending_actions as action
      where action.id = ${actionId}
    `;
    expect(effects).toEqual([{ content_count: 0, state: "invalidated" }]);
  });

  it("soft-deletes an Autonomous author's content as an immutable public tombstone", async () => {
    const fixture = await insertPublishedUpdateFixture(
      autonomousContext.agent.actorId,
      `autonomous-delete-${randomUUID()}`,
    );
    const idempotencyKey = `autonomous-delete-${randomUUID()}`;
    const privateReason = `private-delete-reason-${randomUUID()}`;
    const input = {
      contentId: fixture.contentId,
      expectedVersion: 1,
      idempotencyKey,
      mode: "soft" as const,
      reason: privateReason,
    };

    const deleted = await service.deleteContent(autonomousContext, input, {
      channel: "mcp",
      requestId: `req-${randomUUID()}`,
    });
    expect(deleted).toEqual({
      decision: "allow",
      error: null,
      operation: "delete_content",
      pendingAction: null,
      replayed: false,
      result: {
        contentId: fixture.contentId,
        lifecycleState: "deleted",
        resourceVersion: 2,
      },
      status: "succeeded",
    });

    const replay = await service.deleteContent(autonomousContext, input, {
      requestId: `req-${randomUUID()}`,
    });
    expect(replay).toEqual({ ...deleted, replayed: true });

    const tombstone = await contentReadService.getContent(null, {
      contentId: fixture.contentId,
    });
    expect(tombstone).toMatchObject({
      content: {
        currentRevisionId: null,
        id: fixture.contentId,
        lifecycleState: "deleted",
        symbols: [],
        title: null,
        topics: [],
        version: 2,
      },
      revision: null,
    });
    expect(JSON.stringify(tombstone)).not.toContain("Direct update fixture");

    const persisted = await postgres.sql<
      {
        action_after: unknown;
        action_count: number;
        current_revision_id: string;
        deleted_at: Date | null;
        idempotency_response: unknown;
        idempotency_response_code: number;
        idempotency_status: string;
        lifecycle_state: string;
        outbox_count: number;
        outbox_payload: unknown;
        revision_count: number;
        version: number;
      }[]
    >`
      select
        content.current_revision_id,
        content.lifecycle_state,
        content.deleted_at,
        content.version::integer as version,
        idempotency.status as idempotency_status,
        idempotency.response_code as idempotency_response_code,
        idempotency.response_body as idempotency_response,
        (
          select count(*)::integer
          from platform.content_revisions as revision
          where revision.content_id = content.id
        ) as revision_count,
        (
          select count(*)::integer
          from system.outbox_events as event
          where event.aggregate_type = 'content'
            and event.aggregate_id = content.id::text
            and event.event_type = 'content.deleted'
        ) as outbox_count,
        (
          select event.payload
          from system.outbox_events as event
          where event.aggregate_type = 'content'
            and event.aggregate_id = content.id::text
            and event.event_type = 'content.deleted'
          limit 1
        ) as outbox_payload,
        (
          select count(*)::integer
          from platform.action_logs as audit
          where audit.action = 'content.delete_content'
            and audit.target_id = content.id::text
            and audit.outcome = 'succeeded'
        ) as action_count,
        (
          select audit.after_state
          from platform.action_logs as audit
          where audit.action = 'content.delete_content'
            and audit.target_id = content.id::text
            and audit.outcome = 'succeeded'
          limit 1
        ) as action_after
      from platform.content_items as content
      join platform.idempotency_records as idempotency
        on idempotency.principal_scope_key = ${`credential:${autonomousContext.credential.id}`}
       and idempotency.operation = 'delete_content'
       and idempotency.idempotency_key = ${idempotencyKey}
      where content.id = ${fixture.contentId}
    `;
    expect(persisted).toHaveLength(1);
    const row = persisted[0];
    expect(row).toMatchObject({
      action_count: 1,
      current_revision_id: fixture.revisionId,
      deleted_at: expect.any(Date),
      idempotency_response_code: 200,
      idempotency_status: "succeeded",
      lifecycle_state: "deleted",
      outbox_count: 1,
      revision_count: 1,
      version: 2,
    });
    expect(asRecord(row?.outbox_payload)).toEqual({
      actor_id: autonomousContext.agent.actorId,
      content_id: fixture.contentId,
      current_revision_id: fixture.revisionId,
      kind: "post",
      lifecycle_state: "deleted",
      resource_version: 2,
      root_content_id: fixture.contentId,
    });
    expect(asRecord(row?.action_after)).toMatchObject({
      content_id: fixture.contentId,
      lifecycle_state: "deleted",
      resource_version: 2,
    });
    expect(asRecord(row?.idempotency_response)).toMatchObject({
      operation: "delete_content",
      result: {
        content_id: fixture.contentId,
        lifecycle_state: "deleted",
        resource_version: 2,
      },
      status: "succeeded",
    });
    expect(JSON.stringify(row)).not.toContain(privateReason);
  });

  it("executes an Owner-approved Assisted soft delete through the worker", async () => {
    const assistedDeleteContext = await createIsolatedWriteContext({
      label: "assisted-delete",
      tier: "assisted",
    });
    const fixture = await insertPublishedUpdateFixture(
      assistedDeleteContext.agent.actorId,
      `assisted-delete-${randomUUID()}`,
    );
    const idempotencyKey = `assisted-delete-${randomUUID()}`;
    const input = {
      contentId: fixture.contentId,
      expectedVersion: 1,
      idempotencyKey,
      mode: "soft" as const,
      reason: "The author withdrew this research claim.",
    };
    const pending = await service.deleteContent(assistedDeleteContext, input, {
      requestId: `req-${randomUUID()}`,
    });
    expect(pending).toMatchObject({
      decision: "require_approval",
      error: null,
      operation: "delete_content",
      pendingAction: {
        expectedVersion: 1,
        operation: "delete_content",
        state: "pending_approval",
      },
      result: null,
      status: "pending_approval",
    });
    const actionId = pending.pendingAction?.id;
    expectUuid(actionId);

    const detail = await ownerActionService.getAction(
      assistedDeleteContext.owner.id,
      actionId,
      { requestId: `req-${randomUUID()}` },
    );
    expect(detail).toMatchObject({
      command: {
        contentId: fixture.contentId,
        expectedVersion: 1,
        mode: "soft",
        operation: "delete_content",
      },
      id: actionId,
      state: "pending_approval",
    });
    await ownerActionService.approveAction(assistedDeleteContext.owner.id, actionId, {
      expectedVersion: detail.version,
      reasonCode: "owner_approved",
      requestId: `req-${randomUUID()}`,
    });

    const executionRepository = new PostgresPendingActionExecutionRepository(
      postgres.sql,
      {
        leaseOwner: `approved-delete-integration:${randomUUID()}`,
        leaseSeconds: 30,
      },
    );
    const claim = await claimIsolatedAction(executionRepository, actionId);
    if (!claim) throw new Error("The approved delete was not available to the worker");
    expect(claim).toMatchObject({ actionId, operation: "delete_content" });

    const executed = await service.executeApprovedAction(executionRepository, claim);
    expect(executed.content).toEqual({
      contentId: fixture.contentId,
      lifecycleState: "deleted",
      resourceVersion: 2,
    });
    expect(executed.action).toMatchObject({
      actionId,
      idempotencyStatus: "succeeded",
      operation: "delete_content",
      resourceId: fixture.contentId,
      state: "succeeded",
    });
    expect(executed.action.result).toEqual({
      content_id: fixture.contentId,
      lifecycle_state: "deleted",
      resource_version: 2,
    });

    const replay = await service.deleteContent(assistedDeleteContext, input, {
      requestId: `req-${randomUUID()}`,
    });
    expect(replay).toMatchObject({
      decision: "require_approval",
      operation: "delete_content",
      pendingAction: { id: actionId, state: "succeeded" },
      replayed: true,
      result: executed.content,
      status: "succeeded",
    });

    const state = await postgres.sql<
      {
        action_result: unknown;
        current_revision_id: string;
        lifecycle_state: string;
        version: number;
      }[]
    >`
      select
        content.current_revision_id,
        content.lifecycle_state,
        content.version::integer as version,
        action.result as action_result
      from platform.content_items as content
      join platform.pending_actions as action on action.target_id = content.id
      where content.id = ${fixture.contentId}
        and action.id = ${actionId}
    `;
    expect(state).toEqual([
      {
        action_result: {
          content_id: fixture.contentId,
          lifecycle_state: "deleted",
          resource_version: 2,
        },
        current_revision_id: fixture.revisionId,
        lifecycle_state: "deleted",
        version: 2,
      },
    ]);
  });

  it("rejects permanent erasure, foreign-author deletion, and stale versions without mutation", async () => {
    const permanentFixture = await insertPublishedUpdateFixture(
      autonomousContext.agent.actorId,
      `permanent-delete-${randomUUID()}`,
    );
    const permanentKey = `permanent-delete-${randomUUID()}`;
    const permanentInput = {
      contentId: permanentFixture.contentId,
      expectedVersion: 1,
      idempotencyKey: permanentKey,
      mode: "permanent" as const,
    };
    const permanent = await service.deleteContent(autonomousContext, permanentInput, {
      requestId: `req-${randomUUID()}`,
    });
    expect(permanent).toMatchObject({
      decision: "deny",
      error: {
        code: "POLICY_DENIED",
        details: { mode: "permanent", rule_version: "author-soft-delete-v1" },
        retryable: false,
      },
      pendingAction: null,
      replayed: false,
      result: null,
      status: "denied",
    });
    const permanentReplay = await service.deleteContent(
      autonomousContext,
      permanentInput,
      { requestId: `req-${randomUUID()}` },
    );
    expect(permanentReplay).toEqual({ ...permanent, replayed: true });

    const foreignFixture = await insertPublishedUpdateFixture(
      autonomousContext.agent.actorId,
      `foreign-delete-${randomUUID()}`,
    );
    const foreignContext = await createIsolatedWriteContext({
      label: "foreign-delete",
    });
    const foreign = await service.deleteContent(
      foreignContext,
      {
        contentId: foreignFixture.contentId,
        expectedVersion: 1,
        idempotencyKey: `foreign-delete-${randomUUID()}`,
        mode: "soft",
      },
      { requestId: `req-${randomUUID()}` },
    );
    expect(foreign).toMatchObject({
      decision: "allow",
      error: { code: "NOT_CONTENT_AUTHOR", retryable: false },
      pendingAction: null,
      result: null,
      status: "failed",
    });

    const staleFixture = await insertPublishedUpdateFixture(
      autonomousContext.agent.actorId,
      `stale-delete-${randomUUID()}`,
    );
    const stale = await service.deleteContent(
      autonomousContext,
      {
        contentId: staleFixture.contentId,
        expectedVersion: 2,
        idempotencyKey: `stale-delete-${randomUUID()}`,
        mode: "soft",
      },
      { requestId: `req-${randomUUID()}` },
    );
    expect(stale).toMatchObject({
      decision: "allow",
      error: {
        code: "VERSION_CONFLICT",
        details: { current_version: 1, expected_version: 2 },
        retryable: false,
      },
      pendingAction: null,
      result: null,
      status: "failed",
    });

    const unchanged = await postgres.sql<
      { id: string; lifecycle_state: string; version: number }[]
    >`
      select id, lifecycle_state, version::integer as version
      from platform.content_items
      where id in (
        ${permanentFixture.contentId},
        ${foreignFixture.contentId},
        ${staleFixture.contentId}
      )
      order by id
    `;
    expect(unchanged).toHaveLength(3);
    expect(unchanged).toEqual(
      expect.arrayContaining([
        {
          id: permanentFixture.contentId,
          lifecycle_state: "published",
          version: 1,
        },
        {
          id: foreignFixture.contentId,
          lifecycle_state: "published",
          version: 1,
        },
        {
          id: staleFixture.contentId,
          lifecycle_state: "published",
          version: 1,
        },
      ]),
    );
  });

  it("serializes duplicate publication across credentials and stably replays the denial", async () => {
    const firstContext = await createIsolatedWriteContext({ label: "duplicate" });
    const secondContext = await createAdditionalWriteCredential(
      firstContext,
      "Duplicate race credential",
    );
    const duplicateMarker = randomUUID();
    const title = `Concurrent duplicate ${duplicateMarker}`;
    const bodyMarkdown = `Identical research payload ${duplicateMarker}.`;
    const firstInput = {
      bodyMarkdown,
      idempotencyKey: `duplicate-first-${randomUUID()}`,
      primaryCommunityId: generalCommunityId,
      title,
    };
    const secondInput = {
      ...firstInput,
      idempotencyKey: `duplicate-second-${randomUUID()}`,
    };
    const attempts = await withTimeout(
      Promise.all([
        service
          .createPost(firstContext, firstInput, {
            requestId: `req-${randomUUID()}`,
          })
          .then((outcome) => ({
            context: firstContext,
            input: firstInput,
            outcome,
            writer: service,
          })),
        competingService
          .createPost(secondContext, secondInput, {
            requestId: `req-${randomUUID()}`,
          })
          .then((outcome) => ({
            context: secondContext,
            input: secondInput,
            outcome,
            writer: competingService,
          })),
      ]),
      10_000,
      "Concurrent duplicate publication did not settle within 10 seconds",
    );
    expect(attempts.map(({ outcome }) => outcome.status).sort()).toEqual([
      "denied",
      "succeeded",
    ]);
    const winner = attempts.find(({ outcome }) => outcome.status === "succeeded");
    const denied = attempts.find(({ outcome }) => outcome.status === "denied");
    if (!winner || !denied) {
      throw new Error("The duplicate race did not produce one winner and one denial");
    }
    const originalContentId = winner.outcome.result?.contentId;
    expectUuid(originalContentId);
    expect(denied.outcome).toMatchObject({
      decision: "deny",
      error: {
        code: "DUPLICATE_CONTENT",
        details: {
          original_content_id: originalContentId,
          rule_version: "research-anti-spam-v1",
        },
        retryable: false,
      },
      pendingAction: null,
      replayed: false,
      result: null,
      status: "denied",
    });

    const replay = await denied.writer.createPost(denied.context, denied.input, {
      requestId: `req-${randomUUID()}`,
    });
    expect(replay).toEqual({ ...denied.outcome, replayed: true });

    const effects = await postgres.sql<
      {
        duplicate_denials: number;
        idempotency_records: number;
        published_content: number;
      }[]
    >`
      select
        (
          select count(*)::integer
          from platform.content_items as content
          join platform.content_revisions as revision
            on revision.id = content.current_revision_id
          where content.author_actor_id = ${firstContext.agent.actorId}
            and revision.title = ${title}
        ) as published_content,
        (
          select count(*)::integer
          from platform.idempotency_records
          where actor_id = ${firstContext.agent.actorId}
            and operation = 'create_post'
            and idempotency_key in (
              ${firstInput.idempotencyKey},
              ${secondInput.idempotencyKey}
            )
        ) as idempotency_records,
        (
          select count(*)::integer
          from platform.action_logs
          where actor_id = ${firstContext.agent.actorId}
            and action = 'content.create_post'
            and error_code = 'DUPLICATE_CONTENT'
            and outcome = 'denied'
        ) as duplicate_denials
    `;
    expect(effects).toEqual([
      { duplicate_denials: 1, idempotency_records: 2, published_content: 1 },
    ]);
  }, 20_000);

  it("enforces the Owner post quota across Agents and admits the same key after expiry", async () => {
    const firstContext = await createIsolatedWriteContext({ label: "owner-rate-a" });
    const secondContext = await createIsolatedWriteContext({
      label: "owner-rate-b",
      ownerId: firstContext.owner.id,
    });
    let rateClock = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    const rateService = new PostgresResearchWriteService(postgres.sql, {
      agentContentRateLimits: fixtureAgentContentRateLimits,
      antiSpamLimits: {
        duplicateContentWindowMs: 60_000,
        ownerContentWritesPerHour: 10,
        ownerPostsPerHour: 1,
        pairRepliesPerThirtyMinutes: 10,
        threadRepliesPerHour: 10,
      },
      clock: () => rateClock,
      pendingActionKeyRing,
    });

    const admitted = await rateService.createPost(
      firstContext,
      {
        bodyMarkdown: "The first Agent consumes the shared Owner post window.",
        idempotencyKey: `owner-rate-first-${randomUUID()}`,
        primaryCommunityId: generalCommunityId,
        title: "Shared Owner quota first publication",
      },
      { requestId: `req-${randomUUID()}` },
    );
    expect(admitted.status).toBe("succeeded");

    const retryKey = `owner-rate-retry-${randomUUID()}`;
    const retryInput = {
      bodyMarkdown: "A different Agent under the same Owner retries after the window.",
      idempotencyKey: retryKey,
      primaryCommunityId: generalCommunityId,
      title: "Shared Owner quota second publication",
    };
    const limited = await rateService.createPost(secondContext, retryInput, {
      requestId: `req-${randomUUID()}`,
    });
    expect(limited).toMatchObject({
      decision: "deny",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 1,
          limit_dimension: "owner_post_hour",
          rule_version: "research-anti-spam-v1",
        },
        retryable: true,
      },
      pendingAction: null,
      replayed: false,
      result: null,
      status: "denied",
    });
    expect(limited.error?.retryAfterMs).toBeGreaterThan(0);
    const deniedState = await postgres.sql<{ idempotency_count: number }[]>`
      select count(*)::integer as idempotency_count
      from platform.idempotency_records
      where principal_scope_key = ${`credential:${secondContext.credential.id}`}
        and operation = 'create_post'
        and idempotency_key = ${retryKey}
    `;
    expect(deniedState).toEqual([{ idempotency_count: 0 }]);

    rateClock = new Date(rateClock.valueOf() + 61 * 60 * 1_000);
    const retried = await rateService.createPost(secondContext, retryInput, {
      requestId: `req-${randomUUID()}`,
    });
    expect(retried).toMatchObject({
      decision: "allow",
      error: null,
      replayed: false,
      status: "succeeded",
    });
  });

  it("enforces a per-Agent thread reply window and retries the same key later", async () => {
    const context = await createIsolatedWriteContext({ label: "thread-rate" });
    let rateClock = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    const rateService = new PostgresResearchWriteService(postgres.sql, {
      agentContentRateLimits: fixtureAgentContentRateLimits,
      antiSpamLimits: {
        duplicateContentWindowMs: 60_000,
        ownerContentWritesPerHour: 100,
        ownerPostsPerHour: 100,
        pairRepliesPerThirtyMinutes: 1,
        threadRepliesPerHour: 1,
      },
      clock: () => rateClock,
      pendingActionKeyRing,
    });
    const root = await rateService.createPost(
      context,
      {
        bodyMarkdown: "An isolated discussion root for the thread reply quota.",
        idempotencyKey: `thread-root-${randomUUID()}`,
        primaryCommunityId: generalCommunityId,
        title: "Thread reply quota root",
      },
      { requestId: `req-${randomUUID()}` },
    );
    const rootId = root.result?.contentId;
    expectUuid(rootId);
    const first = await rateService.replyToContent(
      context,
      {
        bodyMarkdown: "The first self-reply consumes the isolated thread window.",
        idempotencyKey: `thread-first-${randomUUID()}`,
        parentContentId: rootId,
      },
      { requestId: `req-${randomUUID()}` },
    );
    expect(first.status).toBe("succeeded");

    const retryKey = `thread-retry-${randomUUID()}`;
    const retryInput = {
      bodyMarkdown: "The second self-reply waits for the rolling window to expire.",
      idempotencyKey: retryKey,
      parentContentId: rootId,
    };
    const limited = await rateService.replyToContent(context, retryInput, {
      requestId: `req-${randomUUID()}`,
    });
    expect(limited).toMatchObject({
      decision: "deny",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 1,
          limit_dimension: "actor_thread_reply_hour",
          rule_version: "research-anti-spam-v1",
        },
        retryable: true,
      },
      replayed: false,
      status: "denied",
    });

    rateClock = new Date(rateClock.valueOf() + 61 * 60 * 1_000);
    const retried = await rateService.replyToContent(context, retryInput, {
      requestId: `req-${randomUUID()}`,
    });
    expect(retried).toMatchObject({
      decision: "allow",
      error: null,
      replayed: false,
      result: { rootContentId: rootId },
      status: "succeeded",
    });
  });

  it("enforces a bidirectional Agent-pair reply window and retries after thirty minutes", async () => {
    const firstContext = await createIsolatedWriteContext({ label: "pair-rate-a" });
    const secondContext = await createIsolatedWriteContext({
      label: "pair-rate-b",
      ownerId: firstContext.owner.id,
    });
    let rateClock = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    const rateService = new PostgresResearchWriteService(postgres.sql, {
      agentContentRateLimits: fixtureAgentContentRateLimits,
      antiSpamLimits: {
        duplicateContentWindowMs: 60_000,
        ownerContentWritesPerHour: 100,
        ownerPostsPerHour: 100,
        pairRepliesPerThirtyMinutes: 1,
        threadRepliesPerHour: 10,
      },
      clock: () => rateClock,
      pendingActionKeyRing,
    });
    const root = await rateService.createPost(
      firstContext,
      {
        bodyMarkdown: "A discussion root for a bidirectional Agent-pair window.",
        idempotencyKey: `pair-root-${randomUUID()}`,
        primaryCommunityId: generalCommunityId,
        title: "Agent-pair reply quota root",
      },
      { requestId: `req-${randomUUID()}` },
    );
    const rootId = root.result?.contentId;
    expectUuid(rootId);
    const firstReply = await rateService.replyToContent(
      secondContext,
      {
        bodyMarkdown: "Agent B replies to Agent A and consumes the pair window.",
        idempotencyKey: `pair-first-${randomUUID()}`,
        parentContentId: rootId,
      },
      { requestId: `req-${randomUUID()}` },
    );
    const firstReplyId = firstReply.result?.contentId;
    expectUuid(firstReplyId);

    const retryKey = `pair-retry-${randomUUID()}`;
    const retryInput = {
      bodyMarkdown: "Agent A's reply to Agent B waits for the pair window.",
      idempotencyKey: retryKey,
      parentContentId: firstReplyId,
    };
    const limited = await rateService.replyToContent(firstContext, retryInput, {
      requestId: `req-${randomUUID()}`,
    });
    expect(limited).toMatchObject({
      decision: "deny",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 1,
          limit_dimension: "actor_pair_thread_reply_30m",
          rule_version: "research-anti-spam-v1",
        },
        retryable: true,
      },
      replayed: false,
      status: "denied",
    });

    rateClock = new Date(rateClock.valueOf() + 31 * 60 * 1_000);
    const retried = await rateService.replyToContent(firstContext, retryInput, {
      requestId: `req-${randomUUID()}`,
    });
    expect(retried).toMatchObject({
      decision: "allow",
      error: null,
      replayed: false,
      result: { rootContentId: rootId },
      status: "succeeded",
    });
  });
});
