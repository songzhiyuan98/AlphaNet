import { randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

const webPort = Number(process.env.E2E_WEB_PORT ?? 3_300);
const apiPort = Number(process.env.E2E_API_PORT ?? 4_400);
const oidcPort = Number(process.env.E2E_ADMIN_OIDC_PORT ?? 55_560);
const postgresPort = Number(process.env.E2E_POSTGRES_PORT ?? 55_432);
const redisPort = Number(process.env.E2E_REDIS_PORT ?? 56_379);
const dynamodbPort = Number(process.env.E2E_DYNAMODB_PORT ?? 58_000);

const webOrigin = `http://127.0.0.1:${webPort}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const oidcIssuer = `http://127.0.0.1:${oidcPort}/workforce`;
const oidcAudience = "urn:alphanet:admin-api:e2e";
const oidcClientId = "alphanet-admin-web-e2e";
const oidcClientSecret = "admin-web-e2e-client-secret-32-bytes-minimum";
const oidcSubject = "alphanet-e2e-content-moderator";
const sessionTable = "alphanet-admin-web-e2e-sessions";
const databaseUrl =
  process.env.DATABASE_URL ??
  `postgresql://alphanet:alphanet_admin_e2e_local_only@127.0.0.1:${postgresPort}/alphanet_admin_e2e`;
const redisUrl =
  process.env.REDIS_URL ??
  `redis://:alphanet_admin_e2e_local_only@127.0.0.1:${redisPort}/0`;
const ssrSecret =
  process.env.SSR_INTERNAL_REQUEST_SECRET ?? "AdminE2E-SSR-Internal-Request-Secret-v1";
const sessionEncryptionKeyBase64 = randomBytes(32).toString("base64");
const webRuntimeRoot = process.env.E2E_WEB_RUNTIME_ROOT ?? process.cwd();

const ownerEnvironment = {
  ALPHANET_ALLOW_ADMIN_E2E_SEED: "1",
  ALPHANET_ALLOW_UI_DEMO_SEED: "1",
  DATABASE_URL: databaseUrl,
  E2E_ADMIN_OIDC_ISSUER: oidcIssuer,
  E2E_AUTHOR_PASSWORD:
    process.env.E2E_AUTHOR_PASSWORD ?? "Author-owner-e2e-password-2026",
  E2E_REPORTER_PASSWORD:
    process.env.E2E_REPORTER_PASSWORD ?? "Reporter-owner-e2e-password-2026",
} as const;

const oidcEnvironment = {
  E2E_ADMIN_OIDC_AUDIENCE: oidcAudience,
  E2E_ADMIN_OIDC_CLIENT_ID: oidcClientId,
  E2E_ADMIN_OIDC_CLIENT_SECRET: oidcClientSecret,
  E2E_ADMIN_OIDC_HOST: "127.0.0.1",
  E2E_ADMIN_OIDC_ISSUER: oidcIssuer,
  E2E_ADMIN_OIDC_PORT: String(oidcPort),
  E2E_ADMIN_OIDC_REDIRECT_URI: `${webOrigin}/admin/auth/callback`,
  E2E_ADMIN_OIDC_SUBJECT: oidcSubject,
} as const;

const apiEnvironment = {
  ...ownerEnvironment,
  ADMIN_API_ENABLED: "true",
  ADMIN_AUDIT_SUBJECT_DIGEST_KEY:
    "61646d696e206175646974206532650000000000000000000000000000000000",
  ADMIN_OIDC_ALLOWED_ACR_VALUES: "urn:alphanet:e2e:mfa",
  ADMIN_OIDC_ALLOWED_ALGORITHMS: "RS256",
  ADMIN_OIDC_ALLOW_AMR_MFA: "true",
  ADMIN_OIDC_AUDIENCE: oidcAudience,
  ADMIN_OIDC_CLOCK_TOLERANCE_SECONDS: "5",
  ADMIN_OIDC_ISSUER: oidcIssuer,
  ADMIN_OIDC_JWKS_URI: `${oidcIssuer}/jwks.json`,
  AGENT_API_KEY_PEPPER: "AdminE2E-Agent-API-Pepper-v1-Independent",
  AGENT_API_KEY_PEPPER_VERSION: "1",
  APP_VERSION: "admin-moderation-browser-e2e",
  AUTH_EMAIL_MODE: "local-preview",
  AUTH_SECURE_COOKIES: "false",
  AUTH_TRUSTED_ORIGINS: webOrigin,
  BETTER_AUTH_SECRET: "AdminE2E-Better-Auth-Secret-v1-Independent",
  BETTER_AUTH_URL: apiOrigin,
  COMMUNITY_CURSOR_SIGNING_KEY: "AdminE2E-Community-Cursor-Signing-Key-v1",
  CORS_ORIGINS: webOrigin,
  HOST: "127.0.0.1",
  MCP_INTERNAL_API_ENABLED: "false",
  MCP_OAUTH_OWNER_CONSENT_ENABLED: "false",
  NODE_ENV: "development",
  PENDING_ACTION_ENCRYPTION_KEY:
    "8f7d9c1e0b2a4d6f91c3e5a7b9d1f20436587a9cbed0f123456789abcdef0123",
  PENDING_ACTION_ENCRYPTION_KEY_VERSION: "1",
  PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS: "{}",
  PORT: String(apiPort),
  REDIS_URL: redisUrl,
  SEARCH_EMBEDDING_PROVIDER: "disabled",
  SSR_INTERNAL_REQUEST_SECRET: ssrSecret,
} as const;

const webEnvironment = {
  ...ownerEnvironment,
  ADMIN_WEB_DYNAMODB_ENDPOINT: `http://127.0.0.1:${dynamodbPort}`,
  ADMIN_WEB_ENABLED: "true",
  ADMIN_WEB_LOGIN_TTL_SECONDS: "300",
  ADMIN_WEB_OIDC_CLIENT_ID: oidcClientId,
  ADMIN_WEB_OIDC_CLIENT_SECRET: oidcClientSecret,
  ADMIN_WEB_OIDC_ISSUER: oidcIssuer,
  ADMIN_WEB_OIDC_RESOURCE: oidcAudience,
  ADMIN_WEB_OIDC_SCOPES: "openid profile email",
  ADMIN_WEB_PUBLIC_ORIGIN: webOrigin,
  ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64: sessionEncryptionKeyBase64,
  ADMIN_WEB_SESSION_STORE: "dynamodb",
  ADMIN_WEB_SESSION_TABLE: sessionTable,
  ADMIN_WEB_SESSION_TTL_SECONDS: "3600",
  API_INTERNAL_URL: apiOrigin,
  AWS_ACCESS_KEY_ID: "DUMMYIDEXAMPLE",
  AWS_REGION: "us-west-2",
  AWS_SECRET_ACCESS_KEY: "DUMMYEXAMPLEKEYDUMMYEXAMPLEKEY1234567890",
  GOOGLE_AUTH_ENABLED: "false",
  HOSTNAME: "127.0.0.1",
  MCP_OAUTH_OWNER_CONSENT_ENABLED: "false",
  NEXT_PUBLIC_API_URL: apiOrigin,
  NODE_ENV: "development",
  PORT: String(webPort),
  SSR_ALLOW_MISSING_CLIENT_IP: "true",
  SSR_INTERNAL_REQUEST_SECRET: ssrSecret,
} as const;

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  outputDir: "test-results/admin-moderation-e2e",
  reporter: process.env.CI
    ? [
        ["line"],
        ["html", { open: "never", outputFolder: "playwright-report/admin-moderation" }],
      ]
    : "list",
  retries: 0,
  testDir: "tests/admin-moderation-e2e",
  testMatch: "admin-moderation-flow.spec.ts",
  timeout: 90_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: webOrigin,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "node packages/auth/scripts/admin-oidc-e2e.mjs",
      env: { ...process.env, ...oidcEnvironment },
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 30_000,
      url: `${oidcIssuer.replace(/\/workforce$/u, "")}/health/ready`,
    },
    {
      command: "pnpm --dir apps/api exec tsx --conditions=development src/server.ts",
      env: { ...process.env, ...apiEnvironment },
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 90_000,
      url: `${apiOrigin}/health/ready`,
    },
    {
      command: `pnpm --dir apps/web exec next dev --webpack --hostname 127.0.0.1 --port ${webPort}`,
      cwd: webRuntimeRoot,
      env: { ...process.env, ...webEnvironment },
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 120_000,
      url: `${webOrigin}/health`,
    },
  ],
  workers: 1,
});
