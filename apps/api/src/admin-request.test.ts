import {
  OidcJwtVerificationError,
  type OidcJwtVerifier,
  type VerifiedOidcJwtIdentity,
} from "@alphanet/auth";
import { V1ErrorResponseSchema } from "@alphanet/contracts";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  LogController,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAdminRequestAuthorizationBoundary,
  type ActiveAdminAuthorizationSnapshot,
  type AdminAuthorizationRepository,
  type AdminRequestMode,
  type AdminRequestRateLimiter,
  type AdminSecurityAudit,
} from "./admin-request.js";

const token = "a.b.c";
const secondToken = "d.e.f";
const adminId = "10000000-0000-4000-8000-000000000001";
const secondAdminId = "10000000-0000-4000-8000-000000000002";
const issuer = "https://login.alphanet.test/workforce";
const identity: VerifiedOidcJwtIdentity = {
  issuer,
  mfa: {
    amrMfa: true,
    matchedAcr: "urn:alphanet:assurance:mfa",
    method: "acr_and_amr_mfa",
  },
  subject: "workforce-user-01",
};
const authorization: ActiveAdminAuthorizationSnapshot = {
  adminId,
  permissions: ["moderation:read", "moderation:decide", "audit:read"],
  roles: ["moderator", "audit_reader"],
};
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function allowAllLimiter(): AdminRequestRateLimiter & {
  consume: ReturnType<typeof vi.fn>;
} {
  return {
    consume: vi.fn(() => Promise.resolve({ allowed: true, retryAfter: null })),
  };
}

function capturingLogger(entries: unknown[][]): FastifyBaseLogger {
  const record = (...arguments_: unknown[]) => entries.push(arguments_);
  const logger = {
    child: () => logger,
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

function createBoundaryApp(options?: {
  audit?: AdminSecurityAudit;
  identityVerifier?: OidcJwtVerifier;
  loggerEntries?: unknown[][];
  mode?: AdminRequestMode;
  rateLimiter?: AdminRequestRateLimiter;
  repository?: AdminAuthorizationRepository;
  resolveClientIp?: () => string;
}) {
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    ...(options?.loggerEntries
      ? { loggerInstance: capturingLogger(options.loggerEntries) }
      : { logger: false }),
  });
  const verify = vi.fn((value: string) =>
    options?.identityVerifier
      ? options.identityVerifier.verify(value)
      : Promise.resolve(identity),
  );
  const resolveActiveAuthorization = vi.fn(
    (resolvedIdentity: { issuer: string; subject: string }) =>
      options?.repository
        ? options.repository.resolveActiveAuthorization(resolvedIdentity)
        : Promise.resolve(authorization),
  );
  const recordSecurityRejection = vi.fn(
    (event: Parameters<AdminSecurityAudit["recordSecurityRejection"]>[0]) =>
      options?.audit ? options.audit.recordSecurityRejection(event) : Promise.resolve(),
  );
  const rateLimiter = options?.rateLimiter ?? allowAllLimiter();
  const boundary = createAdminRequestAuthorizationBoundary({
    audit: { recordSecurityRejection },
    identityVerifier: { verify },
    mode: options?.mode ?? "read",
    permission: "moderation:read",
    rateLimiter,
    repository: { resolveActiveAuthorization },
    resolveClientIp: options?.resolveClientIp ?? (() => "203.0.113.10"),
  });
  const handler = vi.fn((request: Parameters<typeof boundary.getAuthorization>[0]) =>
    boundary.getAuthorization(request),
  );
  app.post("/v1/admin/test", { onRequest: boundary.onRequest }, handler);
  apps.push(app);
  return {
    app,
    handler,
    rateLimiter,
    recordSecurityRejection,
    resolveActiveAuthorization,
    verify,
  };
}

function bearerHeaders(value = token) {
  return {
    authorization: `Bearer ${value}`,
    cookie: "alphanet.session=owner-session-that-must-be-ignored",
    "x-admin-id": "90000000-0000-4000-8000-000000000009",
  };
}

function errorCode(response: { json(): unknown }): string {
  return V1ErrorResponseSchema.parse(response.json()).error.code;
}

