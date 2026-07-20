import { describe, expect, it } from "vitest";

import {
  EnvironmentValidationError,
  loadApiEnvironment,
  loadWorkerEnvironment,
  parseCorsOrigins,
} from "./index.js";

const baseEnvironment = {
  DATABASE_URL: "postgres://alphanet:alphanet@localhost:5432/alphanet",
  OUTBOX_CONSUMER_NAME: "alphanet-worker:v1",
  OUTBOX_REPLAY_FROM: "2026-07-20T00:00:00.000Z",
  REDIS_URL: "redis://localhost:6379",
};

describe("environment parsing", () => {
  it("coerces bounded numeric values and applies safe defaults", () => {
    const result = loadWorkerEnvironment({
      ...baseEnvironment,
      WORKER_BATCH_SIZE: "42",
    });

    expect(result.WORKER_BATCH_SIZE).toBe(42);
    expect(result.RUN_ONCE).toBe(false);
  });

  it("does not require Redis for the PostgreSQL polling worker", () => {
    const result = loadWorkerEnvironment({
      ...baseEnvironment,
      REDIS_URL: undefined,
    });

    expect(result.DATABASE_URL).toBe(baseEnvironment.DATABASE_URL);
  });

  it("requires a versioned outbox consumer and a stable replay watermark", () => {
    expect(() =>
      loadWorkerEnvironment({
        ...baseEnvironment,
        OUTBOX_CONSUMER_NAME: "alphanet-worker",
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadWorkerEnvironment({
        ...baseEnvironment,
        OUTBOX_REPLAY_FROM: "now",
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it("reports the invalid key without including its value", () => {
    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        DATABASE_URL: "not a database url",
      }),
    ).toThrow(EnvironmentValidationError);

    try {
      loadApiEnvironment({
        ...baseEnvironment,
        DATABASE_URL: "secret-that-must-not-be-logged",
      });
    } catch (error) {
      expect(String(error)).not.toContain("secret-that-must-not-be-logged");
    }
  });
});

describe("parseCorsOrigins", () => {
  it("normalizes a comma-separated allowlist", () => {
    expect(parseCorsOrigins("https://alpha.example, http://localhost:3000,")).toEqual([
      "https://alpha.example",
      "http://localhost:3000",
    ]);
  });
});
