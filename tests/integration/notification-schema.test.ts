import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
  type PostgresClient,
} from "../../packages/database/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeNotificationSchema = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
type TransactionSql = Parameters<Parameters<PostgresClient["begin"]>[1]>[0];
type TaggedQueryForwarder = (
  strings: TemplateStringsArray,
  ...parameters: readonly unknown[]
) => Promise<unknown>;

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

function roleScopedPostgres(sql: PostgresClient, role: string): PostgresClient {
  const roleSql = quoteRole(role);
  const scoped = (async (
    strings: TemplateStringsArray,
    ...parameters: readonly unknown[]
  ) =>
    sql.begin(async (transaction) => {
      await transaction.unsafe(`set local role ${roleSql}`);
      const forward = transaction as unknown as TaggedQueryForwarder;
      return forward(strings, ...parameters);
    })) as unknown as PostgresClient;
  scoped.begin = (async (callback: (transaction: TransactionSql) => Promise<unknown>) =>
    sql.begin(async (transaction) => {
      await transaction.unsafe(`set local role ${roleSql}`);
      return callback(transaction);
    })) as PostgresClient["begin"];
  return scoped;
}

type NotificationRow = {
  aggregate_agent_count: number | null;
  aggregate_distinct_actor_count: number | null;
  aggregate_human_count: number | null;
  change_sequence: number;
  created_sequence: number;
  id: string;
  read_at: Date | null;
  updated_at: Date;
  version: number;
};

