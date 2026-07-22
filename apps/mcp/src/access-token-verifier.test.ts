import { digestInboundMcpTokenJti } from "@alphanet/auth";
import {
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  errors,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createRemoteMcpAccessTokenVerifier,
  REMOTE_MCP_ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS,
  REMOTE_MCP_ACCESS_TOKEN_MAX_BYTES,
  REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS,
} from "./access-token-verifier.js";

const ISSUER = "https://auth.alphanet.example/api/auth";
const JWKS_URL = "https://keys.alphanet.example/remote-mcp/jwks.json";
const RESOURCE = "https://mcp.alphanet.example/mcp";
const NOW_SECONDS = 2_000_000_000;
const GRANT_ID = "10000000-0000-4000-8000-000000000001";
const CREDENTIAL_ID = "20000000-0000-4000-8000-000000000002";
const TOKEN_ID = "30000000-0000-4000-8000-000000000003";
const TOKEN_JTI_DIGEST_KEY = Buffer.from(
  "2b132b5336f59f987e0dd4f8a63997698a3df512e89cfeb34b34bbfcfb09ea63",
  "hex",
);
const TOKEN_JTI_DIGEST = digestInboundMcpTokenJti(TOKEN_ID, TOKEN_JTI_DIGEST_KEY);

type GeneratedEs256KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

let privateKey: GeneratedEs256KeyPair["privateKey"];
let publicKey: GeneratedEs256KeyPair["publicKey"];

beforeAll(async () => {
  const generated = await generateKeyPair("ES256", { extractable: true });
  privateKey = generated.privateKey;
  publicKey = generated.publicKey;
});

function canonicalPayload(overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    aud: RESOURCE,
    azp: "mcp-client-v1",
    credential_id: CREDENTIAL_ID,
    exp: NOW_SECONDS + REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS,
    grant_epoch: 7,
    iat: NOW_SECONDS,
    iss: ISSUER,
    jti: TOKEN_ID,
    nbf: NOW_SECONDS,
    scope: "research:read community:read offline_access",
    sub: GRANT_ID,
    token_jti_digest: TOKEN_JTI_DIGEST,
    ...overrides,
  };
}

async function token(
  payloadOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT(canonicalPayload(payloadOverrides))
    .setProtectedHeader({
      alg: "ES256",
      kid: "remote-mcp-v1",
      typ: "JWT",
      ...headerOverrides,
    })
    .sign(privateKey);
}

function verifier(keyResolver: JWTVerifyGetKey = () => Promise.resolve(publicKey)) {
  return createRemoteMcpAccessTokenVerifier(
    {
      issuer: ISSUER,
      jwksUrl: JWKS_URL,
      resource: RESOURCE,
      tokenJtiDigestKey: TOKEN_JTI_DIGEST_KEY,
    },
    { keyResolver, now: () => new Date(NOW_SECONDS * 1_000) },
  );
}

async function expectInvalid(value: string): Promise<void> {
  const result = verifier().verifyAccessToken(value);
  await expect(result).rejects.toBeInstanceOf(InvalidTokenError);
  await expect(result).rejects.toMatchObject({
    errorCode: "invalid_token",
    message: "Invalid access token.",
  });
}

