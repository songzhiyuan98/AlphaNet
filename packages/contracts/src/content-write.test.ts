import { describe, expect, it } from "vitest";

import {
  CreatePostRequestSchema,
  CreatePostWriteResultSchema,
  HttpsSourceUrlSchema,
  IdempotencyKeySchema,
  ReplyToContentRequestSchema,
  ReplyToContentWriteResultSchema,
  SetReactionPathParamsSchema,
  SetReactionRequestSchema,
  SetReactionResultSchema,
  SetReactionWriteResultSchema,
  UnifiedContentWriteResultSchema,
  UpdateContentPatchSchema,
  UpdateContentRequestSchema,
  UpdateContentWriteResultSchema,
} from "./content-write.ts";

const timestamp = "2026-07-20T12:00:00.000Z";
const pendingSummaryMetadata = {
  requested_at: timestamp,
  decision_id: "dec_pending_write",
  policy_version: "1",
  approval_summary: "Owner approval is required for this Agent write.",
} as const;

const createPost = {
  title: "AMD 数据中心情景",
  body_markdown: "## Base case\n\nRevenue growth remains sensitive to product mix.",
  primary_community_id: "com_semiconductors",
  additional_community_ids: ["com_earnings", "com_ai_infrastructure"],
  symbols: ["AMD"],
  topics: ["data-center", "scenario-analysis"],
  source_links: [
    {
      url: "https://ir.amd.com/example",
      title: "AMD investor update",
      description: "Primary disclosure for the scenario assumptions.",
    },
  ],
  references: [
    {
      target_content_id: "cnt_source",
      relation_type: "reference",
    },
  ],
  idempotency_key: "post-amd-scenarios-20260720-v1",
} as const;

const reply = {
  parent_content_id: "cnt_amd_thesis",
  body_markdown: "I disagree because the product mix changes in Q4.",
  symbols: ["AMD"],
  topics: ["margins"],
  source_links: [
    {
      url: "https://ir.amd.com/example",
      description: "Product-mix disclosure.",
    },
  ],
  references: [
    {
      target_content_id: "cnt_amd_thesis",
      relation_type: "quote",
    },
  ],
  idempotency_key: "reply-amd-margin-20260720-v1",
} as const;

const update = {
  content_id: "cnt_amd_thesis",
  expected_version: 2,
  patch: {
    body_markdown: "## Revised case\n\nRevenue remains sensitive to product mix and FX.",
    additional_community_ids: ["com_earnings"],
    symbols: ["AMD"],
    topics: ["data-center", "fx"],
    source_links: [
      {
        url: "https://ir.amd.com/revised-example",
        title: "AMD revised investor update",
      },
    ],
    references: [
      {
        target_content_id: "cnt_source",
        relation_type: "reference",
      },
    ],
  },
  edit_summary: "Add FX sensitivity",
  idempotency_key: "edit-amd-scenarios-20260720-v2",
} as const;

const structuredError = {
  code: "POLICY_DENIED",
  message: "The current policy denies this write.",
  retryable: false,
  details: null,
  retry_after_ms: null,
} as const;

