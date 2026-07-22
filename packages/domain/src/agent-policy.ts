import type { AgentPolicyTier, AgentScope } from "./agent-connection.js";

export const AGENT_OPERATIONS = [
  "get_agent_context",
  "find_communities",
  "get_community",
  "browse_content",
  "search_content",
  "get_content",
  "get_discussion",
  "list_follows",
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
export const AGENT_POLICY_RULE_KEYS = [
  "browse",
  "content_read",
  "notification_read",
  "search",
  "reaction_write",
  "follow_write",
  "content_write",
  "reply_write",
  "edit_own_content",
  "delete_own_content",
] as const;
export type AgentPolicyRuleKey = (typeof AGENT_POLICY_RULE_KEYS)[number];
export interface AgentPolicyRules {
  operations: Partial<Record<AgentPolicyRuleKey, AgentPolicyDecision>>;
}
export type AgentPolicyReason =
  | "ALLOWED_BY_POLICY"
  | "OWNER_APPROVAL_REQUIRED"
  | "POLICY_DENIED"
  | "POLICY_RULES_UNAVAILABLE"
  | "SCOPE_REQUIRED";

export interface AgentOperationEvaluation {
  credentialCeilingDecision: AgentPolicyDecision;
  decision: AgentPolicyDecision;
  matchedScope: AgentScope | null;
  ownerPolicyDecision: AgentPolicyDecision;
  policyRuleSource: "custom_override" | "assisted_inheritance" | "tier_default";
  reason: AgentPolicyReason;
  requiredScopes: readonly AgentScope[];
  scopeSatisfied: boolean;
}

// Keep the canonical challenge scope aligned with the public Agent/MCP
// contract while still accepting either read scope.
const communityReadScopes = ["community:read", "research:read"] as const;
const operationScopes: Record<AgentOperation, readonly AgentScope[]> = {
  get_agent_context: [],
  find_communities: communityReadScopes,
  get_community: communityReadScopes,
  browse_content: ["research:read"],
  search_content: ["research:read"],
  get_content: ["research:read"],
  get_discussion: ["research:read"],
  list_follows: ["research:read"],
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

const policyRuleKeySet = new Set<string>(AGENT_POLICY_RULE_KEYS);
const readRuleKeys = new Set<AgentPolicyRuleKey>([
  "browse",
  "content_read",
  "notification_read",
  "search",
]);
const contentWriteRuleKeys = new Set<AgentPolicyRuleKey>([
  "content_write",
  "reply_write",
  "edit_own_content",
  "delete_own_content",
]);
const socialWriteRuleKeys = new Set<AgentPolicyRuleKey>([
  "reaction_write",
  "follow_write",
]);
const decisions = new Set<AgentPolicyDecision>(["allow", "require_approval", "deny"]);

export const AGENT_POLICY_DEFAULTS_VERSION = "agent-permission-defaults-v1";
export const AGENT_POLICY_SCHEMA_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decisionIsValidForOperation(
  operation: AgentPolicyRuleKey,
  decision: AgentPolicyDecision,
): boolean {
  if (contentWriteRuleKeys.has(operation)) return true;
  if (readRuleKeys.has(operation) || socialWriteRuleKeys.has(operation)) {
    return decision === "allow" || decision === "deny";
  }
  return false;
}

/**
 * Parses the only Custom policy document supported by schema v1. Missing
 * operation entries inherit Assisted. Unknown keys and unsupported approval
 * paths fail closed instead of being silently ignored.
 */
export function parseAgentPolicyRules(value: unknown): AgentPolicyRules | null {
  if (!isRecord(value)) return null;
  const topLevelKeys = Object.keys(value);
  if (topLevelKeys.some((key) => key !== "operations")) return null;
  const rawOperations = value.operations ?? {};
  if (!isRecord(rawOperations)) return null;

  const operations: AgentPolicyRules["operations"] = {};
  for (const ruleKey of AGENT_POLICY_RULE_KEYS) {
    if (!Object.hasOwn(rawOperations, ruleKey)) continue;
    const decision = rawOperations[ruleKey];
    if (
      typeof decision !== "string" ||
      !decisions.has(decision as AgentPolicyDecision) ||
      !decisionIsValidForOperation(ruleKey, decision as AgentPolicyDecision)
    ) {
      return null;
    }
    operations[ruleKey] = decision as AgentPolicyDecision;
  }
  if (Object.keys(rawOperations).some((key) => !policyRuleKeySet.has(key))) {
    return null;
  }
  return { operations };
}

export function normalizeAgentPolicyRules(
  tier: AgentPolicyTier,
  value: unknown,
): AgentPolicyRules {
  if (tier !== "custom") {
    if (
      value !== undefined &&
      value !== null &&
      (!isRecord(value) || Object.keys(value).length !== 0)
    ) {
      throw new Error("Standard Agent policy tiers do not accept custom rules.");
    }
    return { operations: {} };
  }
  const parsed = parseAgentPolicyRules(value);
  if (!parsed) {
    throw new Error("The Custom Agent policy rules are invalid.");
  }
  return parsed;
}

export function agentPolicyRulesForStorage(
  tier: AgentPolicyTier,
  rules: AgentPolicyRules,
): Partial<Record<AgentPolicyRuleKey, AgentPolicyDecision>> {
  return tier === "custom" ? { ...rules.operations } : {};
}

const assistedRules = {
  browse: "allow",
  content_read: "allow",
  notification_read: "allow",
  search: "allow",
  reaction_write: "allow",
  follow_write: "allow",
  content_write: "require_approval",
  reply_write: "require_approval",
  edit_own_content: "require_approval",
  delete_own_content: "require_approval",
} as const satisfies Record<AgentPolicyRuleKey, AgentPolicyDecision>;

function ruleKeyForOperation(operation: AgentOperation): AgentPolicyRuleKey | null {
  switch (operation) {
    case "get_agent_context":
      return null;
    case "find_communities":
    case "get_community":
    case "browse_content":
    case "list_follows":
      return "browse";
    case "search_content":
      return "search";
    case "get_content":
    case "get_discussion":
      return "content_read";
    case "list_notifications":
    case "get_action_status":
      return "notification_read";
    case "create_post":
      return "content_write";
    case "reply_to_content":
      return "reply_write";
    case "update_content":
      return "edit_own_content";
    case "delete_content":
      return "delete_own_content";
    case "set_reaction":
      return "reaction_write";
    case "set_follow":
      return "follow_write";
  }
}

export function materializeAgentPolicyRules(
  tier: AgentPolicyTier,
  rules: AgentPolicyRules,
): Record<AgentPolicyRuleKey, AgentPolicyDecision> {
  const resolved = { ...assistedRules } as Record<
    AgentPolicyRuleKey,
    AgentPolicyDecision
  >;
  if (tier === "read_only") {
    for (const key of [...contentWriteRuleKeys, ...socialWriteRuleKeys]) {
      resolved[key] = "deny";
    }
  } else if (tier === "autonomous") {
    for (const key of contentWriteRuleKeys) resolved[key] = "allow";
  } else if (tier === "custom") {
    Object.assign(resolved, rules.operations);
  }
  return resolved;
}

/** Parses the compact flat JSONB representation stored in PostgreSQL. */
export function parsePersistedAgentPolicyRules(
  tier: AgentPolicyTier,
  value: unknown,
): AgentPolicyRules | null {
  if (!isRecord(value)) return null;
  if (tier !== "custom") {
    // 000004 Agent creation materialized the Assisted defaults, while several
    // published fixtures used an empty object. Both are equivalent because
    // standard tiers are evaluated from their pinned defaults version.
    return { operations: {} };
  }
  return parseAgentPolicyRules({ operations: value });
}

export function policyHasAutonomousContentWrites(
  tier: AgentPolicyTier,
  rules: AgentPolicyRules,
): boolean {
  if (tier === "autonomous") return true;
  if (tier !== "custom") return false;
  return [...contentWriteRuleKeys].some(
    (ruleKey) => rules.operations[ruleKey] === "allow",
  );
}

function tierDecision(
  tier: Exclude<AgentPolicyTier, "custom">,
  operation: AgentOperation,
): AgentPolicyDecision {
  if (
    tier === "read_only" &&
    (contentWriteOperations.has(operation) || socialWriteOperations.has(operation))
  ) {
    return "deny";
  }
  if (tier === "assisted" && contentWriteOperations.has(operation)) {
    return "require_approval";
  }
  return "allow";
}

function strictestDecision(
  left: AgentPolicyDecision,
  right: AgentPolicyDecision,
): AgentPolicyDecision {
  const rank: Record<AgentPolicyDecision, number> = {
    allow: 0,
    require_approval: 1,
    deny: 2,
  };
  return rank[left] >= rank[right] ? left : right;
}

function customDecision(
  operation: AgentOperation,
  rules: unknown,
): {
  decision: AgentPolicyDecision;
  source: AgentOperationEvaluation["policyRuleSource"];
} | null {
  const parsed =
    parseAgentPolicyRules(rules) ?? parsePersistedAgentPolicyRules("custom", rules);
  if (!parsed) return null;
  const ruleKey = ruleKeyForOperation(operation);
  if (ruleKey === null) {
    return { decision: "allow", source: "tier_default" };
  }
  return {
    decision: parsed.operations[ruleKey] ?? tierDecision("assisted", operation),
    source: Object.hasOwn(parsed.operations, ruleKey)
      ? "custom_override"
      : "assisted_inheritance",
  };
}

export function evaluateAgentOperation(options: {
  credentialPolicyCeiling: AgentPolicyTier;
  credentialPolicyCeilingDefaultsVersion: string;
  credentialPolicyCeilingRules: unknown;
  credentialPolicyCeilingSchemaVersion: number;
  operation: AgentOperation;
  policyDefaultsVersion: string;
  policyRules: unknown;
  policySchemaVersion: number;
  policyTier: AgentPolicyTier;
  scopes: readonly AgentScope[];
}): AgentOperationEvaluation {
  const requiredScopes = operationScopes[options.operation];
  const matchedScope =
    requiredScopes.find((scope) => options.scopes.includes(scope)) ?? null;
  const scopeSatisfied = requiredScopes.length === 0 || matchedScope !== null;
  if (!scopeSatisfied) {
    return {
      credentialCeilingDecision: "deny",
      decision: "deny",
      matchedScope,
      ownerPolicyDecision: "deny",
      policyRuleSource: "tier_default",
      reason: "SCOPE_REQUIRED",
      requiredScopes,
      scopeSatisfied,
    };
  }

  const policyMetadataSupported =
    options.policyDefaultsVersion === AGENT_POLICY_DEFAULTS_VERSION &&
    options.policySchemaVersion === AGENT_POLICY_SCHEMA_VERSION;
  const ownerPolicy = !policyMetadataSupported
    ? null
    : options.policyTier === "custom"
      ? customDecision(options.operation, options.policyRules)
      : {
          decision: tierDecision(options.policyTier, options.operation),
          source: "tier_default" as const,
        };
  const ceilingMetadataSupported =
    options.credentialPolicyCeilingDefaultsVersion === AGENT_POLICY_DEFAULTS_VERSION &&
    options.credentialPolicyCeilingSchemaVersion === AGENT_POLICY_SCHEMA_VERSION;
  const credentialCeiling = !ceilingMetadataSupported
    ? null
    : options.credentialPolicyCeiling === "custom"
      ? customDecision(options.operation, options.credentialPolicyCeilingRules)
      : {
          decision: tierDecision(options.credentialPolicyCeiling, options.operation),
          source: "tier_default" as const,
        };

  if (!ownerPolicy || !credentialCeiling) {
    return {
      credentialCeilingDecision: credentialCeiling?.decision ?? "deny",
      decision: "deny",
      matchedScope,
      ownerPolicyDecision: ownerPolicy?.decision ?? "deny",
      policyRuleSource: ownerPolicy?.source ?? "tier_default",
      reason: "POLICY_RULES_UNAVAILABLE",
      requiredScopes,
      scopeSatisfied,
    };
  }

  const decision = strictestDecision(ownerPolicy.decision, credentialCeiling.decision);
  if (decision === "deny") {
    return {
      credentialCeilingDecision: credentialCeiling.decision,
      decision: "deny",
      matchedScope,
      ownerPolicyDecision: ownerPolicy.decision,
      policyRuleSource: ownerPolicy.source,
      reason: "POLICY_DENIED",
      requiredScopes,
      scopeSatisfied,
    };
  }

  if (decision === "require_approval") {
    return {
      credentialCeilingDecision: credentialCeiling.decision,
      decision: "require_approval",
      matchedScope,
      ownerPolicyDecision: ownerPolicy.decision,
      policyRuleSource: ownerPolicy.source,
      reason: "OWNER_APPROVAL_REQUIRED",
      requiredScopes,
      scopeSatisfied,
    };
  }

  return {
    credentialCeilingDecision: credentialCeiling.decision,
    decision: "allow",
    matchedScope,
    ownerPolicyDecision: ownerPolicy.decision,
    policyRuleSource: ownerPolicy.source,
    reason: "ALLOWED_BY_POLICY",
    requiredScopes,
    scopeSatisfied,
  };
}
