import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import {
  CreatePostRequestSchema,
  GetActionStatusRequestSchema,
  GetCommunityRequestSchema,
} from "@alphanet/contracts";
import type {
  AgentOperation,
  CommunityDirectoryService,
  ContentReadService,
  PendingActionStatusService,
  ResearchWriteService,
} from "@alphanet/domain";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerFactory,
  LogController,
} from "fastify";

import { projectAgentContext } from "./agent-context-projection.js";
import {
  AGENT_WRITE_REQUEST_RATE_LIMIT_CATEGORY,
  authorizeAuthenticatedAgentRequest,
  type AgentRequestRateLimitCategory,
  type AgentRequestRateLimiter,
  type AuthorizedAgentRequest,
} from "./agent-request.js";
import { handleAgentGetCommunity } from "./community-routes.js";
import { handleGetContentRequest } from "./content-read-routes.js";
import {
  createRemoteMcpActorAuthenticator,
  RemoteMcpActorAuthenticationError,
  type RemoteMcpActorAuthenticatorOptions,
} from "./mcp-actor-authenticator.js";
import { handleAgentGetActionStatus } from "./pending-action-routes.js";
import { handleAgentCreatePost } from "./research-write-routes.js";
import { v1Error } from "./v1-error.js";

export const PRIVATE_MCP_API_PREFIX = "/internal/mcp/v1";
export const PRIVATE_MCP_AGENT_CONTEXT_PATH =
  `${PRIVATE_MCP_API_PREFIX}/agent/context` as const;
export const PRIVATE_MCP_COMMUNITY_BY_SLUG_PATH =
  `${PRIVATE_MCP_API_PREFIX}/communities/by-slug/:slug` as const;
export const PRIVATE_MCP_COMMUNITY_PATH =
  `${PRIVATE_MCP_API_PREFIX}/communities/:communityId` as const;
export const PRIVATE_MCP_CONTENT_PATH =
  `${PRIVATE_MCP_API_PREFIX}/content/:contentId` as const;
export const PRIVATE_MCP_POSTS_PATH = `${PRIVATE_MCP_API_PREFIX}/posts` as const;
export const PRIVATE_MCP_ACTION_PATH =
  `${PRIVATE_MCP_API_PREFIX}/actions/:actionId` as const;

export interface PrivateMcpTransportIdentity {
  authentication: "mutual_tls";
  service: "mcp";
}

/**
 * The server assembly owns TLS and certificate verification. This guard must
 * return the MCP service identity only after the socket is mutually
 * authenticated and its certificate identity has been pinned/allowed.
 */
export type PrivateMcpTransportIdentityGuard = (
  request: FastifyRequest,
) => PrivateMcpTransportIdentity | null | Promise<PrivateMcpTransportIdentity | null>;

export interface PrivateMcpAppOptions {
  actorAuthenticator: RemoteMcpActorAuthenticatorOptions;
  communityDirectoryService: Pick<CommunityDirectoryService, "getCommunity">;
  contentReadService: Pick<ContentReadService, "getContent">;
  logger?: FastifyBaseLogger | undefined;
  now?: (() => Date) | undefined;
  pendingActionStatusService: Pick<PendingActionStatusService, "getActionStatus">;
  rateLimiter: AgentRequestRateLimiter;
  researchWriteService: Pick<ResearchWriteService, "createPost">;
  /** Root runtime injection used to create the dedicated HTTPS/mTLS server. */
  serverFactory?: FastifyServerFactory | undefined;
  transportIdentityGuard: PrivateMcpTransportIdentityGuard;
}

interface RawHeadersCarrier {
  rawHeaders: readonly string[];
}

interface PrivateMcpAuthorization extends AuthorizedAgentRequest {
  requestId: string;
}

