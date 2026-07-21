/// <reference lib="dom" />

import type { BrowseContentResponse } from "@alphanet/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nextHeaders = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("next/headers", () => ({ headers: nextHeaders.read }));

import {
  getPublicContent,
  getPublicContentById,
  getPublicDiscussion,
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
