import { z } from "zod";

import { TimestampSchema, V1EnvelopeShape } from "./agent.ts";
import {
  OpaqueCursorSchema,
  OpaqueIdSchema,
  OrderingSnapshotSchema,
  V1CursorPageSchema,
} from "./community.ts";
import {
  ContentAuthorProjectionSchema,
  ContentDistributionStateSchema,
  ContentKindSchema,
  ContentLifecycleStateSchema,
} from "./content.ts";
import {
  PostBodyMarkdownSchema,
  PostTitleSchema,
  ReplyBodyMarkdownSchema,
} from "./content-write.ts";
import { IdempotencyKeySchema } from "./write-primitives.ts";

export const MODERATION_CASE_LIST_ORDERING_VERSION =
  "moderation-case-live-keyset-v1" as const;
export const MODERATION_REPORT_LIST_ORDERING_VERSION =
  "moderation-report-list-v1" as const;
export const MODERATION_ACTION_LIST_ORDERING_VERSION =
  "moderation-action-list-v1" as const;
export const OWNER_CONTENT_MODERATION_LIST_ORDERING_VERSION =
  "owner-content-moderation-list-v1" as const;

const unicodeLength = (value: string): number => [...value].length;
const uniqueArray = <T>(values: readonly T[]) => new Set(values).size === values.length;
const encoder = new TextEncoder();

function boundedModerationText(
  maximum: number,
  maximumBytes: number,
  label: string,
): z.ZodString {
  return z.string().superRefine((value, context) => {
    if (value.trim() !== value || value.length === 0 || unicodeLength(value) > maximum) {
      context.addIssue({
        code: "custom",
        message: `${label} must be trimmed and contain 1 through ${maximum} Unicode characters.`,
      });
    }
    if (value.normalize("NFC") !== value) {
      context.addIssue({
        code: "custom",
        message: `${label} must use NFC Unicode normalization.`,
      });
    }
    if (/[^\P{Cc}\n\t]/u.test(value)) {
      context.addIssue({
        code: "custom",
        message: `${label} cannot contain control characters other than newline or tab.`,
      });
    }
    if (encoder.encode(value).byteLength > maximumBytes) {
      context.addIssue({
        code: "custom",
        message: `${label} cannot exceed ${maximumBytes} UTF-8 bytes.`,
      });
    }
  });
}

export const ContentReportDetailsSchema = boundedModerationText(
  4_000,
  16_384,
  "Report details",
);
export const ModerationInternalNoteSchema = boundedModerationText(
  4_000,
  16_384,
  "Internal moderation note",
);

/** Human-facing report taxonomy. This is intentionally not an Admin action reason. */
export const ContentReportReasonSchema = z.enum([
  "spam",
  "harassment",
  "impersonation",
  "malicious_link",
  "privacy_exposure",
  "other_rule_violation",
]);
export type ContentReportReason = z.infer<typeof ContentReportReasonSchema>;

export const ContentReportStatusSchema = z.enum([
  "open",
  "reviewing",
  "resolved_action",
  "dismissed",
]);
export type ContentReportStatus = z.infer<typeof ContentReportStatusSchema>;

export const ModerationCasePrioritySchema = z.enum(["normal", "high", "urgent"]);
export type ModerationCasePriority = z.infer<typeof ModerationCasePrioritySchema>;

export const ModerationCaseStatusSchema = ContentReportStatusSchema;
export type ModerationCaseStatus = z.infer<typeof ModerationCaseStatusSchema>;

export const AdminContentModerationActionSchema = z.enum([
  "dismiss",
  "limit_content",
  "hide_content",
  "restore_content",
]);
export type AdminContentModerationAction = z.infer<
  typeof AdminContentModerationActionSchema
>;

/** Admin audit taxonomy. It must stay separate from ContentReportReasonSchema. */
export const AdminModerationReasonCodeSchema = z.enum([
  "confirmed_report_violation",
  "precautionary_distribution_limit",
  "insufficient_evidence",
  "no_rule_violation",
  "duplicate_case",
  "moderation_error_corrected",
  "appeal_granted",
  "risk_condition_resolved",
]);
export type AdminModerationReasonCode = z.infer<typeof AdminModerationReasonCodeSchema>;

