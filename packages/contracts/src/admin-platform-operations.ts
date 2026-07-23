import { z } from "zod";

import { TimestampSchema, UuidSchema, V1EnvelopeShape } from "./agent.ts";
import { IdempotencyKeySchema } from "./write-primitives.ts";

export const AdminCommunityWritePauseReasonSchema = z.enum([
  "security_incident",
  "integrity_incident",
  "infrastructure_degradation",
  "emergency_maintenance",
]);
export type AdminCommunityWritePauseReason = z.infer<
  typeof AdminCommunityWritePauseReasonSchema
>;

export const AdminCommunityWriteResumeReasonSchema = z.enum([
  "incident_resolved",
  "integrity_restored",
  "infrastructure_recovered",
  "maintenance_completed",
  "false_positive_corrected",
]);
export type AdminCommunityWriteResumeReason = z.infer<
  typeof AdminCommunityWriteResumeReasonSchema
>;

const RecoveryConditionSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((value) => !/\p{Cc}/u.test(value), {
    message: "Recovery conditions cannot contain control characters.",
  });

export const AdminCommunityWriteControlActionRequestSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("pause_community_writes"),
        reason_code: AdminCommunityWritePauseReasonSchema,
        resume_condition: RecoveryConditionSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("resume_community_writes"),
        reason_code: AdminCommunityWriteResumeReasonSchema,
      })
      .strict(),
  ],
);
export type AdminCommunityWriteControlActionRequest = z.infer<
  typeof AdminCommunityWriteControlActionRequestSchema
>;

export const AdminPlatformActionHeadersSchema = z
  .object({
    "idempotency-key": IdempotencyKeySchema,
    "if-match": z.string().regex(/^"[1-9][0-9]*"$/u),
  })
  .strict();

export const AdminCommunityWriteControlProjectionSchema = z
  .object({
    mode: z.enum(["open", "paused"]),
    version: z.number().int().positive().safe(),
    pause_reason_code: AdminCommunityWritePauseReasonSchema.nullable(),
    paused_at: TimestampSchema.nullable(),
    resume_condition: z.string().trim().min(1).max(1_000).nullable(),
    updated_by_admin_id: UuidSchema.nullable(),
    updated_at: TimestampSchema,
  })
  .strict()
  .superRefine((control, context) => {
    const openIsConsistent =
      control.mode === "open" &&
      control.pause_reason_code === null &&
      control.paused_at === null &&
      control.resume_condition === null;
    const pausedIsConsistent =
      control.mode === "paused" &&
      control.pause_reason_code !== null &&
      control.paused_at !== null &&
      control.resume_condition !== null &&
      control.updated_by_admin_id !== null;
    if (!openIsConsistent && !pausedIsConsistent) {
      context.addIssue({
        code: "custom",
        message: "Community-write control state is inconsistent.",
      });
    }
  });
export type AdminCommunityWriteControlProjection = z.infer<
  typeof AdminCommunityWriteControlProjectionSchema
>;

export const AdminPlatformOperationsCapabilitiesSchema = z
  .object({
    can_operate_platform: z.boolean(),
  })
  .strict();

export const AdminCommunityWriteControlResponseSchema = z
  .object({
    capabilities: AdminPlatformOperationsCapabilitiesSchema,
    control: AdminCommunityWriteControlProjectionSchema,
    ...V1EnvelopeShape,
  })
  .strict();
export type AdminCommunityWriteControlResponse = z.infer<
  typeof AdminCommunityWriteControlResponseSchema
>;

export const AdminCommunityWriteControlActionProjectionSchema = z
  .object({
    action_id: UuidSchema,
    action: z.enum(["pause_community_writes", "resume_community_writes"]),
    admin_id: UuidSchema,
    permission_used: z.literal("platform:operate"),
    reason_code: z.union([
      AdminCommunityWritePauseReasonSchema,
      AdminCommunityWriteResumeReasonSchema,
    ]),
    version_before: z.number().int().positive().safe(),
    version_after: z.number().int().positive().safe(),
    occurred_at: TimestampSchema,
  })
  .strict()
  .refine((action) => action.version_after === action.version_before + 1, {
    message: "Platform operations must advance the control version exactly once.",
  });

export const AdminCommunityWriteControlActionResponseSchema = z
  .object({
    action: AdminCommunityWriteControlActionProjectionSchema,
    control: AdminCommunityWriteControlProjectionSchema,
    ...V1EnvelopeShape,
  })
  .strict();
export type AdminCommunityWriteControlActionResponse = z.infer<
  typeof AdminCommunityWriteControlActionResponseSchema
>;
