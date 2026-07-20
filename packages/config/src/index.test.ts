import { describe, expect, it } from "vitest";

import {
  EnvironmentValidationError,
  loadApiEnvironment,
  loadAuthEnvironment,
  loadWorkerEnvironment,
  parseCorsOrigins,
} from "./index.js";

const localAuthEnvironment = {
  AUTH_EMAIL_MODE: "local-preview",
  AUTH_SECURE_COOKIES: "false",
  AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
  BETTER_AUTH_SECRET: "yKt8Jue5W_Q24xh6bP9FdM3Rav7CzsNe0GLi1TXUcAo",
  BETTER_AUTH_URL: "http://localhost:4000",
} as const;

const baseEnvironment = {
  ...localAuthEnvironment,
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

describe("Owner authentication environment parsing", () => {
  it("loads the safe local-preview configuration and bounded capacity defaults", () => {
    const result = loadAuthEnvironment(localAuthEnvironment);

    expect(result.AUTH_TRUSTED_ORIGINS).toEqual(["http://localhost:3000"]);
    expect(result.AUTH_SECURE_COOKIES).toBe(false);
    expect(result.AUTH_DATABASE_POOL_MAX).toBe(5);
    expect(result.AUTH_EMAIL_DAILY_GLOBAL_LIMIT).toBe(10_000);
  });

  it("requires Google OAuth credentials as an atomic pair", () => {
    expect(() =>
      loadAuthEnvironment({
        ...localAuthEnvironment,
        AUTH_GOOGLE_CLIENT_ID: "google-client-id",
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it("requires Resend credentials and a valid sender in Resend mode", () => {
    expect(() =>
      loadAuthEnvironment({
        ...localAuthEnvironment,
        AUTH_EMAIL_MODE: "resend",
      }),
    ).toThrow(EnvironmentValidationError);

    const result = loadAuthEnvironment({
      ...localAuthEnvironment,
      AUTH_EMAIL_FROM: "AlphaNet <auth@example.com>",
      AUTH_EMAIL_MODE: "resend",
      RESEND_API_KEY: "re_test_key",
    });

    expect(result.AUTH_EMAIL_FROM).toBe("AlphaNet <auth@example.com>");
  });

  it("keeps local-preview delivery on a non-production loopback origin", () => {
    expect(() =>
      loadAuthEnvironment({
        ...localAuthEnvironment,
        BETTER_AUTH_URL: "https://api.example.com",
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadAuthEnvironment({
        ...localAuthEnvironment,
        NODE_ENV: "production",
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it("requires production TLS, secure cookies, trusted TLS origins, and a rotated secret", () => {
    expect(() =>
      loadAuthEnvironment({
        ...localAuthEnvironment,
        AUTH_EMAIL_FROM: "auth@example.com",
        AUTH_EMAIL_MODE: "resend",
        NODE_ENV: "production",
        RESEND_API_KEY: "re_test_key",
      }),
    ).toThrow(EnvironmentValidationError);

    const result = loadAuthEnvironment({
      AUTH_EMAIL_FROM: "AlphaNet <auth@example.com>",
      AUTH_EMAIL_MODE: "resend",
      AUTH_SECURE_COOKIES: "true",
      AUTH_TRUSTED_ORIGINS: "https://api.alphanet.example",
      BETTER_AUTH_SECRET: "QJv7w8ScgVN4Xs1TBP-Wuz2HaK6e3d9Rm5Afy0LcoEi",
      BETTER_AUTH_URL: "https://api.alphanet.example",
      NODE_ENV: "production",
      RESEND_API_KEY: "re_live_key",
    });

    expect(result.AUTH_SECURE_COOKIES).toBe(true);
  });

  it("requires an explicit trusted ingress address range in production", () => {
    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        AUTH_EMAIL_FROM: "AlphaNet <auth@example.com>",
        AUTH_EMAIL_MODE: "resend",
        AUTH_SECURE_COOKIES: "true",
        AUTH_TRUSTED_ORIGINS: "https://api.alphanet.example",
        BETTER_AUTH_SECRET: "QJv7w8ScgVN4Xs1TBP-Wuz2HaK6e3d9Rm5Afy0LcoEi",
        BETTER_AUTH_URL: "https://api.alphanet.example",
        CORS_ORIGINS: "https://api.alphanet.example",
        NODE_ENV: "production",
        RESEND_API_KEY: "re_live_key",
      }),
    ).toThrow(EnvironmentValidationError);

    const result = loadApiEnvironment({
      ...baseEnvironment,
      API_TRUSTED_PROXY_CIDRS: "10.20.0.0/16,fd00:1234::/48",
      AUTH_EMAIL_FROM: "AlphaNet <auth@example.com>",
      AUTH_EMAIL_MODE: "resend",
      AUTH_SECURE_COOKIES: "true",
      AUTH_TRUSTED_ORIGINS: "https://api.alphanet.example",
      BETTER_AUTH_SECRET: "QJv7w8ScgVN4Xs1TBP-Wuz2HaK6e3d9Rm5Afy0LcoEi",
      BETTER_AUTH_URL: "https://api.alphanet.example",
      CORS_ORIGINS: "https://api.alphanet.example",
      NODE_ENV: "production",
      RESEND_API_KEY: "re_live_key",
    });
    expect(result.API_TRUSTED_PROXY_CIDRS).toEqual(["10.20.0.0/16", "fd00:1234::/48"]);
  });

  it("rejects malformed and catch-all trusted proxy ranges", () => {
    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        API_TRUSTED_PROXY_CIDRS: "0.0.0.0/0",
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        API_TRUSTED_PROXY_CIDRS: "not-an-address",
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it("rejects non-canonical URLs, weak secrets, and duplicate trusted origins", () => {
    expect(() =>
      loadAuthEnvironment({
        ...localAuthEnvironment,
        BETTER_AUTH_URL: "http://localhost:4000/api/auth",
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadAuthEnvironment({
        ...localAuthEnvironment,
        BETTER_AUTH_SECRET: "change-me-change-me-change-me-change-me",
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadAuthEnvironment({
        ...localAuthEnvironment,
        AUTH_TRUSTED_ORIGINS: "http://localhost:3000,http://localhost:3000",
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it("requires CORS to cover every browser origin trusted by Better Auth", () => {
    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        AUTH_TRUSTED_ORIGINS: "http://localhost:3000,http://localhost:3001",
        CORS_ORIGINS: "http://localhost:3000",
      }),
    ).toThrow(EnvironmentValidationError);
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
