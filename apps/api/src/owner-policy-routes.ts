import {
  OWNER_SESSION_FRESH_AGE_SECONDS,
  type AlphaNetAuthRuntime,
} from "@alphanet/auth";
import {
  AgentPermissionTierSchema,
  AgentPolicyRulesSchema,
  OwnerAgentPolicyUpdateRequestSchema,
  OwnerAgentPolicyUpdateResponseSchema,
  UuidSchema,
  type OwnerAgentPolicyUpdateRequest,
  type OwnerAgentPolicyUpdateResponse,
  type V1ErrorDetail,
} from "@alphanet/contracts";
import {
  AgentConnectionError,
  type AgentConnectionService,
  type AgentPolicyMutationResult,
  materializeAgentPolicyRules,
  normalizeAgentPolicyRules,
} from "@alphanet/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { serializeAgent, serializeAgentPolicy, v1Error } from "./agent-routes.js";
import {
  createOwnerRequestAuthorizationBoundary,
  type OwnerRequestRateLimiter,
} from "./owner-request.js";

export interface OwnerAgentPolicyRouteOptions {
  allowedOrigins: readonly string[];
  authRuntime: Pick<AlphaNetAuthRuntime, "getOwnerSession">;
  now?: (() => Date) | undefined;
  rateLimiter?: OwnerRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  service: Pick<AgentConnectionService, "updateAgentPolicy">;
}

const autonomousContentRuleNames = [
  "content_write",
  "reply_write",
  "edit_own_content",
  "delete_own_content",
] as const;

function hasNoQueryParameters(request: FastifyRequest): boolean {
  return new URL(request.url, "http://alphanet.invalid").searchParams.size === 0;
}

function agentId(request: FastifyRequest): string | null {
  const parsed = UuidSchema.safeParse((request.params as { agentId?: unknown }).agentId);
  return parsed.success ? parsed.data : null;
}

function requiresFreshOwnerSession(request: OwnerAgentPolicyUpdateRequest): boolean {
  return (
    request.tier === "autonomous" ||
    (request.tier === "custom" &&
      autonomousContentRuleNames.some((ruleName) => request.rules[ruleName] === "allow"))
  );
}

function isFreshOwnerSession(createdAt: Date, now: Date): boolean {
  const ageMilliseconds = now.valueOf() - createdAt.valueOf();
  return (
    Number.isFinite(ageMilliseconds) &&
    ageMilliseconds >= -60_000 &&
    ageMilliseconds < OWNER_SESSION_FRESH_AGE_SECONDS * 1_000
  );
}

function validationFailed(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code: "INVALID_ARGUMENT",
      message: "The request does not match the Owner policy API contract.",
    }),
  );
}

function safePolicyVersion(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) return undefined;
  const version = Number(value);
  return Number.isSafeInteger(version) ? version : undefined;
}

function policyErrorDetails(error: AgentConnectionError): V1ErrorDetail["details"] {
  if (error.code !== "AGENT_POLICY_VERSION_CONFLICT") return null;
  const tier = AgentPermissionTierSchema.safeParse(error.currentPolicyTier);
  const version = safePolicyVersion(error.currentPolicyVersion);
  const details = {
    ...(tier.success ? { current_tier: tier.data } : {}),
    ...(version === undefined ? {} : { current_version: version }),
  };
  return Object.keys(details).length === 0 ? null : details;
}

function sendPolicyError(
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
        details: policyErrorDetails(error),
      }),
    );
  }

  request.log.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Owner Agent policy request failed",
  );
  return reply.code(503).send(
    v1Error(request, {
      code: "OWNER_POLICY_UNAVAILABLE",
      message: "Owner policy operations are temporarily unavailable.",
      retryable: true,
    }),
  );
}

