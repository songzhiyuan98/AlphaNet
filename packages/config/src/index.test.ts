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
  AGENT_API_KEY_PEPPER: "h9mP6Lrz3dF5cQ8K7Vw2uX4aN1sJ0tYbEoGkUiZp",
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

  it("loads bounded Agent credential defaults", () => {
    const result = loadApiEnvironment(baseEnvironment);

    expect(result.AGENT_API_AUDIENCE).toBe("urn:alphanet:api:v1");
    expect(result.AGENT_API_KEY_PEPPER_VERSION).toBe(1);
    expect(result.AGENT_API_KEY_PREVIOUS_PEPPERS).toEqual({});
    expect(result.AGENT_CREDENTIAL_ACTIVE_PER_AGENT).toBe(5);
    expect(result.AGENT_CREDENTIAL_ACTIVE_PER_OWNER).toBe(20);
    expect(result.AGENT_CREDENTIAL_DEFAULT_TTL_DAYS).toBe(90);
    expect(result.AGENT_CREDENTIAL_MAX_TTL_DAYS).toBe(365);
    expect(result.AGENT_CREDENTIAL_ISSUE_PER_OWNER_24H).toBe(10);
    expect(result.AGENT_CREDENTIAL_MUTATION_COOLDOWN_SECONDS).toBe(30);
    expect(result.SSR_INTERNAL_REQUEST_SECRET).toBe(
      "L8wq2Uox9sV7Gm1Xc4Kd6aJ0Ph5Rt3NyE1bZfQ7i",
    );
    expect(result.PENDING_ACTION_ENCRYPTION_KEY_VERSION).toBe(1);
    expect(result.PENDING_ACTION_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(result.PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS).toEqual({});
  });

  it("loads a bounded previous Agent API key pepper ring", () => {
    const previousPepper = "Previous-Agent-Key-Pepper-Q8m2V7s4X1n6K9p3T5w0";
    const result = loadApiEnvironment({
      ...baseEnvironment,
      AGENT_API_KEY_PEPPER_VERSION: "2",
      AGENT_API_KEY_PREVIOUS_PEPPERS: JSON.stringify({
        1: previousPepper,
      }),
    });

    expect(result.AGENT_API_KEY_PEPPER_VERSION).toBe(2);
    expect(result.AGENT_API_KEY_PREVIOUS_PEPPERS).toEqual({
      1: previousPepper,
    });
  });

  it("rejects malformed or duplicate Agent API key pepper versions", () => {
    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        AGENT_API_KEY_PREVIOUS_PEPPERS: "not-json",
      }),
    ).toThrow(EnvironmentValidationError);

    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        AGENT_API_KEY_PEPPER_VERSION: "2",
        AGENT_API_KEY_PREVIOUS_PEPPERS: JSON.stringify({
          2: "Previous-Agent-Key-Pepper-Q8m2V7s4X1n6K9p3T5w0",
        }),
      }),
    ).toThrow(EnvironmentValidationError);

    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        AGENT_API_KEY_PEPPER_VERSION: "2",
        AGENT_API_KEY_PREVIOUS_PEPPERS: JSON.stringify({
          1: baseEnvironment.AGENT_API_KEY_PEPPER,
        }),
      }),
    ).toThrow(EnvironmentValidationError);

    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        AGENT_API_KEY_PEPPER_VERSION: "32768",
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it("rejects inconsistent Agent credential limits", () => {
    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        AGENT_CREDENTIAL_ACTIVE_PER_AGENT: "10",
        AGENT_CREDENTIAL_ACTIVE_PER_OWNER: "5",
      }),
    ).toThrow(EnvironmentValidationError);

    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        AGENT_CREDENTIAL_DEFAULT_TTL_DAYS: "366",
        AGENT_CREDENTIAL_MAX_TTL_DAYS: "365",
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it("loads a rotation-safe PendingAction encryption key ring", () => {
    const previousKey =
      "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const result = loadApiEnvironment({
      ...baseEnvironment,
      PENDING_ACTION_ENCRYPTION_KEY_VERSION: "2",
      PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({
        1: previousKey,
      }),
    });

    expect(result.PENDING_ACTION_ENCRYPTION_KEY_VERSION).toBe(2);
    expect(result.PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS).toEqual({
      1: previousKey,
    });
  });

  it("rejects malformed, duplicated, or reused PendingAction key versions", () => {
    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        PENDING_ACTION_ENCRYPTION_KEY: "not-a-32-byte-key",
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        PENDING_ACTION_ENCRYPTION_KEY_VERSION: "2",
        PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({
          2: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        }),
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        PENDING_ACTION_ENCRYPTION_KEY_VERSION: "2",
        PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({
          1: "8f7d9c1e0b2a4d6f91c3e5a7b9d1f20436587a9cbed0f123456789abcdef0123",
        }),
      }),
    ).toThrow(EnvironmentValidationError);
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
        AGENT_API_KEY_PEPPER: "Production-Agent-Key-Pepper-Rotated-Q7v9N2x5Lm8Kp3Rt",
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
      AGENT_API_KEY_PEPPER: "Production-Agent-Key-Pepper-Rotated-Q7v9N2x5Lm8Kp3Rt",
      API_TRUSTED_PROXY_CIDRS: "10.20.0.0/16,fd00:1234::/48",
      AUTH_EMAIL_FROM: "AlphaNet <auth@example.com>",
      AUTH_EMAIL_MODE: "resend",
      AUTH_SECURE_COOKIES: "true",
      AUTH_TRUSTED_ORIGINS: "https://api.alphanet.example",
      BETTER_AUTH_SECRET: "QJv7w8ScgVN4Xs1TBP-Wuz2HaK6e3d9Rm5Afy0LcoEi",
      BETTER_AUTH_URL: "https://api.alphanet.example",
      CORS_ORIGINS: "https://api.alphanet.example",
      NODE_ENV: "production",
      PENDING_ACTION_ENCRYPTION_KEY:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      RESEND_API_KEY: "re_live_key",
      SSR_INTERNAL_REQUEST_SECRET: "Production-SSR-Request-Secret-J8m4V2s7X5n9K3p6T1w0",
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
