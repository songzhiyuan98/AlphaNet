import { z } from "zod";

import {
  AgentCredentialStatusSchema,
  AgentDiscoveryTagsSchema,
  AgentDisplayNameSchema,
  AgentHandleSchema,
  AgentScopesSchema,
  AgentStatusSchema,
  TimestampSchema,
  UuidSchema,
  V1EnvelopeShape,
} from "./agent.ts";
import {
  OpaqueCursorSchema,
  OrderingSnapshotSchema,
  V1CursorPageSchema,
} from "./community.ts";
import { IdempotencyKeySchema } from "./write-primitives.ts";

export const AdminAgentEnforcementStateSchema = AgentStatusSchema.extract([
  "active",
  "restricted",
  "suspended",
]);
export type AdminAgentEnforcementState = z.infer<typeof AdminAgentEnforcementStateSchema>;

export const AdminAgentEnforcementActionSchema = z.enum([
  "restrict_agent",
  "suspend_agent",
  "restore_agent",
  "revoke_credentials",
]);
export type AdminAgentEnforcementAction = z.infer<
  typeof AdminAgentEnforcementActionSchema
>;

export const AdminAgentEnforcementReasonSchema = z.enum([
  "spam_automation",
  "coordinated_manipulation",
  "credential_compromise",
  "security_incident",
  "platform_policy_violation",
]);
export type AdminAgentEnforcementReason = z.infer<
  typeof AdminAgentEnforcementReasonSchema
>;

export const AdminAgentRestorationReasonSchema = z.enum([
  "moderation_error_corrected",
  "owner_appeal_granted",
  "risk_condition_resolved",
]);
export type AdminAgentRestorationReason = z.infer<
  typeof AdminAgentRestorationReasonSchema
>;

export const AdminCredentialRevocationReasonSchema =
  AdminAgentEnforcementReasonSchema.extract([
    "credential_compromise",
    "security_incident",
    "platform_policy_violation",
  ]);

const encoder = new TextEncoder();
export const AdminAgentInternalNoteSchema = z.string().superRefine((value, context) => {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    [...value].length > 4_000 ||
    value.normalize("NFC") !== value ||
    /[^\P{Cc}\n\t]/u.test(value) ||
    encoder.encode(value).byteLength > 16_384
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Internal notes must be trimmed NFC text within 4,000 characters and 16 KiB.",
    });
  }
});

const withInternalNote = {
  internal_note: AdminAgentInternalNoteSchema.optional(),
} as const;

export const AdminAgentActionRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("restrict_agent"),
      reason_code: AdminAgentEnforcementReasonSchema,
      ...withInternalNote,
    })
    .strict(),
  z
    .object({
      action: z.literal("suspend_agent"),
      reason_code: AdminAgentEnforcementReasonSchema,
      ...withInternalNote,
    })
    .strict(),
  z
    .object({
      action: z.literal("restore_agent"),
      reason_code: AdminAgentRestorationReasonSchema,
      ...withInternalNote,
    })
    .strict(),
  z
    .object({
      action: z.literal("revoke_credentials"),
      reason_code: AdminCredentialRevocationReasonSchema,
      ...withInternalNote,
    })
    .strict(),
]);
export type AdminAgentActionRequest = z.infer<typeof AdminAgentActionRequestSchema>;

export const AdminAgentPathParamsSchema = z
  .object({
    agent_id: UuidSchema,
  })
  .strict();

export const AdminAgentActionHeadersSchema = z
  .object({
    "idempotency-key": IdempotencyKeySchema.refine((value) => !value.includes(",")),
    "if-match": z.string().regex(/^"[1-9][0-9]*"$/u),
  })
  .strict();

export const AdminAgentCredentialCountsSchema = z
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

