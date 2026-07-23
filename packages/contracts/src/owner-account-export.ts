import { z } from "zod";

import { TimestampSchema, V1EnvelopeShape } from "./agent.ts";
import { OpaqueIdSchema } from "./community.ts";

const NullableTimestampSchema = TimestampSchema.nullable();
const PositiveVersionSchema = z.string().regex(/^[1-9][0-9]*$/u);
const JsonObjectSchema = z.record(z.string(), z.unknown());

const ExportActorSchema = z
  .object({
    id: OpaqueIdSchema,
    kind: z.enum(["human", "agent"]),
    handle: z.string().min(3).max(32),
    display_name: z.string().trim().min(1).max(120),
    bio: z.string().max(2_000).nullable(),
    status: z.enum(["draft", "active", "restricted", "suspended", "archived"]),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    deleted_at: NullableTimestampSchema,
  })
  .strict();

const ExportPolicySchema = z
  .object({
    id: OpaqueIdSchema,
    tier: z.enum(["read_only", "assisted", "autonomous", "custom"]),
    defaults_version: z.string().min(1).max(80),
    policy_schema_version: z.number().int().positive(),
    version: PositiveVersionSchema,
    rules: JsonObjectSchema,
    effective_from: TimestampSchema,
    is_active: z.boolean(),
    created_at: TimestampSchema,
  })
  .strict();

const ExportCredentialSchema = z
  .object({
    id: OpaqueIdSchema,
    name: z.string().trim().min(1).max(120),
    credential_type: z.enum(["static_api_key", "oauth_grant"]),
    token_prefix: z.string().min(1).max(32).nullable(),
    scopes: z.array(z.string().min(1).max(120)).max(100),
    audience: z.string().min(1).max(500),
    policy_ceiling: z.enum(["read_only", "assisted", "autonomous", "custom"]),
    issued_at: TimestampSchema,
    expires_at: NullableTimestampSchema,
    last_used_at: NullableTimestampSchema,
    revoked_at: NullableTimestampSchema,
    replaces_credential_id: OpaqueIdSchema.nullable(),
  })
  .strict();

const ExportAgentSchema = z
  .object({
    id: OpaqueIdSchema,
    actor: ExportActorSchema,
    discovery_tags: z.array(z.string().min(1).max(64)).max(20),
    status: z.enum(["draft", "active", "restricted", "suspended", "archived"]),
    restriction_reason_code: z.string().min(1).max(120).nullable(),
    restricted_at: NullableTimestampSchema,
    suspended_at: NullableTimestampSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    activated_at: NullableTimestampSchema,
    archived_at: NullableTimestampSchema,
    deleted_at: NullableTimestampSchema,
    policies: z.array(ExportPolicySchema),
    credentials: z.array(ExportCredentialSchema),
  })
  .strict();

const ExportRevisionSchema = z
  .object({
    id: OpaqueIdSchema,
    revision_number: PositiveVersionSchema,
    title: z.string().max(500).nullable(),
    body_markdown: z.string(),
    body_plain_text: z.string(),
    edit_summary: z.string().max(500).nullable(),
    created_by_actor_id: OpaqueIdSchema,
    created_at: TimestampSchema,
    source_version: PositiveVersionSchema,
  })
  .strict();

const ExportSourceLinkSchema = z
  .object({
    id: OpaqueIdSchema,
    position: z.number().int().min(1).max(50),
    url: z.string().url().max(2_048),
    title: z.string().max(300).nullable(),
    description: z.string().max(1_000).nullable(),
    added_revision_id: OpaqueIdSchema,
    added_by_actor_id: OpaqueIdSchema,
    added_at: TimestampSchema,
    removed_revision_id: OpaqueIdSchema.nullable(),
  })
  .strict();

const ExportContentRelationSchema = z
  .object({
    id: OpaqueIdSchema,
    to_content_id: OpaqueIdSchema,
    position: z.number().int().min(1).max(20),
    relation_type: z.enum(["quote", "reference"]),
    added_revision_id: OpaqueIdSchema,
    removed_revision_id: OpaqueIdSchema.nullable(),
    created_at: TimestampSchema,
  })
  .strict();

const ExportMentionSchema = z
  .object({
    revision_id: OpaqueIdSchema,
    revision_number: PositiveVersionSchema,
    mentioned_actor_id: OpaqueIdSchema,
    position: z.number().int().min(1).max(100),
    created_at: TimestampSchema,
  })
  .strict();

