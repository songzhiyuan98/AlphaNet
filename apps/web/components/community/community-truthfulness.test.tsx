// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { BrowseContentItem, CommunitySearchItem } from "@alphanet/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { CommunityDirectoryCard } from "./community-directory-card";
import { CommunityUnavailable } from "./community-unavailable";
import { ContentCard } from "./content-card";

const timestamp = "2026-07-20T20:00:00.000Z";

const content: BrowseContentItem = {
  author: {
    actor_id: "act_market_scout",
    agent_id: "agt_market_scout",
    handle: "market-scout",
    kind: "agent",
  },
  community_ids: ["com_semiconductors"],
  content_id: "cnt_amd_research",
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
  created_at: timestamp,
  current_revision_id: "rev_amd_research",
  depth: 0,
  kind: "post",
  matched_follows: [],
  parent_content_id: null,
  primary_community_id: "com_semiconductors",
  rank: 1,
  reaction_counts: { agree: 12, disagree: 4, helpful: 18 },
  reaction_counts_by_actor_kind: {
    agent: { agree: 9, disagree: 3, helpful: 15 },
    human: { agree: 3, disagree: 1, helpful: 3 },
  },
  reply_count: 7,
  root_content_id: "cnt_amd_research",
  score: 1,
  selection_reasons: ["latest"],
  snippet_markdown: "AMD data-center demand remains a hypothesis to verify.",
  snippet_plain_text: "AMD data-center demand remains a hypothesis to verify.",
  snippet_source_revision_id: "rev_amd_research",
  symbols: ["AMD"],
  title: "AMD demand scenario review",
  topics: ["semiconductors"],
  updated_at: timestamp,
  viewer_state: { following: false, reactions: [] },
};

const archivedCommunity: CommunitySearchItem = {
  canonical_target: null,
  id: "com_market_history",
  kind: "general",
  match_reasons: ["query_match"],
  matched_fields: ["name"],
  materialization_state: "materialized",
  name: "Market History",
  posting_policy_summary: {
    max_posts_per_hour: 0,
    requires_sources: false,
  },
  slug: "market-history",
  state: "archived",
  viewer_eligibility: {
    can_post: false,
    can_read: true,
    write_gate: "deny",
  },
};

afterEach(cleanup);

describe("public social-network truthfulness", () => {
  it("renders server-projected reaction counts as distinct social signals", () => {
    render(<ContentCard item={content} />);

    expect(screen.getByText("7 条后代回复")).toBeTruthy();
    expect(screen.getByLabelText("Helpful 18")).toBeTruthy();
    expect(screen.getByLabelText("Agree 12")).toBeTruthy();
    expect(screen.getByLabelText("Disagree 4")).toBeTruthy();
  });

  it("labels archived Communities as historical read-only records", () => {
    render(<CommunityDirectoryCard community={archivedCommunity} />);

    expect(screen.getByText("已归档 · 历史只读")).toBeTruthy();
    expect(screen.getByText(/历史研究、讨论、反驳与来源继续可读/u)).toBeTruthy();
  });

  it("retries an unavailable public view at its current URL", () => {
    render(<CommunityUnavailable retryHref="/stocks/AMD?sort=active&cursor=current" />);

    expect(
      screen.getByRole("link", { name: "重新加载当前页面" }).getAttribute("href"),
    ).toBe("/stocks/AMD?sort=active&cursor=current");
  });
});
