import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AlphaNetAuthRuntime,
  OwnerSession,
  RemoteMcpOAuthConsentService,
} from "@alphanet/auth";
import { V1ErrorResponseSchema } from "@alphanet/contracts";
import type {
  ContentModerationService,
  ContentReadService,
  ContentReportService,
  ContentSearchService,
  FollowService,
  OwnerPendingActionService,
} from "@alphanet/domain";
import type { FastifyBaseLogger } from "fastify";

import { createApiApp } from "./app.js";

const apps: Awaited<ReturnType<typeof createApiApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function createAuthRuntime(options?: {
  checkReady?: () => Promise<void>;
  getOwnerSession?: () => Promise<OwnerSession | null>;
  googleEnabled?: boolean;
  handler?: (request: Request) => Promise<Response>;
  ownerSession?: OwnerSession | null;
}): {
  close: ReturnType<typeof vi.fn>;
  getOwnerSession: ReturnType<typeof vi.fn>;
  handler: ReturnType<typeof vi.fn>;
  runtime: AlphaNetAuthRuntime;
} {
  const handler = vi.fn(
    options?.handler ??
      (() =>
        Promise.resolve(
          Response.json({
            ok: true,
          }),
        )),
  );
  const close = vi.fn(() => Promise.resolve());
  const getOwnerSession = vi.fn(
    options?.getOwnerSession ?? (() => Promise.resolve(options?.ownerSession ?? null)),
  );
  const runtime = {
    auth: { handler },
    baseUrl: "https://api.alphanet.test",
    checkReady: vi.fn(options?.checkReady ?? (() => Promise.resolve())),
    close,
    getOwnerSession,
    googleEnabled: options?.googleEnabled ?? false,
    handle: handler,
  } as unknown as AlphaNetAuthRuntime;

  return { close, getOwnerSession, handler, runtime };
}

function createCapturingLogger(entries: unknown[][]): FastifyBaseLogger {
  const record = (...arguments_: unknown[]) => {
    entries.push(arguments_);
  };
  const logger = {
    child: (...arguments_: unknown[]) => {
      entries.push(["child", ...arguments_]);
      return logger;
    },
    debug: record,
    error: record,
    fatal: record,
    info: record,
    level: "info",
    silent: () => undefined,
    trace: record,
    warn: record,
  };
  return logger;
}

function createOwnerPendingActionService(options?: {
  checkReady?: () => Promise<void>;
}): OwnerPendingActionService & {
  approveAction: ReturnType<typeof vi.fn>;
  checkReady: ReturnType<typeof vi.fn>;
  getAction: ReturnType<typeof vi.fn>;
  listActions: ReturnType<typeof vi.fn>;
  rejectAction: ReturnType<typeof vi.fn>;
} {
  return {
    approveAction: vi.fn(() => Promise.reject(new Error("unexpected approval"))),
    checkReady: vi.fn(options?.checkReady ?? (() => Promise.resolve())),
    getAction: vi.fn(() => Promise.reject(new Error("unexpected detail read"))),
    listActions: vi.fn(() => Promise.reject(new Error("unexpected list read"))),
    rejectAction: vi.fn(() => Promise.reject(new Error("unexpected rejection"))),
  };
}

function createContentReadService(): ContentReadService & {
  browseContent: ReturnType<typeof vi.fn>;
  checkReady: ReturnType<typeof vi.fn>;
} {
  const now = new Date("2026-07-20T20:00:00.000Z");
  return {
    browseContent: vi.fn(() =>
      Promise.resolve({
        countsAsOf: now,
        items: [],
        page: { hasMore: false, limit: 20, nextCursor: null },
        ranking: {
          asOf: now,
          expiresAt: new Date(now.valueOf() + 15 * 60_000),
          rankingVersion: "content-read-v1:latest",
          snapshotId: "crs_00000000000000000000000000000000",
        },
      }),
    ),
    checkReady: vi.fn(() => Promise.resolve()),
    getContent: vi.fn(() => Promise.reject(new Error("unexpected content read"))),
    getDiscussion: vi.fn(() => Promise.reject(new Error("unexpected discussion read"))),
  };
}

