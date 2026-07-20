import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import type { AlphaNetAuthRuntime, OwnerSession } from "@alphanet/auth";
import {
  createHealthResponse,
  type ApiError,
  type OwnerSessionResponse,
  type SystemStatusResponse,
} from "@alphanet/contracts";
import { closeDependencies, type HealthDependency } from "@alphanet/database";
import Fastify, {
  type FastifyInstance,
  type FastifyBaseLogger,
  type FastifyRequest,
  LogController,
} from "fastify";

export interface ApiAppOptions {
  allowedOrigins: string[];
  authRuntime?: AlphaNetAuthRuntime;
  dependencies?: readonly HealthDependency[];
  environment: "development" | "test" | "production";
  logger?: FastifyBaseLogger;
  trustedProxyCidrs?: readonly string[];
  version: string;
}

const dependencyTimeoutMilliseconds = 2_000;
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
  "provider",
]);

function isAllowedAuthRequest(
  method: string,
  pathname: string,
  googleEnabled: boolean,
): boolean {
  if (method === "POST") {
    return (
      allowedAuthPostPaths.has(pathname) ||
      (googleEnabled && pathname === "/api/auth/sign-in/social")
    );
  }
  if (method !== "GET") {
    return false;
  }
  return (
    pathname === "/api/auth/verify-email" ||
    (googleEnabled && pathname === "/api/auth/callback/google")
  );
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

function toAuthHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || name.toLowerCase() === "x-alphanet-client-ip") {
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
  headers.set("x-alphanet-client-ip", request.ip);
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
): string | null {
  if (
    response.ok &&
    (pathname === "/api/auth/sign-in/email" || pathname === "/api/auth/sign-up/email")
  ) {
    return JSON.stringify({ status: true });
  }
  return responseBody;
}

export async function createApiApp(options: ApiAppOptions): Promise<FastifyInstance> {
  const dependencies = options.dependencies ?? [];
  const authRuntime = options.authRuntime;
  const readinessDependencies = authRuntime
    ? [
        ...dependencies,
        {
          critical: true,
          name: "auth-schema",
          check: () => authRuntime.checkReady(),
        },
      ]
    : dependencies;
  const app = Fastify({
    logController: new LogController({
      // Auth links contain one-time secrets in the path or query string. AlphaNet
      // emits its own route-template completion log below and never logs raw URLs.
      disableRequestLogging: true,
    }),
    logger: options.logger ? false : { level: "silent" },
    ...(options.logger ? { loggerInstance: options.logger } : {}),
    requestIdHeader: "x-request-id",
    trustProxy:
      options.trustedProxyCidrs && options.trustedProxyCidrs.length > 0
        ? [...options.trustedProxyCidrs]
        : false,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });
  await app.register(cors, {
    credentials: true,
    maxAge: 86_400,
    methods: ["GET", "POST", "OPTIONS"],
    origin: options.allowedOrigins,
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    void reply.header("x-request-id", request.id);
    if (
      request.routeOptions.url === "/api/auth/*" ||
      request.routeOptions.url === "/v1/owner/session"
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
    app.route({
      method: ["GET", "POST"],
      url: "/api/auth/*",
      async handler(request, reply) {
        const url = new URL(request.url, authRuntime.baseUrl);
        if (
          !isAllowedAuthRequest(request.method, url.pathname, authRuntime.googleEnabled)
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
        const headers = toAuthHeaders(request);
        const body =
          request.method === "GET" || request.body === undefined
            ? undefined
            : JSON.stringify(request.body);

        let response: Response;
        try {
          response = await authRuntime.handle(
            new Request(url, {
              ...(body === undefined ? {} : { body }),
              headers,
              method: request.method,
            }),
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
        return reply.send(sanitizeAuthResponseBody(url.pathname, response, responseBody));
      },
    });

    app.get("/v1/owner/session", async (request, reply) => {
      const session = await authRuntime.getOwnerSession(toAuthHeaders(request));
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
  }

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send(routeNotFound(request));
  });

  app.setErrorHandler(async (error, request, reply) => {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    request.log.error(
      {
        errorName,
        statusCode,
      },
      "request failed",
    );
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
