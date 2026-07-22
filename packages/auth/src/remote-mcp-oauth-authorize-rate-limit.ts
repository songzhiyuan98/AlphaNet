import { createHash } from "node:crypto";

import { REMOTE_MCP_OAUTH_CAPACITY_POLICY } from "@alphanet/config/remote-mcp-oauth-capacity";

export interface RemoteMcpOAuthAuthorizeRateLimitStorage {
  consume(key: string, rule: { max: number; window: number }): Promise<unknown>;
}

export interface RemoteMcpOAuthAuthorizeRateLimitInput {
  clientId: string;
  clientIp: string;
}

export type RemoteMcpOAuthAuthorizeRateLimitDecision =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

export type RemoteMcpOAuthAuthorizeRateLimiter = (
  input: RemoteMcpOAuthAuthorizeRateLimitInput,
) => Promise<RemoteMcpOAuthAuthorizeRateLimitDecision>;

export const REMOTE_MCP_OAUTH_AUTHORIZE_RATE_LIMIT_RULES =
  REMOTE_MCP_OAUTH_CAPACITY_POLICY.authorize;

const RATE_LIMIT_KEY_PREFIX = "remote-mcp-oauth-authorize:v1";
const RATE_LIMIT_DIGEST_CONTEXT = "alphanet:remote-mcp-oauth:authorize:v1";
const GLOBAL_BUCKET_VALUE = "all-authorize-requests";
const MAX_RATE_LIMIT_IDENTIFIER_BYTES = 1_024;

type RateLimitDimension = keyof typeof REMOTE_MCP_OAUTH_AUTHORIZE_RATE_LIMIT_RULES;

export class RemoteMcpOAuthAuthorizeRateLimitUnavailableError extends Error {
  constructor() {
    super("Remote MCP OAuth authorize rate-limit protection is unavailable");
    this.name = "RemoteMcpOAuthAuthorizeRateLimitUnavailableError";
  }
}

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertRateLimitIdentifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_RATE_LIMIT_IDENTIFIER_BYTES ||
    value.trim() !== value ||
    containsAsciiControlCharacter(value)
  ) {
    throw new TypeError("Remote MCP OAuth authorize rate-limit identity is invalid");
  }
}

function digestRateLimitKey(dimension: RateLimitDimension, value: string): string {
  const digest = createHash("sha256")
    .update(RATE_LIMIT_DIGEST_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(dimension, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
  return `${RATE_LIMIT_KEY_PREFIX}:${dimension}:sha256:${digest}`;
}

function normalizeConsumeResult(
  value: unknown,
  maximumRetryAfterSeconds: number,
): RemoteMcpOAuthAuthorizeRateLimitDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RemoteMcpOAuthAuthorizeRateLimitUnavailableError();
  }
  const candidate = value as { allowed?: unknown; retryAfter?: unknown };
  if (candidate.allowed === true && candidate.retryAfter === null) {
    return { allowed: true };
  }
  if (
    candidate.allowed === false &&
    typeof candidate.retryAfter === "number" &&
    Number.isSafeInteger(candidate.retryAfter) &&
    candidate.retryAfter >= 1 &&
    candidate.retryAfter <= maximumRetryAfterSeconds
  ) {
    return { allowed: false, retryAfterSeconds: candidate.retryAfter };
  }
  throw new RemoteMcpOAuthAuthorizeRateLimitUnavailableError();
}

async function consumeDimension(
  storage: RemoteMcpOAuthAuthorizeRateLimitStorage,
  dimension: RateLimitDimension,
  value: string,
): Promise<RemoteMcpOAuthAuthorizeRateLimitDecision> {
  const rule = REMOTE_MCP_OAUTH_AUTHORIZE_RATE_LIMIT_RULES[dimension];
  let result: unknown;
  try {
    result = await storage.consume(digestRateLimitKey(dimension, value), rule);
  } catch {
    throw new RemoteMcpOAuthAuthorizeRateLimitUnavailableError();
  }
  return normalizeConsumeResult(result, rule.window);
}

export function createRemoteMcpOAuthAuthorizeRateLimiter(
  storage: RemoteMcpOAuthAuthorizeRateLimitStorage,
): RemoteMcpOAuthAuthorizeRateLimiter {
  if (!storage || typeof storage.consume !== "function") {
    throw new TypeError("Remote MCP OAuth authorize rate-limit storage is invalid");
  }

  return async ({ clientId, clientIp }) => {
    assertRateLimitIdentifier(clientId);
    assertRateLimitIdentifier(clientIp);

    // Consume the narrowest identities first. A rejected IP or Client must not
    // spend the shared global budget and let one abusive source deny service to
    // otherwise independent OAuth Clients.
    const dimensions = [
      ["ip", clientIp],
      ["client", clientId],
      ["global", GLOBAL_BUCKET_VALUE],
    ] as const;
    for (const [dimension, value] of dimensions) {
      const decision = await consumeDimension(storage, dimension, value);
      if (!decision.allowed) return decision;
    }
    return { allowed: true };
  };
}
