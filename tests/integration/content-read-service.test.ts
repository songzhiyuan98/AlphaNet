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
import {
  ContentReadError,
  PostgresContentReadService,
} from "../../packages/domain/src/content-read.js";
import { PostgresResearchWriteService } from "../../packages/domain/src/research-write.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeContentRead = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const apiKeyPepper = "content-read-service-pepper-is-integration-test-data-only";
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

describeContentRead("PostgresContentReadService", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const agentService = new PostgresAgentConnectionService(
    postgres.sql,
    agentConnectionOptions,
  );
  const writeService = new PostgresResearchWriteService(postgres.sql, {
    pendingActionKeyRing: {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    },
  });
  const readService = new PostgresContentReadService(postgres.sql, {
    cursorSigningKey: Buffer.from(
      "content-read-integration-cursor-signing-key-material-v1",
      "utf8",
    ),
  });
  dependencies.push(postgres);

  let context: AgentCredentialContext;
  let followedAuthorContext: AgentCredentialContext;
  let noReadContext: AgentCredentialContext;
  let communityId = "";
  let activeAdditionalCommunityId = "";
  let archivedCommunityId = "";
  let deletedCommunityId = "";
  let readOnlyCommunityId = "";
  let suspendedCommunityId = "";
  let marker = "";
  let rootId = "";
  let firstReplyId = "";
  let secondReplyId = "";
  let referenceId = "";
  let suspendedOnlyRootId = "";
  let suspendedOnlyReplyId = "";
  let mixedCommunityRootId = "";
  let mixedDeletedCommunityRootId = "";
  let archivedRootId = "";
  let deletedRootId = "";
  let readOnlyRootId = "";
  let inboundTargetId = "";
  let symbol = "";
  let topic = "";
  let mentionHandle = "";
  let sourceUrl = "";
  let followCommunityId = "";
  let followSymbol = "";
  let followSymbolId = "";
  let followTopic = "";
  let followTopicId = "";
  let followedRootId = "";
  let followedFirstReplyId = "";
  let followedSecondReplyId = "";
  let followedThirdReplyId = "";

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
        'Content Read Integration Owner',
        ${`content-read-${testMarker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id
    `;
    const userId = users[0]?.id;
    if (!userId) throw new Error("The integration Auth User was not created");
    const owners = await postgres.sql<{ id: string }[]>`
      select id
      from platform.owners
      where auth_user_id = ${userId}
    `;
    return requireId(owners[0]?.id, "The verified Owner projection");
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

  async function createIsolatedCommunity(label: string): Promise<string> {
    const communityFixtureId = randomUUID();
    const topicId = randomUUID();
    const slug = `content-read-${label}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.topics (id, slug, name, description)
        values (
          ${topicId},
          ${slug},
          'Content read cursor test topic',
          'An isolated social discussion topic for cursor consistency tests.'
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
          ${communityFixtureId},
          ${slug},
          'Content read cursor test Community',
          'An isolated Community for social-feed cursor consistency tests.',
          'topic',
          ${transaction.json({
            allowed_content: ["investment-research", "discussion"],
            max_posts_per_hour: 100,
            replies_open: true,
            requires_sources: false,
          })},
          ${transaction.json({ integration_fixture: marker, label })}
        )
      `;
      await transaction`
        insert into platform.community_topics (community_id, topic_id, is_primary)
        values (${communityFixtureId}, ${topicId}, true)
      `;
    });
    return communityFixtureId;
  }

  beforeAll(async () => {
    marker = randomUUID().replaceAll("-", "").slice(0, 10);
    communityId = randomUUID();
    activeAdditionalCommunityId = randomUUID();
    archivedCommunityId = randomUUID();
    deletedCommunityId = randomUUID();
    readOnlyCommunityId = randomUUID();
    suspendedCommunityId = randomUUID();
    const topicId = randomUUID();
    const activeAdditionalTopicId = randomUUID();
    const archivedTopicId = randomUUID();
    const deletedTopicId = randomUUID();
    const readOnlyTopicId = randomUUID();
    const suspendedTopicId = randomUUID();
    const symbolId = randomUUID();
    const symbolCandidateId = randomUUID();
    followCommunityId = randomUUID();
    followTopicId = randomUUID();
    followSymbolId = randomUUID();
    const followSymbolCandidateId = randomUUID();
    topic = `content-read-${marker}`;
    const activeAdditionalTopic = `content-read-active-${marker}`;
    const archivedTopic = `content-read-archived-${marker}`;
    const deletedTopic = `content-read-deleted-${marker}`;
    const readOnlyTopic = `content-read-read-only-${marker}`;
    const suspendedTopic = `content-read-suspended-${marker}`;
    symbol = `R${marker.slice(0, 8).toUpperCase()}`;
    followTopic = `following-${marker}`;
    followSymbol = `F${marker.slice(0, 8).toUpperCase()}`;
    sourceUrl = `https://evidence.example.test/content-read/${marker}`;
    const postingRules = {
      allowed_content: ["investment-research", "discussion"],
      max_posts_per_hour: 6,
      replies_open: true,
      requires_sources: false,
    };

    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.topics (id, slug, name, description)
        values
          (
            ${topicId},
            ${topic},
            'Content read integration topic',
            'An isolated topic for content read projections.'
          ),
          (
            ${activeAdditionalTopicId},
            ${activeAdditionalTopic},
            'Content read active additional topic',
            'The active distribution target for mixed-visibility content.'
          ),
          (
            ${archivedTopicId},
            ${archivedTopic},
            'Content read archived topic',
            'A topic whose Community becomes archived after publication.'
          ),
          (
            ${deletedTopicId},
            ${deletedTopic},
            'Content read deleted topic',
            'A topic whose Community is soft-deleted after publication.'
          ),
          (
            ${readOnlyTopicId},
            ${readOnlyTopic},
            'Content read read-only topic',
            'A topic whose Community becomes read-only after publication.'
          ),
          (
            ${suspendedTopicId},
            ${suspendedTopic},
            'Content read suspended topic',
            'A topic whose Community becomes suspended after publication.'
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
            ${topic},
            'Content Read Integration Community',
            'An isolated Community for content read projections.',
            'topic',
            ${transaction.json(postingRules)},
            ${transaction.json({ integration_fixture: marker })}
          ),
          (
            ${activeAdditionalCommunityId},
            ${activeAdditionalTopic},
            'Content Read Active Additional Community',
            'The active distribution target for mixed-visibility content.',
            'topic',
            ${transaction.json(postingRules)},
            ${transaction.json({ integration_fixture: marker })}
          ),
          (
            ${archivedCommunityId},
            ${archivedTopic},
            'Content Read Archived Community',
            'A Community archived after its fixture content is published.',
            'topic',
            ${transaction.json(postingRules)},
            ${transaction.json({ integration_fixture: marker })}
          ),
          (
            ${deletedCommunityId},
            ${deletedTopic},
            'Content Read Deleted Community',
            'A Community soft-deleted after its fixture content is published.',
            'topic',
            ${transaction.json(postingRules)},
            ${transaction.json({ integration_fixture: marker })}
          ),
          (
            ${readOnlyCommunityId},
            ${readOnlyTopic},
            'Content Read Read-only Community',
            'A Community made read-only after its fixture content is published.',
            'topic',
            ${transaction.json(postingRules)},
            ${transaction.json({ integration_fixture: marker })}
          ),
          (
            ${suspendedCommunityId},
            ${suspendedTopic},
            'Content Read Suspended Community',
            'A Community suspended after its fixture content is published.',
            'topic',
            ${transaction.json(postingRules)},
            ${transaction.json({ integration_fixture: marker })}
          )
      `;
      await transaction`
        insert into platform.community_topics (community_id, topic_id, is_primary)
        values
          (${communityId}, ${topicId}, true),
          (${activeAdditionalCommunityId}, ${activeAdditionalTopicId}, true),
          (${archivedCommunityId}, ${archivedTopicId}, true),
          (${deletedCommunityId}, ${deletedTopicId}, true),
          (${readOnlyCommunityId}, ${readOnlyTopicId}, true),
          (${suspendedCommunityId}, ${suspendedTopicId}, true)
      `;
      await transaction`
        insert into platform.symbols (
          id,
          community_candidate_id,
          ticker,
          exchange,
          name
        )
        values (
          ${symbolId},
          ${symbolCandidateId},
          ${symbol},
          'TEST',
          'Content read integration symbol'
        )
      `;
    });

    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.topics (id, slug, name, description)
        values (
          ${followTopicId},
          ${followTopic},
          'Strict Following Feed integration topic',
          'An isolated topic for Follow matching and cursor invalidation.'
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
          ${followCommunityId},
          ${followTopic},
          'Strict Following Feed Integration Community',
          'An isolated Community for the Follow read projection.',
          'topic',
          ${transaction.json(postingRules)},
          ${transaction.json({ integration_fixture: marker, slice: "following" })}
        )
      `;
      await transaction`
        insert into platform.community_topics (community_id, topic_id, is_primary)
        values (${followCommunityId}, ${followTopicId}, true)
      `;
      await transaction`
        insert into platform.symbols (
          id,
          community_candidate_id,
          ticker,
          exchange,
          name
        )
        values (
          ${followSymbolId},
          ${followSymbolCandidateId},
          ${followSymbol},
          'TEST',
          'Strict Following Feed integration symbol'
        )
      `;
    });

    const ownerId = await createVerifiedOwner(marker);
    const writer = await agentService.createAgent(
      ownerId,
      {
        displayName: "Content Read Writer",
        handle: `content-reader-${marker}`,
      },
      randomUUID(),
    );
    await activatePolicy(ownerId, writer.agent.id, "autonomous");
    const mentioned = await agentService.createAgent(
      ownerId,
      {
        displayName: "Mentioned Research Agent",
        handle: `mentioned-${marker}`,
      },
      randomUUID(),
    );
    mentionHandle = mentioned.agent.handle;
    await activatePolicy(ownerId, mentioned.agent.id, "autonomous");
    const followedAuthorCredential = await agentService.createCredential(
      ownerId,
      mentioned.agent.id,
      {
        name: "Strict Following Feed fixture author",
        scopes: ["research:read", "content:write"],
      },
      randomUUID(),
    );
    followedAuthorContext = await agentService.authenticateStaticApiKey(
      followedAuthorCredential.apiKey,
    );

    const credential = await agentService.createCredential(
      ownerId,
      writer.agent.id,
      {
        name: "Content read and write integration",
        scopes: ["research:read", "content:write"],
      },
      randomUUID(),
    );
    context = await agentService.authenticateStaticApiKey(credential.apiKey);
    const noReadCredential = await agentService.createCredential(
      ownerId,
      writer.agent.id,
      { name: "Actions only integration", scopes: ["actions:read"] },
      randomUUID(),
    );
    noReadContext = await agentService.authenticateStaticApiKey(noReadCredential.apiKey);

    const followedRoot = await writeService.createPost(
      followedAuthorContext,
      {
        bodyMarkdown:
          "A Follow-specific market thesis used to verify explainable social discovery.",
        idempotencyKey: `content-read-followed-root-${randomUUID()}`,
        primaryCommunityId: followCommunityId,
        symbols: [followSymbol],
        title: "Strict Following Feed market thesis",
        topics: [followTopic],
      },
      { requestId: `req-${randomUUID()}` },
    );
    followedRootId = requireId(followedRoot.result?.contentId, "Followed Root Content");
    const followedFirstReply = await writeService.replyToContent(
      followedAuthorContext,
      {
        bodyMarkdown:
          "A directly followed reply that must survive default post filtering.",
        idempotencyKey: `content-read-followed-reply-1-${randomUUID()}`,
        parentContentId: followedRootId,
      },
      { requestId: `req-${randomUUID()}` },
    );
    followedFirstReplyId = requireId(
      followedFirstReply.result?.contentId,
      "Directly Followed Reply Content",
    );
    const followedSecondReply = await writeService.replyToContent(
      followedAuthorContext,
      {
        bodyMarkdown: "A direct child of the followed reply.",
        idempotencyKey: `content-read-followed-reply-2-${randomUUID()}`,
        parentContentId: followedFirstReplyId,
      },
      { requestId: `req-${randomUUID()}` },
    );
    followedSecondReplyId = requireId(
      followedSecondReply.result?.contentId,
      "Followed Reply Child Content",
    );
    const followedThirdReply = await writeService.replyToContent(
      followedAuthorContext,
      {
        bodyMarkdown:
          "A grandchild that must not match a Follow on its grandparent reply.",
        idempotencyKey: `content-read-followed-reply-3-${randomUUID()}`,
        parentContentId: followedSecondReplyId,
      },
      { requestId: `req-${randomUUID()}` },
    );
    followedThirdReplyId = requireId(
      followedThirdReply.result?.contentId,
      "Followed Reply Grandchild Content",
    );

    await postgres.sql`
      insert into platform.follows (
        follower_actor_id,
        target_type,
        target_actor_id,
        target_symbol_id,
        target_topic_id,
        target_content_id,
        notification_level
      )
      values
        (
          ${context.agent.actorId}, 'actor', ${followedAuthorContext.agent.actorId},
          null, null, null, 'new_posts'
        ),
        (
          ${context.agent.actorId}, 'symbol', null,
          ${followSymbolId}, null, null, 'feed_only'
        ),
        (
          ${context.agent.actorId}, 'topic', null,
          null, ${followTopicId}, null, 'all_events'
        ),
        (
          ${context.agent.actorId}, 'content', null,
          null, null, ${followedRootId}, 'feed_only'
        ),
        (
          ${context.agent.actorId}, 'content', null,
          null, null, ${followedFirstReplyId}, 'all_events'
        )
    `;

    const reference = await writeService.createPost(
      context,
      {
        bodyMarkdown: "Independent reference evidence for the read integration test.",
        idempotencyKey: `content-read-reference-${randomUUID()}`,
        primaryCommunityId: communityId,
        title: "Independent reference evidence node",
      },
      { requestId: `req-${randomUUID()}` },
    );
    referenceId = requireId(reference.result?.contentId, "Reference Content");

    const root = await writeService.createPost(
      context,
      {
        bodyMarkdown: `@${mentionHandle} should independently verify the linked evidence.`,
        idempotencyKey: `content-read-root-${randomUUID()}`,
        primaryCommunityId: communityId,
        references: [{ relationType: "reference", targetContentId: referenceId }],
        sourceLinks: [
          {
            description: "Author-provided primary evidence.",
            title: "Primary evidence",
            url: sourceUrl,
          },
        ],
        symbols: [symbol],
        title: "Isolated market research discussion",
        topics: [topic],
      },
      { requestId: `req-${randomUUID()}` },
    );
    rootId = requireId(root.result?.contentId, "Root Content");

    const firstReply = await writeService.replyToContent(
      context,
      {
        bodyMarkdown: "First-level counterargument with a distinct research path.",
        idempotencyKey: `content-read-reply-1-${randomUUID()}`,
        parentContentId: rootId,
      },
      { requestId: `req-${randomUUID()}` },
    );
    firstReplyId = requireId(firstReply.result?.contentId, "First Reply");
    const secondReply = await writeService.replyToContent(
      context,
      {
        bodyMarkdown: "Nested follow-up that preserves parent and depth semantics.",
        idempotencyKey: `content-read-reply-2-${randomUUID()}`,
        parentContentId: firstReplyId,
      },
      { requestId: `req-${randomUUID()}` },
    );
    secondReplyId = requireId(secondReply.result?.contentId, "Second Reply");

    const suspendedOnlyRoot = await writeService.createPost(
      context,
      {
        bodyMarkdown: "Research distributed only to a Community that will be suspended.",
        idempotencyKey: `content-read-suspended-only-${randomUUID()}`,
        primaryCommunityId: suspendedCommunityId,
        title: "Suspended-only research root",
      },
      { requestId: `req-${randomUUID()}` },
    );
    suspendedOnlyRootId = requireId(
      suspendedOnlyRoot.result?.contentId,
      "Suspended-only Root Content",
    );
    const suspendedOnlyReply = await writeService.replyToContent(
      context,
      {
        bodyMarkdown: "A reply that must inherit the suspended root visibility.",
        idempotencyKey: `content-read-suspended-reply-${randomUUID()}`,
        parentContentId: suspendedOnlyRootId,
      },
      { requestId: `req-${randomUUID()}` },
    );
    suspendedOnlyReplyId = requireId(
      suspendedOnlyReply.result?.contentId,
      "Suspended-only Reply Content",
    );

    const mixedCommunityRoot = await writeService.createPost(
      context,
      {
        additionalCommunityIds: [activeAdditionalCommunityId],
        bodyMarkdown:
          "Research with a suspended primary Community and an active additional Community.",
        idempotencyKey: `content-read-mixed-community-${randomUUID()}`,
        primaryCommunityId: suspendedCommunityId,
        title: "Mixed Community visibility research",
      },
      { requestId: `req-${randomUUID()}` },
    );
    mixedCommunityRootId = requireId(
      mixedCommunityRoot.result?.contentId,
      "Mixed-community Root Content",
    );

    const archivedRoot = await writeService.createPost(
      context,
      {
        bodyMarkdown: "Research retained for public reading after archival.",
        idempotencyKey: `content-read-archived-${randomUUID()}`,
        primaryCommunityId: archivedCommunityId,
        title: "Archived Community research",
      },
      { requestId: `req-${randomUUID()}` },
    );
    archivedRootId = requireId(archivedRoot.result?.contentId, "Archived Root Content");

    const deletedRoot = await writeService.createPost(
      context,
      {
        bodyMarkdown: "Research removed when its only Community is deleted.",
        idempotencyKey: `content-read-deleted-${randomUUID()}`,
        primaryCommunityId: deletedCommunityId,
        title: "Deleted Community research",
      },
      { requestId: `req-${randomUUID()}` },
    );
    deletedRootId = requireId(deletedRoot.result?.contentId, "Deleted Root Content");

    const mixedDeletedCommunityRoot = await writeService.createPost(
      context,
      {
        additionalCommunityIds: [activeAdditionalCommunityId],
        bodyMarkdown:
          "A social research post whose deleted primary Community must never leak through its public projection.",
        idempotencyKey: `content-read-deleted-primary-mixed-${randomUUID()}`,
        primaryCommunityId: deletedCommunityId,
        title: "Deleted primary with active social distribution",
      },
      { requestId: `req-${randomUUID()}` },
    );
    mixedDeletedCommunityRootId = requireId(
      mixedDeletedCommunityRoot.result?.contentId,
      "Mixed deleted-primary Root Content",
    );

    const readOnlyRoot = await writeService.createPost(
      context,
      {
        bodyMarkdown: "Research retained for public reading in a read-only Community.",
        idempotencyKey: `content-read-read-only-${randomUUID()}`,
        primaryCommunityId: readOnlyCommunityId,
        title: "Read-only Community research",
      },
      { requestId: `req-${randomUUID()}` },
    );
    readOnlyRootId = requireId(readOnlyRoot.result?.contentId, "Read-only Root Content");

    const inboundTarget = await writeService.createPost(
      context,
      {
        bodyMarkdown: "An active target used to verify viewer-relative inbound counts.",
        idempotencyKey: `content-read-inbound-target-${randomUUID()}`,
        primaryCommunityId: communityId,
        title: "Viewer-relative inbound reference target",
      },
      { requestId: `req-${randomUUID()}` },
    );
    inboundTargetId = requireId(
      inboundTarget.result?.contentId,
      "Inbound Reference Target Content",
    );

    await writeService.createPost(
      context,
      {
        bodyMarkdown:
          "A suspended-only source that references an otherwise public target.",
        idempotencyKey: `content-read-suspended-reference-${randomUUID()}`,
        primaryCommunityId: suspendedCommunityId,
        references: [{ relationType: "reference", targetContentId: inboundTargetId }],
        title: "Suspended-only inbound reference source",
      },
      { requestId: `req-${randomUUID()}` },
    );

    await writeService.createPost(
      context,
      {
        bodyMarkdown:
          "A source in a soon-to-be-deleted Community that must not affect inbound social proof.",
        idempotencyKey: `content-read-deleted-reference-${randomUUID()}`,
        primaryCommunityId: deletedCommunityId,
        references: [{ relationType: "reference", targetContentId: inboundTargetId }],
        title: "Deleted-Community inbound reference source",
      },
      { requestId: `req-${randomUUID()}` },
    );

    await postgres.sql.begin(async (transaction) => {
      await transaction`
        update platform.communities
        set version = version + 1,
            status = 'suspended'
        where id = ${suspendedCommunityId}
      `;
      await transaction`
        update platform.communities
        set version = version + 1,
            status = 'archived'
        where id = ${archivedCommunityId}
      `;
      await transaction`
        update platform.communities
        set version = version + 1,
            status = 'archived',
            deleted_at = clock_timestamp()
        where id = ${deletedCommunityId}
      `;
      await transaction`
        update platform.communities
        set version = version + 1,
            status = 'read_only'
        where id = ${readOnlyCommunityId}
      `;
    });
  }, 30_000);

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("is ready against the exact 000008, 000009, and 000011 read schemas", async () => {
    await expect(readService.checkReady()).resolves.toBeUndefined();
  });

  it("builds a strict, explainable Following Feed across all four target types", async () => {
    const empty = await readService.browseContent(followedAuthorContext, {
      scope: "following",
      sort: "latest",
    });
    expect(empty.items).toEqual([]);

    const defaults = await readService.browseContent(context, {
      limit: 100,
      scope: "following",
      sort: "latest",
    });
    expect(defaults.ranking.rankingVersion).toBe("following-latest-v1");
    expect(defaults.items.map((item) => item.contentId)).toEqual([
      followedFirstReplyId,
      followedRootId,
    ]);

    const explicitPosts = await readService.browseContent(context, {
      contentTypes: ["post"],
      limit: 100,
      scope: "following",
      sort: "latest",
    });
    expect(explicitPosts.items.map((item) => item.contentId)).toEqual([followedRootId]);

    const replies = await readService.browseContent(context, {
      contentTypes: ["reply"],
      limit: 100,
      scope: "following",
      sort: "active",
    });
    expect(replies.ranking.rankingVersion).toBe("following-active-v1");
    expect(new Set(replies.items.map((item) => item.contentId))).toEqual(
      new Set([followedFirstReplyId, followedSecondReplyId, followedThirdReplyId]),
    );

    const byId = new Map(
      [...defaults.items, ...replies.items].map((item) => [item.contentId, item]),
    );
    const root = byId.get(followedRootId)!;
    const firstReply = byId.get(followedFirstReplyId)!;
    const secondReply = byId.get(followedSecondReplyId)!;
    const thirdReply = byId.get(followedThirdReplyId)!;
    expect(root.matchedFollows.map((match) => match.targetType)).toEqual([
      "content",
      "actor",
      "symbol",
      "topic",
    ]);
    expect(firstReply.matchedFollows.map((match) => match.targetType)).toEqual([
      "content",
      "content",
      "actor",
      "symbol",
      "topic",
    ]);
    expect(secondReply.matchedFollows.map((match) => match.targetType)).toEqual([
      "content",
      "content",
      "actor",
      "symbol",
      "topic",
    ]);
    expect(thirdReply.matchedFollows.map((match) => match.targetType)).toEqual([
      "content",
      "actor",
      "symbol",
      "topic",
    ]);
    expect(
      firstReply.matchedFollows
        .filter((match) => match.targetType === "content")
        .map((match) => match.targetId),
    ).toEqual([followedFirstReplyId, followedRootId].sort());
    expect(
      thirdReply.matchedFollows.some(
        (match) =>
          match.targetType === "content" && match.targetId === followedFirstReplyId,
      ),
    ).toBe(false);
    expect(root.viewerState.following).toBe(true);
    expect(firstReply.viewerState.following).toBe(true);
    expect(secondReply.viewerState.following).toBe(false);

    await expect(
      readService.getContent(context, { contentId: followedRootId }),
    ).resolves.toMatchObject({ viewerState: { following: true } });
    await expect(
      readService.getContent(null, { contentId: followedRootId }),
    ).resolves.toMatchObject({ viewerState: { following: false } });
    const discussion = await readService.getDiscussion(context, {
      contentId: followedSecondReplyId,
      limit: 50,
      sort: "oldest",
    });
    expect(discussion.root.viewerState.following).toBe(true);
    expect(
      discussion.replies.find((reply) => reply.id === followedFirstReplyId)?.viewerState
        .following,
    ).toBe(true);
    expect(
      discussion.replies.find((reply) => reply.id === followedSecondReplyId)?.viewerState
        .following,
    ).toBe(false);
  });

  it("uses created_at as the deterministic third Active-order key", async () => {
    const olderId = randomUUID();
    const newerId = randomUUID();
    const olderRevisionId = randomUUID();
    const newerRevisionId = randomUUID();
    const times = await postgres.sql<
      {
        activity_at: Date;
        boundary_at: Date;
        newer_created_at: Date;
        older_created_at: Date;
      }[]
    >`
      select
        clock_timestamp() - interval '100 milliseconds' as activity_at,
        clock_timestamp() - interval '130 milliseconds' as boundary_at,
        clock_timestamp() - interval '110 milliseconds' as newer_created_at,
        clock_timestamp() - interval '120 milliseconds' as older_created_at
    `;
    const timing = times[0]!;
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.content_items (
          id,
          kind,
          author_actor_id,
          primary_community_id,
          root_id,
          parent_id,
          depth,
          published_at,
          created_at,
          updated_at
        )
        values
          (
            ${olderId},
            'post',
            ${followedAuthorContext.agent.actorId},
            ${followCommunityId},
            ${olderId},
            null,
            0,
            ${timing.older_created_at},
            ${timing.older_created_at},
            ${timing.activity_at}
          ),
          (
            ${newerId},
            'post',
            ${followedAuthorContext.agent.actorId},
            ${followCommunityId},
            ${newerId},
            null,
            0,
            ${timing.newer_created_at},
            ${timing.newer_created_at},
            ${timing.activity_at}
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
        values
          (
            ${olderRevisionId},
            ${olderId},
            1,
            'Following active-order older creation',
            'Older creation time with the same active timestamp.',
            'Older creation time with the same active timestamp.',
            ${followedAuthorContext.agent.actorId},
            ${timing.activity_at},
            1,
            decode(repeat('a', 64), 'hex'),
            512
          ),
          (
            ${newerRevisionId},
            ${newerId},
            1,
            'Following active-order newer creation',
            'Newer creation time with the same active timestamp.',
            'Newer creation time with the same active timestamp.',
            ${followedAuthorContext.agent.actorId},
            ${timing.activity_at},
            1,
            decode(repeat('b', 64), 'hex'),
            512
          )
      `;
      await transaction`
        update platform.content_items
        set current_revision_id = case
          when id = ${olderId}::uuid then ${olderRevisionId}::uuid
          else ${newerRevisionId}::uuid
        end
        where id in (${olderId}::uuid, ${newerId}::uuid)
      `;
    });

    const first = await readService.browseContent(context, {
      contentTypes: ["post"],
      createdAfter: timing.boundary_at,
      limit: 1,
      scope: "following",
      sort: "active",
    });
    expect(first.items.map((item) => item.contentId)).toEqual([newerId]);
    expect(first.page.nextCursor).toBeTruthy();
    const second = await readService.browseContent(context, {
      contentTypes: ["post"],
      createdAfter: timing.boundary_at,
      cursor: first.page.nextCursor,
      limit: 1,
      scope: "following",
      sort: "active",
    });
    expect(second.items.map((item) => item.contentId)).toEqual([olderId]);
    expect(second.ranking).toEqual(first.ranking);
  });

  it("isolates Following cursors by the current Actor follow epoch", async () => {
    const first = await readService.browseContent(context, {
      contentTypes: ["reply"],
      limit: 1,
      scope: "following",
      sort: "latest",
    });
    expect(first.page.nextCursor).toBeTruthy();

    await postgres.sql`
      insert into platform.follows (
        follower_actor_id,
        target_type,
        target_symbol_id,
        notification_level
      )
      values (
        ${followedAuthorContext.agent.actorId},
        'symbol',
        ${followSymbolId},
        'feed_only'
      )
    `;
    const continuation = await readService.browseContent(context, {
      contentTypes: ["reply"],
      cursor: first.page.nextCursor,
      limit: 1,
      scope: "following",
      sort: "latest",
    });
    expect(continuation.ranking).toEqual(first.ranking);

    const beforeOwnMutation = await readService.browseContent(context, {
      contentTypes: ["reply"],
      limit: 1,
      scope: "following",
      sort: "latest",
    });
    expect(beforeOwnMutation.page.nextCursor).toBeTruthy();
    await postgres.sql`
      update platform.follows
      set notification_level = 'new_posts'
      where follower_actor_id = ${context.agent.actorId}
        and target_type = 'topic'
        and target_topic_id = ${followTopicId}
    `;

    await expect(
      readService.browseContent(context, {
        contentTypes: ["reply"],
        cursor: beforeOwnMutation.page.nextCursor,
        limit: 1,
        scope: "following",
        sort: "latest",
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED", statusCode: 410 });
  });

  it("browses public content with scopes, filters, active order, and stable cursors", async () => {
    const symbolPage = await readService.browseContent(null, {
      scope: "symbol",
      sort: "latest",
      symbol,
    });
    expect(symbolPage.items).toHaveLength(1);
    expect(symbolPage.items[0]).toMatchObject({
      communityIds: [communityId],
      contentId: rootId,
      kind: "post",
      primaryCommunityId: communityId,
      symbols: [symbol],
      topics: [topic],
    });

    const topicPage = await readService.browseContent(context, {
      scope: "topic",
      sort: "active",
      topic,
    });
    expect(topicPage.items.map((item) => item.contentId)).toEqual([rootId]);

    const first = await readService.browseContent(context, {
      authorActorId: context.agent.actorId,
      limit: 1,
      scope: "author",
      sort: "latest",
    });
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).toBeTruthy();
    const afterSnapshot = await writeService.createPost(
      context,
      {
        bodyMarkdown: "This post is newer than the frozen browse snapshot.",
        idempotencyKey: `content-read-after-snapshot-${randomUUID()}`,
        primaryCommunityId: communityId,
        title: "Post created after the browse snapshot",
      },
      { requestId: `req-${randomUUID()}` },
    );
    const afterSnapshotId = requireId(
      afterSnapshot.result?.contentId,
      "Post-snapshot Content",
    );
    const second = await readService.browseContent(context, {
      authorActorId: context.agent.actorId,
      cursor: first.page.nextCursor,
      limit: 1,
      scope: "author",
      sort: "latest",
    });
    expect(second.ranking).toEqual(first.ranking);
    expect(second.items[0]?.contentId).not.toBe(first.items[0]?.contentId);
    expect(second.items.map((item) => item.contentId)).not.toContain(afterSnapshotId);
    expect(second.items[0]?.rank).toBe(2);
  });

  it("projects current revision provenance, sources, references, mentions, and descendants", async () => {
    const detail = await readService.getContent(null, { contentId: rootId });
    expect(detail).toMatchObject({
      content: {
        id: rootId,
        lifecycleState: "published",
        primaryCommunityId: communityId,
        symbols: [symbol],
        topics: [topic],
      },
      effectiveCommunityIds: [communityId],
      inboundReferenceCount: 0,
      reactionCounts: { agree: 0, disagree: 0, helpful: 0 },
      replyCount: 2,
      viewerState: { following: false, reactions: [] },
    });
    expect(detail.revision?.sourceLinks).toEqual([
      expect.objectContaining({ title: "Primary evidence", url: sourceUrl }),
    ]);
    expect(detail.revision?.references).toEqual([
      { relationType: "reference", targetContentId: referenceId },
    ]);
    expect(detail.revision?.mentions).toEqual([
      expect.objectContaining({ handle: mentionHandle, kind: "agent" }),
    ]);
    expect(detail.revision?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);

    await expect(
      readService.getContent(null, { contentId: referenceId }),
    ).resolves.toMatchObject({ inboundReferenceCount: 1 });
    await expect(
      readService.getContent(context, { contentId: firstReplyId }),
    ).resolves.toMatchObject({ replyCount: 1 });
  });

  it("returns a flat nested discussion and preserves deleted reply tombstones", async () => {
    const beforeDeletion = await readService.getDiscussion(context, {
      contentId: secondReplyId,
      limit: 50,
      sort: "oldest",
    });
    expect(beforeDeletion.root.id).toBe(rootId);
    expect(beforeDeletion.ancestorContext).toEqual([
      expect.objectContaining({ depth: 1, id: firstReplyId }),
    ]);
    expect(beforeDeletion.replies.map((reply) => reply.id)).toEqual([
      firstReplyId,
      secondReplyId,
    ]);
    expect(beforeDeletion.replies[1]).toMatchObject({
      depth: 2,
      parentContentId: firstReplyId,
      rootContentId: rootId,
    });

    await postgres.sql`
      update platform.content_items
      set version = version + 1,
          lifecycle_state = 'deleted',
          deleted_at = clock_timestamp()
      where id = ${firstReplyId}
    `;

    const afterDeletion = await readService.getDiscussion(null, {
      contentId: firstReplyId,
      limit: 50,
      sort: "oldest",
    });
    expect(afterDeletion.replies[0]).toMatchObject({
      currentRevisionId: null,
      id: firstReplyId,
      lifecycleState: "deleted",
      revision: null,
      symbols: [],
      topics: [],
    });
    expect(afterDeletion.replies[1]).toMatchObject({
      id: secondReplyId,
      lifecycleState: "published",
    });
    expect(JSON.stringify(afterDeletion.replies[0])).not.toContain(
      "First-level counterargument",
    );
  });

  it("applies viewer-relative visibility to suspended-only and mixed-Community roots", async () => {
    const anonymousGlobal = await readService.browseContent(null, {
      authorActorIds: [context.agent.actorId],
      limit: 100,
      scope: "global",
      sort: "latest",
    });
    const anonymousGlobalIds = anonymousGlobal.items.map((item) => item.contentId);
    expect(anonymousGlobalIds).not.toContain(suspendedOnlyRootId);
    expect(anonymousGlobalIds).toContain(mixedCommunityRootId);

    await expect(
      readService.browseContent(null, {
        communityId: suspendedCommunityId,
        limit: 100,
        scope: "community",
        sort: "latest",
      }),
    ).rejects.toMatchObject({ code: "COMMUNITY_NOT_FOUND", statusCode: 404 });

    const anonymousActiveAdditional = await readService.browseContent(null, {
      communityId: activeAdditionalCommunityId,
      limit: 100,
      scope: "community",
      sort: "latest",
    });
    expect(anonymousActiveAdditional.items.map((item) => item.contentId)).toContain(
      mixedCommunityRootId,
    );

    await expect(
      readService.getContent(null, { contentId: suspendedOnlyRootId }),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND", statusCode: 404 });
    await expect(
      readService.getDiscussion(null, {
        contentId: suspendedOnlyRootId,
        limit: 50,
        sort: "oldest",
      }),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND", statusCode: 404 });

    const agentSuspended = await readService.browseContent(context, {
      communityId: suspendedCommunityId,
      limit: 100,
      scope: "community",
      sort: "latest",
    });
    expect(agentSuspended.items.map((item) => item.contentId)).toEqual(
      expect.arrayContaining([suspendedOnlyRootId, mixedCommunityRootId]),
    );
    await expect(
      readService.getContent(context, { contentId: suspendedOnlyRootId }),
    ).resolves.toMatchObject({ content: { id: suspendedOnlyRootId } });
    await expect(
      readService.getDiscussion(context, {
        contentId: suspendedOnlyRootId,
        limit: 50,
        sort: "oldest",
      }),
    ).resolves.toMatchObject({
      replies: [expect.objectContaining({ id: suspendedOnlyReplyId })],
      root: { id: suspendedOnlyRootId },
    });

    await expect(
      readService.getContent(null, { contentId: mixedCommunityRootId }),
    ).resolves.toMatchObject({ content: { id: mixedCommunityRootId } });
    await expect(
      readService.getDiscussion(null, {
        contentId: mixedCommunityRootId,
        limit: 50,
        sort: "oldest",
      }),
    ).resolves.toMatchObject({ root: { id: mixedCommunityRootId } });
  });

  it("keeps archived and read-only Communities publicly readable", async () => {
    for (const [fixtureCommunityId, fixtureRootId] of [
      [archivedCommunityId, archivedRootId],
      [readOnlyCommunityId, readOnlyRootId],
    ] as const) {
      const communityPage = await readService.browseContent(null, {
        communityId: fixtureCommunityId,
        limit: 100,
        scope: "community",
        sort: "latest",
      });
      expect(communityPage.items.map((item) => item.contentId)).toContain(fixtureRootId);
      await expect(
        readService.getContent(null, { contentId: fixtureRootId }),
      ).resolves.toMatchObject({ content: { id: fixtureRootId } });
    }
  });

  it("removes soft-deleted Communities and their content from every read audience", async () => {
    for (const viewer of [null, context] as const) {
      await expect(
        readService.browseContent(viewer, {
          communityId: deletedCommunityId,
          limit: 100,
          scope: "community",
          sort: "latest",
        }),
      ).rejects.toMatchObject({ code: "COMMUNITY_NOT_FOUND", statusCode: 404 });
      await expect(
        readService.getContent(viewer, { contentId: deletedRootId }),
      ).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND", statusCode: 404 });
      await expect(
        readService.getDiscussion(viewer, {
          contentId: deletedRootId,
          limit: 50,
          sort: "oldest",
        }),
      ).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND", statusCode: 404 });

      const globalPage = await readService.browseContent(viewer, {
        authorActorIds: [context.agent.actorId],
        limit: 100,
        scope: "global",
        sort: "latest",
      });
      expect(globalPage.items.map((item) => item.contentId)).not.toContain(deletedRootId);
      expect(globalPage.items.map((item) => item.contentId)).toContain(
        mixedDeletedCommunityRootId,
      );

      const mixedDetail = await readService.getContent(viewer, {
        contentId: mixedDeletedCommunityRootId,
      });
      expect(mixedDetail).toMatchObject({
        content: {
          additionalCommunityIds: [],
          id: mixedDeletedCommunityRootId,
          primaryCommunityId: activeAdditionalCommunityId,
        },
        effectiveCommunityIds: [activeAdditionalCommunityId],
      });
      expect(JSON.stringify(mixedDetail)).not.toContain(deletedCommunityId);

      const mixedBrowseItem = globalPage.items.find(
        (item) => item.contentId === mixedDeletedCommunityRootId,
      );
      expect(mixedBrowseItem).toMatchObject({
        communityIds: [activeAdditionalCommunityId],
        primaryCommunityId: activeAdditionalCommunityId,
      });
      expect(JSON.stringify(mixedBrowseItem)).not.toContain(deletedCommunityId);
    }
  });

  it("computes inbound reference counts without deleted-Community social proof", async () => {
    await expect(
      readService.getContent(null, { contentId: inboundTargetId }),
    ).resolves.toMatchObject({ inboundReferenceCount: 0 });
    await expect(
      readService.getContent(context, { contentId: inboundTargetId }),
    ).resolves.toMatchObject({ inboundReferenceCount: 1 });
  });

  it("expires an active browse cursor when an old reply becomes hidden", async () => {
    const oldReply = await writeService.replyToContent(
      context,
      {
        bodyMarkdown: "A pre-snapshot reply whose visibility will change.",
        idempotencyKey: `content-read-active-old-reply-${randomUUID()}`,
        parentContentId: rootId,
      },
      { requestId: `req-${randomUUID()}` },
    );
    const oldReplyId = requireId(oldReply.result?.contentId, "Pre-snapshot Active Reply");
    const first = await readService.browseContent(context, {
      authorActorId: context.agent.actorId,
      contentTypes: ["post"],
      limit: 1,
      scope: "author",
      sort: "active",
    });
    expect(first.page.nextCursor).toBeTruthy();

    await postgres.sql`
      update platform.content_items
      set version = version + 1,
          distribution_state = 'hidden'
      where id = ${oldReplyId}
    `;

    await expect(
      readService.browseContent(context, {
        authorActorId: context.agent.actorId,
        contentTypes: ["post"],
        cursor: first.page.nextCursor,
        limit: 1,
        scope: "author",
        sort: "active",
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED", statusCode: 410 });
  });

  it("expires a public Community cursor before reporting its new visibility", async () => {
    const cursorCommunityId = await createIsolatedCommunity("suspend-cursor");
    for (const index of [1, 2]) {
      await writeService.createPost(
        context,
        {
          bodyMarkdown: `Community cursor fixture post ${index}.`,
          idempotencyKey: `content-read-community-cursor-${randomUUID()}`,
          primaryCommunityId: cursorCommunityId,
          title: `Community cursor fixture post ${index}`,
        },
        { requestId: `req-${randomUUID()}` },
      );
    }
    const first = await readService.browseContent(null, {
      communityId: cursorCommunityId,
      limit: 1,
      scope: "community",
      sort: "latest",
    });
    expect(first.page.nextCursor).toBeTruthy();

    await postgres.sql`
      update platform.communities
      set version = version + 1,
          status = 'suspended'
      where id = ${cursorCommunityId}
    `;

    await expect(
      readService.browseContent(null, {
        communityId: cursorCommunityId,
        cursor: first.page.nextCursor,
        limit: 1,
        scope: "community",
        sort: "latest",
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED", statusCode: 410 });
  });

  it("expires a discussion cursor before resolving a newly deleted root", async () => {
    const cursorCommunityId = await createIsolatedCommunity("delete-cursor");
    const root = await writeService.createPost(
      context,
      {
        bodyMarkdown: "A discussion root used to verify continuation invalidation.",
        idempotencyKey: `content-read-discussion-cursor-root-${randomUUID()}`,
        primaryCommunityId: cursorCommunityId,
        title: "Discussion cursor invalidation root",
      },
      { requestId: `req-${randomUUID()}` },
    );
    const cursorRootId = requireId(root.result?.contentId, "Cursor Root Content");
    for (const index of [1, 2]) {
      await writeService.replyToContent(
        context,
        {
          bodyMarkdown: `Discussion cursor fixture reply ${index}.`,
          idempotencyKey: `content-read-discussion-cursor-reply-${randomUUID()}`,
          parentContentId: cursorRootId,
        },
        { requestId: `req-${randomUUID()}` },
      );
    }
    const first = await readService.getDiscussion(context, {
      contentId: cursorRootId,
      limit: 1,
      sort: "oldest",
    });
    expect(first.page.nextCursor).toBeTruthy();

    await postgres.sql`
      update platform.communities
      set version = version + 1,
          status = 'archived',
          deleted_at = clock_timestamp()
      where id = ${cursorCommunityId}
    `;

    await expect(
      readService.getDiscussion(context, {
        contentId: cursorRootId,
        cursor: first.page.nextCursor,
        limit: 1,
        sort: "oldest",
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED", statusCode: 410 });
  });

  it("keeps a pre-existing active candidate set stable when a new reply is published", async () => {
    const first = await readService.browseContent(context, {
      authorActorId: context.agent.actorId,
      limit: 2,
      scope: "author",
      sort: "active",
    });
    expect(first.page.nextCursor).toBeTruthy();

    const newReply = await writeService.replyToContent(
      context,
      {
        bodyMarkdown: "A post-snapshot reply that must not enter the frozen candidates.",
        idempotencyKey: `content-read-active-new-reply-${randomUUID()}`,
        parentContentId: rootId,
      },
      { requestId: `req-${randomUUID()}` },
    );
    const newReplyId = requireId(
      newReply.result?.contentId,
      "Post-snapshot Active Reply",
    );

    const frozenCandidateIds = first.items.map((item) => item.contentId);
    let cursor = first.page.nextCursor;
    let continuationCount = 0;
    while (cursor !== null) {
      continuationCount += 1;
      if (continuationCount > 100) {
        throw new Error("Active browse cursor did not terminate");
      }
      const next = await readService.browseContent(context, {
        authorActorId: context.agent.actorId,
        cursor,
        limit: 2,
        scope: "author",
        sort: "active",
      });
      frozenCandidateIds.push(...next.items.map((item) => item.contentId));
      cursor = next.page.nextCursor;
    }
    expect(continuationCount).toBeGreaterThan(0);
    expect(frozenCandidateIds).not.toContain(newReplyId);
  });

  it("keeps active-feed score and activity time bound to the frozen rank", async () => {
    const cursorCommunityId = await createIsolatedCommunity("active-rank");
    const postIds: string[] = [];
    for (const index of [1, 2]) {
      const post = await writeService.createPost(
        context,
        {
          bodyMarkdown: `Active-rank fixture post ${index}.`,
          idempotencyKey: `content-read-active-rank-post-${randomUUID()}`,
          primaryCommunityId: cursorCommunityId,
          title: `Active-rank fixture post ${index}`,
        },
        { requestId: `req-${randomUUID()}` },
      );
      postIds.push(requireId(post.result?.contentId, `Active-rank Post ${index}`));
    }
    const first = await readService.browseContent(context, {
      communityId: cursorCommunityId,
      contentTypes: ["post"],
      limit: 1,
      scope: "community",
      sort: "active",
    });
    expect(first.page.nextCursor).toBeTruthy();
    const firstContentId = requireId(first.items[0]?.contentId, "First ranked Content");
    const secondContentId = requireId(
      postIds.find((contentId) => contentId !== firstContentId),
      "Second ranked Content",
    );

    await writeService.replyToContent(
      context,
      {
        bodyMarkdown:
          "This post-snapshot reply must not rewrite the activity time attached to a frozen rank.",
        idempotencyKey: `content-read-active-rank-reply-${randomUUID()}`,
        parentContentId: secondContentId,
      },
      { requestId: `req-${randomUUID()}` },
    );

    const second = await readService.browseContent(context, {
      communityId: cursorCommunityId,
      contentTypes: ["post"],
      cursor: first.page.nextCursor,
      limit: 1,
      scope: "community",
      sort: "active",
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.contentId).toBe(secondContentId);
    expect(second.items[0]?.rank).toBe(2);
    expect(second.items[0]?.lastActivityAt.valueOf()).toBeLessThanOrEqual(
      first.ranking.asOf.valueOf(),
    );
    expect(second.items[0]?.score).toBe(
      second.items[0]!.lastActivityAt.valueOf() / 1_000,
    );
  });

  it("expires a discussion cursor when an old node in the same root mutates", async () => {
    const first = await readService.getDiscussion(context, {
      contentId: rootId,
      limit: 1,
      sort: "oldest",
    });
    expect(first.page.nextCursor).toBeTruthy();

    await postgres.sql`
      update platform.content_items
      set version = version + 1,
          distribution_state = 'hidden'
      where id = ${secondReplyId}
    `;

    await expect(
      readService.getDiscussion(context, {
        contentId: rootId,
        cursor: first.page.nextCursor,
        limit: 1,
        sort: "oldest",
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED", statusCode: 410 });
  });

  it("fails closed for missing Agent read scope and hidden content", async () => {
    await expect(
      readService.browseContent(noReadContext, { scope: "global" }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ContentReadError && error.code === "SCOPE_REQUIRED",
    );

    await postgres.sql`
      update platform.content_items
      set version = version + 1,
          distribution_state = 'hidden'
      where id = ${referenceId}
    `;
    await expect(
      readService.getContent(null, { contentId: referenceId }),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND", statusCode: 404 });
  });
});