const dismissReasonCodes = [
  "insufficient_evidence",
  "no_rule_violation",
  "duplicate_case",
] as const;
const enforcementReasonCodes = [
  "confirmed_report_violation",
  "precautionary_distribution_limit",
] as const;
const restoreReasonCodes = [
  "moderation_error_corrected",
  "appeal_granted",
  "risk_condition_resolved",
] as const;

export const StrictVersionEntityTagSchema = z
  .string()
  .regex(/^"[1-9][0-9]*"$/u, "If-Match must be one quoted positive version.")
  .superRefine((value, context) => {
    const version = Number(value.slice(1, -1));
    if (!Number.isSafeInteger(version)) {
      context.addIssue({
        code: "custom",
        message: "If-Match version must be a positive safe integer.",
      });
    }
  });

export const StrictTransportIdempotencyKeySchema = IdempotencyKeySchema.refine(
  (value) => !value.includes(","),
  "Transport idempotency keys cannot contain commas.",
);

/** The route passes only these normalized header fields into this strict DTO. */
export const OwnerContentReportHeadersSchema = z
  .object({
    "idempotency-key": StrictTransportIdempotencyKeySchema,
  })
  .strict();
export type OwnerContentReportHeaders = z.infer<typeof OwnerContentReportHeadersSchema>;

/** If-Match identifies the current Case version; transport rejects duplicate lines. */
export const AdminModerationDecisionHeadersSchema = z
  .object({
    "if-match": StrictVersionEntityTagSchema,
    "idempotency-key": StrictTransportIdempotencyKeySchema,
  })
  .strict();
export type AdminModerationDecisionHeaders = z.infer<
  typeof AdminModerationDecisionHeadersSchema
>;

export const OwnerContentReportPathParamsSchema = z
  .object({ content_id: OpaqueIdSchema })
  .strict();
export type OwnerContentReportPathParams = z.infer<
  typeof OwnerContentReportPathParamsSchema
>;

export const AdminModerationCasePathParamsSchema = z
  .object({ case_id: OpaqueIdSchema })
  .strict();
export type AdminModerationCasePathParams = z.infer<
  typeof AdminModerationCasePathParamsSchema
>;

export const OwnerContentModerationPathParamsSchema = z
  .object({ content_id: OpaqueIdSchema })
  .strict();
export type OwnerContentModerationPathParams = z.infer<
  typeof OwnerContentModerationPathParamsSchema
>;

export const OwnerContentReportCreateRequestSchema = z
  .object({
    reporter_actor_id: OpaqueIdSchema,
    reason_code: ContentReportReasonSchema,
    details: ContentReportDetailsSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.reason_code === "other_rule_violation" && request.details === undefined) {
      context.addIssue({
        code: "custom",
        path: ["details"],
        message: "other_rule_violation requires report details.",
      });
    }
  });
export type OwnerContentReportCreateRequest = z.infer<
  typeof OwnerContentReportCreateRequestSchema
>;

type TimedStatus = {
  status: ContentReportStatus;
  submitted_at: string;
  updated_at: string;
  resolved_at: string | null;
};

function validateTimedStatus(value: TimedStatus, context: z.RefinementCtx): void {
  const submittedAt = Date.parse(value.submitted_at);
  const updatedAt = Date.parse(value.updated_at);
  if (updatedAt < submittedAt) {
    context.addIssue({
      code: "custom",
      path: ["updated_at"],
      message: "updated_at cannot precede submitted_at.",
    });
  }

  const terminal = value.status === "resolved_action" || value.status === "dismissed";
  if (terminal !== (value.resolved_at !== null)) {
    context.addIssue({
      code: "custom",
      path: ["resolved_at"],
      message: "resolved_at must be present exactly for terminal report states.",
    });
  } else if (value.resolved_at !== null && Date.parse(value.resolved_at) < updatedAt) {
    context.addIssue({
      code: "custom",
      path: ["resolved_at"],
      message: "resolved_at cannot precede updated_at.",
    });
  }
}

