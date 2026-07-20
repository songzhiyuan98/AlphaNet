import { createHash, createHmac } from "node:crypto";

import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { Redis } from "ioredis";
import { Pool } from "pg";

import {
  assertTrustedActionUrl,
  BackgroundTaskSupervisor,
  GuardedAuthEmailSender,
  LocalPreviewEmailSender,
  ResendEmailSender,
  type AuthEmailLogger,
  type AuthEmailSender,
} from "./email.js";
import { RedisRateLimitStorage } from "./rate-limit.js";

export interface AlphaNetGoogleAuthConfig {
  clientId: string;
  clientSecret: string;
}

export type AlphaNetEmailDeliveryConfig =
  | {
      mode: "local-preview";
    }
  | {
      apiKey: string;
      from: string;
      mode: "resend";
      replyTo?: string;
    };

export interface AlphaNetAuthConfig {
  baseUrl: string;
  databasePoolMax?: number;
  databaseUrl: string;
  email: AlphaNetEmailDeliveryConfig;
  emailDailyGlobalLimit?: number;
  google?: AlphaNetGoogleAuthConfig;
  redisUrl: string;
  secret: string;
  secureCookies: boolean;
  trustedOrigins: string[];
}

export interface AlphaNetAuthRuntimeDependencies {
  emailSender?: AuthEmailSender;
  logger: AuthEmailLogger;
  redis?: Redis;
}

interface RegistrationControlRow {
  mode: "open" | "paused";
}

interface CredentialSubjectRow {
  user_id: string;
}

export interface OwnerSession {
  owner: {
    email: string;
    emailVerified: boolean;
    id: string;
    name: string;
    status: "active" | "closed" | "pending_verification" | "restricted" | "suspended";
  };
  session: {
    expiresAt: Date;
    id: string;
  };
}

interface OwnerRow {
  email: string;
  email_verified_at: Date | null;
  id: string;
  status: OwnerSession["owner"]["status"];
}

function createPool(config: AlphaNetAuthConfig): Pool {
  const pool = new Pool({
    application_name: "alphanet-auth",
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 20_000,
    max: config.databasePoolMax ?? 5,
    options: "-c search_path=auth,pg_catalog",
  });
  pool.on("error", () => {
    // Individual requests surface database failures through Better Auth. Keeping an
    // error listener avoids an unhandled pool event without logging credentials.
  });
  return pool;
}

function createCredentialLockPool(config: AlphaNetAuthConfig): Pool {
  const pool = new Pool({
    application_name: "alphanet-auth-credential-lock",
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 20_000,
    max: Math.max(1, Math.min(2, config.databasePoolMax ?? 5)),
    options: "-c search_path=auth,pg_catalog",
  });
  pool.on("error", () => {
    // A failed idle lock connection is discarded by pg. The next credential
    // operation must establish a healthy connection before it can continue.
  });
  return pool;
}

function createRedis(config: AlphaNetAuthConfig): Redis {
  const redis = new Redis(config.redisUrl, {
    commandTimeout: 2_000,
    connectTimeout: 2_000,
    // Lazy connection plus a bounded offline queue lets the first request wait
    // for the initial handshake. maxRetriesPerRequest still makes auth fail
    // closed quickly when Redis is unavailable instead of bypassing limits.
    enableOfflineQueue: true,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 100, 1_000),
  });
  redis.on("error", () => {
    // Authentication endpoints fail closed if distributed rate limiting is down.
  });
  return redis;
}

function createEmailSender(
  config: AlphaNetAuthConfig,
  dependencies: AlphaNetAuthRuntimeDependencies,
  redis: Redis,
): AuthEmailSender {
  const provider =
    dependencies.emailSender ??
    (config.email.mode === "resend"
      ? new ResendEmailSender({
          apiKey: config.email.apiKey,
          from: config.email.from,
          ...(config.email.replyTo ? { replyTo: config.email.replyTo } : {}),
        })
      : new LocalPreviewEmailSender(dependencies.logger, config.baseUrl));

  return new GuardedAuthEmailSender(provider, {
    dailyGlobalLimit: config.emailDailyGlobalLimit ?? 10_000,
    keySecret: config.secret,
    logger: dependencies.logger,
    redis,
  });
}

