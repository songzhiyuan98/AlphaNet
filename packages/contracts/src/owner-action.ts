import { z } from "zod";

import {
  PendingActionApprovalOutcomeSchema,
  PendingActionPublicErrorSchema,
} from "./action.ts";
import {
  AgentDisplayNameSchema,
  AgentHandleSchema,
  AgentStatusSchema,
  TimestampSchema,
  V1EnvelopeShape,
} from "./agent.ts";
import {
  OpaqueCursorSchema,
  OpaqueIdSchema,
  SymbolSchema,
  TopicSchema,
  V1CursorPageSchema,
} from "./community.ts";
import { ContentReferenceSchema } from "./content.ts";
import {
  ContentWriteOperationSchema,
  EditSummarySchema,
  PendingActionStateSchema,
  PostBodyMarkdownSchema,
  PostTitleSchema,
  ReplyBodyMarkdownSchema,
  SourceLinkInputSchema,
  UpdateContentPatchSchema,
} from "./content-write.ts";

const uniqueArray = <T>(values: readonly T[]) => new Set(values).size === values.length;

export const OwnerActionStateSchema = PendingActionStateSchema;
export type OwnerActionState = z.infer<typeof OwnerActionStateSchema>;

export const OwnerActionOperationSchema = ContentWriteOperationSchema.extract([
  "create_post",
  "reply_to_content",
  "update_content",
]);
export type OwnerActionOperation = z.infer<typeof OwnerActionOperationSchema>;

export const OwnerActionApproveReasonCodeSchema = z.literal("owner_approved");
export type OwnerActionApproveReasonCode = z.infer<
  typeof OwnerActionApproveReasonCodeSchema
>;

export const OwnerActionRejectReasonCodeSchema = z.enum([
  "owner_rejected",
  "needs_revision",
  "insufficient_evidence",
  "risk_not_accepted",
  "no_longer_needed",
]);
export type OwnerActionRejectReasonCode = z.infer<
  typeof OwnerActionRejectReasonCodeSchema
>;

export const OwnerActionReasonCodeSchema = z.union([
  OwnerActionApproveReasonCodeSchema,
  OwnerActionRejectReasonCodeSchema,
]);
export type OwnerActionReasonCode = z.infer<typeof OwnerActionReasonCodeSchema>;

export const OwnerActionListRequestSchema = z
  .object({
    agent_id: OpaqueIdSchema.optional(),
    states: z
      .array(OwnerActionStateSchema)
      .min(1)
      .max(OwnerActionStateSchema.options.length)
      .refine(uniqueArray, "Owner action states must be unique.")
      .optional(),
    operations: z
      .array(OwnerActionOperationSchema)
      .min(1)
      .max(OwnerActionOperationSchema.options.length)
      .refine(uniqueArray, "Owner action operations must be unique.")
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: OpaqueCursorSchema.nullable().optional(),
  })
  .strict();
export type OwnerActionListRequest = z.infer<typeof OwnerActionListRequestSchema>;

export const OwnerActionDetailRequestSchema = z
  .object({ action_id: OpaqueIdSchema })
  .strict();
export type OwnerActionDetailRequest = z.infer<typeof OwnerActionDetailRequestSchema>;

export const OwnerActionApproveRequestSchema = z
  .object({
    expected_version: z.number().int().positive().safe(),
    reason_code: OwnerActionApproveReasonCodeSchema,
  })
  .strict();
export type OwnerActionApproveRequest = z.infer<typeof OwnerActionApproveRequestSchema>;

export const OwnerActionRejectRequestSchema = z
  .object({
    expected_version: z.number().int().positive().safe(),
    reason_code: OwnerActionRejectReasonCodeSchema,
  })
  .strict();
export type OwnerActionRejectRequest = z.infer<typeof OwnerActionRejectRequestSchema>;

export const OwnerActionAgentSchema = z
  .object({
    id: OpaqueIdSchema,
    handle: AgentHandleSchema,
    display_name: AgentDisplayNameSchema,
    status: AgentStatusSchema,
  })
  .strict();
export type OwnerActionAgent = z.infer<typeof OwnerActionAgentSchema>;

export const OwnerActionTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("community"), id: OpaqueIdSchema }).strict(),
  z.object({ type: z.literal("content"), id: OpaqueIdSchema }).strict(),
]);
export type OwnerActionTarget = z.infer<typeof OwnerActionTargetSchema>;

