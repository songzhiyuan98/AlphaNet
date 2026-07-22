import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeRemoteMcpOAuth = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const domainScopes = ["research:read"] as const;
const providerScopes = ["research:read", "offline_access"] as const;
const resource = "http://127.0.0.1:4100/mcp";
const redirectUri = "http://127.0.0.1:43110/oauth/callback";

interface OwnerAgentFixture {
  actorId: string;
  agentId: string;
  authUserId: string;
  ownerId: string;
  sessionId: string;
}

function requireId(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} was not created`);
  return value;
}

function digest(): Buffer {
  return randomBytes(32);
}

function protocolDigest(): string {
  return randomBytes(32).toString("base64url");
}

describeRemoteMcpOAuth("Remote MCP OAuth schema", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  dependencies.push(postgres);

  const marker = randomUUID().replaceAll("-", "").slice(0, 10);
  const clientId = `oauth-schema-${marker}`;
  let primary: OwnerAgentFixture;
  let secondary: OwnerAgentFixture;

  async function createOwnerAgent(label: string): Promise<OwnerAgentFixture> {
    const authUserId = randomUUID();
    const actorId = randomUUID();
    const agentId = randomUUID();
    const sessionId = randomUUID();
    await postgres.sql`
      insert into auth.users (
        id,
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        ${authUserId},
        ${`OAuth ${label}`},
        ${`oauth-${label}-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
    `;
    const owners = await postgres.sql<{ id: string }[]>`
      select id
      from platform.owners
      where auth_user_id = ${authUserId}
    `;
    const ownerId = requireId(owners[0]?.id, `${label} Owner`);

    await postgres.sql`
      insert into auth.sessions (
        id,
        expires_at,
        token,
        updated_at,
        user_id
      )
      values (
        ${sessionId},
        clock_timestamp() + interval '1 hour',
        ${`oauth-session-${label}-${marker}-${randomUUID()}`},
        clock_timestamp(),
        ${authUserId}
      )
    `;

    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.actors (
          id,
          kind,
          owner_id,
          handle,
          display_name,
          status
        )
        values (
          ${actorId},
          'agent',
          ${ownerId},
          ${`oauth-${label}-${marker}`},
          ${`OAuth ${label} Agent`},
          'active'
        )
      `;
      await transaction`
        insert into platform.agents (
          id,
          actor_id,
          owner_id,
          discovery_tags,
          status,
          activated_at
        )
        values (
          ${agentId},
          ${actorId},
          ${ownerId},
          array['oauth-test']::text[],
          'active',
          clock_timestamp()
        )
      `;
      await transaction`
        insert into platform.agent_policies (
          agent_id,
          tier,
          defaults_version,
          policy_schema_version,
          version,
          rules,
          is_active,
          configured_by_owner_id
        )
        values (
          ${agentId},
          'assisted',
          'agent-permission-defaults-v1',
          1,
          1,
          ${transaction.json({})},
          true,
          ${ownerId}
        )
      `;
      await transaction`
        update platform.registration_controls
        set active_agent_count = active_agent_count + 1
        where id = true
      `;
    });

    return { actorId, agentId, authUserId, ownerId, sessionId };
  }

  async function insertClient(
    id: string,
    allowedScopes: readonly string[] = providerScopes,
  ): Promise<void> {
    await postgres.sql`
      insert into auth.oauth_clients (
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
      )
      values (
        ${id},
        false,
        false,
        ${postgres.sql.json([...allowedScopes])},
        clock_timestamp(),
        clock_timestamp(),
        'AlphaNet OAuth Integration Client',
        ${postgres.sql.json([redirectUri])},
        'none',
        ${postgres.sql.json(["authorization_code", "refresh_token"])},
        ${postgres.sql.json(["code"])},
        true,
        true
      )
    `;
  }

  async function createAuthorizationRequest(
    oauthClientId: string,
    options: {
      createdAtSql?: "expired";
      expiresInSeconds?: number;
      requestedScopes?: readonly string[];
      targetResource?: string;
      targetRedirectUri?: string;
    } = {},
  ): Promise<string> {
    const requestId = randomUUID();
    const requestedScopes = options.requestedScopes ?? providerScopes;
    const targetResource = options.targetResource ?? resource;
    const targetRedirectUri = options.targetRedirectUri ?? redirectUri;
    if (options.createdAtSql === "expired") {
      await postgres.sql`
        insert into platform.oauth_authorization_requests (
          id,
          binding_digest,
          oauth_client_id,
          resource,
          requested_scopes,
          redirect_uri,
          code_challenge,
          created_at,
          expires_at
        )
        values (
          ${requestId},
          ${digest()},
          ${oauthClientId},
          ${targetResource},
          ${[...requestedScopes]},
          ${targetRedirectUri},
          ${protocolDigest()},
          statement_timestamp() - interval '6 minutes',
          statement_timestamp() - interval '1 minute'
        )
      `;
      return requestId;
    }

    if (options.expiresInSeconds !== undefined) {
      await postgres.sql`
        insert into platform.oauth_authorization_requests (
          id,
          binding_digest,
          oauth_client_id,
          resource,
          requested_scopes,
          redirect_uri,
          code_challenge,
          expires_at
        )
        values (
          ${requestId},
          ${digest()},
          ${oauthClientId},
          ${targetResource},
          ${[...requestedScopes]},
          ${targetRedirectUri},
          ${protocolDigest()},
          statement_timestamp() + (${options.expiresInSeconds} * interval '1 second')
        )
      `;
      return requestId;
    }

    await postgres.sql`
      insert into platform.oauth_authorization_requests (
        id,
        binding_digest,
        oauth_client_id,
        resource,
        requested_scopes,
        redirect_uri,
        code_challenge,
        expires_at
      )
      values (
        ${requestId},
        ${digest()},
        ${oauthClientId},
        ${targetResource},
        ${[...requestedScopes]},
        ${targetRedirectUri},
        ${protocolDigest()},
        statement_timestamp() + interval '5 minutes'
      )
    `;
    return requestId;
  }

  async function selectAgent(
    requestId: string,
    fixture: OwnerAgentFixture,
    sessionId = fixture.sessionId,
  ): Promise<void> {
    await postgres.sql`
      update platform.oauth_authorization_requests
      set status = 'selected',
          owner_id = ${fixture.ownerId},
          agent_id = ${fixture.agentId},
          owner_session_id = ${sessionId}
      where id = ${requestId}
    `;
  }

  async function createPendingGrant(
    authorizationRequestId: string,
    fixture: OwnerAgentFixture,
    oauthClientId: string,
    absoluteExpiresAt = new Date(Date.now() + 29 * 24 * 60 * 60 * 1_000),
  ): Promise<{ credentialId: string; expiresAt: Date; grantId: string }> {
    const credentialId = randomUUID();
    const grantId = randomUUID();
    await postgres.sql`
      insert into platform.credentials (
        id,
        owner_id,
        agent_id,
        name,
        credential_type,
        scopes,
        audience,
        policy_ceiling,
        policy_ceiling_defaults_version,
        policy_ceiling_schema_version,
        policy_ceiling_rules,
        expires_at
      )
      values (
        ${credentialId},
        ${fixture.ownerId},
        ${fixture.agentId},
        'Remote MCP OAuth Pending Grant',
        'oauth_grant',
        ${[...domainScopes]},
        ${resource},
        'assisted',
        'agent-permission-defaults-v1',
        1,
        ${postgres.sql.json({})},
        ${absoluteExpiresAt}
      )
    `;
    await postgres.sql`
      insert into platform.oauth_grants (
        id,
        owner_id,
        auth_user_id,
        agent_id,
        credential_id,
        authorization_request_id,
        oauth_client_id,
        resource,
        scopes,
        offline_access,
        expires_at
      )
      values (
        ${grantId},
        ${fixture.ownerId},
        ${fixture.authUserId},
        ${fixture.agentId},
        ${credentialId},
        ${authorizationRequestId},
        ${oauthClientId},
        ${resource},
        ${[...domainScopes]},
        true,
        ${absoluteExpiresAt}
      )
    `;
    return { credentialId, expiresAt: absoluteExpiresAt, grantId };
  }

  beforeAll(async () => {
    await postgres.sql`
      insert into platform.oauth_resource_configuration (id, resource)
      values (true, ${resource})
      on conflict (id) do nothing
    `;
    const configuredResources = await postgres.sql<{ resource: string }[]>`
      select resource
      from platform.oauth_resource_configuration
    `;
    if (configuredResources[0]?.resource !== resource) {
      throw new Error("The integration database has a different MCP resource");
    }

    primary = await createOwnerAgent("primary");
    secondary = await createOwnerAgent("secondary");
    await insertClient(clientId);
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("records the exact migration and installs the official Provider tables", async () => {
    const migration = await readFile(
      `${process.cwd()}/db/migrations/000018_remote_mcp_oauth_v1.up.sql`,
    );
    const checksum = createHash("sha256").update(migration).digest("hex");
    const ledger = await postgres.sql<
      { checksum: string; name: string; version: string }[]
    >`
      select version, name, checksum
      from system.schema_migrations
      where version = '000018'
    `;
    expect(ledger).toEqual([
      { checksum, name: "remote_mcp_oauth_v1", version: "000018" },
    ]);

    const tables = await postgres.sql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'auth'
        and table_name in (
          'oauth_access_tokens',
          'oauth_clients',
          'oauth_consents',
          'oauth_jwks',
          'oauth_refresh_tokens'
        )
      order by table_name
    `;
    expect(tables.map((table) => table.table_name)).toEqual([
      "oauth_access_tokens",
      "oauth_clients",
      "oauth_consents",
      "oauth_jwks",
      "oauth_refresh_tokens",
    ]);

    const officialColumns = await postgres.sql<
      { columns: string[]; table_name: string }[]
    >`
      select table_name,
             array_agg(column_name order by ordinal_position) as columns
      from information_schema.columns
      where table_schema = 'auth'
        and table_name in (
          'oauth_access_tokens',
          'oauth_clients',
          'oauth_consents',
          'oauth_jwks',
          'oauth_refresh_tokens'
        )
      group by table_name
      order by table_name
    `;
    expect(officialColumns).toEqual([
      {
        columns: [
          "id",
          "token",
          "client_id",
          "session_id",
          "user_id",
          "reference_id",
          "refresh_id",
          "expires_at",
          "created_at",
          "scopes",
        ],
        table_name: "oauth_access_tokens",
      },
      {
        columns: [
          "id",
          "client_id",
          "client_secret",
          "disabled",
          "skip_consent",
          "enable_end_session",
          "subject_type",
          "scopes",
          "user_id",
          "created_at",
          "updated_at",
          "name",
          "uri",
          "icon",
          "contacts",
          "tos",
          "policy",
          "software_id",
          "software_version",
          "software_statement",
          "redirect_uris",
          "post_logout_redirect_uris",
          "token_endpoint_auth_method",
          "grant_types",
          "response_types",
          "public",
          "type",
          "require_pkce",
          "reference_id",
          "metadata",
        ],
        table_name: "oauth_clients",
      },
      {
        columns: [
          "id",
          "client_id",
          "user_id",
          "reference_id",
          "scopes",
          "created_at",
          "updated_at",
        ],
        table_name: "oauth_consents",
      },
      {
        columns: ["id", "public_key", "private_key", "created_at", "expires_at"],
        table_name: "oauth_jwks",
      },
      {
        columns: [
          "id",
          "token",
          "client_id",
          "session_id",
          "user_id",
          "reference_id",
          "expires_at",
          "created_at",
          "revoked",
          "auth_time",
          "scopes",
        ],
        table_name: "oauth_refresh_tokens",
      },
    ]);

    const domainTables = await postgres.sql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'platform'
        and table_name in (
          'oauth_access_token_jtis',
          'oauth_authorization_requests',
          'oauth_grants',
          'oauth_resource_configuration'
        )
      order by table_name
    `;
    expect(domainTables.map((table) => table.table_name)).toEqual([
      "oauth_access_token_jtis",
      "oauth_authorization_requests",
      "oauth_grants",
      "oauth_resource_configuration",
    ]);
  });

  it("allows only exact /mcp resources and configures one immutable audience", async () => {
    const resourceCases = [
      { resource: "https://mcp.alphanet.example/mcp", valid: true },
      { resource: "https://mcp.alphanet.example:8443/mcp", valid: true },
      { resource: "https://mcp.alphanet.example:65535/mcp", valid: true },
      { resource: "https://mcp-edge.alphanet.example/mcp", valid: true },
      { resource: "https://xn--fsqu00a.xn--0zwm56d/mcp", valid: true },
      { resource: "http://localhost/mcp", valid: true },
      { resource: "http://localhost:4100/mcp", valid: true },
      { resource: "http://127.0.0.1/mcp", valid: true },
      { resource: "http://127.0.0.1:4100/mcp", valid: true },
      { resource: "http://[::1]/mcp", valid: true },
      { resource: "http://[::1]:4100/mcp", valid: true },
      { resource: "https://MCP.alphanet.example/mcp", valid: false },
      { resource: "https://mcp_alpha.example/mcp", valid: false },
      { resource: "https://-mcp.example/mcp", valid: false },
      { resource: "https://mcp-.example/mcp", valid: false },
      { resource: "https://mcp..example/mcp", valid: false },
      { resource: "https://.mcp.example/mcp", valid: false },
      { resource: "https://mcp.example./mcp", valid: false },
      {
        resource: `https://${"a".repeat(64)}.example/mcp`,
        valid: false,
      },
      { resource: "https://例子.测试/mcp", valid: false },
      { resource: "https://192.0.2.1/mcp", valid: false },
      { resource: "https://127.0.0.1/mcp", valid: false },
      { resource: "https://999.1.1.1/mcp", valid: false },
      { resource: "https://0177.0.0.1/mcp", valid: false },
      { resource: "https://2130706433/mcp", valid: false },
      { resource: "https://[::1]/mcp", valid: false },
      { resource: "http://mcp.alphanet.example/mcp", valid: false },
      { resource: "http://localhost.example/mcp", valid: false },
      { resource: "http://LOCALHOST/mcp", valid: false },
      { resource: "http://127.0.0.2/mcp", valid: false },
      { resource: "http://999.1.1.1/mcp", valid: false },
      { resource: "http://[::2]/mcp", valid: false },
      { resource: "http://[0:0:0:0:0:0:0:1]/mcp", valid: false },
      { resource: "https://mcp.alphanet.example:443/mcp", valid: false },
      { resource: "http://localhost:80/mcp", valid: false },
      { resource: "https://mcp.alphanet.example:0/mcp", valid: false },
      { resource: "https://mcp.alphanet.example:65536/mcp", valid: false },
      { resource: "https://mcp.alphanet.example:0443/mcp", valid: false },
      { resource: "https://owner@mcp.alphanet.example/mcp", valid: false },
      { resource: "https://mcp.alphanet.example/mcp/", valid: false },
      { resource: "https://mcp.alphanet.example/not-mcp", valid: false },
      { resource: "https://mcp.alphanet.example//mcp", valid: false },
      { resource: "https://mcp.alphanet.example/mc%70", valid: false },
      { resource: "https://mcp.alphanet.example/mcp?tenant=1", valid: false },
      { resource: "https://mcp.alphanet.example/mcp#fragment", valid: false },
      { resource: "https://mcp.alphanet.example/mcp ", valid: false },
      { resource: "ftp://mcp.alphanet.example/mcp", valid: false },
    ] as const;
    const candidates = resourceCases.map(({ resource: candidate }) => candidate);
    const validity = await postgres.sql<{ resource: string; valid: boolean }[]>`
      select candidate.resource,
             platform.oauth_resource_is_valid(candidate.resource) as valid
      from unnest(${candidates}::text[]) with ordinality
        as candidate(resource, position)
      order by candidate.position
    `;
    expect(validity).toEqual(resourceCases);

    await expect(
      postgres.sql`
        insert into platform.oauth_resource_configuration (resource)
        values ('https://second-mcp.alphanet.example/mcp')
      `,
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      postgres.sql`
        update platform.oauth_resource_configuration
        set resource = resource
        where id = true
      `,
    ).rejects.toMatchObject({ code: "55000" });

    const resourceConstraints = await postgres.sql<
      { constraint_definition: string; table_name: string }[]
    >`
      select constraint_table.relname as table_name,
             pg_get_constraintdef(constraint_record.oid) as constraint_definition
      from pg_constraint as constraint_record
      join pg_class as constraint_table
        on constraint_table.oid = constraint_record.conrelid
      join pg_namespace as namespace
        on namespace.oid = constraint_table.relnamespace
      where namespace.nspname = 'platform'
        and constraint_record.conname in (
          'oauth_access_token_jtis_resource',
          'oauth_authorization_requests_resource',
          'oauth_grants_resource'
        )
      order by constraint_table.relname
    `;
    expect(resourceConstraints).toHaveLength(3);
    expect(
      resourceConstraints.every((constraint) =>
        constraint.constraint_definition.includes("oauth_resource_is_valid(resource)"),
      ),
    ).toBe(true);

    const configuredResourceForeignKeys = await postgres.sql<{ table_name: string }[]>`
      select constraint_table.relname as table_name
      from pg_constraint as constraint_record
      join pg_class as constraint_table
        on constraint_table.oid = constraint_record.conrelid
      join pg_namespace as namespace
        on namespace.oid = constraint_table.relnamespace
      where namespace.nspname = 'platform'
        and constraint_record.conname in (
          'oauth_access_token_jtis_configured_resource',
          'oauth_authorization_requests_configured_resource',
          'oauth_grants_configured_resource'
        )
      order by constraint_table.relname
    `;
    expect(configuredResourceForeignKeys.map((row) => row.table_name)).toEqual([
      "oauth_access_token_jtis",
      "oauth_authorization_requests",
      "oauth_grants",
    ]);
  });

  it("binds one live Owner session to one active owned Agent", async () => {
    const selectedRequestId = await createAuthorizationRequest(clientId);
    await selectAgent(selectedRequestId, primary);
    const selected = await postgres.sql<
      { agent_id: string; owner_id: string; selected_at: Date; status: string }[]
    >`
      select agent_id, owner_id, selected_at, status
      from platform.oauth_authorization_requests
      where id = ${selectedRequestId}
    `;
    expect(selected[0]).toMatchObject({
      agent_id: primary.agentId,
      owner_id: primary.ownerId,
      status: "selected",
    });
    expect(selected[0]?.selected_at).toBeInstanceOf(Date);

    const crossOwnerRequestId = await createAuthorizationRequest(clientId);
    await expect(
      selectAgent(crossOwnerRequestId, secondary, primary.sessionId),
    ).rejects.toMatchObject({ code: "42501" });

    const expiredRequestId = await createAuthorizationRequest(clientId, {
      createdAtSql: "expired",
    });
    await expect(selectAgent(expiredRequestId, primary)).rejects.toMatchObject({
      code: "23514",
    });

    await expect(
      createAuthorizationRequest(clientId, {
        targetRedirectUri: "http://127.0.0.1:43111/not-registered",
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      createAuthorizationRequest(clientId, {
        requestedScopes: ["community:read"],
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      createAuthorizationRequest(clientId, {
        targetResource: "http://mcp.alphanet.example/mcp",
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      createAuthorizationRequest(clientId, {
        targetResource: "https://other-mcp.alphanet.example/mcp",
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("expires a stranded pending Grant before admitting reauthorization", async () => {
    const lifecycleClientId = `${clientId}-pending`;
    await insertClient(lifecycleClientId);

    const staleRequestId = await createAuthorizationRequest(lifecycleClientId, {
      expiresInSeconds: 5,
    });
    await selectAgent(staleRequestId, secondary);
    const staleGrant = await createPendingGrant(
      staleRequestId,
      secondary,
      lifecycleClientId,
    );

    await postgres.sql`select pg_sleep(5.1)`;

    const replacementRequestId = await createAuthorizationRequest(lifecycleClientId);
    await selectAgent(replacementRequestId, secondary);
    const replacementGrant = await createPendingGrant(
      replacementRequestId,
      secondary,
      lifecycleClientId,
    );

    const lifecycle = await postgres.sql<
      {
        expired_at: Date | null;
        grant_id: string;
        reason_code: string | null;
        request_status: string;
        status: string;
      }[]
    >`
      select oauth_grant.id as grant_id,
             oauth_grant.status,
             oauth_grant.expired_at,
             oauth_grant.reason_code,
             authorization_request.status as request_status
      from platform.oauth_grants as oauth_grant
      join platform.oauth_authorization_requests as authorization_request
        on authorization_request.id = oauth_grant.authorization_request_id
      where oauth_grant.id in (${staleGrant.grantId}, ${replacementGrant.grantId})
      order by oauth_grant.created_at, oauth_grant.id
    `;
    expect(lifecycle).toEqual([
      {
        expired_at: expect.any(Date),
        grant_id: staleGrant.grantId,
        reason_code: "authorization_request_expired",
        request_status: "expired",
        status: "expired",
      },
      {
        expired_at: null,
        grant_id: replacementGrant.grantId,
        reason_code: null,
        request_status: "selected",
        status: "pending",
      },
    ]);

    await expect(
      postgres.sql`
        update platform.oauth_grants
        set reason_code = 'changed_after_expiry'
        where id = ${staleGrant.grantId}
      `,
    ).rejects.toMatchObject({ code: "22023" });

    await postgres.sql`
      update platform.oauth_authorization_requests
      set status = 'denied'
      where id = ${replacementRequestId}
    `;
    const cleanup = await postgres.sql<{ expired_count: number }[]>`
      select platform.expire_stale_oauth_pending_grants(
        ${secondary.agentId},
        ${lifecycleClientId}
      ) as expired_count
    `;
    expect(cleanup).toEqual([{ expired_count: 1 }]);
  }, 15_000);

  it("terminalizes an absolutely expired active Grant before reauthorization", async () => {
    const lifecycleClientId = `${clientId}-active-expiry`;
    await insertClient(lifecycleClientId);

    const originalRequestId = await createAuthorizationRequest(lifecycleClientId);
    await selectAgent(originalRequestId, secondary);
    const absoluteExpiresAt = new Date(Date.now() + 4_000);
    const originalGrant = await createPendingGrant(
      originalRequestId,
      secondary,
      lifecycleClientId,
      absoluteExpiresAt,
    );

    const consentedAt = new Date();
    await postgres.sql`
      insert into auth.oauth_consents (
        id,
        client_id,
        user_id,
        reference_id,
        scopes,
        created_at,
        updated_at
      )
      values (
        ${randomUUID()},
        ${lifecycleClientId},
        ${secondary.authUserId},
        ${originalGrant.grantId},
        ${postgres.sql.json([...providerScopes])},
        ${consentedAt},
        ${consentedAt}
      )
    `;
    await postgres.sql`
      update platform.oauth_authorization_requests
      set status = 'consumed',
          grant_id = ${originalGrant.grantId}
      where id = ${originalRequestId}
    `;
    await postgres.sql`
      update platform.oauth_grants
      set status = 'active'
      where id = ${originalGrant.grantId}
    `;

    const activated = await postgres.sql<
      { activated_at: Date; status: string; token_epoch: number }[]
    >`
      select activated_at, status, token_epoch::integer as token_epoch
      from platform.oauth_grants
      where id = ${originalGrant.grantId}
    `;
    expect(activated).toEqual([
      {
        activated_at: expect.any(Date),
        status: "active",
        token_epoch: 1,
      },
    ]);
    const originalActivatedAt = activated[0]?.activated_at;
    expect(originalActivatedAt).toBeInstanceOf(Date);

    await expect(
      postgres.sql`
        update platform.oauth_grants
        set status = 'expired'
        where id = ${originalGrant.grantId}
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await postgres.sql`
      select pg_sleep(
        greatest(
          extract(epoch from (${absoluteExpiresAt}::timestamptz - clock_timestamp()))
            + 0.25,
          0
        )
      )
    `;

    await expect(
      postgres.sql`
        update platform.oauth_grants
        set status = 'expired',
            token_epoch = token_epoch + 1
        where id = ${originalGrant.grantId}
      `,
    ).rejects.toMatchObject({ code: "23514" });

    const replacementRequestId = await createAuthorizationRequest(lifecycleClientId);
    await selectAgent(replacementRequestId, secondary);
    const replacementGrant = await createPendingGrant(
      replacementRequestId,
      secondary,
      lifecycleClientId,
    );

    const lifecycle = await postgres.sql<
      {
        activated_at: Date | null;
        expired_at: Date | null;
        expires_at: Date;
        grant_id: string;
        reason_code: string | null;
        request_status: string;
        status: string;
        token_epoch: number;
      }[]
    >`
      select oauth_grant.id as grant_id,
             oauth_grant.status,
             oauth_grant.token_epoch::integer as token_epoch,
             oauth_grant.activated_at,
             oauth_grant.expires_at,
             oauth_grant.expired_at,
             oauth_grant.reason_code,
             authorization_request.status as request_status
      from platform.oauth_grants as oauth_grant
      join platform.oauth_authorization_requests as authorization_request
        on authorization_request.id = oauth_grant.authorization_request_id
      where oauth_grant.id in (
        ${originalGrant.grantId},
        ${replacementGrant.grantId}
      )
      order by oauth_grant.consented_at, oauth_grant.id
    `;

    const expiredGrant = lifecycle[0];
    expect(expiredGrant).toMatchObject({
      grant_id: originalGrant.grantId,
      reason_code: "grant_absolute_expiry",
      request_status: "consumed",
      status: "expired",
      token_epoch: 1,
    });
    expect(expiredGrant?.activated_at?.getTime()).toBe(originalActivatedAt?.getTime());
    expect(expiredGrant?.expires_at.getTime()).toBe(absoluteExpiresAt.getTime());
    expect(expiredGrant?.expired_at).toBeInstanceOf(Date);
    expect(expiredGrant?.expired_at?.getTime()).toBeGreaterThanOrEqual(
      absoluteExpiresAt.getTime(),
    );
    expect(lifecycle[1]).toEqual({
      activated_at: null,
      expired_at: null,
      expires_at: replacementGrant.expiresAt,
      grant_id: replacementGrant.grantId,
      reason_code: null,
      request_status: "selected",
      status: "pending",
      token_epoch: 1,
    });

    const current = await postgres.sql<{ id: string }[]>`
      select id
      from platform.oauth_grants
      where agent_id = ${secondary.agentId}
        and oauth_client_id = ${lifecycleClientId}
        and status in ('pending', 'active')
    `;
    expect(current).toEqual([{ id: replacementGrant.grantId }]);

    await expect(
      postgres.sql`
        update platform.oauth_grants
        set reason_code = 'changed_after_expiry'
        where id = ${originalGrant.grantId}
      `,
    ).rejects.toMatchObject({ code: "22023" });
  }, 15_000);

  it("clamps sliding refresh rotations to fixed authority expiry", async () => {
    const absoluteClientId = `${clientId}-absolute`;
    await insertClient(absoluteClientId);

    const authorizationRequestId = await createAuthorizationRequest(absoluteClientId);
    await selectAgent(authorizationRequestId, secondary);

    const absoluteExpiresAt = new Date(Date.now() + 8_000);
    const { grantId } = await createPendingGrant(
      authorizationRequestId,
      secondary,
      absoluteClientId,
      absoluteExpiresAt,
    );
    const consentId = randomUUID();
    const consentedAt = new Date();
    await postgres.sql`
      insert into auth.oauth_consents (
        id,
        client_id,
        user_id,
        reference_id,
        scopes,
        created_at,
        updated_at
      )
      values (
        ${consentId},
        ${absoluteClientId},
        ${secondary.authUserId},
        ${grantId},
        ${postgres.sql.json([...providerScopes])},
        ${consentedAt},
        ${consentedAt}
      )
    `;
    await postgres.sql`
      update platform.oauth_authorization_requests
      set status = 'consumed',
          grant_id = ${grantId}
      where id = ${authorizationRequestId}
    `;
    await postgres.sql`
      update platform.oauth_grants
      set status = 'active'
      where id = ${grantId}
    `;

    const authTime = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const refreshIds = [randomUUID(), randomUUID(), randomUUID()];
    const initialRefreshId = requireId(refreshIds[0], "initial Refresh Token");
    const initialCreatedAt = new Date();
    await postgres.sql`
      insert into auth.oauth_refresh_tokens (
        id,
        token,
        client_id,
        session_id,
        user_id,
        reference_id,
        expires_at,
        created_at,
        auth_time,
        scopes
      )
      values (
        ${initialRefreshId},
        ${protocolDigest()},
        ${absoluteClientId},
        ${secondary.sessionId},
        ${secondary.authUserId},
        ${grantId},
        ${new Date(initialCreatedAt.getTime() + 30 * 24 * 60 * 60 * 1_000)},
        ${initialCreatedAt},
        ${authTime},
        ${postgres.sql.json([...providerScopes])}
      )
    `;

    for (let rotationIndex = 1; rotationIndex < refreshIds.length; rotationIndex += 1) {
      const previousRefreshId = requireId(
        refreshIds[rotationIndex - 1],
        "previous Refresh Token",
      );
      const nextRefreshId = requireId(refreshIds[rotationIndex], "next Refresh Token");
      const rotatedAt = new Date();
      await postgres.sql.begin(async (transaction) => {
        const revoked = await transaction<{ id: string }[]>`
          update auth.oauth_refresh_tokens
          set revoked = clock_timestamp()
          where id = ${previousRefreshId}
            and revoked is null
          returning id
        `;
        expect(revoked).toEqual([{ id: previousRefreshId }]);
        await transaction`
          insert into auth.oauth_refresh_tokens (
            id,
            token,
            client_id,
            session_id,
            user_id,
            reference_id,
            expires_at,
            created_at,
            auth_time,
            scopes
          )
          values (
            ${nextRefreshId},
            ${protocolDigest()},
            ${absoluteClientId},
            ${secondary.sessionId},
            ${secondary.authUserId},
            ${grantId},
            ${new Date(rotatedAt.getTime() + 30 * 24 * 60 * 60 * 1_000)},
            ${rotatedAt},
            ${authTime},
            ${transaction.json([...providerScopes])}
          )
        `;
      });
    }

    const persistedRotations = await postgres.sql<
      { expires_at: Date; id: string; revoked: Date | null }[]
    >`
      select id, expires_at, revoked
      from auth.oauth_refresh_tokens
      where id = any(${refreshIds}::uuid[])
      order by created_at, id
    `;
    expect(persistedRotations).toHaveLength(3);
    for (const refreshToken of persistedRotations) {
      expect(refreshToken.expires_at.getTime()).toBe(absoluteExpiresAt.getTime());
    }
    expect(
      persistedRotations.filter((refreshToken) => refreshToken.revoked),
    ).toHaveLength(2);

    await postgres.sql`
      select pg_sleep(
        greatest(
          extract(epoch from (${absoluteExpiresAt}::timestamptz - clock_timestamp()))
            + 0.25,
          0
        )
      )
    `;

    const currentRefreshId = requireId(
      refreshIds[refreshIds.length - 1],
      "current Refresh Token",
    );
    await expect(
      postgres.sql.begin(async (transaction) => {
        await transaction`
          update auth.oauth_refresh_tokens
          set revoked = clock_timestamp()
          where id = ${currentRefreshId}
            and revoked is null
        `;
        await transaction`
          insert into auth.oauth_refresh_tokens (
            id,
            token,
            client_id,
            session_id,
            user_id,
            reference_id,
            expires_at,
            created_at,
            auth_time,
            scopes
          )
          values (
            ${randomUUID()},
            ${protocolDigest()},
            ${absoluteClientId},
            ${secondary.sessionId},
            ${secondary.authUserId},
            ${grantId},
            clock_timestamp() + interval '30 days',
            clock_timestamp(),
            ${authTime},
            ${transaction.json([...providerScopes])}
          )
        `;
      }),
    ).rejects.toMatchObject({ code: "23514" });

    const currentRefresh = await postgres.sql<{ revoked: Date | null }[]>`
      select revoked
      from auth.oauth_refresh_tokens
      where id = ${currentRefreshId}
    `;
    expect(currentRefresh).toEqual([{ revoked: null }]);
  }, 20_000);

  it("accepts the Provider consent, rotation, and family-invalidation sequence", async () => {
    const authorizationRequestId = await createAuthorizationRequest(clientId);
    await selectAgent(authorizationRequestId, primary);

    const credentialId = randomUUID();
    const grantId = randomUUID();
    const grantExpiresAt = new Date(Date.now() + 29 * 24 * 60 * 60 * 1_000);
    await postgres.sql`
      insert into platform.credentials (
        id,
        owner_id,
        agent_id,
        name,
        credential_type,
        scopes,
        audience,
        policy_ceiling,
        policy_ceiling_defaults_version,
        policy_ceiling_schema_version,
        policy_ceiling_rules,
        expires_at
      )
      values (
        ${credentialId},
        ${primary.ownerId},
        ${primary.agentId},
        'Remote MCP OAuth Grant',
        'oauth_grant',
        ${[...domainScopes]},
        ${resource},
        'assisted',
        'agent-permission-defaults-v1',
        1,
        ${postgres.sql.json({})},
        ${grantExpiresAt}
      )
    `;

    await expect(
      postgres.sql`
        insert into platform.oauth_grants (
          owner_id,
          auth_user_id,
          agent_id,
          credential_id,
          authorization_request_id,
          oauth_client_id,
          resource,
          scopes,
          offline_access,
          expires_at
        )
        values (
          ${primary.ownerId},
          ${primary.authUserId},
          ${primary.agentId},
          ${credentialId},
          ${authorizationRequestId},
          ${clientId},
          'https://mcp.alphanet.example/wrong-resource',
          ${[...domainScopes]},
          true,
          ${grantExpiresAt}
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await postgres.sql`
      insert into platform.oauth_grants (
        id,
        owner_id,
        auth_user_id,
        agent_id,
        credential_id,
        authorization_request_id,
        oauth_client_id,
        resource,
        scopes,
        offline_access,
        expires_at
      )
      values (
        ${grantId},
        ${primary.ownerId},
        ${primary.authUserId},
        ${primary.agentId},
        ${credentialId},
        ${authorizationRequestId},
        ${clientId},
        ${resource},
        ${[...domainScopes]},
        true,
        ${grantExpiresAt}
      )
    `;

    await expect(
      postgres.sql`
        update platform.oauth_authorization_requests
        set grant_id = ${grantId}
        where id = ${authorizationRequestId}
      `,
    ).rejects.toMatchObject({ code: "23514" });

    const consentId = randomUUID();
    const consentedAt = new Date();
    await postgres.sql`
      insert into auth.oauth_consents (
        id,
        client_id,
        user_id,
        reference_id,
        scopes,
        created_at,
        updated_at
      )
      values (
        ${consentId},
        ${clientId},
        ${primary.authUserId},
        ${grantId},
        ${postgres.sql.json([...providerScopes])},
        ${consentedAt},
        ${consentedAt}
      )
    `;
    await expect(
      postgres.sql`
        update auth.oauth_consents
        set scopes = ${postgres.sql.json(["community:read", "offline_access"])},
            updated_at = clock_timestamp()
        where id = ${consentId}
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await postgres.sql`
      update platform.oauth_authorization_requests
      set status = 'consumed',
          grant_id = ${grantId}
      where id = ${authorizationRequestId}
    `;
    await postgres.sql`
      update platform.oauth_grants
      set status = 'active'
      where id = ${grantId}
    `;

    await postgres.sql`
      update auth.oauth_consents
      set scopes = ${postgres.sql.json([...providerScopes])},
          updated_at = clock_timestamp()
      where id = ${consentId}
    `;

    const issuedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const accessTokenJtiId = randomUUID();
    await postgres.sql`
      insert into platform.oauth_access_token_jtis (
        id,
        jti_digest,
        grant_id,
        owner_id,
        agent_id,
        grant_epoch,
        oauth_client_id,
        resource,
        scopes,
        issued_at,
        expires_at,
        created_at
      )
      values (
        ${accessTokenJtiId},
        ${digest()},
        ${grantId},
        ${primary.ownerId},
        ${primary.agentId},
        1,
        ${clientId},
        ${resource},
        ${[...domainScopes]},
        ${issuedAt},
        ${new Date(issuedAt.getTime() + 9 * 60 * 1_000)},
        ${issuedAt}
      )
    `;
    await expect(
      postgres.sql`
        insert into platform.oauth_access_token_jtis (
          jti_digest,
          grant_id,
          owner_id,
          agent_id,
          grant_epoch,
          oauth_client_id,
          resource,
          scopes,
          issued_at,
          expires_at,
          created_at
        )
        values (
          ${digest()},
          ${grantId},
          ${primary.ownerId},
          ${primary.agentId},
          2,
          ${clientId},
          ${resource},
          ${[...domainScopes]},
          ${issuedAt},
          ${new Date(issuedAt.getTime() + 9 * 60 * 1_000)},
          ${issuedAt}
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    const firstRefreshId = randomUUID();
    const firstRefreshCreatedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const providerSessionAuthTime = new Date(firstRefreshCreatedAt.getTime() + 500);
    const overlongRefreshId = randomUUID();
    await postgres.sql`
      insert into auth.oauth_refresh_tokens (
        id,
        token,
        client_id,
        session_id,
        user_id,
        reference_id,
        expires_at,
        created_at,
        auth_time,
        scopes
      )
      values (
        ${overlongRefreshId},
        ${protocolDigest()},
        ${clientId},
        ${primary.sessionId},
        ${primary.authUserId},
        ${grantId},
        ${new Date(grantExpiresAt.getTime() + 1_000)},
        ${firstRefreshCreatedAt},
        ${providerSessionAuthTime},
        ${postgres.sql.json([...providerScopes])}
      )
    `;
    const clampedRefresh = await postgres.sql<{ expires_at: Date }[]>`
      select expires_at
      from auth.oauth_refresh_tokens
      where id = ${overlongRefreshId}
    `;
    expect(clampedRefresh[0]?.expires_at.getTime()).toBe(grantExpiresAt.getTime());
    await postgres.sql`
      delete from auth.oauth_refresh_tokens
      where id = ${overlongRefreshId}
    `;

    await expect(
      postgres.sql`
        insert into auth.oauth_refresh_tokens (
          token,
          client_id,
          session_id,
          user_id,
          reference_id,
          expires_at,
          created_at,
          auth_time,
          scopes
        )
        values (
          'raw-refresh-token',
          ${clientId},
          ${primary.sessionId},
          ${primary.authUserId},
          ${grantId},
          ${grantExpiresAt},
          ${firstRefreshCreatedAt},
          ${providerSessionAuthTime},
          ${postgres.sql.json([...providerScopes])}
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      postgres.sql`
        insert into auth.oauth_refresh_tokens (
          token,
          client_id,
          session_id,
          user_id,
          reference_id,
          expires_at,
          created_at,
          auth_time,
          scopes
        )
        values (
          ${protocolDigest()},
          ${clientId},
          ${primary.sessionId},
          ${primary.authUserId},
          ${grantId},
          ${grantExpiresAt},
          ${firstRefreshCreatedAt},
          ${providerSessionAuthTime},
          ${postgres.sql.json([...domainScopes])}
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await postgres.sql`
      insert into auth.oauth_refresh_tokens (
        id,
        token,
        client_id,
        session_id,
        user_id,
        reference_id,
        expires_at,
        created_at,
        auth_time,
        scopes
      )
      values (
        ${firstRefreshId},
        ${protocolDigest()},
        ${clientId},
        ${primary.sessionId},
        ${primary.authUserId},
        ${grantId},
        ${grantExpiresAt},
        ${firstRefreshCreatedAt},
        ${providerSessionAuthTime},
        ${postgres.sql.json([...providerScopes])}
      )
    `;

    const rotation = await postgres.sql<{ id: string }[]>`
      update auth.oauth_refresh_tokens
      set revoked = clock_timestamp()
      where id = ${firstRefreshId}
        and revoked is null
      returning id
    `;
    expect(rotation).toEqual([{ id: firstRefreshId }]);

    const secondRefreshId = randomUUID();
    const secondRefreshCreatedAt = new Date();
    await postgres.sql`
      insert into auth.oauth_refresh_tokens (
        id,
        token,
        client_id,
        session_id,
        user_id,
        reference_id,
        expires_at,
        created_at,
        auth_time,
        scopes
      )
      values (
        ${secondRefreshId},
        ${protocolDigest()},
        ${clientId},
        ${primary.sessionId},
        ${primary.authUserId},
        ${grantId},
        ${grantExpiresAt},
        ${secondRefreshCreatedAt},
        ${providerSessionAuthTime},
        ${postgres.sql.json([...providerScopes])}
      )
    `;
    const replayCas = await postgres.sql<{ id: string }[]>`
      update auth.oauth_refresh_tokens
      set revoked = clock_timestamp()
      where id = ${firstRefreshId}
        and revoked is null
      returning id
    `;
    expect(replayCas).toEqual([]);
    await expect(
      postgres.sql`
        update auth.oauth_refresh_tokens
        set revoked = clock_timestamp()
        where id = ${firstRefreshId}
      `,
    ).rejects.toMatchObject({ code: "22023" });

    const opaqueAccessId = randomUUID();
    const opaqueAccessCreatedAt = new Date();
    await postgres.sql`
      insert into auth.oauth_access_tokens (
        id,
        token,
        client_id,
        session_id,
        user_id,
        reference_id,
        refresh_id,
        expires_at,
        created_at,
        scopes
      )
      values (
        ${opaqueAccessId},
        ${protocolDigest()},
        ${clientId},
        ${primary.sessionId},
        ${primary.authUserId},
        ${grantId},
        ${secondRefreshId},
        ${new Date(opaqueAccessCreatedAt.getTime() + 9 * 60 * 1_000)},
        ${opaqueAccessCreatedAt},
        ${postgres.sql.json([...providerScopes])}
      )
    `;

    await postgres.sql`
      delete from auth.oauth_access_tokens
      where refresh_id in (
        select id
        from auth.oauth_refresh_tokens
        where client_id = ${clientId}
          and user_id = ${primary.authUserId}
      )
    `;
    await postgres.sql`
      delete from auth.oauth_refresh_tokens
      where client_id = ${clientId}
        and user_id = ${primary.authUserId}
    `;
    const providerFamily = await postgres.sql<
      { access_count: number; refresh_count: number }[]
    >`
      select
        (
          select count(*)::integer
          from auth.oauth_access_tokens
          where client_id = ${clientId}
            and user_id = ${primary.authUserId}
        ) as access_count,
        (
          select count(*)::integer
          from auth.oauth_refresh_tokens
          where client_id = ${clientId}
            and user_id = ${primary.authUserId}
        ) as refresh_count
    `;
    expect(providerFamily[0]).toEqual({ access_count: 0, refresh_count: 0 });

    await postgres.sql`
      update platform.oauth_access_token_jtis
      set status = 'revoked',
          revoked_at = clock_timestamp(),
          revocation_reason_code = 'owner_revoked'
      where id = ${accessTokenJtiId}
    `;
    await expect(
      postgres.sql`
        update platform.oauth_access_token_jtis
        set revocation_reason_code = 'owner_revoked'
        where id = ${accessTokenJtiId}
      `,
    ).rejects.toMatchObject({ code: "22023" });

    await postgres.sql`
      update platform.oauth_grants
      set status = 'revoked',
          token_epoch = token_epoch + 1,
          reason_code = 'owner_revoked'
      where id = ${grantId}
    `;
    await expect(
      postgres.sql`
        update platform.oauth_grants
        set last_used_at = last_used_at
        where id = ${grantId}
      `,
    ).rejects.toMatchObject({ code: "22023" });
  });
});
