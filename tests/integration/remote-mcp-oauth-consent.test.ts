import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresRemoteMcpOAuthConsentService,
  type RemoteMcpOAuthConsentPool,
} from "../../packages/auth/src/remote-mcp-oauth-consent.js";
import {
  createAlphaNetRemoteMcpOAuthSecurityStore,
  type AlphaNetRemoteMcpOAuthSecurityStoreOptions,
} from "../../packages/auth/src/remote-mcp-oauth-store.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeRemoteMcpOAuthConsent = databaseUrl ? describe : describe.skip;
const resource = "http://127.0.0.1:4100/mcp";
const redirectUri = "http://127.0.0.1:43110/oauth/callback";
const providerScopes = ["research:read", "offline_access"] as const;
const domainScopes = ["research:read"] as const;
const authorizationBindingKey = Buffer.alloc(32, 0x51);
const continuationKey = Buffer.alloc(32, 0x52);
const refreshTokenStorageKey = Buffer.alloc(32, 0x53);
const tokenJtiDigestKey = Buffer.alloc(32, 0x54);

type ConsentIntegrationPool = AlphaNetRemoteMcpOAuthSecurityStoreOptions["pool"] &
  RemoteMcpOAuthConsentPool;

interface PgModule {
  Pool: new (config: Record<string, unknown>) => ConsentIntegrationPool;
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

interface OwnerAgentFixture {
  actorId: string;
  agentId: string;
  authUserId: string;
  ownerId: string;
  sessionId: string;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} was not created`);
  }
  return value;
}

describeRemoteMcpOAuthConsent("Remote MCP OAuth Owner/Agent consent integration", () => {
  const pool = new Pool({
    application_name: "alphanet-remote-mcp-oauth-consent-integration",
    connectionString: databaseUrl,
    max: 4,
  });
  const lockPool = new Pool({
    application_name: "alphanet-remote-mcp-oauth-consent-lock-integration",
    connectionString: databaseUrl,
    max: 1,
  });
  const marker = randomUUID().replaceAll("-", "").slice(0, 10);
  const clientId = `oauth-consent-${marker}`;
  const codeChallenge = createHash("sha256")
    .update(`alphanet-consent-verifier-${marker}`, "utf8")
    .digest("base64url");
  const consent = new PostgresRemoteMcpOAuthConsentService(pool, {
    authorizationBindingKey,
    continuationKey,
  });
  const securityStore = createAlphaNetRemoteMcpOAuthSecurityStore({
    authorizationBindingKey,
    lockPool,
    pool,
    refreshTokenStorageKey,
    tokenJtiDigestKey,
  });
  let owner!: OwnerAgentFixture;
  let otherOwner!: OwnerAgentFixture;

  async function createOwnerAgent(label: string): Promise<OwnerAgentFixture> {
    const authUserId = randomUUID();
    const sessionId = randomUUID();
    const actorId = randomUUID();
    const agentId = randomUUID();
    await pool.query(
      `insert into auth.users (
           id, name, email, email_verified, created_at, updated_at
         ) values ($1, $2, $3, true, clock_timestamp(), clock_timestamp())`,
      [
        authUserId,
        `OAuth Consent ${label}`,
        `oauth-consent-${label}-${marker}@example.test`,
      ],
    );
    const owners = await pool.query<{ id: string }>(
      `select id::text
           from platform.owners
          where auth_user_id = $1::uuid`,
      [authUserId],
    );
    const ownerId = requiredString(owners.rows[0]?.id, `${label} Owner`);
    await pool.query(
      `insert into auth.sessions (id, expires_at, token, updated_at, user_id)
         values (
           $1::uuid,
           clock_timestamp() + interval '1 hour',
           $2::text,
           clock_timestamp(),
           $3::uuid
         )`,
      [sessionId, `oauth-consent-session-${label}-${marker}`, authUserId],
    );

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into platform.actors (
             id, kind, owner_id, handle, display_name, status
           ) values ($1::uuid, 'agent', $2::uuid, $3::text, $4::text, 'active')`,
        [actorId, ownerId, `oauth-c-${label}-${marker}`, `${label} Research Agent`],
      );
      await client.query(
        `insert into platform.agents (
             id, actor_id, owner_id, discovery_tags, status, activated_at
           ) values (
             $1::uuid,
             $2::uuid,
             $3::uuid,
             array['oauth-consent']::text[],
             'active',
             clock_timestamp()
           )`,
        [agentId, actorId, ownerId],
      );
      await client.query(
        `insert into platform.agent_policies (
             agent_id,
             tier,
             defaults_version,
             policy_schema_version,
             version,
             rules,
             is_active,
             configured_by_owner_id
           ) values (
             $1::uuid,
             'assisted',
             'agent-permission-defaults-v1',
             1,
             1,
             '{}'::jsonb,
             true,
             $2::uuid
           )`,
        [agentId, ownerId],
      );
      await client.query(
        `update platform.registration_controls
              set active_agent_count = active_agent_count + 1
            where id = true`,
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    return { actorId, agentId, authUserId, ownerId, sessionId };
  }

  beforeAll(async () => {
    await pool.query(
      `insert into platform.oauth_resource_configuration (id, resource)
         values (true, $1::text)
         on conflict (id) do nothing`,
      [resource],
    );
    const configured = await pool.query<{ resource: string }>(
      `select resource
           from platform.oauth_resource_configuration
          where id = true`,
    );
    if (configured.rows[0]?.resource !== resource) {
      throw new Error("The integration database has a different MCP resource");
    }

    owner = await createOwnerAgent("owner");
    otherOwner = await createOwnerAgent("other");
    await pool.query(
      `insert into auth.oauth_clients (
           client_id,
           disabled,
           skip_consent,
           scopes,
           created_at,
           updated_at,
           name,
           redirect_uris,
           token_endpoint_auth_method,
           grant_types,
           response_types,
           public,
           require_pkce
         ) values (
           $1::text,
           false,
           false,
           $2::jsonb,
           clock_timestamp(),
           clock_timestamp(),
           'AlphaNet Consent Integration Client',
           $3::jsonb,
           'none',
           $4::jsonb,
           '["code"]'::jsonb,
           true,
           true
         )`,
      [
        clientId,
        JSON.stringify(providerScopes),
        JSON.stringify([redirectUri]),
        JSON.stringify(["authorization_code", "refresh_token"]),
      ],
    );
  });

  afterAll(async () => {
    await Promise.all([pool.end(), lockPool.end()]);
  });

  it("keeps consent Owner-scoped and atomically claims one Grant before token signing", async () => {
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
    await securityStore.persistAuthorizationRequestEnvelope(authorizeInput);

    const consentInput = {
      clientId,
      codeChallenge,
      ownerSessionId: owner.sessionId,
      redirectUri,
      requestedScopes: providerScopes,
      resource,
    };
    const loaded = await consent.loadConsentRequest(consentInput);
    expect(loaded.agents.map((agent) => agent.id)).toEqual([owner.agentId]);
    expect(loaded.agents.map((agent) => agent.id)).not.toContain(otherOwner.agentId);
    expect(loaded.client).toEqual({
      id: clientId,
      name: "AlphaNet Consent Integration Client",
      redirectOrigin: "http://127.0.0.1:43110",
    });

    await expect(
      consent.selectAgentAndPrepareGrant({
        ...consentInput,
        agentId: otherOwner.agentId,
      }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_AVAILABLE" });
    const afterCrossOwnerAttempt = await pool.query<{
      agent_id: string | null;
      owner_id: string | null;
      owner_session_id: string | null;
      status: string;
    }>(
      `select status, owner_id, agent_id, owner_session_id
           from platform.oauth_authorization_requests
          where id = $1::uuid`,
      [loaded.id],
    );
    expect(afterCrossOwnerAttempt.rows[0]).toEqual({
      agent_id: null,
      owner_id: null,
      owner_session_id: null,
      status: "pending",
    });

    const prepared = await consent.selectAgentAndPrepareGrant({
      ...consentInput,
      agentId: owner.agentId,
    });
    expect(prepared).toMatchObject({
      authorizationRequestId: loaded.id,
      idempotent: false,
      scopes: [...domainScopes],
    });

    const selected = await pool.query<{
      credential_type: string;
      grant_status: string;
      request_grant_id: string | null;
      request_status: string;
      secret_digest: Buffer | null;
      token_prefix: string | null;
    }>(
      `select authorization_request.status as request_status,
                authorization_request.grant_id as request_grant_id,
                oauth_grant.status as grant_status,
                credential.credential_type,
                credential.token_prefix,
                credential.secret_digest
           from platform.oauth_authorization_requests as authorization_request
           inner join platform.oauth_grants as oauth_grant
             on oauth_grant.authorization_request_id = authorization_request.id
           inner join platform.credentials as credential
             on credential.id = oauth_grant.credential_id
          where authorization_request.id = $1::uuid`,
      [prepared.authorizationRequestId],
    );
    expect(selected.rows[0]).toEqual({
      credential_type: "oauth_grant",
      grant_status: "pending",
      request_grant_id: null,
      request_status: "selected",
      secret_digest: null,
      token_prefix: null,
    });

    await expect(
      consent.resolveContinuationHandle({
        continuationHandle: prepared.continuationHandle,
        ownerSessionId: owner.sessionId,
        phase: "inspect",
      }),
    ).resolves.toEqual({
      authorizationRequestId: prepared.authorizationRequestId,
      grantId: prepared.grantId,
    });
    await expect(
      consent.resolveContinuationHandle({
        continuationHandle: prepared.continuationHandle,
        ownerSessionId: owner.sessionId,
        phase: "inspect",
      }),
    ).resolves.toEqual({
      authorizationRequestId: prepared.authorizationRequestId,
      grantId: prepared.grantId,
    });

    const stillSelected = await pool.query<{
      grant_status: string;
      request_status: string;
    }>(
      `select authorization_request.status as request_status,
                oauth_grant.status as grant_status
           from platform.oauth_authorization_requests as authorization_request
           inner join platform.oauth_grants as oauth_grant
             on oauth_grant.authorization_request_id = authorization_request.id
          where authorization_request.id = $1::uuid`,
      [prepared.authorizationRequestId],
    );
    expect(stillSelected.rows[0]).toEqual({
      grant_status: "pending",
      request_status: "selected",
    });

    await expect(
      consent.resolveContinuationHandle({
        continuationHandle: prepared.continuationHandle,
        ownerSessionId: owner.sessionId,
        phase: "claim",
      }),
    ).resolves.toEqual({
      authorizationRequestId: prepared.authorizationRequestId,
      grantId: prepared.grantId,
    });

    await expect(
      consent.resolveContinuationHandle({
        continuationHandle: prepared.continuationHandle,
        ownerSessionId: owner.sessionId,
        phase: "claim",
      }),
    ).rejects.toMatchObject({ code: "CONTINUATION_REPLAYED" });

    const claimed = await pool.query<{
      grant_status: string;
      request_grant_id: string;
      request_status: string;
    }>(
      `select authorization_request.status as request_status,
              authorization_request.grant_id::text as request_grant_id,
              oauth_grant.status as grant_status
         from platform.oauth_authorization_requests as authorization_request
         inner join platform.oauth_grants as oauth_grant
           on oauth_grant.authorization_request_id = authorization_request.id
        where authorization_request.id = $1::uuid`,
      [prepared.authorizationRequestId],
    );
    expect(claimed.rows[0]).toEqual({
      grant_status: "pending",
      request_grant_id: prepared.grantId,
      request_status: "consumed",
    });

    await securityStore.activateAuthorizationGrant({
      authUserId: owner.authUserId,
      codeChallenge,
      codeChallengeMethod: "S256",
      grantId: prepared.grantId,
      oauthClientId: clientId,
      ownerSessionId: owner.sessionId,
      redirectUri,
      resource,
      scopes: providerScopes,
    });

    const issuedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    await expect(
      securityStore.persistAccessTokenAuthority({
        authUserId: owner.authUserId,
        expiresAt: new Date(issuedAt.valueOf() + 10 * 60 * 1_000),
        grantId: prepared.grantId,
        issuedAt,
        jti: randomUUID(),
        oauthClientId: clientId,
        protocolScopes: providerScopes,
        resource,
        scopes: domainScopes,
      }),
    ).resolves.toMatchObject({
      credentialId: prepared.credentialId,
      grantEpoch: 1,
    });

    const activated = await pool.query<{
      grant_status: string;
      request_grant_id: string;
      request_status: string;
    }>(
      `select authorization_request.status as request_status,
                authorization_request.grant_id::text as request_grant_id,
                oauth_grant.status as grant_status
           from platform.oauth_authorization_requests as authorization_request
           inner join platform.oauth_grants as oauth_grant
             on oauth_grant.authorization_request_id = authorization_request.id
          where authorization_request.id = $1::uuid`,
      [prepared.authorizationRequestId],
    );
    expect(activated.rows[0]).toEqual({
      grant_status: "active",
      request_grant_id: prepared.grantId,
      request_status: "consumed",
    });
  }, 20_000);
});
