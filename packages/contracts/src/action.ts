import { z } from "zod";

import { PolicyDecisionSchema, TimestampSchema, V1EnvelopeShape } from "./agent.ts";
import { OpaqueIdSchema } from "./community.ts";
import {
  ContentLifecycleStateSchema,
  ReactionCountsSchema,
  ViewerContentStateSchema,
} from "./content.ts";
import { SetFollowResultSchema } from "./follow.ts";
import {
  ContentWriteOperationSchema,
  CreatePostResultSchema,
  PendingActionStateSchema,
  ReplyToContentResultSchema,
  WriteStatusSchema,
} from "./content-write.ts";

export const GetActionStatusRequestSchema = z
  .object({
    action_id: OpaqueIdSchema,
  })
  .strict();
export type GetActionStatusRequest = z.infer<typeof GetActionStatusRequestSchema>;

export const PendingActionApprovalOutcomeSchema = z.enum([
  "approved",
  "rejected",
  "expired",
  "cancelled",
  "invalidated",
]);
export type PendingActionApprovalOutcome = z.infer<
  typeof PendingActionApprovalOutcomeSchema
>;

export const PendingActionApprovalMethodSchema = z.literal("owner_approval");
export type PendingActionApprovalMethod = z.infer<
  typeof PendingActionApprovalMethodSchema
>;

function terminalActionError<const Code extends string, const Message extends string>(
  code: Code,
  message: Message,
) {
  return z
    .object({
      code: z.literal(code),
      message: z.literal(message),
      retryable: z.literal(false),
      details: z.null(),
      retry_after_ms: z.null(),
    })
    .strict();
}

export const PendingActionPublicErrorSchema = z.union([
  terminalActionError("ACTION_REJECTED", "The Owner rejected this action."),
  terminalActionError(
    "ACTION_EXPIRED",
    "The action expired before it could be completed.",
  ),
  terminalActionError("ACTION_CANCELLED", "The action was cancelled."),
  terminalActionError(
    "ACTION_EXECUTION_FAILED",
    "The approved action could not be completed.",
  ),
  terminalActionError("ACTION_INVALIDATED", "The frozen action is no longer valid."),
]);
export type PendingActionPublicError = z.infer<typeof PendingActionPublicErrorSchema>;

export const UpdateContentActionResultSchema = z
  .object({
    content_id: OpaqueIdSchema,
    revision_id: OpaqueIdSchema.nullable(),
    resource_version: z.number().int().positive(),
  })
  .strict();
export type UpdateContentActionResult = z.infer<typeof UpdateContentActionResultSchema>;

export const DeleteContentActionResultSchema = z
  .object({
    content_id: OpaqueIdSchema,
    lifecycle_state: ContentLifecycleStateSchema.extract(["deleted"]),
    resource_version: z.number().int().positive(),
  })
  .strict();
export type DeleteContentActionResult = z.infer<typeof DeleteContentActionResultSchema>;

export const SetReactionActionResultSchema = z
  .object({
    content_id: OpaqueIdSchema,
    viewer_state: ViewerContentStateSchema,
    reaction_counts: ReactionCountsSchema,
  })
  .strict();
export type SetReactionActionResult = z.infer<typeof SetReactionActionResultSchema>;

export const SetFollowActionResultSchema = SetFollowResultSchema;
export type SetFollowActionResult = z.infer<typeof SetFollowActionResultSchema>;

const PendingActionProjectionCommonShape = {
  id: OpaqueIdSchema,
  decision: PolicyDecisionSchema.extract(["require_approval"]),
  status: WriteStatusSchema,
  state: PendingActionStateSchema,
  decision_id: OpaqueIdSchema,
  policy_version: z.string().min(1),
  requested_at: TimestampSchema,
  expires_at: TimestampSchema,
  decided_at: TimestampSchema.nullable(),
  executing_at: TimestampSchema.nullable(),
  completed_at: TimestampSchema.nullable(),
  terminal_at: TimestampSchema.nullable(),
  input_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  approval_summary: z
    .string()
    .min(1)
    .max(2_000)
    .refine((value) => value.trim() === value && !/\p{Cc}/u.test(value)),
  approval_outcome: PendingActionApprovalOutcomeSchema.nullable(),
  approval_method: PendingActionApprovalMethodSchema.nullable(),
  decided_by_owner_id: OpaqueIdSchema.nullable(),
  error: PendingActionPublicErrorSchema.nullable(),
} as const;

const PendingActionProjectionBaseSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...PendingActionProjectionCommonShape,
      operation: z.literal("create_post"),
      result: CreatePostResultSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...PendingActionProjectionCommonShape,
      operation: z.literal("reply_to_content"),
      result: ReplyToContentResultSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...PendingActionProjectionCommonShape,
      operation: z.literal("update_content"),
      result: UpdateContentActionResultSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...PendingActionProjectionCommonShape,
      operation: z.literal("delete_content"),
      result: DeleteContentActionResultSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...PendingActionProjectionCommonShape,
      operation: z.literal("set_reaction"),
      result: SetReactionActionResultSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...PendingActionProjectionCommonShape,
      operation: z.literal("set_follow"),
      result: SetFollowActionResultSchema.nullable(),
    })
    .strict(),
]);

type PendingActionState = z.infer<typeof PendingActionStateSchema>;
type WriteStatus = z.infer<typeof WriteStatusSchema>;
type ApprovalOutcome = z.infer<typeof PendingActionApprovalOutcomeSchema>;

const terminalStates = new Set<PendingActionState>([
  "succeeded",
  "rejected",
  "expired",
  "cancelled",
  "failed",
  "invalidated",
]);

const statusByState = {
  pending_approval: "pending_approval",
  approved: "pending_approval",
  executing: "pending_approval",
  succeeded: "succeeded",
  rejected: "denied",
  expired: "denied",
  cancelled: "denied",
  failed: "failed",
  invalidated: "failed",
} as const satisfies Record<PendingActionState, WriteStatus>;

const approvalOutcomesByState = {
  pending_approval: new Set<ApprovalOutcome | null>([null]),
  approved: new Set<ApprovalOutcome | null>(["approved"]),
  executing: new Set<ApprovalOutcome | null>(["approved"]),
  succeeded: new Set<ApprovalOutcome | null>(["approved"]),
  rejected: new Set<ApprovalOutcome | null>(["rejected"]),
  expired: new Set<ApprovalOutcome | null>(["expired", "approved"]),
  cancelled: new Set<ApprovalOutcome | null>(["cancelled", "approved"]),
  failed: new Set<ApprovalOutcome | null>(["approved"]),
  invalidated: new Set<ApprovalOutcome | null>(["invalidated", "approved"]),
} as const satisfies Record<PendingActionState, ReadonlySet<ApprovalOutcome | null>>;

const publicErrorCodeByState: Partial<
  Record<PendingActionState, PendingActionPublicError["code"]>
> = {
  rejected: "ACTION_REJECTED",
  expired: "ACTION_EXPIRED",
  cancelled: "ACTION_CANCELLED",
  failed: "ACTION_EXECUTION_FAILED",
  invalidated: "ACTION_INVALIDATED",
};

function milliseconds(timestamp: string): number {
  return Date.parse(timestamp);
}

