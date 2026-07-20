import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import {
  createHealthResponse,
  type ApiError,
  type SystemStatusResponse,
} from "@alphanet/contracts";
import { closeDependencies, type HealthDependency } from "@alphanet/database";
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from "fastify";

export interface ApiAppOptions {
  allowedOrigins: string[];
  dependencies?: readonly HealthDependency[];
  environment: "development" | "test" | "production";
  logger?: FastifyBaseLogger;
  version: string;
}

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

export async function createApiApp(options: ApiAppOptions): Promise<FastifyInstance> {
  const dependencies = options.dependencies ?? [];
  const app = Fastify({
    logger: options.logger ? false : { level: "silent" },
    ...(options.logger ? { loggerInstance: options.logger } : {}),
    requestIdHeader: "x-request-id",
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });
  await app.register(cors, {
    credentials: true,
    origin: options.allowedOrigins,
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    void reply.header("x-request-id", request.id);
    done(null, payload);
  });

  app.addHook("onClose", async () => {
    await closeDependencies(dependencies);
  });

  app.get("/health/live", () => createHealthResponse("api", options.version));

  app.get("/health/ready", async (_request, reply) => {
    const results = await Promise.allSettled(
      dependencies.map(async (dependency) => checkWithTimeout(dependency)),
    );
    const failedDependencies = results.flatMap((result, index) => {
      if (result.status === "fulfilled") {
        return [];
      }
      return [dependencies[index]?.name ?? "unknown"];
    });
    const criticalDependencyFailed = results.some(
      (result, index) =>
        result.status === "rejected" && dependencies[index]?.critical !== false,
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

  app.setNotFoundHandler(async (request, reply) => {
    const response: ApiError = {
      error: {
        code: "route_not_found",
        message: "The requested route does not exist.",
        requestId: request.id,
      },
    };
    return reply.code(404).send(response);
  });

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, "request failed");
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
