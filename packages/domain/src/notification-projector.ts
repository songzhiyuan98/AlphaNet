import { randomUUID } from "node:crypto";

import type { OutboxEvent, PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

export const NOTIFICATION_OUTBOX_EVENT_TYPES = [
  "content.published",
  "content.reply",
  "content.revised",
  "reaction.changed",
  "follow.changed",
  "content.moderation_changed",
  "action.pending_approval",
  "action.resolved",
] as const;

export type NotificationOutboxEventType =
  (typeof NOTIFICATION_OUTBOX_EVENT_TYPES)[number];

export interface NotificationProjectionResult {
  accepted: boolean;
  projected: number;
  sourceEventId: string;
}

export interface NotificationProjector {
  checkReady(): Promise<void>;
  project(event: OutboxEvent): Promise<NotificationProjectionResult>;
}

type TransactionSql = postgres.TransactionSql;

type NotificationType =
  | "content.published"
  | "content.reply"
  | "content.mention"
  | "reaction.changed"
  | "follow.started"
  | "content.revised"
  | "moderation.changed"
  | "action.pending_approval"
  | "action.resolved";

type FollowTargetType = "actor" | "symbol" | "topic" | "content";
type FollowNotificationLevel = "new_posts" | "all_events";

interface ContentFactRow {
  author_actor_id: string;
  community_ids: string[];
  content_id: string;
  current_revision_id: string;
  distribution_state: string;
  kind: string;
  lifecycle_state: string;
  parent_author_actor_id: string | null;
  parent_id: string | null;
  root_id: string;
  symbol_ids: string[];
  symbols: string[];
  topic_ids: string[];
  topic_slugs: string[];
}

interface ClassificationValueRow {
  id: string;
  value: string;
}

interface FollowMatchRow {
  follow_id: string;
  follower_actor_id: string;
  notification_level: string;
  target_id: string;
  target_type: string;
}

interface PendingActionRecipientRow {
  actor_id: string;
}

interface ProjectedRow {
  id: string;
}

interface ReactionProjectedRow {
  id: string;
}

interface NotificationCandidate {
  communityIds: string[];
  context: Record<string, unknown>;
  dedupeKey: string;
  matchedFollow: FollowMatch | null;
  objectId: string;
  objectType: "actor" | "content" | "pending_action";
  occurredAt: Date;
  recipientActorId: string;
  summaryTemplateKey: string;
  symbolIds: string[];
  triggerActorId: string | null;
  type: Exclude<NotificationType, "reaction.changed">;
}

interface FollowMatch {
  followId: string;
  notificationLevel: FollowNotificationLevel;
  targetId: string;
  targetType: FollowTargetType;
}

interface RecipientMatch {
  matches: FollowMatch[];
  recipientActorId: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REACTION_TYPES = new Set(["agree", "disagree", "helpful"]);
const MAX_NOTIFICATION_COMMUNITIES = 5;
const MAX_NOTIFICATION_FOLLOW_CONTEXT_IDS = 40;
const MAX_NOTIFICATION_SYMBOLS = 20;
const MAX_NOTIFICATION_TOPICS = 10;
const ACTION_STATES = new Set([
  "succeeded",
  "rejected",
  "expired",
  "failed",
  "invalidated",
  "cancelled",
]);
const CONTENT_CHANGE_GROUPS = new Set([
  "title",
  "body_markdown",
  "source_links",
  "references",
  "additional_community_ids",
  "symbols",
  "topics",
]);
const RESEARCH_REVISION_CHANGE_GROUPS = new Set([
  "title",
  "body_markdown",
  "source_links",
  "references",
]);
const FOLLOW_PRIORITY: Record<FollowTargetType, number> = {
  content: 0,
  actor: 1,
  symbol: 2,
  topic: 3,
};

const SUMMARY_TEMPLATE_KEYS: Record<NotificationType, string> = {
  "content.published": "notification.content_published",
  "content.reply": "notification.content_reply",
  "content.mention": "notification.content_mention",
  "reaction.changed": "notification.reaction_changed",
  "follow.started": "notification.follow_started",
  "content.revised": "notification.content_revised",
  "moderation.changed": "notification.moderation_changed",
  "action.pending_approval": "notification.action_pending_approval",
  "action.resolved": "notification.action_resolved",
};

function requiredString(
  payload: Record<string, unknown>,
  name: string,
  maximum = 200,
): string {
  const value = payload[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw new NotificationProjectionError(
      "NOTIFICATION_EVENT_INVALID",
      `Notification source event field ${name} is invalid.`,
    );
  }
  return value;
}

function requiredUuid(payload: Record<string, unknown>, name: string): string {
  const value = requiredString(payload, name, 36).toLowerCase();
  if (!UUID_PATTERN.test(value)) {
    throw new NotificationProjectionError(
      "NOTIFICATION_EVENT_INVALID",
      `Notification source event field ${name} must be a UUID.`,
    );
  }
  return value;
}

function optionalUuid(payload: Record<string, unknown>, name: string): string | null {
  const value = payload[name];
  if (value === null || value === undefined) return null;
  return requiredUuid(payload, name);
}

function requiredBoolean(payload: Record<string, unknown>, name: string): boolean {
  const value = payload[name];
  if (typeof value !== "boolean") {
    throw new NotificationProjectionError(
      "NOTIFICATION_EVENT_INVALID",
      `Notification source event field ${name} must be boolean.`,
    );
  }
  return value;
}

function stringArray(payload: Record<string, unknown>, name: string): string[] {
  const value = payload[name];
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    !value.every(
      (entry): entry is string =>
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= 200 &&
        entry === entry.trim() &&
        !entry.includes("\0"),
    )
  ) {
    throw new NotificationProjectionError(
      "NOTIFICATION_EVENT_INVALID",
      `Notification source event field ${name} is invalid.`,
    );
  }
  return [...new Set(value)];
}

function optionalUuidArray(
  payload: Record<string, unknown>,
  name: string,
  maximum: number,
): string[] | null {
  const value = payload[name];
  if (value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    !value.every(
      (entry: unknown): entry is string =>
        typeof entry === "string" && UUID_PATTERN.test(entry),
    )
  ) {
    throw new NotificationProjectionError(
      "NOTIFICATION_EVENT_INVALID",
      `Notification source event field ${name} is invalid.`,
    );
  }
  const normalized = sortedUnique(value.map((entry) => entry.toLowerCase()));
  if (normalized.length !== value.length) {
    throw new NotificationProjectionError(
      "NOTIFICATION_EVENT_INVALID",
      `Notification source event field ${name} contains duplicates.`,
    );
  }
  return normalized;
}

function copyDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new NotificationProjectionError(
      "NOTIFICATION_EVENT_INVALID",
      `${name} is invalid.`,
    );
  }
  return new Date(value.valueOf());
}

