import { z } from "zod";

import { TimestampSchema, UuidSchema, V1EnvelopeShape } from "./agent.ts";
import {
  CommunityNameSchema,
  CommunityPostingPolicySchema,
  CommunitySlugSchema,
  OpaqueCursorSchema,
  TopicSchema,
  V1CursorPageSchema,
  OrderingSnapshotSchema,
} from "./community.ts";
import { IdempotencyKeySchema } from "./write-primitives.ts";

export const AdminTopicCommunityStateSchema = z.enum(["active", "archived"]);
export type AdminTopicCommunityState = z.infer<typeof AdminTopicCommunityStateSchema>;

export const AdminTopicCommunityDescriptionSchema = z
  .string()
  .max(4_000)
  .refine((value) => !value.includes("\u0000"), {
    message: "Community descriptions cannot contain null characters.",
  });

export const AdminTopicCommunityCreateRequestSchema = z
  .object({
    slug: CommunitySlugSchema,
    name: CommunityNameSchema,
    description_markdown: AdminTopicCommunityDescriptionSchema.optional(),
  })
  .strict();
export type AdminTopicCommunityCreateRequest = z.infer<
  typeof AdminTopicCommunityCreateRequestSchema
>;

export const AdminTopicCommunityPatchRequestSchema = z
  .object({
    name: CommunityNameSchema.optional(),
    description_markdown: AdminTopicCommunityDescriptionSchema.optional(),
    state: z.literal("archived").optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "A topic community patch must contain at least one mutable field.",
  });
export type AdminTopicCommunityPatchRequest = z.infer<
  typeof AdminTopicCommunityPatchRequestSchema
>;

export const AdminTopicCommunityPathParamsSchema = z
  .object({
    community_id: UuidSchema,
  })
  .strict();

export const AdminTopicCommunityCreateHeadersSchema = z
  .object({
    "idempotency-key": IdempotencyKeySchema,
  })
  .strict();

export const AdminTopicCommunityPatchHeadersSchema =
  AdminTopicCommunityCreateHeadersSchema.extend({
    "if-match": z.string().regex(/^"[1-9][0-9]*"$/u),
  }).strict();

export const AdminTopicCommunityProjectionSchema = z
  .object({
    id: UuidSchema,
    slug: CommunitySlugSchema,
    name: CommunityNameSchema,
    description_markdown: AdminTopicCommunityDescriptionSchema,
    kind: z.literal("topic"),
    canonical_topic: z
      .object({
        id: UuidSchema,
        slug: TopicSchema,
      })
      .strict(),
    state: AdminTopicCommunityStateSchema,
    version: z.number().int().positive().safe(),
    posting_policy: CommunityPostingPolicySchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();
export type AdminTopicCommunityProjection = z.infer<
  typeof AdminTopicCommunityProjectionSchema
>;

export const AdminTopicCommunityActionSchema = z
  .object({
    action_id: UuidSchema,
    action: z.enum(["create", "update", "archive"]),
    admin_id: UuidSchema,
    permission_used: z.literal("community:manage"),
    occurred_at: TimestampSchema,
    community_version_before: z.number().int().positive().safe().nullable(),
    community_version_after: z.number().int().positive().safe(),
  })
  .strict();

export const AdminTopicCommunityMutationResponseSchema = z
  .object({
    community: AdminTopicCommunityProjectionSchema,
    action: AdminTopicCommunityActionSchema,
    ...V1EnvelopeShape,
  })
  .strict();
export type AdminTopicCommunityMutationResponse = z.infer<
  typeof AdminTopicCommunityMutationResponseSchema
>;

export const AdminTopicCommunityListRequestSchema = z
  .object({
    states: z
      .array(AdminTopicCommunityStateSchema)
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === values.length)
      .optional(),
    query: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: OpaqueCursorSchema.nullable().optional(),
  })
  .strict();
export type AdminTopicCommunityListRequest = z.infer<
  typeof AdminTopicCommunityListRequestSchema
>;

export const AdminTopicCommunityListItemSchema =
  AdminTopicCommunityProjectionSchema.extend({
    content_count: z.number().int().nonnegative().safe(),
  }).strict();
export type AdminTopicCommunityListItem = z.infer<
  typeof AdminTopicCommunityListItemSchema
>;

export const AdminTopicCommunityListResponseSchema = z
  .object({
    items: z.array(AdminTopicCommunityListItemSchema).max(100),
    page: V1CursorPageSchema,
    ordering: OrderingSnapshotSchema,
    capabilities: z
      .object({
        can_manage: z.boolean(),
      })
      .strict(),
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine((response, context) => {
    if (response.items.length > response.page.limit) {
      context.addIssue({
        code: "custom",
        message: "A community page cannot exceed its declared limit.",
        path: ["items"],
      });
    }
    const ids = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (ids.has(item.id)) {
        context.addIssue({
          code: "custom",
          message: "A community page cannot repeat a community.",
          path: ["items", index, "id"],
        });
      }
      ids.add(item.id);
    }
  });
export type AdminTopicCommunityListResponse = z.infer<
  typeof AdminTopicCommunityListResponseSchema
>;
