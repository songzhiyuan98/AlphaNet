import { createHealthResponse } from "@alphanet/contracts";
import { closeDependencies, type HealthDependency } from "@alphanet/database";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { Request, Response } from "express";
import type { Logger } from "pino";

export interface McpAppOptions {
  allowedHosts: string[];
  dependencies?: readonly HealthDependency[];
  host: string;
  logger: Logger;
  version: string;
}

export interface McpApp {
  app: ReturnType<typeof createMcpExpressApp>;
  close(): Promise<void>;
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

function createProtocolServer(version: string): McpServer {
  const server = new McpServer({
    name: "alphanet",
    version,
  });

  server.registerTool(
    "get_platform_status",
    {
      title: "Get AlphaNet platform status",
      description:
        "Returns the current AlphaNet MCP service version. This operational tool does not access community data.",
      inputSchema: {},
      annotations: {
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            name: "AlphaNet",
            service: "mcp",
            status: "ok",
            version,
          }),
        },
      ],
    }),
  );

  return server;
}

export function createMcpApp(options: McpAppOptions): McpApp {
  const dependencies = options.dependencies ?? [];
  const app = express();
  const protocolApp = createMcpExpressApp({
    host: options.host,
    allowedHosts: options.allowedHosts,
  });
  app.disable("x-powered-by");
  protocolApp.disable("x-powered-by");

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
    const payload = createHealthResponse("mcp", options.version, failedDependencies);
    response.status(criticalDependencyFailed ? 503 : 200).json(payload);
  });

  protocolApp.post("/mcp", async (request, response) => {
    const protocolServer = createProtocolServer(options.version);
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    let closed = false;

    const closeProtocol = async () => {
      if (closed) {
        return;
      }
      closed = true;
      await protocolServer.close();
    };

    response.on("close", () => {
      void closeProtocol().catch((error: unknown) => {
        options.logger.warn({ err: error }, "failed to close MCP request transport");
      });
    });

    try {
      await protocolServer.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      options.logger.error({ err: error }, "MCP request failed");
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
      await closeProtocol();
    }
  });

  const methodNotAllowed = (_request: Request, response: Response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    });
  };

  protocolApp.get("/mcp", methodNotAllowed);
  protocolApp.delete("/mcp", methodNotAllowed);

  // ALB target health checks use the task IP in the Host header. Keep only the
  // health endpoints outside MCP's DNS-rebinding middleware; every protocol
  // route remains protected by the explicit allowed-host list.
  app.use(protocolApp);

  return {
    app,
    async close() {
      await closeDependencies(dependencies);
    },
  };
}
