import {
  AgentConnectionError,
  evaluateAgentOperation,
  type AgentConnectionService,
  type AgentCredentialContext,
  type AgentOperation,
  type AgentOperationEvaluation,
} from "@alphanet/domain";
import type { FastifyReply, FastifyRequest } from "fastify";

import { v1Error } from "./v1-error.js";

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

type AgentRequestLimitSubject = "agent" | "credential" | "ip" | "owner";
export type AgentAuthenticatedRequestLimitSubject = Exclude<
  AgentRequestLimitSubject,
  "ip"
>;

export interface AgentRequestRateLimitCategory {
  namespace: string;
  limits: Partial<Record<AgentRequestLimitSubject, AgentRequestLimitRule>>;
}

export interface AgentRequestBoundaryOptions {
  operation: AgentOperation;
  policyEnforcement?: "boundary" | "domain" | undefined;
  rateLimiter?: AgentRequestRateLimiter | undefined;
  rateLimitCategory?: AgentRequestRateLimitCategory | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: Pick<AgentConnectionService, "authenticateStaticApiKey">;
}

/**
 * Transport-neutral controls applied after an Agent identity has been
 * authenticated. Static REST and private MCP both enter through this boundary,
 * so aggregate Agent/Owner budgets and policy evaluation cannot drift by
 * transport.
 */
export interface AuthenticatedAgentRequestBoundaryOptions {
  clientIp?: string | undefined;
  operation: AgentOperation;
  policyEnforcement?: "boundary" | "domain" | undefined;
  rateLimiter?: AgentRequestRateLimiter | undefined;
  rateLimitCategory?: AgentRequestRateLimitCategory | undefined;
  rateLimitSubjects?: readonly AgentAuthenticatedRequestLimitSubject[] | undefined;
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
} satisfies Record<AgentRequestLimitSubject, AgentRequestLimitRule>;

/**
 * Shared write budget for Agent REST mutations. Route boundaries opt into this
 * category in addition to, never instead of, the global Agent API budget.
 */
export const AGENT_WRITE_REQUEST_RATE_LIMIT_CATEGORY = {
  limits: {
    credential: { max: 20, window: 60 },
  },
  namespace: "write",
} as const satisfies AgentRequestRateLimitCategory;

const normalizedQueryCredentialNames = new Set(["accesstoken", "apikey", "token"]);
const bearerCredentialPattern = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/;

function normalizedQueryCredentialName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

/**
 * Parses a static Agent Bearer credential from the raw Node header list.
 * Reading raw headers is intentional: Fastify's normalized header map cannot
 * distinguish duplicate, differently-cased Authorization fields after Node has
 * combined them.
 */
export function agentBearerCredential(request: FastifyRequest): string | null {
  const url = new URL(request.url, "http://alphanet.invalid");
  for (const name of url.searchParams.keys()) {
    if (normalizedQueryCredentialNames.has(normalizedQueryCredentialName(name))) {
      return null;
    }
  }

  const rawHeaders = request.raw.rawHeaders;
  if (rawHeaders.length % 2 !== 0) {
    return null;
  }

  let authorization: string | undefined;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name !== "string" || typeof value !== "string") {
      return null;
    }
    if (name.toLowerCase() !== "authorization") {
      continue;
    }
    if (authorization !== undefined) {
      return null;
    }
    authorization = value;
  }

  return authorization === undefined
    ? null
    : (bearerCredentialPattern.exec(authorization)?.[1] ?? null);
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
    if (result.allowed === true) {
      return true;
    }

    if (
      result.allowed !== false ||
      (result.retryAfter !== null &&
        (!Number.isFinite(result.retryAfter) || result.retryAfter < 0))
    ) {
      throw new Error("Agent request rate limiter returned an invalid result");
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

const defaultAuthenticatedRateLimitSubjects = [
  "credential",
  "agent",
  "owner",
] as const satisfies readonly AgentAuthenticatedRequestLimitSubject[];

/**
 * Applies the transport-neutral half of the Agent authorization boundary.
 * Callers must supply a context produced by their own trusted authentication
 * mechanism; this function never accepts headers, cookies, or caller identity
 * fields as context.
 */
export async function authorizeAuthenticatedAgentRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  context: AgentCredentialContext,
  options: AuthenticatedAgentRequestBoundaryOptions,
): Promise<AuthorizedAgentRequest | null> {
  const rateLimitSubjects = new Set(
    options.rateLimitSubjects ?? defaultAuthenticatedRateLimitSubjects,
  );
  const aggregateKeys: Record<AgentAuthenticatedRequestLimitSubject, string> = {
    agent: `agent:${context.agent.id}:agent-api`,
    credential: `credential:${context.credential.id}:agent-api`,
    owner: `owner:${context.owner.id}:agent-api`,
  };
  for (const subject of defaultAuthenticatedRateLimitSubjects) {
    if (
      rateLimitSubjects.has(subject) &&
      !(await consumeLimit(
        request,
        reply,
        options.rateLimiter,
        aggregateKeys[subject],
        DEFAULT_AGENT_REQUEST_LIMITS[subject],
      ))
    ) {
      return null;
    }
  }

  const category = options.rateLimitCategory;
  if (category) {
    const categoryKeys: Record<AgentRequestLimitSubject, string | null> = {
      agent: `agent:${context.agent.id}:agent-api:${category.namespace}`,
      credential: `credential:${context.credential.id}:agent-api:${category.namespace}`,
      ip: options.clientIp
        ? `ip:${options.clientIp}:agent-api:${category.namespace}`
        : null,
      owner: `owner:${context.owner.id}:agent-api:${category.namespace}`,
    };
    for (const subject of ["ip", "credential", "agent", "owner"] as const) {
      const rule = category.limits[subject];
      if (!rule) {
        continue;
      }
      const key = categoryKeys[subject];
      if (!key) {
        request.log.error(
          { subject },
          "Agent request rate-limit category is missing its subject identity",
        );
        sendDependencyUnavailable(
          request,
          reply,
          "Request protection is temporarily unavailable.",
        );
        return null;
      }
      if (!(await consumeLimit(request, reply, options.rateLimiter, key, rule))) {
        return null;
      }
    }
  }

  const evaluation = evaluateAgentOperation({
    credentialPolicyCeiling: context.credential.policyCeiling,
    credentialPolicyCeilingDefaultsVersion:
      context.credential.policyCeilingDefaultsVersion,
    credentialPolicyCeilingRules: context.credential.policyCeilingRules,
    credentialPolicyCeilingSchemaVersion: context.credential.policyCeilingSchemaVersion,
    operation: options.operation,
    policyDefaultsVersion: context.agent.policy.defaultsVersion,
    policyRules: context.agent.policy.rules,
    policySchemaVersion: context.agent.policy.schemaVersion,
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
      DEFAULT_AGENT_REQUEST_LIMITS.ip,
    ))
  ) {
    return null;
  }

  const token = agentBearerCredential(request);
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

  return authorizeAuthenticatedAgentRequest(request, reply, context, {
    clientIp,
    operation: options.operation,
    ...(options.policyEnforcement
      ? { policyEnforcement: options.policyEnforcement }
      : {}),
    ...(options.rateLimitCategory
      ? { rateLimitCategory: options.rateLimitCategory }
      : {}),
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
  });
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
