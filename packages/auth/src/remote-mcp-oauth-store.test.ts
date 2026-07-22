import { createHash, createHmac } from "node:crypto";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { RemoteMcpOAuthGuardError } from "./remote-mcp-oauth-guard.js";
import { digestInboundMcpTokenJti } from "./mcp-actor-context.js";
import {
  createAlphaNetRemoteMcpOAuthSecurityStore,
  RemoteMcpOAuthSecurityStoreError,
} from "./remote-mcp-oauth-store.js";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const AUTH_USER_ID = "10000000-0000-4000-8000-000000000002";
const AGENT_ID = "10000000-0000-4000-8000-000000000003";
const CREDENTIAL_ID = "10000000-0000-4000-8000-000000000004";
const GRANT_ID = "10000000-0000-4000-8000-000000000005";
const REQUEST_ID = "10000000-0000-4000-8000-000000000006";
const CLIENT_ID = "alphanet-desktop";
const RESOURCE = "https://mcp.alphanet.example/mcp";
const REDIRECT_URI = "http://127.0.0.1:43110/oauth/callback";
const AUTHORIZATION_CODE = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
const CODE_VERIFIER =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const CODE_CHALLENGE = createHash("sha256")
  .update(CODE_VERIFIER, "ascii")
  .digest("base64url");
const ISSUED_AT = new Date("2026-07-22T18:00:00.000Z");
const EXPIRES_AT = new Date("2026-07-22T18:10:00.000Z");
const AUTHORITY_EXPIRES_AT = new Date("2026-08-01T00:00:00.000Z");

interface QueryCall {
  text: string;
  values: unknown[];
}

interface QueryStep {
  match: string;
  result?: {
    rowCount?: number | null;
    rows?: unknown[];
  };
  throws?: Error;
}