describe("Admin workforce request boundary", () => {
  it("returns an immutable real-time RBAC and MFA snapshot from verified identity only", async () => {
    const limiter = allowAllLimiter();
    const { app, recordSecurityRejection, resolveActiveAuthorization, verify } =
      createBoundaryApp({ rateLimiter: limiter });

    const response = await app.inject({
      headers: bearerHeaders(),
      method: "POST",
      payload: {},
      url: "/v1/admin/test",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.json()).toEqual({
      adminId,
      authenticationAssurance: "workforce_oidc",
      mfa: identity.mfa,
      permission: "moderation:read",
      permissions: ["audit:read", "moderation:decide", "moderation:read"],
      roles: ["audit_reader", "moderator"],
    });
    expect(verify).toHaveBeenCalledExactlyOnceWith(token);
    expect(resolveActiveAuthorization).toHaveBeenCalledExactlyOnceWith({
      issuer,
      subject: identity.subject,
    });
    expect(limiter.consume).toHaveBeenNthCalledWith(1, "ip:203.0.113.10:admin-api:read", {
      max: 120,
      window: 60,
    });
    expect(limiter.consume).toHaveBeenNthCalledWith(
      2,
      `admin:${adminId}:admin-api:read`,
      { max: 120, window: 60 },
    );
    expect(recordSecurityRejection).not.toHaveBeenCalled();
    expect(JSON.stringify(response.json())).not.toContain(
      "90000000-0000-4000-8000-000000000009",
    );
  });

  it("uses the 20/min mutation budget on both the IP and resolved Admin", async () => {
    const limiter = allowAllLimiter();
    const { app } = createBoundaryApp({ mode: "mutation", rateLimiter: limiter });

    const response = await app.inject({
      headers: bearerHeaders(),
      method: "POST",
      payload: {},
      url: "/v1/admin/test",
    });

    expect(response.statusCode).toBe(200);
    expect(limiter.consume).toHaveBeenNthCalledWith(
      1,
      "ip:203.0.113.10:admin-api:mutation",
      { max: 20, window: 60 },
    );
    expect(limiter.consume).toHaveBeenNthCalledWith(
      2,
      `admin:${adminId}:admin-api:mutation`,
      { max: 20, window: 60 },
    );
  });

  it.each([
    {
      authorization: undefined,
      label: "a missing Authorization header",
      url: "/v1/admin/test",
    },
    {
      authorization: `bearer ${token}`,
      label: "a lower-case scheme",
      url: "/v1/admin/test",
    },
    {
      authorization: `Bearer  ${token}`,
      label: "extra whitespace",
      url: "/v1/admin/test",
    },
    { authorization: `Basic ${token}`, label: "another scheme", url: "/v1/admin/test" },
    {
      authorization: `Bearer ${token}`,
      label: "a token-shaped query parameter",
      url: "/v1/admin/test?access_token=leaked",
    },
  ])(
    "rejects $label before OIDC verification",
    async ({ authorization: header, url }) => {
      const { app, verify } = createBoundaryApp();
      const response = await app.inject({
        headers: {
          cookie: "alphanet.session=owner-only",
          ...(header ? { authorization: header } : {}),
          "x-admin-id": adminId,
        },
        method: "POST",
        payload: {},
        url,
      });

      expect(response.statusCode).toBe(401);
      expect(errorCode(response)).toBe("AUTHENTICATION_REQUIRED");
      expect(response.headers["www-authenticate"]).toContain("alphanet-admin");
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it("maps invalid tokens to 401 and provider outages to sanitized 503 responses", async () => {
    const invalid = createBoundaryApp({
      identityVerifier: {
        verify: () => Promise.reject(new OidcJwtVerificationError("invalid_token")),
      },
    });
    const invalidResponse = await invalid.app.inject({
      headers: bearerHeaders(),
      method: "POST",
      payload: {},
      url: "/v1/admin/test",
    });
    expect(invalidResponse.statusCode).toBe(401);
    expect(errorCode(invalidResponse)).toBe("AUTHENTICATION_REQUIRED");
    expect(invalidResponse.headers["www-authenticate"]).toContain(
      'error="invalid_token"',
    );

    const loggerEntries: unknown[][] = [];
    const unavailable = createBoundaryApp({
      identityVerifier: {
        verify: () =>
          Promise.reject(new Error(`provider failure included ${token} and claims`)),
      },
      loggerEntries,
    });
    const unavailableResponse = await unavailable.app.inject({
      headers: bearerHeaders(),
      method: "POST",
      payload: {},
      url: "/v1/admin/test",
    });
    expect(unavailableResponse.statusCode).toBe(503);
    expect(errorCode(unavailableResponse)).toBe("TEMPORARILY_UNAVAILABLE");
    expect(
      JSON.stringify({
        body: unavailableResponse.body,
        headers: unavailableResponse.headers,
        logs: loggerEntries,
      }),
    ).not.toContain(token);
    expect(JSON.stringify(loggerEntries)).not.toContain("provider failure included");
  });

  it("audits an inactive or unprovisioned workforce identity as a security rejection", async () => {
    const recordSecurityRejection = vi.fn<AdminSecurityAudit["recordSecurityRejection"]>(
      () => Promise.resolve(),
    );
    const { app } = createBoundaryApp({
      audit: { recordSecurityRejection },
      repository: { resolveActiveAuthorization: () => Promise.resolve(null) },
    });
    const response = await app.inject({
      headers: bearerHeaders(),
      method: "POST",
      payload: {},
      url: "/v1/admin/test",
    });

    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe("ADMIN_ACCESS_DENIED");
    expect(recordSecurityRejection).toHaveBeenCalledOnce();
    const rejection = recordSecurityRejection.mock.calls[0]?.[0];
    expect(rejection?.requestId).toMatch(/^req-/);
    expect(rejection).toMatchObject({
      adminId: null,
      authenticationAssurance: "workforce_oidc",
      authorizationSnapshot: null,
      channel: "admin_web",
      eventClass: "security_rejection",
      identity: { issuer, subject: identity.subject },
      permission: "moderation:read",
      reasonCode: "admin_not_active",
    });
  });

  it("audits missing atomic permission with the complete role/permission snapshot", async () => {
    const recordSecurityRejection = vi.fn<AdminSecurityAudit["recordSecurityRejection"]>(
      () => Promise.resolve(),
    );
    const { app } = createBoundaryApp({
      audit: { recordSecurityRejection },
      repository: {
        resolveActiveAuthorization: () =>
          Promise.resolve({
            adminId,
            permissions: ["community:manage"],
            roles: ["community_operator"],
          }),
      },
    });
    const response = await app.inject({
      headers: bearerHeaders(),
      method: "POST",
      payload: {},
      url: "/v1/admin/test",
    });

    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe("ADMIN_PERMISSION_REQUIRED");
    expect(recordSecurityRejection).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId,
        authorizationSnapshot: {
          permission: "moderation:read",
          permissions: ["community:manage"],
          roles: ["community_operator"],
        },
        eventClass: "security_rejection",
        permission: "moderation:read",
        reasonCode: "admin_permission_required",
      }),
    );
    expect(JSON.stringify(recordSecurityRejection.mock.calls)).not.toContain(token);
  });

  it("fails closed when RBAC lookup, snapshot validation, or rejection audit fails", async () => {
    const repositoryFailure = createBoundaryApp({
      repository: {
        resolveActiveAuthorization: () => Promise.reject(new Error("database secret")),
      },
    });
    const repositoryResponse = await repositoryFailure.app.inject({
      headers: bearerHeaders(),
      method: "POST",
      payload: {},
      url: "/v1/admin/test",
    });
    expect(repositoryResponse.statusCode).toBe(503);

    const invalidSnapshot = createBoundaryApp({
      repository: {
        resolveActiveAuthorization: () =>
          Promise.resolve({
            adminId: "forged-admin-id",
            permissions: ["moderation:read"],
            roles: ["moderator"],
          }),
      },
    });
    const invalidSnapshotResponse = await invalidSnapshot.app.inject({
      headers: bearerHeaders(),
      method: "POST",
      payload: {},
      url: "/v1/admin/test",
    });
    expect(invalidSnapshotResponse.statusCode).toBe(503);

    const auditFailure = createBoundaryApp({
      audit: {
        recordSecurityRejection: () => Promise.reject(new Error("audit unavailable")),
      },
      repository: { resolveActiveAuthorization: () => Promise.resolve(null) },
    });
    const auditResponse = await auditFailure.app.inject({
      headers: bearerHeaders(),
      method: "POST",
      payload: {},
      url: "/v1/admin/test",
    });
    expect(auditResponse.statusCode).toBe(503);
    expect(errorCode(auditResponse)).toBe("TEMPORARILY_UNAVAILABLE");
  });

  it.each([
    { failAt: 1, label: "IP", status: "reject" },
    { failAt: 2, label: "Admin", status: "reject" },
    { failAt: 1, label: "IP", status: "throw" },
    { failAt: 2, label: "Admin", status: "throw" },
  ] as const)(
    "fails closed when the $label Redis limit returns $status",
    async ({ failAt, status }) => {
      const consume = vi.fn(() => {
        const call = consume.mock.calls.length;
        if (call !== failAt) return Promise.resolve({ allowed: true, retryAfter: null });
        return status === "throw"
          ? Promise.reject(new Error(`redis secret ${token}`))
          : Promise.resolve({ allowed: false, retryAfter: 7 });
      });
      const { app, verify } = createBoundaryApp({ rateLimiter: { consume } });
      const response = await app.inject({
        headers: bearerHeaders(),
        method: "POST",
        payload: {},
        url: "/v1/admin/test",
      });

      expect(response.statusCode).toBe(status === "throw" ? 503 : 429);
      expect(errorCode(response)).toBe(
        status === "throw" ? "TEMPORARILY_UNAVAILABLE" : "RATE_LIMITED",
      );
      if (status === "reject") expect(response.headers["retry-after"]).toBe("7");
      if (failAt === 1) expect(verify).not.toHaveBeenCalled();
    },
  );

  it("resolves RBAC again on every request and observes a revoked permission", async () => {
    const resolveActiveAuthorization = vi
      .fn<AdminAuthorizationRepository["resolveActiveAuthorization"]>()
      .mockResolvedValueOnce(authorization)
      .mockResolvedValueOnce({
        adminId,
        permissions: ["audit:read"],
        roles: ["audit_reader"],
      });
    const { app, handler } = createBoundaryApp({
      repository: { resolveActiveAuthorization },
    });

    const first = await app.inject({
      headers: bearerHeaders(),
      method: "POST",
      payload: {},
      url: "/v1/admin/test",
    });
    const second = await app.inject({
      headers: bearerHeaders(),
      method: "POST",
      payload: {},
      url: "/v1/admin/test",
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(403);
    expect(resolveActiveAuthorization).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("keeps concurrent Admin authorizations isolated by request", async () => {
    const verify = vi.fn((value: string) =>
      Promise.resolve({
        ...identity,
        subject: value === secondToken ? "workforce-user-02" : identity.subject,
      }),
    );
    const resolveActiveAuthorization = vi.fn(({ subject: resolvedSubject }) =>
      Promise.resolve({
        ...authorization,
        adminId: resolvedSubject === "workforce-user-02" ? secondAdminId : adminId,
      }),
    );
    const { app } = createBoundaryApp({
      identityVerifier: { verify },
      repository: { resolveActiveAuthorization },
    });

    const [first, second] = await Promise.all([
      app.inject({
        headers: bearerHeaders(token),
        method: "POST",
        payload: {},
        url: "/v1/admin/test",
      }),
      app.inject({
        headers: bearerHeaders(secondToken),
        method: "POST",
        payload: {},
        url: "/v1/admin/test",
      }),
    ]);

    expect(first.json()).toMatchObject({ adminId });
    expect(second.json()).toMatchObject({ adminId: secondAdminId });
  });

  it("authorizes before Fastify parses an invalid mutation body", async () => {
    const unauthorized = createBoundaryApp({ mode: "mutation" });
    const unauthorizedResponse = await unauthorized.app.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: "{",
      url: "/v1/admin/test",
    });
    expect(unauthorizedResponse.statusCode).toBe(401);

    const authorized = createBoundaryApp({ mode: "mutation" });
    const authorizedResponse = await authorized.app.inject({
      headers: { ...bearerHeaders(), "content-type": "application/json" },
      method: "POST",
      payload: "{",
      url: "/v1/admin/test",
    });
    expect(authorizedResponse.statusCode).toBe(400);
    expect(authorized.handler).not.toHaveBeenCalled();
  });

  it("rejects uncontrolled route permissions and unsafe limit overrides at startup", () => {
    const dependencies = {
      audit: { recordSecurityRejection: () => Promise.resolve() },
      identityVerifier: { verify: () => Promise.resolve(identity) },
      mode: "read" as const,
      rateLimiter: allowAllLimiter(),
      repository: { resolveActiveAuthorization: () => Promise.resolve(authorization) },
    };

    expect(() =>
      createAdminRequestAuthorizationBoundary({
        ...dependencies,
        permission: "admin:*" as "moderation:read",
      }),
    ).toThrow("controlled atomic permission");
    expect(() =>
      createAdminRequestAuthorizationBoundary({
        ...dependencies,
        limits: { read: { max: 0, window: 60 } },
        permission: "moderation:read",
      }),
    ).toThrow("limit rule");
  });
});
