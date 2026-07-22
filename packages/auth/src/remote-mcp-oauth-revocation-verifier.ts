import { timingSafeEqual } from "node:crypto";

import { AGENT_SCOPES } from "@alphanet/contracts";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTPayload,
} from "jose";

import { digestInboundMcpTokenJti } from "./mcp-actor-context.js";
import type { AlphaNetRemoteMcpOAuthSigningService } from "./remote-mcp-oauth-signing.js";
import type {
  AlphaNetRemoteMcpOAuthRevocationOptions,
  VerifiedRemoteMcpAccessTokenForRevocation,
} from "./remote-mcp-oauth-revocation.js";

const ACCESS_TOKEN_MAX_BYTES = 16 * 1_024;
const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
const CLOCK_TOLERANCE_SECONDS = 5;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_VISIBLE_ASCII = /^[\x21-\x7e]+$/u;
const TOKEN_JTI_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const AGENT_SCOPE_SET = new Set<string>(AGENT_SCOPES);
const HEADER_KEYS = ["alg", "kid", "typ"] as const;
const PAYLOAD_KEYS = [
  "aud",
  "azp",
  "credential_id",
  "exp",
  "grant_epoch",
  "iat",
  "iss",
  "jti",
  "nbf",
  "scope",
  "sub",
  "token_jti_digest",
] as const;

export interface AlphaNetRemoteMcpOAuthRevocationVerifierOptions {
  getPublicJwks: AlphaNetRemoteMcpOAuthSigningService["getPublicJwks"];
  issuer: string;
  now?: (() => Date) | undefined;
  resource: string;
  tokenJtiDigestKey: Uint8Array;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function canonicalUrl(value: string, resource: boolean): boolean {
  try {
    const url = new URL(value);
    return (
      url.toString() === value &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      (!resource || url.pathname === "/mcp") &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          (url.hostname === "localhost" ||
            url.hostname === "127.0.0.1" ||
            url.hostname === "[::1]")))
    );
  } catch {
    return false;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validClientId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    Buffer.byteLength(value, "utf8") <= 200 &&
    SAFE_VISIBLE_ASCII.test(value)
  );
}

function validScopes(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const scopes = value.split(" ");
  return (
    scopes.length >= 1 &&
    scopes.length <= AGENT_SCOPES.length + 1 &&
    new Set(scopes).size === scopes.length &&
    scopes.some((scope) => scope !== "offline_access") &&
    scopes.every((scope) => scope === "offline_access" || AGENT_SCOPE_SET.has(scope))
  );
}

function validTokenJtiDigest(value: unknown, jti: string, key: Uint8Array): boolean {
  if (typeof value !== "string" || !TOKEN_JTI_DIGEST_PATTERN.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    return false;
  }
  const expected = Buffer.from(digestInboundMcpTokenJti(jti, key), "base64url");
  return timingSafeEqual(decoded, expected);
}

function validatePayload(
  payload: JWTPayload,
  issuer: string,
  resource: string,
  digestKey: Uint8Array,
): VerifiedRemoteMcpAccessTokenForRevocation | null {
  if (
    !hasExactKeys(payload, PAYLOAD_KEYS) ||
    payload.iss !== issuer ||
    payload.aud !== resource ||
    !validClientId(payload["azp"]) ||
    !isUuid(payload.sub) ||
    !isUuid(payload.jti) ||
    !isUuid(payload["credential_id"]) ||
    !isPositiveSafeInteger(payload["grant_epoch"]) ||
    !isPositiveSafeInteger(payload.iat) ||
    !isPositiveSafeInteger(payload.nbf) ||
    !isPositiveSafeInteger(payload.exp) ||
    payload.nbf !== payload.iat ||
    payload.exp - payload.iat !== ACCESS_TOKEN_TTL_SECONDS ||
    !validScopes(payload["scope"]) ||
    !validTokenJtiDigest(payload["token_jti_digest"], payload.jti, digestKey)
  ) {
    return null;
  }
  return Object.freeze({
    clientId: payload["azp"],
    grantId: payload.sub,
    jti: payload.jti,
    resource,
  });
}

export function createAlphaNetRemoteMcpOAuthRevocationAccessTokenVerifier(
  options: AlphaNetRemoteMcpOAuthRevocationVerifierOptions,
): AlphaNetRemoteMcpOAuthRevocationOptions["verifyAccessTokenForRevocation"] {
  if (
    !options ||
    typeof options.getPublicJwks !== "function" ||
    !canonicalUrl(options.issuer, false) ||
    !canonicalUrl(options.resource, true) ||
    !(options.tokenJtiDigestKey instanceof Uint8Array) ||
    options.tokenJtiDigestKey.byteLength !== 32 ||
    (options.now !== undefined && typeof options.now !== "function")
  ) {
    throw new TypeError("Remote MCP OAuth revocation verifier configuration is invalid");
  }
  const issuer = options.issuer;
  const resource = options.resource;
  const digestKey = Uint8Array.from(options.tokenJtiDigestKey);

  return async (token): Promise<VerifiedRemoteMcpAccessTokenForRevocation | null> => {
    if (
      typeof token !== "string" ||
      token.length < 1 ||
      Buffer.byteLength(token, "utf8") > ACCESS_TOKEN_MAX_BYTES
    ) {
      return null;
    }
    try {
      const header = decodeProtectedHeader(token);
      if (
        !hasExactKeys(header, HEADER_KEYS) ||
        header.alg !== "ES256" ||
        header.typ !== "JWT" ||
        typeof header.kid !== "string" ||
        header.kid.length < 1 ||
        header.kid.length > 200 ||
        !SAFE_VISIBLE_ASCII.test(header.kid)
      ) {
        return null;
      }
    } catch {
      return null;
    }

    // Loading JWKS is an authority dependency. Its failure must propagate so a
    // valid token is never reported as successfully revoked without a commit.
    const jwks = await options.getPublicJwks();
    const resolver = createLocalJWKSet(jwks.document);
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, resolver, {
        algorithms: ["ES256"],
        audience: resource,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        ...(options.now ? { currentDate: options.now() } : {}),
        issuer,
        requiredClaims: [...PAYLOAD_KEYS],
        typ: "JWT",
      });
      payload = result.payload;
    } catch (error) {
      if (error instanceof errors.JOSEError) return null;
      throw error;
    }
    return validatePayload(payload, issuer, resource, digestKey);
  };
}
