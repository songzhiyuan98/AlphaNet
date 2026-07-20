import {
  createAlphaNetAuthRuntime,
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
import { createLogger } from "@alphanet/observability";

import { createApiApp } from "./app.js";

async function start(): Promise<void> {
  const environment = loadApiEnvironment();
  const logger = createLogger({
    service: "api",
    environment: environment.NODE_ENV,
    level: environment.LOG_LEVEL,
  });
  const dependencies: HealthDependency[] = [
    createPostgresDependency(environment.DATABASE_URL),
    createRedisDependency(environment.REDIS_URL, { critical: true }),
  ];
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
      authRuntime,
      dependencies,
      environment: environment.NODE_ENV,
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
