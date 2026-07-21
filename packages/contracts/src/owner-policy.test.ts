import { describe, expect, it } from "vitest";

import {
  AgentPolicyRulesSchema,
  type AgentPolicyRules,
  type OwnerAgentSummary,
} from "./agent.ts";
import {
  OWNER_AUTONOMOUS_ACKNOWLEDGEMENT,
  OwnerAgentPolicyUpdateRequestSchema,
  OwnerAgentPolicyUpdateResponseSchema,
} from "./owner-policy.ts";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  agent: "20000000-0000-4000-8000-000000000001",
  currentPolicy: "30000000-0000-4000-8000-000000000001",
  owner: "40000000-0000-4000-8000-000000000001",
  previousPolicy: "50000000-0000-4000-8000-000000000001",
} as const;
const timestamp = "2026-07-21T18:00:00.000Z";

const assistedRules = {
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
} as const satisfies AgentPolicyRules;

const autonomousRules = {
  ...assistedRules,
  content_write: "allow",
  delete_own_content: "allow",
  edit_own_content: "allow",
  reply_write: "allow",
} as const satisfies AgentPolicyRules;

function agent(policyId = ids.currentPolicy, version = 4): OwnerAgentSummary {
  return {
    id: ids.agent,
    actor_id: ids.actor,
    owner_id: ids.owner,
    handle: "market-scout",
    display_name: "Market Scout",
    bio: "Cross-validates market research.",
    discovery_tags: ["semiconductors", "risk"],
    status: "active",
    restriction_reason_code: null,
    policy: {
      id: policyId,
      tier: "autonomous",
      defaults_version: "agent-permission-defaults-v1",
      policy_schema_version: "1",
      version,
      rules: autonomousRules,
      effective_from: timestamp,
    },
    credential_count: 2,
    created_at: timestamp,
    updated_at: timestamp,
    activated_at: timestamp,
    archived_at: null,
  };
}

describe("Owner Agent policy request contracts", () => {
  it("accepts the two standard non-autonomous tiers without extra authority", () => {
    expect(
      OwnerAgentPolicyUpdateRequestSchema.parse({
        expected_version: 3,
        tier: "read_only",
      }),
    ).toEqual({ expected_version: 3, tier: "read_only" });
    expect(
      OwnerAgentPolicyUpdateRequestSchema.parse({
        expected_version: 3,
        tier: "assisted",
      }),
    ).toEqual({ expected_version: 3, tier: "assisted" });

    expect(
      OwnerAgentPolicyUpdateRequestSchema.safeParse({
        expected_version: 3,
        tier: "assisted",
        rules: {},
      }).success,
    ).toBe(false);
  });

  it("requires the exact acknowledgement for Autonomous", () => {
    const request = {
      expected_version: 3,
      tier: "autonomous",
      autonomous_acknowledgement: OWNER_AUTONOMOUS_ACKNOWLEDGEMENT,
    } as const;
    expect(OwnerAgentPolicyUpdateRequestSchema.parse(request)).toEqual(request);
    expect(
      OwnerAgentPolicyUpdateRequestSchema.safeParse({
        expected_version: 3,
        tier: "autonomous",
      }).success,
    ).toBe(false);
    expect(
      OwnerAgentPolicyUpdateRequestSchema.safeParse({
        ...request,
        autonomous_acknowledgement: "I understand",
      }).success,
    ).toBe(false);
  });

  it("accepts partial Custom overrides and constrains each rule family", () => {
    expect(
      OwnerAgentPolicyUpdateRequestSchema.parse({
        expected_version: 3,
        tier: "custom",
        rules: {
          content_write: "deny",
          reaction_write: "deny",
        },
      }),
    ).toEqual({
      expected_version: 3,
      tier: "custom",
      rules: {
        content_write: "deny",
        reaction_write: "deny",
      },
    });
    expect(
      OwnerAgentPolicyUpdateRequestSchema.safeParse({
        expected_version: 3,
        tier: "custom",
        rules: { browse: "require_approval" },
      }).success,
    ).toBe(false);
    expect(
      OwnerAgentPolicyUpdateRequestSchema.safeParse({
        expected_version: 3,
        tier: "custom",
        rules: { reaction_write: "require_approval" },
      }).success,
    ).toBe(false);
    expect(
      OwnerAgentPolicyUpdateRequestSchema.safeParse({
        expected_version: 3,
        tier: "custom",
        rules: { unknown_operation: "allow" },
      }).success,
    ).toBe(false);
  });

  it("requires the autonomous acknowledgement for Custom direct content writes", () => {
    expect(
      OwnerAgentPolicyUpdateRequestSchema.safeParse({
        expected_version: 3,
        tier: "custom",
        rules: { content_write: "allow" },
      }).success,
    ).toBe(false);
    expect(
      OwnerAgentPolicyUpdateRequestSchema.safeParse({
        expected_version: 3,
        tier: "custom",
        rules: { content_write: "allow" },
        autonomous_acknowledgement: OWNER_AUTONOMOUS_ACKNOWLEDGEMENT,
      }).success,
    ).toBe(true);
    expect(
      OwnerAgentPolicyUpdateRequestSchema.safeParse({
        expected_version: 3,
        tier: "custom",
        rules: { content_write: "deny" },
        autonomous_acknowledgement: OWNER_AUTONOMOUS_ACKNOWLEDGEMENT,
      }).success,
    ).toBe(false);
  });

  it("rejects unsafe versions and identity or server-owned fields", () => {
    expect(
      OwnerAgentPolicyUpdateRequestSchema.safeParse({
        expected_version: Number.MAX_SAFE_INTEGER + 1,
        tier: "assisted",
      }).success,
    ).toBe(false);
    expect(
      OwnerAgentPolicyUpdateRequestSchema.safeParse({
        expected_version: 3,
        tier: "assisted",
        owner_id: ids.owner,
      }).success,
    ).toBe(false);
  });
});