export const PendingActionProjectionSchema =
  PendingActionProjectionBaseSchema.superRefine((action, context) => {
    if (!ContentWriteOperationSchema.safeParse(action.operation).success) {
      context.addIssue({
        code: "custom",
        path: ["operation"],
        message: "PendingAction operation is not a supported Agent write.",
      });
    }

    if (action.status !== statusByState[action.state]) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "The write status must reflect the current PendingAction state.",
      });
    }

    const isTerminal = terminalStates.has(action.state);
    if (isTerminal !== (action.terminal_at !== null)) {
      context.addIssue({
        code: "custom",
        path: ["terminal_at"],
        message:
          "terminal_at must be present for every terminal state and null otherwise.",
      });
    }

    const completedByExecution =
      action.state === "succeeded" || action.state === "failed";
    if (completedByExecution !== (action.completed_at !== null)) {
      context.addIssue({
        code: "custom",
        path: ["completed_at"],
        message:
          "completed_at is required exactly when an execution path succeeded or failed.",
      });
    }

    if (action.state === "executing" && action.executing_at === null) {
      context.addIssue({
        code: "custom",
        path: ["executing_at"],
        message: "An executing action cannot have a null executing_at.",
      });
    }
    if (
      action.state !== "executing" &&
      action.state !== "succeeded" &&
      action.state !== "failed" &&
      action.executing_at !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["executing_at"],
        message:
          "Only executing, succeeded, or execution-failed actions may have executing_at.",
      });
    }

    if (!approvalOutcomesByState[action.state].has(action.approval_outcome)) {
      context.addIssue({
        code: "custom",
        path: ["approval_outcome"],
        message: "The approval outcome is not compatible with the PendingAction state.",
      });
    }

    const hasOwnerDecision =
      action.approval_outcome === "approved" ||
      action.approval_outcome === "rejected" ||
      action.approval_outcome === "cancelled";
    const ownerEvidenceIsComplete =
      action.decided_at !== null &&
      action.approval_method === "owner_approval" &&
      action.decided_by_owner_id !== null;
    const ownerEvidenceIsEmpty =
      action.decided_at === null &&
      action.approval_method === null &&
      action.decided_by_owner_id === null;

    if (
      (hasOwnerDecision && !ownerEvidenceIsComplete) ||
      (!hasOwnerDecision && !ownerEvidenceIsEmpty)
    ) {
      context.addIssue({
        code: "custom",
        path: ["approval_method"],
        message:
          "Owner decision time, method, and decider must be all present or all absent according to approval_outcome.",
      });
    }

    if (action.state === "succeeded") {
      if (action.result === null || action.error !== null) {
        context.addIssue({
          code: "custom",
          message:
            "A succeeded PendingAction requires its operation-specific result and a null error.",
        });
      }
    } else if (action.result !== null) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "Only a succeeded PendingAction may expose a resource result.",
      });
    }

    if (
      (action.state === "rejected" ||
        action.state === "expired" ||
        action.state === "cancelled" ||
        action.state === "failed" ||
        action.state === "invalidated") &&
      action.error === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Terminal non-success actions require a structured error.",
      });
    }
    if (
      (action.state === "pending_approval" ||
        action.state === "approved" ||
        action.state === "executing") &&
      action.error !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Nonterminal actions cannot expose a terminal error.",
      });
    }
    const expectedErrorCode = publicErrorCodeByState[action.state];
    if (
      expectedErrorCode !== undefined &&
      action.error !== null &&
      action.error.code !== expectedErrorCode
    ) {
      context.addIssue({
        code: "custom",
        path: ["error", "code"],
        message: "The public error must match the terminal PendingAction state.",
      });
    }

    if (milliseconds(action.expires_at) <= milliseconds(action.requested_at)) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "expires_at must be later than requested_at.",
      });
    }

    const lifecycleTimes = [
      ["decided_at", action.decided_at],
      ["executing_at", action.executing_at],
      ["completed_at", action.completed_at],
      ["terminal_at", action.terminal_at],
    ] as const;
    for (const [field, timestamp] of lifecycleTimes) {
      if (
        timestamp !== undefined &&
        timestamp !== null &&
        milliseconds(timestamp) < milliseconds(action.requested_at)
      ) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} cannot precede requested_at.`,
        });
      }
    }
    if (
      action.completed_at !== null &&
      action.terminal_at !== null &&
      milliseconds(action.terminal_at) < milliseconds(action.completed_at)
    ) {
      context.addIssue({
        code: "custom",
        path: ["terminal_at"],
        message: "terminal_at cannot precede completed_at.",
      });
    }
  });
export type PendingActionProjection = z.infer<typeof PendingActionProjectionSchema>;

export const GetActionStatusResponseSchema = z
  .object({
    action: PendingActionProjectionSchema,
    ...V1EnvelopeShape,
  })
  .strict();
export type GetActionStatusResponse = z.infer<typeof GetActionStatusResponseSchema>;
