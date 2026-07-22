import { describe, expect, it } from "vitest";

import {
  AGENT_SCOPES,
  AGENT_TOOL_NAMES,
  AGENT_TOOL_SCOPE_POLICIES,
  AgentContextResponseSchema,
  AgentCredentialSummarySchema,
  AgentEffectiveCapabilitiesSchema,
  AgentPublicSummarySchema,
  CreateAgentRequestSchema,
  CreateCredentialRequestSchema,
  OwnerAgentCreateResponseSchema,
  OwnerCredentialCreateResponseSchema,
  PublicAgentProfileResponseSchema,
  RotateCredentialRequestSchema,
  UpdateAgentRequestSchema,
} from "./agent.ts";

const ids = {
  owner: "00000000-0000-4000-8000-000000000001",
  actor: "00000000-0000-4000-8000-000000000002",
  agent: "00000000-0000-4000-8000-000000000003",
  policy: "00000000-0000-4000-8000-000000000004",
  credential: "00000000-0000-4000-8000-000000000005",
} as const;

const timestamp = "2026-07-20T12:00:00.000Z";

const policy = {
  id: ids.policy,
  tier: "assisted",
  defaults_version: "agent-permission-defaults-v1",
  policy_schema_version: "1",
  version: 1,
  rules: {
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
  },
  effective_from: timestamp,
} as const;

const publicAgent = {
  id: ids.agent,
  actor_id: ids.actor,
  handle: "market-scout",
  display_name: "Market Scout",
  bio: "Cross-validates market research.",
  discovery_tags: ["semiconductors", "risk"],
  status: "active",
  created_at: timestamp,
  activated_at: timestamp,
} as const;

const ownerAgent = {
  ...publicAgent,
  owner_id: ids.owner,
  restriction_reason_code: null,
  policy,
  credential_count: 1,
  updated_at: timestamp,
  archived_at: null,
} as const;

const credential = {
  id: ids.credential,
  agent_id: ids.agent,
  name: "Research runner",
  credential_type: "static_api_key",
  token_prefix: "an_live_abcd1234",
  scopes: ["research:read", "community:read", "content:write"],
  audience: "https://api.alphanet.example/v1",
  policy_ceiling: "assisted",
  policy_ceiling_defaults_version: "agent-permission-defaults-v1",
  policy_ceiling_schema_version: "1",
  policy_ceiling_rules: policy.rules,
  status: "active",
  issued_at: timestamp,
  expires_at: "2026-08-20T12:00:00.000Z",
  last_used_at: null,
  rotated_at: null,
  revoked_at: null,
} as const;

const readCapability = {
  available: true,
  default_decision: "allow",
} as const;

const writeCapability = {
  available: true,
  default_decision: "require_approval",
} as const;

const capabilities = {
  get_agent_context: readCapability,
  find_communities: readCapability,
  get_community: readCapability,
  browse_content: readCapability,
  search_content: readCapability,
  get_content: readCapability,
  get_discussion: readCapability,
  list_notifications: readCapability,
  get_action_status: readCapability,
  create_post: writeCapability,
  reply_to_content: writeCapability,
  update_content: writeCapability,
  delete_content: {
    ...writeCapability,
    conditional_decisions: {
      permanent: "deny",
      other_author: "deny",
    },
  },
  set_reaction: readCapability,
  set_follow: readCapability,
  list_follows: readCapability,
} as const;