const OwnerContentReportProjectionBaseSchema = z
  .object({
    report_id: OpaqueIdSchema,
    report_version: z.number().int().positive().safe(),
    case_id: OpaqueIdSchema,
    content_id: OpaqueIdSchema,
    reporter_actor_id: OpaqueIdSchema,
    reason_code: ContentReportReasonSchema,
    details: ContentReportDetailsSchema.nullable(),
    status: ContentReportStatusSchema,
    submitted_at: TimestampSchema,
    updated_at: TimestampSchema,
    resolved_at: TimestampSchema.nullable(),
  })
  .strict();

export const OwnerContentReportProjectionSchema =
  OwnerContentReportProjectionBaseSchema.superRefine(validateTimedStatus);
export type OwnerContentReportProjection = z.infer<
  typeof OwnerContentReportProjectionSchema
>;

export const OwnerContentReportCreateResponseSchema = z
  .object({
    created: z.boolean(),
    report: OwnerContentReportProjectionSchema,
    ...V1EnvelopeShape,
  })
  .strict();
export type OwnerContentReportCreateResponse = z.infer<
  typeof OwnerContentReportCreateResponseSchema
>;

export const ModerationReasonCountsSchema = z
  .object({
    spam: z.number().int().nonnegative().safe(),
    harassment: z.number().int().nonnegative().safe(),
    impersonation: z.number().int().nonnegative().safe(),
    malicious_link: z.number().int().nonnegative().safe(),
    privacy_exposure: z.number().int().nonnegative().safe(),
    other_rule_violation: z.number().int().nonnegative().safe(),
  })
  .strict();
export type ModerationReasonCounts = z.infer<typeof ModerationReasonCountsSchema>;

const ModerationCaseSummaryBaseSchema = z
  .object({
    case_id: OpaqueIdSchema,
    case_version: z.number().int().positive().safe(),
    content_id: OpaqueIdSchema,
    content_version: z.number().int().positive().safe(),
    content_kind: ContentKindSchema,
    lifecycle_state: ContentLifecycleStateSchema,
    distribution_state: ContentDistributionStateSchema,
    author: ContentAuthorProjectionSchema,
    status: ModerationCaseStatusSchema,
    priority: ModerationCasePrioritySchema,
    report_count: z.number().int().positive().safe(),
    reason_counts: ModerationReasonCountsSchema,
    opened_at: TimestampSchema,
    last_reported_at: TimestampSchema,
    updated_at: TimestampSchema,
    resolved_at: TimestampSchema.nullable(),
    resolution_action: AdminContentModerationActionSchema.nullable(),
    latest_action_id: OpaqueIdSchema.nullable(),
  })
  .strict();

type ModerationCaseSummary = z.infer<typeof ModerationCaseSummaryBaseSchema>;

function validateModerationCaseSummary(
  value: ModerationCaseSummary,
  context: z.RefinementCtx,
): void {
  const countedReports = ContentReportReasonSchema.options.reduce(
    (total, reason) => total + value.reason_counts[reason],
    0,
  );
  if (countedReports !== value.report_count) {
    context.addIssue({
      code: "custom",
      path: ["reason_counts"],
      message: "Reason counts must sum to report_count.",
    });
  }

  const openedAt = Date.parse(value.opened_at);
  if (
    Date.parse(value.last_reported_at) < openedAt ||
    Date.parse(value.updated_at) < openedAt
  ) {
    context.addIssue({
      code: "custom",
      path: ["updated_at"],
      message: "Case activity timestamps cannot precede opened_at.",
    });
  }

  const terminal = value.status === "resolved_action" || value.status === "dismissed";
  if (
    terminal !== (value.resolved_at !== null) ||
    terminal !== (value.resolution_action !== null) ||
    terminal !== (value.latest_action_id !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["resolution_action"],
      message: "Terminal Cases require a resolution timestamp and latest action.",
    });
  }
  if (value.status === "dismissed" && value.resolution_action !== "dismiss") {
    context.addIssue({
      code: "custom",
      path: ["resolution_action"],
      message: "A dismissed Case must resolve with dismiss.",
    });
  }
  if (
    value.status === "resolved_action" &&
    (value.resolution_action === null || value.resolution_action === "dismiss")
  ) {
    context.addIssue({
      code: "custom",
      path: ["resolution_action"],
      message: "A resolved_action Case requires a content moderation action.",
    });
  }
  if (
    value.resolved_at !== null &&
    Date.parse(value.resolved_at) < Date.parse(value.updated_at)
  ) {
    context.addIssue({
      code: "custom",
      path: ["resolved_at"],
      message: "resolved_at cannot precede updated_at.",
    });
  }
}

