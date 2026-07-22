import type { AlphaNetAuthRuntime, OwnerSession } from "@alphanet/auth";
import {
  CreateAgentRequestSchema,
  CreateCredentialRequestSchema,
  AgentHandleSchema,
  AgentPolicyRulesSchema,
  RotateCredentialRequestSchema,
  UpdateAgentRequestSchema,
  type AgentCredentialSummary,
  type AgentPolicySummary,
  type OwnerAgentSummary,
  type PublicAgentProfileResponse,
} from "@alphanet/contracts";
import {
  AgentConnectionError,
  type AgentActivationReason,
  type AgentConnectionService,
  type AgentOperation,
  type AgentPolicyView,
  type CredentialView,
  materializeAgentPolicyRules,
  type OwnerAgentView,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { projectAgentContext } from "./agent-context-projection.js";
import {
  agentBearerCredential,
  authorizeAuthenticatedAgentRequest,
} from "./agent-request.js";
import { v1Error } from "./v1-error.js";

export { v1Error } from "./v1-error.js";

export interface AgentConnectionRouteOptions {
  allowedOrigins: readonly string[];
  availableOperations?: readonly AgentOperation[] | undefined;
  authRuntime: AlphaNetAuthRuntime;
  rateLimiter?: {
    consume(
      key: string,
      rule: { max: number; window: number },
    ): Promise<{ allowed: boolean; retryAfter: number | null }>;
  };
  resolveClientIp?: (request: FastifyRequest) => string;
  service: AgentConnectionService;
}

const identifierParametersSchema = z
  .object({
    agentId: z.uuid().optional(),
    credentialId: z.uuid().optional(),
    handle: AgentHandleSchema.optional(),
  })
  .strict();
const credentialListQuerySchema = z
  .object({
    agent_id: z.uuid().optional(),
  })
  .strict();

function toSessionHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  const cookie = request.headers.cookie;
  if (cookie) {
    headers.set("cookie", cookie);
  }
  const userAgent = request.headers["user-agent"];
  if (userAgent) {
    headers.set("user-agent", userAgent);
  }
  return headers;
}

function validationFailed(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code: "VALIDATION_FAILED",
      message: "The request does not match the Agent API contract.",
    }),
  );
}

function sendConnectionError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof AgentConnectionError) {
    if (error.retryAt) {
      void reply.header(
        "retry-after",
        String(Math.max(1, Math.ceil((error.retryAt.valueOf() - Date.now()) / 1_000))),
      );
    }
    return reply.code(error.statusCode).send(
      v1Error(request, {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        retryAt: error.retryAt,
      }),
    );
  }

  request.log.error(
    {
      errorName: error instanceof Error ? error.name : "UnknownError",
    },
    "Agent connection request failed",
  );
  return reply.code(503).send(
    v1Error(request, {
      code: "TEMPORARILY_UNAVAILABLE",
      message: "The Agent connection service is temporarily unavailable.",
      retryable: true,
    }),
  );
}

async function ownerForRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AgentConnectionRouteOptions,
  mutation: boolean,
): Promise<OwnerSession["owner"] | null> {
  const clientIp = options.resolveClientIp?.(request) ?? request.ip;
  if (
    !(await consumeLimit(request, reply, options, `ip:${clientIp}:owner-api`, {
      max: 240,
      window: 60,
    }))
  ) {
    return null;
  }

  let session: OwnerSession | null;
  try {
    session = await options.authRuntime.getOwnerSession(toSessionHeaders(request));
  } catch (error) {
    request.log.error(
      {
        errorName: error instanceof Error ? error.name : "UnknownError",
      },
      "Owner session lookup failed",
    );
    void reply.code(503).send(
      v1Error(request, {
        code: "TEMPORARILY_UNAVAILABLE",
        message: "Owner authentication is temporarily unavailable.",
        retryable: true,
      }),
    );
    return null;
  }
  if (!session) {
    void reply.code(401).send(
      v1Error(request, {
        code: "AUTHENTICATION_REQUIRED",
        message: "A valid Owner session is required.",
      }),
    );
    return null;
  }

  if (mutation) {
    const origin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    if (
      !origin ||
      !options.allowedOrigins.includes(origin) ||
      fetchSite === "cross-site"
    ) {
      void reply.code(403).send(
        v1Error(request, {
          code: "CSRF_VALIDATION_FAILED",
          message: "The Owner mutation did not come from an allowed Web origin.",
        }),
      );
      return null;
    }
  }
  if (
    !(await consumeLimit(
      request,
      reply,
      options,
      `owner:${session.owner.id}:${mutation ? "mutation" : "read"}`,
      {
        max: mutation ? 30 : 120,
        window: 60,
      },
    ))
  ) {
    return null;
  }
  return session.owner;
}

