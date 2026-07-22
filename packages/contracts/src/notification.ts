import { z } from "zod";

import { AgentHandleSchema, TimestampSchema, V1EnvelopeShape } from "./agent.ts";
import {
  OpaqueCursorSchema,
  OpaqueIdSchema,
  OrderingSnapshotSchema,
  SymbolSchema,
} from "./community.ts";
import {
  ContentAuthorProjectionSchema,
  MatchedFollowSchema,
  ReactionTypeSchema,
} from "./content.ts";

export const NOTIFICATION_SCHEMA_VERSION = "notification-v1" as const;
export const NOTIFICATION_HISTORY_ORDERING_VERSION =
  "notifications-created-at-v1" as const;
export const NOTIFICATION_INCREMENTAL_ORDERING_VERSION =
  "notifications-recipient-change-sequence-v1" as const;

const uniqueArray = <T>(values: readonly T[]) => new Set(values).size === values.length;

export const NotificationTypeSchema = z.enum([
  "content.published",
  "content.reply",
  "content.mention",
  "reaction.changed",
  "follow.started",
  "content.revised",
  "moderation.changed",
  "action.pending_approval",
  "action.resolved",
]);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

export const NotificationResourceTypeSchema = z.enum([
  "content",
  "actor",
  "community",
  "pending_action",
]);
export type NotificationResourceType = z.infer<typeof NotificationResourceTypeSchema>;

export const NotificationTriggerActorSchema = ContentAuthorProjectionSchema;
export type NotificationTriggerActor = z.infer<typeof NotificationTriggerActorSchema>;

export const NotificationObjectSchema = z
  .object({
    type: NotificationResourceTypeSchema,
    id: OpaqueIdSchema,
  })
  .strict();
export type NotificationObject = z.infer<typeof NotificationObjectSchema>;

export const NotificationContextSchema = z
  .object({
    symbols: z
      .array(SymbolSchema)
      .max(20)
      .refine(uniqueArray, "Notification symbols must be unique.")
      .optional(),
    community_ids: z
      .array(OpaqueIdSchema)
      .max(5)
      .refine(uniqueArray, "Notification community IDs must be unique.")
      .optional(),
    matched_follow: MatchedFollowSchema.optional(),
    additional_matched_follow_ids: z
      .array(OpaqueIdSchema)
      .max(40)
      .refine(uniqueArray, "Additional matched Follow IDs must be unique.")
      .optional(),
    root_content_id: OpaqueIdSchema.optional(),
    parent_content_id: OpaqueIdSchema.optional(),
    revision_id: OpaqueIdSchema.optional(),
    reaction_type: ReactionTypeSchema.optional(),
    reaction_window_started_at: TimestampSchema.optional(),
    reaction_window_ends_at: TimestampSchema.optional(),
    recent_trigger_handles: z
      .array(AgentHandleSchema)
      .max(3)
      .refine(uniqueArray, "Recent trigger handles must be unique.")
      .optional(),
  })
  .strict()
  .superRefine((notificationContext, context) => {
    const reactionWindowFields = [
      notificationContext.reaction_type,
      notificationContext.reaction_window_started_at,
      notificationContext.reaction_window_ends_at,
    ];
    const hasReactionWindow = reactionWindowFields.some((value) => value !== undefined);
    const hasCompleteReactionWindow = reactionWindowFields.every(
      (value) => value !== undefined,
    );
    if (hasReactionWindow && !hasCompleteReactionWindow) {
      context.addIssue({
        code: "custom",
        path: ["reaction_window_started_at"],
        message:
          "Reaction context requires reaction_type and both aggregation-window timestamps.",
      });
    }
    if (
      notificationContext.reaction_window_started_at !== undefined &&
      notificationContext.reaction_window_ends_at !== undefined &&
      Date.parse(notificationContext.reaction_window_started_at) >=
        Date.parse(notificationContext.reaction_window_ends_at)
    ) {
      context.addIssue({
        code: "custom",
        path: ["reaction_window_ends_at"],
        message: "The reaction aggregation window must end after it starts.",
      });
    }
    if (
      notificationContext.additional_matched_follow_ids !== undefined &&
      notificationContext.matched_follow === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["additional_matched_follow_ids"],
        message: "Additional Follow matches require one primary matched_follow.",
      });
    }
  });
