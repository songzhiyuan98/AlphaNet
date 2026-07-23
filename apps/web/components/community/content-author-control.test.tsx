// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { ContentAuthorControl } from "./content-author-control";

const ids = {
  agent: "10000000-0000-4000-8000-000000000001",
  authorActor: "10000000-0000-4000-8000-000000000002",
  content: "10000000-0000-4000-8000-000000000003",
  otherActor: "10000000-0000-4000-8000-000000000004",
  revision: "10000000-0000-4000-8000-000000000005",
} as const;
const timestamp = "2026-07-22T18:00:00.000Z";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function identitiesResponse(actorId: string = ids.authorActor) {
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
          actor_id: actorId,
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

function renderControl() {
  return render(
    <ContentAuthorControl
      authorActorId={ids.authorActor}
      contentId={ids.content}
      contentKind="post"
      currentBodyMarkdown="Original research body."
      currentSourceLinks={[
        { title: "Issuer filing", url: "https://example.test/filing" },
      ]}
      currentSymbols={["MU"]}
      currentTitle="Original MU thesis"
      currentTopics={["semiconductors"]}
      currentVersion={2}
    />,
  );
}

afterEach(() => {
  cleanup();
  refreshMock.mockReset();
  vi.unstubAllGlobals();
});

describe("ContentAuthorControl", () => {
  it("does not expose author operations to a different managed identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(identitiesResponse(ids.otherActor))),
    );

    renderControl();

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "管理作者内容" })).toBeNull();
    });
  });

  it("updates the exact content path with the fixed author identity and version", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(identitiesResponse()))
      .mockResolvedValueOnce(
        jsonResponse({
          decision: "allow",
          status: "succeeded",
          result: {
            content_id: ids.content,
            revision_id: ids.revision,
            resource_version: 3,
          },
          pending_action: null,
          error: null,
          request_id: "req-update",
          schema_version: "1",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "update-attempt-id" });

    renderControl();

    await user.click(await screen.findByRole("button", { name: "管理作者内容" }));
    const title = screen.getByLabelText("标题");
    const body = screen.getByLabelText("Markdown 正文");
    await user.clear(title);
    await user.type(title, "Revised MU thesis");
    await user.clear(body);
    await user.type(body, "Revised research body with an independently verified source.");
    await user.type(screen.getByLabelText("股票代码（逗号分隔）"), ", amd");
    await user.type(
      screen.getByLabelText("修订说明（可选）"),
      "Added the latest filing cross-check.",
    );
    await user.click(screen.getByRole("button", { name: "保存修订" }));

    expect(await screen.findByText("已保存修订。")).not.toBeNull();
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe(`/v1/owner/social/content/${ids.content}`);
    expect(init?.method).toBe("PATCH");
    if (typeof init?.body !== "string") throw new Error("Expected a JSON body");
    expect(JSON.parse(init.body)).toEqual({
      actor_selection: {
        actor_kind: "agent",
        agent_id: ids.agent,
      },
      expected_version: 2,
      idempotency_key: "owner-web-update-update-attempt-id",
      patch: {
        title: "Revised MU thesis",
        body_markdown: "Revised research body with an independently verified source.",
        symbols: ["MU", "AMD"],
      },
      edit_summary: "Added the latest filing cross-check.",
    });
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("requires explicit confirmation before issuing a soft delete", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(identitiesResponse()))
      .mockResolvedValueOnce(
        jsonResponse({
          decision: "allow",
          status: "succeeded",
          result: {
            content_id: ids.content,
            lifecycle_state: "deleted",
            resource_version: 3,
          },
          pending_action: null,
          error: null,
          request_id: "req-delete",
          schema_version: "1",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "delete-attempt-id" });

    renderControl();

    await user.click(await screen.findByRole("button", { name: "管理作者内容" }));
    await user.click(screen.getByRole("tab", { name: "软删除" }));
    const submit = screen.getByRole("button", { name: "确认软删除" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("删除原因（可选）"), "Superseded thesis");
    await user.click(screen.getByLabelText("我确认以作者身份软删除这项内容"));
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    await user.click(submit);

    expect(
      await screen.findByText("内容已软删除，讨论位置和修订审计仍被保留。"),
    ).not.toBeNull();
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe(`/v1/owner/social/content/${ids.content}`);
    expect(init?.method).toBe("DELETE");
    if (typeof init?.body !== "string") throw new Error("Expected a JSON body");
    expect(JSON.parse(init.body)).toEqual({
      actor_selection: {
        actor_kind: "agent",
        agent_id: ids.agent,
      },
      expected_version: 2,
      idempotency_key: "owner-web-delete-delete-attempt-id",
      mode: "soft",
      reason: "Superseded thesis",
    });
    expect(refreshMock).toHaveBeenCalledOnce();
  });
});
