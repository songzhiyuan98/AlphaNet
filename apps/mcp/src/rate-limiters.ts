import type {
  McpActorRateLimiter,
  McpRateLimitDecision,
  McpRequestRateLimiter,
} from "./app.js";

export interface McpRateLimitStorage {
  consume(
    key: string,
    rule: { max: number; window: number },
  ): Promise<{ allowed: boolean; retryAfter: number | null }>;
}

/**
 * A coarse pre-auth defense ceiling. Current Agent/Owner limits remain in the
 * API/domain authority boundary and cannot be reset by changing OAuth clients.
 */
export const MCP_IP_RATE_LIMIT = { max: 300, window: 60 } as const;

/**
 * The transport accepts the documented credential burst ceiling. Write/search
 * budgets are enforced again by the shared API/domain route boundary.
 */
export const MCP_ACTOR_RATE_LIMIT = { max: 120, window: 60 } as const;

function abortError(): Error {
  const error = new Error("Remote MCP rate-limit operation was aborted");
  error.name = "AbortError";
  return error;
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}

function normalizeDecision(value: {
  allowed: boolean;
  retryAfter: number | null;
}): McpRateLimitDecision {
  if (value.allowed === true && value.retryAfter === null) {
    return { allowed: true };
  }
  if (
    value.allowed === false &&
    typeof value.retryAfter === "number" &&
    Number.isSafeInteger(value.retryAfter) &&
    value.retryAfter >= 1 &&
    value.retryAfter <= 3_600
  ) {
    return { allowed: false, retryAfterSeconds: value.retryAfter };
  }
  throw new Error("Redis returned an invalid Remote MCP rate-limit decision");
}

async function consume(
  storage: McpRateLimitStorage,
  key: string,
  rule: { max: number; window: number },
  signal: AbortSignal,
): Promise<McpRateLimitDecision> {
  assertActive(signal);
  const result = await storage.consume(key, rule);
  assertActive(signal);
  return normalizeDecision(result);
}

export function createMcpRequestRateLimiter(
  storage: McpRateLimitStorage,
): McpRequestRateLimiter {
  return ({ clientIp, signal }) =>
    consume(storage, `ip:${clientIp}`, MCP_IP_RATE_LIMIT, signal);
}

export function createMcpActorRateLimiter(
  storage: McpRateLimitStorage,
): McpActorRateLimiter {
  return async ({ clientId, credentialId, grantId, signal }) => {
    const dimensions = [
      `client:${clientId}`,
      `grant:${grantId}`,
      `credential:${credentialId}`,
    ] as const;
    for (const key of dimensions) {
      const decision = await consume(storage, key, MCP_ACTOR_RATE_LIMIT, signal);
      if (!decision.allowed) {
        return decision;
      }
    }
    return { allowed: true };
  };
}
