import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it } from "vitest";

import { AgentConnectionError, type AgentScope } from "./agent-connection.js";
import {
  PostgresRemoteMcpAuthorityService,
  type RemoteMcpActorAuthorityInput,
} from "./remote-mcp-authority.js";

const checkedAt = new Date("2026-07-22T18:00:00.000Z");
const issuedAt = new Date("2026-07-01T18:00:00.000Z");
const expiresAt = new Date("2026-08-01T18:00:00.000Z");
const tokenExpiresAt = new Date("2026-07-22T18:10:00.000Z");
const ownerId = "10000000-0000-4000-8000-000000000001";
const authUserId = "10000000-0000-4000-8000-000000000002";
const agentId = "20000000-0000-4000-8000-000000000001";
const actorId = "20000000-0000-4000-8000-000000000002";
const credentialId = "30000000-0000-4000-8000-000000000001";
const grantId = "40000000-0000-4000-8000-000000000001";
const policyId = "50000000-0000-4000-8000-000000000001";
const tokenJtiDigest = Buffer.alloc(32, 0x5a);
const tokenJtiDigestText = tokenJtiDigest.toString("base64url");
const resource = "https://mcp.alphanet.example/mcp";
const clientId = "alphanet-test-client";
const scopes: AgentScope[] = ["community:read", "research:read"];

interface CapturedQuery {
  text: string;
  values: unknown[];
}

interface FakePostgresOptions {
  authorityRows?: unknown[];
  ownerRows?: unknown[];
  rejectAuthority?: boolean;
  rejectTelemetry?: boolean;
  subjectRows?: unknown[];
}

function fakePostgres(options: FakePostgresOptions = {}): {
  calls: CapturedQuery[];
  sql: PostgresClient;
} {
  const calls: CapturedQuery[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join("?"), values };
    calls.push(query);
    if (query.text.includes("update platform.oauth_grants")) {
      if (options.rejectTelemetry) {
        return Promise.reject(new Error("telemetry unavailable"));
      }
      return Promise.resolve([]);
    }
    if (query.text.includes("update platform.credentials")) {
      if (options.rejectTelemetry) {
        return Promise.reject(new Error("telemetry unavailable"));
      }
      return Promise.resolve([]);
    }
    if (
      query.text.includes("select owner_id") &&
      query.text.includes("from platform.oauth_grants")
    ) {
      return Promise.resolve(options.subjectRows ?? [{ owner_id: ownerId }]);
    }
    if (query.text.includes("from platform.owners")) {
      return Promise.resolve(options.ownerRows ?? [validOwnerRow()]);
    }
    if (query.text.includes("from platform.oauth_grants as oauth_grant")) {
      if (options.rejectAuthority) {
        return Promise.reject(new Error("database unavailable"));
      }
      return Promise.resolve(options.authorityRows ?? [validAuthorityRow()]);
    }
    return Promise.reject(new Error(`Unexpected query: ${query.text}`));
  };
  Object.assign(tag, {
    begin: async <T>(
      optionsOrCallback: string | ((transaction: typeof tag) => Promise<T>),
      possibleCallback?: (transaction: typeof tag) => Promise<T>,
    ): Promise<T> => {
      const callback =
        typeof optionsOrCallback === "string" ? possibleCallback : optionsOrCallback;
      if (!callback) throw new Error("A transaction callback is required");
      return callback(tag);
    },
  });
  return { calls, sql: tag as unknown as PostgresClient };
}

function validOwnerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ownerId,
    auth_user_id: authUserId,
    status: "active",
    email_verified_at: issuedAt,
    deleted_at: null,
    ...overrides,
  };
}

