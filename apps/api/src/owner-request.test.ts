import type { AlphaNetAuthRuntime, OwnerSession } from "@alphanet/auth";
import { V1ErrorResponseSchema } from "@alphanet/contracts";
import {
  createOwnerWebContextAuthority,
  type OwnerWebContextAuthority,
} from "@alphanet/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOwnerRequestAuthorizationBoundary,
  createOwnerWebSocialRequestAuthorizationBoundary,
  type OwnerRequestMode,
  type OwnerRequestRateLimiter,
} from "./owner-request.js";

const allowedOrigin = "https://app.alphanet.test";
const ownerId = "10000000-0000-4000-8000-000000000001";
const ownerSession: OwnerSession = {
  owner: {
    email: "owner@alphanet.test",
    emailVerified: true,
    id: ownerId,
    name: "Research Owner",
    status: "active",
  },
  session: {
    createdAt: new Date("2026-07-21T17:55:00.000Z"),
    expiresAt: new Date("2026-07-21T18:00:00.000Z"),
    id: "20000000-0000-4000-8000-000000000001",
  },
};
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function allowAllLimiter(): OwnerRequestRateLimiter & {
  consume: ReturnType<typeof vi.fn>;
} {
  return {
    consume: vi.fn(() => Promise.resolve({ allowed: true, retryAfter: null })),
  };
}

