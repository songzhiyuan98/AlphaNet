import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
