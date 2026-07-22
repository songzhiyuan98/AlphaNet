import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport as McpSdkTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";

import { createApiApp } from "../../apps/api/src/app.js";
import { createPrivateMcpApp } from "../../apps/api/src/private-mcp-app.js";
import { createPrivateMcpTlsIdentityGuard } from "../../apps/api/src/private-mcp-transport.js";
import { createMcpApp, type McpApp } from "../../apps/mcp/src/app.js";
import { createMcpRuntimeAssembly } from "../../apps/mcp/src/runtime-assembly.js";
import {
  createAlphaNetAuthRuntime,
  createMcpActorAssertionKeyRing,
  createRemoteMcpOAuthConsentService,
  RedisMcpActorAssertionReplayStore,
  RedisRateLimitStorage,
  type AlphaNetAuthRuntime,
  type AuthEmail,
} from "../../packages/auth/src/index.js";
import { AgentContextResponseSchema } from "../../packages/contracts/src/index.js";
import {
  createPostgresDependency,
  createRedisDependency,
  type PostgresDependency,
  type RedisDependency,
} from "../../packages/database/src/index.js";
import {
  PostgresCommunityDirectoryService,
  PostgresContentReadService,
  PostgresContentSearchService,
  PostgresFollowService,
  PostgresNotificationService,
  PostgresPendingActionStatusService,
  PostgresReactionWriteService,
  PostgresRemoteMcpAuthorityService,
  PostgresResearchWriteService,
} from "../../packages/domain/src/index.js";
import { createLogger } from "../../packages/observability/src/index.js";
import {
  createRemoteMcpTestPki,
  type RemoteMcpTestPki,
} from "./support/remote-mcp-test-pki.js";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";
const hasConfiguration = Boolean(databaseUrl && redisUrl);

if (mustRun && !hasConfiguration) {
  throw new Error(
    "DATABASE_URL and REDIS_URL are required when REQUIRE_INTEGRATION_SERVICES=true",
  );
}

