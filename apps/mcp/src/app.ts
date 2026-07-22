import { randomUUID } from "node:crypto";

import {
  AgentScopesSchema,
  createHealthResponse,
  type AgentScope,
} from "@alphanet/contracts";
import { closeDependencies, type HealthDependency } from "@alphanet/database";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { JSONRPCMessageSchema, type RequestId } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Logger } from "pino";

import { InvalidForwardedForError } from "./client-ip.js";
import {
  createMcpToolScopeMap,
  createProtocolServer,
  McpExecutionRegistry,
  parseMcpActorAuthorization,
  type McpActorAuthorization,
  type McpToolRegistration,
} from "./protocol.js";

export const MCP_MAX_REQUEST_BYTES = 1024 * 1024;
export const MCP_PROTECTION_TIMEOUT_MILLISECONDS = 2_000;

export interface McpAppOptions {
  actorRateLimiter?: McpActorRateLimiter;
  allowedHosts: string[];
  dependencies?: readonly HealthDependency[];
  host: string;
  logger: Logger;
  authorizationMiddleware?: RequestHandler;
  runtimeEnabled?: boolean;
  protectionTimeoutMilliseconds?: number;
  requestRateLimiter?: McpRequestRateLimiter;
  resolveClientIp?: (request: Request) => string;
  resource?: string;
  toolTimeoutMilliseconds?: number;
  tools?: readonly McpToolRegistration[];
  version: string;
}

export interface McpApp {
  app: ReturnType<typeof express>;
  beginShutdown(): void;
  close(): Promise<void>;
}

export type McpRateLimitDecision =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface McpRequestRateLimitContext {
  clientIp: string;
  requestId: string;
  signal: AbortSignal;
}

export interface McpActorRateLimitContext extends McpRequestRateLimitContext {
  clientId: string;
  credentialId: string;
  grantId: string;
  method: string;
  toolName?: string;
}

export type McpRequestRateLimiter = (
  context: McpRequestRateLimitContext,
) => Promise<McpRateLimitDecision> | McpRateLimitDecision;

export type McpActorRateLimiter = (
  context: McpActorRateLimitContext,
) => Promise<McpRateLimitDecision> | McpRateLimitDecision;

const dependencyTimeoutMilliseconds = 2_000;

async function checkWithTimeout(dependency: HealthDependency): Promise<void> {
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

interface TrustedMcpAuthorization {
  actor: McpActorAuthorization;
  auth: AuthInfo & { expiresAt: number; resource: URL };
  scopes: AgentScope[];
}

interface RequestWithMcpContext extends Request {
  auth?: AuthInfo;
  mcpAuthorization?: TrustedMcpAuthorization;
  mcpClientIp?: string;
  mcpRequestId?: string;
}

interface BodyParserError {
  status?: number;
  type?: string;
}

const queryCredentialNames = new Set(["access_token", "api_key", "token"]);
const mcpRateLimitMaximumRetrySeconds = 3_600;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

async function withProtectionDeadline<Result>(
  timeoutMilliseconds: number,
  operation: (signal: AbortSignal) => Promise<Result> | Result,
): Promise<Result> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("MCP protection deadline exceeded"));
          controller.abort();
        }, timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function sendJsonRpcError(
  response: Response,
  status: number,
  code: number,
  message: string,
  data?: Record<string, unknown>,
  id: RequestId | null = null,
): void {
  const requestId = (response.locals as { mcpRequestId?: unknown }).mcpRequestId;
  response.status(status).json({
    jsonrpc: "2.0",
    error: {
      code,
      message,
      ...(data || typeof requestId === "string"
        ? {
            data: {
              ...(data ?? {}),
              ...(typeof requestId === "string" ? { request_id: requestId } : {}),
            },
          }
        : {}),
    },
    id,
  });
}

function parseTrustedAuthorization(
  request: Request,
  expectedResource: URL | undefined,
): TrustedMcpAuthorization | null {
  const auth = (request as RequestWithMcpContext).auth;
  const parsedScopes = AgentScopesSchema.safeParse(auth?.scopes);
  const actor = parseMcpActorAuthorization(auth?.extra?.actor);
  if (
    !expectedResource ||
    !auth ||
    !actor ||
    typeof auth.token !== "string" ||
    auth.token.length === 0 ||
    typeof auth.clientId !== "string" ||
    auth.clientId.length === 0 ||
    !parsedScopes.success ||
    typeof auth.expiresAt !== "number" ||
    !Number.isFinite(auth.expiresAt) ||
    auth.expiresAt <= Date.now() / 1_000
  ) {
    return null;
  }

  if (
    !(auth.resource instanceof URL) ||
    auth.resource.toString() !== expectedResource.toString()
  ) {
    return null;
  }

  return {
    actor,
    auth: auth as AuthInfo & { expiresAt: number; resource: URL },
    scopes: parsedScopes.data,
  };
}

