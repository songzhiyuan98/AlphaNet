// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { OwnerContentModerationListResponse } from "@alphanet/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { OwnerModerationHistory } from "./owner-moderation-history";

const ids = {
  actionHide: "10000000-0000-4000-8000-000000000001",
  actionRestore: "10000000-0000-4000-8000-000000000002",
  case: "20000000-0000-4000-8000-000000000001",
  content: "30000000-0000-4000-8000-000000000001",
  snapshot: "40000000-0000-4000-8000-000000000001",
} as const;

const history: OwnerContentModerationListResponse = {
  content_id: ids.content,
  content_version: 3,
  distribution_state: "normal",
  items: [
    {
      action: "restore_content",
      action_version: 1,
      case_id: ids.case,
      content_id: ids.content,
      content_version_after: 3,
      content_version_before: 2,
      decided_at: "2026-07-21T20:00:00.000Z",
      distribution_after: "normal",
      distribution_before: "hidden",
      moderation_action_id: ids.actionRestore,
      reason_code: "moderation_error_corrected",
      reverted_action_id: ids.actionHide,
    },
    {
      action: "hide_content",
      action_version: 1,
      case_id: ids.case,
      content_id: ids.content,
      content_version_after: 2,
      content_version_before: 1,
      decided_at: "2026-07-21T19:00:00.000Z",
      distribution_after: "hidden",
      distribution_before: "normal",
      moderation_action_id: ids.actionHide,
      reason_code: "confirmed_report_violation",
      reverted_action_id: null,
    },
  ],
  ordering: {
    as_of: "2026-07-21T20:00:00.000Z",
    ordering_version: "owner-content-moderation-list-v1",
    snapshot_id: ids.snapshot,
  },
  page: {
    has_more: true,
    limit: 2,
    next_cursor: "opaque-owner-history-cursor",
  },
  request_id: "req-owner-history",
  schema_version: "1",
};

afterEach(cleanup);

describe("OwnerModerationHistory", () => {
  it("shows an Owner-safe action history with versioned state transitions", () => {
    render(
      <OwnerModerationHistory
        history={history}
        nextPageHref={`/content/${ids.content}?moderation_cursor=opaque-owner-history-cursor`}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "这项内容的社区处置记录" }),
    ).not.toBeNull();
    expect(screen.getByText("内容分发已恢复")).not.toBeNull();
    expect(screen.getByText("内容已移出公共分发")).not.toBeNull();
    expect(screen.getByText("更正审核处理")).not.toBeNull();
    expect(screen.getByText("确认违反社区规则")).not.toBeNull();
    expect(screen.getByText("隐藏 → 正常分发")).not.toBeNull();
    expect(screen.getByText("正常分发 → 隐藏")).not.toBeNull();
    expect(screen.getByText("2 → 3")).not.toBeNull();
    expect(screen.getByText("1 → 2")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "查看更早的处置记录" }).getAttribute("href"),
    ).toBe(`/content/${ids.content}?moderation_cursor=opaque-owner-history-cursor`);
  });

  it("does not render an empty history section", () => {
    const { container } = render(
      <OwnerModerationHistory
        history={{
          ...history,
          items: [],
          page: { has_more: false, limit: 20, next_cursor: null },
        }}
        nextPageHref={null}
      />,
    );

    expect(container.childElementCount).toBe(0);
  });
});
