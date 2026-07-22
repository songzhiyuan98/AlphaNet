import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiApp } from "../../apps/api/src/app.js";
import {
  createAlphaNetAuthRuntime,
  createRemoteMcpOAuthConsentService,
  type AlphaNetAuthRuntime,
  type AuthEmail,
} from "../../packages/auth/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";
const hasConfiguration = Boolean(databaseUrl && redisUrl);

if (mustRun && !hasConfiguration) {
  throw new Error(
    "DATABASE_URL and REDIS_URL are required when REQUIRE_INTEGRATION_SERVICES=true",
  );
}

const describeLiveOAuth = hasConfiguration ? describe : describe.skip;
const baseUrl = "http://127.0.0.1:4000";
const issuer = `${baseUrl}/api/auth`;
const jwksUrl = `${issuer}/jwks`;
const webOrigin = "http://127.0.0.1:3101";
const resource = "http://127.0.0.1:4100/mcp";
const redirectUri = "http://127.0.0.1:43111/oauth/callback";

function injectedCookieHeader(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responseRecord(body: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} did not return an object`);
  return parsed;
}

function redirectFrom(body: string, label: string): URL {
  const parsed = responseRecord(body, label);
  if (parsed["redirect"] !== true || typeof parsed["url"] !== "string") {
    throw new Error(`${label} did not return a redirect`);
  }
  return new URL(parsed["url"]);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} was not returned`);
  }
  return value;
}