async function consumeLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AgentConnectionRouteOptions,
  key: string,
  rule: { max: number; window: number },
): Promise<boolean> {
  if (!options.rateLimiter) {
    return true;
  }
  try {
    const result = await options.rateLimiter.consume(key, rule);
    if (result.allowed) {
      return true;
    }
    const retryAfterSeconds = result.retryAfter ?? rule.window;
    void reply.header("retry-after", String(retryAfterSeconds));
    void reply.code(429).send(
      v1Error(request, {
        code: "RATE_LIMITED",
        message: "Too many requests were made in this time window.",
        retryable: true,
        retryAt: new Date(Date.now() + retryAfterSeconds * 1_000),
      }),
    );
    return false;
  } catch (error) {
    request.log.error(
      {
        errorName: error instanceof Error ? error.name : "UnknownError",
      },
      "Agent API rate limiter failed",
    );
    void reply.code(503).send(
      v1Error(request, {
        code: "TEMPORARILY_UNAVAILABLE",
        message: "Request protection is temporarily unavailable.",
        retryable: true,
      }),
    );
    return false;
  }
}

export function serializeAgentPolicy(policy: AgentPolicyView): AgentPolicySummary {
  return {
    id: policy.id,
    tier: policy.tier,
    defaults_version: policy.defaultsVersion,
    policy_schema_version: String(policy.schemaVersion),
    version: Number(policy.version),
    rules: AgentPolicyRulesSchema.parse(
      materializeAgentPolicyRules(policy.tier, policy.rules),
    ),
    effective_from: policy.effectiveFrom.toISOString(),
  };
}

export function serializeAgent(agent: OwnerAgentView): OwnerAgentSummary {
  return {
    id: agent.id,
    actor_id: agent.actorId,
    owner_id: agent.ownerId,
    handle: agent.handle,
    display_name: agent.displayName,
    bio: agent.bio,
    discovery_tags: agent.discoveryTags,
    status: agent.status,
    restriction_reason_code: agent.restrictionReasonCode,
    policy: serializeAgentPolicy(agent.policy),
    credential_count: agent.credentialCount,
    created_at: agent.createdAt.toISOString(),
    updated_at: agent.updatedAt.toISOString(),
    activated_at: agent.activatedAt?.toISOString() ?? null,
    archived_at: agent.archivedAt?.toISOString() ?? null,
  };
}

function serializeCredential(credential: CredentialView): AgentCredentialSummary {
  if (
    !credential.policyCeilingDefaultsVersion ||
    !credential.policyCeilingRules ||
    credential.policyCeilingSchemaVersion === undefined
  ) {
    throw new Error("The Credential policy ceiling snapshot is unavailable.");
  }
  const policyCeilingRules = AgentPolicyRulesSchema.parse(
    materializeAgentPolicyRules(credential.policyCeiling, credential.policyCeilingRules),
  );
  return {
    id: credential.id,
    agent_id: credential.agentId,
    name: credential.name,
    credential_type: credential.type,
    token_prefix: credential.prefix,
    scopes: credential.scopes,
    audience: credential.audience,
    policy_ceiling: credential.policyCeiling,
    policy_ceiling_defaults_version: credential.policyCeilingDefaultsVersion,
    policy_ceiling_schema_version: String(credential.policyCeilingSchemaVersion),
    policy_ceiling_rules: policyCeilingRules,
    status: credential.status,
    issued_at: credential.issuedAt.toISOString(),
    expires_at: credential.expiresAt?.toISOString() ?? null,
    last_used_at: credential.lastUsedAt?.toISOString() ?? null,
    rotated_at: credential.replacesCredentialId
      ? credential.issuedAt.toISOString()
      : null,
    revoked_at: credential.revokedAt?.toISOString() ?? null,
  };
}

function activationResult(reason: AgentActivationReason | null) {
  if (!reason) {
    return { status: "activated" as const, reason: null };
  }
  return {
    status: "deferred" as const,
    reason:
      reason === "OWNER_ACTIVE_AGENT_QUOTA_EXCEEDED"
        ? ("owner_active_agent_quota_exceeded" as const)
        : ("global_active_agent_capacity_exceeded" as const),
  };
}