describe("Remote MCP Access Token verifier", () => {
  it("returns only trusted MCP AuthInfo and strips offline_access", async () => {
    const signed = await token();
    const keyResolver = vi.fn<JWTVerifyGetKey>(() => Promise.resolve(publicKey));

    await expect(verifier(keyResolver).verifyAccessToken(signed)).resolves.toEqual({
      clientId: "mcp-client-v1",
      expiresAt: NOW_SECONDS + REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS,
      extra: {
        actor: {
          credentialId: CREDENTIAL_ID,
          grantId: GRANT_ID,
          tokenJtiDigest: TOKEN_JTI_DIGEST,
        },
      },
      resource: new URL(RESOURCE),
      scopes: ["research:read", "community:read"],
      token: signed,
    });
    expect(keyResolver).toHaveBeenCalledOnce();
  });

  it("accepts every unique Agent scope without offline_access", async () => {
    const signed = await token({
      scope:
        "research:read community:read notifications:read actions:read content:write reaction:write follow:write",
    });
    const result = await verifier().verifyAccessToken(signed);
    expect(result.scopes).toEqual([
      "research:read",
      "community:read",
      "notifications:read",
      "actions:read",
      "content:write",
      "reaction:write",
      "follow:write",
    ]);
  });

  it.each([
    ["unknown scope", { scope: "research:read admin:write" }],
    ["duplicate scope", { scope: "research:read research:read" }],
    ["offline-only scope", { scope: "offline_access" }],
    ["leading whitespace", { scope: " research:read" }],
    ["double whitespace", { scope: "research:read  community:read" }],
  ])("rejects %s", async (_label, overrides) => {
    await expectInvalid(await token(overrides));
  });

  it("fails closed when the injected verification clock throws or returns an invalid Date", async () => {
    const expired = await token({
      exp: NOW_SECONDS - 1,
      iat: NOW_SECONDS - 601,
      nbf: NOW_SECONDS - 601,
    });
    const keyResolver = vi.fn<JWTVerifyGetKey>(() => Promise.resolve(publicKey));

    for (const now of [
      () => new Date(Number.NaN),
      () => {
        throw new Error("sensitive clock failure");
      },
    ]) {
      const promise = createRemoteMcpAccessTokenVerifier(
        {
          issuer: ISSUER,
          jwksUrl: JWKS_URL,
          resource: RESOURCE,
          tokenJtiDigestKey: TOKEN_JTI_DIGEST_KEY,
        },
        { keyResolver, now },
      ).verifyAccessToken(expired);
      await expect(promise).rejects.toEqual(
        new ServerError("Access-token verification is temporarily unavailable."),
      );
    }
    expect(keyResolver).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong audience", { aud: "https://other.example/mcp" }],
    ["audience array", { aud: [RESOURCE] }],
    ["wrong issuer", { iss: "https://attacker.example" }],
    ["non-canonical Grant UUID", { sub: "A0000000-0000-4000-8000-000000000001" }],
    ["non-canonical Credential UUID", { credential_id: "not-a-uuid" }],
    ["non-canonical token UUID", { jti: "00000000-0000-0000-0000-000000000000" }],
    ["invalid Grant epoch", { grant_epoch: 0 }],
    ["invalid client id", { azp: "client id" }],
    ["invalid digest", { token_jti_digest: `${TOKEN_JTI_DIGEST}=` }],
  ])("rejects %s", async (_label, overrides) => {
    await expectInvalid(await token(overrides));
  });

  it("rejects a valid token when configured with a different digest key", async () => {
    const wrongKey = Buffer.from(TOKEN_JTI_DIGEST_KEY);
    wrongKey.writeUInt8(wrongKey.readUInt8(0) ^ 0xff, 0);
    const boundary = createRemoteMcpAccessTokenVerifier(
      {
        issuer: ISSUER,
        jwksUrl: JWKS_URL,
        resource: RESOURCE,
        tokenJtiDigestKey: wrongKey,
      },
      {
        keyResolver: () => Promise.resolve(publicKey),
        now: () => new Date(NOW_SECONDS * 1_000),
      },
    );

    await expect(boundary.verifyAccessToken(await token())).rejects.toEqual(
      new InvalidTokenError("Invalid access token."),
    );
  });

  it("rejects a canonical but incorrect token_jti_digest", async () => {
    await expectInvalid(
      await token({ token_jti_digest: Buffer.alloc(32, 0x77).toString("base64url") }),
    );
  });

  it("copies the token jti digest key at construction", async () => {
    const mutableKey = Buffer.from(TOKEN_JTI_DIGEST_KEY);
    const boundary = createRemoteMcpAccessTokenVerifier(
      {
        issuer: ISSUER,
        jwksUrl: JWKS_URL,
        resource: RESOURCE,
        tokenJtiDigestKey: mutableKey,
      },
      {
        keyResolver: () => Promise.resolve(publicKey),
        now: () => new Date(NOW_SECONDS * 1_000),
      },
    );
    mutableKey.fill(0);

    await expect(boundary.verifyAccessToken(await token())).resolves.toMatchObject({
      clientId: "mcp-client-v1",
    });
  });

  it.each([Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33)])(
    "rejects invalid token jti digest key material without exposing it",
    (tokenJtiDigestKey) => {
      expect(() =>
        createRemoteMcpAccessTokenVerifier({
          issuer: ISSUER,
          jwksUrl: JWKS_URL,
          resource: RESOURCE,
          tokenJtiDigestKey,
        }),
      ).toThrowError("tokenJtiDigestKey must contain exactly 32 bytes");
    },
  );

  it("rejects any extra payload claim", async () => {
    await expectInvalid(await token({ owner_id: GRANT_ID }));
  });

  it("rejects a missing payload claim", async () => {
    const payload = canonicalPayload();
    delete payload["credential_id"];
    const signed = await new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", kid: "remote-mcp-v1", typ: "JWT" })
      .sign(privateKey);
    await expectInvalid(signed);
  });

  it.each([
    ["incorrect lifetime", { exp: NOW_SECONDS + 599 }],
    ["nbf does not equal iat", { nbf: NOW_SECONDS + 1 }],
    [
      "expired token",
      {
        exp: NOW_SECONDS - REMOTE_MCP_ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS - 1,
        iat:
          NOW_SECONDS -
          REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS -
          REMOTE_MCP_ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS -
          1,
        nbf:
          NOW_SECONDS -
          REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS -
          REMOTE_MCP_ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS -
          1,
      },
    ],
    [
      "not-yet-active token",
      {
        exp:
          NOW_SECONDS +
          REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS +
          REMOTE_MCP_ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS +
          1,
        iat: NOW_SECONDS + REMOTE_MCP_ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS + 1,
        nbf: NOW_SECONDS + REMOTE_MCP_ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS + 1,
      },
    ],
  ])("rejects %s", async (_label, overrides) => {
    await expectInvalid(await token(overrides));
  });

  it.each([1, REMOTE_MCP_ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS])(
    "accepts an exact-TTL token issued %i second(s) in the future",
    async (futureOffsetSeconds) => {
      const issuedAt = NOW_SECONDS + futureOffsetSeconds;
      const signed = await token({
        exp: issuedAt + REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS,
        iat: issuedAt,
        nbf: issuedAt,
      });

      await expect(verifier().verifyAccessToken(signed)).resolves.toMatchObject({
        expiresAt: issuedAt + REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS,
      });
    },
  );

  it("rejects a non-ES256 algorithm before key resolution", async () => {
    const hmacKey = new TextEncoder().encode(
      "a-secure-test-key-that-is-at-least-32-bytes",
    );
    const signed = await new SignJWT(canonicalPayload())
      .setProtectedHeader({ alg: "HS256", kid: "remote-mcp-v1", typ: "JWT" })
      .sign(hmacKey);
    const keyResolver = vi.fn<JWTVerifyGetKey>(() => Promise.resolve(publicKey));
    await expect(verifier(keyResolver).verifyAccessToken(signed)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    expect(keyResolver).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong typ", { typ: "at+jwt" }],
    ["missing kid", { kid: undefined }],
    ["invalid kid", { kid: "key id" }],
    ["token-controlled jku", { jku: "https://attacker.example/jwks.json" }],
  ])("rejects %s before key resolution", async (_label, overrides) => {
    const signed = await token({}, overrides);
    const keyResolver = vi.fn<JWTVerifyGetKey>(() => Promise.resolve(publicKey));
    await expect(verifier(keyResolver).verifyAccessToken(signed)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    expect(keyResolver).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized values without resolving a key", async () => {
    const keyResolver = vi.fn<JWTVerifyGetKey>(() => Promise.resolve(publicKey));
    const boundary = verifier(keyResolver);
    await expect(boundary.verifyAccessToken("not-a-jwt")).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    await expect(
      boundary.verifyAccessToken("x".repeat(REMOTE_MCP_ACCESS_TOKEN_MAX_BYTES + 1)),
    ).rejects.toBeInstanceOf(InvalidTokenError);
    expect(keyResolver).not.toHaveBeenCalled();
  });

  it("maps signature and unknown-kid failures to the same non-leaking invalid-token error", async () => {
    const other = await generateKeyPair("ES256");
    const resolverWithWrongKey: JWTVerifyGetKey = () => Promise.resolve(other.publicKey);
    const promise = verifier(resolverWithWrongKey).verifyAccessToken(await token());
    await expect(promise).rejects.toEqual(new InvalidTokenError("Invalid access token."));

    const unknownKidResolver: JWTVerifyGetKey = () =>
      Promise.reject(new errors.JWKSNoMatchingKey());
    await expect(
      verifier(unknownKidResolver).verifyAccessToken(await token()),
    ).rejects.toEqual(new InvalidTokenError("Invalid access token."));
  });

  it("maps JWKS dependency failures to a non-leaking ServerError", async () => {
    const resolver: JWTVerifyGetKey = () =>
      Promise.reject(new Error("sensitive upstream failure"));
    const promise = verifier(resolver).verifyAccessToken(await token());
    const rejection: unknown = await promise.catch((error: unknown): unknown => error);
    expect(rejection).toBeInstanceOf(ServerError);
    expect(rejection).toMatchObject({
      errorCode: "server_error",
      message: "Access-token verification is temporarily unavailable.",
    });
    if (!(rejection instanceof ServerError)) {
      throw new Error("Expected ServerError");
    }
    expect(rejection.message).not.toContain("sensitive");

    const timeoutResolver: JWTVerifyGetKey = () =>
      Promise.reject(new errors.JWKSTimeout());
    await expect(
      verifier(timeoutResolver).verifyAccessToken(await token()),
    ).rejects.toEqual(
      new ServerError("Access-token verification is temporarily unavailable."),
    );

    const unsupportedResolver: JWTVerifyGetKey = () =>
      Promise.reject(new errors.JOSENotSupported());
    await expect(
      verifier(unsupportedResolver).verifyAccessToken(await token()),
    ).rejects.toEqual(
      new ServerError("Access-token verification is temporarily unavailable."),
    );
  });

  it("accepts only canonical pinned HTTPS or loopback URLs", () => {
    expect(() =>
      createRemoteMcpAccessTokenVerifier(
        {
          issuer: "http://localhost:4000/api/auth",
          jwksUrl: "http://127.0.0.1:4000/api/auth/jwks",
          resource: "http://[::1]:4100/mcp",
          tokenJtiDigestKey: TOKEN_JTI_DIGEST_KEY,
        },
        { keyResolver: () => Promise.resolve(publicKey) },
      ),
    ).not.toThrow();

    for (const config of [
      {
        issuer: "not-a-url",
        jwksUrl: JWKS_URL,
        resource: RESOURCE,
        tokenJtiDigestKey: TOKEN_JTI_DIGEST_KEY,
      },
      {
        issuer: "http://auth.internal/api/auth",
        jwksUrl: JWKS_URL,
        resource: RESOURCE,
        tokenJtiDigestKey: TOKEN_JTI_DIGEST_KEY,
      },
      {
        issuer: ISSUER,
        jwksUrl: "https://keys.example/jwks#fragment",
        resource: RESOURCE,
        tokenJtiDigestKey: TOKEN_JTI_DIGEST_KEY,
      },
      {
        issuer: ISSUER,
        jwksUrl: JWKS_URL,
        resource: "https://mcp.example/not-mcp",
        tokenJtiDigestKey: TOKEN_JTI_DIGEST_KEY,
      },
      {
        issuer: ISSUER,
        jwksUrl: JWKS_URL,
        resource: "https://mcp.example/mcp/",
        tokenJtiDigestKey: TOKEN_JTI_DIGEST_KEY,
      },
    ]) {
      expect(() =>
        createRemoteMcpAccessTokenVerifier(config, {
          keyResolver: () => Promise.resolve(publicKey),
        }),
      ).toThrow();
    }
  });

  it("works with a JOSE-compatible imported public JWK resolver", async () => {
    const publicJwk = await exportJWK(publicKey);
    const resolver: JWTVerifyGetKey = async () =>
      importJWK({ ...publicJwk, alg: "ES256" }, "ES256");
    await expect(
      verifier(resolver).verifyAccessToken(await token()),
    ).resolves.toMatchObject({
      clientId: "mcp-client-v1",
      scopes: ["research:read", "community:read"],
    });
  });
});
