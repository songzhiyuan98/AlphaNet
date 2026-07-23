import { z } from "zod";

import { TimestampSchema, V1EnvelopeShape } from "./agent.ts";
import { OpaqueIdSchema } from "./community.ts";

export const OwnerAuditOutcomeSchema = z.enum([
  "succeeded",
  "pending",
  "denied",
  "failed",
]);
export type OwnerAuditOutcome = z.infer<typeof OwnerAuditOutcomeSchema>;

export const OwnerAuditEventClassSchema = z.enum([
  "domain_write",
  "authorization_change",
  "approval_transition",
  "governance",
  "sensitive_read",
  "security_rejection",
]);
export type OwnerAuditEventClass = z.infer<typeof OwnerAuditEventClassSchema>;

export const OwnerAuditDecisionSchema = z.enum(["allow", "require_approval", "deny"]);
export type OwnerAuditDecision = z.infer<typeof OwnerAuditDecisionSchema>;

export const OwnerAuditApprovalMethodSchema = z.enum([
  "policy_auto",
  "owner_approval",
  "owner_direct",
  "human_direct",
  "admin_override",
]);
export type OwnerAuditApprovalMethod = z.infer<typeof OwnerAuditApprovalMethodSchema>;

export const OwnerAuditSearchOutcomeSchema = z.enum(["started", "succeeded", "failed"]);
export type OwnerAuditSearchOutcome = z.infer<typeof OwnerAuditSearchOutcomeSchema>;

export const OwnerAuditSearchSurfaceSchema = z.enum(["rest", "mcp", "sdk", "web"]);
export type OwnerAuditSearchSurface = z.infer<typeof OwnerAuditSearchSurfaceSchema>;

export const OwnerAuditSearchModeSchema = z.enum(["lexical", "semantic", "hybrid"]);
export type OwnerAuditSearchMode = z.infer<typeof OwnerAuditSearchModeSchema>;

const AuditActionSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9_.-]{0,159}$/u);
const AuditCursorSchema = z.string().min(16).max(2_048);
const AuditLimitSchema = z.number().int().min(1).max(100).default(25);

export const OwnerAuditActionListRequestSchema = z
  .object({
    agent_id: OpaqueIdSchema.optional(),
    credential_id: OpaqueIdSchema.optional(),
    action: AuditActionSchema.optional(),
    outcome: OwnerAuditOutcomeSchema.optional(),
    from: TimestampSchema.optional(),
    to: TimestampSchema.optional(),
    limit: AuditLimitSchema.optional(),
    cursor: AuditCursorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.from !== undefined &&
      value.to !== undefined &&
      Date.parse(value.from) > Date.parse(value.to)
    ) {
      context.addIssue({
        code: "custom",
        message: "from must not be later than to",
        path: ["from"],
      });
    }
  });
export type OwnerAuditActionListRequest = z.infer<
  typeof OwnerAuditActionListRequestSchema
>;

export const OwnerAuditSearchListRequestSchema = z
  .object({
    agent_id: OpaqueIdSchema.optional(),
    credential_id: OpaqueIdSchema.optional(),
    outcome: OwnerAuditSearchOutcomeSchema.optional(),
    surface: OwnerAuditSearchSurfaceSchema.optional(),
    from: TimestampSchema.optional(),
    to: TimestampSchema.optional(),
    limit: AuditLimitSchema.optional(),
    cursor: AuditCursorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.from !== undefined &&
      value.to !== undefined &&
      Date.parse(value.from) > Date.parse(value.to)
    ) {
      context.addIssue({
        code: "custom",
        message: "from must not be later than to",
        path: ["from"],
      });
    }
  });
export type OwnerAuditSearchListRequest = z.infer<
  typeof OwnerAuditSearchListRequestSchema
>;

const OwnerAuditAgentSchema = z
  .object({
    id: OpaqueIdSchema,
    handle: z
      .string()
      .min(3)
      .max(32)
      .regex(/^[a-z0-9][a-z0-9_.-]{2,31}$/u),
    display_name: z.string().trim().min(1).max(120),
  })
  .strict();

