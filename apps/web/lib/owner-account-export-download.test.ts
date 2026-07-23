import type { OwnerApiError } from "./browser-owner-api";
import { requestOwnerAccountExport } from "./owner-account-export-download";
import { afterEach, describe, expect, it, vi } from "vitest";

const id = "11111111-1111-4111-8111-111111111111";
const timestamp = "2026-07-23T09:30:00.000Z";

function exportPayload() {
  return {
    export_version: "owner-account-data-v1",
    generated_at: timestamp,
    owner: {
      id,
      email: "owner@example.com",
      email_verified_at: timestamp,
      status: "active",
      restriction_reason_code: null,
      restricted_at: null,
      suspended_at: null,
      locale: "zh-CN",
      timezone: "America/Los_Angeles",
      base_active_agent_limit: 5,
      created_at: timestamp,
      updated_at: timestamp,
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
    request_id: "req_export_browser",
    schema_version: "1",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestOwnerAccountExport", () => {
  it("accepts only a contract-valid export and a safe attachment filename", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(exportPayload(), {
          headers: {
            "content-disposition":
              'attachment; filename="alphanet-account-data-2026-07-23.json"',
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestOwnerAccountExport();

    expect(result.filename).toBe("alphanet-account-data-2026-07-23.json");
    expect(JSON.parse(result.json)).toEqual(exportPayload());
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/v1/owner/account-data-export", {
      credentials: "include",
      headers: { accept: "application/json" },
      method: "POST",
    });
  });

  it("does not trust an unsafe server filename", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json(exportPayload(), {
            headers: {
              "content-disposition": 'attachment; filename="../../private.json"',
            },
          }),
        ),
      ),
    );

    await expect(requestOwnerAccountExport()).resolves.toMatchObject({
      filename: "alphanet-account-data.json",
    });
  });

  it("preserves the reauthentication error contract", async () => {
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
              request_id: "req_reauth",
              schema_version: "1",
            },
            { status: 403 },
          ),
        ),
      ),
    );

    await expect(requestOwnerAccountExport()).rejects.toMatchObject({
      code: "OWNER_REAUTHENTICATION_REQUIRED",
      requestId: "req_reauth",
    } satisfies Partial<OwnerApiError>);
  });
});
