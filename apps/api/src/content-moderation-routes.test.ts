import type {
  AlphaNetAuthRuntime,
  OidcJwtVerifier,
  OwnerSession,
  VerifiedOidcJwtIdentity,
} from "@alphanet/auth";
import {
  AdminModerationCaseDetailResponseSchema,
  AdminModerationCaseListResponseSchema,
  AdminModerationDecisionResponseSchema,
  OwnerContentModerationListResponseSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  ContentModerationError,
  type ContentModerationActionRecord,
  type ContentModerationService,
  type CursorPage,
  type ModerationCaseDetailView,
  type ModerationCaseQueueItem,
  type ModerationCaseSummaryView,
  type ModerationDecisionOutcome,
  type OwnerContentModerationHistoryView,
  type OwnerContentModerationRecord,
} from "@alphanet/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ActiveAdminAuthorizationSnapshot,
  AdminRequestRateLimiter,
  AdminRequestRuntime,
} from "./admin-request.js";
import {
  registerAdminContentModerationRoutes,
  registerOwnerContentModerationRoutes,
} from "./content-moderation-routes.js";

const ids = {
  action: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000002",
  admin: "10000000-0000-4000-8000-000000000003",
  agent: "10000000-0000-4000-8000-000000000004",
  case: "10000000-0000-4000-8000-000000000005",
  content: "10000000-0000-4000-8000-000000000006",
  owner: "10000000-0000-4000-8000-000000000007",
  reporterActor: "10000000-0000-4000-8000-000000000008",
  reporterOwner: "10000000-0000-4000-8000-000000000009",
  report: "10000000-0000-4000-8000-000000000010",
  revision: "10000000-0000-4000-8000-000000000011",
  session: "10000000-0000-4000-8000-000000000012",
  snapshot: "10000000-0000-4000-8000-000000000013",
} as const;
const token = "a.b.c";
const openedAt = new Date("2026-07-21T17:00:00.000Z");
const reportedAt = new Date("2026-07-21T17:30:00.000Z");
const decidedAt = new Date("2026-07-21T18:00:00.000Z");
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

const identity: VerifiedOidcJwtIdentity = {
  issuer: "https://login.alphanet.test/workforce",
  mfa: {
    amrMfa: true,
    matchedAcr: "urn:alphanet:assurance:mfa",
    method: "acr_and_amr_mfa",
  },
  subject: "moderator-01",
};

function caseView(
  overrides: Partial<ModerationCaseSummaryView> = {},
): ModerationCaseSummaryView {
  return {
    author: {
      actorId: ids.actor,
      agentId: ids.agent,
      handle: "market-agent",
      kind: "agent",
    },
    caseId: ids.case,
    contentId: ids.content,
    contentKind: "post",
    contentVersion: 3,
    distributionState: "normal",
    lastReportedAt: reportedAt,
    latestActionId: null,
    lifecycleState: "published",
    openedAt,
    priority: "normal",
    reasonCounts: {
      harassment: 0,
      impersonation: 0,
      malicious_link: 0,
      other_rule_violation: 0,
      privacy_exposure: 0,
      spam: 1,
    },
    reportCount: 1,
    resolutionAction: null,
    resolvedAt: null,
    status: "open",
    updatedAt: reportedAt,
    version: 1,
    ...overrides,
  };
}

function hiddenAction(): ContentModerationActionRecord {
  return {
    action: "hide_content",
    actionVersion: 1,
    caseId: ids.case,
    contentId: ids.content,
    contentLifecycleState: "published",
    contentVersionAfter: 4,
    contentVersionBefore: 3,
    decidedAt,
    decidedByAdminId: ids.admin,
    distributionAfter: "hidden",
    distributionBefore: "normal",
    internalNote: "private evidence note",
    moderationActionId: ids.action,
    reasonCode: "confirmed_report_violation",
    revertedActionId: null,
  };
}

function cursorPage<T>(
  items: T[],
  orderingVersion: string,
  overrides: Partial<CursorPage<T>> = {},
): CursorPage<T> {
  return {
    asOf: decidedAt,
    hasMore: false,
    items,
    limit: 20,
    nextCursor: null,
    orderingVersion,
    snapshotId: ids.snapshot,
    ...overrides,
  };
}

