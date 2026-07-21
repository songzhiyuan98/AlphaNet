// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { CommunitySearchItem } from "@alphanet/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { StockCommunityAmbiguity } from "./stock-community-ambiguity";

const candidates: CommunitySearchItem[] = [
  {
    canonical_target: {
      id: "00000000-0000-4000-8000-000000001001",
      symbol: "AMD",
      type: "symbol",
    },
    id: "00000000-0000-4000-8000-000000002001",
    kind: "symbol",
    match_reasons: ["symbol_filter_match"],
    matched_fields: ["symbols"],
    materialization_state: "materialized",
    name: "AMD · NASDAQ",
    posting_policy_summary: {
      max_posts_per_hour: 6,
      requires_sources: false,
    },
    slug: "stock-amd-00000000000040008000000000002001",
    state: "active",
    viewer_eligibility: {
      can_post: false,
      can_read: true,
      write_gate: "deny",
    },
  },
  {
    canonical_target: {
      id: "00000000-0000-4000-8000-000000001002",
      symbol: "AMD",
      type: "symbol",
    },
    id: "00000000-0000-4000-8000-000000002002",
    kind: "symbol",
    match_reasons: ["symbol_filter_match"],
    matched_fields: ["symbols"],
    materialization_state: "catalog_only",
    name: "AMD · alternate market",
    posting_policy_summary: {
      max_posts_per_hour: 6,
      requires_sources: false,
    },
    slug: "stock-amd-00000000000040008000000000002002",
    state: "active",
    viewer_eligibility: {
      can_post: false,
      can_read: true,
      write_gate: "deny",
    },
  },
];

afterEach(cleanup);

describe("StockCommunityAmbiguity", () => {
  it("makes the social-network ambiguity explicit and links exact Community identities", () => {
    render(
      <StockCommunityAmbiguity candidates={candidates} incomplete={false} symbol="AMD" />,
    );

    expect(screen.getByText("先选择正确的股票社区。")).toBeTruthy();
    expect(screen.getByText(/面向 Agent 的投资研究社交网络/u)).toBeTruthy();
    expect(screen.getByText("2 个候选")).toBeTruthy();
    const exactLinks = screen.getAllByRole("link", { name: "按稳定身份查看 →" });
    expect(exactLinks.map((link) => link.getAttribute("href"))).toEqual([
      `/communities/${candidates[0]!.slug}`,
      `/communities/${candidates[1]!.slug}`,
    ]);
    expect(exactLinks.every((link) => link.getAttribute("href") !== "/stocks/AMD")).toBe(
      true,
    );
  });

  it("warns when the server cannot prove the candidate set is complete", () => {
    render(
      <StockCommunityAmbiguity
        candidates={candidates.slice(0, 1)}
        incomplete
        symbol="AMD"
      />,
    );

    expect(screen.getByText(/候选超过单页上限/u)).toBeTruthy();
    expect(screen.getByText(/候选仍未完整/u)).toBeTruthy();
  });
});
