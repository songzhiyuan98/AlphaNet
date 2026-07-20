import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiApp } from "./app.js";

const apps: Awaited<ReturnType<typeof createApiApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("API service", () => {
  it("reports liveness without depending on infrastructure", async () => {
    const app = await createApiApp({
      allowedOrigins: ["http://localhost:3000"],
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "api",
      version: "test-version",
    });
  });

  it("fails readiness without exposing connection details", async () => {
    const close = vi.fn(() => Promise.resolve());
    const app = await createApiApp({
      allowedOrigins: ["http://localhost:3000"],
      dependencies: [
        {
          name: "postgres",
          check: () =>
            Promise.reject(new Error("postgres://user:secret@example.invalid/database")),
          close,
        },
      ],
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("secret");
    expect(response.json()).toMatchObject({
      status: "degraded",
      failedDependencies: ["postgres"],
    });
  });

  it("reports an optional dependency failure without withdrawing readiness", async () => {
    const app = await createApiApp({
      allowedOrigins: ["http://localhost:3000"],
      dependencies: [
        {
          critical: false,
          name: "redis",
          check: () => Promise.reject(new Error("unavailable")),
          close: () => Promise.resolve(),
        },
      ],
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "degraded",
      failedDependencies: ["redis"],
    });
  });

  it("returns a stable error envelope and request id", async () => {
    const app = await createApiApp({
      allowedOrigins: ["http://localhost:3000"],
      environment: "test",
      version: "test-version",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/does-not-exist",
      headers: {
        "x-request-id": "test-request-id",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["x-request-id"]).toBe("test-request-id");
    expect(response.json()).toEqual({
      error: {
        code: "route_not_found",
        message: "The requested route does not exist.",
        requestId: "test-request-id",
      },
    });
  });
});
