import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";
import { FOLLOW_GRAPH_MIGRATION_CHECKSUM } from "../../packages/domain/src/schema-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeFollowSchema = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];

function requireId(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`${label} was not created`);
  }
  return value;
}

describeFollowSchema("Follow graph schema", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  dependencies.push(postgres);

  let marker = "";
  let followerActorId = "";
  let cardinalityFollowerActorId = "";
  let targetActorId = "";
  let alternateActorId = "";
  let inactiveFollowerActorId = "";
  let inactiveTargetActorId = "";
  let activeSymbolId = "";
  let inactiveSymbolId = "";
  let ambiguousSymbolId = "";
  let ambiguousSymbolPeerId = "";
  let activeTopicId = "";
  let deletedTopicId = "";
  let visibleContentId = "";
  let hiddenContentId = "";
  let actorFollowId = "";
  let symbolFollowId = "";
  let topicFollowId = "";
  let contentFollowId = "";

  async function createHumanActor(
    marker: string,
    status: "active" | "suspended" = "active",
  ): Promise<string> {
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
        ${`Follow ${marker}`},
        ${`follow-${marker}-${userId.slice(0, 8)}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
    `;
    const owners = await postgres.sql<{ id: string }[]>`
      select id
      from platform.owners
      where auth_user_id = ${userId}
    `;
    const ownerId = requireId(owners[0]?.id, `${marker} Owner`);
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
        ${ownerId},
        ${`follow-${marker}-${userId.slice(0, 6)}`},
        ${`Follow ${marker}`},
        ${status}
      )
    `;
    return actorId;
  }

  async function createPost(options: {
    authorActorId: string;
    communityId: string;
    distributionState?: "hidden" | "normal";
  }): Promise<string> {
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const body = `Follow schema fixture ${contentId}`;
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.content_items (
          id,
          kind,
          author_actor_id,
          primary_community_id,
          root_id,
          depth,
          distribution_state
        )
        values (
          ${contentId},
          'post',
          ${options.authorActorId},
          ${options.communityId},
          ${contentId},
          0,
          ${options.distributionState ?? "normal"}
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
          'Follow schema research',
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

  async function readFollowerEpoch(actorId: string): Promise<number> {
    const rows = await postgres.sql<{ epoch: number }[]>`
      select coalesce(
        (
          select epoch
          from system.actor_follow_epochs
          where actor_id = ${actorId}
        ),
        0
      )::integer as epoch
    `;
    return rows[0]?.epoch ?? -1;
  }

  async function waitForAdvisoryLock(backendPid: number, label: string): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const sessions = await postgres.sql<
        { wait_event: string | null; wait_event_type: string | null }[]
      >`
        select wait_event, wait_event_type
        from pg_stat_activity
        where pid = ${backendPid}
      `;
      if (
        sessions[0]?.wait_event_type === "Lock" &&
        sessions[0]?.wait_event === "advisory"
      ) {
        return;
      }
      await delay(10);
    }
    throw new Error(`${label} did not wait for the cardinality advisory lock`);
  }

  beforeAll(async () => {
    marker = randomUUID().replaceAll("-", "").slice(0, 7);
    followerActorId = await createHumanActor(`${marker}f`);
    cardinalityFollowerActorId = await createHumanActor(`${marker}c`);
    targetActorId = await createHumanActor(`${marker}t`);
    alternateActorId = await createHumanActor(`${marker}a`);
    inactiveFollowerActorId = await createHumanActor(`${marker}if`, "suspended");
    inactiveTargetActorId = await createHumanActor(`${marker}it`, "suspended");

    activeSymbolId = randomUUID();
    inactiveSymbolId = randomUUID();
    ambiguousSymbolId = randomUUID();
    ambiguousSymbolPeerId = randomUUID();
    activeTopicId = randomUUID();
    deletedTopicId = randomUUID();
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
            ${activeSymbolId},
            ${randomUUID()},
            ${`F${marker.toUpperCase()}`},
            'TEST',
            'Follow Active Symbol',
            'active'
          ),
          (
            ${inactiveSymbolId},
            ${randomUUID()},
            ${`I${marker.toUpperCase()}`},
            'TEST',
            'Follow Inactive Symbol',
            'inactive'
          ),
          (
            ${ambiguousSymbolId},
            ${randomUUID()},
            ${`A${marker.toUpperCase()}`},
            'TEST1',
            'Follow Ambiguous Symbol One',
            'active'
          ),
          (
            ${ambiguousSymbolPeerId},
            ${randomUUID()},
            ${`A${marker.toUpperCase()}`},
            'TEST2',
            'Follow Ambiguous Symbol Two',
            'active'
          )
      `;
      await transaction`
        insert into platform.topics (
          id,
          slug,
          name,
          deleted_at
        )
        values
          (
            ${activeTopicId},
            ${`follow-active-${marker}`},
            'Follow Active Topic',
            null
          ),
          (
            ${deletedTopicId},
            ${`follow-deleted-${marker}`},
            'Follow Deleted Topic',
            clock_timestamp() + interval '1 second'
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
          ${`follow-community-${marker}`},
          'Follow Schema Community',
          'Primary Community for Follow schema integration fixtures.',
          'general'
        )
      `;
    });

    visibleContentId = await createPost({
      authorActorId: followerActorId,
      communityId,
    });
    hiddenContentId = await createPost({
      authorActorId: followerActorId,
      communityId,
      distributionState: "hidden",
    });
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("records the exact migration and installs its closed schema shape", async () => {
    const migration = await readFile(
      `${process.cwd()}/db/migrations/000011_follow_graph.up.sql`,
    );
    const checksum = createHash("sha256").update(migration).digest("hex");
    expect(checksum).toBe(FOLLOW_GRAPH_MIGRATION_CHECKSUM);

    const ledger = await postgres.sql<
      { checksum: string; name: string; version: string }[]
    >`
      select version, name, checksum
      from system.schema_migrations
      where version = '000011'
    `;
    expect(ledger).toEqual([
      {
        checksum: FOLLOW_GRAPH_MIGRATION_CHECKSUM,
        name: "follow_graph",
        version: "000011",
      },
    ]);

    const shape = await postgres.sql<
      {
        constraints: number;
        indexes: number;
        tables: number;
        triggers: number;
      }[]
    >`
      select
        (
          select count(*)::integer
          from pg_constraint
          where conrelid = 'platform.follows'::regclass
            and conname in (
              'follows_target_shape',
              'follows_no_self_actor',
              'follows_notification_level',
              'follows_updated_after_created',
              'follows_timestamp_precision'
            )
            and convalidated
        ) as constraints,
        (
          select count(*)::integer
          from pg_class
          where oid = any(array[
            to_regclass('platform.follows_follower_actor_target_unique'),
            to_regclass('platform.follows_follower_symbol_target_unique'),
            to_regclass('platform.follows_follower_topic_target_unique'),
            to_regclass('platform.follows_follower_content_target_unique'),
            to_regclass('platform.follows_follower_updated_idx'),
            to_regclass('platform.follows_target_actor_reverse_idx'),
            to_regclass('platform.follows_target_symbol_reverse_idx'),
            to_regclass('platform.follows_target_topic_reverse_idx'),
            to_regclass('platform.follows_target_content_reverse_idx'),
            to_regclass(
              'platform.action_logs_follow_succeeded_agent_occurred_idx'
            )
          ]::oid[])
        ) as indexes,
        (
          select count(*)::integer
          from pg_class
          where oid in (
            'platform.follows'::regclass,
            'system.actor_follow_epochs'::regclass
          )
        ) as tables,
        (
          select count(*)::integer
          from pg_trigger
          where tgrelid = 'platform.follows'::regclass
            and tgname in (
              'follows_validate_write',
              'follows_prepare_update',
              'follows_advance_actor_epoch'
            )
            and not tgisinternal
            and tgenabled in ('O', 'A')
        ) as triggers
    `;
    expect(shape).toEqual([{ constraints: 5, indexes: 10, tables: 2, triggers: 3 }]);
  });

  it("stores one canonical fact for each target kind and isolates its epoch", async () => {
    expect(await readFollowerEpoch(followerActorId)).toBe(0);
    expect(await readFollowerEpoch(targetActorId)).toBe(0);

    actorFollowId = randomUUID();
    symbolFollowId = randomUUID();
    topicFollowId = randomUUID();
    contentFollowId = randomUUID();
    await postgres.sql`
      insert into platform.follows (
        id,
        follower_actor_id,
        target_type,
        target_actor_id,
        notification_level
      )
      values (
        ${actorFollowId},
        ${followerActorId},
        'actor',
        ${targetActorId},
        'new_posts'
      )
    `;
    await postgres.sql`
      insert into platform.follows (
        id,
        follower_actor_id,
        target_type,
        target_symbol_id
      )
      values (${symbolFollowId}, ${followerActorId}, 'symbol', ${activeSymbolId})
    `;
    await postgres.sql`
      insert into platform.follows (
        id,
        follower_actor_id,
        target_type,
        target_topic_id,
        notification_level
      )
      values (
        ${topicFollowId},
        ${followerActorId},
        'topic',
        ${activeTopicId},
        'all_events'
      )
    `;
    await postgres.sql`
      insert into platform.follows (
        id,
        follower_actor_id,
        target_type,
        target_content_id
      )
      values (
        ${contentFollowId},
        ${followerActorId},
        'content',
        ${visibleContentId}
      )
    `;

    const rows = await postgres.sql<
      { notification_level: string; target_type: string }[]
    >`
      select target_type, notification_level
      from platform.follows
      where follower_actor_id = ${followerActorId}
      order by target_type
    `;
    expect(rows).toEqual([
      { notification_level: "new_posts", target_type: "actor" },
      { notification_level: "feed_only", target_type: "content" },
      { notification_level: "feed_only", target_type: "symbol" },
      { notification_level: "all_events", target_type: "topic" },
    ]);

    const timestampPrecision = await postgres.sql<
      { created_milliseconds: string; updated_milliseconds: string }[]
    >`
      select
        to_char(created_at, 'US') as created_milliseconds,
        to_char(updated_at, 'US') as updated_milliseconds
      from platform.follows
      where follower_actor_id = ${followerActorId}
      order by target_type
    `;
    expect(timestampPrecision).toHaveLength(4);
    for (const timestamp of timestampPrecision) {
      expect(timestamp.created_milliseconds).toMatch(/^\d{3}000$/u);
      expect(timestamp.updated_milliseconds).toMatch(/^\d{3}000$/u);
    }

    await expect(
      postgres.sql`
        insert into platform.follows (
          follower_actor_id,
          target_type,
          target_actor_id,
          created_at,
          updated_at
        )
        values (
          ${followerActorId},
          'actor',
          ${alternateActorId},
          '2026-07-21T12:00:00.123456Z'::timestamptz,
          '2026-07-21T12:00:00.123456Z'::timestamptz
        )
      `,
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "follows_timestamp_precision",
    });
    expect(await readFollowerEpoch(followerActorId)).toBe(4);
    expect(await readFollowerEpoch(targetActorId)).toBe(0);

    for (const duplicate of [
      postgres.sql`
        insert into platform.follows (
          follower_actor_id, target_type, target_actor_id
        ) values (${followerActorId}, 'actor', ${targetActorId})
      `,
      postgres.sql`
        insert into platform.follows (
          follower_actor_id, target_type, target_symbol_id
        ) values (${followerActorId}, 'symbol', ${activeSymbolId})
      `,
      postgres.sql`
        insert into platform.follows (
          follower_actor_id, target_type, target_topic_id
        ) values (${followerActorId}, 'topic', ${activeTopicId})
      `,
      postgres.sql`
        insert into platform.follows (
          follower_actor_id, target_type, target_content_id
        ) values (${followerActorId}, 'content', ${visibleContentId})
      `,
    ]) {
      await expect(duplicate).rejects.toMatchObject({ code: "23505" });
    }
    expect(await readFollowerEpoch(followerActorId)).toBe(4);
  });

  it("permits only real preference updates and advances only the follower epoch", async () => {
    await postgres.sql`
      update platform.follows
      set notification_level = 'all_events'
      where id = ${actorFollowId}
    `;
    expect(await readFollowerEpoch(followerActorId)).toBe(5);
    expect(await readFollowerEpoch(targetActorId)).toBe(0);

    await expect(
      postgres.sql`
        update platform.follows
        set notification_level = 'all_events'
        where id = ${actorFollowId}
      `,
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      postgres.sql`
        update platform.follows
        set target_actor_id = ${alternateActorId}
        where id = ${actorFollowId}
      `,
    ).rejects.toMatchObject({ code: "22023" });
    expect(await readFollowerEpoch(followerActorId)).toBe(5);

    await postgres.sql`
      delete from platform.follows
      where id = ${symbolFollowId}
    `;
    expect(await readFollowerEpoch(followerActorId)).toBe(6);
  });

  it("rejects self follows, inactive identities, and unusable targets", async () => {
    await expect(
      postgres.sql`
        insert into platform.follows (
          follower_actor_id, target_type, target_actor_id
        ) values (${followerActorId}, 'actor', ${followerActorId})
      `,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      postgres.sql`
        insert into platform.follows (
          follower_actor_id, target_type, target_topic_id
        ) values (${inactiveFollowerActorId}, 'topic', ${activeTopicId})
      `,
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      postgres.sql`
        insert into platform.follows (
          follower_actor_id, target_type, target_actor_id
        ) values (${followerActorId}, 'actor', ${inactiveTargetActorId})
      `,
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      postgres.sql`
        insert into platform.follows (
          follower_actor_id, target_type, target_symbol_id
        ) values (${followerActorId}, 'symbol', ${inactiveSymbolId})
      `,
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      postgres.sql`
        insert into platform.follows (
          follower_actor_id, target_type, target_topic_id
        ) values (${followerActorId}, 'topic', ${deletedTopicId})
      `,
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      postgres.sql`
        insert into platform.follows (
          follower_actor_id, target_type, target_content_id
        ) values (${followerActorId}, 'content', ${hiddenContentId})
      `,
    ).rejects.toMatchObject({ code: "55000" });
    expect(await readFollowerEpoch(followerActorId)).toBe(6);
  });

  it("rejects a Symbol target whose active ticker is ambiguous", async () => {
    await expect(
      postgres.sql`
        insert into platform.follows (
          follower_actor_id, target_type, target_symbol_id
        ) values (${followerActorId}, 'symbol', ${ambiguousSymbolId})
      `,
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "follows_symbol_target_unambiguous",
    });
    expect(await readFollowerEpoch(followerActorId)).toBe(6);
  });

  it("serializes direct inserts at the 1000-Follow cardinality boundary", async () => {
    const topicPrefix = `follow-cap-${marker}-`;
    await postgres.sql`
        insert into platform.topics (slug, name)
        select
          ${topicPrefix} || series::text,
          'Follow cardinality topic ' || series::text
        from generate_series(1, 1002) as series
      `;

    await postgres.sql`
        insert into platform.follows (
          follower_actor_id,
          target_type,
          target_topic_id
        )
        select
          ${cardinalityFollowerActorId},
          'topic',
          topic.id
        from platform.topics as topic
        where topic.slug::text like ${`${topicPrefix}%`}
        order by topic.id
        limit 999
      `;
    expect(await readFollowerEpoch(cardinalityFollowerActorId)).toBe(999);

    const remainingTargets = await postgres.sql<{ id: string }[]>`
        select topic.id
        from platform.topics as topic
        where topic.slug::text like ${`${topicPrefix}%`}
          and not exists (
            select 1
            from platform.follows as follow
            where follow.follower_actor_id = ${cardinalityFollowerActorId}
              and follow.target_topic_id = topic.id
          )
        order by topic.id
      `;
    const firstTargetId = requireId(remainingTargets[0]?.id, "first cardinality target");
    const concurrentTargetId = requireId(
      remainingTargets[1]?.id,
      "concurrent cardinality target",
    );
    const directTargetId = requireId(
      remainingTargets[2]?.id,
      "direct cardinality target",
    );

    const firstConnection = await postgres.sql.reserve();
    const secondConnection = await postgres.sql.reserve();
    let firstTransactionOpen = false;
    let secondTransactionOpen = false;
    let secondOutcome:
      { status: "fulfilled" } | { error: unknown; status: "rejected" } | undefined;
    let secondOutcomePromise:
      | Promise<{ status: "fulfilled" } | { error: unknown; status: "rejected" }>
      | undefined;

    try {
      await firstConnection`begin`;
      firstTransactionOpen = true;
      await firstConnection`
          insert into platform.follows (
            follower_actor_id, target_type, target_topic_id
          ) values (${cardinalityFollowerActorId}, 'topic', ${firstTargetId})
        `;

      await secondConnection`begin`;
      secondTransactionOpen = true;
      const backendRows = await secondConnection<{ pid: number }[]>`
          select pg_backend_pid()::integer as pid
        `;
      const secondBackendPid = backendRows[0]?.pid;
      if (!secondBackendPid) {
        throw new Error("second Follow insert backend PID was unavailable");
      }
      secondOutcomePromise = Promise.resolve(
        secondConnection`
            insert into platform.follows (
              follower_actor_id, target_type, target_topic_id
            ) values (
              ${cardinalityFollowerActorId},
              'topic',
              ${concurrentTargetId}
            )
          `,
      ).then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ error, status: "rejected" as const }),
      );

      await waitForAdvisoryLock(secondBackendPid, "second Follow insert");
      await firstConnection`commit`;
      firstTransactionOpen = false;
      secondOutcome = await secondOutcomePromise;
    } finally {
      if (firstTransactionOpen) await firstConnection`rollback`;
      if (secondTransactionOpen) await secondConnection`rollback`;
      await secondOutcomePromise;
      firstConnection.release();
      secondConnection.release();
    }

    expect(secondOutcome?.status).toBe("rejected");
    if (secondOutcome?.status === "rejected") {
      expect(secondOutcome.error).toMatchObject({
        code: "23514",
        constraint_name: "follows_actor_cardinality_limit",
      });
    }

    const atLimit = await postgres.sql<{ count: number }[]>`
        select count(*)::integer as count
        from platform.follows
        where follower_actor_id = ${cardinalityFollowerActorId}
      `;
    expect(atLimit).toEqual([{ count: 1000 }]);
    expect(await readFollowerEpoch(cardinalityFollowerActorId)).toBe(1000);

    await expect(
      postgres.sql`
          insert into platform.follows (
            follower_actor_id, target_type, target_topic_id
          ) values (${cardinalityFollowerActorId}, 'topic', ${directTargetId})
        `,
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "follows_actor_cardinality_limit",
    });
    expect(await readFollowerEpoch(cardinalityFollowerActorId)).toBe(1000);
  }, 30_000);

  it("revalidates a target before a preference update", async () => {
    await postgres.sql`
      update platform.actors
      set status = 'suspended'
      where id = ${targetActorId}
    `;
    await expect(
      postgres.sql`
        update platform.follows
        set notification_level = 'feed_only'
        where id = ${actorFollowId}
      `,
    ).rejects.toMatchObject({ code: "55000" });

    await postgres.sql`
      update platform.communities
      set status = 'suspended',
          version = version + 1
      where id = (
        select primary_community_id
        from platform.content_items
        where id = ${visibleContentId}
      )
    `;
    await expect(
      postgres.sql`
        update platform.follows
        set notification_level = 'all_events'
        where id = ${contentFollowId}
      `,
    ).rejects.toMatchObject({ code: "55000" });

    const rows = await postgres.sql<{ actor_level: string; content_level: string }[]>`
      select
        (
          select notification_level
          from platform.follows
          where id = ${actorFollowId}
        ) as actor_level,
        (
          select notification_level
          from platform.follows
          where id = ${contentFollowId}
        ) as content_level
    `;
    expect(rows).toEqual([{ actor_level: "all_events", content_level: "feed_only" }]);
    expect(await readFollowerEpoch(followerActorId)).toBe(6);
  });
});
