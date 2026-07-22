import { V1ErrorResponseSchema } from "@alphanet/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  decide: vi.fn(),
}));

vi.mock("./admin-api", () => ({ decideAdminModerationCase: mocks.decide }));

vi.mock("./admin-web-config", () => ({
  isAdminPostOriginAllowed: (origin: string | null) =>
    origin === "https://app.alphanet.test",
  loadAdminWebConfig: () => ({
    enabled: true,
    publicOrigin: "https://app.alphanet.test",
  }),
}));

const caseId = "10000000-0000-4000-8000-000000000001";
const attemptId = "20000000-0000-4000-8000-000000000001";
const requestBody = {
  attempt_id: attemptId,
  case_version: 2,
  decision: {
    action: "hide_content",
    reason_code: "confirmed_report_violation",
  },
} as const;

function request(body: unknown = requestBody, origin = "https://app.alphanet.test") {
  return new Request(`https://app.alphanet.test/admin/moderation/${caseId}/actions`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  });
}

function context(id = caseId) {
  return { params: Promise.resolve({ caseId: id }) };
}

describe("Admin moderation action BFF route", () => {
  beforeEach(() => {
    mocks.decide.mockReset();
  });

  it("passes only parsed decision metadata to the server client and preserves 201", async () => {
    mocks.decide.mockResolvedValueOnce({
      data: {
        case: { case_version: 3 },
        request_id: "req-decision",
        schema_version: "1",
      },
      kind: "success",
      status: 201,
    });
    const { POST } = await import("../app/admin/moderation/[caseId]/actions/route");
    const response = await POST(request(), context());

    expect(mocks.decide).toHaveBeenCalledWith({
      attemptId,
      caseId,
      caseVersion: 2,
      decision: requestBody.decision,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("etag")).toBe('"3"');
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects cross-origin and forged transport input before the Admin API", async () => {
    const { POST } = await import("../app/admin/moderation/[caseId]/actions/route");
    const crossOrigin = await POST(
      request(requestBody, "https://attacker.invalid"),
      context(),
    );
    expect(crossOrigin.status).toBe(403);

    const forged = await POST(
      request({ ...requestBody, idempotency_key: "browser-controlled" }),
      context(),
    );
    expect(forged.status).toBe(422);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("returns a bounded V1 permission error without upstream private details", async () => {
    mocks.decide.mockResolvedValueOnce({
      error: {
        code: "ADMIN_PERMISSION_REQUIRED",
        currentVersion: null,
        requestId: "req-forbidden",
        requiredPermission: "moderation:decide",
        retryAfterMs: null,
      },
      kind: "forbidden",
    });
    const { POST } = await import("../app/admin/moderation/[caseId]/actions/route");
    const response = await POST(request(), context());
    const payload = V1ErrorResponseSchema.parse((await response.json()) as unknown);

    expect(response.status).toBe(403);
    expect(payload).toEqual({
      error: {
        code: "ADMIN_PERMISSION_REQUIRED",
        details: { required_permission: "moderation:decide" },
        message: "The current Workforce identity is not authorized for this decision.",
        retry_after_ms: null,
        retryable: false,
      },
      request_id: "req-forbidden",
      schema_version: "1",
    });
    expect(JSON.stringify(payload)).not.toContain("Bearer");
  });

  it("preserves the safe rate-limit fallback for browser retry behavior", async () => {
    mocks.decide.mockResolvedValueOnce({
      error: {
        code: "RATE_LIMITED",
        currentVersion: null,
        requestId: "req-rate-limited",
        requiredPermission: null,
        retryAfterMs: null,
      },
      kind: "rate_limited",
      retryAfterMs: 1_000,
    });
    const { POST } = await import("../app/admin/moderation/[caseId]/actions/route");
    const response = await POST(request(), context());
    const payload = V1ErrorResponseSchema.parse((await response.json()) as unknown);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(payload.error.retry_after_ms).toBe(1_000);
    expect(payload.error.retryable).toBe(true);
  });
});