function queuePage(): CursorPage<ModerationCaseQueueItem> {
  return cursorPage([{ ...caseView(), queueRank: 1 }], "moderation-case-live-keyset-v1");
}

function resolvedCase(): ModerationCaseSummaryView {
  return caseView({
    contentVersion: 4,
    distributionState: "hidden",
    latestActionId: ids.action,
    resolutionAction: "hide_content",
    resolvedAt: decidedAt,
    status: "resolved_action",
    updatedAt: decidedAt,
    version: 2,
  });
}

function caseDetail(): ModerationCaseDetailView {
  return {
    actions: cursorPage([hiddenAction()], "moderation-action-list-v1"),
    case: resolvedCase(),
    content: {
      author: caseView().author,
      bodyMarkdown: "Evidence for the market claim.",
      contentId: ids.content,
      createdAt: openedAt,
      currentRevisionId: ids.revision,
      deletedAt: null,
      depth: 0,
      distributionState: "hidden",
      kind: "post",
      lifecycleState: "published",
      parentContentId: null,
      resourceVersion: 4,
      rootContentId: ids.content,
      title: "Market claim",
      updatedAt: decidedAt,
    },
    reports: cursorPage(
      [
        {
          caseId: ids.case,
          contentId: ids.content,
          details: "Repeated links",
          reasonCode: "spam",
          reportId: ids.report,
          reporterActorId: ids.reporterActor,
          reporterOwnerId: ids.reporterOwner,
          resolvedAt: decidedAt,
          status: "resolved_action",
          submittedAt: reportedAt,
          updatedAt: decidedAt,
          version: 2,
        },
      ],
      "moderation-report-list-v1",
    ),
  };
}

function decisionOutcome(replayed = false): ModerationDecisionOutcome {
  return {
    action: hiddenAction(),
    case: resolvedCase(),
    caseVersionBefore: 1,
    content: {
      contentId: ids.content,
      distributionState: "hidden",
      lifecycleState: "published",
      resourceVersion: 4,
    },
    replayed,
  };
}

function allowAllLimiter(): AdminRequestRateLimiter {
  return {
    consume: vi.fn(() => Promise.resolve({ allowed: true, retryAfter: null })),
  };
}

function adminHeaders() {
  return { authorization: `Bearer ${token}` };
}

function createAdminApp(options?: {
  authorization?: ActiveAdminAuthorizationSnapshot | null;
  decideError?: Error;
  detail?: ModerationCaseDetailView;
  list?: CursorPage<ModerationCaseQueueItem>;
  outcome?: ModerationDecisionOutcome;
}) {
  const verify = vi.fn<OidcJwtVerifier["verify"]>(() => Promise.resolve(identity));
  const resolveActiveAuthorization = vi.fn(() =>
    Promise.resolve(
      options?.authorization === undefined
        ? {
            adminId: ids.admin,
            permissions: ["moderation:read", "moderation:decide"] as const,
            roles: ["moderator"],
          }
        : options.authorization,
    ),
  );
  const runtime: AdminRequestRuntime = {
    audit: { recordSecurityRejection: vi.fn(() => Promise.resolve()) },
    identityVerifier: { verify },
    rateLimiter: allowAllLimiter(),
    repository: { resolveActiveAuthorization },
    resolveClientIp: () => "203.0.113.10",
  };
  const listCases = vi.fn<ContentModerationService["listCases"]>(() =>
    Promise.resolve(options?.list ?? queuePage()),
  );
  const getCase = vi.fn<ContentModerationService["getCase"]>(() =>
    Promise.resolve(options?.detail ?? caseDetail()),
  );
  const decideCase = vi.fn<ContentModerationService["decideCase"]>(() => {
    if (options?.decideError) return Promise.reject(options.decideError);
    return Promise.resolve(options?.outcome ?? decisionOutcome());
  });
  const app = Fastify({ logger: false });
  registerAdminContentModerationRoutes(app, {
    adminRuntime: runtime,
    service: { decideCase, getCase, listCases },
  });
  apps.push(app);
  return { app, decideCase, getCase, listCases, resolveActiveAuthorization, verify };
}

