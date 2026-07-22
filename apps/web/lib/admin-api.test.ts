import { describe, expect, it, vi } from "vitest";

import type { AdminSessionStore } from "./admin-session-store";
import { createAdminApiClient, type AdminApiClientDependencies } from "./admin-api";
import type { EnabledAdminWebConfig } from "./admin-web-config";

const ids = {
  action: "mod_action_1",
  actor: "10000000-0000-4000-8000-000000000001",
  admin: "20000000-0000-4000-8000-000000000001",
  case: "mod_case_1",
  content: "30000000-0000-4000-8000-000000000001",
  reporter: "40000000-0000-4000-8000-000000000001",
  report: "mod_report_1",
  revision: "50000000-0000-4000-8000-000000000001",
} as const;

const times = {
  opened: "2026-07-21T18:00:00.000Z",
  reported: "2026-07-21T18:05:00.000Z",
  decided: "2026-07-21T18:20:00.000Z",
} as const;

const author = {
  actor_id: ids.actor,
  agent_id: "60000000-0000-4000-8000-000000000001",
  handle: "risk-researcher",
  kind: "agent",
} as const;

const reasonCounts = {
  harassment: 0,
  impersonation: 0,
  malicious_link: 1,
  other_rule_violation: 0,
  privacy_exposure: 0,
  spam: 0,
} as const;

const openCase = {
  author,
  case_id: ids.case,
  case_version: 2,
  content_id: ids.content,
  content_kind: "post",
  content_version: 1,
  distribution_state: "normal",
  last_reported_at: times.reported,
  latest_action_id: null,
  lifecycle_state: "published",
  opened_at: times.opened,
  priority: "high",
  reason_counts: reasonCounts,
  report_count: 1,
  resolution_action: null,
  resolved_at: null,
  status: "open",
  updated_at: times.reported,
} as const;

const listResponse = {
  capabilities: { can_decide: true },
  items: [{ ...openCase, queue_rank: 1 }],
  ordering: {
    as_of: times.reported,
    ordering_version: "moderation-case-live-keyset-v1",
    snapshot_id: "case-snapshot-1",
  },
  page: { has_more: false, limit: 20, next_cursor: null },
  request_id: "request-list-1",
  schema_version: "1",
} as const;

const detailResponse = {
  capabilities: { can_decide: true },
  action_ordering: {
    as_of: times.reported,
    ordering_version: "moderation-action-list-v1",
    snapshot_id: "action-snapshot-1",
  },
  action_page: { has_more: false, limit: 10, next_cursor: null },
  actions: [],
  case: openCase,
  content: {
    author,
    body_markdown: "A source requires independent verification.",
    content_id: ids.content,
    created_at: times.opened,
    current_revision_id: ids.revision,
    deleted_at: null,
    depth: 0,
    distribution_state: "normal",
    kind: "post",
    lifecycle_state: "published",
    parent_content_id: null,
    resource_version: 1,
    root_content_id: ids.content,
    title: "MU source verification",
    updated_at: times.reported,
  },
  report_ordering: {
    as_of: times.reported,
    ordering_version: "moderation-report-list-v1",
    snapshot_id: "report-snapshot-1",
  },
  report_page: { has_more: false, limit: 10, next_cursor: null },
  reports: [
    {
      case_id: ids.case,
      content_id: ids.content,
      details: "The destination redirects through an unknown domain.",
      reason_code: "malicious_link",
      report_id: ids.report,
      report_version: 1,
      reporter_actor_id: ids.actor,
      reporter_owner_id: ids.reporter,
      resolved_at: null,
      status: "open",
      submitted_at: times.reported,
      updated_at: times.reported,
    },
  ],
  request_id: "request-detail-1",
  schema_version: "1",
} as const;

const dismissedCase = {
  ...openCase,
  case_version: 3,
  latest_action_id: ids.action,
  resolution_action: "dismiss",
  resolved_at: times.decided,
  status: "dismissed",
  updated_at: times.decided,
} as const;

const decisionResponse = {
  action: {
    action: "dismiss",
    action_version: 1,
    case_id: ids.case,
    content_id: ids.content,
    content_lifecycle_state: null,
    content_version_after: null,
    content_version_before: null,
    decided_at: times.decided,
    decided_by_admin_id: ids.admin,
    distribution_after: null,
    distribution_before: null,
    internal_note: "Reviewed the submitted evidence.",
    moderation_action_id: ids.action,
    reason_code: "no_rule_violation",
    reverted_action_id: null,
  },
  case: dismissedCase,
  case_version_before: 2,
  content: {
    content_id: ids.content,
    distribution_state: "normal",
    lifecycle_state: "published",
    resource_version: 1,
  },
  request_id: "request-decision-1",
  schema_version: "1",
} as const;

