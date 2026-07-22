import { createServer, request } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureMcpHttpServer,
  MCP_HTTP_HEADERS_TIMEOUT_MILLISECONDS,
  MCP_HTTP_KEEP_ALIVE_TIMEOUT_MILLISECONDS,
  MCP_HTTP_MAX_REQUESTS_PER_SOCKET,
  MCP_HTTP_REQUEST_TIMEOUT_MILLISECONDS,
  MCP_HTTP_SOCKET_TIMEOUT_MILLISECONDS,
  shutdownMcpHttpServer,
} from "./lifecycle.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
  }
});

describe("MCP HTTP lifecycle", () => {
  it("sets explicit slow-client and socket resource bounds", () => {
    const server = createServer();
    servers.push(server);

    configureMcpHttpServer(server);

    expect(server.headersTimeout).toBe(MCP_HTTP_HEADERS_TIMEOUT_MILLISECONDS);
    expect(server.requestTimeout).toBe(MCP_HTTP_REQUEST_TIMEOUT_MILLISECONDS);
    expect(server.keepAliveTimeout).toBe(MCP_HTTP_KEEP_ALIVE_TIMEOUT_MILLISECONDS);
    expect(server.maxRequestsPerSocket).toBe(MCP_HTTP_MAX_REQUESTS_PER_SOCKET);
    expect(server.timeout).toBe(MCP_HTTP_SOCKET_TIMEOUT_MILLISECONDS);
  });

  it("forces a hanging connection closed within the shutdown grace period", async () => {
    const server = createServer(() => {
      // Deliberately keep the response open until shutdown forces the socket closed.
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected a TCP listener");
    }
    const received = new Promise<void>((resolve) =>
      server.once("request", () => resolve()),
    );
    const clientRequest = request({
      host: "127.0.0.1",
      method: "GET",
      port: address.port,
      path: "/mcp",
    });
    clientRequest.on("error", () => undefined);
    clientRequest.end();
    await received;

    const target = {
      beginShutdown: vi.fn(),
      close: vi.fn(() => Promise.resolve()),
    };
    const startedAt = Date.now();
    await shutdownMcpHttpServer(server, target, 25);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(target.beginShutdown).toHaveBeenCalledOnce();
    expect(target.close).toHaveBeenCalledOnce();
  });

  it("bounds dependency shutdown with the same overall grace period", async () => {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const target = {
      beginShutdown: vi.fn(),
      close: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const startedAt = Date.now();

    await expect(shutdownMcpHttpServer(server, target, 25)).rejects.toThrow(
      "shutdown deadline exceeded",
    );

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(target.beginShutdown).toHaveBeenCalledOnce();
    expect(target.close).toHaveBeenCalledOnce();
  });
});