const ownerSession: OwnerSession = {
  owner: {
    email: "owner@example.com",
    emailVerified: true,
    id: ids.owner,
    name: "Owner",
    status: "active",
  },
  session: {
    createdAt: openedAt,
    expiresAt: new Date("2026-07-28T17:00:00.000Z"),
    id: ids.session,
  },
};

function ownerHistory(): OwnerContentModerationHistoryView {
  const action = hiddenAction();
  const safeAction: OwnerContentModerationRecord = {
    action: action.action,
    actionVersion: action.actionVersion,
    caseId: action.caseId,
    contentLifecycleState: action.contentLifecycleState,
    contentId: action.contentId,
    contentVersionAfter: action.contentVersionAfter,
    contentVersionBefore: action.contentVersionBefore,
    decidedAt: action.decidedAt,
    distributionAfter: action.distributionAfter,
    distributionBefore: action.distributionBefore,
    moderationActionId: action.moderationActionId,
    reasonCode: action.reasonCode,
    revertedActionId: action.revertedActionId,
  };
  return {
    contentId: ids.content,
    contentVersion: 4,
    distributionState: "hidden",
    page: cursorPage([safeAction], "owner-content-moderation-list-v1"),
  };
}

function createOwnerApp(options?: {
  history?: OwnerContentModerationHistoryView;
  session?: OwnerSession | null;
  thrown?: Error;
}) {
  const getOwnerSession = vi.fn<AlphaNetAuthRuntime["getOwnerSession"]>(() =>
    Promise.resolve(options?.session === undefined ? ownerSession : options.session),
  );
  const listContentActions = vi.fn<ContentModerationService["listContentActions"]>(() => {
    if (options?.thrown) return Promise.reject(options.thrown);
    return Promise.resolve(options?.history ?? ownerHistory());
  });
  const app = Fastify({ logger: false });
  registerOwnerContentModerationRoutes(app, {
    allowedOrigins: ["http://localhost:3101"],
    authRuntime: { getOwnerSession },
    service: { listContentActions },
  });
  apps.push(app);
  return { app, getOwnerSession, listContentActions };
}

