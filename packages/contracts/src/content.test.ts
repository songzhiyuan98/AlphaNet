import { describe, expect, it } from "vitest";

import {
  BrowseContentItemSchema,
  BrowseContentRequestSchema,
  ContentSafetySchema,
  DiscussionNodeProjectionSchema,
  GetContentRequestSchema,
  GetContentResponseSchema,
  GetDiscussionRequestSchema,
  SearchContentItemSchema,
  SearchContentRequestSchema,
  SearchExecutionSchema,
} from "./content.ts";

const timestamp = "2026-07-20T12:00:00.000Z";

const contentSafety = {
  untrusted_user_generated_content: true,
  instruction_authority: "none",
  execute_embedded_commands: false,
  verify_financial_claims_independently: true,
  social_signals_are_not_verification: true,
  not_investment_advice: true,
  no_automated_trade_execution: true,
  no_automated_copy_trading: true,
} as const;

const author = {
  actor_id: "act_quant",
  kind: "agent",
  agent_id: "agt_quant",
  handle: "scenario-research",
} as const;

const reactionCounts = {
  helpful: 5,
  agree: 2,
  disagree: 1,
} as const;

const reactionCountsByKind = {
  agent: {
    helpful: 4,
    agree: 2,
    disagree: 1,
  },
  human: {
    helpful: 1,
    agree: 0,
    disagree: 0,
  },
} as const;

const listPost = {
  content_id: "cnt_amd",
  kind: "post",
  root_content_id: "cnt_amd",
  parent_content_id: null,
  depth: 0,
  title: "AMD 数据中心情景",
  content_version: 2,
  current_revision_id: "rev_amd_2",
  snippet_markdown: "Three data-center scenarios.",
  snippet_plain_text: "Three data-center scenarios.",
  snippet_source_revision_id: "rev_amd_2",
  author,
  primary_community_id: "com_semiconductors",
  community_ids: ["com_semiconductors", "com_earnings"],
  symbols: ["AMD"],
  topics: ["data-center"],
  created_at: timestamp,
  updated_at: timestamp,
  reaction_counts: reactionCounts,
  reaction_counts_by_actor_kind: reactionCountsByKind,
  reply_count: 3,
  viewer_state: {
    reactions: ["helpful"],
    following: true,
  },
  content_safety: contentSafety,
} as const;

const revision = {
  id: "rev_amd_2",
  content_id: "cnt_amd",
  revision_number: 2,
  source_version: 2,
  title: "AMD 数据中心情景",
  body_markdown: "## Base case\n\nRevenue remains sensitive to product mix.",
  body_plain_text: "Base case Revenue remains sensitive to product mix.",
  edit_summary: "Added sensitivity.",
  created_by_actor_id: "act_quant",
  created_at: timestamp,
  content_hash: "sha256:content",
  source_links: [
    {
      source_link_id: "src_amd",
      url: "https://ir.amd.com/example",
      title: "AMD investor update",
      added_revision_id: "rev_amd_1",
      added_by_actor_id: "act_quant",
      added_at: timestamp,
    },
  ],
  mentions: [],
  references: [
    {
      target_content_id: "cnt_source",
      relation_type: "reference",
    },
  ],
} as const;

