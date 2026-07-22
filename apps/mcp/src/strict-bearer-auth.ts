import {
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Request, RequestHandler } from "express";

import { REMOTE_MCP_ACCESS_TOKEN_MAX_BYTES } from "./access-token-verifier.js";

const AUTHORIZATION_PREFIX = "Bearer ";
const JWT_WIRE_VALUE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

export interface StrictBearerAuthorizationOptions {
  /** The already pinned AlphaNet Access Token verifier. */
  verifier: OAuthTokenVerifier;
  /**
   * Protected Resource Metadata URL advertised to clients on a 401. The URL
   * is validated once so it can be emitted without header escaping.
   */
  resourceMetadataUrl?: string | undefined;
  /** Test-only clock boundary. */
  now?: (() => Date) | undefined;
}

interface RequestWithAuth extends Request {
  auth?: AuthInfo;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function validateResourceMetadataUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("resourceMetadataUrl must be a canonical URL");
  }
  if (
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > 2_048 ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.toString() !== value ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopbackHostname(url.hostname)))
  ) {
    throw new Error("resourceMetadataUrl must be a canonical URL");
  }
  return value;
}

function invalidTokenChallenge(resourceMetadataUrl: string | undefined): string {
  return resourceMetadataUrl
    ? `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`
    : 'Bearer error="invalid_token"';
}

function sendInvalidToken(
  response: Parameters<RequestHandler>[1],
  challenge: string,
): void {
  response.set("www-authenticate", challenge);
  response.status(401).json({
    error: "invalid_token",
    error_description: "Invalid access token.",
  });
}

function sendVerificationUnavailable(response: Parameters<RequestHandler>[1]): void {
  response.status(503).json({
    error: "temporarily_unavailable",
    error_description: "Access-token verification is temporarily unavailable.",
  });
}

function currentEpochSeconds(clock: (() => Date) | undefined): number {
  let now: Date;
  try {
    now = clock ? clock() : new Date();
  } catch {
    throw new ServerError("Access-token verification is temporarily unavailable.");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
    throw new ServerError("Access-token verification is temporarily unavailable.");
  }
  return now.valueOf() / 1_000;
}

function validAuthInfoShape(value: AuthInfo, token: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    value.token === token &&
    typeof value.clientId === "string" &&
    value.clientId.length > 0 &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === "string") &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt)
  );
}

/**
 * Reads the raw Node header list instead of Node's normalized header map. That
 * makes duplicate Authorization fields observable and prevents comma folding
 * or whitespace normalization from changing the credential boundary.
 */
export function parseStrictBearerAuthorization(
  rawHeaders: readonly string[],
): string | null {
  if (rawHeaders.length % 2 !== 0) return null;

  let authorizationValue: string | undefined;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name !== "string" || typeof value !== "string") return null;
    if (name.toLowerCase() !== "authorization") continue;
    if (authorizationValue !== undefined) return null;
    authorizationValue = value;
  }

  if (
    authorizationValue === undefined ||
    !authorizationValue.startsWith(AUTHORIZATION_PREFIX)
  ) {
    return null;
  }
  const token = authorizationValue.slice(AUTHORIZATION_PREFIX.length);
  if (
    token.length < 1 ||
    Buffer.byteLength(token, "utf8") > REMOTE_MCP_ACCESS_TOKEN_MAX_BYTES ||
    !JWT_WIRE_VALUE.test(token)
  ) {
    return null;
  }
  return token;
}

/**
 * Strict OAuth Bearer boundary for the public MCP endpoint. It deliberately
 * does not use the SDK's split-based middleware because that middleware cannot
 * distinguish duplicate raw Authorization fields.
 */
export function createStrictBearerAuthorizationMiddleware(
  options: StrictBearerAuthorizationOptions,
): RequestHandler {
  const resourceMetadataUrl = validateResourceMetadataUrl(options.resourceMetadataUrl);
  const challenge = invalidTokenChallenge(resourceMetadataUrl);

  return async (request, response, next) => {
    const token = parseStrictBearerAuthorization(request.rawHeaders);
    if (!token) {
      sendInvalidToken(response, challenge);
      return;
    }

    let authInfo: AuthInfo;
    try {
      authInfo = await options.verifier.verifyAccessToken(token);
      if (!validAuthInfoShape(authInfo, token)) {
        throw new ServerError("Access-token verification is temporarily unavailable.");
      }
      if ((authInfo.expiresAt as number) <= currentEpochSeconds(options.now)) {
        throw new InvalidTokenError("Invalid access token.");
      }
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        sendInvalidToken(response, challenge);
        return;
      }
      sendVerificationUnavailable(response);
      return;
    }

    (request as RequestWithAuth).auth = authInfo;
    next();
  };
}
