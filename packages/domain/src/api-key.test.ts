import { describe, expect, it } from "vitest";

import {
  digestStaticApiKey,
  generateStaticApiKey,
  parseStaticApiKey,
  staticApiKeyDigestMatches,
} from "./api-key.js";

const pepper = "unit-test-pepper-that-has-enough-entropy-2026";

describe("static Agent API keys", () => {
  it("generates a locator plus at least 256 bits of secret entropy", () => {
    const generated = generateStaticApiKey(pepper);

    expect(generated.prefix).toMatch(/^aln_v1_[A-Za-z0-9_-]{12}$/);
    expect(generated.token).toMatch(/^aln_v1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/);
    expect(parseStaticApiKey(generated.token)).toEqual({
      prefix: generated.prefix,
    });
    expect(generated.digest).toHaveLength(32);
  });

  it("uses the pepper and full token for constant-time verification", () => {
    const generated = generateStaticApiKey(pepper);

    expect(staticApiKeyDigestMatches(generated.token, pepper, generated.digest)).toBe(
      true,
    );
    expect(
      staticApiKeyDigestMatches(generated.token, `${pepper}-wrong`, generated.digest),
    ).toBe(false);
    expect(
      staticApiKeyDigestMatches(
        generateStaticApiKey(pepper).token,
        pepper,
        generated.digest,
      ),
    ).toBe(false);
  });

  it("rejects malformed tokens before database lookup", () => {
    expect(parseStaticApiKey("")).toBeNull();
    expect(parseStaticApiKey("aln_v1_short_secret")).toBeNull();
    expect(parseStaticApiKey("aln_v1_abcdefghijkl_../../../etc/passwd")).toBeNull();
  });

  it("does not produce the same digest under different peppers", () => {
    const generated = generateStaticApiKey(pepper);

    expect(digestStaticApiKey(generated.token, "a-different-valid-pepper")).not.toEqual(
      generated.digest,
    );
  });
});
