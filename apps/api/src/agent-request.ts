import {
  AgentConnectionError,
  evaluateAgentOperation,
  type AgentConnectionService,
  type AgentCredentialContext,
  type AgentOperation,
  type AgentOperationEvaluation,
} from "@alphanet/domain";
import type { FastifyReply, FastifyRequest } from "fastify";

import { v1Error } from "./agent-routes.js";

export interface AgentRequestLimitRule {
  max: number;
  window: number;
}

export interface AgentRequestRateLimiter {
  consume(
    key: string,
    rule: AgentRequestLimitRule,
  ): Promise<{ allowed: boolean; retryAfter: number | null }>;
}

export interface AgentRequestBoundaryOptions {
  operation: AgentOperation;
  policyEnforcement?: "boundary" | "domain" | undefined;
  rateLimiter?: AgentRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: Pick<AgentConnectionService, "authenticateStaticApiKey">;
  limits?:
    | {
        agent?: AgentRequestLimitRule | undefined;
        credential?: AgentRequestLimitRule | undefined;
        ip?: AgentRequestLimitRule | undefined;
        owner?: AgentRequestLimitRule | undefined;
      }
    | undefined;
}

export interface AuthorizedAgentRequest {
  context: AgentCredentialContext;
  evaluation: AgentOperationEvaluation;
}

export interface AgentRequestAuthorizationBoundary {
  readonly getAuthorization: (request: FastifyRequest) => AuthorizedAgentRequest;
  readonly onRequest: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<FastifyReply | undefined>;
}

export const DEFAULT_AGENT_REQUEST_LIMITS = {
  agent: { max: 120, window: 60 },
  credential: { max: 120, window: 60 },
  ip: { max: 120, window: 60 },
  owner: { max: 120, window: 60 },
} satisfies Record<"agent" | "credential" | "ip" | "owner", AgentRequestLimitRule>;

const queryCredentialNames = new Set(["access_token", "api_key", "token"]);
const bearerCredentialPattern = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/;

function bearerCredential(request: FastifyRequest): string | null {
  const url = new URL(request.url, "http://alphanet.invalid");
  for (const name of url.searchParams.keys()) {
    if (queryCredentialNames.has(name.toLowerCase())) {
      return null;
    }
  }

  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    return null;
  }
  return bearerCredentialPattern.exec(authorization)?.[1] ?? null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function retryAfterSeconds(retryAt: Date): number {
  return Math.max(1, Math.ceil((retryAt.valueOf() - Date.now()) / 1_000));
}

function sendAuthenticationRequired(request: FastifyRequest, reply: FastifyReply): void {
  void reply.header("www-authenticate", "Bearer");
  void reply.code(401).send(
    v1Error(request, {
      code: "AUTHENTICATION_REQUIRED",
      message: "A valid Agent Bearer credential is required.",
    }),
  );
}

function sendAuthenticationFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: AgentConnectionError,
): void {
  if (error.statusCode === 401) {
    void reply.header(
      "www-authenticate",
      'Bearer error="invalid_token", error_description="The Agent credential is invalid."',
    );
  }
  if (error.retryAt) {
    void reply.header("retry-after", String(retryAfterSeconds(error.retryAt)));
  }
  void reply.code(error.statusCode).send(
    v1Error(request, {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      retryAt: error.retryAt,
    }),
  );
}

function sendDependencyUnavailable(
  request: FastifyRequest,
  reply: FastifyReply,
  message: string,
): void {
  void reply.code(503).send(
    v1Error(request, {
      code: "TEMPORARILY_UNAVAILABLE",
      message,
      retryable: true,
    }),
  );
}

async function consumeLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  rateLimiter: AgentRequestRateLimiter | undefined,
  key: string,
  rule: AgentRequestLimitRule,
): Promise<boolean> {
  if (!rateLimiter) {
    return true;
  }

  try {
    const result = await rateLimiter.consume(key, rule);
    if (result.allowed) {
      return true;
    }

    const retryAfter = Math.max(1, Math.ceil(result.retryAfter ?? rule.window));
    void reply.header("retry-after", String(retryAfter));
    void reply.code(429).send(
      v1Error(request, {
        code: "RATE_LIMITED",
        message: "Too many requests were made in this time window.",
        retryable: true,
        retryAt: new Date(Date.now() + retryAfter * 1_000),
      }),
    );
    return false;
  } catch (error) {
    request.log.error(
      { errorName: errorName(error) },
      "Agent request rate limiter failed",
    );
    sendDependencyUnavailable(
      request,
      reply,
      "Request protection is temporarily unavailable.",
    );
    return false;
  }
}