const describePublicChain = hasConfiguration ? describe : describe.skip;
const host = "127.0.0.1";
const resource = "http://127.0.0.1:4100/mcp";
const webOrigin = "http://127.0.0.1:3101";
const redirectUri = "http://127.0.0.1:43110/oauth/callback";
const sdkToolNames = [
  "get_agent_context",
  "find_communities",
  "get_community",
  "browse_content",
  "search_content",
  "get_content",
  "get_discussion",
  "list_notifications",
  "get_action_status",
  "create_post",
  "reply_to_content",
  "update_content",
  "delete_content",
  "set_reaction",
  "set_follow",
  "list_follows",
] as const;
const logger = createLogger({
  environment: "test",
  level: "silent",
  service: "remote-mcp-public-chain-integration",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function responseRecord(
  response: Response,
  label: string,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = (await response.json()) as unknown;
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
  if (!isRecord(value)) throw new Error(`${label} did not return an object`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} was not returned`);
  }
  return value;
}

function redirectFrom(value: Record<string, unknown>, label: string): URL {
  if (value["redirect"] !== true || typeof value["url"] !== "string") {
    throw new Error(`${label} did not return a redirect`);
  }
  return new URL(value["url"]);
}

function cookieHeader(response: Response): string {
  const headers = response.headers as Headers & {
    getSetCookie?: (() => string[]) | undefined;
  };
  const values = headers.getSetCookie?.() ?? [response.headers.get("set-cookie")];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

async function waitForEmail(
  emails: AuthEmail[],
  predicate: (message: AuthEmail) => boolean,
  timeoutMilliseconds = 5_000,
): Promise<AuthEmail> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const email = emails.find(predicate);
    if (email) return email;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected authentication email was not emitted");
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback TCP port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function listenHttp(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeHttp(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function unpinnedPrivateApiStatus(
  pki: RemoteMcpTestPki,
  port: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = httpsRequest(
      {
        ca: pki.caCertificate,
        cert: pki.unpinnedClientCertificate,
        host,
        key: pki.unpinnedClientPrivateKey,
        method: "GET",
        path: "/internal/mcp/v1/agent/context",
        port,
        rejectUnauthorized: true,
        headers: {
          "x-alphanet-mcp-actor-context": "not-an-assertion",
          "x-request-id": randomUUID(),
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function cleanupFixture(
  runtime: AlphaNetAuthRuntime,
  clientId: string,
  email: string,
): Promise<void> {
  const connection = await runtime.pool.connect();
  try {
    await connection.query("begin");
    const activeAgents = await connection.query<{ count: string }>(
      `select count(*)::text as count
         from platform.agents as agent
         inner join platform.owners as owner on owner.id = agent.owner_id
         inner join auth.users as auth_user on auth_user.id = owner.auth_user_id
        where auth_user.email = $1
          and agent.status = 'active'
          and agent.deleted_at is null`,
      [email],
    );
    const activeAgentCount = BigInt(activeAgents.rows[0]?.count ?? "0");
    if (activeAgentCount > 0n) {
      await connection.query(
        `update platform.registration_controls
            set active_agent_count = greatest(active_agent_count - $1::bigint, 0)
          where id = true`,
        [activeAgentCount.toString()],
      );
    }

    for (const trigger of [
      "platform.credentials disable trigger credentials_prevent_delete",
      "platform.agent_policies disable trigger agent_policies_prevent_delete",
      "platform.agents disable trigger agents_prevent_delete",
      "platform.actors disable trigger actors_prevent_delete",
      "platform.owners disable trigger owners_prevent_delete",
      "platform.action_logs disable trigger action_logs_prevent_mutation",
    ]) {
      await connection.query(`alter table ${trigger}`);
    }

    await connection.query(
      `delete from auth.oauth_access_tokens
        where client_id = $1
           or user_id in (select id from auth.users where email = $2)`,
      [clientId, email],
    );
    await connection.query(
      `delete from auth.oauth_refresh_tokens
        where client_id = $1
           or user_id in (select id from auth.users where email = $2)`,
      [clientId, email],
    );
    await connection.query(
      `delete from auth.oauth_consents
        where client_id = $1
           or user_id in (select id from auth.users where email = $2)`,
      [clientId, email],
    );
    await connection.query(
      `delete from auth.verifications
        where value in (select id::text from auth.users where email = $2)
           or position($1::text in identifier) > 0
           or position($1::text in value) > 0
           or position(lower($2::text) in lower(identifier)) > 0
           or position(lower($2::text) in lower(value)) > 0`,
      [clientId, email],
    );
    await connection.query(
      `with deleted_logs as (
         delete from platform.action_logs
          where owner_id in (
            select owner.id
              from platform.owners as owner
              inner join auth.users as auth_user
                on auth_user.id = owner.auth_user_id
             where auth_user.email = $1
          )
          returning outbox_event_id
       ),
       candidate_events as materialized (
         select event.id
           from system.outbox_events as event
          where event.payload ->> 'oauth_client_id' = $2
             or event.id in (
                  select outbox_event_id
                    from deleted_logs
                   where outbox_event_id is not null
                )
       ),
       deleted_receipts as (
         delete from system.outbox_consumer_receipts
          where event_id in (select id from candidate_events)
          returning event_id
       ),
       deleted_events as (
         delete from system.outbox_events
          where id in (select id from candidate_events)
          returning aggregate_type, aggregate_id
       )
       delete from system.outbox_aggregate_heads as aggregate_head
        using deleted_events as deleted_event
        where aggregate_head.aggregate_type = deleted_event.aggregate_type
          and aggregate_head.aggregate_id = deleted_event.aggregate_id`,
      [email, clientId],
    );
    await connection.query(
      `delete from platform.oauth_access_token_jtis
        where oauth_client_id = $1
           or grant_id in (
                select id from platform.oauth_grants where oauth_client_id = $1
              )`,
      [clientId],
    );
    await connection.query(
      `with deleted_grants as (
         delete from platform.oauth_grants
          where oauth_client_id = $1
          returning authorization_request_id
       )
       delete from platform.oauth_authorization_requests
        where oauth_client_id = $1
           or id in (select authorization_request_id from deleted_grants)`,
      [clientId],
    );
    for (const table of ["credentials", "agent_policies", "agents"] as const) {
      const relation = `platform.${table}`;
      const column = table === "agents" ? "owner_id" : "agent_id";
      const subquery =
        column === "owner_id"
          ? `select owner.id
               from platform.owners as owner
               inner join auth.users as auth_user
                 on auth_user.id = owner.auth_user_id
              where auth_user.email = $1`
          : `select agent.id
               from platform.agents as agent
               inner join platform.owners as owner on owner.id = agent.owner_id
               inner join auth.users as auth_user on auth_user.id = owner.auth_user_id
              where auth_user.email = $1`;
      await connection.query(`delete from ${relation} where ${column} in (${subquery})`, [
        email,
      ]);
    }
    await connection.query(
      `delete from platform.actors
        where owner_id in (
          select owner.id
            from platform.owners as owner
            inner join auth.users as auth_user on auth_user.id = owner.auth_user_id
           where auth_user.email = $1
        )`,
      [email],
    );
    await connection.query(
      `delete from platform.owners
        where auth_user_id in (select id from auth.users where email = $1)`,
      [email],
    );
    await connection.query("delete from auth.users where email = $1", [email]);
    await connection.query("delete from auth.oauth_clients where client_id = $1", [
      clientId,
    ]);

    const remaining = await connection.query<{
      access_tokens: number;
      auth_users: number;
      clients: number;
      consents: number;
      grants: number;
      jtis: number;
      outbox_events: number;
      owners: number;
      refresh_tokens: number;
      requests: number;
      verifications: number;
    }>(
      `select
         (select count(*)::integer from auth.users where email = $2)
           as auth_users,
         (select count(*)::integer
            from auth.oauth_clients where client_id = $1) as clients,
         (select count(*)::integer
            from auth.oauth_access_tokens where client_id = $1)
           as access_tokens,
         (select count(*)::integer
            from auth.oauth_refresh_tokens where client_id = $1)
           as refresh_tokens,
         (select count(*)::integer
            from auth.oauth_consents where client_id = $1) as consents,
         (select count(*)::integer
            from auth.verifications
           where position($1::text in identifier) > 0
              or position($1::text in value) > 0
              or position(lower($2::text) in lower(identifier)) > 0
              or position(lower($2::text) in lower(value)) > 0)
           as verifications,
         (select count(*)::integer
            from platform.oauth_grants where oauth_client_id = $1) as grants,
         (select count(*)::integer
            from platform.oauth_authorization_requests
           where oauth_client_id = $1) as requests,
         (select count(*)::integer
            from platform.oauth_access_token_jtis
           where oauth_client_id = $1) as jtis,
         (select count(*)::integer
            from platform.owners where email = $2) as owners,
         (select count(*)::integer
            from system.outbox_events
           where payload ->> 'oauth_client_id' = $1) as outbox_events`,
      [clientId, email],
    );
    const remainingCounts = remaining.rows[0];
    if (!remainingCounts || Object.values(remainingCounts).some((count) => count !== 0)) {
      throw new Error("Remote MCP public-chain PostgreSQL fixture cleanup failed");
    }

    for (const trigger of [
      "platform.action_logs enable trigger action_logs_prevent_mutation",
      "platform.owners enable trigger owners_prevent_delete",
      "platform.actors enable trigger actors_prevent_delete",
      "platform.agents enable trigger agents_prevent_delete",
      "platform.agent_policies enable trigger agent_policies_prevent_delete",
      "platform.credentials enable trigger credentials_prevent_delete",
    ]) {
      await connection.query(`alter table ${trigger}`);
    }
    await connection.query("commit");
  } catch (error) {
    await connection.query("rollback");
    throw error;
  } finally {
    connection.release();
  }
}

async function captureTeardown(
  failures: unknown[],
  operation: () => Promise<void> | void,
): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error) {
    failures.push(error);
    return false;
  }
}

describePublicChain("Remote MCP full public chain", () => {
  it(
    "runs OAuth, SDK, mTLS, replay protection, PostgreSQL authority, and revocation",
    { timeout: 60_000 },
    async () => {
      const marker = randomUUID().replaceAll("-", "").slice(0, 16);
      const clientId = `public-chain-${marker}`;
      const email = `public-chain-${marker}@example.test`;
      const password = "Public-chain-integration-password-2026!";
      const state = `state-${randomUUID()}`;
      const codeVerifier = randomBytes(32).toString("base64url");
      const codeChallenge = createHash("sha256")
        .update(codeVerifier, "ascii")
        .digest("base64url");
      const authorizationBindingKey = randomBytes(32);
      const continuationKey = randomBytes(32);
      const jwkEncryptionKey = createHash("sha256")
        .update("AlphaNet Remote MCP OAuth live HTTP integration JWK key v1", "utf8")
        .digest();
      const tokenJtiDigestKey = randomBytes(32);
      const tokenStorageKey = randomBytes(32);
      const actorAssertionKey = randomBytes(32);
      const replayDigestKey = randomBytes(32);
      const testRedisKeyPrefix = `alphanet:test:public-chain:${marker}:`;
      const replayKeyPrefix = `${testRedisKeyPrefix}assertion:`;
      const emails: AuthEmail[] = [];
      const authPort = await reserveLoopbackPort();
      const baseUrl = `http://${host}:${authPort}`;
      const issuer = `${baseUrl}/api/auth`;
      const jwksUrl = `${issuer}/jwks`;
      const pki = createRemoteMcpTestPki();
      let runtime: AlphaNetAuthRuntime | undefined;
      let apiApp: Awaited<ReturnType<typeof createApiApp>> | undefined;
      let postgres: PostgresDependency | undefined;
      let redis: RedisDependency | undefined;
      let privateApp: Awaited<ReturnType<typeof createPrivateMcpApp>> | undefined;
      let mcpApp: McpApp | undefined;
      let mcpServer: Server | undefined;
      let sdkClient: Client | undefined;
      let bodyFailed = false;
      let bodyFailure: unknown;

      try {
        postgres = createPostgresDependency(databaseUrl ?? "");
        redis = createRedisDependency(redisUrl ?? "", { critical: true });
        await Promise.all([postgres.check(), redis.check()]);

        runtime = createAlphaNetAuthRuntime(
          {
            baseUrl,
            databasePoolMax: 4,
            databaseUrl: databaseUrl ?? "",
            email: { mode: "local-preview" },
            emailDailyGlobalLimit: 10_000,
            redisUrl: redisUrl ?? "",
            remoteMcpOAuth: {
              authorizationBindingKey,
              continuationKey,
              issuer,
              jwksUrl,
              jwkEncryptionKey,
              resource,
              tokenJtiDigestKey,
              tokenStorageKey,
            },
            secret: `integration-only-${randomBytes(32).toString("base64url")}`,
            secureCookies: false,
            trustedOrigins: [webOrigin],
          },
          {
            emailSender: {
              send: (message) => {
                emails.push(message);
                return Promise.resolve();
              },
            },
            logger: { error: () => undefined, info: () => undefined },
          },
        );
        await runtime.pool.query(
          `insert into platform.oauth_resource_configuration (id, resource)
           values (true, $1::text)
           on conflict (id) do nothing`,
          [resource],
        );
        const configuredResource = await runtime.pool.query<{ resource: string }>(
          `select resource
             from platform.oauth_resource_configuration
            where id = true`,
        );
        expect(configuredResource.rows).toEqual([{ resource }]);

        apiApp = await createApiApp({
          allowedOrigins: [webOrigin],
          authRuntime: runtime,
          environment: "test",
          remoteMcpOAuthConsent: {
            resource,
            service: createRemoteMcpOAuthConsentService(runtime.pool, {
              authorizationBindingKey,
              continuationKey,
            }),
          },
          version: "integration",
        });
        await apiApp.listen({ host, port: authPort });

        const cursorKey = createHmac("sha256", randomBytes(32))
          .update("public-chain-cursor", "utf8")
          .digest();
        const communityDirectoryService = new PostgresCommunityDirectoryService(
          postgres.sql,
          { cursorSigningKey: cursorKey },
        );
        const contentReadService = new PostgresContentReadService(postgres.sql, {
          cursorSigningKey: createHmac("sha256", cursorKey)
            .update("content-read", "utf8")
            .digest(),
        });
        const contentSearchService = new PostgresContentSearchService(postgres.sql, {
          activityDigestKey: createHmac("sha256", cursorKey)
            .update("content-search-activity", "utf8")
            .digest(),
          cursorSigningKey: createHmac("sha256", cursorKey)
            .update("content-search-cursor", "utf8")
            .digest(),
          embeddingProvider: null,
        });
        const followService = new PostgresFollowService(postgres.sql, {
          cursorSigningKey: createHmac("sha256", cursorKey)
            .update("follow", "utf8")
            .digest(),
        });
        const notificationService = new PostgresNotificationService(postgres.sql, {
          cursorSigningKey: createHmac("sha256", cursorKey)
            .update("notification", "utf8")
            .digest(),
        });
        const pendingActionStatusService = new PostgresPendingActionStatusService(
          postgres.sql,
        );
        const reactionWriteService = new PostgresReactionWriteService(postgres.sql);
        const researchWriteService = new PostgresResearchWriteService(postgres.sql, {
          pendingActionKeyRing: {
            currentVersion: 1,
            keys: { 1: randomBytes(32) },
          },
        });
        const actorAssertionKeyRing = createMcpActorAssertionKeyRing({
          currentKey: actorAssertionKey,
          currentVersion: 1,
        });
        const privateRateLimiter = new RedisRateLimitStorage(
          redis.client,
          `${testRedisKeyPrefix}private-rate:`,
        );
        privateApp = await createPrivateMcpApp({
          actorAuthenticator: {
            authority: new PostgresRemoteMcpAuthorityService(postgres.sql),
            keyRing: actorAssertionKeyRing,
            replayStore: new RedisMcpActorAssertionReplayStore(redis.client, {
              digestKey: replayDigestKey,
              keyPrefix: replayKeyPrefix,
            }),
          },
          communityDirectoryService,
          contentReadService,
          contentSearchService,
          followService,
          logger,
          notificationService,
          pendingActionStatusService,
          rateLimiter: privateRateLimiter,
          reactionWriteService,
          researchWriteService,
          serverFactory: (handler) =>
            createHttpsServer(
              {
                ca: pki.caCertificate,
                cert: pki.serverCertificate,
                honorCipherOrder: true,
                key: pki.serverPrivateKey,
                minVersion: "TLSv1.2",
                rejectUnauthorized: true,
                requestCert: true,
              },
              handler,
            ),
          transportIdentityGuard: createPrivateMcpTlsIdentityGuard({
            allowedClientCertificateFingerprints: [pki.clientFingerprintSha256],
          }),
        });
        await privateApp.listen({ host, port: 0 });
        const privateAddress = privateApp.server.address();
        if (!privateAddress || typeof privateAddress === "string") {
          throw new Error("Private MCP API did not expose a TCP address");
        }

        const mcpRuntime = createMcpRuntimeAssembly(
          {
            MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64: tokenJtiDigestKey,
            MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64: actorAssertionKey,
            MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION: 1,
            MCP_ACTOR_ASSERTION_PREVIOUS_KEYS: {},
            MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64: pki.clientCertificate,
            MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64: pki.clientPrivateKey,
            MCP_INTERNAL_API_MAX_RESPONSE_BYTES: 4 * 1_024 * 1_024,
            MCP_INTERNAL_API_SERVER_CA_PEM_BASE64: pki.caCertificate,
            MCP_INTERNAL_API_TIMEOUT_MS: 15_000,
            MCP_INTERNAL_API_URL: `https://${host}:${privateAddress.port}`,
            MCP_OAUTH_ISSUER: issuer,
            MCP_OAUTH_JWKS_URI: jwksUrl,
            MCP_RESOURCE: resource,
            MCP_RUNTIME_ENABLED: true,
          },
          redis.client,
        );
        if (!mcpRuntime.runtimeEnabled) {
          throw new Error("Remote MCP runtime did not enable");
        }
        mcpApp = createMcpApp({
          ...mcpRuntime,
          allowedHosts: [host],
          host,
          logger,
          resolveClientIp: () => host,
          version: "integration",
        });
        mcpServer = createHttpServer(mcpApp.app);
        // This fixed resource is part of the OAuth audience contract. If another
        // process owns it the test fails closed; it never terminates that process.
        await listenHttp(mcpServer, 4100);

        const noBearer = await fetch(resource, {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              capabilities: {},
              clientInfo: { name: "missing-bearer", version: "1.0.0" },
              protocolVersion: "2025-11-25",
            },
          }),
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          method: "POST",
        });
        expect(noBearer.status).toBe(401);
        expect(noBearer.headers.get("www-authenticate")).toContain("Bearer");
        await noBearer.arrayBuffer();

        await runtime.pool.query(
          `insert into auth.oauth_clients (
             client_id, disabled, skip_consent, scopes, created_at, updated_at,
             name, redirect_uris, token_endpoint_auth_method, grant_types,
             response_types, public, require_pkce
           ) values (
             $1::text, false, false, '["research:read"]'::jsonb,
             clock_timestamp(), clock_timestamp(),
             'AlphaNet public-chain integration client', $2::jsonb, 'none',
             '["authorization_code"]'::jsonb, '["code"]'::jsonb, true, true
           )`,
          [clientId, JSON.stringify([redirectUri])],
        );

        const registration = await fetch(`${issuer}/sign-up/email`, {
          body: JSON.stringify({
            email,
            name: "Remote MCP public-chain Owner",
            password,
          }),
          headers: { "content-type": "application/json", origin: webOrigin },
          method: "POST",
        });
        expect(registration.status).toBe(200);
        await registration.arrayBuffer();
        const verificationEmail = await waitForEmail(
          emails,
          (message) => message.purpose === "verification" && message.recipient === email,
        );
        const verification = await fetch(verificationEmail.actionUrl, {
          redirect: "manual",
        });
        expect(verification.status).toBe(302);
        await verification.arrayBuffer();

        const signIn = await fetch(`${issuer}/sign-in/email`, {
          body: JSON.stringify({ email, password }),
          headers: { "content-type": "application/json", origin: webOrigin },
          method: "POST",
        });
        expect(signIn.status).toBe(200);
        const sessionCookie = cookieHeader(signIn);
        expect(sessionCookie).toContain("alphanet.session_token=");
        await signIn.arrayBuffer();

        const owner = await runtime.pool.query<{ owner_id: string }>(
          `select platform_owner.id::text as owner_id
             from auth.users as auth_user
             inner join platform.owners as platform_owner
               on platform_owner.auth_user_id = auth_user.id
            where auth_user.email = $1`,
          [email],
        );
        const ownerId = requiredString(owner.rows[0]?.owner_id, "Owner id");
        const actorId = randomUUID();
        const agentId = randomUUID();
        const setup = await runtime.pool.connect();
        try {
          await setup.query("begin");
          await setup.query(
            `insert into platform.actors (
               id, kind, owner_id, handle, display_name, status
             ) values ($1::uuid, 'agent', $2::uuid, $3::text,
               'Public Chain Research Agent', 'active')`,
            [actorId, ownerId, `public-chain-${marker}`],
          );
          await setup.query(
            `insert into platform.agents (
               id, actor_id, owner_id, discovery_tags, status, activated_at
             ) values ($1::uuid, $2::uuid, $3::uuid,
               array['public-chain']::text[], 'active', clock_timestamp())`,
            [agentId, actorId, ownerId],
          );
          await setup.query(
            `insert into platform.agent_policies (
               agent_id, tier, defaults_version, policy_schema_version, version,
               rules, is_active, configured_by_owner_id
             ) values ($1::uuid, 'assisted', 'agent-permission-defaults-v1',
               1, 1, '{}'::jsonb, true, $2::uuid)`,
            [agentId, ownerId],
          );
          await setup.query(
            `update platform.registration_controls
                set active_agent_count = active_agent_count + 1
              where id = true`,
          );
          await setup.query("commit");
        } catch (error) {
          await setup.query("rollback");
          throw error;
        } finally {
          setup.release();
        }

        const authorizeParameters = new URLSearchParams({
          client_id: clientId,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          redirect_uri: redirectUri,
          resource,
          response_type: "code",
          scope: "research:read",
          state,
        });
        const authorize = await fetch(
          `${issuer}/oauth2/authorize?${authorizeParameters}`,
          {
            headers: { accept: "application/json", cookie: sessionCookie },
          },
        );
        expect(authorize.status).toBe(200);
        const postLoginRedirect = redirectFrom(
          await responseRecord(authorize, "authorize"),
          "authorize",
        );
        expect(postLoginRedirect.pathname).toBe("/oauth/consent");
        const postLoginQuery = postLoginRedirect.search.slice(1);
        const mutationHeaders = {
          "content-type": "application/json",
          cookie: sessionCookie,
          origin: webOrigin,
          "sec-fetch-site": "same-origin",
        };

        const select = await fetch(
          `${baseUrl}/v1/owner/remote-mcp/oauth/consent/select-agent`,
          {
            body: JSON.stringify({ agent_id: agentId, oauth_query: postLoginQuery }),
            headers: mutationHeaders,
            method: "POST",
          },
        );
        expect(select.status).toBe(200);
        const selection = await responseRecord(select, "consent selection");
        const continuationHandle = requiredString(
          selection["continuation_handle"],
          "OAuth continuation",
        );

        const continuation = await fetch(`${issuer}/oauth2/continue`, {
          body: JSON.stringify({ oauth_query: postLoginQuery, postLogin: true }),
          headers: {
            ...mutationHeaders,
            accept: "application/json",
            "x-alphanet-oauth-continuation": continuationHandle,
          },
          method: "POST",
        });
        expect(continuation.status).toBe(200);
        const consentRedirect = redirectFrom(
          await responseRecord(continuation, "continued authorization"),
          "continued authorization",
        );
        const consentQuery = consentRedirect.search.slice(1);

        const consent = await fetch(`${issuer}/oauth2/consent`, {
          body: JSON.stringify({ accept: true, oauth_query: consentQuery }),
          headers: {
            ...mutationHeaders,
            accept: "application/json",
            "x-alphanet-oauth-continuation": continuationHandle,
          },
          method: "POST",
        });
        expect(consent.status).toBe(200);
        const clientRedirect = redirectFrom(
          await responseRecord(consent, "consent acceptance"),
          "consent acceptance",
        );
        expect(clientRedirect.searchParams.get("state")).toBe(state);
        const authorizationCode = requiredString(
          clientRedirect.searchParams.get("code"),
          "Authorization code",
        );

        const tokenResponse = await fetch(`${issuer}/oauth2/token`, {
          body: new URLSearchParams({
            client_id: clientId,
            code: authorizationCode,
            code_verifier: codeVerifier,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
            resource,
          }),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
        expect(tokenResponse.status).toBe(200);
        const tokenResult = await responseRecord(tokenResponse, "token endpoint");
        expect(tokenResult).toMatchObject({
          expires_in: 600,
          scope: "research:read",
          token_type: "Bearer",
        });
        const accessToken = requiredString(tokenResult["access_token"], "Access token");

        expect(await unpinnedPrivateApiStatus(pki, privateAddress.port)).toBe(401);

        const transport = new StreamableHTTPClientTransport(new URL(resource), {
          requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
        });
        sdkClient = new Client(
          { name: "alphanet-public-chain-integration", version: "1.0.0" },
          { capabilities: {} },
        );
        // SDK 1.29's concrete client transport accessors include undefined;
        // its exact-optional Transport interface expresses the same runtime
        // contract differently, so keep the adapter at this one SDK boundary.
        await sdkClient.connect(transport as unknown as McpSdkTransport);
        const tools = await sdkClient.listTools();
        expect(tools.tools.map((tool) => tool.name)).toEqual(sdkToolNames);

        const contextResult = await sdkClient.callTool({
          arguments: {},
          name: "get_agent_context",
        });
        expect(contextResult.isError).not.toBe(true);
        const context = AgentContextResponseSchema.parse(contextResult.structuredContent);
        expect(context.agent).toMatchObject({ id: agentId, actor_id: actorId });
        expect(context.owner.id).toBe(ownerId);
        expect(context.credential).toMatchObject({
          audience: resource,
          scopes: ["research:read"],
        });
        expect(await redis.client.keys(`${replayKeyPrefix}*`)).toHaveLength(1);

        const revoke = await fetch(`${issuer}/oauth2/revoke`, {
          body: new URLSearchParams({
            client_id: clientId,
            token: accessToken,
            token_type_hint: "access_token",
          }),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
        expect(revoke.status).toBe(200);
        await revoke.arrayBuffer();

        const rejectedAfterRevocation = await sdkClient.callTool({
          arguments: {},
          name: "get_agent_context",
        });
        expect(rejectedAfterRevocation.isError).toBe(true);
        expect(rejectedAfterRevocation.structuredContent).toMatchObject({
          error: { code: "REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED" },
        });
        expect(await redis.client.keys(`${replayKeyPrefix}*`)).toHaveLength(2);
        const revokedAuthority = await runtime.pool.query<{
          credential_revoked: boolean;
          grant_status: string;
          jti_status: string;
        }>(
          `select oauth_grant.status as grant_status,
                  credential.revoked_at is not null as credential_revoked,
                  token_jti.status as jti_status
             from platform.oauth_grants as oauth_grant
             inner join platform.credentials as credential
               on credential.id = oauth_grant.credential_id
             inner join platform.oauth_access_token_jtis as token_jti
               on token_jti.grant_id = oauth_grant.id
            where oauth_grant.oauth_client_id = $1`,
          [clientId],
        );
        expect(revokedAuthority.rows).toEqual([
          {
            credential_revoked: true,
            grant_status: "revoked",
            jti_status: "revoked",
          },
        ]);
      } catch (error) {
        bodyFailed = true;
        bodyFailure = error;
      }

      const teardownFailures: unknown[] = [];
      await captureTeardown(teardownFailures, async () => {
        await sdkClient?.close();
      });
      await captureTeardown(teardownFailures, () => mcpApp?.beginShutdown());
      await captureTeardown(teardownFailures, async () => closeHttp(mcpServer));
      await captureTeardown(teardownFailures, async () => {
        await mcpApp?.close();
      });
      await captureTeardown(teardownFailures, async () => {
        await privateApp?.close();
      });
      const liveRuntime = runtime;
      if (liveRuntime) {
        await captureTeardown(teardownFailures, async () => {
          await cleanupFixture(liveRuntime, clientId, email);
        });
      }
      const liveApiApp = apiApp;
      const apiClosed = await captureTeardown(teardownFailures, async () => {
        await liveApiApp?.close();
      });
      if ((!liveApiApp || !apiClosed) && liveRuntime) {
        await captureTeardown(teardownFailures, async () => liveRuntime.close());
      }
      const liveRedis = redis;
      if (liveRedis) {
        await captureTeardown(teardownFailures, async () => {
          const integrationKeys = await liveRedis.client.keys(`${testRedisKeyPrefix}*`);
          if (integrationKeys.length > 0) {
            await liveRedis.client.del(...integrationKeys);
          }
          const remainingKeys = await liveRedis.client.keys(`${testRedisKeyPrefix}*`);
          if (remainingKeys.length !== 0) {
            throw new Error("Remote MCP public-chain Redis fixture cleanup failed");
          }
        });
        await captureTeardown(teardownFailures, async () => liveRedis.close());
      }
      await captureTeardown(teardownFailures, async () => {
        await postgres?.close();
      });
      await captureTeardown(teardownFailures, () => pki.close());

      if (teardownFailures.length > 0) {
        throw new AggregateError(
          bodyFailed ? [bodyFailure, ...teardownFailures] : teardownFailures,
          "Remote MCP public-chain teardown failed",
        );
      }
      if (bodyFailed) throw bodyFailure;
    },
  );
});