export type NotificationContext = z.infer<typeof NotificationContextSchema>;

const StableWebPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^\/[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/u,
    "Stable notification paths may contain only stable path segments.",
  );

export const NotificationStableTargetSchema = z
  .object({
    resource_type: NotificationResourceTypeSchema,
    resource_id: OpaqueIdSchema,
    web_path: StableWebPathSchema,
  })
  .strict()
  .superRefine((target, context) => {
    const finalSegment = target.web_path.split("/").at(-1);
    if (finalSegment !== target.resource_id) {
      context.addIssue({
        code: "custom",
        path: ["web_path"],
        message: "A stable target path must end with its stable resource ID.",
      });
    }
  });
export type NotificationStableTarget = z.infer<typeof NotificationStableTargetSchema>;

export const NotificationSchemaVersionSchema = z.literal(NOTIFICATION_SCHEMA_VERSION);

const NotificationSummarySchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) => value.trim() === value && !/\p{Cc}/u.test(value),
    "Notification summaries must be trimmed template text without control characters.",
  );

const NotificationDedupeKeySchema = z
  .string()
  .min(1)
  .max(1_000)
  .refine(
    (value) => value.trim() === value && !/\p{Cc}/u.test(value),
    "Notification dedupe keys must be trimmed and cannot contain control characters.",
  );

const NotificationProjectionCommonShape = {
  id: OpaqueIdSchema,
  recipient_actor_id: OpaqueIdSchema,
  trigger_actor: NotificationTriggerActorSchema.nullable(),
  object: NotificationObjectSchema,
  context: NotificationContextSchema,
  summary: NotificationSummarySchema,
  stable_target: NotificationStableTargetSchema,
  version: z.number().int().positive().safe(),
  occurred_at: TimestampSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  read_at: TimestampSchema.nullable(),
  dedupe_key: NotificationDedupeKeySchema,
  schema_version: NotificationSchemaVersionSchema,
} as const;

const NonAggregateNotificationTypeSchema = NotificationTypeSchema.exclude([
  "reaction.changed",
]);

const NonAggregateNotificationProjectionSchema = z
  .object({
    ...NotificationProjectionCommonShape,
    type: NonAggregateNotificationTypeSchema,
  })
  .strict();

const AggregateNotificationProjectionSchema = z
  .object({
    ...NotificationProjectionCommonShape,
    type: z.literal("reaction.changed"),
    last_occurred_at: TimestampSchema,
    distinct_actor_count: z.number().int().nonnegative().safe(),
    distinct_actor_counts_by_kind: z
      .object({
        agent: z.number().int().nonnegative().safe(),
        human: z.number().int().nonnegative().safe(),
      })
      .strict(),
  })
  .strict();

const resourceTypesByNotificationType = {
  "content.published": new Set<NotificationResourceType>(["content"]),
  "content.reply": new Set<NotificationResourceType>(["content"]),
  "content.mention": new Set<NotificationResourceType>(["content"]),
  "reaction.changed": new Set<NotificationResourceType>(["content"]),
  "follow.started": new Set<NotificationResourceType>(["actor"]),
  "content.revised": new Set<NotificationResourceType>(["content"]),
  "moderation.changed": new Set<NotificationResourceType>(["content", "community"]),
  "action.pending_approval": new Set<NotificationResourceType>(["pending_action"]),
  "action.resolved": new Set<NotificationResourceType>(["pending_action"]),
} as const satisfies Record<NotificationType, ReadonlySet<NotificationResourceType>>;

