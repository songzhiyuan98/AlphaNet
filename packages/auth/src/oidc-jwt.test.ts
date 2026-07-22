import { createServer } from "node:http";

import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWTVerifyGetKey,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createOidcJwtVerifier,
  OidcJwtVerificationError,
  type OidcJwtVerifierConfig,
} from "./oidc-jwt.js";

const now = new Date("2026-07-21T19:00:00.000Z");
const issuer = "https://login.alphanet.test/workforce";
const audience = "urn:alphanet:admin-api";
const subject = "workforce-user-01HXYZ";
let rsaPrivateKey: CryptoKey;
let rsaPublicKey: CryptoKey;
let ecPrivateKey: CryptoKey;
let ecPublicKey: CryptoKey;

const config: OidcJwtVerifierConfig = {
  algorithms: ["RS256"],
  audience,
  clockToleranceSeconds: 0,
  issuer,
  jwksUri: `${issuer}/.well-known/jwks.json`,
  mfa: {
    allowedAcrValues: ["urn:alphanet:assurance:mfa"],
    allowAmrMfa: true,
  },
};

beforeAll(async () => {
  const rsa = await generateKeyPair("RS256", { extractable: true });
  rsaPrivateKey = rsa.privateKey;
  rsaPublicKey = rsa.publicKey;
  const ec = await generateKeyPair("ES256", { extractable: true });
  ecPrivateKey = ec.privateKey;
  ecPublicKey = ec.publicKey;
});

function keyResolver(key: CryptoKey): JWTVerifyGetKey {
  return () => Promise.resolve(key);
}

function jwt(
  claims: {
    acr?: unknown;
    algorithm?: "ES256" | "RS256";
    amr?: unknown;
    aud?: string;
    exp?: number | null;
    iss?: string;
    jku?: string;
    nbf?: number | null;
    sub?: string | null;
  } = {},
): Promise<string> {
  const algorithm = claims.algorithm ?? "RS256";
  const builder = new SignJWT({
    ...(claims.acr === undefined
      ? { acr: "urn:alphanet:assurance:mfa" }
      : { acr: claims.acr }),
    ...(claims.amr === undefined ? {} : { amr: claims.amr }),
  })
    .setProtectedHeader({
      alg: algorithm,
      kid: `${algorithm.toLowerCase()}-test-key`,
      ...(claims.jku ? { jku: claims.jku } : {}),
    })
    .setIssuer(claims.iss ?? issuer)
    .setAudience(claims.aud ?? audience)
    .setIssuedAt(Math.floor(now.valueOf() / 1_000));

  if (claims.sub !== null) builder.setSubject(claims.sub ?? subject);
  if (claims.nbf !== null) {
    builder.setNotBefore(claims.nbf ?? Math.floor(now.valueOf() / 1_000) - 30);
  }
  if (claims.exp !== null) {
    builder.setExpirationTime(claims.exp ?? Math.floor(now.valueOf() / 1_000) + 300);
  }
  return builder.sign(algorithm === "RS256" ? rsaPrivateKey : ecPrivateKey);
}

function verifier(
  overrides: Partial<OidcJwtVerifierConfig> = {},
  resolver: JWTVerifyGetKey = keyResolver(rsaPublicKey),
) {
  return createOidcJwtVerifier(
    { ...config, ...overrides },
    { keyResolver: resolver, now: () => now },
  );
}

async function expectInvalid(token: Promise<string>): Promise<void> {
  await expect(verifier().verify(await token)).rejects.toMatchObject({
    code: "invalid_token",
    name: "OidcJwtVerificationError",
  });
}

