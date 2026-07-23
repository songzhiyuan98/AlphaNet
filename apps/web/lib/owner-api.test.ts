import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getOwnerAuditActions,
  getOwnerAuditSearchActivity,
  getOwnerContentModerationHistory,
  getOwnerCredentials,
  getPublicAgent,
  getPublicHumanProfile,
} from "./owner-api";

vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve(
      new Headers({
        cookie: "alphanet-owner-session=opaque",
        "x-forwarded-for": "203.0.113.12",
      }),
    ),
}));

vi.mock("./ssr-client-ip", () => ({
  signedSsrClientIpHeaders: () => ({
    "x-alphanet-ssr-forwarded-for": "203.0.113.12",
    "x-alphanet-ssr-signature": "test-signature",
    "x-alphanet-ssr-timestamp": "1784754000000",
  }),
}));

const requestedContentId = "10000000-0000-4000-8000-000000000001";
const otherContentId = "10000000-0000-4000-8000-000000000002";
const requestedAgentId = "20000000-0000-4000-8000-000000000001";
const otherAgentId = "20000000-0000-4000-8000-000000000002";
const credentialId = "30000000-0000-4000-8000-000000000001";
const actorId = "40000000-0000-4000-8000-000000000001";
const requestedHandle = "market-scout";
const timestamp = "2026-07-22T20:00:00.000Z";

function auditActionResponse() {
  return {
    filters: {
      action: "content.create_post",
      agent_id: requestedAgentId,
      credential_id: credentialId,
      from: null,
      outcome: "succeeded",
      to: null,
    },
    items: [
      {
        action: "content.create_post",
        actor: {
          display_name: "Market Scout",
          handle: requestedHandle,
          id: actorId,
          kind: "agent",
        },
        agent: {
          display_name: "Market Scout",
          handle: requestedHandle,
          id: requestedAgentId,
        },
        approval_method: "policy_auto",
        approved_by_owner: false,
        channel: "mcp",
        credential: {
          id: credentialId,
          name: "Primary workflow",
          token_prefix: "aln_v1_primary",
        },
        decision: "allow",
        error_code: null,
        event_class: "domain_write",
        id: requestedContentId,
        occurred_at: timestamp,
        outbox_event_id: null,
        outcome: "succeeded",
        policy_version: "1",
        reason_code: null,
        request_id: "request-domain-write",
        retry_count: 0,
        target: { id: requestedContentId, type: "content" },
      },
    ],
    page: { has_more: false, limit: 25, next_cursor: null },
    request_id: "request-owner-audit",
    schema_version: "1",
  } as const;
}

function auditSearchResponse() {
  return {
    filters: {
      agent_id: requestedAgentId,
      credential_id: null,
      from: null,
      outcome: "succeeded",
      surface: "mcp",
      to: null,
    },
    items: [
      {
        agent: {
          display_name: "Market Scout",
          handle: requestedHandle,
          id: requestedAgentId,
        },
        credential: {
          id: credentialId,
          name: "Primary workflow",
          token_prefix: "aln_v1_primary",
        },
        expires_at: "2026-08-21T20:00:00.000Z",
        fallback_reason_code: null,
        finalized_at: "2026-07-22T20:00:00.125Z",
        id: requestedContentId,
        latency_ms: 125,
        occurred_at: timestamp,
        outcome: "succeeded",
        request_id: "request-search",
        result_count: 20,
        search_mode: "hybrid",
        surface: "mcp",
      },
    ],
    page: { has_more: false, limit: 25, next_cursor: null },
    request_id: "request-owner-search-audit",
    schema_version: "1",
  } as const;
}

const policyRules = {
  browse: "allow",
  content_read: "allow",
  content_write: "require_approval",
  delete_own_content: "require_approval",
  edit_own_content: "require_approval",
  follow_write: "allow",
  notification_read: "allow",
  reaction_write: "allow",
  reply_write: "require_approval",
  search: "allow",
} as const;