function isValidRateLimitDecision(value: unknown): value is McpRateLimitDecision {
  if (typeof value !== "object" || value === null || !("allowed" in value)) {
    return false;
  }
  if (value.allowed === true) {
    return true;
  }
  if (value.allowed !== false || !("retryAfterSeconds" in value)) {
    return false;
  }
  return (
    typeof value.retryAfterSeconds === "number" &&
    Number.isSafeInteger(value.retryAfterSeconds) &&
    value.retryAfterSeconds >= 1 &&
    value.retryAfterSeconds <= mcpRateLimitMaximumRetrySeconds
  );
}

function requestIdOf(request: Request): string {
  const requestId = (request as RequestWithMcpContext).mcpRequestId;
  if (!requestId) {
    throw new Error("MCP request id is unavailable");
  }
  return requestId;
}

function trustedAuthorizationOf(request: Request): TrustedMcpAuthorization {
  const authorization = (request as RequestWithMcpContext).mcpAuthorization;
  if (!authorization) {
    throw new Error("MCP authorization context is unavailable");
  }
  return authorization;
}

function clientIpOf(request: Request): string {
  const clientIp = (request as RequestWithMcpContext).mcpClientIp;
  if (!clientIp) {
    throw new Error("MCP client address is unavailable");
  }
  return clientIp;
}

function requestMessageId(body: unknown): RequestId | null {
  if (typeof body !== "object" || body === null || !("id" in body)) {
    return null;
  }
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function toolNameOf(body: unknown): string | undefined {
  if (
    typeof body !== "object" ||
    body === null ||
    !("method" in body) ||
    (body as { method?: unknown }).method !== "tools/call" ||
    !("params" in body)
  ) {
    return undefined;
  }
  const params = (body as { params?: unknown }).params;
  if (typeof params !== "object" || params === null || !("name" in params)) {
    return undefined;
  }
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function acceptsMediaType(header: string, expected: string): boolean {
  return header.split(",").some((part) => {
    const [mediaRange, ...parameters] = part.split(";").map((value) => value.trim());
    if (mediaRange?.toLowerCase() !== expected) {
      return false;
    }
    let quality = 1;
    let qualitySeen = false;
    for (const parameter of parameters) {
      const separator = parameter.indexOf("=");
      const name = (separator < 0 ? parameter : parameter.slice(0, separator))
        .trim()
        .toLowerCase();
      if (name !== "q") {
        continue;
      }
      if (qualitySeen || separator < 0) {
        return false;
      }
      qualitySeen = true;
      quality = Number(parameter.slice(separator + 1).trim());
      if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
        return false;
      }
    }
    return quality > 0;
  });
}

function acceptsMcpResponse(request: Request): boolean {
  const accept = request.get("accept");
  return (
    typeof accept === "string" &&
    acceptsMediaType(accept, "application/json") &&
    acceptsMediaType(accept, "text/event-stream")
  );
}

function normalizeIncomingHeader(request: Request, name: string, value: string): void {
  request.headers[name] = value;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      request.rawHeaders[index + 1] = value;
    }
  }
}

function containsQueryCredential(request: Request): boolean {
  const url = new URL(request.originalUrl, "http://alphanet.invalid");
  return [...url.searchParams.keys()].some((name) =>
    queryCredentialNames.has(name.toLowerCase()),
  );
}

function bodyParserErrorHandler(
  error: BodyParserError,
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (error.type === "entity.too.large" || error.status === 413) {
    sendJsonRpcError(response, 413, -32000, "Request body exceeds the MCP limit.", {
      maximum_body_bytes: MCP_MAX_REQUEST_BYTES,
    });
    return;
  }

  if (error.type === "entity.parse.failed" || error.status === 400) {
    sendJsonRpcError(response, 400, -32700, "Parse error: Invalid JSON");
    return;
  }

  if (error.type === "encoding.unsupported" || error.status === 415) {
    sendJsonRpcError(response, 415, -32000, "Unsupported content encoding.");
    return;
  }

  next(error);
}

