// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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
});
