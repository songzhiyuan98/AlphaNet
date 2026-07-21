import { z } from "zod";

import {
  AgentPermissionTierSchema,
  AgentPolicyRulesShape,
  AgentPolicySummarySchema,
  OwnerAgentSummarySchema,
  V1EnvelopeShape,
} from "./agent.ts";

export const OWNER_AUTONOMOUS_ACKNOWLEDGEMENT =
  "enable_without_per_action_approval" as const;

/** Partial Owner input. The domain normalizes missing keys from Assisted defaults. */
export const OwnerAgentPolicyRuleOverridesSchema = z
  .object(AgentPolicyRulesShape)
  .partial()
  .strict();
export type OwnerAgentPolicyRuleOverrides = z.infer<
  typeof OwnerAgentPolicyRuleOverridesSchema
>;

const expectedVersionShape = {
  expected_version: z.number().int().positive().safe(),
} as const;

const ownerReadOnlyPolicyUpdateSchema = z
  .object({
    ...expectedVersionShape,
    tier: z.literal("read_only"),
  })
  .strict();

const ownerAssistedPolicyUpdateSchema = z
  .object({
    ...expectedVersionShape,
    tier: z.literal("assisted"),
  })
  .strict();

const ownerAutonomousPolicyUpdateSchema = z
  .object({
    ...expectedVersionShape,
    tier: z.literal("autonomous"),
    autonomous_acknowledgement: z.literal(OWNER_AUTONOMOUS_ACKNOWLEDGEMENT),
  })
  .strict();

const contentWriteRuleNames = [
  "content_write",
  "reply_write",
  "edit_own_content",
  "delete_own_content",
] as const;

const ownerCustomPolicyUpdateSchema = z
  .object({
    ...expectedVersionShape,
    tier: z.literal("custom"),
    rules: OwnerAgentPolicyRuleOverridesSchema,
    autonomous_acknowledgement: z.literal(OWNER_AUTONOMOUS_ACKNOWLEDGEMENT).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const directlyWritesContent = contentWriteRuleNames.some(
      (ruleName) => request.rules[ruleName] === "allow",
    );
    if (
      directlyWritesContent &&
      request.autonomous_acknowledgement !== OWNER_AUTONOMOUS_ACKNOWLEDGEMENT
    ) {
      context.addIssue({
        code: "custom",
        path: ["autonomous_acknowledgement"],
        message: "Direct content writes require the autonomous risk acknowledgement.",
      });
    }
    if (!directlyWritesContent && request.autonomous_acknowledgement !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["autonomous_acknowledgement"],
        message:
          "The autonomous risk acknowledgement is accepted only for direct content writes.",
      });
    }
  });

export const OwnerAgentPolicyUpdateRequestSchema = z.discriminatedUnion("tier", [
  ownerReadOnlyPolicyUpdateSchema,
  ownerAssistedPolicyUpdateSchema,
  ownerAutonomousPolicyUpdateSchema,
  ownerCustomPolicyUpdateSchema,
]);
export type OwnerAgentPolicyUpdateRequest = z.infer<
  typeof OwnerAgentPolicyUpdateRequestSchema
>;

export const AgentPolicyCeilingCountsSchema = z
  .object({
    read_only: z.number().int().nonnegative().safe(),
    assisted: z.number().int().nonnegative().safe(),
    autonomous: z.number().int().nonnegative().safe(),
    custom: z.number().int().nonnegative().safe(),
  })
  .strict();
export type AgentPolicyCeilingCounts = z.infer<typeof AgentPolicyCeilingCountsSchema>;

export const OwnerAgentPolicyCredentialImpactSchema = z
  .object({
    retained_credential_count: z.number().int().nonnegative().safe(),
    ceiling_counts: AgentPolicyCeilingCountsSchema,
    existing_credentials_keep_ceiling: z.literal(true),
  })
  .strict()
  .superRefine((impact, context) => {
    const countedCredentials = AgentPermissionTierSchema.options.reduce(
      (total, tier) => total + impact.ceiling_counts[tier],
      0,
    );
    if (countedCredentials !== impact.retained_credential_count) {
      context.addIssue({
        code: "custom",
        path: ["ceiling_counts"],
        message: "Credential ceiling counts must sum to retained_credential_count.",
      });
    }
  });
export type OwnerAgentPolicyCredentialImpact = z.infer<
  typeof OwnerAgentPolicyCredentialImpactSchema
>;

export const OwnerAgentPolicyUpdateResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    changed: z.boolean(),
    previous_policy: AgentPolicySummarySchema,
    agent: OwnerAgentSummarySchema,
    credential_impact: OwnerAgentPolicyCredentialImpactSchema,
  })
  .strict()
  .superRefine((response, context) => {
    const previous = response.previous_policy;
    const current = response.agent.policy;
    if (response.changed) {
      if (current.version !== previous.version + 1 || current.id === previous.id) {
        context.addIssue({
          code: "custom",
          path: ["agent", "policy"],
          message: "A changed policy must be the next immutable policy version.",
        });
      }
      return;
    }

    if (
      current.id !== previous.id ||
      current.version !== previous.version ||
      current.tier !== previous.tier ||
      current.defaults_version !== previous.defaults_version ||
      current.policy_schema_version !== previous.policy_schema_version ||
      current.effective_from !== previous.effective_from ||
      JSON.stringify(current.rules) !== JSON.stringify(previous.rules)
    ) {
      context.addIssue({
        code: "custom",
        path: ["previous_policy"],
        message: "An unchanged response must identify the current policy.",
      });
    }
  });
export type OwnerAgentPolicyUpdateResponse = z.infer<
  typeof OwnerAgentPolicyUpdateResponseSchema
>;