export const NotificationProjectionSchema = z
  .union([
    NonAggregateNotificationProjectionSchema,
    AggregateNotificationProjectionSchema,
  ])
  .superRefine((notification, context) => {
    if (
      !resourceTypesByNotificationType[notification.type].has(notification.object.type)
    ) {
      context.addIssue({
        code: "custom",
        path: ["object", "type"],
        message: "The notification object type is invalid for this notification type.",
      });
    }
    if (
      notification.stable_target.resource_type !== notification.object.type ||
      notification.stable_target.resource_id !== notification.object.id
    ) {
      context.addIssue({
        code: "custom",
        path: ["stable_target"],
        message: "stable_target must identify the notification object exactly.",
      });
    }
    if (Date.parse(notification.updated_at) < Date.parse(notification.created_at)) {
      context.addIssue({
        code: "custom",
        path: ["updated_at"],
        message: "updated_at cannot precede created_at.",
      });
    }
    if (
      notification.read_at !== null &&
      Date.parse(notification.read_at) < Date.parse(notification.created_at)
    ) {
      context.addIssue({
        code: "custom",
        path: ["read_at"],
        message: "read_at cannot precede created_at.",
      });
    }

    const hasReactionContext = notification.context.reaction_type !== undefined;
    if (notification.type === "reaction.changed") {
      if (!hasReactionContext) {
        context.addIssue({
          code: "custom",
          path: ["context", "reaction_type"],
          message: "Aggregated reaction notifications require reaction context.",
        });
      }
      if (
        notification.distinct_actor_counts_by_kind.agent +
          notification.distinct_actor_counts_by_kind.human !==
        notification.distinct_actor_count
      ) {
        context.addIssue({
          code: "custom",
          path: ["distinct_actor_counts_by_kind"],
          message: "Actor-kind counts must sum to distinct_actor_count.",
        });
      }
      if (
        Date.parse(notification.last_occurred_at) < Date.parse(notification.occurred_at)
      ) {
        context.addIssue({
          code: "custom",
          path: ["last_occurred_at"],
          message: "last_occurred_at cannot precede occurred_at.",
        });
      }
    } else if (hasReactionContext) {
      context.addIssue({
        code: "custom",
        path: ["context", "reaction_type"],
        message: "Only reaction.changed notifications may contain reaction context.",
      });
    }
  });
export type NotificationProjection = z.infer<typeof NotificationProjectionSchema>;

/** History cursors are snapshot/keyset cursors and can never be poll cursors. */
export const NotificationHistoryCursorSchema = OpaqueCursorSchema.refine(
  (value) => value.startsWith("cur_") || value.startsWith("nhc_"),
  "Notification history cursors must use the cur_ or nhc_ namespace.",
);
export type NotificationHistoryCursor = z.infer<typeof NotificationHistoryCursorSchema>;

/** Poll cursors bind recipient, change sequence, filters, and expiry. */
export const NotificationPollCursorSchema = OpaqueCursorSchema.refine(
  (value) => value.startsWith("npc_"),
  "Notification poll cursors must use the npc_ namespace.",
);
export type NotificationPollCursor = z.infer<typeof NotificationPollCursorSchema>;

const NotificationListFilterShape = {
  types: z
    .array(NotificationTypeSchema)
    .min(1)
    .max(NotificationTypeSchema.options.length)
    .refine(uniqueArray, "Notification types must be unique.")
    .optional(),
  unread_only: z.boolean().optional(),
  symbols: z
    .array(SymbolSchema)
    .min(1)
    .max(10)
    .refine(uniqueArray, "Notification symbols must be unique.")
    .optional(),
  community_ids: z
    .array(OpaqueIdSchema)
    .min(1)
    .max(5)
    .refine(uniqueArray, "Notification community IDs must be unique.")
    .optional(),
  following_only: z.boolean().optional(),
  created_after: TimestampSchema.optional(),
  created_before: TimestampSchema.optional(),
} as const;

type NotificationListFilterTimes = {
  created_after?: string | undefined;
  created_before?: string | undefined;
};

function validateNotificationFilterTimes(
  filters: NotificationListFilterTimes,
  context: z.RefinementCtx,
): void {
  if (
    filters.created_after !== undefined &&
    filters.created_before !== undefined &&
    Date.parse(filters.created_after) >= Date.parse(filters.created_before)
  ) {
    context.addIssue({
      code: "custom",
      path: ["created_before"],
      message: "created_before must be later than created_after.",
    });
  }
}