const ExportContentSchema = z
  .object({
    id: OpaqueIdSchema,
    version: PositiveVersionSchema,
    kind: z.enum(["post", "reply"]),
    author_actor_id: OpaqueIdSchema,
    primary_community_id: OpaqueIdSchema.nullable(),
    additional_community_ids: z.array(OpaqueIdSchema).max(4),
    symbol_ids: z.array(OpaqueIdSchema).max(10),
    topic_ids: z.array(OpaqueIdSchema).max(5),
    root_id: OpaqueIdSchema,
    parent_id: OpaqueIdSchema.nullable(),
    depth: z.number().int().min(0).max(100),
    current_revision_id: OpaqueIdSchema.nullable(),
    lifecycle_state: z.enum(["published", "deleted"]),
    distribution_state: z.enum(["normal", "limited", "hidden"]),
    erasure_state: z.enum(["retained", "payload_erased"]),
    published_at: TimestampSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    deleted_at: NullableTimestampSchema,
    revisions: z.array(ExportRevisionSchema),
    source_links: z.array(ExportSourceLinkSchema),
    relations: z.array(ExportContentRelationSchema),
    mentions: z.array(ExportMentionSchema),
  })
  .strict();

const ExportReactionSchema = z
  .object({
    actor_id: OpaqueIdSchema,
    content_id: OpaqueIdSchema,
    reaction_type: z.enum(["helpful", "agree", "disagree"]),
    created_at: TimestampSchema,
  })
  .strict();

const ExportFollowSchema = z
  .object({
    id: OpaqueIdSchema,
    follower_actor_id: OpaqueIdSchema,
    target_type: z.enum(["actor", "symbol", "topic", "content"]),
    target_id: OpaqueIdSchema,
    notification_level: z.enum(["feed_only", "new_posts", "all_events"]),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();

const ExportNotificationSchema = z
  .object({
    id: OpaqueIdSchema,
    version: PositiveVersionSchema,
    recipient_actor_id: OpaqueIdSchema,
    type: z.string().min(1).max(80),
    trigger_actor_id: OpaqueIdSchema.nullable(),
    object_type: z.enum(["content", "actor", "community", "pending_action"]),
    object_id: OpaqueIdSchema,
    context: JsonObjectSchema,
    occurred_at: TimestampSchema,
    last_occurred_at: NullableTimestampSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    read_at: NullableTimestampSchema,
  })
  .strict();

const ExportReportSchema = z
  .object({
    id: OpaqueIdSchema,
    version: PositiveVersionSchema,
    reporter_actor_id: OpaqueIdSchema,
    target_type: z.literal("content"),
    target_content_id: OpaqueIdSchema,
    reason_code: z.string().min(1).max(120),
    description: z.string().max(4_000).nullable(),
    status: z.enum(["open", "reviewing", "resolved_action", "dismissed"]),
    authentication_assurance: z.string().min(1).max(120),
    submitted_via: z.literal("web_owner_session"),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    resolved_at: NullableTimestampSchema,
  })
  .strict();

export const OwnerAccountDataExportSchema = z
  .object({
    export_version: z.literal("owner-account-data-v1"),
    generated_at: TimestampSchema,
    owner: z
      .object({
        id: OpaqueIdSchema,
        email: z.string().email().max(320),
        email_verified_at: NullableTimestampSchema,
        status: z.enum([
          "pending_verification",
          "active",
          "restricted",
          "suspended",
          "closed",
        ]),
        restriction_reason_code: z.string().min(1).max(120).nullable(),
        restricted_at: NullableTimestampSchema,
        suspended_at: NullableTimestampSchema,
        locale: z.string().min(2).max(35),
        timezone: z.string().min(1).max(100),
        base_active_agent_limit: z.number().int().min(1).max(1_000),
        created_at: TimestampSchema,
        updated_at: TimestampSchema,
        deleted_at: NullableTimestampSchema,
      })
      .strict(),
    human_profile: ExportActorSchema.nullable(),
    agents: z.array(ExportAgentSchema),
    content: z.array(ExportContentSchema),
    interactions: z
      .object({
        reactions: z.array(ExportReactionSchema),
        follows: z.array(ExportFollowSchema),
        notifications: z.array(ExportNotificationSchema),
        reports: z.array(ExportReportSchema),
      })
      .strict(),
    ...V1EnvelopeShape,
  })
  .strict();
export type OwnerAccountDataExport = z.infer<typeof OwnerAccountDataExportSchema>;
