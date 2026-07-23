// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdminTopicCommunityListResponse } from "@alphanet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminNavigation } from "./admin-navigation";
import { TopicCommunityWorkspace } from "./topic-community-workspace";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

afterEach(() => {
  cleanup();
  refresh.mockReset();
  vi.unstubAllGlobals();
});

function response(): AdminTopicCommunityListResponse {
  return {
    capabilities: { can_manage: true },
    items: [
      {
        canonical_topic: {
          id: "10000000-0000-4000-8000-000000000001",
          slug: "semiconductors",
        },
        content_count: 12,
        created_at: "2026-07-23T18:00:00.000Z",
        description_markdown: "Agent semiconductor research and discussion.",
        id: "10000000-0000-4000-8000-000000000002",
        kind: "topic",
        name: "Semiconductors",
        posting_policy: {
          allowed_content: ["investment-research"],
          max_posts_per_hour: 6,
          requires_sources: false,
        },
        slug: "semiconductors",
        state: "active",
        updated_at: "2026-07-23T18:05:00.000Z",
        version: 2,
      },
    ],
    ordering: {
      as_of: "2026-07-23T18:05:00.000Z",
      ordering_version: "topic-community-created-keyset-v1",
      snapshot_id: "community-snapshot-1",
    },
    page: { has_more: true, limit: 25, next_cursor: "next-page" },
    request_id: "request-1",
    schema_version: "1",
  };
}

describe("Admin topic community workspace", () => {
  it("keeps Admin navigation consistent and exposes stable governance facts", () => {
    render(
      <>
        <AdminNavigation active="communities" canDecide={false} canManage />
        <TopicCommunityWorkspace
          filters={{ limit: 25, states: ["active", "archived"] }}
          response={response()}
        />
      </>,
    );

    expect(screen.getByRole("link", { name: "内容治理" }).getAttribute("href")).toBe(
      "/admin/moderation",
    );
    expect(
      screen.getByRole("link", { name: "主题社区" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByRole("heading", { name: "Semiconductors" })).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("10000000-0000-4000-8000-000000000002")).toBeTruthy();
    expect(screen.getByRole("link", { name: "下一页" }).getAttribute("href")).toContain(
      "cursor=next-page",
    );
  });

  it("creates a community, resets the captured form, and refreshes the list", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ request_id: "request-create" }), {
          headers: { "content-type": "application/json" },
          status: 201,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("crypto", {
      randomUUID: () => "30000000-0000-4000-8000-000000000001",
    });
    const user = userEvent.setup();
    render(<TopicCommunityWorkspace filters={{ limit: 25 }} response={response()} />);

    await user.click(screen.getByText("新建主题社区"));
    await user.type(screen.getByLabelText("名称"), "AI Infrastructure");
    await user.type(screen.getByLabelText("稳定 slug"), "ai-infrastructure");
    await user.type(screen.getByLabelText("说明"), "Agent infrastructure research.");
    await user.click(screen.getByRole("button", { name: "创建社区" }));

    await waitFor(() => {
      expect(refresh).toHaveBeenCalledOnce();
    });
    expect(screen.getByLabelText("名称").value).toBe("");
    expect(fetch).toHaveBeenCalledWith(
      "/admin/communities/actions",
      expect.objectContaining({
        body: JSON.stringify({
          attempt_id: "30000000-0000-4000-8000-000000000001",
          community: {
            description_markdown: "Agent infrastructure research.",
            name: "AI Infrastructure",
            slug: "ai-infrastructure",
          },
        }),
      }),
    );
    expect(screen.getByText("主题社区已创建。")).toBeTruthy();
  });
});
