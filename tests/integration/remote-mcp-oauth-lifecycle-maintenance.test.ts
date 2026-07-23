import { randomBytes, randomUUID } from "node:crypto";

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

const describeIntegration = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const resource = "http://127.0.0.1:4100/mcp";
const redirectUri = "http://127.0.0.1:43110/oauth/callback";
const domainScopes = ["research:read"] as const;
const providerScopes = ["research:read", "offline_access"] as const;
const broadProviderScopes = [
  "research:read",
  "community:read",
  "offline_access",
] as const;

interface OwnerAgentFixture {
  actorId: string;
  agentId: string;
  authUserId: string;
  ownerId: string;
  sessionId: string;
}

interface GrantFixture {
  clientId: string;
  credentialId: string;
  grantId: string;
  offlineAccess: boolean;
  protocolScopes: readonly string[];
  requestId: string;
}

interface ReconciliationResult {
  coherent_count: number;
  inspected_count: number;
  terminated_count: number;
}

interface BacklogResult {
  expired_envelope_count: number;
  expired_envelope_oldest_age_seconds: number | null;
  purgeable_envelope_count: number;
  purgeable_envelope_oldest_age_seconds: number | null;
  unreconciled_grant_count: number;
  unreconciled_grant_oldest_age_seconds: number | null;
}

function digest(): Buffer {
  return randomBytes(32);
}

