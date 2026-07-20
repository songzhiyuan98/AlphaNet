import { loadApiEnvironment, parseCorsOrigins } from "@alphanet/config";
import {
  closeDependencies,
  createPostgresDependency,
  createRedisDependency,
  type HealthDependency,
} from "@alphanet/database";
import { createLogger } from "@alphanet/observability";

import { createApiApp } from "./app.js";

async function start(): Promise<void> {
  const environment = loadApiEnvironment();
  const logger = createLogger({
    service: "api",
    environment: environment.NODE_ENV,
    level: environment.LOG_LEVEL,
  });
  const dependencies: HealthDependency[] = [
    createPostgresDependency(environment.DATABASE_URL),
    createRedisDependency(environment.REDIS_URL),
  ];
  let app: Awaited<ReturnType<typeof createApiApp>> | undefined;
  try {
    app = await createApiApp({
      allowedOrigins: parseCorsOrigins(environment.CORS_ORIGINS),
      dependencies,
      environment: environment.NODE_ENV,
      logger,
      version: environment.APP_VERSION,
    });

    let closing = false;
    const shutdown = async (signal: string) => {
      if (closing || !app) {
        return;
      }
      closing = true;
      logger.info({ signal }, "shutting down");
      await app.close();
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });

    await app.listen({
      host: environment.HOST,
      port: environment.PORT,
    });
  } catch (error) {
    if (app) {
      await app.close();
    } else {
      await closeDependencies(dependencies);
    }
    throw error;
  }
}

start().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "API failed to start"}\n`,
  );
  process.exitCode = 1;
});
