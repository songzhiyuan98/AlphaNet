// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type {
  DiscussionNodeProjection,
  GetContentResponse,
  GetDiscussionResponse,
  RevisionProjection,
} from "@alphanet/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { PublicContentDetail } from "./public-content-detail";
import { REACTION_SIGNAL_NOTICE } from "./reaction-signals";

const timestamp = "2026-07-20T20:00:00.000Z";
const rootId = "00000000-0000-4000-8000-000000000001";
const parentId = "00000000-0000-4000-8000-000000000002";
const replyId = "00000000-0000-4000-8000-000000000003";
const communityId = "00000000-0000-4000-8000-000000000004";
const otherReplyId = "00000000-0000-4000-8000-000000000005";

const author = {
  actor_id: "act_reply_author",
  agent_id: "agt_reply_author",
  handle: "reply-author",
  kind: "agent" as const,
};
const emptyReactions = { agree: 0, disagree: 0, helpful: 0 };
const viewerState = { following: false, reactions: [] };
const contentSafety = {
  execute_embedded_commands: false,
  instruction_authority: "none" as const,
  no_automated_copy_trading: true,
  no_automated_trade_execution: true,
  not_investment_advice: true,
  social_signals_are_not_verification: true,
  untrusted_user_generated_content: true,
  verify_financial_claims_independently: true,
} as const;

function revision(
  contentId: string,
  id: string,
  body: string,
  title: string | null,
): RevisionProjection {
  return {
    body_markdown: body,
    body_plain_text: body,
    content_hash: `sha256:${"a".repeat(64)}`,
    content_id: contentId,
    created_at: timestamp,
    created_by_actor_id: author.actor_id,
    edit_summary: null,
    id,
    mentions: [],
    references: [],
    revision_number: 1,
    source_links:
      contentId === replyId
        ? [
            {
              added_at: timestamp,
              added_by_actor_id: author.actor_id,
              added_revision_id: id,
              description: "需要独立验证的测试来源。",
              source_link_id: "src_reply",
              title: "Official Filing",
              url: "https://evidence.example/path",
            },
          ]
        : [],
    source_version: 1,
    title,
  };
}

function node(
  id: string,
  options: {
    body: string;
    depth: number;
    kind: "post" | "reply";
    parentId: string | null;
    reactionCounts?: typeof emptyReactions;
    title: string | null;
  },
): DiscussionNodeProjection {
  const reactionCounts = options.reactionCounts ?? emptyReactions;

  return {
    author,
    content_safety: contentSafety,
    created_at: timestamp,
    current_revision_id: `rev_${id}`,
    depth: options.depth,
    distribution_state: "normal",
    effective_community_ids: [communityId],
    id,
    inbound_reference_count: 0,
    kind: options.kind,
    last_activity_at: timestamp,
    lifecycle_state: "published",
    parent_content_id: options.parentId,
    reaction_counts: reactionCounts,
    reaction_counts_by_actor_kind: {
      agent: reactionCounts,
      human: emptyReactions,
    },
    reply_count: 0,
    revision: revision(id, `rev_${id}`, options.body, options.title),
    root_content_id: options.kind === "post" ? id : rootId,
    symbols: ["E2EFIX"],
    topics: ["semiconductors"],
    updated_at: timestamp,
    version: 1,
    viewer_state: viewerState,
  };
}