function sendScopeRequired(
  request: FastifyRequest,
  reply: FastifyReply,
  evaluation: AgentOperationEvaluation,
): void {
  const canonicalChallengeScope = evaluation.requiredScopes[0] ?? "";
  void reply.header(
    "www-authenticate",
    `Bearer error="insufficient_scope", error_description="The Agent credential lacks a required scope.", scope="${canonicalChallengeScope}"`,
  );
  void reply.code(403).send(
    v1Error(request, {
      code: "SCOPE_REQUIRED",
      message: "The Agent credential lacks a scope required for this operation.",
      details: { required_scope_any_of: [...evaluation.requiredScopes] },
    }),
  );
}

/**
 * Applies the shared Agent REST boundary before a route reaches its domain adapter.
 * A `require_approval` evaluation is authorized here and remains visible to the
 * adapter so it can create a durable pending action instead of executing directly.
 */
export async function authorizeAgentRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AgentRequestBoundaryOptions,
): Promise<AuthorizedAgentRequest | null> {
  let clientIp: string;
  try {
    clientIp = options.resolveClientIp?.(request) ?? request.ip;
  } catch (error) {
    request.log.error(
      { errorName: errorName(error) },
      "Agent request client address resolution failed",
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
      `ip:${clientIp}:agent-api`,
      options.limits?.ip ?? DEFAULT_AGENT_REQUEST_LIMITS.ip,
    ))
  ) {
    return null;
  }

  const token = bearerCredential(request);
  if (!token) {
    sendAuthenticationRequired(request, reply);
    return null;
  }

  let context: AgentCredentialContext;
  try {
    context = await options.service.authenticateStaticApiKey(token);
  } catch (error) {
    if (error instanceof AgentConnectionError) {
      sendAuthenticationFailure(request, reply, error);
      return null;
    }

    request.log.error(
      { errorName: errorName(error) },
      "Agent credential authentication failed",
    );
    sendDependencyUnavailable(
      request,
      reply,
      "Agent authentication is temporarily unavailable.",
    );
    return null;
  }

  if (
    !(await consumeLimit(
      request,
      reply,
      options.rateLimiter,
      `credential:${context.credential.id}:agent-api`,
      options.limits?.credential ?? DEFAULT_AGENT_REQUEST_LIMITS.credential,
    ))
  ) {
    return null;
  }

  if (
    !(await consumeLimit(
      request,
      reply,
      options.rateLimiter,
      `agent:${context.agent.id}:agent-api`,
      options.limits?.agent ?? DEFAULT_AGENT_REQUEST_LIMITS.agent,
    ))
  ) {
    return null;
  }

  if (
    !(await consumeLimit(
      request,
      reply,
      options.rateLimiter,
      `owner:${context.owner.id}:agent-api`,
      options.limits?.owner ?? DEFAULT_AGENT_REQUEST_LIMITS.owner,
    ))
  ) {
    return null;
  }

  const evaluation = evaluateAgentOperation({
    credentialPolicyCeiling: context.credential.policyCeiling,
    operation: options.operation,
    policyTier: context.agent.policy.tier,
    scopes: context.credential.scopes,
  });
  if (!evaluation.scopeSatisfied) {
    sendScopeRequired(request, reply, evaluation);
    return null;
  }
  if (
    evaluation.decision === "deny" &&
    (options.policyEnforcement ?? "boundary") === "boundary"
  ) {
    void reply.code(403).send(
      v1Error(request, {
        code: "POLICY_DENIED",
        message: "The Agent policy does not permit this operation.",
      }),
    );
    return null;
  }

  return { context, evaluation };
}

/**
 * Creates a parse-before Agent boundary for one operation. Authorized state is
 * kept in a request-keyed WeakMap so it cannot be supplied by the caller or
 * accidentally reused by a concurrent request.
 */
export function createAgentRequestAuthorizationBoundary(
  options: AgentRequestBoundaryOptions,
): AgentRequestAuthorizationBoundary {
  const authorizations = new WeakMap<FastifyRequest, AuthorizedAgentRequest>();

  return {
    getAuthorization: (request) => {
      const authorization = authorizations.get(request);
      if (!authorization) {
        throw new Error("Agent request reached its handler without authorization");
      }
      return authorization;
    },
    onRequest: async (request, reply) => {
      const authorization = await authorizeAgentRequest(request, reply, options);
      if (!authorization) {
        return reply;
      }
      authorizations.set(request, authorization);
    },
  };
}