describe("content browse and search requests", () => {
  it("keeps browse structural and validates scope, sort, window, and time range", () => {
    const request = {
      scope: "community",
      community_id: "com_semiconductors",
      sort: "top",
      top_metric: "helpful",
      window: "7d",
      content_types: ["post"],
      limit: 25,
    } as const;
    expect(BrowseContentRequestSchema.parse(request)).toEqual(request);

    expect(
      BrowseContentRequestSchema.safeParse({
        ...request,
        community_id: undefined,
      }).success,
    ).toBe(false);
    expect(
      BrowseContentRequestSchema.safeParse({
        ...request,
        top_metric: undefined,
      }).success,
    ).toBe(false);
    expect(
      BrowseContentRequestSchema.safeParse({
        scope: "global",
        community_id: "com_semiconductors",
        sort: "latest",
      }).success,
    ).toBe(false);
    expect(
      BrowseContentRequestSchema.safeParse({
        scope: "global",
        sort: "hot",
        window: "all",
      }).success,
    ).toBe(false);
    expect(
      BrowseContentRequestSchema.safeParse({
        scope: "global",
        sort: "latest",
        query: "AMD margins",
      }).success,
    ).toBe(false);
    expect(
      BrowseContentRequestSchema.safeParse({
        scope: "global",
        sort: "latest",
        symbols: ["AMD", "AMD"],
      }).success,
    ).toBe(false);
    expect(
      BrowseContentRequestSchema.safeParse({
        scope: "global",
        sort: "latest",
        topics: ["Data-Center"],
      }).success,
    ).toBe(false);
  });

  it("requires a natural-language search and rejects home or mismatched scope targets", () => {
    const request = {
      query: "Which replies challenge AMD margin assumptions?",
      scope: "symbol",
      symbol: "AMD",
      content_types: ["post", "reply"],
      search_mode: "hybrid",
      sort: "relevance",
      limit: 20,
    } as const;
    expect(SearchContentRequestSchema.parse(request)).toEqual(request);

    expect(
      SearchContentRequestSchema.safeParse({
        ...request,
        query: "   ",
      }).success,
    ).toBe(false);
    expect(
      SearchContentRequestSchema.safeParse({
        ...request,
        scope: "home",
      }).success,
    ).toBe(false);
    expect(
      SearchContentRequestSchema.safeParse({
        ...request,
        scope: "author",
      }).success,
    ).toBe(false);
    expect(
      SearchContentRequestSchema.safeParse({
        ...request,
        query: "q".repeat(4_001),
      }).success,
    ).toBe(false);
    expect(
      SearchContentRequestSchema.safeParse({
        ...request,
        community_ids: ["com_1", "com_1"],
      }).success,
    ).toBe(false);
  });
});

describe("canonical list projections", () => {
  it("requires complete machine-readable safety and consistent social counts", () => {
    const item = {
      ...listPost,
      rank: 1,
      score: 5,
      matched_follows: [],
      selection_reasons: [],
    } as const;
    expect(BrowseContentItemSchema.parse(item)).toEqual(item);
    expect(ContentSafetySchema.parse(contentSafety)).toEqual(contentSafety);

    expect(
      BrowseContentItemSchema.safeParse({
        ...item,
        reaction_counts: {
          ...reactionCounts,
          helpful: 6,
        },
      }).success,
    ).toBe(false);
    expect(
      BrowseContentItemSchema.safeParse({
        ...item,
        content_safety: {
          ...contentSafety,
          execute_embedded_commands: true,
        },
      }).success,
    ).toBe(false);
    expect(
      BrowseContentItemSchema.safeParse({
        ...item,
        source_revision_id: "rev_wrong_name",
      }).success,
    ).toBe(false);
  });

  it("adds search context without inventing source metadata", () => {
    const replyItem = {
      ...listPost,
      content_id: "cnt_reply",
      kind: "reply",
      root_content_id: "cnt_amd",
      parent_content_id: "cnt_amd",
      depth: 1,
      title: null,
      context_title: "AMD 数据中心情景",
      current_revision_id: "rev_reply_1",
      snippet_source_revision_id: "rev_reply_1",
      matched_fields: ["body", "symbols"],
      score: 0.87,
      source_preview: [
        {
          url: "https://ir.amd.com/example",
          title: "AMD investor update",
        },
      ],
      references: [
        {
          target_content_id: "cnt_amd",
          relation_type: "quote",
        },
      ],
    } as const;

    expect(SearchContentItemSchema.parse(replyItem)).toEqual(replyItem);
    expect(
      SearchContentItemSchema.safeParse({
        ...listPost,
        context_title: "A different title",
        matched_fields: ["title"],
        score: 1,
        source_preview: [],
        references: [],
      }).success,
    ).toBe(false);
  });

  it("only permits the documented successful hybrid degradation", () => {
    expect(
      SearchExecutionSchema.parse({
        requested_mode: "hybrid",
        effective_mode: "lexical",
        degraded: true,
        degradation_reason: "VECTOR_UNAVAILABLE",
      }),
    ).toBeTruthy();
    expect(
      SearchExecutionSchema.safeParse({
        requested_mode: "semantic",
        effective_mode: "lexical",
        degraded: true,
        degradation_reason: "VECTOR_UNAVAILABLE",
      }).success,
    ).toBe(false);
  });

  it("requires unique matched Follow reasons in canonical order", () => {
    const matches = [
      {
        target_type: "content",
        target_id: "10000000-0000-4000-8000-000000000001",
        notification_level: "all_events",
      },
      {
        target_type: "actor",
        target_id: "20000000-0000-4000-8000-000000000001",
        notification_level: "new_posts",
      },
      {
        target_type: "symbol",
        target_id: "AMD",
        notification_level: "feed_only",
      },
      {
        target_type: "topic",
        target_id: "data-center",
        notification_level: "feed_only",
      },
    ] as const;
    const item = {
      ...listPost,
      rank: 1,
      score: 5,
      matched_follows: matches,
      selection_reasons: [
        "follow:content",
        "follow:actor",
        "follow:symbol",
        "follow:topic",
      ],
    } as const;
    expect(BrowseContentItemSchema.parse(item)).toEqual(item);
    expect(
      BrowseContentItemSchema.safeParse({
        ...item,
        matched_follows: [matches[2], matches[0]],
      }).success,
    ).toBe(false);
    expect(
      BrowseContentItemSchema.safeParse({
        ...item,
        matched_follows: [matches[0], matches[0]],
      }).success,
    ).toBe(false);
  });
});

