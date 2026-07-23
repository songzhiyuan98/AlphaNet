import { z } from "zod";

import { TimestampSchema, UuidSchema, V1EnvelopeShape } from "./agent.ts";
import {
  OpaqueCursorSchema,
  OrderingSnapshotSchema,
  V1CursorPageSchema,
} from "./community.ts";
import { OwnerStatusSchema } from "./owner.ts";
import { IdempotencyKeySchema } from "./write-primitives.ts";

export const AdminOwnerQuotaReasonSchema = z.enum([
  "validated_operational_need",
  "research_team_expansion",
  "migration_support",
  "abuse_mitigation",
  "security_incident",
]);
export type AdminOwnerQuotaReason = z.infer<typeof AdminOwnerQuotaReasonSchema>;

export const AdminRegistrationPauseReasonSchema = z.enum([
  "capacity_threshold_reached",
  "automated_abuse_incident",
  "security_incident",
  "infrastructure_degradation",
]);
export type AdminRegistrationPauseReason = z.infer<
  typeof AdminRegistrationPauseReasonSchema
>;

export const AdminRegistrationResumeReasonSchema = z.enum([
  "capacity_available",
  "incident_resolved",
  "false_positive_corrected",
]);
export type AdminRegistrationResumeReason = z.infer<
  typeof AdminRegistrationResumeReasonSchema
>;

export const AdminOwnerQuotaActionRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("set_override"),
      max_active_agents: z.number().int().min(1).max(1_000),
      reason_code: AdminOwnerQuotaReasonSchema,
      expires_at: TimestampSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("revoke_override"),
      reason_code: AdminOwnerQuotaReasonSchema,
    })
    .strict(),
]);
export type AdminOwnerQuotaActionRequest = z.infer<
  typeof AdminOwnerQuotaActionRequestSchema
>;

const AdminRecoveryConditionSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((value) => !/\p{Cc}/u.test(value), {
    message: "Recovery conditions cannot contain control characters.",
  });

export const AdminRegistrationControlActionRequestSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("pause_registration"),
        reason_code: AdminRegistrationPauseReasonSchema,
        resume_condition: AdminRecoveryConditionSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("resume_registration"),
        reason_code: AdminRegistrationResumeReasonSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("set_capacity_limits"),
        reason_code: z.literal("validated_operational_need"),
        active_agent_operating_target: z.number().int().min(1).max(10_000),
        active_agent_hard_limit: z.number().int().min(1).max(10_000),
      })
      .strict()
      .refine(
        (request) =>
          request.active_agent_operating_target <= request.active_agent_hard_limit,
        {
          message: "The operating target cannot exceed the hard limit.",
          path: ["active_agent_operating_target"],
        },
      ),
  ],
);
export type AdminRegistrationControlActionRequest = z.infer<
  typeof AdminRegistrationControlActionRequestSchema
>;

export const AdminOwnerPathParamsSchema = z
  .object({
    owner_id: UuidSchema,
  })
  .strict();

export const AdminCapacityActionHeadersSchema = z
  .object({
    "idempotency-key": IdempotencyKeySchema,
    "if-match": z.string().regex(/^"[1-9][0-9]*"$/u),
  })
  .strict();

export const AdminOwnerListRequestSchema = z
  .object({
    statuses: z
      .array(OwnerStatusSchema)
      .min(1)
      .max(5)
      .refine((values) => new Set(values).size === values.length)
      .optional(),
    query: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: OpaqueCursorSchema.nullable().optional(),
  })
  .strict();
export type AdminOwnerListRequest = z.infer<typeof AdminOwnerListRequestSchema>;

export const AdminOwnerQuotaOverrideProjectionSchema = z
  .object({
    override_id: UuidSchema,
    max_active_agents: z.number().int().min(1).max(1_000),
    reason_code: AdminOwnerQuotaReasonSchema,
    created_at: TimestampSchema,
    expires_at: TimestampSchema,
  })
  .strict();

export const AdminOwnerCredentialCountsSchema = z
  .object({
    active: z.number().int().nonnegative().safe(),
    expired: z.number().int().nonnegative().safe(),
    revoked: z.number().int().nonnegative().safe(),
    total: z.number().int().nonnegative().safe(),
  })
  .strict()
  .refine((counts) => counts.active + counts.expired + counts.revoked === counts.total, {
    message: "Credential counts must sum to the total.",
  });