const requestIdPattern =
  /^(?:req[-_][A-Za-z0-9][A-Za-z0-9_-]{0,59}|(?!0{32}$)[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/;
const forbiddenIdentityNames = new Set([
  "accesstoken",
  "actor",
  "actorcontext",
  "actorid",
  "agent",
  "agentid",
  "apikey",
  "authorization",
  "bearer",
  "clientid",
  "clientsecret",
  "cookie",
  "credential",
  "credentialid",
  "grant",
  "grantid",
  "idtoken",
  "oauthgrantid",
  "owner",
  "ownerid",
  "principal",
  "principalid",
  "refreshtoken",
  "session",
  "sessiontoken",
  "sub",
  "subject",
  "token",
  "tokenjti",
  "tokenjtidigest",
  "xalphanetmcpactorcontext",
]);

function normalizedIdentityName(name: string): string {
  return name.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function rawHeaderValues(carrier: RawHeadersCarrier, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < carrier.rawHeaders.length; index += 2) {
    const rawName = carrier.rawHeaders[index];
    const rawValue = carrier.rawHeaders[index + 1];
    if (
      typeof rawName === "string" &&
      rawName.toLowerCase() === name &&
      typeof rawValue === "string"
    ) {
      values.push(rawValue);
    }
  }
  return values;
}

function oneRawHeader(request: FastifyRequest, name: string): string | null {
  const rawValues = rawHeaderValues(request.raw, name);
  const normalizedValue = request.headers[name];
  if (
    rawValues.length !== 1 ||
    typeof normalizedValue !== "string" ||
    normalizedValue !== rawValues[0]
  ) {
    return null;
  }
  return normalizedValue;
}

function safeRequestId(rawRequest: IncomingMessage): string {
  const values = rawHeaderValues(rawRequest, "x-request-id");
  const candidate = values.length === 1 ? values[0] : undefined;
  return candidate && requestIdPattern.test(candidate) ? candidate : randomUUID();
}

function hasRawHeader(request: FastifyRequest, name: string): boolean {
  return rawHeaderValues(request.raw, name).length > 0;
}

function hasRequestBodySignal(request: FastifyRequest): boolean {
  if (hasRawHeader(request, "transfer-encoding")) {
    return true;
  }
  const lengths = rawHeaderValues(request.raw, "content-length");
  return lengths.some((value) => value !== "0");
}

function urlContainsIdentity(request: FastifyRequest): boolean {
  const url = new URL(request.url, "http://alphanet.invalid");
  return Array.from(url.searchParams.keys()).some((name) =>
    forbiddenIdentityNames.has(normalizedIdentityName(name)),
  );
}

function hasQueryParameters(request: FastifyRequest): boolean {
  return new URL(request.url, "http://alphanet.invalid").searchParams.size > 0;
}

function valueContainsIdentity(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): boolean {
  if (depth > 32) {
    return true;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (seen.has(value)) {
    return true;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => valueContainsIdentity(entry, seen, depth + 1));
  }
  return Object.entries(value).some(
    ([name, entry]) =>
      forbiddenIdentityNames.has(normalizedIdentityName(name)) ||
      valueContainsIdentity(entry, seen, depth + 1),
  );
}

function sendPrivateAuthenticationFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  code = "REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED",
  message = "Remote MCP request authentication failed.",
): FastifyReply {
  return reply.code(401).send(
    v1Error(request, {
      code,
      message,
    }),
  );
}

function sendPrivateDependencyUnavailable(
  request: FastifyRequest,
  reply: FastifyReply,
  code = "REMOTE_MCP_ACTOR_AUTHENTICATION_UNAVAILABLE",
  message = "Remote MCP request authentication is temporarily unavailable.",
): FastifyReply {
  return reply.code(503).send(
    v1Error(request, {
      code,
      message,
      retryable: true,
    }),
  );
}

function sendPrivateValidationFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  code = "INVALID_ARGUMENT",
): FastifyReply {
  return reply.code(422).send(
    v1Error(request, {
      code,
      message: "The request does not match the Agent API contract.",
    }),
  );
}

function validTransportIdentity(
  identity: PrivateMcpTransportIdentity | null,
): identity is PrivateMcpTransportIdentity {
  return identity?.authentication === "mutual_tls" && identity.service === "mcp";
}

interface PrivateAuthorizationOptions {
  allowBody?: boolean | undefined;
  operation: AgentOperation;
  policyEnforcement?: "boundary" | "domain" | undefined;
  rateLimitCategory?: AgentRequestRateLimitCategory | undefined;
}

/**
 * Builds the application mounted on the private mTLS listener. It deliberately
 * owns no listener and no dependency lifecycle; the API runtime supplies both.
 */
