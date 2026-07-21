import { createLogger } from "@alphanet/observability";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createMcpApp, type McpApp } from "./app.js";

const apps: McpApp[] = [];
const logger = createLogger({
  environment: "test",
  level: "silent",
  service: "mcp-test",
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function makeApp(): McpApp {
  const app = createMcpApp({
    allowedHosts: ["127.0.0.1", "localhost"],
    host: "127.0.0.1",
    logger,
    version: "test-version",
  });
  apps.push(app);
  return app;
}

describe("MCP service", () => {
  it("reports liveness", async () => {
    const { app } = makeApp();

    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      service: "mcp",
      status: "ok",
      version: "test-version",
    });
  });

  it("keeps optional dependency failures non-blocking", async () => {
    const instance = createMcpApp({
      allowedHosts: ["127.0.0.1", "localhost"],
      dependencies: [
        {
          critical: false,
          name: "redis",
          check: () => Promise.reject(new Error("unavailable")),
          close: () => Promise.resolve(),
        },
      ],
      host: "127.0.0.1",
      logger,
      version: "test-version",
    });
    apps.push(instance);

    const response = await request(instance.app).get("/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "degraded",
      failedDependencies: ["redis"],
    });
  });

  it("completes the MCP initialize handshake through the official transport", async () => {
    const { app } = makeApp();

    const response = await request(app)
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: {
            name: "alphanet-test",
            version: "0.1.0",
          },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        serverInfo: {
          name: "alphanet",
          version: "test-version",
        },
      },
    });
  });

  it("lists the operational walking-skeleton tool", async () => {
    const { app } = makeApp();

    const response = await request(app)
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      result: {
        tools: [
          {
            name: "get_platform_status",
            annotations: {
              readOnlyHint: true,
            },
          },
        ],
      },
    });
  });

  it("rejects unsupported HTTP methods at the protocol endpoint", async () => {
    const { app } = makeApp();

    const response = await request(app).get("/mcp");

    expect(response.status).toBe(405);
    expect(response.body).toMatchObject({
      error: {
        code: -32000,
      },
    });
  });

  it("allows task-IP Host headers only on health endpoints", async () => {
    const { app } = makeApp();

    const healthResponse = await request(app)
      .get("/health/live")
      .set("host", "10.0.12.34:4100");

    expect(healthResponse.status).toBe(200);
    expect(healthResponse.headers).not.toHaveProperty("x-powered-by");

    const protocolResponse = await request(app)
      .post("/mcp")
      .set("host", "attacker.example")
      .set("accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {},
      });

    expect(protocolResponse.status).toBe(403);
    expect(protocolResponse.headers).not.toHaveProperty("x-powered-by");
  });
});
