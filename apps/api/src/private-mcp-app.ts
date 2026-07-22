import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

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
  authorizeAuthenticatedAgentRequest,
  type AgentRequestRateLimiter,
  type AuthorizedAgentRequest,
} from "./agent-request.js";
import {
  createRemoteMcpActorAuthenticator,
  RemoteMcpActorAuthenticationError,
  type RemoteMcpActorAuthenticatorOptions,
} from "./mcp-actor-authenticator.js";
import { v1Error } from "./v1-error.js";

export const PRIVATE_MCP_API_PREFIX = "/internal/mcp/v1";
export const PRIVATE_MCP_AGENT_CONTEXT_PATH =
  `${PRIVATE_MCP_API_PREFIX}/agent/context` as const;

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
  logger?: FastifyBaseLogger | undefined;
  now?: (() => Date) | undefined;
  rateLimiter: AgentRequestRateLimiter;
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

function validTransportIdentity(
  identity: PrivateMcpTransportIdentity | null,
): identity is PrivateMcpTransportIdentity {
  return identity?.authentication === "mutual_tls" && identity.service === "mcp";
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

  app.get(
    PRIVATE_MCP_AGENT_CONTEXT_PATH,
    {
      preValidation: async (request, reply) => {
        if (!transportAuthenticated.has(request)) {
          return sendPrivateDependencyUnavailable(request, reply);
        }
        if (
          hasRawHeader(request, "authorization") ||
          hasRawHeader(request, "cookie") ||
          hasRequestBodySignal(request) ||
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
            operation: "get_agent_context",
            policyEnforcement: "domain",
            rateLimiter: options.rateLimiter,
            rateLimitSubjects: ["agent", "owner"],
          },
        );
        if (!authorization) {
          return reply;
        }
        authorizations.set(request, { ...authorization, requestId });
      },
    },
    (request) => {
      const authorization = authorizations.get(request);
      if (!authorization) {
        throw new Error("Private MCP request reached its handler without authorization");
      }
      const now = options.now?.() ?? new Date();
      return projectAgentContext(authorization.context, {
        availableOperations: ["get_agent_context"],
        now,
        requestId: authorization.requestId,
      });
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
    if (statusCode >= 400 && statusCode < 500) {
      request.log.warn(
        { errorName, statusCode },
        "Private MCP request rejected before authorization",
      );
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