export const ModerationCaseSummarySchema = ModerationCaseSummaryBaseSchema.superRefine(
  validateModerationCaseSummary,
);
export type ModerationCaseSummaryProjection = z.infer<typeof ModerationCaseSummarySchema>;

export const AdminModerationCaseListRequestSchema = z
  .object({
    statuses: z
      .array(ModerationCaseStatusSchema)
      .min(1)
      .max(ModerationCaseStatusSchema.options.length)
      .refine(uniqueArray, "Case statuses must be unique.")
      .optional(),
    priorities: z
      .array(ModerationCasePrioritySchema)
      .min(1)
      .max(ModerationCasePrioritySchema.options.length)
      .refine(uniqueArray, "Case priorities must be unique.")
      .optional(),
    reasons: z
      .array(ContentReportReasonSchema)
      .min(1)
      .max(ContentReportReasonSchema.options.length)
      .refine(uniqueArray, "Report reasons must be unique.")
      .optional(),
    content_id: OpaqueIdSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: OpaqueCursorSchema.nullable().optional(),
  })
  .strict();
export type AdminModerationCaseListRequest = z.infer<
  typeof AdminModerationCaseListRequestSchema
>;

export const AdminModerationCaseListItemSchema = ModerationCaseSummaryBaseSchema.extend({
  queue_rank: z.number().int().positive().safe(),
})
  .strict()
  .superRefine(validateModerationCaseSummary);
export type AdminModerationCaseListItem = z.infer<
  typeof AdminModerationCaseListItemSchema
>;

export const ModerationCaseListOrderingSchema = OrderingSnapshotSchema.extend({
  ordering_version: z.literal(MODERATION_CASE_LIST_ORDERING_VERSION),
}).strict();

export const AdminModerationCaseListResponseSchema = z
  .object({
    items: z.array(AdminModerationCaseListItemSchema).max(100),
    page: V1CursorPageSchema,
    ordering: ModerationCaseListOrderingSchema,
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine((response, context) => {
    if (response.items.length > response.page.limit) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "A Case page cannot contain more items than its declared limit.",
      });
    }
    const caseIds = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (caseIds.has(item.case_id)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "case_id"],
          message: "A Case page cannot repeat a Case.",
        });
      }
      caseIds.add(item.case_id);
      const previous = response.items[index - 1];
      if (previous !== undefined && previous.queue_rank >= item.queue_rank) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "queue_rank"],
          message: "Case queue ranks must be strictly ascending.",
        });
      }
    }
  });
export type AdminModerationCaseListResponse = z.infer<
  typeof AdminModerationCaseListResponseSchema
>;

const ModerationContentLocationShape = {
  content_id: OpaqueIdSchema,
  root_content_id: OpaqueIdSchema,
  parent_content_id: OpaqueIdSchema.nullable(),
  depth: z.number().int().min(0).max(100),
} as const;

const ModerationContentStateShape = {
  resource_version: z.number().int().positive().safe(),
  lifecycle_state: ContentLifecycleStateSchema,
  distribution_state: ContentDistributionStateSchema,
  current_revision_id: OpaqueIdSchema,
  author: ContentAuthorProjectionSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  deleted_at: TimestampSchema.nullable(),
} as const;

