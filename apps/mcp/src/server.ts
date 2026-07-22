import { createServer } from "node:http";

import { loadMcpEnvironment, parseCommaSeparated } from "@alphanet/config";
import {
  closeDependencies,
  createRedisDependency,
  type HealthDependency,
} from "@alphanet/database";
import { createLogger } from "@alphanet/observability";

import { createMcpApp } from "./app.js";
import { createMcpClientIpResolver } from "./client-ip.js";
import { configureMcpHttpServer, shutdownMcpHttpServer } from "./lifecycle.js";
import { createMcpRuntimeAssembly } from "./runtime-assembly.js";

async function start(): Promise<void> {
  const environment = loadMcpEnvironment();
  const logger = createLogger({
    service: "mcp",
    environment: environment.NODE_ENV,
    level: environment.LOG_LEVEL,
  });
  const redis = createRedisDependency(environment.REDIS_URL, {
    critical: environment.MCP_RUNTIME_ENABLED,
  });
  const dependencies: HealthDependency[] = [redis];
  let mcp: ReturnType<typeof createMcpApp> | undefined;
  let httpServer: ReturnType<typeof createServer> | undefined;
  try {
    if (environment.MCP_RUNTIME_ENABLED) {
      // Connect before listening so the first authenticated request cannot
      // race the Redis-backed protection boundary during process warm-up.
      await redis.check();
    }
    const runtime = createMcpRuntimeAssembly(environment, redis.client);
    mcp = createMcpApp({
      ...runtime,
      allowedHosts: parseCommaSeparated(environment.MCP_ALLOWED_HOSTS),
      dependencies,
      host: environment.HOST,
      logger,
      resolveClientIp: createMcpClientIpResolver(environment.MCP_TRUSTED_PROXY_CIDRS),
      version: environment.APP_VERSION,
    });
    httpServer = createServer(mcp.app);
    configureMcpHttpServer(httpServer);

    await new Promise<void>((resolve, reject) => {
      httpServer?.once("error", reject);
      httpServer?.listen(environment.PORT, environment.HOST, () => {
        httpServer?.off("error", reject);
        resolve();
      });
    });

    logger.info(
      {
        host: environment.HOST,
        port: environment.PORT,
        publicExposureEnabled: environment.MCP_PUBLIC_ENABLED,
        runtimeEnabled: environment.MCP_RUNTIME_ENABLED,
      },
      "MCP service listening",
    );

    let closing = false;
    const shutdown = async (signal: string) => {
      if (closing || !httpServer || !mcp) {
        return;
      }
      closing = true;
      logger.info({ signal }, "shutting down");
      await shutdownMcpHttpServer(httpServer, mcp);
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT").catch((error: unknown) => {
        logger.error(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "shutdown failed",
        );
        httpServer?.closeAllConnections();
        process.exitCode = 1;
      });
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM").catch((error: unknown) => {
        logger.error(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "shutdown failed",
        );
        httpServer?.closeAllConnections();
        process.exitCode = 1;
      });
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
  void error;
  process.stderr.write("MCP service failed to start\n");
  process.exitCode = 1;
});