const OwnerAuditCredentialSchema = z
  .object({
    id: OpaqueIdSchema,
    name: z.string().trim().min(1).max(120),
    token_prefix: z.string().min(1).max(32),
  })
  .strict();

export const OwnerAuditActionSchema = z
  .object({
    id: OpaqueIdSchema,
    event_class: OwnerAuditEventClassSchema,
    occurred_at: TimestampSchema,
    actor: z
      .object({
        id: OpaqueIdSchema,
        kind: z.enum(["human", "agent"]),
        handle: z.string().min(3).max(32),
        display_name: z.string().trim().min(1).max(120),
      })
      .strict()
      .nullable(),
    agent: OwnerAuditAgentSchema.nullable(),
    credential: OwnerAuditCredentialSchema.nullable(),
    channel: z.string().min(1).max(60),
    action: AuditActionSchema,
    target: z
      .object({
        type: z.string().min(1).max(80),
        id: z.string().min(1).max(200),
      })
      .strict()
      .nullable(),
    decision: OwnerAuditDecisionSchema.nullable(),
    outcome: OwnerAuditOutcomeSchema,
    error_code: z.string().min(1).max(120).nullable(),
    reason_code: z.string().min(1).max(120).nullable(),
    policy_version: z
      .string()
      .regex(/^[1-9][0-9]*$/u)
      .nullable(),
    approval_method: OwnerAuditApprovalMethodSchema.nullable(),
    approved_by_owner: z.boolean(),
    request_id: z.string().trim().min(1).max(200),
    outbox_event_id: OpaqueIdSchema.nullable(),
    retry_count: z.number().int().min(0).safe(),
  })
  .strict();
export type OwnerAuditAction = z.infer<typeof OwnerAuditActionSchema>;

export const OwnerAuditSearchActivitySchema = z
  .object({
    id: OpaqueIdSchema,
    occurred_at: TimestampSchema,
    finalized_at: TimestampSchema.nullable(),
    expires_at: TimestampSchema,
    request_id: z.string().trim().min(1).max(200),
    agent: OwnerAuditAgentSchema,
    credential: OwnerAuditCredentialSchema,
    surface: OwnerAuditSearchSurfaceSchema,
    search_mode: OwnerAuditSearchModeSchema,
    outcome: OwnerAuditSearchOutcomeSchema,
    result_count: z.number().int().min(0).max(1_000).nullable(),
    latency_ms: z.number().int().min(0).max(300_000).nullable(),
    fallback_reason_code: z.string().min(1).max(120).nullable(),
  })
  .strict();
export type OwnerAuditSearchActivity = z.infer<typeof OwnerAuditSearchActivitySchema>;

const OwnerAuditPageSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    has_more: z.boolean(),
    next_cursor: AuditCursorSchema.nullable(),
  })
  .strict();

export const OwnerAuditActionListResponseSchema = z
  .object({
    items: z.array(OwnerAuditActionSchema).max(100),
    page: OwnerAuditPageSchema,
    filters: z
      .object({
        agent_id: OpaqueIdSchema.nullable(),
        credential_id: OpaqueIdSchema.nullable(),
        action: AuditActionSchema.nullable(),
        outcome: OwnerAuditOutcomeSchema.nullable(),
        from: TimestampSchema.nullable(),
        to: TimestampSchema.nullable(),
      })
      .strict(),
    ...V1EnvelopeShape,
  })
  .strict();
export type OwnerAuditActionListResponse = z.infer<
  typeof OwnerAuditActionListResponseSchema
>;

export const OwnerAuditSearchListResponseSchema = z
  .object({
    items: z.array(OwnerAuditSearchActivitySchema).max(100),
    page: OwnerAuditPageSchema,
    filters: z
      .object({
        agent_id: OpaqueIdSchema.nullable(),
        credential_id: OpaqueIdSchema.nullable(),
        outcome: OwnerAuditSearchOutcomeSchema.nullable(),
        surface: OwnerAuditSearchSurfaceSchema.nullable(),
        from: TimestampSchema.nullable(),
        to: TimestampSchema.nullable(),
      })
      .strict(),
    ...V1EnvelopeShape,
  })
  .strict();
export type OwnerAuditSearchListResponse = z.infer<
  typeof OwnerAuditSearchListResponseSchema
>;
