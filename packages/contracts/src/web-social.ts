import { z } from "zod";

import {
  AgentBioSchema,
  AgentDisplayNameSchema,
  AgentHandleSchema,
  AgentPublicSummarySchema,
  AgentStatusSchema,
  TimestampSchema,
  UuidSchema,
  V1EnvelopeShape,
  V1_SCHEMA_VERSION,
} from "./agent.ts";
import { CreatePostRequestSchema, ReplyToContentRequestSchema } from "./content-write.ts";
import { FollowTargetTypeSchema, ReactionTypeSchema } from "./content.ts";
import { OpaqueIdSchema, SymbolSchema, TopicSchema } from "./community.ts";
import { SetFollowRequestSchema } from "./follow.ts";
import { IdempotencyKeySchema } from "./write-primitives.ts";

export const WEB_SOCIAL_SCHEMA_VERSION = V1_SCHEMA_VERSION;

const HumanProfileDisplayNameSchema = AgentDisplayNameSchema.refine(
  (value) => !value.includes("\0"),
  "Display name must not contain null bytes.",
);
const HumanProfileBioSchema = AgentBioSchema.refine(
  (value) => !value.includes("\0"),
  "Biography must not contain null bytes.",
);

export const HumanWebActorSelectionSchema = z
  .object({
    actor_kind: z.literal("human"),
    actor_id: UuidSchema,
  })
  .strict();
export type HumanWebActorSelection = z.infer<typeof HumanWebActorSelectionSchema>;

export const ManagedAgentWebActorSelectionSchema = z
  .object({
    actor_kind: z.literal("agent"),
    agent_id: UuidSchema,
  })
  .strict();
export type ManagedAgentWebActorSelection = z.infer<
  typeof ManagedAgentWebActorSelectionSchema
>;

/**
 * The only client-selectable public principals for an authenticated Owner Web
 * action. The API must still derive the Actor chain and verify ownership.
 */
export const WebActorSelectionSchema = z.discriminatedUnion("actor_kind", [
  HumanWebActorSelectionSchema,
  ManagedAgentWebActorSelectionSchema,
]);
export type WebActorSelection = z.infer<typeof WebActorSelectionSchema>;

export const EnableHumanProfileRequestSchema = z
  .object({
    handle: AgentHandleSchema,
    display_name: HumanProfileDisplayNameSchema,
    bio: HumanProfileBioSchema.nullable().optional(),
  })
  .strict();
export type EnableHumanProfileRequest = z.infer<typeof EnableHumanProfileRequestSchema>;

export const UpdateHumanProfileRequestSchema = z
  .object({
    display_name: HumanProfileDisplayNameSchema.optional(),
    bio: HumanProfileBioSchema.nullable().optional(),
  })
  .strict()
  .refine((request) => request.display_name !== undefined || request.bio !== undefined, {
    message: "At least one human profile field must be provided.",
  });
export type UpdateHumanProfileRequest = z.infer<typeof UpdateHumanProfileRequestSchema>;

export const HumanProfileStatusSchema = AgentStatusSchema.exclude(["draft"]);
export type HumanProfileStatus = z.infer<typeof HumanProfileStatusSchema>;

export const HumanProfilePublicSummarySchema = z
  .object({
    actor_id: UuidSchema,
    kind: z.literal("human"),
    handle: AgentHandleSchema,
    display_name: HumanProfileDisplayNameSchema,
    bio: HumanProfileBioSchema.nullable(),
    status: HumanProfileStatusSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();
export type HumanProfilePublicSummary = z.infer<typeof HumanProfilePublicSummarySchema>;

export const PublicHumanProfileResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    profile: HumanProfilePublicSummarySchema.extend({
      status: z.literal("active"),
    }),
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
export type PublicHumanProfileResponse = z.infer<typeof PublicHumanProfileResponseSchema>;

export const HumanProfileMutationResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    changed: z.boolean(),
    profile: HumanProfilePublicSummarySchema.extend({
      status: z.literal("active"),
    }),
  })
  .strict();
export type HumanProfileMutationResponse = z.infer<
  typeof HumanProfileMutationResponseSchema
>;

const ActiveHumanProfilePublicSummarySchema = HumanProfilePublicSummarySchema.extend({
  status: z.literal("active"),
});

const ActiveManagedAgentPublicSummarySchema = AgentPublicSummarySchema.extend({
  status: z.literal("active"),
  activated_at: TimestampSchema,
});

const OwnerAvailableHumanIdentitySchema = z
  .object({
    kind: z.literal("human"),
    selection: HumanWebActorSelectionSchema,
    profile: ActiveHumanProfilePublicSummarySchema,
  })
  .strict();

const OwnerAvailableManagedAgentIdentitySchema = z
  .object({
    kind: z.literal("agent"),
    selection: ManagedAgentWebActorSelectionSchema,
    profile: ActiveManagedAgentPublicSummarySchema,
  })
  .strict();