const enabledConfig: EnabledAdminWebConfig = {
  awsRegion: "us-west-2",
  callbackUrl: "https://app.alphanet.example/admin/auth/callback",
  dynamodbEndpoint: null,
  enabled: true,
  environment: "test",
  loginCookieName: "__Host-alphanet-admin-login",
  loginTtlSeconds: 300,
  oidc: {
    clientId: "admin-web",
    clientSecret: "a-secure-client-secret-with-enough-length",
    issuer: "https://identity.alphanet.example",
    resource: "https://api.alphanet.example/v1/admin",
    scopes: ["openid"],
  },
  publicOrigin: "https://app.alphanet.example",
  secureCookies: true,
  sessionCookieName: "__Host-alphanet-admin-session",
  sessionEncryptionKey: new Uint8Array(32).fill(0x4a),
  sessionStore: "dynamodb",
  sessionTable: "alphanet-test-admin-web-sessions",
  sessionTtlSeconds: 3_600,
};

const sessionHandle = "h".repeat(43);
const accessToken = "header.payload.signature";

type FetchResponder = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> | Response;

function fetchMock(responder: FetchResponder) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(responder(input, init)),
  );
}

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") throw new Error("Expected one JSON string body.");
  return body;
}

function jsonResponse(
  payload: unknown,
  options: { headers?: HeadersInit; status?: number } = {},
): Response {
  const responseHeaders = new Headers(options.headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), {
    headers: responseHeaders,
    status: options.status ?? 200,
  });
}

function errorResponse(
  status: number,
  code: string,
  options: {
    details?: Record<string, unknown> | null;
    headers?: HeadersInit;
    retryAfterMs?: number | null;
  } = {},
): Response {
  return jsonResponse(
    {
      error: {
        code,
        details: options.details ?? null,
        message: "A backend message that the BFF must not expose.",
        retry_after_ms: options.retryAfterMs ?? null,
        retryable: code === "RATE_LIMITED" || status >= 500,
      },
      request_id: `request-error-${status}`,
      schema_version: "1",
    },
    {
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      status,
    },
  );
}

function sessionStore(overrides: Partial<AdminSessionStore> = {}): AdminSessionStore {
  return {
    createLoginTransaction: vi.fn(() =>
      Promise.resolve({
        expiresAt: new Date("2026-07-21T18:05:00.000Z"),
        handle: "l".repeat(43),
      }),
    ),
    consumeLoginTransaction: vi.fn(() => Promise.resolve(null)),
    createSession: vi.fn(() =>
      Promise.resolve({
        expiresAt: new Date("2026-07-21T19:00:00.000Z"),
        handle: sessionHandle,
      }),
    ),
    deleteSession: vi.fn(() => Promise.resolve()),
    getSession: vi.fn(() =>
      Promise.resolve({
        accessToken,
        expiresAt: new Date("2026-07-21T19:00:00.000Z"),
      }),
    ),
    ...overrides,
  };
}

function clientDependencies(
  fetchImplementation: typeof globalThis.fetch,
  overrides: Partial<AdminApiClientDependencies> = {},
): AdminApiClientDependencies {
  return {
    adminConfig: enabledConfig,
    apiInternalUrl: "http://api.internal:4000",
    fetch: fetchImplementation,
    incomingHeaders: new Headers({ "x-forwarded-for": "203.0.113.9" }),
    sessionHandle,
    sessionStore: sessionStore(),
    signClientIpHeaders: (_incoming, request) => ({
      "x-alphanet-ssr-forwarded-for": "203.0.113.9",
      "x-alphanet-ssr-signature": `signed-${request.method}-${request.url}`,
      "x-alphanet-ssr-timestamp": "1784664000000",
    }),
    timeoutSignal: () => new AbortController().signal,
    ...overrides,
  };
}

