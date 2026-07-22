import { decodeProtectedHeader, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import {
  actorContextTokenDigestMatches,
  createMcpActorContextAssertion,
  digestInboundMcpTokenJti,
  MCP_ACTOR_ASSERTION_AUDIENCE,
  MCP_ACTOR_ASSERTION_ISSUER,
  verifyMcpActorContextAssertion,
  type McpActorAssertionKeyRing,
} from "./mcp-actor-context.js";

const now = new Date("2026-07-21T20:00:00.000Z");
const keyV1 = Buffer.alloc(32, 0x11);
const keyV2 = Buffer.alloc(32, 0x22);
const tokenJtiDigestKey = Buffer.alloc(32, 0x33);
const inboundTokenJti = "oauth-access-token-jti";
const keyRing: McpActorAssertionKeyRing = {
  currentVersion: 2,
  keys: {
    1: {
      key: keyV1,
      verificationExpiresAt: new Date("2026-07-28T20:00:00.000Z"),
    },
    2: { key: keyV2, verificationExpiresAt: null },
  },
};
const input = {
  credentialId: "10000000-0000-4000-8000-000000000001",
  grantId: "20000000-0000-4000-8000-000000000002",
  requestId: "req_remote_mcp_1",
  scopes: ["research:read", "community:read"] as const,
  tokenJtiDigest: digestInboundMcpTokenJti(inboundTokenJti, tokenJtiDigestKey),
};

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("MCP ActorContext assertions", () => {
  it("signs a bounded assertion and verifies it with the advertised key version", async () => {
    const assertion = await createMcpActorContextAssertion(input, keyRing, {
      now,
      ttlSeconds: 20,
    });

    expect(decodeProtectedHeader(assertion)).toEqual({
      alg: "HS256",
      kid: "v2",
      typ: "JWT",
    });
    await expect(
      verifyMcpActorContextAssertion(assertion, keyRing, now),
    ).resolves.toEqual(
      expect.objectContaining({
        credentialId: input.credentialId,
        expiresAt: new Date("2026-07-21T20:00:20.000Z"),
        grantId: input.grantId,
        issuedAt: now,
        notBefore: now,
        requestId: input.requestId,
        scopes: [...input.scopes],
        tokenJtiDigest: input.tokenJtiDigest,
      }),
    );
  });

  it("keeps prior keys valid during a rotation window", async () => {
    const assertion = await createMcpActorContextAssertion(
      input,
      {
        currentVersion: 1,
        keys: {
          1: { key: keyV1, verificationExpiresAt: null },
          2: {
            key: keyV2,
            verificationExpiresAt: new Date("2026-07-28T20:00:00.000Z"),
          },
        },
      },
      { now },
    );

    await expect(
      verifyMcpActorContextAssertion(assertion, keyRing, now),
    ).resolves.toEqual(
      expect.objectContaining({
        grantId: input.grantId,
        tokenJtiDigest: input.tokenJtiDigest,
      }),
    );
  });

  it("rejects expiry, unknown key ids, wrong audience and overlong lifetimes", async () => {
    const valid = await createMcpActorContextAssertion(input, keyRing, {
      now,
      ttlSeconds: 10,
    });
    await expectCode(
      verifyMcpActorContextAssertion(valid, keyRing, new Date(now.valueOf() + 13_000)),
      "ASSERTION_EXPIRED",
    );

    const unknownKey = await new SignJWT({
      credential_id: input.credentialId,
      request_id: input.requestId,
      scopes: input.scopes,
      token_jti_digest: input.tokenJtiDigest,
    })
      .setProtectedHeader({ alg: "HS256", kid: "v99", typ: "JWT" })
      .setIssuer(MCP_ACTOR_ASSERTION_ISSUER)
      .setAudience(MCP_ACTOR_ASSERTION_AUDIENCE)
      .setSubject(input.grantId)
      .setJti("30000000-0000-4000-8000-000000000003")
      .setIssuedAt(Math.floor(now.valueOf() / 1_000))
      .setNotBefore(Math.floor(now.valueOf() / 1_000))
      .setExpirationTime(Math.floor(now.valueOf() / 1_000) + 10)
      .sign(keyV1);
    await expectCode(
      verifyMcpActorContextAssertion(unknownKey, keyRing, now),
      "ASSERTION_KEY_UNKNOWN",
    );

    const wrongAudience = await new SignJWT({
      credential_id: input.credentialId,
      request_id: input.requestId,
      scopes: input.scopes,
      token_jti_digest: input.tokenJtiDigest,
    })
      .setProtectedHeader({ alg: "HS256", kid: "v2", typ: "JWT" })
      .setIssuer(MCP_ACTOR_ASSERTION_ISSUER)
      .setAudience("urn:alphanet:wrong")
      .setSubject(input.grantId)
      .setJti("30000000-0000-4000-8000-000000000003")
      .setIssuedAt(Math.floor(now.valueOf() / 1_000))
      .setNotBefore(Math.floor(now.valueOf() / 1_000))
      .setExpirationTime(Math.floor(now.valueOf() / 1_000) + 10)
      .sign(keyV2);
    await expectCode(
      verifyMcpActorContextAssertion(wrongAudience, keyRing, now),
      "ASSERTION_INVALID",
    );

    await expectCode(
      createMcpActorContextAssertion(input, keyRing, { now, ttlSeconds: 31 }),
      "ASSERTION_TTL_INVALID",
    );
  });

  it("rejects retired verification keys and key rings without an old-key cutoff", async () => {
    const oldSigningRing: McpActorAssertionKeyRing = {
      currentVersion: 1,
      keys: { 1: { key: keyV1, verificationExpiresAt: null } },
    };
    const assertion = await createMcpActorContextAssertion(input, oldSigningRing, {
      now,
    });

    await expectCode(
      verifyMcpActorContextAssertion(
        assertion,
        {
          currentVersion: 2,
          keys: {
            1: {
              key: keyV1,
              verificationExpiresAt: new Date("2026-07-21T19:59:59.000Z"),
            },
            2: { key: keyV2, verificationExpiresAt: null },
          },
        },
        now,
      ),
      "ASSERTION_KEY_RETIRED",
    );

    await expectCode(
      verifyMcpActorContextAssertion(
        assertion,
        {
          currentVersion: 2,
          keys: {
            1: { key: keyV1, verificationExpiresAt: null },
            2: { key: keyV2, verificationExpiresAt: null },
          },
        },
        now,
      ),
      "ASSERTION_KEY_INVALID",
    );
  });

  it("distinguishes malformed inbound token identifiers from digest-key failures", () => {
    expect(() => digestInboundMcpTokenJti("", tokenJtiDigestKey)).toThrowError(
      expect.objectContaining({ code: "ASSERTION_TOKEN_JTI_INVALID" }),
    );
    expect(() =>
      digestInboundMcpTokenJti("contains\u0000control", tokenJtiDigestKey),
    ).toThrowError(expect.objectContaining({ code: "ASSERTION_TOKEN_JTI_INVALID" }));
    expect(() =>
      digestInboundMcpTokenJti(inboundTokenJti, Buffer.alloc(31)),
    ).toThrowError(expect.objectContaining({ code: "ASSERTION_KEY_INVALID" }));
  });

  it("rejects malformed claims and compares token digests without early exit", async () => {
    const malformed = await new SignJWT({
      credential_id: "not-a-uuid",
      request_id: input.requestId,
      scopes: ["research:read"],
      token_jti_digest: input.tokenJtiDigest,
    })
      .setProtectedHeader({ alg: "HS256", kid: "v2", typ: "JWT" })
      .setIssuer(MCP_ACTOR_ASSERTION_ISSUER)
      .setAudience(MCP_ACTOR_ASSERTION_AUDIENCE)
      .setSubject(input.grantId)
      .setJti("30000000-0000-4000-8000-000000000003")
      .setIssuedAt(Math.floor(now.valueOf() / 1_000))
      .setNotBefore(Math.floor(now.valueOf() / 1_000))
      .setExpirationTime(Math.floor(now.valueOf() / 1_000) + 10)
      .sign(keyV2);
    await expectCode(
      verifyMcpActorContextAssertion(malformed, keyRing, now),
      "ASSERTION_INVALID",
    );

    const ownerLeakingAssertion = await new SignJWT({
      credential_id: input.credentialId,
      owner_id: "40000000-0000-4000-8000-000000000004",
      request_id: input.requestId,
      scopes: ["research:read"],
      token_jti_digest: input.tokenJtiDigest,
    })
      .setProtectedHeader({ alg: "HS256", kid: "v2", typ: "JWT" })
      .setIssuer(MCP_ACTOR_ASSERTION_ISSUER)
      .setAudience(MCP_ACTOR_ASSERTION_AUDIENCE)
      .setSubject(input.grantId)
      .setJti("30000000-0000-4000-8000-000000000003")
      .setIssuedAt(Math.floor(now.valueOf() / 1_000))
      .setNotBefore(Math.floor(now.valueOf() / 1_000))
      .setExpirationTime(Math.floor(now.valueOf() / 1_000) + 10)
      .sign(keyV2);
    await expectCode(
      verifyMcpActorContextAssertion(ownerLeakingAssertion, keyRing, now),
      "ASSERTION_INVALID",
    );

    const digest = input.tokenJtiDigest;
    expect(actorContextTokenDigestMatches(digest, digest)).toBe(true);
    expect(actorContextTokenDigestMatches(digest, digest.replace(/.$/, "A"))).toBe(false);
    expect(actorContextTokenDigestMatches(digest, "not-a-digest")).toBe(false);
  });

  it("maps invalid assertion inputs to the stable boundary error", async () => {
    await expectCode(
      createMcpActorContextAssertion(
        { ...input, tokenJtiDigest: "raw-jti-must-not-cross-the-boundary" },
        keyRing,
        { now },
      ),
      "ASSERTION_INVALID",
    );
    await expectCode(
      createMcpActorContextAssertion(
        { ...input, tokenJtiDigest: `${"A".repeat(42)}B` },
        keyRing,
        { now },
      ),
      "ASSERTION_INVALID",
    );
    await expectCode(
      createMcpActorContextAssertion(
        { ...input, scopes: ["research:read", "research:read"] },
        keyRing,
        { now },
      ),
      "ASSERTION_INVALID",
    );
  });
});
