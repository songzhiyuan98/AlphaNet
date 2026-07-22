import {
  parseRemoteMcpOAuthConsentQuery,
  RemoteMcpOAuthConsentError,
  RemoteMcpOAuthConsentQueryError,
  RemoteMcpOAuthGuardError,
  type AlphaNetAuthRuntime,
  type RemoteMcpOAuthConsentErrorCode,
  type RemoteMcpOAuthConsentRequestView,
  type RemoteMcpOAuthConsentService,
  type RemoteMcpOAuthPreparedGrant,
  type ValidatedRemoteMcpAuthorizeQuery,
} from "@alphanet/auth";
import {
  OwnerRemoteMcpOAuthConsentInspectRequestSchema,
  OwnerRemoteMcpOAuthConsentInspectResponseSchema,
  OwnerRemoteMcpOAuthConsentSelectAgentRequestSchema,
  OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema,
} from "@alphanet/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createOwnerRequestAuthorizationBoundary,
  type OwnerRequestRateLimiter,
} from "./owner-request.js";
import { v1Error } from "./v1-error.js";

export interface OwnerRemoteMcpOAuthConsentRouteOptions {
  allowedOrigins: readonly string[];
  authRuntime: Pick<AlphaNetAuthRuntime, "getOwnerSession">;
  rateLimiter?: OwnerRequestRateLimiter | undefined;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
  resource: string;
  service: Pick<
    RemoteMcpOAuthConsentService,
    "loadConsentRequest" | "resolveContinuationHandle" | "selectAgentAndPrepareGrant"
  >;
}

const consentLimits = {
  ip: { max: 120, window: 60 },
  mutation: { max: 20, window: 60 },
} as const;

const consentErrors: Record<
  RemoteMcpOAuthConsentErrorCode,
  { message: string; statusCode: number }
> = {
  AGENT_NOT_AVAILABLE: {
    message: "The selected Agent is not available for this authorization request.",
    statusCode: 404,
  },
  CLIENT_NOT_AVAILABLE: {
    message: "The OAuth client is not available for this authorization request.",
    statusCode: 400,
  },
  CONSENT_STATE_CONFLICT: {
    message: "The OAuth consent request is no longer in the expected state.",
    statusCode: 409,
  },
  CONTINUATION_EXPIRED: {
    message: "The OAuth consent continuation has expired.",
    statusCode: 410,
  },
  CONTINUATION_INVALID: {
    message: "The OAuth consent continuation is invalid.",
    statusCode: 400,
  },
  CONTINUATION_REPLAYED: {
    message: "The OAuth consent continuation has already been used.",
    statusCode: 409,
  },
  GRANT_CONFLICT: {
    message: "The OAuth Grant conflicts with the current authorization request.",
    statusCode: 409,
  },
  OWNER_SESSION_INVALID: {
    message: "The Owner session is not valid for this OAuth consent request.",
    statusCode: 401,
  },
  REQUEST_EXPIRED: {
    message: "The OAuth authorization request has expired.",
    statusCode: 410,
  },
  REQUEST_NOT_FOUND: {
    message: "The OAuth authorization request is not available.",
    statusCode: 404,
  },
};

function hasNoQueryParameters(request: FastifyRequest): boolean {
  return new URL(request.url, "http://alphanet.invalid").searchParams.size === 0;
}

function validationFailed(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code: "INVALID_ARGUMENT",
      message: "The request does not match the Owner Remote MCP OAuth consent contract.",
    }),
  );
}

