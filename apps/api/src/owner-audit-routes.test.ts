import type { AlphaNetAuthRuntime, OwnerSession } from "@alphanet/auth";
import {
  OwnerAuditActionListResponseSchema,
  OwnerAuditSearchListResponseSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  OwnerAuditError,
  type OwnerAuditActionView,
  type OwnerAuditSearchActivityView,
  type OwnerAuditService,
} from "@alphanet/domain";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerOwnerAuditRoutes } from "./owner-audit-routes.js";

const ids = {
  action: "11111111-1111-4111-8111-111111111111",
  actor: "22222222-2222-4222-8222-222222222222",
  agent: "33333333-3333-4333-8333-333333333333",
  credential: "44444444-4444-4444-8444-444444444444",
  owner: "55555555-5555-4555-8555-555555555555",
  session: "66666666-6666-4666-8666-666666666666",
} as const;
const now = new Date("2026-07-23T08:00:00.000Z");
const ownerSession: OwnerSession = {
  owner: {
    email: "owner@example.com",
    emailVerified: true,
    id: ids.owner,
    name: "Owner",
    status: "active",
  },
  session: {
    createdAt: new Date("2026-07-23T07:55:00.000Z"),
    expiresAt: new Date("2026-07-30T07:55:00.000Z"),
    id: ids.session,
  },
};

function action(overrides: Partial<OwnerAuditActionView> = {}): OwnerAuditActionView {
  return {
    action: "content.create_post",
    actor: {
      displayName: "Alpha Research",
      handle: "alpha-research",
      id: ids.actor,
      kind: "agent",
    },
    agent: {
      displayName: "Alpha Research",
      handle: "alpha-research",
      id: ids.agent,
    },
    approvalMethod: "policy_auto",
    approvedByOwner: false,
    channel: "mcp",
    credential: {
      id: ids.credential,
      name: "Research runtime",
      tokenPrefix: "aln_v1_000000000001",
    },
    decision: "allow",
    errorCode: null,
    eventClass: "domain_write",
    id: ids.action,
    occurredAt: now,
    outboxEventId: null,
    outcome: "succeeded",
    policyVersion: "4",
    reasonCode: null,
    requestId: "req_action_01",
    retryCount: 0,
    target: { id: ids.action, type: "content" },
    ...overrides,
  };
}

function search(): OwnerAuditSearchActivityView {
  return {
    agent: {
      displayName: "Alpha Research",
      handle: "alpha-research",
      id: ids.agent,
    },
    credential: {
      id: ids.credential,
      name: "Research runtime",
      tokenPrefix: "aln_v1_000000000001",
    },
    expiresAt: new Date("2026-08-22T08:00:00.000Z"),
    fallbackReasonCode: null,
    finalizedAt: new Date("2026-07-23T08:00:00.100Z"),
    id: ids.action,
    latencyMs: 100,
    occurredAt: now,
    outcome: "succeeded",
    requestId: "req_search_01",
    resultCount: 20,
    searchMode: "hybrid",
    surface: "mcp",
  };
}

function createApp(
  options: {
    invalidProjection?: boolean;
    session?: OwnerSession | null;
    thrown?: Error;
  } = {},
) {
  const listActions = vi.fn<OwnerAuditService["listActions"]>(() => {
    if (options.thrown) return Promise.reject(options.thrown);
    return Promise.resolve({
      hasMore: true,
      items: [action(options.invalidProjection ? { action: "INVALID ACTION" } : {})],
      limit: 1,
      nextCursor: "signed-owner-audit-cursor",
    });
  });
  const listSearchActivity = vi.fn<OwnerAuditService["listSearchActivity"]>(() =>
    Promise.resolve({
      hasMore: false,
      items: [search()],
      limit: 25,
      nextCursor: null,
    }),
  );
  const getOwnerSession = vi.fn<AlphaNetAuthRuntime["getOwnerSession"]>(() =>
    Promise.resolve(options.session === undefined ? ownerSession : options.session),
  );
  const app = Fastify({ logger: false });
  registerOwnerAuditRoutes(app, {
    allowedOrigins: ["http://localhost:3101"],
    authRuntime: { getOwnerSession },
    service: {
      checkReady: () => Promise.resolve(),
      listActions,
      listSearchActivity,
    },
  });
  return { app, listActions, listSearchActivity };
}