export const ModerationContentSnapshotSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("post"),
        ...ModerationContentLocationShape,
        ...ModerationContentStateShape,
        title: PostTitleSchema,
        body_markdown: PostBodyMarkdownSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("reply"),
        ...ModerationContentLocationShape,
        ...ModerationContentStateShape,
        title: z.null(),
        body_markdown: ReplyBodyMarkdownSchema,
      })
      .strict(),
  ])
  .superRefine((content, context) => {
    const isPost = content.kind === "post";
    if (
      isPost !==
      (content.root_content_id === content.content_id &&
        content.parent_content_id === null &&
        content.depth === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Post and reply locations must match their content kind.",
      });
    }
    if (
      content.kind === "reply" &&
      (content.root_content_id === content.content_id ||
        content.parent_content_id === null ||
        content.depth < 1)
    ) {
      context.addIssue({
        code: "custom",
        message: "Replies require a distinct root, parent, and positive depth.",
      });
    }
    if ((content.lifecycle_state === "deleted") !== (content.deleted_at !== null)) {
      context.addIssue({
        code: "custom",
        path: ["deleted_at"],
        message: "deleted_at must reflect the content lifecycle.",
      });
    }
    if (Date.parse(content.updated_at) < Date.parse(content.created_at)) {
      context.addIssue({
        code: "custom",
        path: ["updated_at"],
        message: "updated_at cannot precede created_at.",
      });
    }
  });
export type ModerationContentSnapshot = z.infer<typeof ModerationContentSnapshotSchema>;

export const AdminContentReportProjectionSchema =
  OwnerContentReportProjectionBaseSchema.extend({
    reporter_owner_id: OpaqueIdSchema,
  })
    .strict()
    .superRefine(validateTimedStatus);
export type AdminContentReportProjection = z.infer<
  typeof AdminContentReportProjectionSchema
>;

const decisionRequestCommonShape = {
  internal_note: ModerationInternalNoteSchema.optional(),
} as const;

export const AdminModerationDecisionRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("dismiss"),
      reason_code: z.enum(dismissReasonCodes),
      ...decisionRequestCommonShape,
    })
    .strict(),
  z
    .object({
      action: z.literal("limit_content"),
      reason_code: z.enum(enforcementReasonCodes),
      ...decisionRequestCommonShape,
    })
    .strict(),
  z
    .object({
      action: z.literal("hide_content"),
      reason_code: z.enum(enforcementReasonCodes),
      ...decisionRequestCommonShape,
    })
    .strict(),
  z
    .object({
      action: z.literal("restore_content"),
      reason_code: z.enum(restoreReasonCodes),
      ...decisionRequestCommonShape,
    })
    .strict(),
]);
export type AdminModerationDecisionRequest = z.infer<
  typeof AdminModerationDecisionRequestSchema
>;

const moderationActionRecordCommonShape = {
  moderation_action_id: OpaqueIdSchema,
  action_version: z.literal(1),
  case_id: OpaqueIdSchema,
  content_id: OpaqueIdSchema,
  internal_note: ModerationInternalNoteSchema.nullable(),
  decided_by_admin_id: OpaqueIdSchema,
  decided_at: TimestampSchema,
} as const;

const DismissModerationActionRecordSchema = z
  .object({
    ...moderationActionRecordCommonShape,
    action: z.literal("dismiss"),
    reason_code: z.enum(dismissReasonCodes),
    content_version_before: z.null(),
    content_version_after: z.null(),
    content_lifecycle_state: z.null(),
    distribution_before: z.null(),
    distribution_after: z.null(),
    reverted_action_id: z.null(),
  })
  .strict();

const LimitContentModerationActionRecordSchema = z
  .object({
    ...moderationActionRecordCommonShape,
    action: z.literal("limit_content"),
    reason_code: z.enum(enforcementReasonCodes),
    content_version_before: z.number().int().positive().safe(),
    content_version_after: z.number().int().positive().safe(),
    content_lifecycle_state: z.literal("published"),
    distribution_before: z.enum(["normal", "hidden"]),
    distribution_after: z.literal("limited"),
    reverted_action_id: z.null(),
  })
  .strict();

