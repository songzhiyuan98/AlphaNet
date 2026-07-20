import { z } from "zod";

export const V1_SCHEMA_VERSION = "1" as const;

export const AgentScopeSchema = z.enum([
  "research:read",
  "community:read",
  "notifications:read",
  "actions:read",
  "content:write",
  "reaction:write",
  "follow:write",
]);
export type AgentScope = z.infer<typeof AgentScopeSchema>;
export const AGENT_SCOPES = AgentScopeSchema.options;

export const AgentToolNameSchema = z.enum([
  "get_agent_context",
  "find_communities",
  "get_community",
  "browse_content",
  "search_content",
  "get_content",
  "get_discussion",
  "list_notifications",
  "get_action_status",
  "create_post",
  "reply_to_content",
  "update_content",
  "delete_content",
  "set_reaction",
  "set_follow",
]);
export type AgentToolName = z.infer<typeof AgentToolNameSchema>;
export const AGENT_TOOL_NAMES = AgentToolNameSchema.options;

export const AgentHandleSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Handle must contain only lowercase letters, numbers, and internal hyphens.",
  );
export type AgentHandle = z.infer<typeof AgentHandleSchema>;

export const AgentDisplayNameSchema = z.string().trim().min(1).max(80);
export const AgentBioSchema = z.string().max(1_000);
export const AgentDiscoveryTagSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
    "Discovery tags must use lowercase letters, numbers, dots, underscores, or hyphens.",
  );

const uniqueArray = <T>(values: T[]) => new Set(values).size === values.length;

export const AgentDiscoveryTagsSchema = z
  .array(AgentDiscoveryTagSchema)
  .max(10)
  .refine(uniqueArray, "Discovery tags must be unique.");

export const AgentScopesSchema = z
  .array(AgentScopeSchema)
  .min(1)
  .refine(uniqueArray, "Credential scopes must be unique.");

export const AgentStatusSchema = z.enum([
  "draft",
  "active",
  "restricted",
  "suspended",
  "archived",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentPermissionTierSchema = z.enum([
  "read_only",
  "assisted",
  "autonomous",
  "custom",
]);
export type AgentPermissionTier = z.infer<typeof AgentPermissionTierSchema>;

export const PolicyDecisionSchema = z.enum(["allow", "require_approval", "deny"]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

const UuidSchema = z.uuid();
const TimestampSchema = z.iso.datetime({ offset: true });
const NullableTimestampSchema = TimestampSchema.nullable();
const V1EnvelopeShape = {
  request_id: z.string().min(1).max(200),
  schema_version: z.literal(V1_SCHEMA_VERSION),
} as const;

export const CreateAgentRequestSchema = z
  .object({
    handle: AgentHandleSchema,
    display_name: AgentDisplayNameSchema,
    bio: AgentBioSchema.optional(),
    discovery_tags: AgentDiscoveryTagsSchema.optional(),
  })
  .strict();
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export const UpdateAgentRequestSchema = z
  .object({
    display_name: AgentDisplayNameSchema.optional(),
    bio: AgentBioSchema.nullable().optional(),
    discovery_tags: AgentDiscoveryTagsSchema.optional(),
  })
  .strict()
  .refine((request) => Object.keys(request).length > 0, {
    message: "At least one Agent field must be provided.",
  });
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

export const AgentPolicySummarySchema = z
  .object({
    id: UuidSchema,
    tier: AgentPermissionTierSchema,
    defaults_version: z.string().min(1).max(100),
    policy_schema_version: z.string().min(1).max(100),
    version: z.number().int().positive(),
    effective_from: TimestampSchema,
  })
  .strict();
export type AgentPolicySummary = z.infer<typeof AgentPolicySummarySchema>;

const AgentDisplayShape = {
  id: UuidSchema,
  actor_id: UuidSchema,
  handle: AgentHandleSchema,
  display_name: AgentDisplayNameSchema,
  bio: AgentBioSchema.nullable(),
  discovery_tags: AgentDiscoveryTagsSchema,
} as const;

export const AgentPublicSummarySchema = z
  .object({
    ...AgentDisplayShape,
    status: AgentStatusSchema,
    created_at: TimestampSchema,
    activated_at: NullableTimestampSchema,
  })
  .strict();
export type AgentPublicSummary = z.infer<typeof AgentPublicSummarySchema>;

export const OwnerAgentSummarySchema = z
  .object({
    ...AgentDisplayShape,
    owner_id: UuidSchema,
    status: AgentStatusSchema,
    restriction_reason_code: z.string().min(1).max(100).nullable(),
    policy: AgentPolicySummarySchema,
    credential_count: z.number().int().nonnegative(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    activated_at: NullableTimestampSchema,
    archived_at: NullableTimestampSchema,
  })
  .strict();
export type OwnerAgentSummary = z.infer<typeof OwnerAgentSummarySchema>;

export const AgentActivationBlockReasonSchema = z.enum([
  "owner_email_unverified",
  "owner_not_active",
  "owner_active_agent_quota_exceeded",
  "global_active_agent_capacity_exceeded",
  "agent_not_draft",
]);
export type AgentActivationBlockReason = z.infer<typeof AgentActivationBlockReasonSchema>;

export const AgentActivationResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("activated"),
      reason: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal("deferred"),
      reason: AgentActivationBlockReasonSchema,
    })
    .strict(),
]);
export type AgentActivationResult = z.infer<typeof AgentActivationResultSchema>;

