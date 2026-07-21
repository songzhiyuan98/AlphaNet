import type { AlphaNetAuthRuntime, OwnerSession } from "@alphanet/auth";
import {
  OwnerActionApproveResponseSchema,
  OwnerActionDetailResponseSchema,
  OwnerActionListResponseSchema,
  OwnerActionRejectResponseSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  OwnerPendingActionError,
  type OwnerPendingActionDetailView,
  type OwnerPendingActionPage,
  type OwnerPendingActionService,
} from "@alphanet/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerOwnerActionRoutes } from "./owner-action-routes.js";
import type { OwnerRequestRateLimiter } from "./owner-request.js";

const ids = {
  action: "10000000-0000-4000-8000-000000000001",
  agent: "20000000-0000-4000-8000-000000000001",
  community: "30000000-0000-4000-8000-000000000001",
  decision: "40000000-0000-4000-8000-000000000001",
  owner: "50000000-0000-4000-8000-000000000001",
  policy: "60000000-0000-4000-8000-000000000001",
  session: "70000000-0000-4000-8000-000000000001",
  sourceContent: "80000000-0000-4000-8000-000000000001",
} as const;
const allowedOrigin = "https://app.alphanet.test";
const requestedAt = new Date("2026-07-20T18:00:00.000Z");
const expiresAt = new Date("2026-07-21T18:00:00.000Z");
const decidedAt = new Date("2026-07-20T18:01:00.000Z");
const apps: FastifyInstance[] = [];

