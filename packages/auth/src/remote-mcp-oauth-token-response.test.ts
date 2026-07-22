import { describe, expect, it } from "vitest";

import {
  REMOTE_MCP_OAUTH_TOKEN_RESPONSE_MAX_BYTES,
  RemoteMcpOAuthTokenResponseValidationError,
  validateRemoteMcpOAuthTokenSuccessResponse,
  type RemoteMcpOAuthTokenResponseExpectation,
} from "./remote-mcp-oauth-token-response.js";

const ISSUER = "https://auth.alphanet.example/api/auth";
const RESOURCE = "https://mcp.alphanet.example/mcp";
const CLIENT_ID = "alphanet-desktop-v1";
const GRANT_ID = "10000000-0000-4000-8000-000000000001";
const CREDENTIAL_ID = "10000000-0000-4000-8000-000000000002";
const JTI = "10000000-0000-4000-8000-000000000003";
const IAT = 2_000_000_000;
const EXP = IAT + 600;
const TOKEN_DIGEST = Buffer.alloc(32, 0x44).toString("base64url");
const REFRESH_TOKEN = `aln_rt_v1_${"R".repeat(32)}`;
const EXPECTATION = Object.freeze({
  clientId: CLIENT_ID,
  issuer: ISSUER,
  resource: RESOURCE,
  scopes: Object.freeze(["research:read"]),
}) satisfies RemoteMcpOAuthTokenResponseExpectation;

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function accessToken(overrides?: {
  header?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  signature?: Uint8Array;
}): string {
  const header = overrides?.header ?? {
    alg: "ES256",
    kid: "10000000-0000-4000-8000-000000000004",
    typ: "JWT",
  };
  const payload = overrides?.payload ?? {
    aud: RESOURCE,
    azp: CLIENT_ID,
    credential_id: CREDENTIAL_ID,
    exp: EXP,
    grant_epoch: 1,
    iat: IAT,
    iss: ISSUER,
    jti: JTI,
    nbf: IAT,
    scope: "research:read",
    sub: GRANT_ID,
    token_jti_digest: TOKEN_DIGEST,
  };
  return [
    encodeJson(header),
    encodeJson(payload),
    Buffer.from(overrides?.signature ?? new Uint8Array(64).fill(0x55)).toString(
      "base64url",
    ),
  ].join(".");
}

function tokenBody(options?: {
  accessToken?: string;
  extra?: Record<string, unknown>;
  expiresAt?: unknown;
  expiresIn?: unknown;
  refreshToken?: string;
  scope?: unknown;
  tokenType?: unknown;
}): Record<string, unknown> {
  return {
    access_token: options?.accessToken ?? accessToken(),
    expires_at: options?.expiresAt ?? EXP,
    expires_in: options?.expiresIn ?? 600,
    scope: options?.scope ?? "research:read",
    token_type: options?.tokenType ?? "Bearer",
    ...(options?.refreshToken ? { refresh_token: options.refreshToken } : {}),
    ...options?.extra,
  };
}

function response(
  body: string | null = JSON.stringify(tokenBody()),
  options?: {
    cacheControl?: string;
    contentType?: string;
    pragma?: string;
    status?: number;
  },
): Response {
  return new Response(body, {
    headers: {
      "cache-control": options?.cacheControl ?? "no-store",
      "content-type": options?.contentType ?? "application/json; charset=utf-8",
      pragma: options?.pragma ?? "no-cache",
    },
    status: options?.status ?? 200,
  });
}

function expectInvalid(result: Promise<void>): Promise<void> {
  return expect(result).rejects.toBeInstanceOf(
    RemoteMcpOAuthTokenResponseValidationError,
  );
}

