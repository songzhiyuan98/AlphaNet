import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { createAlphaNetRemoteMcpOAuthRevocationService } from "./remote-mcp-oauth-revocation.js";

const ISSUER = "https://auth.alphanet.example/api/auth";
const RESOURCE = "https://mcp.alphanet.example/mcp";
const CLIENT_ID = "alphanet-desktop";
const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const AUTH_USER_ID = "10000000-0000-4000-8000-000000000002";
const SESSION_ID = "10000000-0000-4000-8000-000000000003";
const AGENT_ID = "10000000-0000-4000-8000-000000000004";
const CREDENTIAL_ID = "10000000-0000-4000-8000-000000000005";
const GRANT_ID = "10000000-0000-4000-8000-000000000006";
const CONSENT_ID = "10000000-0000-4000-8000-000000000007";
const OUTBOX_ID = "10000000-0000-4000-8000-000000000008";
const REFRESH_TOKEN = `aln_rt_v1_${"A".repeat(32)}`;

interface QueryCall {
  text: string;
  values: unknown[];
}

interface QueryStep {
  match: string;
  result?: { rowCount?: number | null; rows?: unknown[] };
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
  readonly client: ScriptedClient;
  connectCount = 0;

  constructor(steps: QueryStep[]) {
    this.client = new ScriptedClient(steps);
  }

  connect(): Promise<ScriptedClient> {
    this.connectCount += 1;
    return Promise.resolve(this.client);
  }
}

function grantRow(status = "active", epoch = "7") {
  return {
    agent_id: AGENT_ID,
    credential_id: CREDENTIAL_ID,
    grant_id: GRANT_ID,
    oauth_client_id: CLIENT_ID,
    owner_id: OWNER_ID,
    status,
    token_epoch: epoch,
  };
}

function successfulRevocationSteps(locator: "access" | "owner" | "refresh"): QueryStep[] {
  return [
    { match: "begin" },
    ...(locator === "owner"
      ? []
      : [{ match: "lock_public_client", result: { rows: [{ client_id: CLIENT_ID }] } }]),
    {
      match: `lock_${locator === "owner" ? "owner_consent" : locator}_grant`,
      result: { rows: [grantRow()] },
    },
    { match: "revoke_refresh_authority", result: { rowCount: 1 } },
    { match: "delete_provider_access_authority", result: { rowCount: 1 } },
    { match: "delete_consent_authority", result: { rowCount: 1 } },
    { match: "revoke_jti_authority", result: { rowCount: 1 } },
    { match: "revoke_credential_authority", result: { rowCount: 1 } },
    {
      match: "revoke_grant_authority",
      result: { rowCount: 1, rows: [{ status: "revoked", token_epoch: "8" }] },
    },
    { match: "lock_outbox_aggregate" },
    { match: "allocate_outbox_sequence", result: { rows: [{ next_sequence: "1" }] } },
    { match: "insert_outbox_event", result: { rows: [{ id: OUTBOX_ID }] } },
    { match: "insert_action_log", result: { rowCount: 1 } },
    { match: "commit" },
  ];
}

function createService(
  pool: ScriptedPool,
  overrides: Partial<{
    authenticateOwner: () => Promise<{
      authUserId: string;
      ownerId: string;
      sessionId: string;
    } | null>;
    verifyAccessTokenForRevocation: (token: string) => Promise<{
      clientId: string;
      grantId: string;
      jti: string;
      resource: string;
    } | null>;
  }> = {},
) {
  return createAlphaNetRemoteMcpOAuthRevocationService({
    authenticateOwner:
      overrides.authenticateOwner ??
      (() =>
        Promise.resolve({
          authUserId: AUTH_USER_ID,
          ownerId: OWNER_ID,
          sessionId: SESSION_ID,
        })),
    issuer: ISSUER,
    pool: pool as unknown as Pool,
    refreshTokenStorageKey: Buffer.alloc(32, 0x22),
    resource: RESOURCE,
    tokenJtiDigestKey: Buffer.alloc(32, 0x33),
    verifyAccessTokenForRevocation:
      overrides.verifyAccessTokenForRevocation ?? (() => Promise.resolve(null)),
  });
}