const HideContentModerationActionRecordSchema = z
  .object({
    ...moderationActionRecordCommonShape,
    action: z.literal("hide_content"),
    reason_code: z.enum(enforcementReasonCodes),
    content_version_before: z.number().int().positive().safe(),
    content_version_after: z.number().int().positive().safe(),
    content_lifecycle_state: z.literal("published"),
    distribution_before: z.enum(["normal", "limited"]),
    distribution_after: z.literal("hidden"),
    reverted_action_id: z.null(),
  })
  .strict();

const RestoreContentModerationActionRecordSchema = z
  .object({
    ...moderationActionRecordCommonShape,
    action: z.literal("restore_content"),
    reason_code: z.enum(restoreReasonCodes),
    content_version_before: z.number().int().positive().safe(),
    content_version_after: z.number().int().positive().safe(),
    content_lifecycle_state: z.literal("published"),
    distribution_before: z.enum(["limited", "hidden"]),
    distribution_after: z.literal("normal"),
    reverted_action_id: OpaqueIdSchema,
  })
  .strict();

const AdminContentModerationActionRecordBaseSchema = z.discriminatedUnion("action", [
  DismissModerationActionRecordSchema,
  LimitContentModerationActionRecordSchema,
  HideContentModerationActionRecordSchema,
  RestoreContentModerationActionRecordSchema,
]);

type AdminContentModerationActionRecord = z.infer<
  typeof AdminContentModerationActionRecordBaseSchema
>;

function validateModerationActionRecord(
  record: AdminContentModerationActionRecord,
  context: z.RefinementCtx,
): void {
  if (record.action === "dismiss") {
    return;
  }

  if (record.content_version_after !== record.content_version_before + 1) {
    context.addIssue({
      code: "custom",
      path: ["content_version_after"],
      message: "Content moderation must advance the Content version exactly once.",
    });
  }
}

export const AdminContentModerationActionRecordSchema =
  AdminContentModerationActionRecordBaseSchema.superRefine(
    validateModerationActionRecord,
  );
export type AdminContentModerationActionRecordProjection = z.infer<
  typeof AdminContentModerationActionRecordSchema
>;

export const AdminModerationCaseDetailRequestSchema = z
  .object({
    report_limit: z.number().int().min(1).max(100).optional(),
    report_cursor: OpaqueCursorSchema.nullable().optional(),
    action_limit: z.number().int().min(1).max(100).optional(),
    action_cursor: OpaqueCursorSchema.nullable().optional(),
  })
  .strict();
export type AdminModerationCaseDetailRequest = z.infer<
  typeof AdminModerationCaseDetailRequestSchema
>;

export const ModerationReportListOrderingSchema = OrderingSnapshotSchema.extend({
  ordering_version: z.literal(MODERATION_REPORT_LIST_ORDERING_VERSION),
}).strict();
export const ModerationActionListOrderingSchema = OrderingSnapshotSchema.extend({
  ordering_version: z.literal(MODERATION_ACTION_LIST_ORDERING_VERSION),
}).strict();