describe("OIDC JWT verifier", () => {
  it("verifies the configured issuer, audience, JWKS key, algorithm, lifetime, subject, and acr MFA", async () => {
    const token = await jwt({ jku: "https://attacker.invalid/jwks.json" });

    await expect(verifier().verify(token)).resolves.toEqual({
      issuer,
      mfa: {
        amrMfa: false,
        matchedAcr: "urn:alphanet:assurance:mfa",
        method: "acr",
      },
      subject,
    });
  });

  it("fetches only the configured remote JWKS and ignores a token-controlled jku", async () => {
    const jwk = await exportJWK(rsaPublicKey);
    const requestedPaths: string[] = [];
    const server = createServer((request, response) => {
      requestedPaths.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          keys: [{ ...jwk, alg: "RS256", kid: "rs256-test-key", use: "sig" }],
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("test JWKS server did not bind to a TCP port");
    }

    try {
      const remoteVerifier = createOidcJwtVerifier(
        {
          ...config,
          jwksUri: `http://127.0.0.1:${address.port}/trusted-jwks`,
        },
        { now: () => now },
      );
      await expect(
        remoteVerifier.verify(
          await jwt({ jku: "https://attacker.invalid/controlled-jwks" }),
        ),
      ).resolves.toMatchObject({ subject });
      expect(requestedPaths).toEqual(["/trusted-jwks"]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("accepts exact amr=mfa evidence when configured and records both mechanisms", async () => {
    await expect(
      verifier().verify(await jwt({ amr: ["pwd", "mfa"] })),
    ).resolves.toMatchObject({
      mfa: {
        amrMfa: true,
        matchedAcr: "urn:alphanet:assurance:mfa",
        method: "acr_and_amr_mfa",
      },
    });

    await expect(
      verifier({
        mfa: { allowedAcrValues: [], allowAmrMfa: true },
      }).verify(await jwt({ acr: "urn:untrusted:acr", amr: ["mfa"] })),
    ).resolves.toMatchObject({
      mfa: { amrMfa: true, matchedAcr: null, method: "amr_mfa" },
    });
  });

  it("rejects tokens with the wrong issuer, audience, or signing algorithm", async () => {
    await expectInvalid(jwt({ iss: "https://attacker.invalid" }));
    await expectInvalid(jwt({ aud: "urn:someone-else" }));

    const esToken = await jwt({ algorithm: "ES256" });
    await expect(
      verifier({}, keyResolver(ecPublicKey)).verify(esToken),
    ).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("requires exp and a bounded subject while accepting an omitted nbf", async () => {
    await expectInvalid(jwt({ exp: null }));
    await expectInvalid(jwt({ sub: null }));
    await expectInvalid(jwt({ sub: "" }));
    await expectInvalid(jwt({ sub: `subject-${"x".repeat(256)}` }));
    await expect(verifier().verify(await jwt({ nbf: null }))).resolves.toMatchObject({
      subject,
    });
  });

  it("rejects expired, not-yet-valid, and non-MFA tokens", async () => {
    const timestamp = Math.floor(now.valueOf() / 1_000);
    await expectInvalid(jwt({ exp: timestamp - 1 }));
    await expectInvalid(jwt({ nbf: timestamp + 1 }));
    await expectInvalid(jwt({ acr: "urn:untrusted:acr", amr: ["pwd"] }));
    await expectInvalid(jwt({ acr: ["urn:alphanet:assurance:mfa"] }));
    await expectInvalid(jwt({ amr: "mfa" }));
  });

  it("maps provider/JWKS outages to a claim-free unavailable error", async () => {
    const token = await jwt();
    const resolver: JWTVerifyGetKey = () => {
      throw new Error(`JWKS unavailable for secret token ${token}`);
    };

    let caught: unknown;
    try {
      await verifier({}, resolver).verify(token);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OidcJwtVerificationError);
    expect(caught).toMatchObject({ code: "identity_provider_unavailable" });
    expect(JSON.stringify(caught)).not.toContain(token);
    expect(String(caught)).not.toContain(token);
  });

  it("rejects unsafe verifier configurations before making a JWKS request", () => {
    expect(() =>
      createOidcJwtVerifier({
        ...config,
        algorithms: ["HS256" as "RS256"],
      }),
    ).toThrow("algorithms");
    expect(() =>
      createOidcJwtVerifier({
        ...config,
        mfa: { allowedAcrValues: [], allowAmrMfa: false },
      }),
    ).toThrow("MFA");
    expect(() =>
      createOidcJwtVerifier({
        ...config,
        jwksUri: "file:///tmp/attacker-jwks.json",
      }),
    ).toThrow("jwksUri");
    expect(() =>
      createOidcJwtVerifier({
        ...config,
        jwksUri: "http://idp.internal/jwks.json",
      }),
    ).toThrow("jwksUri");
    expect(() =>
      createOidcJwtVerifier({
        ...config,
        issuer: "https://login.alphanet.test/workforce?tenant=forged",
      }),
    ).toThrow("issuer");
  });
});