function isSupportedEventType(value: string): value is NotificationOutboxEventType {
  return (NOTIFICATION_OUTBOX_EVENT_TYPES as readonly string[]).includes(value);
}

function isFollowTargetType(value: string): value is FollowTargetType {
  return (
    value === "actor" || value === "symbol" || value === "topic" || value === "content"
  );
}

function isFollowNotificationLevel(value: string): value is FollowNotificationLevel {
  return value === "new_posts" || value === "all_events";
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function boundedSortedUnique(
  values: readonly string[],
  maximum: number,
  field: string,
): string[] {
  const normalized = sortedUnique(values);
  if (normalized.length > maximum) {
    throw new NotificationProjectionError(
      "NOTIFICATION_EVENT_INVALID",
      `Notification ${field} exceeds the supported projection capacity.`,
    );
  }
  return normalized;
}

function stableFollowMatches(matches: readonly FollowMatch[]): FollowMatch[] {
  return [...matches].sort((left, right) => {
    const priority =
      (FOLLOW_PRIORITY[left.targetType] ?? 99) -
      (FOLLOW_PRIORITY[right.targetType] ?? 99);
    if (priority !== 0) return priority;
    const target = left.targetId.localeCompare(right.targetId);
    return target !== 0 ? target : left.followId.localeCompare(right.followId);
  });
}

function revisionIsMaterialToFollow(
  match: FollowMatch,
  changedGroups: ReadonlySet<string>,
): boolean {
  if (match.targetType === "actor" || match.targetType === "content") return true;
  if ([...RESEARCH_REVISION_CHANGE_GROUPS].some((group) => changedGroups.has(group))) {
    return true;
  }
  return match.targetType === "symbol"
    ? changedGroups.has("symbols")
    : changedGroups.has("topics");
}

function eventContext(
  content: ContentFactRow,
  options: {
    revisionId?: string | null | undefined;
  } = {},
): Record<string, unknown> {
  const context: Record<string, unknown> = {
    community_ids: boundedSortedUnique(
      content.community_ids,
      MAX_NOTIFICATION_COMMUNITIES,
      "community_ids",
    ),
    root_content_id: content.root_id,
    symbols: boundedSortedUnique(content.symbols, MAX_NOTIFICATION_SYMBOLS, "symbols"),
  };
  if (content.parent_id) context.parent_content_id = content.parent_id;
  if (options.revisionId) context.revision_id = options.revisionId;
  return context;
}

function withFollowContext(
  context: Record<string, unknown>,
  matches: readonly FollowMatch[],
): { context: Record<string, unknown>; matchedFollow: FollowMatch | null } {
  const sorted = stableFollowMatches(matches);
  const primary = sorted[0] ?? null;
  if (!primary) return { context, matchedFollow: null };
  if (sorted.length - 1 > MAX_NOTIFICATION_FOLLOW_CONTEXT_IDS) {
    throw new NotificationProjectionError(
      "NOTIFICATION_EVENT_INVALID",
      "Notification Follow matches exceed the supported projection capacity.",
    );
  }
  return {
    context: {
      ...context,
      matched_follow: {
        notification_level: primary.notificationLevel,
        target_id: primary.targetId,
        target_type: primary.targetType,
      },
      ...(sorted.length > 1
        ? {
            additional_matched_follow_ids: sorted.slice(1).map((match) => match.followId),
          }
        : {}),
    },
    matchedFollow: primary,
  };
}

function candidateForContent(options: {
  content: ContentFactRow;
  event: OutboxEvent;
  matches?: readonly FollowMatch[] | undefined;
  recipientActorId: string;
  revisionId?: string | null | undefined;
  triggerActorId: string | null;
  type: "content.mention" | "content.published" | "content.reply" | "content.revised";
}): NotificationCandidate {
  const contextualized = withFollowContext(
    eventContext(options.content, {
      revisionId: options.revisionId,
    }),
    options.matches ?? [],
  );
  return {
    communityIds: boundedSortedUnique(
      options.content.community_ids,
      MAX_NOTIFICATION_COMMUNITIES,
      "community_ids",
    ),
    context: contextualized.context,
    dedupeKey: `${options.type}:${options.event.id}:${options.recipientActorId}`,
    matchedFollow: contextualized.matchedFollow,
    objectId: options.content.content_id,
    objectType: "content",
    occurredAt: copyDate(options.event.occurredAt, "Outbox event occurredAt"),
    recipientActorId: options.recipientActorId,
    summaryTemplateKey: SUMMARY_TEMPLATE_KEYS[options.type],
    symbolIds: boundedSortedUnique(
      options.content.symbols,
      MAX_NOTIFICATION_SYMBOLS,
      "symbols",
    ),
    triggerActorId: options.triggerActorId,
    type: options.type,
  };
}

interface ContentRecipientAccumulator {
  directReply: boolean;
  followMatches: Map<string, FollowMatch>;
  mentioned: boolean;
}

function candidatesForContentEvent(options: {
  content: ContentFactRow;
  directReplyRecipientActorId?: string | null | undefined;
  event: OutboxEvent;
  followNotificationType: "content.published" | "content.reply" | "content.revised";
  follows: readonly RecipientMatch[];
  mentions: readonly string[];
  revisionId?: string | null | undefined;
  triggerActorId: string;
}): NotificationCandidate[] {
  const recipients = new Map<string, ContentRecipientAccumulator>();
  const recipient = (recipientActorId: string): ContentRecipientAccumulator | null => {
    if (recipientActorId === options.triggerActorId) return null;
    const existing = recipients.get(recipientActorId);
    if (existing) return existing;
    const created: ContentRecipientAccumulator = {
      directReply: false,
      followMatches: new Map(),
      mentioned: false,
    };
    recipients.set(recipientActorId, created);
    return created;
  };

  for (const follow of options.follows) {
    const accumulated = recipient(follow.recipientActorId);
    if (!accumulated) continue;
    for (const match of follow.matches) {
      accumulated.followMatches.set(match.followId, match);
    }
  }
  for (const recipientActorId of options.mentions) {
    const accumulated = recipient(recipientActorId);
    if (accumulated) accumulated.mentioned = true;
  }
  if (options.directReplyRecipientActorId) {
    const accumulated = recipient(options.directReplyRecipientActorId);
    if (accumulated) accumulated.directReply = true;
  }

  return [...recipients.entries()].map(([recipientActorId, accumulated]) => {
    const type = accumulated.directReply
      ? "content.reply"
      : accumulated.mentioned
        ? "content.mention"
        : options.followNotificationType;
    return candidateForContent({
      content: options.content,
      event: options.event,
      matches: [...accumulated.followMatches.values()],
      recipientActorId,
      revisionId: options.revisionId,
      triggerActorId: options.triggerActorId,
      type,
    });
  });
}

export type NotificationProjectionErrorCode =
  | "NOTIFICATION_EVENT_INVALID"
  | "NOTIFICATION_PROJECTION_NOT_READY"
  | "NOTIFICATION_SOURCE_NOT_FOUND";

export class NotificationProjectionError extends Error {
  readonly code: NotificationProjectionErrorCode;

  constructor(code: NotificationProjectionErrorCode, message: string) {
    super(message);
    this.name = "NotificationProjectionError";
    this.code = code;
  }
}

export class PostgresNotificationProjector implements NotificationProjector {
  constructor(private readonly sql: PostgresClient) {}

  async checkReady(): Promise<void> {
    const rows = await this.sql<{ ready: boolean }[]>`
      select
        to_regclass('platform.notifications') is not null
        and to_regclass('platform.notification_aggregate_actors') is not null
        and to_regclass('system.notification_change_journal') is not null
        and to_regprocedure(
          'system.project_notification(uuid,uuid,text,uuid,text,uuid,text[],uuid[],text,text,text,jsonb,text,timestamp with time zone,text)'
        ) is not null
        and to_regprocedure(
          'system.project_reaction_notification(uuid,uuid,uuid,text,timestamp with time zone,uuid,boolean,timestamp with time zone,bigint)'
        ) is not null as ready
    `;
    if (rows.length !== 1 || rows[0]?.ready !== true) {
      throw new NotificationProjectionError(
        "NOTIFICATION_PROJECTION_NOT_READY",
        "The notification projection schema is not ready.",
      );
    }
  }

  async project(event: OutboxEvent): Promise<NotificationProjectionResult> {
    if (!isSupportedEventType(event.eventType) || event.eventVersion !== 1) {
      throw new NotificationProjectionError(
        "NOTIFICATION_EVENT_INVALID",
        "The Outbox event is not supported by Notifications v1.",
      );
    }

    const projected = await this.sql.begin(async (transaction) => {
      switch (event.eventType) {
        case "content.published":
          return this.#projectContentPublished(transaction, event);
        case "content.reply":
          return this.#projectContentReply(transaction, event);
        case "content.revised":
          return this.#projectContentRevised(transaction, event);
        case "reaction.changed":
          return this.#projectReaction(transaction, event);
        case "follow.changed":
          return this.#projectFollow(transaction, event);
        case "content.moderation_changed":
          return this.#projectModeration(transaction, event);
        case "action.pending_approval":
          return this.#projectAction(transaction, event, "action.pending_approval");
        case "action.resolved":
          return this.#projectAction(transaction, event, "action.resolved");
        default:
          throw new NotificationProjectionError(
            "NOTIFICATION_EVENT_INVALID",
            "The Outbox event is not supported by Notifications v1.",
          );
      }
    });

    return { accepted: true, projected, sourceEventId: event.id };
  }

  async #contentFact(
    transaction: TransactionSql,
    contentId: string,
  ): Promise<ContentFactRow> {
    const rows = await transaction<ContentFactRow[]>`
      select
        content.id::text as content_id,
        content.kind,
        content.author_actor_id::text as author_actor_id,
        content.parent_id::text as parent_id,
        parent.author_actor_id::text as parent_author_actor_id,
        content.root_id::text as root_id,
        content.current_revision_id::text as current_revision_id,
        content.lifecycle_state,
        content.distribution_state,
        coalesce((
          select array_agg(distinct symbol.id::text order by symbol.id::text)
          from platform.content_symbols as content_symbol
          join platform.symbols as symbol on symbol.id = content_symbol.symbol_id
          where content_symbol.content_id in (content.id, content.root_id)
        ), array[]::text[]) as symbol_ids,
        coalesce((
          select array_agg(distinct symbol.ticker::text order by symbol.ticker::text)
          from platform.content_symbols as content_symbol
          join platform.symbols as symbol on symbol.id = content_symbol.symbol_id
          where content_symbol.content_id in (content.id, content.root_id)
        ), array[]::text[]) as symbols,
        coalesce((
          select array_agg(distinct topic.id::text order by topic.id::text)
          from platform.content_topics as content_topic
          join platform.topics as topic on topic.id = content_topic.topic_id
          where content_topic.content_id in (content.id, content.root_id)
        ), array[]::text[]) as topic_ids,
        coalesce((
          select array_agg(distinct topic.slug::text order by topic.slug::text)
          from platform.content_topics as content_topic
          join platform.topics as topic on topic.id = content_topic.topic_id
          where content_topic.content_id in (content.id, content.root_id)
        ), array[]::text[]) as topic_slugs,
        coalesce((
          select array_agg(community_id::text order by community_id::text)
          from (
            select root.primary_community_id as community_id
            union
            select additional.community_id
            from platform.content_additional_communities as additional
            where additional.content_id = root.id
          ) as communities
          where community_id is not null
        ), array[]::text[]) as community_ids
      from platform.content_items as content
      join platform.content_items as root on root.id = content.root_id
      left join platform.content_items as parent on parent.id = content.parent_id
      where content.id = ${contentId}
      limit 1
      for share of content, root
    `;
    const row = rows[0];
    if (
      !row ||
      !UUID_PATTERN.test(row.content_id) ||
      !UUID_PATTERN.test(row.author_actor_id)
    ) {
      throw new NotificationProjectionError(
        "NOTIFICATION_SOURCE_NOT_FOUND",
        "The source ContentItem is unavailable for notification projection.",
      );
    }
    return row;
  }

  async #contentFactForEvent(
    transaction: TransactionSql,
    event: OutboxEvent,
    content: ContentFactRow,
    required: boolean,
  ): Promise<ContentFactRow> {
    const communityIds = optionalUuidArray(
      event.payload,
      "community_ids",
      MAX_NOTIFICATION_COMMUNITIES,
    );
    const symbolIds = optionalUuidArray(
      event.payload,
      "symbol_ids",
      MAX_NOTIFICATION_SYMBOLS,
    );
    const topicIds = optionalUuidArray(
      event.payload,
      "topic_ids",
      MAX_NOTIFICATION_TOPICS,
    );
    const presentCount = [communityIds, symbolIds, topicIds].filter(
      (value) => value !== null,
    ).length;
    if (presentCount === 0 && !required) return content;
    if (presentCount !== 3) {
      throw new NotificationProjectionError(
        "NOTIFICATION_EVENT_INVALID",
        "Notification source classifications must be complete.",
      );
    }

    const [symbolRows, topicRows] = await Promise.all([
      transaction<ClassificationValueRow[]>`
        select symbol.id::text as id, symbol.ticker::text as value
        from platform.symbols as symbol
        where symbol.id = any(${transaction.array(symbolIds!)}::uuid[])
        order by symbol.id
      `,
      transaction<ClassificationValueRow[]>`
        select topic.id::text as id, topic.slug::text as value
        from platform.topics as topic
        where topic.id = any(${transaction.array(topicIds!)}::uuid[])
        order by topic.id
      `,
    ]);
    if (
      symbolRows.length !== symbolIds!.length ||
      topicRows.length !== topicIds!.length ||
      symbolRows.some(
        (row) => !UUID_PATTERN.test(row.id) || typeof row.value !== "string",
      ) ||
      topicRows.some((row) => !UUID_PATTERN.test(row.id) || typeof row.value !== "string")
    ) {
      throw new NotificationProjectionError(
        "NOTIFICATION_SOURCE_NOT_FOUND",
        "Notification source classifications are unavailable.",
      );
    }
    return {
      ...content,
      community_ids: communityIds!,
      symbol_ids: symbolIds!,
      symbols: symbolRows.map((row) => row.value),
      topic_ids: topicIds!,
      topic_slugs: topicRows.map((row) => row.value),
    };
  }

  async #mentionRecipients(
    transaction: TransactionSql,
    revisionId: string | null,
    triggerActorId: string,
  ): Promise<string[]> {
    if (!revisionId) return [];
    const rows = await transaction<{ actor_id: string }[]>`
      select mention.mentioned_actor_id::text as actor_id
      from platform.mentions as mention
      join platform.actors as actor on actor.id = mention.mentioned_actor_id
      where mention.revision_id = ${revisionId}
        and mention.mentioned_actor_id <> ${triggerActorId}
        and actor.status in ('active', 'restricted')
        and actor.deleted_at is null
      order by mention.position, mention.mentioned_actor_id
    `;
    return sortedUnique(rows.map((row) => row.actor_id));
  }

  async #followMatches(
    transaction: TransactionSql,
    options: {
      actorId: string;
      changedGroups?: ReadonlySet<string> | undefined;
      content: ContentFactRow;
      eventKind: "published" | "reply" | "revised" | "moderation";
    },
  ): Promise<RecipientMatch[]> {
    const actorLevels =
      options.eventKind === "published"
        ? (["new_posts", "all_events"] as const)
        : options.eventKind === "moderation"
          ? ([] as const)
          : (["all_events"] as const);
    const classificationLevels =
      options.eventKind === "published"
        ? (["new_posts", "all_events"] as const)
        : options.eventKind === "moderation"
          ? ([] as const)
          : (["all_events"] as const);
    const contentLevels =
      options.eventKind === "reply"
        ? (["new_posts", "all_events"] as const)
        : options.eventKind === "revised" || options.eventKind === "moderation"
          ? (["all_events"] as const)
          : ([] as const);
    const contentTargetIds = sortedUnique(
      [
        options.content.root_id,
        options.content.parent_id,
        options.content.content_id,
      ].filter((value): value is string => value !== null),
    );

    const rows = await transaction<FollowMatchRow[]>`
      select
        follow.id::text as follow_id,
        follow.follower_actor_id::text as follower_actor_id,
        follow.target_type,
        follow.notification_level,
        case follow.target_type
          when 'actor' then follow.target_actor_id::text
          when 'symbol' then symbol.ticker::text
          when 'topic' then topic.slug::text
          when 'content' then follow.target_content_id::text
        end as target_id
      from platform.follows as follow
      join platform.actors as follower on follower.id = follow.follower_actor_id
      left join platform.symbols as symbol on symbol.id = follow.target_symbol_id
      left join platform.topics as topic on topic.id = follow.target_topic_id
      where follow.follower_actor_id <> ${options.actorId}
        and follower.status in ('active', 'restricted')
        and follower.deleted_at is null
        and (
          (
            follow.target_type = 'actor'
            and follow.target_actor_id = ${options.actorId}
            and follow.notification_level = any(${transaction.array([...actorLevels])}::text[])
          )
          or (
            follow.target_type = 'symbol'
            and follow.target_symbol_id = any(${transaction.array(options.content.symbol_ids)}::uuid[])
            and follow.notification_level = any(${transaction.array([...classificationLevels])}::text[])
          )
          or (
            follow.target_type = 'topic'
            and follow.target_topic_id = any(${transaction.array(options.content.topic_ids)}::uuid[])
            and follow.notification_level = any(${transaction.array([...classificationLevels])}::text[])
          )
          or (
            follow.target_type = 'content'
            and follow.target_content_id = any(${transaction.array(contentTargetIds)}::uuid[])
            and follow.notification_level = any(${transaction.array([...contentLevels])}::text[])
          )
        )
      order by follow.follower_actor_id, follow.target_type, target_id, follow.id
    `;

    const grouped = new Map<string, FollowMatch[]>();
    for (const row of rows) {
      if (
        !UUID_PATTERN.test(row.follow_id) ||
        !UUID_PATTERN.test(row.follower_actor_id) ||
        !isFollowTargetType(row.target_type) ||
        !isFollowNotificationLevel(row.notification_level) ||
        typeof row.target_id !== "string" ||
        row.target_id.length === 0
      ) {
        throw new NotificationProjectionError(
          "NOTIFICATION_EVENT_INVALID",
          "A Follow match could not be projected safely.",
        );
      }
      const matches = grouped.get(row.follower_actor_id) ?? [];
      const match: FollowMatch = {
        followId: row.follow_id,
        notificationLevel: row.notification_level,
        targetId: row.target_id,
        targetType: row.target_type,
      };
      if (
        options.eventKind === "revised" &&
        options.changedGroups &&
        !revisionIsMaterialToFollow(match, options.changedGroups)
      ) {
        continue;
      }
      matches.push(match);
      grouped.set(row.follower_actor_id, matches);
    }
    return [...grouped.entries()].map(([recipientActorId, matches]) => ({
      matches: stableFollowMatches(matches),
      recipientActorId,
    }));
  }

  async #projectCandidate(
    transaction: TransactionSql,
    candidate: NotificationCandidate,
  ): Promise<number> {
    const matched = candidate.matchedFollow;
    const rows = await transaction<ProjectedRow[]>`
      select projected.id::text as id
      from system.project_notification(
        ${randomUUID()}::uuid,
        ${candidate.recipientActorId}::uuid,
        ${candidate.type}::text,
        ${candidate.triggerActorId}::uuid,
        ${candidate.objectType}::text,
        ${candidate.objectId}::uuid,
        ${transaction.array(candidate.symbolIds)}::text[],
        ${transaction.array(candidate.communityIds)}::uuid[],
        ${matched?.targetType ?? null}::text,
        ${matched?.targetId ?? null}::text,
        ${matched?.notificationLevel ?? null}::text,
        ${transaction.json(candidate.context as postgres.JSONValue)}::jsonb,
        ${candidate.summaryTemplateKey}::text,
        ${candidate.occurredAt}::timestamptz,
        ${candidate.dedupeKey}::text
      ) as projected
    `;
    return rows.length === 1 ? 1 : 0;
  }

  async #projectCandidates(
    transaction: TransactionSql,
    candidates: readonly NotificationCandidate[],
  ): Promise<number> {
    let projected = 0;
    const orderedCandidates = [...candidates].sort((left, right) => {
      const recipient = left.recipientActorId.localeCompare(right.recipientActorId);
      return recipient !== 0 ? recipient : left.dedupeKey.localeCompare(right.dedupeKey);
    });
    for (const candidate of orderedCandidates) {
      projected += await this.#projectCandidate(transaction, candidate);
    }
    return projected;
  }

  async #projectContentPublished(
    transaction: TransactionSql,
    event: OutboxEvent,
  ): Promise<number> {
    const contentId = requiredUuid(event.payload, "content_id");
    const actorId = requiredUuid(event.payload, "actor_id");
    const revisionId = optionalUuid(event.payload, "revision_id");
    const content = await this.#contentFactForEvent(
      transaction,
      event,
      await this.#contentFact(transaction, contentId),
      true,
    );
    if (content.kind !== "post" || content.author_actor_id !== actorId) {
      throw new NotificationProjectionError(
        "NOTIFICATION_EVENT_INVALID",
        "The content.published event does not match its ContentItem.",
      );
    }

    const [follows, mentions] = await Promise.all([
      this.#followMatches(transaction, { actorId, content, eventKind: "published" }),
      this.#mentionRecipients(transaction, revisionId, actorId),
    ]);
    return this.#projectCandidates(
      transaction,
      candidatesForContentEvent({
        content,
        event,
        followNotificationType: "content.published",
        follows,
        mentions,
        revisionId,
        triggerActorId: actorId,
      }),
    );
  }

  async #projectContentReply(
    transaction: TransactionSql,
    event: OutboxEvent,
  ): Promise<number> {
    const contentId = requiredUuid(event.payload, "content_id");
    const actorId = requiredUuid(event.payload, "actor_id");
    const revisionId = optionalUuid(event.payload, "revision_id");
    const content = await this.#contentFactForEvent(
      transaction,
      event,
      await this.#contentFact(transaction, contentId),
      true,
    );
    if (
      content.kind !== "reply" ||
      content.author_actor_id !== actorId ||
      !content.parent_id ||
      !content.parent_author_actor_id
    ) {
      throw new NotificationProjectionError(
        "NOTIFICATION_EVENT_INVALID",
        "The content.reply event does not match its ContentItem.",
      );
    }

    const [follows, mentions] = await Promise.all([
      this.#followMatches(transaction, { actorId, content, eventKind: "reply" }),
      this.#mentionRecipients(transaction, revisionId, actorId),
    ]);
    return this.#projectCandidates(
      transaction,
      candidatesForContentEvent({
        content,
        directReplyRecipientActorId: content.parent_author_actor_id,
        event,
        followNotificationType: "content.reply",
        follows,
        mentions,
        revisionId,
        triggerActorId: actorId,
      }),
    );
  }

  async #projectContentRevised(
    transaction: TransactionSql,
    event: OutboxEvent,
  ): Promise<number> {
    const contentId = requiredUuid(event.payload, "content_id");
    const actorId = requiredUuid(event.payload, "actor_id");
    const revisionId = optionalUuid(event.payload, "revision_id");
    const changedGroups = stringArray(event.payload, "changed_groups");
    if (
      changedGroups.length === 0 ||
      changedGroups.some((group) => !CONTENT_CHANGE_GROUPS.has(group))
    ) {
      throw new NotificationProjectionError(
        "NOTIFICATION_EVENT_INVALID",
        "The content.revised event has invalid changed groups.",
      );
    }
    const content = await this.#contentFactForEvent(
      transaction,
      event,
      await this.#contentFact(transaction, contentId),
      false,
    );
    if (content.author_actor_id !== actorId) {
      throw new NotificationProjectionError(
        "NOTIFICATION_EVENT_INVALID",
        "The content.revised event does not match its ContentItem.",
      );
    }

    const affectedSymbolIds = optionalUuidArray(
      event.payload,
      "affected_symbol_ids",
      MAX_NOTIFICATION_SYMBOLS,
    );
    const affectedTopicIds = optionalUuidArray(
      event.payload,
      "affected_topic_ids",
      MAX_NOTIFICATION_TOPICS,
    );
    if ((affectedSymbolIds === null) !== (affectedTopicIds === null)) {
      throw new NotificationProjectionError(
        "NOTIFICATION_EVENT_INVALID",
        "Revised notification classification deltas must be complete.",
      );
    }
    if (
      affectedSymbolIds !== null &&
      (content.symbol_ids.some((id) => !affectedSymbolIds.includes(id)) ||
        content.topic_ids.some((id) => !affectedTopicIds!.includes(id)))
    ) {
      throw new NotificationProjectionError(
        "NOTIFICATION_EVENT_INVALID",
        "Revised notification classification deltas omit current classifications.",
      );
    }
    const followContent =
      affectedSymbolIds === null
        ? content
        : {
            ...content,
            symbol_ids: affectedSymbolIds,
            topic_ids: affectedTopicIds!,
          };

    const [follows, mentions] = await Promise.all([
      this.#followMatches(transaction, {
        actorId,
        changedGroups: new Set(changedGroups),
        content: followContent,
        eventKind: "revised",
      }),
      this.#mentionRecipients(transaction, revisionId, actorId),
    ]);
    return this.#projectCandidates(
      transaction,
      candidatesForContentEvent({
        content,
        event,
        followNotificationType: "content.revised",
        follows,
        mentions,
        revisionId,
        triggerActorId: actorId,
      }),
    );
  }

  async #projectReaction(
    transaction: TransactionSql,
    event: OutboxEvent,
  ): Promise<number> {
    const changed = requiredBoolean(event.payload, "changed");
    if (!changed) return 0;
    const contentId = requiredUuid(event.payload, "content_id");
    const actorId = requiredUuid(event.payload, "actor_id");
    const active = requiredBoolean(event.payload, "active");
    const reaction = requiredString(event.payload, "reaction", 20);
    if (!REACTION_TYPES.has(reaction)) {
      throw new NotificationProjectionError(
        "NOTIFICATION_EVENT_INVALID",
        "The reaction.changed event has an unsupported reaction type.",
      );
    }
    const content = await this.#contentFact(transaction, contentId);
    if (content.author_actor_id === actorId) return 0;
    const occurredAt = copyDate(event.occurredAt, "Outbox event occurredAt");
    const bucketStart = new Date(
      Math.floor(occurredAt.valueOf() / (10 * 60 * 1_000)) * 10 * 60 * 1_000,
    );
    const rows = await transaction<ReactionProjectedRow[]>`
      select projected.id::text as id
      from system.project_reaction_notification(
        ${randomUUID()}::uuid,
        ${content.author_actor_id}::uuid,
        ${contentId}::uuid,
        ${reaction}::text,
        ${bucketStart}::timestamptz,
        ${actorId}::uuid,
        ${active}::boolean,
        ${occurredAt}::timestamptz,
        ${event.aggregateSequence}::bigint
      ) as projected
    `;
    return rows.length;
  }

  async #projectFollow(transaction: TransactionSql, event: OutboxEvent): Promise<number> {
    if (!requiredBoolean(event.payload, "changed")) return 0;
    if (!requiredBoolean(event.payload, "active")) return 0;
    if (requiredString(event.payload, "target_type", 20) !== "actor") return 0;
    const followerActorId = requiredUuid(event.payload, "follower_actor_id");
    const recipientActorId = requiredUuid(event.payload, "target_resource_id");
    if (followerActorId === recipientActorId) return 0;

    return this.#projectCandidate(transaction, {
      communityIds: [],
      context: {},
      dedupeKey: `follow.started:${event.id}:${recipientActorId}`,
      matchedFollow: null,
      objectId: followerActorId,
      objectType: "actor",
      occurredAt: copyDate(event.occurredAt, "Outbox event occurredAt"),
      recipientActorId,
      summaryTemplateKey: SUMMARY_TEMPLATE_KEYS["follow.started"],
      symbolIds: [],
      triggerActorId: followerActorId,
      type: "follow.started",
    });
  }

  async #projectModeration(
    transaction: TransactionSql,
    event: OutboxEvent,
  ): Promise<number> {
    const contentId = requiredUuid(event.payload, "content_id");
    const content = await this.#contentFact(transaction, contentId);
    requiredString(event.payload, "before_distribution_state", 20);
    requiredString(event.payload, "after_distribution_state", 20);
    const follows = await this.#followMatches(transaction, {
      actorId: content.author_actor_id,
      content,
      eventKind: "moderation",
    });
    const recipients = new Map<string, FollowMatch[]>(
      follows.map((match) => [match.recipientActorId, match.matches]),
    );
    recipients.set(
      content.author_actor_id,
      recipients.get(content.author_actor_id) ?? [],
    );
    const candidates: NotificationCandidate[] = [];
    for (const [recipientActorId, matches] of recipients) {
      const contextualized = withFollowContext(eventContext(content), matches);
      candidates.push({
        communityIds: boundedSortedUnique(
          content.community_ids,
          MAX_NOTIFICATION_COMMUNITIES,
          "community_ids",
        ),
        context: contextualized.context,
        dedupeKey: `moderation.changed:${event.id}:${recipientActorId}`,
        matchedFollow: contextualized.matchedFollow,
        objectId: contentId,
        objectType: "content",
        occurredAt: copyDate(event.occurredAt, "Outbox event occurredAt"),
        recipientActorId,
        summaryTemplateKey: SUMMARY_TEMPLATE_KEYS["moderation.changed"],
        symbolIds: boundedSortedUnique(
          content.symbols,
          MAX_NOTIFICATION_SYMBOLS,
          "symbols",
        ),
        triggerActorId: null,
        type: "moderation.changed",
      });
    }
    return this.#projectCandidates(transaction, candidates);
  }

  async #pendingActionRecipient(
    transaction: TransactionSql,
    actionId: string,
  ): Promise<string> {
    const rows = await transaction<PendingActionRecipientRow[]>`
      select agent.actor_id::text as actor_id
      from platform.pending_actions as action
      join platform.agents as agent
        on agent.id = action.agent_id
       and agent.owner_id = action.owner_id
      where action.id = ${actionId}
      limit 1
      for share of action, agent
    `;
    const actorId = rows[0]?.actor_id;
    if (!actorId || !UUID_PATTERN.test(actorId)) {
      throw new NotificationProjectionError(
        "NOTIFICATION_SOURCE_NOT_FOUND",
        "The source PendingAction is unavailable for notification projection.",
      );
    }
    return actorId;
  }

  async #projectAction(
    transaction: TransactionSql,
    event: OutboxEvent,
    type: "action.pending_approval" | "action.resolved",
  ): Promise<number> {
    const actionId = requiredUuid(event.payload, "action_id");
    const payloadActorId = optionalUuid(event.payload, "actor_id");
    const recipientActorId = await this.#pendingActionRecipient(transaction, actionId);
    if (payloadActorId !== null && payloadActorId !== recipientActorId) {
      throw new NotificationProjectionError(
        "NOTIFICATION_EVENT_INVALID",
        "The action notification Actor does not match the source PendingAction.",
      );
    }
    if (type === "action.resolved") {
      const state = requiredString(event.payload, "state", 40);
      if (!ACTION_STATES.has(state)) {
        throw new NotificationProjectionError(
          "NOTIFICATION_EVENT_INVALID",
          "The action.resolved event has an unsupported terminal state.",
        );
      }
    }
    return this.#projectCandidate(transaction, {
      communityIds: [],
      context: {},
      dedupeKey: `${type}:${event.id}:${recipientActorId}`,
      matchedFollow: null,
      objectId: actionId,
      objectType: "pending_action",
      occurredAt: copyDate(event.occurredAt, "Outbox event occurredAt"),
      recipientActorId,
      summaryTemplateKey: SUMMARY_TEMPLATE_KEYS[type],
      symbolIds: [],
      triggerActorId: null,
      type,
    });
  }
}
