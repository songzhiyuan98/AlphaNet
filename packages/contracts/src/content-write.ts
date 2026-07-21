import { z } from "zod";

import { PolicyDecisionSchema, TimestampSchema, V1EnvelopeShape } from "./agent.ts";
import { OpaqueIdSchema, SymbolSchema, TopicSchema } from "./community.ts";
import {
  ContentReferenceSchema,
  ReactionCountsSchema,
  ReactionTypeSchema,
  ViewerContentStateSchema,
} from "./content.ts";
import { SetFollowWriteResultSchema } from "./follow.ts";
import { V1ErrorDetailSchema } from "./v1-error.ts";
import {
  IdempotencyKeySchema,
  WriteStatusSchema,
  type WriteStatus,
} from "./write-primitives.ts";

export { IdempotencyKeySchema, WriteStatusSchema } from "./write-primitives.ts";
export type { WriteStatus } from "./write-primitives.ts";

const KIBIBYTE = 1_024;
const MAX_NORMALIZED_BODY_BYTES = 160 * KIBIBYTE;
const MAX_SOURCE_METADATA_BYTES = 128 * KIBIBYTE;
const MAX_WRITE_REQUEST_BYTES = 1_024 * KIBIBYTE;

const encoder = new TextEncoder();
const utf8ByteLength = (value: string): number => encoder.encode(value).byteLength;
const unicodeLength = (value: string): number => [...value].length;
const uniqueArray = <T>(values: readonly T[]) => new Set(values).size === values.length;
const parseUrl = (value: string): URL | null => {
  try {
    return new URL(
      value.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim(),
    );
  } catch {
    return null;
  }
};
const normalizeLabel = (value: string | undefined): string | null =>
  value?.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim() || null;

function boundedUnicodeString(
  minimum: number,
  maximum: number,
  label: string,
): z.ZodString {
  return z.string().superRefine((value, context) => {
    if (value.includes("\u0000")) {
      context.addIssue({
        code: "custom",
        message: `${label} cannot contain the NUL character.`,
      });
    }
    const length = unicodeLength(value);
    if (length < minimum || length > maximum || value.trim().length === 0) {
      context.addIssue({
        code: "custom",
        message: `${label} must contain ${minimum} through ${maximum} Unicode characters.`,
      });
    }
  });
}

export const PostTitleSchema = boundedUnicodeString(5, 200, "Post title");
export const PostBodyMarkdownSchema = boundedUnicodeString(
  1,
  100_000,
  "Post body",
).refine(
  (value) => utf8ByteLength(value) <= MAX_NORMALIZED_BODY_BYTES,
  `Post body must not exceed ${MAX_NORMALIZED_BODY_BYTES} UTF-8 bytes.`,
);
export const ReplyBodyMarkdownSchema = boundedUnicodeString(
  1,
  20_000,
  "Reply body",
).refine(
  (value) => utf8ByteLength(value) <= MAX_NORMALIZED_BODY_BYTES,
  `Reply body must not exceed ${MAX_NORMALIZED_BODY_BYTES} UTF-8 bytes.`,
);

export const HttpsSourceUrlSchema = z
  .url()
  .refine((url) => !/\p{Cc}/u.test(url), {
    message: "Source URLs cannot contain control characters.",
  })
  .refine((url) => parseUrl(url)?.protocol === "https:", {
    message: "Source URLs must use HTTPS.",
  })
  .refine(
    (url) => {
      const parsed = parseUrl(url);
      return parsed !== null && parsed.username === "" && parsed.password === "";
    },
    {
      message: "Source URLs cannot contain userinfo credentials.",
    },
  )
  .refine((url) => utf8ByteLength(url) <= 2_048, {
    message: "Source URLs must not exceed 2,048 UTF-8 bytes.",
  });

export const SourceLinkInputSchema = z
  .object({
    url: HttpsSourceUrlSchema,
    title: boundedUnicodeString(1, 300, "Source title").optional(),
    description: boundedUnicodeString(1, 1_000, "Source description").optional(),
  })
  .strict();
export type SourceLinkInput = z.infer<typeof SourceLinkInputSchema>;

// Exact duplicate sources and references remain valid input: the domain
// canonicalizer collapses them before hashing. Conflicting metadata for one
// normalized URL is rejected below, and distinct URL fragments stay distinct.
const sourceLinksSchema = z.array(SourceLinkInputSchema).max(50);
const symbolsSchema = z
  .array(SymbolSchema)
  .max(10)
  .refine(uniqueArray, "Symbols must be unique.");
