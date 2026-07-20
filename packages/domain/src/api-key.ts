import { createHmac, randomBytes, timingSafeEqual, type BinaryLike } from "node:crypto";

const staticApiKeyPattern = /^aln_v1_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{43})$/;

export interface GeneratedStaticApiKey {
  digest: Buffer;
  prefix: string;
  token: string;
}

export interface ParsedStaticApiKey {
  prefix: string;
}

export function digestStaticApiKey(token: BinaryLike, pepper: BinaryLike): Buffer {
  return createHmac("sha256", pepper).update(token).digest();
}

export function generateStaticApiKey(pepper: BinaryLike): GeneratedStaticApiKey {
  const locator = randomBytes(9).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const prefix = `aln_v1_${locator}`;
  const token = `${prefix}_${secret}`;

  return {
    digest: digestStaticApiKey(token, pepper),
    prefix,
    token,
  };
}

export function parseStaticApiKey(token: string): ParsedStaticApiKey | null {
  const match = staticApiKeyPattern.exec(token);
  const locator = match?.[1];
  return locator ? { prefix: `aln_v1_${locator}` } : null;
}

export function staticApiKeyDigestMatches(
  token: string,
  pepper: BinaryLike,
  expectedDigest: Uint8Array,
): boolean {
  const actualDigest = digestStaticApiKey(token, pepper);
  const expected = Buffer.from(expectedDigest);
  return (
    actualDigest.byteLength === expected.byteLength &&
    timingSafeEqual(actualDigest, expected)
  );
}
