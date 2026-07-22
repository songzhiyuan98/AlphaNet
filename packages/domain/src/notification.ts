import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import type { AgentCredentialContext } from "./agent-connection.js";

export const NOTIFICATION_HISTORY_ORDERING_VERSION =
  "notifications-created-at-v1" as const;
export const NOTIFICATION_INCREMENTAL_ORDERING_VERSION =
  "notifications-recipient-change-sequence-v1" as const;
export const NOTIFICATION_SCHEMA_VERSION = "notification-v1" as const;

export const NOTIFICATION_TYPES = [
  "content.published",
  "content.reply",
  "content.mention",
  "reaction.changed",
  "follow.started",
  "content.revised",
  "moderation.changed",
  "action.pending_approval",
  "action.resolved",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type NotificationResourceType =
  "content" | "actor" | "community" | "pending_action";

export interface NotificationTriggerActor {
  actorId: string;
  agentId?: string | undefined;
  handle: string;
  kind: "agent" | "human";
}

export interface NotificationProjection {
  communityIds: string[];
  context: Record<string, unknown>;
  createdAt: Date;
  dedupeKey: string;
  distinctActorCount?: number | undefined;
  distinctActorCountsByKind?: { agent: number; human: number } | undefined;
  id: string;
  lastOccurredAt?: Date | undefined;
  object: { id: string; type: NotificationResourceType };
  occurredAt: Date;
  readAt: Date | null;
  recipientActorId: string;
  schemaVersion: typeof NOTIFICATION_SCHEMA_VERSION;
  stableTarget: {
    resourceId: string;
    resourceType: NotificationResourceType;
    webPath: string;
  };
  summary: string;
  symbols: string[];
  triggerActor: NotificationTriggerActor | null;
  type: NotificationType;
  updatedAt: Date;
  version: number;
}

export interface NotificationListInput {
  communityIds?: readonly string[] | undefined;
  createdAfter?: Date | string | undefined;
  createdBefore?: Date | string | undefined;
  cursor?: string | null | undefined;
  followingOnly?: boolean | undefined;
  limit?: number | undefined;
  pollCursor?: string | undefined;
  symbols?: readonly string[] | undefined;
  types?: readonly NotificationType[] | undefined;
  unreadOnly?: boolean | undefined;
}

export interface NormalizedNotificationFilters {
  communityIds: string[];
  createdAfter: Date | null;
  createdBefore: Date | null;
  followingOnly: boolean;
  symbols: string[];
  types: NotificationType[];
  unreadOnly: boolean;
}

export interface NotificationListPage {
  filters: NormalizedNotificationFilters;
  items: NotificationProjection[];
  mode: "history" | "incremental";
  ordering: {
    asOf: Date;
    orderingVersion:
      | typeof NOTIFICATION_HISTORY_ORDERING_VERSION
      | typeof NOTIFICATION_INCREMENTAL_ORDERING_VERSION;
    snapshotId: string;
  };
  page: {
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
  } | null;
  poll: {
    hasMore: boolean;
    nextCursor: string;
  };
}

export interface MarkNotificationReadResult {
  changed: boolean;
  notification: NotificationProjection;
  unreadCount: number;
}

export interface MarkAllNotificationsReadResult {
  markedCount: number;
  readAt: Date;
  unreadCount: number;
}

export interface NotificationService {
  checkReady(): Promise<void>;
  listAgentNotifications(
    context: AgentCredentialContext,
    input: NotificationListInput,
  ): Promise<NotificationListPage>;
  listOwnerAgentNotifications(
    ownerId: string,
    agentId: string,
    input: NotificationListInput,
  ): Promise<NotificationListPage>;
  markOwnerAgentNotificationRead(
    ownerId: string,
    agentId: string,
    notificationId: string,
  ): Promise<MarkNotificationReadResult>;
  markAllOwnerAgentNotificationsRead(
    ownerId: string,
    agentId: string,
  ): Promise<MarkAllNotificationsReadResult>;
}

export type NotificationErrorCode =
  | "AUTHORIZATION_CONTEXT_STALE"
  | "CURSOR_EXPIRED"
  | "CURSOR_INVALID"
  | "INVALID_ARGUMENT"
  | "NOTIFICATION_DATA_INVALID"
  | "NOTIFICATION_NOT_FOUND"
  | "NOTIFICATION_NOT_READY"
  | "OWNER_AGENT_NOT_FOUND"
  | "SNAPSHOT_EXPIRED";

export class NotificationError extends Error {
  readonly code: NotificationErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    code: NotificationErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean | undefined } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "NotificationError";
    this.code = code;
    this.retryable =
      options.retryable ??
      (code === "NOTIFICATION_DATA_INVALID" || code === "NOTIFICATION_NOT_READY");
    this.statusCode = notificationErrorStatus(code);
  }
}

export interface PostgresNotificationServiceOptions {
  clock?: (() => Date) | undefined;
  cursorSigningKey: Buffer;
  cursorTtlSeconds?: number | undefined;
  defaultLimit?: number | undefined;
}

interface NotificationRow {
  aggregate_agent_count: number | string | null;
  aggregate_distinct_actor_count: number | string | null;
  aggregate_human_count: number | string | null;
  change_sequence: string;
  community_ids: string[];
  context: unknown;
  created_at: Date;
  dedupe_key: string;
  id: string;
  last_occurred_at: Date | null;
  object_id: string;
  object_is_visible: boolean;
  object_type: string;
  occurred_at: Date;
  read_at: Date | null;
  recipient_actor_id: string;
  schema_version: string;
  summary_template_key: string;
  symbol_ids: string[];
  trigger_actor_id: string | null;
  trigger_actor_kind: string | null;
  trigger_agent_id: string | null;
  trigger_handle: string | null;
  type: string;
  updated_at: Date;
  version: number | string;
}

interface IncrementalNotificationRow extends NotificationRow {
  observed_change_sequence: string;
}