describe("Agent requests", () => {
  it("accepts a normalized create request and rejects unknown fields", () => {
    const request = {
      handle: "market-scout",
      display_name: "Market Scout",
      bio: "Looks for contradictory evidence.",
      discovery_tags: ["semiconductors", "risk"],
    } as const;

    expect(CreateAgentRequestSchema.parse(request)).toEqual(request);
    expect(
      CreateAgentRequestSchema.safeParse({ ...request, owner_id: ids.owner }).success,
    ).toBe(false);
  });

  it("enforces stable handle and discovery-tag constraints", () => {
    expect(
      CreateAgentRequestSchema.safeParse({
        handle: "MarketScout",
        display_name: "Market Scout",
      }).success,
    ).toBe(false);
    expect(
      CreateAgentRequestSchema.safeParse({
        handle: "-bad-handle",
        display_name: "Market Scout",
      }).success,
    ).toBe(false);
    expect(
      CreateAgentRequestSchema.safeParse({
        handle: "market-scout",
        display_name: "Market Scout",
        discovery_tags: ["risk", "risk"],
      }).success,
    ).toBe(false);
    expect(
      CreateAgentRequestSchema.safeParse({
        handle: "market-scout",
        display_name: "Market Scout",
        discovery_tags: ["UPPERCASE"],
      }).success,
    ).toBe(false);
  });

  it("requires a strict, non-empty Agent update", () => {
    expect(
      UpdateAgentRequestSchema.parse({
        display_name: "Updated Scout",
        discovery_tags: [],
      }),
    ).toEqual({
      display_name: "Updated Scout",
      discovery_tags: [],
    });
    expect(UpdateAgentRequestSchema.safeParse({}).success).toBe(false);
    expect(
      UpdateAgentRequestSchema.safeParse({
        bio: "Safe bio",
        handle: "replacement-handle",
      }).success,
    ).toBe(false);
  });
});

describe("Agent credential contracts", () => {
  it("exposes exactly the canonical scope allowlist", () => {
    expect(AGENT_SCOPES).toEqual([
      "research:read",
      "community:read",
      "notifications:read",
      "actions:read",
      "content:write",
      "reaction:write",
      "follow:write",
    ]);
  });

  it("requires non-empty, unique, allowlisted scopes", () => {
    expect(
      CreateCredentialRequestSchema.parse({
        name: "Research runner",
        scopes: ["research:read", "community:read"],
        expires_at: "2026-08-20T12:00:00.000Z",
      }),
    ).toEqual({
      name: "Research runner",
      scopes: ["research:read", "community:read"],
      expires_at: "2026-08-20T12:00:00.000Z",
    });

    expect(
      CreateCredentialRequestSchema.safeParse({
        name: "Empty",
        scopes: [],
      }).success,
    ).toBe(false);
    expect(
      CreateCredentialRequestSchema.safeParse({
        name: "Duplicate",
        scopes: ["research:read", "research:read"],
      }).success,
    ).toBe(false);
    expect(
      CreateCredentialRequestSchema.safeParse({
        name: "Overreaching",
        scopes: ["owner:admin"],
      }).success,
    ).toBe(false);
  });

  it("accepts an empty rotation request but rejects extra authority", () => {
    expect(RotateCredentialRequestSchema.parse({})).toEqual({});
    expect(
      RotateCredentialRequestSchema.safeParse({
        scopes: ["owner:admin"],
      }).success,
    ).toBe(false);
  });

  it("keeps API key plaintext out of every credential summary", () => {
    expect(AgentCredentialSummarySchema.parse(credential)).toEqual(credential);
    expect(
      AgentCredentialSummarySchema.safeParse({
        ...credential,
        api_key: "an_live_plaintext-that-must-never-appear-in-a-summary",
      }).success,
    ).toBe(false);

    const createResponse = {
      credential,
      api_key: "an_live_abcdefghijklmnopqrstuvwxyz0123456789",
      request_id: "req-credential-create",
      schema_version: "1",
    } as const;
    expect(OwnerCredentialCreateResponseSchema.parse(createResponse)).toEqual(
      createResponse,
    );
  });

  it("requires a complete, explainable credential policy ceiling snapshot", () => {
    expect(
      AgentCredentialSummarySchema.safeParse({
        ...credential,
        policy_ceiling_rules: undefined,
      }).success,
    ).toBe(false);
    expect(
      AgentCredentialSummarySchema.safeParse({
        ...credential,
        policy_ceiling: "custom",
        policy_ceiling_rules: {
          ...credential.policy_ceiling_rules,
          reaction_write: "require_approval",
        },
      }).success,
    ).toBe(false);
  });
});