const topicsSchema = z
  .array(TopicSchema)
  .max(5)
  .refine(uniqueArray, "Topics must be unique.");
const referencesSchema = z.array(ContentReferenceSchema).max(20);

function validateWriteBudgets(
  request: unknown,
  context: z.RefinementCtx,
  sourceLinks: readonly SourceLinkInput[] = [],
  sourcePath: readonly (string | number)[] = ["source_links"],
): void {
  const sourcesByNormalizedUrl = new Map<string, string>();
  for (const [index, source] of sourceLinks.entries()) {
    const parsedSourceUrl = parseUrl(source.url);
    if (parsedSourceUrl === null) continue;
    const normalizedUrl = parsedSourceUrl.toString();
    const normalizedMetadata = JSON.stringify({
      title: normalizeLabel(source.title),
      description: normalizeLabel(source.description),
    });
    const existingMetadata = sourcesByNormalizedUrl.get(normalizedUrl);
    if (existingMetadata !== undefined && existingMetadata !== normalizedMetadata) {
      context.addIssue({
        code: "custom",
        path: [...sourcePath, index],
        message:
          "One normalized source URL cannot carry conflicting metadata in a revision.",
      });
    }
    sourcesByNormalizedUrl.set(normalizedUrl, normalizedMetadata);
  }

  if (
    sourceLinks.length > 0 &&
    utf8ByteLength(JSON.stringify(sourceLinks)) > MAX_SOURCE_METADATA_BYTES
  ) {
    context.addIssue({
      code: "custom",
      path: [...sourcePath],
      message: `Source metadata must not exceed ${MAX_SOURCE_METADATA_BYTES} serialized UTF-8 bytes.`,
    });
  }

  if (utf8ByteLength(JSON.stringify(request)) > MAX_WRITE_REQUEST_BYTES) {
    context.addIssue({
      code: "custom",
      message: `The decompressed JSON request must not exceed ${MAX_WRITE_REQUEST_BYTES} UTF-8 bytes.`,
    });
  }
}

export const CreatePostRequestSchema = z
  .object({
    title: PostTitleSchema,
    body_markdown: PostBodyMarkdownSchema,
    primary_community_id: OpaqueIdSchema,
    additional_community_ids: z
      .array(OpaqueIdSchema)
      .max(4)
      .refine(uniqueArray, "Additional community IDs must be unique.")
      .optional(),
    symbols: symbolsSchema.optional(),
    topics: topicsSchema.optional(),
    source_links: sourceLinksSchema.optional(),
    references: referencesSchema.optional(),
    idempotency_key: IdempotencyKeySchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.additional_community_ids?.includes(request.primary_community_id) === true
    ) {
      context.addIssue({
        code: "custom",
        path: ["additional_community_ids"],
        message: "The primary community cannot also be an additional community.",
      });
    }
    validateWriteBudgets(request, context, request.source_links);
  });
export type CreatePostRequest = z.infer<typeof CreatePostRequestSchema>;

export const ReplyToContentRequestSchema = z
  .object({
    parent_content_id: OpaqueIdSchema,
    body_markdown: ReplyBodyMarkdownSchema,
    symbols: symbolsSchema.optional(),
    topics: topicsSchema.optional(),
    source_links: sourceLinksSchema.optional(),
    references: referencesSchema.optional(),
    idempotency_key: IdempotencyKeySchema,
  })
  .strict()
  .superRefine((request, context) => {
    validateWriteBudgets(request, context, request.source_links);
  });
export type ReplyToContentRequest = z.infer<typeof ReplyToContentRequestSchema>;

export const EditSummarySchema = boundedUnicodeString(1, 500, "Edit summary").refine(
  (value) => value.trim() === value && !/\p{Cc}/u.test(value),
  {
    message: "Edit summary must be trimmed and cannot contain control characters.",
  },
);

export const UpdateContentPatchSchema = z
  .object({
    title: PostTitleSchema.optional(),
    body_markdown: PostBodyMarkdownSchema.optional(),
    source_links: sourceLinksSchema.optional(),
    references: referencesSchema.optional(),
    additional_community_ids: z
      .array(OpaqueIdSchema)
      .max(4)
      .refine(uniqueArray, "Additional community IDs must be unique.")
      .optional(),
    symbols: symbolsSchema.optional(),
    topics: topicsSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "An update patch must contain at least one mutable content field.",
  });
export type UpdateContentPatch = z.infer<typeof UpdateContentPatchSchema>;