export async function createPrivateMcpApp(
  options: PrivateMcpAppOptions,
): Promise<FastifyInstance> {
  const actorAuthenticator = createRemoteMcpActorAuthenticator(
    options.actorAuthenticator,
  );
  const transportAuthenticated = new WeakSet<FastifyRequest>();
  const authorizations = new WeakMap<FastifyRequest, PrivateMcpAuthorization>();
  const app = Fastify({
    bodyLimit: 64 * 1_024,
    genReqId: safeRequestId,
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ? false : { level: "silent" },
    ...(options.logger ? { loggerInstance: options.logger } : {}),
    ...(options.serverFactory ? { serverFactory: options.serverFactory } : {}),
    requestIdHeader: false,
  });

  app.addHook("onRequest", async (request, reply) => {
    let identity: PrivateMcpTransportIdentity | null;
    try {
      identity = await options.transportIdentityGuard(request);
    } catch (error) {
      request.log.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Private MCP transport identity verification failed",
      );
      return sendPrivateDependencyUnavailable(
        request,
        reply,
        "REMOTE_MCP_TRANSPORT_AUTHENTICATION_UNAVAILABLE",
        "Private MCP transport authentication is temporarily unavailable.",
      );
    }
    if (!validTransportIdentity(identity)) {
      return sendPrivateAuthenticationFailure(
        request,
        reply,
        "REMOTE_MCP_TRANSPORT_AUTHENTICATION_FAILED",
        "Private MCP transport authentication failed.",
      );
    }
    transportAuthenticated.add(request);
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    void reply.header("cache-control", "no-store, private");
    void reply.header("pragma", "no-cache");
    void reply.header("x-request-id", request.id);
    done(null, payload);
  });

  const privateAuthorization =
    (authorizationOptions: PrivateAuthorizationOptions) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!transportAuthenticated.has(request)) {
        return sendPrivateDependencyUnavailable(request, reply);
      }
      if (
        hasRawHeader(request, "authorization") ||
        hasRawHeader(request, "cookie") ||
        (!authorizationOptions.allowBody && hasRequestBodySignal(request)) ||
        urlContainsIdentity(request) ||
        valueContainsIdentity(request.body)
      ) {
        return sendPrivateAuthenticationFailure(request, reply);
      }

      const requestId = oneRawHeader(request, "x-request-id");
      const assertion = oneRawHeader(request, "x-alphanet-mcp-actor-context");
      if (!requestId || !requestIdPattern.test(requestId) || !assertion) {
        return sendPrivateAuthenticationFailure(request, reply);
      }

      let context;
      try {
        context = await actorAuthenticator.authenticate({ assertion, requestId });
      } catch (error) {
        if (error instanceof RemoteMcpActorAuthenticationError) {
          if (error.statusCode === 401) {
            return sendPrivateAuthenticationFailure(request, reply);
          }
          return sendPrivateDependencyUnavailable(request, reply);
        }
        request.log.error(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Private MCP ActorContext authentication failed",
        );
        return sendPrivateDependencyUnavailable(request, reply);
      }

      const authorization = await authorizeAuthenticatedAgentRequest(
        request,
        reply,
        context,
        {
          operation: authorizationOptions.operation,
          policyEnforcement: authorizationOptions.policyEnforcement,
          rateLimiter: options.rateLimiter,
          rateLimitCategory: authorizationOptions.rateLimitCategory,
          rateLimitSubjects: ["agent", "owner"],
        },
      );
      if (!authorization) {
        return reply;
      }
      authorizations.set(request, { ...authorization, requestId });
    };

  const authorizationFor = (request: FastifyRequest): PrivateMcpAuthorization => {
    const authorization = authorizations.get(request);
    if (!authorization) {
      throw new Error("Private MCP request reached its handler without authorization");
    }
    return authorization;
  };

  app.get(
    PRIVATE_MCP_AGENT_CONTEXT_PATH,
    {
      preValidation: privateAuthorization({
        operation: "get_agent_context",
        policyEnforcement: "domain",
      }),
    },
    (request) => {
      const authorization = authorizationFor(request);
      const now = options.now?.() ?? new Date();
      return projectAgentContext(authorization.context, {
        availableOperations: [
          "get_agent_context",
          "get_community",
          "create_post",
          "get_action_status",
          "get_content",
        ],
        now,
        requestId: authorization.requestId,
      });
    },
  );

  // Keep the static slug route ahead of the opaque ID route.
  app.get(
    PRIVATE_MCP_COMMUNITY_BY_SLUG_PATH,
    { preValidation: privateAuthorization({ operation: "get_community" }) },
    (request, reply) => {
      if (hasQueryParameters(request)) {
        return sendPrivateValidationFailure(request, reply);
      }
      const rawParameters = request.params as { slug?: unknown };
      const parameters = GetCommunityRequestSchema.safeParse({
        slug: rawParameters.slug,
      });
      if (!parameters.success || !parameters.data.slug) {
        return sendPrivateValidationFailure(request, reply);
      }
      return handleAgentGetCommunity(
        request,
        reply,
        options.communityDirectoryService,
        authorizationFor(request).context,
        { slug: parameters.data.slug },
        "Private MCP Community slug",
      );
    },
  );

  app.get(
    PRIVATE_MCP_COMMUNITY_PATH,
    { preValidation: privateAuthorization({ operation: "get_community" }) },
    (request, reply) => {
      if (hasQueryParameters(request)) {
        return sendPrivateValidationFailure(request, reply);
      }
      const rawParameters = request.params as { communityId?: unknown };
      const parameters = GetCommunityRequestSchema.safeParse({
        community_id: rawParameters.communityId,
      });
      if (!parameters.success || !parameters.data.community_id) {
        return sendPrivateValidationFailure(request, reply);
      }
      return handleAgentGetCommunity(
        request,
        reply,
        options.communityDirectoryService,
        authorizationFor(request).context,
        { communityId: parameters.data.community_id },
        "Private MCP Community detail",
      );
    },
  );

  app.get(
    PRIVATE_MCP_CONTENT_PATH,
    { preValidation: privateAuthorization({ operation: "get_content" }) },
    (request, reply) =>
      handleGetContentRequest(
        request,
        reply,
        { service: options.contentReadService },
        authorizationFor(request).context,
        "Agent",
      ),
  );

  app.get(
    PRIVATE_MCP_ACTION_PATH,
    { preValidation: privateAuthorization({ operation: "get_action_status" }) },
    (request, reply) => {
      if (hasQueryParameters(request)) {
        return sendPrivateValidationFailure(request, reply);
      }
      const rawParameters = request.params as { actionId?: unknown };
      const parameters = GetActionStatusRequestSchema.safeParse({
        action_id: rawParameters.actionId,
      });
      if (!parameters.success) {
        return sendPrivateValidationFailure(request, reply);
      }
      const authorization = authorizationFor(request);
      return handleAgentGetActionStatus(
        request,
        reply,
        options.pendingActionStatusService,
        {
          agentId: authorization.context.agent.id,
          ownerId: authorization.context.owner.id,
        },
        parameters.data.action_id,
      );
    },
  );

  app.post(
    PRIVATE_MCP_POSTS_PATH,
    {
      bodyLimit: 1_024 * 1_024,
      preValidation: privateAuthorization({
        allowBody: true,
        operation: "create_post",
        policyEnforcement: "domain",
        rateLimitCategory: AGENT_WRITE_REQUEST_RATE_LIMIT_CATEGORY,
      }),
    },
    (request, reply) => {
      if (hasQueryParameters(request)) {
        return sendPrivateValidationFailure(request, reply);
      }
      const body = CreatePostRequestSchema.safeParse(request.body);
      if (!body.success) {
        return sendPrivateValidationFailure(request, reply, "VALIDATION_ERROR");
      }
      return handleAgentCreatePost(
        request,
        reply,
        options.researchWriteService,
        authorizationFor(request).context,
        body.data,
        "mcp",
        `${PRIVATE_MCP_API_PREFIX}/actions`,
      );
    },
  );

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send(
      v1Error(request, {
        code: "ROUTE_NOT_FOUND",
        message: "The requested private MCP API route does not exist.",
      }),
    );
  });

  app.setErrorHandler(async (error, request, reply) => {
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null;
    if (statusCode >= 400 && statusCode < 500) {
      request.log.warn(
        { errorName, statusCode },
        "Private MCP request rejected before authorization",
      );
      const payloadTooLarge =
        statusCode === 413 || errorCode === "FST_ERR_CTP_BODY_TOO_LARGE";
      const unsupportedMediaType = statusCode === 415;
      const malformedJson = errorCode === "FST_ERR_CTP_INVALID_JSON_BODY";
      if (payloadTooLarge || unsupportedMediaType || malformedJson) {
        return reply.code(statusCode).send(
          v1Error(request, {
            code: payloadTooLarge
              ? "PAYLOAD_TOO_LARGE"
              : unsupportedMediaType
                ? "UNSUPPORTED_MEDIA_TYPE"
                : "MALFORMED_REQUEST",
            message: payloadTooLarge
              ? "The request body exceeds the maximum allowed size."
              : unsupportedMediaType
                ? "The request content type is not supported."
                : "The request body is not valid JSON.",
          }),
        );
      }
      return sendPrivateAuthenticationFailure(request, reply);
    }
    request.log.error({ errorName }, "Private MCP request failed");
    return sendPrivateDependencyUnavailable(
      request,
      reply,
      "TEMPORARILY_UNAVAILABLE",
      "The private MCP API is temporarily unavailable.",
    );
  });

  return app;
}
