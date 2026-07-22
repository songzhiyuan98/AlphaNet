import { Buffer } from "node:buffer";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as callbackGet } from "../app/admin/auth/callback/route";
import { POST as logoutPost } from "../app/admin/auth/logout/route";
import { POST as startPost } from "../app/admin/auth/start/route";

const mocks = vi.hoisted(() => ({
  consumeLoginTransaction: vi.fn(),
  createAuthorizationRequest: vi.fn(),
  createLoginTransaction: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("./admin-session-store", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    getAdminSessionStore: () => ({
      consumeLoginTransaction: mocks.consumeLoginTransaction,
      createLoginTransaction: mocks.createLoginTransaction,
      createSession: mocks.createSession,
      deleteSession: mocks.deleteSession,
      getSession: mocks.getSession,
    }),
  };
});

vi.mock("./admin-oidc", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    getAdminOidcService: () => ({
      createAuthorizationRequest: mocks.createAuthorizationRequest,
      exchangeAuthorizationCode: mocks.exchangeAuthorizationCode,
    }),
  };
});

const transaction = {
  codeVerifier: "v".repeat(64),
  nonce: "n".repeat(43),
  returnTo: "/admin/moderation?status=open",
  state: "s".repeat(43),
};
const accessToken = [
  Buffer.from(JSON.stringify({ alg: "RS256", kid: "admin" })).toString("base64url"),
  Buffer.from(JSON.stringify({ exp: 1_784_754_000, sub: "workforce-user" })).toString(
    "base64url",
  ),
  Buffer.from("integration-test-signature").toString("base64url"),
].join(".");

function stubEnvironment(): void {
  const environment = {
    ADMIN_WEB_DYNAMODB_ENDPOINT: "http://127.0.0.1:8000",
    ADMIN_WEB_ENABLED: "true",
    ADMIN_WEB_LOGIN_TTL_SECONDS: "300",
    ADMIN_WEB_OIDC_CLIENT_ID: "alphanet-workforce-admin-web",
    ADMIN_WEB_OIDC_CLIENT_SECRET: "workforce-client-secret-with-32-plus-characters",
    ADMIN_WEB_OIDC_ISSUER: "http://127.0.0.1:5556/workforce",
    ADMIN_WEB_OIDC_SCOPES: "openid profile email",
    ADMIN_WEB_PUBLIC_ORIGIN: "http://127.0.0.1:3101",
    ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 0x44).toString("base64"),
    ADMIN_WEB_SESSION_STORE: "dynamodb",
    ADMIN_WEB_SESSION_TABLE: "alphanet-test-admin-web-sessions",
    ADMIN_WEB_SESSION_TTL_SECONDS: "3600",
    AWS_REGION: "us-west-2",
    NODE_ENV: "test",
  };
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
}

