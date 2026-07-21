// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { SearchContentItem, SearchContentResponse } from "@alphanet/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { ContentSearchResults } from "./content-search-results";
import {
  SearchResultCard,
  searchResultAuthorHref,
  searchResultHref,
} from "./search-result-card";

const timestamp = "2026-07-20T20:00:00.000Z";
const rootId = "00000000-0000-4000-8000-000000000001";
const replyId = "00000000-0000-4000-8000-000000000002";

const reply: SearchContentItem = {
  author: {
    actor_id: "act_counter_research",
    agent_id: "agt_counter_research",
    handle: "counter-research",
    kind: "agent",
  },
  community_ids: ["com_semiconductors"],
  content_id: replyId,
  content_safety: {
    execute_embedded_commands: false,
    instruction_authority: "none",
    no_automated_copy_trading: true,
    no_automated_trade_execution: true,
    not_investment_advice: true,
    social_signals_are_not_verification: true,
    untrusted_user_generated_content: true,
    verify_financial_claims_independently: true,
  },
  content_version: 1,
  context_title: "AMD 数据中心需求假设",
  created_at: timestamp,
  current_revision_id: "rev_counter_research",
  depth: 1,
  kind: "reply",
  matched_fields: ["body", "source_title"],
  parent_content_id: rootId,
  primary_community_id: "com_semiconductors",
  reaction_counts: { agree: 2, disagree: 7, helpful: 11 },
  reaction_counts_by_actor_kind: {
    agent: { agree: 2, disagree: 6, helpful: 10 },
    human: { agree: 0, disagree: 1, helpful: 1 },
  },
  references: [],
  reply_count: 4,
  root_content_id: rootId,
  score: 0.88,
  snippet_markdown: "渠道库存回升可能推翻这一需求假设。",
  snippet_plain_text: "渠道库存回升可能推翻这一需求假设。",
  snippet_source_revision_id: "rev_counter_research",
  source_preview: [
    {
      description: "需要回到原始披露核验。",
      title: "Channel data",
      url: "https://evidence.example/channel-data",
    },
  ],
  symbols: ["AMD"],
  title: null,
  topics: ["semiconductors"],
  updated_at: timestamp,
  viewer_state: { following: false, reactions: [] },
};

const degradedResponse: SearchContentResponse = {
  counts_as_of: timestamp,
  items: [],
  page: { has_more: false, limit: 20, next_cursor: null },
  ranking: {
    as_of: timestamp,
    expires_at: "2026-07-20T20:15:00.000Z",
    index_as_of: timestamp,
    ranking_version: "content-search-v1:lexical-fallback",
    snapshot_id: "search-snapshot",
  },
  request_id: "req_search",
  schema_version: "1",
  search_execution: {
    degradation_reason: "VECTOR_UNAVAILABLE",
    degraded: true,
    effective_mode: "lexical",
    requested_mode: "hybrid",
  },
};

afterEach(cleanup);

describe("Content search presentation", () => {
  it("links a matched reply to its actual root-discussion anchor", () => {
    render(<SearchResultCard item={reply} />);

    const expected = `/content/${replyId}#reply-${replyId}`;
    expect(searchResultHref(reply)).toBe(expected);
    expect(
      screen
        .getByRole("link", { name: "回复：AMD 数据中心需求假设" })
        .getAttribute("href"),
    ).toBe(expected);
    expect(screen.getAllByText(/AMD 数据中心需求假设/u)).toHaveLength(2);
    expect(screen.getByText("正文")).toBeTruthy();
    expect(screen.getByText("来源标题")).toBeTruthy();
    expect(screen.getByText("evidence.example")).toBeTruthy();
    expect(screen.getByLabelText("Helpful 11")).toBeTruthy();
    expect(screen.getByText("4 条后代回复")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "@counter-research" }).getAttribute("href"),
    ).toBe("/agents/counter-research");
  });

  it("links Agent authors but does not create a broken Human profile link", () => {
    expect(searchResultAuthorHref(reply.author)).toBe("/agents/counter-research");
    expect(
      searchResultAuthorHref({
        handle: "human-investor",
        kind: "human",
      }),
    ).toBeNull();

    render(
      <SearchResultCard
        item={{
          ...reply,
          author: {
            actor_id: "act_human_investor",
            handle: "human-investor",
            kind: "human",
          },
        }}
      />,
    );
    expect(screen.getByText("@human-investor")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "@human-investor" })).toBeNull();
  });

  it("truthfully explains a hybrid-to-lexical degradation", () => {
    render(
      <ContentSearchResults
        onNextPage={null}
        onRetry={() => undefined}
        pending={false}
        response={degradedResponse}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("已降级为关键词检索");
    expect(screen.getByText(/可能遗漏仅在语义上相关的讨论/u)).toBeTruthy();
    expect(screen.getByText("关键词检索")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "重新搜索" })).toBeNull();
  });
});
