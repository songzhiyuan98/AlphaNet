import {
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import express, { type Request } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import {
  createStrictBearerAuthorizationMiddleware,
  parseStrictBearerAuthorization,
} from "./strict-bearer-auth.js";

const TOKEN = "header.payload.signature";
const PRM_URL = "https://mcp.alphanet.test/.well-known/oauth-protected-resource/mcp";
const NOW = new Date("2033-05-18T03:33:20.000Z");

interface RequestWithAuth extends Request {
  auth?: AuthInfo;
}

function authInfo(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    clientId: "mcp-client-v1",
    expiresAt: NOW.valueOf() / 1_000 + 600,
    extra: {
      actor: {
        credentialId: "20000000-0000-4000-8000-000000000002",
        grantId: "10000000-0000-4000-8000-000000000001",
        tokenJtiDigest: "A".repeat(43),
      },
    },
    resource: new URL("https://mcp.alphanet.test/mcp"),
    scopes: ["research:read"],
    token: TOKEN,
    ...overrides,
  };
}

function buildApp(verifier: OAuthTokenVerifier, resourceMetadataUrl = PRM_URL) {
  const app = express();
  app.use(
    createStrictBearerAuthorizationMiddleware({
      now: () => NOW,
      resourceMetadataUrl,
      verifier,
    }),
  );
  app.get("/", (requestValue, response) => {
    response.json({ client_id: (requestValue as RequestWithAuth).auth?.clientId });
  });
  return app;
}

describe("strict Bearer authorization parser", () => {
  it("accepts one exact raw Bearer field and ignores unrelated headers", () => {
    expect(
      parseStrictBearerAuthorization([
        "Host",
        "mcp.alphanet.test",
        "Authorization",
        `Bearer ${TOKEN}`,
        "Accept",
        "application/json",
      ]),
    ).toBe(TOKEN);
  });

  it.each([
    ["missing", ["Host", "mcp.alphanet.test"]],
    ["odd raw header list", ["Authorization"]],
    [
      "duplicate",
      ["Authorization", `Bearer ${TOKEN}`, "authorization", `Bearer ${TOKEN}`],
    ],
    ["comma-folded list", ["Authorization", `Bearer ${TOKEN}, Bearer ${TOKEN}`]],
    ["lowercase scheme", ["Authorization", `bearer ${TOKEN}`]],
    ["other scheme", ["Authorization", `Basic ${TOKEN}`]],
    ["double space", ["Authorization", `Bearer  ${TOKEN}`]],
    ["leading space", ["Authorization", ` Bearer ${TOKEN}`]],
    ["trailing space", ["Authorization", `Bearer ${TOKEN} `]],
    ["tab separator", ["Authorization", `Bearer\t${TOKEN}`]],
    ["additional field", ["Authorization", `Bearer ${TOKEN} extra`]],
    ["empty token", ["Authorization", "Bearer "]],
    ["non-JWT token", ["Authorization", "Bearer opaque-token"]],
  ] as const)("rejects %s", (_label, rawHeaders) => {
    expect(parseStrictBearerAuthorization(rawHeaders)).toBeNull();
  });
});

