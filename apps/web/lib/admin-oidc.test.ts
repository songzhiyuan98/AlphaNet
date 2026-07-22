import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import { loadAdminWebConfig, type EnabledAdminWebConfig } from "./admin-web-config";
import {
  AdminOidcError,
  createAdminOidcService,
  type AdminOidcAdapter,
} from "./admin-oidc";

const now = new Date("2026-07-22T20:00:00.000Z");
const accessToken = [
  Buffer.from(JSON.stringify({ alg: "RS256", kid: "admin" })).toString("base64url"),
  Buffer.from(
    JSON.stringify({
      exp: Math.floor(now.valueOf() / 1_000) + 1_800,
      sub: "workforce-user",
    }),
  ).toString("base64url"),
  Buffer.from("integration-test-signature").toString("base64url"),
].join(".");

function config(
  overrides: Record<string, string | undefined> = {},
): EnabledAdminWebConfig {
  const loaded = loadAdminWebConfig({
    ADMIN_WEB_DYNAMODB_ENDPOINT: "http://127.0.0.1:8000",
    ADMIN_WEB_ENABLED: "true",
    ADMIN_WEB_LOGIN_TTL_SECONDS: "300",
    ADMIN_WEB_OIDC_CLIENT_ID: "alphanet-workforce-admin-web",
    ADMIN_WEB_OIDC_CLIENT_SECRET: "workforce-client-secret-with-32-plus-characters",
    ADMIN_WEB_OIDC_ISSUER: "http://127.0.0.1:5556/workforce",
    ADMIN_WEB_OIDC_RESOURCE: "http://127.0.0.1:4000/v1/admin",
    ADMIN_WEB_OIDC_SCOPES: "openid profile email",
    ADMIN_WEB_PUBLIC_ORIGIN: "http://127.0.0.1:3101",
    ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 0x44).toString("base64"),
    ADMIN_WEB_SESSION_STORE: "dynamodb",
    ADMIN_WEB_SESSION_TABLE: "alphanet-test-admin-web-sessions",
    ADMIN_WEB_SESSION_TTL_SECONDS: "3600",
    AWS_REGION: "us-west-2",
    NODE_ENV: "test",
    ...overrides,
  });
  if (!loaded.enabled) throw new Error("test configuration must be enabled");
  return loaded;
}

function adapter(): AdminOidcAdapter & {
  authorizationCodeGrant: ReturnType<typeof vi.fn>;
  buildAuthorizationUrl: ReturnType<typeof vi.fn>;
  discover: ReturnType<typeof vi.fn>;
} {
  const discovered = Object.freeze({ id: "discovered-config" });
  return {
    authorizationCodeGrant: vi.fn(() =>
      Promise.resolve({
        accessToken,
        expiresInSeconds: 1_800,
        tokenType: "Bearer",
      }),
    ),
    buildAuthorizationUrl: vi.fn(
      (_configuration: unknown, parameters: Record<string, string>) => {
        const url = new URL("http://127.0.0.1:5556/workforce/authorize");
        for (const [name, value] of Object.entries(parameters)) {
          url.searchParams.set(name, value);
        }
        return url;
      },
    ),
    calculatePkceCodeChallenge: vi.fn(() => Promise.resolve("c".repeat(43))),
    discover: vi.fn(() => Promise.resolve(discovered)),
    randomNonce: vi.fn(() => "n".repeat(43)),
    randomPkceCodeVerifier: vi.fn(() => "v".repeat(64)),
    randomState: vi.fn(() => "s".repeat(43)),
  };
}