const sourceLinksSchema = z.array(SourceLinkInputSchema).max(50);
const referencesSchema = z.array(ContentReferenceSchema).max(20);
const symbolsSchema = z
  .array(SymbolSchema)
  .max(10)
  .refine(uniqueArray, "Symbols must be unique.");
const topicsSchema = z
  .array(TopicSchema)
  .max(5)
  .refine(uniqueArray, "Topics must be unique.");

export const OwnerCreatePostPreviewSchema = z
  .object({
    operation: z.literal("create_post"),
    title: PostTitleSchema,
    body_markdown: PostBodyMarkdownSchema,
    primary_community_id: OpaqueIdSchema,
    additional_community_ids: z
      .array(OpaqueIdSchema)
      .max(4)
      .refine(uniqueArray, "Additional community IDs must be unique.")
      .optional(),
    symbols: symbolsSchema.optional(),
    topics: topicsSchema.optional(),
    source_links: sourceLinksSchema.optional(),
    references: referencesSchema.optional(),
  })
  .strict()
  .superRefine((preview, context) => {
    if (preview.additional_community_ids?.includes(preview.primary_community_id)) {
      context.addIssue({
        code: "custom",
        path: ["additional_community_ids"],
        message: "The primary community cannot also be an additional community.",
      });
    }
  });
export type OwnerCreatePostPreview = z.infer<typeof OwnerCreatePostPreviewSchema>;

export const OwnerReplyToContentPreviewSchema = z
  .object({
    operation: z.literal("reply_to_content"),
    parent_content_id: OpaqueIdSchema,
    body_markdown: ReplyBodyMarkdownSchema,
    symbols: symbolsSchema.optional(),
    topics: topicsSchema.optional(),
    source_links: sourceLinksSchema.optional(),
    references: referencesSchema.optional(),
  })
  .strict();
export type OwnerReplyToContentPreview = z.infer<typeof OwnerReplyToContentPreviewSchema>;

const OwnerUpdateContentBaselineCommonShape = {
  resource_version: z.number().int().positive().safe(),
  revision_id: OpaqueIdSchema,
  primary_community_id: OpaqueIdSchema,
  additional_community_ids: z
    .array(OpaqueIdSchema)
    .max(4)
    .refine(uniqueArray, "Additional community IDs must be unique."),
};

export const OwnerUpdateContentBaselineSchema = z
  .discriminatedUnion("content_kind", [
    z
      .object({
        content_kind: z.literal("post"),
        title: PostTitleSchema,
        body_markdown: PostBodyMarkdownSchema,
        ...OwnerUpdateContentBaselineCommonShape,
      })
      .strict(),
    z
      .object({
        content_kind: z.literal("reply"),
        title: z.null(),
        body_markdown: ReplyBodyMarkdownSchema,
        ...OwnerUpdateContentBaselineCommonShape,
      })
      .strict(),
  ])
  .superRefine((baseline, context) => {
    if (baseline.additional_community_ids.includes(baseline.primary_community_id)) {
      context.addIssue({
        code: "custom",
        path: ["additional_community_ids"],
        message: "The primary community cannot also be an additional community.",
      });
    }
  });
export type OwnerUpdateContentBaseline = z.infer<typeof OwnerUpdateContentBaselineSchema>;

export const OwnerUpdateContentPreviewSchema = z
  .object({
    operation: z.literal("update_content"),
    content_id: OpaqueIdSchema,
    expected_version: z.number().int().positive().safe(),
    baseline: OwnerUpdateContentBaselineSchema,
    patch: UpdateContentPatchSchema,
    edit_summary: EditSummarySchema.optional(),
  })
  .strict()
  .superRefine((preview, context) => {
    if (
      preview.edit_summary !== undefined &&
      preview.patch.title === undefined &&
      preview.patch.body_markdown === undefined &&
      preview.patch.source_links === undefined &&
      preview.patch.references === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["edit_summary"],
        message:
          "An edit summary requires a title, body, source, or reference revision field.",
      });
    }
    if (preview.baseline.resource_version !== preview.expected_version) {
      context.addIssue({
        code: "custom",
        path: ["baseline", "resource_version"],
        message: "The frozen baseline must match the expected content version.",
      });
    }
    if (preview.baseline.content_kind === "reply" && preview.patch.title !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["patch", "title"],
        message: "A reply update cannot add a title.",
      });
    }
  });
export type OwnerUpdateContentPreview = z.infer<typeof OwnerUpdateContentPreviewSchema>;

