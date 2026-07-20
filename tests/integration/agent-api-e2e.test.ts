import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  createAlphaNetAuthRuntime,
  RedisRateLimitStorage,
  type AlphaNetAuthRuntime,
  type AuthEmail,
} from "../../packages/auth/src/index.js";
import {
  closeDependencies,
  createPostgresDependency,
  createRedisDependency,
  type PostgresDependency,
  type RedisDependency,
} from "../../packages/database/src/index.js";
import { PostgresAgentConnectionService } from "../../packages/domain/src/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiApp } from "../../apps/api/src/app.js";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";
const hasConfiguration = Boolean(databaseUrl && redisUrl);

if (mustRun && !hasConfiguration) {
  throw new Error(
    "DATABASE_URL and REDIS_URL are required when REQUIRE_INTEGRATION_SERVICES=true",
  );
}

const describeCredentialE2e = hasConfiguration ? describe : describe.skip;
const apiOrigin = "http://localhost:4000";
const webOrigin = "http://localhost:3000";
const apiKeyPepper =
  "agent-api-e2e-pepper-is-public-test-data-and-never-used-in-production";

function responseCookies(response: unknown): string {
  const raw = (
    response as {
      headers: Record<string, string | string[] | undefined>;
    }
  ).headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return values
    .map((cookie) => cookie.split(";", 1)[0])
    .filter((cookie): cookie is string => Boolean(cookie))
    .join("; ");
}

