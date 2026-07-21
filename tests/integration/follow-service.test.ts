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
  type AgentScope,
} from "../../packages/domain/src/agent-connection.js";
import {
  PostgresFollowService,
  type FollowNotificationLevel,
  type FollowTarget,
  type SetFollowInput,
} from "../../packages/domain/src/follow.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeFollowService = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const agentConnectionOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: {
    1: "follow-service-integration-pepper-is-test-data-only",
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

describeFollowService("PostgresFollowService", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const agentService = new PostgresAgentConnectionService(
    postgres.sql,
    agentConnectionOptions,
  );
  const followService = new PostgresFollowService(postgres.sql, {
    cursorSigningKey: Buffer.from(
      "follow-service-integration-cursor-signing-key-material-v1",
      "utf8",
    ),
  });
  dependencies.push(postgres);
  const apiKeysByCredentialId = new Map<string, string>();

  let marker = "";
  let primaryContext: AgentCredentialContext;
  let secondaryContext: AgentCredentialContext;
  let actorTargetId = "";
  let idempotencyActorTargetId = "";
  let inactiveReplayActorTargetId = "";
  let rateActorTargetId = "";
  let symbolId = "";
  let symbolTicker = "";
  let tamperSymbolId = "";
  let tamperSymbolTicker = "";
  let lifecycleTopicId = "";
  let lifecycleTopicSlug = "";
  let semanticsTopicId = "";
  let semanticsTopicSlug = "";
  let tamperTopicId = "";
  let tamperTopicSlug = "";
  let lifecycleContentId = "";
  let hiddenReplayContentId = "";
  let cursorTopics: Array<{ id: string; slug: string }> = [];

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
        ${`Follow ${label} Owner`},
        ${`follow-${label}-${marker}@example.test`},
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

  async function createAgentContext(
    label: string,
    options: {
      scopes?: AgentScope[];
      tier?: AgentPolicyTier;
    } = {},
  ): Promise<AgentCredentialContext> {
    const ownerId = await createVerifiedOwner(label);
    const created = await agentService.createAgent(
      ownerId,
      {
        displayName: `Follow ${label} Agent`,
        handle: `fa-${label.slice(0, 10)}-${marker}`,
      },
      randomUUID(),
    );
    await activatePolicy(ownerId, created.agent.id, options.tier ?? "autonomous");
    const credential = await agentService.createCredential(
      ownerId,
      created.agent.id,
      {
        name: `Follow ${label} integration`,
        scopes: options.scopes ?? ["research:read", "follow:write"],
      },
      randomUUID(),
    );
    const context = await agentService.authenticateStaticApiKey(credential.apiKey);
    apiKeysByCredentialId.set(context.credential.id, credential.apiKey);
    return context;
  }

  async function refreshContext(
    context: AgentCredentialContext,
  ): Promise<AgentCredentialContext> {
    const apiKey = apiKeysByCredentialId.get(context.credential.id);
    if (!apiKey) throw new Error("The integration credential secret was not retained");
    return agentService.authenticateStaticApiKey(apiKey);
  }

  async function createHumanActor(label: string): Promise<string> {
    const ownerId = await createVerifiedOwner(`target-${label}`);
    const rows = await postgres.sql<{ id: string }[]>`
      insert into platform.actors (
        kind,
        owner_id,
        handle,
        display_name,
        status
      )
      values (
        'human',
        ${ownerId},
        ${`ft-${label.slice(0, 8)}-${marker}`},
        ${`Follow target ${label}`},
        'active'
      )
      returning id
    `;
    return requireId(rows[0]?.id, `${label} target Actor`);
  }

  async function createPost(options: {
    authorActorId: string;
    communityId: string;
    title: string;
  }): Promise<string> {
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const body = `Follow service integration fixture ${contentId}`;
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.content_items (
          id,
          kind,
          author_actor_id,
          primary_community_id,
          root_id,
          depth
        )
        values (
          ${contentId},
          'post',
          ${options.authorActorId},
          ${options.communityId},
          ${contentId},
          0
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
          source_version,
          content_hash,
          public_node_serialized_bytes
        )
        values (
          ${revisionId},
          ${contentId},
          1,
          ${options.title},
          ${body},
          ${body},
          ${options.authorActorId},
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
    return contentId;
  }

  async function setFollow(
    service: PostgresFollowService,
    context: AgentCredentialContext,
    target: FollowTarget,
    options: {
      active: boolean;
      channel?: string;
      idempotencyKey?: string;
      notificationLevel?: FollowNotificationLevel;
      requestId?: string;
    },
  ) {
    const input: SetFollowInput = {
      active: options.active,
      idempotencyKey: options.idempotencyKey ?? `follow-${randomUUID()}`,
      targetId: target.targetId,
      targetType: target.targetType,
      ...(options.notificationLevel === undefined
        ? {}
        : { notificationLevel: options.notificationLevel }),
    };
    return service.setFollow(context, input, {
      channel: options.channel ?? "integration-follow",
      requestId: options.requestId ?? `req-${randomUUID()}`,
    });
  }

  beforeAll(async () => {
    marker = randomUUID().replaceAll("-", "").slice(0, 8);
    primaryContext = await createAgentContext("primary");
    secondaryContext = await createAgentContext("secondary");

    actorTargetId = await createHumanActor("actor");
    idempotencyActorTargetId = await createHumanActor("idempotency");
    inactiveReplayActorTargetId = await createHumanActor("inactive-replay");
    rateActorTargetId = await createHumanActor("rate");

    symbolId = randomUUID();
    symbolTicker = `F${marker.toUpperCase()}`;
    tamperSymbolId = randomUUID();
    tamperSymbolTicker = `T${marker.toUpperCase()}`;
    lifecycleTopicId = randomUUID();
    lifecycleTopicSlug = `follow-lifecycle-${marker}`;
    semanticsTopicId = randomUUID();
    semanticsTopicSlug = `follow-semantics-${marker}`;
    tamperTopicId = randomUUID();
    tamperTopicSlug = `follow-tamper-${marker}`;
    cursorTopics = Array.from({ length: 3 }, (_, index) => ({
      id: randomUUID(),
      slug: `follow-cursor-${marker}-${index + 1}`,
    }));
    const [cursorTopicOne, cursorTopicTwo, cursorTopicThree] = cursorTopics;
    if (!cursorTopicOne || !cursorTopicTwo || !cursorTopicThree) {
      throw new Error("Follow cursor Topic fixtures were not created");
    }
    const communityId = randomUUID();
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.symbols (
          id,
          community_candidate_id,
          ticker,
          exchange,
          name,
          status
        )
        values
          (
            ${symbolId},
            ${randomUUID()},
            ${symbolTicker},
            'TEST',
            'Follow service Symbol',
            'active'
          ),
          (
            ${tamperSymbolId},
            ${randomUUID()},
            ${tamperSymbolTicker},
            'TEST',
            'Follow resource-tamper Symbol',
            'active'
          )
      `;
      await transaction`
        insert into platform.topics (id, slug, name)
        values
          (
            ${lifecycleTopicId},
            ${lifecycleTopicSlug},
            'Follow lifecycle Topic'
          ),
          (
            ${semanticsTopicId},
            ${semanticsTopicSlug},
            'Follow notification semantics Topic'
          ),
          (
            ${tamperTopicId},
            ${tamperTopicSlug},
            'Follow resource-tamper Topic'
          ),
          (
            ${cursorTopicOne.id},
            ${cursorTopicOne.slug},
            'Follow cursor Topic 1'
          ),
          (
            ${cursorTopicTwo.id},
            ${cursorTopicTwo.slug},
            'Follow cursor Topic 2'
          ),
          (
            ${cursorTopicThree.id},
            ${cursorTopicThree.slug},
            'Follow cursor Topic 3'
          )
      `;
      await transaction`
        insert into platform.communities (
          id,
          slug,
          name,
          description,
          kind
        )
        values (
          ${communityId},
          ${`follow-service-${marker}`},
          'Follow Service Integration Community',
          'Canonical primary Community for Follow service integration fixtures.',
          'general'
        )
      `;
    });

    lifecycleContentId = await createPost({
      authorActorId: primaryContext.agent.actorId,
      communityId,
      title: "Follow lifecycle Content",
    });
    hiddenReplayContentId = await createPost({
      authorActorId: secondaryContext.agent.actorId,
      communityId,
      title: "Follow hidden replay Content",
    });
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("passes the real Follow readiness gate", async () => {
    await expect(followService.checkReady()).resolves.toBeUndefined();
  });

  it("follows, updates, lists, filters, and removes all four target kinds", async () => {
    const targets: Array<{
      initialLevel: FollowNotificationLevel | undefined;
      target: FollowTarget;
      updatedLevel: FollowNotificationLevel;
    }> = [
      {
        initialLevel: "new_posts",
        target: { targetId: actorTargetId, targetType: "actor" },
        updatedLevel: "all_events",
      },
      {
        initialLevel: undefined,
        target: { targetId: symbolTicker.toLowerCase(), targetType: "symbol" },
        updatedLevel: "new_posts",
      },
      {
        initialLevel: "all_events",
        target: { targetId: lifecycleTopicSlug.toUpperCase(), targetType: "topic" },
        updatedLevel: "feed_only",
      },
      {
        initialLevel: undefined,
        target: { targetId: lifecycleContentId, targetType: "content" },
        updatedLevel: "all_events",
      },
    ];

    for (const fixture of targets) {
      const created = await setFollow(followService, primaryContext, fixture.target, {
        active: true,
        ...(fixture.initialLevel === undefined
          ? {}
          : { notificationLevel: fixture.initialLevel }),
      });
      expect(created).toMatchObject({
        decision: "allow",
        error: null,
        replayed: false,
        result: {
          active: true,
          notificationLevel: fixture.initialLevel ?? "feed_only",
          targetType: fixture.target.targetType,
        },
        status: "succeeded",
      });
      const updated = await setFollow(followService, primaryContext, fixture.target, {
        active: true,
        notificationLevel: fixture.updatedLevel,
      });
      expect(updated).toMatchObject({
        result: {
          active: true,
          notificationLevel: fixture.updatedLevel,
          targetType: fixture.target.targetType,
        },
        status: "succeeded",
      });
    }

    const page = await followService.listFollows(primaryContext, { limit: 10 });
    expect(
      page.items
        .map((item) => ({
          level: item.notificationLevel,
          targetId: item.targetId,
          targetType: item.targetType,
        }))
        .sort((left, right) => left.targetType.localeCompare(right.targetType)),
    ).toEqual([
      { level: "all_events", targetId: actorTargetId, targetType: "actor" },
      {
        level: "all_events",
        targetId: lifecycleContentId,
        targetType: "content",
      },
      { level: "new_posts", targetId: symbolTicker, targetType: "symbol" },
      { level: "feed_only", targetId: lifecycleTopicSlug, targetType: "topic" },
    ]);
    expect(page.page).toEqual({ hasMore: false, limit: 10, nextCursor: null });

    const symbolPage = await followService.listFollows(primaryContext, {
      limit: 10,
      targetType: "symbol",
    });
    expect(symbolPage.items).toHaveLength(1);
    expect(symbolPage.items[0]).toMatchObject({
      notificationLevel: "new_posts",
      targetId: symbolTicker,
      targetType: "symbol",
    });

    for (const fixture of targets) {
      const removed = await setFollow(followService, primaryContext, fixture.target, {
        active: false,
      });
      expect(removed).toMatchObject({
        result: {
          active: false,
          notificationLevel: null,
          targetType: fixture.target.targetType,
        },
        status: "succeeded",
      });
    }
    await expect(
      followService.listFollows(primaryContext, { limit: 10 }),
    ).resolves.toMatchObject({ items: [] });
  });

  it("defaults new follows, preserves omitted preferences, and ignores them on unfollow", async () => {
    const target: FollowTarget = {
      targetId: semanticsTopicSlug,
      targetType: "topic",
    };
    const created = await setFollow(followService, primaryContext, target, {
      active: true,
    });
    expect(created.result?.notificationLevel).toBe("feed_only");

    const changed = await setFollow(followService, primaryContext, target, {
      active: true,
      notificationLevel: "all_events",
    });
    expect(changed.result?.notificationLevel).toBe("all_events");

    const preserved = await setFollow(followService, primaryContext, target, {
      active: true,
    });
    expect(preserved).toMatchObject({
      result: { active: true, notificationLevel: "all_events" },
      status: "succeeded",
    });
    expect(preserved.result?.updatedAt).toEqual(changed.result?.updatedAt);

    const removed = await setFollow(followService, primaryContext, target, {
      active: false,
      notificationLevel: "new_posts",
    });
    expect(removed.result).toMatchObject({
      active: false,
      notificationLevel: null,
    });

    const recreated = await setFollow(followService, primaryContext, target, {
      active: true,
    });
    expect(recreated.result?.notificationLevel).toBe("feed_only");
    await setFollow(followService, primaryContext, target, { active: false });

    const events = await postgres.sql<
      { event_type: string; notification_level: string | null }[]
    >`
      select
        event_type,
        payload ->> 'notification_level' as notification_level
      from system.outbox_events
      where aggregate_type = 'follow'
        and aggregate_id = ${`${primaryContext.agent.actorId}:topic:${semanticsTopicId}`}
      order by aggregate_sequence
    `;
    expect(events.map((event) => event.event_type)).toEqual([
      "follow.changed",
      "follow.changed",
      "follow.confirmed",
      "follow.changed",
      "follow.changed",
      "follow.changed",
    ]);
    expect(events[3]?.notification_level).toBeNull();
    expect(events[4]?.notification_level).toBe("feed_only");
  });

  it("rejects an active ambiguous Symbol command but cleans up its unique existing fact", async () => {
    const target: FollowTarget = {
      targetId: symbolTicker,
      targetType: "symbol",
    };
    const created = await setFollow(followService, secondaryContext, target, {
      active: true,
      notificationLevel: "new_posts",
    });
    expect(created).toMatchObject({
      result: {
        active: true,
        notificationLevel: "new_posts",
        targetId: symbolTicker,
      },
      status: "succeeded",
    });

    const ambiguousPeerId = randomUUID();
    await postgres.sql`
      insert into platform.symbols (
        id,
        community_candidate_id,
        ticker,
        exchange,
        name,
        status
      )
      values (
        ${ambiguousPeerId},
        ${randomUUID()},
        ${symbolTicker},
        'TEST2',
        'Follow service ambiguous Symbol peer',
        'active'
      )
    `;

    const ambiguous = await setFollow(followService, secondaryContext, target, {
      active: true,
    });
    expect(ambiguous).toMatchObject({
      decision: "allow",
      error: { code: "TARGET_AMBIGUOUS", retryable: false },
      result: null,
      status: "failed",
    });

    const removed = await setFollow(followService, secondaryContext, target, {
      active: false,
    });
    expect(removed).toMatchObject({
      result: {
        active: false,
        notificationLevel: null,
        targetId: symbolTicker,
      },
      status: "succeeded",
    });
    const remaining = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.follows
      where follower_actor_id = ${secondaryContext.agent.actorId}
        and target_type = 'symbol'
        and target_symbol_id in (${symbolId}, ${ambiguousPeerId})
    `;
    expect(remaining).toEqual([{ count: 0 }]);
  });

  it("replays exact commands without duplicate audit or events and rejects conflicts", async () => {
    const idempotencyKey = `follow-replay-${randomUUID()}`;
    const requestId = `req-${randomUUID()}`;
    const input: SetFollowInput = {
      active: true,
      idempotencyKey,
      notificationLevel: "new_posts",
      targetId: idempotencyActorTargetId.toUpperCase(),
      targetType: "actor",
    };
    const first = await followService.setFollow(primaryContext, input, {
      channel: "integration-follow-replay",
      requestId,
    });
    expect(first).toMatchObject({
      replayed: false,
      result: {
        active: true,
        notificationLevel: "new_posts",
        targetId: idempotencyActorTargetId,
      },
      status: "succeeded",
    });

    const replay = await followService.setFollow(
      primaryContext,
      { ...input, targetId: idempotencyActorTargetId },
      {
        channel: "integration-follow-replay",
        requestId: `req-${randomUUID()}`,
      },
    );
    expect(replay).toEqual({ ...first, replayed: true });

    const conflict = await followService.setFollow(
      primaryContext,
      { ...input, active: false, targetId: idempotencyActorTargetId },
      {
        channel: "integration-follow-replay",
        requestId: `req-${randomUUID()}`,
      },
    );
    expect(conflict).toMatchObject({
      decision: "allow",
      error: { code: "IDEMPOTENCY_CONFLICT", retryable: false },
      replayed: false,
      result: null,
      status: "failed",
    });

    const persisted = await postgres.sql<
      {
        action_count: number;
        event_count: number;
        event_type: string;
        idempotency_count: number;
        payload: Record<string, unknown>;
        target_id: string;
      }[]
    >`
      select
        action.target_id::text as target_id,
        event.event_type,
        event.payload,
        (
          select count(*)::integer
          from platform.action_logs as counted_action
          where counted_action.request_id = ${requestId}
            and counted_action.action = 'follow.set'
        ) as action_count,
        (
          select count(*)::integer
          from system.outbox_events as counted_event
          where counted_event.id = action.outbox_event_id
        ) as event_count,
        (
          select count(*)::integer
          from platform.idempotency_records as idempotency
          where idempotency.principal_scope_key =
                ${`credential:${primaryContext.credential.id}`}
            and idempotency.operation = 'set_follow'
            and idempotency.idempotency_key = ${idempotencyKey}
        ) as idempotency_count
      from platform.action_logs as action
      join system.outbox_events as event on event.id = action.outbox_event_id
      where action.request_id = ${requestId}
        and action.action = 'follow.set'
    `;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      action_count: 1,
      event_count: 1,
      event_type: "follow.changed",
      idempotency_count: 1,
      payload: {
        active: true,
        changed: true,
        follower_actor_id: primaryContext.agent.actorId,
        notification_level: "new_posts",
        target_id: idempotencyActorTargetId,
        target_resource_id: idempotencyActorTargetId,
        target_type: "actor",
      },
      target_id: idempotencyActorTargetId,
    });

    await setFollow(
      followService,
      primaryContext,
      { targetId: idempotencyActorTargetId, targetType: "actor" },
      { active: false },
    );
  });

  it("serializes concurrent requests for one idempotency key into one commit", async () => {
    const context = await createAgentContext("idem-race");
    const idempotencyKey = `follow-concurrent-${randomUUID()}`;
    const channel = "integration-follow-concurrent";
    const target: FollowTarget = {
      targetId: idempotencyActorTargetId,
      targetType: "actor",
    };

    const outcomes = await Promise.all([
      setFollow(followService, context, target, {
        active: true,
        channel,
        idempotencyKey,
        notificationLevel: "new_posts",
      }),
      setFollow(followService, context, target, {
        active: true,
        channel,
        idempotencyKey,
        notificationLevel: "new_posts",
      }),
    ]);

    expect(outcomes.every((outcome) => outcome.status === "succeeded")).toBe(true);
    expect(outcomes.map((outcome) => outcome.replayed).sort()).toEqual([false, true]);
    expect(outcomes[0]?.result).toEqual(outcomes[1]?.result);

    const committed = await postgres.sql<
      {
        action_count: number;
        event_count: number;
        follow_count: number;
        idempotency_count: number;
      }[]
    >`
      select
        (
          select count(*)::integer
          from platform.follows
          where follower_actor_id = ${context.agent.actorId}
            and target_actor_id = ${idempotencyActorTargetId}
        ) as follow_count,
        (
          select count(*)::integer
          from platform.idempotency_records
          where principal_scope_key = ${`credential:${context.credential.id}`}
            and operation = 'set_follow'
            and idempotency_key = ${idempotencyKey}
            and status = 'succeeded'
        ) as idempotency_count,
        (
          select count(*)::integer
          from platform.action_logs
          where agent_id = ${context.agent.id}
            and action = 'follow.set'
            and channel = ${channel}
        ) as action_count,
        (
          select count(*)::integer
          from system.outbox_events as event
          join platform.action_logs as action
            on action.outbox_event_id = event.id
          where action.agent_id = ${context.agent.id}
            and action.action = 'follow.set'
            and action.channel = ${channel}
        ) as event_count
    `;
    expect(committed).toEqual([
      {
        action_count: 1,
        event_count: 1,
        follow_count: 1,
        idempotency_count: 1,
      },
    ]);
  });

  it("fails closed when persisted success semantics or resolved resources are tampered", async () => {
    const activeKey = `follow-tamper-active-${randomUUID()}`;
    const levelKey = `follow-tamper-level-${randomUUID()}`;
    const symbolResourceKey = `follow-tamper-symbol-resource-${randomUUID()}`;
    const topicResourceKey = `follow-tamper-topic-resource-${randomUUID()}`;
    const activeInput: SetFollowInput = {
      active: true,
      idempotencyKey: activeKey,
      targetId: lifecycleTopicSlug,
      targetType: "topic",
    };
    const levelInput: SetFollowInput = {
      active: true,
      idempotencyKey: levelKey,
      notificationLevel: "all_events",
      targetId: semanticsTopicSlug,
      targetType: "topic",
    };
    const symbolResourceInput: SetFollowInput = {
      active: true,
      idempotencyKey: symbolResourceKey,
      targetId: tamperSymbolTicker,
      targetType: "symbol",
    };
    const topicResourceInput: SetFollowInput = {
      active: true,
      idempotencyKey: topicResourceKey,
      targetId: tamperTopicSlug,
      targetType: "topic",
    };
    const inputs = [activeInput, levelInput, symbolResourceInput, topicResourceInput];
    for (const input of inputs) {
      const outcome = await followService.setFollow(secondaryContext, input, {
        channel: "integration-follow-tamper",
        requestId: `req-${randomUUID()}`,
      });
      expect(outcome.status).toBe("succeeded");
    }

    await postgres.sql`
      alter table platform.idempotency_records
      disable trigger idempotency_records_prepare_update
    `;
    try {
      await postgres.sql`
        update platform.idempotency_records
        set response_body = jsonb_set(
          jsonb_set(response_body, '{result,active}', 'false'::jsonb),
          '{result,notification_level}',
          'null'::jsonb
        )
        where principal_scope_key =
              ${`credential:${secondaryContext.credential.id}`}
          and operation = 'set_follow'
          and idempotency_key = ${activeKey}
      `;
      await postgres.sql`
        update platform.idempotency_records
        set response_body = jsonb_set(
          response_body,
          '{result,notification_level}',
          '"feed_only"'::jsonb
        )
        where principal_scope_key =
              ${`credential:${secondaryContext.credential.id}`}
          and operation = 'set_follow'
          and idempotency_key = ${levelKey}
      `;
      await postgres.sql`
        update platform.idempotency_records
        set resource_id = ${tamperTopicId}
        where principal_scope_key =
              ${`credential:${secondaryContext.credential.id}`}
          and operation = 'set_follow'
          and idempotency_key = ${symbolResourceKey}
      `;
      await postgres.sql`
        update platform.idempotency_records
        set resource_id = ${tamperSymbolId}
        where principal_scope_key =
              ${`credential:${secondaryContext.credential.id}`}
          and operation = 'set_follow'
          and idempotency_key = ${topicResourceKey}
      `;
    } finally {
      await postgres.sql`
        alter table platform.idempotency_records
        enable trigger idempotency_records_prepare_update
      `;
    }

    for (const input of inputs) {
      const replay = await followService.setFollow(secondaryContext, input, {
        channel: "integration-follow-tamper",
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

    await setFollow(
      followService,
      secondaryContext,
      { targetId: lifecycleTopicSlug, targetType: "topic" },
      { active: false },
    );
    await setFollow(
      followService,
      secondaryContext,
      { targetId: semanticsTopicSlug, targetType: "topic" },
      { active: false },
    );
    await setFollow(
      followService,
      secondaryContext,
      { targetId: tamperSymbolTicker, targetType: "symbol" },
      { active: false },
    );
    await setFollow(
      followService,
      secondaryContext,
      { targetId: tamperTopicSlug, targetType: "topic" },
      { active: false },
    );
  });

  it("replays after targets become unavailable and still permits cleanup", async () => {
    const actorTarget: FollowTarget = {
      targetId: inactiveReplayActorTargetId,
      targetType: "actor",
    };
    const actorKey = `follow-inactive-replay-${randomUUID()}`;
    const actorFirst = await setFollow(followService, secondaryContext, actorTarget, {
      active: true,
      idempotencyKey: actorKey,
      notificationLevel: "all_events",
    });
    await postgres.sql`
      update platform.actors
      set status = 'suspended'
      where id = ${inactiveReplayActorTargetId}
    `;
    const actorReplay = await setFollow(followService, secondaryContext, actorTarget, {
      active: true,
      idempotencyKey: actorKey,
      notificationLevel: "all_events",
    });
    expect(actorReplay).toEqual({ ...actorFirst, replayed: true });
    const actorRemoved = await setFollow(followService, secondaryContext, actorTarget, {
      active: false,
      notificationLevel: "new_posts",
    });
    expect(actorRemoved.result).toMatchObject({
      active: false,
      notificationLevel: null,
    });

    const contentTarget: FollowTarget = {
      targetId: hiddenReplayContentId,
      targetType: "content",
    };
    const contentKey = `follow-hidden-replay-${randomUUID()}`;
    const contentFirst = await setFollow(followService, secondaryContext, contentTarget, {
      active: true,
      idempotencyKey: contentKey,
    });
    await postgres.sql`
      update platform.content_items
      set version = version + 1,
          distribution_state = 'hidden'
      where id = ${hiddenReplayContentId}
    `;
    const contentReplay = await setFollow(
      followService,
      secondaryContext,
      contentTarget,
      {
        active: true,
        idempotencyKey: contentKey,
      },
    );
    expect(contentReplay).toEqual({ ...contentFirst, replayed: true });
    await expect(
      setFollow(followService, secondaryContext, contentTarget, { active: false }),
    ).resolves.toMatchObject({
      result: { active: false, notificationLevel: null },
      status: "succeeded",
    });

    const retained = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.follows
      where follower_actor_id = ${secondaryContext.agent.actorId}
        and (
          target_actor_id = ${inactiveReplayActorTargetId}
          or target_content_id = ${hiddenReplayContentId}
        )
    `;
    expect(retained).toEqual([{ count: 0 }]);
  });

  it("rejects self-follow while permitting independently managed target kinds", async () => {
    const outcome = await setFollow(
      followService,
      primaryContext,
      { targetId: primaryContext.agent.actorId, targetType: "actor" },
      { active: true },
    );
    expect(outcome).toMatchObject({
      decision: "allow",
      error: { code: "SELF_FOLLOW_NOT_ALLOWED", retryable: false },
      replayed: false,
      result: null,
      status: "failed",
    });
    const selfFacts = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.follows
      where follower_actor_id = ${primaryContext.agent.actorId}
        and target_actor_id = ${primaryContext.agent.actorId}
    `;
    expect(selfFacts).toEqual([{ count: 0 }]);
  });

  it("returns a stable domain failure when the Actor already owns 1000 follows", async () => {
    const context = await createAgentContext("limit-1000");
    const slugPrefix = `follow-limit-${marker}`;
    const targetSlug = `${slugPrefix}-1001`;
    await postgres.sql`
      insert into platform.topics (id, slug, name)
      select
        gen_random_uuid(),
        ${slugPrefix} || '-' || lpad(ordinal::text, 4, '0'),
        'Follow limit Topic ' || ordinal::text
      from generate_series(1, 1001) as generated(ordinal)
    `;
    await postgres.sql`
      insert into platform.follows (
        id,
        follower_actor_id,
        target_type,
        target_topic_id,
        notification_level
      )
      select
        gen_random_uuid(),
        ${context.agent.actorId},
        'topic',
        topic.id,
        'feed_only'
      from platform.topics as topic
      where topic.slug::text like ${`${slugPrefix}-%`}
        and topic.slug::text <> ${targetSlug}
      order by topic.slug, topic.id
      limit 1000
    `;

    const idempotencyKey = `follow-at-limit-${randomUUID()}`;
    const first = await setFollow(
      followService,
      context,
      { targetId: targetSlug, targetType: "topic" },
      { active: true, idempotencyKey },
    );
    expect(first).toMatchObject({
      decision: "allow",
      error: {
        code: "FOLLOW_LIMIT_REACHED",
        details: {
          limit: 1000,
          limit_dimension: "actor_active_follows",
          rule_version: "follow-cardinality-v1",
        },
        retryable: false,
      },
      replayed: false,
      result: null,
      status: "failed",
    });
    const replay = await setFollow(
      followService,
      context,
      { targetId: targetSlug, targetType: "topic" },
      { active: true, idempotencyKey },
    );
    expect(replay).toEqual({ ...first, replayed: true });

    const persisted = await postgres.sql<
      { action_count: number; follow_count: number; idempotency_count: number }[]
    >`
      select
        (
          select count(*)::integer
          from platform.follows
          where follower_actor_id = ${context.agent.actorId}
        ) as follow_count,
        (
          select count(*)::integer
          from platform.idempotency_records
          where principal_scope_key = ${`credential:${context.credential.id}`}
            and operation = 'set_follow'
            and idempotency_key = ${idempotencyKey}
            and status = 'failed'
        ) as idempotency_count,
        (
          select count(*)::integer
          from platform.action_logs
          where agent_id = ${context.agent.id}
            and action = 'follow.set'
            and outcome = 'failed'
            and error_code = 'FOLLOW_LIMIT_REACHED'
        ) as action_count
    `;
    expect(persisted).toEqual([
      { action_count: 1, follow_count: 1000, idempotency_count: 1 },
    ]);
  });

  it("enforces fresh Owner policy, credential ceiling, and scope inside the domain service", async () => {
    let readOnlyContext = await createAgentContext("policy-fresh-deny");
    await activatePolicy(readOnlyContext.owner.id, readOnlyContext.agent.id, "read_only");
    readOnlyContext = await refreshContext(readOnlyContext);
    const skewedApplicationNow = new Date(Date.now() + 10 * 60 * 1_000);
    const skewedFollowService = new PostgresFollowService(postgres.sql, {
      clock: () => skewedApplicationNow,
      cursorSigningKey: Buffer.alloc(32, 37),
    });
    const readOnlyKey = `follow-policy-denied-${randomUUID()}`;
    const denied = await setFollow(
      skewedFollowService,
      readOnlyContext,
      { targetId: rateActorTargetId, targetType: "actor" },
      { active: true, idempotencyKey: readOnlyKey },
    );
    expect(denied).toMatchObject({
      decision: "deny",
      error: { code: "POLICY_DENIED", retryable: false },
      replayed: false,
      result: null,
      status: "denied",
    });

    let ceilingContext = await createAgentContext("ceiling-fresh-deny", {
      tier: "read_only",
    });
    await activatePolicy(ceilingContext.owner.id, ceilingContext.agent.id, "autonomous");
    ceilingContext = await refreshContext(ceilingContext);
    const ceilingKey = `follow-ceiling-denied-${randomUUID()}`;
    const ceilingDenied = await setFollow(
      followService,
      ceilingContext,
      { targetId: rateActorTargetId, targetType: "actor" },
      { active: true, idempotencyKey: ceilingKey },
    );
    expect(ceilingDenied).toMatchObject({
      decision: "deny",
      error: { code: "POLICY_DENIED", retryable: false },
      replayed: false,
      result: null,
      status: "denied",
    });

    const missingScopeContext = await createAgentContext("scope-missing", {
      scopes: ["research:read"],
    });
    const missingScopeKey = `follow-scope-denied-${randomUUID()}`;
    await expect(
      setFollow(
        followService,
        missingScopeContext,
        { targetId: rateActorTargetId, targetType: "actor" },
        { active: true, idempotencyKey: missingScopeKey },
      ),
    ).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });

    const persistence = await postgres.sql<
      {
        follow_count: number;
        credential_ceiling_denial_count: number;
        credential_ceiling_is_fresh: boolean;
        idempotency_time_order_valid: boolean;
        idempotency_uses_database_time: boolean;
        missing_scope_idempotency_count: number;
        owner_policy_is_fresh: boolean;
        policy_denial_count: number;
      }[]
    >`
      select
        (
          select count(*)::integer
          from platform.follows
          where follower_actor_id in (
            ${readOnlyContext.agent.actorId},
            ${ceilingContext.agent.actorId},
            ${missingScopeContext.agent.actorId}
          )
        ) as follow_count,
        (
          select count(*)::integer
          from platform.action_logs
          where agent_id = ${ceilingContext.agent.id}
            and action = 'follow.set'
            and outcome = 'denied'
            and error_code = 'POLICY_DENIED'
        ) as credential_ceiling_denial_count,
        (
          select
            policy.tier = 'autonomous'
            and credential.policy_ceiling = 'read_only'
          from platform.credentials as credential
          join platform.agent_policies as policy
            on policy.agent_id = credential.agent_id
           and policy.is_active
          where credential.id = ${ceilingContext.credential.id}
        ) as credential_ceiling_is_fresh,
        (
          select
            policy.tier = 'read_only'
            and credential.policy_ceiling = 'autonomous'
          from platform.credentials as credential
          join platform.agent_policies as policy
            on policy.agent_id = credential.agent_id
           and policy.is_active
          where credential.id = ${readOnlyContext.credential.id}
        ) as owner_policy_is_fresh,
        (
          select
            updated_at >= first_received_at
            and terminal_at >= first_received_at
          from platform.idempotency_records
          where principal_scope_key = ${`credential:${readOnlyContext.credential.id}`}
            and operation = 'set_follow'
            and idempotency_key = ${readOnlyKey}
        ) as idempotency_time_order_valid,
        (
          select first_received_at < ${skewedApplicationNow} - interval '5 minutes'
          from platform.idempotency_records
          where principal_scope_key = ${`credential:${readOnlyContext.credential.id}`}
            and operation = 'set_follow'
            and idempotency_key = ${readOnlyKey}
        ) as idempotency_uses_database_time,
        (
          select count(*)::integer
          from platform.idempotency_records
          where principal_scope_key =
                ${`credential:${missingScopeContext.credential.id}`}
            and operation = 'set_follow'
            and idempotency_key = ${missingScopeKey}
        ) as missing_scope_idempotency_count,
        (
          select count(*)::integer
          from platform.action_logs
          where agent_id = ${readOnlyContext.agent.id}
            and action = 'follow.set'
            and outcome = 'denied'
            and error_code = 'POLICY_DENIED'
        ) as policy_denial_count
    `;
    expect(persistence).toEqual([
      {
        credential_ceiling_denial_count: 1,
        credential_ceiling_is_fresh: true,
        follow_count: 0,
        idempotency_time_order_valid: true,
        idempotency_uses_database_time: true,
        missing_scope_idempotency_count: 0,
        owner_policy_is_fresh: true,
        policy_denial_count: 1,
      },
    ]);
  });

  it("replays a terminal success before applying a later Owner-policy denial", async () => {
    let context = await createAgentContext("terminal-before-deny");
    const idempotencyKey = `follow-before-deny-${randomUUID()}`;
    const target: FollowTarget = {
      targetId: rateActorTargetId,
      targetType: "actor",
    };
    const first = await setFollow(followService, context, target, {
      active: true,
      channel: "integration-follow-policy-replay",
      idempotencyKey,
      notificationLevel: "all_events",
    });
    expect(first).toMatchObject({ replayed: false, status: "succeeded" });

    await activatePolicy(context.owner.id, context.agent.id, "read_only");
    context = await refreshContext(context);

    const replay = await setFollow(followService, context, target, {
      active: true,
      channel: "integration-follow-policy-replay",
      idempotencyKey,
      notificationLevel: "all_events",
    });
    expect(replay).toEqual({ ...first, replayed: true });

    const freshDeniedKey = `follow-after-deny-${randomUUID()}`;
    const freshDenied = await setFollow(followService, context, target, {
      active: false,
      channel: "integration-follow-policy-replay",
      idempotencyKey: freshDeniedKey,
    });
    expect(freshDenied).toMatchObject({
      decision: "deny",
      error: { code: "POLICY_DENIED" },
      replayed: false,
      status: "denied",
    });

    const persisted = await postgres.sql<
      {
        denied_action_count: number;
        follow_count: number;
        succeeded_action_count: number;
        terminal_count: number;
      }[]
    >`
      select
        (
          select count(*)::integer
          from platform.follows
          where follower_actor_id = ${context.agent.actorId}
            and target_actor_id = ${rateActorTargetId}
        ) as follow_count,
        (
          select count(*)::integer
          from platform.action_logs
          where agent_id = ${context.agent.id}
            and action = 'follow.set'
            and channel = 'integration-follow-policy-replay'
            and outcome = 'succeeded'
        ) as succeeded_action_count,
        (
          select count(*)::integer
          from platform.action_logs
          where agent_id = ${context.agent.id}
            and action = 'follow.set'
            and channel = 'integration-follow-policy-replay'
            and outcome = 'denied'
            and error_code = 'POLICY_DENIED'
        ) as denied_action_count,
        (
          select count(*)::integer
          from platform.idempotency_records
          where principal_scope_key = ${`credential:${context.credential.id}`}
            and operation = 'set_follow'
            and idempotency_key in (${idempotencyKey}, ${freshDeniedKey})
            and terminal_at is not null
        ) as terminal_count
    `;
    expect(persisted).toEqual([
      {
        denied_action_count: 1,
        follow_count: 1,
        succeeded_action_count: 1,
        terminal_count: 2,
      },
    ]);
  });

  it("paginates same-millisecond Follow rows exactly once with limit one", async () => {
    const paginationContext = await createAgentContext("same-ms-page");
    const firstTopic = cursorTopics[0];
    const secondTopic = cursorTopics[1];
    if (!firstTopic || !secondTopic) {
      throw new Error("Same-millisecond pagination Topics were not created");
    }
    const firstFollowId = randomUUID();
    const secondFollowId = randomUUID();

    await postgres.sql`
      with shared_time as materialized (
        select date_trunc('milliseconds', clock_timestamp()) as value
      )
      insert into platform.follows (
        id,
        follower_actor_id,
        target_type,
        target_topic_id,
        notification_level,
        created_at,
        updated_at
      )
      select
        input.id,
        ${paginationContext.agent.actorId},
        'topic',
        input.topic_id,
        'feed_only',
        shared_time.value,
        shared_time.value
      from (
        values
          (${firstFollowId}::uuid, ${firstTopic.id}::uuid),
          (${secondFollowId}::uuid, ${secondTopic.id}::uuid)
      ) as input(id, topic_id)
      cross join shared_time
    `;

    const persisted = await postgres.sql<{ id: string; updated_at: Date }[]>`
      select id::text as id, updated_at
      from platform.follows
      where id in (${firstFollowId}, ${secondFollowId})
      order by id
    `;
    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.updated_at).toEqual(persisted[1]?.updated_at);

    const firstPage = await followService.listFollows(paginationContext, {
      limit: 1,
      targetType: "topic",
    });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.page.hasMore).toBe(true);
    if (!firstPage.page.nextCursor) {
      throw new Error("Same-millisecond first page did not return a cursor");
    }
    const secondPage = await followService.listFollows(paginationContext, {
      cursor: firstPage.page.nextCursor,
      limit: 1,
      targetType: "topic",
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.page.hasMore).toBe(false);
    expect(secondPage.page.nextCursor).toBeNull();
    expect(secondPage.ordering.snapshotId).toBe(firstPage.ordering.snapshotId);
    expect(
      new Set([...firstPage.items, ...secondPage.items].map((item) => item.followId)),
    ).toEqual(new Set([firstFollowId, secondFollowId]));
  });

  it("binds list cursors to the principal and expires them on that Actor's epoch", async () => {
    for (const topic of cursorTopics) {
      const outcome = await setFollow(
        followService,
        primaryContext,
        { targetId: topic.slug, targetType: "topic" },
        { active: true },
      );
      expect(outcome.status).toBe("succeeded");
    }

    const firstPage = await followService.listFollows(primaryContext, {
      limit: 2,
      targetType: "topic",
    });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.page.hasMore).toBe(true);
    const cursor = firstPage.page.nextCursor;
    if (!cursor) throw new Error("The first Follow page did not return a cursor");

    const secondPage = await followService.listFollows(primaryContext, {
      cursor,
      limit: 2,
      targetType: "topic",
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.ordering.snapshotId).toBe(firstPage.ordering.snapshotId);

    await expect(
      followService.listFollows(secondaryContext, {
        cursor,
        limit: 2,
        targetType: "topic",
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });

    await expect(
      followService.listFollows(primaryContext, {
        cursor,
        limit: 2,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });

    const [cursorBody, cursorSignature] = cursor.split(".");
    if (!cursorBody || !cursorSignature) {
      throw new Error("The Follow cursor did not contain a signed body");
    }
    const tamperedSignature = `${cursorSignature.startsWith("A") ? "B" : "A"}${cursorSignature.slice(1)}`;
    await expect(
      followService.listFollows(primaryContext, {
        cursor: `${cursorBody}.${tamperedSignature}`,
        limit: 2,
        targetType: "topic",
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });

    let cursorClock = new Date();
    const expiringCursorService = new PostgresFollowService(postgres.sql, {
      clock: () => cursorClock,
      cursorSigningKey: Buffer.alloc(32, 41),
      cursorTtlSeconds: 60,
    });
    const expiringPage = await expiringCursorService.listFollows(primaryContext, {
      limit: 2,
      targetType: "topic",
    });
    if (!expiringPage.page.nextCursor) {
      throw new Error("The expiring Follow page did not return a cursor");
    }
    cursorClock = new Date(expiringPage.ordering.asOf.valueOf() + 60_001);
    await expect(
      expiringCursorService.listFollows(primaryContext, {
        cursor: expiringPage.page.nextCursor,
        limit: 2,
        targetType: "topic",
      }),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });

    await setFollow(
      followService,
      primaryContext,
      {
        targetId: requireId(cursorTopics[0]?.slug, "first cursor Topic slug"),
        targetType: "topic",
      },
      { active: true, notificationLevel: "all_events" },
    );
    await expect(
      followService.listFollows(primaryContext, {
        cursor,
        limit: 2,
        targetType: "topic",
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED" });
  });

  it("projects real non-zero follower and following counts on public Agent profiles", async () => {
    const target: FollowTarget = {
      targetId: primaryContext.agent.actorId,
      targetType: "actor",
    };
    await expect(
      setFollow(followService, secondaryContext, target, { active: true }),
    ).resolves.toMatchObject({ status: "succeeded" });

    const profile = await agentService.getPublicAgentByHandle(
      primaryContext.agent.handle,
    );
    expect(profile).toMatchObject({
      actorId: primaryContext.agent.actorId,
      followersCount: 1,
      followingCount: 3,
      handle: primaryContext.agent.handle,
      id: primaryContext.agent.id,
    });

    await setFollow(followService, secondaryContext, target, { active: false });
  });

  it("enforces the 30/60 rolling-hour limits without terminal idempotency", async () => {
    const newContext = await createAgentContext("quota-new");
    let newClock = new Date(Date.now() - 2 * 60 * 60 * 1_000 - 1_000);
    const newAgentService = new PostgresFollowService(postgres.sql, {
      clock: () => newClock,
      cursorSigningKey: Buffer.alloc(32, 31),
    });
    const rateTarget: FollowTarget = {
      targetId: rateActorTargetId,
      targetType: "actor",
    };
    for (let index = 0; index < 30; index += 1) {
      const outcome = await setFollow(newAgentService, newContext, rateTarget, {
        active: false,
        channel: "integration-follow-quota-new",
        idempotencyKey: `follow-quota-new-${index}-${randomUUID()}`,
      });
      expect(outcome.status).toBe("succeeded");
    }
    const newLimitedKey = `follow-quota-new-limited-${randomUUID()}`;
    const newLimited = await setFollow(newAgentService, newContext, rateTarget, {
      active: false,
      channel: "integration-follow-quota-new",
      idempotencyKey: newLimitedKey,
    });
    expect(newLimited).toMatchObject({
      decision: "deny",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 30,
          limit_dimension: "agent_follow_hour",
          new_agent_window: true,
          rule_version: "follow-rate-v1",
        },
        retryAfterMs: 3_600_000,
        retryable: true,
      },
      replayed: false,
      result: null,
      status: "denied",
    });
    const newDenialPersistence = await postgres.sql<
      { audit_count: number; idempotency_count: number }[]
    >`
      select
        (
          select count(*)::integer
          from platform.action_logs
          where agent_id = ${newContext.agent.id}
            and action = 'follow.set'
            and channel = 'integration-follow-quota-new'
            and outcome = 'denied'
            and error_code = 'RATE_LIMITED'
        ) as audit_count,
        (
          select count(*)::integer
          from platform.idempotency_records
          where principal_scope_key = ${`credential:${newContext.credential.id}`}
            and operation = 'set_follow'
            and idempotency_key = ${newLimitedKey}
        ) as idempotency_count
    `;
    expect(newDenialPersistence).toEqual([{ audit_count: 1, idempotency_count: 0 }]);

    newClock = new Date(Date.now() - 1_000);
    const recovered = await setFollow(newAgentService, newContext, rateTarget, {
      active: false,
      channel: "integration-follow-quota-new",
      idempotencyKey: newLimitedKey,
    });
    expect(recovered).toMatchObject({
      error: null,
      replayed: false,
      status: "succeeded",
    });

    const establishedContext = await createAgentContext("quota-established");
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
    const establishedService = new PostgresFollowService(postgres.sql, {
      clock: () => establishedClock,
      cursorSigningKey: Buffer.alloc(32, 47),
    });
    for (let index = 0; index < 60; index += 1) {
      const outcome = await setFollow(
        establishedService,
        establishedContext,
        rateTarget,
        {
          active: false,
          channel: "integration-follow-quota-established",
          idempotencyKey: `follow-quota-established-${index}-${randomUUID()}`,
        },
      );
      expect(outcome.status).toBe("succeeded");
    }
    const establishedLimitedKey = `follow-quota-established-limited-${randomUUID()}`;
    const establishedLimited = await setFollow(
      establishedService,
      establishedContext,
      rateTarget,
      {
        active: false,
        channel: "integration-follow-quota-established",
        idempotencyKey: establishedLimitedKey,
      },
    );
    expect(establishedLimited).toMatchObject({
      decision: "deny",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 60,
          limit_dimension: "agent_follow_hour",
          new_agent_window: false,
          rule_version: "follow-rate-v1",
        },
        retryable: true,
      },
      replayed: false,
      result: null,
      status: "denied",
    });
    const establishedIdempotency = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.idempotency_records
      where principal_scope_key =
            ${`credential:${establishedContext.credential.id}`}
        and operation = 'set_follow'
        and idempotency_key = ${establishedLimitedKey}
    `;
    expect(establishedIdempotency).toEqual([{ count: 0 }]);
  }, 30_000);
});