interface RecipientSequenceRow {
  as_of: Date;
  last_created_sequence: string;
  last_change_sequence: string;
}

interface OwnerRecipientRow {
  actor_id: string;
}

interface UnreadCountRow {
  unread_count: number | string;
}

interface MarkAllRow {
  marked_count: number | string;
  read_at: Date;
}

interface HistoryCursorPayload {
  asOf: string;
  binding: string;
  changeHighWater: string;
  createdHighWater: string;
  expiresAt: string;
  kind: "notification_history";
  last: { createdAt: string; id: string };
  recipientActorId: string;
  snapshotId: string;
  v: 1;
}

interface PollCursorPayload {
  binding: string;
  expiresAt: string;
  kind: "notification_poll";
  lastChangeSequence: string;
  recipientActorId: string;
  upperChangeSequence: string | null;
  v: 1;
  windowAsOf: string | null;
}

const DEFAULT_LIMIT = 25;
const MAXIMUM_LIMIT = 100;
const DEFAULT_CURSOR_TTL_SECONDS = 15 * 60;
const MAXIMUM_CURSOR_LENGTH = 4_096;
const CURSOR_SIGNATURE_DOMAIN = "alphanet.notification.cursor-signature.v1";
const CURSOR_BINDING_DOMAIN = "alphanet.notification.cursor-binding.v1";
const SNAPSHOT_ID_DOMAIN = "alphanet.notification.snapshot-id.v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9.-]{0,14}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const notificationTypeSet = new Set<string>(NOTIFICATION_TYPES);
const resourceTypeSet = new Set<string>([
  "content",
  "actor",
  "community",
  "pending_action",
]);

const summaries: Record<NotificationType, string> = {
  "content.published": "A followed target has a new post.",
  "content.reply": "A discussion has a new reply.",
  "content.mention": "You were mentioned in research.",
  "reaction.changed": "Your content has new reaction activity.",
  "follow.started": "Another Actor started following you.",
  "content.revised": "Followed research has been revised.",
  "moderation.changed": "A content distribution state changed.",
  "action.pending_approval": "A write is waiting for Owner approval.",
  "action.resolved": "A pending action reached a terminal state.",
};

const summaryTemplateKeys: Record<NotificationType, string> = {
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

type QuerySql = postgres.Sql | postgres.TransactionSql;

function notificationErrorStatus(code: NotificationErrorCode): number {
  switch (code) {
    case "AUTHORIZATION_CONTEXT_STALE":
      return 401;
    case "NOTIFICATION_NOT_FOUND":
    case "OWNER_AGENT_NOT_FOUND":
      return 404;
    case "CURSOR_EXPIRED":
    case "SNAPSHOT_EXPIRED":
      return 410;
    case "CURSOR_INVALID":
    case "INVALID_ARGUMENT":
      return 400;
    case "NOTIFICATION_DATA_INVALID":
    case "NOTIFICATION_NOT_READY":
      return 503;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotificationType(value: string): value is NotificationType {
  return notificationTypeSet.has(value);
}

function isNotificationResourceType(value: string): value is NotificationResourceType {
  return resourceTypeSet.has(value);
}

function copyDate(value: unknown, code: NotificationErrorCode): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.valueOf())) {
    throw new NotificationError(code, "A notification timestamp is invalid.");
  }
  return new Date(date.valueOf());
}

function positiveSafeInteger(value: unknown, name: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new NotificationError(
      "NOTIFICATION_DATA_INVALID",
      `Stored notification ${name} is invalid.`,
    );
  }
  return number;
}

function decimal(value: unknown, name: string): string {
  const candidate = typeof value === "string" ? value : String(value);
  if (!DECIMAL_PATTERN.test(candidate)) {
    throw new NotificationError(
      "NOTIFICATION_DATA_INVALID",
      `Stored notification ${name} is invalid.`,
    );
  }
  return candidate;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeDate(value: Date | string | undefined, name: string): Date | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? new Date(value.valueOf()) : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new NotificationError("INVALID_ARGUMENT", `${name} must be a timestamp.`);
  }
  return date;
}

function normalizeFilters(input: NotificationListInput): {
  filters: NormalizedNotificationFilters;
  limit: number;
} {
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_LIMIT) {
    throw new NotificationError(
      "INVALID_ARGUMENT",
      `limit must be between 1 and ${MAXIMUM_LIMIT}.`,
    );
  }
  const types = [...new Set(input.types ?? [])].sort();
  if (
    types.length > NOTIFICATION_TYPES.length ||
    types.some((type) => !isNotificationType(type))
  ) {
    throw new NotificationError("INVALID_ARGUMENT", "types contains an invalid value.");
  }
  const symbols = uniqueSorted(
    (input.symbols ?? []).map((symbol) => symbol.toUpperCase()),
  );
  if (
    symbols.length > 10 ||
    symbols.some((symbol) => !SYMBOL_PATTERN.test(symbol)) ||
    symbols.length !== (input.symbols?.length ?? 0)
  ) {
    throw new NotificationError("INVALID_ARGUMENT", "symbols contains an invalid value.");
  }
  const communityIds = uniqueSorted(
    (input.communityIds ?? []).map((communityId) => communityId.toLowerCase()),
  );
  if (
    communityIds.length > 5 ||
    communityIds.some((communityId) => !UUID_PATTERN.test(communityId)) ||
    communityIds.length !== (input.communityIds?.length ?? 0)
  ) {
    throw new NotificationError(
      "INVALID_ARGUMENT",
      "community_ids contains an invalid value.",
    );
  }
  const createdAfter = normalizeDate(input.createdAfter, "created_after");
  const createdBefore = normalizeDate(input.createdBefore, "created_before");
  if (createdAfter && createdBefore && createdAfter >= createdBefore) {
    throw new NotificationError(
      "INVALID_ARGUMENT",
      "created_before must be later than created_after.",
    );
  }
  if (input.cursor && input.pollCursor) {
    throw new NotificationError(
      "INVALID_ARGUMENT",
      "History and incremental cursors are mutually exclusive.",
    );
  }
  if (
    (input.cursor !== undefined &&
      input.cursor !== null &&
      input.cursor.length > MAXIMUM_CURSOR_LENGTH) ||
    (input.pollCursor !== undefined && input.pollCursor.length > MAXIMUM_CURSOR_LENGTH)
  ) {
    throw new NotificationError("CURSOR_INVALID", "The notification cursor is invalid.");
  }
  return {
    filters: {
      communityIds,
      createdAfter,
      createdBefore,
      followingOnly: input.followingOnly ?? false,
      symbols,
      types,
      unreadOnly: input.unreadOnly ?? false,
    },
    limit,
  };
}