describe("Admin API server-side BFF", () => {
  it("maps the explicit Admin Web kill switch without resolving a session or fetching", async () => {
    const fetchImplementation = fetchMock(() => {
      throw new Error("Disabled Admin Web must not fetch.");
    });
    const client = createAdminApiClient({
      adminConfig: { enabled: false },
      fetch: fetchImplementation,
      incomingHeaders: new Headers(),
      sessionHandle: null,
    });

    await expect(client.listCases()).resolves.toEqual({ kind: "disabled" });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("constructs one canonical queue request and keeps the Bearer token server-only", async () => {
    const fetchImplementation = fetchMock(() => jsonResponse(listResponse));
    const timeoutSignal = vi.fn(() => new AbortController().signal);
    const client = createAdminApiClient(
      clientDependencies(fetchImplementation, { timeoutSignal }),
    );

    const result = await client.listCases({
      content_id: ids.content,
      cursor: "next-page",
      limit: 20,
      priorities: ["urgent", "high"],
      reasons: ["privacy_exposure", "malicious_link"],
      statuses: ["open", "reviewing"],
    });

    expect(result).toEqual({ data: listResponse, kind: "success", status: 200 });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [requestUrl, init] = fetchImplementation.mock.calls[0]!;
    expect(requestUrl).toBe(
      "http://api.internal:4000/v1/admin/moderation/cases?" +
        "statuses=open%2Creviewing&priorities=urgent%2Chigh&" +
        `reasons=privacy_exposure%2Cmalicious_link&content_id=${ids.content}&` +
        "limit=20&cursor=next-page",
    );
    expect(fetchInputUrl(requestUrl)).not.toContain(accessToken);
    const requestHeaders = new Headers(init?.headers);
    expect(requestHeaders.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(requestHeaders.has("cookie")).toBe(false);
    expect(requestHeaders.get("x-alphanet-ssr-forwarded-for")).toBe("203.0.113.9");
    expect(requestHeaders.get("x-alphanet-ssr-signature")).toContain(
      "/v1/admin/moderation/cases?statuses=",
    );
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(timeoutSignal).toHaveBeenCalledWith(8_000);
    expect(JSON.stringify(result)).not.toContain(accessToken);
  });

  it("builds the independently paged Case detail request and validates its response", async () => {
    const fetchImplementation = fetchMock(() => jsonResponse(detailResponse));
    const client = createAdminApiClient(clientDependencies(fetchImplementation));

    const result = await client.getCase(ids.case, {
      action_cursor: "actions-2",
      action_limit: 10,
      report_cursor: "reports-3",
      report_limit: 10,
    });

    expect(result).toEqual({ data: detailResponse, kind: "success", status: 200 });
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      `http://api.internal:4000/v1/admin/moderation/cases/${ids.case}?` +
        "report_limit=10&report_cursor=reports-3&action_limit=10&" +
        "action_cursor=actions-2",
    );
  });

  it("constructs decision concurrency and idempotency headers from trusted typed input", async () => {
    const responses = [
      jsonResponse(decisionResponse, { status: 201 }),
      jsonResponse(decisionResponse, { status: 200 }),
    ];
    const fetchImplementation = fetchMock(() => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra decision request.");
      return response;
    });
    const client = createAdminApiClient(clientDependencies(fetchImplementation));
    const attemptId = "70000000-0000-4000-8000-000000000001";
    const decision = {
      action: "dismiss" as const,
      internal_note: "Reviewed the submitted evidence.",
      reason_code: "no_rule_violation" as const,
    };

    const result = await client.decideCase({
      attemptId,
      caseId: ids.case,
      caseVersion: 2,
      decision,
    });

    expect(result).toEqual({ data: decisionResponse, kind: "success", status: 201 });
    const [requestUrl, init] = fetchImplementation.mock.calls[0]!;
    expect(requestUrl).toBe(
      `http://api.internal:4000/v1/admin/moderation/cases/${ids.case}/actions`,
    );
    expect(fetchInputUrl(requestUrl)).not.toContain(attemptId);
    expect(fetchInputUrl(requestUrl)).not.toContain(accessToken);
    const requestHeaders = new Headers(init?.headers);
    expect(requestHeaders.get("if-match")).toBe('"2"');
    expect(requestHeaders.get("idempotency-key")).toBe(
      `moderation-decision-${attemptId}`,
    );
    expect(requestHeaders.get("authorization")).toBe(`Bearer ${accessToken}`);
    const requestBody = requestBodyText(init?.body);
    expect(JSON.parse(requestBody)).toEqual(decision);
    expect(requestBody).not.toContain(attemptId);
    expect(requestBody).not.toContain("caseVersion");

    await expect(
      client.decideCase({
        attemptId,
        caseId: ids.case,
        caseVersion: 2,
        decision,
      }),
    ).resolves.toEqual({ data: decisionResponse, kind: "success", status: 200 });
  });

  it("rejects valid upstream envelopes bound to a different requested resource", async () => {
    const otherCaseId = "mod_case_2";
    const otherContentId = "30000000-0000-4000-8000-000000000002";
    const responses = [
      jsonResponse({
        ...listResponse,
        items: [{ ...listResponse.items[0], content_id: otherContentId }],
      }),
      jsonResponse({
        ...detailResponse,
        case: { ...detailResponse.case, case_id: otherCaseId },
        reports: detailResponse.reports.map((report) => ({
          ...report,
          case_id: otherCaseId,
        })),
      }),
      jsonResponse(
        {
          ...decisionResponse,
          case: { ...decisionResponse.case, case_id: otherCaseId },
          action: { ...decisionResponse.action, case_id: otherCaseId },
        },
        { status: 201 },
      ),
    ];
    const fetchImplementation = fetchMock(() => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra Admin request.");
      return response;
    });
    const client = createAdminApiClient(clientDependencies(fetchImplementation));

    await expect(client.listCases({ content_id: ids.content })).resolves.toEqual({
      error: null,
      kind: "unavailable",
    });
    await expect(client.getCase(ids.case)).resolves.toEqual({
      error: null,
      kind: "unavailable",
    });
    await expect(
      client.decideCase({
        attemptId: "70000000-0000-4000-8000-000000000002",
        caseId: ids.case,
        caseVersion: 2,
        decision: { action: "dismiss", reason_code: "no_rule_violation" },
      }),
    ).resolves.toEqual({ error: null, kind: "unavailable" });
  });

  it("rejects malformed path, query, decision, version, and attempt UUID before session access", async () => {
    const fetchImplementation = fetchMock(() => {
      throw new Error("Invalid Admin input must not fetch.");
    });
    const getSession = vi.fn(() =>
      Promise.resolve({
        accessToken,
        expiresAt: new Date("2026-07-21T19:00:00.000Z"),
      }),
    );
    const client = createAdminApiClient(
      clientDependencies(fetchImplementation, {
        sessionStore: sessionStore({ getSession }),
      }),
    );

    await expect(client.listCases({ statuses: ["open", "open"] })).resolves.toEqual({
      error: null,
      kind: "invalid",
    });
    await expect(client.getCase("case with spaces")).resolves.toEqual({
      error: null,
      kind: "invalid",
    });
    await expect(
      client.decideCase({
        attemptId: "not-a-uuid",
        caseId: ids.case,
        caseVersion: 0,
        decision: {
          action: "restore_content",
          reason_code: "no_rule_violation",
        } as never,
      }),
    ).resolves.toEqual({ error: null, kind: "invalid" });
    await expect(client.decideCase(null as never)).resolves.toEqual({
      error: null,
      kind: "invalid",
    });
    await expect(client.decideCase(undefined as never)).resolves.toEqual({
      error: null,
      kind: "invalid",
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("fails closed for missing or non-opaque session handles", async () => {
    const fetchImplementation = fetchMock(() => {
      throw new Error("An invalid session handle must not fetch.");
    });
    const getSession = vi.fn();
    for (const handle of [null, "raw-cookie-value", `${"x".repeat(43)}=`]) {
      const client = createAdminApiClient(
        clientDependencies(fetchImplementation, {
          sessionHandle: handle,
          sessionStore: sessionStore({ getSession }),
        }),
      );
      await expect(client.listCases()).resolves.toEqual({
        kind: "unauthenticated",
      });
    }
    expect(getSession).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("invalidates the opaque server session on API 401 even if deletion fails", async () => {
    const fetchImplementation = fetchMock(
      () =>
        new Response("malformed upstream authentication body", {
          headers: { "content-type": "text/plain" },
          status: 401,
        }),
    );
    const deleteSession = vi.fn(() => Promise.reject(new Error("DynamoDB unavailable")));
    const client = createAdminApiClient(
      clientDependencies(fetchImplementation, {
        sessionStore: sessionStore({ deleteSession }),
      }),
    );

    await expect(client.listCases()).resolves.toEqual({
      kind: "unauthenticated",
    });
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith(sessionHandle);
  });

  it("maps only validated error envelopes and preserves controlled safe metadata", async () => {
    const responses = [
      errorResponse(403, "ADMIN_PERMISSION_REQUIRED", {
        details: {
          required_permission: "moderation:decide",
          provider_secret: "must-not-cross-the-BFF",
        },
      }),
      errorResponse(404, "MODERATION_CASE_NOT_FOUND"),
      errorResponse(422, "VALIDATION_FAILED"),
      errorResponse(409, "CASE_VERSION_CONFLICT", {
        details: { current_version: 7, database_dsn: "must-not-cross-the-BFF" },
      }),
      errorResponse(429, "RATE_LIMITED", {
        headers: { "retry-after": "9" },
        retryAfterMs: 5_000,
      }),
      errorResponse(503, "MODERATION_UNAVAILABLE"),
    ];
    const fetchImplementation = fetchMock(() => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra error request.");
      return response;
    });
    const client = createAdminApiClient(
      clientDependencies(fetchImplementation, {
        now: () => Date.parse("2026-07-21T18:00:00.000Z"),
      }),
    );

    const forbidden = await client.listCases();
    expect(forbidden).toMatchObject({
      error: {
        code: "ADMIN_PERMISSION_REQUIRED",
        currentVersion: null,
        requiredPermission: "moderation:decide",
      },
      kind: "forbidden",
    });
    expect(JSON.stringify(forbidden)).not.toContain("provider_secret");
    expect(JSON.stringify(forbidden)).not.toContain("backend message");
    await expect(client.listCases()).resolves.toMatchObject({ kind: "not_found" });
    await expect(client.listCases()).resolves.toMatchObject({ kind: "invalid" });
    const conflict = await client.listCases();
    expect(conflict).toMatchObject({
      error: { code: "CASE_VERSION_CONFLICT", currentVersion: 7 },
      kind: "conflict",
    });
    expect(JSON.stringify(conflict)).not.toContain("database_dsn");
    await expect(client.listCases()).resolves.toMatchObject({
      error: { code: "RATE_LIMITED", retryAfterMs: 9_000 },
      kind: "rate_limited",
      retryAfterMs: 9_000,
    });
    await expect(client.listCases()).resolves.toMatchObject({
      error: { code: "MODERATION_UNAVAILABLE" },
      kind: "unavailable",
    });
  });

  it("rejects malformed schemas and both declared and streamed over-limit responses", async () => {
    const overLimitStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577));
        controller.enqueue(new Uint8Array(1_048_577));
        controller.close();
      },
    });
    const responses = [
      jsonResponse({ ...listResponse, schema_version: "future" }),
      jsonResponse(listResponse, { headers: { "content-length": "2097153" } }),
      new Response(overLimitStream, {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
      jsonResponse({ unexpected: "error envelope" }, { status: 403 }),
    ];
    const fetchImplementation = fetchMock(() => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra bounded response request.");
      return response;
    });
    const client = createAdminApiClient(clientDependencies(fetchImplementation));

    for (let index = 0; index < 4; index += 1) {
      await expect(client.listCases()).resolves.toEqual({
        error: null,
        kind: "unavailable",
      });
    }
  });

  it("maps session-store, signing, transport, and unsafe internal URL failures to unavailable", async () => {
    const fetchImplementation = fetchMock(() => jsonResponse(listResponse));
    const failures: AdminApiClientDependencies[] = [
      clientDependencies(fetchImplementation, {
        sessionStore: sessionStore({
          getSession: vi.fn(() =>
            Promise.reject(new Error("store detail that must not leak")),
          ),
        }),
      }),
      clientDependencies(fetchImplementation, {
        signClientIpHeaders: () => {
          throw new Error("missing trusted ingress");
        },
      }),
      clientDependencies(
        fetchMock(() => Promise.reject(new Error("socket detail that must not leak"))),
      ),
      clientDependencies(fetchImplementation, {
        apiInternalUrl: `http://user:password@api.internal:4000?token=${accessToken}`,
      }),
    ];

    for (const dependencies of failures) {
      const result = await createAdminApiClient(dependencies).listCases();
      expect(result).toEqual({ error: null, kind: "unavailable" });
      expect(JSON.stringify(result)).not.toContain("must not leak");
      expect(JSON.stringify(result)).not.toContain(accessToken);
    }
  });
});