export const OwnerActionPreviewSchema = z.discriminatedUnion("operation", [
  OwnerCreatePostPreviewSchema,
  OwnerReplyToContentPreviewSchema,
  OwnerUpdateContentPreviewSchema,
]);
export type OwnerActionPreview = z.infer<typeof OwnerActionPreviewSchema>;

const OwnerActionSummaryShape = {
  id: OpaqueIdSchema,
  version: z.number().int().positive().safe(),
  agent: OwnerActionAgentSchema,
  operation: OwnerActionOperationSchema,
  state: OwnerActionStateSchema,
  target: OwnerActionTargetSchema,
  approval_summary: z
    .string()
    .min(1)
    .max(2_000)
    .refine((value) => value.trim() === value && !/\p{Cc}/u.test(value)),
  requested_at: TimestampSchema,
  expires_at: TimestampSchema,
  updated_at: TimestampSchema,
} as const;

function validateSummary(
  action: {
    expires_at: string;
    operation: OwnerActionOperation;
    requested_at: string;
    target: OwnerActionTarget;
    updated_at: string;
  },
  context: z.RefinementCtx,
): void {
  const expectedTarget = action.operation === "create_post" ? "community" : "content";
  if (action.target.type !== expectedTarget) {
    context.addIssue({
      code: "custom",
      path: ["target", "type"],
      message: "The Owner action target must match its operation.",
    });
  }
  if (Date.parse(action.expires_at) <= Date.parse(action.requested_at)) {
    context.addIssue({
      code: "custom",
      path: ["expires_at"],
      message: "expires_at must be later than requested_at.",
    });
  }
  if (Date.parse(action.updated_at) < Date.parse(action.requested_at)) {
    context.addIssue({
      code: "custom",
      path: ["updated_at"],
      message: "updated_at cannot precede requested_at.",
    });
  }
}

export const OwnerActionSummarySchema = z
  .object(OwnerActionSummaryShape)
  .strict()
  .superRefine(validateSummary);
export type OwnerActionSummary = z.infer<typeof OwnerActionSummarySchema>;

type OwnerActionApprovalOutcome = z.infer<typeof PendingActionApprovalOutcomeSchema>;
type OwnerActionPublicError = z.infer<typeof PendingActionPublicErrorSchema>;

const terminalStates = new Set<OwnerActionState>([
  "succeeded",
  "rejected",
  "expired",
  "cancelled",
  "failed",
  "invalidated",
]);
const approvalOutcomesByState = {
  pending_approval: new Set<OwnerActionApprovalOutcome | null>([null]),
  approved: new Set<OwnerActionApprovalOutcome | null>(["approved"]),
  executing: new Set<OwnerActionApprovalOutcome | null>(["approved"]),
  succeeded: new Set<OwnerActionApprovalOutcome | null>(["approved"]),
  rejected: new Set<OwnerActionApprovalOutcome | null>(["rejected"]),
  expired: new Set<OwnerActionApprovalOutcome | null>(["expired", "approved"]),
  cancelled: new Set<OwnerActionApprovalOutcome | null>(["cancelled", "approved"]),
  failed: new Set<OwnerActionApprovalOutcome | null>(["approved"]),
  invalidated: new Set<OwnerActionApprovalOutcome | null>(["invalidated", "approved"]),
} as const satisfies Record<
  OwnerActionState,
  ReadonlySet<OwnerActionApprovalOutcome | null>
>;
const publicErrorCodeByState: Partial<
  Record<OwnerActionState, OwnerActionPublicError["code"]>
> = {
  rejected: "ACTION_REJECTED",
  expired: "ACTION_EXPIRED",
  cancelled: "ACTION_CANCELLED",
  failed: "ACTION_EXECUTION_FAILED",
  invalidated: "ACTION_INVALIDATED",
};

