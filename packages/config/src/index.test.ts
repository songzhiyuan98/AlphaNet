import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EnvironmentValidationError,
  loadApiEnvironment,
  loadAuthEnvironment,
  loadMcpEnvironment,
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
const adminAuditSubjectDigestKey = "1".repeat(64);

interface TlsFixture {
  clientCertificateBase64: string;
  clientFingerprint: string;
  clientPrivateKeyBase64: string;
  serverCertificateBase64: string;
  serverPrivateKeyBase64: string;
}

let tlsFixtureDirectory: string | undefined;
let tlsFixture: TlsFixture | undefined;

function generateSelfSignedIdentity(directory: string, name: string): void {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "2",
      "-subj",
      `/CN=alphanet-${name}-test`,
      "-keyout",
      join(directory, `${name}.key.pem`),
      "-out",
      join(directory, `${name}.cert.pem`),
    ],
    { stdio: "ignore" },
  );
}

beforeAll(() => {
  tlsFixtureDirectory = mkdtempSync(join(tmpdir(), "alphanet-config-mtls-"));
  generateSelfSignedIdentity(tlsFixtureDirectory, "server");
  generateSelfSignedIdentity(tlsFixtureDirectory, "client");
  const serverCertificate = readFileSync(join(tlsFixtureDirectory, "server.cert.pem"));
  const clientCertificate = readFileSync(join(tlsFixtureDirectory, "client.cert.pem"));
  tlsFixture = {
    clientCertificateBase64: clientCertificate.toString("base64"),
    clientFingerprint: new X509Certificate(clientCertificate).fingerprint256.replaceAll(
      ":",
      "",
    ),
    clientPrivateKeyBase64: readFileSync(
      join(tlsFixtureDirectory, "client.key.pem"),
    ).toString("base64"),
    serverCertificateBase64: serverCertificate.toString("base64"),
    serverPrivateKeyBase64: readFileSync(
      join(tlsFixtureDirectory, "server.key.pem"),
    ).toString("base64"),
  };
});

afterAll(() => {
  if (tlsFixtureDirectory !== undefined) {
    rmSync(tlsFixtureDirectory, { force: true, recursive: true });
  }
});

function getTlsFixture(): TlsFixture {
  if (tlsFixture === undefined) {
    throw new Error("TLS fixture was not initialized");
  }
  return tlsFixture;
}

function independentKeyBase64(seed: number): string {
  return Buffer.from(
    Array.from({ length: 32 }, (_, index) => (seed + index * 17) % 256),
  ).toString("base64");
}

const actorCurrentKeyBase64 = independentKeyBase64(1);
const actorPreviousKeyBase64 = independentKeyBase64(2);
const actorReplayDigestKeyBase64 = independentKeyBase64(3);
const accessTokenJtiDigestKeyBase64 = independentKeyBase64(4);

function validActorAssertionEnvironment() {
  return {
    MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64: actorCurrentKeyBase64,
    MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION: "2",
    MCP_ACTOR_ASSERTION_PREVIOUS_KEYS: JSON.stringify({
      1: {
        keyBase64: actorPreviousKeyBase64,
        verificationExpiresAt: "2030-01-01T00:00:00.000Z",
      },
    }),
  } as const;
}

function validMcpRuntimeEnvironment() {
  const fixture = getTlsFixture();
  return {
    ...validActorAssertionEnvironment(),
    MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64: accessTokenJtiDigestKeyBase64,
    MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64: fixture.clientCertificateBase64,
    MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64: fixture.clientPrivateKeyBase64,
    MCP_INTERNAL_API_SERVER_CA_PEM_BASE64: fixture.serverCertificateBase64,
    MCP_INTERNAL_API_URL: "https://127.0.0.1:4443",
    MCP_OAUTH_ISSUER: "http://127.0.0.1:5556/",
    MCP_OAUTH_JWKS_URI: "http://127.0.0.1:5556/jwks.json",
    MCP_RESOURCE: "http://127.0.0.1:4100/mcp",
    MCP_RUNTIME_ENABLED: "true",
    REDIS_URL: baseEnvironment.REDIS_URL,
  } as const;
}