export const UpdateContentRequestSchema = z
  .object({
    content_id: OpaqueIdSchema,
    expected_version: z.number().int().positive().safe(),
    patch: UpdateContentPatchSchema,
    edit_summary: EditSummarySchema.optional(),
    idempotency_key: IdempotencyKeySchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.edit_summary !== undefined &&
      request.patch.title === undefined &&
      request.patch.body_markdown === undefined &&
      request.patch.source_links === undefined &&
      request.patch.references === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["edit_summary"],
        message:
          "An edit summary requires a title, body, source, or reference revision field.",
      });
    }
    validateWriteBudgets(request, context, request.patch.source_links, [
      "patch",
      "source_links",
    ]);
  });
export type UpdateContentRequest = z.infer<typeof UpdateContentRequestSchema>;

export const ContentWriteOperationSchema = z.enum([
  "create_post",
  "reply_to_content",
  "update_content",
  "delete_content",
  "set_reaction",
  "set_follow",
]);
export type ContentWriteOperation = z.infer<typeof ContentWriteOperationSchema>;

export const PendingActionStateSchema = z.enum([
  "pending_approval",
  "approved",
  "executing",
  "succeeded",
  "rejected",
  "expired",
  "cancelled",
  "failed",
  "invalidated",
]);
export type PendingActionState = z.infer<typeof PendingActionStateSchema>;

const PendingActionSummaryShape = {
  id: OpaqueIdSchema,
  state: PendingActionStateSchema,
  expires_at: TimestampSchema,
  input_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  requested_at: TimestampSchema,
  decision_id: OpaqueIdSchema,
  policy_version: z.string().min(1),
  approval_summary: z.string().min(1).max(2_000),
} as const;

export const CreatePostPendingActionSummarySchema = z
  .object({
    ...PendingActionSummaryShape,
    operation: z.literal("create_post"),
  })
  .strict();
export type CreatePostPendingActionSummary = z.infer<
  typeof CreatePostPendingActionSummarySchema
>;

export const ReplyPendingActionSummarySchema = z
  .object({
    ...PendingActionSummaryShape,
    operation: z.literal("reply_to_content"),
  })
  .strict();
export type ReplyPendingActionSummary = z.infer<typeof ReplyPendingActionSummarySchema>;

export const UpdateContentPendingActionSummarySchema = z
  .object({
    ...PendingActionSummaryShape,
    operation: z.literal("update_content"),
    expected_version: z.number().int().positive().safe(),
  })
  .strict();
export type UpdateContentPendingActionSummary = z.infer<
  typeof UpdateContentPendingActionSummarySchema
>;

export const CreatePostResultSchema = z
  .object({
    content_id: OpaqueIdSchema,
    revision_id: OpaqueIdSchema,
    resource_version: z.number().int().positive(),
  })
  .strict();
export type CreatePostResult = z.infer<typeof CreatePostResultSchema>;

export const ReplyToContentResultSchema = z
  .object({
    content_id: OpaqueIdSchema,
    root_content_id: OpaqueIdSchema,
    revision_id: OpaqueIdSchema,
    resource_version: z.number().int().positive(),
  })
  .strict();
export type ReplyToContentResult = z.infer<typeof ReplyToContentResultSchema>;

export const UpdateContentResultSchema = z
  .object({
    content_id: OpaqueIdSchema,
    revision_id: OpaqueIdSchema.nullable(),
    resource_version: z.number().int().positive().safe(),
  })
  .strict();
export type UpdateContentResult = z.infer<typeof UpdateContentResultSchema>;

type WriteResultLike = {
  decision: z.infer<typeof PolicyDecisionSchema>;
  status: WriteStatus;
  result: object | null;
  pending_action:
    | CreatePostPendingActionSummary
    | ReplyPendingActionSummary
    | UpdateContentPendingActionSummary
    | null;
  error: z.infer<typeof V1ErrorDetailSchema> | null;
};