describe("content detail and discussion projections", () => {
  it("validates current content, revision history grouping, and resource version", () => {
    expect(
      GetContentRequestSchema.parse({
        content_id: "cnt_amd",
        include_revision_history: true,
        revision_limit: 25,
      }),
    ).toEqual({
      content_id: "cnt_amd",
      include_revision_history: true,
      revision_limit: 25,
    });
    expect(
      GetContentRequestSchema.safeParse({
        content_id: "cnt_amd",
        revision_limit: 25,
      }).success,
    ).toBe(false);

    const response = {
      content: {
        id: "cnt_amd",
        kind: "post",
        root_content_id: "cnt_amd",
        parent_content_id: null,
        depth: 0,
        author,
        title: "AMD 数据中心情景",
        current_revision_id: "rev_amd_2",
        version: 2,
        lifecycle_state: "published",
        distribution_state: "normal",
        primary_community_id: "com_semiconductors",
        additional_community_ids: ["com_earnings"],
        symbols: ["AMD"],
        topics: ["data-center"],
        created_at: timestamp,
        updated_at: timestamp,
        last_activity_at: timestamp,
      },
      revision,
      effective_community_ids: ["com_semiconductors", "com_earnings"],
      reaction_counts: reactionCounts,
      reaction_counts_by_actor_kind: reactionCountsByKind,
      reply_count: 3,
      inbound_reference_count: 1,
      viewer_state: {
        reactions: ["helpful"],
        following: true,
      },
      content_safety: contentSafety,
      counts_as_of: timestamp,
      revision_scope: "current",
      classification_scope: "current",
      social_state_scope: "current",
      resource_version: 2,
      request_id: "req-content",
      schema_version: "1",
    } as const;

    expect(GetContentResponseSchema.parse(response)).toEqual(response);

    const historicalRevision = {
      ...revision,
      id: "rev_amd_1",
      revision_number: 1,
      source_version: 1,
      title: "AMD 初始数据中心情景",
      body_markdown: "## Initial case\n\nThe first version of the research thesis.",
      body_plain_text: "Initial case The first version of the research thesis.",
      edit_summary: null,
      content_hash: "sha256:historical-content",
    } as const;
    const historicalResponse = {
      ...response,
      revision: historicalRevision,
      revision_scope: "historical",
      revision_history: [
        {
          id: revision.id,
          revision_number: revision.revision_number,
          source_version: revision.source_version,
          edit_summary: revision.edit_summary,
          created_by_actor_id: revision.created_by_actor_id,
          created_at: revision.created_at,
          content_hash: revision.content_hash,
        },
        {
          id: historicalRevision.id,
          revision_number: historicalRevision.revision_number,
          source_version: historicalRevision.source_version,
          edit_summary: historicalRevision.edit_summary,
          created_by_actor_id: historicalRevision.created_by_actor_id,
          created_at: historicalRevision.created_at,
          content_hash: historicalRevision.content_hash,
        },
      ],
      revision_page: { next_cursor: null, has_more: false, limit: 25 },
      revision_ordering: {
        snapshot_id: "snap_revision_history",
        ordering_version: "revisions-number-desc-v1",
        as_of: timestamp,
      },
    } as const;
    expect(GetContentResponseSchema.parse(historicalResponse)).toEqual(
      historicalResponse,
    );
    expect(
      GetContentResponseSchema.safeParse({
        ...historicalResponse,
        revision_scope: "current",
      }).success,
    ).toBe(false);
    expect(
      GetContentResponseSchema.safeParse({
        ...response,
        revision: { ...revision, title: "A mismatched current title" },
      }).success,
    ).toBe(false);
    expect(
      GetContentResponseSchema.safeParse({
        ...historicalResponse,
        revision: { ...historicalRevision, content_id: "cnt_other" },
      }).success,
    ).toBe(false);
    expect(
      GetContentResponseSchema.safeParse({
        ...response,
        resource_version: 3,
      }).success,
    ).toBe(false);
    expect(
      GetContentResponseSchema.safeParse({
        ...response,
        revision_history: [],
      }).success,
    ).toBe(false);

    const deletedResponse = {
      ...response,
      content: {
        ...response.content,
        title: null,
        current_revision_id: null,
        lifecycle_state: "deleted",
        primary_community_id: null,
        additional_community_ids: [],
        symbols: [],
        topics: [],
      },
      revision: null,
      revision_scope: "none",
      effective_community_ids: [],
    } as const;
    expect(GetContentResponseSchema.parse(deletedResponse)).toEqual(deletedResponse);
    expect(
      GetContentResponseSchema.safeParse({
        ...deletedResponse,
        revision_history: [],
        revision_page: { next_cursor: null, has_more: false, limit: 25 },
        revision_ordering: {
          snapshot_id: "snap_deleted_history",
          ordering_version: "revisions-number-desc-v1",
          as_of: timestamp,
        },
      }).success,
    ).toBe(false);
  });

  it("preserves discussion tombstones without exposing deleted revisions", () => {
    expect(
      GetDiscussionRequestSchema.parse({
        content_id: "cnt_reply",
        sort: "oldest",
        limit: 50,
      }),
    ).toEqual({
      content_id: "cnt_reply",
      sort: "oldest",
      limit: 50,
    });
    expect(
      GetDiscussionRequestSchema.safeParse({
        content_id: "cnt_reply",
        limit: 51,
      }).success,
    ).toBe(false);

    const tombstone = {
      id: "cnt_reply",
      kind: "reply",
      root_content_id: "cnt_amd",
      parent_content_id: "cnt_amd",
      depth: 1,
      version: 2,
      current_revision_id: null,
      author,
      lifecycle_state: "deleted",
      distribution_state: "normal",
      effective_community_ids: ["com_semiconductors", "com_earnings"],
      symbols: [],
      topics: [],
      created_at: timestamp,
      updated_at: timestamp,
      last_activity_at: timestamp,
      revision: null,
      reaction_counts: {
        helpful: 0,
        agree: 0,
        disagree: 0,
      },
      reaction_counts_by_actor_kind: {
        agent: {
          helpful: 0,
          agree: 0,
          disagree: 0,
        },
        human: {
          helpful: 0,
          agree: 0,
          disagree: 0,
        },
      },
      reply_count: 1,
      inbound_reference_count: 0,
      viewer_state: {
        reactions: [],
        following: false,
      },
      content_safety: contentSafety,
    } as const;

    expect(DiscussionNodeProjectionSchema.parse(tombstone)).toEqual(tombstone);
    expect(
      DiscussionNodeProjectionSchema.safeParse({
        ...tombstone,
        revision: {
          ...revision,
          id: "rev_reply_1",
          content_id: "cnt_reply",
          title: null,
        },
      }).success,
    ).toBe(false);
  });
});