function parseConsentQuery(
  oauthQuery: string,
  resource: string,
): ValidatedRemoteMcpAuthorizeQuery | null {
  try {
    return parseRemoteMcpOAuthConsentQuery(oauthQuery, { resource });
  } catch (error) {
    if (
      error instanceof RemoteMcpOAuthConsentQueryError ||
      error instanceof RemoteMcpOAuthGuardError
    ) {
      return null;
    }
    throw error;
  }
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

function viewMatchesAuthority(
  view: RemoteMcpOAuthConsentRequestView,
  query: ValidatedRemoteMcpAuthorizeQuery,
  ownerId: string,
): boolean {
  let redirectOrigin: string;
  try {
    redirectOrigin = new URL(query.redirectUri).origin;
  } catch {
    return false;
  }

  const agentIds = new Set(view.agents.map((agent) => agent.id));
  if (agentIds.size !== view.agents.length) return false;
  const selectionIsConsistent =
    view.status === "pending"
      ? view.selectedAgentId === null
      : view.selectedAgentId !== null && agentIds.has(view.selectedAgentId);

  return (
    view.ownerId === ownerId &&
    view.client.id === query.clientId &&
    view.client.redirectOrigin === redirectOrigin &&
    view.resource === query.resource &&
    arraysEqual(view.requestedScopes, query.requestedScopes) &&
    selectionIsConsistent
  );
}

function publicConsentView(
  view: RemoteMcpOAuthConsentRequestView,
  phase: "agent_selection" | "consent_review",
  redirectUri: string,
  credentialPolicyCeiling: RemoteMcpOAuthPreparedGrant["credentialPolicyCeiling"] | null,
): Record<string, unknown> {
  return {
    phase,
    client: {
      id: view.client.id,
      name: view.client.name,
      redirect_origin: view.client.redirectOrigin,
      redirect_uri: redirectUri,
    },
    resource: view.resource,
    requested_scopes: [...view.requestedScopes],
    expires_at: view.expiresAt.toISOString(),
    selected_agent_id: phase === "consent_review" ? view.selectedAgentId : null,
    credential_policy_ceiling:
      credentialPolicyCeiling === null
        ? null
        : {
            tier: credentialPolicyCeiling.tier,
            defaults_version: credentialPolicyCeiling.defaultsVersion,
            schema_version: credentialPolicyCeiling.schemaVersion,
          },
    agents: view.agents.map((agent) => ({
      id: agent.id,
      handle: agent.handle,
      display_name: agent.displayName,
      policy: {
        tier: agent.policy.tier,
        defaults_version: agent.policy.defaultsVersion,
        schema_version: agent.policy.schemaVersion,
        version: agent.policy.version,
      },
    })),
  };
}

function grantMatchesSelection(
  grant: RemoteMcpOAuthPreparedGrant,
  view: RemoteMcpOAuthConsentRequestView,
  query: ValidatedRemoteMcpAuthorizeQuery,
  selectedAgentId: string,
): boolean {
  const expectedGrantScopes = query.requestedScopes.filter(
    (scope) => scope !== "offline_access",
  );
  return (
    grant.authorizationRequestId === view.id &&
    view.status === "selected" &&
    view.selectedAgentId === selectedAgentId &&
    arraysEqual(grant.scopes, expectedGrantScopes)
  );
}

function sendConsentError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof RemoteMcpOAuthConsentError) {
    const mapped = consentErrors[error.code];
    return reply.code(mapped.statusCode).send(
      v1Error(request, {
        code: error.code,
        message: mapped.message,
      }),
    );
  }

  request.log.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Owner Remote MCP OAuth consent operation failed",
  );
  return reply.code(503).send(
    v1Error(request, {
      code: "OWNER_OAUTH_CONSENT_UNAVAILABLE",
      message: "Owner Remote MCP OAuth consent is temporarily unavailable.",
      retryable: true,
    }),
  );
}