describeNotificationSchema("Notifications v1 schema", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  dependencies.push(postgres);

  const marker = randomUUID().replaceAll("-", "").slice(0, 8);
  const runtimeRole = `alphanet_ntf_${marker}`;
  const runtimeSql = roleScopedPostgres(postgres.sql, runtimeRole);
  let recipientActorId = "";
  let humanTriggerActorId = "";
  let agentTriggerActorId = "";
  let lateTriggerActorId = "";
  let concurrentTriggerActorId = "";
  let communityId = "";
  let contentId = "";
  let genericNotificationId = "";
  let reactionNotificationId = "";

  async function createActor(label: string, kind: "agent" | "human"): Promise<string> {
    const userId = randomUUID();
    const actorId = randomUUID();
    const agentId = randomUUID();
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
        ${`Notification ${label}`},
        ${`notification-${label}-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
    `;
    const owners = await postgres.sql<{ id: string }[]>`
      select id from platform.owners where auth_user_id = ${userId}
    `;
    const ownerId = requireId(owners[0]?.id, `${label} Owner`);
    await postgres.sql.begin(async (transaction) => {
      await transaction`
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
          ${kind},
          ${ownerId},
          ${`ntf-${label}-${marker}`},
          ${`Notification ${label}`},
          'active'
        )
      `;
      if (kind === "agent") {
        await transaction`
          insert into platform.agents (
            id,
            actor_id,
            owner_id,
            discovery_tags,
            status,
            activated_at
          )
          values (
            ${agentId},
            ${actorId},
            ${ownerId},
            array['notification-test']::text[],
            'active',
            clock_timestamp()
          )
        `;
        await transaction`
          insert into platform.agent_policies (
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
            ${agentId},
            'assisted',
            'agent-permission-defaults-v1',
            1,
            1,
            ${transaction.json({})},
            true,
            ${ownerId}
          )
        `;
        await transaction`
          update platform.registration_controls
          set active_agent_count = active_agent_count + 1
          where id = true
        `;
      }
    });
    return actorId;
  }

  async function projectReaction(
    actorId: string,
    active: boolean,
    occurredAt: string,
    eventSequence: string,
    candidateId: string = randomUUID(),
  ): Promise<NotificationRow[]> {
    return runtimeSql<NotificationRow[]>`
      select id, version::integer as version,
        created_sequence::integer as created_sequence,
        change_sequence::integer as change_sequence,
        read_at, updated_at,
        aggregate_distinct_actor_count::integer as aggregate_distinct_actor_count,
        aggregate_agent_count::integer as aggregate_agent_count,
        aggregate_human_count::integer as aggregate_human_count
      from system.project_reaction_notification(
        ${candidateId},
        ${recipientActorId},
        ${contentId},
        'helpful',
        date_bin(
          interval '10 minutes',
          ${occurredAt}::timestamptz,
          '2000-01-01T00:00:00Z'::timestamptz
        ),
        ${actorId},
        ${active},
        ${occurredAt}::timestamptz,
        ${eventSequence}::bigint
      )
    `;
  }

  beforeAll(async () => {
    recipientActorId = await createActor("recipient", "agent");
    humanTriggerActorId = await createActor("human", "human");
    agentTriggerActorId = await createActor("agent", "agent");
    lateTriggerActorId = await createActor("late", "human");
    concurrentTriggerActorId = await createActor("concurrent", "agent");
    communityId = randomUUID();
    contentId = randomUUID();
    const revisionId = randomUUID();
    const symbolId = randomUUID();
    const ticker = `N${marker.toUpperCase()}`;

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
        values (
          ${symbolId},
          ${randomUUID()},
          ${ticker},
          'TEST',
          'Notification schema symbol',
          'active'
        )
      `;
      await transaction`
        insert into platform.communities (id, slug, name, kind)
        values (
          ${communityId},
          ${`notification-${marker}`},
          'Notification schema Community',
          'general'
        )
      `;
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
          ${recipientActorId},
          ${communityId},
          ${contentId},
          0
        )
      `;
      await transaction`
        insert into platform.content_symbols (content_id, symbol_id, position)
        values (${contentId}, ${symbolId}, 1)
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
          'Notification schema fixture',
          'Private UGC that must never enter a notification row.',
          'Private UGC that must never enter a notification row.',
          ${recipientActorId},
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

    await postgres.sql.unsafe(`create role ${quoteRole(runtimeRole)} nologin noinherit`);
    await postgres.sql.unsafe(
      `grant usage on schema platform, system to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant select on table
        platform.notifications,
        system.notification_change_journal,
        system.notification_recipient_sequences
      to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant execute on function
        system.project_notification(uuid, uuid, text, uuid, text, uuid, text[], uuid[], text, text, text, jsonb, text, timestamptz, text),
        system.project_reaction_notification(uuid, uuid, uuid, text, timestamptz, uuid, boolean, timestamptz, bigint),
        system.purge_expired_notifications(integer),
        system.set_notification_read_state(uuid, uuid, boolean),
        system.mark_all_notifications_read(uuid)
      to ${quoteRole(runtimeRole)}`,
    );
  });

  afterAll(async () => {
    try {
      const roleExists = await postgres.sql<{ exists: boolean }[]>`
        select to_regrole(${runtimeRole}) is not null as exists
      `;
      if (roleExists[0]?.exists === true) {
        await postgres.sql.unsafe(`drop owned by ${quoteRole(runtimeRole)}`);
        await postgres.sql.unsafe(`drop role ${quoteRole(runtimeRole)}`);
      }
    } finally {
      await closeDependencies(dependencies);
    }
  });

  it("records migration 000016 and installs the projection, journal, and indexes", async () => {
    const migration = await readFile(
      `${process.cwd()}/db/migrations/000016_notifications_v1.up.sql`,
    );
    const checksum = createHash("sha256").update(migration).digest("hex");
    const ledger = await postgres.sql<
      { checksum: string; name: string; version: string }[]
    >`
      select version, name, checksum
      from system.schema_migrations
      where version = '000016'
    `;
    expect(ledger).toEqual([{ checksum, name: "notifications_v1", version: "000016" }]);

    const shape = await postgres.sql<
      { hardened_functions: number; indexes: number; tables: number; triggers: number }[]
    >`
      select
        (
          select count(*)::integer
          from pg_class
          where oid in (
            'platform.notifications'::regclass,
            'platform.notification_aggregate_actors'::regclass,
            'system.notification_change_journal'::regclass,
            'system.notification_recipient_sequences'::regclass
          )
        ) as tables,
        (
          select count(*)::integer
          from pg_class
          where oid = any(array[
            to_regclass('platform.notifications_recipient_history_idx'),
            to_regclass('platform.notifications_recipient_unread_history_idx'),
            to_regclass('platform.notifications_recipient_type_history_idx'),
            to_regclass('platform.notifications_recipient_occurred_idx'),
            to_regclass('platform.notifications_retention_idx'),
            to_regclass('platform.notifications_symbol_ids_idx'),
            to_regclass('platform.notifications_community_ids_idx'),
            to_regclass('platform.notifications_recipient_follow_history_idx'),
            to_regclass('system.notification_change_journal_notification_idx'),
            to_regclass('platform.notification_aggregate_actors_active_idx')
          ]::oid[])
        ) as indexes,
        (
          select count(*)::integer
          from pg_trigger
          where tgname in (
            'notifications_prepare_write',
            'notifications_append_change_journal',
            'notifications_validate_aggregate_counts',
            'notification_change_journal_prevent_mutation',
            'notification_aggregate_actors_prepare_write',
            'notification_aggregate_actors_validate_counts'
          )
            and not tgisinternal
        ) as triggers,
        (
          select count(*)::integer
          from pg_proc as routine
          join pg_namespace as namespace on namespace.oid = routine.pronamespace
          where namespace.nspname = 'system'
            and routine.oid in (
              to_regprocedure(
                'system.project_notification(uuid,uuid,text,uuid,text,uuid,text[],uuid[],text,text,text,jsonb,text,timestamptz,text)'
              ),
              to_regprocedure(
                'system.project_reaction_notification(uuid,uuid,uuid,text,timestamptz,uuid,boolean,timestamptz,bigint)'
              ),
              to_regprocedure('system.purge_expired_notifications(integer)'),
              to_regprocedure(
                'system.set_notification_read_state(uuid,uuid,boolean)'
              ),
              to_regprocedure('system.mark_all_notifications_read(uuid)')
            )
            and routine.prosecdef
            and 'search_path=pg_catalog' = any(routine.proconfig)
        ) as hardened_functions
    `;
    expect(shape).toEqual([
      { hardened_functions: 5, indexes: 10, tables: 4, triggers: 6 },
    ]);

    const capacities = await postgres.sql<
      {
        additional_follows_40_valid: boolean;
        additional_follows_41_valid: boolean;
        context_symbols_20_valid: boolean;
        context_symbols_21_valid: boolean;
        symbols_20_valid: boolean;
        symbols_21_valid: boolean;
      }[]
    >`
      with boundary as (
        select
          array(
            select 'S' || lpad(value::text, 2, '0')
            from generate_series(1, 20) as value
          )::text[] as symbols_20,
          array(
            select 'S' || lpad(value::text, 2, '0')
            from generate_series(1, 21) as value
          )::text[] as symbols_21,
          to_jsonb(array(
            select 'follow-' || lpad(value::text, 2, '0')
            from generate_series(1, 40) as value
          )) as follows_40,
          to_jsonb(array(
            select 'follow-' || lpad(value::text, 2, '0')
            from generate_series(1, 41) as value
          )) as follows_41
      )
      select
        platform.notification_symbol_ids_are_valid(symbols_20)
          as symbols_20_valid,
        platform.notification_symbol_ids_are_valid(symbols_21)
          as symbols_21_valid,
        platform.notification_context_is_valid(
          jsonb_build_object('symbols', symbols_20)
        ) as context_symbols_20_valid,
        platform.notification_context_is_valid(
          jsonb_build_object('symbols', symbols_21)
        ) as context_symbols_21_valid,
        platform.notification_context_is_valid(jsonb_build_object(
          'matched_follow', jsonb_build_object(
            'target_type', 'actor',
            'target_id', 'actor-1',
            'notification_level', 'all_events'
          ),
          'additional_matched_follow_ids', follows_40
        )) as additional_follows_40_valid,
        platform.notification_context_is_valid(jsonb_build_object(
          'matched_follow', jsonb_build_object(
            'target_type', 'actor',
            'target_id', 'actor-1',
            'notification_level', 'all_events'
          ),
          'additional_matched_follow_ids', follows_41
        )) as additional_follows_41_valid
      from boundary
    `;
    expect(capacities).toEqual([
      {
        additional_follows_40_valid: true,
        additional_follows_41_valid: false,
        context_symbols_20_valid: true,
        context_symbols_21_valid: false,
        symbols_20_valid: true,
        symbols_21_valid: false,
      },
    ]);
  });

  it("projects non-aggregate notifications idempotently without raw table writes", async () => {
    genericNotificationId = randomUUID();
    const dedupeKey = `content.reply:${contentId}:${recipientActorId}`;
    const projected = await runtimeSql<NotificationRow[]>`
      select id, version::integer as version,
        created_sequence::integer as created_sequence,
        change_sequence::integer as change_sequence,
        read_at, updated_at,
        aggregate_distinct_actor_count::integer as aggregate_distinct_actor_count,
        aggregate_agent_count::integer as aggregate_agent_count,
        aggregate_human_count::integer as aggregate_human_count
      from system.project_notification(
        ${genericNotificationId},
        ${recipientActorId},
        'content.reply',
        ${humanTriggerActorId},
        'content',
        ${contentId},
        array[]::text[],
        array[${communityId}]::uuid[],
        null,
        null,
        null,
        jsonb_build_object('root_content_id', ${contentId}::text),
        'notification.content_reply',
        '2026-07-21T11:59:00.000Z'::timestamptz,
        ${dedupeKey}
      )
    `;
    expect(projected[0]).toMatchObject({
      change_sequence: 1,
      created_sequence: 1,
      id: genericNotificationId,
      version: 1,
    });

    const replay = await runtimeSql<NotificationRow[]>`
      select id, version::integer as version,
        created_sequence::integer as created_sequence,
        change_sequence::integer as change_sequence,
        read_at, updated_at,
        aggregate_distinct_actor_count::integer as aggregate_distinct_actor_count,
        aggregate_agent_count::integer as aggregate_agent_count,
        aggregate_human_count::integer as aggregate_human_count
      from system.project_notification(
        ${randomUUID()},
        ${recipientActorId},
        'content.reply',
        ${humanTriggerActorId},
        'content',
        ${contentId},
        array[]::text[],
        array[${communityId}]::uuid[],
        null,
        null,
        null,
        jsonb_build_object('root_content_id', ${contentId}::text),
        'notification.content_reply',
        '2026-07-21T11:59:00.000Z'::timestamptz,
        ${dedupeKey}
      )
    `;
    expect(replay[0]).toMatchObject({
      change_sequence: 1,
      created_sequence: 1,
      id: genericNotificationId,
      version: 1,
    });

    await expect(
      runtimeSql`
        select system.project_notification(
          ${randomUUID()},
          ${recipientActorId},
          'content.reply',
          ${humanTriggerActorId},
          'content',
          ${contentId},
          array[]::text[],
          array[]::uuid[],
          null,
          null,
          null,
          jsonb_build_object('body', 'raw UGC is forbidden'),
          'notification.content_reply',
          '2026-07-21T11:58:00.000Z'::timestamptz,
          ${`content.reply:unsafe:${marker}`}
        )
      `,
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "notifications_context_valid",
    });

    await expect(
      runtimeSql`
        insert into platform.notifications (
          id,
          recipient_actor_id,
          type,
          object_type,
          object_id,
          summary_template_key,
          occurred_at,
          dedupe_key
        )
        values (
          ${randomUUID()},
          ${recipientActorId},
          'content.reply',
          'content',
          ${contentId},
          'notification.content_reply',
          clock_timestamp(),
          ${`content.reply:direct:${marker}`}
        )
      `,
    ).rejects.toMatchObject({ code: "42501" });

    const facts = await postgres.sql<
      { journal_count: number; notification_count: number }[]
    >`
      select
        (
          select count(*)::integer
          from platform.notifications
          where recipient_actor_id = ${recipientActorId}
        ) as notification_count,
        (
          select count(*)::integer
          from system.notification_change_journal
          where recipient_actor_id = ${recipientActorId}
        ) as journal_count
    `;
    expect(facts).toEqual([{ journal_count: 1, notification_count: 1 }]);
  });

  it("orders reaction replay by source sequence, not wall-clock time", async () => {
    reactionNotificationId = randomUUID();
    await expect(
      projectReaction(humanTriggerActorId, true, "2026-07-21T12:00:30.000Z", "0"),
    ).rejects.toMatchObject({ code: "22023" });

    const initial = await projectReaction(
      humanTriggerActorId,
      true,
      "2026-07-21T12:01:00.000Z",
      "100",
      reactionNotificationId,
    );
    expect(initial[0]).toMatchObject({
      aggregate_agent_count: 0,
      aggregate_distinct_actor_count: 1,
      aggregate_human_count: 1,
      change_sequence: 2,
      created_sequence: 2,
      id: reactionNotificationId,
      version: 1,
    });

    const replay = await projectReaction(
      humanTriggerActorId,
      true,
      "2026-07-21T12:02:00.000Z",
      "100",
    );
    expect(replay[0]).toMatchObject({ change_sequence: 2, version: 1 });

    const readResult = await runtimeSql<NotificationRow[]>`
      select id, version::integer as version,
        created_sequence::integer as created_sequence,
        change_sequence::integer as change_sequence,
        read_at, updated_at,
        aggregate_distinct_actor_count::integer as aggregate_distinct_actor_count,
        aggregate_agent_count::integer as aggregate_agent_count,
        aggregate_human_count::integer as aggregate_human_count
      from system.set_notification_read_state(
        ${reactionNotificationId},
        ${recipientActorId},
        true
      )
    `;
    expect(readResult[0]?.read_at).toBeInstanceOf(Date);
    expect(readResult[0]).toMatchObject({ change_sequence: 2, version: 1 });

    const revoked = await projectReaction(
      humanTriggerActorId,
      false,
      "2026-07-21T12:01:00.000Z",
      "101",
    );
    expect(revoked[0]).toMatchObject({
      aggregate_distinct_actor_count: 0,
      change_sequence: 3,
      version: 2,
    });
    expect(revoked[0]?.read_at).toBeInstanceOf(Date);

    const staleRestore = await projectReaction(
      humanTriggerActorId,
      true,
      "2026-07-21T12:09:00.000Z",
      "100",
    );
    expect(staleRestore[0]).toMatchObject({
      aggregate_distinct_actor_count: 0,
      change_sequence: 3,
      version: 2,
    });

    const restored = await projectReaction(
      humanTriggerActorId,
      true,
      "2026-07-21T12:00:30.000Z",
      "102",
    );
    expect(restored[0]).toMatchObject({
      aggregate_distinct_actor_count: 1,
      aggregate_human_count: 1,
      change_sequence: 4,
      version: 3,
    });
    expect(restored[0]?.read_at).toBeInstanceOf(Date);

    const secondActor = await projectReaction(
      agentTriggerActorId,
      true,
      "2026-07-21T12:05:00.000Z",
      "103",
    );
    expect(secondActor[0]).toMatchObject({
      aggregate_agent_count: 1,
      aggregate_distinct_actor_count: 2,
      aggregate_human_count: 1,
      change_sequence: 5,
      read_at: null,
      version: 4,
    });

    const state = await postgres.sql<
      {
        active_members: number;
        journal_sequences: number[];
        journal_versions: number[];
        latest_member_sequences: number[];
        member_count: number;
        sequence_head: number;
      }[]
    >`
      select
        (
          select count(*)::integer
          from platform.notification_aggregate_actors
          where notification_id = ${reactionNotificationId}
        ) as member_count,
        (
          select count(*)::integer
          from platform.notification_aggregate_actors
          where notification_id = ${reactionNotificationId}
            and active
        ) as active_members,
        (
          select array_agg(
            latest_event_sequence::integer
            order by latest_event_sequence
          )
          from platform.notification_aggregate_actors
          where notification_id = ${reactionNotificationId}
        ) as latest_member_sequences,
        (
          select array_agg(change_sequence order by change_sequence)::integer[]
          from system.notification_change_journal
          where recipient_actor_id = ${recipientActorId}
        ) as journal_sequences,
        (
          select array_agg(notification_version order by change_sequence)::integer[]
          from system.notification_change_journal
          where recipient_actor_id = ${recipientActorId}
        ) as journal_versions,
        (
          select last_change_sequence::integer
          from system.notification_recipient_sequences
          where recipient_actor_id = ${recipientActorId}
        ) as sequence_head
    `;
    expect(state).toEqual([
      {
        active_members: 2,
        journal_sequences: [1, 2, 3, 4, 5],
        journal_versions: [1, 1, 2, 3, 4],
        latest_member_sequences: [102, 103],
        member_count: 2,
        sequence_head: 5,
      },
    ]);
  });

  it("marks one recipient inbox read atomically without creating poll changes", async () => {
    const before = await postgres.sql<
      { change_sequence: number; id: string; version: number }[]
    >`
      select id, version::integer as version,
        change_sequence::integer as change_sequence
      from platform.notifications
      where recipient_actor_id = ${recipientActorId}
      order by id
    `;
    const journalBefore = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from system.notification_change_journal
      where recipient_actor_id = ${recipientActorId}
    `;

    const result = await runtimeSql<{ marked_count: number; read_at: Date }[]>`
      select marked_count::integer as marked_count, read_at
      from system.mark_all_notifications_read(${recipientActorId})
    `;
    expect(result).toHaveLength(1);
    expect(result[0]?.marked_count).toBe(2);
    expect(result[0]?.read_at).toBeInstanceOf(Date);

    const after = await postgres.sql<
      { change_sequence: number; id: string; read_at: Date | null; version: number }[]
    >`
      select id, version::integer as version,
        change_sequence::integer as change_sequence, read_at
      from platform.notifications
      where recipient_actor_id = ${recipientActorId}
      order by id
    `;
    expect(
      after.map(({ id, version, change_sequence }) => ({
        change_sequence,
        id,
        version,
      })),
    ).toEqual(before);
    expect(after.every((notification) => notification.read_at instanceof Date)).toBe(
      true,
    );

    const journalAfter = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from system.notification_change_journal
      where recipient_actor_id = ${recipientActorId}
    `;
    expect(journalAfter).toEqual(journalBefore);
  });

  it("keeps revoke and restore membership authoritative across notification windows", async () => {
    const revoked = await projectReaction(
      humanTriggerActorId,
      false,
      "2026-07-21T12:11:00.000Z",
      "104",
    );
    expect(revoked[0]).toMatchObject({
      aggregate_agent_count: 1,
      aggregate_distinct_actor_count: 1,
      aggregate_human_count: 0,
      change_sequence: 6,
      id: reactionNotificationId,
      version: 5,
    });
    expect(revoked[0]?.read_at).toBeInstanceOf(Date);

    const restored = await projectReaction(
      humanTriggerActorId,
      true,
      "2026-07-21T12:21:00.000Z",
      "105",
    );
    expect(restored[0]).toMatchObject({
      aggregate_agent_count: 1,
      aggregate_distinct_actor_count: 2,
      aggregate_human_count: 1,
      change_sequence: 7,
      id: reactionNotificationId,
      version: 6,
    });
    expect(restored[0]?.read_at).toBeInstanceOf(Date);

    const lateNotificationId = randomUUID();
    const late = await projectReaction(
      lateTriggerActorId,
      true,
      "2026-07-21T12:31:00.000Z",
      "106",
      lateNotificationId,
    );
    expect(late[0]).toMatchObject({
      aggregate_agent_count: 0,
      aggregate_distinct_actor_count: 1,
      aggregate_human_count: 1,
      change_sequence: 8,
      created_sequence: 3,
      id: lateNotificationId,
      read_at: null,
      version: 1,
    });

    const state = await postgres.sql<
      {
        change_sequence_head: number;
        created_sequence_head: number;
        human_member_active: boolean;
        human_member_notification_id: string;
        human_member_sequence: number;
        journal_count: number;
        late_members: number;
        original_members: number;
        original_window_end: Date;
        original_window_start: Date;
        reaction_notifications: number;
      }[]
    >`
      select
        (
          select count(*)::integer
          from platform.notifications
          where recipient_actor_id = ${recipientActorId}
            and type = 'reaction.changed'
            and object_id = ${contentId}
        ) as reaction_notifications,
        (
          select count(*)::integer
          from platform.notification_aggregate_actors
          where notification_id = ${reactionNotificationId}
        ) as original_members,
        (
          select count(*)::integer
          from platform.notification_aggregate_actors
          where notification_id = ${lateNotificationId}
        ) as late_members,
        (
          select notification_id
          from platform.notification_aggregate_actors
          where content_id = ${contentId}
            and reaction_type = 'helpful'
            and actor_id = ${humanTriggerActorId}
        ) as human_member_notification_id,
        (
          select active
          from platform.notification_aggregate_actors
          where content_id = ${contentId}
            and reaction_type = 'helpful'
            and actor_id = ${humanTriggerActorId}
        ) as human_member_active,
        (
          select latest_event_sequence::integer
          from platform.notification_aggregate_actors
          where content_id = ${contentId}
            and reaction_type = 'helpful'
            and actor_id = ${humanTriggerActorId}
        ) as human_member_sequence,
        (
          select (context ->> 'reaction_window_started_at')::timestamptz
          from platform.notifications
          where id = ${reactionNotificationId}
        ) as original_window_start,
        (
          select (context ->> 'reaction_window_ends_at')::timestamptz
          from platform.notifications
          where id = ${reactionNotificationId}
        ) as original_window_end,
        (
          select last_created_sequence::integer
          from system.notification_recipient_sequences
          where recipient_actor_id = ${recipientActorId}
        ) as created_sequence_head,
        (
          select last_change_sequence::integer
          from system.notification_recipient_sequences
          where recipient_actor_id = ${recipientActorId}
        ) as change_sequence_head,
        (
          select count(*)::integer
          from system.notification_change_journal
          where recipient_actor_id = ${recipientActorId}
        ) as journal_count
    `;
    expect(state).toEqual([
      {
        change_sequence_head: 8,
        created_sequence_head: 3,
        human_member_active: true,
        human_member_notification_id: reactionNotificationId,
        human_member_sequence: 105,
        journal_count: 8,
        late_members: 1,
        original_members: 2,
        original_window_end: new Date("2026-07-21T12:10:00.000Z"),
        original_window_start: new Date("2026-07-21T12:00:00.000Z"),
        reaction_notifications: 2,
      },
    ]);
  });

  it("serializes authoritative membership creation and stays deadlock-free with retention", async () => {
    const candidateIds = [randomUUID(), randomUUID()] as const;
    const concurrentResults = await Promise.all(
      candidateIds.map((candidateId) =>
        projectReaction(
          concurrentTriggerActorId,
          true,
          "2026-07-21T12:41:00.000Z",
          "107",
          candidateId,
        ),
      ),
    );
    const projectedIds = concurrentResults.flatMap((rows) => rows.map((row) => row.id));
    expect(new Set(projectedIds).size).toBe(1);
    expect(candidateIds).toContain(projectedIds[0]);
    expect(concurrentResults.map((rows) => rows[0]?.change_sequence)).toEqual([9, 9]);
    expect(concurrentResults.map((rows) => rows[0]?.created_sequence)).toEqual([4, 4]);

    const concurrentNotificationId = requireId(
      projectedIds[0],
      "concurrent reaction notification",
    );
    const authoritativeRows = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.notification_aggregate_actors
      where content_id = ${contentId}
        and reaction_type = 'helpful'
        and actor_id = ${concurrentTriggerActorId}
    `;
    expect(authoritativeRows).toEqual([{ count: 1 }]);

    await postgres.sql.unsafe(
      "alter table platform.notifications disable trigger notifications_prepare_write",
    );
    try {
      await postgres.sql`
        update platform.notifications
        set created_at = date_trunc(
          'milliseconds',
          statement_timestamp() - interval '91 days'
        )
        where id = ${concurrentNotificationId}
      `;
    } finally {
      await postgres.sql.unsafe(
        "alter table platform.notifications enable trigger notifications_prepare_write",
      );
    }

    // Both paths lock the parent notification before its aggregate member.
    // SKIP LOCKED permits the purge to yield when projection wins the race.
    const [replay, racedPurge] = await Promise.all([
      projectReaction(concurrentTriggerActorId, false, "2026-07-21T12:51:00.000Z", "107"),
      runtimeSql<{ purged_count: number }[]>`
        select system.purge_expired_notifications(1)::integer as purged_count
      `,
    ]);
    expect([0, 1]).toContain(replay.length);
    const cleanupPurge = await runtimeSql<{ purged_count: number }[]>`
      select system.purge_expired_notifications(1)::integer as purged_count
    `;
    expect(
      (racedPurge[0]?.purged_count ?? 0) + (cleanupPurge[0]?.purged_count ?? 0),
    ).toBe(1);

    const retained = await postgres.sql<
      { journal_count: number; member_count: number; notification_count: number }[]
    >`
      select
        (
          select count(*)::integer
          from platform.notifications
          where id = ${concurrentNotificationId}
        ) as notification_count,
        (
          select count(*)::integer
          from platform.notification_aggregate_actors
          where content_id = ${contentId}
            and reaction_type = 'helpful'
            and actor_id = ${concurrentTriggerActorId}
        ) as member_count,
        (
          select count(*)::integer
          from system.notification_change_journal
          where notification_id = ${concurrentNotificationId}
        ) as journal_count
    `;
    expect(retained).toEqual([
      { journal_count: 0, member_count: 0, notification_count: 0 },
    ]);
  });

  it("purges only notifications older than 90 days through a bounded runtime entry point", async () => {
    const freshProbe = await runtimeSql<{ purged_count: number }[]>`
      select system.purge_expired_notifications(10)::integer as purged_count
    `;
    expect(freshProbe).toEqual([{ purged_count: 0 }]);

    await expect(
      runtimeSql`
        delete from system.notification_change_journal
        where recipient_actor_id = ${recipientActorId}
      `,
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      postgres.sql`
        delete from system.notification_change_journal
        where recipient_actor_id = ${recipientActorId}
      `,
    ).rejects.toMatchObject({ code: "55000" });

    await expect(
      runtimeSql`select system.purge_expired_notifications(0)`,
    ).rejects.toMatchObject({ code: "22023" });

    await postgres.sql.unsafe(
      "alter table platform.notifications disable trigger notifications_prepare_write",
    );
    try {
      await postgres.sql`
        update platform.notifications
        set created_at = date_trunc(
          'milliseconds',
          statement_timestamp() - interval '91 days'
        )
        where recipient_actor_id = ${recipientActorId}
      `;
    } finally {
      await postgres.sql.unsafe(
        "alter table platform.notifications enable trigger notifications_prepare_write",
      );
    }

    const firstBatch = await runtimeSql<{ purged_count: number }[]>`
      select system.purge_expired_notifications(1)::integer as purged_count
    `;
    const secondBatch = await runtimeSql<{ purged_count: number }[]>`
      select system.purge_expired_notifications(10)::integer as purged_count
    `;
    const exhausted = await runtimeSql<{ purged_count: number }[]>`
      select system.purge_expired_notifications(10)::integer as purged_count
    `;
    expect(firstBatch).toEqual([{ purged_count: 1 }]);
    expect(secondBatch).toEqual([{ purged_count: 2 }]);
    expect(exhausted).toEqual([{ purged_count: 0 }]);

    const retained = await postgres.sql<
      {
        aggregate_members: number;
        content_items: number;
        journal_rows: number;
        notification_rows: number;
        sequence_head: number;
      }[]
    >`
      select
        (
          select count(*)::integer
          from platform.notifications
          where recipient_actor_id = ${recipientActorId}
        ) as notification_rows,
        (
          select count(*)::integer
          from system.notification_change_journal
          where recipient_actor_id = ${recipientActorId}
        ) as journal_rows,
        (
          select count(*)::integer
          from platform.notification_aggregate_actors
          where content_id = ${contentId}
        ) as aggregate_members,
        (
          select count(*)::integer
          from platform.content_items
          where id = ${contentId}
        ) as content_items,
        (
          select last_change_sequence::integer
          from system.notification_recipient_sequences
          where recipient_actor_id = ${recipientActorId}
        ) as sequence_head
    `;
    expect(retained).toEqual([
      {
        aggregate_members: 0,
        content_items: 1,
        journal_rows: 0,
        notification_rows: 0,
        sequence_head: 9,
      },
    ]);
  });
});
