import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import type {
  AlphaNetAuthRuntime,
  OwnerSession,
  RemoteMcpOAuthConsentService,
  RedisRateLimitStorage,
} from "@alphanet/auth";
import {
  createHealthResponse,
  type ApiError,
  type OwnerSessionResponse,
  type SystemStatusResponse,
} from "@alphanet/contracts";
import { closeDependencies, type HealthDependency } from "@alphanet/database";
import type {
  AgentConnectionService,
  CommunityDirectoryService,
  ContentModerationService,
  ContentReadService,
  ContentReportService,
  ContentSearchService,
  FollowService,
  NotificationService,
  OwnerSocialIdentityService,
  OwnerWebContextIssuer,
  OwnerWebResearchWriteService,
  OwnerPendingActionService,
  PendingActionStatusService,
  ReactionWriteService,
  ResearchWriteService,
  WebSocialAuthorityResolver,
} from "@alphanet/domain";
import Fastify, {
  type FastifyInstance,
  type FastifyBaseLogger,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from "fastify";

import { registerAgentConnectionRoutes, v1Error } from "./agent-routes.js";
import {
  registerCommunityRoutes,
  registerPublicCommunityRoutes,
} from "./community-routes.js";
import {
  registerAdminContentModerationRoutes,
  registerOwnerContentModerationRoutes,
} from "./content-moderation-routes.js";
import {
  registerContentReadRoutes,
  registerPublicContentReadRoutes,
} from "./content-read-routes.js";
import {
  registerContentSearchRoutes,
  registerPublicContentSearchRoutes,
} from "./content-search-routes.js";
import { registerOwnerActionRoutes } from "./owner-action-routes.js";
import { registerOwnerRemoteMcpOAuthConsentRoutes } from "./owner-oauth-consent-routes.js";
import { registerOwnerAgentPolicyRoutes } from "./owner-policy-routes.js";
import { registerOwnerReportRoutes } from "./owner-report-routes.js";
import { registerOwnerSocialRoutes } from "./owner-social-routes.js";
import { registerPendingActionRoutes } from "./pending-action-routes.js";
import { registerPublicPeopleRoutes } from "./public-people-routes.js";
import { registerReactionRoutes } from "./reaction-routes.js";
import { registerFollowRoutes } from "./follow-routes.js";
import {
  registerAgentNotificationRoutes,
  registerOwnerNotificationRoutes,
} from "./notification-routes.js";
import { registerResearchWriteRoutes } from "./research-write-routes.js";
import type { AdminRequestRuntime } from "./admin-request.js";
import { createRequestClientIpResolver, ssrClientIpHeaders } from "./ssr-client-ip.js";

export interface ApiAppOptions {
  allowedOrigins: string[];
  adminRequestRuntime?: AdminRequestRuntime;
  agentConnectionService?: AgentConnectionService;
  agentRateLimiter?: Pick<RedisRateLimitStorage, "consume">;
  authRuntime?: AlphaNetAuthRuntime;
  communityDirectoryService?: CommunityDirectoryService;
  contentModerationService?: ContentModerationService;
  contentReadService?: ContentReadService;
  contentReportService?: ContentReportService;
  contentSearchService?: ContentSearchService;
  followService?: FollowService;
  notificationService?: NotificationService;
  dependencies?: readonly HealthDependency[];
  environment: "development" | "test" | "production";
  internalSsrRequestSecret?: string;
  logger?: FastifyBaseLogger;
  ownerPendingActionService?: OwnerPendingActionService;
  ownerSocialIdentityService?: OwnerSocialIdentityService;
  ownerWebContextIssuer?: OwnerWebContextIssuer;
  ownerWebResearchWriteService?: OwnerWebResearchWriteService;
  ownerWebSocialAuthorityResolver?: Pick<WebSocialAuthorityResolver, "checkReady">;
  pendingActionStatusService?: PendingActionStatusService;
  reactionWriteService?: ReactionWriteService;
  remoteMcpOAuthConsent?: {
    resource: string;
    service: Pick<
      RemoteMcpOAuthConsentService,
      "loadConsentRequest" | "resolveContinuationHandle" | "selectAgentAndPrepareGrant"
    >;
  };
  researchWriteService?: ResearchWriteService;
  trustedProxyCidrs?: readonly string[];
  version: string;
}

const dependencyTimeoutMilliseconds = 2_000;
const remoteMcpActorContextHeader = "x-alphanet-mcp-actor-context";
const remoteMcpOAuthFormBodyMaxBytes = 16 * 1_024;
const remoteMcpOAuthExternalMetadataPath =
  "/.well-known/oauth-authorization-server/api/auth";
const remoteMcpOAuthIssuerMetadataPaths = new Set([
  remoteMcpOAuthExternalMetadataPath,
  "/api/auth/.well-known/oauth-authorization-server",
  "/api/auth/.well-known/openid-configuration",
]);
const remoteMcpOAuthGetPaths = new Set(["/api/auth/oauth2/authorize"]);
const remoteMcpOAuthPostPaths = new Set([
  "/api/auth/oauth2/consent",
  "/api/auth/oauth2/continue",
  "/api/auth/oauth2/delete-consent",
  "/api/auth/oauth2/revoke",
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/update-consent",
]);
const remoteMcpOAuthFormPaths = new Set([
  "/api/auth/oauth2/revoke",
  "/api/auth/oauth2/token",
]);
type ReadinessDependency = Pick<HealthDependency, "check" | "critical" | "name">;
const allowedAuthPostPaths = new Set([
  "/api/auth/request-password-reset",
  "/api/auth/reset-password",
  "/api/auth/send-verification-email",
  "/api/auth/sign-in/email",
  "/api/auth/sign-out",
  "/api/auth/sign-up/email",
]);
const allowedGoogleSocialBodyKeys = new Set([
  "callbackURL",
  "errorCallbackURL",
  "oauth_query",
  "provider",
]);
const alphanetRequestIdPattern = /^req[-_][A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
const staticApiKeyPattern = /^aln_v1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/;
const traceIdPattern = /^(?!0{32}$)[0-9a-f]{32}$/i;
const uuidRequestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isAllowedAuthRequest(
  method: string,
  pathname: string,
  googleEnabled: boolean,
  remoteMcpOAuthEnabled: boolean,
  remoteMcpOAuthJwksPath: string | undefined,
): boolean {
  if (method === "POST") {
    return (
      allowedAuthPostPaths.has(pathname) ||
      (googleEnabled && pathname === "/api/auth/sign-in/social") ||
      (remoteMcpOAuthEnabled && remoteMcpOAuthPostPaths.has(pathname))
    );
  }
  if (method !== "GET") {
    return false;
  }
  return (
    pathname === "/api/auth/verify-email" ||
    (googleEnabled && pathname === "/api/auth/callback/google") ||
    (remoteMcpOAuthEnabled &&
      (remoteMcpOAuthGetPaths.has(pathname) ||
        remoteMcpOAuthIssuerMetadataPaths.has(pathname) ||
        pathname === remoteMcpOAuthJwksPath))
  );
}

interface RemoteMcpOAuthTransportSnapshot {
  authorizationHeaders: readonly string[];
  continuationHeaders: readonly string[];
}

type AuthRuntimeWithRemoteMcpOAuth = AlphaNetAuthRuntime & {
  remoteMcpOAuthEnabled?: boolean;
  remoteMcpOAuthJwksPath?: string;
};

type AuthRuntimeHandler = (
  request: Request,
  transport: RemoteMcpOAuthTransportSnapshot,
) => Promise<Response>;

function configuredRemoteMcpOAuthJwksPath(
  authRuntime: AuthRuntimeWithRemoteMcpOAuth,
): string | undefined {
  const value = authRuntime.remoteMcpOAuthJwksPath;
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\")
  ) {
    return undefined;
  }
  return value;
}

function rawHeaderValues(request: FastifyRequest, headerName: string): string[] {
  const values: string[] = [];
  const normalizedHeaderName = headerName.toLowerCase();
  const rawHeaders = request.raw.rawHeaders;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name?.toLowerCase() === normalizedHeaderName && value !== undefined) {
      values.push(value);
    }
  }
  return values;
}