function authSchemaOptions() {
  return {
    account: {
      fields: {
        accessToken: "access_token",
        accessTokenExpiresAt: "access_token_expires_at",
        accountId: "account_id",
        createdAt: "created_at",
        idToken: "id_token",
        providerId: "provider_id",
        refreshToken: "refresh_token",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        updatedAt: "updated_at",
        userId: "user_id",
      },
      modelName: "accounts",
    },
    session: {
      fields: {
        createdAt: "created_at",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        updatedAt: "updated_at",
        userAgent: "user_agent",
        userId: "user_id",
      },
      modelName: "sessions",
    },
    user: {
      fields: {
        createdAt: "created_at",
        emailVerified: "email_verified",
        updatedAt: "updated_at",
      },
      modelName: "users",
    },
    verification: {
      fields: {
        createdAt: "created_at",
        expiresAt: "expires_at",
        updatedAt: "updated_at",
      },
      modelName: "verifications",
    },
  } as const;
}

export function createAlphaNetAuthRuntime(
  config: AlphaNetAuthConfig,
  dependencies: AlphaNetAuthRuntimeDependencies,
) {
  const pool = createPool(config);
  const credentialLockPool = createCredentialLockPool(config);
  const redis = dependencies.redis ?? createRedis(config);
  const emailSender = createEmailSender(config, dependencies, redis);
  const tasks = new BackgroundTaskSupervisor(dependencies.logger);
  const rateLimitStorage = new RedisRateLimitStorage(redis);
  const schema = authSchemaOptions();
  const socialProviders = config.google
    ? {
        google: {
          clientId: config.google.clientId,
          clientSecret: config.google.clientSecret,
          disableIdTokenSignIn: true,
          prompt: "select_account" as const,
          scope: ["openid", "email", "profile"],
        },
      }
    : {};

  const options = {
    account: {
      ...schema.account,
      accountLinking: {
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
        disableImplicitLinking: true,
        enabled: false,
        updateUserInfoOnLink: false,
      },
      encryptOAuthTokens: true,
      storeAccountCookie: false,
      storeStateStrategy: "database",
      updateAccountOnSignIn: false,
    },
    advanced: {
      cookiePrefix: "alphanet",
      database: {
        defaultFindManyLimit: 100,
        generateId: "uuid",
      },
      defaultCookieAttributes: {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: config.secureCookies,
      },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      ipAddress: {
        ipAddressHeaders: ["x-alphanet-client-ip"],
        ipv6Subnet: 64,
      },
      trustedProxyHeaders: false,
      useSecureCookies: config.secureCookies,
    },
    appName: "AlphaNet",
    basePath: "/api/auth",
    baseURL: config.baseUrl,
    database: pool,
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            const result = await pool.query<RegistrationControlRow>(
              "select mode from platform.registration_controls where id = true",
            );
            if (result.rows[0]?.mode !== "open") {
              throw new APIError("SERVICE_UNAVAILABLE", {
                code: "REGISTRATION_PAUSED",
                message: "Registration is temporarily paused.",
              });
            }
          },
        },
      },
    },
    emailAndPassword: {
      autoSignIn: false,
      enabled: true,
      maxPasswordLength: 128,
      minPasswordLength: 12,
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: 30 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ token, user, url }) => {
        assertTrustedActionUrl(url, config.baseUrl);
        const actionUrl = new URL("/reset-password", config.trustedOrigins[0]);
        actionUrl.hash = new URLSearchParams({ token }).toString();
        tasks.schedule(
          emailSender.send({
            actionUrl: actionUrl.toString(),
            purpose: "password_reset",
            recipient: user.email,
          }),
          "password_reset_email",
        );
        return Promise.resolve();
      },
    },
    disabledPaths: [
      "/account-info",
      "/change-email",
      "/change-password",
      "/delete-user",
      "/delete-user/callback",
      "/get-access-token",
      "/get-session",
      "/link-social",
      "/list-accounts",
      "/list-sessions",
      "/refresh-token",
      "/revoke-other-sessions",
      "/revoke-session",
      "/revoke-sessions",
      "/unlink-account",
      "/update-session",
      "/update-user",
      "/verify-password",
    ],
    emailVerification: {
      autoSignInAfterVerification: false,
      expiresIn: 24 * 60 * 60,
      sendOnSignIn: false,
      sendOnSignUp: true,
      sendVerificationEmail: ({ user, url }) => {
        assertTrustedActionUrl(url, config.baseUrl);
        tasks.schedule(
          emailSender.send({
            actionUrl: url,
            purpose: "verification",
            recipient: user.email,
          }),
          "verification_email",
        );
        return Promise.resolve();
      },
    },
    logger: {
      disabled: true,
    },
    onAPIError: {
      errorURL: `${config.trustedOrigins[0] ?? config.baseUrl}/auth/error`,
      onError: (error: unknown) => {
        dependencies.logger.error("Better Auth request failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      },
    },
    rateLimit: {
      customRules: {
        "/callback/*": { max: 20, window: 60 },
        "/request-password-reset": { max: 3, window: 3_600 },
        "/reset-password": { max: 5, window: 900 },
        "/send-verification-email": { max: 3, window: 3_600 },
        "/sign-in/email": { max: 5, window: 60 },
        "/sign-in/social": { max: 10, window: 60 },
        "/sign-up/email": { max: 5, window: 3_600 },
      },
      customStorage: rateLimitStorage,
      enabled: true,
      max: 100,
      window: 60,
    },
    secret: config.secret,
    session: {
      ...schema.session,
      cookieCache: {
        enabled: false,
      },
      deferSessionRefresh: true,
      expiresIn: 7 * 24 * 60 * 60,
      freshAge: 10 * 60,
      updateAge: 12 * 60 * 60,
    },
    socialProviders,
    telemetry: {
      enabled: false,
    },
    trustedOrigins: config.trustedOrigins,
    user: {
      ...schema.user,
      changeEmail: {
        enabled: false,
      },
      deleteUser: {
        enabled: false,
      },
    },
    verification: {
      ...schema.verification,
      disableCleanup: false,
      storeIdentifier: "hashed",
    },
  } satisfies BetterAuthOptions;

  const auth = betterAuth(options);

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isPasswordReset =
      request.method === "POST" && url.pathname === "/api/auth/reset-password";
    const isPasswordSignIn =
      request.method === "POST" && url.pathname === "/api/auth/sign-in/email";
    if (!isPasswordReset && !isPasswordSignIn) {
      return auth.handler(request);
    }

    let body: Record<string, unknown> | undefined;
    try {
      const candidate: unknown = await request.clone().json();
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        !Array.isArray(candidate)
      ) {
        body = candidate as Record<string, unknown>;
      }
    } catch {
      // Better Auth owns the canonical malformed-body response.
    }

    let credentialLockSubject: string | undefined;
    if (isPasswordReset) {
      const token = body?.token;
      if (typeof token === "string" && token.length > 0 && token.length <= 512) {
        const identifier = createHash("sha256")
          .update(`reset-password:${token}`)
          .digest("base64url");
        const verification = await pool.query<CredentialSubjectRow>(
          `select verification.value as user_id
           from auth.verifications as verification
           inner join auth.users as auth_user
             on auth_user.id::text = verification.value
           where verification.identifier = $1
             and verification.expires_at >= clock_timestamp()
           order by verification.created_at desc
           limit 1`,
          [identifier],
        );
        const userId = verification.rows[0]?.user_id;
        if (userId) {
          credentialLockSubject = `owner:${userId}`;
        }
      }
    } else {
      const email = body?.email;
      if (typeof email === "string" && email.length > 0 && email.length <= 320) {
        const normalizedEmail = email.toLowerCase();
        const user = await pool.query<CredentialSubjectRow>(
          `select id::text as user_id
           from auth.users
           where email = $1
           limit 1`,
          [normalizedEmail],
        );
        const userId = user.rows[0]?.user_id;
        credentialLockSubject = userId
          ? `owner:${userId}`
          : `unknown:${createHmac("sha256", config.secret)
              .update(normalizedEmail)
              .digest("base64url")}`;
      }
    }
    if (!credentialLockSubject) {
      return auth.handler(request);
    }

    // Keep password verification + session creation and reset token consumption
    // + credential replacement in one per-Owner order across all replicas. This
    // prevents an old password verified before a reset from creating a session
    // after the credential transaction has already revoked existing sessions.
    // The lock pool is separate so waiters cannot exhaust Better Auth's pool.
    const client = await credentialLockPool.connect();
    let transactionStarted = false;
    let releaseError: Error | undefined;
    try {
      await client.query("begin");
      transactionStarted = true;
      await client.query("set local statement_timeout = '15s'");
      await client.query(
        `select pg_advisory_xact_lock(
           pg_catalog.hashtextextended($1, 0)
         )`,
        [`alphanet:credential:${credentialLockSubject}`],
      );
      await client.query("set local statement_timeout = '0'");
      return await auth.handler(request);
    } catch (error) {
      releaseError = error instanceof Error ? error : new Error("Credential lock failed");
      throw error;
    } finally {
      if (transactionStarted) {
        try {
          await client.query("rollback");
        } catch (error) {
          releaseError =
            error instanceof Error ? error : new Error("Credential lock release failed");
        }
      }
      client.release(releaseError);
    }
  }

  return {
    auth,
    baseUrl: config.baseUrl,
    googleEnabled: Boolean(config.google),
    async checkReady(): Promise<void> {
      const result = await pool.query<{ ready: boolean }>(
        `select
           to_regclass('auth.users') is not null
           and to_regclass('auth.sessions') is not null
           and to_regclass('auth.accounts') is not null
           and to_regclass('auth.verifications') is not null
           and to_regclass('platform.owners') is not null
           and to_regclass('platform.registration_controls') is not null
           and (
             select count(*) = 2
             from system.schema_migrations
             where (version, name) in (
               ('000002', 'auth_schema'),
               ('000003', 'owner_identity')
             )
           ) as ready`,
      );
      if (result.rows[0]?.ready !== true) {
        throw new Error("Owner authentication schema is not ready");
      }
    },
    async close(): Promise<void> {
      await tasks.drain();
      await Promise.allSettled([
        pool.end(),
        credentialLockPool.end(),
        (async () => {
          if (redis.status === "ready") {
            await redis.quit();
            return;
          }
          redis.disconnect();
        })(),
      ]);
    },
    handle,
    async getOwnerSession(headers: Headers): Promise<OwnerSession | null> {
      const session = await auth.api.getSession({
        headers,
        query: {
          disableCookieCache: true,
        },
      });
      if (!session) {
        return null;
      }

      const result = await pool.query<OwnerRow>(
        `select id, status, email, email_verified_at
         from platform.owners
         where auth_user_id = $1
           and deleted_at is null`,
        [session.user.id],
      );
      const owner = result.rows[0];
      if (!owner) {
        return null;
      }

      return {
        owner: {
          email: owner.email,
          emailVerified: session.user.emailVerified && owner.email_verified_at !== null,
          id: owner.id,
          name: session.user.name,
          status: owner.status,
        },
        session: {
          expiresAt: session.session.expiresAt,
          id: session.session.id,
        },
      };
    },
    options,
    pool,
    redis,
  };
}

export type AlphaNetAuthRuntime = ReturnType<typeof createAlphaNetAuthRuntime>;

export function createSchemaGenerationAuth() {
  const generationSchema = process.env.AUTH_SCHEMA_GENERATION_SCHEMA ?? "auth";
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(generationSchema)) {
    throw new Error("AUTH_SCHEMA_GENERATION_SCHEMA must be a safe PostgreSQL schema");
  }
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://alphanet:alphanet_local_only@127.0.0.1:5432/alphanet",
    options: `-c search_path=${generationSchema}`,
  });
  const schema = authSchemaOptions();

  return betterAuth({
    account: {
      ...schema.account,
      accountLinking: {
        disableImplicitLinking: true,
      },
      encryptOAuthTokens: true,
      storeStateStrategy: "database",
    },
    advanced: {
      database: {
        generateId: "uuid",
      },
    },
    baseURL: "http://localhost:4000",
    database: pool,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
    },
    rateLimit: {
      customStorage: {
        consume: () => Promise.resolve({ allowed: true, retryAfter: null }),
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
      },
      enabled: true,
    },
    session: schema.session,
    user: schema.user,
    verification: {
      ...schema.verification,
      storeIdentifier: "hashed",
    },
  });
}