export const OwnerAgentListResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    agents: z.array(OwnerAgentSummarySchema),
    next_cursor: z.string().min(1).nullable(),
    quota: z
      .object({
        active_agent_count: z.number().int().nonnegative(),
        active_agent_limit: z.number().int().positive(),
        created_last_24_hours: z.number().int().nonnegative(),
        create_limit: z.number().int().positive(),
        create_retry_at: NullableTimestampSchema,
      })
      .strict(),
  })
  .strict();
export type OwnerAgentListResponse = z.infer<typeof OwnerAgentListResponseSchema>;

export const OwnerAgentCreateResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    agent: OwnerAgentSummarySchema,
    activation: AgentActivationResultSchema,
  })
  .strict();
export type OwnerAgentCreateResponse = z.infer<typeof OwnerAgentCreateResponseSchema>;

export const OwnerAgentUpdateResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    agent: OwnerAgentSummarySchema,
  })
  .strict();
export type OwnerAgentUpdateResponse = z.infer<typeof OwnerAgentUpdateResponseSchema>;

export const OwnerAgentActivateResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    agent: OwnerAgentSummarySchema,
    activation: AgentActivationResultSchema,
  })
  .strict();
export type OwnerAgentActivateResponse = z.infer<typeof OwnerAgentActivateResponseSchema>;

export const OwnerAgentArchiveResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    agent: OwnerAgentSummarySchema,
  })
  .strict();
export type OwnerAgentArchiveResponse = z.infer<typeof OwnerAgentArchiveResponseSchema>;

export const CreateCredentialRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: AgentScopesSchema,
    expires_at: TimestampSchema.optional(),
  })
  .strict();
export type CreateCredentialRequest = z.infer<typeof CreateCredentialRequestSchema>;

export const RotateCredentialRequestSchema = z
  .object({
    expires_at: TimestampSchema.optional(),
  })
  .strict();
export type RotateCredentialRequest = z.infer<typeof RotateCredentialRequestSchema>;

export const AgentCredentialStatusSchema = z.enum([
  "active",
  "expired",
  "revoked",
  "inactive_principal",
]);
export type AgentCredentialStatus = z.infer<typeof AgentCredentialStatusSchema>;

export const AgentCredentialSummarySchema = z
  .object({
    id: UuidSchema,
    agent_id: UuidSchema,
    name: z.string().min(1).max(80),
    credential_type: z.literal("static_api_key"),
    token_prefix: z.string().min(1).max(64),
    scopes: AgentScopesSchema,
    audience: z.string().min(1).max(300),
    status: AgentCredentialStatusSchema,
    issued_at: TimestampSchema,
    expires_at: NullableTimestampSchema,
    last_used_at: NullableTimestampSchema,
    rotated_at: NullableTimestampSchema,
    revoked_at: NullableTimestampSchema,
  })
  .strict();
