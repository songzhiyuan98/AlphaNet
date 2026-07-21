import { describe, expect, it } from "vitest";

import {
  AGENT_POLICY_DEFAULTS_VERSION,
  AGENT_OPERATIONS,
  AGENT_POLICY_SCHEMA_VERSION,
  evaluateAgentOperation,
  materializeAgentPolicyRules,
  normalizeAgentPolicyRules,
  policyHasAutonomousContentWrites,
  type AgentOperation,
} from "./agent-policy.js";
import type { AgentScope } from "./agent-connection.js";

const supportedPolicyArguments = {
  credentialPolicyCeilingDefaultsVersion: AGENT_POLICY_DEFAULTS_VERSION,
  credentialPolicyCeilingRules: { operations: {} },
  credentialPolicyCeilingSchemaVersion: AGENT_POLICY_SCHEMA_VERSION,
  policyDefaultsVersion: AGENT_POLICY_DEFAULTS_VERSION,
  policyRules: { operations: {} },
  policySchemaVersion: AGENT_POLICY_SCHEMA_VERSION,
} as const;

const scopeForOperation: Record<AgentOperation, AgentScope | null> = {
  get_agent_context: null,
  find_communities: "community:read",
  get_community: "community:read",
  browse_content: "research:read",
  search_content: "research:read",
  get_content: "research:read",
  get_discussion: "research:read",
  list_follows: "research:read",
  list_notifications: "notifications:read",
  get_action_status: "actions:read",
  create_post: "content:write",
  reply_to_content: "content:write",
  update_content: "content:write",
  delete_content: "content:write",
  set_reaction: "reaction:write",
  set_follow: "follow:write",
};

