import { createHmac } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";

import {
  createAlphaNetAuthRuntime,
  createMcpActorAssertionKeyRing,
  createOidcJwtVerifier,
  createRemoteMcpOAuthConsentService,
  RedisMcpActorAssertionReplayStore,
  RedisRateLimitStorage,
  type AlphaNetAuthRuntime,
  type AlphaNetEmailDeliveryConfig,
} from "@alphanet/auth";
import { loadApiEnvironment, parseCorsOrigins } from "@alphanet/config";
import {
  closeDependencies,
  createPostgresDependency,
  createRedisDependency,
  type HealthDependency,
} from "@alphanet/database";
import {
  PostgresAgentConnectionService,
  BedrockTitanV2EmbeddingProvider,
  PostgresCommunityDirectoryService,
  PostgresContentModerationService,
  PostgresContentReadService,
  PostgresContentReportService,
  PostgresContentSearchService,
  PostgresFollowService,
  PostgresNotificationService,
  PostgresOwnerPendingActionService,
  PostgresPendingActionStatusService,
  PostgresReactionWriteService,
  PostgresRemoteMcpAuthorityService,
  PostgresResearchWriteService,
} from "@alphanet/domain";
import { AwsBedrockInvokeModelTransport } from "@alphanet/integrations";
import { createLogger } from "@alphanet/observability";

import { createApiApp } from "./app.js";
import {
  PostgresAdminAuthorizationRepository,
  PostgresAdminSecurityAudit,
} from "./admin-postgres.js";
import type { AdminRequestRuntime } from "./admin-request.js";
import { createPrivateMcpApp } from "./private-mcp-app.js";
import { createPrivateMcpTlsIdentityGuard } from "./private-mcp-transport.js";
import { createSearchIndexContractDependency } from "./search-readiness.js";

