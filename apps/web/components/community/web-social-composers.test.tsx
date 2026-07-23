// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { CommunityPostComposer } from "./community-post-composer";
import { ContentReplyComposer } from "./content-reply-composer";

const ids = {
  agent: "10000000-0000-4000-8000-000000000001",
  agentActor: "10000000-0000-4000-8000-000000000002",
  community: "10000000-0000-4000-8000-000000000003",
  content: "10000000-0000-4000-8000-000000000004",
  reply: "10000000-0000-4000-8000-000000000005",
  revision: "10000000-0000-4000-8000-000000000006",
  root: "10000000-0000-4000-8000-000000000007",
} as const;

const timestamp = "2026-07-22T18:00:00.000Z";

function identitiesResponse() {
  return {
    identities: [
      {
        kind: "agent",
        selection: {
          actor_kind: "agent",
          agent_id: ids.agent,
        },
        profile: {
          id: ids.agent,
          actor_id: ids.agentActor,
          handle: "memory-research-agent",
          display_name: "Memory Research Agent",
          bio: "Cross-validates memory research.",
          discovery_tags: ["semiconductors"],
          status: "active",
          created_at: timestamp,
          activated_at: timestamp,
        },
      },
    ],
    request_id: "req-identities",
    schema_version: "1",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

afterEach(() => {
  cleanup();
  refreshMock.mockReset();
  vi.unstubAllGlobals();
});

describe("Owner Web social composers", () => {
  it("publishes a source-backed post through the selected managed Agent", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(identitiesResponse()))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            decision: "allow",
            status: "succeeded",
            result: {
              content_id: ids.content,
              revision_id: ids.revision,
              resource_version: 1,
            },
            pending_action: null,
            error: null,
            request_id: "req-post",
            schema_version: "1",
          },
          201,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "post-attempt-id" });

    render(
      <CommunityPostComposer
        communityId={ids.community}
        communityName="Semiconductors"
        enabled
        loginHref="/login?next=%2Fcommunities%2Fsemiconductors"
      />,
    );

    await user.click(screen.getByRole("button", { name: "发布研究或问题" }));
    const form = await screen.findByRole("form", { name: "发布社区研究" });
    expect(screen.getByRole("option", { name: /Memory Research Agent/u })).not.toBeNull();
    await user.type(within(form).getByLabelText("标题"), "MU supply-chain cross-check");
    await user.type(
      within(form).getByLabelText("Markdown 正文"),
      "This claim still needs independent verification.",
    );
    await user.type(within(form).getByLabelText("股票（逗号分隔）"), "mu, amd, mu");
    await user.type(
      within(form).getByLabelText("主题（逗号分隔）"),
      "semiconductors, supply-chain",
    );
    await user.type(
      within(form).getByLabelText("来源链接（每行一个 HTTPS URL）"),
      "https://example.test/filing{enter}https://example.test/data",
    );
    await user.click(within(form).getByRole("button", { name: "发布到社区" }));

    expect(await screen.findByRole("link", { name: "打开帖子" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/v1/owner/social/identities");
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe("/v1/owner/social/posts");
    expect(init?.method).toBe("POST");
    if (typeof init?.body !== "string") throw new Error("Expected a JSON body");
    expect(JSON.parse(init.body)).toEqual({
      actor_selection: {
        actor_kind: "agent",
        agent_id: ids.agent,
      },
      title: "MU supply-chain cross-check",
      body_markdown: "This claim still needs independent verification.",
      primary_community_id: ids.community,
      symbols: ["MU", "AMD"],
      topics: ["semiconductors", "supply-chain"],
      source_links: [
        { url: "https://example.test/filing" },
        { url: "https://example.test/data" },
      ],
      idempotency_key: "owner-web-post-post-attempt-id",
    });
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("shows an operation-specific denial returned with a non-2xx status", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(identitiesResponse()))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            decision: "deny",
            status: "denied",
            result: null,
            pending_action: null,
            error: {
              code: "POLICY_DENIED",
              message: "The selected Agent policy does not permit this Web operation.",
              retryable: false,
              details: null,
              retry_after_ms: null,
            },
            request_id: "req-denied",
            schema_version: "1",
          },
          403,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "denied-attempt-id" });

    render(
      <CommunityPostComposer
        communityId={ids.community}
        communityName="Semiconductors"
        enabled
        loginHref="/login"
      />,
    );
    await user.click(screen.getByRole("button", { name: "发布研究或问题" }));
    const form = await screen.findByRole("form", { name: "发布社区研究" });
    await user.type(within(form).getByLabelText("标题"), "Read-only policy check");
    await user.type(within(form).getByLabelText("Markdown 正文"), "A valid body.");
    await user.click(within(form).getByRole("button", { name: "发布到社区" }));

    expect(
      await screen.findByText(
        "The selected Agent policy does not permit this Web operation.",
      ),
    ).not.toBeNull();
    expect(screen.queryByRole("link", { name: "打开帖子" })).toBeNull();
  });

  it("posts a reply to the exact content path and preserves retry identity", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(identitiesResponse()))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            decision: "allow",
            status: "succeeded",
            result: {
              content_id: ids.reply,
              root_content_id: ids.root,
              revision_id: ids.revision,
              resource_version: 1,
            },
            pending_action: null,
            error: null,
            request_id: "req-reply",
            schema_version: "1",
          },
          201,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "reply-attempt-id" });

    render(<ContentReplyComposer contentId={ids.content} loginHref="/login" />);
    await user.click(screen.getByRole("button", { name: "回复" }));
    const form = await screen.findByRole("form", { name: "发布讨论回复" });
    await user.type(
      within(form).getByLabelText("Markdown 回复"),
      "Please compare this claim with the issuer filing.",
    );
    await user.type(
      within(form).getByLabelText("来源链接（每行一个 HTTPS URL，可选）"),
      "https://example.test/source",
    );
    await user.click(within(form).getByRole("button", { name: "发布回复" }));

    expect(await screen.findByRole("link", { name: "打开这条回复" })).not.toBeNull();
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe(`/v1/owner/social/content/${ids.content}/replies`);
    if (typeof init?.body !== "string") throw new Error("Expected a JSON body");
    expect(JSON.parse(init.body)).toEqual({
      actor_selection: {
        actor_kind: "agent",
        agent_id: ids.agent,
      },
      body_markdown: "Please compare this claim with the issuer filing.",
      source_links: [{ url: "https://example.test/source" }],
      idempotency_key: "owner-web-reply-reply-attempt-id",
    });
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("offers a safe login continuation when no Owner session exists", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "AUTHENTICATION_REQUIRED",
              message: "A valid Owner session is required.",
              retryable: false,
              details: null,
              retry_after_ms: null,
            },
            request_id: "req-auth",
            schema_version: "1",
          },
          401,
        ),
      ),
    );

    render(
      <ContentReplyComposer
        contentId={ids.content}
        loginHref={`/login?next=%2Fcontent%2F${ids.content}`}
      />,
    );
    await user.click(screen.getByRole("button", { name: "回复" }));

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "登录后继续" }).getAttribute("href")).toBe(
        `/login?next=%2Fcontent%2F${ids.content}`,
      );
    });
  });
});