describe("Owner Agent policy response contracts", () => {
  it("requires complete normalized rules", () => {
    expect(AgentPolicyRulesSchema.parse(assistedRules)).toEqual(assistedRules);
    const missingRule: Partial<AgentPolicyRules> = { ...assistedRules };
    delete missingRule.search;
    expect(AgentPolicyRulesSchema.safeParse(missingRule).success).toBe(false);
  });

  it("accepts a changed next-version projection and validated ceiling counts", () => {
    const response = {
      changed: true,
      previous_policy: {
        id: ids.previousPolicy,
        tier: "assisted",
        defaults_version: "agent-permission-defaults-v1",
        policy_schema_version: "1",
        version: 3,
        rules: assistedRules,
        effective_from: timestamp,
      },
      agent: agent(),
      credential_impact: {
        retained_credential_count: 2,
        ceiling_counts: {
          read_only: 0,
          assisted: 2,
          autonomous: 0,
          custom: 0,
        },
        existing_credentials_keep_ceiling: true,
      },
      request_id: "req-policy-update",
      schema_version: "1",
    } as const;

    expect(OwnerAgentPolicyUpdateResponseSchema.parse(response)).toEqual(response);
  });

  it("accepts a canonical no-op and rejects inconsistent response invariants", () => {
    const unchangedAgent = agent(ids.currentPolicy, 4);
    const response = {
      changed: false,
      previous_policy: unchangedAgent.policy,
      agent: unchangedAgent,
      credential_impact: {
        retained_credential_count: 1,
        ceiling_counts: {
          read_only: 0,
          assisted: 1,
          autonomous: 0,
          custom: 0,
        },
        existing_credentials_keep_ceiling: true,
      },
      request_id: "req-policy-no-op",
      schema_version: "1",
    } as const;
    expect(OwnerAgentPolicyUpdateResponseSchema.safeParse(response).success).toBe(true);
    expect(
      OwnerAgentPolicyUpdateResponseSchema.safeParse({
        ...response,
        credential_impact: {
          ...response.credential_impact,
          retained_credential_count: 2,
        },
      }).success,
    ).toBe(false);
    expect(
      OwnerAgentPolicyUpdateResponseSchema.safeParse({
        ...response,
        previous_policy: { ...response.previous_policy, version: 3 },
      }).success,
    ).toBe(false);
    expect(
      OwnerAgentPolicyUpdateResponseSchema.safeParse({
        ...response,
        previous_policy: {
          ...response.previous_policy,
          rules: { ...response.previous_policy.rules, reaction_write: "deny" },
        },
      }).success,
    ).toBe(false);
  });
});
