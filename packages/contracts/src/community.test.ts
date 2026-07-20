import { describe, expect, it } from "vitest";

import {
  CommunityNameSchema,
  CommunityDetailProjectionSchema,
  FindCommunitiesRequestSchema,
  FindCommunitiesResponseSchema,
  GetCommunityRequestSchema,
  OpaqueCursorSchema,
  OpaqueIdSchema,
  SymbolSchema,
  TopicSchema,
} from "./community.js";

const timestamp = "2026-07-20T12:00:00.000Z";

const viewerEligibility = {
  can_read: true,
  can_post: true,
  write_gate: "require_approval",
} as const;

const materializedCommunity = {
  id: "com_semiconductors",
  slug: "semiconductors",
  name: "Semiconductors",
  kind: "topic",
  canonical_target: {
    type: "topic",
    id: "top_semiconductors",
    slug: "semiconductors",
  },
  state: "active",
  materialization_state: "materialized",
  description_markdown: "Semiconductor company and supply-chain research.",
  version: 12,
  posting_policy: {
    allowed_content: ["investment-research", "source-analysis"],
    max_posts_per_hour: 6,
    requires_sources: false,
  },
  viewer_eligibility: viewerEligibility,
  created_at: timestamp,
  updated_at: timestamp,
} as const;

describe("community discovery contracts", () => {
  it("requires an explicit discovery intent and accepts catalog browsing via query star", () => {
    expect(FindCommunitiesRequestSchema.parse({ query: "*" })).toEqual({
      query: "*",
    });
    expect(
      FindCommunitiesRequestSchema.parse({
        proposed_title: "AMD data-center scenarios",
        proposed_summary: "Supply-chain and margin assumptions.",
        symbols: ["AMD"],
        topics: ["scenario-analysis"],
        states: ["active"],
        limit: 10,
      }),
    ).toEqual({
      proposed_title: "AMD data-center scenarios",
      proposed_summary: "Supply-chain and margin assumptions.",
      symbols: ["AMD"],
      topics: ["scenario-analysis"],
      states: ["active"],
      limit: 10,
    });

    expect(FindCommunitiesRequestSchema.safeParse({}).success).toBe(false);
    expect(FindCommunitiesRequestSchema.safeParse({ query: "   " }).success).toBe(false);
    expect(
      FindCommunitiesRequestSchema.safeParse({
        query: "*",
        limit: 101,
      }).success,
    ).toBe(false);
    expect(
      FindCommunitiesRequestSchema.safeParse({
        query: "*",
        choose_best_community: true,
      }).success,
    ).toBe(false);
  });

  it("bounds discovery text and requires unique canonical filters", () => {
    for (const request of [
      { query: "q".repeat(2_001) },
      { proposed_title: "t".repeat(201) },
      { proposed_summary: "s".repeat(4_001) },
      { symbols: ["AMD", "AMD"] },
      { topics: ["margins", "margins"] },
      { states: ["active", "active"] },
      { symbols: Array.from({ length: 11 }, (_, index) => `S${index}`) },
      {
        topics: ["one", "two", "three", "four", "five", "six"],
      },
    ]) {
      expect(FindCommunitiesRequestSchema.safeParse(request).success).toBe(false);
    }

    expect(
      FindCommunitiesRequestSchema.safeParse({
        symbols: ["AMD"],
        proposed_title: "   ",
      }).success,
    ).toBe(false);
  });

  it("returns a strict, ordered community projection", () => {
    const response = {
      items: [
        {
          id: materializedCommunity.id,
          slug: materializedCommunity.slug,
          name: materializedCommunity.name,
          kind: materializedCommunity.kind,
          canonical_target: materializedCommunity.canonical_target,
          state: materializedCommunity.state,
          materialization_state: materializedCommunity.materialization_state,
          matched_fields: ["description", "topics"],
          match_reasons: ["The proposed research matches this topic."],
          posting_policy_summary: {
            max_posts_per_hour: 6,
            requires_sources: false,
          },
          viewer_eligibility: viewerEligibility,
        },
      ],
      page: {
        next_cursor: null,
        has_more: false,
        limit: 10,
      },
      ordering: {
        snapshot_id: "cms_01",
        ordering_version: "community-relevance-v1",
        as_of: timestamp,
      },
      request_id: "req-community-find",
      schema_version: "1",
    } as const;

    expect(FindCommunitiesResponseSchema.parse(response)).toEqual(response);
    expect(
      FindCommunitiesResponseSchema.safeParse({
        ...response,
        page: {
          next_cursor: null,
          has_more: true,
          limit: 10,
        },
      }).success,
    ).toBe(false);
    expect(
      FindCommunitiesResponseSchema.safeParse({
        ...response,
        selected_community_id: materializedCommunity.id,
      }).success,
    ).toBe(false);
  });
});