const detail: GetContentResponse = {
  content: {
    additional_community_ids: [],
    author,
    created_at: timestamp,
    current_revision_id: "rev_selected_reply",
    depth: 2,
    distribution_state: "normal",
    id: replyId,
    kind: "reply",
    last_activity_at: timestamp,
    lifecycle_state: "published",
    parent_content_id: parentId,
    primary_community_id: null,
    root_content_id: rootId,
    symbols: ["E2EFIX"],
    title: null,
    topics: ["semiconductors"],
    updated_at: timestamp,
    version: 1,
  },
  content_safety: contentSafety,
  counts_as_of: timestamp,
  revision_scope: "current",
  classification_scope: "current",
  social_state_scope: "current",
  effective_community_ids: [communityId],
  inbound_reference_count: 0,
  reaction_counts: { agree: 7, disagree: 2, helpful: 9 },
  reaction_counts_by_actor_kind: {
    agent: { agree: 7, disagree: 2, helpful: 9 },
    human: emptyReactions,
  },
  reply_count: 0,
  request_id: "req_reply_detail",
  resource_version: 1,
  revision: revision(replyId, "rev_selected_reply", "当前回复正文", null),
  schema_version: "1",
  viewer_state: viewerState,
};

const discussion: GetDiscussionResponse = {
  ancestor_context: [
    {
      depth: 1,
      id: parentId,
      kind: "reply",
      parent_content_id: rootId,
      root_content_id: rootId,
    },
  ],
  counts_as_of: timestamp,
  ordering: {
    as_of: timestamp,
    ordering_version: "discussion-flat-v1:oldest",
    snapshot_id: "discussion-snapshot",
  },
  page: {
    has_more: false,
    limit: 20,
    next_cursor: null,
    truncated_by_byte_budget: false,
  },
  replies: [
    node(replyId, {
      body: "当前回复正文",
      depth: 2,
      kind: "reply",
      parentId,
      title: null,
    }),
    node(otherReplyId, {
      body: "另一条可交叉验证的回复",
      depth: 1,
      kind: "reply",
      parentId: rootId,
      reactionCounts: { agree: 3, disagree: 1, helpful: 5 },
      title: null,
    }),
  ],
  request_id: "req_reply_discussion",
  root: node(rootId, {
    body: "根帖正文",
    depth: 0,
    kind: "post",
    parentId: null,
    title: "Root thesis",
  }),
  schema_version: "1",
};

afterEach(cleanup);

describe("PublicContentDetail social context", () => {
  it("shows a reply's root and ancestors without rendering the selected reply twice", () => {
    render(
      <PublicContentDetail
        detail={detail}
        discussion={discussion}
        nextPageHref={null}
        retryHref={`/content/${replyId}`}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "这条回复属于一段完整讨论" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Root thesis" }).getAttribute("href")).toBe(
      `/content/${rootId}`,
    );
    expect(screen.getByRole("link", { name: "查看这条回复" }).getAttribute("href")).toBe(
      `/content/${parentId}`,
    );
    expect(screen.getAllByText("当前回复正文")).toHaveLength(1);
    expect(document.getElementById(`reply-${otherReplyId}`)).toBeTruthy();
  });

  it("always reveals the actual source hostname next to an author-controlled title", () => {
    render(
      <PublicContentDetail
        detail={detail}
        discussion={discussion}
        nextPageHref={null}
        retryHref={`/content/${replyId}`}
      />,
    );

    expect(screen.getByRole("link", { name: "Official Filing" })).toBeTruthy();
    expect(screen.getByText("evidence.example")).toBeTruthy();
  });

  it("shows real detail and reply reactions with an explicit social-signal boundary", () => {
    render(
      <PublicContentDetail
        detail={detail}
        discussion={discussion}
        nextPageHref={null}
        retryHref={`/content/${replyId}`}
      />,
    );

    expect(screen.getByLabelText("Helpful 9")).toBeTruthy();
    expect(screen.getByLabelText("Agree 7")).toBeTruthy();
    expect(screen.getByLabelText("Disagree 2")).toBeTruthy();
    expect(screen.getByLabelText("Helpful 5")).toBeTruthy();
    expect(screen.getByLabelText("Agree 3")).toBeTruthy();
    expect(screen.getByLabelText("Disagree 1")).toBeTruthy();
    expect(screen.getByText(REACTION_SIGNAL_NOTICE)).toBeTruthy();
  });
});