function createContentReportService(): ContentReportService & {
  checkReady: ReturnType<typeof vi.fn>;
  createReport: ReturnType<typeof vi.fn>;
} {
  return {
    checkReady: vi.fn(() => Promise.resolve()),
    createReport: vi.fn(() => Promise.reject(new Error("unexpected Content report"))),
  };
}

function createContentModerationService(): ContentModerationService & {
  checkReady: ReturnType<typeof vi.fn>;
  listCases: ReturnType<typeof vi.fn>;
  listContentActions: ReturnType<typeof vi.fn>;
} {
  return {
    checkReady: vi.fn(() => Promise.resolve()),
    decideCase: vi.fn(() => Promise.reject(new Error("unexpected decision"))),
    getCase: vi.fn(() => Promise.reject(new Error("unexpected Case read"))),
    listCases: vi.fn(() => Promise.reject(new Error("unexpected Case list"))),
    listContentActions: vi.fn(() =>
      Promise.reject(new Error("unexpected Owner moderation history")),
    ),
  };
}

function createFollowService(): FollowService & {
  checkReady: ReturnType<typeof vi.fn>;
  listFollows: ReturnType<typeof vi.fn>;
  setFollow: ReturnType<typeof vi.fn>;
} {
  return {
    checkReady: vi.fn(() => Promise.resolve()),
    listFollows: vi.fn(() => Promise.reject(new Error("unexpected Follow list"))),
    setFollow: vi.fn(() => Promise.reject(new Error("unexpected Follow write"))),
  };
}

function createContentSearchService(): ContentSearchService & {
  checkReady: ReturnType<typeof vi.fn>;
  searchContent: ReturnType<typeof vi.fn>;
} {
  return {
    checkReady: vi.fn(() => Promise.resolve()),
    searchContent: vi.fn(() => Promise.reject(new Error("unexpected Content Search"))),
  };
}

function createRemoteMcpOAuthConsentService(): Pick<
  RemoteMcpOAuthConsentService,
  "loadConsentRequest" | "resolveContinuationHandle" | "selectAgentAndPrepareGrant"
> {
  return {
    loadConsentRequest: vi.fn(() =>
      Promise.reject(new Error("unexpected consent inspection")),
    ),
    resolveContinuationHandle: vi.fn(() =>
      Promise.reject(new Error("unexpected continuation resolution")),
    ),
    selectAgentAndPrepareGrant: vi.fn(() =>
      Promise.reject(new Error("unexpected Agent selection")),
    ),
  };
}

