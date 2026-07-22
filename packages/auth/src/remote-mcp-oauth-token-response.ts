import { AGENT_SCOPES } from "@alphanet/contracts";

export const REMOTE_MCP_OAUTH_TOKEN_RESPONSE_MAX_BYTES = 32 * 1_024;

const ACCESS_TOKEN_MAX_BYTES = 16 * 1_024;
const ACCESS_TOKEN_TTL_SECONDS = 600;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_VISIBLE_ASCII = /^[!-~]+$/u;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/u;
const TOKEN_JTI_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const REFRESH_TOKEN_PATTERN = /^aln_rt_v1_[A-Za-z0-9_-]{32,512}$/u;
const PROTOCOL_SCOPE_ORDER = [...AGENT_SCOPES, "offline_access"] as const;
const PROTOCOL_SCOPE_INDEX = new Map<string, number>(
  PROTOCOL_SCOPE_ORDER.map((scope, index) => [scope, index]),
);
const TOKEN_RESPONSE_KEYS = [
  "access_token",
  "expires_at",
  "expires_in",
  "scope",
  "token_type",
] as const;
const TOKEN_HEADER_KEYS = ["alg", "kid", "typ"] as const;
const TOKEN_PAYLOAD_KEYS = [
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

export interface RemoteMcpOAuthTokenResponseExpectation {
  clientId: string;
  issuer: string;
  resource: string;
  scopes: readonly string[];
}

interface ValidatedExpectation {
  clientId: string;
  issuer: string;
  resource: string;
  scope: string;
  wantsOfflineAccess: boolean;
}

export class RemoteMcpOAuthTokenResponseValidationError extends Error {
  constructor() {
    super("Remote MCP OAuth token success response is invalid");
    this.name = "RemoteMcpOAuthTokenResponseValidationError";
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalUrl(value: unknown, resource: boolean): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > 2_048
  ) {
    return false;
  }
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

function isClientId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    Buffer.byteLength(value, "utf8") <= 200 &&
    SAFE_VISIBLE_ASCII.test(value)
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validateExpectation(
  value: RemoteMcpOAuthTokenResponseExpectation,
): ValidatedExpectation {
  if (
    !value ||
    !isClientId(value.clientId) ||
    !isCanonicalUrl(value.issuer, false) ||
    !isCanonicalUrl(value.resource, true) ||
    !isStringArray(value.scopes) ||
    value.scopes.length < 1 ||
    value.scopes.length > PROTOCOL_SCOPE_ORDER.length ||
    new Set(value.scopes).size !== value.scopes.length ||
    !value.scopes.some((scope) => scope !== "offline_access") ||
    value.scopes.some((scope) => !PROTOCOL_SCOPE_INDEX.has(scope)) ||
    value.scopes.some((scope, index) => {
      if (index === 0) return false;
      const previous = value.scopes[index - 1];
      return (
        previous === undefined ||
        (PROTOCOL_SCOPE_INDEX.get(previous) ?? Number.MAX_SAFE_INTEGER) >=
          (PROTOCOL_SCOPE_INDEX.get(scope) ?? Number.MAX_SAFE_INTEGER)
      );
    })
  ) {
    throw new TypeError("Remote MCP OAuth token response expectation is invalid");
  }
  const scopes = Object.freeze([...value.scopes]);
  return Object.freeze({
    clientId: value.clientId,
    issuer: value.issuer,
    resource: value.resource,
    scope: scopes.join(" "),
    wantsOfflineAccess: scopes.includes("offline_access"),
  });
}

function invalidResponse(): never {
  throw new RemoteMcpOAuthTokenResponseValidationError();
}

function hasJsonContentType(value: string | null): boolean {
  return (
    value !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value.trim())
  );
}

async function readBoundedClone(response: Response): Promise<string> {
  let clone: Response;
  try {
    clone = response.clone();
  } catch {
    return invalidResponse();
  }
  if (!clone.body) return invalidResponse();

  const reader = clone.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const result: unknown = await reader.read();
      if (!isRecord(result) || typeof result["done"] !== "boolean") {
        return invalidResponse();
      }
      if (result["done"]) break;
      const chunk = result["value"];
      if (
        !(chunk instanceof Uint8Array) ||
        chunk.byteLength > REMOTE_MCP_OAUTH_TOKEN_RESPONSE_MAX_BYTES - bytesRead
      ) {
        // A cloned body is one branch of a tee. Awaiting cancellation can wait
        // for the untouched original branch, which this validator must preserve.
        void reader.cancel().catch(() => undefined);
        return invalidResponse();
      }
      bytesRead += chunk.byteLength;
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof RemoteMcpOAuthTokenResponseValidationError) throw error;
    return invalidResponse();
  } finally {
    reader.releaseLock();
  }
  if (bytesRead === 0) return invalidResponse();

  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return invalidResponse();
  }
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  if (!BASE64URL_SEGMENT.test(segment)) return invalidResponse();
  const decoded = Buffer.from(segment, "base64url");
  if (decoded.byteLength === 0 || decoded.toString("base64url") !== segment) {
    return invalidResponse();
  }
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(decoded),
    );
    return isRecord(parsed) ? parsed : invalidResponse();
  } catch (error) {
    if (error instanceof RemoteMcpOAuthTokenResponseValidationError) throw error;
    return invalidResponse();
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTokenJtiDigest(value: unknown): value is string {
  if (typeof value !== "string" || !TOKEN_JTI_DIGEST_PATTERN.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}

function canonicalResponseScope(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.startsWith(" ") ||
    value.endsWith(" ") ||
    value.includes("  ")
  ) {
    return undefined;
  }
  const scopes = value.split(" ");
  if (
    scopes.length > PROTOCOL_SCOPE_ORDER.length ||
    new Set(scopes).size !== scopes.length ||
    !scopes.some((scope) => scope !== "offline_access") ||
    scopes.some((scope) => !PROTOCOL_SCOPE_INDEX.has(scope))
  ) {
    return undefined;
  }
  return [...scopes]
    .sort(
      (left, right) =>
        (PROTOCOL_SCOPE_INDEX.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (PROTOCOL_SCOPE_INDEX.get(right) ?? Number.MAX_SAFE_INTEGER),
    )
    .join(" ");
}

function validateAccessToken(token: unknown, expectation: ValidatedExpectation): number {
  if (
    typeof token !== "string" ||
    token.length < 1 ||
    Buffer.byteLength(token, "utf8") > ACCESS_TOKEN_MAX_BYTES
  ) {
    return invalidResponse();
  }
  const segments = token.split(".");
  if (segments.length !== 3) return invalidResponse();
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (!encodedHeader || !encodedPayload || !encodedSignature) return invalidResponse();
  const header = decodeJsonSegment(encodedHeader);
  const payload = decodeJsonSegment(encodedPayload);
  if (!BASE64URL_SEGMENT.test(encodedSignature)) return invalidResponse();
  const signature = Buffer.from(encodedSignature, "base64url");
  if (
    signature.byteLength !== 64 ||
    signature.toString("base64url") !== encodedSignature ||
    !hasExactKeys(header, TOKEN_HEADER_KEYS) ||
    header["alg"] !== "ES256" ||
    header["typ"] !== "JWT" ||
    typeof header["kid"] !== "string" ||
    header["kid"].length < 1 ||
    header["kid"].length > 200 ||
    !SAFE_VISIBLE_ASCII.test(header["kid"]) ||
    !hasExactKeys(payload, TOKEN_PAYLOAD_KEYS) ||
    payload["iss"] !== expectation.issuer ||
    payload["aud"] !== expectation.resource ||
    payload["azp"] !== expectation.clientId ||
    payload["scope"] !== expectation.scope ||
    !isUuid(payload["sub"]) ||
    !isUuid(payload["jti"]) ||
    !isUuid(payload["credential_id"]) ||
    !isPositiveSafeInteger(payload["grant_epoch"]) ||
    !isPositiveSafeInteger(payload["iat"]) ||
    !isPositiveSafeInteger(payload["nbf"]) ||
    !isPositiveSafeInteger(payload["exp"]) ||
    payload["nbf"] !== payload["iat"] ||
    payload["exp"] - payload["iat"] !== ACCESS_TOKEN_TTL_SECONDS ||
    !isTokenJtiDigest(payload["token_jti_digest"])
  ) {
    return invalidResponse();
  }
  return payload["exp"];
}

function validateTokenResponseBody(
  value: unknown,
  expectation: ValidatedExpectation,
): void {
  if (!isRecord(value)) return invalidResponse();
  const expectedKeys = expectation.wantsOfflineAccess
    ? [...TOKEN_RESPONSE_KEYS, "refresh_token"]
    : TOKEN_RESPONSE_KEYS;
  if (
    !hasExactKeys(value, expectedKeys) ||
    value["token_type"] !== "Bearer" ||
    value["expires_in"] !== ACCESS_TOKEN_TTL_SECONDS ||
    canonicalResponseScope(value["scope"]) !== expectation.scope ||
    !isPositiveSafeInteger(value["expires_at"])
  ) {
    return invalidResponse();
  }
  const tokenExpiry = validateAccessToken(value["access_token"], expectation);
  if (value["expires_at"] !== tokenExpiry) return invalidResponse();

  const refreshToken = value["refresh_token"];
  if (
    (expectation.wantsOfflineAccess &&
      (typeof refreshToken !== "string" || !REFRESH_TOKEN_PATTERN.test(refreshToken))) ||
    (!expectation.wantsOfflineAccess && refreshToken !== undefined)
  ) {
    return invalidResponse();
  }
}

export async function validateRemoteMcpOAuthTokenSuccessResponse(
  response: Response,
  expectation: RemoteMcpOAuthTokenResponseExpectation,
): Promise<void> {
  const validatedExpectation = validateExpectation(expectation);
  if (
    !(response instanceof Response) ||
    response.status !== 200 ||
    !hasJsonContentType(response.headers.get("content-type")) ||
    response.headers.get("cache-control")?.trim().toLowerCase() !== "no-store" ||
    response.headers.get("pragma")?.trim().toLowerCase() !== "no-cache"
  ) {
    return invalidResponse();
  }

  const body = await readBoundedClone(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return invalidResponse();
  }
  validateTokenResponseBody(parsed, validatedExpectation);
}
