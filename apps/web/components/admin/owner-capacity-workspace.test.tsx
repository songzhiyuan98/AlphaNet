// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AdminOwnerDetailResponse,
  AdminOwnerListResponse,
  AdminRegistrationControlResponse,
} from "@alphanet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminNavigation } from "./admin-navigation";
import { OwnerCapacityWorkspace, OwnerQuotaDetail } from "./owner-capacity-workspace";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const ownerId = "90000000-0000-4000-8000-000000000001";
const now = "2026-07-23T18:00:00.000Z";

function owners(): AdminOwnerListResponse {
  return {
    capabilities: { can_manage_quota: true },
    items: [
      {
        active_agent_count: 2,
        base_active_agent_limit: 5,
        closed_at: null,
        created_at: now,
        credential_counts: { active: 2, expired: 1, revoked: 0, total: 3 },
        current_override: null,
        effective_active_agent_limit: 5,
        email_hint: "r***@example.test",
        email_verified: true,
        owner_id: ownerId,
        quota_version: 1,
        restricted_at: null,
        status: "active",
        suspended_at: null,
        total_agent_count: 2,
        updated_at: now,
      },
    ],
    ordering: {
      as_of: now,
      ordering_version: "admin-owner-created-keyset-v1",
      snapshot_id: "owner-snapshot-1",
    },
    page: { has_more: false, limit: 25, next_cursor: null },
    request_id: "request-owner-list",
    schema_version: "1",
  };
}

function control(): AdminRegistrationControlResponse {
  return {
    capabilities: { can_manage_quota: true },
    control: {
      active_agent_count: 2,
      active_agent_hard_limit: 10_000,
      active_agent_operating_target: 5_000,
      mode: "open",
      pause_reason_code: null,
      paused_at: null,
      resume_condition: null,
      updated_at: now,
      version: 1,
    },
    request_id: "request-capacity",
    schema_version: "1",
  };
}

function detail(): AdminOwnerDetailResponse {
  return {
    capabilities: { can_manage_quota: true },
    owner: owners().items[0]!,
    request_id: "request-owner-detail",
    schema_version: "1",
  };
}

afterEach(() => {
  cleanup();
  refresh.mockReset();
  vi.unstubAllGlobals();
});

describe("Admin Owner capacity workspace", () => {
  it("shows the shared navigation, registration state and Owner facts", () => {
    render(
      <>
        <AdminNavigation active="capacity" canDecide={false} canManageCapacity />
        <OwnerCapacityWorkspace control={control()} filters={{}} owners={owners()} />
      </>,
    );
    expect(
      screen.getByRole("link", { name: "身份容量" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByRole("heading", { name: "平台注册" })).toBeTruthy();
    expect(screen.getByText("r***@example.test")).toBeTruthy();
    expect(screen.getByText(ownerId)).toBeTruthy();
  });

  it("submits a versioned Owner quota command and refreshes authority", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ request_id: "request-quota" }), {
          headers: { "content-type": "application/json" },
          status: 201,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("crypto", {
      randomUUID: () => "90000000-0000-4000-8000-000000000005",
    });
    const user = userEvent.setup();
    render(<OwnerQuotaDetail response={detail()} />);

    await user.clear(screen.getByLabelText("活跃 Agent 上限"));
    await user.type(screen.getByLabelText("活跃 Agent 上限"), "10");
    await user.type(screen.getByLabelText("到期时间"), "2026-07-25T18:20");
    await user.selectOptions(
      screen.getByLabelText("受控原因"),
      "research_team_expansion",
    );
    await user.click(screen.getByRole("button", { name: "确认执行" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith(
      `/admin/owners/${ownerId}/quota-actions`,
      expect.objectContaining({
        body: JSON.stringify({
          action: {
            action: "set_override",
            expires_at: new Date("2026-07-25T18:20").toISOString(),
            max_active_agents: 10,
            reason_code: "research_team_expansion",
          },
          attempt_id: "90000000-0000-4000-8000-000000000005",
          quota_version: 1,
        }),
      }),
    );
    expect(screen.getByText("Owner 配额已更新并写入审计记录。")).toBeTruthy();
  });
});
