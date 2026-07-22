import { createHash, createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createAlphaNetRemoteMcpOAuthSecurityStore,
  createRemoteMcpAuthorizationBindingDigest,
  digestInboundMcpTokenJti,
  RemoteMcpOAuthGuardError,
  type AlphaNetRemoteMcpOAuthSecurityStoreOptions,
} from "../../packages/auth/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeRemoteMcpOAuthStore = databaseUrl ? describe : describe.skip;
const resource = "http://127.0.0.1:4100/mcp";
const redirectUri = "http://127.0.0.1:43110/oauth/callback";
const domainScopes = ["research:read"] as const;
const providerScopes = ["research:read", "offline_access"] as const;
const authorizationBindingKey = Buffer.alloc(32, 0x41);
const refreshTokenStorageKey = Buffer.alloc(32, 0x42);
const tokenJtiDigestKey = Buffer.alloc(32, 0x43);
const codeVerifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";

type OAuthStorePool = AlphaNetRemoteMcpOAuthSecurityStoreOptions["pool"];

interface PgModule {
  Pool: new (config: Record<string, unknown>) => OAuthStorePool;
}

function isPgModule(value: unknown): value is PgModule {
  return (
    value !== null &&
    typeof value === "object" &&
    "Pool" in value &&
    typeof value.Pool === "function"
  );
}

const authRequire = createRequire(`${process.cwd()}/packages/auth/package.json`);
const pgModule: unknown = authRequire("pg");
if (!isPgModule(pgModule)) throw new Error("The pg module is unavailable");
const { Pool } = pgModule;

interface Fixture {
  actorId: string;
  agentId: string;
  authUserId: string;
  ownerId: string;
  sessionId: string;
}

function requireValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new Error(`${label} was not created`);
  }
  return value;
}