describe("evaluateAgentOperation", () => {
  it("requires the operation scope before applying Owner policy", () => {
    for (const operation of AGENT_OPERATIONS) {
      const result = evaluateAgentOperation({
        ...supportedPolicyArguments,
        credentialPolicyCeiling: "autonomous",
        operation,
        policyTier: "autonomous",
        scopes: [],
      });

      if (operation === "get_agent_context") {
        expect(result).toMatchObject({
          decision: "allow",
          matchedScope: null,
          scopeSatisfied: true,
        });
      } else {
        expect(result).toMatchObject({
          decision: "deny",
          matchedScope: null,
          reason: "SCOPE_REQUIRED",
          scopeSatisfied: false,
        });
      }
    }
  });

  it("accepts either community directory scope", () => {
    for (const scope of ["community:read", "research:read"] as const) {
      expect(
        evaluateAgentOperation({
          ...supportedPolicyArguments,
          credentialPolicyCeiling: "assisted",
          operation: "find_communities",
          policyTier: "assisted",
          scopes: [scope],
        }),
      ).toMatchObject({
        decision: "allow",
        matchedScope: scope,
        scopeSatisfied: true,
      });
    }
  });

  it("implements the locked default tier decisions", () => {
    for (const operation of AGENT_OPERATIONS) {
      const scope = scopeForOperation[operation];
      const scopes = scope ? [scope] : [];
      const assisted = evaluateAgentOperation({
        ...supportedPolicyArguments,
        credentialPolicyCeiling: "autonomous",
        operation,
        policyTier: "assisted",
        scopes,
      });
      const autonomous = evaluateAgentOperation({
        ...supportedPolicyArguments,
        credentialPolicyCeiling: "autonomous",
        operation,
        policyTier: "autonomous",
        scopes,
      });
      const readOnly = evaluateAgentOperation({
        ...supportedPolicyArguments,
        credentialPolicyCeiling: "read_only",
        operation,
        policyTier: "autonomous",
        scopes,
      });

      if (
        ["create_post", "reply_to_content", "update_content", "delete_content"].includes(
          operation,
        )
      ) {
        expect(assisted.decision).toBe("require_approval");
        expect(autonomous.decision).toBe("allow");
        expect(readOnly.decision).toBe("deny");
      } else if (["set_reaction", "set_follow"].includes(operation)) {
        expect(assisted.decision).toBe("allow");
        expect(autonomous.decision).toBe("allow");
        expect(readOnly.decision).toBe("deny");
      } else {
        expect(assisted.decision).toBe("allow");
        expect(autonomous.decision).toBe("allow");
        expect(readOnly.decision).toBe("allow");
      }
    }
  });

  it("uses the stricter policy ceiling and fails closed for unprojected Custom rules", () => {
    expect(
      evaluateAgentOperation({
        ...supportedPolicyArguments,
        credentialPolicyCeiling: "assisted",
        operation: "create_post",
        policyTier: "autonomous",
        scopes: ["content:write"],
      }),
    ).toMatchObject({
      decision: "require_approval",
      reason: "OWNER_APPROVAL_REQUIRED",
    });

    expect(
      evaluateAgentOperation({
        ...supportedPolicyArguments,
        credentialPolicyCeiling: "custom",
        credentialPolicyCeilingRules: null,
        operation: "get_content",
        policyTier: "autonomous",
        scopes: ["research:read"],
      }),
    ).toMatchObject({
      decision: "deny",
      reason: "POLICY_RULES_UNAVAILABLE",
      scopeSatisfied: true,
    });
  });

  it("materializes Custom overrides over Assisted defaults", () => {
    const rules = normalizeAgentPolicyRules("custom", {
      operations: {
        browse: "deny",
        content_write: "allow",
        reaction_write: "deny",
      },
    });

    expect(materializeAgentPolicyRules("custom", rules)).toMatchObject({
      browse: "deny",
      content_read: "allow",
      content_write: "allow",
      reaction_write: "deny",
      reply_write: "require_approval",
    });
    expect(policyHasAutonomousContentWrites("custom", rules)).toBe(true);
  });

  it("rejects approval decisions for read and social operations", () => {
    for (const ruleKey of ["browse", "reaction_write", "follow_write"] as const) {
      expect(() =>
        normalizeAgentPolicyRules("custom", {
          operations: { [ruleKey]: "require_approval" },
        }),
      ).toThrow("Custom Agent policy rules are invalid");
    }
  });

  it("intersects a Custom Owner policy with an immutable Custom credential ceiling", () => {
    expect(
      evaluateAgentOperation({
        ...supportedPolicyArguments,
        credentialPolicyCeiling: "custom",
        credentialPolicyCeilingDefaultsVersion: "agent-permission-defaults-v1",
        credentialPolicyCeilingRules: {
          operations: { content_write: "require_approval" },
        },
        credentialPolicyCeilingSchemaVersion: 1,
        operation: "create_post",
        policyDefaultsVersion: "agent-permission-defaults-v1",
        policyRules: { operations: { content_write: "allow" } },
        policySchemaVersion: 1,
        policyTier: "custom",
        scopes: ["content:write"],
      }),
    ).toMatchObject({
      credentialCeilingDecision: "require_approval",
      decision: "require_approval",
      ownerPolicyDecision: "allow",
      policyRuleSource: "custom_override",
      reason: "OWNER_APPROVAL_REQUIRED",
    });
  });

  it("fails closed when a Custom policy pins an unsupported schema", () => {
    expect(
      evaluateAgentOperation({
        ...supportedPolicyArguments,
        credentialPolicyCeiling: "autonomous",
        operation: "create_post",
        policyDefaultsVersion: "agent-permission-defaults-v1",
        policyRules: { operations: { content_write: "allow" } },
        policySchemaVersion: 2,
        policyTier: "custom",
        scopes: ["content:write"],
      }),
    ).toMatchObject({
      decision: "deny",
      reason: "POLICY_RULES_UNAVAILABLE",
    });

    expect(
      evaluateAgentOperation({
        ...supportedPolicyArguments,
        credentialPolicyCeiling: "autonomous",
        credentialPolicyCeilingDefaultsVersion: "future-defaults",
        operation: "create_post",
        policyTier: "autonomous",
        scopes: ["content:write"],
      }),
    ).toMatchObject({
      decision: "deny",
      reason: "POLICY_RULES_UNAVAILABLE",
    });
  });

  it("fails closed when either metadata projection is absent at runtime", () => {
    expect(
      evaluateAgentOperation({
        ...supportedPolicyArguments,
        credentialPolicyCeiling: "autonomous",
        operation: "create_post",
        policyDefaultsVersion: undefined as unknown as string,
        policyTier: "autonomous",
        scopes: ["content:write"],
      }),
    ).toMatchObject({
      decision: "deny",
      reason: "POLICY_RULES_UNAVAILABLE",
    });

    expect(
      evaluateAgentOperation({
        ...supportedPolicyArguments,
        credentialPolicyCeiling: "autonomous",
        credentialPolicyCeilingSchemaVersion: undefined as unknown as number,
        operation: "create_post",
        policyTier: "autonomous",
        scopes: ["content:write"],
      }),
    ).toMatchObject({
      decision: "deny",
      reason: "POLICY_RULES_UNAVAILABLE",
    });
  });
});