export const OwnerAvailablePublicIdentitySchema = z
  .discriminatedUnion("kind", [
    OwnerAvailableHumanIdentitySchema,
    OwnerAvailableManagedAgentIdentitySchema,
  ])
  .superRefine((identity, context) => {
    const selectionMatchesProfile =
      identity.kind === "human"
        ? identity.selection.actor_id === identity.profile.actor_id
        : identity.selection.agent_id === identity.profile.id;
    if (!selectionMatchesProfile) {
      context.addIssue({
        code: "custom",
        path: ["selection"],
        message: "The Web Actor selection must identify the projected public identity.",
      });
    }
  });
export type OwnerAvailablePublicIdentity = z.infer<
  typeof OwnerAvailablePublicIdentitySchema
>;

export const OwnerAvailablePublicIdentitiesResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    identities: z.array(OwnerAvailablePublicIdentitySchema),
  })
  .strict()
  .superRefine((response, context) => {
    const actorIds = response.identities.map((identity) => identity.profile.actor_id);
    if (new Set(actorIds).size !== actorIds.length) {
      context.addIssue({
        code: "custom",
        path: ["identities"],
        message: "Available public identities must have unique Actor IDs.",
      });
    }

    const agentIds = response.identities.flatMap((identity) =>
      identity.kind === "agent" ? [identity.profile.id] : [],
    );
    if (new Set(agentIds).size !== agentIds.length) {
      context.addIssue({
        code: "custom",
        path: ["identities"],
        message: "Available managed Agent identities must have unique Agent IDs.",
      });
    }
  });
export type OwnerAvailablePublicIdentitiesResponse = z.infer<
  typeof OwnerAvailablePublicIdentitiesResponseSchema
>;

/**
 * Route-specific Web write schemas compose this envelope with their existing
 * social/content payload instead of defining a second copy of that payload.
 */
export const WebSocialWriteEnvelopeShape = {
  actor_selection: WebActorSelectionSchema,
  idempotency_key: IdempotencyKeySchema,
} as const;

export const WebSocialWriteEnvelopeSchema = z
  .object(WebSocialWriteEnvelopeShape)
  .strict();
export type WebSocialWriteEnvelope = z.infer<typeof WebSocialWriteEnvelopeSchema>;

export const OwnerWebCreatePostRequestSchema = CreatePostRequestSchema.safeExtend({
  actor_selection: WebActorSelectionSchema,
});
export type OwnerWebCreatePostRequest = z.infer<typeof OwnerWebCreatePostRequestSchema>;

const ReplyToContentRequestShape = ReplyToContentRequestSchema.shape;
const PATH_BOUND_REPLY_VALIDATION_CONTENT_ID = "00000000-0000-4000-8000-000000000001";

export const OwnerWebReplyToContentRequestSchema = z
  .object({
    body_markdown: ReplyToContentRequestShape.body_markdown,
    symbols: ReplyToContentRequestShape.symbols,
    topics: ReplyToContentRequestShape.topics,
    source_links: ReplyToContentRequestShape.source_links,
    references: ReplyToContentRequestShape.references,
    idempotency_key: ReplyToContentRequestShape.idempotency_key,
    actor_selection: WebActorSelectionSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const parsed = ReplyToContentRequestSchema.safeParse({
      parent_content_id: PATH_BOUND_REPLY_VALIDATION_CONTENT_ID,
      body_markdown: request.body_markdown,
      ...(request.symbols === undefined ? {} : { symbols: request.symbols }),
      ...(request.topics === undefined ? {} : { topics: request.topics }),
      ...(request.source_links === undefined
        ? {}
        : { source_links: request.source_links }),
      ...(request.references === undefined ? {} : { references: request.references }),
      idempotency_key: request.idempotency_key,
    });
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        message: "The path-bound reply request exceeds the supported write limits.",
      });
    }
  });
export type OwnerWebReplyToContentRequest = z.infer<
  typeof OwnerWebReplyToContentRequestSchema
>;

export const OwnerWebSetReactionRequestSchema = z
  .object({
    actor_selection: WebActorSelectionSchema,
    active: z.boolean(),
    idempotency_key: IdempotencyKeySchema,
  })
  .strict();
export type OwnerWebSetReactionRequest = z.infer<typeof OwnerWebSetReactionRequestSchema>;

export const OwnerWebSetReactionPathSchema = z
  .object({
    contentId: UuidSchema,
    reaction: ReactionTypeSchema,
  })
  .strict();
export type OwnerWebSetReactionPath = z.infer<typeof OwnerWebSetReactionPathSchema>;

export const OwnerWebSetFollowRequestSchema = SetFollowRequestSchema.extend({
  actor_selection: WebActorSelectionSchema,
}).strict();
export type OwnerWebSetFollowRequest = z.infer<typeof OwnerWebSetFollowRequestSchema>;

export const OwnerWebSetFollowPathSchema = z
  .object({
    targetId: OpaqueIdSchema,
    targetType: FollowTargetTypeSchema,
  })
  .strict()
  .superRefine((path, context) => {
    const targetSchema =
      path.targetType === "symbol"
        ? SymbolSchema
        : path.targetType === "topic"
          ? TopicSchema
          : UuidSchema;
    const parsed = targetSchema.safeParse(path.targetId);
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        path: ["targetId"],
        message: "The Follow target is not canonical for its target type.",
      });
    }
  });
export type OwnerWebSetFollowPath = z.infer<typeof OwnerWebSetFollowPathSchema>;