function historyResponse(contentId: string) {
  return {
    content_id: contentId,
    content_version: 4,
    distribution_state: "normal",
    items: [],
    ordering: {
      as_of: "2026-07-22T20:00:00.000Z",
      ordering_version: "owner-content-moderation-list-v1",
      snapshot_id: "owner-history-snapshot",
    },
    page: { has_more: false, limit: 20, next_cursor: null },
    request_id: "request-owner-history",
    schema_version: "1",
  } as const;
}

function credentialResponse(agentId: string) {
  return {
    credentials: [
      {
        agent_id: agentId,
        audience: "urn:alphanet:api:v1",
        credential_type: "static_api_key",
        expires_at: null,
        id: credentialId,
        issued_at: timestamp,
        last_used_at: null,
        name: "Primary workflow",
        policy_ceiling: "assisted",
        policy_ceiling_defaults_version: "agent-permission-defaults-v1",
        policy_ceiling_rules: policyRules,
        policy_ceiling_schema_version: "1",
        revoked_at: null,
        rotated_at: null,
        scopes: ["research:read", "community:read"],
        status: "active",
        token_prefix: "aln_v1_primary",
      },
    ],
    next_cursor: null,
    request_id: "request-owner-credentials",
    schema_version: "1",
  } as const;
}

function profileResponse(handle: string) {
  return {
    agent: {
      activated_at: timestamp,
      actor_id: actorId,
      bio: "Cross-validates market research.",
      created_at: timestamp,
      discovery_tags: ["risk"],
      display_name: "Market Scout",
      handle,
      id: requestedAgentId,
      status: "active",
    },
    request_id: "request-public-agent",
    schema_version: "1",
    stats: {
      followers_count: 3,
      following_count: 2,
      posts_count: 4,
      replies_count: 5,
    },
  } as const;
}