function decodeJwtSegment(token: string, segment: number): Record<string, unknown> {
  const encoded = token.split(".")[segment];
  if (!encoded) throw new Error("Access token is not a compact JWT");
  return responseRecord(Buffer.from(encoded, "base64url").toString("utf8"), "JWT");
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

async function cleanupLiveFixture(
  runtime: AlphaNetAuthRuntime,
  clientId: string,
  email: string,
): Promise<void> {
  const cleanup = await runtime.pool.connect();
  try {
    await cleanup.query("begin");

    const activeAgents = await cleanup.query<{ count: string }>(
      `select count(*)::text as count
         from platform.agents as agent
         inner join platform.owners as owner
           on owner.id = agent.owner_id
         inner join auth.users as auth_user
           on auth_user.id = owner.auth_user_id
        where auth_user.email = $1
          and agent.status = 'active'
          and agent.deleted_at is null`,
      [email],
    );
    const activeAgentCount = BigInt(activeAgents.rows[0]?.count ?? "0");
    if (activeAgentCount > 0n) {
      await cleanup.query(
        `update platform.registration_controls
            set active_agent_count = greatest(
              active_agent_count - $1::bigint,
              0::bigint
            )
          where id = true`,
        [activeAgentCount.toString()],
      );
    }

    await cleanup.query(
      "alter table platform.credentials disable trigger credentials_prevent_delete",
    );
    await cleanup.query(
      "alter table platform.agent_policies disable trigger agent_policies_prevent_delete",
    );
    await cleanup.query(
      "alter table platform.agents disable trigger agents_prevent_delete",
    );
    await cleanup.query(
      "alter table platform.actors disable trigger actors_prevent_delete",
    );
    await cleanup.query(
      "alter table platform.owners disable trigger owners_prevent_delete",
    );
    await cleanup.query(
      "alter table platform.action_logs disable trigger action_logs_prevent_mutation",
    );

    await cleanup.query(
      `delete from auth.oauth_access_tokens
        where client_id = $1
           or user_id in (select id from auth.users where email = $2)`,
      [clientId, email],
    );
    await cleanup.query(
      `delete from auth.oauth_refresh_tokens
        where client_id = $1
           or user_id in (select id from auth.users where email = $2)`,
      [clientId, email],
    );
    await cleanup.query(
      `delete from auth.oauth_consents
        where client_id = $1
           or user_id in (select id from auth.users where email = $2)`,
      [clientId, email],
    );
    await cleanup.query(
      `delete from auth.verifications
        where value in (
                select id::text from auth.users where email = $2
              )
           or position($1::text in identifier) > 0
           or position($1::text in value) > 0
           or position(lower($2::text) in lower(identifier)) > 0
           or position(lower($2::text) in lower(value)) > 0`,
      [clientId, email],
    );
    await cleanup.query(
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
    await cleanup.query(
      `delete from platform.oauth_access_token_jtis
        where oauth_client_id = $1
           or grant_id in (
                select id
                  from platform.oauth_grants
                 where oauth_client_id = $1
              )`,
      [clientId],
    );
    await cleanup.query(
      `with deleted_grants as (
         delete from platform.oauth_grants
          where oauth_client_id = $1
          returning authorization_request_id
       ),
       deleted_requests as (
         delete from platform.oauth_authorization_requests
          where oauth_client_id = $1
             or id in (
                  select authorization_request_id from deleted_grants
                )
          returning id
       )
       select
         (select count(*) from deleted_grants)::integer as grants,
         (select count(*) from deleted_requests)::integer as requests`,
      [clientId],
    );
    await cleanup.query(
      `delete from platform.credentials
        where agent_id in (
          select agent.id
            from platform.agents as agent
            inner join platform.owners as owner
              on owner.id = agent.owner_id
            inner join auth.users as auth_user
              on auth_user.id = owner.auth_user_id
           where auth_user.email = $1
        )`,
      [email],
    );
    await cleanup.query(
      `delete from platform.agent_policies
        where agent_id in (
          select agent.id
            from platform.agents as agent
            inner join platform.owners as owner
              on owner.id = agent.owner_id
            inner join auth.users as auth_user
              on auth_user.id = owner.auth_user_id
           where auth_user.email = $1
        )`,
      [email],
    );
    await cleanup.query(
      `delete from platform.agents
        where owner_id in (
          select owner.id
            from platform.owners as owner
            inner join auth.users as auth_user
              on auth_user.id = owner.auth_user_id
           where auth_user.email = $1
        )`,
      [email],
    );
    await cleanup.query(
      `delete from platform.actors
        where owner_id in (
          select owner.id
            from platform.owners as owner
            inner join auth.users as auth_user
              on auth_user.id = owner.auth_user_id
           where auth_user.email = $1
        )`,
      [email],
    );
    await cleanup.query(
      `delete from platform.owners
        where auth_user_id in (select id from auth.users where email = $1)`,
      [email],
    );
    await cleanup.query("delete from auth.users where email = $1", [email]);
    await cleanup.query("delete from auth.oauth_clients where client_id = $1", [
      clientId,
    ]);

    await cleanup.query(
      "alter table platform.action_logs enable trigger action_logs_prevent_mutation",
    );
    await cleanup.query(
      "alter table platform.owners enable trigger owners_prevent_delete",
    );
    await cleanup.query(
      "alter table platform.actors enable trigger actors_prevent_delete",
    );
    await cleanup.query(
      "alter table platform.agents enable trigger agents_prevent_delete",
    );
    await cleanup.query(
      "alter table platform.agent_policies enable trigger agent_policies_prevent_delete",
    );
    await cleanup.query(
      "alter table platform.credentials enable trigger credentials_prevent_delete",
    );

    const remaining = await cleanup.query<{
      access_tokens: number;
      auth_users: number;
      clients: number;
      consents: number;
      grants: number;
      jtis: number;
      owners: number;
      outbox_events: number;
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
    expect(remaining.rows[0]).toEqual({
      access_tokens: 0,
      auth_users: 0,
      clients: 0,
      consents: 0,
      grants: 0,
      jtis: 0,
      owners: 0,
      outbox_events: 0,
      refresh_tokens: 0,
      requests: 0,
      verifications: 0,
    });

    await cleanup.query("commit");
  } catch (error) {
    await cleanup.query("rollback");
    throw error;
  } finally {
    cleanup.release();
  }
}

describeLiveOAuth("Remote MCP OAuth live refresh integration", () => {
  const marker = randomUUID().replaceAll("-", "").slice(0, 16);
  const clientIp = `2001:db8:${marker.slice(0, 4)}:${marker.slice(4, 8)}::3`;
  const clientId = `oauth-live-refresh-${marker}`;
  const email = `oauth-live-refresh-${marker}@example.test`;
  const password = "OAuth-live-refresh-password-2026!";
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
  const emails: AuthEmail[] = [];
  let runtime!: AlphaNetAuthRuntime;
  let runtimeIsOpen = false;
  let app!: Awaited<ReturnType<typeof createApiApp>>;

  beforeAll(async () => {
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
        logger: {
          error: () => undefined,
          info: () => undefined,
        },
      },
    );
    runtimeIsOpen = true;

    try {
      await runtime.pool.query(
        `insert into platform.oauth_resource_configuration (id, resource)
         values (true, $1::text)
         on conflict (id) do nothing`,
        [resource],
      );
      const configured = await runtime.pool.query<{ resource: string }>(
        `select resource
           from platform.oauth_resource_configuration
          where id = true`,
      );
      if (configured.rows[0]?.resource !== resource) {
        throw new Error("The integration database has a different MCP resource");
      }

      const consentService = createRemoteMcpOAuthConsentService(runtime.pool, {
        authorizationBindingKey,
        continuationKey,
      });
      app = await createApiApp({
        allowedOrigins: [webOrigin],
        authRuntime: runtime,
        environment: "test",
        remoteMcpOAuthConsent: {
          resource,
          service: consentService,
        },
        version: "integration",
      });
    } catch (error) {
      await runtime.close();
      runtimeIsOpen = false;
      throw error;
    }
  });

  afterAll(async () => {
    if (!runtimeIsOpen) return;
    try {
      await cleanupLiveFixture(runtime, clientId, email);
    } finally {
      if (app) {
        await app.close();
      } else {
        await runtime.close();
      }
      runtimeIsOpen = false;
    }
  });

  async function waitForVerificationEmail(): Promise<AuthEmail> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const message = emails.find(
        (candidate) =>
          candidate.purpose === "verification" && candidate.recipient === email,
      );
      if (message) return message;
      await delay(10);
    }
    throw new Error("Timed out waiting for the verification email");
  }

  it("rotates refresh tokens and compromises the Owner-client family on reuse", async () => {
    expect(runtime.remoteMcpOAuthEnabled).toBe(true);
    await expect(runtime.checkReady()).resolves.toBeUndefined();

    await runtime.pool.query(
      `insert into auth.oauth_clients (
         client_id, disabled, skip_consent, scopes, created_at, updated_at,
         name, redirect_uris, token_endpoint_auth_method, grant_types,
         response_types, public, require_pkce
       ) values (
         $1::text, false, false, $2::jsonb,
         clock_timestamp(), clock_timestamp(),
         'AlphaNet Live Refresh Integration Client', $3::jsonb, 'none',
         $4::jsonb, '["code"]'::jsonb, true, true
       )`,
      [
        clientId,
        JSON.stringify(["research:read", "offline_access"]),
        JSON.stringify([redirectUri]),
        JSON.stringify(["authorization_code", "refresh_token"]),
      ],
    );

    const registration = await app.inject({
      headers: { origin: webOrigin },
      method: "POST",
      payload: { email, name: "OAuth Live Refresh Owner", password },
      remoteAddress: clientIp,
      url: "/api/auth/sign-up/email",
    });
    expect(registration.statusCode).toBe(200);
    const verificationEmail = await waitForVerificationEmail();
    const verificationUrl = new URL(verificationEmail.actionUrl);
    const verification = await app.inject({
      method: "GET",
      url: `${verificationUrl.pathname}${verificationUrl.search}`,
    });
    expect(verification.statusCode).toBe(302);

    const signIn = await app.inject({
      headers: { origin: webOrigin },
      method: "POST",
      payload: { email, password },
      remoteAddress: clientIp,
      url: "/api/auth/sign-in/email",
    });
    expect(signIn.statusCode).toBe(200);
    const sessionCookie = injectedCookieHeader(signIn.headers["set-cookie"]);
    expect(sessionCookie.includes("alphanet.session_token=")).toBe(true);

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
           'Live Refresh Research Agent', 'active')`,
        [actorId, ownerId, `oauth-refresh-${marker}`],
      );
      await setup.query(
        `insert into platform.agents (
           id, actor_id, owner_id, discovery_tags, status, activated_at
         ) values ($1::uuid, $2::uuid, $3::uuid,
           array['oauth-live-refresh']::text[], 'active', clock_timestamp())`,
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
      scope: "research:read offline_access",
      state,
    });
    const authorize = await app.inject({
      headers: { accept: "application/json", cookie: sessionCookie },
      method: "GET",
      remoteAddress: clientIp,
      url: `/api/auth/oauth2/authorize?${authorizeParameters}`,
    });
    expect(authorize.statusCode).toBe(200);
    const postLoginRedirect = redirectFrom(authorize.body, "authorize");
    expect(postLoginRedirect.origin).toBe(webOrigin);
    expect(postLoginRedirect.pathname).toBe("/oauth/consent");
    const postLoginQuery = postLoginRedirect.search.slice(1);

    const mutationHeaders = {
      cookie: sessionCookie,
      origin: webOrigin,
      "sec-fetch-site": "same-origin",
    };
    const inspect = await app.inject({
      headers: mutationHeaders,
      method: "POST",
      payload: { oauth_query: postLoginQuery },
      url: "/v1/owner/remote-mcp/oauth/consent/inspect",
    });
    expect(inspect.statusCode).toBe(200);
    expect(responseRecord(inspect.body, "consent inspect")).toMatchObject({
      phase: "agent_selection",
      selected_agent_id: null,
    });

    const select = await app.inject({
      headers: mutationHeaders,
      method: "POST",
      payload: { agent_id: agentId, oauth_query: postLoginQuery },
      url: "/v1/owner/remote-mcp/oauth/consent/select-agent",
    });
    expect(select.statusCode).toBe(200);
    const selection = responseRecord(select.body, "consent selection");
    expect({
      phase: selection["phase"],
      selected_agent_id: selection["selected_agent_id"],
    }).toEqual({ phase: "consent_review", selected_agent_id: agentId });
    const continuationHandle = requiredString(
      selection["continuation_handle"],
      "OAuth continuation",
    );

    const continueAuthorization = await app.inject({
      headers: {
        ...mutationHeaders,
        accept: "application/json",
        "x-alphanet-oauth-continuation": continuationHandle,
      },
      method: "POST",
      payload: { oauth_query: postLoginQuery, postLogin: true },
      remoteAddress: clientIp,
      url: "/api/auth/oauth2/continue",
    });
    expect(continueAuthorization.statusCode).toBe(200);
    const consentRedirect = redirectFrom(
      continueAuthorization.body,
      "continued authorization",
    );
    expect(consentRedirect.origin).toBe(webOrigin);
    expect(consentRedirect.pathname).toBe("/oauth/consent");
    const consentQuery = consentRedirect.search.slice(1);
    expect(consentQuery).not.toBe(postLoginQuery);

    const review = await app.inject({
      headers: mutationHeaders,
      method: "POST",
      payload: {
        continuation_handle: continuationHandle,
        oauth_query: consentQuery,
      },
      url: "/v1/owner/remote-mcp/oauth/consent/inspect",
    });
    expect(review.statusCode).toBe(200);
    const reviewBody = responseRecord(review.body, "consent review");
    expect({
      phase: reviewBody["phase"],
      selected_agent_id: reviewBody["selected_agent_id"],
    }).toEqual({ phase: "consent_review", selected_agent_id: agentId });

    const consent = await app.inject({
      headers: {
        ...mutationHeaders,
        accept: "application/json",
        "x-alphanet-oauth-continuation": continuationHandle,
      },
      method: "POST",
      payload: { accept: true, oauth_query: consentQuery },
      remoteAddress: clientIp,
      url: "/api/auth/oauth2/consent",
    });
    expect(consent.statusCode).toBe(200);
    const clientRedirect = redirectFrom(consent.body, "consent acceptance");
    expect(`${clientRedirect.origin}${clientRedirect.pathname}`).toBe(redirectUri);
    expect(clientRedirect.searchParams.get("state")).toBe(state);
    expect(clientRedirect.searchParams.get("iss")).toBe(issuer);
    const authorizationCode = requiredString(
      clientRedirect.searchParams.get("code"),
      "authorization code",
    );

    const codeExchange = await app.inject({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      payload: new URLSearchParams({
        client_id: clientId,
        code: authorizationCode,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        resource,
      }).toString(),
      remoteAddress: clientIp,
      url: "/api/auth/oauth2/token",
    });
    expect(codeExchange.statusCode).toBe(200);
    expect(codeExchange.headers["cache-control"]).toContain("no-store");
    expect(codeExchange.headers["pragma"]).toBe("no-cache");
    const codeTokens = responseRecord(codeExchange.body, "authorization code exchange");
    expect({
      expires_in: codeTokens["expires_in"],
      scope: codeTokens["scope"],
      token_type: codeTokens["token_type"],
    }).toEqual({
      expires_in: 600,
      scope: "research:read offline_access",
      token_type: "Bearer",
    });
    const access1 = requiredString(codeTokens["access_token"], "first access token");
    const refresh1 = requiredString(codeTokens["refresh_token"], "first refresh token");
    expect(refresh1.startsWith("aln_rt_v1_")).toBe(true);
    const access1Claims = decodeJwtSegment(access1, 1);
    expect({
      aud: access1Claims["aud"],
      azp: access1Claims["azp"],
      grant_epoch: access1Claims["grant_epoch"],
      iss: access1Claims["iss"],
      scope: access1Claims["scope"],
    }).toEqual({
      aud: resource,
      azp: clientId,
      grant_epoch: 1,
      iss: issuer,
      scope: "research:read offline_access",
    });
    const grantId = requiredString(access1Claims["sub"], "Grant subject");

    const refresh = (refreshToken: string) =>
      app.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        payload: new URLSearchParams({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          resource,
        }).toString(),
        remoteAddress: clientIp,
        url: "/api/auth/oauth2/token",
      });

    const rotation = await refresh(refresh1);
    expect(rotation.statusCode).toBe(200);
    expect(rotation.headers["cache-control"]).toContain("no-store");
    expect(rotation.headers["pragma"]).toBe("no-cache");
    const rotatedTokens = responseRecord(rotation.body, "refresh rotation");
    expect({
      expires_in: rotatedTokens["expires_in"],
      scope: rotatedTokens["scope"],
      token_type: rotatedTokens["token_type"],
    }).toEqual({
      expires_in: 600,
      scope: "research:read offline_access",
      token_type: "Bearer",
    });
    const access2 = requiredString(rotatedTokens["access_token"], "second access token");
    const refresh2 = requiredString(
      rotatedTokens["refresh_token"],
      "second refresh token",
    );
    expect(refresh2.startsWith("aln_rt_v1_")).toBe(true);
    expect(tokenFingerprint(refresh2)).not.toBe(tokenFingerprint(refresh1));
    expect(tokenFingerprint(access2)).not.toBe(tokenFingerprint(access1));
    const access2Claims = decodeJwtSegment(access2, 1);
    expect({
      aud: access2Claims["aud"],
      azp: access2Claims["azp"],
      grant_epoch: access2Claims["grant_epoch"],
      iss: access2Claims["iss"],
      scope: access2Claims["scope"],
      sub: access2Claims["sub"],
    }).toEqual({
      aud: resource,
      azp: clientId,
      grant_epoch: 1,
      iss: issuer,
      scope: "research:read offline_access",
      sub: grantId,
    });

    const afterRotation = await runtime.pool.query<{
      active_jtis: number;
      active_refresh_tokens: number;
      credential_revoked: boolean;
      grant_status: string;
      jtis: number;
      refresh_tokens: number;
      token_epoch: string;
    }>(
      `select
         oauth_grant.status as grant_status,
         oauth_grant.token_epoch::text,
         credential.revoked_at is not null as credential_revoked,
         (select count(*)::integer
            from platform.oauth_access_token_jtis as token_jti
           where token_jti.grant_id = oauth_grant.id) as jtis,
         (select count(*)::integer
            from platform.oauth_access_token_jtis as token_jti
           where token_jti.grant_id = oauth_grant.id
             and token_jti.status = 'active') as active_jtis,
         (select count(*)::integer
            from auth.oauth_refresh_tokens as refresh_token
           where refresh_token.reference_id = oauth_grant.id::text) as refresh_tokens,
         (select count(*)::integer
            from auth.oauth_refresh_tokens as refresh_token
           where refresh_token.reference_id = oauth_grant.id::text
             and refresh_token.revoked is null) as active_refresh_tokens
       from platform.oauth_grants as oauth_grant
       inner join platform.credentials as credential
         on credential.id = oauth_grant.credential_id
       where oauth_grant.id = $1::uuid`,
      [grantId],
    );
    expect(afterRotation.rows).toEqual([
      {
        active_jtis: 2,
        active_refresh_tokens: 1,
        credential_revoked: false,
        grant_status: "active",
        jtis: 2,
        refresh_tokens: 2,
        token_epoch: "1",
      },
    ]);

    const [replayA, replayB] = await Promise.all([refresh(refresh1), refresh(refresh1)]);
    for (const replay of [replayA, replayB]) {
      expect(replay.statusCode).toBe(400);
      expect(replay.headers["cache-control"]).toContain("no-store");
      expect(replay.headers["pragma"]).toBe("no-cache");
      const error = responseRecord(replay.body, "refresh replay");
      expect({ error: error["error"] }).toEqual({ error: "invalid_grant" });
    }

    const compromised = await runtime.pool.query<{
      active_jtis: number;
      active_refresh_tokens: number;
      credential_revoked: boolean;
      grant_status: string;
      jtis: number;
      jtis_revoked_for_reuse: number;
      reason_code: string;
      refresh_tokens: number;
      revoked_refresh_tokens: number;
      token_epoch: string;
    }>(
      `select
         oauth_grant.status as grant_status,
         oauth_grant.token_epoch::text,
         oauth_grant.reason_code,
         credential.revoked_at is not null as credential_revoked,
         (select count(*)::integer
            from platform.oauth_access_token_jtis as token_jti
           where token_jti.grant_id = oauth_grant.id) as jtis,
         (select count(*)::integer
            from platform.oauth_access_token_jtis as token_jti
           where token_jti.grant_id = oauth_grant.id
             and token_jti.status = 'active') as active_jtis,
         (select count(*)::integer
            from platform.oauth_access_token_jtis as token_jti
           where token_jti.grant_id = oauth_grant.id
             and token_jti.status = 'revoked'
             and token_jti.revocation_reason_code = 'refresh_token_reuse')
           as jtis_revoked_for_reuse,
         (select count(*)::integer
            from auth.oauth_refresh_tokens as refresh_token
           where refresh_token.reference_id = oauth_grant.id::text) as refresh_tokens,
         (select count(*)::integer
            from auth.oauth_refresh_tokens as refresh_token
           where refresh_token.reference_id = oauth_grant.id::text
             and refresh_token.revoked is null) as active_refresh_tokens,
         (select count(*)::integer
            from auth.oauth_refresh_tokens as refresh_token
           where refresh_token.reference_id = oauth_grant.id::text
             and refresh_token.revoked is not null) as revoked_refresh_tokens
       from platform.oauth_grants as oauth_grant
       inner join platform.credentials as credential
         on credential.id = oauth_grant.credential_id
       where oauth_grant.id = $1::uuid`,
      [grantId],
    );
    expect(compromised.rows).toEqual([
      {
        active_jtis: 0,
        active_refresh_tokens: 0,
        credential_revoked: true,
        grant_status: "compromised",
        jtis: 2,
        jtis_revoked_for_reuse: 2,
        reason_code: "refresh_token_reuse",
        refresh_tokens: 2,
        revoked_refresh_tokens: 2,
        token_epoch: "2",
      },
    ]);

    const compromisedRefresh = await refresh(refresh2);
    expect(compromisedRefresh.statusCode).toBe(400);
    const compromisedError = responseRecord(
      compromisedRefresh.body,
      "compromised refresh family",
    );
    expect({ error: compromisedError["error"] }).toEqual({
      error: "invalid_grant",
    });

    const finalCounts = await runtime.pool.query<{
      active_jtis: number;
      active_refresh_tokens: number;
      jtis: number;
      refresh_tokens: number;
    }>(
      `select
         (select count(*)::integer
            from platform.oauth_access_token_jtis
           where grant_id = $1::uuid) as jtis,
         (select count(*)::integer
            from platform.oauth_access_token_jtis
           where grant_id = $1::uuid and status = 'active') as active_jtis,
         (select count(*)::integer
            from auth.oauth_refresh_tokens
           where reference_id = $1::text) as refresh_tokens,
         (select count(*)::integer
            from auth.oauth_refresh_tokens
           where reference_id = $1::text and revoked is null)
           as active_refresh_tokens`,
      [grantId],
    );
    expect(finalCounts.rows).toEqual([
      {
        active_jtis: 0,
        active_refresh_tokens: 0,
        jtis: 2,
        refresh_tokens: 2,
      },
    ]);
  });
});