describe("Admin content-moderation routes", () => {
  it("lists a strictly filtered queue through workforce OIDC and moderation:read", async () => {
    const { app, listCases, resolveActiveAuthorization, verify } = createAdminApp();
    const response = await app.inject({
      headers: adminHeaders(),
      method: "GET",
      url:
        `/v1/admin/moderation/cases?statuses=open,reviewing&priorities=urgent,high` +
        `&reasons=spam&content_id=${ids.content}&limit=10&cursor=next-page`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    const parsed = AdminModerationCaseListResponseSchema.parse(response.json());
    expect(parsed.items).toHaveLength(1);
    expect(parsed.capabilities).toEqual({ can_decide: true });
    expect(verify).toHaveBeenCalledExactlyOnceWith(token);
    expect(resolveActiveAuthorization).toHaveBeenCalledExactlyOnceWith({
      issuer: identity.issuer,
      subject: identity.subject,
    });
    expect(listCases).toHaveBeenCalledOnce();
    const moderationContext = listCases.mock.calls[0]?.[0];
    expect(moderationContext).toMatchObject({
      adminId: ids.admin,
      authenticationAssurance: "workforce_oidc",
      permission: "moderation:read",
    });
    expect(typeof moderationContext?.requestId).toBe("string");
    expect(listCases.mock.calls[0]?.[1]).toEqual({
      contentId: ids.content,
      cursor: "next-page",
      limit: 10,
      priorities: ["urgent", "high"],
      reasons: ["spam"],
      statuses: ["open", "reviewing"],
    });
  });

  it.each([
    "/v1/admin/moderation/cases?limit=1&limit=2",
    "/v1/admin/moderation/cases?unknown=true",
    "/v1/admin/moderation/cases?statuses=open,,reviewing",
    "/v1/admin/moderation/cases?limit=01",
  ])("rejects non-canonical queue transport: %s", async (url) => {
    const { app, listCases } = createAdminApp();
    const response = await app.inject({ headers: adminHeaders(), method: "GET", url });
    expect(response.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(listCases).not.toHaveBeenCalled();
  });

  it("returns bounded Case evidence with Admin-only identities and internal notes", async () => {
    const { app, getCase } = createAdminApp();
    const response = await app.inject({
      headers: adminHeaders(),
      method: "GET",
      url:
        `/v1/admin/moderation/cases/${ids.case}` +
        "?report_limit=10&report_cursor=reports-next&action_limit=5&action_cursor=actions-next",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    const parsed = AdminModerationCaseDetailResponseSchema.parse(response.json());
    expect(parsed.capabilities).toEqual({ can_decide: true });
    expect(parsed.reports[0]).toMatchObject({
      reporter_actor_id: ids.reporterActor,
      reporter_owner_id: ids.reporterOwner,
    });
    expect(parsed.actions[0]).toMatchObject({
      decided_by_admin_id: ids.admin,
      internal_note: "private evidence note",
    });
    expect(getCase.mock.calls[0]?.[1]).toBe(ids.case);
    expect(getCase.mock.calls[0]?.[2]).toEqual({
      actionCursor: "actions-next",
      actionLimit: 5,
      reportCursor: "reports-next",
      reportLimit: 10,
    });
  });

  it("creates and idempotently replays decisions with strict ETag transport", async () => {
    const created = createAdminApp();
    const request = {
      headers: {
        ...adminHeaders(),
        "idempotency-key": "moderation-decision-01",
        "if-match": '"1"',
      },
      method: "POST" as const,
      payload: {
        action: "hide_content",
        internal_note: "private evidence note",
        reason_code: "confirmed_report_violation",
      },
      url: `/v1/admin/moderation/cases/${ids.case}/actions`,
    };
    const createdResponse = await created.app.inject(request);
    expect(createdResponse.statusCode).toBe(201);
    expect(createdResponse.headers.etag).toBe('"2"');
    expect(createdResponse.headers.location).toBeUndefined();
    expect(
      AdminModerationDecisionResponseSchema.parse(createdResponse.json()).action,
    ).toMatchObject({ action: "hide_content", content_version_after: 4 });
    expect(created.decideCase.mock.calls[0]?.[0]).toMatchObject({
      adminId: ids.admin,
      permission: "moderation:decide",
    });
    expect(created.decideCase.mock.calls[0]?.[2]).toEqual({
      action: "hide_content",
      expectedCaseVersion: 1,
      idempotencyKey: "moderation-decision-01",
      internalNote: "private evidence note",
      reasonCode: "confirmed_report_violation",
    });

    const replay = createAdminApp({ outcome: decisionOutcome(true) });
    const replayResponse = await replay.app.inject(request);
    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.headers.location).toBeUndefined();
  });

  it.each([
    ["missing If-Match", { headers: { ...adminHeaders(), "idempotency-key": "key-01" } }],
    [
      "weak If-Match",
      {
        headers: {
          ...adminHeaders(),
          "idempotency-key": "key-01",
          "if-match": 'W/"1"',
        },
      },
    ],
    [
      "merged idempotency headers",
      {
        headers: {
          ...adminHeaders(),
          "idempotency-key": "key-01,key-02",
          "if-match": '"1"',
        },
      },
    ],
    [
      "transport control in body",
      {
        payload: {
          action: "dismiss",
          case_id: ids.case,
          reason_code: "no_rule_violation",
        },
      },
    ],
    ["query input", { url: `/v1/admin/moderation/cases/${ids.case}/actions?force=true` }],
  ])("rejects %s before deciding", async (_label, override) => {
    const { app, decideCase } = createAdminApp();
    const response = await app.inject({
      headers: {
        ...adminHeaders(),
        "idempotency-key": "key-01",
        "if-match": '"1"',
      },
      method: "POST",
      payload: { action: "dismiss", reason_code: "no_rule_violation" },
      url: `/v1/admin/moderation/cases/${ids.case}/actions`,
      ...override,
    });
    expect(response.statusCode).toBe(422);
    expect(decideCase).not.toHaveBeenCalled();
  });

  it("enforces atomic moderation permissions independently per endpoint", async () => {
    const { app, decideCase, resolveActiveAuthorization } = createAdminApp({
      authorization: {
        adminId: ids.admin,
        permissions: ["moderation:read"],
        roles: ["reviewer"],
      },
    });
    const read = await app.inject({
      headers: adminHeaders(),
      method: "GET",
      url: "/v1/admin/moderation/cases",
    });
    expect(read.statusCode).toBe(200);
    expect(AdminModerationCaseListResponseSchema.parse(read.json()).capabilities).toEqual(
      { can_decide: false },
    );

    const detail = await app.inject({
      headers: adminHeaders(),
      method: "GET",
      url: `/v1/admin/moderation/cases/${ids.case}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(
      AdminModerationCaseDetailResponseSchema.parse(detail.json()).capabilities,
    ).toEqual({ can_decide: false });

    const write = await app.inject({
      headers: {
        ...adminHeaders(),
        "idempotency-key": "key-01",
        "if-match": '"1"',
      },
      method: "POST",
      payload: { action: "dismiss", reason_code: "no_rule_violation" },
      url: `/v1/admin/moderation/cases/${ids.case}/actions`,
    });
    expect(write.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(write.json()).error.code).toBe(
      "ADMIN_PERMISSION_REQUIRED",
    );
    expect(resolveActiveAuthorization).toHaveBeenCalledTimes(3);
    expect(decideCase).not.toHaveBeenCalled();
  });

  it("rechecks moderation:decide after advertising the current read capability", async () => {
    const { app, decideCase, resolveActiveAuthorization } = createAdminApp();
    resolveActiveAuthorization
      .mockResolvedValueOnce({
        adminId: ids.admin,
        permissions: ["moderation:read", "moderation:decide"],
        roles: ["moderator"],
      })
      .mockResolvedValueOnce({
        adminId: ids.admin,
        permissions: ["moderation:read"],
        roles: ["reviewer"],
      });

    const read = await app.inject({
      headers: adminHeaders(),
      method: "GET",
      url: "/v1/admin/moderation/cases",
    });
    expect(read.statusCode).toBe(200);
    expect(AdminModerationCaseListResponseSchema.parse(read.json()).capabilities).toEqual(
      { can_decide: true },
    );

    const write = await app.inject({
      headers: {
        ...adminHeaders(),
        "idempotency-key": "key-after-revocation",
        "if-match": '"1"',
      },
      method: "POST",
      payload: { action: "dismiss", reason_code: "no_rule_violation" },
      url: `/v1/admin/moderation/cases/${ids.case}/actions`,
    });
    expect(write.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(write.json()).error.code).toBe(
      "ADMIN_PERMISSION_REQUIRED",
    );
    expect(resolveActiveAuthorization).toHaveBeenCalledTimes(2);
    expect(decideCase).not.toHaveBeenCalled();
  });

  it("requires workforce authentication before a Case can be observed", async () => {
    const { app, listCases } = createAdminApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/moderation/cases",
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("alphanet-admin");
    expect(listCases).not.toHaveBeenCalled();
  });

  it("maps controlled conflicts with current version and hides unknown failures", async () => {
    const conflict = createAdminApp({
      decideError: new ContentModerationError("CASE_VERSION_CONFLICT", {
        currentVersion: 7,
      }),
    });
    const request = {
      headers: {
        ...adminHeaders(),
        "idempotency-key": "key-01",
        "if-match": '"1"',
      },
      method: "POST" as const,
      payload: { action: "dismiss", reason_code: "no_rule_violation" },
      url: `/v1/admin/moderation/cases/${ids.case}/actions`,
    };
    const conflictResponse = await conflict.app.inject(request);
    expect(conflictResponse.statusCode).toBe(409);
    expect(V1ErrorResponseSchema.parse(conflictResponse.json()).error).toMatchObject({
      code: "CASE_VERSION_CONFLICT",
      details: { current_version: 7 },
    });

    const retryAt = new Date(Date.now() + 60_000);
    const limited = createAdminApp({
      decideError: new ContentModerationError("RATE_LIMITED", { retryAt }),
    });
    const limitedResponse = await limited.app.inject(request);
    expect(limitedResponse.statusCode).toBe(429);
    expect(Number(limitedResponse.headers["retry-after"])).toBeGreaterThan(0);
    expect(V1ErrorResponseSchema.parse(limitedResponse.json()).error).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });

    const unavailable = createAdminApp({
      decideError: new Error("database password=must-not-leak"),
    });
    const unavailableResponse = await unavailable.app.inject(request);
    expect(unavailableResponse.statusCode).toBe(503);
    expect(JSON.stringify(unavailableResponse.json())).not.toContain("must-not-leak");
  });

  it("fails closed if a service projection violates the public schema", async () => {
    const invalidPage = queuePage();
    invalidPage.items[0] = { ...invalidPage.items[0]!, reportCount: 0 };
    const { app } = createAdminApp({ list: invalidPage });
    const response = await app.inject({
      headers: adminHeaders(),
      method: "GET",
      url: "/v1/admin/moderation/cases",
    });
    expect(response.statusCode).toBe(503);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "MODERATION_UNAVAILABLE",
    );
  });
});

describe("Owner content moderation history route", () => {
  it("derives ownership from the session and returns only the redacted projection", async () => {
    const { app, listContentActions } = createOwnerApp();
    const response = await app.inject({
      headers: { cookie: "owner_session=test" },
      method: "GET",
      url: `/v1/owner/content/${ids.content}/moderation-actions?limit=10&cursor=next-page`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(response.headers.etag).toBe('"4"');
    const parsed = OwnerContentModerationListResponseSchema.parse(response.json());
    expect(parsed.items[0]).toMatchObject({
      action: "hide_content",
      content_id: ids.content,
      reason_code: "confirmed_report_violation",
    });
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("decided_by_admin_id");
    expect(serialized).not.toContain("internal_note");
    expect(serialized).not.toContain("reporter_owner_id");
    expect(serialized).not.toContain("private evidence note");
    expect(listContentActions).toHaveBeenCalledExactlyOnceWith(ids.owner, ids.content, {
      cursor: "next-page",
      limit: 10,
    });
  });

  it.each([
    `/v1/owner/content/${ids.content}/moderation-actions?limit=1&limit=2`,
    `/v1/owner/content/${ids.content}/moderation-actions?owner_id=${ids.owner}`,
    `/v1/owner/content/${ids.content}/moderation-actions?limit=0`,
  ])("rejects non-canonical Owner history transport: %s", async (url) => {
    const { app, listContentActions } = createOwnerApp();
    const response = await app.inject({
      headers: { cookie: "owner_session=test" },
      method: "GET",
      url,
    });
    expect(response.statusCode).toBe(422);
    expect(listContentActions).not.toHaveBeenCalled();
  });

  it("does not reveal whether content exists without an authenticated Owner", async () => {
    const { app, listContentActions } = createOwnerApp({ session: null });
    const response = await app.inject({
      method: "GET",
      url: `/v1/owner/content/${ids.content}/moderation-actions`,
    });
    expect(response.statusCode).toBe(401);
    expect(listContentActions).not.toHaveBeenCalled();
  });

  it("maps ownership failures and fails closed on malformed projections", async () => {
    const missing = createOwnerApp({
      thrown: new ContentModerationError("OWNER_CONTENT_NOT_FOUND"),
    });
    const missingResponse = await missing.app.inject({
      headers: { cookie: "owner_session=test" },
      method: "GET",
      url: `/v1/owner/content/${ids.content}/moderation-actions`,
    });
    expect(missingResponse.statusCode).toBe(404);

    const invalid = createOwnerApp({
      history: { ...ownerHistory(), contentVersion: 0 },
    });
    const invalidResponse = await invalid.app.inject({
      headers: { cookie: "owner_session=test" },
      method: "GET",
      url: `/v1/owner/content/${ids.content}/moderation-actions`,
    });
    expect(invalidResponse.statusCode).toBe(503);
    expect(V1ErrorResponseSchema.parse(invalidResponse.json()).error.code).toBe(
      "MODERATION_UNAVAILABLE",
    );
  });
});
