/// <reference lib="dom" />

import type { SearchContentRequest, SearchContentResponse } from "@alphanet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { searchPublicContentFromBrowser } from "./browser-content-search";

const response: SearchContentResponse = {
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

const request: SearchContentRequest = {
  content_types: ["post", "reply"],
  limit: 20,
  query: "Which replies challenge the AMD demand thesis?",
  scope: "global",
  search_mode: "hybrid",
  sort: "relevance",
  symbols: ["AMD"],
};

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser public Content Search transport", () => {
  it("puts the strict request in a no-store POST body, never in the URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:4000/");
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(response)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchPublicContentFromBrowser(request)).resolves.toEqual({
      kind: "success",
      data: response,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(requestUrl(url)).toBe("http://localhost:4000/v1/public/content/search");
    expect(requestUrl(url)).not.toContain(encodeURIComponent(request.query));
    expect(requestUrl(url)).not.toContain(request.query);
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    const requestBody = init?.body;
    expect(typeof requestBody).toBe("string");
    if (typeof requestBody !== "string") throw new Error("Expected a JSON body");
    expect(JSON.parse(requestBody)).toEqual(request);
  });

  it("uses the same-origin public API path when the browser base URL is empty", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(response)));
    vi.stubGlobal("fetch", fetchMock);

    await searchPublicContentFromBrowser(request);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/v1/public/content/search");
  });

  it("fails closed before fetch for an invalid request and for an invalid response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      searchPublicContentFromBrowser({ ...request, query: "" }),
    ).resolves.toEqual({ kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(searchPublicContentFromBrowser(request)).resolves.toEqual({
      kind: "unavailable",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("parses V1 errors and honors the longest 429 Retry-After signal", async () => {
    const rateLimitError = {
      error: {
        code: "RATE_LIMITED",
        details: { retry_at: "2026-07-20T20:02:00.000Z" },
        message: "Too many public Content Search requests were made.",
        retry_after_ms: 60_000,
        retryable: true,
      },
      request_id: "req_rate_limited",
      schema_version: "1",
    } as const;
    const unavailableError = {
      error: {
        code: "INDEX_UNAVAILABLE",
        details: null,
        message: "Content Search is temporarily unavailable.",
        retry_after_ms: null,
        retryable: true,
      },
      request_id: "req_unavailable",
      schema_version: "1",
    } as const;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(rateLimitError, {
          headers: { "retry-after": "120" },
          status: 429,
        }),
      )
      .mockResolvedValueOnce(Response.json(unavailableError, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchPublicContentFromBrowser(request)).resolves.toEqual({
      kind: "rate_limited",
      requestId: "req_rate_limited",
      retryAfterMs: 120_000,
    });
    await expect(searchPublicContentFromBrowser(request)).resolves.toEqual({
      error: unavailableError.error,
      kind: "unavailable",
      requestId: "req_unavailable",
    });
  });

  it("fails closed after the bounded browser deadline instead of loading forever", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = searchPublicContentFromBrowser(request);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toEqual({ kind: "unavailable" });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    vi.useRealTimers();
  });
});