function normalizeSql(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

class ScriptedClient {
  readonly calls: QueryCall[] = [];
  readonly #steps: QueryStep[];
  released = false;

  constructor(steps: QueryStep[]) {
    this.#steps = [...steps];
  }

  query(text: string, values: unknown[] = []) {
    const normalized = normalizeSql(text);
    this.calls.push({ text: normalized, values: [...values] });
    const step = this.#steps.shift();
    if (!step) return Promise.reject(new Error(`Unexpected query: ${normalized}`));
    expect(normalized).toContain(step.match);
    if (step.throws) return Promise.reject(step.throws);
    return Promise.resolve({
      command: "SELECT",
      fields: [],
      oid: 0,
      rowCount: step.result?.rowCount ?? step.result?.rows?.length ?? 0,
      rows: step.result?.rows ?? [],
    });
  }

  release(): void {
    this.released = true;
  }

  expectComplete(): void {
    expect(this.#steps).toEqual([]);
    expect(this.released).toBe(true);
  }
}

class ScriptedPool {
  readonly calls: QueryCall[] = [];
  readonly client: ScriptedClient;
  readonly #steps: QueryStep[];

  constructor(poolSteps: QueryStep[], transactionSteps: QueryStep[]) {
    this.#steps = [...poolSteps];
    this.client = new ScriptedClient(transactionSteps);
  }

  query(text: string, values: unknown[] = []) {
    const normalized = normalizeSql(text);
    this.calls.push({ text: normalized, values: [...values] });
    const step = this.#steps.shift();
    if (!step) return Promise.reject(new Error(`Unexpected pool query: ${normalized}`));
    expect(normalized).toContain(step.match);
    if (step.throws) return Promise.reject(step.throws);
    return Promise.resolve({
      command: "SELECT",
      fields: [],
      oid: 0,
      rowCount: step.result?.rowCount ?? step.result?.rows?.length ?? 0,
      rows: step.result?.rows ?? [],
    });
  }

  connect(): Promise<ScriptedClient> {
    return Promise.resolve(this.client);
  }

  expectComplete(): void {
    expect(this.#steps).toEqual([]);
    this.client.expectComplete();
  }
}

function ownerRow() {
  return {
    auth_user_id: AUTH_USER_ID,
    deleted_at: null,
    email_verified_at: new Date("2026-07-01T00:00:00.000Z"),
    id: OWNER_ID,
    status: "active",
  };
}

function accessAuthorityRow(status: "active" | "pending" = "pending") {
  return {
    agent_id: AGENT_ID,
    agent_deleted_at: null,
    agent_owner_id: OWNER_ID,
    agent_status: "active",
    actor_deleted_at: null,
    actor_kind: "agent",
    actor_owner_id: OWNER_ID,
    actor_status: "active",
    authority_checked_at: new Date("2026-07-22T18:00:01.000Z"),
    client_disabled: false,
    client_grant_types: ["authorization_code", "refresh_token"],
    client_id: CLIENT_ID,
    client_public: true,
    client_redirect_uris: [REDIRECT_URI],
    client_require_pkce: true,
    client_secret: null,
    client_scopes: ["research:read", "offline_access"],
    client_skip_consent: false,
    client_token_endpoint_auth_method: "none",
    configured_resource: RESOURCE,
    credential_audience: RESOURCE,
    credential_expires_at: AUTHORITY_EXPIRES_AT,
    credential_id: CREDENTIAL_ID,
    credential_revoked_at: null,
    credential_scopes: ["research:read"],
    credential_type: "oauth_grant",
    grant_activated_at: status === "active" ? new Date("2026-07-22T17:59:00.000Z") : null,
    grant_agent_id: AGENT_ID,
    grant_auth_user_id: AUTH_USER_ID,
    grant_credential_id: CREDENTIAL_ID,
    grant_expires_at: AUTHORITY_EXPIRES_AT,
    grant_id: GRANT_ID,
    grant_offline_access: true,
    grant_owner_id: OWNER_ID,
    grant_resource: RESOURCE,
    grant_scopes: ["research:read"],
    grant_status: status,
    grant_token_epoch: "4",
    oauth_client_id: CLIENT_ID,
    request_agent_id: AGENT_ID,
    request_code_challenge: CODE_CHALLENGE,
    request_code_challenge_method: "S256",
    request_expires_at: new Date("2026-07-22T18:04:00.000Z"),
    request_grant_id: GRANT_ID,
    request_id: REQUEST_ID,
    request_oauth_client_id: CLIENT_ID,
    request_owner_id: OWNER_ID,
    request_owner_session_id: "10000000-0000-4000-8000-000000000008",
    request_redirect_uri: REDIRECT_URI,
    request_requested_scopes: ["research:read", "offline_access"],
    request_resource: RESOURCE,
    request_status: "consumed",
  };
}

function refreshAuthorityRow(revokedAt: Date | null = null) {
  return {
    actor_deleted_at: null,
    actor_kind: "agent",
    actor_owner_id: OWNER_ID,
    actor_status: "active",
    agent_deleted_at: null,
    agent_id: AGENT_ID,
    agent_owner_id: OWNER_ID,
    agent_status: "active",
    authority_checked_at: new Date("2026-07-22T18:00:01.000Z"),
    client_disabled: false,
    client_grant_types: ["authorization_code", "refresh_token"],
    client_id: CLIENT_ID,
    client_public: true,
    client_require_pkce: true,
    client_secret: null,
    client_scopes: ["research:read", "offline_access"],
    client_skip_consent: false,
    client_token_endpoint_auth_method: "none",
    configured_resource: RESOURCE,
    credential_audience: RESOURCE,
    credential_expires_at: AUTHORITY_EXPIRES_AT,
    credential_id: CREDENTIAL_ID,
    credential_revoked_at: null,
    credential_scopes: ["research:read"],
    grant_expires_at: AUTHORITY_EXPIRES_AT,
    grant_agent_id: AGENT_ID,
    grant_id: GRANT_ID,
    grant_offline_access: true,
    grant_resource: RESOURCE,
    grant_scopes: ["research:read"],
    grant_status: "active",
    oauth_client_id: CLIENT_ID,
    owner_id: OWNER_ID,
    refresh_auth_user_id: AUTH_USER_ID,
    refresh_client_id: CLIENT_ID,
    refresh_created_at: new Date("2026-07-22T17:00:00.000Z"),
    refresh_expires_at: AUTHORITY_EXPIRES_AT,
    refresh_reference_id: GRANT_ID,
    refresh_revoked_at: revokedAt,
    refresh_scopes: ["research:read", "offline_access"],
  };
}

function asPool(pool: ScriptedPool): Pool {
  return pool as unknown as Pool;
}

function asDistinctPoolView(pool: ScriptedPool): Pool {
  return {
    connect: pool.connect.bind(pool),
    query: pool.query.bind(pool),
  } as unknown as Pool;
}

function refreshFamilyCompromiseSteps(): QueryStep[] {
  return [
    { match: "remote_mcp_oauth_store:revoke_refresh_family" },
    { match: "remote_mcp_oauth_store:delete_provider_access_family" },
    { match: "remote_mcp_oauth_store:revoke_jti_family" },
    { match: "remote_mcp_oauth_store:revoke_credential_family" },
    { match: "remote_mcp_oauth_store:compromise_grant_family" },
  ];
}

function createStore(pool: ScriptedPool) {
  return createAlphaNetRemoteMcpOAuthSecurityStore({
    authorizationBindingKey: Buffer.alloc(32, 0x11),
    lockPool: asDistinctPoolView(pool),
    pool: asPool(pool),
    refreshTokenStorageKey: Buffer.alloc(32, 0x22),
    tokenJtiDigestKey: Buffer.alloc(32, 0x33),
  });
}

function authorizeInput() {
  return {
    canonicalScope: "research:read offline_access",
    clientId: CLIENT_ID,
    codeChallenge: CODE_CHALLENGE,
    codeChallengeMethod: "S256" as const,
    redirectUri: REDIRECT_URI,
    requestedScopes: ["research:read", "offline_access"] as const,
    resource: RESOURCE,
    responseType: "code" as const,
  };
}

function accessInput() {
  return {
    authUserId: AUTH_USER_ID,
    expiresAt: EXPIRES_AT,
    grantId: GRANT_ID,
    issuedAt: ISSUED_AT,
    jti: "10000000-0000-4000-8000-000000000007",
    oauthClientId: CLIENT_ID,
    protocolScopes: ["research:read", "offline_access"] as const,
    resource: RESOURCE,
    scopes: ["research:read"] as const,
  };
}

function activationInput() {
  return {
    authUserId: AUTH_USER_ID,
    codeChallenge: CODE_CHALLENGE,
    codeChallengeMethod: "S256" as const,
    grantId: GRANT_ID,
    oauthClientId: CLIENT_ID,
    ownerSessionId: "10000000-0000-4000-8000-000000000008",
    redirectUri: REDIRECT_URI,
    resource: RESOURCE,
    scopes: ["research:read", "offline_access"] as const,
  };
}

function authorizationCodeLockInput() {
  return {
    authorizationCode: AUTHORIZATION_CODE,
    clientId: CLIENT_ID,
    codeVerifier: CODE_VERIFIER,
    redirectUri: REDIRECT_URI,
    resource: RESOURCE,
  };
}

function authorizationCodeVerificationRow() {
  return {
    authority_checked_at: new Date("2026-07-22T18:00:01.000Z"),
    expires_at: new Date("2026-07-22T18:04:00.000Z"),
    value: JSON.stringify({
      query: {
        client_id: CLIENT_ID,
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "research:read offline_access",
      },
      referenceId: GRANT_ID,
      sessionId: activationInput().ownerSessionId,
      type: "authorization_code",
      userId: AUTH_USER_ID,
    }),
  };
}

describe("createAlphaNetRemoteMcpOAuthSecurityStore", () => {
  it("requires independent keys and an exact 32-byte JTI digest key", () => {
    const pool = new ScriptedPool([], []);
    const base = {
      authorizationBindingKey: Buffer.alloc(32, 0x11),
      lockPool: asDistinctPoolView(pool),
      pool: asPool(pool),
      refreshTokenStorageKey: Buffer.alloc(32, 0x22),
      tokenJtiDigestKey: Buffer.alloc(32, 0x33),
    };

    expect(() =>
      createAlphaNetRemoteMcpOAuthSecurityStore({
        ...base,
        authorizationBindingKey: Buffer.alloc(31),
      }),
    ).toThrow(RemoteMcpOAuthSecurityStoreError);
    expect(() =>
      createAlphaNetRemoteMcpOAuthSecurityStore({
        ...base,
        tokenJtiDigestKey: base.refreshTokenStorageKey,
      }),
    ).toThrow(/independent/u);
    expect(() =>
      createAlphaNetRemoteMcpOAuthSecurityStore({
        ...base,
        tokenJtiDigestKey: Buffer.alloc(33, 0x33),
      }),
    ).toThrow(/exactly 32 bytes/u);
    expect(() =>
      createAlphaNetRemoteMcpOAuthSecurityStore({
        ...base,
        lockPool: base.pool,
      }),
    ).toThrow(RemoteMcpOAuthSecurityStoreError);
  });

  it("inserts a five-minute unselected authorization envelope without key material", async () => {
    const pool = new ScriptedPool(
      [],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:insert_authorization_request",
          result: { rowCount: 1, rows: [{ id: REQUEST_ID }] },
        },
        { match: "commit" },
      ],
    );

    await createStore(pool).persistAuthorizationRequestEnvelope(authorizeInput());

    const insert = pool.client.calls.find((call) =>
      call.text.includes("insert_authorization_request"),
    );
    expect(insert?.values).toEqual([
      expect.any(Buffer),
      CLIENT_ID,
      RESOURCE,
      ["research:read", "offline_access"],
      REDIRECT_URI,
      CODE_CHALLENGE,
    ]);
    expect((insert?.values[0] as Buffer).byteLength).toBe(32);
    expect(insert?.values).not.toContain(Buffer.alloc(32, 0x11));
    pool.expectComplete();
  });

  it("strongly revalidates an idempotent pending envelope", async () => {
    const pool = new ScriptedPool(
      [],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:insert_authorization_request",
          result: { rowCount: 0, rows: [] },
        },
        {
          match: "remote_mcp_oauth_store:revalidate_authorization_request",
          result: {
            rows: [
              {
                agent_id: null,
                code_challenge: CODE_CHALLENGE,
                code_challenge_method: "S256",
                expires_at: new Date("2026-07-22T18:05:00.000Z"),
                grant_id: null,
                oauth_client_id: CLIENT_ID,
                owner_id: null,
                owner_session_id: null,
                redirect_uri: REDIRECT_URI,
                requested_scopes: ["research:read", "offline_access"],
                resource: RESOURCE,
                status: "pending",
              },
            ],
          },
        },
        { match: "commit" },
      ],
    );

    await expect(
      createStore(pool).persistAuthorizationRequestEnvelope(authorizeInput()),
    ).resolves.toBeUndefined();
    expect(pool.client.calls[2]?.text).toContain("for share");
    pool.expectComplete();
  });

  it("fails closed instead of reusing a selected or expired envelope", async () => {
    const pool = new ScriptedPool(
      [],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:insert_authorization_request",
          result: { rowCount: 0, rows: [] },
        },
        {
          match: "remote_mcp_oauth_store:revalidate_authorization_request",
          result: { rows: [] },
        },
        { match: "rollback" },
      ],
    );

    await expect(
      createStore(pool).persistAuthorizationRequestEnvelope(authorizeInput()),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_REQUEST_INVALID" });
    pool.expectComplete();
  });

  it("serializes and correlates an unconsumed Provider code without exposing its secrets", async () => {
    const pool = new ScriptedPool(
      [],
      [
        { match: "begin" },
        { match: "pg_advisory_xact_lock" },
        {
          match: "remote_mcp_oauth_store:read_authorization_code",
          result: { rows: [authorizationCodeVerificationRow()] },
        },
        {
          match: "remote_mcp_oauth_store:bind_authorization_code_grant",
          result: { rows: [{ grant_id: GRANT_ID }] },
        },
        { match: "commit" },
      ],
    );
    const callback = vi.fn(() => Promise.resolve("provider-result"));

    await expect(
      createStore(pool).withAuthorizationCodeExchangeLock(
        authorizationCodeLockInput(),
        callback,
      ),
    ).resolves.toBe("provider-result");
    expect(callback).toHaveBeenCalledWith({ grantId: GRANT_ID });
    const providerDigest = createHmac("sha256", Buffer.alloc(32, 0x22))
      .update("alphanet:authorization_code:v1\0", "utf8")
      .update(AUTHORIZATION_CODE, "utf8")
      .digest("base64url");
    const storedIdentifier = createHash("sha256")
      .update(providerDigest, "utf8")
      .digest("base64url");
    const codeRead = pool.client.calls.find((call) =>
      call.text.includes("read_authorization_code"),
    );
    expect(codeRead?.values).toEqual([storedIdentifier]);
    const serializedQueries = JSON.stringify(pool.client.calls);
    expect(serializedQueries).not.toContain(AUTHORIZATION_CODE);
    expect(serializedQueries).not.toContain(CODE_VERIFIER);
    pool.expectComplete();
  });

  it("rejects a wrong PKCE verifier before Provider code consumption", async () => {
    const pool = new ScriptedPool(
      [],
      [
        { match: "begin" },
        { match: "pg_advisory_xact_lock" },
        {
          match: "remote_mcp_oauth_store:read_authorization_code",
          result: { rows: [authorizationCodeVerificationRow()] },
        },
        { match: "rollback" },
      ],
    );
    const callback = vi.fn(() => Promise.resolve("must-not-run"));

    await expect(
      createStore(pool).withAuthorizationCodeExchangeLock(
        {
          ...authorizationCodeLockInput(),
          codeVerifier:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~",
        },
        callback,
      ),
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_CODE_AUTHORITY_INVALID",
      oauthError: "invalid_grant",
    });
    expect(callback).not.toHaveBeenCalled();
    pool.expectComplete();
  });

  it("activates the Grant before token persistence and stores only the shared domain-separated JTI digest", async () => {
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_activation_owner",
          result: { rows: [{ owner_id: OWNER_ID }] },
        },
        {
          match: "remote_mcp_oauth_store:locate_access_owner",
          result: { rows: [{ owner_id: OWNER_ID }] },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_activation_owner",
          result: { rows: [ownerRow()] },
        },
        {
          match: "remote_mcp_oauth_store:read_access_authority",
          result: { rows: [accessAuthorityRow("pending")] },
        },
        {
          match: "remote_mcp_oauth_store:lock_activation_session",
          result: { rows: [{ id: activationInput().ownerSessionId }] },
        },
        {
          match: "remote_mcp_oauth_store:activate_grant",
          result: { rowCount: 1, rows: [{ token_epoch: "4" }] },
        },
        { match: "commit" },
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_access_owner",
          result: { rows: [ownerRow()] },
        },
        {
          match: "remote_mcp_oauth_store:read_access_authority",
          result: { rows: [accessAuthorityRow("active")] },
        },
        {
          match: "remote_mcp_oauth_store:insert_access_jti",
          result: { rowCount: 1, rows: [{ id: "jti-row" }] },
        },
        { match: "commit" },
      ],
    );

    const store = createStore(pool);
    await store.activateAuthorizationGrant(activationInput());
    const result = await store.persistAccessTokenAuthority(accessInput());

    const expectedDigest = digestInboundMcpTokenJti(
      accessInput().jti,
      Buffer.alloc(32, 0x33),
    );
    expect(result).toEqual({
      credentialId: CREDENTIAL_ID,
      grantEpoch: 4,
      tokenJtiDigest: expectedDigest,
    });
    const insert = pool.client.calls.find((call) =>
      call.text.includes("insert_access_jti"),
    );
    expect(insert?.values[0]).toEqual(Buffer.from(expectedDigest, "base64url"));
    expect(insert?.values).not.toContain(accessInput().jti);
    expect(insert?.text).toContain("greatest(clock_timestamp(), $9::timestamptz)");
    expect(pool.client.calls[1]?.text).toContain("lock_activation_owner");
    expect(
      pool.client.calls.some((call) =>
        call.text.includes("consume_authorization_request"),
      ),
    ).toBe(false);
    pool.expectComplete();
  });

  it("rejects JTI persistence while its Grant is still pending", async () => {
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_access_owner",
          result: { rows: [{ owner_id: OWNER_ID }] },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_access_owner",
          result: { rows: [ownerRow()] },
        },
        {
          match: "remote_mcp_oauth_store:read_access_authority",
          result: { rows: [accessAuthorityRow("pending")] },
        },
        { match: "rollback" },
      ],
    );

    await expect(
      createStore(pool).persistAccessTokenAuthority(accessInput()),
    ).rejects.toMatchObject({ code: "ACCESS_TOKEN_AUTHORITY_INVALID" });
    expect(
      pool.client.calls.some((call) => call.text.includes("insert_access_jti")),
    ).toBe(false);
    pool.expectComplete();
  });

  it("rejects pre-token activation without the token-plus-clock-skew horizon", async () => {
    const shortAuthority = {
      ...accessAuthorityRow("pending"),
      credential_expires_at: new Date("2026-07-22T18:10:00.000Z"),
      grant_expires_at: new Date("2026-07-22T18:10:00.000Z"),
    };
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_activation_owner",
          result: { rows: [{ owner_id: OWNER_ID }] },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_activation_owner",
          result: { rows: [ownerRow()] },
        },
        {
          match: "remote_mcp_oauth_store:read_access_authority",
          result: { rows: [shortAuthority] },
        },
        { match: "rollback" },
      ],
    );

    await expect(
      createStore(pool).activateAuthorizationGrant(activationInput()),
    ).rejects.toMatchObject({ code: "ACCESS_TOKEN_AUTHORITY_INVALID" });
    expect(pool.client.calls.some((call) => call.text.includes("activate_grant"))).toBe(
      false,
    );
    pool.expectComplete();
  });

  it("revalidates the bound live session even for an already-active Grant", async () => {
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_activation_owner",
          result: { rows: [{ owner_id: OWNER_ID }] },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_activation_owner",
          result: { rows: [ownerRow()] },
        },
        {
          match: "remote_mcp_oauth_store:read_access_authority",
          result: { rows: [accessAuthorityRow("active")] },
        },
        {
          match: "remote_mcp_oauth_store:lock_activation_session",
          result: { rows: [] },
        },
        { match: "rollback" },
      ],
    );

    await expect(
      createStore(pool).activateAuthorizationGrant(activationInput()),
    ).rejects.toMatchObject({ code: "ACCESS_TOKEN_AUTHORITY_INVALID" });
    expect(pool.client.calls.some((call) => call.text.includes("activate_grant"))).toBe(
      false,
    );
    pool.expectComplete();
  });

  it("issues another JTI for the same fully revalidated active authority without replaying lifecycle updates", async () => {
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_access_owner",
          result: { rows: [{ owner_id: OWNER_ID }] },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_access_owner",
          result: { rows: [ownerRow()] },
        },
        {
          match: "remote_mcp_oauth_store:read_access_authority",
          result: { rows: [accessAuthorityRow("active")] },
        },
        {
          match: "remote_mcp_oauth_store:insert_access_jti",
          result: { rowCount: 1, rows: [{ id: "jti-row" }] },
        },
        { match: "commit" },
      ],
    );

    await expect(
      createStore(pool).persistAccessTokenAuthority(accessInput()),
    ).resolves.toMatchObject({ credentialId: CREDENTIAL_ID, grantEpoch: 4 });
    expect(
      pool.client.calls.some(
        (call) =>
          call.text.includes("consume_authorization_request") ||
          call.text.includes("activate_grant"),
      ),
    ).toBe(false);
    pool.expectComplete();
  });

  it("rolls back without a JTI when current authority no longer matches", async () => {
    const invalid = { ...accessAuthorityRow("active"), credential_revoked_at: ISSUED_AT };
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_access_owner",
          result: { rows: [{ owner_id: OWNER_ID }] },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_access_owner",
          result: { rows: [ownerRow()] },
        },
        {
          match: "remote_mcp_oauth_store:read_access_authority",
          result: { rows: [invalid] },
        },
        { match: "rollback" },
      ],
    );

    await expect(
      createStore(pool).persistAccessTokenAuthority(accessInput()),
    ).rejects.toMatchObject({ code: "ACCESS_TOKEN_AUTHORITY_INVALID" });
    expect(
      pool.client.calls.some((call) => call.text.includes("insert_access_jti")),
    ).toBe(false);
    pool.expectComplete();
  });

  it("never treats a terminal Grant as an active access-token authority", async () => {
    const terminal = { ...accessAuthorityRow("active"), grant_status: "compromised" };
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_access_owner",
          result: { rows: [{ owner_id: OWNER_ID }] },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_access_owner",
          result: { rows: [ownerRow()] },
        },
        {
          match: "remote_mcp_oauth_store:read_access_authority",
          result: { rows: [terminal] },
        },
        { match: "rollback" },
      ],
    );

    await expect(
      createStore(pool).persistAccessTokenAuthority(accessInput()),
    ).rejects.toMatchObject({ code: "ACCESS_TOKEN_AUTHORITY_INVALID" });
    expect(
      pool.client.calls.some((call) => call.text.includes("insert_access_jti")),
    ).toBe(false);
    pool.expectComplete();
  });

  it("rejects access-token signing when either the Agent or its Actor is inactive", async () => {
    for (const invalid of [
      { ...accessAuthorityRow("active"), agent_status: "suspended" },
      { ...accessAuthorityRow("active"), actor_deleted_at: ISSUED_AT },
    ]) {
      const pool = new ScriptedPool(
        [
          {
            match: "remote_mcp_oauth_store:locate_access_owner",
            result: { rows: [{ owner_id: OWNER_ID }] },
          },
        ],
        [
          { match: "begin" },
          {
            match: "remote_mcp_oauth_store:lock_access_owner",
            result: { rows: [ownerRow()] },
          },
          {
            match: "remote_mcp_oauth_store:read_access_authority",
            result: { rows: [invalid] },
          },
          { match: "rollback" },
        ],
      );

      await expect(
        createStore(pool).persistAccessTokenAuthority(accessInput()),
      ).rejects.toMatchObject({ code: "ACCESS_TOKEN_AUTHORITY_INVALID" });
      pool.expectComplete();
    }
  });

  it.each([
    ["JWT client drift", accessAuthorityRow("active"), { oauthClientId: "other-client" }],
    [
      "JWT protocol-scope drift",
      accessAuthorityRow("active"),
      { protocolScopes: ["research:read"] as const },
    ],
    [
      "current client is not public",
      { ...accessAuthorityRow("active"), client_public: false },
      {},
    ],
    [
      "offline client lost refresh_token",
      {
        ...accessAuthorityRow("active"),
        client_grant_types: ["authorization_code"],
      },
      {},
    ],
  ])("rejects %s before JTI persistence", async (_scenario, row, inputOverride) => {
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_access_owner",
          result: { rows: [{ owner_id: OWNER_ID }] },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_access_owner",
          result: { rows: [ownerRow()] },
        },
        {
          match: "remote_mcp_oauth_store:read_access_authority",
          result: { rows: [row] },
        },
        { match: "rollback" },
      ],
    );

    await expect(
      createStore(pool).persistAccessTokenAuthority({
        ...accessInput(),
        ...inputOverride,
      }),
    ).rejects.toMatchObject({ code: "ACCESS_TOKEN_AUTHORITY_INVALID" });
    expect(
      pool.client.calls.some((call) => call.text.includes("insert_access_jti")),
    ).toBe(false);
    pool.expectComplete();
  });

  it("maps duplicate JTI persistence to invalid authority and rolls back", async () => {
    const duplicate = Object.assign(new Error("duplicate key"), { code: "23505" });
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_access_owner",
          result: { rows: [{ owner_id: OWNER_ID }] },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_access_owner",
          result: { rows: [ownerRow()] },
        },
        {
          match: "remote_mcp_oauth_store:read_access_authority",
          result: { rows: [accessAuthorityRow("active")] },
        },
        { match: "remote_mcp_oauth_store:insert_access_jti", throws: duplicate },
        { match: "rollback" },
      ],
    );

    await expect(
      createStore(pool).persistAccessTokenAuthority(accessInput()),
    ).rejects.toMatchObject({ code: "ACCESS_TOKEN_AUTHORITY_INVALID" });
    pool.expectComplete();
  });

  it("uses the Provider-compatible refresh digest and holds the Owner+Client lock around the callback", async () => {
    const refreshToken = "aln_rt_v1_abcdefghijklmnopqrstuvwxyzABCDEF";
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_refresh_owner",
          result: {
            rows: [
              {
                auth_user_id: AUTH_USER_ID,
                client_id: CLIENT_ID,
                owner_id: OWNER_ID,
              },
            ],
          },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_refresh_owner",
          result: { rows: [ownerRow()] },
        },
        { match: "pg_catalog.pg_advisory_xact_lock" },
        {
          match: "remote_mcp_oauth_store:read_refresh_authority",
          result: { rows: [refreshAuthorityRow()] },
        },
        { match: "commit" },
      ],
    );
    const execute = vi.fn(() => {
      expect(pool.client.calls.at(-1)?.text).toContain("read_refresh_authority");
      return Promise.resolve("provider-result");
    });

    await expect(
      createStore(pool).withOwnerClientRefreshLock(
        { clientId: CLIENT_ID, refreshToken, resource: RESOURCE },
        execute,
      ),
    ).resolves.toBe("provider-result");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: CLIENT_ID,
        credentialId: CREDENTIAL_ID,
        grantId: GRANT_ID,
        ownerId: OWNER_ID,
      }),
    );
    const locator = pool.calls[0];
    const expectedDigest = createHmac("sha256", Buffer.alloc(32, 0x22))
      .update("alphanet:refresh_token:v1\0", "utf8")
      .update("abcdefghijklmnopqrstuvwxyzABCDEF", "utf8")
      .digest("base64url");
    expect(locator?.values).toEqual([expectedDigest]);
    expect(locator?.values).not.toContain(refreshToken);
    pool.expectComplete();
  });

  it("commits an Owner+Client family compromise before rejecting revoked-token replay", async () => {
    const refreshToken = "aln_rt_v1_abcdefghijklmnopqrstuvwxyzABCDEF";
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_refresh_owner",
          result: {
            rows: [
              {
                auth_user_id: AUTH_USER_ID,
                client_id: CLIENT_ID,
                owner_id: OWNER_ID,
              },
            ],
          },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_refresh_owner",
          result: { rows: [ownerRow()] },
        },
        { match: "pg_catalog.pg_advisory_xact_lock" },
        {
          match: "remote_mcp_oauth_store:read_refresh_authority",
          result: {
            rows: [refreshAuthorityRow(new Date("2026-07-22T17:30:00.000Z"))],
          },
        },
        ...refreshFamilyCompromiseSteps(),
        { match: "commit" },
      ],
    );
    const execute = vi.fn(() => Promise.resolve("must-not-run"));

    const promise = createStore(pool).withOwnerClientRefreshLock(
      { clientId: CLIENT_ID, refreshToken, resource: RESOURCE },
      execute,
    );
    await expect(promise).rejects.toMatchObject({
      code: "REFRESH_AUTHORITY_INVALID",
      oauthError: "invalid_grant",
      statusCode: 400,
    });
    await expect(promise).rejects.toBeInstanceOf(RemoteMcpOAuthGuardError);
    expect(execute).not.toHaveBeenCalled();
    expect(pool.client.calls.at(-1)?.text).toBe("commit");
    pool.expectComplete();
  });

  it("does not run the refresh callback for an inactive Agent Actor", async () => {
    const refreshToken = "aln_rt_v1_abcdefghijklmnopqrstuvwxyzABCDEF";
    const inactiveActor = { ...refreshAuthorityRow(), actor_status: "suspended" };
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_refresh_owner",
          result: {
            rows: [
              {
                auth_user_id: AUTH_USER_ID,
                client_id: CLIENT_ID,
                owner_id: OWNER_ID,
              },
            ],
          },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_refresh_owner",
          result: { rows: [ownerRow()] },
        },
        { match: "pg_catalog.pg_advisory_xact_lock" },
        {
          match: "remote_mcp_oauth_store:read_refresh_authority",
          result: { rows: [inactiveActor] },
        },
        { match: "rollback" },
      ],
    );
    const execute = vi.fn(() => Promise.resolve("must-not-run"));

    await expect(
      createStore(pool).withOwnerClientRefreshLock(
        { clientId: CLIENT_ID, refreshToken, resource: RESOURCE },
        execute,
      ),
    ).rejects.toMatchObject({ code: "REFRESH_AUTHORITY_INVALID" });
    expect(execute).not.toHaveBeenCalled();
    pool.expectComplete();
  });

  it("rejects refresh authority without the token-plus-clock-skew horizon", async () => {
    const refreshToken = "aln_rt_v1_abcdefghijklmnopqrstuvwxyzABCDEF";
    const shortAuthority = {
      ...refreshAuthorityRow(),
      credential_expires_at: new Date("2026-07-22T18:10:00.000Z"),
      grant_expires_at: new Date("2026-07-22T18:10:00.000Z"),
      refresh_expires_at: new Date("2026-07-22T18:09:30.000Z"),
    };
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_refresh_owner",
          result: {
            rows: [
              {
                auth_user_id: AUTH_USER_ID,
                client_id: CLIENT_ID,
                owner_id: OWNER_ID,
              },
            ],
          },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_refresh_owner",
          result: { rows: [ownerRow()] },
        },
        { match: "pg_catalog.pg_advisory_xact_lock" },
        {
          match: "remote_mcp_oauth_store:read_refresh_authority",
          result: { rows: [shortAuthority] },
        },
        { match: "rollback" },
      ],
    );
    const execute = vi.fn(() => Promise.resolve("must-not-run"));

    await expect(
      createStore(pool).withOwnerClientRefreshLock(
        { clientId: CLIENT_ID, refreshToken, resource: RESOURCE },
        execute,
      ),
    ).rejects.toMatchObject({ code: "REFRESH_AUTHORITY_INVALID" });
    expect(execute).not.toHaveBeenCalled();
    pool.expectComplete();
  });

  it("commits family compromise and preserves a thrown refresh callback error", async () => {
    const refreshToken = "aln_rt_v1_abcdefghijklmnopqrstuvwxyzABCDEF";
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_refresh_owner",
          result: {
            rows: [
              {
                auth_user_id: AUTH_USER_ID,
                client_id: CLIENT_ID,
                owner_id: OWNER_ID,
              },
            ],
          },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_refresh_owner",
          result: { rows: [ownerRow()] },
        },
        { match: "pg_catalog.pg_advisory_xact_lock" },
        {
          match: "remote_mcp_oauth_store:read_refresh_authority",
          result: { rows: [refreshAuthorityRow()] },
        },
        ...refreshFamilyCompromiseSteps(),
        { match: "commit" },
      ],
    );
    const callbackError = new Error("provider failed safely");

    await expect(
      createStore(pool).withOwnerClientRefreshLock(
        { clientId: CLIENT_ID, refreshToken, resource: RESOURCE },
        () => Promise.reject(callbackError),
      ),
    ).rejects.toBe(callbackError);
    expect(
      pool.client.calls
        .flatMap((call) => call.values)
        .some((value) => value === refreshToken),
    ).toBe(false);
    const jtiRevocation = pool.client.calls.find((call) =>
      call.text.includes("revoke_jti_family"),
    );
    expect(jtiRevocation?.values[2]).toBe("refresh_rotation_failed");
    expect(pool.client.calls.at(-1)?.text).toBe("commit");
    pool.expectComplete();
  });

  it("does not compromise a family when locked validation rejects before Provider start", async () => {
    const refreshToken = "aln_rt_v1_abcdefghijklmnopqrstuvwxyzABCDEF";
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_refresh_owner",
          result: {
            rows: [
              {
                auth_user_id: AUTH_USER_ID,
                client_id: CLIENT_ID,
                owner_id: OWNER_ID,
              },
            ],
          },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_refresh_owner",
          result: { rows: [ownerRow()] },
        },
        { match: "pg_catalog.pg_advisory_xact_lock" },
        {
          match: "remote_mcp_oauth_store:read_refresh_authority",
          result: { rows: [refreshAuthorityRow()] },
        },
        { match: "commit" },
      ],
    );
    const validationError = new RemoteMcpOAuthGuardError({
      code: "SCOPE_INVALID",
      message: "The refresh scope set is invalid.",
      oauthError: "invalid_scope",
      parameter: "scope",
    });

    await expect(
      createStore(pool).withOwnerClientRefreshLock(
        { clientId: CLIENT_ID, refreshToken, resource: RESOURCE },
        () => Promise.reject(validationError),
      ),
    ).rejects.toBe(validationError);
    expect(
      pool.client.calls.some((call) => call.text.includes("revoke_refresh_family")),
    ).toBe(false);
    expect(pool.client.calls.at(-1)?.text).toBe("commit");
    pool.expectComplete();
  });

  it("commits family compromise before returning an actual non-2xx refresh response", async () => {
    const refreshToken = "aln_rt_v1_abcdefghijklmnopqrstuvwxyzABCDEF";
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_refresh_owner",
          result: {
            rows: [
              {
                auth_user_id: AUTH_USER_ID,
                client_id: CLIENT_ID,
                owner_id: OWNER_ID,
              },
            ],
          },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_refresh_owner",
          result: { rows: [ownerRow()] },
        },
        { match: "pg_catalog.pg_advisory_xact_lock" },
        {
          match: "remote_mcp_oauth_store:read_refresh_authority",
          result: { rows: [refreshAuthorityRow()] },
        },
        ...refreshFamilyCompromiseSteps(),
        { match: "commit" },
      ],
    );
    const failure = new Response(null, { status: 503 });

    await expect(
      createStore(pool).withOwnerClientRefreshLock(
        { clientId: CLIENT_ID, refreshToken, resource: RESOURCE },
        () => Promise.resolve(failure),
      ),
    ).resolves.toBe(failure);
    const jtiRevocation = pool.client.calls.find((call) =>
      call.text.includes("revoke_jti_family"),
    );
    expect(jtiRevocation?.values[2]).toBe("refresh_rotation_failed");
    expect(pool.client.calls.at(-1)?.text).toBe("commit");
    pool.expectComplete();
  });

  it("compensates a failed bootstrap by revoking token state and compromising its Grant", async () => {
    const pool = new ScriptedPool(
      [
        {
          match: "remote_mcp_oauth_store:locate_failed_exchange_grant",
          result: {
            rows: [
              {
                auth_user_id: AUTH_USER_ID,
                oauth_client_id: CLIENT_ID,
                owner_id: OWNER_ID,
              },
            ],
          },
        },
      ],
      [
        { match: "begin" },
        {
          match: "remote_mcp_oauth_store:lock_failed_exchange_owner",
          result: { rows: [ownerRow()] },
        },
        { match: "pg_catalog.pg_advisory_xact_lock" },
        {
          match: "remote_mcp_oauth_store:lock_failed_exchange_grant",
          result: {
            rows: [{ credential_id: CREDENTIAL_ID, status: "active" }],
          },
        },
        { match: "remote_mcp_oauth_store:revoke_failed_exchange_refresh" },
        {
          match: "remote_mcp_oauth_store:delete_failed_exchange_provider_access",
        },
        { match: "remote_mcp_oauth_store:delete_failed_exchange_consent" },
        { match: "remote_mcp_oauth_store:revoke_failed_exchange_jtis" },
        { match: "remote_mcp_oauth_store:revoke_failed_exchange_credential" },
        {
          match: "remote_mcp_oauth_store:compromise_failed_exchange_grant",
          result: { rowCount: 1, rows: [{ id: GRANT_ID }] },
        },
        { match: "commit" },
      ],
    );

    await expect(
      createStore(pool).compensateFailedAuthorizationGrantExchange({ grantId: GRANT_ID }),
    ).resolves.toBeUndefined();
    expect(pool.client.calls.at(-1)?.text).toBe("commit");
    pool.expectComplete();
  });
});