export function createMcpApp(options: McpAppOptions): McpApp {
  const dependencies = options.dependencies ?? [];
  const expectedResource = options.resource ? new URL(options.resource) : undefined;
  const expectedOrigin = expectedResource?.origin;
  const resourceMetadataUrl = expectedResource
    ? getOAuthProtectedResourceMetadataUrl(expectedResource)
    : undefined;
  const toolRegistrations = options.tools ?? Object.freeze([]);
  const toolScopeMap = createMcpToolScopeMap(toolRegistrations);
  const executionRegistry = new McpExecutionRegistry();
  const protectionTimeoutMilliseconds =
    options.protectionTimeoutMilliseconds ?? MCP_PROTECTION_TIMEOUT_MILLISECONDS;
  if (
    !Number.isSafeInteger(protectionTimeoutMilliseconds) ||
    protectionTimeoutMilliseconds < 1 ||
    protectionTimeoutMilliseconds > MCP_PROTECTION_TIMEOUT_MILLISECONDS
  ) {
    throw new Error("MCP protection timeout must be between 1 and 2000 milliseconds");
  }
  const runtimeProtectionAvailable = Boolean(
    options.authorizationMiddleware &&
    options.requestRateLimiter &&
    options.actorRateLimiter &&
    options.resolveClientIp &&
    expectedResource,
  );
  let shuttingDown = false;
  const app = express();
  app.disable("x-powered-by");

  app.get("/health/live", (_request, response) => {
    response.json(createHealthResponse("mcp", options.version));
  });

  app.get("/health/ready", async (_request, response) => {
    const results = await Promise.allSettled(
      dependencies.map(async (dependency) => checkWithTimeout(dependency)),
    );
    const failedDependencies = results.flatMap((result, index) =>
      result.status === "rejected" ? [dependencies[index]?.name ?? "unknown"] : [],
    );
    const criticalDependencyFailed = results.some(
      (result, index) =>
        result.status === "rejected" && dependencies[index]?.critical !== false,
    );
    if (options.runtimeEnabled === true && !runtimeProtectionAvailable) {
      failedDependencies.push("mcp-runtime-protection");
    }
    if (shuttingDown) {
      failedDependencies.push("shutdown");
    }
    const payload = createHealthResponse("mcp", options.version, failedDependencies);
    response
      .status(
        criticalDependencyFailed ||
          shuttingDown ||
          (options.runtimeEnabled === true && !runtimeProtectionAvailable)
          ? 503
          : 200,
      )
      .json(payload);
  });

  app.use("/mcp", (request, response, next) => {
    const requestId = randomUUID();
    (request as RequestWithMcpContext).mcpRequestId = requestId;
    (response.locals as { mcpRequestId?: string }).mcpRequestId = requestId;
    response.set("x-request-id", requestId);
    response.set("cache-control", "no-store");
    next();
  });
  app.use("/mcp", (request, response, next) => {
    const host = request.headers.host;
    let hostname: string | undefined;
    try {
      if (typeof host !== "string" || host.length === 0 || host.length > 255) {
        throw new Error("invalid host");
      }
      const parsed = new URL(`http://${host}`);
      if (
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      ) {
        throw new Error("invalid host");
      }
      hostname = parsed.hostname;
    } catch {
      hostname = undefined;
    }
    if (!hostname || !options.allowedHosts.includes(hostname)) {
      options.logger.warn(
        { reason: "HOST_FORBIDDEN", requestId: requestIdOf(request) },
        "MCP request rejected",
      );
      sendJsonRpcError(response, 403, -32000, "Invalid Host header.", {
        code: "MCP_HOST_FORBIDDEN",
      });
      return;
    }
    next();
  });
  app.use("/mcp", (request, response, next) => {
    const origin = request.headers.origin;
    if (
      origin !== undefined &&
      (typeof origin !== "string" || origin !== expectedOrigin)
    ) {
      options.logger.warn(
        { reason: "ORIGIN_FORBIDDEN", requestId: requestIdOf(request) },
        "MCP request rejected",
      );
      sendJsonRpcError(response, 403, -32000, "Invalid Origin header.", {
        code: "MCP_ORIGIN_FORBIDDEN",
      });
      return;
    }
    next();
  });
  app.use("/mcp", (request, response, next) => {
    if (containsQueryCredential(request)) {
      sendJsonRpcError(
        response,
        400,
        -32600,
        "Credentials are not accepted in the request URL.",
        { code: "QUERY_CREDENTIAL_FORBIDDEN" },
      );
      return;
    }
    next();
  });
  app.use("/mcp", (_request, response, next) => {
    if (shuttingDown) {
      sendJsonRpcError(response, 503, -32000, "MCP service is shutting down.", {
        code: "MCP_SHUTTING_DOWN",
      });
      return;
    }
    if (options.runtimeEnabled !== true) {
      sendJsonRpcError(response, 503, -32000, "MCP runtime is disabled.", {
        code: "MCP_RUNTIME_DISABLED",
      });
      return;
    }

    if (!runtimeProtectionAvailable) {
      sendJsonRpcError(response, 503, -32000, "MCP request protection is unavailable.", {
        code: "MCP_PROTECTION_UNAVAILABLE",
      });
      return;
    }

    next();
  });

  app.use("/mcp", async (request, response, next) => {
    try {
      const clientIp = options.resolveClientIp?.(request);
      if (!clientIp || clientIp.length > 128) {
        throw new Error("invalid client address");
      }
      (request as RequestWithMcpContext).mcpClientIp = clientIp;
      const decision = await withProtectionDeadline(
        protectionTimeoutMilliseconds,
        (signal) =>
          options.requestRateLimiter?.({
            clientIp,
            requestId: requestIdOf(request),
            signal,
          }),
      );
      if (!isValidRateLimitDecision(decision)) {
        throw new Error("invalid request limiter decision");
      }
      if (!decision.allowed) {
        response.set("retry-after", String(decision.retryAfterSeconds));
        sendJsonRpcError(response, 429, -32000, "MCP request rate limit exceeded.", {
          code: "MCP_REQUEST_RATE_LIMITED",
          retry_after_seconds: decision.retryAfterSeconds,
        });
        return;
      }
      next();
    } catch (error) {
      if (error instanceof InvalidForwardedForError) {
        sendJsonRpcError(response, 400, -32600, "Invalid forwarding header.", {
          code: "MCP_INVALID_FORWARDED_FOR",
        });
        return;
      }
      options.logger.error(
        {
          errorName: errorName(error),
          requestId: requestIdOf(request),
          stage: "request-rate-limit",
        },
        "MCP request protection failed",
      );
      sendJsonRpcError(response, 503, -32000, "MCP request protection is unavailable.", {
        code: "MCP_PROTECTION_UNAVAILABLE",
      });
    }
  });

  if (options.authorizationMiddleware) {
    app.use("/mcp", options.authorizationMiddleware);
  }

  app.use("/mcp", (request, response, next) => {
    const authorization = parseTrustedAuthorization(request, expectedResource);
    if (!authorization) {
      if (resourceMetadataUrl) {
        response.set(
          "www-authenticate",
          `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`,
        );
      }
      sendJsonRpcError(response, 401, -32000, "A valid MCP access token is required.", {
        code: "MCP_INVALID_TOKEN",
      });
      return;
    }

    (request as RequestWithMcpContext).mcpAuthorization = authorization;
    next();
  });

  const methodNotAllowed = (_request: Request, response: Response) => {
    response.set("allow", "POST");
    sendJsonRpcError(response, 405, -32000, "Method not allowed.");
  };

  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.post(
    "/mcp",
    (request, response, next) => {
      if (!acceptsMcpResponse(request)) {
        sendJsonRpcError(
          response,
          406,
          -32000,
          "Accept must allow application/json and text/event-stream.",
          { code: "MCP_ACCEPT_UNSUPPORTED" },
        );
        return;
      }
      // SDK 1.29.0 performs a case-sensitive substring check. Normalize only
      // after our media-range parser has accepted the original header.
      normalizeIncomingHeader(request, "accept", "application/json, text/event-stream");
      next();
    },
    (request, response, next) => {
      if (!request.is("application/json")) {
        sendJsonRpcError(response, 415, -32000, "Content-Type must be application/json.");
        return;
      }
      normalizeIncomingHeader(request, "content-type", "application/json");
      next();
    },
    express.json({
      inflate: true,
      limit: MCP_MAX_REQUEST_BYTES,
      strict: false,
      type: "application/json",
    }),
    (request, response, next) => {
      if (Array.isArray(request.body)) {
        sendJsonRpcError(
          response,
          400,
          -32600,
          "JSON-RPC batch requests are not supported.",
        );
        return;
      }

      if (typeof request.body !== "object" || request.body === null) {
        sendJsonRpcError(response, 400, -32600, "Invalid JSON-RPC request.");
        return;
      }

      if (!JSONRPCMessageSchema.safeParse(request.body).success) {
        sendJsonRpcError(response, 400, -32600, "Invalid JSON-RPC request.");
        return;
      }

      next();
    },
    (request, response, next) => {
      const toolName = toolNameOf(request.body);
      const scopePolicy = toolName ? toolScopeMap.get(toolName) : undefined;
      if (
        scopePolicy?.kind === "any_of" &&
        !scopePolicy.requiredScopesAnyOf.some((scope) =>
          trustedAuthorizationOf(request).scopes.includes(scope),
        )
      ) {
        if (resourceMetadataUrl) {
          response.set(
            "www-authenticate",
            `Bearer error="insufficient_scope", error_description="The access token lacks a required scope.", scope="${scopePolicy.challengeScope}", resource_metadata="${resourceMetadataUrl}"`,
          );
        }
        sendJsonRpcError(
          response,
          403,
          -32000,
          "The access token lacks a scope required for this tool.",
          {
            code: "MCP_SCOPE_REQUIRED",
            required_scope_any_of: [...scopePolicy.requiredScopesAnyOf],
          },
          requestMessageId(request.body),
        );
        return;
      }
      next();
    },
    async (request, response, next) => {
      try {
        const authorization = trustedAuthorizationOf(request);
        const method = (request.body as { method?: unknown }).method;
        if (typeof method !== "string") {
          throw new Error("MCP method is unavailable");
        }
        const toolName = toolNameOf(request.body);
        const decision = await withProtectionDeadline(
          protectionTimeoutMilliseconds,
          (signal) =>
            options.actorRateLimiter?.({
              clientId: authorization.auth.clientId,
              clientIp: clientIpOf(request),
              credentialId: authorization.actor.credentialId,
              grantId: authorization.actor.grantId,
              method,
              requestId: requestIdOf(request),
              signal,
              ...(toolName ? { toolName } : {}),
            }),
        );
        if (!isValidRateLimitDecision(decision)) {
          throw new Error("invalid actor limiter decision");
        }
        if (!decision.allowed) {
          response.set("retry-after", String(decision.retryAfterSeconds));
          sendJsonRpcError(
            response,
            429,
            -32000,
            "MCP actor rate limit exceeded.",
            {
              code: "MCP_ACTOR_RATE_LIMITED",
              retry_after_seconds: decision.retryAfterSeconds,
            },
            requestMessageId(request.body),
          );
          return;
        }
        next();
      } catch (error) {
        options.logger.error(
          {
            errorName: errorName(error),
            requestId: requestIdOf(request),
            stage: "actor-rate-limit",
          },
          "MCP actor protection failed",
        );
        sendJsonRpcError(
          response,
          503,
          -32000,
          "MCP actor protection is unavailable.",
          { code: "MCP_PROTECTION_UNAVAILABLE" },
          requestMessageId(request.body),
        );
      }
    },
    async (request, response) => {
      const protocolServer = createProtocolServer({
        executionRegistry,
        logger: options.logger,
        requestId: requestIdOf(request),
        ...(options.toolTimeoutMilliseconds === undefined
          ? {}
          : { toolTimeoutMilliseconds: options.toolTimeoutMilliseconds }),
        tools: toolRegistrations,
        version: options.version,
      });
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        sessionIdGenerator: undefined,
      });
      try {
        await protocolServer.connect(transport);
        await transport.handleRequest(request, response, request.body);
      } catch (error) {
        options.logger.error(
          { errorName: errorName(error), requestId: requestIdOf(request) },
          "MCP request failed",
        );
        if (!response.headersSent) {
          sendJsonRpcError(
            response,
            500,
            -32603,
            "Internal server error",
            undefined,
            requestMessageId(request.body),
          );
        } else if (!response.destroyed) {
          response.destroy(error instanceof Error ? error : undefined);
        }
      } finally {
        try {
          await protocolServer.close();
        } catch (error) {
          options.logger.warn(
            { errorName: errorName(error), requestId: requestIdOf(request) },
            "failed to close MCP request transport",
          );
        }
      }
    },
  );

  app.all("/mcp", methodNotAllowed);

  app.use("/mcp", bodyParserErrorHandler);

  app.use(
    "/mcp",
    (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      void _next;
      options.logger.error({ errorName: errorName(error) }, "MCP HTTP request failed");
      if (response.headersSent) {
        if (!response.destroyed) {
          response.destroy(error instanceof Error ? error : undefined);
        }
      } else {
        sendJsonRpcError(response, 500, -32603, "Internal server error");
      }
    },
  );

  // ALB target health checks use the task IP in the Host header. Keep only the
  // health endpoints outside MCP's DNS-rebinding middleware; every protocol
  // route remains protected by the explicit allowed-host list.
  return {
    app,
    beginShutdown() {
      shuttingDown = true;
      executionRegistry.abortAll();
    },
    async close() {
      shuttingDown = true;
      executionRegistry.abortAll();
      await closeDependencies(dependencies);
    },
  };
}