describe("Admin workforce OIDC service", () => {
  it("builds an authorization-code request with mandatory PKCE S256, state, nonce, and no refresh scope", async () => {
    const oidcAdapter = adapter();
    const service = createAdminOidcService(config(), {
      adapter: oidcAdapter,
      now: () => now,
    });

    const result = await service.createAuthorizationRequest(
      "/admin/moderation?status=open",
    );

    expect(result.transaction).toEqual({
      codeVerifier: "v".repeat(64),
      nonce: "n".repeat(43),
      returnTo: "/admin/moderation?status=open",
      state: "s".repeat(43),
    });
    expect(result.authorizationUrl.origin).toBe("http://127.0.0.1:5556");
    expect(Object.fromEntries(result.authorizationUrl.searchParams)).toMatchObject({
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      nonce: "n".repeat(43),
      redirect_uri: "http://127.0.0.1:3101/admin/auth/callback",
      resource: "http://127.0.0.1:4000/v1/admin",
      response_type: "code",
      scope: "openid profile email",
      state: "s".repeat(43),
    });
    expect(result.authorizationUrl.searchParams.get("scope")).not.toContain(
      "offline_access",
    );
  });

  it("accepts a discovery-declared HTTPS authorization endpoint on a distinct provider origin", async () => {
    const oidcAdapter = adapter();
    oidcAdapter.buildAuthorizationUrl.mockImplementation(
      (_configuration: unknown, parameters: Record<string, string>) => {
        const url = new URL("https://authorize.workforce.example/login");
        for (const [name, value] of Object.entries(parameters)) {
          url.searchParams.set(name, value);
        }
        return url;
      },
    );
    const service = createAdminOidcService(
      config({
        ADMIN_WEB_DYNAMODB_ENDPOINT: undefined,
        ADMIN_WEB_OIDC_ISSUER: "https://issuer.workforce.example/tenant",
        ADMIN_WEB_OIDC_RESOURCE: "urn:alphanet:admin-api",
        ADMIN_WEB_PUBLIC_ORIGIN: "https://app.alphanet.example",
        NODE_ENV: "production",
      }),
      { adapter: oidcAdapter, now: () => now },
    );

    await expect(
      service.createAuthorizationRequest("/admin/moderation"),
    ).resolves.toMatchObject({
      authorizationUrl: new URL(
        `https://authorize.workforce.example/login?code_challenge=${"c".repeat(43)}&code_challenge_method=S256&nonce=${"n".repeat(43)}&redirect_uri=https%3A%2F%2Fapp.alphanet.example%2Fadmin%2Fauth%2Fcallback&response_type=code&scope=openid+profile+email&state=${"s".repeat(43)}&resource=urn%3Aalphanet%3Aadmin-api`,
      ),
    });
  });

  it("never permits a discovery-declared cleartext authorization endpoint in production", async () => {
    const oidcAdapter = adapter();
    oidcAdapter.buildAuthorizationUrl.mockReturnValue(
      new URL("http://127.0.0.1:5556/workforce/authorize"),
    );
    const service = createAdminOidcService(
      config({
        ADMIN_WEB_DYNAMODB_ENDPOINT: undefined,
        ADMIN_WEB_OIDC_ISSUER: "https://issuer.workforce.example/tenant",
        ADMIN_WEB_OIDC_RESOURCE: "urn:alphanet:admin-api",
        ADMIN_WEB_PUBLIC_ORIGIN: "https://app.alphanet.example",
        NODE_ENV: "production",
      }),
      { adapter: oidcAdapter, now: () => now },
    );

    await expect(
      service.createAuthorizationRequest("/admin/moderation"),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("rejects an authorization URL that drops a bound state, nonce, or PKCE parameter", async () => {
    const oidcAdapter = adapter();
    oidcAdapter.buildAuthorizationUrl.mockReturnValue(
      new URL("https://authorize.workforce.example/login?response_type=code"),
    );
    const service = createAdminOidcService(
      config({
        ADMIN_WEB_DYNAMODB_ENDPOINT: undefined,
        ADMIN_WEB_OIDC_ISSUER: "https://issuer.workforce.example/tenant",
        ADMIN_WEB_OIDC_RESOURCE: "urn:alphanet:admin-api",
        ADMIN_WEB_PUBLIC_ORIGIN: "https://app.alphanet.example",
        NODE_ENV: "production",
      }),
      { adapter: oidcAdapter, now: () => now },
    );

    await expect(
      service.createAuthorizationRequest("/admin/moderation"),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("discovers once per service and exchanges a code with exact state, nonce, PKCE, redirect, and resource", async () => {
    const oidcAdapter = adapter();
    const service = createAdminOidcService(config(), {
      adapter: oidcAdapter,
      now: () => now,
    });
    const transaction = {
      codeVerifier: "v".repeat(64),
      nonce: "n".repeat(43),
      returnTo: "/admin/moderation",
      state: "s".repeat(43),
    };

    await service.createAuthorizationRequest(transaction.returnTo);
    await expect(
      service.exchangeAuthorizationCode(
        new URL(
          `http://127.0.0.1:3101/admin/auth/callback?code=code-value&state=${transaction.state}`,
        ),
        transaction,
      ),
    ).resolves.toEqual({
      accessToken,
      tokenExpiresAt: new Date(now.valueOf() + 1_800_000),
    });

    expect(oidcAdapter.discover).toHaveBeenCalledTimes(1);
    expect(oidcAdapter.authorizationCodeGrant).toHaveBeenCalledWith(
      { id: "discovered-config" },
      new URL(
        `http://127.0.0.1:3101/admin/auth/callback?code=code-value&state=${transaction.state}`,
      ),
      {
        expectedNonce: transaction.nonce,
        expectedState: transaction.state,
        pkceCodeVerifier: transaction.codeVerifier,
      },
      { resource: "http://127.0.0.1:4000/v1/admin" },
    );
  });

  it("coalesces concurrent provider discovery", async () => {
    const oidcAdapter = adapter();
    let resolveDiscovery: ((value: unknown) => void) | undefined;
    oidcAdapter.discover.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDiscovery = resolve;
        }),
    );
    const service = createAdminOidcService(config(), {
      adapter: oidcAdapter,
      now: () => now,
    });

    const first = service.createAuthorizationRequest("/admin/moderation");
    const second = service.createAuthorizationRequest("/admin/moderation");
    await vi.waitFor(() => expect(oidcAdapter.discover).toHaveBeenCalledTimes(1));
    resolveDiscovery?.(Object.freeze({ id: "discovered-config" }));
    await Promise.all([first, second]);
    expect(oidcAdapter.discover).toHaveBeenCalledTimes(1);
  });

  it("rejects callback URL substitution and malformed or long-lived token responses", async () => {
    const wrongOriginAdapter = adapter();
    const service = createAdminOidcService(config(), {
      adapter: wrongOriginAdapter,
      now: () => now,
    });
    const transaction = {
      codeVerifier: "v".repeat(64),
      nonce: "n".repeat(43),
      returnTo: "/admin/moderation",
      state: "s".repeat(43),
    };

    await expect(
      service.exchangeAuthorizationCode(
        new URL(`https://attacker.invalid/callback?state=${transaction.state}`),
        transaction,
      ),
    ).rejects.toMatchObject({ code: "authentication_failed" });

    for (const tokenResult of [
      { accessToken: "not-a-jwt", expiresInSeconds: 1_800, tokenType: "Bearer" },
      { accessToken, expiresInSeconds: 0, tokenType: "Bearer" },
      { accessToken, expiresInSeconds: 86_401, tokenType: "Bearer" },
      { accessToken, expiresInSeconds: 1_800, tokenType: "DPoP" },
    ]) {
      const invalidAdapter = adapter();
      invalidAdapter.authorizationCodeGrant.mockResolvedValue(tokenResult);
      await expect(
        createAdminOidcService(config(), {
          adapter: invalidAdapter,
          now: () => now,
        }).exchangeAuthorizationCode(
          new URL(
            `http://127.0.0.1:3101/admin/auth/callback?code=code&state=${transaction.state}`,
          ),
          transaction,
        ),
      ).rejects.toBeInstanceOf(AdminOidcError);
    }
  });

  it("maps provider details to a stable claim-free error", async () => {
    const oidcAdapter = adapter();
    const secret = `provider failed for token ${accessToken}`;
    oidcAdapter.authorizationCodeGrant.mockRejectedValue(new Error(secret));
    const service = createAdminOidcService(config(), {
      adapter: oidcAdapter,
      now: () => now,
    });
    const transaction = {
      codeVerifier: "v".repeat(64),
      nonce: "n".repeat(43),
      returnTo: "/admin/moderation",
      state: "s".repeat(43),
    };

    let caught: unknown;
    try {
      await service.exchangeAuthorizationCode(
        new URL(
          `http://127.0.0.1:3101/admin/auth/callback?code=secret-code&state=${transaction.state}`,
        ),
        transaction,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AdminOidcError);
    expect(caught).toMatchObject({ code: "authentication_failed" });
    expect(String(caught)).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect(String(caught)).not.toContain(accessToken);
  });

  it("does not retain or expose a provider refresh token", async () => {
    const oidcAdapter = adapter();
    oidcAdapter.authorizationCodeGrant.mockResolvedValue({
      accessToken,
      expiresInSeconds: 1_800,
      refreshToken: "refresh-token-must-not-be-retained",
      tokenType: "Bearer",
    });
    const service = createAdminOidcService(config(), {
      adapter: oidcAdapter,
      now: () => now,
    });
    const transaction = {
      codeVerifier: "v".repeat(64),
      nonce: "n".repeat(43),
      returnTo: "/admin/moderation",
      state: "s".repeat(43),
    };

    const result = await service.exchangeAuthorizationCode(
      new URL(
        `http://127.0.0.1:3101/admin/auth/callback?code=code&state=${transaction.state}`,
      ),
      transaction,
    );
    expect(result).toEqual({
      accessToken,
      tokenExpiresAt: new Date(now.valueOf() + 1_800_000),
    });
    expect(JSON.stringify(result)).not.toContain("refresh-token");
  });
});