function protocolDigest(): string {
  return randomBytes(32).toString("base64url");
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} was not created`);
  return value;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  return {
    promise: new Promise<void>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve() {
      if (!resolvePromise) throw new Error("Deferred was not initialized");
      resolvePromise();
    },
  };
}

describeIntegration("Remote MCP OAuth lifecycle maintenance", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  dependencies.push(postgres);
  const marker = randomUUID().replaceAll("-", "").slice(0, 12);
  const clientPrefix = `oauth-maint-${marker}`;
  const email = `${clientPrefix}@example.test`;
  let owner: OwnerAgentFixture;
  const clientIds: string[] = [];

  async function createOwnerAgent(): Promise<OwnerAgentFixture> {
    const authUserId = randomUUID();
    const actorId = randomUUID();
    const agentId = randomUUID();
    const sessionId = randomUUID();
    await postgres.sql`
      insert into auth.users (
        id, name, email, email_verified, created_at, updated_at
      ) values (
        ${authUserId}, 'OAuth maintenance Owner', ${email}, true,
        clock_timestamp(), clock_timestamp()
      )
    `;
    const owners = await postgres.sql<{ id: string }[]>`
      select id from platform.owners where auth_user_id = ${authUserId}
    `;
    const ownerId = required(owners[0]?.id, "Owner");
    await postgres.sql`
      insert into auth.sessions (id, expires_at, token, updated_at, user_id)
      values (
        ${sessionId}, clock_timestamp() + interval '1 hour',
        ${`${clientPrefix}-session-${randomUUID()}`}, clock_timestamp(),
        ${authUserId}
      )
    `;
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.actors (
          id, kind, owner_id, handle, display_name, status
        ) values (
          ${actorId}, 'agent', ${ownerId}, ${clientPrefix},
          'OAuth maintenance Agent', 'active'
        )
      `;
      await transaction`
        insert into platform.agents (
          id, actor_id, owner_id, discovery_tags, status, activated_at
        ) values (
          ${agentId}, ${actorId}, ${ownerId}, array['oauth-test']::text[],
          'active', clock_timestamp()
        )
      `;
      await transaction`
        insert into platform.agent_policies (
          agent_id, tier, defaults_version, policy_schema_version, version,
          rules, is_active, configured_by_owner_id
        ) values (
          ${agentId}, 'assisted', 'agent-permission-defaults-v1', 1, 1,
          ${transaction.json({})}, true, ${ownerId}
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

  async function createClient(
    label: string,
    scopes: readonly string[] = providerScopes,
  ): Promise<string> {
    const clientId = `${clientPrefix}-${label}`;
    clientIds.push(clientId);
    await postgres.sql`
      insert into auth.oauth_clients (
        client_id, disabled, skip_consent, scopes, created_at, updated_at,
        name, redirect_uris, token_endpoint_auth_method, grant_types,
        response_types, public, require_pkce
      ) values (
        ${clientId}, false, false, ${postgres.sql.json([...scopes])},
        clock_timestamp(), clock_timestamp(), 'OAuth maintenance client',
        ${postgres.sql.json([redirectUri])}, 'none',
        ${postgres.sql.json(["authorization_code", "refresh_token"])},
        ${postgres.sql.json(["code"])}, true, true
      )
    `;
    return clientId;
  }

  async function createRequest(
    clientId: string,
    options: { expired?: boolean; scopes?: readonly string[] } = {},
  ): Promise<string> {
    const requestId = randomUUID();
    const scopes = options.scopes ?? providerScopes;
    if (options.expired) {
      await postgres.sql`
        insert into platform.oauth_authorization_requests (
          id, binding_digest, oauth_client_id, resource, requested_scopes,
          redirect_uri, code_challenge, created_at, expires_at
        ) values (
          ${requestId}, ${digest()}, ${clientId}, ${resource}, ${[...scopes]},
          ${redirectUri}, ${protocolDigest()},
          statement_timestamp() - interval '6 minutes',
          statement_timestamp() - interval '1 minute'
        )
      `;
    } else {
      await postgres.sql`
        insert into platform.oauth_authorization_requests (
          id, binding_digest, oauth_client_id, resource, requested_scopes,
          redirect_uri, code_challenge, expires_at
        ) values (
          ${requestId}, ${digest()}, ${clientId}, ${resource}, ${[...scopes]},
          ${redirectUri}, ${protocolDigest()},
          statement_timestamp() + interval '5 minutes'
        )
      `;
    }
    return requestId;
  }

  async function createPendingGrant(
    clientId: string,
    options: { consume?: boolean; offlineAccess?: boolean } = {},
  ): Promise<GrantFixture> {
    const offlineAccess = options.offlineAccess ?? true;
    const protocolScopes = offlineAccess ? providerScopes : domainScopes;
    const requestId = await createRequest(clientId, { scopes: protocolScopes });
    await postgres.sql`
      update platform.oauth_authorization_requests
      set status = 'selected', owner_id = ${owner.ownerId},
          agent_id = ${owner.agentId}, owner_session_id = ${owner.sessionId}
      where id = ${requestId}
    `;
    const credentialId = randomUUID();
    const grantId = randomUUID();
    const expiresAt = new Date(Date.now() + 29 * 24 * 60 * 60 * 1_000);
    await postgres.sql`
      insert into platform.credentials (
        id, owner_id, agent_id, name, credential_type, scopes, audience,
        policy_ceiling, policy_ceiling_defaults_version,
        policy_ceiling_schema_version, policy_ceiling_rules, expires_at
      ) values (
        ${credentialId}, ${owner.ownerId}, ${owner.agentId},
        'Remote MCP OAuth maintenance Grant', 'oauth_grant',
        ${[...domainScopes]}, ${resource}, 'assisted',
        'agent-permission-defaults-v1', 1, ${postgres.sql.json({})}, ${expiresAt}
      )
    `;
    await postgres.sql`
      insert into platform.oauth_grants (
        id, owner_id, auth_user_id, agent_id, credential_id,
        authorization_request_id, oauth_client_id, resource, scopes,
        offline_access, expires_at
      ) values (
        ${grantId}, ${owner.ownerId}, ${owner.authUserId}, ${owner.agentId},
        ${credentialId}, ${requestId}, ${clientId}, ${resource},
        ${[...domainScopes]}, ${offlineAccess}, ${expiresAt}
      )
    `;
    if (options.consume) {
      await postgres.sql`
        update platform.oauth_authorization_requests
        set status = 'consumed', grant_id = ${grantId}
        where id = ${requestId}
      `;
    }
    return {
      clientId,
      credentialId,
      grantId,
      offlineAccess,
      protocolScopes,
      requestId,
    };
  }

  async function ageRequest(requestId: string, retained = false): Promise<void> {
    await postgres.sql.begin(async (transaction) => {
      await transaction.unsafe("set local session_replication_role = replica");
      if (retained) {
        await transaction`
          update platform.oauth_authorization_requests
          set created_at = statement_timestamp() - interval '9 days',
              expires_at = statement_timestamp() - interval '8 days 23 hours 55 minutes',
              selected_at = case when selected_at is null then null
                else statement_timestamp() - interval '8 days 23 hours 58 minutes' end,
              consumed_at = case when consumed_at is null then null
                else statement_timestamp() - interval '8 days 23 hours 57 minutes' end,
              terminal_at = statement_timestamp() - interval '8 days',
              updated_at = statement_timestamp()
          where id = ${requestId}
        `;
      } else {
        await transaction`
          update platform.oauth_authorization_requests
          set created_at = statement_timestamp() - interval '6 minutes',
              expires_at = statement_timestamp() - interval '1 minute',
              updated_at = statement_timestamp()
          where id = ${requestId}
        `;
      }
    });
  }

  async function activateGrant(fixture: GrantFixture): Promise<void> {
    await postgres.sql`
      update platform.oauth_authorization_requests
      set status = 'consumed', grant_id = ${fixture.grantId}
      where id = ${fixture.requestId} and status = 'selected'
    `;
    await postgres.sql`
      update platform.oauth_grants set status = 'active'
      where id = ${fixture.grantId}
    `;
  }

  async function insertProviderAuthority(
    fixture: GrantFixture,
    options: { access?: boolean } = {},
  ): Promise<void> {
    const issuedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const expiresAt = new Date(issuedAt.valueOf() + 9 * 60 * 1_000);
    await postgres.sql`
      insert into auth.oauth_consents (
        id, client_id, user_id, reference_id, resources, scopes, created_at,
        updated_at
      ) values (
        ${randomUUID()}, ${fixture.clientId}, ${owner.authUserId},
        ${fixture.grantId}, ${postgres.sql.json([resource])},
        ${postgres.sql.json([...fixture.protocolScopes])}, ${issuedAt}, ${issuedAt}
      )
    `;
    if (fixture.offlineAccess) {
      await postgres.sql`
        insert into auth.oauth_refresh_tokens (
          id, token, client_id, user_id, reference_id, expires_at, created_at,
          auth_time, resources, scopes
        ) values (
          ${randomUUID()}, ${protocolDigest()}, ${fixture.clientId},
          ${owner.authUserId}, ${fixture.grantId},
          ${new Date(issuedAt.valueOf() + 24 * 60 * 60 * 1_000)}, ${issuedAt},
          ${issuedAt}, ${postgres.sql.json([resource])},
          ${postgres.sql.json([...fixture.protocolScopes])}
        )
      `;
    }
    if (options.access !== false) {
      await postgres.sql`
        insert into auth.oauth_access_tokens (
          id, token, client_id, user_id, reference_id, expires_at, created_at,
          resources, scopes
        ) values (
          ${randomUUID()}, ${protocolDigest()}, ${fixture.clientId},
          ${owner.authUserId}, ${fixture.grantId}, ${expiresAt}, ${issuedAt},
          ${postgres.sql.json([resource])},
          ${postgres.sql.json([...fixture.protocolScopes])}
        )
      `;
    }
    await postgres.sql`
      insert into platform.oauth_access_token_jtis (
        id, jti_digest, grant_id, owner_id, agent_id, grant_epoch,
        oauth_client_id, resource, scopes, issued_at, expires_at, created_at
      ) values (
        ${randomUUID()}, ${digest()}, ${fixture.grantId}, ${owner.ownerId},
        ${owner.agentId}, 1, ${fixture.clientId}, ${resource},
        ${[...domainScopes]}, ${issuedAt}, ${expiresAt}, ${issuedAt}
      )
    `;
  }

  async function reconcile(batchSize: number): Promise<ReconciliationResult> {
    const rows = await postgres.sql<ReconciliationResult[]>`
      select inspected_count, coherent_count, terminated_count
      from system.reconcile_remote_mcp_oauth_grant_bootstraps(${batchSize}, 0)
    `;
    const row = rows[0];
    if (!row) throw new Error("Reconciliation did not return aggregates");
    return row;
  }

  async function reconcileUntilRecorded(grantIds: readonly string[]): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const rows = await postgres.sql<{ count: number }[]>`
        select count(*)::integer as count
        from platform.oauth_grant_bootstrap_reconciliations
        where grant_id in ${postgres.sql(grantIds)}
      `;
      if (rows[0]?.count === grantIds.length) return;
      const result = await reconcile(1000);
      if (result.inspected_count === 0) break;
    }
    throw new Error("OAuth bootstrap fixtures were not reconciled");
  }

  async function expireRequest(requestId: string): Promise<void> {
    await postgres.sql`
      update platform.oauth_authorization_requests
      set status = 'expired'
      where id = ${requestId} and status in ('pending', 'selected')
    `;
  }

  beforeAll(async () => {
    await postgres.sql`
      insert into platform.oauth_resource_configuration (id, resource)
      values (true, ${resource}) on conflict (id) do nothing
    `;
    owner = await createOwnerAgent();
  });

  afterAll(async () => {
    try {
      await postgres.sql.begin(async (transaction) => {
        await transaction.unsafe("set local session_replication_role = replica");
        await transaction`
          update platform.registration_controls
          set active_agent_count = greatest(active_agent_count - 1, 0)
          where id = true
        `;
        await transaction`
          delete from platform.oauth_grant_bootstrap_reconciliations
          where grant_id in (
            select id from platform.oauth_grants
            where oauth_client_id like ${`${clientPrefix}%`}
          )
        `;
        await transaction`
          delete from auth.oauth_access_tokens
          where client_id like ${`${clientPrefix}%`}
        `;
        await transaction`
          delete from auth.oauth_refresh_tokens
          where client_id like ${`${clientPrefix}%`}
        `;
        await transaction`
          delete from auth.oauth_consents
          where client_id like ${`${clientPrefix}%`}
        `;
        await transaction`
          delete from platform.oauth_access_token_jtis
          where oauth_client_id like ${`${clientPrefix}%`}
        `;
        await transaction`
          delete from system.oauth_grant_bootstrap_queue
          where grant_id in (
            select id from platform.oauth_grants
            where oauth_client_id like ${`${clientPrefix}%`}
          )
        `;
        await transaction`
          delete from platform.oauth_grants
          where oauth_client_id like ${`${clientPrefix}%`}
        `;
        await transaction`
          delete from platform.oauth_authorization_requests
          where oauth_client_id like ${`${clientPrefix}%`}
        `;
        await transaction`
          delete from platform.credentials where owner_id = ${owner.ownerId}
        `;
        await transaction`
          delete from platform.agent_policies where agent_id = ${owner.agentId}
        `;
        await transaction`
          delete from platform.agents where id = ${owner.agentId}
        `;
        await transaction`
          delete from platform.actors where id = ${owner.actorId}
        `;
        await transaction`
          delete from auth.sessions where user_id = ${owner.authUserId}
        `;
        await transaction`
          delete from platform.owners where id = ${owner.ownerId}
        `;
        await transaction`
          delete from auth.users where id = ${owner.authUserId}
        `;
        await transaction`
          delete from auth.oauth_clients
          where client_id like ${`${clientPrefix}%`}
        `;
      });
    } finally {
      await closeDependencies(dependencies);
    }
  });

  it("reconciles coherent and crashed bootstrap states once and fail closed", async () => {
    const selected = await createPendingGrant(await createClient("selected"));
    await ageRequest(selected.requestId);

    const abandoned = await createPendingGrant(await createClient("abandoned"), {
      consume: true,
    });
    await ageRequest(abandoned.requestId);

    const coherent = await createPendingGrant(
      await createClient("coherent", broadProviderScopes),
    );
    await activateGrant(coherent);
    await insertProviderAuthority(coherent);

    const onlineCoherent = await createPendingGrant(
      await createClient("coherent-online", broadProviderScopes),
      { offlineAccess: false },
    );
    await activateGrant(onlineCoherent);
    await insertProviderAuthority(onlineCoherent);

    const partial = await createPendingGrant(await createClient("partial"));
    await activateGrant(partial);
    await insertProviderAuthority(partial, { access: false });

    const fixtureGrantIds = [
      selected.grantId,
      abandoned.grantId,
      coherent.grantId,
      onlineCoherent.grantId,
      partial.grantId,
    ];
    const queuedBefore = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from system.oauth_grant_bootstrap_queue
      where grant_id in ${postgres.sql(fixtureGrantIds)}
    `;
    expect(queuedBefore).toEqual([{ count: fixtureGrantIds.length }]);
    await reconcileUntilRecorded(fixtureGrantIds);

    const queuedAfter = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from system.oauth_grant_bootstrap_queue
      where grant_id in ${postgres.sql(fixtureGrantIds)}
    `;
    expect(queuedAfter).toEqual([{ count: 0 }]);

    const state = await postgres.sql<
      {
        credential_revoked: boolean;
        grant_id: string;
        grant_status: string;
        outcome: string;
        provider_access: number;
        provider_consents: number;
        reason_code: string;
        refresh_active: number;
        token_epoch: string;
        token_jti_active: number;
      }[]
    >`
      select oauth_grant.id as grant_id,
             oauth_grant.status as grant_status,
             oauth_grant.token_epoch::text,
             credential.revoked_at is not null as credential_revoked,
             reconciliation.outcome,
             reconciliation.reason_code,
             (select count(*)::integer from auth.oauth_access_tokens access_token
               where access_token.reference_id = oauth_grant.id::text)
               as provider_access,
             (select count(*)::integer from auth.oauth_consents provider_consent
               where provider_consent.reference_id = oauth_grant.id::text)
               as provider_consents,
             (select count(*)::integer from auth.oauth_refresh_tokens refresh_token
               where refresh_token.reference_id = oauth_grant.id::text
                 and refresh_token.revoked is null) as refresh_active,
             (select count(*)::integer
                from platform.oauth_access_token_jtis token_jti
               where token_jti.grant_id = oauth_grant.id
                 and token_jti.status = 'active') as token_jti_active
        from platform.oauth_grants as oauth_grant
        inner join platform.credentials as credential
          on credential.id = oauth_grant.credential_id
        inner join platform.oauth_grant_bootstrap_reconciliations reconciliation
          on reconciliation.grant_id = oauth_grant.id
       where oauth_grant.id in (
         ${selected.grantId}, ${abandoned.grantId}, ${coherent.grantId},
         ${onlineCoherent.grantId}, ${partial.grantId}
       )
       order by oauth_grant.id
    `;
    const byId = new Map(state.map((row) => [row.grant_id, row]));
    expect(byId.get(coherent.grantId)).toMatchObject({
      credential_revoked: false,
      grant_status: "active",
      outcome: "coherent",
      provider_access: 1,
      provider_consents: 1,
      reason_code: "authority_complete",
      refresh_active: 1,
      token_epoch: "1",
      token_jti_active: 1,
    });
    expect(byId.get(onlineCoherent.grantId)).toMatchObject({
      credential_revoked: false,
      grant_status: "active",
      outcome: "coherent",
      provider_access: 1,
      provider_consents: 1,
      reason_code: "authority_complete",
      refresh_active: 0,
      token_epoch: "1",
      token_jti_active: 1,
    });
    expect(byId.get(selected.grantId)).toMatchObject({
      credential_revoked: true,
      grant_status: "expired",
      outcome: "terminated",
      reason_code: "authorization_request_expired",
      token_epoch: "1",
    });
    expect(byId.get(abandoned.grantId)).toMatchObject({
      credential_revoked: true,
      grant_status: "compromised",
      outcome: "terminated",
      reason_code: "authorization_code_abandoned",
      token_epoch: "2",
    });
    expect(byId.get(partial.grantId)).toMatchObject({
      credential_revoked: true,
      grant_status: "compromised",
      outcome: "terminated",
      provider_access: 0,
      provider_consents: 0,
      reason_code: "oauth_bootstrap_incomplete",
      refresh_active: 0,
      token_epoch: "2",
      token_jti_active: 0,
    });

    const beforeRerun = await postgres.sql<
      { grant_id: string; outcome: string; reconciled_at: Date }[]
    >`
      select grant_id, outcome, reconciled_at
      from platform.oauth_grant_bootstrap_reconciliations
      where grant_id in ${postgres.sql(fixtureGrantIds)}
      order by grant_id
    `;
    await reconcile(1000);
    const afterRerun = await postgres.sql<
      { grant_id: string; outcome: string; reconciled_at: Date }[]
    >`
      select grant_id, outcome, reconciled_at
      from platform.oauth_grant_bootstrap_reconciliations
      where grant_id in ${postgres.sql(fixtureGrantIds)}
      order by grant_id
    `;
    expect(afterRerun).toEqual(beforeRerun);

    await expect(
      postgres.sql`
        update platform.oauth_grant_bootstrap_reconciliations
        set reason_code = 'rewritten' where grant_id = ${coherent.grantId}
      `,
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      postgres.sql`
        delete from platform.oauth_grant_bootstrap_reconciliations
        where grant_id = ${coherent.grantId}
      `,
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("uses SKIP LOCKED, enforces batch bounds, and avoids broad envelope writes", async () => {
    const bulkClient = await createClient("bulk");
    const lockedRequest = await createRequest(bulkClient, {
      expired: true,
      scopes: domainScopes,
    });
    const freeRequest = await createRequest(bulkClient, {
      expired: true,
      scopes: domainScopes,
    });
    const lockAcquired = deferred();
    const release = deferred();
    const lockTransaction = postgres.sql.begin(async (transaction) => {
      await transaction`
        select id
        from platform.oauth_authorization_requests
        where status in ('pending', 'selected')
          and expires_at <= statement_timestamp()
          and id <> ${freeRequest}
        for update
      `;
      lockAcquired.resolve();
      await release.promise;
    });
    await lockAcquired.promise;
    const whileLocked = await postgres.sql<{ count: number }[]>`
      select system.expire_remote_mcp_oauth_authorization_requests(1) as count
    `;
    expect(whileLocked).toEqual([{ count: 1 }]);
    const lockedState = await postgres.sql<{ status: string }[]>`
      select status from platform.oauth_authorization_requests
      where id = ${lockedRequest}
    `;
    expect(lockedState).toEqual([{ status: "pending" }]);
    const freeState = await postgres.sql<{ status: string }[]>`
      select status from platform.oauth_authorization_requests
      where id = ${freeRequest}
    `;
    expect(freeState).toEqual([{ status: "expired" }]);
    release.resolve();
    await lockTransaction;
    const afterRelease = await postgres.sql<{ count: number }[]>`
      select system.expire_remote_mcp_oauth_authorization_requests(1000) as count
    `;
    expect(afterRelease[0]?.count).toBeGreaterThanOrEqual(1);
    const releasedState = await postgres.sql<{ status: string }[]>`
      select status from platform.oauth_authorization_requests
      where id = ${lockedRequest}
    `;
    expect(releasedState).toEqual([{ status: "expired" }]);

    const backgroundClient = await createClient("bulk-background");
    await postgres.sql`
      insert into platform.oauth_authorization_requests (
        id, binding_digest, oauth_client_id, resource, requested_scopes,
        redirect_uri, code_challenge, created_at, expires_at
      )
      select gen_random_uuid(),
             digest(${`${marker}:background:`} || series::text, 'sha256'),
             ${backgroundClient}, ${resource}, ${[...domainScopes]}, ${redirectUri},
             repeat('B', 43),
             statement_timestamp() - interval '6 minutes',
             statement_timestamp() - interval '1 minute'
      from generate_series(1, 4000) as fixture(series)
    `;
    await postgres.sql`
      update platform.oauth_authorization_requests
      set status = 'expired'
      where oauth_client_id = ${backgroundClient} and status = 'pending'
    `;

    await postgres.sql`
      insert into platform.oauth_authorization_requests (
        id, binding_digest, oauth_client_id, resource, requested_scopes,
        redirect_uri, code_challenge, created_at, expires_at
      )
      select gen_random_uuid(),
             digest(${`${marker}:bulk:`} || series::text, 'sha256'),
             ${bulkClient}, ${resource}, ${[...domainScopes]}, ${redirectUri},
             repeat('A', 43),
             statement_timestamp() - interval '6 minutes',
             statement_timestamp() - interval '1 minute'
      from generate_series(1, 1205) as fixture(series)
    `;
    await postgres.sql.unsafe("analyze platform.oauth_authorization_requests");
    const cappedBacklog = await postgres.sql<BacklogResult[]>`
      select *
      from system.inspect_remote_mcp_oauth_lifecycle_backlog(
        0, ${7 * 24 * 60 * 60}, 1000
      )
    `;
    expect(cappedBacklog[0]).toMatchObject({
      expired_envelope_count: 1000,
      purgeable_envelope_count: 0,
      unreconciled_grant_count: 0,
    });
    expect(cappedBacklog[0]?.expired_envelope_oldest_age_seconds).toBeGreaterThanOrEqual(
      60,
    );
    await expect(
      postgres.sql`
        select *
        from system.inspect_remote_mcp_oauth_lifecycle_backlog(
          0, ${7 * 24 * 60 * 60}, 0
        )
      `,
    ).rejects.toMatchObject({ code: "22023" });
    const expiryPlan = await postgres.sql.begin(async (transaction) => {
      await transaction.unsafe("set local enable_seqscan = off");
      return transaction<Record<string, unknown>[]>`
        explain (format json)
        select id
        from platform.oauth_authorization_requests
        where status in ('pending', 'selected')
          and expires_at <= statement_timestamp()
        order by expires_at, id
        limit 1000
      `;
    });
    expect(JSON.stringify(expiryPlan)).toContain(
      "oauth_authorization_requests_expiry_idx",
    );
    const first = await postgres.sql<{ count: number }[]>`
      select system.expire_remote_mcp_oauth_authorization_requests(1000) as count
    `;
    expect(first).toEqual([{ count: 1000 }]);
    const remaining = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.oauth_authorization_requests
      where oauth_client_id = ${bulkClient} and status = 'pending'
    `;
    expect(remaining).toEqual([{ count: 205 }]);
    const second = await postgres.sql<{ count: number }[]>`
      select system.expire_remote_mcp_oauth_authorization_requests(1000) as count
    `;
    expect(second).toEqual([{ count: 205 }]);
    const third = await postgres.sql<{ count: number }[]>`
      select system.expire_remote_mcp_oauth_authorization_requests(1000) as count
    `;
    expect(third).toEqual([{ count: 0 }]);

    const indexDefinitions = await postgres.sql<
      { indexdef: string; indexname: string }[]
    >`
      select indexname, indexdef
      from pg_catalog.pg_indexes
      where schemaname in ('auth', 'platform', 'system')
        and indexname in (
          'oauth_authorization_requests_expiry_idx',
          'oauth_authorization_requests_terminal_retention_idx',
          'oauth_grant_bootstrap_queue_order_idx',
          'oauth_access_tokens_grant_reference_idx'
        )
      order by indexname
    `;
    expect(indexDefinitions.map((entry) => entry.indexname)).toEqual([
      "oauth_access_tokens_grant_reference_idx",
      "oauth_authorization_requests_expiry_idx",
      "oauth_authorization_requests_terminal_retention_idx",
      "oauth_grant_bootstrap_queue_order_idx",
    ]);

    const queuePlan = await postgres.sql.begin(async (transaction) => {
      await transaction.unsafe("set local enable_seqscan = off");
      return transaction<Record<string, unknown>[]>`
        explain (format json)
        select grant_id
        from system.oauth_grant_bootstrap_queue
        order by enqueued_at, grant_id
        limit 1000
      `;
    });
    expect(JSON.stringify(queuePlan)).toContain("oauth_grant_bootstrap_queue_order_idx");
  });

  it("retains recent and Grant-linked terminal envelopes while purging old orphans", async () => {
    const retentionClient = await createClient("retention");
    const orphanIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const requestId = await createRequest(retentionClient, {
        expired: true,
        scopes: domainScopes,
      });
      await expireRequest(requestId);
      await ageRequest(requestId, true);
      orphanIds.push(requestId);
    }
    const recent = await createRequest(retentionClient, {
      expired: true,
      scopes: domainScopes,
    });
    await expireRequest(recent);

    const linked = await createPendingGrant(await createClient("retained-grant"));
    await ageRequest(linked.requestId);
    await reconcileUntilRecorded([linked.grantId]);
    await ageRequest(linked.requestId, true);
    await postgres.sql.unsafe("analyze platform.oauth_authorization_requests");

    const retainedBacklog = await postgres.sql<BacklogResult[]>`
      select *
      from system.inspect_remote_mcp_oauth_lifecycle_backlog(
        0, ${7 * 24 * 60 * 60}, 2
      )
    `;
    expect(retainedBacklog[0]).toMatchObject({
      expired_envelope_count: 0,
      purgeable_envelope_count: 2,
      unreconciled_grant_count: 0,
    });
    expect(
      retainedBacklog[0]?.purgeable_envelope_oldest_age_seconds,
    ).toBeGreaterThanOrEqual(24 * 60 * 60);

    const retentionPlan = await postgres.sql.begin(async (transaction) => {
      await transaction.unsafe("set local enable_seqscan = off");
      return transaction<Record<string, unknown>[]>`
        explain (format json)
        select id
        from platform.oauth_authorization_requests
        where status in ('denied', 'expired')
          and grant_id is null
          and terminal_at < statement_timestamp() - interval '7 days'
        order by terminal_at, id
        limit 2
      `;
    });
    expect(JSON.stringify(retentionPlan)).toContain(
      "oauth_authorization_requests_terminal_retention_idx",
    );

    const purgeFirst = await postgres.sql<{ count: number }[]>`
      select system.purge_terminal_remote_mcp_oauth_authorization_requests(
        2, ${7 * 24 * 60 * 60}
      ) as count
    `;
    const purgeSecond = await postgres.sql<{ count: number }[]>`
      select system.purge_terminal_remote_mcp_oauth_authorization_requests(
        2, ${7 * 24 * 60 * 60}
      ) as count
    `;
    const purgeThird = await postgres.sql<{ count: number }[]>`
      select system.purge_terminal_remote_mcp_oauth_authorization_requests(
        2, ${7 * 24 * 60 * 60}
      ) as count
    `;
    expect([purgeFirst, purgeSecond, purgeThird]).toEqual([
      [{ count: 2 }],
      [{ count: 1 }],
      [{ count: 0 }],
    ]);

    const [orphanOne, orphanTwo, orphanThree] = orphanIds;
    if (!orphanOne || !orphanTwo || !orphanThree) {
      throw new Error("Expected three terminal orphan authorization requests");
    }

    const survivors = await postgres.sql<{ id: string }[]>`
      select id from platform.oauth_authorization_requests
      where id in (${recent}, ${linked.requestId}, ${orphanOne},
                   ${orphanTwo}, ${orphanThree})
      order by id
    `;
    expect(survivors.map((row: { id: string }) => row.id).sort()).toEqual(
      [recent, linked.requestId].sort(),
    );
  });
});
