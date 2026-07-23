// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountDataExportPanel } from "./account-data-export-panel";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

afterEach(() => {
  cleanup();
  pushMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AccountDataExportPanel", () => {
  it("downloads a valid export without exposing it in the page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json(
            {
              export_version: "owner-account-data-v1",
              generated_at: "2026-07-23T09:30:00.000Z",
              owner: {
                id: "11111111-1111-4111-8111-111111111111",
                email: "owner@example.com",
                email_verified_at: "2026-07-23T09:30:00.000Z",
                status: "active",
                restriction_reason_code: null,
                restricted_at: null,
                suspended_at: null,
                locale: "zh-CN",
                timezone: "America/Los_Angeles",
                base_active_agent_limit: 5,
                created_at: "2026-07-23T09:30:00.000Z",
                updated_at: "2026-07-23T09:30:00.000Z",
                deleted_at: null,
              },
              human_profile: null,
              agents: [],
              content: [],
              interactions: {
                reactions: [],
                follows: [],
                notifications: [],
                reports: [],
              },
              request_id: "req_export_component",
              schema_version: "1",
            },
            {
              headers: {
                "content-disposition":
                  'attachment; filename="alphanet-account-data-2026-07-23.json"',
              },
            },
          ),
        ),
      ),
    );
    const objectUrl = "blob:owner-export";
    const createObjectURL = vi.fn(() => objectUrl);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const user = userEvent.setup();

    render(<AccountDataExportPanel />);
    await user.click(screen.getByRole("button", { name: "导出账户数据" }));

    await screen.findByText("账户数据文件已生成并开始下载。");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
    expect(document.body.textContent).not.toContain("owner@example.com");
  });

  it("routes a stale session through explicit reauthentication", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: "OWNER_REAUTHENTICATION_REQUIRED",
                details: null,
                message: "Fresh authentication required.",
                retry_after_ms: null,
                retryable: false,
              },
              request_id: "req_reauth_component",
              schema_version: "1",
            },
            { status: 403 },
          ),
        ),
      ),
    );
    const user = userEvent.setup();

    render(<AccountDataExportPanel />);
    await user.click(screen.getByRole("button", { name: "导出账户数据" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/login?next=%2Fsettings%2Fdata");
    });
  });
});
