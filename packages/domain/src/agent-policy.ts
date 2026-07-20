import type { AgentPolicyTier, AgentScope } from "./agent-connection.js";

export const AGENT_OPERATIONS = [
  "get_agent_context",
  "find_communities",
  "get_community",
  "browse_content",
  "search_content",
  "get_content",
  "get_discussion",
  "list_notifications",
  "get_action_status",
  "create_post",
  "reply_to_content",
  "update_content",
  "delete_content",
  "set_reaction",
  "set_follow",
] as const;

export type AgentOperation = (typeof AGENT_OPERATIONS)[number];
export type AgentPolicyDecision = "allow" | "require_approval" | "deny";
export type AgentPolicyReason =
  | "ALLOWED_BY_POLICY"
  | "OWNER_APPROVAL_REQUIRED"
  | "POLICY_DENIED"
  | "POLICY_RULES_UNAVAILABLE"
  | "SCOPE_REQUIRED";

export interface AgentOperationEvaluation {
  decision: AgentPolicyDecision;
  matchedScope: AgentScope | null;
  reason: AgentPolicyReason;
  requiredScopes: readonly AgentScope[];
  scopeSatisfied: boolean;
}

const communityReadScopes = ["research:read", "community:read"] as const;
const operationScopes: Record<AgentOperation, readonly AgentScope[]> = {
  get_agent_context: [],
  find_communities: communityReadScopes,
  get_community: communityReadScopes,
  browse_content: ["research:read"],
  search_content: ["research:read"],
  get_content: ["research:read"],
  get_discussion: ["research:read"],
  list_notifications: ["notifications:read"],
  get_action_status: ["actions:read"],
  create_post: ["content:write"],
  reply_to_content: ["content:write"],
  update_content: ["content:write"],
  delete_content: ["content:write"],
  set_reaction: ["reaction:write"],
  set_follow: ["follow:write"],
};

const contentWriteOperations = new Set<AgentOperation>([
  "create_post",
  "reply_to_content",
  "update_content",
  "delete_content",
]);
const socialWriteOperations = new Set<AgentOperation>(["set_reaction", "set_follow"]);

function effectivePolicyTier(
  current: AgentPolicyTier,
  credentialCeiling: AgentPolicyTier,
): AgentPolicyTier {
  if (current === "read_only" || credentialCeiling === "read_only") {
    return "read_only";
  }
  if (current === "custom" || credentialCeiling === "custom") {
    return "custom";
  }
  if (current === "assisted" || credentialCeiling === "assisted") {
    return "assisted";
  }
  return "autonomous";
}

export function evaluateAgentOperation(options: {
  credentialPolicyCeiling: AgentPolicyTier;
  operation: AgentOperation;
  policyTier: AgentPolicyTier;
  scopes: readonly AgentScope[];
}): AgentOperationEvaluation {
  const requiredScopes = operationScopes[options.operation];
  const matchedScope =
    requiredScopes.find((scope) => options.scopes.includes(scope)) ?? null;
  const scopeSatisfied = requiredScopes.length === 0 || matchedScope !== null;
  if (!scopeSatisfied) {
    return {
      decision: "deny",
      matchedScope,
      reason: "SCOPE_REQUIRED",
      requiredScopes,
      scopeSatisfied,
    };
  }

  const tier = effectivePolicyTier(options.policyTier, options.credentialPolicyCeiling);
  if (tier === "custom") {
    // Custom rules are immutable policy data and must be projected into the
    // authorization snapshot before they can be evaluated. An absent rule
    // document is never interpreted as Autonomous.
    return {
      decision: "deny",
      matchedScope,
      reason: "POLICY_RULES_UNAVAILABLE",
      requiredScopes,
      scopeSatisfied,
    };
  }

  if (
    tier === "read_only" &&
    (contentWriteOperations.has(options.operation) ||
      socialWriteOperations.has(options.operation))
  ) {
    return {
      decision: "deny",
      matchedScope,
      reason: "POLICY_DENIED",
      requiredScopes,
      scopeSatisfied,
    };
  }

  if (tier === "assisted" && contentWriteOperations.has(options.operation)) {
    return {
      decision: "require_approval",
      matchedScope,
      reason: "OWNER_APPROVAL_REQUIRED",
      requiredScopes,
      scopeSatisfied,
    };
  }

  return {
    decision: "allow",
    matchedScope,
    reason: "ALLOWED_BY_POLICY",
    requiredScopes,
    scopeSatisfied,
  };
}
