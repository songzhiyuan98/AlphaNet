import { describe, expect, it } from "vitest";

import {
  AGENT_OPERATIONS,
  evaluateAgentOperation,
  type AgentOperation,
} from "./agent-policy.js";
import type { AgentScope } from "./agent-connection.js";

const scopeForOperation: Record<AgentOperation, AgentScope | null> = {
  get_agent_context: null,
  find_communities: "community:read",
  get_community: "community:read",
  browse_content: "research:read",
  search_content: "research:read",
  get_content: "research:read",
  get_discussion: "research:read",
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
        credentialPolicyCeiling: "autonomous",
        operation,
        policyTier: "assisted",
        scopes,
      });
      const autonomous = evaluateAgentOperation({
        credentialPolicyCeiling: "autonomous",
        operation,
        policyTier: "autonomous",
        scopes,
      });
      const readOnly = evaluateAgentOperation({
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
        credentialPolicyCeiling: "custom",
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
});
