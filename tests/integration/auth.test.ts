import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAlphaNetAuthRuntime,
  type AlphaNetAuthRuntime,
  type AuthEmail,
} from "../../packages/auth/src/index.js";
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

const describeAuth = hasConfiguration ? describe : describe.skip;
const baseUrl = "http://localhost:4000";
const webOrigin = "http://localhost:3000";
const ipMarker = randomUUID().replaceAll("-", "");
const testClientIp = `2001:db8:${ipMarker.slice(0, 4)}:${ipMarker.slice(4, 8)}::1`;
const bridgeTestClientIp = `2001:db8:${ipMarker.slice(8, 12)}:${ipMarker.slice(12, 16)}::2`;

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .filter((cookie): cookie is string => Boolean(cookie))
    .join("; ");
}

function injectedCookieHeader(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

describeAuth("Owner authentication", () => {
  const emails: AuthEmail[] = [];
  let runtime: AlphaNetAuthRuntime;

  beforeAll(() => {
    runtime = createAlphaNetAuthRuntime(
      {
        baseUrl,
        databasePoolMax: 3,
        databaseUrl: databaseUrl ?? "",
        email: { mode: "local-preview" },
        emailDailyGlobalLimit: 10_000,
        redisUrl: redisUrl ?? "",
        secret:
          "integration-only-secret-that-is-long-enough-and-never-used-outside-tests",
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
        logger: {
          error: () => undefined,
          info: () => undefined,
        },
      },
    );
  });

  afterAll(async () => {
    if (!runtime) {
      return;
    }
    await runtime.close();
  });

  async function authRequest(
    path: string,
    options: {
      body?: Record<string, unknown>;
      cookie?: string;
      method?: "GET" | "POST";
    } = {},
  ): Promise<Response> {
    const headers = new Headers({
      "x-alphanet-client-ip": testClientIp,
    });
    if (options.body) {
      headers.set("content-type", "application/json");
      headers.set("origin", webOrigin);
    }
    if (options.cookie) {
      headers.set("cookie", options.cookie);
    }
    return runtime.handle(
      new Request(`${baseUrl}/api/auth${path}`, {
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        headers,
        method: options.method ?? (options.body ? "POST" : "GET"),
      }),
    );
  }

  async function waitForEmail(
    purpose: AuthEmail["purpose"],
    recipient: string,
  ): Promise<AuthEmail> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const message = emails.find(
        (candidate) => candidate.purpose === purpose && candidate.recipient === recipient,
      );
      if (message) {
        return message;
      }
      await delay(10);
    }
    throw new Error(`Timed out waiting for ${purpose} email`);
  }

  it("keeps Better Auth tables isolated from the public schema", async () => {
    await expect(runtime.checkReady()).resolves.toBeUndefined();

    const result = await runtime.pool.query<{
      auth_users: string | null;
      public_rate_limit: string | null;
      public_users: string | null;
    }>(
      `select
         to_regclass('auth.users')::text as auth_users,
         to_regclass('public.users')::text as public_users,
         to_regclass('public."rateLimit"')::text as public_rate_limit`,
    );

    expect(result.rows[0]).toEqual({
      auth_users: "users",
      public_rate_limit: null,
      public_users: null,
    });
  });

  it("does not grant PUBLIC execution on privileged trigger functions", async () => {
    const result = await runtime.pool.query<{ function_name: string }>(
      `select routine.proname as function_name
       from pg_proc as routine
       join pg_namespace as namespace on namespace.oid = routine.pronamespace
       cross join lateral aclexplode(
         coalesce(routine.proacl, acldefault('f', routine.proowner))
       ) as privilege
       where namespace.nspname = 'platform'
         and routine.prosecdef
         and privilege.grantee = 0
         and privilege.privilege_type = 'EXECUTE'
       order by routine.proname`,
    );

    expect(result.rows).toEqual([]);
  });

  it("atomically revokes sessions and sibling reset tokens with a credential write", async () => {
    const marker = randomUUID();
    const inserted = await runtime.pool.query<{ id: string }>(
      `insert into auth.users (name, email, email_verified, created_at, updated_at)
       values ('Credential Trigger Owner', $1, true, clock_timestamp(), clock_timestamp())
       returning id`,
      [`credential-trigger-${marker}@example.test`],
    );
    const userId = inserted.rows[0]?.id;
    if (!userId) {
      throw new Error("test Auth User was not inserted");
    }

    await runtime.pool.query(
      `insert into auth.accounts (
         account_id,
         provider_id,
         user_id,
         password,
         updated_at
       )
       values (
         $1::text,
         'credential',
         $1::uuid,
         'first-hash',
         clock_timestamp()
       )`,
      [userId],
    );
    await runtime.pool.query(
      `insert into auth.sessions (
         expires_at,
         token,
         updated_at,
         user_id
       )
       values (
         clock_timestamp() + interval '1 hour',
         $1,
         clock_timestamp(),
         $2
       )`,
      [`credential-trigger-session-${marker}`, userId],
    );
    await runtime.pool.query(
      `insert into auth.verifications (identifier, value, expires_at)
       values ($1, $2, clock_timestamp() + interval '30 minutes')`,
      [`credential-trigger-verification-${marker}`, userId],
    );

    await runtime.pool.query(
      `update auth.accounts
       set password = 'second-hash',
           updated_at = clock_timestamp()
       where provider_id = 'credential'
         and user_id = $1`,
      [userId],
    );

    const result = await runtime.pool.query<{
      session_count: number;
      verification_count: number;
    }>(
      `select
         (
           select count(*)::integer
           from auth.sessions
           where user_id = $1
         ) as session_count,
         (
           select count(*)::integer
           from auth.verifications
           where value = $1::text
         ) as verification_count`,
      [userId],
    );
    expect(result.rows[0]).toEqual({
      session_count: 0,
      verification_count: 0,
    });
  });

  it("atomically provisions verified OAuth-style Owners under batch load", async () => {
    const marker = randomUUID().replaceAll("-", "");
    const inserted = await runtime.pool.query<{ id: string }>(
      `insert into auth.users (name, email, email_verified, created_at, updated_at)
       select
         'Verified OAuth Owner',
         concat('verified-', $1::text, '-', sequence_number, '@example.test'),
         true,
         statement_timestamp(),
         statement_timestamp()
       from generate_series(1, 128) as sequence_number
       returning id`,
      [marker],
    );
    expect(inserted.rows).toHaveLength(128);

    const result = await runtime.pool.query<{
      active_count: number;
      inconsistent_timestamp_count: number;
      owner_count: number;
    }>(
      `select
         count(*)::integer as owner_count,
         count(*) filter (where owner.status = 'active')::integer as active_count,
         count(*) filter (
           where owner.created_at <> owner.email_verified_at
              or owner.created_at <> owner.updated_at
         )::integer as inconsistent_timestamp_count
       from platform.owners as owner
       where owner.auth_user_id = any($1::uuid[])`,
      [inserted.rows.map((row) => row.id)],
    );
    expect(result.rows[0]).toEqual({
      active_count: 128,
      inconsistent_timestamp_count: 0,
      owner_count: 128,
    });
  });

  it("completes registration, verification, login, and password reset", async () => {
    const marker = randomUUID();
    const email = `owner-${marker}@example.test`;
    const firstPassword = "Initial-password-2026!";
    const secondPassword = "Replacement-password-2026!";

    const registration = await authRequest("/sign-up/email", {
      body: {
        callbackURL: `${webOrigin}/home`,
        email,
        name: "Integration Owner",
        password: firstPassword,
      },
    });
    expect(registration.status).toBe(200);

    const ownerBeforeVerification = await runtime.pool.query<{
      auth_user_id: string;
      email_verified: boolean;
      owner_count: number;
      status: string;
    }>(
      `select
         auth_user.id as auth_user_id,
         auth_user.email_verified,
         owner.status,
         count(*) over ()::integer as owner_count
       from auth.users as auth_user
       join platform.owners as owner on owner.auth_user_id = auth_user.id
       where auth_user.email = $1`,
      [email],
    );
    expect(ownerBeforeVerification.rows).toHaveLength(1);
    expect(ownerBeforeVerification.rows[0]).toMatchObject({
      email_verified: false,
      owner_count: 1,
      status: "pending_verification",
    });
    const authUserId = ownerBeforeVerification.rows[0]?.auth_user_id;
    if (!authUserId) {
      throw new Error("registration did not provision an Auth User");
    }
    const verificationEmail = await waitForEmail("verification", email);
    const verification = await runtime.handle(new Request(verificationEmail.actionUrl));
    expect(verification.status).toBe(302);
    expect(verification.headers.get("location")).toBe(`${webOrigin}/home`);

    const ownerAfterVerification = await runtime.pool.query<{
      email_verified_at: Date | null;
      status: string;
    }>(
      `select owner.status, owner.email_verified_at
       from platform.owners as owner
       where owner.auth_user_id = $1`,
      [authUserId],
    );
    expect(ownerAfterVerification.rows[0]?.status).toBe("active");
    expect(ownerAfterVerification.rows[0]?.email_verified_at).toBeInstanceOf(Date);

    const signIn = await authRequest("/sign-in/email", {
      body: {
        callbackURL: `${webOrigin}/home`,
        email,
        password: firstPassword,
        rememberMe: true,
      },
    });
    expect(signIn.status).toBe(200);
    const sessionCookie = cookieHeader(signIn);
    expect(sessionCookie).toContain("alphanet.session_token=");

    const ownerSession = await runtime.getOwnerSession(
      new Headers({ cookie: sessionCookie }),
    );
    expect(ownerSession).toMatchObject({
      owner: {
        email,
        emailVerified: true,
        name: "Integration Owner",
        status: "active",
      },
    });
    const publicBetterAuthSession = await authRequest("/get-session", {
      cookie: sessionCookie,
    });
    expect(publicBetterAuthSession.status).toBe(404);

    const resetRequest = await authRequest("/request-password-reset", {
      body: {
        email,
        redirectTo: `${webOrigin}/reset-password`,
      },
    });
    expect(resetRequest.status).toBe(200);
    const resetEmail = await waitForEmail("password_reset", email);
    const resetAction = new URL(resetEmail.actionUrl);
    const resetToken = new URLSearchParams(resetAction.hash.slice(1)).get("token");
    expect(resetAction.origin).toBe(webOrigin);
    expect(resetAction.pathname).toBe("/reset-password");
    expect(resetAction.search).toBe("");
    expect(resetToken).toBeTruthy();

    const siblingResetToken = randomUUID().replaceAll("-", "");
    const siblingResetIdentifier = createHash("sha256")
      .update(`reset-password:${siblingResetToken}`)
      .digest("base64url");
    await runtime.pool.query(
      `insert into auth.verifications (identifier, value, expires_at)
       values ($1, $2, clock_timestamp() + interval '30 minutes')`,
      [siblingResetIdentifier, authUserId],
    );
    const pendingResetTokens = await runtime.pool.query<{ count: number }>(
      `select count(*)::integer as count
       from auth.verifications
       where value = $1`,
      [authUserId],
    );
    expect(pendingResetTokens.rows[0]?.count).toBe(2);

    const competingPassword = "Competing-password-reset-2026!";
    const siblingRuntime = createAlphaNetAuthRuntime(
      {
        baseUrl,
        databasePoolMax: 2,
        databaseUrl: databaseUrl ?? "",
        email: { mode: "local-preview" },
        emailDailyGlobalLimit: 10_000,
        redisUrl: redisUrl ?? "",
        secret:
          "integration-only-secret-that-is-long-enough-and-never-used-outside-tests",
        secureCookies: false,
        trustedOrigins: [webOrigin],
      },
      {
        emailSender: {
          send: () => Promise.resolve(),
        },
        logger: {
          error: () => undefined,
          info: () => undefined,
        },
      },
    );
    let concurrentResponses: [Response, Response, Response];
    try {
      concurrentResponses = await Promise.all([
        authRequest("/reset-password", {
          body: {
            newPassword: secondPassword,
            token: resetToken,
          },
        }),
        siblingRuntime.handle(
          new Request(`${baseUrl}/api/auth/reset-password`, {
            body: JSON.stringify({
              newPassword: competingPassword,
              token: siblingResetToken,
            }),
            headers: {
              "content-type": "application/json",
              origin: webOrigin,
              "x-alphanet-client-ip": testClientIp,
            },
            method: "POST",
          }),
        ),
        siblingRuntime.handle(
          new Request(`${baseUrl}/api/auth/sign-in/email`, {
            body: JSON.stringify({
              email,
              password: firstPassword,
            }),
            headers: {
              "content-type": "application/json",
              origin: webOrigin,
              "x-alphanet-client-ip": testClientIp,
            },
            method: "POST",
          }),
        ),
      ]);
    } finally {
      await siblingRuntime.close();
    }
    const [firstResetResponse, secondResetResponse, concurrentOldPasswordSignIn] =
      concurrentResponses;
    const resetResponses: [Response, Response] = [
      firstResetResponse,
      secondResetResponse,
    ];
    expect(resetResponses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect([200, 401]).toContain(concurrentOldPasswordSignIn.status);
    const successfulPassword =
      resetResponses[0].status === 200 ? secondPassword : competingPassword;
    const rejectedPassword =
      resetResponses[0].status === 200 ? competingPassword : secondPassword;
    const remainingResetTokens = await runtime.pool.query<{ count: number }>(
      `select count(*)::integer as count
       from auth.verifications
       where value = $1`,
      [authUserId],
    );
    expect(remainingResetTokens.rows[0]?.count).toBe(0);
    await expect(
      runtime.getOwnerSession(new Headers({ cookie: sessionCookie })),
    ).resolves.toBeNull();
    if (concurrentOldPasswordSignIn.status === 200) {
      await expect(
        runtime.getOwnerSession(
          new Headers({ cookie: cookieHeader(concurrentOldPasswordSignIn) }),
        ),
      ).resolves.toBeNull();
    }

    const oldPasswordSignIn = await authRequest("/sign-in/email", {
      body: {
        email,
        password: firstPassword,
      },
    });
    expect(oldPasswordSignIn.status).toBe(401);

    const newPasswordSignIn = await authRequest("/sign-in/email", {
      body: {
        email,
        password: successfulPassword,
      },
    });
    expect(newPasswordSignIn.status).toBe(200);
    const rejectedPasswordSignIn = await authRequest("/sign-in/email", {
      body: {
        email,
        password: rejectedPassword,
      },
    });
    expect(rejectedPasswordSignIn.status).toBe(401);
  });

  it("never reactivates a restricted Owner through email verification sync", async () => {
    const marker = randomUUID();
    const email = `restricted-${marker}@example.test`;
    const inserted = await runtime.pool.query<{ id: string }>(
      `insert into auth.users (name, email, email_verified, created_at, updated_at)
       values ('Restricted Owner', $1, false, clock_timestamp(), clock_timestamp())
       returning id`,
      [email],
    );
    const authUserId = inserted.rows[0]?.id;
    if (!authUserId) {
      throw new Error("test Auth User was not inserted");
    }

    await expect(
      runtime.pool.query(
        `insert into platform.owners (
           auth_user_id,
           email,
           email_verified_at,
           status,
           restriction_reason_code,
           restricted_at
         )
         values (
           $1,
           $2,
           clock_timestamp(),
           'restricted',
           'forged_projection',
           clock_timestamp()
         )`,
        [authUserId, email],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      runtime.pool.query(
        `delete from platform.owners
         where auth_user_id = $1`,
        [authUserId],
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await runtime.pool.query(
      `update platform.owners
       set status = 'restricted',
           restricted_at = clock_timestamp(),
           restriction_reason_code = 'integration_test'
       where auth_user_id = $1`,
      [authUserId],
    );
    await expect(
      runtime.pool.query(
        `update platform.owners
         set email = 'forged-owner@example.test'
         where auth_user_id = $1`,
        [authUserId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await runtime.pool.query(
      `update auth.users
       set email_verified = true,
           updated_at = clock_timestamp()
       where id = $1`,
      [authUserId],
    );

    const result = await runtime.pool.query<{
      email_verified_at: Date | null;
      status: string;
    }>(
      `select status, email_verified_at
       from platform.owners
       where auth_user_id = $1`,
      [authUserId],
    );
    expect(result.rows[0]?.status).toBe("restricted");
    expect(result.rows[0]?.email_verified_at).toBeInstanceOf(Date);
  });

  it("completes the real Better Auth and Fastify bridge vertical path", async () => {
    const bridgeEmails: AuthEmail[] = [];
    const bridgeRuntime = createAlphaNetAuthRuntime(
      {
        baseUrl,
        databasePoolMax: 2,
        databaseUrl: databaseUrl ?? "",
        email: { mode: "local-preview" },
        emailDailyGlobalLimit: 10_000,
        redisUrl: redisUrl ?? "",
        secret: "bridge-integration-secret-that-is-long-enough-and-isolated-for-tests",
        secureCookies: false,
        trustedOrigins: [webOrigin],
      },
      {
        emailSender: {
          send: (message) => {
            bridgeEmails.push(message);
            return Promise.resolve();
          },
        },
        logger: {
          error: () => undefined,
          info: () => undefined,
        },
      },
    );
    const app = await createApiApp({
      allowedOrigins: [webOrigin],
      authRuntime: bridgeRuntime,
      environment: "test",
      version: "integration",
    });

    try {
      const marker = randomUUID();
      const email = `bridge-${marker}@example.test`;
      const password = "Bridge-password-2026!";
      const registration = await app.inject({
        headers: { origin: webOrigin },
        method: "POST",
        payload: {
          callbackURL: `${webOrigin}/home`,
          email,
          name: "Bridge Owner",
          password,
        },
        remoteAddress: bridgeTestClientIp,
        url: "/api/auth/sign-up/email",
      });
      expect(registration.statusCode).toBe(200);
      expect(registration.json()).toEqual({ status: true });
      expect(registration.body).not.toContain("user");
      expect(registration.headers["cache-control"]).toBe("no-store, private");

      const deadline = Date.now() + 3_000;
      while (
        !bridgeEmails.some(
          (message) => message.purpose === "verification" && message.recipient === email,
        ) &&
        Date.now() < deadline
      ) {
        await delay(10);
      }
      const verificationEmail = bridgeEmails.find(
        (message) => message.purpose === "verification" && message.recipient === email,
      );
      expect(verificationEmail).toBeDefined();
      const verificationUrl = new URL(verificationEmail?.actionUrl ?? "");
      const verification = await app.inject({
        method: "GET",
        url: `${verificationUrl.pathname}${verificationUrl.search}`,
      });
      expect(verification.statusCode).toBe(302);

      const signIn = await app.inject({
        headers: { origin: webOrigin },
        method: "POST",
        payload: {
          email,
          password,
        },
        remoteAddress: bridgeTestClientIp,
        url: "/api/auth/sign-in/email",
      });
      expect(signIn.statusCode).toBe(200);
      expect(signIn.json()).toEqual({ status: true });
      const sessionCookie = injectedCookieHeader(signIn.headers["set-cookie"]);
      expect(sessionCookie).toContain("alphanet.session_token=");

      const ownerSession = await app.inject({
        headers: { cookie: sessionCookie },
        method: "GET",
        url: "/v1/owner/session",
      });
      expect(ownerSession.statusCode).toBe(200);
      expect(ownerSession.json()).toMatchObject({
        owner: {
          email,
          emailVerified: true,
          name: "Bridge Owner",
          status: "active",
        },
      });
      expect(ownerSession.headers["cache-control"]).toBe("no-store, private");
    } finally {
      await app.close();
    }
  });

  it("pauses registration without creating an orphan Auth User", async () => {
    const email = `paused-${randomUUID()}@example.test`;
    await runtime.pool.query(
      `update platform.registration_controls
       set mode = 'paused',
           pause_reason_code = 'integration_test',
           updated_at = clock_timestamp()
       where id = true`,
    );

    try {
      const response = await authRequest("/sign-up/email", {
        body: {
          email,
          name: "Paused Registration",
          password: "Never-created-password-2026!",
        },
      });
      expect(response.status).toBe(503);

      const orphanCheck = await runtime.pool.query<{ count: number }>(
        `select count(*)::integer as count
         from auth.users
         where email = $1`,
        [email],
      );
      expect(orphanCheck.rows[0]?.count).toBe(0);
    } finally {
      await runtime.pool.query(
        `update platform.registration_controls
         set mode = 'open', updated_at = clock_timestamp()
         where id = true`,
      );
    }
  });
});