export type AgentCredentialSummary = z.infer<typeof AgentCredentialSummarySchema>;

export const OwnerCredentialListResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    credentials: z.array(AgentCredentialSummarySchema),
    next_cursor: z.string().min(1).nullable(),
  })
  .strict();
export type OwnerCredentialListResponse = z.infer<
  typeof OwnerCredentialListResponseSchema
>;

export const OwnerCredentialCreateResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    credential: AgentCredentialSummarySchema,
    api_key: z.string().min(32).max(512),
  })
  .strict();
export type OwnerCredentialCreateResponse = z.infer<
  typeof OwnerCredentialCreateResponseSchema
>;

export const OwnerCredentialRotateResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    credential: AgentCredentialSummarySchema,
    api_key: z.string().min(32).max(512),
  })
  .strict();
export type OwnerCredentialRotateResponse = z.infer<
  typeof OwnerCredentialRotateResponseSchema
>;

export const OwnerCredentialRevokeResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    credential: AgentCredentialSummarySchema,
  })
  .strict();
export type OwnerCredentialRevokeResponse = z.infer<
  typeof OwnerCredentialRevokeResponseSchema
>;

export const AgentCapabilitySchema = z
  .object({
    available: z.boolean(),
    default_decision: PolicyDecisionSchema,
    conditional_decisions: z
      .record(z.string().min(1).max(100), PolicyDecisionSchema)
      .optional(),
  })
  .strict();
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;

export const AgentEffectiveCapabilitiesSchema = z
  .object({
    get_agent_context: AgentCapabilitySchema,
    find_communities: AgentCapabilitySchema,
    get_community: AgentCapabilitySchema,
    browse_content: AgentCapabilitySchema,
    search_content: AgentCapabilitySchema,
    get_content: AgentCapabilitySchema,
    get_discussion: AgentCapabilitySchema,
    list_notifications: AgentCapabilitySchema,
    get_action_status: AgentCapabilitySchema,
    create_post: AgentCapabilitySchema,
    reply_to_content: AgentCapabilitySchema,
    update_content: AgentCapabilitySchema,
    delete_content: AgentCapabilitySchema,
    set_reaction: AgentCapabilitySchema,
    set_follow: AgentCapabilitySchema,
  })
  .strict();
export type AgentEffectiveCapabilities = z.infer<typeof AgentEffectiveCapabilitiesSchema>;

export const AgentContextResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    agent: z
      .object({
        id: UuidSchema,
        actor_id: UuidSchema,
        handle: AgentHandleSchema,
        display_name: AgentDisplayNameSchema,
      })
      .strict(),
    owner: z
      .object({
        id: UuidSchema,
      })
      .strict(),
    credential: z
      .object({
        id: UuidSchema,
        name: z.string().min(1).max(80),
        scopes: AgentScopesSchema,
        audience: z.string().min(1).max(300),
        expires_at: NullableTimestampSchema,
      })
      .strict(),
    permission_tier: AgentPermissionTierSchema,
    policy_version: z.string().min(1).max(200),
    effective_capabilities: AgentEffectiveCapabilitiesSchema,
    quota: z
      .object({
        window_ends_at: TimestampSchema,
        writes_remaining: z.number().int().nonnegative(),
      })
      .strict(),
    server_time: TimestampSchema,
  })
  .strict();
export type AgentContextResponse = z.infer<typeof AgentContextResponseSchema>;

export const PublicAgentProfileResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    agent: AgentPublicSummarySchema,
    stats: z
      .object({
        posts_count: z.number().int().nonnegative(),
        replies_count: z.number().int().nonnegative(),
        followers_count: z.number().int().nonnegative(),
        following_count: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type PublicAgentProfileResponse = z.infer<typeof PublicAgentProfileResponseSchema>;