describe("Remote MCP OAuth token success response validator", () => {
  it("validates a canonical response through a clone without consuming the original", async () => {
    const original = response();

    await expect(
      validateRemoteMcpOAuthTokenSuccessResponse(original, EXPECTATION),
    ).resolves.toBeUndefined();

    expect(original.bodyUsed).toBe(false);
    await expect(original.json()).resolves.toEqual(tokenBody());
  });

  it("requires and validates an AlphaNet refresh token for offline_access", async () => {
    const expectation = {
      ...EXPECTATION,
      scopes: ["research:read", "offline_access"],
    };
    const payload = {
      ...tokenBody({
        refreshToken: REFRESH_TOKEN,
        scope: "offline_access research:read",
      }),
      access_token: accessToken({
        payload: {
          aud: RESOURCE,
          azp: CLIENT_ID,
          credential_id: CREDENTIAL_ID,
          exp: EXP,
          grant_epoch: 1,
          iat: IAT,
          iss: ISSUER,
          jti: JTI,
          nbf: IAT,
          scope: "research:read offline_access",
          sub: GRANT_ID,
          token_jti_digest: TOKEN_DIGEST,
        },
      }),
    };

    await expect(
      validateRemoteMcpOAuthTokenSuccessResponse(
        response(JSON.stringify(payload)),
        expectation,
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    response(null),
    response("not-json"),
    response("plain text", { contentType: "text/plain" }),
    response(JSON.stringify(tokenBody()), { status: 201 }),
    response(JSON.stringify(tokenBody()), { cacheControl: "public, max-age=60" }),
    response(JSON.stringify(tokenBody()), { pragma: "cache" }),
    response("x".repeat(REMOTE_MCP_OAUTH_TOKEN_RESPONSE_MAX_BYTES + 1)),
  ])("rejects malformed transport response %#", async (candidate) => {
    await expectInvalid(
      validateRemoteMcpOAuthTokenSuccessResponse(candidate, EXPECTATION),
    );
  });

  it.each([
    tokenBody({ extra: { unexpected: true } }),
    Object.fromEntries(Object.entries(tokenBody()).filter(([key]) => key !== "scope")),
    tokenBody({ expiresAt: String(EXP) }),
    tokenBody({ expiresAt: EXP + 1 }),
    tokenBody({ expiresIn: 601 }),
    tokenBody({ scope: "community:read" }),
    tokenBody({ tokenType: "bearer" }),
    tokenBody({ refreshToken: REFRESH_TOKEN }),
  ])("rejects non-canonical token JSON %#", async (body) => {
    await expectInvalid(
      validateRemoteMcpOAuthTokenSuccessResponse(
        response(JSON.stringify(body)),
        EXPECTATION,
      ),
    );
  });

  it.each([
    "",
    " research:read",
    "research:read ",
    "research:read  offline_access",
    "research:read research:read",
    "research:read community:read",
    "research:read unknown:scope",
  ])("rejects malformed or unequal response scope set %#", async (scope) => {
    await expectInvalid(
      validateRemoteMcpOAuthTokenSuccessResponse(
        response(JSON.stringify(tokenBody({ scope }))),
        EXPECTATION,
      ),
    );
  });

  it("rejects a JWT and expires_at that agree with each other but not the 600-second TTL", async () => {
    const wrongExpiry = EXP + 1;
    const token = accessToken({
      payload: {
        aud: RESOURCE,
        azp: CLIENT_ID,
        credential_id: CREDENTIAL_ID,
        exp: wrongExpiry,
        grant_epoch: 1,
        iat: IAT,
        iss: ISSUER,
        jti: JTI,
        nbf: IAT,
        scope: "research:read",
        sub: GRANT_ID,
        token_jti_digest: TOKEN_DIGEST,
      },
    });

    await expectInvalid(
      validateRemoteMcpOAuthTokenSuccessResponse(
        response(
          JSON.stringify(tokenBody({ accessToken: token, expiresAt: wrongExpiry })),
        ),
        EXPECTATION,
      ),
    );
  });

  it("does not consume the original response when validation fails", async () => {
    const original = response(JSON.stringify(tokenBody({ tokenType: "bearer" })));

    await expectInvalid(
      validateRemoteMcpOAuthTokenSuccessResponse(original, EXPECTATION),
    );
    expect(original.bodyUsed).toBe(false);
    await expect(original.json()).resolves.toEqual(tokenBody({ tokenType: "bearer" }));
  });

  it.each([
    "",
    "not-a-jwt",
    `${encodeJson({ alg: "RS256", kid: "key", typ: "JWT" })}.${encodeJson({})}.${Buffer.alloc(64).toString("base64url")}`,
    accessToken({
      header: { alg: "ES256", extra: true, kid: "key", typ: "JWT" },
    }),
    accessToken({ signature: new Uint8Array(63).fill(0x55) }),
  ])("rejects malformed ES256 token %#", async (token) => {
    await expectInvalid(
      validateRemoteMcpOAuthTokenSuccessResponse(
        response(JSON.stringify(tokenBody({ accessToken: token }))),
        EXPECTATION,
      ),
    );
  });

  it.each([
    { iss: "https://attacker.example/api/auth" },
    { aud: "https://attacker.example/mcp" },
    { azp: "another-client" },
    { scope: "community:read" },
    { exp: EXP + 1 },
    { nbf: IAT + 1 },
    { credential_id: "not-a-uuid" },
    { grant_epoch: 0 },
    { token_jti_digest: "not-a-digest" },
    { extra: true },
  ])("rejects token claim mismatch %#", async (override) => {
    const canonical = {
      aud: RESOURCE,
      azp: CLIENT_ID,
      credential_id: CREDENTIAL_ID,
      exp: EXP,
      grant_epoch: 1,
      iat: IAT,
      iss: ISSUER,
      jti: JTI,
      nbf: IAT,
      scope: "research:read",
      sub: GRANT_ID,
      token_jti_digest: TOKEN_DIGEST,
    };
    const token = accessToken({ payload: { ...canonical, ...override } });

    await expectInvalid(
      validateRemoteMcpOAuthTokenSuccessResponse(
        response(JSON.stringify(tokenBody({ accessToken: token }))),
        EXPECTATION,
      ),
    );
  });

  it.each([
    { ...EXPECTATION, issuer: "not-a-url" },
    { ...EXPECTATION, resource: "https://mcp.alphanet.example/not-mcp" },
    { ...EXPECTATION, clientId: "client id with spaces" },
    { ...EXPECTATION, scopes: [] },
    { ...EXPECTATION, scopes: ["offline_access"] },
    { ...EXPECTATION, scopes: ["offline_access", "research:read"] },
    { ...EXPECTATION, scopes: ["research:read", "research:read"] },
    { ...EXPECTATION, scopes: ["unknown:scope"] },
  ])(
    "rejects invalid expectation %# before reading the response",
    async (expectation) => {
      const original = response();

      await expect(
        validateRemoteMcpOAuthTokenSuccessResponse(original, expectation),
      ).rejects.toThrow("Remote MCP OAuth token response expectation is invalid");
      expect(original.bodyUsed).toBe(false);
    },
  );

  it.each([undefined, "wrong-prefix-token", `aln_rt_v1_${"short"}`])(
    "rejects missing or malformed offline refresh token %#",
    async (refreshToken) => {
      const expectation = {
        ...EXPECTATION,
        scopes: ["research:read", "offline_access"],
      };
      const token = accessToken({
        payload: {
          aud: RESOURCE,
          azp: CLIENT_ID,
          credential_id: CREDENTIAL_ID,
          exp: EXP,
          grant_epoch: 1,
          iat: IAT,
          iss: ISSUER,
          jti: JTI,
          nbf: IAT,
          scope: "research:read offline_access",
          sub: GRANT_ID,
          token_jti_digest: TOKEN_DIGEST,
        },
      });
      const body = tokenBody({
        accessToken: token,
        ...(refreshToken ? { refreshToken } : {}),
        scope: "research:read offline_access",
      });

      await expectInvalid(
        validateRemoteMcpOAuthTokenSuccessResponse(
          response(JSON.stringify(body)),
          expectation,
        ),
      );
    },
  );
});