export const NotificationListFiltersSchema = z
  .object(NotificationListFilterShape)
  .strict()
  .superRefine(validateNotificationFilterTimes);
export type NotificationListFilters = z.infer<typeof NotificationListFiltersSchema>;

export const NotificationHistoryListRequestSchema = z
  .object({
    ...NotificationListFilterShape,
    limit: z.number().int().min(1).max(100).optional(),
    cursor: NotificationHistoryCursorSchema.nullable().optional(),
  })
  .strict()
  .superRefine(validateNotificationFilterTimes);
export type NotificationHistoryListRequest = z.infer<
  typeof NotificationHistoryListRequestSchema
>;

export const NotificationIncrementalListRequestSchema = z
  .object({
    ...NotificationListFilterShape,
    limit: z.number().int().min(1).max(100).optional(),
    poll_cursor: NotificationPollCursorSchema,
  })
  .strict()
  .superRefine(validateNotificationFilterTimes);
export type NotificationIncrementalListRequest = z.infer<
  typeof NotificationIncrementalListRequestSchema
>;

export const ListNotificationsRequestSchema = z.union([
  NotificationHistoryListRequestSchema,
  NotificationIncrementalListRequestSchema,
]);
export type ListNotificationsRequest = z.infer<typeof ListNotificationsRequestSchema>;

export const NotificationHistoryPageSchema = z
  .object({
    next_cursor: NotificationHistoryCursorSchema.nullable(),
    has_more: z.boolean(),
    limit: z.number().int().min(1).max(100),
  })
  .strict()
  .superRefine((page, context) => {
    if (page.has_more !== (page.next_cursor !== null)) {
      context.addIssue({
        code: "custom",
        path: ["next_cursor"],
        message: "A history cursor is required exactly when has_more is true.",
      });
    }
  });
export type NotificationHistoryPage = z.infer<typeof NotificationHistoryPageSchema>;

export const NotificationPollStateSchema = z
  .object({
    next_cursor: NotificationPollCursorSchema,
    has_more: z.boolean(),
  })
  .strict();
export type NotificationPollState = z.infer<typeof NotificationPollStateSchema>;

export const NotificationHistoryOrderingSchema = OrderingSnapshotSchema.extend({
  ordering_version: z.literal(NOTIFICATION_HISTORY_ORDERING_VERSION),
}).strict();

export const NotificationIncrementalOrderingSchema = OrderingSnapshotSchema.extend({
  ordering_version: z.literal(NOTIFICATION_INCREMENTAL_ORDERING_VERSION),
}).strict();

type NotificationListResponseForValidation = {
  filters: NotificationListFilters;
  items: NotificationProjection[];
};

function validateNotificationListItems(
  response: NotificationListResponseForValidation,
  context: z.RefinementCtx,
): void {
  const notificationIds = new Set<string>();
  const recipientIds = new Set<string>();
  for (const [index, notification] of response.items.entries()) {
    if (notificationIds.has(notification.id)) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "id"],
        message: "A notification list page cannot repeat a notification ID.",
      });
    }
    notificationIds.add(notification.id);
    recipientIds.add(notification.recipient_actor_id);

    const filters = response.filters;
    if (filters.types !== undefined && !filters.types.includes(notification.type)) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "type"],
        message: "A notification item does not satisfy the normalized type filter.",
      });
    }
    if (filters.unread_only === true && notification.read_at !== null) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "read_at"],
        message: "Unread-only notification results cannot contain read items.",
      });
    }
    if (
      filters.symbols !== undefined &&
      !filters.symbols.some((symbol) => notification.context.symbols?.includes(symbol))
    ) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "context", "symbols"],
        message: "A notification item does not satisfy the normalized symbol filter.",
      });
    }
    if (
      filters.community_ids !== undefined &&
      !filters.community_ids.some((communityId) =>
        notification.context.community_ids?.includes(communityId),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "context", "community_ids"],
        message: "A notification item does not satisfy the normalized community filter.",
      });
    }
    if (
      filters.following_only === true &&
      notification.context.matched_follow === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "context", "matched_follow"],
        message: "Following-only results require a matched Follow projection.",
      });
    }
    if (
      filters.created_after !== undefined &&
      Date.parse(notification.created_at) <= Date.parse(filters.created_after)
    ) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "created_at"],
        message: "A notification item does not satisfy created_after.",
      });
    }
    if (
      filters.created_before !== undefined &&
      Date.parse(notification.created_at) >= Date.parse(filters.created_before)
    ) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "created_at"],
        message: "A notification item does not satisfy created_before.",
      });
    }
  }
  if (recipientIds.size > 1) {
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: "One notification list response cannot mix recipient Actors.",
    });
  }
}

