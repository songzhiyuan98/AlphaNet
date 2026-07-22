import { createHash } from "node:crypto";

import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  PostgresRemoteMcpOAuthConsentService,
  RemoteMcpOAuthConsentError,
  type RemoteMcpOAuthConsentPool,
} from "./remote-mcp-oauth-consent.js";

const now = new Date("2026-07-22T12:00:00.000Z");
const ownerId = "10000000-0000-4000-8000-000000000001";
const authUserId = "20000000-0000-4000-8000-000000000002";
const sessionId = "30000000-0000-4000-8000-000000000003";
const otherSessionId = "30000000-0000-4000-8000-000000000004";
const agentId = "40000000-0000-4000-8000-000000000004";
const otherAgentId = "40000000-0000-4000-8000-000000000005";
const actorId = "50000000-0000-4000-8000-000000000005";
const requestId = "60000000-0000-4000-8000-000000000006";
const resource = "https://mcp.alphanet.example/mcp";
const redirectUri = "https://client.example/callback";
const clientId = "alphanet-test-client";
const requestedScopes = ["research:read", "offline_access"] as const;
const codeChallenge = createHash("sha256")
  .update("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~", "ascii")
  .digest("base64url");
const authorization = {
  clientId,
  codeChallenge,
  ownerSessionId: sessionId,
  redirectUri,
  requestedScopes,
  resource,
};

function result(rows: QueryResultRow[]): unknown {
  return {
    command: "SELECT",
    fields: [],
    oid: 0,
    rowCount: rows.length,
    rows,
  };
}

