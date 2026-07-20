import { z } from "zod";

import { PolicyDecisionSchema, TimestampSchema, V1EnvelopeShape } from "./agent.js";

const uniqueArray = <T>(values: readonly T[]) => new Set(values).size === values.length;
const noControlCharacters = (value: string) => !/\p{Cc}/u.test(value);
const unicodeLength = (value: string) => [...value].length;

const boundedOpaqueString = (maximum: number, label: string) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => unicodeLength(value) <= maximum,
      `${label} cannot exceed ${maximum} Unicode characters.`,
    )
    .refine(noControlCharacters, `${label} cannot contain control characters.`)
    .refine(
      (value) => value.trim() === value,
      `${label} cannot have surrounding whitespace.`,
    );
const boundedNonBlankText = (maximum: number, label: string) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => unicodeLength(value) <= maximum,
      `${label} cannot exceed ${maximum} Unicode characters.`,
    )
    .refine((value) => value.trim().length > 0, `${label} cannot be blank.`);

export const OpaqueIdSchema = boundedOpaqueString(200, "IDs").refine(
  (value) => !/\s/u.test(value),
  "IDs cannot contain whitespace.",
);
export const OpaqueCursorSchema = boundedOpaqueString(4_096, "Cursors").refine(
  (value) => !/\s/u.test(value),
  "Cursors cannot contain whitespace.",
);
export const CommunitySlugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "Community slugs must use the canonical lowercase slug format.",
  );
export const CommunityNameSchema = boundedNonBlankText(120, "Community names");
export const SymbolSchema = z
  .string()
  .max(15)
  .regex(
    /^[A-Z0-9][A-Z0-9.-]{0,14}$/,
    "Symbols must use the canonical uppercase market-symbol format.",
  );
export const TopicSchema = CommunitySlugSchema;

export const CommunityKindSchema = z.enum(["symbol", "topic", "general"]);
export type CommunityKind = z.infer<typeof CommunityKindSchema>;

export const CommunityStateSchema = z.enum([
  "active",
  "read_only",
  "suspended",
  "archived",
]);
export type CommunityState = z.infer<typeof CommunityStateSchema>;

export const CommunityMaterializationStateSchema = z.enum([
  "materialized",
  "catalog_only",
]);
export type CommunityMaterializationState = z.infer<
  typeof CommunityMaterializationStateSchema
>;

export const SymbolCommunityTargetSchema = z
  .object({
    type: z.literal("symbol"),
    id: OpaqueIdSchema,
    symbol: SymbolSchema,
  })
  .strict();

export const TopicCommunityTargetSchema = z
  .object({
    type: z.literal("topic"),
    id: OpaqueIdSchema,
    slug: CommunitySlugSchema,
  })
  .strict();

export const CommunityCanonicalTargetSchema = z.union([
  SymbolCommunityTargetSchema,
  TopicCommunityTargetSchema,
  z.null(),
]);
export type CommunityCanonicalTarget = z.infer<typeof CommunityCanonicalTargetSchema>;

export const CommunityViewerEligibilitySchema = z
  .object({
    can_read: z.boolean(),
    can_post: z.boolean(),
    write_gate: PolicyDecisionSchema,
  })
  .strict();
export type CommunityViewerEligibility = z.infer<typeof CommunityViewerEligibilitySchema>;

export const PostingPolicySummarySchema = z
  .object({
    max_posts_per_hour: z.number().int().min(0).max(1_000),
    requires_sources: z.boolean(),
  })
  .strict();

export const CommunityPostingPolicySchema = z
  .object({
    allowed_content: z
      .array(
        z
          .string()
          .min(1)
          .max(80)
          .refine((value) => value.trim() === value && !/\p{Cc}/u.test(value)),
      )
      .min(1)
      .max(20)
      .refine(uniqueArray, "Allowed content values must be unique."),
    max_posts_per_hour: z.number().int().min(0).max(1_000),
    requires_sources: z.boolean(),
  })
  .strict();
export type CommunityPostingPolicy = z.infer<typeof CommunityPostingPolicySchema>;

const CommunityIdentityShape = {
  id: OpaqueIdSchema,
  slug: CommunitySlugSchema,
  name: CommunityNameSchema,
  kind: CommunityKindSchema,
  canonical_target: CommunityCanonicalTargetSchema,
  state: CommunityStateSchema,
  materialization_state: CommunityMaterializationStateSchema,
} as const;

type CommunityIdentity = {
  kind: CommunityKind;
  canonical_target: CommunityCanonicalTarget;
};

function validateCanonicalTarget(
  community: CommunityIdentity,
  context: z.RefinementCtx,
): void {
  if (community.kind === "general" && community.canonical_target !== null) {
    context.addIssue({
      code: "custom",
      path: ["canonical_target"],
      message: "General communities must have a null canonical target.",
    });
    return;
  }

  if (
    community.kind !== "general" &&
    community.canonical_target?.type !== community.kind
  ) {
    context.addIssue({
      code: "custom",
      path: ["canonical_target"],
      message: "The canonical target must match the community kind.",
    });
  }
}