function revokeRequest(token: string, clientId = CLIENT_ID): Request {
  return new Request(`${ISSUER}/oauth2/revoke`, {
    body: new URLSearchParams({ client_id: clientId, token }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

function consentRequest(
  operation: "delete-consent" | "update-consent",
  body: unknown,
): Request {
  return new Request(`${ISSUER}/oauth2/${operation}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json; charset=utf-8" },
    method: "POST",
  });
}

describe("Remote MCP OAuth revocation service", () => {
  it("revokes every Grant authority surface and writes audit/outbox atomically", async () => {
    const pool = new ScriptedPool(successfulRevocationSteps("refresh"));
    const service = createService(pool);

    const result = await service.executeDomainRevocationTransaction({
      operation: "revoke_token",
      request: revokeRequest(REFRESH_TOKEN),
    });

    expect(result.status).toBe(200);
    expect(await result.text()).toBe("");
    expect(result.headers.get("cache-control")).toBe("no-store");
    const sql = pool.client.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("revoke_refresh_authority");
    expect(sql).toContain("delete_provider_access_authority");
    expect(sql).toContain("delete_consent_authority");
    expect(sql).toContain("revoke_jti_authority");
    expect(sql).toContain("revoke_credential_authority");
    expect(sql).toContain("revoke_grant_authority");
    expect(sql).toContain("insert_outbox_event");
    expect(sql).toContain("insert_action_log");
    expect(pool.client.calls.flatMap((call) => call.values)).not.toContain(REFRESH_TOKEN);
    pool.client.expectComplete();
  });

  it("returns the same RFC-safe success for unknown refresh and access tokens", async () => {
    const refreshPool = new ScriptedPool([
      { match: "begin" },
      { match: "lock_public_client", result: { rows: [{ client_id: CLIENT_ID }] } },
      { match: "lock_refresh_grant", result: { rows: [] } },
      { match: "commit" },
    ]);
    const accessPool = new ScriptedPool([
      { match: "begin" },
      { match: "lock_public_client", result: { rows: [{ client_id: CLIENT_ID }] } },
      { match: "commit" },
    ]);
    const refreshService = createService(refreshPool);
    const accessService = createService(accessPool, {
      verifyAccessTokenForRevocation: () => Promise.resolve(null),
    });

    const [refreshResult, accessResult] = await Promise.all([
      refreshService.executeDomainRevocationTransaction({
        operation: "revoke_token",
        request: revokeRequest(REFRESH_TOKEN),
      }),
      accessService.executeDomainRevocationTransaction({
        operation: "revoke_token",
        request: revokeRequest("unknown.jwt.value"),
      }),
    ]);

    expect(refreshResult.status).toBe(200);
    expect(accessResult.status).toBe(200);
    expect(await refreshResult.text()).toBe(await accessResult.text());
    expect([...refreshResult.headers]).toEqual([...accessResult.headers]);
    expect(refreshPool.client.calls.some((call) => call.text.includes("insert_"))).toBe(
      false,
    );
    expect(accessPool.client.calls.some((call) => call.text.includes("insert_"))).toBe(
      false,
    );
    refreshPool.client.expectComplete();
    accessPool.client.expectComplete();
  });

  it("uses verified access-token locators but never places the raw JWT in SQL", async () => {
    const rawJwt = "signed.jwt.value";
    const verifier = vi.fn(() =>
      Promise.resolve({
        clientId: CLIENT_ID,
        grantId: GRANT_ID,
        jti: "jti-value-123",
        resource: RESOURCE,
      }),
    );
    const pool = new ScriptedPool(successfulRevocationSteps("access"));
    const service = createService(pool, { verifyAccessTokenForRevocation: verifier });

    const result = await service.executeDomainRevocationTransaction({
      operation: "revoke_token",
      request: revokeRequest(rawJwt),
    });

    expect(result.status).toBe(200);
    expect(verifier).toHaveBeenCalledWith(rawJwt);
    expect(pool.client.calls.flatMap((call) => call.values)).not.toContain(rawJwt);
    pool.client.expectComplete();
  });

  it("rejects an unregistered public client before attempting token verification", async () => {
    const verifier = vi.fn(() => Promise.resolve(null));
    const pool = new ScriptedPool([
      { match: "begin" },
      { match: "lock_public_client", result: { rows: [] } },
      { match: "rollback" },
    ]);
    const service = createService(pool, {
      verifyAccessTokenForRevocation: verifier,
    });

    const result = await service.executeDomainRevocationTransaction({
      operation: "revoke_token",
      request: revokeRequest("unknown.jwt.value", "unregistered-client"),
    });

    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: "invalid_client" });
    expect(verifier).not.toHaveBeenCalled();
    pool.client.expectComplete();
  });

  it("revalidates the Owner session and treats Provider update as full revocation", async () => {
    const authenticateOwner = vi.fn(() =>
      Promise.resolve({
        authUserId: AUTH_USER_ID,
        ownerId: OWNER_ID,
        sessionId: SESSION_ID,
      }),
    );
    const pool = new ScriptedPool(successfulRevocationSteps("owner"));
    const service = createService(pool, { authenticateOwner });

    const result = await service.executeDomainRevocationTransaction({
      operation: "update_consent",
      request: consentRequest("update-consent", {
        id: CONSENT_ID,
        update: { scopes: ["community:read", "offline_access"] },
      }),
    });

    expect(result.status).toBe(200);
    expect(authenticateOwner).toHaveBeenCalledOnce();
    const locator = pool.client.calls.find((call) =>
      call.text.includes("lock_owner_consent_grant"),
    );
    expect(locator?.values).toEqual([
      CONSENT_ID,
      AUTH_USER_ID,
      OWNER_ID,
      SESSION_ID,
      RESOURCE,
    ]);
    const actionLog = pool.client.calls.find((call) =>
      call.text.includes("insert_action_log"),
    );
    expect(actionLog?.values).toContain("owner_consent_updated");
    pool.client.expectComplete();
  });

  it("lets an Owner revoke an existing grant after its OAuth client is disabled", async () => {
    const pool = new ScriptedPool(successfulRevocationSteps("owner"));
    const service = createService(pool);

    const result = await service.executeDomainRevocationTransaction({
      operation: "delete_consent",
      request: consentRequest("delete-consent", { id: CONSENT_ID }),
    });

    expect(result.status).toBe(200);
    const locator = pool.client.calls.find((call) =>
      call.text.includes("lock_owner_consent_grant"),
    );
    expect(locator?.text).not.toContain("oauth_client.disabled");
    expect(locator?.text).toContain("oauth_client.public is true");
    pool.client.expectComplete();
  });

  it("rejects an unauthenticated Owner without opening a transaction", async () => {
    const pool = new ScriptedPool([]);
    const service = createService(pool, {
      authenticateOwner: () => Promise.resolve(null),
    });

    const result = await service.executeDomainRevocationTransaction({
      operation: "delete_consent",
      request: consentRequest("delete-consent", { id: CONSENT_ID }),
    });

    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: "unauthorized" });
    expect(pool.connectCount).toBe(0);
  });

  it("rejects unsupported request shapes before authentication or database access", async () => {
    const authenticateOwner = vi.fn(() => Promise.resolve(null));
    const pool = new ScriptedPool([]);
    const service = createService(pool, { authenticateOwner });
    const duplicateForm = new Request(`${ISSUER}/oauth2/revoke`, {
      body: `client_id=${CLIENT_ID}&token=one&token=two`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });

    const results = await Promise.all([
      service.executeDomainRevocationTransaction({
        operation: "revoke_token",
        request: duplicateForm,
      }),
      service.executeDomainRevocationTransaction({
        operation: "update_consent",
        request: consentRequest("update-consent", {
          id: CONSENT_ID,
          update: { scopes: ["offline_access"] },
        }),
      }),
      service.executeDomainRevocationTransaction({
        operation: "delete_consent",
        request: consentRequest("delete-consent", { extra: true, id: CONSENT_ID }),
      }),
    ]);

    expect(results.map((result) => result.status)).toEqual([400, 400, 400]);
    expect(pool.connectCount).toBe(0);
    expect(authenticateOwner).not.toHaveBeenCalled();
  });

  it("fails closed and rolls back without returning token or database details", async () => {
    const pool = new ScriptedPool([
      { match: "begin" },
      { match: "lock_public_client", result: { rows: [{ client_id: CLIENT_ID }] } },
      { match: "lock_refresh_grant", result: { rows: [grantRow()] } },
      {
        match: "revoke_refresh_authority",
        throws: new Error("sensitive database detail"),
      },
      { match: "rollback" },
    ]);
    const service = createService(pool);

    const result = await service.executeDomainRevocationTransaction({
      operation: "revoke_token",
      request: revokeRequest(REFRESH_TOKEN),
    });

    expect(result.status).toBe(503);
    const body = await result.text();
    expect(body).toBe('{"error":"temporarily_unavailable"}');
    expect(body).not.toContain(REFRESH_TOKEN);
    expect(body).not.toContain("database");
    pool.client.expectComplete();
  });
});