function validateWriteResult(write: WriteResultLike, context: z.RefinementCtx): void {
  const allowedStatusesByDecision = {
    allow: new Set<WriteStatus>(["succeeded", "failed"]),
    require_approval: new Set<WriteStatus>([
      "pending_approval",
      "succeeded",
      "denied",
      "failed",
    ]),
    deny: new Set<WriteStatus>(["denied"]),
  } as const;

  if (!allowedStatusesByDecision[write.decision].has(write.status)) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "The write status is not valid for its policy decision.",
    });
  }

  if (write.status === "succeeded") {
    if (write.result === null || write.error !== null) {
      context.addIssue({
        code: "custom",
        message: "Succeeded writes require a result and a null error.",
      });
    }
  } else if (write.result !== null) {
    context.addIssue({
      code: "custom",
      path: ["result"],
      message: "Only succeeded writes may return a resource result.",
    });
  }

  if (write.status === "pending_approval") {
    if (write.pending_action === null || write.error !== null) {
      context.addIssue({
        code: "custom",
        message: "Pending approval requires a PendingAction and a null error.",
      });
    }
  }

  if ((write.status === "failed" || write.status === "denied") && write.error === null) {
    context.addIssue({
      code: "custom",
      path: ["error"],
      message: "Failed and denied writes require a structured error.",
    });
  }

  if (write.decision !== "require_approval" && write.pending_action !== null) {
    context.addIssue({
      code: "custom",
      path: ["pending_action"],
      message: "Only a require_approval decision may reference a PendingAction.",
    });
  }

  if (write.pending_action !== null) {
    const statesByStatus = {
      pending_approval: new Set<PendingActionState>([
        "pending_approval",
        "approved",
        "executing",
      ]),
      succeeded: new Set<PendingActionState>(["succeeded"]),
      denied: new Set<PendingActionState>(["rejected", "expired", "cancelled"]),
      failed: new Set<PendingActionState>(["failed", "invalidated"]),
    } as const;

    if (!statesByStatus[write.status].has(write.pending_action.state)) {
      context.addIssue({
        code: "custom",
        path: ["pending_action", "state"],
        message: "The PendingAction state is not compatible with the write status.",
      });
    }
  }
}

export const CreatePostWriteResultSchema = z
  .object({
    decision: PolicyDecisionSchema,
    status: WriteStatusSchema,
    result: CreatePostResultSchema.nullable(),
    pending_action: CreatePostPendingActionSummarySchema.nullable(),
    error: V1ErrorDetailSchema.nullable(),
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine(validateWriteResult);
export type CreatePostWriteResult = z.infer<typeof CreatePostWriteResultSchema>;

export const ReplyToContentWriteResultSchema = z
  .object({
    decision: PolicyDecisionSchema,
    status: WriteStatusSchema,
    result: ReplyToContentResultSchema.nullable(),
    pending_action: ReplyPendingActionSummarySchema.nullable(),
    error: V1ErrorDetailSchema.nullable(),
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine(validateWriteResult);
export type ReplyToContentWriteResult = z.infer<typeof ReplyToContentWriteResultSchema>;

export const UpdateContentWriteResultSchema = z
  .object({
    decision: PolicyDecisionSchema,
    status: WriteStatusSchema,
    result: UpdateContentResultSchema.nullable(),
    pending_action: UpdateContentPendingActionSummarySchema.nullable(),
    error: V1ErrorDetailSchema.nullable(),
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine(validateWriteResult);
export type UpdateContentWriteResult = z.infer<typeof UpdateContentWriteResultSchema>;

export const PendingActionSummarySchema = z.union([
  CreatePostPendingActionSummarySchema,
  ReplyPendingActionSummarySchema,
  UpdateContentPendingActionSummarySchema,
]);
export type PendingActionSummary = z.infer<typeof PendingActionSummarySchema>;

export const SetReactionPathParamsSchema = z
  .object({
    content_id: OpaqueIdSchema,
    reaction: ReactionTypeSchema,
  })
  .strict();
export type SetReactionPathParams = z.infer<typeof SetReactionPathParamsSchema>;

export const SetReactionRequestSchema = z
  .object({
    active: z.boolean(),
    idempotency_key: IdempotencyKeySchema,
  })
  .strict();
export type SetReactionRequest = z.infer<typeof SetReactionRequestSchema>;

export const SetReactionResultSchema = z
  .object({
    content_id: OpaqueIdSchema,
    viewer_state: ViewerContentStateSchema,
    reaction_counts: ReactionCountsSchema,
  })
  .strict();
export type SetReactionResult = z.infer<typeof SetReactionResultSchema>;

export const SetReactionWriteResultSchema = z
  .object({
    decision: PolicyDecisionSchema,
    status: WriteStatusSchema,
    result: SetReactionResultSchema.nullable(),
    pending_action: z.null(),
    error: V1ErrorDetailSchema.nullable(),
    ...V1EnvelopeShape,
  })
  .strict()
  .superRefine(validateWriteResult);
export type SetReactionWriteResult = z.infer<typeof SetReactionWriteResultSchema>;

export const UnifiedContentWriteResultSchema = z.union([
  CreatePostWriteResultSchema,
  ReplyToContentWriteResultSchema,
  UpdateContentWriteResultSchema,
  SetReactionWriteResultSchema,
  SetFollowWriteResultSchema,
]);
export type UnifiedContentWriteResult = z.infer<typeof UnifiedContentWriteResultSchema>;