function validAuthorityRow(overrides: Record<string, unknown> = {}) {
  return {
    authority_checked_at: checkedAt,
    grant_id: grantId,
    grant_owner_id: ownerId,
    grant_auth_user_id: authUserId,
    grant_agent_id: agentId,
    grant_credential_id: credentialId,
    grant_client_id: clientId,
    grant_resource: resource,
    grant_scopes: [...scopes].reverse(),
    grant_offline_access: false,
    grant_status: "active",
    grant_token_epoch: "7",
    grant_activated_at: issuedAt,
    grant_expires_at: expiresAt,

    token_jti_digest: Buffer.from(tokenJtiDigest),
    token_grant_id: grantId,
    token_owner_id: ownerId,
    token_agent_id: agentId,
    token_grant_epoch: "7",
    token_client_id: clientId,
    token_resource: resource,
    token_scopes: [...scopes],
    token_status: "active",
    token_issued_at: checkedAt,
    token_expires_at: tokenExpiresAt,
    token_revoked_at: null,

    client_id: clientId,
    client_disabled: false,
    client_skip_consent: false,
    client_require_pkce: true,
    client_scopes: ["research:read", "community:read", "offline_access"],
    client_grant_types: ["authorization_code", "refresh_token"],
    configured_resource: resource,

    credential_id: credentialId,
    credential_owner_id: ownerId,
    credential_agent_id: agentId,
    credential_name: "Remote MCP grant",
    credential_type: "oauth_grant",
    credential_token_prefix: null,
    credential_secret_digest: null,
    credential_pepper_version: null,
    credential_scopes: [...scopes],
    credential_audience: resource,
    credential_policy_ceiling: "autonomous",
    credential_policy_ceiling_defaults_version: "agent-permission-defaults-v1",
    credential_policy_ceiling_schema_version: 1,
    credential_policy_ceiling_rules: {},
    credential_issued_at: issuedAt,
    credential_expires_at: expiresAt,
    credential_last_used_at: null,
    credential_revoked_at: null,
    credential_replaces_id: null,

    agent_id: agentId,
    agent_actor_id: actorId,
    agent_owner_id: ownerId,
    agent_discovery_tags: ["semiconductors"],
    agent_status: "active",
    agent_restriction_reason_code: null,
    agent_created_at: issuedAt,
    agent_updated_at: issuedAt,
    agent_activated_at: issuedAt,
    agent_archived_at: null,
    agent_deleted_at: null,
    credential_count: 2,

    actor_id: actorId,
    actor_owner_id: ownerId,
    actor_kind: "agent",
    actor_handle: "remote-research-agent",
    actor_display_name: "Remote Research Agent",
    actor_bio: "Cross-validates market research.",
    actor_status: "active",
    actor_deleted_at: null,

    policy_id: policyId,
    policy_agent_id: agentId,
    policy_tier: "autonomous",
    policy_defaults_version: "agent-permission-defaults-v1",
    policy_schema_version: 1,
    policy_version: "3",
    policy_rules: {},
    policy_effective_from: issuedAt,
    policy_is_active: true,
    policy_owner_id: ownerId,
    ...overrides,
  };
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    credentialId,
    grantId,
    scopes: [...scopes],
    tokenJtiDigest: tokenJtiDigestText,
    ...overrides,
  } as unknown as RemoteMcpActorAuthorityInput;
}

async function expectInvalid(
  service: PostgresRemoteMcpAuthorityService,
  input: RemoteMcpActorAuthorityInput = validInput(),
): Promise<void> {
  await expect(service.authenticateActorContext(input)).rejects.toMatchObject({
    code: "INVALID_CREDENTIAL",
    name: "AgentConnectionError",
    statusCode: 401,
  });
}