export const AdminModerationCaseDetailResponseSchema = z
  .object({
    case: ModerationCaseSummarySchema,
    content: ModerationContentSnapshotSchema,
    reports: z.array(AdminContentReportProjectionSchema).max(100),
    report_page: V1CursorPageSchema,
    report_ordering: ModerationReportListOrderingSchema,
    actions: z.array(AdminContentModerationActionRecordSchema).max(100),
    action_page: V1CursorPageSchema,
    action_ordering: ModerationActionListOrderingSchema,
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine((response, context) => {
    if (response.case.content_id !== response.content.content_id) {
      context.addIssue({
        code: "custom",
        path: ["content", "content_id"],
        message: "The Case detail content must match the Case target.",
      });
    }
    if (
      response.case.content_version !== response.content.resource_version ||
      response.case.lifecycle_state !== response.content.lifecycle_state ||
      response.case.distribution_state !== response.content.distribution_state
    ) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "The Case and content snapshots must describe one resource version.",
      });
    }
    if (
      response.reports.length > response.report_page.limit ||
      response.actions.length > response.action_page.limit
    ) {
      context.addIssue({
        code: "custom",
        message: "Case detail collections cannot exceed their declared page limits.",
      });
    }

    const reportIds = new Set<string>();
    for (const [index, report] of response.reports.entries()) {
      if (
        report.case_id !== response.case.case_id ||
        report.content_id !== response.case.content_id ||
        reportIds.has(report.report_id)
      ) {
        context.addIssue({
          code: "custom",
          path: ["reports", index],
          message: "Case reports must be unique and belong to the requested Case.",
        });
      }
      reportIds.add(report.report_id);
      const previous = response.reports[index - 1];
      if (
        previous !== undefined &&
        (Date.parse(previous.submitted_at) < Date.parse(report.submitted_at) ||
          (previous.submitted_at === report.submitted_at &&
            previous.report_id <= report.report_id))
      ) {
        context.addIssue({
          code: "custom",
          path: ["reports", index],
          message: "Reports must use submitted_at and report_id descending order.",
        });
      }
    }

    const actionIds = new Set<string>();
    for (const [index, action] of response.actions.entries()) {
      if (
        action.case_id !== response.case.case_id ||
        action.content_id !== response.case.content_id ||
        actionIds.has(action.moderation_action_id)
      ) {
        context.addIssue({
          code: "custom",
          path: ["actions", index],
          message: "Case actions must be unique and belong to the requested Case.",
        });
      }
      actionIds.add(action.moderation_action_id);
      const previous = response.actions[index - 1];
      if (
        previous !== undefined &&
        (Date.parse(previous.decided_at) < Date.parse(action.decided_at) ||
          (previous.decided_at === action.decided_at &&
            previous.moderation_action_id <= action.moderation_action_id))
      ) {
        context.addIssue({
          code: "custom",
          path: ["actions", index],
          message: "Actions must use decided_at and action ID descending order.",
        });
      }
    }
  });
export type AdminModerationCaseDetailResponse = z.infer<
  typeof AdminModerationCaseDetailResponseSchema
>;

export const AdminModerationDecisionResponseSchema = z
  .object({
    case_version_before: z.number().int().positive().safe(),
    case: ModerationCaseSummarySchema,
    action: AdminContentModerationActionRecordSchema,
    content: z
      .object({
        content_id: OpaqueIdSchema,
        resource_version: z.number().int().positive().safe(),
        lifecycle_state: ContentLifecycleStateSchema,
        distribution_state: ContentDistributionStateSchema,
      })
      .strict(),
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine((response, context) => {
    const { action, content } = response;
    if (
      response.case.case_version !== response.case_version_before + 1 ||
      response.case.case_id !== action.case_id ||
      response.case.content_id !== action.content_id ||
      response.case.content_id !== content.content_id ||
      response.case.content_version !== content.resource_version ||
      response.case.lifecycle_state !== content.lifecycle_state ||
      response.case.distribution_state !== content.distribution_state
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Decision response versions and Content state must be internally consistent.",
      });
    }
    if (
      action.action !== "dismiss" &&
      (response.case.content_version !== action.content_version_after ||
        response.case.lifecycle_state !== action.content_lifecycle_state ||
        response.case.distribution_state !== action.distribution_after)
    ) {
      context.addIssue({
        code: "custom",
        path: ["action"],
        message: "A Content action must match the post-decision Content resource.",
      });
    }
    const expectedStatus = action.action === "dismiss" ? "dismissed" : "resolved_action";
    if (
      response.case.status !== expectedStatus ||
      response.case.resolution_action !== action.action ||
      response.case.latest_action_id !== action.moderation_action_id
    ) {
      context.addIssue({
        code: "custom",
        path: ["case", "status"],
        message: "The Case resolution must match the applied moderation action.",
      });
    }
  });
export type AdminModerationDecisionResponse = z.infer<
  typeof AdminModerationDecisionResponseSchema
>;

const ownerModerationRecordCommonShape = {
  moderation_action_id: OpaqueIdSchema,
  action_version: z.literal(1),
  case_id: OpaqueIdSchema,
  content_id: OpaqueIdSchema,
  decided_at: TimestampSchema,
} as const;