function sqlKey(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

class ConsentDatabaseHarness {
  clientGrantTypes: string[] = ["authorization_code", "refresh_token"];
  clientPublic: boolean | null = true;
  clientSecret: string | null = null;
  clientTokenEndpointAuthMethod: string | null = "none";
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];
  readonly releases: Array<boolean | Error | undefined> = [];
  expired = false;
  grant: {
    credentialId: string;
    expiresAt: Date;
    grantId: string;
    offlineAccess: boolean;
    scopes: string[];
    status: "active" | "pending";
  } | null = null;
  requestAgentId: string | null = null;
  requestGrantId: string | null = null;
  requestOwnerId: string | null = null;
  requestSessionId: string | null = null;
  requestStatus: "consumed" | "denied" | "expired" | "pending" | "selected" = "pending";
  selectedAgentAvailable = true;
  sessionAvailable = true;
  throwOnInsert: (Error & { code: string }) | null = null;

  readonly client = {
    query: async <Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> => {
      await Promise.resolve();
      const key = sqlKey(text);
      this.queries.push({ text: key, values });
      if (
        key.startsWith("begin isolation level") ||
        key === "commit" ||
        key === "rollback"
      ) {
        return result([]) as QueryResult<Row>;
      }
      if (key.includes("from auth.sessions as owner_session")) {
        return result(
          this.sessionAvailable ? [{ auth_user_id: authUserId, owner_id: ownerId }] : [],
        ) as QueryResult<Row>;
      }
      if (
        key.includes(
          "from platform.oauth_authorization_requests as authorization_request",
        ) &&
        key.includes("inner join auth.oauth_clients as oauth_client") &&
        !key.includes("inner join platform.oauth_grants as oauth_grant")
      ) {
        return result([
          {
            agent_id: this.requestAgentId,
            client_disabled: false,
            client_grant_types: [...this.clientGrantTypes],
            client_name: "AlphaNet Research Desktop",
            client_public: this.clientPublic,
            client_redirect_uris: [redirectUri],
            client_require_pkce: true,
            client_secret: this.clientSecret,
            client_scopes: [...requestedScopes],
            client_skip_consent: false,
            client_token_endpoint_auth_method: this.clientTokenEndpointAuthMethod,
            code_challenge: authorization.codeChallenge,
            code_challenge_method: "S256",
            expires_at: new Date(now.valueOf() + 5 * 60_000),
            id: requestId,
            is_expired: this.expired,
            oauth_client_id: clientId,
            owner_id: this.requestOwnerId,
            owner_session_id: this.requestSessionId,
            redirect_uri: redirectUri,
            requested_scopes: [...requestedScopes],
            resource,
            status: this.requestStatus,
          },
        ]) as QueryResult<Row>;
      }
      if (
        key.includes("from platform.agents as agent") &&
        !key.includes("where agent.id = $1::uuid")
      ) {
        return result([
          {
            actor_id: actorId,
            defaults_version: "agent-permission-defaults-v1",
            display_name: "Research Agent",
            handle: "research-agent",
            id: agentId,
            policy_schema_version: 1,
            policy_tier: "assisted",
            policy_version: "9007199254740993",
          },
        ]) as QueryResult<Row>;
      }
      if (
        key.includes("from platform.agents as agent") &&
        key.includes("where agent.id = $1::uuid")
      ) {
        const requestedAgent = values[0];
        if (!this.selectedAgentAvailable || requestedAgent !== agentId) {
          return result([]) as QueryResult<Row>;
        }
        return result([
          {
            actor_id: actorId,
            defaults_version: "agent-permission-defaults-v1",
            display_name: "Research Agent",
            handle: "research-agent",
            id: agentId,
            policy_rules: {},
            policy_schema_version: 1,
            policy_tier: "assisted",
            policy_version: "4",
          },
        ]) as QueryResult<Row>;
      }
      if (
        key.startsWith("update platform.oauth_authorization_requests") &&
        key.includes("set status = 'selected'")
      ) {
        if (this.requestStatus !== "pending" || this.expired) {
          return result([]) as QueryResult<Row>;
        }
        this.requestStatus = "selected";
        this.requestOwnerId = values[1] as string;
        this.requestAgentId = values[2] as string;
        this.requestSessionId = values[3] as string;
        return result([{ id: requestId }]) as QueryResult<Row>;
      }
      if (key.startsWith("with inserted_credential as")) {
        if (this.throwOnInsert) throw this.throwOnInsert;
        this.grant = {
          credentialId: values[0] as string,
          expiresAt: new Date(now.valueOf() + 30 * 24 * 60 * 60_000),
          grantId: values[10] as string,
          offlineAccess: values[14] as boolean,
          scopes: [...(values[3] as string[])],
          status: "pending",
        };
        return result([
          {
            credential_id: this.grant.credentialId,
            expires_at: this.grant.expiresAt,
            grant_id: this.grant.grantId,
            offline_access: this.grant.offlineAccess,
            scopes: this.grant.scopes,
          },
        ]) as QueryResult<Row>;
      }
      if (
        key.includes("from platform.oauth_grants as oauth_grant") &&
        !key.includes("from platform.oauth_authorization_requests")
      ) {
        return result(
          this.grant
            ? [
                {
                  credential_id: this.grant.credentialId,
                  expires_at: this.grant.expiresAt,
                  grant_id: this.grant.grantId,
                  offline_access: this.grant.offlineAccess,
                  scopes: this.grant.scopes,
                },
              ]
            : [],
        ) as QueryResult<Row>;
      }
      if (
        key.includes(
          "from platform.oauth_authorization_requests as authorization_request",
        ) &&
        key.includes("inner join platform.oauth_grants as oauth_grant")
      ) {
        return result(
          this.grant
            ? [
                {
                  authority_checked_at: now,
                  agent_id: this.requestAgentId,
                  client_disabled: false,
                  client_grant_types: [...this.clientGrantTypes],
                  client_public: this.clientPublic,
                  client_redirect_uris: [redirectUri],
                  client_require_pkce: true,
                  client_secret: this.clientSecret,
                  client_scopes: [...requestedScopes],
                  client_skip_consent: false,
                  client_token_endpoint_auth_method: this.clientTokenEndpointAuthMethod,
                  credential_expires_at: this.grant.expiresAt,
                  grant_expires_at: this.grant.expiresAt,
                  grant_id: this.grant.grantId,
                  grant_offline_access: this.grant.offlineAccess,
                  grant_scopes: this.grant.scopes,
                  grant_status: this.grant.status,
                  is_expired: this.expired,
                  oauth_client_id: clientId,
                  owner_id: this.requestOwnerId,
                  owner_session_id: this.requestSessionId,
                  redirect_uri: redirectUri,
                  request_grant_id: this.requestGrantId,
                  request_status: this.requestStatus,
                  requested_scopes: [...requestedScopes],
                  resource,
                },
              ]
            : [],
        ) as QueryResult<Row>;
      }
      if (
        key.startsWith("update platform.oauth_authorization_requests") &&
        key.includes("set status = 'consumed'")
      ) {
        if (this.requestStatus !== "selected" || this.requestGrantId !== null) {
          return result([]) as QueryResult<Row>;
        }
        this.requestStatus = "consumed";
        this.requestGrantId = values[1] as string;
        return result([{ id: requestId }]) as QueryResult<Row>;
      }
      if (
        key.startsWith("update platform.oauth_grants") &&
        key.includes("set status = 'active'")
      ) {
        if (!this.grant || this.grant.status !== "pending") {
          return result([]) as QueryResult<Row>;
        }
        this.grant.status = "active";
        return result([{ id: this.grant.grantId }]) as QueryResult<Row>;
      }
      throw new Error(`Unexpected SQL: ${key}`);
    },
    release: (error?: boolean | Error): void => {
      this.releases.push(error);
    },
  };

  readonly pool = {
    connect: async () => {
      await Promise.resolve();
      return this.client;
    },
  } as unknown as RemoteMcpOAuthConsentPool;
}