describe("PostgresRemoteMcpAuthorityService", () => {
  it("revalidates the full OAuth chain under Owner-first locks and returns truthful authority", async () => {
    const { calls, sql } = fakePostgres();
    const context = await new PostgresRemoteMcpAuthorityService(
      sql,
    ).authenticateActorContext(validInput());

    expect(context).toMatchObject({
      owner: { id: ownerId },
      agent: {
        id: agentId,
        actorId,
        ownerId,
        handle: "remote-research-agent",
        policy: {
          id: policyId,
          tier: "autonomous",
          version: "3",
        },
      },
      credential: {
        id: credentialId,
        ownerId,
        agentId,
        type: "oauth_grant",
        prefix: null,
        audience: resource,
        scopes,
        status: "active",
      },
    });
    expect(context.credential.expiresAt).toEqual(expiresAt);
    expect(context.agent.policy.rules.operations.content_write).toBe("allow");

    const subjectIndex = calls.findIndex((call) => call.text.includes("select owner_id"));
    const ownerLockIndex = calls.findIndex((call) =>
      call.text.includes("from platform.owners"),
    );
    const authorityIndex = calls.findIndex((call) =>
      call.text.includes("from platform.oauth_grants as oauth_grant"),
    );
    const telemetryIndex = calls.findIndex((call) =>
      call.text.includes("update platform.oauth_grants"),
    );
    expect(subjectIndex).toBeGreaterThanOrEqual(0);
    expect(ownerLockIndex).toBeGreaterThan(subjectIndex);
    expect(authorityIndex).toBeGreaterThan(ownerLockIndex);
    expect(telemetryIndex).toBeGreaterThan(authorityIndex);
    expect(calls[ownerLockIndex]?.text).toContain("for share");
    expect(calls[authorityIndex]?.text).toContain(
      "for share of oauth_grant, credential, token_jti, oauth_client",
    );
    expect(calls[authorityIndex]?.text).toContain("on resource_configuration.id = true");
    expect(calls[authorityIndex]?.values).toContainEqual(tokenJtiDigest);
  });

  it("strictly rejects malformed assertions before PostgreSQL is consulted", async () => {
    const malformed: RemoteMcpActorAuthorityInput[] = [
      null as unknown as RemoteMcpActorAuthorityInput,
      validInput({ extra: "not-allowed" }),
      validInput({ grantId: "not-a-uuid" }),
      validInput({ credentialId: credentialId.toUpperCase(), grantId: "" }),
      validInput({ scopes: [] }),
      validInput({ scopes: ["research:read", "research:read"] }),
      validInput({ scopes: ["offline_access"] }),
      validInput({ tokenJtiDigest: "A".repeat(42) }),
      validInput({ tokenJtiDigest: `${tokenJtiDigestText.slice(0, -1)}=` }),
    ];

    for (const input of malformed) {
      const { calls, sql } = fakePostgres();
      await expectInvalid(new PostgresRemoteMcpAuthorityService(sql), input);
      expect(calls).toHaveLength(0);
    }
  });

  it.each([
    ["terminal Grant", { grant_status: "revoked" }],
    ["future Grant activation", { grant_activated_at: expiresAt }],
    ["expired Grant", { grant_expires_at: checkedAt }],
    ["wrong Credential type", { credential_type: "static_api_key" }],
    ["revoked Credential", { credential_revoked_at: checkedAt }],
    ["future Credential issue", { credential_issued_at: expiresAt }],
    ["inactive JTI", { token_status: "revoked", token_revoked_at: checkedAt }],
    [
      "future JTI issue",
      {
        token_issued_at: new Date(checkedAt.valueOf() + 60_000),
        token_expires_at: new Date(checkedAt.valueOf() + 120_000),
      },
    ],
    ["expired JTI", { token_expires_at: checkedAt }],
    ["JTI epoch drift", { token_grant_epoch: "8" }],
    ["JTI digest drift", { token_jti_digest: Buffer.alloc(32, 0x33) }],
    ["disabled client", { client_disabled: true }],
    ["unsafe client consent", { client_skip_consent: true }],
    ["disabled PKCE", { client_require_pkce: false }],
    ["client scope drift", { client_scopes: ["research:read"] }],
    ["client identity drift", { token_client_id: "another-client" }],
    ["resource drift", { token_resource: "https://other.example/mcp" }],
    ["Credential scope drift", { credential_scopes: ["research:read"] }],
    ["Agent suspension", { agent_status: "suspended" }],
    ["future Agent activation", { agent_activated_at: expiresAt }],
    ["Actor suspension", { actor_status: "suspended" }],
    ["policy identity drift", { policy_owner_id: authUserId }],
    ["unsupported policy schema", { policy_schema_version: 2 }],
    [
      "unparseable Custom policy",
      { policy_tier: "custom", policy_rules: { unknown_operation: "allow" } },
    ],
    [
      "unsupported Credential ceiling",
      { credential_policy_ceiling_defaults_version: "future-defaults" },
    ],
  ])("fails closed with one public error for %s", async (_label, overrides) => {
    const { sql } = fakePostgres({
      authorityRows: [validAuthorityRow(overrides)],
    });
    await expectInvalid(new PostgresRemoteMcpAuthorityService(sql));
  });

  it.each([
    ["inactive Owner", { status: "suspended" }],
    ["unverified Owner", { email_verified_at: null }],
    ["deleted Owner", { deleted_at: checkedAt }],
    ["Owner-to-auth-user drift", { auth_user_id: agentId }],
  ])("fails closed for %s after taking the Owner lock", async (_label, overrides) => {
    const { calls, sql } = fakePostgres({
      ownerRows: [validOwnerRow(overrides)],
    });
    await expectInvalid(new PostgresRemoteMcpAuthorityService(sql));
    expect(calls.some((call) => call.text.includes("from platform.owners"))).toBe(true);
  });

  it("fails closed for missing subjects and missing authority snapshots", async () => {
    for (const options of [
      { subjectRows: [] },
      { authorityRows: [] },
    ] satisfies FakePostgresOptions[]) {
      const { sql } = fakePostgres(options);
      await expectInvalid(new PostgresRemoteMcpAuthorityService(sql));
    }
  });

  it("preserves dependency failures so the API can report unavailability", async () => {
    const { sql } = fakePostgres({ rejectAuthority: true });
    const error = await new PostgresRemoteMcpAuthorityService(sql)
      .authenticateActorContext(validInput())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AgentConnectionError);
    expect((error as Error).message).toBe("database unavailable");
  });

  it("keeps post-authorization usage telemetry best effort", async () => {
    const { calls, sql } = fakePostgres({ rejectTelemetry: true });
    const context = await new PostgresRemoteMcpAuthorityService(
      sql,
    ).authenticateActorContext(validInput());

    expect(context.credential.id).toBe(credentialId);
    expect(
      calls.filter(
        (call) =>
          call.text.includes("update platform.oauth_grants") ||
          call.text.includes("update platform.credentials"),
      ),
    ).toHaveLength(2);
  });

  it("uses only AgentConnectionError INVALID_CREDENTIAL at the service boundary", async () => {
    const { sql } = fakePostgres({ authorityRows: [] });
    try {
      await new PostgresRemoteMcpAuthorityService(sql).authenticateActorContext(
        validInput(),
      );
      throw new Error("Expected authentication to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentConnectionError);
      expect((error as AgentConnectionError).code).toBe("INVALID_CREDENTIAL");
      expect((error as Error).message).toBe("The Agent credential is invalid.");
    }
  });
});