describe("strict Bearer authorization middleware", () => {
  it("verifies only the exact token and attaches trusted AuthInfo", async () => {
    const verifier = {
      verifyAccessToken: vi.fn(() => Promise.resolve(authInfo())),
    } satisfies OAuthTokenVerifier;

    const response = await request(buildApp(verifier))
      .get("/")
      .set("authorization", `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ client_id: "mcp-client-v1" });
    expect(verifier.verifyAccessToken).toHaveBeenCalledExactlyOnceWith(TOKEN);
  });

  it("returns a fixed 401 challenge for malformed headers without calling the verifier", async () => {
    const verifier = {
      verifyAccessToken: vi.fn(() => Promise.resolve(authInfo())),
    } satisfies OAuthTokenVerifier;

    const response = await request(buildApp(verifier))
      .get("/")
      .set("authorization", `Bearer ${TOKEN} injected`);

    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toBe(
      `Bearer error="invalid_token", resource_metadata="${PRM_URL}"`,
    );
    expect(response.body).toEqual({
      error: "invalid_token",
      error_description: "Invalid access token.",
    });
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("maps verifier token rejection and expiry to the same non-leaking 401", async () => {
    const secret = `${TOKEN}.sensitive`;
    const invalidVerifier = {
      verifyAccessToken: vi.fn(() =>
        Promise.reject(new InvalidTokenError(`rejected ${secret}`)),
      ),
    } satisfies OAuthTokenVerifier;
    const expiredVerifier = {
      verifyAccessToken: vi.fn(() =>
        Promise.resolve(authInfo({ expiresAt: NOW.valueOf() / 1_000 })),
      ),
    } satisfies OAuthTokenVerifier;

    for (const verifier of [invalidVerifier, expiredVerifier]) {
      const response = await request(buildApp(verifier))
        .get("/")
        .set("authorization", `Bearer ${TOKEN}`);
      expect(response.status).toBe(401);
      expect(JSON.stringify(response.headers) + response.text).not.toContain(secret);
      expect(response.body).toEqual({
        error: "invalid_token",
        error_description: "Invalid access token.",
      });
    }
  });

  it("maps dependency and unexpected verifier failures to a fixed 503 without a challenge", async () => {
    const secret = `${TOKEN}.upstream-secret`;
    const dependencyFailure = {
      verifyAccessToken: vi.fn(() =>
        Promise.reject(new ServerError(`JWKS failed: ${secret}`)),
      ),
    } satisfies OAuthTokenVerifier;
    const unexpectedFailure = {
      verifyAccessToken: vi.fn(() => Promise.reject(new Error(secret))),
    } satisfies OAuthTokenVerifier;

    for (const verifier of [dependencyFailure, unexpectedFailure]) {
      const response = await request(buildApp(verifier))
        .get("/")
        .set("authorization", `Bearer ${TOKEN}`);
      expect(response.status).toBe(503);
      expect(response.headers).not.toHaveProperty("www-authenticate");
      expect(JSON.stringify(response.headers) + response.text).not.toContain(secret);
      expect(response.body).toEqual({
        error: "temporarily_unavailable",
        error_description: "Access-token verification is temporarily unavailable.",
      });
    }
  });

  it("fails closed with 503 when the verifier violates its AuthInfo contract or the clock fails", async () => {
    const wrongTokenVerifier = {
      verifyAccessToken: vi.fn(() =>
        Promise.resolve(authInfo({ token: "other.payload.signature" })),
      ),
    } satisfies OAuthTokenVerifier;
    const app = express();
    app.use(
      createStrictBearerAuthorizationMiddleware({
        now: () => new Date(Number.NaN),
        verifier: {
          verifyAccessToken: () => Promise.resolve(authInfo()),
        },
      }),
    );
    app.get("/", (_request, response) => response.json({ ok: true }));

    for (const instance of [buildApp(wrongTokenVerifier), app]) {
      const response = await request(instance)
        .get("/")
        .set("authorization", `Bearer ${TOKEN}`);
      expect(response.status).toBe(503);
      expect((response.body as { error?: unknown }).error).toBe(
        "temporarily_unavailable",
      );
    }
  });

  it("validates the injectable PRM challenge URL before serving requests", () => {
    const verifier = {
      verifyAccessToken: () => Promise.resolve(authInfo()),
    } satisfies OAuthTokenVerifier;

    for (const resourceMetadataUrl of [
      "https://mcp.alphanet.test/prm#fragment",
      'https://mcp.alphanet.test/prm"injected',
      "http://mcp.alphanet.test/prm",
    ]) {
      expect(() => buildApp(verifier, resourceMetadataUrl)).toThrow(
        "resourceMetadataUrl must be a canonical URL",
      );
    }
    expect(() => buildApp(verifier, "http://127.0.0.1:4100/prm")).not.toThrow();
  });
});