const ownerSession: OwnerSession = {
  owner: {
    email: "owner@alphanet.test",
    emailVerified: true,
    id: ids.owner,
    name: "Research Owner",
    status: "active",
  },
  session: {
    createdAt: requestedAt,
    expiresAt,
    id: ids.session,
  },
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function pendingDetail(): OwnerPendingActionDetailView {
  return {
    agent: {
      id: ids.agent,
      handle: "market-scout",
      displayName: "Market Scout",
      status: "active",
    },
    approvalSummary: "Create one post in the Semiconductors community.",
    expiresAt,
    id: ids.action,
    operation: "create_post",
    requestedAt,
    state: "pending_approval",
    target: { id: ids.community, type: "community" },
    updatedAt: requestedAt,
    version: 3,
    approvalOutcome: null,
    command: {
      operation: "create_post",
      title: "AMD data-center scenario review",
      bodyMarkdown: "Base case revenue remains sensitive to product mix.",
      primaryCommunityId: ids.community,
      additionalCommunityIds: [],
      symbols: ["AMD"],
      topics: ["semiconductors"],
      sourceLinks: [
        {
          url: "https://example.com/amd-source",
          title: "AMD source",
        },
      ],
      references: [{ targetContentId: ids.sourceContent, relationType: "reference" }],
    },
    decidedAt: null,
    decisionId: ids.decision,
    decisionReasonCode: null,
    inputDigest: `sha256:${"a".repeat(64)}`,
    policyVersion: `${ids.policy}:1`,
    publicError: null,
    terminalAt: null,
  };
}

function approvedDetail(
  state: "approved" | "succeeded" = "approved",
): OwnerPendingActionDetailView {
  return {
    ...pendingDetail(),
    state,
    updatedAt: decidedAt,
    version: 4,
    approvalOutcome: "approved",
    decidedAt,
    decisionReasonCode: "owner_approved",
    terminalAt: state === "succeeded" ? new Date(decidedAt.valueOf() + 1_000) : null,
  };
}

function rejectedDetail(): OwnerPendingActionDetailView {
  return {
    ...pendingDetail(),
    state: "rejected",
    updatedAt: decidedAt,
    version: 4,
    approvalOutcome: "rejected",
    decidedAt,
    decisionReasonCode: "needs_revision",
    publicError: {
      code: "ACTION_REJECTED",
      message: "The Owner rejected this action.",
      retryable: false,
      details: null,
      retryAfterMs: null,
    },
    terminalAt: decidedAt,
  };
}

function actionPage(): OwnerPendingActionPage {
  const view = pendingDetail();
  return {
    hasMore: false,
    items: [
      {
        agent: view.agent,
        approvalSummary: view.approvalSummary,
        expiresAt: view.expiresAt,
        id: view.id,
        operation: view.operation,
        requestedAt: view.requestedAt,
        state: view.state,
        target: view.target,
        updatedAt: view.updatedAt,
        version: view.version,
      },
    ],
    limit: 20,
    nextCursor: null,
  };
}

function allowAllLimiter(): OwnerRequestRateLimiter & {
  consume: ReturnType<typeof vi.fn>;
} {
  return {
    consume: vi.fn(() => Promise.resolve({ allowed: true, retryAfter: null })),
  };
}

function createApp(options?: {
  approveAction?: OwnerPendingActionService["approveAction"];
  getAction?: OwnerPendingActionService["getAction"];
  listActions?: OwnerPendingActionService["listActions"];
  rateLimiter?: OwnerRequestRateLimiter;
  rejectAction?: OwnerPendingActionService["rejectAction"];
  session?: OwnerSession | null;
}) {
  const app = Fastify({ logger: false });
  const getOwnerSession = vi.fn<AlphaNetAuthRuntime["getOwnerSession"]>(() =>
    Promise.resolve(options && "session" in options ? options.session! : ownerSession),
  );
  const listActions = vi.fn<OwnerPendingActionService["listActions"]>(
    options?.listActions ?? (() => Promise.resolve(actionPage())),
  );
  const getAction = vi.fn<OwnerPendingActionService["getAction"]>(
    options?.getAction ?? (() => Promise.resolve(pendingDetail())),
  );
  const approveAction = vi.fn<OwnerPendingActionService["approveAction"]>(
    options?.approveAction ?? (() => Promise.resolve(approvedDetail())),
  );
  const rejectAction = vi.fn<OwnerPendingActionService["rejectAction"]>(
    options?.rejectAction ?? (() => Promise.resolve(rejectedDetail())),
  );
  registerOwnerActionRoutes(app, {
    allowedOrigins: [allowedOrigin],
    authRuntime: { getOwnerSession },
    ...(options?.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    service: {
      approveAction,
      checkReady: vi.fn(() => Promise.resolve()),
      getAction,
      listActions,
      rejectAction,
    },
  });
  apps.push(app);
  return {
    app,
    approveAction,
    getAction,
    getOwnerSession,
    listActions,
    rejectAction,
  };
}

function mutationHeaders() {
  return {
    "content-type": "application/json",
    origin: allowedOrigin,
    "sec-fetch-site": "same-origin",
  };
}

describe("Owner pending-action read routes", () => {
  it("parses one comma-separated list query and serializes a summary page", async () => {
    const { app, listActions } = createApp();
    const response = await app.inject({
      method: "GET",
      url:
        `/v1/owner/pending-actions?agent_id=${ids.agent}` +
        "&states=pending_approval,approved" +
        "&operations=create_post,reply_to_content" +
        "&limit=20&cursor=cursor_01",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(OwnerActionListResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(listActions).toHaveBeenCalledExactlyOnceWith(ids.owner, {
      agentId: ids.agent,
      states: ["pending_approval", "approved"],
      operations: ["create_post", "reply_to_content"],
      limit: 20,
      cursor: "cursor_01",
    });
  });

  it.each([
    "/v1/owner/pending-actions?states=pending_approval&states=approved",
    "/v1/owner/pending-actions?states=pending_approval,,approved",
    "/v1/owner/pending-actions?operations=create_post,delete_content",
    "/v1/owner/pending-actions?limit=01",
    "/v1/owner/pending-actions?unknown=value",
  ])("rejects noncanonical or unknown list query %s", async (url) => {
    const { app, listActions } = createApp();
    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(listActions).not.toHaveBeenCalled();
  });

  it("serializes the frozen command to the strict snake_case detail preview", async () => {
    const { app, getAction } = createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v1/owner/pending-actions/${ids.action}`,
    });

    expect(response.statusCode).toBe(200);
    const parsed = OwnerActionDetailResponseSchema.parse(response.json());
    expect(parsed.action.preview).toMatchObject({
      operation: "create_post",
      title: "AMD data-center scenario review",
      body_markdown: "Base case revenue remains sensitive to product mix.",
      primary_community_id: ids.community,
      symbols: ["AMD"],
      references: [{ target_content_id: ids.sourceContent, relation_type: "reference" }],
    });
    expect(JSON.stringify(parsed)).not.toContain("idempotency_key");
    expect(getAction).toHaveBeenCalledOnce();
    const call = getAction.mock.calls[0];
    expect(call?.slice(0, 2)).toEqual([ids.owner, ids.action]);
    expect(typeof call?.[2].requestId).toBe("string");
    expect(call?.[2].requestId.length).toBeGreaterThan(0);
  });

  it("rejects query fields on a detail request", async () => {
    const { app, getAction } = createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v1/owner/pending-actions/${ids.action}?owner_id=${ids.owner}`,
    });

    expect(response.statusCode).toBe(422);
    expect(getAction).not.toHaveBeenCalled();
  });
});

describe("Owner pending-action decision routes", () => {
  it("approves with session ownership and returns 202 plus the Agent polling URL", async () => {
    const { app, approveAction } = createApp({
      approveAction: () => Promise.resolve(approvedDetail("succeeded")),
    });
    const response = await app.inject({
      headers: mutationHeaders(),
      method: "POST",
      payload: { expected_version: 3, reason_code: "owner_approved" },
      url: `/v1/owner/pending-actions/${ids.action}/approve`,
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toBe(`/v1/actions/${ids.action}`);
    expect(OwnerActionApproveResponseSchema.safeParse(response.json()).success).toBe(
      true,
    );
    expect(approveAction).toHaveBeenCalledOnce();
    const approveInput = approveAction.mock.calls[0]?.[2];
    expect(approveAction.mock.calls[0]?.slice(0, 2)).toEqual([ids.owner, ids.action]);
    expect(approveInput).toMatchObject({
      expectedVersion: 3,
      reasonCode: "owner_approved",
    });
    expect(typeof approveInput?.requestId).toBe("string");
  });

  it("rejects with a controlled reason and returns the terminal representation", async () => {
    const { app, rejectAction } = createApp();
    const response = await app.inject({
      headers: mutationHeaders(),
      method: "POST",
      payload: { expected_version: 3, reason_code: "needs_revision" },
      url: `/v1/owner/pending-actions/${ids.action}/reject`,
    });

    expect(response.statusCode).toBe(200);
    expect(OwnerActionRejectResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(rejectAction).toHaveBeenCalledOnce();
    const rejectInput = rejectAction.mock.calls[0]?.[2];
    expect(rejectAction.mock.calls[0]?.slice(0, 2)).toEqual([ids.owner, ids.action]);
    expect(rejectInput).toMatchObject({
      expectedVersion: 3,
      reasonCode: "needs_revision",
    });
    expect(typeof rejectInput?.requestId).toBe("string");
  });

  it("runs authentication and CSRF before parsing malformed decision JSON", async () => {
    const limiter = allowAllLimiter();
    const unauthenticated = createApp({ rateLimiter: limiter, session: null });
    const unauthenticatedResponse = await unauthenticated.app.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: "{",
      url: `/v1/owner/pending-actions/${ids.action}/approve`,
    });
    expect(unauthenticatedResponse.statusCode).toBe(401);
    expect(limiter.consume).toHaveBeenCalledOnce();
    expect(unauthenticated.approveAction).not.toHaveBeenCalled();

    const csrf = createApp();
    const csrfResponse = await csrf.app.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: "{",
      url: `/v1/owner/pending-actions/${ids.action}/approve`,
    });
    expect(csrfResponse.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(csrfResponse.json()).error.code).toBe(
      "CSRF_VALIDATION_FAILED",
    );
    expect(csrf.approveAction).not.toHaveBeenCalled();

    const authorized = createApp();
    const malformedResponse = await authorized.app.inject({
      headers: mutationHeaders(),
      method: "POST",
      payload: "{",
      url: `/v1/owner/pending-actions/${ids.action}/approve`,
    });
    expect(malformedResponse.statusCode).toBe(400);
    expect(authorized.approveAction).not.toHaveBeenCalled();
  });

  it("rejects forged ownership and free-text decision fields", async () => {
    const { app, approveAction } = createApp();
    const response = await app.inject({
      headers: mutationHeaders(),
      method: "POST",
      payload: {
        expected_version: 3,
        reason_code: "owner_approved",
        owner_id: "90000000-0000-4000-8000-000000000009",
        comment: "free text",
      },
      url: `/v1/owner/pending-actions/${ids.action}/approve`,
    });

    expect(response.statusCode).toBe(422);
    expect(approveAction).not.toHaveBeenCalled();
  });
});

describe("Owner pending-action errors and response boundary", () => {
  it("returns safe current state/version details for a version conflict", async () => {
    const { app } = createApp({
      approveAction: () =>
        Promise.reject(
          new OwnerPendingActionError("ACTION_VERSION_CONFLICT", {
            currentState: "approved",
            currentVersion: 4,
          }),
        ),
    });
    const response = await app.inject({
      headers: mutationHeaders(),
      method: "POST",
      payload: { expected_version: 3, reason_code: "owner_approved" },
      url: `/v1/owner/pending-actions/${ids.action}/approve`,
    });

    expect(response.statusCode).toBe(409);
    expect(V1ErrorResponseSchema.parse(response.json()).error).toMatchObject({
      code: "ACTION_VERSION_CONFLICT",
      details: { current_state: "approved", current_version: 4 },
      retryable: false,
    });
  });

  it("fails closed without leaking an unknown service error", async () => {
    const { app } = createApp({
      getAction: () => Promise.reject(new Error("private database detail")),
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/owner/pending-actions/${ids.action}`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private database detail");
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "OWNER_ACTION_UNAVAILABLE",
    );
  });

  it("does not expose invalid current-state conflict metadata", async () => {
    const unsafeError = new OwnerPendingActionError("ACTION_VERSION_CONFLICT");
    Object.defineProperties(unsafeError, {
      currentState: { value: "private-state" },
      currentVersion: { value: -1 },
    });
    const { app } = createApp({
      approveAction: () => Promise.reject(unsafeError),
    });
    const response = await app.inject({
      headers: mutationHeaders(),
      method: "POST",
      payload: { expected_version: 3, reason_code: "owner_approved" },
      url: `/v1/owner/pending-actions/${ids.action}/approve`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain("private-state");
    expect(V1ErrorResponseSchema.parse(response.json()).error.details).toBeNull();
  });

  it("fails closed when a detail projection violates the public contract", async () => {
    const invalid = pendingDetail();
    invalid.command.bodyMarkdown = "private\u0000frozen draft";
    const { app } = createApp({ getAction: () => Promise.resolve(invalid) });
    const response = await app.inject({
      method: "GET",
      url: `/v1/owner/pending-actions/${ids.action}`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private");
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "OWNER_ACTION_UNAVAILABLE",
    );
  });
});
