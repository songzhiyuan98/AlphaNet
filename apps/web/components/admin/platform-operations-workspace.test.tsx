// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdminCommunityWriteControlResponse } from "@alphanet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminNavigation } from "./admin-navigation";
import { PlatformOperationsWorkspace } from "./platform-operations-workspace";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const now = "2026-07-23T18:00:00.000Z";

function control(): AdminCommunityWriteControlResponse {
  return {
    capabilities: { can_operate_platform: true },
    control: {
      mode: "open",
      pause_reason_code: null,
      paused_at: null,
      resume_condition: null,
      updated_at: now,
      updated_by_admin_id: null,
      version: 1,
    },
    request_id: "request-platform-control",
    schema_version: "1",
  };
}

afterEach(() => {
  cleanup();
  refresh.mockReset();
  vi.unstubAllGlobals();
});

describe("Admin platform operations workspace", () => {
  it("uses the shared navigation and submits a versioned pause command", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ request_id: "request-platform-action" }), {
          headers: { "content-type": "application/json" },
          status: 201,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("crypto", {
      randomUUID: () => "90000000-0000-4000-8000-000000000008",
    });
    const user = userEvent.setup();
    render(
      <>
        <AdminNavigation active="operations" canDecide={false} canOperatePlatform />
        <PlatformOperationsWorkspace response={control()} />
      </>,
    );

    expect(
      screen.getByRole("link", { name: "平台操作" }).getAttribute("aria-current"),
    ).toBe("page");
    await user.selectOptions(screen.getByLabelText("受控原因"), "security_incident");
    await user.type(
      screen.getByLabelText("恢复条件"),
      "Security review completed and evidence retained.",
    );
    await user.click(screen.getByRole("button", { name: "确认暂停写入" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith(
      "/admin/operations/actions",
      expect.objectContaining({
        body: JSON.stringify({
          action: {
            action: "pause_community_writes",
            reason_code: "security_incident",
            resume_condition: "Security review completed and evidence retained.",
          },
          attempt_id: "90000000-0000-4000-8000-000000000008",
          control_version: 1,
        }),
      }),
    );
    expect(screen.getByText("社区写入已暂停，读取与治理能力保持可用。")).toBeTruthy();
  });
});
