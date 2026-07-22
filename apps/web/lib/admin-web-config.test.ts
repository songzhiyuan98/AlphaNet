import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  AdminWebConfigurationError,
  isAdminPostOriginAllowed,
  loadAdminWebConfig,
  normalizeAdminReturnTo,
} from "./admin-web-config";

const encryptionKey = Buffer.alloc(32, 0x5a).toString("base64");

function enabledEnvironment(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    ADMIN_WEB_DYNAMODB_ENDPOINT: undefined,
    ADMIN_WEB_ENABLED: "true",
    ADMIN_WEB_LOGIN_TTL_SECONDS: "300",
    ADMIN_WEB_OIDC_CLIENT_ID: "alphanet-workforce-admin-web",
    ADMIN_WEB_OIDC_CLIENT_SECRET: "workforce-client-secret-with-32-plus-characters",
    ADMIN_WEB_OIDC_ISSUER: "https://login.alphanet.example/workforce",
    ADMIN_WEB_OIDC_RESOURCE: "https://api.alphanet.example/v1/admin",
    ADMIN_WEB_OIDC_SCOPES: "openid profile email",
    ADMIN_WEB_PUBLIC_ORIGIN: "https://app.alphanet.example",
    ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64: encryptionKey,
    ADMIN_WEB_SESSION_STORE: "dynamodb",
    ADMIN_WEB_SESSION_TABLE: "alphanet-production-admin-web-sessions",
    ADMIN_WEB_SESSION_TTL_SECONDS: "3600",
    AWS_REGION: "us-west-2",
    NODE_ENV: "production",
    ...overrides,
  };
}

