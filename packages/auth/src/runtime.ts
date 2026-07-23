import { createHash, createHmac, timingSafeEqual } from "node:crypto";

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
import { createRemoteMcpOAuthAuthorizeRateLimiter } from "./remote-mcp-oauth-authorize-rate-limit.js";
import { createRemoteMcpOAuthConsentService } from "./remote-mcp-oauth-consent.js";
import { createAlphaNetRemoteMcpOAuthPostLogin } from "./remote-mcp-oauth-post-login.js";
import {
  createAlphaNetRemoteMcpOAuthLiveBoundary,
  createAlphaNetRemoteMcpOAuthSchemaOnlyPlugins,
  type AlphaNetRemoteMcpOAuthLiveBoundary,
} from "./remote-mcp-oauth-provider.js";
import { createAlphaNetRemoteMcpOAuthRevocationAccessTokenVerifier } from "./remote-mcp-oauth-revocation-verifier.js";
import { createAlphaNetRemoteMcpOAuthRevocationService } from "./remote-mcp-oauth-revocation.js";
import {
  createAlphaNetRemoteMcpOAuthSigningService,
  type AlphaNetRemoteMcpOAuthSigningService,
} from "./remote-mcp-oauth-signing.js";
import { createAlphaNetRemoteMcpOAuthSecurityStore } from "./remote-mcp-oauth-store.js";

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

export interface AlphaNetRemoteMcpOAuthRuntimeConfig {
  authorizationBindingKey: Uint8Array;
  continuationKey: Uint8Array;
  issuer: string;
  jwksUrl: string;
  jwkEncryptionKey: Uint8Array;
  resource: string;
  tokenJtiDigestKey: Uint8Array;
  tokenStorageKey: Uint8Array;
}

export interface AlphaNetAuthConfig {
  baseUrl: string;
  databasePoolMax?: number;
  databaseUrl: string;
  email: AlphaNetEmailDeliveryConfig;
  emailDailyGlobalLimit?: number;
  google?: AlphaNetGoogleAuthConfig;
  redisUrl: string;
  /** Atomic: omit the object to disable every live Remote MCP OAuth surface. */
  remoteMcpOAuth?: AlphaNetRemoteMcpOAuthRuntimeConfig;
  secret: string;
  secureCookies: boolean;
  trustedOrigins: string[];
}

export interface AlphaNetAuthRuntimeDependencies {
  emailSender?: AuthEmailSender;
  logger: AuthEmailLogger;
  redis?: Redis;
}

export const OWNER_SESSION_FRESH_AGE_SECONDS = 10 * 60;

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
    createdAt: Date;
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

interface RemoteMcpRevocationOwnerRow {
  email_verified_at: Date | null;
  id: string;
  status: OwnerSession["owner"]["status"];
}

interface RemoteMcpOAuthTransportSnapshot {
  authorizationHeaders: readonly string[];
  continuationHeaders: readonly string[];
}