describe("community detail contracts", () => {
  it("requires exactly one stable lookup key", () => {
    expect(
      GetCommunityRequestSchema.parse({
        community_id: "com_semiconductors",
      }),
    ).toEqual({ community_id: "com_semiconductors" });
    expect(
      GetCommunityRequestSchema.parse({
        slug: "semiconductors",
      }),
    ).toEqual({ slug: "semiconductors" });

    expect(GetCommunityRequestSchema.safeParse({}).success).toBe(false);
    expect(
      GetCommunityRequestSchema.safeParse({
        community_id: "com_semiconductors",
        slug: "semiconductors",
      }).success,
    ).toBe(false);
  });

  it("aligns opaque transport bounds and canonical reference-data formats", () => {
    expect(OpaqueIdSchema.safeParse("i".repeat(200)).success).toBe(true);
    expect(OpaqueIdSchema.safeParse("i".repeat(201)).success).toBe(false);
    expect(OpaqueIdSchema.safeParse("id\u0000suffix").success).toBe(false);
    expect(OpaqueIdSchema.safeParse("id with spaces").success).toBe(false);
    expect(OpaqueCursorSchema.safeParse("c".repeat(4_096)).success).toBe(true);
    expect(OpaqueCursorSchema.safeParse("c".repeat(4_097)).success).toBe(false);
    expect(OpaqueCursorSchema.safeParse("cursor with spaces").success).toBe(false);

    expect(SymbolSchema.safeParse("BRK.B").success).toBe(true);
    expect(SymbolSchema.safeParse("ABCDEFGHIJKLMNO").success).toBe(true);
    expect(SymbolSchema.safeParse("ABCDEFGHIJKLMNOP").success).toBe(false);
    expect(SymbolSchema.safeParse("amd").success).toBe(false);
    expect(SymbolSchema.safeParse("AMD/USD").success).toBe(false);

    expect(TopicSchema.safeParse("a".repeat(63)).success).toBe(true);
    expect(TopicSchema.safeParse("a".repeat(64)).success).toBe(false);
    expect(TopicSchema.safeParse("Data-Center").success).toBe(false);
    expect(CommunityNameSchema.safeParse("n".repeat(120)).success).toBe(true);
    expect(CommunityNameSchema.safeParse("n".repeat(121)).success).toBe(false);
  });

  it("enforces canonical target and materialization invariants", () => {
    expect(CommunityDetailProjectionSchema.parse(materializedCommunity)).toEqual(
      materializedCommunity,
    );

    const catalogOnly = {
      ...materializedCommunity,
      id: "com_stock_MU",
      slug: "mu",
      name: "MU",
      kind: "symbol",
      canonical_target: {
        type: "symbol",
        id: "sym_MU",
        symbol: "MU",
      },
      materialization_state: "catalog_only",
      version: 0,
      created_at: null,
      updated_at: null,
    } as const;
    expect(CommunityDetailProjectionSchema.parse(catalogOnly)).toEqual(catalogOnly);

    expect(
      CommunityDetailProjectionSchema.safeParse({
        ...catalogOnly,
        kind: "general",
      }).success,
    ).toBe(false);
    expect(
      CommunityDetailProjectionSchema.safeParse({
        ...catalogOnly,
        version: 1,
      }).success,
    ).toBe(false);
    expect(
      CommunityDetailProjectionSchema.safeParse({
        ...materializedCommunity,
        canonical_target: {
          type: "symbol",
          id: "sym_AMD",
          symbol: "AMD",
        },
      }).success,
    ).toBe(false);
  });
});
