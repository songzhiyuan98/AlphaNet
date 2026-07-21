import { describe, expect, it } from "vitest";

import {
  contentSearchScopeHref,
  parseContentSearch,
  safeContentSearchPrefill,
} from "./content-search-query";

describe("Content search in-memory request state", () => {
  it("builds a global natural-language search with practical filters", () => {
    const parsed = parseContentSearch({
      after: "2026-07-01",
      before: "2026-07-20",
      mode: "hybrid",
      q: " 哪些回复质疑 AMD 数据中心需求？ ",
      scope: "global",
      sort: "relevance",
      symbols: "amd, MU, AMD",
      topics: "Semiconductors, supply-chain",
      type: "reply",
    });

    expect(parsed.error).toBeNull();
    expect(parsed.request).toEqual({
      content_types: ["reply"],
      created_after: "2026-07-01T00:00:00.000Z",
      created_before: "2026-07-21T00:00:00.000Z",
      limit: 20,
      query: "哪些回复质疑 AMD 数据中心需求?",
      scope: "global",
      search_mode: "hybrid",
      sort: "relevance",
      symbols: ["AMD", "MU"],
      topics: ["semiconductors", "supply-chain"],
    });
    expect(parsed.state).toMatchObject({
      query: "哪些回复质疑 AMD 数据中心需求?",
      symbols: "AMD, MU",
      topics: "semiconductors, supply-chain",
      contentType: "reply",
    });
  });

  it("uses the first canonical target and never imports a cursor from page parameters", () => {
    const parsed = parseContentSearch({
      cursor: "signed-search-cursor",
      mode: "lexical",
      q: "margin assumptions",
      scope: "symbol",
      sort: "latest",
      symbols: "amd",
      type: "post",
    });

    expect(parsed.request).toMatchObject({
      content_types: ["post"],
      query: "margin assumptions",
      scope: "symbol",
      search_mode: "lexical",
      sort: "latest",
      symbol: "AMD",
    });
    expect(parsed.request).not.toHaveProperty("cursor");
  });

  it("does not call search for blank, invalid scoped, or inverted-date input", () => {
    expect(parseContentSearch({ q: "   " }).error).toMatch(/请输入/u);
    expect(parseContentSearch({ q: "risk", scope: "topic", topics: "" }).error).toMatch(
      /主题/u,
    );
    expect(
      parseContentSearch({
        after: "2026-07-22",
        before: "2026-07-20",
        q: "risk",
      }).error,
    ).toMatch(/开始日期/u);
    expect(
      parseContentSearch({ q: "risk", scope: "community", community_id: "" }).error,
    ).toMatch(/社区 ID/u);
    expect(
      parseContentSearch({ q: "risk", scope: "author", author_actor_id: "bad id" }).error,
    ).toMatch(/Actor ID/u);
  });

  it("builds community and author scoped searches with optional filters", () => {
    expect(
      parseContentSearch({
        community_id: "community_public_1",
        q: "who challenged this thesis?",
        scope: "community",
        symbols: "AMD",
      }).request,
    ).toMatchObject({
      community_id: "community_public_1",
      query: "who challenged this thesis?",
      scope: "community",
      symbols: ["AMD"],
    });
    expect(
      parseContentSearch({
        author_actor_id: "550e8400-e29b-41d4-a716-446655440000",
        q: "updates and corrections",
        scope: "author",
        topics: "semiconductors",
      }).request,
    ).toMatchObject({
      author_actor_id: "550e8400-e29b-41d4-a716-446655440000",
      query: "updates and corrections",
      scope: "author",
      topics: ["semiconductors"],
    });
  });

  it("normalizes NFKC and whitespace before enforcing the query maximum", () => {
    expect(
      parseContentSearch({ q: `  AMD${" \n\t".repeat(4_001)}ﬁ risk  ` }).request?.query,
    ).toBe("AMD fi risk");
    expect(parseContentSearch({ q: "ﬁ".repeat(2_001) }).error).toMatch(/4,000/u);
    expect(parseContentSearch({ q: "ﬁ".repeat(2_000) }).request?.query).toBe(
      "fi".repeat(2_000),
    );
  });

  it("allows only public scope IDs into page prefill and never imports query state", () => {
    expect(
      safeContentSearchPrefill({
        community_id: "community/alpha?public=true",
        cursor: "opaque-secret-cursor",
        q: "private research question",
        scope: "community",
        symbols: "AMD",
      }),
    ).toEqual({
      community_id: "community/alpha?public=true",
      scope: "community",
    });
    expect(
      safeContentSearchPrefill({
        author_actor_id: "bad actor id",
        q: "private research question",
        scope: "author",
      }),
    ).toEqual({});

    const href = contentSearchScopeHref({
      communityId: "community/alpha?public=true",
      scope: "community",
    });
    expect(href).toBe(
      "/search?scope=community&community_id=community%2Falpha%3Fpublic%3Dtrue",
    );
    expect(href).not.toContain("q=");
    expect(href).not.toContain("cursor=");
  });

  it("keeps the initial page idle until a q parameter is submitted", () => {
    const parsed = parseContentSearch({ scope: "global" });
    expect(parsed.submitted).toBe(false);
    expect(parsed.request).toBeNull();
    expect(parsed.error).toBeNull();
  });
});