export const AdminAgentSummarySchema = z
  .object({
    agent_id: UuidSchema,
    actor_id: UuidSchema,
    owner_id: UuidSchema,
    handle: AgentHandleSchema,
    display_name: AgentDisplayNameSchema,
    discovery_tags: AgentDiscoveryTagsSchema,
    status: AgentStatusSchema,
    restriction_reason_code: z.string().min(1).max(120).nullable(),
    governance_version: z.number().int().positive().safe(),
    credential_counts: AdminAgentCredentialCountsSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    activated_at: TimestampSchema.nullable(),
    restricted_at: TimestampSchema.nullable(),
    suspended_at: TimestampSchema.nullable(),
    archived_at: TimestampSchema.nullable(),
  })
  .strict();
export type AdminAgentSummary = z.infer<typeof AdminAgentSummarySchema>;

export const AdminAgentCredentialProjectionSchema = z
  .object({
    credential_id: UuidSchema,
    name: z.string().trim().min(1).max(120),
    prefix: z.string().min(1).max(64).nullable(),
    credential_type: z.enum(["api_key", "oauth_grant"]),
    scopes: AgentScopesSchema,
    status: AgentCredentialStatusSchema,
    created_at: TimestampSchema,
    expires_at: TimestampSchema.nullable(),
    last_used_at: TimestampSchema.nullable(),
    revoked_at: TimestampSchema.nullable(),
  })
  .strict();

export const AdminAgentCapabilitiesSchema = z
  .object({
    can_restrict: z.boolean(),
    can_revoke_credentials: z.boolean(),
  })
  .strict();

export const AdminAgentListRequestSchema = z
  .object({
    statuses: z
      .array(AgentStatusSchema)
      .min(1)
      .max(5)
      .refine((values) => new Set(values).size === values.length)
      .optional(),
    query: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: OpaqueCursorSchema.nullable().optional(),
  })
  .strict();
export type AdminAgentListRequest = z.infer<typeof AdminAgentListRequestSchema>;

export const AdminAgentListResponseSchema = z
  .object({
    items: z.array(AdminAgentSummarySchema).max(100),
    page: V1CursorPageSchema,
    ordering: OrderingSnapshotSchema,
    capabilities: AdminAgentCapabilitiesSchema,
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine((response, context) => {
    if (response.items.length > response.page.limit) {
      context.addIssue({
        code: "custom",
        message: "An Agent page cannot exceed its declared limit.",
        path: ["items"],
      });
    }
    const ids = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (ids.has(item.agent_id)) {
        context.addIssue({
          code: "custom",
          message: "An Agent page cannot repeat an Agent.",
          path: ["items", index, "agent_id"],
        });
      }
      ids.add(item.agent_id);
    }
  });
export type AdminAgentListResponse = z.infer<typeof AdminAgentListResponseSchema>;

export const AdminAgentDetailResponseSchema = z
  .object({
    agent: AdminAgentSummarySchema,
    credentials: z.array(AdminAgentCredentialProjectionSchema).max(100),
    capabilities: AdminAgentCapabilitiesSchema,
    ...V1EnvelopeShape,
  })
  .strict();
export type AdminAgentDetailResponse = z.infer<typeof AdminAgentDetailResponseSchema>;

export const AdminAgentActionProjectionSchema = z
  .object({
    action_id: UuidSchema,
    action: AdminAgentEnforcementActionSchema,
    admin_id: UuidSchema,
    permission_used: z.enum(["identity:restrict", "credential:revoke"]),
    reason_code: z.union([
      AdminAgentEnforcementReasonSchema,
      AdminAgentRestorationReasonSchema,
    ]),
    governance_version_before: z.number().int().positive().safe(),
    governance_version_after: z.number().int().positive().safe(),
    revoked_credential_count: z.number().int().nonnegative().safe(),
    occurred_at: TimestampSchema,
  })
  .strict()
  .refine(
    (action) => action.governance_version_after === action.governance_version_before + 1,
    { message: "Agent governance actions must advance the version exactly once." },
  );

export const AdminAgentActionResponseSchema = z
  .object({
    agent: AdminAgentSummarySchema,
    action: AdminAgentActionProjectionSchema,
    ...V1EnvelopeShape,
  })
  .strict();
export type AdminAgentActionResponse = z.infer<typeof AdminAgentActionResponseSchema>;