describe("Admin Web configuration", () => {
  it("is disabled by default without reading partial secret configuration", () => {
    expect(loadAdminWebConfig({ NODE_ENV: "test" })).toEqual({ enabled: false });
  });

  it("loads one strict HTTPS OIDC and DynamoDB configuration", () => {
    const config = loadAdminWebConfig(enabledEnvironment());

    expect(config).toMatchObject({
      enabled: true,
      awsRegion: "us-west-2",
      callbackUrl: "https://app.alphanet.example/admin/auth/callback",
      loginCookieName: "__Host-alphanet-admin-login",
      loginTtlSeconds: 300,
      oidc: {
        clientId: "alphanet-workforce-admin-web",
        issuer: "https://login.alphanet.example/workforce",
        resource: "https://api.alphanet.example/v1/admin",
        scopes: ["openid", "profile", "email"],
      },
      publicOrigin: "https://app.alphanet.example",
      secureCookies: true,
      sessionCookieName: "__Host-alphanet-admin-session",
      sessionStore: "dynamodb",
      sessionTable: "alphanet-production-admin-web-sessions",
      sessionTtlSeconds: 3600,
    });
    expect(config.enabled && config.sessionEncryptionKey).toEqual(
      new Uint8Array(Buffer.from(encryptionKey, "base64")),
    );
  });

  it("accepts the deployed URN API audience as an RFC 8707 resource", () => {
    const config = loadAdminWebConfig(
      enabledEnvironment({
        ADMIN_WEB_LOGIN_TTL_SECONDS: "900",
        ADMIN_WEB_OIDC_RESOURCE: "urn:alphanet:admin-api",
        ADMIN_WEB_SESSION_TTL_SECONDS: "86400",
      }),
    );

    expect(config).toMatchObject({
      enabled: true,
      loginTtlSeconds: 900,
      oidc: { resource: "urn:alphanet:admin-api" },
      sessionTtlSeconds: 86_400,
    });
  });

  it("preserves the exact issuer identifier and accepts Terraform's equal TTL edge", () => {
    const config = loadAdminWebConfig(
      enabledEnvironment({
        ADMIN_WEB_LOGIN_TTL_SECONDS: "900",
        ADMIN_WEB_OIDC_ISSUER: "https://workforce.alphanet.example",
        ADMIN_WEB_SESSION_TTL_SECONDS: "900",
      }),
    );

    expect(config).toMatchObject({
      enabled: true,
      loginTtlSeconds: 900,
      oidc: { issuer: "https://workforce.alphanet.example" },
      sessionTtlSeconds: 900,
    });
  });

  it("allows an explicit loopback-only local OIDC and DynamoDB endpoint", () => {
    const config = loadAdminWebConfig(
      enabledEnvironment({
        ADMIN_WEB_DYNAMODB_ENDPOINT: "http://127.0.0.1:8000",
        ADMIN_WEB_OIDC_ISSUER: "http://127.0.0.1:5556/workforce",
        ADMIN_WEB_OIDC_RESOURCE: "http://127.0.0.1:4000/v1/admin",
        ADMIN_WEB_PUBLIC_ORIGIN: "http://127.0.0.1:3101",
        NODE_ENV: "test",
      }),
    );

    expect(config).toMatchObject({
      dynamodbEndpoint: "http://127.0.0.1:8000",
      enabled: true,
      loginCookieName: "alphanet-admin-login-local",
      secureCookies: false,
      sessionCookieName: "alphanet-admin-session-local",
    });
  });

  it("rejects non-Dynamo stores, weak or partial secrets, refresh scope, and unsafe URLs", () => {
    const invalidEnvironments = [
      { ADMIN_WEB_SESSION_STORE: "memory" },
      { ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64: Buffer.alloc(16).toString("base64") },
      { ADMIN_WEB_OIDC_SCOPES: "openid offline_access" },
      { ADMIN_WEB_OIDC_SCOPES: "profile email" },
      { ADMIN_WEB_PUBLIC_ORIGIN: "https://app.alphanet.example/admin" },
      { ADMIN_WEB_OIDC_ISSUER: "http://idp.internal/workforce", NODE_ENV: "test" },
      { ADMIN_WEB_DYNAMODB_ENDPOINT: "http://dynamodb.internal:8000", NODE_ENV: "test" },
      { ADMIN_WEB_OIDC_CLIENT_SECRET: undefined },
    ];

    for (const overrides of invalidEnvironments) {
      expect(() => loadAdminWebConfig(enabledEnvironment(overrides))).toThrow(
        AdminWebConfigurationError,
      );
    }
  });

  it("forbids cleartext provider/origin URLs and endpoint overrides in production", () => {
    expect(() =>
      loadAdminWebConfig(
        enabledEnvironment({
          ADMIN_WEB_PUBLIC_ORIGIN: "http://127.0.0.1:3101",
        }),
      ),
    ).toThrow(AdminWebConfigurationError);
    expect(() =>
      loadAdminWebConfig(
        enabledEnvironment({
          ADMIN_WEB_DYNAMODB_ENDPOINT: "http://127.0.0.1:8000",
        }),
      ),
    ).toThrow(AdminWebConfigurationError);
  });

  it("rejects an ambiguous runtime environment instead of weakening production rules", () => {
    expect(() => loadAdminWebConfig(enabledEnvironment({ NODE_ENV: "prod" }))).toThrow(
      AdminWebConfigurationError,
    );
  });

  it("never includes configured secrets in validation errors", () => {
    const secret = "secret-marker-that-must-not-reach-errors-51f8";
    let caught: unknown;
    try {
      loadAdminWebConfig(
        enabledEnvironment({
          ADMIN_WEB_OIDC_CLIENT_SECRET: secret,
          ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64: secret,
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AdminWebConfigurationError);
    expect(String(caught)).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain(secret);
  });
});

describe("Admin Web request safety helpers", () => {
  it("allows only relative paths rooted at /admin and strips fragments", () => {
    expect(normalizeAdminReturnTo(undefined)).toBe("/admin/moderation");
    expect(normalizeAdminReturnTo("/admin")).toBe("/admin");
    expect(normalizeAdminReturnTo("/admin/moderation?status=open#private")).toBe(
      "/admin/moderation?status=open",
    );
  });

  it("fails closed for external, ambiguous, escaped, and oversized return targets", () => {
    for (const value of [
      "https://attacker.invalid/admin",
      "//attacker.invalid/admin",
      "/owner/admin",
      "/admin\\..\\owner",
      "/admin/%2e%2e/owner",
      `/admin/${"x".repeat(2_100)}`,
    ]) {
      expect(normalizeAdminReturnTo(value)).toBe("/admin/moderation");
    }
  });

  it("requires an exact same-origin Origin value for browser POSTs", () => {
    const config = loadAdminWebConfig(enabledEnvironment());
    expect(config.enabled).toBe(true);
    if (!config.enabled) throw new Error("test configuration must be enabled");

    expect(isAdminPostOriginAllowed("https://app.alphanet.example", config)).toBe(true);
    expect(isAdminPostOriginAllowed("https://app.alphanet.example/", config)).toBe(false);
    expect(isAdminPostOriginAllowed(null, config)).toBe(false);
    expect(isAdminPostOriginAllowed("https://attacker.invalid", config)).toBe(false);
  });
});