interface DeferredBetterAuthSession {
  session: { id: string };
  user: { emailVerified: boolean; id: string };
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

function createRemoteMcpOAuthLockPool(config: AlphaNetAuthConfig): Pool {
  const pool = new Pool({
    application_name: "alphanet-auth-remote-mcp-oauth-lock",
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 20_000,
    max: Math.max(1, Math.min(2, config.databasePoolMax ?? 5)),
    options: "-c search_path=auth,pg_catalog",
  });
  pool.on("error", () => {
    // A failed lock connection is discarded. OAuth exchanges fail closed until
    // this identity-distinct pool establishes another healthy connection.
  });
  return pool;
}

function assertRemoteMcpOAuthKeysAreIndependent(
  config: AlphaNetRemoteMcpOAuthRuntimeConfig,
): void {
  const keys = [
    config.authorizationBindingKey,
    config.continuationKey,
    config.jwkEncryptionKey,
    config.tokenJtiDigestKey,
    config.tokenStorageKey,
  ];
  if (keys.some((key) => !(key instanceof Uint8Array) || key.byteLength !== 32)) {
    throw new TypeError("Remote MCP OAuth key configuration is invalid");
  }
  const copies = keys.map((key) => Buffer.from(key));
  for (let left = 0; left < copies.length; left += 1) {
    for (let right = left + 1; right < copies.length; right += 1) {
      const leftKey = copies[left];
      const rightKey = copies[right];
      if (
        leftKey &&
        rightKey &&
        leftKey.byteLength === rightKey.byteLength &&
        timingSafeEqual(leftKey, rightKey)
      ) {
        throw new TypeError("Remote MCP OAuth keys must be pairwise independent");
      }
    }
  }
}

export async function checkRemoteMcpOAuthResourceReady(
  pool: Pick<Pool, "query">,
  resource: string,
): Promise<void> {
  const result = await pool.query<{ ready: boolean }>(
    `select exists (
       select 1
       from platform.oauth_resource_configuration
       where id = true and resource = $1::text
     ) as ready`,
    [resource],
  );
  if (result.rows[0]?.ready !== true) {
    throw new Error("Remote MCP OAuth resource is not ready");
  }
}

export async function checkRemoteMcpOAuthSchemaReady(
  pool: Pick<Pool, "query">,
): Promise<void> {
  const result = await pool.query<{ ready: boolean }>(
    `select
       to_regclass('auth.oauth_jwks') is not null
       and to_regclass('auth.oauth_clients') is not null
       and to_regclass('auth.oauth_refresh_tokens') is not null
       and to_regclass('auth.oauth_access_tokens') is not null
       and to_regclass('auth.oauth_consents') is not null
       and to_regprocedure('platform.validate_oauth_provider_grant_reference()') is not null
       and exists (
         select 1
         from information_schema.columns
         where table_schema = 'auth'
           and table_name = 'oauth_access_tokens'
           and column_name = 'resources'
           and data_type = 'jsonb'
           and is_nullable = 'NO'
       )
       and to_regclass('platform.oauth_resource_configuration') is not null
       and to_regclass('platform.oauth_authorization_requests') is not null
       and to_regclass('platform.oauth_grants') is not null
       and to_regclass('platform.oauth_access_token_jtis') is not null
       and to_regclass('platform.oauth_grant_bootstrap_reconciliations') is not null
       and to_regclass('system.oauth_grant_bootstrap_queue') is not null
       and to_regprocedure('platform.prevent_oauth_grant_bootstrap_reconciliation_mutation()') is not null
       and to_regprocedure('platform.maintain_oauth_grant_bootstrap_queue()') is not null
       and to_regprocedure('system.inspect_remote_mcp_oauth_lifecycle_backlog(integer,integer,integer)') is not null
       and to_regprocedure('system.expire_remote_mcp_oauth_authorization_requests(integer)') is not null
       and to_regprocedure('system.reconcile_remote_mcp_oauth_grant_bootstraps(integer,integer)') is not null
       and to_regprocedure('system.purge_terminal_remote_mcp_oauth_authorization_requests(integer,integer)') is not null
       and (
         select count(*) = 4
         from system.schema_migrations
         where (version, name) in (
           ('000018', 'remote_mcp_oauth_v1'),
           ('000019', 'remote_mcp_oauth_hardening_v1'),
           ('000020', 'remote_mcp_oauth_lifecycle_maintenance_v1'),
           ('000027', 'remote_mcp_oauth_resource_binding_v1')
         )
       ) as ready`,
  );
  if (result.rows[0]?.ready !== true) {
    throw new Error("Remote MCP OAuth schema is not ready");
  }
}

function isRemoteMcpOAuthTransportSnapshot(
  value: unknown,
): value is RemoteMcpOAuthTransportSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RemoteMcpOAuthTransportSnapshot>;
  return (
    Array.isArray(candidate.authorizationHeaders) &&
    candidate.authorizationHeaders.every((header) => typeof header === "string") &&
    Array.isArray(candidate.continuationHeaders) &&
    candidate.continuationHeaders.every((header) => typeof header === "string")
  );
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
  const remoteMcpOAuthLockPool = config.remoteMcpOAuth
    ? createRemoteMcpOAuthLockPool(config)
    : undefined;
  const redis = dependencies.redis ?? createRedis(config);
  const emailSender = createEmailSender(config, dependencies, redis);
  const tasks = new BackgroundTaskSupervisor(dependencies.logger);
  const rateLimitStorage = new RedisRateLimitStorage(redis);
  const schema = authSchemaOptions();
  const deferredBetterAuthSession: {
    get?: (headers: Headers) => Promise<DeferredBetterAuthSession | null>;
  } = {};

