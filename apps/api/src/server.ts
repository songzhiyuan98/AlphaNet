import {
  createAlphaNetAuthRuntime,
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
import { PostgresAgentConnectionService } from "@alphanet/domain";
import { createLogger } from "@alphanet/observability";

import { createApiApp } from "./app.js";

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
  const agentRateLimiter = new RedisRateLimitStorage(
    redis.client,
    "alphanet:agent-api:rate-limit:",
  );
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
  try {
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
    app = await createApiApp({
      allowedOrigins: parseCorsOrigins(environment.CORS_ORIGINS),
      agentConnectionService,
      agentRateLimiter,
      authRuntime,
      dependencies,
      environment: environment.NODE_ENV,
      internalSsrRequestSecret: environment.SSR_INTERNAL_REQUEST_SECRET,
      logger,
      trustedProxyCidrs: environment.API_TRUSTED_PROXY_CIDRS,
      version: environment.APP_VERSION,
    });

    let closing = false;
    const shutdown = async (signal: string) => {
      if (closing || !app) {
        return;
      }
      closing = true;
      logger.info({ signal }, "shutting down");
      await app.close();
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });

    await app.listen({
      host: environment.HOST,
      port: environment.PORT,
    });
  } catch (error) {
    if (app) {
      await app.close();
    } else {
      await authRuntime?.close();
      await closeDependencies(dependencies);
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
