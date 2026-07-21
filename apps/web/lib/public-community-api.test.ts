/// <reference lib="dom" />

import type { FindCommunitiesResponse, GetCommunityResponse } from "@alphanet/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nextHeaders = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("next/headers", () => ({ headers: nextHeaders.read }));

import {
  communityHref,
  getPublicCommunities,
  getPublicCommunityBySlug,
  getPublicStockCommunity,
} from "./public-community-api";

const communityId = "00000000-0000-4000-8000-000000002001";
const symbolId = "00000000-0000-4000-8000-000000001001";

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

function requestBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") throw new Error("Expected a JSON request body.");
  return body;
}

const directoryResponse: FindCommunitiesResponse = {
  items: [
    {
      id: communityId,
      slug: "stock-amd-00000000000040008000000000002001",
      name: "AMD Research",
      kind: "symbol",
      canonical_target: { type: "symbol", id: symbolId, symbol: "AMD" },
      state: "active",
      materialization_state: "catalog_only",
      matched_fields: ["symbols"],
      match_reasons: ["symbol_filter_match"],
      posting_policy_summary: {
        max_posts_per_hour: 6,
        requires_sources: false,
      },
      viewer_eligibility: {
        can_read: true,
        can_post: false,
        write_gate: "deny",
      },
    },
  ],
  page: { next_cursor: null, has_more: false, limit: 20 },
  ordering: {
    snapshot_id: "cms_00000000000000000000000000000000",
    ordering_version: "community-relevance-v1",
    as_of: "2026-07-20T20:00:00.000Z",
  },
  request_id: "req_public_communities",
  schema_version: "1",
};

const detailResponse: GetCommunityResponse = {
  community: {
    id: communityId,
    slug: "stock-amd-00000000000040008000000000002001",
    name: "AMD Research",
    kind: "symbol",
    canonical_target: { type: "symbol", id: symbolId, symbol: "AMD" },
    state: "active",
    materialization_state: "catalog_only",
    description_markdown: "Research and discussion about AMD.",
    version: 0,
    posting_policy: {
      allowed_content: ["investment-research"],
      max_posts_per_hour: 6,
      requires_sources: false,
    },
    viewer_eligibility: {
      can_read: true,
      can_post: false,
      write_gate: "deny",
    },
    created_at: null,
    updated_at: null,
  },
  request_id: "req_public_community",
  schema_version: "1",
};

beforeEach(() => {
  nextHeaders.read.mockResolvedValue(new Headers());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("public Community Web API", () => {
  it("uses the anonymous list route without leaking credentials", async () => {
    nextHeaders.read.mockResolvedValue(
      new Headers({ "x-forwarded-for": "198.51.100.25" }),
    );
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(directoryResponse)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getPublicCommunities({ cursor: "directory-cursor", limit: 20 });

    expect(result).toEqual({ kind: "success", data: directoryResponse });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(requestUrl(url)).toContain(
      "/v1/public/communities?states=active%2Cread_only&limit=20&cursor=directory-cursor",
    );
    const requestHeaders = new Headers(init?.headers);
    expect(requestHeaders.has("authorization")).toBe(false);
    expect(requestHeaders.get("x-alphanet-ssr-forwarded-for")).toBe("198.51.100.25");
    expect(requestHeaders.has("x-alphanet-ssr-signature")).toBe(true);
    expect(init?.cache).toBe("no-store");
  });

  it("keeps natural-language discovery in a POST body", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(directoryResponse)),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getPublicCommunities({ cursor: "search-cursor", query: "AMD margins" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(requestUrl(url).endsWith("/v1/public/communities/search")).toBe(true);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(requestBody(init?.body))).toEqual({
      cursor: "search-cursor",
      query: "AMD margins",
    });
  });

  it("resolves an exact stock target before loading its detail", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(directoryResponse))
      .mockResolvedValueOnce(Response.json(detailResponse));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getPublicStockCommunity("AMD");

    expect(result).toEqual({ kind: "success", data: detailResponse.community });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(requestBody(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      limit: 100,
      symbols: ["AMD"],
    });
    expect(
      requestUrl(fetchMock.mock.calls[1]![0]).endsWith(
        `/v1/public/communities/${communityId}`,
      ),
    ).toBe(true);
  });

  it("does not silently choose between Communities with the same ticker", async () => {
    const secondCommunity = {
      ...directoryResponse.items[0]!,
      canonical_target: {
        id: "00000000-0000-4000-8000-000000001002",
        symbol: "AMD" as const,
        type: "symbol" as const,
      },
      id: "00000000-0000-4000-8000-000000002002",
      name: "AMD Research · alternate market",
      slug: "stock-amd-00000000000040008000000000002002",
    };
    const response: FindCommunitiesResponse = {
      ...directoryResponse,
      items: [directoryResponse.items[0]!, secondCommunity],
    };
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(response)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getPublicStockCommunity("amd");

    expect(result).toEqual({
      candidates: response.items,
      incomplete: false,
      kind: "ambiguous",
      symbol: "AMD",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not choose a ticker when the candidate page is incomplete", async () => {
    const response: FindCommunitiesResponse = {
      ...directoryResponse,
      page: { has_more: true, limit: 100, next_cursor: "more-stock-candidates" },
    };
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(response)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getPublicStockCommunity("AMD");

    expect(result).toEqual({
      candidates: response.items,
      incomplete: true,
      kind: "ambiguous",
      symbol: "AMD",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns not found only after a complete page has no exact ticker", async () => {
    const response: FindCommunitiesResponse = {
      ...directoryResponse,
      items: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.resolve(Response.json(response))),
    );

    await expect(getPublicStockCommunity("AMD")).resolves.toEqual({
      kind: "not_found",
    });
  });

  it("fails closed if the detail no longer matches the selected ticker identity", async () => {
    const mismatchedDetail: GetCommunityResponse = {
      ...detailResponse,
      community: {
        ...detailResponse.community,
        canonical_target: {
          id: "00000000-0000-4000-8000-000000001099",
          symbol: "AMD",
          type: "symbol",
        },
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(directoryResponse))
      .mockResolvedValueOnce(Response.json(mismatchedDetail));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPublicStockCommunity("AMD")).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("loads a general Community through its exact slug route", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(detailResponse)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getPublicCommunityBySlug("general");

    expect(result).toEqual({ kind: "success", data: detailResponse.community });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain(
      "/v1/public/communities/by-slug/general",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
  });

  it("fails closed when an API response violates the shared contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ items: [] }))),
    );

    await expect(getPublicCommunities()).resolves.toEqual({ kind: "unavailable" });
  });

  it("maps canonical Community targets to stable public routes", () => {
    expect(communityHref(directoryResponse.items[0]!)).toBe("/stocks/AMD");
    expect(
      communityHref({
        canonical_target: {
          id: "00000000-0000-4000-8000-000000003001",
          slug: "semiconductors",
          type: "topic",
        },
        slug: "semiconductors",
      }),
    ).toBe("/topics/semiconductors");
    expect(communityHref({ canonical_target: null, slug: "general" })).toBe(
      "/communities/general",
    );
  });
});