describe("Owner audit routes", () => {
  it("filters immutable actions without trusting an Owner identifier", async () => {
    const { app, listActions } = createApp();
    const response = await app.inject({
      headers: { cookie: "owner_session=test" },
      method: "GET",
      url:
        `/v1/owner/audit/actions?agent_id=${ids.agent}` +
        `&credential_id=${ids.credential}&action=content.create_post` +
        "&outcome=succeeded&limit=1&from=2026-07-01T00%3A00%3A00.000Z",
    });
    expect(response.statusCode).toBe(200);
    const parsed = OwnerAuditActionListResponseSchema.parse(response.json());
    expect(parsed.items[0]?.credential?.token_prefix).toBe("aln_v1_000000000001");
    expect(parsed.page.next_cursor).toBe("signed-owner-audit-cursor");
    expect(listActions).toHaveBeenCalledOnce();
    expect(listActions.mock.calls[0]?.[0]).toBe(ids.owner);
    expect(listActions.mock.calls[0]?.[1]).toMatchObject({
      action: "content.create_post",
      agentId: ids.agent,
      credentialId: ids.credential,
      limit: 1,
      outcome: "succeeded",
    });
    expect(listActions.mock.calls[0]?.[2]).toMatchObject({
      authenticationAssurance: "email_verified_owner_session",
    });
  });

  it("returns recent search metadata without a raw query or keyed digest", async () => {
    const { app, listSearchActivity } = createApp();
    const response = await app.inject({
      headers: { cookie: "owner_session=test" },
      method: "GET",
      url: "/v1/owner/audit/search-activity?surface=mcp&outcome=succeeded",
    });
    expect(response.statusCode).toBe(200);
    const parsed = OwnerAuditSearchListResponseSchema.parse(response.json());
    expect(parsed.items[0]?.surface).toBe("mcp");
    expect(response.body).not.toContain("query");
    expect(response.body).not.toContain("hmac");
    expect(listSearchActivity).toHaveBeenCalledOnce();
  });

  it.each([
    "/v1/owner/audit/actions?owner_id=forged",
    "/v1/owner/audit/actions?limit=01",
    "/v1/owner/audit/actions?outcome=succeeded&outcome=failed",
    "/v1/owner/audit/actions?from=2026-07-24T00%3A00%3A00.000Z&to=2026-07-23T00%3A00%3A00.000Z",
  ])("rejects malformed or forged filters: %s", async (url) => {
    const { app, listActions } = createApp();
    const response = await app.inject({
      headers: { cookie: "owner_session=test" },
      method: "GET",
      url,
    });
    expect(response.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(listActions).not.toHaveBeenCalled();
  });

  it("requires an authenticated, verified, active Owner", async () => {
    const { app, listActions } = createApp({ session: null });
    const response = await app.inject({
      method: "GET",
      url: "/v1/owner/audit/actions",
    });
    expect(response.statusCode).toBe(401);
    expect(listActions).not.toHaveBeenCalled();
  });

  it("maps cursor failures and fails closed on invalid projections", async () => {
    const cursor = createApp({
      thrown: new OwnerAuditError("OWNER_AUDIT_CURSOR_INVALID"),
    });
    const cursorResponse = await cursor.app.inject({
      headers: { cookie: "owner_session=test" },
      method: "GET",
      url: "/v1/owner/audit/actions?cursor=invalid-but-long-enough",
    });
    expect(cursorResponse.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(cursorResponse.json()).error.code).toBe(
      "OWNER_AUDIT_CURSOR_INVALID",
    );

    const invalid = createApp({ invalidProjection: true });
    const invalidResponse = await invalid.app.inject({
      headers: { cookie: "owner_session=test" },
      method: "GET",
      url: "/v1/owner/audit/actions",
    });
    expect(invalidResponse.statusCode).toBe(503);
    expect(invalidResponse.body).not.toContain("INVALID ACTION");
  });
});