const OwnerDismissModerationRecordSchema = z
  .object({
    ...ownerModerationRecordCommonShape,
    action: z.literal("dismiss"),
    reason_code: z.enum(dismissReasonCodes),
    content_version_before: z.null(),
    content_version_after: z.null(),
    distribution_before: z.null(),
    distribution_after: z.null(),
    reverted_action_id: z.null(),
  })
  .strict();

const OwnerLimitModerationRecordSchema = z
  .object({
    ...ownerModerationRecordCommonShape,
    action: z.literal("limit_content"),
    reason_code: z.enum(enforcementReasonCodes),
    content_version_before: z.number().int().positive().safe(),
    content_version_after: z.number().int().positive().safe(),
    distribution_before: z.enum(["normal", "hidden"]),
    distribution_after: z.literal("limited"),
    reverted_action_id: z.null(),
  })
  .strict();

const OwnerHideModerationRecordSchema = z
  .object({
    ...ownerModerationRecordCommonShape,
    action: z.literal("hide_content"),
    reason_code: z.enum(enforcementReasonCodes),
    content_version_before: z.number().int().positive().safe(),
    content_version_after: z.number().int().positive().safe(),
    distribution_before: z.enum(["normal", "limited"]),
    distribution_after: z.literal("hidden"),
    reverted_action_id: z.null(),
  })
  .strict();

const OwnerRestoreModerationRecordSchema = z
  .object({
    ...ownerModerationRecordCommonShape,
    action: z.literal("restore_content"),
    reason_code: z.enum(restoreReasonCodes),
    content_version_before: z.number().int().positive().safe(),
    content_version_after: z.number().int().positive().safe(),
    distribution_before: z.enum(["limited", "hidden"]),
    distribution_after: z.literal("normal"),
    reverted_action_id: OpaqueIdSchema,
  })
  .strict();

export const OwnerContentModerationRecordSchema = z
  .discriminatedUnion("action", [
    OwnerDismissModerationRecordSchema,
    OwnerLimitModerationRecordSchema,
    OwnerHideModerationRecordSchema,
    OwnerRestoreModerationRecordSchema,
  ])
  .superRefine((record, context) => {
    if (
      record.action !== "dismiss" &&
      record.content_version_after !== record.content_version_before + 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["content_version_after"],
        message: "Content moderation must advance the Content version exactly once.",
      });
    }
  });
export type OwnerContentModerationRecord = z.infer<
  typeof OwnerContentModerationRecordSchema
>;

export const OwnerContentModerationListRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: OpaqueCursorSchema.nullable().optional(),
  })
  .strict();
export type OwnerContentModerationListRequest = z.infer<
  typeof OwnerContentModerationListRequestSchema
>;

export const OwnerContentModerationListOrderingSchema = OrderingSnapshotSchema.extend({
  ordering_version: z.literal(OWNER_CONTENT_MODERATION_LIST_ORDERING_VERSION),
}).strict();

export const OwnerContentModerationListResponseSchema = z
  .object({
    content_id: OpaqueIdSchema,
    content_version: z.number().int().positive().safe(),
    distribution_state: ContentDistributionStateSchema,
    items: z.array(OwnerContentModerationRecordSchema).max(100),
    page: V1CursorPageSchema,
    ordering: OwnerContentModerationListOrderingSchema,
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine((response, context) => {
    if (response.items.length > response.page.limit) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "An Owner moderation page cannot exceed its declared limit.",
      });
    }
    const actionIds = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (
        item.content_id !== response.content_id ||
        actionIds.has(item.moderation_action_id)
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "Owner moderation records must be unique and match the Content.",
        });
      }
      actionIds.add(item.moderation_action_id);
      const previous = response.items[index - 1];
      if (
        previous !== undefined &&
        (Date.parse(previous.decided_at) < Date.parse(item.decided_at) ||
          (previous.decided_at === item.decided_at &&
            previous.moderation_action_id <= item.moderation_action_id))
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message:
            "Owner moderation records must use decided_at and action ID descending order.",
        });
      }
    }
  });
export type OwnerContentModerationListResponse = z.infer<
  typeof OwnerContentModerationListResponseSchema
>;
