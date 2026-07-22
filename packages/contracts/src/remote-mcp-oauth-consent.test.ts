import { describe, expect, it } from "vitest";

import {
  OwnerRemoteMcpOAuthConsentInspectRequestSchema,
  OwnerRemoteMcpOAuthConsentInspectResponseSchema,
  OwnerRemoteMcpOAuthConsentSelectAgentRequestSchema,
  OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema,
  REMOTE_MCP_OAUTH_CONTINUATION_HANDLE_MAX_LENGTH,
  REMOTE_MCP_OAUTH_QUERY_MAX_BYTES,
} from "./remote-mcp-oauth-consent.ts";

const agentId = "10000000-0000-4000-8000-000000000001";

const safeView = {
  request_id: "req_consent_1",
  schema_version: "1",
  phase: "consent_review",
  client: {
    id: "alphanet-research-client",
    name: "AlphaNet Research Client",
    redirect_origin: "https://client.example",
    redirect_uri: "https://client.example/oauth/callback?channel=desktop",
  },
  resource: "https://mcp.alphanet.example/mcp",
  requested_scopes: ["research:read", "offline_access"],
  expires_at: "2026-07-22T12:10:00.000Z",
  selected_agent_id: agentId,
  credential_policy_ceiling: {
    tier: "assisted",
    defaults_version: "agent-permission-defaults-v1",
    schema_version: 1,
  },
  agents: [
    {
      id: agentId,
      handle: "research-agent",
      display_name: "Research Agent",
      policy: {
        tier: "assisted",
        defaults_version: "agent-permission-defaults-v1",
        schema_version: 1,
        version: "9007199254740993",
      },
    },
  ],
} as const;

describe("Owner Remote MCP OAuth Consent contracts", () => {
  it("accepts bounded, strict snake_case inspect and selection requests", () => {
    expect(
      OwnerRemoteMcpOAuthConsentInspectRequestSchema.parse({
        oauth_query: "client_id=test&sig=signed",
        continuation_handle: "opaque_base64url-handle",
      }),
    ).toEqual({
      oauth_query: "client_id=test&sig=signed",
      continuation_handle: "opaque_base64url-handle",
    });
    expect(
      OwnerRemoteMcpOAuthConsentSelectAgentRequestSchema.parse({
        oauth_query: "client_id=test&sig=signed",
        agent_id: agentId,
      }),
    ).toEqual({
      oauth_query: "client_id=test&sig=signed",
      agent_id: agentId,
    });

    expect(
      OwnerRemoteMcpOAuthConsentInspectRequestSchema.safeParse({
        oauth_query: "q".repeat(REMOTE_MCP_OAUTH_QUERY_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(
      OwnerRemoteMcpOAuthConsentInspectRequestSchema.safeParse({
        oauth_query: "q",
        continuation_handle: "h".repeat(
          REMOTE_MCP_OAUTH_CONTINUATION_HANDLE_MAX_LENGTH + 1,
        ),
      }).success,
    ).toBe(false);
    expect(
      OwnerRemoteMcpOAuthConsentInspectRequestSchema.safeParse({
        oauth_query: "q",
        continuation_handle: "not+base64url=",
      }).success,
    ).toBe(false);
    expect(
      OwnerRemoteMcpOAuthConsentSelectAgentRequestSchema.safeParse({
        oauth_query: "q",
        agentId,
      }).success,
    ).toBe(false);
  });

  it("projects only the safe consent view and preserves decimal policy versions", () => {
    expect(OwnerRemoteMcpOAuthConsentInspectResponseSchema.parse(safeView)).toEqual(
      safeView,
    );

    for (const sensitiveField of ["owner_id", "actor_id", "grant_id", "credential_id"]) {
      expect(
        OwnerRemoteMcpOAuthConsentInspectResponseSchema.safeParse({
          ...safeView,
          [sensitiveField]: "20000000-0000-4000-8000-000000000002",
        }).success,
      ).toBe(false);
    }

    expect(
      OwnerRemoteMcpOAuthConsentInspectResponseSchema.safeParse({
        ...safeView,
        agents: [{ ...safeView.agents[0], actor_id: agentId }],
      }).success,
    ).toBe(false);
  });

  it("enforces safe-view phase and selection correlation", () => {
    expect(
      OwnerRemoteMcpOAuthConsentInspectResponseSchema.parse({
        ...safeView,
        phase: "agent_selection",
        selected_agent_id: null,
        credential_policy_ceiling: null,
      }),
    ).toMatchObject({
      phase: "agent_selection",
      selected_agent_id: null,
      credential_policy_ceiling: null,
    });

    expect(
      OwnerRemoteMcpOAuthConsentInspectResponseSchema.safeParse({
        ...safeView,
        selected_agent_id: null,
      }).success,
    ).toBe(false);
    expect(
      OwnerRemoteMcpOAuthConsentInspectResponseSchema.safeParse({
        ...safeView,
        selected_agent_id: "20000000-0000-4000-8000-000000000002",
      }).success,
    ).toBe(false);
    expect(
      OwnerRemoteMcpOAuthConsentInspectResponseSchema.safeParse({
        ...safeView,
        credential_policy_ceiling: null,
      }).success,
    ).toBe(false);
  });

  it("accepts the selection response and rejects unsafe or malformed projections", () => {
    const response = {
      ...safeView,
      continuation_handle: "continuation_handle-1",
      grant_expires_at: "2026-08-21T12:00:00.000Z",
      idempotent: false,
    } as const;
    expect(OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema.parse(response)).toEqual(
      response,
    );
    expect(
      OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema.safeParse({
        ...response,
        resource: "https://mcp.alphanet.example/mcp?variant=unsafe",
      }).success,
    ).toBe(false);
    expect(
      OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema.safeParse({
        ...response,
        client: { ...response.client, redirect_origin: "http://client.example" },
      }).success,
    ).toBe(false);
    expect(
      OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema.safeParse({
        ...response,
        client: { ...response.client, redirect_origin: "ftp://client.example" },
      }).success,
    ).toBe(false);
    expect(
      OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema.safeParse({
        ...response,
        client: {
          ...response.client,
          redirect_uri: "https://sibling.example/oauth/callback",
        },
      }).success,
    ).toBe(false);
    expect(
      OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema.safeParse({
        ...response,
        client: {
          ...response.client,
          redirect_uri: "https://client.example/oauth/callback#fragment",
        },
      }).success,
    ).toBe(false);
    expect(
      OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema.safeParse({
        ...response,
        client: { ...response.client, redirect_uri: "not-a-url" },
      }).success,
    ).toBe(false);
    expect(
      OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema.safeParse({
        ...response,
        requested_scopes: ["offline_access"],
      }).success,
    ).toBe(false);
    expect(
      OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema.safeParse({
        ...response,
        agents: [
          {
            ...response.agents[0],
            policy: { ...response.agents[0].policy, version: "1.5" },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