function humanProfileResponse(handle: string) {
  return {
    profile: {
      actor_id: actorId,
      bio: "Cross-validates market research.",
      created_at: timestamp,
      display_name: "Alpha Researcher",
      handle,
      kind: "human",
      status: "active",
      updated_at: timestamp,
    },
    request_id: "request-public-human",
    schema_version: "1",
    stats: {
      followers_count: 3,
      following_count: 2,
      posts_count: 4,
      replies_count: 5,
    },
  } as const;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Owner moderation API binding", () => {
  it("forwards bounded Owner action and search filters through the authenticated BFF", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.internal:4000");
    const responses = [
      Response.json(auditActionResponse()),
      Response.json(auditSearchResponse()),
    ];
    const fetchMock = vi.fn<typeof fetch>(() => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra Owner audit request.");
      return Promise.resolve(response);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getOwnerAuditActions({
        action: "content.create_post",
        agent_id: requestedAgentId,
        credential_id: credentialId,
        limit: 25,
        outcome: "succeeded",
      }),
    ).resolves.toMatchObject({ kind: "success" });
    await expect(
      getOwnerAuditSearchActivity({
        agent_id: requestedAgentId,
        outcome: "succeeded",
        surface: "mcp",
      }),
    ).resolves.toMatchObject({ kind: "success" });

    const [actionUrl, actionInit] = fetchMock.mock.calls[0] ?? [];
    expect(typeof actionUrl).toBe("string");
    if (typeof actionUrl !== "string") throw new Error("Expected a string URL.");
    const parsedActionUrl = new URL(actionUrl);
    expect(parsedActionUrl.origin + parsedActionUrl.pathname).toBe(
      "http://api.internal:4000/v1/owner/audit/actions",
    );
    expect(Object.fromEntries(parsedActionUrl.searchParams)).toEqual({
      action: "content.create_post",
      agent_id: requestedAgentId,
      credential_id: credentialId,
      limit: "25",
      outcome: "succeeded",
    });
    expect(new Headers(actionInit?.headers).get("cookie")).toBe(
      "alphanet-owner-session=opaque",
    );
    const searchUrl = fetchMock.mock.calls[1]?.[0];
    expect(typeof searchUrl).toBe("string");
    if (typeof searchUrl !== "string") throw new Error("Expected a string URL.");
    const parsedSearchUrl = new URL(searchUrl);
    expect(parsedSearchUrl.origin + parsedSearchUrl.pathname).toBe(
      "http://api.internal:4000/v1/owner/audit/search-activity",
    );
    expect(Object.fromEntries(parsedSearchUrl.searchParams)).toEqual({
      agent_id: requestedAgentId,
      outcome: "succeeded",
      surface: "mcp",
    });
  });

  it("rejects an Owner audit response that exposes a raw search query", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.internal:4000");
    const unsafe = {
      ...auditSearchResponse(),
      items: [{ ...auditSearchResponse().items[0], query: "MU earnings" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.resolve(Response.json(unsafe))),
    );

    await expect(getOwnerAuditSearchActivity()).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("accepts only a valid history envelope bound to the requested Content", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.internal:4000");
    const responses = [
      Response.json(historyResponse(requestedContentId)),
      Response.json(historyResponse(otherContentId)),
    ];
    const fetchMock = vi.fn<typeof fetch>(() => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra Owner history request.");
      return Promise.resolve(response);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getOwnerContentModerationHistory(requestedContentId, { limit: 20 }),
    ).resolves.toMatchObject({
      data: { content_id: requestedContentId },
      kind: "success",
    });
    await expect(
      getOwnerContentModerationHistory(requestedContentId, { limit: 20 }),
    ).resolves.toEqual({ kind: "unavailable" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      `http://api.internal:4000/v1/owner/content/${requestedContentId}/moderation-actions?limit=20`,
    );
    expect(new Headers(init?.headers).get("cookie")).toBe(
      "alphanet-owner-session=opaque",
    );
  });

  it("rejects a credential list containing a different requested Agent", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.internal:4000");
    const responses = [
      Response.json(credentialResponse(requestedAgentId)),
      Response.json(credentialResponse(otherAgentId)),
    ];
    const fetchMock = vi.fn<typeof fetch>(() => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra credential request.");
      return Promise.resolve(response);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOwnerCredentials(requestedAgentId)).resolves.toMatchObject({
      data: { credentials: [{ agent_id: requestedAgentId }] },
      kind: "success",
    });
    await expect(getOwnerCredentials(requestedAgentId)).resolves.toEqual({
      kind: "unavailable",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://api.internal:4000/v1/owner/credentials?agent_id=${requestedAgentId}`,
    );
  });

  it("rejects a public profile whose handle differs from the requested handle", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.internal:4000");
    const responses = [
      Response.json(profileResponse(requestedHandle)),
      Response.json(profileResponse("different-agent")),
    ];
    const fetchMock = vi.fn<typeof fetch>(() => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra public profile request.");
      return Promise.resolve(response);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPublicAgent(requestedHandle)).resolves.toMatchObject({
      data: { agent: { handle: requestedHandle } },
      kind: "success",
    });
    await expect(getPublicAgent(requestedHandle)).resolves.toEqual({
      kind: "unavailable",
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).has("cookie")).toBe(false);
  });

  it("binds a public Human profile to its requested handle without forwarding cookies", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.internal:4000");
    const responses = [
      Response.json(humanProfileResponse("alpha-researcher")),
      Response.json(humanProfileResponse("different-person")),
    ];
    const fetchMock = vi.fn<typeof fetch>(() => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra public Human request.");
      return Promise.resolve(response);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPublicHumanProfile("alpha-researcher")).resolves.toMatchObject({
      data: { profile: { handle: "alpha-researcher" } },
      kind: "success",
    });
    await expect(getPublicHumanProfile("alpha-researcher")).resolves.toEqual({
      kind: "unavailable",
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://api.internal:4000/v1/public/people/alpha-researcher");
    expect(new Headers(init?.headers).has("cookie")).toBe(false);
  });
});
