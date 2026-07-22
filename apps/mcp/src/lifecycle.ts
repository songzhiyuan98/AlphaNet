import type { Server } from "node:http";

export const MCP_HTTP_HEADERS_TIMEOUT_MILLISECONDS = 10_000;
export const MCP_HTTP_REQUEST_TIMEOUT_MILLISECONDS = 15_000;
export const MCP_HTTP_KEEP_ALIVE_TIMEOUT_MILLISECONDS = 5_000;
export const MCP_HTTP_SOCKET_TIMEOUT_MILLISECONDS = 35_000;
export const MCP_HTTP_MAX_REQUESTS_PER_SOCKET = 100;
export const MCP_SHUTDOWN_GRACE_MILLISECONDS = 5_000;

export interface McpLifecycleTarget {
  beginShutdown(): void;
  close(): Promise<void>;
}

export function configureMcpHttpServer(server: Server): void {
  server.headersTimeout = MCP_HTTP_HEADERS_TIMEOUT_MILLISECONDS;
  server.requestTimeout = MCP_HTTP_REQUEST_TIMEOUT_MILLISECONDS;
  server.keepAliveTimeout = MCP_HTTP_KEEP_ALIVE_TIMEOUT_MILLISECONDS;
  server.maxRequestsPerSocket = MCP_HTTP_MAX_REQUESTS_PER_SOCKET;
  server.setTimeout(MCP_HTTP_SOCKET_TIMEOUT_MILLISECONDS);
}

export async function shutdownMcpHttpServer(
  server: Server,
  mcp: McpLifecycleTarget,
  graceMilliseconds = MCP_SHUTDOWN_GRACE_MILLISECONDS,
): Promise<void> {
  if (!Number.isSafeInteger(graceMilliseconds) || graceMilliseconds < 1) {
    throw new Error("MCP shutdown grace period must be a positive integer");
  }

  mcp.beginShutdown();
  const shutdownDeadline = Date.now() + graceMilliseconds;
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  server.closeIdleConnections();
  const forceCloseMilliseconds = Math.max(1, Math.floor(graceMilliseconds / 2));
  const deadline = setTimeout(() => {
    server.closeAllConnections();
  }, forceCloseMilliseconds);
  let serverCloseError: Error | undefined;
  try {
    await withinShutdownDeadline(closed, shutdownDeadline);
  } catch (error) {
    serverCloseError =
      error instanceof Error
        ? error
        : new Error("MCP HTTP server shutdown failed", { cause: error });
  } finally {
    clearTimeout(deadline);
    server.closeAllConnections();
  }
  let dependencyCloseError: Error | undefined;
  try {
    await withinShutdownDeadline(mcp.close(), shutdownDeadline);
  } catch (error) {
    dependencyCloseError =
      error instanceof Error
        ? error
        : new Error("MCP dependency shutdown failed", { cause: error });
  }
  if (serverCloseError) {
    throw serverCloseError;
  }
  if (dependencyCloseError) {
    throw dependencyCloseError;
  }
}

async function withinShutdownDeadline<Result>(
  operation: Promise<Result>,
  deadline: number,
): Promise<Result> {
  const remainingMilliseconds = Math.max(1, deadline - Date.now());
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("MCP shutdown deadline exceeded"));
        }, remainingMilliseconds);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
