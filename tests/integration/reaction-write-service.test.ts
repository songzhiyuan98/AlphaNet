import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiApp } from "../../apps/api/src/app.js";
import {
  RedisRateLimitStorage,
  type AlphaNetAuthRuntime,
} from "../../packages/auth/src/index.js";
import {
  GetContentResponseSchema,
  SetReactionWriteResultSchema,
} from "../../packages/contracts/src/index.js";
import {
  closeDependencies,
  createPostgresDependency,
  createRedisDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";
import {
  PostgresAgentConnectionService,
  type AgentCredentialContext,
  type AgentPolicyTier,
} from "../../packages/domain/src/agent-connection.js";
import { PostgresContentReadService } from "../../packages/domain/src/content-read.js";
import {
  PostgresReactionWriteService,
  type ReactionType,
  type SetReactionInput,
} from "../../packages/domain/src/reaction-write.js";
import { PostgresResearchWriteService } from "../../packages/domain/src/research-write.js";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";
const hasConfiguration = Boolean(databaseUrl && redisUrl);

if (mustRun && !hasConfiguration) {
  throw new Error(
    "DATABASE_URL and REDIS_URL are required when REQUIRE_INTEGRATION_SERVICES=true",
  );
}

const describeReactionWrite = hasConfiguration ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const apiKeyPepper = "reaction-write-service-pepper-is-integration-test-data-only";
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

function requireId(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${label} was not created`);
  }
  return value;
}

describeReactionWrite("PostgresReactionWriteService", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  type ReservedConnection = Awaited<ReturnType<typeof postgres.sql.reserve>>;
  const redis = createRedisDependency(redisUrl ?? "", { critical: true });
  const agentService = new PostgresAgentConnectionService(
    postgres.sql,
    agentConnectionOptions,
  );
  const researchWriteService = new PostgresResearchWriteService(postgres.sql, {
    pendingActionKeyRing: {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    },
  });
  const reactionWriteService = new PostgresReactionWriteService(postgres.sql);
  const contentReadService = new PostgresContentReadService(postgres.sql, {
    cursorSigningKey: Buffer.from(
      "reaction-write-integration-cursor-signing-key-material-v1",
      "utf8",
    ),
  });
  dependencies.push(postgres, redis);

  let app: Awaited<ReturnType<typeof createApiApp>>;
  let authorContext: AgentCredentialContext;
  let reactorContext: AgentCredentialContext;
  let authorApiKey = "";
  let reactorApiKey = "";
  let apiContentId = "";
  let primaryContentId = "";
  let concurrentContentId = "";
  let deletionContentId = "";
  let idempotencyTamperContentId = "";
  let replyContentId = "";
  let replyRootContentId = "";
  let reactorHumanActorId = "";
  let mixedCommunityContentId = "";
  let suspendedPrimaryCommunityId = "";
  let suspendedPrimaryContentId = "";
  let deletedPrimaryCommunityId = "";
  let deletedPrimaryContentId = "";
  let raceDeletionContentId = "";
  let marker = "";

  const authHandler = () => Promise.resolve(Response.json({ status: true }));
  const authRuntime = {
    auth: { handler: authHandler },
    baseUrl: "https://api.alphanet.test",
    checkReady: () => Promise.resolve(),
    close: () => Promise.resolve(),
    getOwnerSession: () => Promise.resolve(null),
    googleEnabled: false,
    handle: authHandler,
  } as unknown as AlphaNetAuthRuntime;

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
        ${`Reaction ${label} Owner`},
        ${`reaction-${label}-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id
    `;
    const userId = requireId(users[0]?.id, `${label} Auth User`);
    const owners = await postgres.sql<{ id: string }[]>`
      select id
      from platform.owners
      where auth_user_id = ${userId}
    `;
    return requireId(owners[0]?.id, `${label} Owner projection`);
  }

  async function activatePolicy(
    ownerId: string,
    agentId: string,
    tier: AgentPolicyTier,
  ): Promise<void> {
    await postgres.sql.begin(async (transaction) => {
      const policies = await transaction<
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
      const current = policies[0];
      if (!current) throw new Error("The integration Agent has no active policy");
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

  async function setReaction(
    context: AgentCredentialContext,
    contentId: string,
    reaction: ReactionType,
    active: boolean,
    idempotencyKey = `reaction-${randomUUID()}`,
  ) {
    const input: SetReactionInput = {
      active,
      contentId,
      idempotencyKey,
      reaction,
    };
    return reactionWriteService.setReaction(context, input, {
      channel: "integration",
      requestId: `req-${randomUUID()}`,
    });
  }

  async function createReactionOnlyContext(
    label: string,
  ): Promise<AgentCredentialContext> {
    const ownerId = await createVerifiedOwner(label);
    const agent = await agentService.createAgent(
      ownerId,
      {
        displayName: `Reaction quota ${label}`,
        handle: `rx-${label}-${marker}`,
      },
      randomUUID(),
    );
    const credential = await agentService.createCredential(
      ownerId,
      agent.agent.id,
      {
        name: `Reaction quota ${label}`,
        scopes: ["reaction:write"],
      },
      randomUUID(),
    );
    return agentService.authenticateStaticApiKey(credential.apiKey);
  }

  async function waitForLock(backendPid: number, label: string): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const sessions = await postgres.sql<
        { wait_event: string | null; wait_event_type: string | null }[]
      >`
        select wait_event, wait_event_type
        from pg_stat_activity
        where pid = ${backendPid}
      `;
      if (sessions[0]?.wait_event_type === "Lock") return;
      await delay(10);
    }
    throw new Error(`${label} did not wait for the expected PostgreSQL lock`);
  }

  async function waitForApplicationLock(
    applicationName: string,
    label: string,
  ): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const sessions = await postgres.sql<{ waiting: boolean }[]>`
        select exists (
          select 1
          from pg_stat_activity
          where application_name = ${applicationName}
            and wait_event_type = 'Lock'
        ) as waiting
      `;
      if (sessions[0]?.waiting === true) return;
      await delay(10);
    }
    throw new Error(`${label} did not wait for the expected PostgreSQL lock`);
  }

  async function expectBlockedReactionInsert(options: {
    actorId: string;
    contentId: string;
    label: string;
    mutate(connection: ReservedConnection): Promise<void>;
    reaction: ReactionType;
  }): Promise<void> {
    const mutationConnection = await postgres.sql.reserve();
    const insertConnection = await postgres.sql.reserve();
    let mutationOpen = false;
    let insertOpen = false;
    let insertOutcomePromise:
      | Promise<{ status: "fulfilled" } | { error: unknown; status: "rejected" }>
      | undefined;
    try {
      await mutationConnection`begin`;
      mutationOpen = true;
      await options.mutate(mutationConnection);
      await insertConnection`begin`;
      insertOpen = true;
      const backendRows = await insertConnection<{ pid: number }[]>`
        select pg_backend_pid()::integer as pid
      `;
      const backendPid = backendRows[0]?.pid;
      if (!backendPid) throw new Error(`${options.label} insert PID was unavailable`);
      insertOutcomePromise = Promise.resolve(
        insertConnection`
          insert into platform.reactions (actor_id, content_id, reaction_type)
          values (${options.actorId}, ${options.contentId}, ${options.reaction})
        `,
      ).then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ error, status: "rejected" as const }),
      );
      await waitForLock(backendPid, options.label);
      await mutationConnection`commit`;
      mutationOpen = false;
      const insertOutcome = await insertOutcomePromise;
      expect(insertOutcome.status).toBe("rejected");
      if (insertOutcome.status === "rejected") {
        expect(insertOutcome.error).toMatchObject({ code: "55000" });
      }
      await insertConnection`rollback`;
      insertOpen = false;
    } finally {
      if (mutationOpen) await mutationConnection`rollback`;
      if (insertOpen) await insertConnection`rollback`;
      await insertOutcomePromise;
      mutationConnection.release();
      insertConnection.release();
    }
  }

  beforeAll(async () => {
    await redis.check();
    marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const communityId = randomUUID();
    const topicId = randomUUID();
    const communitySlug = `reaction-${marker}`;
    suspendedPrimaryCommunityId = randomUUID();
    deletedPrimaryCommunityId = randomUUID();
    const suspendedTopicId = randomUUID();
    const deletedTopicId = randomUUID();
    const suspendedSlug = `reaction-suspended-${marker}`;
    const deletedSlug = `reaction-deleted-${marker}`;
    const postingRules = {
      allowed_content: ["investment-research", "discussion"],
      max_posts_per_hour: 100,
      replies_open: true,
      requires_sources: false,
    };
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.topics (id, slug, name, description)
        values
          (
            ${topicId},
            ${communitySlug},
            'Reaction integration topic',
            'An isolated topic for Reaction database and service verification.'
          ),
          (
            ${suspendedTopicId},
            ${suspendedSlug},
            'Reaction suspended-primary topic',
            'A topic used to prove canonical primary Community gating.'
          ),
          (
            ${deletedTopicId},
            ${deletedSlug},
            'Reaction deleted-primary topic',
            'A topic used to prove deleted primary Community gating.'
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
            ${communityId},
            ${communitySlug},
            'Reaction Integration Community',
            'An isolated Community for social reaction integration tests.',
            'topic',
            ${transaction.json(postingRules)},
            ${transaction.json({ integration_fixture: marker })}
          ),
          (
            ${suspendedPrimaryCommunityId},
            ${suspendedSlug},
            'Reaction Suspended-primary Community',
            'A canonical primary Community that is suspended during a race.',
            'topic',
            ${transaction.json(postingRules)},
            ${transaction.json({ integration_fixture: marker })}
          ),
          (
            ${deletedPrimaryCommunityId},
            ${deletedSlug},
            'Reaction Deleted-primary Community',
            'A canonical primary Community that is deleted after publication.',
            'topic',
            ${transaction.json(postingRules)},
            ${transaction.json({ integration_fixture: marker })}
          )
      `;
      await transaction`
        insert into platform.community_topics (community_id, topic_id, is_primary)
        values
          (${communityId}, ${topicId}, true),
          (${suspendedPrimaryCommunityId}, ${suspendedTopicId}, true),
          (${deletedPrimaryCommunityId}, ${deletedTopicId}, true)
      `;
    });

    const authorOwnerId = await createVerifiedOwner("author");
    const author = await agentService.createAgent(
      authorOwnerId,
      {
        displayName: "Reaction Research Author",
        handle: `rx-author-${marker}`,
      },
      randomUUID(),
    );
    await activatePolicy(authorOwnerId, author.agent.id, "autonomous");
    const authorCredential = await agentService.createCredential(
      authorOwnerId,
      author.agent.id,
      {
        name: "Reaction author integration",
        scopes: ["research:read", "content:write", "reaction:write"],
      },
      randomUUID(),
    );
    authorApiKey = authorCredential.apiKey;
    authorContext = await agentService.authenticateStaticApiKey(authorCredential.apiKey);

    const reactorOwnerId = await createVerifiedOwner("reactor");
    const reactor = await agentService.createAgent(
      reactorOwnerId,
      {
        displayName: "Independent Reaction Agent",
        handle: `rx-reactor-${marker}`,
      },
      randomUUID(),
    );
    await activatePolicy(reactorOwnerId, reactor.agent.id, "autonomous");
    const reactorCredential = await agentService.createCredential(
      reactorOwnerId,
      reactor.agent.id,
      {
        name: "Independent reaction integration",
        scopes: ["research:read", "reaction:write"],
      },
      randomUUID(),
    );
    reactorApiKey = reactorCredential.apiKey;
    reactorContext = await agentService.authenticateStaticApiKey(
      reactorCredential.apiKey,
    );
    const humanActors = await postgres.sql<{ id: string }[]>`
      insert into platform.actors (
        kind,
        owner_id,
        handle,
        display_name,
        status
      )
      values (
        'human',
        ${reactorOwnerId},
        ${`rx-human-${marker}`},
        'Reaction Owner human identity',
        'active'
      )
      returning id
    `;
    reactorHumanActorId = requireId(humanActors[0]?.id, "Reactor Owner human Actor");

    const postIds: string[] = [];
    for (const [index, title] of [
      "Independent social signals",
      "Concurrent reaction target",
      "Deleted reaction target",
      "REST reaction target",
      "Reply root reaction target",
      "Concurrent deletion reaction target",
      "Idempotency tamper reaction target",
    ].entries()) {
      const outcome = await researchWriteService.createPost(
        authorContext,
        {
          bodyMarkdown: `Reaction integration research fixture ${index + 1}.`,
          idempotencyKey: `reaction-post-${randomUUID()}`,
          primaryCommunityId: communityId,
          title,
        },
        { requestId: `req-${randomUUID()}` },
      );
      expect(outcome.status).toBe("succeeded");
      postIds.push(requireId(outcome.result?.contentId, `Reaction post ${index + 1}`));
    }
    [
      primaryContentId,
      concurrentContentId,
      deletionContentId,
      apiContentId,
      replyRootContentId,
      raceDeletionContentId,
      idempotencyTamperContentId,
    ] = postIds as [string, string, string, string, string, string, string];
    const reply = await researchWriteService.replyToContent(
      authorContext,
      {
        bodyMarkdown:
          "A published reply whose eligibility remains coupled to its root discussion.",
        idempotencyKey: `reaction-reply-${randomUUID()}`,
        parentContentId: replyRootContentId,
      },
      { requestId: `req-${randomUUID()}` },
    );
    expect(reply.status).toBe("succeeded");
    replyContentId = requireId(reply.result?.contentId, "Reaction reply");

    const mixed = await researchWriteService.createPost(
      authorContext,
      {
        additionalCommunityIds: [suspendedPrimaryCommunityId],
        bodyMarkdown:
          "An active canonical primary discussion with a non-authoritative additional Community.",
        idempotencyKey: `reaction-mixed-community-${randomUUID()}`,
        primaryCommunityId: communityId,
        title: "Active primary with suspended additional distribution",
      },
      { requestId: `req-${randomUUID()}` },
    );
    mixedCommunityContentId = requireId(
      mixed.result?.contentId,
      "Mixed-community Reaction post",
    );
    const suspendedPrimary = await researchWriteService.createPost(
      authorContext,
      {
        bodyMarkdown: "A post whose canonical primary Community will be suspended.",
        idempotencyKey: `reaction-suspended-primary-${randomUUID()}`,
        primaryCommunityId: suspendedPrimaryCommunityId,
        title: "Suspended primary Reaction post",
      },
      { requestId: `req-${randomUUID()}` },
    );
    suspendedPrimaryContentId = requireId(
      suspendedPrimary.result?.contentId,
      "Suspended-primary Reaction post",
    );
    const deletedPrimary = await researchWriteService.createPost(
      authorContext,
      {
        bodyMarkdown: "A post whose canonical primary Community will be deleted.",
        idempotencyKey: `reaction-deleted-primary-${randomUUID()}`,
        primaryCommunityId: deletedPrimaryCommunityId,
        title: "Deleted primary Reaction post",
      },
      { requestId: `req-${randomUUID()}` },
    );
    deletedPrimaryContentId = requireId(
      deletedPrimary.result?.contentId,
      "Deleted-primary Reaction post",
    );

    app = await createApiApp({
      agentConnectionService: agentService,
      agentRateLimiter: new RedisRateLimitStorage(
        redis.client,
        `alphanet:test:reaction-api:${marker}:`,
      ),
      allowedOrigins: ["https://app.alphanet.test"],
      authRuntime,
      contentReadService,
      environment: "test",
      reactionWriteService,
      version: "reaction-write-integration",
    });
  });

  afterAll(async () => {
    await app?.close();
    await closeDependencies(dependencies);
  });

  it("records the exact migration bytes and passes both runtime schema gates", async () => {
    const migration = await readFile(
      `${process.cwd()}/db/migrations/000009_content_reactions.up.sql`,
    );
    const expectedChecksum = createHash("sha256").update(migration).digest("hex");
    const rows = await postgres.sql<
      { checksum: string; name: string; version: string }[]
    >`
      select version, name, checksum
      from system.schema_migrations
      where version = '000009'
    `;
    expect(rows).toEqual([
      {
        checksum: expectedChecksum,
        name: "content_reactions",
        version: "000009",
      },
    ]);
    await expect(reactionWriteService.checkReady()).resolves.toBeUndefined();
    await expect(contentReadService.checkReady()).resolves.toBeUndefined();
  });

  it("canonicalizes uppercase UUID input before digest, persistence, and exact replay", async () => {
    const key = `canonical-content-${randomUUID()}`;
    const requestId = `req-${randomUUID()}`;
    const uppercaseContentId = raceDeletionContentId.toUpperCase();
    const first = await reactionWriteService.setReaction(
      reactorContext,
      {
        active: true,
        contentId: uppercaseContentId,
        idempotencyKey: key,
        reaction: "disagree",
      },
      { channel: "integration-canonical", requestId },
    );
    expect(first).toMatchObject({
      replayed: false,
      result: { contentId: raceDeletionContentId },
      status: "succeeded",
    });
    const replay = await reactionWriteService.setReaction(
      reactorContext,
      {
        active: true,
        contentId: raceDeletionContentId,
        idempotencyKey: key,
        reaction: "disagree",
      },
      { channel: "integration-canonical", requestId: `req-${randomUUID()}` },
    );
    expect(replay).toEqual({ ...first, replayed: true });

    const persisted = await postgres.sql<
      {
        aggregate_id: string;
        idempotency_count: number;
        payload_content_id: string;
        target_id: string;
      }[]
    >`
      select
        action.target_id::text as target_id,
        event.aggregate_id,
        event.payload ->> 'content_id' as payload_content_id,
        (
          select count(*)::integer
          from platform.idempotency_records as idempotency
          where idempotency.principal_scope_key =
                ${`credential:${reactorContext.credential.id}`}
            and idempotency.operation = 'set_reaction'
            and idempotency.idempotency_key = ${key}
        ) as idempotency_count
      from platform.action_logs as action
      join system.outbox_events as event on event.id = action.outbox_event_id
      where action.request_id = ${requestId}
        and action.action = 'reaction.set'
    `;
    expect(persisted).toEqual([
      {
        aggregate_id: raceDeletionContentId,
        idempotency_count: 1,
        payload_content_id: raceDeletionContentId,
        target_id: raceDeletionContentId,
      },
    ]);
  });

  it("rejects persisted idempotency results whose status, code, resource, or content binding was tampered", async () => {
    const inputs = {
      contentId: {
        active: false,
        contentId: idempotencyTamperContentId,
        idempotencyKey: `tamper-content-${randomUUID()}`,
        reaction: "disagree",
      },
      resourceId: {
        active: false,
        contentId: idempotencyTamperContentId,
        idempotencyKey: `tamper-resource-${randomUUID()}`,
        reaction: "disagree",
      },
      responseCode: {
        active: false,
        contentId: idempotencyTamperContentId,
        idempotencyKey: `tamper-code-${randomUUID()}`,
        reaction: "disagree",
      },
      status: {
        active: false,
        contentId: idempotencyTamperContentId,
        idempotencyKey: `tamper-status-${randomUUID()}`,
        reaction: "disagree",
      },
    } satisfies Record<string, SetReactionInput>;

    for (const input of Object.values(inputs)) {
      const outcome = await reactionWriteService.setReaction(reactorContext, input, {
        channel: "integration-idempotency-tamper-fixture",
        requestId: `req-${randomUUID()}`,
      });
      expect(outcome).toMatchObject({ replayed: false, status: "succeeded" });
    }

    const principalScopeKey = `credential:${reactorContext.credential.id}`;
    await postgres.sql`
      alter table platform.idempotency_records
      disable trigger idempotency_records_prepare_update
    `;
    try {
      await expect(
        postgres.sql`
          update platform.idempotency_records
          set response_body = jsonb_set(
            response_body,
            '{status}',
            to_jsonb('failed'::text),
            false
          )
          where principal_scope_key = ${principalScopeKey}
            and operation = 'set_reaction'
            and idempotency_key = ${inputs.status.idempotencyKey}
          returning id
        `,
      ).resolves.toHaveLength(1);
      await expect(
        postgres.sql`
          update platform.idempotency_records
          set response_code = 201
          where principal_scope_key = ${principalScopeKey}
            and operation = 'set_reaction'
            and idempotency_key = ${inputs.responseCode.idempotencyKey}
          returning id
        `,
      ).resolves.toHaveLength(1);
      await expect(
        postgres.sql`
          update platform.idempotency_records
          set resource_id = ${randomUUID()}
          where principal_scope_key = ${principalScopeKey}
            and operation = 'set_reaction'
            and idempotency_key = ${inputs.resourceId.idempotencyKey}
          returning id
        `,
      ).resolves.toHaveLength(1);
      await expect(
        postgres.sql`
          update platform.idempotency_records
          set response_body = jsonb_set(
            response_body,
            '{result,content_id}',
            to_jsonb(${randomUUID()}::text),
            false
          )
          where principal_scope_key = ${principalScopeKey}
            and operation = 'set_reaction'
            and idempotency_key = ${inputs.contentId.idempotencyKey}
          returning id
        `,
      ).resolves.toHaveLength(1);
    } finally {
      await postgres.sql`
        alter table platform.idempotency_records
        enable trigger idempotency_records_prepare_update
      `;
    }

    for (const input of Object.values(inputs)) {
      const replay = await reactionWriteService.setReaction(reactorContext, input, {
        channel: "integration-idempotency-tamper-replay",
        requestId: `req-${randomUUID()}`,
      });
      expect(replay).toMatchObject({
        decision: "allow",
        error: { code: "IDEMPOTENCY_RESULT_CORRUPT", retryable: true },
        replayed: false,
        result: null,
        status: "failed",
      });
    }
  });

  it("serves real PUT, authenticated GET, public GET, replay, and self-error REST flows", async () => {
    const idempotencyKey = `rest-helpful-${randomUUID()}`;
    const first = await app.inject({
      headers: {
        authorization: `Bearer ${reactorApiKey}`,
        "idempotency-key": idempotencyKey,
        "x-request-id": "req_reaction_api_put",
      },
      method: "PUT",
      payload: { active: true },
      remoteAddress: "2001:db8:100::1",
      url: `/v1/content/${apiContentId}/reactions/helpful`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store, private");
    const firstBody = SetReactionWriteResultSchema.parse(first.json());
    expect(firstBody).toMatchObject({
      decision: "allow",
      error: null,
      pending_action: null,
      result: {
        content_id: apiContentId,
        reaction_counts: { agree: 0, disagree: 0, helpful: 1 },
        viewer_state: { following: false, reactions: ["helpful"] },
      },
      status: "succeeded",
    });

    const agentRead = await app.inject({
      headers: { authorization: `Bearer ${reactorApiKey}` },
      method: "GET",
      remoteAddress: "2001:db8:100::1",
      url: `/v1/content/${apiContentId}`,
    });
    expect(agentRead.statusCode).toBe(200);
    expect(GetContentResponseSchema.parse(agentRead.json())).toMatchObject({
      reaction_counts: { agree: 0, disagree: 0, helpful: 1 },
      reaction_counts_by_actor_kind: {
        agent: { agree: 0, disagree: 0, helpful: 1 },
        human: { agree: 0, disagree: 0, helpful: 0 },
      },
      viewer_state: { following: false, reactions: ["helpful"] },
    });
    const publicRead = await app.inject({
      method: "GET",
      remoteAddress: "2001:db8:100::2",
      url: `/v1/public/content/${apiContentId}`,
    });
    expect(publicRead.statusCode).toBe(200);
    expect(GetContentResponseSchema.parse(publicRead.json())).toMatchObject({
      reaction_counts: { agree: 0, disagree: 0, helpful: 1 },
      viewer_state: { following: false, reactions: [] },
    });

    const replay = await app.inject({
      headers: {
        authorization: `Bearer ${reactorApiKey}`,
        "idempotency-key": idempotencyKey,
        "x-request-id": "req_reaction_api_put",
      },
      method: "PUT",
      payload: { active: true },
      remoteAddress: "2001:db8:100::1",
      url: `/v1/content/${apiContentId}/reactions/helpful`,
    });
    expect(replay.statusCode).toBe(200);
    expect(SetReactionWriteResultSchema.parse(replay.json())).toEqual(firstBody);
    const persisted = await postgres.sql<
      { action_count: number; event_count: number; fact_count: number }[]
    >`
      select
        (
          select count(*)::integer
          from platform.reactions
          where actor_id = ${reactorContext.agent.actorId}
            and content_id = ${apiContentId}
            and reaction_type = 'helpful'
        ) as fact_count,
        (
          select count(*)::integer
          from platform.action_logs
          where agent_id = ${reactorContext.agent.id}
            and target_id = ${apiContentId}
            and action = 'reaction.set'
            and outcome = 'succeeded'
        ) as action_count,
        (
          select count(*)::integer
          from system.outbox_events
          where aggregate_id = ${apiContentId}
            and event_type in ('reaction.changed', 'reaction.confirmed')
        ) as event_count
    `;
    expect(persisted).toEqual([{ action_count: 1, event_count: 1, fact_count: 1 }]);

    const selfReaction = await app.inject({
      headers: {
        authorization: `Bearer ${authorApiKey}`,
        "idempotency-key": `rest-self-${randomUUID()}`,
      },
      method: "PUT",
      payload: { active: true },
      remoteAddress: "2001:db8:100::3",
      url: `/v1/content/${apiContentId}/reactions/agree`,
    });
    expect(selfReaction.statusCode).toBe(409);
    expect(SetReactionWriteResultSchema.parse(selfReaction.json())).toMatchObject({
      decision: "allow",
      error: { code: "SELF_REACTION_NOT_ALLOWED", retryable: false },
      pending_action: null,
      result: null,
      status: "failed",
    });
  });

  it("keeps independent reactions strongly consistent across replay, conflict, no-op, and removal", async () => {
    const helpfulKey = `helpful-${randomUUID()}`;
    const helpfulInput: SetReactionInput = {
      active: true,
      contentId: primaryContentId,
      idempotencyKey: helpfulKey,
      reaction: "helpful",
    };
    const first = await reactionWriteService.setReaction(reactorContext, helpfulInput, {
      channel: "integration",
      requestId: `req-${randomUUID()}`,
    });
    expect(first).toMatchObject({
      decision: "allow",
      replayed: false,
      result: {
        contentId: primaryContentId,
        reactionCounts: { agree: 0, disagree: 0, helpful: 1 },
        viewerState: { following: false, reactions: ["helpful"] },
      },
      status: "succeeded",
    });
    const reactionEvents = () =>
      postgres.sql<{ event_type: string; payload: unknown }[]>`
        select event_type, payload
        from system.outbox_events
        where aggregate_id = ${primaryContentId}
          and event_type in ('reaction.changed', 'reaction.confirmed')
        order by aggregate_sequence
      `;
    expect(await reactionEvents()).toEqual([
      {
        event_type: "reaction.changed",
        payload: {
          active: true,
          actor_id: reactorContext.agent.actorId,
          changed: true,
          content_id: primaryContentId,
          reaction: "helpful",
        },
      },
    ]);

    const replay = await reactionWriteService.setReaction(reactorContext, helpfulInput, {
      channel: "integration-replay",
      requestId: `req-${randomUUID()}`,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await reactionEvents()).toHaveLength(1);

    const conflict = await setReaction(
      reactorContext,
      primaryContentId,
      "helpful",
      false,
      helpfulKey,
    );
    expect(conflict).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
      replayed: false,
      result: null,
      status: "failed",
    });

    const confirmation = await setReaction(
      reactorContext,
      primaryContentId,
      "helpful",
      true,
    );
    expect(confirmation).toMatchObject({
      replayed: false,
      result: {
        reactionCounts: { agree: 0, disagree: 0, helpful: 1 },
        viewerState: { reactions: ["helpful"] },
      },
      status: "succeeded",
    });
    expect(await reactionEvents()).toEqual([
      expect.objectContaining({ event_type: "reaction.changed" }),
      {
        event_type: "reaction.confirmed",
        payload: {
          active: true,
          actor_id: reactorContext.agent.actorId,
          changed: false,
          content_id: primaryContentId,
          reaction: "helpful",
        },
      },
    ]);

    const disagree = await setReaction(
      reactorContext,
      primaryContentId,
      "disagree",
      true,
    );
    expect(disagree).toMatchObject({
      result: {
        reactionCounts: { agree: 0, disagree: 1, helpful: 1 },
        viewerState: { reactions: ["helpful", "disagree"] },
      },
      status: "succeeded",
    });

    const facts = await postgres.sql<{ reaction_type: string }[]>`
      select reaction_type
      from platform.reactions
      where actor_id = ${reactorContext.agent.actorId}
        and content_id = ${primaryContentId}
      order by reaction_type
    `;
    expect(facts).toEqual([{ reaction_type: "disagree" }, { reaction_type: "helpful" }]);
    const auditRows = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.action_logs
      where agent_id = ${reactorContext.agent.id}
        and action = 'reaction.set'
        and target_id = ${primaryContentId}
        and outcome = 'succeeded'
    `;
    expect(auditRows).toEqual([{ count: 3 }]);

    const agentDetail = await contentReadService.getContent(reactorContext, {
      contentId: primaryContentId,
    });
    expect(agentDetail).toMatchObject({
      reactionCounts: { agree: 0, disagree: 1, helpful: 1 },
      reactionCountsByActorKind: {
        agent: { agree: 0, disagree: 1, helpful: 1 },
        human: { agree: 0, disagree: 0, helpful: 0 },
      },
      viewerState: { following: false, reactions: ["helpful", "disagree"] },
    });
    const anonymousDetail = await contentReadService.getContent(null, {
      contentId: primaryContentId,
    });
    expect(anonymousDetail).toMatchObject({
      reactionCounts: { agree: 0, disagree: 1, helpful: 1 },
      reactionCountsByActorKind: {
        agent: { agree: 0, disagree: 1, helpful: 1 },
        human: { agree: 0, disagree: 0, helpful: 0 },
      },
      viewerState: { following: false, reactions: [] },
    });

    const withoutHelpful = await setReaction(
      reactorContext,
      primaryContentId,
      "helpful",
      false,
    );
    expect(withoutHelpful).toMatchObject({
      result: {
        reactionCounts: { agree: 0, disagree: 1, helpful: 0 },
        viewerState: { reactions: ["disagree"] },
      },
      status: "succeeded",
    });
    const empty = await setReaction(reactorContext, primaryContentId, "disagree", false);
    expect(empty).toMatchObject({
      result: {
        reactionCounts: { agree: 0, disagree: 0, helpful: 0 },
        viewerState: { reactions: [] },
      },
      status: "succeeded",
    });
    await expect(
      postgres.sql`
        select 1
        from platform.reactions
        where actor_id = ${reactorContext.agent.actorId}
          and content_id = ${primaryContentId}
      `,
    ).resolves.toHaveLength(0);
  });

  it("projects all three simultaneous signals, multiple Actors, and human/Agent splits", async () => {
    for (const reaction of ["helpful", "agree", "disagree"] as const) {
      const outcome = await setReaction(reactorContext, primaryContentId, reaction, true);
      expect(outcome.status).toBe("succeeded");
    }
    await postgres.sql`
      insert into platform.reactions (actor_id, content_id, reaction_type)
      values (${reactorHumanActorId}, ${primaryContentId}, 'helpful')
    `;

    const agentDetail = await contentReadService.getContent(reactorContext, {
      contentId: primaryContentId,
    });
    expect(agentDetail).toMatchObject({
      reactionCounts: { agree: 1, disagree: 1, helpful: 2 },
      reactionCountsByActorKind: {
        agent: { agree: 1, disagree: 1, helpful: 1 },
        human: { agree: 0, disagree: 0, helpful: 1 },
      },
      viewerState: {
        following: false,
        reactions: ["helpful", "agree", "disagree"],
      },
    });
    const publicDetail = await contentReadService.getContent(null, {
      contentId: primaryContentId,
    });
    expect(publicDetail).toMatchObject({
      reactionCounts: { agree: 1, disagree: 1, helpful: 2 },
      reactionCountsByActorKind: {
        agent: { agree: 1, disagree: 1, helpful: 1 },
        human: { agree: 0, disagree: 0, helpful: 1 },
      },
      viewerState: { following: false, reactions: [] },
    });
    const facts = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.reactions
      where content_id = ${primaryContentId}
        and reaction_type = 'helpful'
    `;
    expect(facts).toEqual([{ count: 2 }]);
  });

  it("rejects self-reactions in the service and at the database boundary", async () => {
    const serviceOutcome = await setReaction(
      authorContext,
      primaryContentId,
      "agree",
      true,
    );
    expect(serviceOutcome).toMatchObject({
      error: { code: "SELF_REACTION_NOT_ALLOWED" },
      replayed: false,
      result: null,
      status: "failed",
    });
    await expect(
      postgres.sql`
        insert into platform.reactions (actor_id, content_id, reaction_type)
        values (${authorContext.agent.actorId}, ${primaryContentId}, 'agree')
      `,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      postgres.sql`
        select 1
        from platform.reactions
        where actor_id = ${authorContext.agent.actorId}
          and content_id = ${primaryContentId}
      `,
    ).resolves.toHaveLength(0);
  });

  it("requires both a published reply target and a published root discussion", async () => {
    const allowed = await setReaction(reactorContext, replyContentId, "helpful", true);
    expect(allowed).toMatchObject({
      result: {
        contentId: replyContentId,
        reactionCounts: { agree: 0, disagree: 0, helpful: 1 },
      },
      status: "succeeded",
    });
    await postgres.sql`
      update platform.content_items
      set version = version + 1,
          lifecycle_state = 'deleted',
          deleted_at = clock_timestamp()
      where id = ${replyRootContentId}
    `;

    const blockedByRoot = await setReaction(
      reactorContext,
      replyContentId,
      "agree",
      true,
    );
    expect(blockedByRoot).toMatchObject({
      error: { code: "CONTENT_STATE_INVALID" },
      result: null,
      status: "failed",
    });
    await expect(
      postgres.sql`
        insert into platform.reactions (actor_id, content_id, reaction_type)
        values (${reactorHumanActorId}, ${replyContentId}, 'agree')
      `,
    ).rejects.toMatchObject({ code: "55000" });
    const retained = await postgres.sql<{ reaction_type: string }[]>`
      select reaction_type
      from platform.reactions
      where actor_id = ${reactorContext.agent.actorId}
        and content_id = ${replyContentId}
    `;
    expect(retained).toEqual([{ reaction_type: "helpful" }]);
  });

  it("serializes concurrent identical writes into one fact and one logical audit", async () => {
    const idempotencyKey = `concurrent-${randomUUID()}`;
    const input: SetReactionInput = {
      active: true,
      contentId: concurrentContentId,
      idempotencyKey,
      reaction: "agree",
    };
    const outcomes = await Promise.all([
      reactionWriteService.setReaction(reactorContext, input, {
        channel: "integration-concurrent-a",
        requestId: `req-${randomUUID()}`,
      }),
      reactionWriteService.setReaction(reactorContext, input, {
        channel: "integration-concurrent-b",
        requestId: `req-${randomUUID()}`,
      }),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["succeeded", "succeeded"]);
    expect(outcomes.map((outcome) => outcome.replayed).sort()).toEqual([false, true]);
    for (const outcome of outcomes) {
      expect(outcome.result).toMatchObject({
        reactionCounts: { agree: 1, disagree: 0, helpful: 0 },
        viewerState: { reactions: ["agree"] },
      });
    }
    const rows = await postgres.sql<{ action_count: number; fact_count: number }[]>`
      select
        (
          select count(*)::integer
          from platform.reactions
          where actor_id = ${reactorContext.agent.actorId}
            and content_id = ${concurrentContentId}
            and reaction_type = 'agree'
        ) as fact_count,
        (
          select count(*)::integer
          from platform.action_logs
          where agent_id = ${reactorContext.agent.id}
            and action = 'reaction.set'
            and target_id = ${concurrentContentId}
            and outcome = 'succeeded'
        ) as action_count
    `;
    expect(rows).toEqual([{ action_count: 1, fact_count: 1 }]);
  });

  it("linearizes different Actors on one ContentItem as N+1 then N+2", async () => {
    const secondActor = await createReactionOnlyContext("linear-second");
    const [first, second] = await Promise.all([
      setReaction(reactorContext, concurrentContentId, "helpful", true),
      setReaction(secondActor, concurrentContentId, "helpful", true),
    ]);
    expect([first.status, second.status]).toEqual(["succeeded", "succeeded"]);
    expect(
      [first, second]
        .map((outcome) => outcome.result?.reactionCounts.helpful)
        .sort((left, right) => (left ?? 0) - (right ?? 0)),
    ).toEqual([1, 2]);
    const facts = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.reactions
      where content_id = ${concurrentContentId}
        and reaction_type = 'helpful'
    `;
    expect(facts).toEqual([{ count: 2 }]);
  });

  it("retains facts but projects zero signals and blocks new reactions after soft deletion", async () => {
    const created = await setReaction(reactorContext, deletionContentId, "helpful", true);
    expect(created).toMatchObject({
      result: { reactionCounts: { agree: 0, disagree: 0, helpful: 1 } },
      status: "succeeded",
    });
    await postgres.sql`
      update platform.content_items
      set version = version + 1,
          lifecycle_state = 'deleted',
          deleted_at = clock_timestamp()
      where id = ${deletionContentId}
    `;

    const anonymousDetail = await contentReadService.getContent(null, {
      contentId: deletionContentId,
    });
    expect(anonymousDetail).toMatchObject({
      content: { lifecycleState: "deleted" },
      reactionCounts: { agree: 0, disagree: 0, helpful: 0 },
      reactionCountsByActorKind: {
        agent: { agree: 0, disagree: 0, helpful: 0 },
        human: { agree: 0, disagree: 0, helpful: 0 },
      },
      viewerState: { following: false, reactions: [] },
    });
    await expect(
      contentReadService.getContent(reactorContext, { contentId: deletionContentId }),
    ).resolves.toMatchObject({
      reactionCounts: { agree: 0, disagree: 0, helpful: 0 },
      viewerState: { following: false, reactions: [] },
    });

    const blocked = await setReaction(reactorContext, deletionContentId, "agree", true);
    expect(blocked).toMatchObject({
      error: { code: "CONTENT_STATE_INVALID" },
      result: null,
      status: "failed",
    });
    await expect(
      postgres.sql`
        insert into platform.reactions (actor_id, content_id, reaction_type)
        values (${reactorContext.agent.actorId}, ${deletionContentId}, 'disagree')
      `,
    ).rejects.toMatchObject({ code: "55000" });
    const retained = await postgres.sql<{ reaction_type: string }[]>`
      select reaction_type
      from platform.reactions
      where actor_id = ${reactorContext.agent.actorId}
        and content_id = ${deletionContentId}
    `;
    expect(retained).toEqual([{ reaction_type: "helpful" }]);
  });

  it("enforces exact rolling-hour quotas for new and established Agents with retry timing", async () => {
    const newContext = await createReactionOnlyContext("quota-new");
    let newClock = new Date(Date.now() - 2 * 60 * 60 * 1_000 - 1_000);
    const newAgentService = new PostgresReactionWriteService(postgres.sql, {
      clock: () => newClock,
    });
    for (let index = 0; index < 60; index += 1) {
      const outcome = await newAgentService.setReaction(
        newContext,
        {
          active: false,
          contentId: apiContentId,
          idempotencyKey: `quota-new-${index}-${randomUUID()}`,
          reaction: "disagree",
        },
        {
          channel: "integration-quota-new",
          requestId: `req-${randomUUID()}`,
        },
      );
      expect(outcome.status).toBe("succeeded");
    }
    const limitedKey = `quota-new-limited-${randomUUID()}`;
    const limitedInput: SetReactionInput = {
      active: false,
      contentId: apiContentId,
      idempotencyKey: limitedKey,
      reaction: "disagree",
    };
    const newLimited = await newAgentService.setReaction(newContext, limitedInput, {
      channel: "integration-quota-new",
      requestId: `req-${randomUUID()}`,
    });
    expect(newLimited).toMatchObject({
      decision: "deny",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 60,
          limit_dimension: "agent_reaction_hour",
          new_agent_window: true,
          rule_version: "reaction-rate-v1",
        },
        retryAfterMs: 3_600_000,
        retryable: true,
      },
      result: null,
      status: "denied",
    });
    const newAgentAudit = await postgres.sql<
      {
        error_code: string | null;
        outcome: string;
        rate_rule_version: string | null;
        row_count: number;
      }[]
    >`
      select
        outcome,
        error_code,
        after_state ->> 'rate_rule_version' as rate_rule_version,
        count(*)::integer as row_count
      from platform.action_logs
      where agent_id = ${newContext.agent.id}
        and action = 'reaction.set'
        and channel = 'integration-quota-new'
      group by outcome, error_code, after_state ->> 'rate_rule_version'
      order by outcome
    `;
    expect(newAgentAudit).toEqual([
      {
        error_code: "RATE_LIMITED",
        outcome: "denied",
        rate_rule_version: "reaction-rate-v1",
        row_count: 1,
      },
      {
        error_code: null,
        outcome: "succeeded",
        rate_rule_version: "reaction-rate-v1",
        row_count: 60,
      },
    ]);
    newClock = new Date(Date.now() - 1_000);
    const recovered = await newAgentService.setReaction(newContext, limitedInput, {
      channel: "integration-quota-new",
      requestId: `req-${randomUUID()}`,
    });
    expect(recovered).toMatchObject({
      error: null,
      replayed: false,
      status: "succeeded",
    });

    const establishedContext = await createReactionOnlyContext("quota-established");
    await postgres.sql`
        alter table platform.agents
        disable trigger agents_prepare_update
    `;
    try {
      await postgres.sql`
          update platform.agents
          set created_at = created_at - interval '25 hours',
              activated_at = activated_at - interval '25 hours'
          where id = ${establishedContext.agent.id}
      `;
    } finally {
      await postgres.sql`
          alter table platform.agents
          enable trigger agents_prepare_update
      `;
    }
    const establishedClock = new Date(Date.now() - 1_000);
    const establishedAgentService = new PostgresReactionWriteService(postgres.sql, {
      clock: () => establishedClock,
    });
    for (let index = 0; index < 120; index += 1) {
      const outcome = await establishedAgentService.setReaction(
        establishedContext,
        {
          active: false,
          contentId: apiContentId,
          idempotencyKey: `quota-established-${index}-${randomUUID()}`,
          reaction: "disagree",
        },
        {
          channel: "integration-quota-established",
          requestId: `req-${randomUUID()}`,
        },
      );
      expect(outcome.status).toBe("succeeded");
    }
    const establishedLimited = await establishedAgentService.setReaction(
      establishedContext,
      {
        active: false,
        contentId: apiContentId,
        idempotencyKey: `quota-established-limited-${randomUUID()}`,
        reaction: "disagree",
      },
      {
        channel: "integration-quota-established",
        requestId: `req-${randomUUID()}`,
      },
    );
    expect(establishedLimited).toMatchObject({
      decision: "deny",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 120,
          limit_dimension: "agent_reaction_hour",
          new_agent_window: false,
          rule_version: "reaction-rate-v1",
        },
        retryAfterMs: 3_600_000,
        retryable: true,
      },
      result: null,
      status: "denied",
    });
  }, 30_000);

  it("counts later-clocked commits when a stale-now request checks its quota", async () => {
    const context = await createReactionOnlyContext("quota-stale-now");
    const laterNow = new Date(Date.now() - 1_000);
    const staleNow = new Date(laterNow.valueOf() - 5 * 60 * 1_000);
    const laterClockService = new PostgresReactionWriteService(postgres.sql, {
      clock: () => laterNow,
    });
    for (let index = 0; index < 60; index += 1) {
      const outcome = await laterClockService.setReaction(
        context,
        {
          active: false,
          contentId: apiContentId,
          idempotencyKey: `quota-later-clock-${index}-${randomUUID()}`,
          reaction: "helpful",
        },
        {
          channel: "integration-quota-overtake",
          requestId: `req-${randomUUID()}`,
        },
      );
      expect(outcome.status).toBe("succeeded");
    }

    const staleClockService = new PostgresReactionWriteService(postgres.sql, {
      clock: () => staleNow,
    });
    const staleRequest = await staleClockService.setReaction(
      context,
      {
        active: false,
        contentId: apiContentId,
        idempotencyKey: `quota-stale-clock-${randomUUID()}`,
        reaction: "helpful",
      },
      {
        channel: "integration-quota-overtake",
        requestId: `req-${randomUUID()}`,
      },
    );
    expect(staleRequest).toMatchObject({
      decision: "deny",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 60,
          limit_dimension: "agent_reaction_hour",
          new_agent_window: true,
          rule_version: "reaction-rate-v1",
        },
        retryAfterMs: 3_900_000,
        retryable: true,
      },
      replayed: false,
      result: null,
      status: "denied",
    });

    const audit = await postgres.sql<
      { denied_count: number; later_succeeded_count: number }[]
    >`
      select
        count(*) filter (
          where outcome = 'succeeded'
            and occurred_at > ${staleNow}
        )::integer as later_succeeded_count,
        count(*) filter (where outcome = 'denied')::integer as denied_count
      from platform.action_logs
      where agent_id = ${context.agent.id}
        and action = 'reaction.set'
        and channel = 'integration-quota-overtake'
    `;
    expect(audit).toEqual([{ denied_count: 1, later_succeeded_count: 60 }]);
  }, 15_000);

  it("makes racing Actor, Content, and primary Community mutations win before direct inserts", async () => {
    await expectBlockedReactionInsert({
      actorId: reactorContext.agent.actorId,
      contentId: apiContentId,
      label: "Actor restriction race",
      mutate: async (connection) => {
        await connection`
            update platform.actors
            set status = 'restricted'
            where id = ${reactorContext.agent.actorId}
          `;
        await connection`
            update platform.agents
            set status = 'restricted',
                restriction_reason_code = 'reaction_race_test',
                restricted_at = clock_timestamp()
            where id = ${reactorContext.agent.id}
          `;
      },
      reaction: "disagree",
    });
    await postgres.sql.begin(async (transaction) => {
      await transaction`
          update platform.actors
          set status = 'active'
          where id = ${reactorContext.agent.actorId}
        `;
      await transaction`
          update platform.agents
          set status = 'active',
              restriction_reason_code = null,
              restricted_at = null
          where id = ${reactorContext.agent.id}
        `;
    });

    await expectBlockedReactionInsert({
      actorId: reactorHumanActorId,
      contentId: concurrentContentId,
      label: "Content hide race",
      mutate: async (connection) => {
        await connection`
            update platform.content_items
            set version = version + 1,
                distribution_state = 'hidden'
            where id = ${concurrentContentId}
          `;
      },
      reaction: "disagree",
    });
    await postgres.sql`
        update platform.content_items
        set version = version + 1,
            distribution_state = 'normal'
        where id = ${concurrentContentId}
      `;

    await expectBlockedReactionInsert({
      actorId: reactorContext.agent.actorId,
      contentId: raceDeletionContentId,
      label: "Content deletion race",
      mutate: async (connection) => {
        await connection`
            update platform.content_items
            set version = version + 1,
                lifecycle_state = 'deleted',
                deleted_at = clock_timestamp()
            where id = ${raceDeletionContentId}
          `;
      },
      reaction: "helpful",
    });

    await expectBlockedReactionInsert({
      actorId: reactorHumanActorId,
      contentId: suspendedPrimaryContentId,
      label: "Primary Community suspension race",
      mutate: async (connection) => {
        await connection`
            update platform.communities
            set version = version + 1,
                status = 'suspended'
            where id = ${suspendedPrimaryCommunityId}
          `;
      },
      reaction: "helpful",
    });
  }, 20_000);

  it("uses only the canonical primary Community for reaction eligibility", async () => {
    const mixedAllowed = await setReaction(
      reactorContext,
      mixedCommunityContentId,
      "agree",
      true,
    );
    expect(mixedAllowed).toMatchObject({
      decision: "allow",
      error: null,
      status: "succeeded",
    });
    await expect(
      postgres.sql`
        insert into platform.reactions (actor_id, content_id, reaction_type)
        values (${reactorHumanActorId}, ${mixedCommunityContentId}, 'agree')
        returning actor_id
      `,
    ).resolves.toHaveLength(1);

    const suspendedKey = `suspended-primary-${randomUUID()}`;
    const suspended = await setReaction(
      reactorContext,
      suspendedPrimaryContentId,
      "disagree",
      true,
      suspendedKey,
    );
    expect(suspended).toMatchObject({
      decision: "deny",
      error: { code: "COMMUNITY_RESTRICTED", retryable: false },
      result: null,
      status: "denied",
    });
    const suspendedReplay = await setReaction(
      reactorContext,
      suspendedPrimaryContentId,
      "disagree",
      true,
      suspendedKey,
    );
    expect(suspendedReplay).toEqual({ ...suspended, replayed: true });
    await expect(
      postgres.sql`
        insert into platform.reactions (actor_id, content_id, reaction_type)
        values (${reactorHumanActorId}, ${suspendedPrimaryContentId}, 'disagree')
      `,
    ).rejects.toMatchObject({ code: "55000" });

    await postgres.sql`
      update platform.communities
      set version = version + 1,
          status = 'archived',
          deleted_at = clock_timestamp()
      where id = ${deletedPrimaryCommunityId}
    `;
    const deleted = await setReaction(
      reactorContext,
      deletedPrimaryContentId,
      "helpful",
      true,
    );
    expect(deleted).toMatchObject({
      decision: "allow",
      error: { code: "CONTENT_NOT_FOUND", retryable: false },
      result: null,
      status: "failed",
    });
    await expect(
      postgres.sql`
        insert into platform.reactions (actor_id, content_id, reaction_type)
        values (${reactorHumanActorId}, ${deletedPrimaryContentId}, 'helpful')
      `,
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("keeps Owner-first Credential revocation and Reaction authorization deadlock-free", async () => {
    const context = await createReactionOnlyContext("revoke-race");
    if (!databaseUrl) throw new Error("DATABASE_URL is required for this test");
    const applicationName = `reaction-revoke-${marker}`;
    const isolatedUrl = new URL(databaseUrl);
    isolatedUrl.searchParams.set("application_name", applicationName);
    const isolatedPostgres = createPostgresDependency(isolatedUrl.toString());
    const isolatedReactionService = new PostgresReactionWriteService(
      isolatedPostgres.sql,
    );
    const ownerLock = await postgres.sql.reserve();
    let ownerTransactionOpen = false;
    try {
      await ownerLock`begin`;
      ownerTransactionOpen = true;
      await ownerLock`
        select id
        from platform.owners
        where id = ${context.owner.id}
        for update
      `;
      const reactionPromise = isolatedReactionService.setReaction(
        context,
        {
          active: true,
          contentId: apiContentId,
          idempotencyKey: `revoke-race-${randomUUID()}`,
          reaction: "agree",
        },
        {
          channel: "integration-revoke-race",
          requestId: `req-${randomUUID()}`,
        },
      );
      await waitForApplicationLock(applicationName, "Owner-first Reaction authorization");
      const revokePromise = agentService.revokeCredential(
        context.owner.id,
        context.credential.id,
        `req-${randomUUID()}`,
      );
      await ownerLock`commit`;
      ownerTransactionOpen = false;
      const [reaction, revoked] = await Promise.race([
        Promise.all([reactionPromise, revokePromise]),
        delay(5_000).then(() => {
          throw new Error("Credential revocation and Reaction authorization deadlocked");
        }),
      ]);
      if (reaction.status === "succeeded") {
        expect(reaction).toMatchObject({
          decision: "allow",
          error: null,
        });
      } else {
        expect(reaction).toMatchObject({
          decision: "allow",
          error: {
            code: "AUTHORIZATION_CONTEXT_STALE",
            retryable: false,
          },
          result: null,
          status: "failed",
        });
      }
      expect(revoked).toMatchObject({
        id: context.credential.id,
        status: "revoked",
      });
      const facts = await postgres.sql<{ reaction_type: string }[]>`
        select reaction_type
        from platform.reactions
        where actor_id = ${context.agent.actorId}
          and content_id = ${apiContentId}
      `;
      expect(facts).toEqual(
        reaction.status === "succeeded" ? [{ reaction_type: "agree" }] : [],
      );
    } finally {
      if (ownerTransactionOpen) await ownerLock`rollback`;
      ownerLock.release();
      await isolatedPostgres.close();
    }
  });
});
