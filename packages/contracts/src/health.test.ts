import { describe, expect, it } from "vitest";

import { createHealthResponse, HealthResponseSchema } from "./health.ts";

describe("createHealthResponse", () => {
  const now = new Date("2026-07-19T12:00:00.000Z");

  it("creates an ok response when every dependency is available", () => {
    const result = createHealthResponse("api", "0.1.0", [], now);

    expect(result).toEqual({
      status: "ok",
      service: "api",
      version: "0.1.0",
      timestamp: "2026-07-19T12:00:00.000Z",
    });
    expect(HealthResponseSchema.safeParse(result).success).toBe(true);
  });

  it("exposes dependency names without leaking connection details", () => {
    const result = createHealthResponse("api", "0.1.0", ["postgres"], now);

    expect(result.status).toBe("degraded");
    expect(result.failedDependencies).toEqual(["postgres"]);
  });
});
