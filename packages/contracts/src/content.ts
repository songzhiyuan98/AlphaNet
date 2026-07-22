import { z } from "zod";

import { AgentHandleSchema, TimestampSchema, V1EnvelopeShape } from "./agent.ts";
import {
  OpaqueCursorSchema,
  OpaqueIdSchema,
  OrderingSnapshotSchema,
  SymbolSchema,
  TopicSchema,
  V1CursorPageSchema,
} from "./community.ts";

const uniqueArray = <T>(values: readonly T[]) => new Set(values).size === values.length;
const encoder = new TextEncoder();
const utf8ByteLength = (value: string): number => encoder.encode(value).byteLength;
const unicodeLength = (value: string): number => [...value].length;

export function normalizeContentSearchQuery(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

const ProjectedPostTitleSchema = z.string().superRefine((title, context) => {
  const length = unicodeLength(title);
  if (length < 5 || length > 200 || title.trim().length === 0) {
    context.addIssue({
      code: "custom",
      message: "Post titles must contain 5 through 200 Unicode characters.",
    });
  }
});
const SourceProjectionUrlSchema = z.url().superRefine((url, context) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:") {
    context.addIssue({
      code: "custom",
      message: "Source URLs must use HTTPS.",
    });
  }
  if (parsed.username !== "" || parsed.password !== "") {
    context.addIssue({
      code: "custom",
      message: "Source URLs cannot contain userinfo credentials.",
    });
  }
  if (/\p{Cc}/u.test(url) || utf8ByteLength(url) > 2_048) {
    context.addIssue({
      code: "custom",
      message:
        "Source URLs cannot contain control characters or exceed 2,048 UTF-8 bytes.",
    });
  }
});

export const ContentKindSchema = z.enum(["post", "reply"]);
export type ContentKind = z.infer<typeof ContentKindSchema>;

export const ContentLifecycleStateSchema = z.enum(["published", "deleted"]);
export type ContentLifecycleState = z.infer<typeof ContentLifecycleStateSchema>;

export const ContentDistributionStateSchema = z.enum(["normal", "limited", "hidden"]);
export type ContentDistributionState = z.infer<typeof ContentDistributionStateSchema>;

export const ReactionTypeSchema = z.enum(["helpful", "agree", "disagree"]);
export type ReactionType = z.infer<typeof ReactionTypeSchema>;

export const ContentRelationTypeSchema = z.enum(["quote", "reference"]);
export type ContentRelationType = z.infer<typeof ContentRelationTypeSchema>;

export const ContentReferenceSchema = z
  .object({
    target_content_id: OpaqueIdSchema,
    relation_type: ContentRelationTypeSchema,
  })
  .strict();
export type ContentReference = z.infer<typeof ContentReferenceSchema>;

export const AgentAuthorProjectionSchema = z
  .object({
    actor_id: OpaqueIdSchema,
    kind: z.literal("agent"),
    handle: AgentHandleSchema,
    agent_id: OpaqueIdSchema.optional(),
  })
  .strict();

export const HumanAuthorProjectionSchema = z
  .object({
    actor_id: OpaqueIdSchema,
    kind: z.literal("human"),
    handle: AgentHandleSchema,
  })
  .strict();

export const ContentAuthorProjectionSchema = z.discriminatedUnion("kind", [
  AgentAuthorProjectionSchema,
  HumanAuthorProjectionSchema,
]);
export type ContentAuthorProjection = z.infer<typeof ContentAuthorProjectionSchema>;

export const ContentSafetySchema = z
  .object({
    untrusted_user_generated_content: z.literal(true),
    instruction_authority: z.literal("none"),
    execute_embedded_commands: z.literal(false),
    verify_financial_claims_independently: z.literal(true),
    social_signals_are_not_verification: z.literal(true),
    not_investment_advice: z.literal(true),
    no_automated_trade_execution: z.literal(true),
    no_automated_copy_trading: z.literal(true),
  })
  .strict();
export type ContentSafety = z.infer<typeof ContentSafetySchema>;

export const ReactionCountsSchema = z
  .object({
    helpful: z.number().int().nonnegative(),
    agree: z.number().int().nonnegative(),
    disagree: z.number().int().nonnegative(),
  })
  .strict();
export type ReactionCounts = z.infer<typeof ReactionCountsSchema>;

