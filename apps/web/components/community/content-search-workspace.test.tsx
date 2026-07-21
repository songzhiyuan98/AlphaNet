// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SearchContentResponse } from "@alphanet/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchTransport = vi.hoisted(() => vi.fn());

vi.mock("../../lib/browser-content-search", () => ({
  searchPublicContentFromBrowser: searchTransport,
}));

import { ContentSearchWorkspace } from "./content-search-workspace";

const timestamp = "2026-07-20T20:00:00.000Z";

function searchResponse(nextCursor: string | null): SearchContentResponse {
  return {
    counts_as_of: timestamp,
    items: [],
    page: { has_more: nextCursor !== null, limit: 20, next_cursor: nextCursor },
    ranking: {
      as_of: timestamp,
      expires_at: "2026-07-20T20:15:00.000Z",
      index_as_of: timestamp,
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
}

beforeEach(() => {
  window.history.replaceState({}, "", "/search");
  searchTransport.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("private browser Search workflow", () => {
  it("keeps the query out of URL/history/storage and reuses its frozen request for cursor pagination", async () => {
    const firstQuery = "confidential AMD counter-thesis research";
    const editedDraft = "a different draft must not rebind the cursor";
    searchTransport
      .mockResolvedValueOnce({ kind: "success", data: searchResponse("opaque-page-2") })
      .mockResolvedValueOnce({ kind: "success", data: searchResponse(null) });
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const cookieBefore = document.cookie;
    const user = userEvent.setup();

    render(<ContentSearchWorkspace />);
    const queryInput = screen.getByLabelText("你希望从社区记忆中找到什么？");
    await user.type(queryInput, firstQuery);
    await user.type(screen.getByLabelText("股票代码"), "amd");
    await user.click(screen.getByRole("button", { name: "搜索研究与讨论" }));

    await waitFor(() => expect(searchTransport).toHaveBeenCalledTimes(1));
    expect(searchTransport.mock.calls[0]?.[0]).toEqual({
      limit: 20,
      query: firstQuery,
      scope: "global",
      search_mode: "hybrid",
      sort: "relevance",
      symbols: ["AMD"],
    });
    expect(window.location.pathname).toBe("/search");
    expect(window.location.search).toBe("");
    expect(JSON.stringify(window.history.state)).not.toContain(firstQuery);

    await user.clear(queryInput);
    await user.type(queryInput, editedDraft);
    await user.click(screen.getByRole("button", { name: "下一页搜索结果 →" }));

    await waitFor(() => expect(searchTransport).toHaveBeenCalledTimes(2));
    expect(searchTransport.mock.calls[1]?.[0]).toEqual({
      cursor: "opaque-page-2",
      limit: 20,
      query: firstQuery,
      scope: "global",
      search_mode: "hybrid",
      sort: "relevance",
      symbols: ["AMD"],
    });
    expect(window.location.pathname).toBe("/search");
    expect(window.location.search).toBe("");
    expect(JSON.stringify(window.history.state)).not.toContain(firstQuery);
    expect(JSON.stringify(window.history.state)).not.toContain("opaque-page-2");
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(document.cookie).toBe(cookieBefore);
  });

  it("runs examples and retries the same in-memory request through buttons", async () => {
    searchTransport
      .mockResolvedValueOnce({ kind: "unavailable" })
      .mockResolvedValueOnce({ kind: "success", data: searchResponse(null) });
    const user = userEvent.setup();

    render(<ContentSearchWorkspace />);
    await user.click(screen.getByRole("button", { name: "AMD 看空观点与反驳" }));

    await screen.findByRole("heading", {
      name: "Agent 投资研究社交网络搜索暂时不可用",
    });
    expect(searchTransport.mock.calls[0]?.[0]).toMatchObject({
      query: "AMD 看空观点及其反驳",
      symbols: ["AMD"],
    });
    expect(window.location.search).toBe("");
    expect(screen.queryByRole("link", { name: "重新搜索" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "重新搜索" }));
    await waitFor(() => expect(searchTransport).toHaveBeenCalledTimes(2));
    expect(searchTransport.mock.calls[1]?.[0]).toEqual(
      searchTransport.mock.calls[0]?.[0],
    );
    expect(window.location.search).toBe("");
  });

  it("restarts from the frozen first page when a continuation becomes unavailable", async () => {
    searchTransport
      .mockResolvedValueOnce({ kind: "success", data: searchResponse("expired-cursor") })
      .mockResolvedValueOnce({ kind: "unavailable" })
      .mockResolvedValueOnce({ kind: "success", data: searchResponse(null) });
    const user = userEvent.setup();

    render(<ContentSearchWorkspace />);
    await user.type(
      screen.getByLabelText("你希望从社区记忆中找到什么？"),
      "MU political risk counter-thesis",
    );
    await user.click(screen.getByRole("button", { name: "搜索研究与讨论" }));
    await screen.findByRole("button", { name: "下一页搜索结果 →" });
    await user.click(screen.getByRole("button", { name: "下一页搜索结果 →" }));
    await screen.findByRole("heading", {
      name: "Agent 投资研究社交网络搜索暂时不可用",
    });

    expect(searchTransport.mock.calls[1]?.[0]).toMatchObject({
      cursor: "expired-cursor",
      query: "MU political risk counter-thesis",
    });
    await user.click(screen.getByRole("button", { name: "重新搜索" }));
    await waitFor(() => expect(searchTransport).toHaveBeenCalledTimes(3));
    expect(searchTransport.mock.calls[2]?.[0]).toEqual(
      searchTransport.mock.calls[0]?.[0],
    );
    expect(searchTransport.mock.calls[2]?.[0]).not.toHaveProperty("cursor");
    expect(window.location.search).toBe("");
  });

  it("prefills a public scope without a query and sends the required target", async () => {
    searchTransport.mockResolvedValueOnce({
      kind: "success",
      data: searchResponse(null),
    });
    const user = userEvent.setup();

    render(
      <ContentSearchWorkspace
        initialParameters={{
          author_actor_id: "550e8400-e29b-41d4-a716-446655440000",
          scope: "author",
        }}
      />,
    );

    expect(screen.getByLabelText<HTMLSelectElement>("搜索范围").value).toBe("author");
    expect(screen.getByLabelText<HTMLInputElement>("Agent Actor ID").value).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(searchTransport).not.toHaveBeenCalled();
    await user.type(
      screen.getByLabelText("你希望从社区记忆中找到什么？"),
      "what did this Agent later correct?",
    );
    await user.click(screen.getByRole("button", { name: "搜索研究与讨论" }));

    await waitFor(() => expect(searchTransport).toHaveBeenCalledOnce());
    expect(searchTransport.mock.calls[0]?.[0]).toMatchObject({
      author_actor_id: "550e8400-e29b-41d4-a716-446655440000",
      query: "what did this Agent later correct?",
      scope: "author",
    });
    expect(window.location.search).toBe("");
  });

  it("shows 429 feedback and keeps retry disabled until Retry-After elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T20:00:00.000Z"));
    searchTransport
      .mockResolvedValueOnce({
        kind: "rate_limited",
        requestId: "req_rate_limited",
        retryAfterMs: 2_000,
      })
      .mockResolvedValueOnce({ kind: "success", data: searchResponse(null) });
    render(<ContentSearchWorkspace />);
    fireEvent.change(screen.getByLabelText("你希望从社区记忆中找到什么？"), {
      target: { value: "AMD rate limited query" },
    });
    fireEvent.click(screen.getByRole("button", { name: "搜索研究与讨论" }));
    await act(async () => Promise.resolve());

    expect(screen.getByRole("heading", { name: "搜索请求过于频繁" })).toBeTruthy();
    expect(screen.getByText(/约 2 秒后重试/u)).toBeTruthy();
    expect(screen.getByText(/req_rate_limited/u)).toBeTruthy();
    const retry = screen.getByRole<HTMLButtonElement>("button", {
      name: "重新搜索",
    });
    expect(retry.disabled).toBe(true);
    fireEvent.click(retry);
    expect(searchTransport).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    await act(async () => Promise.resolve());
    expect(searchTransport).toHaveBeenCalledTimes(2);
    expect(searchTransport.mock.calls[1]?.[0]).toEqual(
      searchTransport.mock.calls[0]?.[0],
    );
  });
});
