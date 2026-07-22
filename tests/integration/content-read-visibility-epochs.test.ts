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
import { PostgresContentSearchService } from "../../packages/domain/src/content-search.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeVisibilityEpochs = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const agentConnectionOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: {
    1: "content-visibility-epoch-integration-pepper-material-v1",
  },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

interface EpochSnapshot {
  contentMembership: number;
  publicCommunityVisibility: number;
}

type CommunityStatus = "active" | "archived" | "read_only" | "suspended";

function requireId(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${label} was not created`);
  }
  return value;
}

describeVisibilityEpochs("content read visibility epochs", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const agentService = new PostgresAgentConnectionService(
    postgres.sql,
    agentConnectionOptions,
  );
  const readService = new PostgresContentReadService(postgres.sql, {
    cursorSigningKey: Buffer.from(
      "content-visibility-epoch-cursor-signing-key-material-v1",
      "utf8",
    ),
  });
  const searchService = new PostgresContentSearchService(postgres.sql, {
    activityDigestKey: Buffer.from(
      "content-visibility-search-activity-key-material-v1",
      "utf8",
    ),
    cursorSigningKey: Buffer.from(
      "content-visibility-search-cursor-key-material-v1",
      "utf8",
    ),
  });
  dependencies.push(postgres);

  let actorId = "";
  let primaryCommunityId = "";
  let initialAdditionalCommunityId = "";
  let alternatePrimaryCommunityId = "";
  let statusCommunityId = "";
  let snapshotCommunityId = "";
  let initialSymbolId = "";
  let replySymbolId = "";
  let lateSymbolId = "";
  let initialTopicId = "";
  let replyTopicId = "";
  let rootContentId = "";
  let rootAuthorContext: AgentCredentialContext;
  let replyAuthorActorId = "";
  let replyAuthorContext: AgentCredentialContext;

  async function readEpochs(): Promise<EpochSnapshot> {
    const rows = await postgres.sql<
      {
        content_membership: number;
        public_community_visibility: number;
      }[]
    >`
      select
        max(epoch) filter (
          where epoch_name = 'content_membership'
        )::integer as content_membership,
        max(epoch) filter (
          where epoch_name = 'public_community_visibility'
        )::integer as public_community_visibility
      from system.content_read_visibility_epochs
    `;
    const row = rows[0];
    if (
      row === undefined ||
      !Number.isInteger(row.content_membership) ||
      !Number.isInteger(row.public_community_visibility)
    ) {
      throw new Error("Content read visibility epochs are unavailable");
    }
    return {
      contentMembership: row.content_membership,
      publicCommunityVisibility: row.public_community_visibility,
    };
  }

  async function expectEpochDelta(
    operation: () => Promise<unknown>,
    expected: EpochSnapshot,
  ): Promise<void> {
    const before = await readEpochs();
    await operation();
    const after = await readEpochs();
    expect({
      contentMembership: after.contentMembership - before.contentMembership,
      publicCommunityVisibility:
        after.publicCommunityVisibility - before.publicCommunityVisibility,
    }).toEqual(expected);
  }

  async function createContent(options: {
    additionalCommunityIds?: readonly string[];
    body?: string;
    createdAt?: Date;
    kind?: "post" | "reply";
    authorActorId?: string;
    parentId?: string;
    primaryCommunityId?: string;
    rootId?: string;
    symbolIds?: readonly string[];
    topicIds?: readonly string[];
  }): Promise<{ contentId: string; revisionId: string }> {
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const kind = options.kind ?? "post";
    const rootId = kind === "post" ? contentId : requireId(options.rootId, "Reply root");
    const parentId = kind === "post" ? null : requireId(options.parentId, "Reply parent");
    const createdAt = options.createdAt ?? new Date();
    const body = options.body ?? `Visibility epoch ${kind} fixture ${contentId}.`;

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
        values (
          ${contentId},
          ${kind},
          ${options.authorActorId ?? actorId},
          ${kind === "post" ? (options.primaryCommunityId ?? primaryCommunityId) : null},
          ${rootId},
          ${parentId},
          ${kind === "post" ? 0 : 1},
          ${createdAt},
          ${createdAt},
          ${createdAt}
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
          ${kind === "post" ? "Visibility epoch integration research" : null},
          ${body},
          ${body},
          ${options.authorActorId ?? actorId},
          ${createdAt},
          1,
          ${randomBytes(32)},
          1024
        )
      `;
      await transaction`
        update platform.content_items
        set current_revision_id = ${revisionId}
        where id = ${contentId}
          and current_revision_id is null
      `;
      for (const [index, communityId] of (
        options.additionalCommunityIds ?? []
      ).entries()) {
        await transaction`
          insert into platform.content_additional_communities (
            content_id,
            community_id,
            position,
            created_at
          )
          values (${contentId}, ${communityId}, ${index + 1}, ${createdAt})
        `;
      }
      for (const [index, symbolId] of (options.symbolIds ?? []).entries()) {
        await transaction`
          insert into platform.content_symbols (
            content_id,
            symbol_id,
            position,
            created_at
          )
          values (${contentId}, ${symbolId}, ${index + 1}, ${createdAt})
        `;
      }
      for (const [index, topicId] of (options.topicIds ?? []).entries()) {
        await transaction`
          insert into platform.content_topics (
            content_id,
            topic_id,
            position,
            created_at
          )
          values (${contentId}, ${topicId}, ${index + 1}, ${createdAt})
        `;
      }
    });

    return { contentId, revisionId };
  }

  async function updateCommunityStatus(status: CommunityStatus): Promise<void> {
    await postgres.sql`
      update platform.communities
      set version = version + 1,
          status = ${status}
      where id = ${statusCommunityId}
    `;
  }

  beforeAll(async () => {
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    primaryCommunityId = randomUUID();
    initialAdditionalCommunityId = randomUUID();
    alternatePrimaryCommunityId = randomUUID();
    statusCommunityId = randomUUID();
    snapshotCommunityId = randomUUID();
    initialSymbolId = randomUUID();
    replySymbolId = randomUUID();
    lateSymbolId = randomUUID();
    initialTopicId = randomUUID();
    replyTopicId = randomUUID();

    const authUsers = await postgres.sql<{ id: string }[]>`
      insert into auth.users (
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        'Content Visibility Epoch Owner',
        ${`content-epoch-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id
    `;
    const authUserId = requireId(authUsers[0]?.id, "Epoch Auth User");
    const owners = await postgres.sql<{ id: string }[]>`
      select id
      from platform.owners
      where auth_user_id = ${authUserId}
    `;
    const ownerId = requireId(owners[0]?.id, "Epoch Owner projection");
    const createdAgent = await agentService.createAgent(
      ownerId,
      {
        displayName: "Content Visibility Epoch Agent",
        handle: `content-epoch-${marker}`,
      },
      randomUUID(),
    );
    actorId = createdAgent.agent.actorId;
    const rootAuthorCredential = await agentService.createCredential(
      ownerId,
      createdAgent.agent.id,
      {
        name: "Content visibility root author read credential",
        scopes: ["research:read"],
      },
      randomUUID(),
    );
    rootAuthorContext = await agentService.authenticateStaticApiKey(
      rootAuthorCredential.apiKey,
    );

    const replyAuthUsers = await postgres.sql<{ id: string }[]>`
      insert into auth.users (
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        'Content Visibility Reply Owner',
        ${`content-epoch-reply-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id
    `;
    const replyAuthUserId = requireId(replyAuthUsers[0]?.id, "Reply author Auth User");
    const replyOwners = await postgres.sql<{ id: string }[]>`
      select id
      from platform.owners
      where auth_user_id = ${replyAuthUserId}
    `;
    const replyOwnerId = requireId(replyOwners[0]?.id, "Reply author Owner projection");
    const replyAgent = await agentService.createAgent(
      replyOwnerId,
      {
        displayName: "Content Visibility Reply Agent",
        handle: `content-epoch-reply-${marker}`,
      },
      randomUUID(),
    );
    replyAuthorActorId = replyAgent.agent.actorId;
    const replyAuthorCredential = await agentService.createCredential(
      replyOwnerId,
      replyAgent.agent.id,
      {
        name: "Content visibility reply author read credential",
        scopes: ["research:read"],
      },
      randomUUID(),
    );
    replyAuthorContext = await agentService.authenticateStaticApiKey(
      replyAuthorCredential.apiKey,
    );

    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.communities (
          id,
          slug,
          name,
          description,
          kind
        )
        values
          (
            ${primaryCommunityId},
            ${`epoch-primary-${marker}`},
            'Epoch Primary Community',
            'Primary placement for epoch trigger coverage.',
            'general'
          ),
          (
            ${initialAdditionalCommunityId},
            ${`epoch-additional-${marker}`},
            'Epoch Additional Community',
            'Initial additional placement for epoch trigger coverage.',
            'general'
          ),
          (
            ${alternatePrimaryCommunityId},
            ${`epoch-alternate-${marker}`},
            'Epoch Alternate Community',
            'Alternate primary placement for epoch trigger coverage.',
            'general'
          ),
          (
            ${statusCommunityId},
            ${`epoch-status-${marker}`},
            'Epoch Status Community',
            'Status-boundary fixture for public visibility epochs.',
            'general'
          ),
          (
            ${snapshotCommunityId},
            ${`epoch-snapshot-${marker}`},
            'Epoch Snapshot Community',
            'Isolated Community for database-snapshot cursor coverage.',
            'general'
          )
      `;
      await transaction`
        insert into platform.topics (id, slug, name, description)
        values
          (
            ${initialTopicId},
            ${`epoch-initial-${marker}`},
            'Epoch Initial Topic',
            'Initial topic mapping for epoch trigger coverage.'
          ),
          (
            ${replyTopicId},
            ${`epoch-reply-${marker}`},
            'Epoch Reply Topic',
            'Reply topic mapping for epoch trigger coverage.'
          )
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
            ${initialSymbolId},
            ${randomUUID()},
            ${`E${marker.slice(0, 7).toUpperCase()}`},
            'TEST',
            'Epoch Initial Symbol'
          ),
          (
            ${replySymbolId},
            ${randomUUID()},
            ${`R${marker.slice(0, 7).toUpperCase()}`},
            'TEST',
            'Epoch Reply Symbol'
          ),
          (
            ${lateSymbolId},
            ${randomUUID()},
            ${`L${marker.slice(0, 7).toUpperCase()}`},
            'TEST',
            'Epoch Late Symbol'
          )
      `;
    });
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("installs the content visibility and Search index epochs", async () => {
    const rows = await postgres.sql<{ epoch: number; epoch_name: string }[]>`
      select epoch_name, epoch::integer as epoch
      from system.content_read_visibility_epochs
      order by epoch_name
    `;
    expect(rows).toEqual([
      { epoch: expect.any(Number), epoch_name: "content_membership" },
      { epoch: expect.any(Number), epoch_name: "public_community_visibility" },
      { epoch: expect.any(Number), epoch_name: "search_index" },
    ]);
  });

  it("tombstones a normal reply when its hidden root is requested directly", async () => {
    const rootBody = `Hidden root payload ${randomUUID().replaceAll("-", "")}.`;
    const searchToken = `hiddenrootreply${randomUUID().replaceAll("-", "")}`;
    const replyBody = `Reply payload ${searchToken}.`;
    const root = await createContent({ body: rootBody });
    const reply = await createContent({
      authorActorId: replyAuthorActorId,
      body: replyBody,
      kind: "reply",
      parentId: root.contentId,
      rootId: root.contentId,
    });

    const visibleSearch = await searchService.searchContent(null, {
      query: searchToken,
      scope: "global",
      searchMode: "lexical",
    });
    expect(visibleSearch.items.map((item) => item.contentId)).toContain(reply.contentId);

    await postgres.sql`
      update platform.content_items
      set version = version + 1,
          distribution_state = 'hidden'
      where id = ${root.contentId}
    `;

    for (const unrelatedViewer of [null, rootAuthorContext] as const) {
      const detail = await readService.getContent(unrelatedViewer, {
        contentId: reply.contentId,
        includeRevisionHistory: true,
        revisionId: reply.revisionId,
      });
      expect(detail).toMatchObject({
        content: {
          currentRevisionId: null,
          distributionState: "hidden",
          id: reply.contentId,
          kind: "reply",
          rootContentId: root.contentId,
          symbols: [],
          topics: [],
        },
        effectiveCommunityIds: [],
        reactionCounts: { agree: 0, disagree: 0, helpful: 0 },
        revision: null,
      });
      expect(detail).not.toHaveProperty("revisionHistory");
      expect(JSON.stringify(detail)).not.toContain(replyBody);
      expect(JSON.stringify(detail)).not.toContain(rootBody);
    }

    const authorDetail = await readService.getContent(replyAuthorContext, {
      contentId: reply.contentId,
    });
    expect(authorDetail.content).toMatchObject({
      currentRevisionId: reply.revisionId,
      distributionState: "hidden",
      id: reply.contentId,
      rootContentId: root.contentId,
    });
    expect(authorDetail.revision?.bodyMarkdown).toBe(replyBody);
    expect(JSON.stringify(authorDetail)).not.toContain(rootBody);

    const browse = await readService.browseContent(null, {
      authorActorId: replyAuthorActorId,
      contentTypes: ["reply"],
      scope: "author",
    });
    expect(browse.items.map((item) => item.contentId)).not.toContain(reply.contentId);
    const hiddenSearch = await searchService.searchContent(null, {
      query: searchToken,
      scope: "global",
      searchMode: "lexical",
    });
    expect(hiddenSearch.items.map((item) => item.contentId)).not.toContain(
      reply.contentId,
    );
    await expect(
      readService.getDiscussion(null, { contentId: reply.contentId }),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND", statusCode: 404 });
  });

  it("database-assigns immutable creation XIDs for Content and revisions", async () => {
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const createdAt = new Date();
    let currentXid = "";
    let contentXid = "";
    let revisionXid = "";

    await postgres.sql.begin(async (transaction) => {
      const currentRows = await transaction<{ current_xid: string }[]>`
        select pg_current_xact_id()::text as current_xid
      `;
      currentXid = requireId(currentRows[0]?.current_xid, "Current transaction XID");

      const contentRows = await transaction<{ created_xid: string }[]>`
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
          updated_at,
          content_read_created_xid
        )
        values (
          ${contentId},
          'post',
          ${actorId},
          ${primaryCommunityId},
          ${contentId},
          null,
          0,
          ${createdAt},
          ${createdAt},
          ${createdAt},
          '1'::xid8
        )
        returning content_read_created_xid::text as created_xid
      `;
      contentXid = requireId(contentRows[0]?.created_xid, "Content creation XID");

      const body = `Creation XID integration fixture ${contentId}.`;
      const revisionRows = await transaction<{ created_xid: string }[]>`
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
          public_node_serialized_bytes,
          content_read_created_xid
        )
        values (
          ${revisionId},
          ${contentId},
          1,
          'Creation XID integration fixture',
          ${body},
          ${body},
          ${actorId},
          ${createdAt},
          1,
          ${randomBytes(32)},
          1024,
          '2'::xid8
        )
        returning content_read_created_xid::text as created_xid
      `;
      revisionXid = requireId(
        revisionRows[0]?.created_xid,
        "Content revision creation XID",
      );

      await transaction`
        update platform.content_items
        set current_revision_id = ${revisionId}
        where id = ${contentId}
      `;
    });

    expect(contentXid).toBe(currentXid);
    expect(revisionXid).toBe(currentXid);
    await expect(
      postgres.sql`
        update platform.content_items
        set content_read_created_xid = '1'::xid8
        where id = ${contentId}
      `,
    ).rejects.toThrow(/creation transaction is immutable/iu);
  });

  it("rejects a critical trigger that is enabled only for replica sessions", async () => {
    await expect(readService.checkReady()).resolves.toBeUndefined();
    try {
      await postgres.sql`
        alter table platform.symbols
        enable replica trigger symbols_advance_read_membership_epoch
      `;
      await expect(readService.checkReady()).rejects.toMatchObject({
        code: "CONTENT_READ_NOT_READY",
        statusCode: 503,
      });
    } finally {
      await postgres.sql`
        alter table platform.symbols
        enable trigger symbols_advance_read_membership_epoch
      `;
    }
    await expect(readService.checkReady()).resolves.toBeUndefined();
  });

  it("does not advance epochs for new posts, replies, or their initial mappings", async () => {
    await expectEpochDelta(
      async () => {
        const root = await createContent({
          additionalCommunityIds: [initialAdditionalCommunityId],
          symbolIds: [initialSymbolId],
          topicIds: [initialTopicId],
        });
        rootContentId = root.contentId;
        await createContent({
          kind: "reply",
          parentId: rootContentId,
          rootId: rootContentId,
          symbolIds: [replySymbolId],
          topicIds: [replyTopicId],
        });
      },
      {
        contentMembership: 0,
        publicCommunityVisibility: 0,
      },
    );
  });

  it("does not advance epochs for an ordinary revision and current-revision update", async () => {
    const nextRevisionId = randomUUID();
    const body = "An ordinary second revision that does not change membership.";
    await expectEpochDelta(
      async () => {
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
            ${nextRevisionId},
            ${rootContentId},
            2,
            'Visibility epoch revised research',
            ${body},
            ${body},
            'Ordinary content revision',
            ${actorId},
            2,
            ${randomBytes(32)},
            1024
          )
        `;
          await transaction`
          update platform.content_items
          set version = version + 1,
              current_revision_id = ${nextRevisionId}
          where id = ${rootContentId}
        `;
        });
      },
      {
        contentMembership: 0,
        publicCommunityVisibility: 0,
      },
    );
  });

  it("keeps backdated post-snapshot Content out of cursor continuations without advancing epochs", async () => {
    const baseline = Date.now() - 60_000;
    for (const offset of [1_000, 2_000, 3_000]) {
      await createContent({
        createdAt: new Date(baseline + offset),
        primaryCommunityId: snapshotCommunityId,
      });
    }

    const first = await readService.browseContent(null, {
      communityId: snapshotCommunityId,
      limit: 1,
      scope: "community",
      sort: "latest",
    });
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).toBeTruthy();

    let backdatedContentId = "";
    await expectEpochDelta(
      async () => {
        const backdated = await createContent({
          additionalCommunityIds: [initialAdditionalCommunityId],
          createdAt: new Date(baseline - 86_400_000),
          primaryCommunityId: snapshotCommunityId,
          symbolIds: [initialSymbolId],
          topicIds: [initialTopicId],
        });
        backdatedContentId = backdated.contentId;
      },
      { contentMembership: 0, publicCommunityVisibility: 0 },
    );

    const frozenContentIds = first.items.map((item) => item.contentId);
    let cursor = first.page.nextCursor;
    let continuationCount = 0;
    while (cursor !== null) {
      continuationCount += 1;
      if (continuationCount > 10) {
        throw new Error("Backdated Content cursor did not terminate");
      }
      const next = await readService.browseContent(null, {
        communityId: snapshotCommunityId,
        cursor,
        limit: 1,
        scope: "community",
        sort: "latest",
      });
      frozenContentIds.push(...next.items.map((item) => item.contentId));
      cursor = next.page.nextCursor;
    }

    expect(continuationCount).toBeGreaterThan(0);
    expect(frozenContentIds).toHaveLength(3);
    expect(frozenContentIds).not.toContain(backdatedContentId);
  });

  it("keeps primary placement immutable and advances membership for visibility changes", async () => {
    const mutable = await createContent({});

    const beforeRejectedPlacement = await readEpochs();
    await expect(
      postgres.sql`
        update platform.content_items
        set version = version + 1,
            primary_community_id = ${alternatePrimaryCommunityId}
        where id = ${mutable.contentId}
      `,
    ).rejects.toThrow(/primary Community/iu);
    await expect(readEpochs()).resolves.toEqual(beforeRejectedPlacement);
    await expectEpochDelta(
      () => postgres.sql`
        update platform.content_items
        set version = version + 1,
            distribution_state = 'hidden'
        where id = ${mutable.contentId}
      `,
      { contentMembership: 1, publicCommunityVisibility: 0 },
    );
    await expectEpochDelta(
      () => postgres.sql`
        update platform.content_items
        set version = version + 1,
            lifecycle_state = 'deleted',
            deleted_at = clock_timestamp()
        where id = ${mutable.contentId}
      `,
      { contentMembership: 1, publicCommunityVisibility: 0 },
    );
  });

  it("advances the appropriate epochs at Community visibility boundaries", async () => {
    await expectEpochDelta(() => updateCommunityStatus("read_only"), {
      contentMembership: 0,
      publicCommunityVisibility: 0,
    });
    await expectEpochDelta(() => updateCommunityStatus("active"), {
      contentMembership: 0,
      publicCommunityVisibility: 0,
    });
    await expectEpochDelta(() => updateCommunityStatus("archived"), {
      contentMembership: 0,
      publicCommunityVisibility: 0,
    });
    await expectEpochDelta(() => updateCommunityStatus("active"), {
      contentMembership: 0,
      publicCommunityVisibility: 0,
    });
    await expectEpochDelta(() => updateCommunityStatus("suspended"), {
      contentMembership: 0,
      publicCommunityVisibility: 1,
    });
    await expectEpochDelta(() => updateCommunityStatus("read_only"), {
      contentMembership: 0,
      publicCommunityVisibility: 1,
    });
    await expectEpochDelta(() => updateCommunityStatus("archived"), {
      contentMembership: 0,
      publicCommunityVisibility: 0,
    });
    await expectEpochDelta(
      () => postgres.sql`
        update platform.communities
        set version = version + 1,
            deleted_at = clock_timestamp()
        where id = ${statusCommunityId}
      `,
      { contentMembership: 1, publicCommunityVisibility: 0 },
    );
  });

  it("advances content membership when a mapped catalog identity key changes", async () => {
    await expectEpochDelta(
      () => postgres.sql`
        update platform.symbols
        set ticker = (
              'Z' || upper(substr(replace(id::text, '-', ''), 1, 8))
            )::public.citext,
            updated_at = clock_timestamp()
        where id = ${lateSymbolId}
      `,
      { contentMembership: 0, publicCommunityVisibility: 0 },
    );
    await expectEpochDelta(
      () => postgres.sql`
        update platform.symbols
        set ticker = (
              'Z' || upper(substr(replace(id::text, '-', ''), 1, 8))
            )::public.citext,
            updated_at = clock_timestamp()
        where id = ${initialSymbolId}
      `,
      { contentMembership: 1, publicCommunityVisibility: 0 },
    );
    await expectEpochDelta(
      () => postgres.sql`
        update platform.topics
        set slug = (
              'renamed-' || substr(replace(id::text, '-', ''), 1, 8)
            )::public.citext,
            updated_at = clock_timestamp()
        where id = ${initialTopicId}
      `,
      { contentMembership: 1, publicCommunityVisibility: 0 },
    );
  });

  it("advances content membership for later mapping insert, update, and delete", async () => {
    await expectEpochDelta(
      () => postgres.sql`
        insert into platform.content_symbols (
          content_id,
          symbol_id,
          position,
          created_at
        )
        select
          content.id,
          ${lateSymbolId},
          2,
          content.created_at
        from platform.content_items as content
        where content.id = ${rootContentId}
      `,
      { contentMembership: 1, publicCommunityVisibility: 0 },
    );
    await expectEpochDelta(
      () => postgres.sql`
        update platform.content_topics
        set position = 2
        where content_id = ${rootContentId}
          and topic_id = ${initialTopicId}
      `,
      { contentMembership: 1, publicCommunityVisibility: 0 },
    );
    await expectEpochDelta(
      () => postgres.sql`
        delete from platform.content_additional_communities
        where content_id = ${rootContentId}
          and community_id = ${initialAdditionalCommunityId}
      `,
      { contentMembership: 1, publicCommunityVisibility: 0 },
    );
  });
});