function validMcpInternalApiEnvironment() {
  const fixture = getTlsFixture();
  return {
    ...baseEnvironment,
    ...validActorAssertionEnvironment(),
    MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64: accessTokenJtiDigestKeyBase64,
    MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64: actorReplayDigestKeyBase64,
    MCP_INTERNAL_API_ALLOWED_CLIENT_CERT_SHA256_FINGERPRINTS: fixture.clientFingerprint,
    MCP_INTERNAL_API_CLIENT_CA_PEM_BASE64: fixture.clientCertificateBase64,
    MCP_INTERNAL_API_ENABLED: "true",
    MCP_INTERNAL_API_SERVER_CERT_PEM_BASE64: fixture.serverCertificateBase64,
    MCP_INTERNAL_API_SERVER_KEY_PEM_BASE64: fixture.serverPrivateKeyBase64,
  } as const;
}

describe("environment parsing", () => {
  it("coerces bounded numeric values and applies safe defaults", () => {
    const result = loadWorkerEnvironment({
      ...baseEnvironment,
      WORKER_BATCH_SIZE: "42",
    });

    expect(result.WORKER_BATCH_SIZE).toBe(42);
    expect(result.RUN_ONCE).toBe(false);
    expect(result.SEARCH_EMBEDDING_PROVIDER).toBe("disabled");
    expect(result.SEARCH_EMBEDDING_MODEL_ID).toBe("amazon.titan-embed-text-v2:0");
    expect(result.SEARCH_EMBEDDING_DIMENSIONS).toBe(512);
    expect(result.SEARCH_EMBEDDING_TIMEOUT_MS).toBe(5_000);
    expect(result.SEARCH_INDEX_BATCH_SIZE).toBe(10);
    expect(result.SEARCH_INDEX_LEASE_SECONDS).toBe(60);
  });

  it("does not require Redis for the PostgreSQL polling worker", () => {
    const result = loadWorkerEnvironment({
      ...baseEnvironment,
      REDIS_URL: undefined,
    });

    expect(result.DATABASE_URL).toBe(baseEnvironment.DATABASE_URL);
  });

  it("keeps the worker lease bound aligned with the Search indexer", () => {
    expect(
      loadWorkerEnvironment({
        ...baseEnvironment,
        SEARCH_INDEX_LEASE_SECONDS: "15",
      }).SEARCH_INDEX_LEASE_SECONDS,
    ).toBe(15);
    expect(() =>
      loadWorkerEnvironment({
        ...baseEnvironment,
        SEARCH_INDEX_LEASE_SECONDS: "14",
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadWorkerEnvironment({
        ...baseEnvironment,
        SEARCH_EMBEDDING_TIMEOUT_MS: "10000",
        SEARCH_INDEX_LEASE_SECONDS: "15",
      }),
    ).toThrow(EnvironmentValidationError);
    expect(
      loadWorkerEnvironment({
        ...baseEnvironment,
        SEARCH_EMBEDDING_TIMEOUT_MS: "10000",
        SEARCH_INDEX_LEASE_SECONDS: "16",
      }).SEARCH_INDEX_LEASE_SECONDS,
    ).toBe(16);
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

    expect(result.ADMIN_API_ENABLED).toBe(false);
    expect(result.ADMIN_AUDIT_SUBJECT_DIGEST_KEY).toBeUndefined();
    expect(result.ADMIN_OIDC_ISSUER).toBeUndefined();
    expect(result.ADMIN_OIDC_AUDIENCE).toBeUndefined();
    expect(result.ADMIN_OIDC_JWKS_URI).toBeUndefined();
    expect(result.ADMIN_OIDC_ALLOWED_ALGORITHMS).toEqual(["RS256"]);
    expect(result.ADMIN_OIDC_ALLOWED_ACR_VALUES).toEqual([]);
    expect(result.ADMIN_OIDC_ALLOW_AMR_MFA).toBe(true);
    expect(result.ADMIN_OIDC_CLOCK_TOLERANCE_SECONDS).toBe(5);
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
    expect(result.COMMUNITY_CURSOR_SIGNING_KEY).toHaveLength(40);
    expect(result.SEARCH_EMBEDDING_PROVIDER).toBe("disabled");
    expect(result.SEARCH_EMBEDDING_MODEL_ID).toBe("amazon.titan-embed-text-v2:0");
    expect(result.SEARCH_EMBEDDING_DIMENSIONS).toBe(512);
    expect(result.SEARCH_EMBEDDING_TIMEOUT_MS).toBe(5_000);
    expect(result.MCP_INTERNAL_API_ENABLED).toBe(false);
    expect(result.MCP_INTERNAL_API_PORT).toBe(4_443);
    expect(result.MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64).toBeUndefined();
    expect(result.MCP_ACTOR_ASSERTION_PREVIOUS_KEYS).toEqual({});
  });

  it("enables the Admin API only with an atomic strong workforce OIDC configuration", () => {
    const result = loadApiEnvironment({
      ...baseEnvironment,
      ADMIN_AUDIT_SUBJECT_DIGEST_KEY: adminAuditSubjectDigestKey,
      ADMIN_API_ENABLED: "true",
      ADMIN_OIDC_ALLOWED_ACR_VALUES:
        "urn:alphanet:assurance:mfa,urn:alphanet:assurance:phishing-resistant",
      ADMIN_OIDC_ALLOWED_ALGORITHMS: "RS256,ES256",
      ADMIN_OIDC_ALLOW_AMR_MFA: "false",
      ADMIN_OIDC_AUDIENCE: "urn:alphanet:admin-api",
      ADMIN_OIDC_CLOCK_TOLERANCE_SECONDS: "10",
      ADMIN_OIDC_ISSUER: "https://login.alphanet.example/workforce",
      ADMIN_OIDC_JWKS_URI:
        "https://login.alphanet.example/workforce/.well-known/jwks.json",
    });

    expect(result.ADMIN_API_ENABLED).toBe(true);
    expect(result.ADMIN_OIDC_ALLOWED_ALGORITHMS).toEqual(["RS256", "ES256"]);
    expect(result.ADMIN_OIDC_ALLOWED_ACR_VALUES).toEqual([
      "urn:alphanet:assurance:mfa",
      "urn:alphanet:assurance:phishing-resistant",
    ]);
    expect(result.ADMIN_OIDC_ALLOW_AMR_MFA).toBe(false);
    expect(result.ADMIN_OIDC_CLOCK_TOLERANCE_SECONDS).toBe(10);
  });

  it("rejects an enabled, partial, weak, or symmetric Admin OIDC configuration", () => {
    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        ADMIN_API_ENABLED: "true",
      }),
    ).toThrow(EnvironmentValidationError);

    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        ADMIN_API_ENABLED: "true",
        ADMIN_OIDC_AUDIENCE: "urn:alphanet:admin-api",
        ADMIN_OIDC_ISSUER: "https://login.alphanet.example/workforce",
        ADMIN_OIDC_JWKS_URI: "https://login.alphanet.example/jwks.json",
      }),
    ).toThrow(EnvironmentValidationError);

    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        ADMIN_AUDIT_SUBJECT_DIGEST_KEY:
          "8f7d9c1e0b2a4d6f91c3e5a7b9d1f20436587a9cbed0f123456789abcdef0123",
        ADMIN_API_ENABLED: "true",
        ADMIN_OIDC_AUDIENCE: "urn:alphanet:admin-api",
        ADMIN_OIDC_ISSUER: "https://login.alphanet.example/workforce",
        ADMIN_OIDC_JWKS_URI: "https://login.alphanet.example/jwks.json",
      }),
    ).toThrow(EnvironmentValidationError);

    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        ADMIN_AUDIT_SUBJECT_DIGEST_KEY: adminAuditSubjectDigestKey,
        ADMIN_OIDC_ISSUER: "https://login.alphanet.example/workforce",
      }),
    ).toThrow(EnvironmentValidationError);

    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        ADMIN_AUDIT_SUBJECT_DIGEST_KEY: adminAuditSubjectDigestKey,
        ADMIN_API_ENABLED: "true",
        ADMIN_OIDC_ALLOWED_ACR_VALUES: "",
        ADMIN_OIDC_ALLOW_AMR_MFA: "false",
        ADMIN_OIDC_AUDIENCE: "urn:alphanet:admin-api",
        ADMIN_OIDC_ISSUER: "https://login.alphanet.example/workforce",
        ADMIN_OIDC_JWKS_URI: "https://login.alphanet.example/jwks.json",
      }),
    ).toThrow(EnvironmentValidationError);

    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        ADMIN_AUDIT_SUBJECT_DIGEST_KEY: adminAuditSubjectDigestKey,
        ADMIN_API_ENABLED: "true",
        ADMIN_OIDC_ALLOWED_ALGORITHMS: "HS256",
        ADMIN_OIDC_AUDIENCE: "urn:alphanet:admin-api",
        ADMIN_OIDC_ISSUER: "https://login.alphanet.example/workforce",
        ADMIN_OIDC_JWKS_URI: "https://login.alphanet.example/jwks.json",
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it("allows only loopback cleartext OIDC in local development", () => {
    const local = loadApiEnvironment({
      ...baseEnvironment,
      ADMIN_AUDIT_SUBJECT_DIGEST_KEY: adminAuditSubjectDigestKey,
      ADMIN_API_ENABLED: "true",
      ADMIN_OIDC_AUDIENCE: "urn:alphanet:admin-api",
      ADMIN_OIDC_ISSUER: "http://127.0.0.1:5556/workforce",
      ADMIN_OIDC_JWKS_URI: "http://127.0.0.1:5556/jwks.json",
    });
    expect(local.ADMIN_OIDC_ISSUER).toBe("http://127.0.0.1:5556/workforce");

    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        ADMIN_AUDIT_SUBJECT_DIGEST_KEY: adminAuditSubjectDigestKey,
        ADMIN_API_ENABLED: "true",
        ADMIN_OIDC_AUDIENCE: "urn:alphanet:admin-api",
        ADMIN_OIDC_ISSUER: "http://idp.internal/workforce",
        ADMIN_OIDC_JWKS_URI: "http://idp.internal/jwks.json",
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it("loads bounded Bedrock Search configuration and rejects unsupported dimensions", () => {
    const configured = loadApiEnvironment({
      ...baseEnvironment,
      SEARCH_EMBEDDING_PROVIDER: "bedrock",
      SEARCH_EMBEDDING_TIMEOUT_MS: "2500",
    });

    expect(configured.SEARCH_EMBEDDING_PROVIDER).toBe("bedrock");
    expect(configured.SEARCH_EMBEDDING_TIMEOUT_MS).toBe(2_500);

    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        SEARCH_EMBEDDING_DIMENSIONS: "1024",
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        SEARCH_EMBEDDING_MODEL_ID: "amazon.titan-embed-text-v1",
      }),
    ).toThrow(EnvironmentValidationError);
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

describe("Remote MCP private transport environment parsing", () => {
  it("keeps private API secrets optional while the listener is disabled", () => {
    const result = loadApiEnvironment(baseEnvironment);

    expect(result.MCP_INTERNAL_API_ENABLED).toBe(false);
    expect(result.MCP_INTERNAL_API_PORT).toBe(4_443);
    expect(result.MCP_INTERNAL_API_SERVER_CERT_PEM_BASE64).toBeUndefined();
    expect(result.MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64).toBeUndefined();
    expect(result.MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64).toBeUndefined();
  });

  it("loads and normalizes the complete private API mTLS and assertion tuple", () => {
    const input = validMcpInternalApiEnvironment();
    const result = loadApiEnvironment(input);

    expect(result.MCP_INTERNAL_API_ENABLED).toBe(true);
    expect(Buffer.isBuffer(result.MCP_INTERNAL_API_SERVER_CERT_PEM_BASE64)).toBe(true);
    expect(Buffer.isBuffer(result.MCP_INTERNAL_API_SERVER_KEY_PEM_BASE64)).toBe(true);
    expect(Buffer.isBuffer(result.MCP_INTERNAL_API_CLIENT_CA_PEM_BASE64)).toBe(true);
    expect(result.MCP_INTERNAL_API_ALLOWED_CLIENT_CERT_SHA256_FINGERPRINTS).toEqual([
      input.MCP_INTERNAL_API_ALLOWED_CLIENT_CERT_SHA256_FINGERPRINTS,
    ]);
    expect(result.MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION).toBe(2);
    expect(Buffer.isBuffer(result.MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64)).toBe(true);
    expect(result.MCP_ACTOR_ASSERTION_PREVIOUS_KEYS["1"]?.verificationExpiresAt).toEqual(
      new Date("2030-01-01T00:00:00.000Z"),
    );
    expect(Buffer.isBuffer(result.MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64)).toBe(
      true,
    );
    expect(Buffer.isBuffer(result.MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64)).toBe(true);
  });

  it("accepts a complete preloaded private API tuple without enabling its listener", () => {
    const result = loadApiEnvironment({
      ...validMcpInternalApiEnvironment(),
      MCP_INTERNAL_API_ENABLED: "false",
    });

    expect(result.MCP_INTERNAL_API_ENABLED).toBe(false);
    expect(result.MCP_INTERNAL_API_SERVER_CERT_PEM_BASE64).toBeInstanceOf(Buffer);
  });

  it("fails closed on incomplete listener, mTLS, assertion, or replay tuples", () => {
    const complete = validMcpInternalApiEnvironment();
    const invalidInputs = [
      { ...baseEnvironment, MCP_INTERNAL_API_ENABLED: "true" },
      { ...complete, MCP_INTERNAL_API_SERVER_CERT_PEM_BASE64: undefined },
      { ...complete, MCP_INTERNAL_API_SERVER_KEY_PEM_BASE64: undefined },
      { ...complete, MCP_INTERNAL_API_CLIENT_CA_PEM_BASE64: undefined },
      {
        ...complete,
        MCP_INTERNAL_API_ALLOWED_CLIENT_CERT_SHA256_FINGERPRINTS: "",
      },
      { ...complete, MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION: undefined },
      { ...complete, MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64: undefined },
      { ...complete, MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64: undefined },
      { ...complete, MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64: undefined },
    ];

    for (const input of invalidInputs) {
      expect(() => loadApiEnvironment(input)).toThrow(EnvironmentValidationError);
    }
  });

  it("rejects invalid TLS material, a mismatched key, and non-canonical fingerprints", () => {
    const complete = validMcpInternalApiEnvironment();
    const fixture = getTlsFixture();
    const invalidCertificate = Buffer.from("not a PEM certificate").toString("base64");

    expect(() =>
      loadApiEnvironment({
        ...complete,
        MCP_INTERNAL_API_SERVER_CERT_PEM_BASE64: invalidCertificate,
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadApiEnvironment({
        ...complete,
        MCP_INTERNAL_API_SERVER_KEY_PEM_BASE64: fixture.clientPrivateKeyBase64,
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadApiEnvironment({
        ...complete,
        MCP_INTERNAL_API_ALLOWED_CLIENT_CERT_SHA256_FINGERPRINTS:
          fixture.clientFingerprint.toLowerCase(),
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadApiEnvironment({
        ...complete,
        MCP_INTERNAL_API_ALLOWED_CLIENT_CERT_SHA256_FINGERPRINTS: `${fixture.clientFingerprint},${fixture.clientFingerprint}`,
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it("requires a dedicated listener port and independent assertion secrets", () => {
    const complete = validMcpInternalApiEnvironment();

    expect(() =>
      loadApiEnvironment({
        ...complete,
        MCP_INTERNAL_API_PORT: "4000",
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadApiEnvironment({
        ...complete,
        MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64: actorCurrentKeyBase64,
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadApiEnvironment({
        ...complete,
        MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64: actorReplayDigestKeyBase64,
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadApiEnvironment({
        ...complete,
        MCP_ACTOR_ASSERTION_PREVIOUS_KEYS: JSON.stringify({
          1: {
            keyBase64: actorCurrentKeyBase64,
            verificationExpiresAt: "2030-01-01T00:00:00.000Z",
          },
        }),
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it("normalizes previous-key cutoffs without requiring them to remain in the future", () => {
    const complete = validMcpInternalApiEnvironment();
    const previousEntry = {
      keyBase64: actorPreviousKeyBase64,
      verificationExpiresAt: "2030-01-01T00:00:00.000Z",
    };
    const expired = loadApiEnvironment({
      ...complete,
      MCP_ACTOR_ASSERTION_PREVIOUS_KEYS: JSON.stringify({
        1: {
          keyBase64: actorPreviousKeyBase64,
          verificationExpiresAt: "2020-01-01T00:00:00.000Z",
        },
      }),
    });
    expect(expired.MCP_ACTOR_ASSERTION_PREVIOUS_KEYS["1"]?.verificationExpiresAt).toEqual(
      new Date("2020-01-01T00:00:00.000Z"),
    );

    expect(() =>
      loadApiEnvironment({
        ...complete,
        MCP_ACTOR_ASSERTION_PREVIOUS_KEYS: JSON.stringify({
          1: {
            keyBase64: actorPreviousKeyBase64,
            verificationExpiresAt: "2030-01-01T00:00:00Z",
          },
        }),
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadApiEnvironment({
        ...complete,
        MCP_ACTOR_ASSERTION_PREVIOUS_KEYS: `{"1":${JSON.stringify(previousEntry)},"1":${JSON.stringify(previousEntry)}}`,
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadApiEnvironment({
        ...complete,
        MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION: "1",
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it("keeps MCP runtime independent from public exposure and decodes its full tuple", () => {
    const result = loadMcpEnvironment(validMcpRuntimeEnvironment());

    expect(result.MCP_RUNTIME_ENABLED).toBe(true);
    expect(result.MCP_PUBLIC_ENABLED).toBe(false);
    expect(result.MCP_INTERNAL_API_URL).toBe("https://127.0.0.1:4443");
    expect(result.MCP_INTERNAL_API_TIMEOUT_MS).toBe(15_000);
    expect(result.MCP_INTERNAL_API_MAX_RESPONSE_BYTES).toBe(4 * 1_024 * 1_024);
    expect(Buffer.isBuffer(result.MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64)).toBe(true);
    expect(Buffer.isBuffer(result.MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64)).toBe(true);
    expect(Buffer.isBuffer(result.MCP_INTERNAL_API_SERVER_CA_PEM_BASE64)).toBe(true);
    expect(Buffer.isBuffer(result.MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64)).toBe(true);
  });

  it("allows a complete runtime tuple to be preloaded while runtime remains disabled", () => {
    const result = loadMcpEnvironment({
      ...validMcpRuntimeEnvironment(),
      MCP_RUNTIME_ENABLED: "false",
    });

    expect(result.MCP_RUNTIME_ENABLED).toBe(false);
    expect(result.MCP_RESOURCE).toBe("http://127.0.0.1:4100/mcp");
  });

  it("requires runtime before public exposure and rejects every partial runtime tuple", () => {
    const complete = validMcpRuntimeEnvironment();
    expect(() =>
      loadMcpEnvironment({
        ...complete,
        MCP_PUBLIC_ENABLED: "true",
        MCP_RUNTIME_ENABLED: "false",
      }),
    ).toThrow(EnvironmentValidationError);

    const requiredKeys = [
      "MCP_RESOURCE",
      "MCP_OAUTH_ISSUER",
      "MCP_OAUTH_JWKS_URI",
      "MCP_INTERNAL_API_URL",
      "MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64",
      "MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64",
      "MCP_INTERNAL_API_SERVER_CA_PEM_BASE64",
      "MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64",
      "MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64",
      "MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION",
    ] as const;
    for (const key of requiredKeys) {
      expect(() =>
        loadMcpEnvironment({
          ...complete,
          [key]: undefined,
        }),
      ).toThrow(EnvironmentValidationError);
    }
  });

  it("rejects non-canonical internal and OAuth URLs and cleartext production OAuth", () => {
    const complete = validMcpRuntimeEnvironment();
    for (const override of [
      { MCP_INTERNAL_API_URL: "http://127.0.0.1:4443" },
      { MCP_INTERNAL_API_URL: "https://127.0.0.1:4443/internal/mcp" },
      { MCP_OAUTH_ISSUER: "http://oauth.internal/" },
      { MCP_OAUTH_JWKS_URI: "https://oauth.example/jwks.json?version=1" },
      { MCP_RESOURCE: "https://MCP.alphanet.example/mcp" },
    ]) {
      expect(() => loadMcpEnvironment({ ...complete, ...override })).toThrow(
        EnvironmentValidationError,
      );
    }
    expect(() =>
      loadMcpEnvironment({
        ...complete,
        NODE_ENV: "production",
        REDIS_URL: "rediss://cache.example.com:6379/0",
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it("bounds the internal client and rejects mismatched or reused key material", () => {
    const complete = validMcpRuntimeEnvironment();
    const fixture = getTlsFixture();
    expect(() =>
      loadMcpEnvironment({ ...complete, MCP_INTERNAL_API_TIMEOUT_MS: "99" }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadMcpEnvironment({ ...complete, MCP_INTERNAL_API_TIMEOUT_MS: "30000" }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadMcpEnvironment({ ...complete, MCP_INTERNAL_API_MAX_RESPONSE_BYTES: "1023" }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadMcpEnvironment({
        ...complete,
        MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64: fixture.serverPrivateKeyBase64,
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadMcpEnvironment({
        ...complete,
        MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64: actorCurrentKeyBase64,
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadMcpEnvironment({
        ...complete,
        MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64: Buffer.alloc(32).toString("base64"),
      }),
    ).toThrow(EnvironmentValidationError);
    expect(() =>
      loadMcpEnvironment({
        ...complete,
        MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64: accessTokenJtiDigestKeyBase64.replace(
          /=+$/,
          "",
        ),
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

    expect(() =>
      loadApiEnvironment({
        ...baseEnvironment,
        AGENT_API_KEY_PEPPER: "Production-Agent-Key-Pepper-Rotated-Q7v9N2x5Lm8Kp3Rt",
        API_TRUSTED_PROXY_CIDRS: "10.20.0.0/16",
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
      COMMUNITY_CURSOR_SIGNING_KEY: "Production-Community-Cursor-Key-Q4v8M2x7Lp5Rt9W3n6",
      DATABASE_URL:
        "postgresql://alphanet:secret@db.example.com:5432/alphanet?sslmode=verify-full",
      NODE_ENV: "production",
      PENDING_ACTION_ENCRYPTION_KEY:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      RESEND_API_KEY: "re_live_key",
      REDIS_URL: "rediss://cache.example.com:6379/0",
      SSR_INTERNAL_REQUEST_SECRET: "Production-SSR-Request-Secret-J8m4V2s7X5n9K3p6T1w0",
    });
    expect(result.API_TRUSTED_PROXY_CIDRS).toEqual(["10.20.0.0/16", "fd00:1234::/48"]);
  });

  it("requires TLS for API and MCP Redis connections in production", () => {
    expect(() =>
      loadMcpEnvironment({
        NODE_ENV: "production",
        REDIS_URL: "redis://cache.example.com:6379/0",
      }),
    ).toThrow(EnvironmentValidationError);

    const mcp = loadMcpEnvironment({
      NODE_ENV: "production",
      REDIS_URL: "rediss://alphanet-runtime:secret@cache.example.com:6379/0",
    });
    expect(mcp.REDIS_URL).toMatch(/^rediss:/);
    expect(mcp.MCP_RUNTIME_ENABLED).toBe(false);
    expect(mcp.MCP_PUBLIC_ENABLED).toBe(false);
    expect(mcp.MCP_RESOURCE).toBeUndefined();
  });

  it("requires a canonical fixed MCP resource before public access can be enabled", () => {
    expect(() =>
      loadMcpEnvironment({
        MCP_PUBLIC_ENABLED: "true",
        REDIS_URL: baseEnvironment.REDIS_URL,
      }),
    ).toThrow(EnvironmentValidationError);

    const local = loadMcpEnvironment({
      ...validMcpRuntimeEnvironment(),
      MCP_PUBLIC_ENABLED: "true",
    });
    expect(local.MCP_RESOURCE).toBe("http://127.0.0.1:4100/mcp");

    expect(() =>
      loadMcpEnvironment({
        ...validMcpRuntimeEnvironment(),
        MCP_PUBLIC_ENABLED: "true",
        MCP_RESOURCE: "https://MCP.alphanet.example/mcp",
      }),
    ).toThrow(EnvironmentValidationError);

    expect(() =>
      loadMcpEnvironment({
        ...validMcpRuntimeEnvironment(),
        MCP_PUBLIC_ENABLED: "true",
        MCP_RESOURCE: "https://mcp.alphanet.example/mcp",
        NODE_ENV: "production",
        REDIS_URL: "rediss://alphanet-runtime:secret@cache.example.com:6379/0",
      }),
    ).toThrow(EnvironmentValidationError);

    const production = loadMcpEnvironment({
      ...validMcpRuntimeEnvironment(),
      MCP_PUBLIC_ENABLED: "true",
      MCP_RESOURCE: "https://mcp.alphanet.example/mcp",
      MCP_OAUTH_ISSUER: "https://auth.alphanet.example/",
      MCP_OAUTH_JWKS_URI: "https://auth.alphanet.example/jwks.json",
      MCP_TRUSTED_PROXY_CIDRS: "10.20.0.0/16,fd00:1234::/48",
      NODE_ENV: "production",
      REDIS_URL: "rediss://alphanet-runtime:secret@cache.example.com:6379/0",
    });
    expect(production.MCP_TRUSTED_PROXY_CIDRS).toEqual([
      "10.20.0.0/16",
      "fd00:1234::/48",
    ]);
  });

  it("requires PostgreSQL certificate and endpoint verification in production", () => {
    const productionWorker = {
      ...baseEnvironment,
      NODE_ENV: "production",
      PENDING_ACTION_ENCRYPTION_KEY:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    } as const;

    expect(() => loadWorkerEnvironment(productionWorker)).toThrow(
      EnvironmentValidationError,
    );

    const worker = loadWorkerEnvironment({
      ...productionWorker,
      DATABASE_URL:
        "postgresql://alphanet:secret@db.example.com:5432/alphanet?sslmode=verify-full",
    });
    expect(worker.DATABASE_URL).toContain("sslmode=verify-full");
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