function stripPublicMcpActorContextHeader(request: FastifyRequest): void {
  for (const name of Object.keys(request.headers)) {
    if (name.toLowerCase() === remoteMcpActorContextHeader) {
      delete request.headers[name];
    }
  }

  const rawHeaders = request.raw.rawHeaders;
  for (let index = rawHeaders.length - 2; index >= 0; index -= 2) {
    if (rawHeaders[index]?.toLowerCase() === remoteMcpActorContextHeader) {
      rawHeaders.splice(index, 2);
    }
  }
}

function isConstrainedGoogleSocialRequest(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }
  const requestBody = body as Record<string, unknown>;
  return (
    requestBody.provider === "google" &&
    Object.keys(requestBody).every((key) => allowedGoogleSocialBodyKeys.has(key))
  );
}

function routeNotFound(request: FastifyRequest): ApiError {
  return {
    error: {
      code: "route_not_found",
      message: "The requested route does not exist.",
      requestId: request.id,
    },
  };
}

function safeRequestId(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate &&
    !staticApiKeyPattern.test(candidate) &&
    (uuidRequestIdPattern.test(candidate) ||
      traceIdPattern.test(candidate) ||
      alphanetRequestIdPattern.test(candidate))
    ? candidate
    : randomUUID();
}

function errorStatusCode(error: unknown): number {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode <= 599
  ) {
    return error.statusCode;
  }
  return 500;
}

function fastifyErrorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function usesAgentV1ErrorEnvelope(request: FastifyRequest): boolean {
  const pathname = new URL(request.url, "http://alphanet.invalid").pathname;
  return (
    pathname.startsWith("/v1/") &&
    pathname !== "/v1/owner/session" &&
    pathname !== "/v1/system/status"
  );
}

async function checkWithTimeout(dependency: ReadinessDependency): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      dependency.check(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${dependency.name} readiness probe timed out`));
        }, dependencyTimeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function enforceOwnerSessionRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ApiAppOptions,
  resolveClientIp: (request: FastifyRequest) => string,
): Promise<boolean> {
  if (!options.agentRateLimiter) {
    return true;
  }
  try {
    const result = await options.agentRateLimiter.consume(
      `ip:${resolveClientIp(request)}:owner-session`,
      {
        max: 240,
        window: 60,
      },
    );
    if (result.allowed) {
      return true;
    }
    void reply.header("retry-after", String(result.retryAfter ?? 60));
    void reply.code(429).send({
      error: {
        code: "rate_limited",
        message: "Too many Owner session requests were made in this time window.",
        requestId: request.id,
      },
    } satisfies ApiError);
    return false;
  } catch (error) {
    request.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Owner session rate limiter failed",
    );
    void reply.code(503).send({
      error: {
        code: "auth_unavailable",
        message: "Owner authentication is temporarily unavailable.",
        requestId: request.id,
      },
    } satisfies ApiError);
    return false;
  }
}

function toAuthHeaders(
  request: FastifyRequest,
  resolveClientIp: (request: FastifyRequest) => string,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    const normalizedName = name.toLowerCase();
    if (
      value === undefined ||
      normalizedName === remoteMcpActorContextHeader ||
      normalizedName === "x-alphanet-client-ip" ||
      Object.values(ssrClientIpHeaders).includes(
        normalizedName as (typeof ssrClientIpHeaders)[keyof typeof ssrClientIpHeaders],
      )
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
      continue;
    }
    headers.set(name, String(value));
  }

  // This header is private to the API/Auth boundary. Never trust the
  // caller-supplied value when Better Auth constructs its rate-limit key.
  headers.set("x-alphanet-client-ip", resolveClientIp(request));
  return headers;
}

function serializeOwnerSession(session: OwnerSession): OwnerSessionResponse {
  return {
    owner: session.owner,
    session: {
      expiresAt: session.session.expiresAt.toISOString(),
      id: session.session.id,
    },
  };
}

function sanitizeAuthResponseBody(
  pathname: string,
  response: Response,
  responseBody: string | null,
  allowedOrigins: ReadonlySet<string>,
): string | null {
  if (!response.ok) {
    return responseBody;
  }
  if (pathname === "/api/auth/sign-in/email") {
    if (responseBody !== null) {
      try {
        const candidate: unknown = JSON.parse(responseBody);
        if (
          typeof candidate === "object" &&
          candidate !== null &&
          !Array.isArray(candidate) &&
          (candidate as Record<string, unknown>)["redirect"] === true &&
          typeof (candidate as Record<string, unknown>)["url"] === "string"
        ) {
          const url = new URL((candidate as Record<string, unknown>)["url"] as string);
          if (
            url.username === "" &&
            url.password === "" &&
            url.hash === "" &&
            allowedOrigins.has(url.origin) &&
            url.pathname === "/oauth/consent" &&
            url.searchParams.getAll("sig").length === 1
          ) {
            return JSON.stringify({ redirect: true, url: url.toString() });
          }
        }
      } catch {
        // Ordinary sign-in responses and malformed OAuth recovery responses are
        // reduced to the same secret-free success shape.
      }
    }
    return JSON.stringify({ status: true });
  }
  if (pathname === "/api/auth/sign-up/email") {
    return JSON.stringify({ status: true });
  }
  return responseBody;
}

export async function createApiApp(options: ApiAppOptions): Promise<FastifyInstance> {
  if (
    options.environment === "production" &&
    (options.authRuntime ||
      options.agentConnectionService ||
      options.communityDirectoryService ||
      options.contentModerationService ||
      options.contentReadService ||
      options.contentReportService ||
      options.contentSearchService ||
      options.followService ||
      options.notificationService ||
      options.ownerPendingActionService ||
      options.ownerSocialIdentityService ||
      options.ownerWebResearchWriteService ||
      options.ownerWebSocialAuthorityResolver ||
      options.pendingActionStatusService ||
      options.reactionWriteService ||
      options.remoteMcpOAuthConsent ||
      options.researchWriteService) &&
    !options.agentRateLimiter
  ) {
    throw new Error(
      "A Redis-backed API rate limiter is required for protected API routes in production.",
    );
  }
  const dependencies = options.dependencies ?? [];
  const authRuntime = options.authRuntime;
  const publicRemoteMcpOAuthJwksPath =
    authRuntime &&
    (authRuntime as AuthRuntimeWithRemoteMcpOAuth).remoteMcpOAuthEnabled === true
      ? configuredRemoteMcpOAuthJwksPath(authRuntime as AuthRuntimeWithRemoteMcpOAuth)
      : undefined;
  const readinessDependencies: ReadinessDependency[] = [
    ...dependencies,
    ...(authRuntime
      ? [
          {
            critical: true,
            name: "auth-schema",
            check: () => authRuntime.checkReady(),
          },
        ]
      : []),
    ...(options.agentConnectionService
      ? [
          {
            critical: true,
            name: "agent-schema",
            check: () => options.agentConnectionService!.checkReady(),
          },
        ]
      : []),
    ...(options.communityDirectoryService
      ? [
          {
            critical: true,
            name: "community-directory-schema",
            check: () => options.communityDirectoryService!.checkReady(),
          },
        ]
      : []),
    ...(options.contentReadService
      ? [
          {
            critical: true,
            name: "content-read-schema",
            check: () => options.contentReadService!.checkReady(),
          },
        ]
      : []),
    ...(options.contentModerationService
      ? [
          {
            critical: true,
            name: "content-moderation-schema",
            check: () => options.contentModerationService!.checkReady(),
          },
        ]
      : []),
    ...(options.contentReportService
      ? [
          {
            critical: true,
            name: "content-report-schema",
            check: () => options.contentReportService!.checkReady(),
          },
        ]
      : []),
    ...(options.contentSearchService
      ? [
          {
            critical: true,
            name: "content-search-schema",
            check: () => options.contentSearchService!.checkReady(),
          },
        ]
      : []),
    ...(options.followService
      ? [
          {
            critical: true,
            name: "follow-schema",
            check: () => options.followService!.checkReady(),
          },
        ]
      : []),
    ...(options.notificationService
      ? [
          {
            critical: true,
            name: "notification-schema",
            check: () => options.notificationService!.checkReady(),
          },
        ]
      : []),
    ...(options.ownerPendingActionService
      ? [
          {
            critical: true,
            name: "owner-pending-action-schema",
            check: () => options.ownerPendingActionService!.checkReady(),
          },
        ]
      : []),
    ...(options.ownerSocialIdentityService
      ? [
          {
            critical: true,
            name: "owner-social-identity-schema",
            check: () => options.ownerSocialIdentityService!.checkReady(),
          },
        ]
      : []),
    ...(options.ownerWebSocialAuthorityResolver
      ? [
          {
            critical: true,
            name: "owner-web-social-authority-schema",
            check: () => options.ownerWebSocialAuthorityResolver!.checkReady(),
          },
        ]
      : []),
    ...(options.pendingActionStatusService
      ? [
          {
            critical: true,
            name: "pending-action-schema",
            check: () => options.pendingActionStatusService!.checkReady(),
          },
        ]
      : []),
    ...(options.researchWriteService
      ? [
          {
            critical: true,
            name: "research-write-schema",
            check: () => options.researchWriteService!.checkReady(),
          },
        ]
      : []),
    ...(options.reactionWriteService
      ? [
          {
            critical: true,
            name: "reaction-write-schema",
            check: () => options.reactionWriteService!.checkReady(),
          },
        ]
      : []),
  ];
  const resolveClientIp = createRequestClientIpResolver({
    ...(options.internalSsrRequestSecret
      ? { internalSsrRequestSecret: options.internalSsrRequestSecret }
      : {}),
    ...(options.trustedProxyCidrs
      ? { trustedProxyCidrs: options.trustedProxyCidrs }
      : {}),
  });
  const app = Fastify({
    genReqId: (request) => safeRequestId(request.headers["x-request-id"]),
    logController: new LogController({
      // Auth links contain one-time secrets in the path or query string. AlphaNet
      // emits its own route-template completion log below and never logs raw URLs.
      disableRequestLogging: true,
    }),
    logger: options.logger ? false : { level: "silent" },
    ...(options.logger ? { loggerInstance: options.logger } : {}),
    requestIdHeader: false,
    trustProxy:
      options.trustedProxyCidrs && options.trustedProxyCidrs.length > 0
        ? [...options.trustedProxyCidrs]
        : false,
  });
  // ARCH-0015 reserves this header for the separate private mTLS listener.
  // The public listener strips it itself instead of trusting edge sanitization.
  app.addHook("onRequest", (request, _reply, done) => {
    stripPublicMcpActorContextHeader(request);
    done();
  });
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { bodyLimit: remoteMcpOAuthFormBodyMaxBytes, parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });
  await app.register(cors, {
    credentials: true,
    maxAge: 86_400,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    origin: options.allowedOrigins,
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    void reply.header("x-request-id", request.id);
    const routeUrl = request.routeOptions.url ?? "";
    const requestPathname = new URL(request.url, "http://alphanet.invalid").pathname;
    const isPublicRemoteMcpOAuthJwks =
      request.method === "GET" && requestPathname === publicRemoteMcpOAuthJwksPath;
    if (
      !isPublicRemoteMcpOAuthJwks &&
      (routeUrl === "/api/auth/*" ||
        routeUrl === "/v1/owner/session" ||
        routeUrl.startsWith("/v1/owner/") ||
        routeUrl.startsWith("/v1/admin/") ||
        routeUrl === "/v1/agent/context")
    ) {
      void reply.header("cache-control", "no-store, private");
      void reply.header("pragma", "no-cache");
    }
    done(null, payload);
  });

  app.addHook("onResponse", (request, reply, done) => {
    request.log.info(
      {
        method: request.method,
        responseTimeMilliseconds: reply.elapsedTime,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
      },
      "request completed",
    );
    done();
  });

  app.addHook("onClose", async () => {
    try {
      if (authRuntime) {
        await authRuntime.close();
      }
    } finally {
      await closeDependencies(dependencies);
    }
  });

  app.get("/health/live", () => createHealthResponse("api", options.version));

  app.get("/health/ready", async (_request, reply) => {
    const results = await Promise.allSettled(
      readinessDependencies.map(async (dependency) => checkWithTimeout(dependency)),
    );
    const failedDependencies = results.flatMap((result, index) => {
      if (result.status === "fulfilled") {
        return [];
      }
      return [readinessDependencies[index]?.name ?? "unknown"];
    });
    const criticalDependencyFailed = results.some(
      (result, index) =>
        result.status === "rejected" && readinessDependencies[index]?.critical !== false,
    );
    const response = createHealthResponse("api", options.version, failedDependencies);

    if (criticalDependencyFailed) {
      return reply.code(503).send(response);
    }
    return response;
  });

  app.get("/v1/system/status", (request): SystemStatusResponse => {
    return {
      name: "AlphaNet",
      service: "api",
      version: options.version,
      environment: options.environment,
      uptimeSeconds: process.uptime(),
      requestId: request.id,
    };
  });

  if (authRuntime) {
    const remoteMcpOAuthRuntime = authRuntime as AuthRuntimeWithRemoteMcpOAuth;
    const remoteMcpOAuthEnabled = remoteMcpOAuthRuntime.remoteMcpOAuthEnabled === true;
    const remoteMcpOAuthJwksPath =
      configuredRemoteMcpOAuthJwksPath(remoteMcpOAuthRuntime);
    const allowedAuthRedirectOrigins = new Set(options.allowedOrigins);
    const handleAuthRuntime = authRuntime.handle as AuthRuntimeHandler;
    const handleAuthRequest = async (request: FastifyRequest, reply: FastifyReply) => {
      const url = new URL(request.url, authRuntime.baseUrl);
      if (
        !isAllowedAuthRequest(
          request.method,
          url.pathname,
          authRuntime.googleEnabled,
          remoteMcpOAuthEnabled,
          remoteMcpOAuthJwksPath,
        )
      ) {
        return reply.code(404).send(routeNotFound(request));
      }
      if (
        url.pathname === "/api/auth/sign-in/social" &&
        !isConstrainedGoogleSocialRequest(request.body)
      ) {
        const payload: ApiError = {
          error: {
            code: "invalid_auth_request",
            message: "The social sign-in request is not allowed.",
            requestId: request.id,
          },
        };
        return reply.code(400).send(payload);
      }
      if (url.pathname === "/api/auth/reset-password" && url.search.length > 0) {
        const payload: ApiError = {
          error: {
            code: "invalid_auth_request",
            message: "Password reset tokens are accepted only in the request body.",
            requestId: request.id,
          },
        };
        return reply.code(400).send(payload);
      }
      const headers = toAuthHeaders(request, resolveClientIp);
      const body =
        request.method === "GET" || request.body === undefined
          ? undefined
          : Buffer.isBuffer(request.body) && remoteMcpOAuthFormPaths.has(url.pathname)
            ? Uint8Array.from(request.body)
            : JSON.stringify(request.body);

      let response: Response;
      try {
        response = await handleAuthRuntime(
          new Request(url, {
            ...(body === undefined ? {} : { body }),
            headers,
            method: request.method,
          }),
          {
            authorizationHeaders: rawHeaderValues(request, "authorization"),
            continuationHeaders: rawHeaderValues(
              request,
              "x-alphanet-oauth-continuation",
            ),
          },
        );
      } catch (error) {
        request.log.error(
          {
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "authentication handler failed",
        );
        const payload: ApiError = {
          error: {
            code: "auth_unavailable",
            message: "Authentication is temporarily unavailable.",
            requestId: request.id,
          },
        };
        return reply.code(503).send(payload);
      }

      reply.code(response.status);
      response.headers.forEach((value, name) => {
        const normalizedName = name.toLowerCase();
        if (normalizedName !== "set-cookie" && normalizedName !== "content-length") {
          void reply.header(name, value);
        }
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) {
        void reply.header("set-cookie", cookies);
      }

      const responseBody = response.body ? await response.text() : null;
      if (responseBody === null) return reply.send();
      return reply.send(
        sanitizeAuthResponseBody(
          url.pathname,
          response,
          responseBody,
          allowedAuthRedirectOrigins,
        ),
      );
    };

    app.route({
      method: ["GET", "POST"],
      url: "/api/auth/*",
      handler: handleAuthRequest,
    });
    app.get(remoteMcpOAuthExternalMetadataPath, handleAuthRequest);
    if (
      remoteMcpOAuthJwksPath &&
      !remoteMcpOAuthJwksPath.startsWith("/api/auth/") &&
      remoteMcpOAuthJwksPath !== remoteMcpOAuthExternalMetadataPath
    ) {
      app.get(remoteMcpOAuthJwksPath, handleAuthRequest);
    }

    app.get("/v1/owner/session", async (request, reply) => {
      if (
        !(await enforceOwnerSessionRateLimit(request, reply, options, resolveClientIp))
      ) {
        return reply;
      }
      let session: OwnerSession | null;
      try {
        session = await authRuntime.getOwnerSession(
          toAuthHeaders(request, resolveClientIp),
        );
      } catch (error) {
        request.log.error(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Owner session lookup failed",
        );
        const response: ApiError = {
          error: {
            code: "auth_unavailable",
            message: "Owner authentication is temporarily unavailable.",
            requestId: request.id,
          },
        };
        return reply.code(503).send(response);
      }
      if (!session) {
        const response: ApiError = {
          error: {
            code: "unauthorized",
            message: "A valid Owner session is required.",
            requestId: request.id,
          },
        };
        return reply.code(401).send(response);
      }

      return serializeOwnerSession(session);
    });

    if (options.agentConnectionService) {
      registerAgentConnectionRoutes(app, {
        allowedOrigins: options.allowedOrigins,
        availableOperations: [
          "get_agent_context",
          ...(options.communityDirectoryService
            ? (["find_communities", "get_community"] as const)
            : []),
          ...(options.contentReadService
            ? (["browse_content", "get_content", "get_discussion"] as const)
            : []),
          ...(options.contentSearchService ? (["search_content"] as const) : []),
          ...(options.pendingActionStatusService ? (["get_action_status"] as const) : []),
          ...(options.researchWriteService
            ? ([
                "create_post",
                "reply_to_content",
                "update_content",
                "delete_content",
              ] as const)
            : []),
          ...(options.reactionWriteService ? (["set_reaction"] as const) : []),
          ...(options.followService ? (["set_follow", "list_follows"] as const) : []),
          ...(options.notificationService ? (["list_notifications"] as const) : []),
        ],
        authRuntime,
        ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
        resolveClientIp,
        service: options.agentConnectionService,
      });
      registerOwnerAgentPolicyRoutes(app, {
        allowedOrigins: options.allowedOrigins,
        authRuntime,
        ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
        resolveClientIp,
        service: options.agentConnectionService,
      });
    }

    if (options.ownerPendingActionService) {
      registerOwnerActionRoutes(app, {
        allowedOrigins: options.allowedOrigins,
        authRuntime,
        ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
        resolveClientIp,
        service: options.ownerPendingActionService,
      });
    }

    if (
      options.ownerSocialIdentityService &&
      options.ownerWebContextIssuer &&
      options.ownerWebResearchWriteService
    ) {
      registerOwnerSocialRoutes(app, {
        allowedOrigins: options.allowedOrigins,
        authRuntime,
        contextIssuer: options.ownerWebContextIssuer,
        identityService: options.ownerSocialIdentityService,
        ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
        researchWriteService: options.ownerWebResearchWriteService,
        resolveClientIp,
      });
    }

    if (options.contentReportService) {
      registerOwnerReportRoutes(app, {
        allowedOrigins: options.allowedOrigins,
        authRuntime,
        ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
        resolveClientIp,
        service: options.contentReportService,
      });
    }

    if (options.contentModerationService) {
      registerOwnerContentModerationRoutes(app, {
        allowedOrigins: options.allowedOrigins,
        authRuntime,
        ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
        resolveClientIp,
        service: options.contentModerationService,
      });
    }

    if (options.notificationService) {
      registerOwnerNotificationRoutes(app, {
        allowedOrigins: options.allowedOrigins,
        authRuntime,
        ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
        resolveClientIp,
        service: options.notificationService,
      });
    }

    if (options.remoteMcpOAuthConsent) {
      registerOwnerRemoteMcpOAuthConsentRoutes(app, {
        allowedOrigins: options.allowedOrigins,
        authRuntime,
        ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
        resolveClientIp,
        resource: options.remoteMcpOAuthConsent.resource,
        service: options.remoteMcpOAuthConsent.service,
      });
    }
  }

  if (options.adminRequestRuntime && options.contentModerationService) {
    registerAdminContentModerationRoutes(app, {
      adminRuntime: options.adminRequestRuntime,
      service: options.contentModerationService,
    });
  }

  if (options.communityDirectoryService) {
    registerPublicCommunityRoutes(app, {
      ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
      resolveClientIp,
      service: options.communityDirectoryService,
    });
  }

  if (options.ownerSocialIdentityService) {
    registerPublicPeopleRoutes(app, {
      ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
      resolveClientIp,
      service: options.ownerSocialIdentityService,
    });
  }

  if (options.agentConnectionService && options.communityDirectoryService) {
    registerCommunityRoutes(app, {
      agentConnectionService: options.agentConnectionService,
      ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
      resolveClientIp,
      service: options.communityDirectoryService,
    });
  }

  if (options.contentReadService) {
    registerPublicContentReadRoutes(app, {
      ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
      resolveClientIp,
      service: options.contentReadService,
    });
  }

  if (options.contentSearchService) {
    registerPublicContentSearchRoutes(app, {
      ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
      resolveClientIp,
      service: options.contentSearchService,
    });
  }

  if (options.agentConnectionService && options.contentReadService) {
    registerContentReadRoutes(app, {
      agentConnectionService: options.agentConnectionService,
      ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
      resolveClientIp,
      service: options.contentReadService,
    });
  }
  if (options.agentConnectionService && options.contentSearchService) {
    registerContentSearchRoutes(app, {
      agentConnectionService: options.agentConnectionService,
      ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
      resolveClientIp,
      service: options.contentSearchService,
    });
  }

  if (options.agentConnectionService && options.pendingActionStatusService) {
    registerPendingActionRoutes(app, {
      agentConnectionService: options.agentConnectionService,
      ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
      resolveClientIp,
      service: options.pendingActionStatusService,
    });
  }

  if (options.agentConnectionService && options.researchWriteService) {
    registerResearchWriteRoutes(app, {
      agentConnectionService: options.agentConnectionService,
      ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
      resolveClientIp,
      service: options.researchWriteService,
    });
  }

  if (options.agentConnectionService && options.reactionWriteService) {
    registerReactionRoutes(app, {
      agentConnectionService: options.agentConnectionService,
      ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
      resolveClientIp,
      service: options.reactionWriteService,
    });
  }

  if (options.agentConnectionService && options.followService) {
    registerFollowRoutes(app, {
      agentConnectionService: options.agentConnectionService,
      ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
      resolveClientIp,
      service: options.followService,
    });
  }

  if (options.agentConnectionService && options.notificationService) {
    registerAgentNotificationRoutes(app, {
      agentConnectionService: options.agentConnectionService,
      ...(options.agentRateLimiter ? { rateLimiter: options.agentRateLimiter } : {}),
      resolveClientIp,
      service: options.notificationService,
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (usesAgentV1ErrorEnvelope(request)) {
      return reply.code(404).send(
        v1Error(request, {
          code: "ROUTE_NOT_FOUND",
          message: "The requested API route does not exist.",
        }),
      );
    }
    return reply.code(404).send(routeNotFound(request));
  });

  app.setErrorHandler(async (error, request, reply) => {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const statusCode = errorStatusCode(error);
    const code = fastifyErrorCode(error);
    if (statusCode < 500) {
      request.log.warn({ errorName, statusCode }, "request rejected");
      if (usesAgentV1ErrorEnvelope(request)) {
        const payloadTooLarge =
          statusCode === 413 || code === "FST_ERR_CTP_BODY_TOO_LARGE";
        const unsupportedMediaType = statusCode === 415;
        const malformedJson = code === "FST_ERR_CTP_INVALID_JSON_BODY";
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
                : malformedJson
                  ? "The request body is not valid JSON."
                  : "The request could not be parsed.",
          }),
        );
      }
      const response: ApiError = {
        error: {
          code: statusCode === 413 ? "payload_too_large" : "invalid_request",
          message:
            statusCode === 413
              ? "The request body exceeds the maximum allowed size."
              : "The request could not be parsed.",
          requestId: request.id,
        },
      };
      return reply.code(statusCode).send(response);
    }
    request.log.error(
      {
        errorName,
        statusCode,
      },
      "request failed",
    );
    if (usesAgentV1ErrorEnvelope(request)) {
      return reply.code(500).send(
        v1Error(request, {
          code: "INTERNAL_ERROR",
          message: "The request could not be completed.",
          retryable: true,
        }),
      );
    }
    const response: ApiError = {
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
        requestId: request.id,
      },
    };
    return reply.code(500).send(response);
  });

  return app;
}
