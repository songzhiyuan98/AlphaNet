import { AGENT_SCOPES, type AgentScope } from "@alphanet/contracts";
import {
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export const REMOTE_MCP_ACCESS_TOKEN_MAX_BYTES = 16 * 1_024;
export const REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS = 10 * 60;

export interface RemoteMcpAccessTokenVerifierConfig {
  /** Exact Authorization Server issuer expected in every Access Token. */
  issuer: string;
  /** Pinned JWKS endpoint. JWT-controlled key locations are never consulted. */
  jwksUrl: string;
  /** Exact RFC 8707 resource identifier for this MCP deployment. */
  resource: string;
}

export interface RemoteMcpAccessTokenVerifierDependencies {
  /** Test or embedded resolver override. Production uses only the pinned remote JWKS URL. */
  keyResolver?: JWTVerifyGetKey | undefined;
  now?: (() => Date) | undefined;
}

const ACCESS_TOKEN_HEADER_KEYS = ["alg", "kid", "typ"] as const;
const ACCESS_TOKEN_PAYLOAD_KEYS = [
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
const AGENT_SCOPE_SET: ReadonlySet<string> = new Set(AGENT_SCOPES);
const SAFE_VISIBLE_ASCII = /^[\x21-\x7e]+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function canonicalOAuthUrl(value: string, field: string, resource: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute URL`);
  }
  if (
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > (resource ? 500 : 2_048) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.toString() !== value ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) ||
    (resource && url.pathname !== "/mcp")
  ) {
    throw new Error(`${field} must be a canonical HTTPS URL (or loopback HTTP URL)`);
  }
  return url;
}

function validateConfig(config: RemoteMcpAccessTokenVerifierConfig): void {
  canonicalOAuthUrl(config.issuer, "issuer", false);
  canonicalOAuthUrl(config.jwksUrl, "jwksUrl", false);
  canonicalOAuthUrl(config.resource, "resource", true);
}

function canonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function canonicalTokenJtiDigest(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}

function canonicalClientId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 200 &&
    Buffer.byteLength(value, "utf8") <= 200 &&
    SAFE_VISIBLE_ASCII.test(value)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpected.length &&
    actualKeys.every((key, index) => key === sortedExpected[index])
  );
}

function validateProtectedHeader(token: string): void {
  const segments = token.split(".");
  const signature = segments[2];
  if (segments.length !== 3 || typeof signature !== "string") {
    throw new Error("invalid token envelope");
  }
  const signatureBytes = Buffer.from(signature, "base64url");
  const header = decodeProtectedHeader(token);
  if (
    signatureBytes.byteLength !== 64 ||
    signatureBytes.toString("base64url") !== signature ||
    !hasExactKeys(header, ACCESS_TOKEN_HEADER_KEYS) ||
    header.alg !== "ES256" ||
    header.typ !== "JWT" ||
    typeof header.kid !== "string" ||
    header.kid.length < 1 ||
    header.kid.length > 200 ||
    !SAFE_VISIBLE_ASCII.test(header.kid)
  ) {
    throw new Error("invalid token header");
  }
}

function safePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validatedDomainScopes(value: unknown): AgentScope[] | null {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.startsWith(" ") ||
    value.endsWith(" ") ||
    value.includes("  ")
  ) {
    return null;
  }
  const protocolScopes = value.split(" ");
  if (
    protocolScopes.length < 1 ||
    protocolScopes.length > AGENT_SCOPES.length + 1 ||
    new Set(protocolScopes).size !== protocolScopes.length ||
    protocolScopes.some(
      (scope) => scope !== "offline_access" && !AGENT_SCOPE_SET.has(scope),
    )
  ) {
    return null;
  }
  const domainScopes = protocolScopes.filter(
    (scope): scope is AgentScope => scope !== "offline_access",
  );
  return domainScopes.length > 0 ? domainScopes : null;
}

interface ValidatedAccessTokenPayload {
  clientId: string;
  credentialId: string;
  expiresAt: number;
  grantId: string;
  scopes: AgentScope[];
  tokenJtiDigest: string;
}

function validatePayload(
  payload: JWTPayload,
  issuer: string,
  resource: string,
): ValidatedAccessTokenPayload | null {
  const scopes = validatedDomainScopes(payload["scope"]);
  if (
    !hasExactKeys(payload, ACCESS_TOKEN_PAYLOAD_KEYS) ||
    payload.iss !== issuer ||
    payload.aud !== resource ||
    !canonicalClientId(payload["azp"]) ||
    !canonicalUuid(payload.sub) ||
    !canonicalUuid(payload.jti) ||
    !canonicalUuid(payload["credential_id"]) ||
    !safePositiveInteger(payload["grant_epoch"]) ||
    !safePositiveInteger(payload.iat) ||
    !safePositiveInteger(payload.nbf) ||
    !safePositiveInteger(payload.exp) ||
    payload.nbf !== payload.iat ||
    payload.exp - payload.iat !== REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS ||
    !canonicalTokenJtiDigest(payload["token_jti_digest"]) ||
    !scopes
  ) {
    return null;
  }
  return {
    clientId: payload["azp"],
    credentialId: payload["credential_id"],
    expiresAt: payload.exp,
    grantId: payload.sub,
    scopes,
    tokenJtiDigest: payload["token_jti_digest"],
  };
}

function jwksDependencyFailure(error: unknown): boolean {
  return (
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid ||
    error instanceof errors.JWKInvalid ||
    error instanceof errors.JWKSMultipleMatchingKeys ||
    error instanceof errors.JOSENotSupported ||
    // jose's remote JWKS fetcher uses the base JOSEError (not a subclass) for
    // non-200 responses and non-JSON responses. Match that exact constructor;
    // token-originated JOSE subclasses, including JWKSNoMatchingKey, stay invalid.
    (error instanceof errors.JOSEError && error.constructor === errors.JOSEError) ||
    !(error instanceof errors.JOSEError)
  );
}

function invalidToken(): InvalidTokenError {
  return new InvalidTokenError("Invalid access token.");
}

function verificationUnavailable(): ServerError {
  return new ServerError("Access-token verification is temporarily unavailable.");
}

function readCurrentDate(clock: (() => Date) | undefined): Date | undefined {
  if (!clock) return undefined;
  let currentDate: Date;
  try {
    currentDate = clock();
  } catch {
    throw verificationUnavailable();
  }
  if (!(currentDate instanceof Date) || !Number.isFinite(currentDate.valueOf())) {
    throw verificationUnavailable();
  }
  // Do not retain a mutable Date supplied by an injected clock while an
  // asynchronous JWKS resolver is running.
  return new Date(currentDate.valueOf());
}

/**
 * Builds the MCP SDK token-verifier boundary around one operator-pinned ES256
 * issuer, resource, and remote JWKS. It verifies cryptography and immutable
 * token facts only; current Grant/Credential authority remains an API concern.
 */
export function createRemoteMcpAccessTokenVerifier(
  config: RemoteMcpAccessTokenVerifierConfig,
  dependencies: RemoteMcpAccessTokenVerifierDependencies = {},
): OAuthTokenVerifier {
  validateConfig(config);
  const issuer = config.issuer;
  const resource = config.resource;
  const now = dependencies.now;
  const keyResolver =
    dependencies.keyResolver ??
    createRemoteJWKSet(new URL(config.jwksUrl), {
      cacheMaxAge: 10 * 60_000,
      cooldownDuration: 30_000,
      timeoutDuration: 2_000,
    });

  return Object.freeze({
    verifyAccessToken: async (token: string): Promise<AuthInfo> => {
      if (
        typeof token !== "string" ||
        token.length < 1 ||
        Buffer.byteLength(token, "utf8") > REMOTE_MCP_ACCESS_TOKEN_MAX_BYTES
      ) {
        throw invalidToken();
      }
      try {
        validateProtectedHeader(token);
      } catch {
        throw invalidToken();
      }

      const currentDate = readCurrentDate(now);

      let payload: JWTPayload;
      try {
        const result = await jwtVerify(token, keyResolver, {
          algorithms: ["ES256"],
          audience: resource,
          ...(currentDate ? { currentDate } : {}),
          issuer,
          requiredClaims: [...ACCESS_TOKEN_PAYLOAD_KEYS],
          typ: "JWT",
        });
        payload = result.payload;
      } catch (error) {
        throw jwksDependencyFailure(error) ? verificationUnavailable() : invalidToken();
      }

      const validated = validatePayload(payload, issuer, resource);
      if (!validated) {
        throw invalidToken();
      }
      const scopes: string[] = [...validated.scopes];
      Object.freeze(scopes);
      return Object.freeze({
        clientId: validated.clientId,
        expiresAt: validated.expiresAt,
        extra: Object.freeze({
          actor: Object.freeze({
            credentialId: validated.credentialId,
            grantId: validated.grantId,
            tokenJtiDigest: validated.tokenJtiDigest,
          }),
        }),
        resource: new URL(resource),
        scopes,
        token,
      });
    },
  });
}