function filterBinding(filters: NormalizedNotificationFilters): string {
  return createHash("sha256")
    .update(CURSOR_BINDING_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(
      JSON.stringify({
        community_ids: filters.communityIds,
        created_after: filters.createdAfter?.toISOString() ?? null,
        created_before: filters.createdBefore?.toISOString() ?? null,
        following_only: filters.followingOnly,
        symbols: filters.symbols,
        types: filters.types,
        unread_only: filters.unreadOnly,
      }),
      "utf8",
    )
    .digest("base64url");
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function isHistoryCursorPayload(value: unknown): value is HistoryCursorPayload {
  if (!isRecord(value) || value.kind !== "notification_history" || value.v !== 1) {
    return false;
  }
  const last = value.last;
  return (
    typeof value.asOf === "string" &&
    typeof value.binding === "string" &&
    typeof value.changeHighWater === "string" &&
    DECIMAL_PATTERN.test(value.changeHighWater) &&
    typeof value.createdHighWater === "string" &&
    DECIMAL_PATTERN.test(value.createdHighWater) &&
    typeof value.expiresAt === "string" &&
    typeof value.recipientActorId === "string" &&
    UUID_PATTERN.test(value.recipientActorId) &&
    typeof value.snapshotId === "string" &&
    isRecord(last) &&
    typeof last.createdAt === "string" &&
    typeof last.id === "string" &&
    UUID_PATTERN.test(last.id)
  );
}

function isPollCursorPayload(value: unknown): value is PollCursorPayload {
  return (
    isRecord(value) &&
    value.kind === "notification_poll" &&
    value.v === 1 &&
    typeof value.binding === "string" &&
    typeof value.expiresAt === "string" &&
    typeof value.lastChangeSequence === "string" &&
    DECIMAL_PATTERN.test(value.lastChangeSequence) &&
    typeof value.recipientActorId === "string" &&
    UUID_PATTERN.test(value.recipientActorId) &&
    (value.upperChangeSequence === null ||
      (typeof value.upperChangeSequence === "string" &&
        DECIMAL_PATTERN.test(value.upperChangeSequence))) &&
    (value.windowAsOf === null || typeof value.windowAsOf === "string")
  );
}

function stableTarget(type: NotificationResourceType, id: string) {
  const prefix: Record<NotificationResourceType, string> = {
    actor: "/actors",
    community: "/communities",
    content: "/content",
    pending_action: "/settings/approvals",
  };
  return {
    resourceId: id,
    resourceType: type,
    webPath: `${prefix[type]}/${id}`,
  };
}

function contextFromRow(row: NotificationRow): Record<string, unknown> {
  if (!isRecord(row.context)) {
    throw new NotificationError(
      "NOTIFICATION_DATA_INVALID",
      "Stored notification context is invalid.",
    );
  }
  if (row.object_type !== "content" || row.object_is_visible) {
    return { ...row.context };
  }
  if (row.type !== "reaction.changed") return {};

  const redactedReactionContext: Record<string, unknown> = {};
  for (const key of [
    "reaction_type",
    "reaction_window_started_at",
    "reaction_window_ends_at",
  ] as const) {
    if (row.context[key] !== undefined) {
      redactedReactionContext[key] = row.context[key];
    }
  }
  return redactedReactionContext;
}

function projectionFromRow(row: NotificationRow): NotificationProjection {
  if (
    !UUID_PATTERN.test(row.id) ||
    !UUID_PATTERN.test(row.recipient_actor_id) ||
    !UUID_PATTERN.test(row.object_id) ||
    !isNotificationType(row.type) ||
    !isNotificationResourceType(row.object_type) ||
    row.schema_version !== NOTIFICATION_SCHEMA_VERSION ||
    row.summary_template_key !== summaryTemplateKeys[row.type] ||
    typeof row.object_is_visible !== "boolean"
  ) {
    throw new NotificationError(
      "NOTIFICATION_DATA_INVALID",
      "Stored notification identity or contract fields are invalid.",
    );
  }
  const version = positiveSafeInteger(row.version, "version");
  if (version < 1) {
    throw new NotificationError(
      "NOTIFICATION_DATA_INVALID",
      "Stored notification version is invalid.",
    );
  }
  decimal(row.change_sequence, "change_sequence");
  const createdAt = copyDate(row.created_at, "NOTIFICATION_DATA_INVALID");
  const occurredAt = copyDate(row.occurred_at, "NOTIFICATION_DATA_INVALID");
  const updatedAt = copyDate(row.updated_at, "NOTIFICATION_DATA_INVALID");
  const readAt =
    row.read_at === null ? null : copyDate(row.read_at, "NOTIFICATION_DATA_INVALID");
  if (updatedAt < createdAt || (readAt !== null && readAt < createdAt)) {
    throw new NotificationError(
      "NOTIFICATION_DATA_INVALID",
      "Stored notification timestamps are inconsistent.",
    );
  }
  let triggerActor: NotificationTriggerActor | null = null;
  const hasVisibleTriggerActor =
    row.object_is_visible &&
    (row.trigger_actor_kind !== null ||
      row.trigger_handle !== null ||
      row.trigger_agent_id !== null);
  if (hasVisibleTriggerActor) {
    if (
      row.trigger_actor_id === null ||
      !UUID_PATTERN.test(row.trigger_actor_id) ||
      (row.trigger_actor_kind !== "agent" && row.trigger_actor_kind !== "human") ||
      typeof row.trigger_handle !== "string" ||
      row.trigger_handle.length === 0
    ) {
      throw new NotificationError(
        "NOTIFICATION_DATA_INVALID",
        "Stored notification trigger Actor is invalid.",
      );
    }
    triggerActor = {
      actorId: row.trigger_actor_id,
      handle: row.trigger_handle,
      kind: row.trigger_actor_kind,
      ...(row.trigger_actor_kind === "agent" && row.trigger_agent_id
        ? { agentId: row.trigger_agent_id }
        : {}),
    };
  }

  const projection: NotificationProjection = {
    communityIds: row.object_is_visible ? uniqueSorted(row.community_ids) : [],
    context: contextFromRow(row),
    createdAt,
    dedupeKey: row.dedupe_key,
    id: row.id,
    object: { id: row.object_id, type: row.object_type },
    occurredAt,
    readAt,
    recipientActorId: row.recipient_actor_id,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    stableTarget: stableTarget(row.object_type, row.object_id),
    summary: summaries[row.type],
    symbols: row.object_is_visible ? uniqueSorted(row.symbol_ids) : [],
    triggerActor,
    type: row.type,
    updatedAt,
    version,
  };
  if (row.type === "reaction.changed") {
    if (
      row.last_occurred_at === null ||
      row.aggregate_distinct_actor_count === null ||
      row.aggregate_agent_count === null ||
      row.aggregate_human_count === null
    ) {
      throw new NotificationError(
        "NOTIFICATION_DATA_INVALID",
        "Stored reaction notification aggregation is incomplete.",
      );
    }
    const distinctActorCount = positiveSafeInteger(
      row.aggregate_distinct_actor_count,
      "aggregate_distinct_actor_count",
    );
    const agent = positiveSafeInteger(row.aggregate_agent_count, "aggregate_agent_count");
    const human = positiveSafeInteger(row.aggregate_human_count, "aggregate_human_count");
    if (agent + human !== distinctActorCount) {
      throw new NotificationError(
        "NOTIFICATION_DATA_INVALID",
        "Stored reaction notification counts are inconsistent.",
      );
    }
    projection.distinctActorCount = distinctActorCount;
    projection.distinctActorCountsByKind = { agent, human };
    projection.lastOccurredAt = copyDate(
      row.last_occurred_at,
      "NOTIFICATION_DATA_INVALID",
    );
  } else if (
    row.last_occurred_at !== null ||
    row.aggregate_distinct_actor_count !== null ||
    row.aggregate_agent_count !== null ||
    row.aggregate_human_count !== null
  ) {
    throw new NotificationError(
      "NOTIFICATION_DATA_INVALID",
      "A non-aggregate notification contains aggregate fields.",
    );
  }
  return projection;
}

export class PostgresNotificationService implements NotificationService {
  readonly #clock: () => Date;
  readonly #cursorSigningKey: Buffer;
  readonly #cursorTtlSeconds: number;
  readonly #defaultLimit: number;

  constructor(
    private readonly sql: PostgresClient,
    options: PostgresNotificationServiceOptions,
  ) {
    if (options.cursorSigningKey.byteLength < 32) {
      throw new RangeError(
        "Notification cursor signing key must contain at least 32 bytes.",
      );
    }
    this.#clock = options.clock ?? (() => new Date());
    this.#cursorSigningKey = Buffer.from(options.cursorSigningKey);
    this.#cursorTtlSeconds = options.cursorTtlSeconds ?? DEFAULT_CURSOR_TTL_SECONDS;
    this.#defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
    if (
      !Number.isInteger(this.#cursorTtlSeconds) ||
      this.#cursorTtlSeconds < 60 ||
      !Number.isInteger(this.#defaultLimit) ||
      this.#defaultLimit < 1 ||
      this.#defaultLimit > MAXIMUM_LIMIT
    ) {
      throw new RangeError("Notification service limits are invalid.");
    }
  }

  async checkReady(): Promise<void> {
    const rows = await this.sql<{ ready: boolean }[]>`
      select
        to_regclass('platform.notifications') is not null
        and to_regclass('system.notification_recipient_sequences') is not null
        and to_regclass('system.notification_change_journal') is not null
        and to_regprocedure(
          'system.set_notification_read_state(uuid,uuid,boolean)'
        ) is not null
        and to_regprocedure(
          'system.mark_all_notifications_read(uuid)'
        ) is not null as ready
    `;
    if (rows.length !== 1 || rows[0]?.ready !== true) {
      throw new NotificationError(
        "NOTIFICATION_NOT_READY",
        "The Notification service schema is not ready.",
      );
    }
  }

  async listAgentNotifications(
    context: AgentCredentialContext,
    input: NotificationListInput,
  ): Promise<NotificationListPage> {
    const recipientActorId = await this.#agentRecipient(context);
    return this.#list(recipientActorId, input);
  }

  async listOwnerAgentNotifications(
    ownerId: string,
    agentId: string,
    input: NotificationListInput,
  ): Promise<NotificationListPage> {
    const recipientActorId = await this.#ownerRecipient(ownerId, agentId);
    return this.#list(recipientActorId, input);
  }

  async markOwnerAgentNotificationRead(
    ownerId: string,
    agentId: string,
    notificationId: string,
  ): Promise<MarkNotificationReadResult> {
    if (!UUID_PATTERN.test(notificationId)) {
      throw new NotificationError("INVALID_ARGUMENT", "notification_id must be a UUID.");
    }
    const recipientActorId = await this.#ownerRecipient(ownerId, agentId);
    return this.sql.begin(async (transaction) => {
      const before = await transaction<{ read_at: Date | null }[]>`
        select notification.read_at
        from platform.notifications as notification
        where notification.id = ${notificationId}
          and notification.recipient_actor_id = ${recipientActorId}
        for update
      `;
      if (!before[0]) {
        throw new NotificationError(
          "NOTIFICATION_NOT_FOUND",
          "The notification was not found for this Agent.",
        );
      }
      const rows = await this.#selectRows(
        transaction,
        transaction<NotificationRow[]>`
        select
          notification.*,
          visibility.object_is_visible,
          trigger.kind as trigger_actor_kind,
          trigger.handle::text as trigger_handle,
          trigger_agent.id::text as trigger_agent_id
        from system.set_notification_read_state(
          ${notificationId}::uuid,
          ${recipientActorId}::uuid,
          true
        ) as notification
        left join platform.actors as trigger
          on trigger.id = notification.trigger_actor_id
         and trigger.status in ('active', 'restricted')
         and trigger.deleted_at is null
        left join platform.agents as trigger_agent on trigger_agent.actor_id = trigger.id
        cross join lateral (
          select (
            notification.object_type <> 'content'
            or exists (
              select 1
              from platform.content_items as target_content
              join platform.content_items as target_root
                on target_root.id = target_content.root_id
               and target_root.kind = 'post'
              where target_content.id = notification.object_id
                and target_content.lifecycle_state = 'published'
                and target_root.lifecycle_state = 'published'
                and target_content.distribution_state <> 'hidden'
                and target_root.distribution_state <> 'hidden'
                and exists (
                  select 1
                  from platform.communities as visible_community
                  where visible_community.deleted_at is null
                    and visible_community.status <> 'suspended'
                    and (
                      visible_community.id = target_root.primary_community_id
                      or exists (
                        select 1
                        from platform.content_additional_communities
                          as visible_additional
                        where visible_additional.content_id = target_root.id
                          and visible_additional.community_id = visible_community.id
                      )
                    )
                )
            )
          ) as object_is_visible
        ) as visibility
      `,
      );
      const notification = rows[0];
      if (!notification) {
        throw new NotificationError(
          "NOTIFICATION_NOT_FOUND",
          "The notification was not found for this Agent.",
        );
      }
      return {
        changed: before[0].read_at === null,
        notification: projectionFromRow(notification),
        unreadCount: await this.#unreadCount(transaction, recipientActorId),
      };
    });
  }

  async markAllOwnerAgentNotificationsRead(
    ownerId: string,
    agentId: string,
  ): Promise<MarkAllNotificationsReadResult> {
    const recipientActorId = await this.#ownerRecipient(ownerId, agentId);
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<MarkAllRow[]>`
        select marked.marked_count, marked.read_at
        from system.mark_all_notifications_read(${recipientActorId}::uuid) as marked
      `;
      const row = rows[0];
      if (!row) {
        throw new NotificationError(
          "NOTIFICATION_DATA_INVALID",
          "The bulk notification read result is invalid.",
        );
      }
      return {
        markedCount: positiveSafeInteger(row.marked_count, "marked_count"),
        readAt: copyDate(row.read_at, "NOTIFICATION_DATA_INVALID"),
        unreadCount: await this.#unreadCount(transaction, recipientActorId),
      };
    });
  }

  async #agentRecipient(context: AgentCredentialContext): Promise<string> {
    const rows = await this.sql<OwnerRecipientRow[]>`
      select actor.id::text as actor_id
      from platform.credentials as credential
      join platform.agents as agent
        on agent.id = credential.agent_id
       and agent.owner_id = credential.owner_id
      join platform.actors as actor
        on actor.id = agent.actor_id
       and actor.owner_id = agent.owner_id
      join platform.owners as owner on owner.id = agent.owner_id
      where credential.id = ${context.credential.id}
        and credential.owner_id = ${context.owner.id}
        and credential.agent_id = ${context.agent.id}
        and actor.id = ${context.agent.actorId}
        and credential.revoked_at is null
        and (credential.expires_at is null or credential.expires_at > clock_timestamp())
        and owner.status = 'active'
        and owner.email_verified_at is not null
        and owner.deleted_at is null
        and agent.status = 'active'
        and agent.deleted_at is null
        and actor.status = 'active'
        and actor.deleted_at is null
      limit 1
    `;
    const actorId = rows[0]?.actor_id;
    if (!actorId || !UUID_PATTERN.test(actorId)) {
      throw new NotificationError(
        "AUTHORIZATION_CONTEXT_STALE",
        "The authenticated Agent authority context is no longer valid.",
      );
    }
    return actorId;
  }

  async #ownerRecipient(ownerId: string, agentId: string): Promise<string> {
    if (!UUID_PATTERN.test(ownerId) || !UUID_PATTERN.test(agentId)) {
      throw new NotificationError(
        "OWNER_AGENT_NOT_FOUND",
        "The selected Agent was not found for this Owner.",
      );
    }
    const rows = await this.sql<OwnerRecipientRow[]>`
      select agent.actor_id::text as actor_id
      from platform.agents as agent
      join platform.actors as actor
        on actor.id = agent.actor_id
       and actor.owner_id = agent.owner_id
      where agent.id = ${agentId}
        and agent.owner_id = ${ownerId}
        and agent.status = 'active'
        and agent.deleted_at is null
        and actor.status = 'active'
        and actor.deleted_at is null
      limit 1
    `;
    const actorId = rows[0]?.actor_id;
    if (!actorId || !UUID_PATTERN.test(actorId)) {
      throw new NotificationError(
        "OWNER_AGENT_NOT_FOUND",
        "The selected Agent was not found for this Owner.",
      );
    }
    return actorId;
  }

  async #list(
    recipientActorId: string,
    input: NotificationListInput,
  ): Promise<NotificationListPage> {
    const normalized = normalizeFilters({
      ...input,
      limit: input.limit ?? this.#defaultLimit,
    });
    const binding = filterBinding(normalized.filters);
    return input.pollCursor
      ? this.#listIncremental(
          recipientActorId,
          normalized.filters,
          normalized.limit,
          binding,
          input.pollCursor,
        )
      : this.#listHistory(
          recipientActorId,
          normalized.filters,
          normalized.limit,
          binding,
          input.cursor ?? null,
        );
  }

  async #recipientSequence(
    sql: QuerySql,
    recipientActorId: string,
  ): Promise<RecipientSequenceRow> {
    const rows = await sql<RecipientSequenceRow[]>`
      select
        date_trunc('milliseconds', clock_timestamp()) as as_of,
        coalesce(sequence.last_created_sequence, 0)::text as last_created_sequence,
        coalesce(sequence.last_change_sequence, 0)::text as last_change_sequence
      from (values (1)) as singleton(value)
      left join system.notification_recipient_sequences as sequence
        on sequence.recipient_actor_id = ${recipientActorId}
    `;
    const row = rows[0];
    if (!row) {
      throw new NotificationError(
        "NOTIFICATION_DATA_INVALID",
        "The notification sequence projection is invalid.",
      );
    }
    copyDate(row.as_of, "NOTIFICATION_DATA_INVALID");
    decimal(row.last_created_sequence, "last_created_sequence");
    decimal(row.last_change_sequence, "last_change_sequence");
    if (BigInt(row.last_created_sequence) > BigInt(row.last_change_sequence)) {
      throw new NotificationError(
        "NOTIFICATION_DATA_INVALID",
        "The notification recipient sequence projection is invalid.",
      );
    }
    return row;
  }

  async #listHistory(
    recipientActorId: string,
    filters: NormalizedNotificationFilters,
    limit: number,
    binding: string,
    cursor: string | null,
  ): Promise<NotificationListPage> {
    const cursorPayload = cursor
      ? this.#parseHistoryCursor(cursor, recipientActorId, binding)
      : null;
    const sequence = cursorPayload
      ? null
      : await this.#recipientSequence(this.sql, recipientActorId);
    const asOf = cursorPayload
      ? copyDate(cursorPayload.asOf, "CURSOR_INVALID")
      : copyDate(sequence!.as_of, "NOTIFICATION_DATA_INVALID");
    const createdHighWater =
      cursorPayload?.createdHighWater ?? sequence!.last_created_sequence;
    const changeHighWater =
      cursorPayload?.changeHighWater ?? sequence!.last_change_sequence;
    const snapshotId =
      cursorPayload?.snapshotId ??
      this.#snapshotId(
        recipientActorId,
        binding,
        asOf,
        `${createdHighWater}/${changeHighWater}`,
      );
    const rows = await this.#selectRows(
      this.sql,
      this.sql<NotificationRow[]>`
      select
        notification.*,
        visibility.object_is_visible,
        trigger.kind as trigger_actor_kind,
        trigger.handle::text as trigger_handle,
        trigger_agent.id::text as trigger_agent_id
      from platform.notifications as notification
      left join platform.actors as trigger
        on trigger.id = notification.trigger_actor_id
       and trigger.status in ('active', 'restricted')
       and trigger.deleted_at is null
      left join platform.agents as trigger_agent on trigger_agent.actor_id = trigger.id
      cross join lateral (
        select (
          notification.object_type <> 'content'
          or exists (
            select 1
            from platform.content_items as target_content
            join platform.content_items as target_root
              on target_root.id = target_content.root_id
             and target_root.kind = 'post'
            where target_content.id = notification.object_id
              and target_content.lifecycle_state = 'published'
              and target_root.lifecycle_state = 'published'
              and target_content.distribution_state <> 'hidden'
              and target_root.distribution_state <> 'hidden'
              and exists (
                select 1
                from platform.communities as visible_community
                where visible_community.deleted_at is null
                  and visible_community.status <> 'suspended'
                  and (
                    visible_community.id = target_root.primary_community_id
                    or exists (
                      select 1
                      from platform.content_additional_communities
                        as visible_additional
                      where visible_additional.content_id = target_root.id
                        and visible_additional.community_id = visible_community.id
                    )
                  )
              )
          )
        ) as object_is_visible
      ) as visibility
      where notification.recipient_actor_id = ${recipientActorId}
        and notification.created_at <= ${asOf}
        and notification.created_sequence <= ${createdHighWater}::bigint
        and (
          ${cursorPayload?.last.createdAt ?? null}::timestamptz is null
          or (notification.created_at, notification.id) < (
            ${cursorPayload?.last.createdAt ?? null}::timestamptz,
            ${cursorPayload?.last.id ?? null}::uuid
          )
        )
        and (${filters.types.length === 0} or notification.type = any(${this.sql.array(filters.types)}::text[]))
        and (${!filters.unreadOnly} or notification.read_at is null)
        and (${filters.symbols.length === 0} or (visibility.object_is_visible and notification.symbol_ids && ${this.sql.array(filters.symbols)}::text[]))
        and (${filters.communityIds.length === 0} or (visibility.object_is_visible and notification.community_ids && ${this.sql.array(filters.communityIds)}::uuid[]))
        and (${!filters.followingOnly} or (visibility.object_is_visible and notification.matched_follow_target_type is not null))
        and (${filters.createdAfter}::timestamptz is null or notification.created_at > ${filters.createdAfter})
        and (${filters.createdBefore}::timestamptz is null or notification.created_at < ${filters.createdBefore})
      order by notification.created_at desc, notification.id desc
      limit ${limit + 1}
    `,
    );
    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);
    const last = visibleRows.at(-1);
    const expiresAt = cursorPayload
      ? copyDate(cursorPayload.expiresAt, "CURSOR_INVALID")
      : this.#expiresAt();
    const nextCursor =
      hasMore && last
        ? this.#signCursor("nhc", {
            asOf: asOf.toISOString(),
            binding,
            changeHighWater,
            createdHighWater,
            expiresAt: expiresAt.toISOString(),
            kind: "notification_history",
            last: { createdAt: last.created_at.toISOString(), id: last.id },
            recipientActorId,
            snapshotId,
            v: 1,
          } satisfies HistoryCursorPayload)
        : null;
    return {
      filters,
      items: visibleRows.map(projectionFromRow),
      mode: "history",
      ordering: {
        asOf,
        orderingVersion: NOTIFICATION_HISTORY_ORDERING_VERSION,
        snapshotId,
      },
      page: { hasMore, limit, nextCursor },
      poll: {
        hasMore: false,
        nextCursor: this.#pollCursor(recipientActorId, binding, changeHighWater),
      },
    };
  }

  async #listIncremental(
    recipientActorId: string,
    filters: NormalizedNotificationFilters,
    limit: number,
    binding: string,
    pollCursor: string,
  ): Promise<NotificationListPage> {
    const cursor = this.#parsePollCursor(pollCursor, recipientActorId, binding);
    const sequence =
      cursor.upperChangeSequence === null
        ? await this.#recipientSequence(this.sql, recipientActorId)
        : null;
    const upperChangeSequence =
      cursor.upperChangeSequence ?? sequence!.last_change_sequence;
    const asOf =
      cursor.windowAsOf === null
        ? copyDate(sequence!.as_of, "NOTIFICATION_DATA_INVALID")
        : copyDate(cursor.windowAsOf, "CURSOR_INVALID");
    const rows = await this.#selectRows(
      this.sql,
      this.sql<IncrementalNotificationRow[]>`
        with changed_notifications as (
          select
            journal.notification_id,
            max(journal.change_sequence)::text as observed_change_sequence
          from system.notification_change_journal as journal
          where journal.recipient_actor_id = ${recipientActorId}
            and journal.change_sequence > ${cursor.lastChangeSequence}::bigint
            and journal.change_sequence <= ${upperChangeSequence}::bigint
          group by journal.notification_id
        )
        select
          notification.*,
          changed.observed_change_sequence,
          visibility.object_is_visible,
          trigger.kind as trigger_actor_kind,
          trigger.handle::text as trigger_handle,
          trigger_agent.id::text as trigger_agent_id
        from changed_notifications as changed
        join platform.notifications as notification on notification.id = changed.notification_id
        left join platform.actors as trigger
          on trigger.id = notification.trigger_actor_id
         and trigger.status in ('active', 'restricted')
         and trigger.deleted_at is null
        left join platform.agents as trigger_agent on trigger_agent.actor_id = trigger.id
        cross join lateral (
          select (
            notification.object_type <> 'content'
            or exists (
              select 1
              from platform.content_items as target_content
              join platform.content_items as target_root
                on target_root.id = target_content.root_id
               and target_root.kind = 'post'
              where target_content.id = notification.object_id
                and target_content.lifecycle_state = 'published'
                and target_root.lifecycle_state = 'published'
                and target_content.distribution_state <> 'hidden'
                and target_root.distribution_state <> 'hidden'
                and exists (
                  select 1
                  from platform.communities as visible_community
                  where visible_community.deleted_at is null
                    and visible_community.status <> 'suspended'
                    and (
                      visible_community.id = target_root.primary_community_id
                      or exists (
                        select 1
                        from platform.content_additional_communities
                          as visible_additional
                        where visible_additional.content_id = target_root.id
                          and visible_additional.community_id = visible_community.id
                      )
                    )
                )
            )
          ) as object_is_visible
        ) as visibility
        where notification.recipient_actor_id = ${recipientActorId}
          and notification.change_sequence <= ${upperChangeSequence}::bigint
          and (${filters.types.length === 0} or notification.type = any(${this.sql.array(filters.types)}::text[]))
          and (${!filters.unreadOnly} or notification.read_at is null)
          and (${filters.symbols.length === 0} or (visibility.object_is_visible and notification.symbol_ids && ${this.sql.array(filters.symbols)}::text[]))
          and (${filters.communityIds.length === 0} or (visibility.object_is_visible and notification.community_ids && ${this.sql.array(filters.communityIds)}::uuid[]))
          and (${!filters.followingOnly} or (visibility.object_is_visible and notification.matched_follow_target_type is not null))
          and (${filters.createdAfter}::timestamptz is null or notification.created_at > ${filters.createdAfter})
          and (${filters.createdBefore}::timestamptz is null or notification.created_at < ${filters.createdBefore})
        order by changed.observed_change_sequence::bigint, notification.id
        limit ${limit + 1}
      `,
    );
    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);
    const lastReturnedSequence = visibleRows.at(-1)?.observed_change_sequence;
    const nextSequence =
      hasMore && lastReturnedSequence
        ? decimal(lastReturnedSequence, "observed_change_sequence")
        : upperChangeSequence;
    return {
      filters,
      items: visibleRows.map(projectionFromRow),
      mode: "incremental",
      ordering: {
        asOf,
        orderingVersion: NOTIFICATION_INCREMENTAL_ORDERING_VERSION,
        snapshotId: this.#snapshotId(
          recipientActorId,
          binding,
          asOf,
          upperChangeSequence,
        ),
      },
      page: null,
      poll: {
        hasMore,
        nextCursor: hasMore
          ? this.#pollCursor(recipientActorId, binding, nextSequence, {
              expiresAt: copyDate(cursor.expiresAt, "CURSOR_INVALID"),
              upperChangeSequence,
              windowAsOf: asOf,
            })
          : this.#pollCursor(recipientActorId, binding, nextSequence),
      },
    };
  }

  async #selectRows<T extends NotificationRow>(
    _sql: QuerySql,
    rowsPromise: Promise<T[]>,
  ): Promise<T[]> {
    const rows = await rowsPromise;
    for (const row of rows) projectionFromRow(row);
    return rows;
  }

  async #unreadCount(sql: QuerySql, recipientActorId: string): Promise<number> {
    const rows = await sql<UnreadCountRow[]>`
      select count(*)::text as unread_count
      from platform.notifications as notification
      where notification.recipient_actor_id = ${recipientActorId}
        and notification.read_at is null
    `;
    const row = rows[0];
    if (!row) {
      throw new NotificationError(
        "NOTIFICATION_DATA_INVALID",
        "The notification unread count is invalid.",
      );
    }
    return positiveSafeInteger(row.unread_count, "unread_count");
  }

  #expiresAt(): Date {
    const now = this.#now();
    return new Date(now.valueOf() + this.#cursorTtlSeconds * 1_000);
  }

  #now(): Date {
    const now = this.#clock();
    if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
      throw new Error("The Notification clock returned an invalid Date.");
    }
    return new Date(now.valueOf());
  }

  #snapshotId(
    recipientActorId: string,
    binding: string,
    asOf: Date,
    highWater: string,
  ): string {
    return `nts_${createHmac("sha256", this.#cursorSigningKey)
      .update(SNAPSHOT_ID_DOMAIN, "utf8")
      .update("\0", "utf8")
      .update(recipientActorId, "utf8")
      .update("\0", "utf8")
      .update(binding, "utf8")
      .update("\0", "utf8")
      .update(asOf.toISOString(), "utf8")
      .update("\0", "utf8")
      .update(highWater, "utf8")
      .digest("base64url")}`;
  }

  #pollCursor(
    recipientActorId: string,
    binding: string,
    lastChangeSequence: string,
    window: {
      expiresAt: Date;
      upperChangeSequence: string;
      windowAsOf: Date;
    } | null = null,
  ): string {
    return this.#signCursor("npc", {
      binding,
      expiresAt: (window?.expiresAt ?? this.#expiresAt()).toISOString(),
      kind: "notification_poll",
      lastChangeSequence: decimal(lastChangeSequence, "last_change_sequence"),
      recipientActorId,
      upperChangeSequence:
        window === null
          ? null
          : decimal(window.upperChangeSequence, "upper_change_sequence"),
      v: 1,
      windowAsOf: window?.windowAsOf.toISOString() ?? null,
    } satisfies PollCursorPayload);
  }

  #signCursor(prefix: "nhc" | "npc", payload: object): string {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#cursorSigningKey)
      .update(CURSOR_SIGNATURE_DOMAIN, "utf8")
      .update("\0", "utf8")
      .update(prefix, "utf8")
      .update("\0", "utf8")
      .update(body, "utf8")
      .digest("base64url");
    const cursor = `${prefix}_${body}.${signature}`;
    if (cursor.length > MAXIMUM_CURSOR_LENGTH) {
      throw new NotificationError(
        "NOTIFICATION_DATA_INVALID",
        "The generated Notification cursor exceeded its safety budget.",
      );
    }
    return cursor;
  }

  #verifyCursor(value: string, prefix: "nhc" | "npc"): unknown {
    if (!value.startsWith(`${prefix}_`) || value.length > MAXIMUM_CURSOR_LENGTH) {
      throw new NotificationError(
        "CURSOR_INVALID",
        "The notification cursor is invalid.",
      );
    }
    const [body, signature, extra] = value.slice(prefix.length + 1).split(".");
    if (!body || !signature || extra !== undefined) {
      throw new NotificationError(
        "CURSOR_INVALID",
        "The notification cursor is invalid.",
      );
    }
    const expected = createHmac("sha256", this.#cursorSigningKey)
      .update(CURSOR_SIGNATURE_DOMAIN, "utf8")
      .update("\0", "utf8")
      .update(prefix, "utf8")
      .update("\0", "utf8")
      .update(body, "utf8")
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      throw new NotificationError(
        "CURSOR_INVALID",
        "The notification cursor is invalid.",
      );
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new NotificationError(
        "CURSOR_INVALID",
        "The notification cursor is invalid.",
      );
    }
    return decodeJson(body);
  }

  #parseHistoryCursor(
    value: string,
    recipientActorId: string,
    binding: string,
  ): HistoryCursorPayload {
    const payload = this.#verifyCursor(value, "nhc");
    if (
      !isHistoryCursorPayload(payload) ||
      payload.recipientActorId !== recipientActorId ||
      payload.binding !== binding
    ) {
      throw new NotificationError(
        "CURSOR_INVALID",
        "The notification cursor is invalid.",
      );
    }
    const asOf = copyDate(payload.asOf, "CURSOR_INVALID");
    const expiresAt = copyDate(payload.expiresAt, "CURSOR_INVALID");
    const lastCreatedAt = copyDate(payload.last.createdAt, "CURSOR_INVALID");
    if (
      lastCreatedAt > asOf ||
      expiresAt <= asOf ||
      BigInt(payload.createdHighWater) > BigInt(payload.changeHighWater)
    ) {
      throw new NotificationError(
        "CURSOR_INVALID",
        "The notification cursor is invalid.",
      );
    }
    if (this.#now() >= expiresAt) {
      throw new NotificationError(
        "CURSOR_EXPIRED",
        "The notification cursor has expired.",
      );
    }
    return payload;
  }

  #parsePollCursor(
    value: string,
    recipientActorId: string,
    binding: string,
  ): PollCursorPayload {
    const payload = this.#verifyCursor(value, "npc");
    if (
      !isPollCursorPayload(payload) ||
      payload.recipientActorId !== recipientActorId ||
      payload.binding !== binding
    ) {
      throw new NotificationError(
        "CURSOR_INVALID",
        "The notification cursor is invalid.",
      );
    }
    const expiresAt = copyDate(payload.expiresAt, "CURSOR_INVALID");
    if (
      (payload.upperChangeSequence === null) !== (payload.windowAsOf === null) ||
      (payload.upperChangeSequence !== null &&
        BigInt(payload.lastChangeSequence) > BigInt(payload.upperChangeSequence))
    ) {
      throw new NotificationError(
        "CURSOR_INVALID",
        "The notification cursor is invalid.",
      );
    }
    if (payload.windowAsOf !== null) {
      copyDate(payload.windowAsOf, "CURSOR_INVALID");
    }
    if (this.#now() >= expiresAt) {
      throw new NotificationError(
        "CURSOR_EXPIRED",
        "The notification cursor has expired.",
      );
    }
    return payload;
  }
}