function responseFor(
  request: FastifyRequest,
  result: AgentPolicyMutationResult,
  expectedRequest: OwnerAgentPolicyUpdateRequest,
  expectedOwnerId: string,
  expectedAgentId: string,
): OwnerAgentPolicyUpdateResponse | null {
  const parsed = OwnerAgentPolicyUpdateResponseSchema.safeParse({
    changed: result.changed,
    previous_policy: serializeAgentPolicy(result.previousPolicy),
    agent: serializeAgent(result.agent),
    credential_impact: {
      retained_credential_count: result.credentialImpact.retainedCredentialCount,
      ceiling_counts: {
        read_only: result.credentialImpact.ceilingCounts.read_only,
        assisted: result.credentialImpact.ceilingCounts.assisted,
        autonomous: result.credentialImpact.ceilingCounts.autonomous,
        custom: result.credentialImpact.ceilingCounts.custom,
      },
      existing_credentials_keep_ceiling: true,
    },
    request_id: request.id,
    schema_version: "1",
  });
  if (
    !parsed.success ||
    parsed.data.agent.id !== expectedAgentId ||
    parsed.data.agent.owner_id !== expectedOwnerId ||
    parsed.data.agent.policy.tier !== expectedRequest.tier ||
    (parsed.data.changed &&
      parsed.data.previous_policy.version !== expectedRequest.expected_version)
  ) {
    return null;
  }
  const requestedRules =
    expectedRequest.tier === "custom" ? { operations: expectedRequest.rules } : {};
  const expectedRules = materializeAgentPolicyRules(
    expectedRequest.tier,
    normalizeAgentPolicyRules(expectedRequest.tier, requestedRules),
  );
  const parsedExpectedRules = AgentPolicyRulesSchema.safeParse(expectedRules);
  if (!parsedExpectedRules.success) return null;
  return JSON.stringify(parsed.data.agent.policy.rules) ===
    JSON.stringify(parsedExpectedRules.data)
    ? parsed.data
    : null;
}

export function registerOwnerAgentPolicyRoutes(
  app: FastifyInstance,
  options: OwnerAgentPolicyRouteOptions,
): void {
  const authorization = createOwnerRequestAuthorizationBoundary({
    allowedOrigins: options.allowedOrigins,
    authRuntime: options.authRuntime,
    mode: "mutation",
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  });

  app.put(
    "/v1/owner/agents/:agentId/permission-policy",
    { onRequest: authorization.onRequest },
    async (request, reply) => {
      const ownerAuthorization = authorization.getAuthorization(request);
      const id = agentId(request);
      const body = OwnerAgentPolicyUpdateRequestSchema.safeParse(request.body);
      if (!id || !hasNoQueryParameters(request) || !body.success) {
        return validationFailed(request, reply);
      }

      const now = options.now?.() ?? new Date();
      const freshSession = isFreshOwnerSession(ownerAuthorization.session.createdAt, now);
      if (requiresFreshOwnerSession(body.data) && !freshSession) {
        return reply.code(403).send(
          v1Error(request, {
            code: "OWNER_REAUTHENTICATION_REQUIRED",
            message: "A fresh Owner session is required for autonomous content writes.",
          }),
        );
      }

      try {
        const result = await options.service.updateAgentPolicy(
          ownerAuthorization.owner.id,
          id,
          {
            authenticatedAt: ownerAuthorization.session.createdAt,
            authenticationAssurance: freshSession
              ? "fresh_owner_session"
              : "owner_session",
            autonomousAcknowledged: "autonomous_acknowledgement" in body.data,
            expectedVersion: String(body.data.expected_version),
            rules: body.data.tier === "custom" ? { operations: body.data.rules } : {},
            tier: body.data.tier,
          },
          request.id,
        );
        const response = responseFor(
          request,
          result,
          body.data,
          ownerAuthorization.owner.id,
          id,
        );
        if (response) return reply.code(200).send(response);

        request.log.error(
          { changed: result.changed },
          "Owner Agent policy projection was invalid",
        );
        return sendPolicyError(request, reply, new Error("projection invalid"));
      } catch (error) {
        return sendPolicyError(request, reply, error);
      }
    },
  );
}