describeCredentialE2e("Agent credential HTTP E2E", () => {
  const emails: AuthEmail[] = [];
  let app: Awaited<ReturnType<typeof createApiApp>>;
  let authRuntime: AlphaNetAuthRuntime;
  let postgres: PostgresDependency;
  let redis: RedisDependency;

  beforeAll(async () => {
    postgres = createPostgresDependency(databaseUrl ?? "");
    redis = createRedisDependency(redisUrl ?? "", { critical: true });
    await redis.check();

    authRuntime = createAlphaNetAuthRuntime(
      {
        baseUrl: apiOrigin,
        databasePoolMax: 3,
        databaseUrl: databaseUrl ?? "",
        email: { mode: "local-preview" },
        emailDailyGlobalLimit: 10_000,
        redisUrl: redisUrl ?? "",
        secret: "agent-api-e2e-auth-secret-is-public-test-data-and-never-production",
        secureCookies: false,
        trustedOrigins: [webOrigin],
      },
      {
        emailSender: {
          send(message) {
            emails.push(message);
            return Promise.resolve();
          },
        },
        logger: {
          error: () => undefined,
          info: () => undefined,
        },
      },
    );

    const service = new PostgresAgentConnectionService(postgres.sql, {
      activeCredentialsPerAgent: 5,
      activeCredentialsPerOwner: 20,
      apiAudience: "urn:alphanet:api:v1",
      apiKeyCurrentPepperVersion: 1,
      apiKeyPeppers: { 1: apiKeyPepper },
      credentialDefaultTtlDays: 90,
      credentialIssuePerOwner24Hours: 10,
      credentialMaxTtlDays: 365,
      credentialMutationCooldownSeconds: 0,
    });
    const rateLimiter = new RedisRateLimitStorage(
      redis.client,
      `alphanet:test:agent-api-e2e:${randomUUID()}:`,
    );

    app = await createApiApp({
      allowedOrigins: [webOrigin],
      agentConnectionService: service,
      agentRateLimiter: rateLimiter,
      authRuntime,
      dependencies: [postgres, redis],
      environment: "test",
      version: "agent-api-e2e",
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      return;
    }
    await authRuntime?.close();
    await closeDependencies([postgres, redis].filter(Boolean));
  });

  async function waitForVerificationEmail(recipient: string): Promise<AuthEmail> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const email = emails.find(
        (candidate) =>
          candidate.purpose === "verification" && candidate.recipient === recipient,
      );
      if (email) {
        return email;
      }
      await delay(10);
    }
    throw new Error("Timed out waiting for the Agent E2E verification email");
  }

  it("registers an Owner and enforces the full issue, rotate, and revoke lifecycle", async () => {
    const marker = randomUUID().replaceAll("-", "");
    const clientIp = `2001:db8:${marker.slice(0, 4)}:${marker.slice(4, 8)}::1`;
    const email = `agent-api-e2e-${marker}@example.test`;
    const password = "Agent-api-e2e-password-2026!";

    const registration = await app.inject({
      headers: { origin: webOrigin },
      method: "POST",
      payload: {
        callbackURL: `${webOrigin}/verify-email?verified=1`,
        email,
        name: "Agent API E2E Owner",
        password,
      },
      remoteAddress: clientIp,
      url: "/api/auth/sign-up/email",
    });
    expect(registration.statusCode).toBe(200);

    const verificationEmail = await waitForVerificationEmail(email);
    const verificationUrl = new URL(verificationEmail.actionUrl);
    const verification = await app.inject({
      method: "GET",
      remoteAddress: clientIp,
      url: `${verificationUrl.pathname}${verificationUrl.search}`,
    });
    expect(verification.statusCode).toBe(302);

    const signIn = await app.inject({
      headers: { origin: webOrigin },
      method: "POST",
      payload: {
        callbackURL: `${webOrigin}/home`,
        email,
        password,
        rememberMe: true,
      },
      remoteAddress: clientIp,
      url: "/api/auth/sign-in/email",
    });
    expect(signIn.statusCode).toBe(200);
    const ownerCookie = responseCookies(signIn);
    expect(ownerCookie).toContain("alphanet.session_token=");

    const ownerMutationHeaders = {
      cookie: ownerCookie,
      origin: webOrigin,
      "sec-fetch-site": "same-origin",
    };
    const created = await app.inject({
      headers: ownerMutationHeaders,
      method: "POST",
      payload: {
        display_name: "Credential E2E Agent",
        handle: `credential-e2e-${marker.slice(0, 10)}`,
      },
      url: "/v1/owner/agents",
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json();
    const agentId = createdBody.agent?.id as string | undefined;
    expect(agentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const issued = await app.inject({
      headers: ownerMutationHeaders,
      method: "POST",
      payload: {
        name: "E2E research workflow",
        scopes: ["research:read", "actions:read"],
      },
      url: `/v1/owner/agents/${agentId}/credentials`,
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.headers["cache-control"]).toBe("no-store, private");
    const issuedBody = issued.json();
    const firstKey = issuedBody.api_key as string;
    const firstCredentialId = issuedBody.credential?.id as string;
    expect(firstKey).toMatch(/^aln_v1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/);

    const context = await app.inject({
      headers: { authorization: `Bearer ${firstKey}` },
      method: "GET",
      url: "/v1/agent/context",
    });
    expect(context.statusCode).toBe(200);
    expect(context.headers["cache-control"]).toBe("no-store, private");
    expect(context.json()).toMatchObject({
      agent: { id: agentId },
      credential: {
        id: firstCredentialId,
        scopes: ["research:read", "actions:read"],
      },
      effective_capabilities: {
        get_agent_context: { available: true, default_decision: "allow" },
      },
      schema_version: "1",
    });

    const ownerApiWithAgentKey = await app.inject({
      headers: { authorization: `Bearer ${firstKey}` },
      method: "GET",
      url: "/v1/owner/agents",
    });
    expect(ownerApiWithAgentKey.statusCode).toBe(401);

    const rotated = await app.inject({
      headers: ownerMutationHeaders,
      method: "POST",
      payload: {},
      url: `/v1/owner/credentials/${firstCredentialId}/rotate`,
    });
    expect(rotated.statusCode).toBe(201);
    const rotatedBody = rotated.json();
    const replacementKey = rotatedBody.api_key as string;
    expect(replacementKey).not.toBe(firstKey);

    const oldContext = await app.inject({
      headers: { authorization: `Bearer ${firstKey}` },
      method: "GET",
      url: "/v1/agent/context",
    });
    expect(oldContext.statusCode).toBe(401);
    expect(oldContext.json()).toMatchObject({
      error: { code: "INVALID_CREDENTIAL" },
    });

    const replacementContext = await app.inject({
      headers: { authorization: `Bearer ${replacementKey}` },
      method: "GET",
      url: "/v1/agent/context",
    });
    expect(replacementContext.statusCode).toBe(200);
    const replacementCredentialId = rotatedBody.credential?.id as string;

    const revoked = await app.inject({
      headers: ownerMutationHeaders,
      method: "DELETE",
      url: `/v1/owner/credentials/${replacementCredentialId}`,
    });
    expect(revoked.statusCode).toBe(200);
    const revokedContext = await app.inject({
      headers: { authorization: `Bearer ${replacementKey}` },
      method: "GET",
      url: "/v1/agent/context",
    });
    expect(revokedContext.statusCode).toBe(401);
    expect(revokedContext.json()).toMatchObject({
      error: { code: "INVALID_CREDENTIAL" },
    });

    const list = await app.inject({
      headers: { cookie: ownerCookie },
      method: "GET",
      url: `/v1/owner/credentials?agent_id=${agentId}`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(firstKey);
    expect(list.body).not.toContain(replacementKey);
    expect(list.json().credentials).toHaveLength(2);

    await expect(
      postgres.sql`
        update platform.actors
        set handle = 'Invalid Handle'
        where id = ${createdBody.agent.actor_id as string}
      `,
    ).rejects.toThrow();
    await expect(
      postgres.sql`
        update platform.credentials
        set scopes = ARRAY[]::text[]
        where id = ${replacementCredentialId}
      `,
    ).rejects.toThrow();
  });
});