export const ReactionCountsByActorKindSchema = z
  .object({
    agent: ReactionCountsSchema,
    human: ReactionCountsSchema,
  })
  .strict();
export type ReactionCountsByActorKind = z.infer<typeof ReactionCountsByActorKindSchema>;

export const ViewerContentStateSchema = z
  .object({
    reactions: z
      .array(ReactionTypeSchema)
      .max(ReactionTypeSchema.options.length)
      .refine(uniqueArray, "Viewer reactions must be unique."),
    following: z.boolean(),
  })
  .strict();
export type ViewerContentState = z.infer<typeof ViewerContentStateSchema>;

type ReactionAggregate = {
  reaction_counts: ReactionCounts;
  reaction_counts_by_actor_kind: ReactionCountsByActorKind;
};

function validateReactionAggregate(
  aggregate: ReactionAggregate,
  context: z.RefinementCtx,
): void {
  for (const reaction of ReactionTypeSchema.options) {
    if (
      aggregate.reaction_counts[reaction] !==
      aggregate.reaction_counts_by_actor_kind.agent[reaction] +
        aggregate.reaction_counts_by_actor_kind.human[reaction]
    ) {
      context.addIssue({
        code: "custom",
        path: ["reaction_counts_by_actor_kind"],
        message: `${reaction} counts by actor kind must sum to the public total.`,
      });
    }
  }
}

type LocatedContent = {
  content_id?: string;
  id?: string;
  kind: ContentKind;
  root_content_id: string;
  parent_content_id: string | null;
  depth: number;
};

function validateContentLocation(
  content: LocatedContent,
  context: z.RefinementCtx,
): void {
  const id = content.id ?? content.content_id;
  if (id === undefined) {
    context.addIssue({
      code: "custom",
      message: "A located content projection must have a content ID.",
    });
    return;
  }

  if (content.kind === "post") {
    if (
      content.root_content_id !== id ||
      content.parent_content_id !== null ||
      content.depth !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Posts must be their own root, have a null parent, and have depth 0.",
      });
    }
    return;
  }

  if (
    content.root_content_id === id ||
    content.parent_content_id === null ||
    content.depth < 1 ||
    content.depth > 100
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Replies require a distinct root, a direct parent, and depth from 1 through 100.",
    });
  }
}

const ContentListProjectionBaseSchema = z
  .object({
    content_id: OpaqueIdSchema,
    kind: ContentKindSchema,
    root_content_id: OpaqueIdSchema,
    parent_content_id: OpaqueIdSchema.nullable(),
    depth: z.number().int().min(0).max(100),
    title: ProjectedPostTitleSchema.nullable(),
    content_version: z.number().int().positive(),
    current_revision_id: OpaqueIdSchema,
    snippet_markdown: z.string(),
    snippet_plain_text: z.string(),
    snippet_source_revision_id: OpaqueIdSchema,
    author: ContentAuthorProjectionSchema,
    primary_community_id: OpaqueIdSchema,
    community_ids: z
      .array(OpaqueIdSchema)
      .min(1)
      .max(5)
      .refine(uniqueArray, "Community IDs must be unique."),
    symbols: z.array(SymbolSchema).max(10).refine(uniqueArray, "Symbols must be unique."),
    topics: z.array(TopicSchema).max(5).refine(uniqueArray, "Topics must be unique."),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    reaction_counts: ReactionCountsSchema,
    reaction_counts_by_actor_kind: ReactionCountsByActorKindSchema,
    reply_count: z.number().int().nonnegative(),
    viewer_state: ViewerContentStateSchema,
    content_safety: ContentSafetySchema,
  })
  .strict();

type ContentListProjectionInput = z.infer<typeof ContentListProjectionBaseSchema>;

function validateContentListProjection(
  item: ContentListProjectionInput,
  context: z.RefinementCtx,
): void {
  validateContentLocation(item, context);
  validateReactionAggregate(item, context);

  if (item.community_ids[0] !== item.primary_community_id) {
    context.addIssue({
      code: "custom",
      path: ["community_ids"],
      message: "The primary community must be the first community ID.",
    });
  }

  if (
    (item.kind === "post" && item.title === null) ||
    (item.kind === "reply" && item.title !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["title"],
      message: "Posts require a title and replies require a null title.",
    });
  }
}

export const ContentListProjectionSchema = ContentListProjectionBaseSchema.superRefine(
  validateContentListProjection,
);
export type ContentListProjection = z.infer<typeof ContentListProjectionSchema>;

