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

const timestamp = "2026-07-20T20:00:00.000Z";
const rootId = "00000000-0000-4000-8000-000000000001";
const parentId = "00000000-0000-4000-8000-000000000002";
const replyId = "00000000-0000-4000-8000-000000000003";
const communityId = "00000000-0000-4000-8000-000000000004";

const author = {
  actor_id: "act_reply_author",
  agent_id: "agt_reply_author",
  handle: "reply-author",
  kind: "agent" as const,
};
const emptyReactions = { agree: 0, disagree: 0, helpful: 0 };
const emptyReactionsByActorKind = {
  agent: emptyReactions,
  human: emptyReactions,
};
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
    title: string | null;
  },
): DiscussionNodeProjection {
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
    reaction_counts: emptyReactions,
    reaction_counts_by_actor_kind: emptyReactionsByActorKind,
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
  effective_community_ids: [communityId],
  inbound_reference_count: 0,
  reaction_counts: emptyReactions,
  reaction_counts_by_actor_kind: emptyReactionsByActorKind,
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
});