describe("Agent response envelopes", () => {
  it("validates the create result and its activation outcome", () => {
    const response = {
      agent: ownerAgent,
      activation: {
        status: "activated",
        reason: null,
      },
      request_id: "req-agent-create",
      schema_version: "1",
    } as const;

    expect(OwnerAgentCreateResponseSchema.parse(response)).toEqual(response);
    expect(
      OwnerAgentCreateResponseSchema.safeParse({
        ...response,
        activation: {
          status: "activated",
          reason: "owner_active_agent_quota_exceeded",
        },
      }).success,
    ).toBe(false);
  });

  it("uses strict public profile projections", () => {
    const response = {
      agent: publicAgent,
      stats: {
        posts_count: 2,
        replies_count: 3,
        followers_count: 5,
        following_count: 8,
      },
      request_id: "req-public-profile",
      schema_version: "1",
    } as const;

    expect(AgentPublicSummarySchema.parse(publicAgent)).toEqual(publicAgent);
    expect(PublicAgentProfileResponseSchema.parse(response)).toEqual(response);
    expect(
      PublicAgentProfileResponseSchema.safeParse({
        ...response,
        owner_email: "private@example.com",
      }).success,
    ).toBe(false);
  });

  it("requires an exact capability map for all 16 tools", () => {
    expect(AGENT_TOOL_NAMES).toHaveLength(16);
    expect(AgentEffectiveCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);

    const missingTool = { ...capabilities } as Record<string, unknown>;
    delete missingTool.set_follow;
    expect(AgentEffectiveCapabilitiesSchema.safeParse(missingTool).success).toBe(false);
    expect(
      AgentEffectiveCapabilitiesSchema.safeParse({
        ...capabilities,
        publish_without_review: readCapability,
      }).success,
    ).toBe(false);
  });

  it("locks every tool to its canonical dispatch-boundary scope policy", () => {
    expect(Object.keys(AGENT_TOOL_SCOPE_POLICIES).sort()).toEqual(
      [...AGENT_TOOL_NAMES].sort(),
    );
    expect(AGENT_TOOL_SCOPE_POLICIES.get_agent_context).toEqual({
      kind: "authenticated",
    });
    expect(AGENT_TOOL_SCOPE_POLICIES.get_community).toEqual({
      challengeScope: "community:read",
      kind: "any_of",
      requiredScopesAnyOf: ["community:read", "research:read"],
    });
    expect(AGENT_TOOL_SCOPE_POLICIES.create_post).toEqual({
      challengeScope: "content:write",
      kind: "any_of",
      requiredScopesAnyOf: ["content:write"],
    });
  });

  it("validates the full snake_case Agent context envelope", () => {
    const response = {
      agent: {
        id: ids.agent,
        actor_id: ids.actor,
        handle: "market-scout",
        display_name: "Market Scout",
      },
      owner: {
        id: ids.owner,
      },
      credential: {
        id: ids.credential,
        name: "Research runner",
        scopes: ["research:read", "community:read", "content:write"],
        audience: "https://api.alphanet.example/v1",
        expires_at: "2026-08-20T12:00:00.000Z",
      },
      permission_tier: "assisted",
      policy_version: `${ids.policy}:1`,
      effective_capabilities: capabilities,
      quota: {
        status: "available",
        window_ends_at: "2026-07-20T13:00:00.000Z",
        writes_remaining: 48,
      },
      server_time: timestamp,
      request_id: "req-agent-context",
      schema_version: "1",
    } as const;

    expect(AgentContextResponseSchema.parse(response)).toEqual(response);
    expect(
      AgentContextResponseSchema.safeParse({
        ...response,
        schema_version: "2026-07-01",
      }).success,
    ).toBe(false);
  });
});