export const NotificationHistoryListResponseSchema = z
  .object({
    mode: z.literal("history"),
    filters: NotificationListFiltersSchema,
    items: z.array(NotificationProjectionSchema).max(100),
    page: NotificationHistoryPageSchema,
    poll: NotificationPollStateSchema.extend({ has_more: z.literal(false) }).strict(),
    ordering: NotificationHistoryOrderingSchema,
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine((response, context) => {
    validateNotificationListItems(response, context);
    if (response.items.length > response.page.limit) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "A history page cannot contain more items than its declared limit.",
      });
    }
    for (const [index, notification] of response.items.entries()) {
      const previous = response.items[index - 1];
      if (previous === undefined) continue;
      const previousTime = Date.parse(previous.created_at);
      const currentTime = Date.parse(notification.created_at);
      if (
        previousTime < currentTime ||
        (previousTime === currentTime && previous.id <= notification.id)
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "History items must use created_at and id descending order.",
        });
      }
    }
  });
export type NotificationHistoryListResponse = z.infer<
  typeof NotificationHistoryListResponseSchema
>;

export const NotificationIncrementalListResponseSchema = z
  .object({
    mode: z.literal("incremental"),
    filters: NotificationListFiltersSchema,
    items: z.array(NotificationProjectionSchema).max(100),
    page: z.null(),
    poll: NotificationPollStateSchema,
    ordering: NotificationIncrementalOrderingSchema,
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine(validateNotificationListItems);
export type NotificationIncrementalListResponse = z.infer<
  typeof NotificationIncrementalListResponseSchema
>;

export const ListNotificationsResponseSchema = z.union([
  NotificationHistoryListResponseSchema,
  NotificationIncrementalListResponseSchema,
]);
export type ListNotificationsResponse = z.infer<typeof ListNotificationsResponseSchema>;

export const MarkNotificationReadRequestSchema = z
  .object({ notification_id: OpaqueIdSchema })
  .strict();
export type MarkNotificationReadRequest = z.infer<
  typeof MarkNotificationReadRequestSchema
>;

export const MarkNotificationReadResponseSchema = z
  .object({
    changed: z.boolean(),
    notification: NotificationProjectionSchema,
    unread_count: z.number().int().nonnegative().safe(),
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine((response, context) => {
    if (response.notification.read_at === null) {
      context.addIssue({
        code: "custom",
        path: ["notification", "read_at"],
        message: "A mark-read response must project the notification as read.",
      });
    }
  });
export type MarkNotificationReadResponse = z.infer<
  typeof MarkNotificationReadResponseSchema
>;

export const MarkAllNotificationsReadRequestSchema = z.object({}).strict();
export type MarkAllNotificationsReadRequest = z.infer<
  typeof MarkAllNotificationsReadRequestSchema
>;

export const MarkAllNotificationsReadResponseSchema = z
  .object({
    read_at: TimestampSchema,
    marked_count: z.number().int().nonnegative().safe(),
    unread_count: z.number().int().nonnegative().safe(),
    ...V1EnvelopeShape,
  })
  .strict();
export type MarkAllNotificationsReadResponse = z.infer<
  typeof MarkAllNotificationsReadResponseSchema
>;

export const ReadAllNotificationsRequestSchema = MarkAllNotificationsReadRequestSchema;
export type ReadAllNotificationsRequest = MarkAllNotificationsReadRequest;
export const ReadAllNotificationsResponseSchema = MarkAllNotificationsReadResponseSchema;
export type ReadAllNotificationsResponse = MarkAllNotificationsReadResponse;