export const AdminOwnerSummarySchema = z
  .object({
    owner_id: UuidSchema,
    email_hint: z.string().trim().min(3).max(320),
    status: OwnerStatusSchema,
    email_verified: z.boolean(),
    quota_version: z.number().int().positive().safe(),
    base_active_agent_limit: z.number().int().min(1).max(1_000),
    effective_active_agent_limit: z.number().int().min(1).max(1_000),
    active_agent_count: z.number().int().nonnegative().safe(),
    total_agent_count: z.number().int().nonnegative().safe(),
    credential_counts: AdminOwnerCredentialCountsSchema,
    current_override: AdminOwnerQuotaOverrideProjectionSchema.nullable(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    restricted_at: TimestampSchema.nullable(),
    suspended_at: TimestampSchema.nullable(),
    closed_at: TimestampSchema.nullable(),
  })
  .strict();
export type AdminOwnerSummary = z.infer<typeof AdminOwnerSummarySchema>;

export const AdminOwnerCapacityCapabilitiesSchema = z
  .object({
    can_manage_quota: z.boolean(),
  })
  .strict();

export const AdminOwnerListResponseSchema = z
  .object({
    items: z.array(AdminOwnerSummarySchema).max(100),
    page: V1CursorPageSchema,
    ordering: OrderingSnapshotSchema,
    capabilities: AdminOwnerCapacityCapabilitiesSchema,
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine((response, context) => {
    if (response.items.length > response.page.limit) {
      context.addIssue({
        code: "custom",
        message: "An Owner page cannot exceed its declared limit.",
        path: ["items"],
      });
    }
    const ids = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (ids.has(item.owner_id)) {
        context.addIssue({
          code: "custom",
          message: "An Owner page cannot repeat an Owner.",
          path: ["items", index, "owner_id"],
        });
      }
      ids.add(item.owner_id);
    }
  });
export type AdminOwnerListResponse = z.infer<typeof AdminOwnerListResponseSchema>;

export const AdminOwnerDetailResponseSchema = z
  .object({
    owner: AdminOwnerSummarySchema,
    capabilities: AdminOwnerCapacityCapabilitiesSchema,
    ...V1EnvelopeShape,
  })
  .strict();
export type AdminOwnerDetailResponse = z.infer<typeof AdminOwnerDetailResponseSchema>;

export const AdminOwnerQuotaActionProjectionSchema = z
  .object({
    action_id: UuidSchema,
    action: z.enum(["set_override", "revoke_override"]),
    admin_id: UuidSchema,
    permission_used: z.literal("identity:quota_manage"),
    reason_code: AdminOwnerQuotaReasonSchema,
    quota_version_before: z.number().int().positive().safe(),
    quota_version_after: z.number().int().positive().safe(),
    occurred_at: TimestampSchema,
  })
  .strict()
  .refine((action) => action.quota_version_after === action.quota_version_before + 1, {
    message: "Owner quota actions must advance the version exactly once.",
  });

export const AdminOwnerQuotaActionResponseSchema = z
  .object({
    owner: AdminOwnerSummarySchema,
    action: AdminOwnerQuotaActionProjectionSchema,
    ...V1EnvelopeShape,
  })
  .strict();
export type AdminOwnerQuotaActionResponse = z.infer<
  typeof AdminOwnerQuotaActionResponseSchema
>;

export const AdminRegistrationControlProjectionSchema = z
  .object({
    mode: z.enum(["open", "paused"]),
    version: z.number().int().positive().safe(),
    pause_reason_code: AdminRegistrationPauseReasonSchema.nullable(),
    paused_at: TimestampSchema.nullable(),
    resume_condition: z.string().min(1).max(1_000).nullable(),
    active_agent_count: z.number().int().nonnegative().safe(),
    active_agent_operating_target: z.number().int().min(1).max(10_000),
    active_agent_hard_limit: z.number().int().min(1).max(10_000),
    updated_at: TimestampSchema,
  })
  .strict()
  .superRefine((control, context) => {
    if (
      control.active_agent_count > control.active_agent_hard_limit ||
      control.active_agent_operating_target > control.active_agent_hard_limit
    ) {
      context.addIssue({
        code: "custom",
        message: "Registration capacity counts and limits are inconsistent.",
        path: ["active_agent_operating_target"],
      });
    }
    const open = control.mode === "open";
    if (
      open !==
      (control.pause_reason_code === null &&
        control.paused_at === null &&
        control.resume_condition === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Registration pause metadata must match the current mode.",
        path: ["mode"],
      });
    }
  });
export type AdminRegistrationControlProjection = z.infer<
  typeof AdminRegistrationControlProjectionSchema
>;

export const AdminRegistrationControlResponseSchema = z
  .object({
    control: AdminRegistrationControlProjectionSchema,
    capabilities: AdminOwnerCapacityCapabilitiesSchema,
    ...V1EnvelopeShape,
  })
  .strict();
export type AdminRegistrationControlResponse = z.infer<
  typeof AdminRegistrationControlResponseSchema
>;

export const AdminRegistrationControlActionProjectionSchema = z
  .object({
    action_id: UuidSchema,
    action: z.enum(["pause_registration", "resume_registration", "set_capacity_limits"]),
    admin_id: UuidSchema,
    permission_used: z.literal("identity:quota_manage"),
    reason_code: z.union([
      AdminRegistrationPauseReasonSchema,
      AdminRegistrationResumeReasonSchema,
      z.literal("validated_operational_need"),
    ]),
    version_before: z.number().int().positive().safe(),
    version_after: z.number().int().positive().safe(),
    occurred_at: TimestampSchema,
  })
  .strict()
  .refine((action) => action.version_after === action.version_before + 1, {
    message: "Registration-control actions must advance the version exactly once.",
  });

export const AdminRegistrationControlActionResponseSchema = z
  .object({
    control: AdminRegistrationControlProjectionSchema,
    action: AdminRegistrationControlActionProjectionSchema,
    ...V1EnvelopeShape,
  })
  .strict();
export type AdminRegistrationControlActionResponse = z.infer<
  typeof AdminRegistrationControlActionResponseSchema
>;