async function start(): Promise<void> {
  const environment = loadApiEnvironment();
  const logger = createLogger({
    service: "api",
    environment: environment.NODE_ENV,
    level: environment.LOG_LEVEL,
  });
  const postgres = createPostgresDependency(environment.DATABASE_URL);
  const redis = createRedisDependency(environment.REDIS_URL, { critical: true });
  const dependencies: HealthDependency[] = [postgres, redis];
  dependencies.push(
    createSearchIndexContractDependency(
      postgres.sql,
      `${environment.SEARCH_EMBEDDING_MODEL_ID}:${environment.SEARCH_EMBEDDING_DIMENSIONS}`,
    ),
  );
  const bedrockTransport =
    environment.SEARCH_EMBEDDING_PROVIDER === "bedrock"
      ? new AwsBedrockInvokeModelTransport()
      : null;
  if (bedrockTransport) {
    dependencies.push({
      critical: false,
      name: "bedrock-runtime-client",
      check: () => Promise.resolve(),
      close: () => {
        bedrockTransport.destroy();
        return Promise.resolve();
      },
    });
  }
  const searchEmbeddingProvider = bedrockTransport
    ? new BedrockTitanV2EmbeddingProvider(bedrockTransport, {
        dimensions: environment.SEARCH_EMBEDDING_DIMENSIONS,
        modelId: environment.SEARCH_EMBEDDING_MODEL_ID,
        normalize: true,
        timeoutMilliseconds: environment.SEARCH_EMBEDDING_TIMEOUT_MS,
      })
    : null;
  const agentConnectionService = new PostgresAgentConnectionService(postgres.sql, {
    activeCredentialsPerAgent: environment.AGENT_CREDENTIAL_ACTIVE_PER_AGENT,
    activeCredentialsPerOwner: environment.AGENT_CREDENTIAL_ACTIVE_PER_OWNER,
    apiAudience: environment.AGENT_API_AUDIENCE,
    apiKeyCurrentPepperVersion: environment.AGENT_API_KEY_PEPPER_VERSION,
    apiKeyPeppers: {
      ...environment.AGENT_API_KEY_PREVIOUS_PEPPERS,
      [environment.AGENT_API_KEY_PEPPER_VERSION]: environment.AGENT_API_KEY_PEPPER,
    },
    credentialDefaultTtlDays: environment.AGENT_CREDENTIAL_DEFAULT_TTL_DAYS,
    credentialIssuePerOwner24Hours: environment.AGENT_CREDENTIAL_ISSUE_PER_OWNER_24H,
    credentialMaxTtlDays: environment.AGENT_CREDENTIAL_MAX_TTL_DAYS,
    credentialMutationCooldownSeconds:
      environment.AGENT_CREDENTIAL_MUTATION_COOLDOWN_SECONDS,
  });
  const communityDirectoryService = new PostgresCommunityDirectoryService(postgres.sql, {
    cursorSigningKey: Buffer.from(environment.COMMUNITY_CURSOR_SIGNING_KEY, "utf8"),
  });
  const contentReadService = new PostgresContentReadService(postgres.sql, {
    cursorSigningKey: createHmac(
      "sha256",
      Buffer.from(environment.COMMUNITY_CURSOR_SIGNING_KEY, "utf8"),
    )
      .update("alphanet.content-read.cursor.v1", "utf8")
      .digest(),
  });
  const contentModerationService = new PostgresContentModerationService(postgres.sql, {
    cursorSigningKey: createHmac(
      "sha256",
      Buffer.from(environment.COMMUNITY_CURSOR_SIGNING_KEY, "utf8"),
    )
      .update("alphanet.content-moderation.cursor.v1", "utf8")
      .digest(),
  });
  const contentSearchService = new PostgresContentSearchService(postgres.sql, {
    activityDigestKey: createHmac(
      "sha256",
      Buffer.from(environment.COMMUNITY_CURSOR_SIGNING_KEY, "utf8"),
    )
      .update("alphanet.content-search.activity-digest.v1", "utf8")
      .digest(),
    cursorSigningKey: createHmac(
      "sha256",
      Buffer.from(environment.COMMUNITY_CURSOR_SIGNING_KEY, "utf8"),
    )
      .update("alphanet.content-search.cursor.v1", "utf8")
      .digest(),
    embeddingModel: `${environment.SEARCH_EMBEDDING_MODEL_ID}:${environment.SEARCH_EMBEDDING_DIMENSIONS}`,
    embeddingProvider: searchEmbeddingProvider,
    queryTimeoutMilliseconds: Math.min(environment.SEARCH_EMBEDDING_TIMEOUT_MS, 10_000),
  });
  const contentReportService = new PostgresContentReportService(postgres.sql);
  const followService = new PostgresFollowService(postgres.sql, {
    cursorSigningKey: createHmac(
      "sha256",
      Buffer.from(environment.COMMUNITY_CURSOR_SIGNING_KEY, "utf8"),
    )
      .update("alphanet.follow-list.cursor.v1", "utf8")
      .digest(),
  });
  const notificationService = new PostgresNotificationService(postgres.sql, {
    cursorSigningKey: createHmac(
      "sha256",
      Buffer.from(environment.COMMUNITY_CURSOR_SIGNING_KEY, "utf8"),
    )
      .update("alphanet.notification.cursor.v1", "utf8")
      .digest(),
  });
  const pendingActionStatusService = new PostgresPendingActionStatusService(postgres.sql);
  const pendingActionKeys: Record<number, Uint8Array> = Object.fromEntries([
    ...Object.entries(environment.PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS).map(
      ([version, key]) => [Number(version), Buffer.from(key, "hex")] as const,
    ),
    [
      environment.PENDING_ACTION_ENCRYPTION_KEY_VERSION,
      Buffer.from(environment.PENDING_ACTION_ENCRYPTION_KEY, "hex"),
    ],
  ]);
  const researchWriteService = new PostgresResearchWriteService(postgres.sql, {
    pendingActionKeyRing: {
      currentVersion: environment.PENDING_ACTION_ENCRYPTION_KEY_VERSION,
      keys: pendingActionKeys,
    },
  });
  const reactionWriteService = new PostgresReactionWriteService(postgres.sql);
  const ownerPendingActionService = new PostgresOwnerPendingActionService(postgres.sql, {
    cursorSigningKey: createHmac(
      "sha256",
      Buffer.from(environment.COMMUNITY_CURSOR_SIGNING_KEY, "utf8"),
    )
      .update("alphanet.owner-pending-action.cursor.v1", "utf8")
      .digest(),
    pendingActionKeyRing: {
      currentVersion: environment.PENDING_ACTION_ENCRYPTION_KEY_VERSION,
      keys: pendingActionKeys,
    },
  });
  const agentRateLimiter = new RedisRateLimitStorage(
    redis.client,
    "alphanet:agent-api:rate-limit:",
  );
  const adminRequestRuntime: AdminRequestRuntime | undefined =
    environment.ADMIN_API_ENABLED
      ? {
          audit: new PostgresAdminSecurityAudit(
            postgres.sql,
            Buffer.from(environment.ADMIN_AUDIT_SUBJECT_DIGEST_KEY!, "hex"),
          ),
          identityVerifier: createOidcJwtVerifier({
            algorithms: environment.ADMIN_OIDC_ALLOWED_ALGORITHMS,
            audience: environment.ADMIN_OIDC_AUDIENCE!,
            clockToleranceSeconds: environment.ADMIN_OIDC_CLOCK_TOLERANCE_SECONDS,
            issuer: environment.ADMIN_OIDC_ISSUER!,
            jwksUri: environment.ADMIN_OIDC_JWKS_URI!,
            mfa: {
              allowedAcrValues: environment.ADMIN_OIDC_ALLOWED_ACR_VALUES,
              allowAmrMfa: environment.ADMIN_OIDC_ALLOW_AMR_MFA,
            },
          }),
          rateLimiter: new RedisRateLimitStorage(
            redis.client,
            "alphanet:admin-api:rate-limit:",
          ),
          repository: new PostgresAdminAuthorizationRepository(postgres.sql),
        }
      : undefined;
  const email: AlphaNetEmailDeliveryConfig =
    environment.AUTH_EMAIL_MODE === "resend"
      ? {
          apiKey: environment.RESEND_API_KEY!,
          from: environment.AUTH_EMAIL_FROM!,
          mode: "resend",
          ...(environment.AUTH_EMAIL_REPLY_TO
            ? { replyTo: environment.AUTH_EMAIL_REPLY_TO }
            : {}),
        }
      : { mode: "local-preview" };
  let authRuntime: AlphaNetAuthRuntime | undefined;
  let app: Awaited<ReturnType<typeof createApiApp>> | undefined;
  let privateMcpApp: Awaited<ReturnType<typeof createPrivateMcpApp>> | undefined;
  try {
    // PostgreSQL also verifies that bind parameters cannot be logged. Redis is
    // connected before listen so the first public request does not fail closed
    // merely because the lazy client has not completed its initial handshake.
    await Promise.all([
      postgres.check(),
      redis.check(),
      notificationService.checkReady(),
    ]);
    authRuntime = createAlphaNetAuthRuntime(
      {
        baseUrl: environment.BETTER_AUTH_URL,
        databasePoolMax: environment.AUTH_DATABASE_POOL_MAX,
        databaseUrl: environment.DATABASE_URL,
        email,
        emailDailyGlobalLimit: environment.AUTH_EMAIL_DAILY_GLOBAL_LIMIT,
        ...(environment.AUTH_GOOGLE_CLIENT_ID && environment.AUTH_GOOGLE_CLIENT_SECRET
          ? {
              google: {
                clientId: environment.AUTH_GOOGLE_CLIENT_ID,
                clientSecret: environment.AUTH_GOOGLE_CLIENT_SECRET,
              },
            }
          : {}),
        redisUrl: environment.REDIS_URL,
        secret: environment.BETTER_AUTH_SECRET,
        secureCookies: environment.AUTH_SECURE_COOKIES,
        trustedOrigins: environment.AUTH_TRUSTED_ORIGINS,
      },
      {
        logger: {
          error: (message, context) => {
            logger.error(context ?? {}, message);
          },
          info: (message, context) => {
            logger.info(context ?? {}, message);
          },
        },
      },
    );
    const remoteMcpOAuthConsent = environment.MCP_OAUTH_OWNER_CONSENT_ENABLED
      ? (() => {
          const authorizationBindingKey =
            environment.MCP_OAUTH_AUTHORIZATION_BINDING_KEY_BASE64;
          const continuationKey = environment.MCP_OAUTH_CONTINUATION_KEY_BASE64;
          const resource = environment.MCP_OAUTH_RESOURCE;
          if (!authorizationBindingKey || !continuationKey || !resource) {
            throw new Error("Remote MCP Owner consent configuration is incomplete");
          }
          return {
            resource,
            service: createRemoteMcpOAuthConsentService(authRuntime.pool, {
              authorizationBindingKey,
              continuationKey,
            }),
          };
        })()
      : undefined;
    app = await createApiApp({
      ...(adminRequestRuntime ? { adminRequestRuntime } : {}),
      allowedOrigins: parseCorsOrigins(environment.CORS_ORIGINS),
      agentConnectionService,
      agentRateLimiter,
      authRuntime,
      communityDirectoryService,
      contentModerationService,
      contentReadService,
      contentReportService,
      contentSearchService,
      followService,
      notificationService,
      dependencies,
      environment: environment.NODE_ENV,
      internalSsrRequestSecret: environment.SSR_INTERNAL_REQUEST_SECRET,
      logger,
      ownerPendingActionService,
      pendingActionStatusService,
      reactionWriteService,
      ...(remoteMcpOAuthConsent ? { remoteMcpOAuthConsent } : {}),
      researchWriteService,
      trustedProxyCidrs: environment.API_TRUSTED_PROXY_CIDRS,
      version: environment.APP_VERSION,
    });

    if (environment.MCP_INTERNAL_API_ENABLED) {
      const serverCertificate = environment.MCP_INTERNAL_API_SERVER_CERT_PEM_BASE64;
      const serverPrivateKey = environment.MCP_INTERNAL_API_SERVER_KEY_PEM_BASE64;
      const clientCertificateAuthority =
        environment.MCP_INTERNAL_API_CLIENT_CA_PEM_BASE64;
      const actorCurrentVersion = environment.MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION;
      const actorCurrentKey = environment.MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64;
      const replayDigestKey = environment.MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64;
      const allowedClientCertificateFingerprints =
        environment.MCP_INTERNAL_API_ALLOWED_CLIENT_CERT_SHA256_FINGERPRINTS;
      if (
        !serverCertificate ||
        !serverPrivateKey ||
        !clientCertificateAuthority ||
        actorCurrentVersion === undefined ||
        !actorCurrentKey ||
        !replayDigestKey ||
        allowedClientCertificateFingerprints.length < 1
      ) {
        throw new Error("Private MCP API configuration is incomplete");
      }
      const actorAssertionKeyRing = createMcpActorAssertionKeyRing({
        currentKey: actorCurrentKey,
        currentVersion: actorCurrentVersion,
        previousKeys: Object.fromEntries(
          Object.entries(environment.MCP_ACTOR_ASSERTION_PREVIOUS_KEYS).map(
            ([version, entry]) => [
              Number(version),
              {
                key: entry.keyBase64,
                verificationExpiresAt: entry.verificationExpiresAt,
              },
            ],
          ),
        ),
      });
      privateMcpApp = await createPrivateMcpApp({
        actorAuthenticator: {
          authority: new PostgresRemoteMcpAuthorityService(postgres.sql),
          keyRing: actorAssertionKeyRing,
          replayStore: new RedisMcpActorAssertionReplayStore(redis.client, {
            digestKey: replayDigestKey,
          }),
        },
        communityDirectoryService,
        contentReadService,
        logger,
        pendingActionStatusService,
        rateLimiter: agentRateLimiter,
        researchWriteService,
        serverFactory: (handler) =>
          createHttpsServer(
            {
              ca: clientCertificateAuthority,
              cert: serverCertificate,
              honorCipherOrder: true,
              key: serverPrivateKey,
              minVersion: "TLSv1.2",
              rejectUnauthorized: true,
              requestCert: true,
            },
            handler,
          ),
        transportIdentityGuard: createPrivateMcpTlsIdentityGuard({
          allowedClientCertificateFingerprints,
        }),
      });
    }

    let closing = false;
    const shutdown = async (signal: string) => {
      if (closing || !app) {
        return;
      }
      closing = true;
      logger.info({ signal }, "shutting down");
      try {
        await privateMcpApp?.close();
      } finally {
        await app.close();
      }
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });

    if (privateMcpApp) {
      await privateMcpApp.listen({
        host: environment.HOST,
        port: environment.MCP_INTERNAL_API_PORT,
      });
      logger.info(
        {
          host: environment.HOST,
          port: environment.MCP_INTERNAL_API_PORT,
        },
        "Private MCP mTLS API listening",
      );
    }
    await app.listen({ host: environment.HOST, port: environment.PORT });
  } catch (error) {
    try {
      await privateMcpApp?.close();
    } finally {
      if (app) {
        await app.close();
      } else {
        await authRuntime?.close();
        await closeDependencies(dependencies);
      }
    }
    throw error;
  }
}

start().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "API failed to start"}\n`,
  );
  process.exitCode = 1;
});
