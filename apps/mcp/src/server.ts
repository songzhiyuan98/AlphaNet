import { createServer } from "node:http";

import { loadMcpEnvironment, parseCommaSeparated } from "@alphanet/config";
import {
  closeDependencies,
  createPostgresDependency,
  createRedisDependency,
  type HealthDependency,
} from "@alphanet/database";
import { createLogger } from "@alphanet/observability";

import { createMcpApp } from "./app.js";

async function start(): Promise<void> {
  const environment = loadMcpEnvironment();
  const logger = createLogger({
    service: "mcp",
    environment: environment.NODE_ENV,
    level: environment.LOG_LEVEL,
  });
  const dependencies: HealthDependency[] = [
    createPostgresDependency(environment.DATABASE_URL),
    createRedisDependency(environment.REDIS_URL),
  ];
  let mcp: ReturnType<typeof createMcpApp> | undefined;
  let httpServer: ReturnType<typeof createServer> | undefined;
  try {
    mcp = createMcpApp({
      allowedHosts: parseCommaSeparated(environment.MCP_ALLOWED_HOSTS),
      dependencies,
      host: environment.HOST,
      logger,
      version: environment.APP_VERSION,
    });
    httpServer = createServer(mcp.app);

    await new Promise<void>((resolve, reject) => {
      httpServer?.once("error", reject);
      httpServer?.listen(environment.PORT, environment.HOST, () => {
        httpServer?.off("error", reject);
        resolve();
      });
    });

    logger.info(
      { host: environment.HOST, port: environment.PORT },
      "MCP service listening",
    );

    let closing = false;
    const shutdown = async (signal: string) => {
      if (closing || !httpServer || !mcp) {
        return;
      }
      closing = true;
      logger.info({ signal }, "shutting down");
      await new Promise<void>((resolve, reject) => {
        httpServer?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await mcp.close();
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  } catch (error) {
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => {
        httpServer?.close(() => resolve());
      });
    }
    if (mcp) {
      await mcp.close();
    } else {
      await closeDependencies(dependencies);
    }
    throw error;
  }
}

start().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "MCP service failed to start"}\n`,
  );
  process.exitCode = 1;
});