describeRemoteMcpOAuthStore("Remote MCP OAuth PostgreSQL security store", () => {
  const pool = new Pool({
    application_name: "alphanet-remote-mcp-oauth-store-integration",
    connectionString: databaseUrl,
    max: 4,
    statement_timeout: 2_000,
  });
  const authorityPool = new Pool({
    application_name: "alphanet-remote-mcp-oauth-authority-integration",
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1_000,
    max: 1,
    statement_timeout: 2_000,
  });
  const lockPool = new Pool({
    application_name: "alphanet-remote-mcp-oauth-lock-integration",
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1_000,
    max: 1,
    statement_timeout: 2_000,
  });
  const marker = randomUUID().replaceAll("-", "").slice(0, 12);
  const clientId = `oauth-store-${marker}`;
  const codeChallenge = createHash("sha256")
    .update(codeVerifier, "ascii")
    .digest("base64url");
  const store = createAlphaNetRemoteMcpOAuthSecurityStore({
    authorizationBindingKey,
    lockPool,
    pool: authorityPool,
    refreshTokenStorageKey,
    tokenJtiDigestKey,
  });
  let fixture!: Fixture;

  beforeAll(async () => {
    await pool.query(
      `insert into platform.oauth_resource_configuration (id, resource)
       values (true, $1)
       on conflict (id) do nothing`,
      [resource],
    );
    const configured = await pool.query<{ resource: string }>(
      `select resource from platform.oauth_resource_configuration where id = true`,
    );
    if (configured.rows[0]?.resource !== resource) {
      throw new Error("The integration database has a different MCP resource");
    }

    const authUserId = randomUUID();
    const actorId = randomUUID();
    const agentId = randomUUID();
    const sessionId = randomUUID();
    await pool.query(
      `insert into auth.users (
         id, name, email, email_verified, created_at, updated_at
       )
       values ($1, $2, $3, true, clock_timestamp(), clock_timestamp())`,
      [authUserId, "OAuth Store Owner", `oauth-store-${marker}@example.test`],
    );
    const owners = await pool.query<{ id: string }>(
      `select id::text from platform.owners where auth_user_id = $1::uuid`,
      [authUserId],
    );
    const ownerId = requireValue(owners.rows[0]?.id, "Owner");
    await pool.query(
      `insert into auth.sessions (id, expires_at, token, updated_at, user_id)
       values ($1, clock_timestamp() + interval '1 hour', $2,
         clock_timestamp(), $3)`,
      [sessionId, `oauth-store-session-${marker}-${randomUUID()}`, authUserId],
    );
    const setupClient = await pool.connect();
    try {
      await setupClient.query("begin");
      await setupClient.query(
        `insert into platform.actors (
           id, kind, owner_id, handle, display_name, status
         ) values ($1, 'agent', $2, $3, 'OAuth Store Agent', 'active')`,
        [actorId, ownerId, `oauth-store-${marker}`],
      );
      await setupClient.query(
        `insert into platform.agents (
           id, actor_id, owner_id, discovery_tags, status, activated_at
         ) values ($1, $2, $3, array['oauth-test']::text[],
           'active', clock_timestamp())`,
        [agentId, actorId, ownerId],
      );
      await setupClient.query(
        `insert into platform.agent_policies (
           agent_id, tier, defaults_version, policy_schema_version,
           version, rules, is_active, configured_by_owner_id
         ) values ($1, 'assisted', 'agent-permission-defaults-v1',
           1, 1, '{}'::jsonb, true, $2)`,
        [agentId, ownerId],
      );
      await setupClient.query(
        `update platform.registration_controls
         set active_agent_count = active_agent_count + 1
         where id = true`,
      );
      await setupClient.query("commit");
    } catch (error) {
      await setupClient.query("rollback");
      throw error;
    } finally {
      setupClient.release();
    }

    await pool.query(
      `insert into auth.oauth_clients (
         client_id, disabled, skip_consent, scopes, created_at, updated_at,
         name, redirect_uris, token_endpoint_auth_method, grant_types,
         response_types, public, require_pkce
       ) values (
         $1, false, false, $2::jsonb, clock_timestamp(), clock_timestamp(),
         'AlphaNet OAuth Store Client', $3::jsonb, 'none', $4::jsonb,
         '["code"]'::jsonb, true, true
       )`,
      [
        clientId,
        JSON.stringify(providerScopes),
        JSON.stringify([redirectUri]),
        JSON.stringify(["authorization_code", "refresh_token"]),
      ],
    );
    fixture = { actorId, agentId, authUserId, ownerId, sessionId };
  });

  afterAll(async () => {
    await Promise.all([pool.end(), authorityPool.end(), lockPool.end()]);
  });

  it("activates before JTI persistence and allows nested refresh signing without lock inversion", async () => {
    const authorizeInput = {
      canonicalScope: providerScopes.join(" "),
      clientId,
      codeChallenge,
      codeChallengeMethod: "S256" as const,
      redirectUri,
      requestedScopes: providerScopes,
      resource,
      responseType: "code" as const,
    };
    await store.persistAuthorizationRequestEnvelope(authorizeInput);
    await store.persistAuthorizationRequestEnvelope(authorizeInput);

    const bindingDigest = createRemoteMcpAuthorizationBindingDigest(
      {
        clientId,
        codeChallenge,
        redirectUri,
        requestedScopes: providerScopes,
      },
      authorizationBindingKey,
    );
    const requests = await pool.query<{ id: string }>(
      `select id::text
       from platform.oauth_authorization_requests
       where binding_digest = $1`,
      [bindingDigest],
    );
    const requestId = requireValue(requests.rows[0]?.id, "Authorization Request");
    await pool.query(
      `update platform.oauth_authorization_requests
       set status = 'selected', owner_id = $1, agent_id = $2,
           owner_session_id = $3
       where id = $4`,
      [fixture.ownerId, fixture.agentId, fixture.sessionId, requestId],
    );

    const credentialId = randomUUID();
    const grantId = randomUUID();
    const grantExpiresAt = new Date(Date.now() + 29 * 24 * 60 * 60 * 1_000);
    await pool.query(
      `insert into platform.credentials (
         id, owner_id, agent_id, name, credential_type, scopes, audience,
         policy_ceiling, policy_ceiling_defaults_version,
         policy_ceiling_schema_version, policy_ceiling_rules, expires_at
       ) values (
         $1, $2, $3, 'Remote MCP OAuth Pending Grant', 'oauth_grant',
         $4::text[], $5, 'assisted', 'agent-permission-defaults-v1',
         1, '{}'::jsonb, $6
       )`,
      [
        credentialId,
        fixture.ownerId,
        fixture.agentId,
        [...domainScopes],
        resource,
        grantExpiresAt,
      ],
    );
    await pool.query(
      `insert into platform.oauth_grants (
         id, owner_id, auth_user_id, agent_id, credential_id,
         authorization_request_id, oauth_client_id, resource, scopes,
         offline_access, expires_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], true, $10)`,
      [
        grantId,
        fixture.ownerId,
        fixture.authUserId,
        fixture.agentId,
        credentialId,
        requestId,
        clientId,
        resource,
        [...domainScopes],
        grantExpiresAt,
      ],
    );

    const pendingIssuedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    await expect(
      store.persistAccessTokenAuthority({
        authUserId: fixture.authUserId,
        expiresAt: new Date(pendingIssuedAt.valueOf() + 10 * 60 * 1_000),
        grantId,
        issuedAt: pendingIssuedAt,
        jti: randomUUID(),
        oauthClientId: clientId,
        protocolScopes: providerScopes,
        resource,
        scopes: domainScopes,
      }),
    ).rejects.toMatchObject({ code: "ACCESS_TOKEN_AUTHORITY_INVALID" });

    // Consent claim consumes the selected request and binds the still-pending
    // Grant before the token boundary performs its final activation.
    await pool.query(
      `update platform.oauth_authorization_requests
       set status = 'consumed', grant_id = $1
       where id = $2`,
      [grantId, requestId],
    );

    const authorizationCode = randomUUID().replaceAll("-", "");
    const providerAuthorizationCodeDigest = createHmac("sha256", refreshTokenStorageKey)
      .update("alphanet:authorization_code:v1\0", "utf8")
      .update(authorizationCode, "utf8")
      .digest("base64url");
    const authorizationCodeDigest = createHash("sha256")
      .update(providerAuthorizationCodeDigest, "utf8")
      .digest("base64url");
    await pool.query(
      `insert into auth.verifications (identifier, value, expires_at)
       values ($1, $2, clock_timestamp() + interval '5 minutes')`,
      [
        authorizationCodeDigest,
        JSON.stringify({
          query: {
            client_id: clientId,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            redirect_uri: redirectUri,
            response_type: "code",
            scope: providerScopes.join(" "),
          },
          referenceId: grantId,
          sessionId: fixture.sessionId,
          type: "authorization_code",
          userId: fixture.authUserId,
        }),
      ],
    );

    const issuedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const jti = randomUUID();
    const authority = await store.withAuthorizationCodeExchangeLock(
      {
        authorizationCode,
        clientId,
        codeVerifier,
        redirectUri,
        resource,
      },
      async (lockedAuthority) => {
        expect(lockedAuthority).toEqual({ grantId });
        await store.activateAuthorizationGrant({
          authUserId: fixture.authUserId,
          codeChallenge,
          codeChallengeMethod: "S256",
          grantId,
          oauthClientId: clientId,
          ownerSessionId: fixture.sessionId,
          redirectUri,
          resource,
          scopes: providerScopes,
        });
        return store.persistAccessTokenAuthority({
          authUserId: fixture.authUserId,
          expiresAt: new Date(issuedAt.valueOf() + 10 * 60 * 1_000),
          grantId,
          issuedAt,
          jti,
          oauthClientId: clientId,
          protocolScopes: providerScopes,
          resource,
          scopes: domainScopes,
        });
      },
    );
    const expectedJtiDigest = digestInboundMcpTokenJti(jti, tokenJtiDigestKey);
    expect(authority).toEqual({
      credentialId,
      grantEpoch: 1,
      tokenJtiDigest: expectedJtiDigest,
    });

    const persisted = await pool.query<{
      credential_revoked_at: Date | null;
      grant_status: string;
      jti_digest: Buffer;
      request_grant_id: string;
      request_status: string;
    }>(
      `select
         authorization_request.status as request_status,
         authorization_request.grant_id::text as request_grant_id,
         oauth_grant.status as grant_status,
         credential.revoked_at as credential_revoked_at,
         token_jti.jti_digest
       from platform.oauth_grants as oauth_grant
       inner join platform.oauth_authorization_requests as authorization_request
         on authorization_request.id = oauth_grant.authorization_request_id
       inner join platform.credentials as credential
         on credential.id = oauth_grant.credential_id
       inner join platform.oauth_access_token_jtis as token_jti
         on token_jti.grant_id = oauth_grant.id
       where oauth_grant.id = $1`,
      [grantId],
    );
    expect(persisted.rows[0]).toMatchObject({
      credential_revoked_at: null,
      grant_status: "active",
      request_grant_id: grantId,
      request_status: "consumed",
    });
    expect(persisted.rows[0]?.jti_digest.toString("base64url")).toBe(expectedJtiDigest);

    const refreshBody = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
    const refreshToken = `aln_rt_v1_${refreshBody}`;
    const storedRefreshDigest = createHmac("sha256", refreshTokenStorageKey)
      .update("alphanet:refresh_token:v1\0", "utf8")
      .update(refreshBody, "utf8")
      .digest("base64url");
    const refreshCreatedAt = new Date();
    await pool.query(
      `insert into auth.oauth_refresh_tokens (
         id, token, client_id, user_id, reference_id, expires_at,
         created_at, auth_time, scopes
       ) values ($1, $2, $3, $4, $5, $6, $7, $7, $8::jsonb)`,
      [
        randomUUID(),
        storedRefreshDigest,
        clientId,
        fixture.authUserId,
        grantId,
        new Date(refreshCreatedAt.valueOf() + 24 * 60 * 60 * 1_000),
        refreshCreatedAt,
        JSON.stringify(providerScopes),
      ],
    );
    const nestedJti = randomUUID();
    const execute = vi.fn(async () => {
      const nestedIssuedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
      await expect(
        store.persistAccessTokenAuthority({
          authUserId: fixture.authUserId,
          expiresAt: new Date(nestedIssuedAt.valueOf() + 10 * 60 * 1_000),
          grantId,
          issuedAt: nestedIssuedAt,
          jti: nestedJti,
          oauthClientId: clientId,
          protocolScopes: providerScopes,
          resource,
          scopes: domainScopes,
        }),
      ).resolves.toMatchObject({ credentialId, grantEpoch: 1 });
      return "rotated";
    });
    await expect(
      store.withOwnerClientRefreshLock({ clientId, refreshToken, resource }, execute),
    ).resolves.toBe("rotated");
    expect(execute).toHaveBeenCalledOnce();
    const nestedDigest = digestInboundMcpTokenJti(nestedJti, tokenJtiDigestKey);
    const nestedAuthority = await pool.query<{ jti_digest: Buffer }>(
      `select jti_digest
       from platform.oauth_access_token_jtis
       where grant_id = $1::uuid and jti_digest = $2`,
      [grantId, Buffer.from(nestedDigest, "base64url")],
    );
    expect(nestedAuthority.rowCount).toBe(1);

    await pool.query(
      `update auth.oauth_refresh_tokens
       set revoked = clock_timestamp()
       where token = $1`,
      [storedRefreshDigest],
    );
    const replayCallback = vi.fn(() => Promise.resolve("must-not-run"));
    await expect(
      store.withOwnerClientRefreshLock(
        { clientId, refreshToken, resource },
        replayCallback,
      ),
    ).rejects.toBeInstanceOf(RemoteMcpOAuthGuardError);
    expect(replayCallback).not.toHaveBeenCalled();

    const compromised = await pool.query<{
      credential_revoked_at: Date | null;
      grant_status: string;
      jti_status: string;
      token_epoch: string;
    }>(
      `select
         oauth_grant.status as grant_status,
         oauth_grant.token_epoch::text,
         credential.revoked_at as credential_revoked_at,
         token_jti.status as jti_status
       from platform.oauth_grants as oauth_grant
       inner join platform.credentials as credential
         on credential.id = oauth_grant.credential_id
       inner join platform.oauth_access_token_jtis as token_jti
         on token_jti.grant_id = oauth_grant.id
       where oauth_grant.id = $1`,
      [grantId],
    );
    expect(compromised.rows[0]).toMatchObject({
      grant_status: "compromised",
      jti_status: "revoked",
      token_epoch: "2",
    });
    expect(compromised.rows[0]?.credential_revoked_at).toBeInstanceOf(Date);
  });
});
