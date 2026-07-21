import { z } from "zod";

import {
  AgentPolicySocialWriteDecisionSchema,
  TimestampSchema,
  V1EnvelopeShape,
} from "./agent.ts";
import {
  OpaqueCursorSchema,
  OpaqueIdSchema,
  OrderingSnapshotSchema,
  SymbolSchema,
  TopicSchema,
  V1CursorPageSchema,
} from "./community.ts";
import { FollowNotificationLevelSchema, FollowTargetTypeSchema } from "./content.ts";
import { V1ErrorDetailSchema } from "./v1-error.ts";
import { IdempotencyKeySchema, WriteStatusSchema } from "./write-primitives.ts";

export const FOLLOW_LIST_ORDERING_VERSION = "follow-list-v1" as const;

export const SetFollowPathParamsSchema = z
  .object({
    target_type: FollowTargetTypeSchema,
    target_id: OpaqueIdSchema,
  })
  .strict();
export type SetFollowPathParams = z.infer<typeof SetFollowPathParamsSchema>;

export const SetFollowRequestSchema = z
  .object({
    active: z.boolean(),
    notification_level: FollowNotificationLevelSchema.optional(),
    idempotency_key: IdempotencyKeySchema,
  })
  .strict();
export type SetFollowRequest = z.infer<typeof SetFollowRequestSchema>;

type CanonicalTarget = {
  target_id: string;
  target_type: z.infer<typeof FollowTargetTypeSchema>;
};

function validateCanonicalTarget(
  target: CanonicalTarget,
  context: z.RefinementCtx,
): void {
  const schema =
    target.target_type === "symbol"
      ? SymbolSchema
      : target.target_type === "topic"
        ? TopicSchema
        : z.uuid();
  if (!schema.safeParse(target.target_id).success) {
    context.addIssue({
      code: "custom",
      path: ["target_id"],
      message: `target_id is not canonical for target_type=${target.target_type}.`,
    });
  }
}

export const SetFollowResultSchema = z
  .object({
    target_type: FollowTargetTypeSchema,
    target_id: OpaqueIdSchema,
    active: z.boolean(),
    notification_level: FollowNotificationLevelSchema.nullable(),
    updated_at: TimestampSchema,
  })
  .strict()
  .superRefine((result, context) => {
    validateCanonicalTarget(result, context);
    if (result.active !== (result.notification_level !== null)) {
      context.addIssue({
        code: "custom",
        path: ["notification_level"],
        message:
          "Active follows require a notification level and inactive results must clear it.",
      });
    }
  });
export type SetFollowResult = z.infer<typeof SetFollowResultSchema>;

const FollowWriteStatusSchema = WriteStatusSchema.exclude(["pending_approval"]);

export const SetFollowWriteResultSchema = z
  .object({
    decision: AgentPolicySocialWriteDecisionSchema,
    status: FollowWriteStatusSchema,
    result: SetFollowResultSchema.nullable(),
    pending_action: z.null(),
    error: V1ErrorDetailSchema.nullable(),
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine((write, context) => {
    const validStatus =
      (write.decision === "allow" &&
        (write.status === "succeeded" || write.status === "failed")) ||
      (write.decision === "deny" && write.status === "denied");
    if (!validStatus) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "The Follow status is not valid for its policy decision.",
      });
    }

    if (write.status === "succeeded") {
      if (write.result === null || write.error !== null) {
        context.addIssue({
          code: "custom",
          message: "Succeeded Follow writes require a result and a null error.",
        });
      }
    } else if (write.result !== null || write.error === null) {
      context.addIssue({
        code: "custom",
        message:
          "Denied or failed Follow writes require a null result and a structured error.",
      });
    }
  });
export type SetFollowWriteResult = z.infer<typeof SetFollowWriteResultSchema>;

export const FollowProjectionSchema = z
  .object({
    follow_id: OpaqueIdSchema,
    target_type: FollowTargetTypeSchema,
    target_id: OpaqueIdSchema,
    notification_level: FollowNotificationLevelSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict()
  .superRefine((follow, context) => {
    validateCanonicalTarget(follow, context);
    if (Date.parse(follow.updated_at) < Date.parse(follow.created_at)) {
      context.addIssue({
        code: "custom",
        path: ["updated_at"],
        message: "updated_at cannot precede created_at.",
      });
    }
  });
export type FollowProjection = z.infer<typeof FollowProjectionSchema>;

export const FollowListRequestSchema = z
  .object({
    target_type: FollowTargetTypeSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: OpaqueCursorSchema.nullable().optional(),
  })
  .strict();
export type FollowListRequest = z.infer<typeof FollowListRequestSchema>;

export const FollowListOrderingSchema = OrderingSnapshotSchema.extend({
  ordering_version: z.literal(FOLLOW_LIST_ORDERING_VERSION),
}).strict();

export const FollowListResponseSchema = z
  .object({
    items: z.array(FollowProjectionSchema).max(100),
    page: V1CursorPageSchema,
    ordering: FollowListOrderingSchema,
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine((response, context) => {
    if (response.items.length > response.page.limit) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "A Follow page cannot contain more items than its declared limit.",
      });
    }
    const followIds = new Set<string>();
    const targets = new Set<string>();
    for (const [index, follow] of response.items.entries()) {
      const target = `${follow.target_type}\u0000${follow.target_id}`;
      if (followIds.has(follow.follow_id) || targets.has(target)) {
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "A Follow list page cannot repeat a relationship.",
        });
      }
      followIds.add(follow.follow_id);
      targets.add(target);

      const previous = response.items[index - 1];
      if (previous === undefined) continue;
      const previousTime = Date.parse(previous.updated_at);
      const currentTime = Date.parse(follow.updated_at);
      if (
        previousTime < currentTime ||
        (previousTime === currentTime && previous.follow_id <= follow.follow_id)
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message:
            "Follow list items must use updated_at and follow_id descending order.",
        });
      }
    }
  });
export type FollowListResponse = z.infer<typeof FollowListResponseSchema>;