describe("API service", () => {
  it("reports liveness without depending on infrastructure", async () => {
    const app = await createApiApp({
      allowedOrigins: ["http://localhost:3000"],
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "api",
      version: "test-version",
    });
  });

  it("allows configured browser clients to preflight Reaction PUT requests", async () => {
    const origin = "https://app.alphanet.test";
    const app = await createApiApp({
      allowedOrigins: [origin],
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      headers: {
        origin,
        "access-control-request-headers": "authorization,content-type,idempotency-key",
        "access-control-request-method": "PUT",
      },
      method: "OPTIONS",
      url: "/v1/content/50000000-0000-4000-8000-000000000001/reactions/helpful",
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers["access-control-allow-methods"]?.split(/,\s*/u)).toContain(
      "PUT",
    );
    expect(response.headers["access-control-allow-headers"]?.toLowerCase()).toContain(
      "idempotency-key",
    );
  });

  it("fails readiness without exposing connection details", async () => {
    const close = vi.fn(() => Promise.resolve());
    const app = await createApiApp({
      allowedOrigins: ["http://localhost:3000"],
      dependencies: [
        {
          name: "postgres",
          check: () =>
            Promise.reject(new Error("postgres://user:secret@example.invalid/database")),
          close,
        },
      ],
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("secret");
    expect(response.json()).toMatchObject({
      status: "degraded",
      failedDependencies: ["postgres"],
    });
  });

  it("reports an optional dependency failure without withdrawing readiness", async () => {
    const app = await createApiApp({
      allowedOrigins: ["http://localhost:3000"],
      dependencies: [
        {
          critical: false,
          name: "redis",
          check: () => Promise.reject(new Error("unavailable")),
          close: () => Promise.resolve(),
        },
      ],
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "degraded",
      failedDependencies: ["redis"],
    });
  });

  it("withdraws readiness when authentication Redis is unavailable", async () => {
    const app = await createApiApp({
      allowedOrigins: ["http://localhost:3000"],
      dependencies: [
        {
          critical: true,
          name: "redis",
          check: () => Promise.reject(new Error("unavailable")),
          close: () => Promise.resolve(),
        },
      ],
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      failedDependencies: ["redis"],
    });
  });

  it("withdraws readiness when the Owner authentication schema is missing", async () => {
    const auth = createAuthRuntime({
      checkReady: () => Promise.reject(new Error("missing auth.users")),
    });
    const app = await createApiApp({
      allowedOrigins: ["http://localhost:3000"],
      authRuntime: auth.runtime,
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("auth.users");
    expect(response.json()).toMatchObject({
      status: "degraded",
      failedDependencies: ["auth-schema"],
    });
  });

  it("checks the Owner pending-action service during readiness", async () => {
    const service = createOwnerPendingActionService();
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      environment: "test",
      ownerPendingActionService: service,
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(service.checkReady).toHaveBeenCalledOnce();
  });

  it("registers public Content reads and includes their schema in readiness", async () => {
    const service = createContentReadService();
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      contentReadService: service,
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const readiness = await app.inject({ method: "GET", url: "/health/ready" });
    const browse = await app.inject({
      method: "GET",
      url: "/v1/public/content?scope=global&sort=latest",
    });

    expect(readiness.statusCode).toBe(200);
    expect(service.checkReady).toHaveBeenCalledOnce();
    expect(browse.statusCode).toBe(200);
    expect(browse.headers["cache-control"]).toBe("no-store");
    expect(browse.json()).toMatchObject({
      items: [],
      page: { has_more: false, limit: 20, next_cursor: null },
      ranking: { ranking_version: "content-read-v1:latest" },
    });
  });

  it("includes the Owner Content reporting schema in readiness", async () => {
    const service = createContentReportService();
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      contentReportService: service,
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(service.checkReady).toHaveBeenCalledOnce();
  });

  it("includes the Content moderation schema in readiness", async () => {
    const service = createContentModerationService();
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      contentModerationService: service,
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(service.checkReady).toHaveBeenCalledOnce();
  });

  it("keeps Admin and Owner moderation routes closed without their distinct authentication runtimes", async () => {
    const service = createContentModerationService();
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      contentModerationService: service,
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const [admin, owner] = await Promise.all([
      app.inject({ method: "GET", url: "/v1/admin/moderation/cases" }),
      app.inject({
        method: "GET",
        url: "/v1/owner/content/50000000-0000-4000-8000-000000000001/moderation-actions",
      }),
    ]);

    expect(admin.statusCode).toBe(404);
    expect(owner.statusCode).toBe(404);
    expect(service.listCases).not.toHaveBeenCalled();
    expect(service.listContentActions).not.toHaveBeenCalled();
  });

  it("includes the wired Content Search schema in readiness", async () => {
    const service = createContentSearchService();
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      contentSearchService: service,
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(service.checkReady).toHaveBeenCalledOnce();
  });

  it("includes the wired Follow schema in readiness", async () => {
    const service = createFollowService();
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      environment: "test",
      followService: service,
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(service.checkReady).toHaveBeenCalledOnce();
  });

  it.each([
    { includeAuth: false, includeService: true },
    { includeAuth: true, includeService: false },
  ])(
    "does not register Owner pending-action routes without both dependencies: %o",
    async ({ includeAuth, includeService }) => {
      const auth = createAuthRuntime();
      const service = createOwnerPendingActionService();
      const app = await createApiApp({
        allowedOrigins: ["https://app.alphanet.test"],
        ...(includeAuth ? { authRuntime: auth.runtime } : {}),
        environment: "test",
        ...(includeService ? { ownerPendingActionService: service } : {}),
        version: "test-version",
      });
      apps.push(app);

      const response = await app.inject({
        method: "GET",
        url: "/v1/owner/pending-actions",
      });

      expect(response.statusCode).toBe(404);
      expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
        "ROUTE_NOT_FOUND",
      );
      expect(auth.getOwnerSession).not.toHaveBeenCalled();
      expect(service.listActions).not.toHaveBeenCalled();
    },
  );

  it("registers Owner pending-action routes and authenticates before JSON parsing", async () => {
    const auth = createAuthRuntime();
    const service = createOwnerPendingActionService();
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      authRuntime: auth.runtime,
      environment: "test",
      ownerPendingActionService: service,
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: "{",
      url: "/v1/owner/pending-actions/action_01/approve",
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "AUTHENTICATION_REQUIRED",
    );
    expect(auth.getOwnerSession).toHaveBeenCalledOnce();
    expect(service.approveAction).not.toHaveBeenCalled();
  });

  it.each([
    { includeAuth: false, includeConsent: true },
    { includeAuth: true, includeConsent: false },
  ])(
    "keeps dark-launched Owner OAuth consent routes closed without both dependencies: %o",
    async ({ includeAuth, includeConsent }) => {
      const auth = createAuthRuntime();
      const service = createRemoteMcpOAuthConsentService();
      const app = await createApiApp({
        allowedOrigins: ["https://app.alphanet.test"],
        ...(includeAuth ? { authRuntime: auth.runtime } : {}),
        environment: "test",
        ...(includeConsent
          ? {
              remoteMcpOAuthConsent: {
                resource: "https://mcp.alphanet.test/mcp",
                service,
              },
            }
          : {}),
        version: "test-version",
      });
      apps.push(app);

      const response = await app.inject({
        headers: {
          "content-type": "application/json",
          origin: "https://app.alphanet.test",
          "sec-fetch-site": "same-origin",
        },
        method: "POST",
        payload: {},
        url: "/v1/owner/remote-mcp/oauth/consent/inspect",
      });

      expect(response.statusCode).toBe(404);
      expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
        "ROUTE_NOT_FOUND",
      );
      expect(auth.getOwnerSession).not.toHaveBeenCalled();
      expect(service.loadConsentRequest).not.toHaveBeenCalled();
    },
  );

  it("registers dark-launched Owner OAuth consent only when its authenticated runtime is assembled", async () => {
    const auth = createAuthRuntime({
      ownerSession: {
        owner: {
          email: "owner@alphanet.test",
          emailVerified: true,
          id: "10000000-0000-4000-8000-000000000001",
          name: "Research Owner",
          status: "active",
        },
        session: {
          createdAt: new Date("2026-07-21T12:00:00.000Z"),
          expiresAt: new Date("2026-07-28T12:00:00.000Z"),
          id: "20000000-0000-4000-8000-000000000002",
        },
      },
    });
    const service = createRemoteMcpOAuthConsentService();
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      authRuntime: auth.runtime,
      environment: "test",
      remoteMcpOAuthConsent: {
        resource: "https://mcp.alphanet.test/mcp",
        service,
      },
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      headers: {
        "content-type": "application/json",
        cookie: "alphanet.session=opaque",
        origin: "https://app.alphanet.test",
        "sec-fetch-site": "same-origin",
      },
      method: "POST",
      payload: {},
      url: "/v1/owner/remote-mcp/oauth/consent/inspect",
    });

    expect(response.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(auth.getOwnerSession).toHaveBeenCalledOnce();
    expect(service.loadConsentRequest).not.toHaveBeenCalled();
  });

  it("returns a stable error envelope and request id", async () => {
    const app = await createApiApp({
      allowedOrigins: ["http://localhost:3000"],
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/does-not-exist",
      headers: {
        "x-request-id": "req-test-request-id",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["x-request-id"]).toBe("req-test-request-id");
    expect(response.json()).toEqual({
      error: {
        code: "route_not_found",
        message: "The requested route does not exist.",
        requestId: "req-test-request-id",
      },
    });
  });

  it("returns the versioned Agent envelope for unexpected V1 failures", async () => {
    const app = await createApiApp({
      allowedOrigins: ["http://localhost:3000"],
      environment: "test",
      version: "test-version",
    });
    app.get("/v1/test-internal-error", () => {
      throw new Error("private infrastructure marker");
    });
    apps.push(app);

    const response = await app.inject({
      headers: { "x-request-id": "req-v1-internal" },
      method: "GET",
      url: "/v1/test-internal-error",
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private infrastructure marker");
    expect(V1ErrorResponseSchema.parse(response.json())).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
        retryable: true,
        details: null,
        retry_after_ms: null,
      },
      request_id: "req-v1-internal",
      schema_version: "1",
    });
  });

  it("uses the versioned error envelope for an unknown v1 route", async () => {
    const app = await createApiApp({
      allowedOrigins: ["http://localhost:3000"],
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      headers: {
        "x-request-id": "req-unknown-v1-route",
      },
      method: "GET",
      url: "/v1/does-not-exist",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "ROUTE_NOT_FOUND",
        details: null,
        message: "The requested API route does not exist.",
        retry_after_ms: null,
        retryable: false,
      },
      request_id: "req-unknown-v1-route",
      schema_version: "1",
    });
  });

  it("replaces an Agent API key used as a request id before logging it", async () => {
    const entries: unknown[][] = [];
    const apiKey = "aln_v1_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    expect(apiKey).toHaveLength(63);

    const app = await createApiApp({
      allowedOrigins: ["http://localhost:3000"],
      environment: "test",
      logger: createCapturingLogger(entries),
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/does-not-exist",
      headers: {
        "x-request-id": apiKey,
      },
    });
    const requestId = response.headers["x-request-id"];

    expect(response.statusCode).toBe(404);
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(response.body).not.toContain(apiKey);
    const capturedLogs = inspect(entries, { depth: 8 });
    expect(capturedLogs).toContain(requestId);
    expect(capturedLogs).not.toContain(apiKey);
  });

  it("bridges auth safely and removes internal ids and bearer tokens", async () => {
    let capturedRequest:
      | {
          clientIp: string | null;
          url: string;
        }
      | undefined;
    const auth = createAuthRuntime({
      handler: (request) => {
        capturedRequest = {
          clientIp: request.headers.get("x-alphanet-client-ip"),
          url: request.url,
        };
        const headers = new Headers({
          "content-type": "application/json",
        });
        headers.append(
          "set-cookie",
          "alphanet.session_token=first; Path=/; HttpOnly; SameSite=Lax",
        );
        headers.append(
          "set-cookie",
          "alphanet.state=second; Path=/; HttpOnly; SameSite=Lax",
        );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: "session-token-must-not-reach-browser-javascript",
              user: {
                id: "internal-auth-user-id",
              },
            }),
            { headers },
          ),
        );
      },
    });
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      authRuntime: auth.runtime,
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      headers: {
        host: "attacker.invalid",
        origin: "https://app.alphanet.test",
        "x-alphanet-client-ip": "198.51.100.99",
      },
      method: "POST",
      payload: {
        email: "owner@example.test",
      },
      remoteAddress: "203.0.113.7",
      url: "/api/auth/sign-in/email",
    });

    expect(response.statusCode).toBe(200);
    expect(capturedRequest).toEqual({
      clientIp: "203.0.113.7",
      url: "https://api.alphanet.test/api/auth/sign-in/email",
    });
    expect(response.json()).toEqual({ status: true });
    expect(response.body).not.toContain("session-token");
    expect(response.body).not.toContain("internal-auth-user-id");
    expect(response.headers["set-cookie"]).toHaveLength(2);
    expect(response.headers["cache-control"]).toBe("no-store, private");
  });

  it("denies Better Auth routes outside the public allowlist", async () => {
    const auth = createAuthRuntime();
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      authRuntime: auth.runtime,
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: {
        code: "route_not_found",
      },
    });
    expect(auth.handler).not.toHaveBeenCalled();
  });

  it("allows the Google callback and rejects the legacy URL-token reset callback", async () => {
    const auth = createAuthRuntime({ googleEnabled: true });
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      authRuntime: auth.runtime,
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const reset = await app.inject({
      method: "GET",
      url: "/api/auth/reset-password/opaque-token?callbackURL=https%3A%2F%2Fapp.alphanet.test%2Freset-password",
    });
    const googleCallback = await app.inject({
      method: "GET",
      url: "/api/auth/callback/google?code=opaque-code&state=opaque-state",
    });

    expect(reset.statusCode).toBe(404);
    expect(googleCallback.statusCode).toBe(200);
    expect(auth.handler).toHaveBeenCalledOnce();
  });

  it("rejects password reset tokens in the query string", async () => {
    const auth = createAuthRuntime();
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      authRuntime: auth.runtime,
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      payload: {
        newPassword: "A-secure-replacement-password-2026!",
      },
      url: "/api/auth/reset-password?token=must-not-reach-the-auth-handler",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "invalid_auth_request",
      },
    });
    expect(auth.handler).not.toHaveBeenCalled();
  });

  it("rejects social sign-in payloads that can expand Google access", async () => {
    const auth = createAuthRuntime({ googleEnabled: true });
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      authRuntime: auth.runtime,
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const rejected = await app.inject({
      method: "POST",
      payload: {
        callbackURL: "https://app.alphanet.test/home",
        provider: "google",
        scopes: ["https://www.googleapis.com/auth/drive"],
      },
      url: "/api/auth/sign-in/social",
    });
    expect(rejected.statusCode).toBe(400);
    expect(auth.handler).not.toHaveBeenCalled();

    const allowed = await app.inject({
      method: "POST",
      payload: {
        callbackURL: "https://app.alphanet.test/home",
        errorCallbackURL: "https://app.alphanet.test/auth/error",
        provider: "google",
      },
      url: "/api/auth/sign-in/social",
    });
    expect(allowed.statusCode).toBe(200);
    expect(auth.handler).toHaveBeenCalledOnce();
  });

  it("never writes one-time auth URL secrets to application request logs", async () => {
    const entries: unknown[][] = [];
    const secret = "reset-secret-must-not-be-logged";
    const auth = createAuthRuntime();
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      authRuntime: auth.runtime,
      environment: "test",
      logger: createCapturingLogger(entries),
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/auth/reset-password/${secret}?callbackURL=https%3A%2F%2Fapp.alphanet.test%2Freset-password`,
    });

    expect(response.statusCode).toBe(404);
    expect(inspect(entries, { depth: 8 })).not.toContain(secret);
    expect(inspect(entries, { depth: 8 })).toContain("/api/auth/*");
  });

  it("returns a stable, serialized Owner session and closes auth resources", async () => {
    const auth = createAuthRuntime({
      ownerSession: {
        owner: {
          email: "owner@example.test",
          emailVerified: true,
          id: "4d696ae5-7698-49a8-ad82-d640d14e2f69",
          name: "Owner",
          status: "active",
        },
        session: {
          createdAt: new Date("2026-07-21T23:55:00.000Z"),
          expiresAt: new Date("2026-08-01T00:00:00.000Z"),
          id: "bb944bd4-001f-443f-a642-e1f7d47b902c",
        },
      },
    });
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      authRuntime: auth.runtime,
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      headers: {
        cookie: "alphanet.session_token=opaque",
      },
      method: "GET",
      url: "/v1/owner/session",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      owner: {
        email: "owner@example.test",
        emailVerified: true,
        id: "4d696ae5-7698-49a8-ad82-d640d14e2f69",
        name: "Owner",
        status: "active",
      },
      session: {
        expiresAt: "2026-08-01T00:00:00.000Z",
        id: "bb944bd4-001f-443f-a642-e1f7d47b902c",
      },
    });

    await app.close();
    apps.splice(apps.indexOf(app), 1);
    expect(auth.close).toHaveBeenCalledOnce();
  });

  it("derives the auth limit address from the configured ingress boundary", async () => {
    const auth = createAuthRuntime({
      handler: (request) =>
        Promise.resolve(
          Response.json({
            clientIp: request.headers.get("x-alphanet-client-ip"),
          }),
        ),
    });
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      authRuntime: auth.runtime,
      environment: "test",
      trustedProxyCidrs: ["10.0.0.0/8"],
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      headers: {
        origin: "https://app.alphanet.test",
        "x-forwarded-for": "198.51.100.25",
      },
      method: "POST",
      payload: {
        email: "owner@example.test",
      },
      remoteAddress: "10.0.0.8",
      url: "/api/auth/request-password-reset",
    });

    expect(response.json()).toEqual({
      clientIp: "198.51.100.25",
    });
  });

  it("ignores forwarded client addresses from an untrusted socket", async () => {
    const auth = createAuthRuntime({
      handler: (request) =>
        Promise.resolve(
          Response.json({
            clientIp: request.headers.get("x-alphanet-client-ip"),
          }),
        ),
    });
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      authRuntime: auth.runtime,
      environment: "test",
      trustedProxyCidrs: ["10.0.0.0/8"],
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      headers: {
        origin: "https://app.alphanet.test",
        "x-forwarded-for": "198.51.100.25",
      },
      method: "POST",
      payload: {
        email: "owner@example.test",
      },
      remoteAddress: "203.0.113.8",
      url: "/api/auth/request-password-reset",
    });

    expect(response.json()).toEqual({
      clientIp: "203.0.113.8",
    });
  });

  it("does not expose an Owner record without an authenticated session", async () => {
    const auth = createAuthRuntime();
    const app = await createApiApp({
      allowedOrigins: ["https://app.alphanet.test"],
      authRuntime: auth.runtime,
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/owner/session",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: "unauthorized",
      },
    });
  });

  it("protects the Owner session bridge before touching authentication storage", async () => {
    const limitedAuth = createAuthRuntime();
    const limitedConsume = vi.fn(() =>
      Promise.resolve({ allowed: false, retryAfter: 17 }),
    );
    const limitedApp = await createApiApp({
      agentRateLimiter: { consume: limitedConsume },
      allowedOrigins: ["https://app.alphanet.test"],
      authRuntime: limitedAuth.runtime,
      environment: "test",
      version: "test-version",
    });
    apps.push(limitedApp);

    const limited = await limitedApp.inject({
      headers: { cookie: "alphanet.session_token=random-invalid-session" },
      method: "GET",
      remoteAddress: "198.51.100.40",
      url: "/v1/owner/session",
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("17");
    expect(limitedConsume).toHaveBeenCalledExactlyOnceWith(
      "ip:198.51.100.40:owner-session",
      { max: 240, window: 60 },
    );
    expect(limitedAuth.getOwnerSession).not.toHaveBeenCalled();

    const unavailableAuth = createAuthRuntime();
    const unavailableApp = await createApiApp({
      agentRateLimiter: {
        consume: () => Promise.reject(new Error("redis unavailable")),
      },
      allowedOrigins: ["https://app.alphanet.test"],
      authRuntime: unavailableAuth.runtime,
      environment: "test",
      version: "test-version",
    });
    apps.push(unavailableApp);
    const unavailable = await unavailableApp.inject({
      headers: { cookie: "alphanet.session_token=random-invalid-session" },
      method: "GET",
      remoteAddress: "198.51.100.41",
      url: "/v1/owner/session",
    });

    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      error: { code: "auth_unavailable" },
    });
    expect(unavailableAuth.getOwnerSession).not.toHaveBeenCalled();

    const failedLookupAuth = createAuthRuntime({
      getOwnerSession: () => Promise.reject(new Error("database unavailable")),
    });
    const failedLookupApp = await createApiApp({
      agentRateLimiter: {
        consume: () => Promise.resolve({ allowed: true, retryAfter: null }),
      },
      allowedOrigins: ["https://app.alphanet.test"],
      authRuntime: failedLookupAuth.runtime,
      environment: "test",
      version: "test-version",
    });
    apps.push(failedLookupApp);
    const failedLookup = await failedLookupApp.inject({
      headers: { cookie: "alphanet.session_token=random-invalid-session" },
      method: "GET",
      remoteAddress: "198.51.100.42",
      url: "/v1/owner/session",
    });

    expect(failedLookup.statusCode).toBe(503);
    expect(failedLookup.json()).toMatchObject({
      error: { code: "auth_unavailable" },
    });
  });
});