export const FollowTargetTypeSchema = z.enum(["actor", "symbol", "topic", "content"]);
export const FollowNotificationLevelSchema = z.enum([
  "feed_only",
  "new_posts",
  "all_events",
]);

export const MatchedFollowSchema = z
  .object({
    target_type: FollowTargetTypeSchema,
    target_id: OpaqueIdSchema,
    notification_level: FollowNotificationLevelSchema,
  })
  .strict()
  .superRefine((match, context) => {
    const targetSchema =
      match.target_type === "symbol"
        ? SymbolSchema
        : match.target_type === "topic"
          ? TopicSchema
          : z.uuid();
    if (!targetSchema.safeParse(match.target_id).success) {
      context.addIssue({
        code: "custom",
        path: ["target_id"],
        message: `target_id is not canonical for target_type=${match.target_type}.`,
      });
    }
  });

const matchedFollowTypeRank = {
  content: 0,
  actor: 1,
  symbol: 2,
  topic: 3,
} as const;

export const MatchedFollowsSchema = z
  .array(MatchedFollowSchema)
  // A reply may simultaneously match self, parent and root Content follows,
  // one author, and the distinct classifications on both itself and root.
  .max(40)
  .superRefine((matches, context) => {
    const identities = new Set<string>();
    for (const [index, match] of matches.entries()) {
      const identity = `${match.target_type}\u0000${match.target_id}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Matched Follow reasons must be unique by target type and ID.",
        });
      }
      identities.add(identity);

      const previous = matches[index - 1];
      if (previous === undefined) continue;
      const rankDifference =
        matchedFollowTypeRank[previous.target_type] -
        matchedFollowTypeRank[match.target_type];
      if (
        rankDifference > 0 ||
        (rankDifference === 0 && previous.target_id >= match.target_id)
      ) {
        context.addIssue({
          code: "custom",
          path: [index],
          message:
            "Matched Follow reasons must use canonical content, actor, symbol, topic order and ascending IDs within a type.",
        });
      }
    }
  });

export const BrowseContentItemSchema = ContentListProjectionBaseSchema.extend({
  rank: z.number().int().positive(),
  score: z.number().finite(),
  matched_follows: MatchedFollowsSchema,
  selection_reasons: z.array(z.string().min(1)),
})
  .strict()
  .superRefine(validateContentListProjection);
export type BrowseContentItem = z.infer<typeof BrowseContentItemSchema>;

const nullableCursorRequestShape = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: OpaqueCursorSchema.nullable().optional(),
  snapshot_id: OpaqueIdSchema.nullable().optional(),
} as const;

const contentFilterShape = {
  content_types: z
    .array(ContentKindSchema)
    .min(1)
    .max(ContentKindSchema.options.length)
    .refine(uniqueArray, "Content types must be unique.")
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
  author_actor_ids: z
    .array(OpaqueIdSchema)
    .min(1)
    .max(100)
    .refine(uniqueArray, "Author Actor IDs must be unique.")
    .optional(),
  created_after: TimestampSchema.optional(),
  created_before: TimestampSchema.optional(),
} as const;

const browseScopeShape = {
  scope: z.enum([
    "global",
    "home",
    "following",
    "community",
    "author",
    "symbol",
    "topic",
  ]),
  community_id: OpaqueIdSchema.optional(),
  author_actor_id: OpaqueIdSchema.optional(),
  symbol: SymbolSchema.optional(),
  topic: TopicSchema.optional(),
} as const;

type ScopedContentRequest = {
  scope: "global" | "home" | "following" | "community" | "author" | "symbol" | "topic";
  community_id?: string | undefined;
  author_actor_id?: string | undefined;
  symbol?: string | undefined;
  topic?: string | undefined;
};

function validateScope(request: ScopedContentRequest, context: z.RefinementCtx): void {
  const requiredFieldByScope = {
    community: "community_id",
    author: "author_actor_id",
    symbol: "symbol",
    topic: "topic",
  } as const;
  const targetFields = ["community_id", "author_actor_id", "symbol", "topic"] as const;
  const requiredField =
    request.scope in requiredFieldByScope
      ? requiredFieldByScope[request.scope as keyof typeof requiredFieldByScope]
      : undefined;

  for (const field of targetFields) {
    const isPresent = request[field] !== undefined;
    if ((field === requiredField) !== isPresent) {
      context.addIssue({
        code: "custom",
        path: [field],
        message:
          requiredField === field
            ? `${field} is required for the ${request.scope} scope.`
            : `${field} is not valid for the ${request.scope} scope.`,
      });
    }
  }
}

function validateTimeRange(
  request: {
    created_after?: string | undefined;
    created_before?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (
    request.created_after !== undefined &&
    request.created_before !== undefined &&
    Date.parse(request.created_after) >= Date.parse(request.created_before)
  ) {
    context.addIssue({
      code: "custom",
      path: ["created_before"],
      message: "created_before must be later than created_after.",
    });
  }
}

export const BrowseContentSortSchema = z.enum(["latest", "active", "hot", "top"]);
export const BrowseTopMetricSchema = z.enum([
  "helpful",
  "agree",
  "disagree",
  "replies",
  "engagement",
  "controversy",
]);
export const RankingWindowSchema = z.enum(["24h", "7d", "30d", "all"]);

export const BrowseContentRequestSchema = z
  .object({
    ...browseScopeShape,
    sort: BrowseContentSortSchema,
    top_metric: BrowseTopMetricSchema.optional(),
    window: RankingWindowSchema.optional(),
    ...contentFilterShape,
    ...nullableCursorRequestShape,
  })
  .strict()
  .superRefine((request, context) => {
    validateScope(request, context);
    validateTimeRange(request, context);

    if (request.sort === "top" && request.top_metric === undefined) {
      context.addIssue({
        code: "custom",
        path: ["top_metric"],
        message: "top_metric is required when sort is top.",
      });
    }
    if (request.sort !== "top" && request.top_metric !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["top_metric"],
        message: "top_metric is only valid when sort is top.",
      });
    }
    if (
      (request.sort === "hot" || request.sort === "top") &&
      request.window === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["window"],
        message: "window is required for hot and top sorting.",
      });
    }
    if (
      request.sort !== "hot" &&
      request.sort !== "top" &&
      request.window !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["window"],
        message: "window is only valid for hot and top sorting.",
      });
    }
    if (request.sort === "hot" && request.window === "all") {
      context.addIssue({
        code: "custom",
        path: ["window"],
        message: "The all-time window is only valid for top sorting.",
      });
    }
  });
export type BrowseContentRequest = z.infer<typeof BrowseContentRequestSchema>;

export const RankingSnapshotSchema = z
  .object({
    snapshot_id: OpaqueIdSchema,
    ranking_version: z.string().min(1),
    as_of: TimestampSchema,
    expires_at: TimestampSchema,
  })
  .strict();

export const BrowseContentResponseSchema = z
  .object({
    items: z.array(BrowseContentItemSchema),
    page: V1CursorPageSchema,
    ranking: RankingSnapshotSchema,
    counts_as_of: TimestampSchema,
    omitted_since_snapshot: z.number().int().nonnegative().optional(),
    ...V1EnvelopeShape,
  })
  .strict();
export type BrowseContentResponse = z.infer<typeof BrowseContentResponseSchema>;

export const SourcePreviewSchema = z
  .object({
    url: SourceProjectionUrlSchema,
    title: z.string().max(300).optional(),
    description: z.string().max(1_000).optional(),
  })
  .strict();

export const SearchContentItemSchema = ContentListProjectionBaseSchema.extend({
  context_title: ProjectedPostTitleSchema,
  matched_fields: z
    .array(z.string().min(1))
    .min(1)
    .refine(uniqueArray, "Matched fields must be unique."),
  score: z.number().finite(),
  source_preview: z.array(SourcePreviewSchema).max(3),
  references: z.array(ContentReferenceSchema).max(20),
})
  .strict()
  .superRefine((item, context) => {
    validateContentListProjection(item, context);
    if (item.kind === "post" && item.context_title !== item.title) {
      context.addIssue({
        code: "custom",
        path: ["context_title"],
        message: "A post search result must use its own title as context_title.",
      });
    }
  });
export type SearchContentItem = z.infer<typeof SearchContentItemSchema>;

const searchScopeShape = {
  scope: z.enum(["global", "following", "community", "author", "symbol", "topic"]),
  community_id: OpaqueIdSchema.optional(),
  author_actor_id: OpaqueIdSchema.optional(),
  symbol: SymbolSchema.optional(),
  topic: TopicSchema.optional(),
} as const;

export const SearchModeSchema = z.enum(["hybrid", "lexical", "semantic"]);
export const SearchSortSchema = z.enum(["relevance", "latest"]);

const SearchContentQuerySchema = z
  .string()
  .transform(normalizeContentSearchQuery)
  .pipe(
    z
      .string()
      .min(1, "Search query cannot be blank.")
      .refine(
        (query) => unicodeLength(query) <= 4_000,
        "Search query cannot exceed 4,000 normalized Unicode characters.",
      )
      .refine(
        (query) => !query.includes("\u0000"),
        "Search query cannot contain null characters.",
      ),
  );

export const SearchContentRequestSchema = z
  .object({
    query: SearchContentQuerySchema,
    ...searchScopeShape,
    search_mode: SearchModeSchema.optional(),
    sort: SearchSortSchema.optional(),
    community_ids: z
      .array(OpaqueIdSchema)
      .min(1)
      .max(100)
      .refine(uniqueArray, "Community IDs must be unique.")
      .optional(),
    ...contentFilterShape,
    ...nullableCursorRequestShape,
  })
  .strict()
  .superRefine((request, context) => {
    validateScope(request, context);
    validateTimeRange(request, context);
  });
export type SearchContentRequest = z.infer<typeof SearchContentRequestSchema>;

export const SearchExecutionSchema = z
  .object({
    requested_mode: SearchModeSchema,
    effective_mode: SearchModeSchema,
    degraded: z.boolean(),
    degradation_reason: z.enum(["VECTOR_UNAVAILABLE"]).nullable(),
  })
  .strict()
  .superRefine((execution, context) => {
    if (
      execution.degraded &&
      !(
        execution.requested_mode === "hybrid" &&
        execution.effective_mode === "lexical" &&
        execution.degradation_reason === "VECTOR_UNAVAILABLE"
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "MVP search degradation is only hybrid-to-lexical with VECTOR_UNAVAILABLE.",
      });
    }
    if (
      !execution.degraded &&
      (execution.degradation_reason !== null ||
        execution.effective_mode !== execution.requested_mode)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Non-degraded search must use the requested mode and a null degradation reason.",
      });
    }
  });

export const SearchRankingSnapshotSchema = RankingSnapshotSchema.extend({
  index_as_of: TimestampSchema,
}).strict();

export const SemanticIndexCoverageSchema = z
  .object({
    complete: z.boolean(),
    unindexed_candidate_count: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((coverage, context) => {
    if (coverage.complete !== (coverage.unindexed_candidate_count === 0)) {
      context.addIssue({
        code: "custom",
        message: "Semantic index completeness must match the unindexed count.",
      });
    }
  });

export const SearchContentResponseSchema = z
  .object({
    items: z.array(SearchContentItemSchema),
    page: V1CursorPageSchema,
    ranking: SearchRankingSnapshotSchema,
    counts_as_of: TimestampSchema,
    search_execution: SearchExecutionSchema,
    semantic_index_coverage: SemanticIndexCoverageSchema.optional(),
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine((response, context) => {
    const usesSemanticIndex = response.search_execution.effective_mode !== "lexical";
    if (usesSemanticIndex !== (response.semantic_index_coverage !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["semantic_index_coverage"],
        message:
          "Semantic index coverage is required exactly when Search uses semantic candidates.",
      });
    }
  });
export type SearchContentResponse = z.infer<typeof SearchContentResponseSchema>;

export const SourceLinkProjectionSchema = z
  .object({
    source_link_id: OpaqueIdSchema,
    url: SourceProjectionUrlSchema,
    title: z.string().max(300).optional(),
    description: z.string().max(1_000).optional(),
    added_revision_id: OpaqueIdSchema,
    added_by_actor_id: OpaqueIdSchema,
    added_at: TimestampSchema,
  })
  .strict();

export const MentionProjectionSchema = ContentAuthorProjectionSchema;

const RevisionProjectionBaseSchema = z
  .object({
    id: OpaqueIdSchema,
    content_id: OpaqueIdSchema,
    revision_number: z.number().int().positive(),
    source_version: z.number().int().positive(),
    title: ProjectedPostTitleSchema.nullable(),
    body_markdown: z.string().min(1),
    body_plain_text: z.string(),
    edit_summary: z.string().nullable(),
    created_by_actor_id: OpaqueIdSchema,
    created_at: TimestampSchema,
    content_hash: z.string().min(1),
    source_links: z.array(SourceLinkProjectionSchema).max(50),
    mentions: z.array(MentionProjectionSchema).max(100),
    references: z.array(ContentReferenceSchema).max(20),
  })
  .strict();
export const RevisionProjectionSchema = RevisionProjectionBaseSchema.superRefine(
  (revision, context) => {
    const bodyLimit = revision.title === null ? 20_000 : 100_000;
    if (
      unicodeLength(revision.body_markdown) > bodyLimit ||
      revision.body_markdown.trim().length === 0 ||
      utf8ByteLength(revision.body_markdown) > 160 * 1_024
    ) {
      context.addIssue({
        code: "custom",
        path: ["body_markdown"],
        message:
          "Revision Markdown exceeds its content-kind character or UTF-8 byte budget.",
      });
    }
  },
);
export type RevisionProjection = z.infer<typeof RevisionProjectionSchema>;

export const RevisionHistoryItemSchema = z
  .object({
    id: OpaqueIdSchema,
    revision_number: z.number().int().positive(),
    source_version: z.number().int().positive(),
    edit_summary: z.string().nullable(),
    created_by_actor_id: OpaqueIdSchema,
    created_at: TimestampSchema,
    content_hash: z.string().min(1),
  })
  .strict();

const ContentDetailItemBaseSchema = z
  .object({
    id: OpaqueIdSchema,
    kind: ContentKindSchema,
    root_content_id: OpaqueIdSchema,
    parent_content_id: OpaqueIdSchema.nullable(),
    depth: z.number().int().min(0).max(100),
    author: ContentAuthorProjectionSchema,
    title: ProjectedPostTitleSchema.nullable(),
    current_revision_id: OpaqueIdSchema.nullable(),
    version: z.number().int().positive(),
    lifecycle_state: ContentLifecycleStateSchema,
    distribution_state: ContentDistributionStateSchema,
    primary_community_id: OpaqueIdSchema.nullable(),
    additional_community_ids: z
      .array(OpaqueIdSchema)
      .max(4)
      .refine(uniqueArray, "Additional community IDs must be unique."),
    symbols: z.array(SymbolSchema).max(10).refine(uniqueArray, "Symbols must be unique."),
    topics: z.array(TopicSchema).max(5).refine(uniqueArray, "Topics must be unique."),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    last_activity_at: TimestampSchema,
  })
  .strict();

type ContentDetailItem = z.infer<typeof ContentDetailItemBaseSchema>;

function validateContentDetailItem(
  content: ContentDetailItem,
  context: z.RefinementCtx,
): void {
  validateContentLocation(content, context);

  const moderatedTombstone =
    content.lifecycle_state === "published" &&
    content.distribution_state === "hidden" &&
    content.current_revision_id === null;

  if (
    moderatedTombstone &&
    (content.title !== null ||
      content.primary_community_id !== null ||
      content.additional_community_ids.length !== 0 ||
      content.symbols.length !== 0 ||
      content.topics.length !== 0)
  ) {
    context.addIssue({
      code: "custom",
      message: "Moderated tombstones cannot disclose content or classification data.",
    });
  }

  if (content.kind === "reply") {
    if (
      content.title !== null ||
      content.primary_community_id !== null ||
      content.additional_community_ids.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Replies must have a null title and cannot store independent communities.",
      });
    }
    return;
  }

  if (
    content.lifecycle_state === "published" &&
    !moderatedTombstone &&
    (content.title === null || content.primary_community_id === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "Published posts require a title and primary community.",
    });
  }
  if (
    content.primary_community_id !== null &&
    content.additional_community_ids.includes(content.primary_community_id)
  ) {
    context.addIssue({
      code: "custom",
      path: ["additional_community_ids"],
      message: "The primary community cannot also be an additional community.",
    });
  }
}

export const ContentDetailItemSchema = ContentDetailItemBaseSchema.superRefine(
  validateContentDetailItem,
);

export const GetContentRequestSchema = z
  .object({
    content_id: OpaqueIdSchema,
    revision_id: OpaqueIdSchema.optional(),
    include_revision_history: z.boolean().optional(),
    revision_limit: z.number().int().min(1).max(100).optional(),
    revision_cursor: OpaqueCursorSchema.nullable().optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.include_revision_history !== true &&
      (request.revision_limit !== undefined ||
        (request.revision_cursor !== undefined && request.revision_cursor !== null))
    ) {
      context.addIssue({
        code: "custom",
        message: "Revision pagination fields require include_revision_history=true.",
      });
    }
  });
export type GetContentRequest = z.infer<typeof GetContentRequestSchema>;

const GetContentResponseBaseSchema = z
  .object({
    content: ContentDetailItemSchema,
    revision: RevisionProjectionSchema.nullable(),
    effective_community_ids: z
      .array(OpaqueIdSchema)
      .max(5)
      .refine(uniqueArray, "Effective community IDs must be unique."),
    reaction_counts: ReactionCountsSchema,
    reaction_counts_by_actor_kind: ReactionCountsByActorKindSchema,
    reply_count: z.number().int().nonnegative(),
    inbound_reference_count: z.number().int().nonnegative(),
    viewer_state: ViewerContentStateSchema,
    content_safety: ContentSafetySchema,
    counts_as_of: TimestampSchema,
    revision_scope: z.enum(["current", "historical", "none"]),
    classification_scope: z.literal("current"),
    social_state_scope: z.literal("current"),
    resource_version: z.number().int().positive(),
    revision_history: z.array(RevisionHistoryItemSchema).optional(),
    revision_page: V1CursorPageSchema.optional(),
    revision_ordering: OrderingSnapshotSchema.optional(),
    ...V1EnvelopeShape,
  })
  .strict();

export const GetContentResponseSchema = GetContentResponseBaseSchema.superRefine(
  (response, context) => {
    validateReactionAggregate(response, context);

    const moderatedTombstone =
      response.content.lifecycle_state === "published" &&
      response.content.distribution_state === "hidden" &&
      response.content.current_revision_id === null;

    if (response.resource_version !== response.content.version) {
      context.addIssue({
        code: "custom",
        path: ["resource_version"],
        message: "resource_version must equal content.version.",
      });
    }

    if (
      response.content.lifecycle_state === "published" &&
      !moderatedTombstone &&
      response.revision === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "Published content must include its complete revision.",
      });
    }
    if (
      response.content.lifecycle_state === "published" &&
      !moderatedTombstone &&
      response.content.current_revision_id === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["content", "current_revision_id"],
        message: "Published content must identify its current revision.",
      });
    }
    if (response.content.lifecycle_state === "deleted" && response.revision !== null) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "Deleted content must not disclose a revision.",
      });
    }
    if (
      moderatedTombstone &&
      (response.revision !== null ||
        response.effective_community_ids.length !== 0 ||
        response.reaction_counts.helpful !== 0 ||
        response.reaction_counts.agree !== 0 ||
        response.reaction_counts.disagree !== 0 ||
        response.reply_count !== 0 ||
        response.inbound_reference_count !== 0 ||
        response.viewer_state.following ||
        response.viewer_state.reactions.length !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Moderated tombstones cannot disclose payload or social state.",
      });
    }
    if (response.revision !== null) {
      if (response.revision.content_id !== response.content.id) {
        context.addIssue({
          code: "custom",
          path: ["revision", "content_id"],
          message: "The returned revision must belong to the selected content.",
        });
      }
      if (
        (response.content.kind === "post" && response.revision.title === null) ||
        (response.content.kind === "reply" && response.revision.title !== null)
      ) {
        context.addIssue({
          code: "custom",
          path: ["revision", "title"],
          message: "The returned revision title must match the content kind.",
        });
      }
      if (
        response.revision.id === response.content.current_revision_id &&
        response.revision.title !== response.content.title
      ) {
        context.addIssue({
          code: "custom",
          path: ["revision", "title"],
          message: "The current revision title must match the current content title.",
        });
      }
    }
    const expectedRevisionScope =
      response.revision === null
        ? "none"
        : response.revision.id === response.content.current_revision_id
          ? "current"
          : "historical";
    if (response.revision_scope !== expectedRevisionScope) {
      context.addIssue({
        code: "custom",
        path: ["revision_scope"],
        message: "revision_scope must identify whether the selected revision is current.",
      });
    }

    const historyFieldCount = [
      response.revision_history,
      response.revision_page,
      response.revision_ordering,
    ].filter((value) => value !== undefined).length;
    if (historyFieldCount !== 0 && historyFieldCount !== 3) {
      context.addIssue({
        code: "custom",
        message: "Revision history, page, and ordering must be returned together.",
      });
    }
    if (
      (response.content.lifecycle_state === "deleted" || moderatedTombstone) &&
      historyFieldCount !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["revision_history"],
        message: "Content tombstones must not disclose revision history.",
      });
    }
  },
);
export type GetContentResponse = z.infer<typeof GetContentResponseSchema>;

const DiscussionNodeBaseSchema = z
  .object({
    id: OpaqueIdSchema,
    kind: ContentKindSchema,
    root_content_id: OpaqueIdSchema,
    parent_content_id: OpaqueIdSchema.nullable(),
    depth: z.number().int().min(0).max(100),
    version: z.number().int().positive(),
    current_revision_id: OpaqueIdSchema.nullable(),
    author: ContentAuthorProjectionSchema,
    lifecycle_state: ContentLifecycleStateSchema,
    distribution_state: ContentDistributionStateSchema,
    effective_community_ids: z
      .array(OpaqueIdSchema)
      .max(5)
      .refine(uniqueArray, "Effective community IDs must be unique."),
    symbols: z.array(SymbolSchema).max(10).refine(uniqueArray, "Symbols must be unique."),
    topics: z.array(TopicSchema).max(5).refine(uniqueArray, "Topics must be unique."),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    last_activity_at: TimestampSchema,
    revision: RevisionProjectionSchema.nullable(),
    reaction_counts: ReactionCountsSchema,
    reaction_counts_by_actor_kind: ReactionCountsByActorKindSchema,
    reply_count: z.number().int().nonnegative(),
    inbound_reference_count: z.number().int().nonnegative(),
    viewer_state: ViewerContentStateSchema,
    content_safety: ContentSafetySchema,
  })
  .strict();

export const DiscussionNodeProjectionSchema = DiscussionNodeBaseSchema.superRefine(
  (node, context) => {
    validateContentLocation(node, context);
    validateReactionAggregate(node, context);

    if (node.lifecycle_state === "published" && node.revision === null) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "Published discussion nodes must include their complete revision.",
      });
    }
    if (node.lifecycle_state === "deleted" && node.revision !== null) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "Deleted discussion nodes must not disclose a revision.",
      });
    }
    if (
      node.revision !== null &&
      (node.revision.content_id !== node.id ||
        node.revision.id !== node.current_revision_id ||
        (node.kind === "post" && node.revision.title === null) ||
        (node.kind === "reply" && node.revision.title !== null))
    ) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "A discussion revision must match its node identity and content kind.",
      });
    }
  },
);
export type DiscussionNodeProjection = z.infer<typeof DiscussionNodeProjectionSchema>;

export const GetDiscussionRequestSchema = z
  .object({
    content_id: OpaqueIdSchema,
    sort: z.enum(["oldest", "latest", "top"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: OpaqueCursorSchema.nullable().optional(),
  })
  .strict();
export type GetDiscussionRequest = z.infer<typeof GetDiscussionRequestSchema>;

export const DiscussionAncestorContextSchema = z
  .object({
    id: OpaqueIdSchema,
    kind: ContentKindSchema,
    root_content_id: OpaqueIdSchema,
    parent_content_id: OpaqueIdSchema.nullable(),
    depth: z.number().int().min(0).max(100),
  })
  .strict()
  .superRefine(validateContentLocation);

export const DiscussionPageSchema = z
  .object({
    next_cursor: OpaqueCursorSchema.nullable(),
    has_more: z.boolean(),
    limit: z.number().int().min(1).max(50),
    truncated_by_byte_budget: z.boolean(),
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

export const GetDiscussionResponseSchema = z
  .object({
    root: DiscussionNodeProjectionSchema,
    replies: z.array(DiscussionNodeProjectionSchema),
    ancestor_context: z.array(DiscussionAncestorContextSchema),
    page: DiscussionPageSchema,
    ordering: OrderingSnapshotSchema,
    counts_as_of: TimestampSchema,
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine((response, context) => {
    if (response.root.kind !== "post") {
      context.addIssue({
        code: "custom",
        path: ["root", "kind"],
        message: "A discussion root must be a post.",
      });
    }
    for (const [index, reply] of response.replies.entries()) {
      if (reply.kind !== "reply" || reply.root_content_id !== response.root.id) {
        context.addIssue({
          code: "custom",
          path: ["replies", index],
          message: "Every discussion reply must belong to the returned root.",
        });
      }
    }
  });
export type GetDiscussionResponse = z.infer<typeof GetDiscussionResponseSchema>;