beforeEach(() => {
  vi.clearAllMocks();
  stubEnvironment();
  mocks.createAuthorizationRequest.mockResolvedValue({
    authorizationUrl: new URL(
      `http://127.0.0.1:5556/workforce/authorize?state=${transaction.state}`,
    ),
    transaction,
  });
  mocks.createLoginTransaction.mockResolvedValue({
    expiresAt: new Date("2026-07-22T20:05:00.000Z"),
    handle: "l".repeat(43),
  });
  mocks.consumeLoginTransaction.mockResolvedValue(transaction);
  mocks.exchangeAuthorizationCode.mockResolvedValue({
    accessToken,
    tokenExpiresAt: new Date("2026-07-22T20:30:00.000Z"),
  });
  mocks.createSession.mockResolvedValue({
    expiresAt: new Date("2026-07-22T20:30:00.000Z"),
    handle: "h".repeat(43),
  });
  mocks.deleteSession.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Admin workforce auth routes", () => {
  it("starts OIDC only from a same-origin POST and sets only an opaque HttpOnly login cookie", async () => {
    const response = await startPost(
      new Request(
        "http://127.0.0.1:3101/admin/auth/start?return_to=%2Fadmin%2Fmoderation%3Fstatus%3Dopen",
        {
          headers: { origin: "http://127.0.0.1:3101" },
          method: "POST",
        },
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain(
      "http://127.0.0.1:5556/workforce/authorize",
    );
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`alphanet-admin-login-local=${"l".repeat(43)}`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(cookie).not.toContain(transaction.codeVerifier);
    expect(cookie).not.toContain(transaction.nonce);
    expect(cookie).not.toContain(accessToken);
    expect(mocks.createAuthorizationRequest).toHaveBeenCalledWith(
      "/admin/moderation?status=open",
    );
  });

  it("rejects cross-origin login starts before creating an OIDC transaction", async () => {
    const response = await startPost(
      new Request("http://127.0.0.1:3101/admin/auth/start", {
        headers: { origin: "https://attacker.invalid" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(403);
    expect(mocks.createAuthorizationRequest).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("attacker.invalid");
  });

  it("rejects duplicate or unknown login-start query parameters", async () => {
    for (const query of [
      "return_to=%2Fadmin&return_to=%2Fadmin%2Fmoderation",
      "return_to=%2Fadmin&access_token=attacker-controlled",
      "next=%2Fadmin",
    ]) {
      const response = await startPost(
        new Request(`http://127.0.0.1:3101/admin/auth/start?${query}`, {
          headers: { origin: "http://127.0.0.1:3101" },
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.createAuthorizationRequest).not.toHaveBeenCalled();
  });

  it("routes a same-origin provider outage to the controlled Admin error page", async () => {
    mocks.createAuthorizationRequest.mockRejectedValueOnce(
      new Error("provider details must remain private"),
    );
    const response = await startPost(
      new Request("http://127.0.0.1:3101/admin/auth/start", {
        headers: { origin: "http://127.0.0.1:3101" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://127.0.0.1:3101/admin/auth/error?code=unavailable",
    );
    expect(await response.text()).not.toContain("provider details");
  });

  it("atomically consumes the login handle, exchanges the code, and sets only an opaque session cookie", async () => {
    const response = await callbackGet(
      new Request(
        `http://internal-web:3000/admin/auth/callback?code=one-time-code&state=${transaction.state}`,
        {
          headers: {
            cookie: `alphanet-admin-login-local=${"l".repeat(43)}`,
          },
        },
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://127.0.0.1:3101/admin/moderation?status=open",
    );
    expect(mocks.consumeLoginTransaction).toHaveBeenCalledWith(
      "l".repeat(43),
      transaction.state,
    );
    expect(mocks.exchangeAuthorizationCode).toHaveBeenCalledWith(
      new URL(
        `http://127.0.0.1:3101/admin/auth/callback?code=one-time-code&state=${transaction.state}`,
      ),
      transaction,
    );
    expect(mocks.createSession).toHaveBeenCalledWith({
      accessToken,
      tokenExpiresAt: new Date("2026-07-22T20:30:00.000Z"),
    });
    const cookies = response.headers.getSetCookie().join(";");
    expect(cookies).toContain(`alphanet-admin-session-local=${"h".repeat(43)}`);
    expect(cookies).toContain("alphanet-admin-login-local=");
    expect(cookies.toLowerCase()).toContain("httponly");
    expect(cookies.toLowerCase()).toContain("samesite=lax");
    expect(cookies).not.toContain(accessToken);
    expect(cookies).not.toContain(transaction.codeVerifier);
  });

  it("fails closed and clears the login cookie when the callback transaction is absent", async () => {
    mocks.consumeLoginTransaction.mockResolvedValue(null);
    const response = await callbackGet(
      new Request(
        `http://127.0.0.1:3101/admin/auth/callback?code=code&state=${transaction.state}`,
        { headers: { cookie: `alphanet-admin-login-local=${"l".repeat(43)}` } },
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://127.0.0.1:3101/admin/auth/error?code=invalid_response",
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("set-cookie")).toContain("alphanet-admin-login-local=");
    expect(mocks.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(transaction.state);
  });

  it("routes a token-exchange outage to the controlled error page and clears login state", async () => {
    mocks.exchangeAuthorizationCode.mockRejectedValueOnce(
      new Error("provider response must remain private"),
    );
    const response = await callbackGet(
      new Request(
        `http://127.0.0.1:3101/admin/auth/callback?code=code&state=${transaction.state}`,
        { headers: { cookie: `alphanet-admin-login-local=${"l".repeat(43)}` } },
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://127.0.0.1:3101/admin/auth/error?code=unavailable",
    );
    expect(response.headers.get("set-cookie")).toContain("alphanet-admin-login-local=");
    expect(await response.text()).not.toContain("provider response");
  });

  it("logs out only from a same-origin POST, deletes the server session, and expires the cookie", async () => {
    const response = await logoutPost(
      new Request("http://127.0.0.1:3101/admin/auth/logout", {
        headers: {
          cookie: `alphanet-admin-session-local=${"h".repeat(43)}`,
          origin: "http://127.0.0.1:3101",
        },
        method: "POST",
      }),
    );

    expect(mocks.deleteSession).toHaveBeenCalledWith("h".repeat(43));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://127.0.0.1:3101/admin");
    expect(response.headers.get("set-cookie")).toContain("alphanet-admin-session-local=");
  });

  it("does not delete a session for a cross-origin logout request", async () => {
    const response = await logoutPost(
      new Request("http://127.0.0.1:3101/admin/auth/logout", {
        headers: {
          cookie: `alphanet-admin-session-local=${"h".repeat(43)}`,
          origin: "https://attacker.invalid",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });
});