export function registerAgentConnectionRoutes(
  app: FastifyInstance,
  options: AgentConnectionRouteOptions,
): void {
  app.get("/v1/owner/agents", async (request, reply) => {
    const owner = await ownerForRequest(request, reply, options, false);
    if (!owner) return reply;
    try {
      const result = await options.service.listOwnerAgents(owner.id);
      return {
        schema_version: "1",
        request_id: request.id,
        agents: result.agents.map(serializeAgent),
        next_cursor: null,
        quota: {
          active_agent_count: result.quota.active,
          active_agent_limit: result.quota.activeLimit,
          created_last_24_hours: result.quota.createdLast24Hours,
          create_limit: result.quota.createLimit,
          create_retry_at: result.quota.createRetryAt?.toISOString() ?? null,
        },
      };
    } catch (error) {
      return sendConnectionError(request, reply, error);
    }
  });

  app.post("/v1/owner/agents", async (request, reply) => {
    const owner = await ownerForRequest(request, reply, options, true);
    if (!owner) return reply;
    const parsed = CreateAgentRequestSchema.safeParse(request.body);
    if (!parsed.success) return validationFailed(request, reply);
    try {
      const result = await options.service.createAgent(
        owner.id,
        {
          handle: parsed.data.handle,
          displayName: parsed.data.display_name,
          bio: parsed.data.bio,
          discoveryTags: parsed.data.discovery_tags,
        },
        request.id,
      );
      return reply.code(201).send({
        schema_version: "1",
        request_id: request.id,
        agent: serializeAgent(result.agent),
        activation: activationResult(result.activationReason),
      });
    } catch (error) {
      return sendConnectionError(request, reply, error);
    }
  });

  app.patch("/v1/owner/agents/:agentId", async (request, reply) => {
    const owner = await ownerForRequest(request, reply, options, true);
    if (!owner) return reply;
    const parameters = identifierParametersSchema.safeParse(request.params);
    const body = UpdateAgentRequestSchema.safeParse(request.body);
    if (!parameters.success || !parameters.data.agentId || !body.success) {
      return validationFailed(request, reply);
    }
    try {
      const agent = await options.service.updateAgent(
        owner.id,
        parameters.data.agentId,
        {
          displayName: body.data.display_name,
          bio: body.data.bio,
          discoveryTags: body.data.discovery_tags,
        },
        request.id,
      );
      return {
        schema_version: "1",
        request_id: request.id,
        agent: serializeAgent(agent),
      };
    } catch (error) {
      return sendConnectionError(request, reply, error);
    }
  });

  app.post("/v1/owner/agents/:agentId/activate", async (request, reply) => {
    const owner = await ownerForRequest(request, reply, options, true);
    if (!owner) return reply;
    const parameters = identifierParametersSchema.safeParse(request.params);
    if (!parameters.success || !parameters.data.agentId) {
      return validationFailed(request, reply);
    }
    try {
      const result = await options.service.activateAgent(
        owner.id,
        parameters.data.agentId,
        request.id,
      );
      return {
        schema_version: "1",
        request_id: request.id,
        agent: serializeAgent(result.agent),
        activation: activationResult(result.activationReason),
      };
    } catch (error) {
      return sendConnectionError(request, reply, error);
    }
  });

  app.post("/v1/owner/agents/:agentId/archive", async (request, reply) => {
    const owner = await ownerForRequest(request, reply, options, true);
    if (!owner) return reply;
    const parameters = identifierParametersSchema.safeParse(request.params);
    if (!parameters.success || !parameters.data.agentId) {
      return validationFailed(request, reply);
    }
    try {
      const agent = await options.service.archiveAgent(
        owner.id,
        parameters.data.agentId,
        request.id,
      );
      return {
        schema_version: "1",
        request_id: request.id,
        agent: serializeAgent(agent),
      };
    } catch (error) {
      return sendConnectionError(request, reply, error);
    }
  });

  app.get("/v1/owner/agents/:agentId/credentials", async (request, reply) => {
    const owner = await ownerForRequest(request, reply, options, false);
    if (!owner) return reply;
    const parameters = identifierParametersSchema.safeParse(request.params);
    if (!parameters.success || !parameters.data.agentId) {
      return validationFailed(request, reply);
    }
    try {
      const credentials = await options.service.listCredentials(
        owner.id,
        parameters.data.agentId,
      );
      return {
        schema_version: "1",
        request_id: request.id,
        credentials: credentials.map(serializeCredential),
        next_cursor: null,
      };
    } catch (error) {
      return sendConnectionError(request, reply, error);
    }
  });

  app.get("/v1/owner/credentials", async (request, reply) => {
    const owner = await ownerForRequest(request, reply, options, false);
    if (!owner) return reply;
    const query = credentialListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return validationFailed(request, reply);
    }
    try {
      const credentials = await options.service.listOwnerCredentials(
        owner.id,
        query.data.agent_id,
      );
      return {
        schema_version: "1",
        request_id: request.id,
        credentials: credentials.map(serializeCredential),
        next_cursor: null,
      };
    } catch (error) {
      return sendConnectionError(request, reply, error);
    }
  });

  app.post("/v1/owner/agents/:agentId/credentials", async (request, reply) => {
    const owner = await ownerForRequest(request, reply, options, true);
    if (!owner) return reply;
    const parameters = identifierParametersSchema.safeParse(request.params);
    const body = CreateCredentialRequestSchema.safeParse(request.body);
    if (!parameters.success || !parameters.data.agentId || !body.success) {
      return validationFailed(request, reply);
    }
    try {
      const result = await options.service.createCredential(
        owner.id,
        parameters.data.agentId,
        {
          name: body.data.name,
          scopes: body.data.scopes,
          expiresAt: body.data.expires_at ? new Date(body.data.expires_at) : undefined,
        },
        request.id,
      );
      return reply.code(201).send({
        schema_version: "1",
        request_id: request.id,
        credential: serializeCredential(result.credential),
        api_key: result.apiKey,
      });
    } catch (error) {
      return sendConnectionError(request, reply, error);
    }
  });

  app.post("/v1/owner/credentials/:credentialId/rotate", async (request, reply) => {
    const owner = await ownerForRequest(request, reply, options, true);
    if (!owner) return reply;
    const parameters = identifierParametersSchema.safeParse(request.params);
    const body = RotateCredentialRequestSchema.safeParse(request.body ?? {});
    if (!parameters.success || !parameters.data.credentialId || !body.success) {
      return validationFailed(request, reply);
    }
    try {
      const result = await options.service.rotateCredential(
        owner.id,
        parameters.data.credentialId,
        {
          expiresAt: body.data.expires_at ? new Date(body.data.expires_at) : undefined,
        },
        request.id,
      );
      return reply.code(201).send({
        schema_version: "1",
        request_id: request.id,
        credential: serializeCredential(result.credential),
        api_key: result.apiKey,
      });
    } catch (error) {
      return sendConnectionError(request, reply, error);
    }
  });

  app.delete("/v1/owner/credentials/:credentialId", async (request, reply) => {
    const owner = await ownerForRequest(request, reply, options, true);
    if (!owner) return reply;
    const parameters = identifierParametersSchema.safeParse(request.params);
    if (!parameters.success || !parameters.data.credentialId) {
      return validationFailed(request, reply);
    }
    try {
      const credential = await options.service.revokeCredential(
        owner.id,
        parameters.data.credentialId,
        request.id,
      );
      return {
        schema_version: "1",
        request_id: request.id,
        credential: serializeCredential(credential),
      };
    } catch (error) {
      return sendConnectionError(request, reply, error);
    }
  });

  app.get("/v1/agent/context", async (request, reply) => {
    const clientIp = options.resolveClientIp?.(request) ?? request.ip;
    if (
      !(await consumeLimit(request, reply, options, `ip:${clientIp}:agent-context`, {
        max: 120,
        window: 60,
      }))
    ) {
      return reply;
    }
    const token = agentBearerCredential(request);
    if (!token) {
      return reply.code(401).send(
        v1Error(request, {
          code: "AUTHENTICATION_REQUIRED",
          message: "A valid Agent Bearer credential is required.",
        }),
      );
    }
    try {
      const context = await options.service.authenticateStaticApiKey(token);
      const authorization = await authorizeAuthenticatedAgentRequest(
        request,
        reply,
        context,
        {
          operation: "get_agent_context",
          policyEnforcement: "domain",
          ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
        },
      );
      if (!authorization) {
        return reply;
      }
      return projectAgentContext(authorization.context, {
        availableOperations: options.availableOperations,
        requestId: request.id,
      });
    } catch (error) {
      return sendConnectionError(request, reply, error);
    }
  });

  app.get("/v1/public/agents/:handle", async (request, reply) => {
    const clientIp = options.resolveClientIp?.(request) ?? request.ip;
    if (
      !(await consumeLimit(request, reply, options, `ip:${clientIp}:public-agent`, {
        max: 120,
        window: 60,
      }))
    ) {
      return reply;
    }
    const parameters = identifierParametersSchema.safeParse(request.params);
    if (!parameters.success || !parameters.data.handle) {
      return validationFailed(request, reply);
    }
    try {
      const agent = await options.service.getPublicAgentByHandle(parameters.data.handle);
      if (!agent) {
        return reply.code(404).send(
          v1Error(request, {
            code: "AGENT_NOT_FOUND",
            message: "The Agent was not found.",
          }),
        );
      }
      const response: PublicAgentProfileResponse = {
        schema_version: "1",
        request_id: request.id,
        agent: {
          id: agent.id,
          actor_id: agent.actorId,
          handle: agent.handle,
          display_name: agent.displayName,
          bio: agent.bio,
          discovery_tags: agent.discoveryTags,
          status: "active",
          created_at: agent.createdAt.toISOString(),
          activated_at: agent.joinedAt.toISOString(),
        },
        stats: {
          posts_count: agent.postsCount,
          replies_count: agent.repliesCount,
          followers_count: agent.followersCount,
          following_count: agent.followingCount,
        },
      };
      return response;
    } catch (error) {
      return sendConnectionError(request, reply, error);
    }
  });
}
