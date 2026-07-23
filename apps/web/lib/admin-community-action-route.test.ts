import { V1ErrorResponseSchema } from "@alphanet/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock("./admin-api", () => ({
  createAdminTopicCommunity: mocks.create,
  updateAdminTopicCommunity: mocks.update,
}));

vi.mock("./admin-web-config", () => ({
  isAdminPostOriginAllowed: (origin: string | null) =>
    origin === "https://app.alphanet.test",
  loadAdminWebConfig: () => ({
    enabled: true,
    publicOrigin: "https://app.alphanet.test",
  }),
}));

const communityId = "10000000-0000-4000-8000-000000000001";
const attemptId = "20000000-0000-4000-8000-000000000001";
const createBody = {
  attempt_id: attemptId,
  community: {
    description_markdown: "Memory markets",
    name: "Semiconductors",
    slug: "semiconductors",
  },
} as const;
const updateBody = {
  attempt_id: attemptId,
  community_version: 2,
  patch: { state: "archived" },
} as const;

function request(path: string, body: unknown, origin = "https://app.alphanet.test") {
  return new Request(`https://app.alphanet.test${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  });
}

function context(id = communityId) {
  return { params: Promise.resolve({ communityId: id }) };
}

describe("Admin topic community action BFF routes", () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.update.mockReset();
  });

  it("passes only parsed create metadata and preserves the upstream success status", async () => {
    mocks.create.mockResolvedValueOnce({
      data: {
        community: { version: 1 },
        request_id: "req-create",
        schema_version: "1",
      },
      kind: "success",
      status: 201,
    });
    const { POST } = await import("../app/admin/communities/actions/route");
    const response = await POST(request("/admin/communities/actions", createBody));

    expect(mocks.create).toHaveBeenCalledWith({
      attemptId,
      community: createBody.community,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("passes the stable ID and optimistic version to an update", async () => {
    mocks.update.mockResolvedValueOnce({
      data: {
        community: { version: 3 },
        request_id: "req-update",
        schema_version: "1",
      },
      kind: "success",
      status: 200,
    });
    const { POST } = await import("../app/admin/communities/[communityId]/actions/route");
    const response = await POST(
      request(`/admin/communities/${communityId}/actions`, updateBody),
      context(),
    );

    expect(mocks.update).toHaveBeenCalledWith({
      attemptId,
      communityId,
      communityVersion: 2,
      patch: updateBody.patch,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"3"');
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects cross-origin and browser-forged transport data before the API", async () => {
    const createRoute = await import("../app/admin/communities/actions/route");
    const updateRoute =
      await import("../app/admin/communities/[communityId]/actions/route");
    const crossOrigin = await createRoute.POST(
      request("/admin/communities/actions", createBody, "https://attacker.invalid"),
    );
    const forged = await updateRoute.POST(
      request(`/admin/communities/${communityId}/actions`, {
        ...updateBody,
        idempotency_key: "browser-controlled",
      }),
      context(),
    );

    expect(crossOrigin.status).toBe(403);
    expect(forged.status).toBe(422);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("returns a bounded V1 conflict with safe version metadata", async () => {
    mocks.update.mockResolvedValueOnce({
      error: {
        code: "COMMUNITY_VERSION_CONFLICT",
        currentVersion: 4,
        requestId: "req-conflict",
        requiredPermission: null,
        retryAfterMs: null,
      },
      kind: "conflict",
    });
    const { POST } = await import("../app/admin/communities/[communityId]/actions/route");
    const response = await POST(
      request(`/admin/communities/${communityId}/actions`, updateBody),
      context(),
    );
    const payload = V1ErrorResponseSchema.parse((await response.json()) as unknown);

    expect(response.status).toBe(409);
    expect(payload).toEqual({
      error: {
        code: "COMMUNITY_VERSION_CONFLICT",
        details: { current_version: 4 },
        message: "The community changed before this action.",
        retry_after_ms: null,
        retryable: false,
      },
      request_id: "req-conflict",
      schema_version: "1",
    });
  });

  it("preserves a safe retry window for browser behavior", async () => {
    mocks.create.mockResolvedValueOnce({
      error: {
        code: "RATE_LIMITED",
        currentVersion: null,
        requestId: "req-rate-limited",
        requiredPermission: null,
        retryAfterMs: null,
      },
      kind: "rate_limited",
      retryAfterMs: 1_500,
    });
    const { POST } = await import("../app/admin/communities/actions/route");
    const response = await POST(request("/admin/communities/actions", createBody));
    const payload = V1ErrorResponseSchema.parse((await response.json()) as unknown);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(payload.error.retry_after_ms).toBe(1_500);
    expect(payload.error.retryable).toBe(true);
  });
});