function service(
  database: ConsentDatabaseHarness,
  options: { currentTime?: () => Date; continuationTtlSeconds?: number } = {},
): PostgresRemoteMcpOAuthConsentService {
  return new PostgresRemoteMcpOAuthConsentService(database.pool, {
    authorizationBindingKey: Buffer.alloc(32, 0x11),
    continuationKey: Buffer.alloc(32, 0x22),
    continuationTtlSeconds: options.continuationTtlSeconds ?? 120,
    now: options.currentTime ?? (() => now),
  });
}

async function prepare(
  database: ConsentDatabaseHarness,
  consentService = service(database),
) {
  return consentService.selectAgentAndPrepareGrant({
    ...authorization,
    agentId,
  });
}

async function expectConsentCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toEqual(
    expect.objectContaining({ code, name: "RemoteMcpOAuthConsentError" }),
  );
}

describe("PostgresRemoteMcpOAuthConsentService", () => {
  it("strongly loads one live request and only the current Owner's active Agents", async () => {
    const database = new ConsentDatabaseHarness();
    const view = await service(database).loadConsentRequest(authorization);

    expect(view).toEqual({
      agents: [
        {
          actorId,
          displayName: "Research Agent",
          handle: "research-agent",
          id: agentId,
          policy: {
            defaultsVersion: "agent-permission-defaults-v1",
            schemaVersion: 1,
            tier: "assisted",
            version: "9007199254740993",
          },
        },
      ],
      client: {
        id: clientId,
        name: "AlphaNet Research Desktop",
        redirectOrigin: "https://client.example",
      },
      expiresAt: new Date(now.valueOf() + 5 * 60_000),
      id: requestId,
      ownerId,
      requestedScopes: [...requestedScopes],
      resource,
      selectedAgentId: null,
      status: "pending",
    });
    const agentQuery = database.queries.find((query) =>
      query.text.includes("order by lower(actor.display_name)"),
    );
    expect(agentQuery?.text).toContain("where agent.owner_id = $1::uuid");
    expect(agentQuery?.text).toContain("agent.status = 'active'");
    expect(agentQuery?.values).toEqual([ownerId]);
    expect(database.queries[0]?.text).toBe("begin isolation level repeatable read");
    expect(database.releases).toEqual([undefined]);
  });

  it("selects under Owner-first locks and atomically creates a secretless pending Grant", async () => {
    const database = new ConsentDatabaseHarness();
    const prepared = await prepare(database);

    expect(prepared).toEqual(
      expect.objectContaining({
        authorizationRequestId: requestId,
        idempotent: false,
        scopes: ["research:read"],
      }),
    );
    expect(prepared.grantId).toMatch(UUID_PATTERN_FOR_TEST);
    expect(prepared.credentialId).toMatch(UUID_PATTERN_FOR_TEST);
    expect(prepared.continuationHandle).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(prepared.continuationHandle).not.toContain(requestId);

    const ownerLockIndex = database.queries.findIndex((query) =>
      query.text.includes("from auth.sessions as owner_session"),
    );
    const envelopeLockIndex = database.queries.findIndex((query) =>
      query.text.includes("authorization_request.binding_digest = $1::bytea"),
    );
    const agentLockIndex = database.queries.findIndex((query) =>
      query.text.includes("where agent.id = $1::uuid"),
    );
    const insert = database.queries.find((query) =>
      query.text.startsWith("with inserted_credential as"),
    );
    expect(ownerLockIndex).toBeLessThan(envelopeLockIndex);
    expect(envelopeLockIndex).toBeLessThan(agentLockIndex);
    expect(insert?.text).toContain("'oauth_grant'");
    expect(insert?.text).not.toContain("token_prefix");
    expect(insert?.text).not.toContain("secret_digest");
    expect(insert?.text).not.toContain("activated_at");
    expect(insert?.values.slice(3, 9)).toEqual([
      ["research:read"],
      resource,
      "assisted",
      "agent-permission-defaults-v1",
      1,
      "{}",
    ]);
  });

  it("returns the same pending Grant for the same request and Agent", async () => {
    const database = new ConsentDatabaseHarness();
    const consentService = service(database);
    const first = await prepare(database, consentService);
    const insertCount = database.queries.filter((query) =>
      query.text.startsWith("with inserted_credential as"),
    ).length;

    const second = await consentService.selectAgentAndPrepareGrant({
      ...authorization,
      agentId,
    });

    expect(second).toEqual(
      expect.objectContaining({
        credentialId: first.credentialId,
        grantId: first.grantId,
        idempotent: true,
      }),
    );
    expect(
      database.queries.filter((query) =>
        query.text.startsWith("with inserted_credential as"),
      ),
    ).toHaveLength(insertCount);
  });

  it("rejects a different Agent, terminal request, expiry, and unavailable session", async () => {
    const selected = new ConsentDatabaseHarness();
    await prepare(selected);
    await expectConsentCode(
      service(selected).selectAgentAndPrepareGrant({
        ...authorization,
        agentId: otherAgentId,
      }),
      "AGENT_NOT_AVAILABLE",
    );

    const terminal = new ConsentDatabaseHarness();
    terminal.requestStatus = "denied";
    await expectConsentCode(
      service(terminal).loadConsentRequest(authorization),
      "CONSENT_STATE_CONFLICT",
    );

    const expired = new ConsentDatabaseHarness();
    expired.expired = true;
    await expectConsentCode(
      service(expired).selectAgentAndPrepareGrant({ ...authorization, agentId }),
      "REQUEST_EXPIRED",
    );

    const session = new ConsentDatabaseHarness();
    session.sessionAvailable = false;
    await expectConsentCode(
      service(session).loadConsentRequest(authorization),
      "OWNER_SESSION_INVALID",
    );
  });

  it("fails closed for non-public or non-PKCE-token client authority", async () => {
    const invalidAuthorities: Array<{
      configure(database: ConsentDatabaseHarness): void;
      label: string;
    }> = [
      {
        configure(database) {
          database.clientGrantTypes = ["authorization_code"];
        },
        label: "offline access without refresh_token",
      },
      {
        configure(database) {
          database.clientTokenEndpointAuthMethod = "client_secret_post";
        },
        label: "confidential token authentication",
      },
      {
        configure(database) {
          database.clientPublic = false;
        },
        label: "non-public client",
      },
      {
        configure(database) {
          database.clientSecret = "A".repeat(43);
        },
        label: "persisted client secret",
      },
    ];

    for (const authority of invalidAuthorities) {
      const database = new ConsentDatabaseHarness();
      authority.configure(database);
      await expectConsentCode(
        service(database).loadConsentRequest(authorization),
        "CLIENT_NOT_AVAILABLE",
      );
    }
  });

  it("revalidates the current client before accepting a continuation", async () => {
    const invalidAuthorities: Array<(database: ConsentDatabaseHarness) => void> = [
      (database) => {
        database.clientGrantTypes = ["authorization_code"];
      },
      (database) => {
        database.clientTokenEndpointAuthMethod = "client_secret_post";
      },
      (database) => {
        database.clientPublic = false;
      },
      (database) => {
        database.clientSecret = "A".repeat(43);
      },
    ];

    for (const invalidate of invalidAuthorities) {
      const database = new ConsentDatabaseHarness();
      const consentService = service(database);
      const prepared = await prepare(database, consentService);
      invalidate(database);

      await expectConsentCode(
        consentService.resolveContinuationHandle({
          continuationHandle: prepared.continuationHandle,
          ownerSessionId: sessionId,
          phase: "inspect",
        }),
        "CLIENT_NOT_AVAILABLE",
      );
      expect(database.requestStatus).toBe("selected");
      expect(database.requestGrantId).toBeNull();
      expect(database.grant?.status).toBe("pending");
    }
  });

  it("inspects idempotently, then consumes and binds the one-shot continuation", async () => {
    const database = new ConsentDatabaseHarness();
    const consentService = service(database);
    const prepared = await prepare(database, consentService);

    await expect(
      consentService.resolveContinuationHandle({
        continuationHandle: prepared.continuationHandle,
        ownerSessionId: sessionId,
        phase: "inspect",
      }),
    ).resolves.toEqual({
      authorizationRequestId: requestId,
      grantId: prepared.grantId,
    });
    expect(database.requestStatus).toBe("selected");
    expect(database.requestGrantId).toBeNull();
    expect(
      database.queries.some((query) =>
        query.text.startsWith("update platform.oauth_grants"),
      ),
    ).toBe(false);
    expect(
      database.queries.some(
        (query) =>
          query.text.startsWith("update platform.oauth_authorization_requests") &&
          query.text.includes("set status = 'consumed'"),
      ),
    ).toBe(false);

    await expect(
      consentService.resolveContinuationHandle({
        continuationHandle: prepared.continuationHandle,
        ownerSessionId: sessionId,
        phase: "inspect",
      }),
    ).resolves.toEqual({
      authorizationRequestId: requestId,
      grantId: prepared.grantId,
    });

    await expect(
      consentService.resolveContinuationHandle({
        continuationHandle: prepared.continuationHandle,
        ownerSessionId: sessionId,
        phase: "claim",
      }),
    ).resolves.toEqual({
      authorizationRequestId: requestId,
      grantId: prepared.grantId,
    });
    expect(database.requestStatus).toBe("consumed");
    expect(database.requestGrantId).toBe(prepared.grantId);
    expect(database.grant?.status).toBe("pending");

    await expectConsentCode(
      consentService.resolveContinuationHandle({
        continuationHandle: prepared.continuationHandle,
        ownerSessionId: sessionId,
        phase: "claim",
      }),
      "CONTINUATION_REPLAYED",
    );
  });

  it("rejects tampering, wrong-session use, and expiration before database access", async () => {
    let current = now;
    const database = new ConsentDatabaseHarness();
    const consentService = service(database, {
      continuationTtlSeconds: 10,
      currentTime: () => current,
    });
    const prepared = await prepare(database, consentService);
    const queriesAfterPrepare = database.queries.length;
    const midpoint = Math.floor(prepared.continuationHandle.length / 2);
    const replacement = prepared.continuationHandle[midpoint] === "A" ? "B" : "A";
    const tampered = `${prepared.continuationHandle.slice(0, midpoint)}${replacement}${prepared.continuationHandle.slice(midpoint + 1)}`;

    await expectConsentCode(
      consentService.resolveContinuationHandle({
        continuationHandle: tampered,
        ownerSessionId: sessionId,
        phase: "inspect",
      }),
      "CONTINUATION_INVALID",
    );
    await expectConsentCode(
      consentService.resolveContinuationHandle({
        continuationHandle: prepared.continuationHandle,
        ownerSessionId: otherSessionId,
        phase: "inspect",
      }),
      "CONTINUATION_INVALID",
    );
    current = new Date(now.valueOf() + 11_000);
    await expectConsentCode(
      consentService.resolveContinuationHandle({
        continuationHandle: prepared.continuationHandle,
        ownerSessionId: sessionId,
        phase: "inspect",
      }),
      "CONTINUATION_EXPIRED",
    );
    expect(database.queries).toHaveLength(queriesAfterPrepare);
  });

  it("rolls back and maps database authority conflicts without leaking raw errors", async () => {
    const database = new ConsentDatabaseHarness();
    database.throwOnInsert = Object.assign(new Error("constraint conflict"), {
      code: "23505",
    });

    await expectConsentCode(
      service(database).selectAgentAndPrepareGrant({ ...authorization, agentId }),
      "GRANT_CONFLICT",
    );
    expect(database.queries.at(-1)?.text).toBe("rollback");
    expect(database.releases).toEqual([undefined]);
  });

  it("validates independent key and lifetime boundaries at construction", () => {
    const database = new ConsentDatabaseHarness();
    expect(
      () =>
        new PostgresRemoteMcpOAuthConsentService(database.pool, {
          authorizationBindingKey: Buffer.alloc(31),
          continuationKey: Buffer.alloc(32),
        }),
    ).toThrow("authorization binding key must be at least 32 bytes");
    expect(
      () =>
        new PostgresRemoteMcpOAuthConsentService(database.pool, {
          authorizationBindingKey: Buffer.alloc(32),
          continuationKey: Buffer.alloc(32, 1),
          continuationTtlSeconds: 301,
        }),
    ).toThrow("continuation TTL is outside its supported range");
    expect(
      () =>
        new PostgresRemoteMcpOAuthConsentService(database.pool, {
          authorizationBindingKey: Buffer.alloc(32, 2),
          continuationKey: Buffer.alloc(32, 2),
        }),
    ).toThrow("authorization binding and continuation keys must be independent");
  });

  it("keeps stable error metadata log-safe", () => {
    const error = new RemoteMcpOAuthConsentError("OWNER_SESSION_INVALID");
    expect(error).toMatchObject({
      code: "OWNER_SESSION_INVALID",
      message: "OWNER_SESSION_INVALID",
      statusCode: 401,
    });
  });
});

const UUID_PATTERN_FOR_TEST =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