  let remoteMcpOAuth:
    | {
        boundary: AlphaNetRemoteMcpOAuthLiveBoundary;
        jwksPath: string;
        jwksUrl: string;
        resource: string;
        signing: AlphaNetRemoteMcpOAuthSigningService;
      }
    | undefined;
  if (config.remoteMcpOAuth) {
    if (!remoteMcpOAuthLockPool || remoteMcpOAuthLockPool === pool) {
      throw new Error("Remote MCP OAuth lock pool is unavailable");
    }
    const remoteConfig = config.remoteMcpOAuth;
    assertRemoteMcpOAuthKeysAreIndependent(remoteConfig);
    const authorizeRateLimiter = createRemoteMcpOAuthAuthorizeRateLimiter(
      new RedisRateLimitStorage(redis, "alphanet:remote-mcp-oauth:authorize:rate-limit:"),
    );
    const consentService = createRemoteMcpOAuthConsentService(pool, {
      authorizationBindingKey: remoteConfig.authorizationBindingKey,
      continuationKey: remoteConfig.continuationKey,
    });
    const signing = createAlphaNetRemoteMcpOAuthSigningService({
      jwkEncryptionKey: remoteConfig.jwkEncryptionKey,
      pool,
    });
    const postLogin = createAlphaNetRemoteMcpOAuthPostLogin({
      consentPage: new URL(
        "/oauth/consent",
        config.trustedOrigins[0] ?? config.baseUrl,
      ).toString(),
      consentService,
    });
    const securityStore = createAlphaNetRemoteMcpOAuthSecurityStore({
      authorizationBindingKey: remoteConfig.authorizationBindingKey,
      lockPool: remoteMcpOAuthLockPool,
      pool,
      refreshTokenStorageKey: remoteConfig.tokenStorageKey,
      tokenJtiDigestKey: remoteConfig.tokenJtiDigestKey,
    });
    const verifyAccessTokenForRevocation =
      createAlphaNetRemoteMcpOAuthRevocationAccessTokenVerifier({
        getPublicJwks: () => signing.getPublicJwks(),
        issuer: remoteConfig.issuer,
        resource: remoteConfig.resource,
        tokenJtiDigestKey: remoteConfig.tokenJtiDigestKey,
      });
    const revocation = createAlphaNetRemoteMcpOAuthRevocationService({
      async authenticateOwner(request) {
        const getSession = deferredBetterAuthSession.get;
        if (!getSession) {
          throw new Error("Remote MCP OAuth Owner authentication is unavailable");
        }
        const session = await getSession(request.headers);
        if (!session) return null;
        const result = await pool.query<RemoteMcpRevocationOwnerRow>(
          `select id::text, status, email_verified_at
             from platform.owners
            where auth_user_id = $1::uuid
              and deleted_at is null
            limit 1`,
          [session.user.id],
        );
        const owner = result.rows[0];
        if (
          !owner ||
          owner.status !== "active" ||
          !session.user.emailVerified ||
          owner.email_verified_at === null
        ) {
          return null;
        }
        return {
          authUserId: session.user.id,
          ownerId: owner.id,
          sessionId: session.session.id,
        };
      },
      issuer: remoteConfig.issuer,
      pool,
      refreshTokenStorageKey: remoteConfig.tokenStorageKey,
      resource: remoteConfig.resource,
      tokenJtiDigestKey: remoteConfig.tokenJtiDigestKey,
      verifyAccessTokenForRevocation,
    });
    const boundary = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: postLogin.page,
      issuer: remoteConfig.issuer,
      jwksUrl: remoteConfig.jwksUrl,
      loginPage: new URL("/login", config.trustedOrigins[0] ?? config.baseUrl).toString(),
      resource: remoteConfig.resource,
      security: {
        ...securityStore,
        ...revocation,
        admitAuthorizationRequest: authorizeRateLimiter,
        postLogin,
        signAccessToken: (payload) => signing.signAccessToken(payload),
      },
      tokenStorageKey: remoteConfig.tokenStorageKey,
    });
    remoteMcpOAuth = {
      boundary,
      jwksPath: new URL(remoteConfig.jwksUrl).pathname,
      jwksUrl: remoteConfig.jwksUrl,
      resource: remoteConfig.resource,
      signing,
    };
  }
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
    ...(remoteMcpOAuth ? { plugins: [...remoteMcpOAuth.boundary.plugins] } : {}),
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
      freshAge: OWNER_SESSION_FRESH_AGE_SECONDS,
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
  deferredBetterAuthSession.get = async (headers) => {
    const session = await auth.api.getSession({
      headers,
      query: {
        disableCookieCache: true,
      },
    });
    return session
      ? {
          session: { id: session.session.id },
          user: {
            emailVerified: session.user.emailVerified,
            id: session.user.id,
          },
        }
      : null;
  };
  const wrappedProviderHandler = remoteMcpOAuth?.boundary.wrapProviderHandler((request) =>
    auth.handler(request),
  );

  async function dispatchAuthHandler(
    request: Request,
    transport: RemoteMcpOAuthTransportSnapshot | undefined,
  ): Promise<Response> {
    if (!wrappedProviderHandler) return auth.handler(request);
    if (!isRemoteMcpOAuthTransportSnapshot(transport)) {
      throw new Error("Remote MCP OAuth raw transport metadata is unavailable");
    }
    return wrappedProviderHandler({
      authorizationHeaders: transport.authorizationHeaders,
      continuationHeaders: transport.continuationHeaders,
      request,
    });
  }

  async function handle(
    request: Request,
    transport?: RemoteMcpOAuthTransportSnapshot,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (remoteMcpOAuth) {
      if (!isRemoteMcpOAuthTransportSnapshot(transport)) {
        throw new Error("Remote MCP OAuth raw transport metadata is unavailable");
      }
      if (request.method === "GET" && url.toString() === remoteMcpOAuth.jwksUrl) {
        const jwks = await remoteMcpOAuth.signing.getPublicJwks();
        return new Response(JSON.stringify(jwks.document), {
          headers: {
            "cache-control": jwks.cacheControl,
            "content-type": "application/json; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
          status: 200,
        });
      }
    }
    const isPasswordReset =
      request.method === "POST" && url.pathname === "/api/auth/reset-password";
    const isPasswordSignIn =
      request.method === "POST" && url.pathname === "/api/auth/sign-in/email";
    if (!isPasswordReset && !isPasswordSignIn) {
      return dispatchAuthHandler(request, transport);
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
      return dispatchAuthHandler(request, transport);
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
      return await dispatchAuthHandler(request, transport);
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
    remoteMcpOAuthEnabled: Boolean(remoteMcpOAuth),
    remoteMcpOAuthJwksPath: remoteMcpOAuth?.jwksPath,
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
      if (remoteMcpOAuth) {
        await checkRemoteMcpOAuthSchemaReady(pool);
        await checkRemoteMcpOAuthResourceReady(pool, remoteMcpOAuth.resource);
        await remoteMcpOAuthLockPool?.query("select 1 as ready");
        await remoteMcpOAuth.signing.checkReady();
      }
    },
    async close(): Promise<void> {
      await tasks.drain();
      const closures: Promise<unknown>[] = [
        pool.end(),
        credentialLockPool.end(),
        (async () => {
          if (redis.status === "ready") {
            await redis.quit();
            return;
          }
          redis.disconnect();
        })(),
      ];
      if (remoteMcpOAuthLockPool) closures.push(remoteMcpOAuthLockPool.end());
      await Promise.allSettled(closures);
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
          createdAt: session.session.createdAt,
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

export function createSchemaGenerationAuth(): ReturnType<typeof betterAuth> {
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
  const remoteMcpOAuthPlugins = createAlphaNetRemoteMcpOAuthSchemaOnlyPlugins({
    consentPage: "/oauth/consent",
    issuer: "http://localhost:4000/api/auth",
    loginPage: "/login",
    resource: "http://127.0.0.1:4100/mcp",
  });

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
    plugins: [...remoteMcpOAuthPlugins],
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
  }) as unknown as ReturnType<typeof betterAuth>;
}