const FindCommunitiesRequestBaseSchema = z
  .object({
    query: boundedNonBlankText(2_000, "Community query").optional(),
    proposed_title: boundedNonBlankText(200, "Proposed title").optional(),
    proposed_summary: boundedNonBlankText(4_000, "Proposed summary").optional(),
    states: z
      .array(CommunityStateSchema)
      .min(1)
      .max(CommunityStateSchema.options.length)
      .refine(uniqueArray, "Community states must be unique.")
      .optional(),
    symbols: z
      .array(SymbolSchema)
      .min(1)
      .max(10)
      .refine(uniqueArray, "Symbols must be unique.")
      .optional(),
    topics: z
      .array(TopicSchema)
      .min(1)
      .max(5)
      .refine(uniqueArray, "Topics must be unique.")
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: OpaqueCursorSchema.nullable().optional(),
  })
  .strict();

export const FindCommunitiesRequestSchema = FindCommunitiesRequestBaseSchema.superRefine(
  (request, context) => {
    const hasSearchText = [
      request.query,
      request.proposed_title,
      request.proposed_summary,
    ]
      .filter((value): value is string => value !== undefined)
      .some((value) => value.trim().length > 0);
    const hasStructuredFilter =
      request.states !== undefined ||
      request.symbols !== undefined ||
      request.topics !== undefined;

    if (!hasSearchText && !hasStructuredFilter) {
      context.addIssue({
        code: "custom",
        message:
          'Community discovery requires search text, a proposed-content summary, a structured filter, or query="*".',
      });
    }
  },
);
export type FindCommunitiesRequest = z.infer<typeof FindCommunitiesRequestSchema>;

export const CommunitySearchItemSchema = z
  .object({
    ...CommunityIdentityShape,
    matched_fields: z.array(z.string().min(1)),
    match_reasons: z.array(z.string().min(1)).min(1),
    posting_policy_summary: PostingPolicySummarySchema,
    viewer_eligibility: CommunityViewerEligibilitySchema,
  })
  .strict()
  .superRefine(validateCanonicalTarget);
export type CommunitySearchItem = z.infer<typeof CommunitySearchItemSchema>;

export const V1CursorPageSchema = z
  .object({
    next_cursor: OpaqueCursorSchema.nullable(),
    has_more: z.boolean(),
    limit: z.number().int().min(1).max(100),
  })
  .strict()
  .superRefine((page, context) => {
    if (page.has_more !== (page.next_cursor !== null)) {
      context.addIssue({
        code: "custom",
        path: ["next_cursor"],
        message: "A continuation cursor is required exactly when has_more is true.",
      });
    }
  });
export type V1CursorPage = z.infer<typeof V1CursorPageSchema>;

export const OrderingSnapshotSchema = z
  .object({
    snapshot_id: OpaqueIdSchema,
    ordering_version: z.string().min(1),
    as_of: TimestampSchema,
  })
  .strict();
export type OrderingSnapshot = z.infer<typeof OrderingSnapshotSchema>;

export const FindCommunitiesResponseSchema = z
  .object({
    items: z.array(CommunitySearchItemSchema),
    page: V1CursorPageSchema,
    ordering: OrderingSnapshotSchema,
    ...V1EnvelopeShape,
  })
  .strict();
export type FindCommunitiesResponse = z.infer<typeof FindCommunitiesResponseSchema>;

export const GetCommunityRequestSchema = z
  .object({
    community_id: OpaqueIdSchema.optional(),
    slug: CommunitySlugSchema.optional(),
  })
  .strict()
  .refine(
    (request) => (request.community_id === undefined) !== (request.slug === undefined),
    "Exactly one of community_id or slug must be provided.",
  );
export type GetCommunityRequest = z.infer<typeof GetCommunityRequestSchema>;

export const CommunityDetailProjectionSchema = z
  .object({
    ...CommunityIdentityShape,
    description_markdown: z.string().max(2_000),
    version: z.number().int().nonnegative(),
    posting_policy: CommunityPostingPolicySchema,
    viewer_eligibility: CommunityViewerEligibilitySchema,
    created_at: TimestampSchema.nullable(),
    updated_at: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((community, context) => {
    validateCanonicalTarget(community, context);

    if (community.materialization_state === "catalog_only") {
      if (community.kind !== "symbol") {
        context.addIssue({
          code: "custom",
          path: ["kind"],
          message: "Only verified symbol communities may be catalog-only.",
        });
      }
      if (
        community.version !== 0 ||
        community.created_at !== null ||
        community.updated_at !== null
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Catalog-only communities must have version 0 and null persistence timestamps.",
        });
      }
      return;
    }

    if (
      community.version < 1 ||
      community.created_at === null ||
      community.updated_at === null
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Materialized communities require a positive version and persistence timestamps.",
      });
    }
  });
export type CommunityDetailProjection = z.infer<typeof CommunityDetailProjectionSchema>;

export const GetCommunityResponseSchema = z
  .object({
    community: CommunityDetailProjectionSchema,
    ...V1EnvelopeShape,
  })
  .strict();
export type GetCommunityResponse = z.infer<typeof GetCommunityResponseSchema>;
