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
} from "../../packages/domain/src/agent-connection.js";
import { PostgresContentReadService } from "../../packages/domain/src/content-read.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeRanking = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const agentConnectionOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: {
    1: "content-ranking-integration-pepper-is-test-data-only-v1",
  },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;
const postingRules = {
  allowed_content: ["investment-research", "discussion", "question"],
  max_posts_per_hour: 1_000,
  replies_open: true,
  requires_sources: false,
} as const;

interface ContentFixtureInput {
  authorActorId: string;
  communityId?: string | undefined;
  createdAt: Date;
  distributionState?: "limited" | "normal" | undefined;
  id?: string | undefined;
  parentId?: string | undefined;
  rootId?: string | undefined;
  title: string;
}

function requireId(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${label} was not created`);
  }
  return value;
}

function descendingUuid(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

describeRanking("Postgres Content Ranking v1", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const agentService = new PostgresAgentConnectionService(
    postgres.sql,
    agentConnectionOptions,
  );
  const readService = new PostgresContentReadService(postgres.sql, {
    cursorSigningKey: Buffer.from(
      "content-ranking-integration-cursor-signing-key-v1",
      "utf8",
    ),
  });
  dependencies.push(postgres);

  let marker = "";
  let viewerContext: AgentCredentialContext;
  let followedAuthorActorId = "";
  let discoveryAuthorActorId = "";
  const reactionActorIds: string[] = [];

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
        'Content Ranking Integration Owner',
        ${`content-ranking-${testMarker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id::text as id
    `;
    const userId = requireId(users[0]?.id, "Content Ranking Auth User");
    const owners = await postgres.sql<{ id: string }[]>`
      select id::text as id
      from platform.owners
      where auth_user_id = ${userId}::uuid
    `;
    return requireId(owners[0]?.id, "Content Ranking Owner projection");
  }

  async function createActor(ownerId: string, label: string): Promise<string> {
    const created = await agentService.createAgent(
      ownerId,
      {
        displayName: `Ranking ${label}`,
        handle: `ranking-${label}-${marker}`,
      },
      randomUUID(),
    );
    return created.agent.actorId;
  }

  async function createCommunity(label: string): Promise<string> {
    const communityId = randomUUID();
    const topicId = randomUUID();
    const slug = `ranking-${label}-${marker}`;
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.topics (id, slug, name, description)
        values (
          ${topicId},
          ${slug},
          ${`Ranking ${label}`},
          'An isolated integration fixture for Content Ranking v1.'
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
          ${communityId},
          ${slug},
          ${`Ranking ${label}`},
          'An isolated integration Community for ranking and snapshot tests.',
          'topic',
          ${transaction.json(postingRules)},
          ${transaction.json({ integration_fixture: marker, label })}
        )
      `;
      await transaction`
        insert into platform.community_topics (community_id, topic_id, is_primary)
        values (${communityId}, ${topicId}, true)
      `;
    });
    return communityId;
  }

  async function databaseNow(): Promise<Date> {
    const rows = await postgres.sql<{ now: Date }[]>`
      select clock_timestamp() as now
    `;
    const now = rows[0]?.now;
    if (!(now instanceof Date)) throw new Error("Database time was not returned");
    return now;
  }

  async function createContent(input: ContentFixtureInput): Promise<string> {
    const contentId = input.id ?? randomUUID();
    const revisionId = randomUUID();
    const isReply = input.rootId !== undefined || input.parentId !== undefined;
    const kind = isReply ? "reply" : "post";
    const rootId = isReply ? requireId(input.rootId, "Reply root") : contentId;
    const parentId = isReply ? requireId(input.parentId, "Reply parent") : null;
    const primaryCommunityId = isReply
      ? null
      : requireId(input.communityId, "Post Community");
    const body = `${input.title} (${marker}).`;
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
          distribution_state,
          published_at,
          created_at,
          updated_at
        )
        values (
          ${contentId},
          ${kind},
          ${input.authorActorId},
          ${primaryCommunityId},
          ${rootId},
          ${parentId},
          ${isReply ? 1 : 0},
          ${input.distributionState ?? "normal"},
          ${input.createdAt},
          ${input.createdAt},
          ${input.createdAt}
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
          ${isReply ? null : input.title},
          ${body},
          ${body},
          ${input.authorActorId},
          ${input.createdAt},
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

  async function addReactions(
    contentId: string,
    reactionType: "helpful" | "agree" | "disagree",
    actorIds: readonly string[],
    createdAt: Date,
  ): Promise<void> {
    if (actorIds.length === 0) return;
    await postgres.sql`
      insert into platform.reactions (
        actor_id,
        content_id,
        reaction_type,
        created_at
      )
      select
        fixture_actor.actor_id,
        ${contentId}::uuid,
        ${reactionType},
        ${createdAt}
      from unnest(${actorIds}::uuid[]) as fixture_actor(actor_id)
      on conflict do nothing
    `;
  }

  async function createReplies(
    rootId: string,
    count: number,
    createdAt: Date,
  ): Promise<string[]> {
    const replies: string[] = [];
    for (let index = 0; index < count; index += 1) {
      replies.push(
        await createContent({
          authorActorId: reactionActorIds[index]!,
          createdAt: new Date(createdAt.valueOf() + index),
          parentId: rootId,
          rootId,
          title: `Ranking reply ${index + 1}`,
        }),
      );
    }
    return replies;
  }

  async function createRepliesByAuthor(
    rootId: string,
    count: number,
    authorActorId: string,
    createdAt: Date,
  ): Promise<string[]> {
    const replies: string[] = [];
    for (let index = 0; index < count; index += 1) {
      replies.push(
        await createContent({
          authorActorId,
          createdAt: new Date(createdAt.valueOf() + index),
          parentId: rootId,
          rootId,
          title: `Ranking same-author reply ${index + 1}`,
        }),
      );
    }
    return replies;
  }

  beforeAll(async () => {
    marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const ownerId = await createVerifiedOwner(marker);
    const viewer = await agentService.createAgent(
      ownerId,
      {
        displayName: "Ranking Viewer",
        handle: `ranking-viewer-${marker}`,
      },
      randomUUID(),
    );
    followedAuthorActorId = await createActor(ownerId, "followed");
    discoveryAuthorActorId = await createActor(ownerId, "discovery");
    for (let ownerIndex = 0; ownerIndex < 4; ownerIndex += 1) {
      const reactorOwnerId = await createVerifiedOwner(
        `${marker}-reactors-${ownerIndex + 1}`,
      );
      for (let actorIndex = 0; actorIndex < 3; actorIndex += 1) {
        const reactorNumber = ownerIndex * 3 + actorIndex + 1;
        reactionActorIds.push(
          await createActor(reactorOwnerId, `reactor-${reactorNumber}`),
        );
      }
    }

    const credential = await agentService.createCredential(
      ownerId,
      viewer.agent.id,
      {
        name: "Content Ranking read integration",
        scopes: ["research:read"],
      },
      randomUUID(),
    );
    viewerContext = await agentService.authenticateStaticApiKey(credential.apiKey);
  }, 30_000);

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("ranks Hot by qualified engagement and freshness while enforcing the 24h window", async () => {
    const communityId = await createCommunity("hot");
    const now = await databaseNow();
    const sameAge = new Date(now.valueOf() - 2 * 60 * 60 * 1_000);
    const reactionTime = new Date(now.valueOf() - 30 * 60 * 1_000);
    const baselineId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId,
      createdAt: sameAge,
      title: "Hot baseline",
    });
    const agreeOnlyId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId,
      createdAt: sameAge,
      title: "Hot Agree-only control",
    });
    const helpfulId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId,
      createdAt: sameAge,
      title: "Hot Helpful signal",
    });
    const replyId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId,
      createdAt: sameAge,
      title: "Hot reply signal",
    });
    const newerHelpfulId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId,
      createdAt: new Date(now.valueOf() - 60 * 60 * 1_000),
      title: "Hot newer Helpful signal",
    });
    const olderHelpfulId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId,
      createdAt: new Date(now.valueOf() - 6 * 60 * 60 * 1_000),
      title: "Hot older Helpful signal",
    });
    const outsideWindowId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId,
      createdAt: new Date(now.valueOf() - 26 * 60 * 60 * 1_000),
      title: "Hot outside-window signal",
    });
    const replyCapThreeId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId,
      createdAt: sameAge,
      title: "Hot reply cap three",
    });
    const replyCapFourId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId,
      createdAt: sameAge,
      title: "Hot reply cap four",
    });

    await addReactions(agreeOnlyId, "agree", reactionActorIds.slice(0, 8), reactionTime);
    await addReactions(helpfulId, "helpful", reactionActorIds.slice(0, 2), reactionTime);
    await createReplies(replyId, 2, reactionTime);
    await addReactions(
      newerHelpfulId,
      "helpful",
      reactionActorIds.slice(0, 1),
      reactionTime,
    );
    await addReactions(
      olderHelpfulId,
      "helpful",
      reactionActorIds.slice(0, 1),
      reactionTime,
    );
    await addReactions(
      outsideWindowId,
      "helpful",
      reactionActorIds.slice(0, 10),
      new Date(now.valueOf() - 25 * 60 * 60 * 1_000),
    );
    await createRepliesByAuthor(replyCapThreeId, 3, reactionActorIds[0]!, reactionTime);
    await createRepliesByAuthor(replyCapFourId, 4, reactionActorIds[0]!, reactionTime);

    const page = await readService.browseContent(null, {
      communityId,
      contentTypes: ["post"],
      limit: 100,
      scope: "community",
      sort: "hot",
      window: "24h",
    });
    const byId = new Map(page.items.map((item) => [item.contentId, item]));

    expect(page.ranking.rankingVersion).toContain("hot");
    expect(byId.has(outsideWindowId)).toBe(false);
    const baseline = byId.get(baselineId)!;
    const baselineAgeSeconds =
      (page.ranking.asOf.valueOf() - baseline.createdAt.valueOf()) / 1_000;
    expect(baseline.score).toBeCloseTo(2 ** -(baselineAgeSeconds / (12 * 60 * 60)), 5);
    expect(byId.get(helpfulId)!.score).toBeGreaterThan(byId.get(baselineId)!.score);
    expect(byId.get(replyId)!.score).toBeGreaterThan(byId.get(baselineId)!.score);
    expect(byId.get(agreeOnlyId)!.score).toBe(byId.get(baselineId)!.score);
    expect(
      page.items
        .filter((item) => item.contentId === agreeOnlyId || item.contentId === baselineId)
        .map((item) => item.contentId),
    ).toEqual([agreeOnlyId, baselineId].toSorted(descendingUuid));
    expect(byId.get(replyCapThreeId)!.score).toBe(byId.get(replyCapFourId)!.score);
    expect(byId.get(replyCapThreeId)!.replyCount).toBe(3);
    expect(byId.get(replyCapFourId)!.replyCount).toBe(4);
    expect(byId.get(newerHelpfulId)!.score).toBeGreaterThan(
      byId.get(olderHelpfulId)!.score,
    );
    expect(page.items.every((item) => Number.isFinite(item.score))).toBe(true);
    for (let index = 1; index < page.items.length; index += 1) {
      expect(page.items[index - 1]!.score).toBeGreaterThanOrEqual(
        page.items[index]!.score,
      );
    }

    for (const [window, halfLifeHours] of [
      ["7d", 72],
      ["30d", 168],
    ] as const) {
      const longerWindowPage = await readService.browseContent(null, {
        communityId,
        contentTypes: ["post"],
        limit: 100,
        scope: "community",
        sort: "hot",
        window,
      });
      const longerWindowBaseline = longerWindowPage.items.find(
        (item) => item.contentId === baselineId,
      )!;
      const longerWindowAgeSeconds =
        (longerWindowPage.ranking.asOf.valueOf() -
          longerWindowBaseline.createdAt.valueOf()) /
        1_000;
      expect(longerWindowBaseline.score).toBeCloseTo(
        2 ** -(longerWindowAgeSeconds / (halfLifeHours * 60 * 60)),
        5,
      );
    }
  });

  it("supports Helpful, Replies, and Controversy Top metrics with deterministic ties", async () => {
    const now = await databaseNow();
    const createdAt = new Date(now.valueOf() - 2 * 60 * 60 * 1_000);
    const eventAt = new Date(now.valueOf() - 60 * 60 * 1_000);

    const helpfulCommunityId = await createCommunity("top-helpful");
    const helpfulHighId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId: helpfulCommunityId,
      createdAt,
      title: "Helpful high",
    });
    const helpfulTieIds = await Promise.all(
      ["Helpful tie A", "Helpful tie B"].map((title) =>
        createContent({
          authorActorId: followedAuthorActorId,
          communityId: helpfulCommunityId,
          createdAt,
          title,
        }),
      ),
    );
    const helpfulLowId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId: helpfulCommunityId,
      createdAt,
      title: "Helpful low",
    });
    await addReactions(helpfulHighId, "helpful", reactionActorIds.slice(0, 3), eventAt);
    for (const contentId of helpfulTieIds) {
      await addReactions(contentId, "helpful", reactionActorIds.slice(0, 2), eventAt);
    }
    await addReactions(helpfulLowId, "helpful", reactionActorIds.slice(0, 1), eventAt);
    const helpful = await readService.browseContent(null, {
      communityId: helpfulCommunityId,
      contentTypes: ["post"],
      limit: 100,
      scope: "community",
      sort: "top",
      topMetric: "helpful",
      window: "7d",
    });
    expect(helpful.items.map((item) => item.contentId)).toEqual([
      helpfulHighId,
      ...helpfulTieIds.toSorted(descendingUuid),
      helpfulLowId,
    ]);
    expect(helpful.items.map((item) => item.reactionCounts.helpful)).toEqual([
      3, 2, 2, 1,
    ]);
    expect(helpful.items[1]!.score).toBe(helpful.items[2]!.score);

    const repliesCommunityId = await createCommunity("top-replies");
    const replyHighId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId: repliesCommunityId,
      createdAt,
      title: "Replies high",
    });
    const replyTieIds = await Promise.all(
      ["Replies tie A", "Replies tie B"].map((title) =>
        createContent({
          authorActorId: followedAuthorActorId,
          communityId: repliesCommunityId,
          createdAt,
          title,
        }),
      ),
    );
    const replyLowId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId: repliesCommunityId,
      createdAt,
      title: "Replies low",
    });
    await createReplies(replyHighId, 3, eventAt);
    for (const contentId of replyTieIds) await createReplies(contentId, 2, eventAt);
    await createReplies(replyLowId, 1, eventAt);
    const replies = await readService.browseContent(null, {
      communityId: repliesCommunityId,
      contentTypes: ["post"],
      limit: 100,
      scope: "community",
      sort: "top",
      topMetric: "replies",
      window: "7d",
    });
    expect(replies.items.map((item) => item.contentId)).toEqual([
      replyHighId,
      ...replyTieIds.toSorted(descendingUuid),
      replyLowId,
    ]);
    expect(replies.items.map((item) => item.replyCount)).toEqual([3, 2, 2, 1]);
    expect(replies.items[1]!.score).toBe(replies.items[2]!.score);

    const controversyCommunityId = await createCommunity("top-controversy");
    const controversyIds = {
      balanced: await createContent({
        authorActorId: followedAuthorActorId,
        communityId: controversyCommunityId,
        createdAt,
        title: "Controversy balanced",
      }),
      unbalanced: await createContent({
        authorActorId: followedAuthorActorId,
        communityId: controversyCommunityId,
        createdAt,
        title: "Controversy unbalanced",
      }),
      oneSided: await Promise.all(
        ["Controversy one-sided A", "Controversy one-sided B"].map((title) =>
          createContent({
            authorActorId: followedAuthorActorId,
            communityId: controversyCommunityId,
            createdAt,
            title,
          }),
        ),
      ),
      zero: await createContent({
        authorActorId: followedAuthorActorId,
        communityId: controversyCommunityId,
        createdAt,
        title: "Controversy zero",
      }),
    };
    await addReactions(
      controversyIds.balanced,
      "agree",
      reactionActorIds.slice(0, 3),
      eventAt,
    );
    await addReactions(
      controversyIds.balanced,
      "disagree",
      reactionActorIds.slice(3, 6),
      eventAt,
    );
    await addReactions(
      controversyIds.unbalanced,
      "agree",
      reactionActorIds.slice(0, 5),
      eventAt,
    );
    await addReactions(
      controversyIds.unbalanced,
      "disagree",
      reactionActorIds.slice(5, 6),
      eventAt,
    );
    for (const contentId of controversyIds.oneSided) {
      await addReactions(contentId, "agree", reactionActorIds.slice(0, 6), eventAt);
    }
    const controversy = await readService.browseContent(null, {
      communityId: controversyCommunityId,
      contentTypes: ["post"],
      limit: 100,
      scope: "community",
      sort: "top",
      topMetric: "controversy",
      window: "7d",
    });
    expect(controversy.items.map((item) => item.contentId)).toEqual([
      controversyIds.balanced,
      controversyIds.unbalanced,
      ...controversyIds.oneSided.toSorted(descendingUuid),
      controversyIds.zero,
    ]);
    expect(controversy.items.map((item) => item.score)).toEqual([
      Math.round(Math.log(7) * 1_000_000) / 1_000_000,
      Math.round(((2 * 1) / 6) * Math.log(7) * 1_000_000) / 1_000_000,
      0,
      0,
      0,
    ]);
  });

  it("supports Agree, Disagree, Engagement, and the unbounded Top window", async () => {
    const communityId = await createCommunity("top-remaining-metrics");
    const now = await databaseNow();
    const createdAt = new Date(now.valueOf() - 2 * 60 * 60 * 1_000);
    const eventAt = new Date(now.valueOf() - 60 * 60 * 1_000);
    const highId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId,
      createdAt,
      title: "Top remaining metrics high",
    });
    const mediumId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId,
      createdAt,
      title: "Top remaining metrics medium",
    });
    const lowId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId,
      createdAt,
      title: "Top remaining metrics low",
    });
    await addReactions(highId, "helpful", reactionActorIds.slice(0, 2), eventAt);
    await addReactions(highId, "agree", reactionActorIds.slice(2, 5), eventAt);
    await addReactions(highId, "disagree", reactionActorIds.slice(5, 7), eventAt);
    await createRepliesByAuthor(highId, 4, reactionActorIds[0]!, eventAt);
    await createRepliesByAuthor(highId, 1, reactionActorIds[7]!, eventAt);
    await addReactions(mediumId, "agree", reactionActorIds.slice(0, 2), eventAt);
    await addReactions(mediumId, "disagree", reactionActorIds.slice(2, 3), eventAt);
    await addReactions(lowId, "agree", reactionActorIds.slice(0, 1), eventAt);

    const ranked = async (topMetric: "agree" | "disagree" | "engagement") =>
      readService.browseContent(null, {
        communityId,
        contentTypes: ["post"],
        limit: 100,
        scope: "community",
        sort: "top",
        topMetric,
        window: "7d",
      });

    const [agree, disagree, engagement] = await Promise.all([
      ranked("agree"),
      ranked("disagree"),
      ranked("engagement"),
    ]);
    expect(agree.items.map((item) => item.contentId)).toEqual([highId, mediumId, lowId]);
    expect(agree.items.map((item) => item.score)).toEqual([3, 2, 1]);
    expect(disagree.items.map((item) => item.contentId)).toEqual([
      highId,
      mediumId,
      lowId,
    ]);
    expect(disagree.items.map((item) => item.score)).toEqual([2, 1, 0]);
    expect(engagement.items[0]?.contentId).toBe(highId);
    expect(engagement.items.map((item) => item.score)).toEqual([27, 6, 2]);

    const allWindowCommunityId = await createCommunity("top-all-window");
    const oldCreatedAt = new Date(now.valueOf() - 45 * 24 * 60 * 60 * 1_000);
    const oldEventAt = new Date(now.valueOf() - 40 * 24 * 60 * 60 * 1_000);
    const oldHighId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId: allWindowCommunityId,
      createdAt: oldCreatedAt,
      title: "Top all-window historical leader",
    });
    const recentLowId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId: allWindowCommunityId,
      createdAt,
      title: "Top all-window recent control",
    });
    await addReactions(oldHighId, "helpful", reactionActorIds.slice(0, 5), oldEventAt);
    await addReactions(recentLowId, "helpful", reactionActorIds.slice(0, 1), eventAt);

    const allWindow = await readService.browseContent(null, {
      communityId: allWindowCommunityId,
      contentTypes: ["post"],
      limit: 100,
      scope: "community",
      sort: "top",
      topMetric: "helpful",
      window: "all",
    });
    const thirtyDays = await readService.browseContent(null, {
      communityId: allWindowCommunityId,
      contentTypes: ["post"],
      limit: 100,
      scope: "community",
      sort: "top",
      topMetric: "helpful",
      window: "30d",
    });
    expect(allWindow.items.map((item) => item.contentId)).toEqual([
      oldHighId,
      recentLowId,
    ]);
    expect(allWindow.items.map((item) => item.score)).toEqual([5, 1]);
    expect(thirtyDays.items.map((item) => item.contentId)).toEqual([recentLowId]);
  });

  it("mixes Agent Home at three Following items to one discovery and expires on Follow mutation", async () => {
    const communityId = await createCommunity("home");
    const now = await databaseNow();
    const createdAfter = new Date(now.valueOf() - 60 * 60 * 1_000);
    const homeFollowingIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      homeFollowingIds.push(
        await createContent({
          authorActorId: followedAuthorActorId,
          communityId,
          createdAt: new Date(now.valueOf() - (20 + index) * 60 * 1_000),
          title: `Home Following ${index + 1}`,
        }),
      );
    }
    const homeDiscoveryIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      homeDiscoveryIds.push(
        await createContent({
          authorActorId: discoveryAuthorActorId,
          communityId,
          createdAt: new Date(now.valueOf() - (10 + index) * 60 * 1_000),
          title: `Home discovery ${index + 1}`,
        }),
      );
    }
    const limitedHomeIds = await Promise.all([
      createContent({
        authorActorId: followedAuthorActorId,
        communityId,
        createdAt: new Date(now.valueOf() - 5 * 60 * 1_000),
        distributionState: "limited",
        title: "Home limited Following",
      }),
      createContent({
        authorActorId: discoveryAuthorActorId,
        communityId,
        createdAt: new Date(now.valueOf() - 4 * 60 * 1_000),
        distributionState: "limited",
        title: "Home limited discovery",
      }),
    ]);
    await postgres.sql`
      insert into platform.follows (
        follower_actor_id,
        target_type,
        target_actor_id,
        notification_level
      )
      values (
        ${viewerContext.agent.actorId},
        'actor',
        ${followedAuthorActorId},
        'new_posts'
      )
    `;

    const input = {
      authorActorIds: [followedAuthorActorId, discoveryAuthorActorId],
      createdAfter,
      scope: "home" as const,
      sort: "latest" as const,
    };
    const mixed = await readService.browseContent(viewerContext, {
      ...input,
      limit: 4,
    });
    const followingItems = mixed.items.filter(
      (item) => item.author.actorId === followedAuthorActorId,
    );
    const discoveryItems = mixed.items.filter(
      (item) => item.author.actorId === discoveryAuthorActorId,
    );
    expect(followingItems).toHaveLength(3);
    expect(discoveryItems).toHaveLength(1);
    expect(mixed.items.map((item) => item.contentId)).not.toEqual(
      expect.arrayContaining(limitedHomeIds),
    );
    expect(
      followingItems.every((item) =>
        item.selectionReasons.some((reason) => reason.includes("following")),
      ),
    ).toBe(true);
    expect(
      discoveryItems.every((item) =>
        item.selectionReasons.some((reason) => reason.includes("discovery")),
      ),
    ).toBe(true);

    const homeHotInput = {
      authorActorIds: [followedAuthorActorId, discoveryAuthorActorId],
      createdAfter,
      scope: "home" as const,
      sort: "hot" as const,
      window: "7d" as const,
    };
    const expectedHomeHot = await readService.browseContent(viewerContext, {
      ...homeHotInput,
      limit: 100,
    });
    const firstHomeHot = await readService.browseContent(viewerContext, {
      ...homeHotInput,
      limit: 2,
    });
    expect(firstHomeHot.page.nextCursor).toBeTruthy();
    await addReactions(
      homeDiscoveryIds.at(-1)!,
      "helpful",
      reactionActorIds.slice(0, 10),
      await databaseNow(),
    );
    const collectedHomeHot = [...firstHomeHot.items];
    let homeHotCursor = firstHomeHot.page.nextCursor;
    while (homeHotCursor !== null) {
      const next = await readService.browseContent(viewerContext, {
        ...homeHotInput,
        cursor: homeHotCursor,
        limit: 2,
      });
      expect(next.ranking).toEqual(firstHomeHot.ranking);
      collectedHomeHot.push(...next.items);
      homeHotCursor = next.page.nextCursor;
    }
    expect(collectedHomeHot.map((item) => item.contentId)).toEqual(
      expectedHomeHot.items.map((item) => item.contentId),
    );
    expect(collectedHomeHot.map((item) => item.contentId)).toEqual(
      expect.arrayContaining([...homeFollowingIds, ...homeDiscoveryIds]),
    );
    expect(collectedHomeHot.map((item) => item.contentId)).not.toEqual(
      expect.arrayContaining(limitedHomeIds),
    );

    const beforeMutation = await readService.browseContent(viewerContext, {
      ...input,
      limit: 1,
    });
    expect(beforeMutation.page.nextCursor).toBeTruthy();
    await postgres.sql`
      update platform.follows
      set notification_level = 'all_events'
      where follower_actor_id = ${viewerContext.agent.actorId}::uuid
        and target_type = 'actor'
        and target_actor_id = ${followedAuthorActorId}::uuid
    `;
    await expect(
      readService.browseContent(viewerContext, {
        ...input,
        cursor: beforeMutation.page.nextCursor,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED", statusCode: 410 });
  });

  it("freezes Hot candidates so reaction changes between pages cannot duplicate or skip", async () => {
    const communityId = await createCommunity("hot-snapshot");
    const now = await databaseNow();
    const createdAt = new Date(now.valueOf() - 2 * 60 * 60 * 1_000);
    const eventAt = new Date(now.valueOf() - 60 * 60 * 1_000);
    const contentIds: string[] = [];
    for (let count = 4; count >= 1; count -= 1) {
      const contentId = await createContent({
        authorActorId: followedAuthorActorId,
        communityId,
        createdAt,
        title: `Frozen Hot ${count}`,
      });
      contentIds.push(contentId);
      await addReactions(contentId, "helpful", reactionActorIds.slice(0, count), eventAt);
    }
    const browseInput = {
      communityId,
      contentTypes: ["post"] as const,
      scope: "community" as const,
      sort: "hot" as const,
      window: "7d" as const,
    };
    const expected = await readService.browseContent(null, {
      ...browseInput,
      limit: 100,
    });
    const first = await readService.browseContent(null, {
      ...browseInput,
      limit: 2,
    });
    expect(first.page.nextCursor).toBeTruthy();

    const promotedId = contentIds.at(-1)!;
    await addReactions(
      promotedId,
      "helpful",
      reactionActorIds.slice(1, 11),
      await databaseNow(),
    );

    const collected = [...first.items];
    let cursor = first.page.nextCursor;
    while (cursor !== null) {
      const next = await readService.browseContent(null, {
        ...browseInput,
        cursor,
        limit: 2,
      });
      expect(next.ranking).toEqual(first.ranking);
      collected.push(...next.items);
      cursor = next.page.nextCursor;
    }
    expect(collected.map((item) => item.contentId)).toEqual(
      expected.items.map((item) => item.contentId),
    );
    expect(new Set(collected.map((item) => item.contentId)).size).toBe(collected.length);
    const promotedAgeSeconds =
      (first.ranking.asOf.valueOf() - createdAt.valueOf()) / 1_000;
    const promotedExpectedScore =
      Math.round(5 * 2 ** -(promotedAgeSeconds / (72 * 60 * 60)) * 1_000_000) / 1_000_000;
    expect(collected.find((item) => item.contentId === promotedId)?.score).toBe(
      promotedExpectedScore,
    );
  });

  it("freezes Top candidates so reaction changes between pages cannot duplicate or skip", async () => {
    const communityId = await createCommunity("top-snapshot");
    const now = await databaseNow();
    const createdAt = new Date(now.valueOf() - 2 * 60 * 60 * 1_000);
    const eventAt = new Date(now.valueOf() - 60 * 60 * 1_000);
    const contentIds: string[] = [];
    for (let count = 5; count >= 1; count -= 1) {
      const contentId = await createContent({
        authorActorId: followedAuthorActorId,
        communityId,
        createdAt,
        title: `Frozen Top Helpful ${count}`,
      });
      contentIds.push(contentId);
      await addReactions(contentId, "helpful", reactionActorIds.slice(0, count), eventAt);
    }
    const browseInput = {
      communityId,
      contentTypes: ["post"] as const,
      scope: "community" as const,
      sort: "top" as const,
      topMetric: "helpful" as const,
      window: "7d" as const,
    };
    const expected = await readService.browseContent(null, {
      ...browseInput,
      limit: 100,
    });
    const first = await readService.browseContent(null, {
      ...browseInput,
      limit: 2,
    });
    expect(first.page.nextCursor).toBeTruthy();

    const promotedId = contentIds.at(-1)!;
    await addReactions(
      promotedId,
      "helpful",
      reactionActorIds.slice(1, 11),
      await databaseNow(),
    );

    const collected = [...first.items];
    let cursor = first.page.nextCursor;
    while (cursor !== null) {
      const next = await readService.browseContent(null, {
        ...browseInput,
        cursor,
        limit: 2,
      });
      expect(next.ranking).toEqual(first.ranking);
      collected.push(...next.items);
      cursor = next.page.nextCursor;
    }

    expect(collected.map((item) => item.contentId)).toEqual(
      expected.items.map((item) => item.contentId),
    );
    expect(new Set(collected.map((item) => item.contentId)).size).toBe(collected.length);
    const expectedScores = new Map(
      expected.items.map((item) => [item.contentId, item.score]),
    );
    expect(collected.map((item) => [item.contentId, item.score])).toEqual(
      collected.map((item) => [item.contentId, expectedScores.get(item.contentId)]),
    );
  });

  it("orders Discussion Top by Helpful and keeps that order frozen across reactions", async () => {
    const communityId = await createCommunity("discussion-top");
    const now = await databaseNow();
    const rootId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId,
      createdAt: new Date(now.valueOf() - 3 * 60 * 60 * 1_000),
      title: "Discussion Top root",
    });
    const replyIds: string[] = [];
    for (let count = 4; count >= 1; count -= 1) {
      const replyId = await createContent({
        authorActorId: discoveryAuthorActorId,
        createdAt: new Date(now.valueOf() - (120 - count) * 60 * 1_000),
        parentId: rootId,
        rootId,
        title: `Discussion Helpful ${count}`,
      });
      replyIds.push(replyId);
      await addReactions(
        replyId,
        "helpful",
        reactionActorIds.slice(0, count),
        new Date(now.valueOf() - 30 * 60 * 1_000),
      );
    }
    const limitedReplyId = await createContent({
      authorActorId: discoveryAuthorActorId,
      createdAt: new Date(now.valueOf() - 30 * 60 * 1_000),
      distributionState: "limited",
      parentId: rootId,
      rootId,
      title: "Discussion limited reply",
    });
    await addReactions(
      limitedReplyId,
      "helpful",
      reactionActorIds.slice(0, 10),
      new Date(now.valueOf() - 20 * 60 * 1_000),
    );

    const expected = await readService.getDiscussion(null, {
      contentId: rootId,
      limit: 50,
      sort: "top",
    });
    expect(expected.replies.map((reply) => reply.id)).toEqual(replyIds);
    expect(expected.replies.map((reply) => reply.reactionCounts.helpful)).toEqual([
      4, 3, 2, 1,
    ]);
    const directLatest = await readService.getDiscussion(null, {
      contentId: rootId,
      limit: 50,
      sort: "latest",
    });
    expect(directLatest.replies.map((reply) => reply.id)).toContain(limitedReplyId);

    const first = await readService.getDiscussion(null, {
      contentId: rootId,
      limit: 2,
      sort: "top",
    });
    expect(first.page.nextCursor).toBeTruthy();
    await addReactions(
      replyIds.at(-1)!,
      "helpful",
      reactionActorIds.slice(1, 11),
      await databaseNow(),
    );

    const second = await readService.getDiscussion(null, {
      contentId: rootId,
      cursor: first.page.nextCursor,
      limit: 2,
      sort: "top",
    });
    expect(second.ordering).toEqual(first.ordering);
    const combinedIds = [...first.replies, ...second.replies].map((reply) => reply.id);
    expect(combinedIds).toEqual(replyIds);
    expect(new Set(combinedIds).size).toBe(combinedIds.length);
  });

  it("breaks Discussion Top ties by published time and then descending id", async () => {
    const communityId = await createCommunity("discussion-top-ties");
    const now = await databaseNow();
    const rootId = await createContent({
      authorActorId: followedAuthorActorId,
      communityId,
      createdAt: new Date(now.valueOf() - 4 * 60 * 60 * 1_000),
      title: "Discussion Top tie root",
    });
    const olderId = await createContent({
      authorActorId: discoveryAuthorActorId,
      createdAt: new Date(now.valueOf() - 2 * 60 * 60 * 1_000),
      parentId: rootId,
      rootId,
      title: "Discussion tie older",
    });
    const newerId = await createContent({
      authorActorId: discoveryAuthorActorId,
      createdAt: new Date(now.valueOf() - 60 * 60 * 1_000),
      parentId: rootId,
      rootId,
      title: "Discussion tie newer",
    });
    const samePublishedAt = new Date(now.valueOf() - 30 * 60 * 1_000);
    const sameTimeIds = await Promise.all(
      ["Discussion same-time A", "Discussion same-time B"].map((title) =>
        createContent({
          authorActorId: discoveryAuthorActorId,
          createdAt: samePublishedAt,
          parentId: rootId,
          rootId,
          title,
        }),
      ),
    );
    for (const replyId of [olderId, newerId]) {
      await addReactions(
        replyId,
        "helpful",
        reactionActorIds.slice(0, 2),
        new Date(now.valueOf() - 20 * 60 * 1_000),
      );
    }
    for (const replyId of sameTimeIds) {
      await addReactions(
        replyId,
        "helpful",
        reactionActorIds.slice(0, 1),
        new Date(now.valueOf() - 10 * 60 * 1_000),
      );
    }

    const discussion = await readService.getDiscussion(null, {
      contentId: rootId,
      limit: 50,
      sort: "top",
    });
    expect(discussion.replies.map((reply) => reply.id)).toEqual([
      newerId,
      olderId,
      ...sameTimeIds.toSorted(descendingUuid),
    ]);
  });
});
