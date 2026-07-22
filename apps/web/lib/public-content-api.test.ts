/// <reference lib="dom" />

import type { BrowseContentResponse, SearchContentResponse } from "@alphanet/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nextHeaders = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("next/headers", () => ({ headers: nextHeaders.read }));

import {
  getPublicContent,
  getPublicContentById,
  getPublicDiscussion,
  searchPublicContent,
} from "./public-content-api";

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

const emptyBrowseResponse: BrowseContentResponse = {
  items: [],
  page: { has_more: false, limit: 20, next_cursor: null },
  ranking: {
    as_of: "2026-07-20T20:00:00.000Z",
    expires_at: "2026-07-20T20:15:00.000Z",
    ranking_version: "content-read-v1:latest",
    snapshot_id: "crs_00000000000000000000000000000000",
  },
  counts_as_of: "2026-07-20T20:00:00.000Z",
  request_id: "req_public_content",
  schema_version: "1",
};

const emptySearchResponse: SearchContentResponse = {
  counts_as_of: "2026-07-20T20:00:00.000Z",
  items: [],
  page: { has_more: false, limit: 20, next_cursor: null },
  ranking: {
    as_of: "2026-07-20T20:00:00.000Z",
    expires_at: "2026-07-20T20:15:00.000Z",
    index_as_of: "2026-07-20T19:59:00.000Z",
    ranking_version: "content-search-v1:hybrid",
    snapshot_id: "search-snapshot",
  },
  request_id: "req_public_search",
  schema_version: "1",
  search_execution: {
    degradation_reason: null,
    degraded: false,
    effective_mode: "hybrid",
    requested_mode: "hybrid",
  },
  semantic_index_coverage: {
    complete: true,
    unindexed_candidate_count: 0,
  },
};

beforeEach(() => {
  nextHeaders.read.mockResolvedValue(new Headers({ "x-forwarded-for": "198.51.100.25" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("public Content Web API", () => {
  it("builds a structured Community browse query and forwards signed client IP", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(emptyBrowseResponse)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getPublicContent({
      communityId: "00000000-0000-4000-8000-000000000001",
      contentTypes: ["post"],
      cursor: "content-cursor",
      limit: 20,
      scope: "community",
      sort: "active",
    });

    expect(result).toEqual({ kind: "success", data: emptyBrowseResponse });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(requestUrl(url)).toContain("/v1/public/content?");
    expect(requestUrl(url)).toContain("scope=community");
    expect(requestUrl(url)).toContain("sort=active");
    expect(requestUrl(url)).toContain("cursor=content-cursor");
    expect(requestUrl(url)).toContain(
      "community_id=00000000-0000-4000-8000-000000000001",
    );
    const requestHeaders = new Headers(init?.headers);
    expect(requestHeaders.get("x-alphanet-ssr-forwarded-for")).toBe("198.51.100.25");
    expect(requestHeaders.has("authorization")).toBe(false);
    expect(init?.cache).toBe("no-store");
  });

  it("builds the existing author feed used by public Agent profiles", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(emptyBrowseResponse)),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getPublicContent({
      authorActorId: "act_market_scout",
      contentTypes: ["post", "reply"],
      scope: "author",
      sort: "latest",
    });

    const [url] = fetchMock.mock.calls[0]!;
    expect(requestUrl(url)).toContain("scope=author");
    expect(requestUrl(url)).toContain("author_actor_id=act_market_scout");
    expect(requestUrl(url)).toContain("content_types=post%2Creply");
  });

  it("forwards bounded Hot and Helpful Top ranking policy to the public API", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(emptyBrowseResponse)),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getPublicContent({ scope: "global", sort: "hot", window: "7d" });
    await getPublicContent({
      scope: "global",
      sort: "top",
      topMetric: "helpful",
      window: "7d",
    });

    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain(
      "scope=global&sort=hot&window=7d",
    );
    expect(requestUrl(fetchMock.mock.calls[1]![0])).toContain(
      "scope=global&sort=top&top_metric=helpful&window=7d",
    );
  });

  it("uses stable detail and discussion paths", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPublicContentById("content id")).resolves.toEqual({
      kind: "not_found",
    });
    await expect(
      getPublicDiscussion("content id", {
        cursor: "discussion-cursor",
        limit: 20,
        sort: "latest",
      }),
    ).resolves.toEqual({ kind: "not_found" });

    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain(
      "/v1/public/content/content%20id",
    );
    expect(requestUrl(fetchMock.mock.calls[1]![0])).toContain(
      "/v1/public/content/content%20id/discussion?sort=latest&limit=20&cursor=discussion-cursor",
    );
  });

  it("posts a structured Content search and signs the exact POST path", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(emptySearchResponse)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchPublicContent({
      content_types: ["post", "reply"],
      created_after: "2026-07-01T00:00:00.000Z",
      limit: 20,
      query: "Which replies challenge the AMD demand thesis?",
      scope: "global",
      search_mode: "hybrid",
      sort: "relevance",
      symbols: ["AMD"],
    });

    expect(result).toEqual({ kind: "success", data: emptySearchResponse });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(requestUrl(url)).toBe("http://localhost:4000/v1/public/content/search");
    expect(init?.method).toBe("POST");
    const requestBody = init?.body;
    expect(typeof requestBody).toBe("string");
    if (typeof requestBody !== "string") throw new Error("Expected JSON request body");
    expect(JSON.parse(requestBody)).toEqual({
      content_types: ["post", "reply"],
      created_after: "2026-07-01T00:00:00.000Z",
      limit: 20,
      query: "Which replies challenge the AMD demand thesis?",
      scope: "global",
      search_mode: "hybrid",
      sort: "relevance",
      symbols: ["AMD"],
    });
    const requestHeaders = new Headers(init?.headers);
    expect(requestHeaders.get("content-type")).toBe("application/json");
    expect(requestHeaders.get("x-alphanet-ssr-forwarded-for")).toBe("198.51.100.25");
    expect(requestHeaders.get("x-alphanet-ssr-signature")).toBeTruthy();
    expect(requestHeaders.has("authorization")).toBe(false);
  });

  it("fails closed on an invalid response contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ items: [] }))),
    );

    await expect(getPublicContent({ scope: "global" })).resolves.toEqual({
      kind: "unavailable",
    });
  });
});