export function registerOwnerRemoteMcpOAuthConsentRoutes(
  app: FastifyInstance,
  options: OwnerRemoteMcpOAuthConsentRouteOptions,
): void {
  const authorization = createOwnerRequestAuthorizationBoundary({
    allowedOrigins: options.allowedOrigins,
    authRuntime: options.authRuntime,
    limits: consentLimits,
    mode: "mutation",
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
  });

  app.post(
    "/v1/owner/remote-mcp/oauth/consent/inspect",
    { onRequest: authorization.onRequest },
    async (request, reply) => {
      const ownerAuthorization = authorization.getAuthorization(request);
      const body = OwnerRemoteMcpOAuthConsentInspectRequestSchema.safeParse(request.body);
      if (!body.success || !hasNoQueryParameters(request)) {
        return validationFailed(request, reply);
      }
      let query: ValidatedRemoteMcpAuthorizeQuery | null;
      try {
        query = parseConsentQuery(body.data.oauth_query, options.resource);
      } catch (error) {
        return sendConsentError(request, reply, error);
      }
      if (!query) return validationFailed(request, reply);

      try {
        const view = await options.service.loadConsentRequest({
          clientId: query.clientId,
          codeChallenge: query.codeChallenge,
          ownerSessionId: ownerAuthorization.session.id,
          redirectUri: query.redirectUri,
          requestedScopes: query.requestedScopes,
          resource: query.resource,
        });
        if (!viewMatchesAuthority(view, query, ownerAuthorization.owner.id)) {
          return sendConsentError(request, reply, new Error("projection invalid"));
        }

        let phase: "agent_selection" | "consent_review" = "agent_selection";
        let credentialPolicyCeiling:
          RemoteMcpOAuthPreparedGrant["credentialPolicyCeiling"] | null = null;
        if (body.data.continuation_handle !== undefined) {
          const continuation = await options.service.resolveContinuationHandle({
            continuationHandle: body.data.continuation_handle,
            ownerSessionId: ownerAuthorization.session.id,
            phase: "inspect",
          });
          if (
            continuation.authorizationRequestId !== view.id ||
            view.status !== "selected" ||
            view.selectedAgentId === null
          ) {
            return sendConsentError(request, reply, new Error("projection invalid"));
          }
          phase = "consent_review";
          credentialPolicyCeiling = continuation.credentialPolicyCeiling;
        }

        const response = OwnerRemoteMcpOAuthConsentInspectResponseSchema.safeParse({
          ...publicConsentView(view, phase, query.redirectUri, credentialPolicyCeiling),
          request_id: request.id,
          schema_version: "1",
        });
        if (!response.success) {
          return sendConsentError(request, reply, new Error("projection invalid"));
        }
        return reply.code(200).send(response.data);
      } catch (error) {
        return sendConsentError(request, reply, error);
      }
    },
  );

  app.post(
    "/v1/owner/remote-mcp/oauth/consent/select-agent",
    { onRequest: authorization.onRequest },
    async (request, reply) => {
      const ownerAuthorization = authorization.getAuthorization(request);
      const body = OwnerRemoteMcpOAuthConsentSelectAgentRequestSchema.safeParse(
        request.body,
      );
      if (!body.success || !hasNoQueryParameters(request)) {
        return validationFailed(request, reply);
      }
      let query: ValidatedRemoteMcpAuthorizeQuery | null;
      try {
        query = parseConsentQuery(body.data.oauth_query, options.resource);
      } catch (error) {
        return sendConsentError(request, reply, error);
      }
      if (!query) return validationFailed(request, reply);

      const consentRequestInput = {
        clientId: query.clientId,
        codeChallenge: query.codeChallenge,
        ownerSessionId: ownerAuthorization.session.id,
        redirectUri: query.redirectUri,
        requestedScopes: query.requestedScopes,
        resource: query.resource,
      };

      try {
        const grant = await options.service.selectAgentAndPrepareGrant({
          ...consentRequestInput,
          agentId: body.data.agent_id,
        });
        const view = await options.service.loadConsentRequest(consentRequestInput);
        if (
          !viewMatchesAuthority(view, query, ownerAuthorization.owner.id) ||
          !grantMatchesSelection(grant, view, query, body.data.agent_id)
        ) {
          return sendConsentError(request, reply, new Error("projection invalid"));
        }

        const response = OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema.safeParse({
          ...publicConsentView(
            view,
            "consent_review",
            query.redirectUri,
            grant.credentialPolicyCeiling,
          ),
          continuation_handle: grant.continuationHandle,
          grant_expires_at: grant.expiresAt.toISOString(),
          idempotent: grant.idempotent,
          request_id: request.id,
          schema_version: "1",
        });
        if (!response.success) {
          return sendConsentError(request, reply, new Error("projection invalid"));
        }
        return reply.code(200).send(response.data);
      } catch (error) {
        return sendConsentError(request, reply, error);
      }
    },
  );
}