function createBoundaryApp(options?: {
  bodyLimit?: number;
  contextAuthority?: OwnerWebContextAuthority;
  mode?: OwnerRequestMode;
  rateLimiter?: OwnerRequestRateLimiter;
  resolveClientIp?: () => string;
  session?: OwnerSession | null;
  sessionLookup?: AlphaNetAuthRuntime["getOwnerSession"];
}) {
  const app = Fastify({
    ...(options?.bodyLimit ? { bodyLimit: options.bodyLimit } : {}),
    logger: false,
  });
  let observedRequest:
    | Parameters<
        ReturnType<typeof createOwnerRequestAuthorizationBoundary>["getAuthorization"]
      >[0]
    | null = null;
  app.addHook("onRequest", (request, _reply, done) => {
    observedRequest = request;
    done();
  });
  const getOwnerSession = vi.fn<AlphaNetAuthRuntime["getOwnerSession"]>(
    options?.sessionLookup ??
      (() =>
        Promise.resolve(
          options && "session" in options ? options.session! : ownerSession,
        )),
  );
  const contextAuthority = options?.contextAuthority ?? createOwnerWebContextAuthority();
  const contextIssuer = {
    issueMutationContext: vi.fn(contextAuthority.issuer.issueMutationContext),
    issueSessionContext: vi.fn(contextAuthority.issuer.issueSessionContext),
  };
  const boundary = createOwnerWebSocialRequestAuthorizationBoundary({
    allowedOrigins: [allowedOrigin],
    authRuntime: { getOwnerSession },
    contextIssuer,
    mode: options?.mode ?? "mutation",
    ...(options?.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options?.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  });
  const handler = vi.fn((request: Parameters<typeof boundary.getAuthorization>[0]) => {
    const authorization = boundary.getAuthorization(request);
    const databaseCheckedAt = new Date("2026-07-21T18:00:00.000Z");
    const context =
      (options?.mode ?? "mutation") === "mutation"
        ? contextAuthority.verifier.normalizeMutationContext(
            authorization.context,
            databaseCheckedAt,
          )
        : contextAuthority.verifier.normalizeSessionContext(
            authorization.context,
            databaseCheckedAt,
          );
    return {
      context_csrf_validated: "csrfValidated" in context ? context.csrfValidated : false,
      context_owner_id: context.ownerId,
      context_session_id: context.sessionId,
      owner_id: authorization.owner.id,
      request_body: request.body,
    };
  });
  app.post("/owner-test", { onRequest: boundary.onRequest }, handler);
  apps.push(app);
  return {
    app,
    boundary,
    contextAuthority,
    contextIssuer,
    getObservedRequest: () => observedRequest,
    getOwnerSession,
    handler,
  };
}

function mutationHeaders(contentType = "application/json") {
  return {
    cookie: "alphanet.session=test-session",
    "content-type": contentType,
    origin: allowedOrigin,
    "sec-fetch-site": "same-origin",
    "user-agent": "owner-request-test",
  };
}

describe("Owner request parse-before boundary", () => {
  it.each([
    {
      bodyLimit: undefined,
      contentType: "application/json",
      expectedParseStatus: 400,
      label: "malformed JSON",
      payload: "{",
    },
    {
      bodyLimit: undefined,
      contentType: "application/xml",
      expectedParseStatus: 415,
      label: "an unsupported media type",
      payload: "<decision />",
    },
    {
      bodyLimit: 64,
      contentType: "application/json",
      expectedParseStatus: 413,
      label: "an oversized body",
      payload: JSON.stringify({ reason: "x".repeat(128) }),
    },
  ])(
    "runs IP/session/CSRF/Owner checks before $label handling",
    async ({ bodyLimit, contentType, expectedParseStatus, payload }) => {
      const unauthenticatedLimiter = allowAllLimiter();
      const unauthenticated = createBoundaryApp({
        ...(bodyLimit ? { bodyLimit } : {}),
        rateLimiter: unauthenticatedLimiter,
        session: null,
      });
      const unauthenticatedResponse = await unauthenticated.app.inject({
        headers: { "content-type": contentType },
        method: "POST",
        payload,
        url: "/owner-test",
      });

      expect(unauthenticatedResponse.statusCode).toBe(401);
      expect(V1ErrorResponseSchema.parse(unauthenticatedResponse.json()).error.code).toBe(
        "AUTHENTICATION_REQUIRED",
      );
      expect(unauthenticatedLimiter.consume).toHaveBeenCalledOnce();
      expect(unauthenticated.getOwnerSession).toHaveBeenCalledOnce();
      expect(unauthenticated.handler).not.toHaveBeenCalled();

      const csrfLimiter = allowAllLimiter();
      const csrf = createBoundaryApp({
        ...(bodyLimit ? { bodyLimit } : {}),
        rateLimiter: csrfLimiter,
      });
      const csrfResponse = await csrf.app.inject({
        headers: { "content-type": contentType },
        method: "POST",
        payload,
        url: "/owner-test",
      });

      expect(csrfResponse.statusCode).toBe(403);
      expect(V1ErrorResponseSchema.parse(csrfResponse.json()).error.code).toBe(
        "CSRF_VALIDATION_FAILED",
      );
      expect(csrfLimiter.consume).toHaveBeenCalledOnce();
      expect(csrf.handler).not.toHaveBeenCalled();
      expect(csrf.contextIssuer.issueSessionContext).not.toHaveBeenCalled();
      expect(csrf.contextIssuer.issueMutationContext).not.toHaveBeenCalled();
      const csrfRequest = csrf.getObservedRequest();
      expect(csrfRequest).not.toBeNull();
      expect(() => csrf.boundary.getAuthorization(csrfRequest!)).toThrow(
        "without authorization",
      );

      const authorizedLimiter = allowAllLimiter();
      const authorized = createBoundaryApp({
        ...(bodyLimit ? { bodyLimit } : {}),
        rateLimiter: authorizedLimiter,
      });
      const authorizedResponse = await authorized.app.inject({
        headers: mutationHeaders(contentType),
        method: "POST",
        payload,
        url: "/owner-test",
      });

      expect(authorizedResponse.statusCode).toBe(expectedParseStatus);
      expect(authorizedResponse.headers["cache-control"]).toBe("no-store, private");
      expect(authorizedLimiter.consume).toHaveBeenCalledTimes(2);
      expect(authorized.getOwnerSession).toHaveBeenCalledOnce();
      expect(authorized.handler).not.toHaveBeenCalled();
    },
  );

  it("uses only the session Owner identity and does not re-consume limits in the handler", async () => {
    const limiter = allowAllLimiter();
    const {
      app,
      boundary,
      contextAuthority,
      getObservedRequest,
      getOwnerSession,
      handler,
    } = createBoundaryApp({
      rateLimiter: limiter,
    });
    const response = await app.inject({
      headers: mutationHeaders(),
      method: "POST",
      payload: {
        owner_id: "90000000-0000-4000-8000-000000000009",
        ownerAuthorization: { owner: { id: "forged" } },
      },
      url: "/owner-test",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      context_csrf_validated: true,
      context_owner_id: ownerId,
      context_session_id: ownerSession.session.id,
      owner_id: ownerId,
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(limiter.consume).toHaveBeenCalledTimes(2);
    expect(getOwnerSession).toHaveBeenCalledOnce();
    const sessionHeaders = getOwnerSession.mock.calls[0]?.[0];
    expect(sessionHeaders?.get("cookie")).toBe("alphanet.session=test-session");
    expect(sessionHeaders?.get("user-agent")).toBe("owner-request-test");
    expect(sessionHeaders?.has("authorization")).toBe(false);
    const boundaryRequest = getObservedRequest();
    expect(boundaryRequest).not.toBeNull();
    const issuedContext = boundary.getAuthorization(boundaryRequest!).context;
    expect(
      contextAuthority.verifier.normalizeMutationContext(
        issuedContext,
        new Date("2026-07-21T18:00:00.000Z"),
      ),
    ).toMatchObject({ ownerId, sessionId: ownerSession.session.id });
    expect(() =>
      contextAuthority.verifier.normalizeMutationContext(
        { ...issuedContext, csrfValidated: true },
        new Date("2026-07-21T18:00:00.000Z"),
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_OWNER_WEB_SESSION_CONTEXT" }));
  });

  it("keeps concurrent Owner authorizations isolated by request", async () => {
    const secondOwnerId = "10000000-0000-4000-8000-000000000002";
    const { app } = createBoundaryApp({
      sessionLookup: (headers) =>
        Promise.resolve({
          ...ownerSession,
          owner: {
            ...ownerSession.owner,
            id: headers.get("cookie")?.includes("second") ? secondOwnerId : ownerId,
          },
        }),
    });
    const [first, second] = await Promise.all([
      app.inject({
        headers: { ...mutationHeaders(), cookie: "session=first" },
        method: "POST",
        payload: {},
        url: "/owner-test",
      }),
      app.inject({
        headers: { ...mutationHeaders(), cookie: "session=second" },
        method: "POST",
        payload: {},
        url: "/owner-test",
      }),
    ]);

    expect(first.json()).toMatchObject({ owner_id: ownerId });
    expect(second.json()).toMatchObject({ owner_id: secondOwnerId });
  });

  it("allows reads without an Origin while retaining both limits", async () => {
    const limiter = allowAllLimiter();
    const { app, boundary, contextAuthority, getObservedRequest } = createBoundaryApp({
      mode: "read",
      rateLimiter: limiter,
    });
    const response = await app.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: {},
      url: "/owner-test",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      context_csrf_validated: false,
      context_owner_id: ownerId,
      context_session_id: ownerSession.session.id,
    });
    expect(limiter.consume).toHaveBeenNthCalledWith(1, expect.any(String), {
      max: 240,
      window: 60,
    });
    expect(limiter.consume).toHaveBeenNthCalledWith(2, `owner:${ownerId}:read`, {
      max: 120,
      window: 60,
    });
    const readRequest = getObservedRequest();
    expect(readRequest).not.toBeNull();
    expect(() =>
      contextAuthority.verifier.normalizeMutationContext(
        boundary.getAuthorization(readRequest!).context,
        new Date("2026-07-21T18:00:00.000Z"),
      ),
    ).toThrow(expect.objectContaining({ code: "OWNER_WEB_CSRF_REQUIRED" }));
  });

  it("keeps legacy Owner authorization free of social context authority", async () => {
    const app = Fastify({ logger: false });
    const boundary = createOwnerRequestAuthorizationBoundary({
      allowedOrigins: [allowedOrigin],
      authRuntime: { getOwnerSession: () => Promise.resolve(ownerSession) },
      mode: "mutation",
    });
    app.post("/legacy-owner-test", { onRequest: boundary.onRequest }, (request) =>
      boundary.getAuthorization(request),
    );
    apps.push(app);

    const response = await app.inject({
      headers: mutationHeaders(),
      method: "POST",
      payload: {},
      url: "/legacy-owner-test",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ owner: { id: ownerId } });
    expect(response.json()).not.toHaveProperty("context");
  });
});

describe("Owner request authentication and mutation gates", () => {
  it.each(["pending_verification", "restricted", "suspended", "closed"] as const)(
    "rejects a %s Owner session",
    async (status) => {
      const { app, handler } = createBoundaryApp({
        session: {
          ...ownerSession,
          owner: { ...ownerSession.owner, status },
        },
      });
      const response = await app.inject({
        headers: mutationHeaders(),
        method: "POST",
        payload: {},
        url: "/owner-test",
      });

      expect(response.statusCode).toBe(403);
      expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
        "OWNER_NOT_ACTIVE",
      );
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("requires an email-verified Owner session", async () => {
    const { app, handler } = createBoundaryApp({
      session: {
        ...ownerSession,
        owner: { ...ownerSession.owner, emailVerified: false },
      },
    });
    const response = await app.inject({
      headers: mutationHeaders(),
      method: "POST",
      payload: {},
      url: "/owner-test",
    });

    expect(response.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "OWNER_EMAIL_VERIFICATION_REQUIRED",
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    {
      headers: { ...mutationHeaders(), origin: `${allowedOrigin}/` },
      label: "a non-exact Origin",
    },
    {
      headers: { ...mutationHeaders(), "sec-fetch-site": "cross-site" },
      label: "a cross-site fetch",
    },
  ])("rejects $label", async ({ headers }) => {
    const { app, handler } = createBoundaryApp();
    const response = await app.inject({
      headers,
      method: "POST",
      payload: {},
      url: "/owner-test",
    });

    expect(response.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "CSRF_VALIDATION_FAILED",
    );
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("Owner request dependency failures", () => {
  it("enforces IP and Owner limits in order", async () => {
    const ipLimitedConsume = vi.fn(() =>
      Promise.resolve({ allowed: false, retryAfter: 7 }),
    );
    const ipLimited = createBoundaryApp({
      rateLimiter: { consume: ipLimitedConsume },
    });
    const ipResponse = await ipLimited.app.inject({
      headers: mutationHeaders(),
      method: "POST",
      payload: {},
      url: "/owner-test",
    });
    expect(ipResponse.statusCode).toBe(429);
    expect(ipResponse.headers["retry-after"]).toBe("7");
    expect(ipLimited.getOwnerSession).not.toHaveBeenCalled();

    const ownerLimitedConsume = vi
      .fn()
      .mockResolvedValueOnce({ allowed: true, retryAfter: null })
      .mockResolvedValueOnce({ allowed: false, retryAfter: 11 });
    const ownerLimited = createBoundaryApp({
      rateLimiter: { consume: ownerLimitedConsume },
    });
    const ownerResponse = await ownerLimited.app.inject({
      headers: mutationHeaders(),
      method: "POST",
      payload: {},
      url: "/owner-test",
    });
    expect(ownerResponse.statusCode).toBe(429);
    expect(ownerResponse.headers["retry-after"]).toBe("11");
    expect(ownerLimited.getOwnerSession).toHaveBeenCalledOnce();
    expect(ownerLimitedConsume).toHaveBeenCalledTimes(2);
  });

  it("fails closed when client IP resolution throws", async () => {
    const limiter = allowAllLimiter();
    const { app, getOwnerSession } = createBoundaryApp({
      rateLimiter: limiter,
      resolveClientIp: () => {
        throw new Error("proxy resolver secret");
      },
    });
    const response = await app.inject({
      headers: mutationHeaders(),
      method: "POST",
      payload: {},
      url: "/owner-test",
    });

    expect(response.statusCode).toBe(503);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "TEMPORARILY_UNAVAILABLE",
    );
    expect(response.body).not.toContain("proxy resolver secret");
    expect(limiter.consume).not.toHaveBeenCalled();
    expect(getOwnerSession).not.toHaveBeenCalled();
  });

  it("fails closed when either limiter or session lookup fails", async () => {
    const limiterFailure = createBoundaryApp({
      rateLimiter: {
        consume: vi.fn(() => Promise.reject(new Error("redis secret"))),
      },
    });
    const limiterResponse = await limiterFailure.app.inject({
      headers: mutationHeaders(),
      method: "POST",
      payload: {},
      url: "/owner-test",
    });
    expect(limiterResponse.statusCode).toBe(503);
    expect(limiterResponse.body).not.toContain("redis secret");
    expect(limiterFailure.getOwnerSession).not.toHaveBeenCalled();

    const sessionFailure = createBoundaryApp({
      rateLimiter: allowAllLimiter(),
      sessionLookup: () => Promise.reject(new Error("session secret")),
    });
    const sessionResponse = await sessionFailure.app.inject({
      headers: mutationHeaders(),
      method: "POST",
      payload: {},
      url: "/owner-test",
    });
    expect(sessionResponse.statusCode).toBe(503);
    expect(sessionResponse.body).not.toContain("session secret");
  });
});