describe("content write request contracts", () => {
  it("accepts complete post and reply commands and rejects forged fields", () => {
    expect(CreatePostRequestSchema.parse(createPost)).toEqual(createPost);
    expect(ReplyToContentRequestSchema.parse(reply)).toEqual(reply);

    expect(
      CreatePostRequestSchema.safeParse({
        ...createPost,
        actor_id: "act_forged",
      }).success,
    ).toBe(false);
    expect(
      ReplyToContentRequestSchema.safeParse({
        ...reply,
        primary_community_id: "com_other",
      }).success,
    ).toBe(false);
  });

  it("accepts a strict partial update and rejects empty or forged patches", () => {
    expect(UpdateContentRequestSchema.parse(update)).toEqual(update);
    expect(UpdateContentPatchSchema.parse({ symbols: [] })).toEqual({ symbols: [] });

    expect(
      UpdateContentRequestSchema.safeParse({
        ...update,
        patch: {},
      }).success,
    ).toBe(false);
    expect(
      UpdateContentRequestSchema.safeParse({
        ...update,
        patch: {
          ...update.patch,
          primary_community_id: "com_forbidden",
        },
      }).success,
    ).toBe(false);
    expect(
      UpdateContentRequestSchema.safeParse({
        ...update,
        actor_id: "act_forged",
      }).success,
    ).toBe(false);
    expect(
      UpdateContentRequestSchema.safeParse({
        ...update,
        expected_version: 0,
      }).success,
    ).toBe(false);
  });

  it("requires edit summaries to describe a revision-producing update", () => {
    expect(
      UpdateContentRequestSchema.safeParse({
        ...update,
        patch: { topics: ["fx"] },
        edit_summary: "Classification only",
      }).success,
    ).toBe(false);
    expect(
      UpdateContentRequestSchema.safeParse({
        ...update,
        patch: { body_markdown: "A material body change." },
        edit_summary: " Body change ",
      }).success,
    ).toBe(false);
    expect(
      UpdateContentRequestSchema.safeParse({
        ...update,
        patch: { body_markdown: "A material body change." },
        edit_summary: "x".repeat(501),
      }).success,
    ).toBe(false);
  });

  it("applies source and decompressed request budgets inside update patches", () => {
    expect(
      UpdateContentRequestSchema.safeParse({
        ...update,
        patch: {
          source_links: [
            { url: "https://EXAMPLE.test:443/report", title: "First label" },
            { url: "https://example.test/report", title: "Conflicting label" },
          ],
        },
        edit_summary: "Replace evidence",
      }).success,
    ).toBe(false);
    expect(
      UpdateContentRequestSchema.safeParse({
        ...update,
        patch: {
          body_markdown: "x".repeat(100_000),
          topics: Array.from(
            { length: 5 },
            (_, index) => `${index}-${"t".repeat(190_000)}`,
          ),
        },
      }).success,
    ).toBe(false);
  });

  it("enforces content, community, source, and request budgets", () => {
    expect(
      CreatePostRequestSchema.safeParse({
        ...createPost,
        title: "tiny",
      }).success,
    ).toBe(false);
    expect(
      CreatePostRequestSchema.safeParse({
        ...createPost,
        additional_community_ids: ["com_1", "com_2", "com_3", "com_4", "com_5"],
      }).success,
    ).toBe(false);
    expect(
      CreatePostRequestSchema.safeParse({
        ...createPost,
        additional_community_ids: ["com_semiconductors"],
      }).success,
    ).toBe(false);
    expect(
      CreatePostRequestSchema.safeParse({
        ...createPost,
        additional_community_ids: ["com_earnings", "com_earnings"],
      }).success,
    ).toBe(false);
    expect(
      CreatePostRequestSchema.safeParse({
        ...createPost,
        body_markdown: "😀".repeat(41_000),
      }).success,
    ).toBe(false);
    expect(
      CreatePostRequestSchema.safeParse({
        ...createPost,
        source_links: [{ url: "http://example.com/source" }],
      }).success,
    ).toBe(false);
    expect(
      CreatePostRequestSchema.safeParse({
        ...createPost,
        source_links: [
          {
            url: `https://example.com/${"a".repeat(2_100)}`,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ReplyToContentRequestSchema.safeParse({
        ...reply,
        body_markdown: "x".repeat(20_001),
      }).success,
    ).toBe(false);

    const largeSource = {
      url: `https://example.com/${"a".repeat(1_900)}`,
      title: "t".repeat(300),
      description: "d".repeat(1_000),
    };
    expect(
      CreatePostRequestSchema.safeParse({
        ...createPost,
        source_links: Array.from({ length: 50 }, () => largeSource),
      }).success,
    ).toBe(false);

    expect(
      CreatePostRequestSchema.safeParse({
        ...createPost,
        symbols: Array.from(
          { length: 10 },
          (_, index) => `${index}-${"s".repeat(110_000)}`,
        ),
      }).success,
    ).toBe(false);
  });

  it("rejects PostgreSQL-incompatible NUL while preserving Markdown layout", () => {
    for (const payload of [
      { ...createPost, title: "AMD\u0000 research title" },
      { ...createPost, body_markdown: "Research\u0000body" },
      {
        ...createPost,
        source_links: [
          {
            url: "https://example.test/source",
            title: "Source\u0000title",
          },
        ],
      },
      {
        ...createPost,
        source_links: [
          {
            url: "https://example.test/source",
            description: "Source\u0000description",
          },
        ],
      },
    ]) {
      expect(CreatePostRequestSchema.safeParse(payload).success).toBe(false);
    }

    expect(
      CreatePostRequestSchema.safeParse({
        ...createPost,
        body_markdown: "Line one\n\tLine two",
      }).success,
    ).toBe(true);
  });

  it("requires canonical unique symbols/topics and bounded safe idempotency keys", () => {
    expect(
      CreatePostRequestSchema.safeParse({
        ...createPost,
        symbols: ["AMD", "AMD"],
      }).success,
    ).toBe(false);
    expect(
      CreatePostRequestSchema.safeParse({
        ...createPost,
        symbols: ["amd"],
      }).success,
    ).toBe(false);
    expect(
      CreatePostRequestSchema.safeParse({
        ...createPost,
        topics: ["data-center", "data-center"],
      }).success,
    ).toBe(false);
    expect(
      CreatePostRequestSchema.safeParse({
        ...createPost,
        topics: ["Data-Center"],
      }).success,
    ).toBe(false);

    expect(IdempotencyKeySchema.safeParse("k".repeat(200)).success).toBe(true);
    expect(IdempotencyKeySchema.safeParse("😀".repeat(200)).success).toBe(true);
    expect(IdempotencyKeySchema.safeParse("k".repeat(201)).success).toBe(false);
    expect(IdempotencyKeySchema.safeParse("😀".repeat(201)).success).toBe(false);
    expect(IdempotencyKeySchema.safeParse("key\nsecond-line").success).toBe(false);
    expect(IdempotencyKeySchema.safeParse("key\u0085suffix").success).toBe(false);
  });

  it("keeps fragments but rejects source userinfo and conflicting normalized duplicates", () => {
    const fragmentUrl = "https://example.test/report#risk-factors";
    expect(HttpsSourceUrlSchema.parse(fragmentUrl)).toBe(fragmentUrl);
    expect(
      HttpsSourceUrlSchema.safeParse(
        "https://researcher:secret@example.test/report#risk-factors",
      ).success,
    ).toBe(false);

    const duplicateSources = {
      ...reply,
      source_links: [
        {
          url: "https://EXAMPLE.test:443/report#risk-factors",
          title: " Source report ",
        },
        {
          url: "https://example.test/report#risk-factors",
          title: "Source report",
        },
      ],
    } as const;
    expect(ReplyToContentRequestSchema.safeParse(duplicateSources).success).toBe(true);
    expect(
      ReplyToContentRequestSchema.safeParse({
        ...duplicateSources,
        source_links: [
          duplicateSources.source_links[0],
          {
            ...duplicateSources.source_links[1],
            title: "Conflicting report metadata",
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      ReplyToContentRequestSchema.safeParse({
        ...reply,
        source_links: [
          { url: "https://example.test/report#risk-factors" },
          { url: "https://example.test/report#financial-statements" },
        ],
        references: [
          {
            target_content_id: "cnt_source",
            relation_type: "quote",
          },
          {
            target_content_id: "cnt_source",
            relation_type: "quote",
          },
          {
            target_content_id: "cnt_source",
            relation_type: "reference",
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("unified write and PendingAction contracts", () => {
  it("accepts the Assisted pending result without creating a resource", () => {
    const pending = {
      decision: "require_approval",
      status: "pending_approval",
      result: null,
      pending_action: {
        id: "act_pending_post",
        operation: "create_post",
        state: "pending_approval",
        expires_at: timestamp,
        input_digest: `sha256:${"a".repeat(64)}`,
        ...pendingSummaryMetadata,
      },
      error: null,
      request_id: "req-post",
      schema_version: "1",
    } as const;

    expect(CreatePostWriteResultSchema.parse(pending)).toEqual(pending);
    expect(UnifiedContentWriteResultSchema.parse(pending)).toEqual(pending);
    for (const field of [
      "requested_at",
      "decision_id",
      "policy_version",
      "approval_summary",
    ] as const) {
      expect(
        CreatePostWriteResultSchema.safeParse({
          ...pending,
          pending_action: { ...pending.pending_action, [field]: undefined },
        }).success,
      ).toBe(false);
    }
    expect(
      CreatePostWriteResultSchema.safeParse({
        ...pending,
        pending_action: { ...pending.pending_action, input_digest: "sha256:short" },
      }).success,
    ).toBe(false);
    expect(
      CreatePostWriteResultSchema.safeParse({
        ...pending,
        result: {
          content_id: "cnt_too_early",
          revision_id: "rev_too_early",
          resource_version: 1,
        },
      }).success,
    ).toBe(false);
    expect(
      CreatePostWriteResultSchema.safeParse({
        ...pending,
        pending_action: {
          ...pending.pending_action,
          operation: "reply_to_content",
        },
      }).success,
    ).toBe(false);
  });

  it("binds pending and successful updates to the expected resource version", () => {
    const pending = {
      decision: "require_approval",
      status: "pending_approval",
      result: null,
      pending_action: {
        id: "act_pending_update",
        operation: "update_content",
        state: "pending_approval",
        expected_version: 2,
        expires_at: timestamp,
        input_digest: `sha256:${"b".repeat(64)}`,
        ...pendingSummaryMetadata,
      },
      error: null,
      request_id: "req-update-pending",
      schema_version: "1",
    } as const;
    expect(UpdateContentWriteResultSchema.parse(pending)).toEqual(pending);
    expect(UnifiedContentWriteResultSchema.parse(pending)).toEqual(pending);
    expect(
      UpdateContentWriteResultSchema.safeParse({
        ...pending,
        pending_action: {
          ...pending.pending_action,
          expected_version: undefined,
        },
      }).success,
    ).toBe(false);

    const revised = {
      decision: "allow",
      status: "succeeded",
      result: {
        content_id: update.content_id,
        revision_id: "rev_amd_3",
        resource_version: 3,
      },
      pending_action: null,
      error: null,
      request_id: "req-update-direct",
      schema_version: "1",
    } as const;
    expect(UpdateContentWriteResultSchema.parse(revised)).toEqual(revised);
    expect(UnifiedContentWriteResultSchema.parse(revised)).toEqual(revised);

    const classificationOnly = {
      ...revised,
      result: { ...revised.result, revision_id: null },
    } as const;
    expect(UpdateContentWriteResultSchema.parse(classificationOnly)).toEqual(
      classificationOnly,
    );
  });

  it("accepts direct and approved success while rejecting illegal decision/status pairs", () => {
    const directSuccess = {
      decision: "allow",
      status: "succeeded",
      result: {
        content_id: "cnt_reply",
        root_content_id: "cnt_root",
        revision_id: "rev_reply_1",
        resource_version: 1,
      },
      pending_action: null,
      error: null,
      request_id: "req-reply",
      schema_version: "1",
    } as const;
    expect(ReplyToContentWriteResultSchema.parse(directSuccess)).toEqual(directSuccess);

    const approvedSuccess = {
      decision: "require_approval",
      status: "succeeded",
      result: {
        content_id: "cnt_post",
        revision_id: "rev_post_1",
        resource_version: 1,
      },
      pending_action: {
        id: "act_post",
        operation: "create_post",
        state: "succeeded",
        expires_at: timestamp,
        input_digest: `sha256:${"c".repeat(64)}`,
        ...pendingSummaryMetadata,
      },
      error: null,
      request_id: "req-post-approved",
      schema_version: "1",
    } as const;
    expect(CreatePostWriteResultSchema.parse(approvedSuccess)).toEqual(approvedSuccess);

    expect(
      CreatePostWriteResultSchema.safeParse({
        ...approvedSuccess,
        decision: "deny",
      }).success,
    ).toBe(false);
    expect(
      CreatePostWriteResultSchema.safeParse({
        ...approvedSuccess,
        status: "failed",
        result: null,
      }).success,
    ).toBe(false);

    const denied = {
      decision: "deny",
      status: "denied",
      result: null,
      pending_action: null,
      error: structuredError,
      request_id: "req-denied",
      schema_version: "1",
    } as const;
    expect(CreatePostWriteResultSchema.parse(denied)).toEqual(denied);
    expect(
      CreatePostWriteResultSchema.safeParse({
        ...denied,
        debug_policy_trace: true,
      }).success,
    ).toBe(false);
  });

  it("accepts a transient RATE_LIMITED admission denial only with retry evidence", () => {
    const rateLimited = {
      decision: "deny",
      status: "denied",
      result: null,
      pending_action: null,
      error: {
        code: "RATE_LIMITED",
        message: "The Community post rate limit has been reached.",
        retryable: true,
        details: { limit_dimension: "community_post" },
        retry_after_ms: 75_000,
      },
      request_id: "req-rate-limited",
      schema_version: "1",
    } as const;

    expect(CreatePostWriteResultSchema.parse(rateLimited)).toEqual(rateLimited);
    expect(
      CreatePostWriteResultSchema.safeParse({
        ...rateLimited,
        error: {
          ...rateLimited.error,
          retry_after_ms: null,
        },
      }).success,
    ).toBe(false);
  });
});

describe("Reaction write contracts", () => {
  const reactionPath = {
    content_id: "cnt_amd_thesis",
    reaction: "helpful",
  } as const;
  const reactionRequest = {
    active: true,
    idempotency_key: "reaction-amd-helpful-v1",
  } as const;
  const reactionResult = {
    content_id: "cnt_amd_thesis",
    reaction_counts: {
      helpful: 7,
      agree: 3,
      disagree: 2,
    },
    viewer_state: {
      reactions: ["helpful", "disagree"],
      following: false,
    },
  } as const;

  it("accepts the path, target-state request, and independent reaction projection", () => {
    expect(SetReactionPathParamsSchema.parse(reactionPath)).toEqual(reactionPath);
    expect(SetReactionRequestSchema.parse(reactionRequest)).toEqual(reactionRequest);
    expect(SetReactionRequestSchema.parse({ ...reactionRequest, active: false })).toEqual(
      { ...reactionRequest, active: false },
    );
    expect(SetReactionResultSchema.parse(reactionResult)).toEqual(reactionResult);
  });

  it("rejects unknown reactions, forged transport fields, and malformed target state", () => {
    expect(
      SetReactionPathParamsSchema.safeParse({
        ...reactionPath,
        reaction: "like",
      }).success,
    ).toBe(false);
    expect(
      SetReactionPathParamsSchema.safeParse({
        ...reactionPath,
        actor_id: "act_forged",
      }).success,
    ).toBe(false);
    expect(
      SetReactionRequestSchema.safeParse({
        ...reactionRequest,
        active: "true",
      }).success,
    ).toBe(false);
    expect(
      SetReactionRequestSchema.safeParse({
        ...reactionRequest,
        content_id: reactionPath.content_id,
      }).success,
    ).toBe(false);
    expect(
      SetReactionRequestSchema.safeParse({
        ...reactionRequest,
        idempotency_key: "reaction\nsecond-line",
      }).success,
    ).toBe(false);
  });

  it("rejects invalid aggregate counts and duplicate viewer reactions", () => {
    expect(
      SetReactionResultSchema.safeParse({
        ...reactionResult,
        reaction_counts: {
          ...reactionResult.reaction_counts,
          helpful: -1,
        },
      }).success,
    ).toBe(false);
    expect(
      SetReactionResultSchema.safeParse({
        ...reactionResult,
        viewer_state: {
          ...reactionResult.viewer_state,
          reactions: ["helpful", "helpful"],
        },
      }).success,
    ).toBe(false);
    expect(
      SetReactionResultSchema.safeParse({
        ...reactionResult,
        reaction_counts_by_actor_kind: {
          agent: reactionResult.reaction_counts,
          human: { helpful: 0, agree: 0, disagree: 0 },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts a successful Reaction result through the operation and unified schemas", () => {
    const succeeded = {
      decision: "allow",
      status: "succeeded",
      result: reactionResult,
      pending_action: null,
      error: null,
      request_id: "req-reaction",
      schema_version: "1",
    } as const;

    expect(SetReactionWriteResultSchema.parse(succeeded)).toEqual(succeeded);
    expect(UnifiedContentWriteResultSchema.parse(succeeded)).toEqual(succeeded);
    expect(
      SetReactionWriteResultSchema.safeParse({
        ...succeeded,
        result: null,
      }).success,
    ).toBe(false);
    expect(
      SetReactionWriteResultSchema.safeParse({
        ...succeeded,
        pending_action: {
          id: "act_reaction",
          operation: "set_reaction",
          state: "pending_approval",
          expires_at: timestamp,
          input_digest: "sha256:45891d",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts structured denial/failure and rejects incomplete rate-limit evidence", () => {
    const denied = {
      decision: "deny",
      status: "denied",
      result: null,
      pending_action: null,
      error: structuredError,
      request_id: "req-reaction-denied",
      schema_version: "1",
    } as const;
    expect(SetReactionWriteResultSchema.parse(denied)).toEqual(denied);

    const rateLimited = {
      ...denied,
      error: {
        code: "RATE_LIMITED",
        message: "The Reaction rate limit has been reached.",
        retryable: true,
        details: { limit_dimension: "agent_reaction" },
        retry_after_ms: 45_000,
      },
    } as const;
    expect(SetReactionWriteResultSchema.parse(rateLimited)).toEqual(rateLimited);
    expect(
      SetReactionWriteResultSchema.safeParse({
        ...rateLimited,
        error: { ...rateLimited.error, retry_after_ms: null },
      }).success,
    ).toBe(false);
    expect(
      SetReactionWriteResultSchema.safeParse({
        ...denied,
        error: null,
      }).success,
    ).toBe(false);
  });
});
