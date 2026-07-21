import type { AlphaNetAuthRuntime, OwnerSession } from "@alphanet/auth";
import type { V1ErrorResponse } from "@alphanet/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface OwnerRequestLimitRule {
  max: number;
  window: number;
}

export interface OwnerRequestRateLimiter {
  consume(
    key: string,
    rule: OwnerRequestLimitRule,
  ): Promise<{ allowed: boolean; retryAfter: number | null }>;
}

export type OwnerRequestMode = "read" | "mutation";

export interface OwnerRequestBoundaryOptions {
  allowedOrigins: readonly string[];
  authRuntime: Pick<AlphaNetAuthRuntime, "getOwnerSession">;
  limits?:
    | {
        ip?: OwnerRequestLimitRule | undefined;
        mutation?: OwnerRequestLimitRule | undefined;
        read?: OwnerRequestLimitRule | undefined;
      }
    | undefined;
  mode: OwnerRequestMode;
  rateLimiter?: OwnerRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
}

export interface AuthorizedOwnerRequest {
  owner: OwnerSession["owner"];
}

export interface OwnerRequestAuthorizationBoundary {
  readonly getAuthorization: (request: FastifyRequest) => AuthorizedOwnerRequest;
  readonly onRequest: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<FastifyReply | undefined>;
}

export const DEFAULT_OWNER_REQUEST_LIMITS = {
  ip: { max: 240, window: 60 },
  mutation: { max: 30, window: 60 },
  read: { max: 120, window: 60 },
} satisfies Record<"ip" | OwnerRequestMode, OwnerRequestLimitRule>;

function ownerV1Error(
  request: FastifyRequest,
  options: {
    code: string;
    message: string;
    retryable?: boolean | undefined;
    retryAt?: Date | undefined;
  },
): V1ErrorResponse {
  const retryAfterMilliseconds = options.retryAt
    ? Math.max(1, options.retryAt.valueOf() - Date.now())
    : null;
  return {
    error: {
      code: options.code,
      message: options.message,
      retryable: options.retryable ?? false,
      details: options.retryAt ? { retry_at: options.retryAt.toISOString() } : null,
      retry_after_ms: retryAfterMilliseconds,
    },
    request_id: request.id,
    schema_version: "1",
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function toSessionHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  const cookie = request.headers.cookie;
  if (cookie) headers.set("cookie", cookie);
  const userAgent = request.headers["user-agent"];
  if (userAgent) headers.set("user-agent", userAgent);
  return headers;
}

function sendDependencyUnavailable(
  request: FastifyRequest,
  reply: FastifyReply,
  message: string,
): void {
  void reply.code(503).send(
    ownerV1Error(request, {
      code: "TEMPORARILY_UNAVAILABLE",
      message,
      retryable: true,
    }),
  );
}

async function consumeLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  rateLimiter: OwnerRequestRateLimiter | undefined,
  key: string,
  rule: OwnerRequestLimitRule,
): Promise<boolean> {
  if (!rateLimiter) return true;

  try {
    const result = await rateLimiter.consume(key, rule);
    if (result.allowed) return true;

    const retryAfter = Math.max(1, Math.ceil(result.retryAfter ?? rule.window));
    const retryAt = new Date(Date.now() + retryAfter * 1_000);
    void reply.header("retry-after", String(retryAfter));
    void reply.code(429).send(
      ownerV1Error(request, {
        code: "RATE_LIMITED",
        message: "Too many requests were made in this time window.",
        retryable: true,
        retryAt,
      }),
    );
    return false;
  } catch (error) {
    request.log.error(
      { errorName: errorName(error) },
      "Owner request rate limiter failed",
    );
    sendDependencyUnavailable(
      request,
      reply,
      "Request protection is temporarily unavailable.",
    );
    return false;
  }
}

function mutationOriginAllowed(
  request: FastifyRequest,
  allowedOrigins: readonly string[],
): boolean {
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  return (
    typeof origin === "string" &&
    allowedOrigins.includes(origin) &&
    fetchSite !== "cross-site"
  );
}

async function authorizeOwnerRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: OwnerRequestBoundaryOptions,
): Promise<AuthorizedOwnerRequest | null> {
  let clientIp: string;
  try {
    clientIp = options.resolveClientIp?.(request) ?? request.ip;
  } catch (error) {
    request.log.error(
      { errorName: errorName(error) },
      "Owner request client address resolution failed",
    );
    sendDependencyUnavailable(
      request,
      reply,
      "Request protection is temporarily unavailable.",
    );
    return null;
  }

  if (
    !(await consumeLimit(
      request,
      reply,
      options.rateLimiter,
      `ip:${clientIp}:owner-api`,
      options.limits?.ip ?? DEFAULT_OWNER_REQUEST_LIMITS.ip,
    ))
  ) {
    return null;
  }

  let session: OwnerSession | null;
  try {
    session = await options.authRuntime.getOwnerSession(toSessionHeaders(request));
  } catch (error) {
    request.log.error({ errorName: errorName(error) }, "Owner session lookup failed");
    sendDependencyUnavailable(
      request,
      reply,
      "Owner authentication is temporarily unavailable.",
    );
    return null;
  }
  if (!session) {
    void reply.code(401).send(
      ownerV1Error(request, {
        code: "AUTHENTICATION_REQUIRED",
        message: "A valid Owner session is required.",
      }),
    );
    return null;
  }

  if (
    options.mode === "mutation" &&
    !mutationOriginAllowed(request, options.allowedOrigins)
  ) {
    void reply.code(403).send(
      ownerV1Error(request, {
        code: "CSRF_VALIDATION_FAILED",
        message: "The Owner mutation did not come from an allowed Web origin.",
      }),
    );
    return null;
  }

  if (!session.owner.emailVerified) {
    void reply.code(403).send(
      ownerV1Error(request, {
        code: "OWNER_EMAIL_VERIFICATION_REQUIRED",
        message: "Verify the Owner email address before performing this operation.",
      }),
    );
    return null;
  }
  if (session.owner.status !== "active") {
    void reply.code(403).send(
      ownerV1Error(request, {
        code: "OWNER_NOT_ACTIVE",
        message: "The Owner account cannot perform this operation.",
      }),
    );
    return null;
  }

  const ownerLimit =
    options.limits?.[options.mode] ?? DEFAULT_OWNER_REQUEST_LIMITS[options.mode];
  if (
    !(await consumeLimit(
      request,
      reply,
      options.rateLimiter,
      `owner:${session.owner.id}:${options.mode}`,
      ownerLimit,
    ))
  ) {
    return null;
  }

  return { owner: session.owner };
}

/**
 * Creates a parse-before Owner boundary for one route access mode. Session
 * identity is held only in a request-keyed WeakMap, never in client-controlled
 * request fields or a mutable cross-request slot.
 */
export function createOwnerRequestAuthorizationBoundary(
  options: OwnerRequestBoundaryOptions,
): OwnerRequestAuthorizationBoundary {
  const authorizations = new WeakMap<FastifyRequest, AuthorizedOwnerRequest>();

  return {
    getAuthorization: (request) => {
      const authorization = authorizations.get(request);
      if (!authorization) {
        throw new Error("Owner request reached its handler without authorization");
      }
      return authorization;
    },
    onRequest: async (request, reply) => {
      void reply.header("cache-control", "no-store, private");
      void reply.header("pragma", "no-cache");
      const authorization = await authorizeOwnerRequest(request, reply, options);
      if (!authorization) return reply;
      authorizations.set(request, authorization);
    },
  };
}
