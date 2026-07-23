import { describe, expect, it, vi } from "vitest";

import type {
  AdminAgentDetailResponse,
  AdminAgentListResponse,
} from "@alphanet/contracts";

import type { AdminSessionStore } from "./admin-session-store";
import { createAdminApiClient } from "./admin-api";
import type { EnabledAdminWebConfig } from "./admin-web-config";

const agentId = "50000000-0000-4000-8000-000000000001";
const actorId = "50000000-0000-4000-8000-000000000002";
const ownerId = "50000000-0000-4000-8000-000000000003";
const adminId = "50000000-0000-4000-8000-000000000004";
const actionId = "50000000-0000-4000-8000-000000000005";
const sessionHandle = "s".repeat(43);
const accessToken = "header.payload.signature";
const timestamp = "2026-07-23T20:00:00.000Z";

const agent = {
  activated_at: timestamp,
  actor_id: actorId,
  agent_id: agentId,
  archived_at: null,
  created_at: timestamp,
  credential_counts: { active: 1, expired: 0, revoked: 0, total: 1 },
  discovery_tags: ["semiconductors"] as string[],
  display_name: "Semiconductor Agent",
  governance_version: 3,
  handle: "semi-agent",
  owner_id: ownerId,
  restricted_at: null,
  restriction_reason_code: null,
  status: "active",
  suspended_at: null,
  updated_at: timestamp,
} as const;

const listResponse: AdminAgentListResponse = {
  capabilities: { can_restrict: true, can_revoke_credentials: true },
  items: [agent],
  ordering: {
    as_of: timestamp,
    ordering_version: "admin-agent-created-keyset-v1",
    snapshot_id: "50000000-0000-4000-8000-000000000006",
  },
  page: { has_more: false, limit: 25, next_cursor: null },
  request_id: "request-list",
  schema_version: "1",
};

const detailResponse: AdminAgentDetailResponse = {
  agent,
  capabilities: listResponse.capabilities,
  credentials: [],
  request_id: "request-detail",
  schema_version: "1",
};

const actionResponse = {
  action: {
    action: "suspend_agent",
    action_id: actionId,
    admin_id: adminId,
    governance_version_after: 4,
    governance_version_before: 3,
    occurred_at: timestamp,
    permission_used: "identity:restrict",
    reason_code: "platform_policy_violation",
    revoked_credential_count: 0,
  },
  agent: {
    ...agent,
    governance_version: 4,
    restriction_reason_code: "platform_policy_violation",
    status: "suspended",
    suspended_at: timestamp,
  },
  request_id: "request-action",
  schema_version: "1",
} as const;

const config: EnabledAdminWebConfig = {
  awsRegion: "us-west-2",
  callbackUrl: "https://app.example.test/admin/auth/callback",
  dynamodbEndpoint: null,
  enabled: true,
  environment: "test",
  loginCookieName: "alphanet-admin-login-local",
  loginTtlSeconds: 300,
  oidc: {
    clientId: "client-id",
    clientSecret: "client-secret",
    issuer: "https://login.example.test",
    resource: null,
    scopes: ["openid"],
  },
  publicOrigin: "https://app.example.test",
  secureCookies: false,
  sessionCookieName: "alphanet-admin-session-local",
  sessionEncryptionKey: Buffer.alloc(32, 1),
  sessionStore: "dynamodb",
  sessionTable: "alphanet-admin-sessions",
  sessionTtlSeconds: 3600,
};

function store(): AdminSessionStore {
  return {
    consumeLoginTransaction: vi.fn(() => Promise.resolve(null)),
    createLoginTransaction: vi.fn(() => Promise.reject(new Error("unused"))),
    createSession: vi.fn(() => Promise.reject(new Error("unused"))),
    deleteSession: vi.fn(() => Promise.resolve()),
    getSession: vi.fn(() =>
      Promise.resolve({
        accessToken,
        expiresAt: new Date("2026-07-23T21:00:00.000Z"),
      }),
    ),
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("Admin Agent API BFF client", () => {
  it("lists, gets, and acts without exposing Workforce credentials", async () => {
    const responses = [
      json(listResponse),
      json(detailResponse),
      json(actionResponse, 201),
    ];
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(() => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request.");
      return Promise.resolve(response);
    });
    const client = createAdminApiClient({
      adminConfig: config,
      apiInternalUrl: "http://api.internal:4000",
      fetch: fetchImplementation,
      incomingHeaders: new Headers({ "x-forwarded-for": "203.0.113.40" }),
      sessionHandle,
      sessionStore: store(),
      signClientIpHeaders: (_incoming, request) => ({
        "x-alphanet-ssr-forwarded-for": "203.0.113.40",
        "x-alphanet-ssr-signature": `signed-${request.method}-${request.url}`,
        "x-alphanet-ssr-timestamp": "1784664000000",
      }),
      timeoutSignal: () => new AbortController().signal,
    });

    await expect(
      client.listAgents({
        limit: 25,
        query: "semi",
        statuses: ["active", "restricted"],
      }),
    ).resolves.toEqual({ data: listResponse, kind: "success", status: 200 });
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      "http://api.internal:4000/v1/admin/agents?" +
        "statuses=active%2Crestricted&query=semi&limit=25",
    );

    await expect(client.getAgent(agentId)).resolves.toEqual({
      data: detailResponse,
      kind: "success",
      status: 200,
    });

    const attemptId = "50000000-0000-4000-8000-000000000007";
    await expect(
      client.actOnAgent({
        action: {
          action: "suspend_agent",
          reason_code: "platform_policy_violation",
        },
        agentId,
        agentVersion: 3,
        attemptId,
      }),
    ).resolves.toEqual({
      data: actionResponse,
      kind: "success",
      status: 201,
    });
    const actionInit = fetchImplementation.mock.calls[2]?.[1];
    const headers = new Headers(actionInit?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(headers.get("if-match")).toBe('"3"');
    expect(headers.get("idempotency-key")).toBe(`agent-governance-${attemptId}`);
    expect(actionInit?.body).toBe(
      JSON.stringify({
        action: "suspend_agent",
        reason_code: "platform_policy_violation",
      }),
    );
    expect(JSON.stringify(await client.getAgent("invalid"))).not.toContain(accessToken);
  });
});