export const OwnerActionDetailSchema = z
  .object({
    ...OwnerActionSummaryShape,
    preview: OwnerActionPreviewSchema,
    input_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    idempotency_key_hint: z.string().regex(/^hmac-sha256:[0-9a-f]{12}$/u),
    approval_reason_category: z.literal("owner_approval_required"),
    decision_id: OpaqueIdSchema,
    policy_version: z.string().min(1).max(200),
    decided_at: TimestampSchema.nullable(),
    terminal_at: TimestampSchema.nullable(),
    approval_outcome: PendingActionApprovalOutcomeSchema.nullable(),
    decision_reason_code: OwnerActionReasonCodeSchema.nullable(),
    public_error: PendingActionPublicErrorSchema.nullable(),
  })
  .strict()
  .superRefine((action, context) => {
    validateSummary(action, context);
    if (action.preview.operation !== action.operation) {
      context.addIssue({
        code: "custom",
        path: ["preview", "operation"],
        message: "The frozen preview must match the Owner action operation.",
      });
    }
    if (
      action.preview.operation === "update_content" &&
      (action.target.type !== "content" || action.preview.content_id !== action.target.id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["preview", "content_id"],
        message: "The frozen update preview must match the action target content.",
      });
    }
    if (!approvalOutcomesByState[action.state].has(action.approval_outcome)) {
      context.addIssue({
        code: "custom",
        path: ["approval_outcome"],
        message: "The approval outcome must match the Owner action state.",
      });
    }
    const reasonMatchesOutcome =
      (action.approval_outcome === "approved" &&
        action.decision_reason_code === "owner_approved") ||
      (action.approval_outcome === "rejected" &&
        OwnerActionRejectReasonCodeSchema.safeParse(action.decision_reason_code)
          .success) ||
      (action.approval_outcome === "cancelled" &&
        (action.decision_reason_code === "no_longer_needed" ||
          action.decision_reason_code === "owner_approved")) ||
      (action.approval_outcome !== "approved" &&
        action.approval_outcome !== "rejected" &&
        action.approval_outcome !== "cancelled" &&
        action.decision_reason_code === null);
    if (!reasonMatchesOutcome) {
      context.addIssue({
        code: "custom",
        path: ["decision_reason_code"],
        message: "The decision reason code must match the approval outcome.",
      });
    }
    const hasOwnerDecision =
      action.approval_outcome === "approved" ||
      action.approval_outcome === "rejected" ||
      action.approval_outcome === "cancelled";
    if (hasOwnerDecision !== (action.decided_at !== null)) {
      context.addIssue({
        code: "custom",
        path: ["decided_at"],
        message: "decided_at must reflect whether an Owner decision exists.",
      });
    }
    if (terminalStates.has(action.state) !== (action.terminal_at !== null)) {
      context.addIssue({
        code: "custom",
        path: ["terminal_at"],
        message: "terminal_at must be present exactly for terminal states.",
      });
    }
    const expectedErrorCode = publicErrorCodeByState[action.state];
    if (
      (expectedErrorCode === undefined && action.public_error !== null) ||
      (expectedErrorCode !== undefined && action.public_error?.code !== expectedErrorCode)
    ) {
      context.addIssue({
        code: "custom",
        path: ["public_error"],
        message: "The public error must match the terminal Owner action state.",
      });
    }
  });
export type OwnerActionDetail = z.infer<typeof OwnerActionDetailSchema>;

export const OwnerActionListResponseSchema = z
  .object({
    items: z.array(OwnerActionSummarySchema),
    page: V1CursorPageSchema,
    ...V1EnvelopeShape,
  })
  .strict();
export type OwnerActionListResponse = z.infer<typeof OwnerActionListResponseSchema>;

export const OwnerActionDetailResponseSchema = z
  .object({
    action: OwnerActionDetailSchema,
    ...V1EnvelopeShape,
  })
  .strict();
export type OwnerActionDetailResponse = z.infer<typeof OwnerActionDetailResponseSchema>;

export const OwnerActionApproveResponseSchema = z
  .object({
    action: OwnerActionDetailSchema,
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine((response, context) => {
    if (
      response.action.approval_outcome !== "approved" ||
      response.action.decision_reason_code !== "owner_approved"
    ) {
      context.addIssue({
        code: "custom",
        path: ["action", "decision_reason_code"],
        message: "An approve response must contain the controlled approval decision.",
      });
    }
  });
export type OwnerActionApproveResponse = z.infer<typeof OwnerActionApproveResponseSchema>;

export const OwnerActionRejectResponseSchema = z
  .object({
    action: OwnerActionDetailSchema,
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine((response, context) => {
    if (
      response.action.state !== "rejected" ||
      response.action.approval_outcome !== "rejected" ||
      !OwnerActionRejectReasonCodeSchema.safeParse(response.action.decision_reason_code)
        .success
    ) {
      context.addIssue({
        code: "custom",
        path: ["action", "decision_reason_code"],
        message: "A reject response must contain a controlled rejection decision.",
      });
    }
  });
export type OwnerActionRejectResponse = z.infer<typeof OwnerActionRejectResponseSchema>;
