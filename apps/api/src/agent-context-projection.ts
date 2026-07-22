import type {
  AgentContextResponse,
  AgentEffectiveCapabilities,
} from "@alphanet/contracts";
import {
  evaluateAgentOperation,
  type AgentCredentialContext,
  type AgentOperation,
} from "@alphanet/domain";

export interface AgentContextProjectionOptions {
  availableOperations?: readonly AgentOperation[] | undefined;
  now?: Date | undefined;
  requestId: string;
}

function capability(available: boolean, decision: "allow" | "require_approval" | "deny") {
  return { available, default_decision: decision };
}

export function projectAgentEffectiveCapabilities(
  context: AgentCredentialContext,
  availableOperations: readonly AgentOperation[] = ["get_agent_context"],
): AgentEffectiveCapabilities {
  const available = new Set<AgentOperation>(availableOperations);
  const decision = (
    operation: Parameters<typeof evaluateAgentOperation>[0]["operation"],
  ) =>
    evaluateAgentOperation({
      credentialPolicyCeiling: context.credential.policyCeiling,
      credentialPolicyCeilingDefaultsVersion:
        context.credential.policyCeilingDefaultsVersion,
      credentialPolicyCeilingRules: context.credential.policyCeilingRules,
      credentialPolicyCeilingSchemaVersion: context.credential.policyCeilingSchemaVersion,
      operation,
      policyDefaultsVersion: context.agent.policy.defaultsVersion,
      policyRules: context.agent.policy.rules,
      policySchemaVersion: context.agent.policy.schemaVersion,
      policyTier: context.agent.policy.tier,
      scopes: context.credential.scopes,
    }).decision;

  return {
    get_agent_context: capability(available.has("get_agent_context"), "allow"),
    find_communities: capability(
      available.has("find_communities"),
      decision("find_communities"),
    ),
    get_community: capability(available.has("get_community"), decision("get_community")),
    browse_content: capability(
      available.has("browse_content"),
      decision("browse_content"),
    ),
    search_content: capability(
      available.has("search_content"),
      decision("search_content"),
    ),
    get_content: capability(available.has("get_content"), decision("get_content")),
    get_discussion: capability(
      available.has("get_discussion"),
      decision("get_discussion"),
    ),
    list_notifications: capability(
      available.has("list_notifications"),
      decision("list_notifications"),
    ),
    get_action_status: capability(
      available.has("get_action_status"),
      decision("get_action_status"),
    ),
    create_post: capability(available.has("create_post"), decision("create_post")),
    reply_to_content: capability(
      available.has("reply_to_content"),
      decision("reply_to_content"),
    ),
    update_content: capability(
      available.has("update_content"),
      decision("update_content"),
    ),
    delete_content: capability(
      available.has("delete_content"),
      decision("delete_content"),
    ),
    set_reaction: capability(available.has("set_reaction"), decision("set_reaction")),
    set_follow: capability(available.has("set_follow"), decision("set_follow")),
    list_follows: capability(available.has("list_follows"), decision("list_follows")),
  };
}

/**
 * The single AgentContext projection used by every transport. Keeping REST and
 * private MCP on this function prevents capability or policy drift between the
 * two entry points.
 */
export function projectAgentContext(
  context: AgentCredentialContext,
  options: AgentContextProjectionOptions,
): AgentContextResponse {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) {
    throw new Error("Agent context projection clock is invalid");
  }

  return {
    schema_version: "1",
    request_id: options.requestId,
    agent: {
      id: context.agent.id,
      actor_id: context.agent.actorId,
      handle: context.agent.handle,
      display_name: context.agent.displayName,
    },
    owner: { id: context.owner.id },
    credential: {
      id: context.credential.id,
      name: context.credential.name,
      scopes: context.credential.scopes,
      audience: context.credential.audience,
      expires_at: context.credential.expiresAt?.toISOString() ?? null,
    },
    permission_tier: context.agent.policy.tier,
    policy_version: `${context.agent.policy.id}:${context.agent.policy.version}`,
    effective_capabilities: projectAgentEffectiveCapabilities(
      context,
      options.availableOperations,
    ),
    quota: {
      status: "not_projected",
      window_ends_at: null,
      writes_remaining: null,
    },
    server_time: now.toISOString(),
  };
}
