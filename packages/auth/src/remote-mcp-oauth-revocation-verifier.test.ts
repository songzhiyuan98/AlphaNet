import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import { digestInboundMcpTokenJti } from "./mcp-actor-context.js";
import { createAlphaNetRemoteMcpOAuthRevocationAccessTokenVerifier } from "./remote-mcp-oauth-revocation-verifier.js";

const issuer = "https://api.alphanet.test/api/auth";
const resource = "https://mcp.alphanet.test/mcp";
const clientId = "codex-staging-client";
const grantId = "10000000-0000-4000-8000-000000000001";
const credentialId = "20000000-0000-4000-8000-000000000002";
const jti = "30000000-0000-4000-8000-000000000003";
const now = new Date("2026-07-22T18:00:00.000Z");
const issuedAt = Math.floor(now.getTime() / 1_000) - 60;
const digestKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

async function fixture(overrides: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const kid = "test-signing-key";
  const publicJwk = await exportJWK(publicKey);
  const payload = {
    aud: resource,
    azp: clientId,
    credential_id: credentialId,
    exp: issuedAt + 600,
    grant_epoch: 1,
    iat: issuedAt,
    iss: issuer,
    jti,
    nbf: issuedAt,
    scope: "research:read offline_access",
    sub: grantId,
    token_jti_digest: digestInboundMcpTokenJti(jti, digestKey),
    ...overrides,
  };
  return {
    getPublicJwks: vi.fn(() =>
      Promise.resolve({
        cacheControl: "public, max-age=300, must-revalidate" as const,
        document: {
          keys: [
            {
              alg: "ES256" as const,
              crv: "P-256" as const,
              kid,
              kty: "EC" as const,
              use: "sig" as const,
              x: publicJwk.x!,
              y: publicJwk.y!,
            },
          ],
        },
      }),
    ),
    token: await new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
      .sign(privateKey),
  };
}

function verifier(getPublicJwks: Awaited<ReturnType<typeof fixture>>["getPublicJwks"]) {
  return createAlphaNetRemoteMcpOAuthRevocationAccessTokenVerifier({
    getPublicJwks,
    issuer,
    now: () => now,
    resource,
    tokenJtiDigestKey: digestKey,
  });
}

describe("Remote MCP OAuth revocation access-token verifier", () => {
  it("returns only the signed revocation authority locators", async () => {
    const valid = await fixture();

    await expect(verifier(valid.getPublicJwks)(valid.token)).resolves.toEqual({
      clientId,
      grantId,
      jti,
      resource,
    });
  });

  it.each([
    ["wrong digest", { token_jti_digest: "A".repeat(43) }],
    ["wrong audience", { aud: "https://other.alphanet.test/mcp" }],
    ["wrong lifetime", { exp: issuedAt + 601 }],
    ["extra claim", { unexpected: true }],
  ])("treats a signed token with %s as unknown", async (_name, overrides) => {
    const invalid = await fixture(overrides);

    await expect(verifier(invalid.getPublicJwks)(invalid.token)).resolves.toBeNull();
  });

  it("treats an invalid signature as unknown without a token oracle", async () => {
    const trusted = await fixture();
    const attacker = await fixture();

    await expect(verifier(trusted.getPublicJwks)(attacker.token)).resolves.toBeNull();
  });

  it("propagates JWKS authority failure so revocation fails closed", async () => {
    const valid = await fixture();
    const getPublicJwks = vi.fn(() => Promise.reject(new Error("signer unavailable")));

    await expect(verifier(getPublicJwks)(valid.token)).rejects.toThrow(
      "signer unavailable",
    );
  });
});
