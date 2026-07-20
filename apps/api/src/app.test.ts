import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlphaNetAuthRuntime, OwnerSession } from "@alphanet/auth";
import type { FastifyBaseLogger } from "fastify";

import { createApiApp } from "./app.js";

const apps: Awaited<ReturnType<typeof createApiApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function createAuthRuntime(options?: {
  checkReady?: () => Promise<void>;
  googleEnabled?: boolean;
  handler?: (request: Request) => Promise<Response>;
  ownerSession?: OwnerSession | null;
}): {
  close: ReturnType<typeof vi.fn>;
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
  const runtime = {
    auth: { handler },
    baseUrl: "https://api.alphanet.test",
    checkReady: vi.fn(options?.checkReady ?? (() => Promise.resolve())),
    close,
    getOwnerSession: vi.fn(() => Promise.resolve(options?.ownerSession ?? null)),
    googleEnabled: options?.googleEnabled ?? false,
    handle: handler,
  } as unknown as AlphaNetAuthRuntime;

  return { close, handler, runtime };
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
  return logger as unknown as FastifyBaseLogger;
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
        "x-request-id": "test-request-id",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["x-request-id"]).toBe("test-request-id");
    expect(response.json()).toEqual({
      error: {
        code: "route_not_found",
        message: "The requested route does not exist.",
        requestId: "test-request-id",
      },
    });
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
});
