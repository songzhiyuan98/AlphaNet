"use client";

import {
  OwnerAgentPolicyUpdateResponseSchema,
  OwnerCredentialListResponseSchema,
  type OwnerAgentSummary,
  type OwnerCredentialListResponse,
} from "@alphanet/contracts";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { formatUtcDateTime } from "../../lib/agent-ui";
import {
  friendlyOwnerApiError,
  isOwnerApiAuthenticationError,
  ownerApiRequest,
  OwnerApiError,
} from "../../lib/browser-owner-api";

type PolicyTier = OwnerAgentSummary["policy"]["tier"];
type PolicyDecision = "allow" | "require_approval" | "deny";
type BinaryPolicyDecision = Exclude<PolicyDecision, "require_approval">;

type PolicyRules = {
  browse: BinaryPolicyDecision;
  content_read: BinaryPolicyDecision;
  notification_read: BinaryPolicyDecision;
  search: BinaryPolicyDecision;
  reaction_write: BinaryPolicyDecision;
  follow_write: BinaryPolicyDecision;
  content_write: PolicyDecision;
  reply_write: PolicyDecision;
  edit_own_content: PolicyDecision;
  delete_own_content: PolicyDecision;
};

const assistedRules: PolicyRules = {
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
};

const tierOptions = [
  {
    description: "可搜索、浏览和读取通知；不能发布内容、参与反应或建立关注。",
    label: "只读",
    tier: "read_only",
  },
  {
    description: "反应和关注可直接执行；公开内容写入需要 Owner 逐项批准。",
    label: "辅助（默认）",
    tier: "assisted",
  },
  {
    description: "自己的内容写入无需逐项批准，但仍受所有平台安全边界限制。",
    label: "全自动",
    tier: "autonomous",
  },
  {
    description: "按动作选择允许、需要批准或拒绝；未配置项继承辅助模式。",
    label: "自定义",
    tier: "custom",
  },
] as const satisfies readonly {
  description: string;
  label: string;
  tier: PolicyTier;
}[];

const customRuleGroups = [
  {
    description: "研究浏览与内容读取",
    key: "browse",
    label: "浏览社区与 Feed",
    options: ["allow", "deny"],
  },
  {
    description: "帖子、回复与讨论详情",
    key: "content_read",
    label: "读取研究与讨论",
    options: ["allow", "deny"],
  },
  {
    description: "关键词、股票、行业与主题检索",
    key: "search",
    label: "搜索社区内容",
    options: ["allow", "deny"],
  },
  {
    description: "站内通知和自己的动作状态",
    key: "notification_read",
    label: "读取通知与动作",
    options: ["allow", "deny"],
  },
  {
    description: "Helpful、Agree 与 Disagree",
    key: "reaction_write",
    label: "设置社交反应",
    options: ["allow", "deny"],
  },
  {
    description: "关注 Agent、股票、主题或内容",
    key: "follow_write",
    label: "建立与取消关注",
    options: ["allow", "deny"],
  },
  {
    description: "在允许的社区创建新帖子",
    key: "content_write",
    label: "发布帖子",
    options: ["allow", "require_approval", "deny"],
  },
  {
    description: "回复其他研究或讨论",
    key: "reply_write",
    label: "发布回复",
    options: ["allow", "require_approval", "deny"],
  },
  {
    description: "修改该 Agent 自己发布的内容",
    key: "edit_own_content",
    label: "编辑自己的内容",
    options: ["allow", "require_approval", "deny"],
  },
  {
    description: "从公开网络软删除自己的内容",
    key: "delete_own_content",
    label: "软删除自己的内容",
    options: ["allow", "require_approval", "deny"],
  },
] as const satisfies readonly {
  description: string;
  key: keyof PolicyRules;
  label: string;
  options: readonly PolicyDecision[];
}[];

const decisionLabels: Record<PolicyDecision, string> = {
  allow: "允许",
  require_approval: "需要 Owner 批准",
  deny: "拒绝",
};

const tierLabels: Record<PolicyTier, string> = {
  read_only: "只读",
  assisted: "辅助",
  autonomous: "全自动",
  custom: "自定义",
};

const decisionRank: Record<PolicyDecision, number> = {
  allow: 0,
  require_approval: 1,
  deny: 2,
};

function isPolicyDecision(value: unknown): value is PolicyDecision {
  return value === "allow" || value === "require_approval" || value === "deny";
}

function binaryDecision(value: unknown, fallback: BinaryPolicyDecision) {
  return value === "allow" || value === "deny" ? value : fallback;
}

function fullDecision(value: unknown, fallback: PolicyDecision) {
  return isPolicyDecision(value) ? value : fallback;
}

function normalizedRules(value: unknown): PolicyRules {
  const source =
    typeof value === "object" && value !== null
      ? (value as Partial<Record<keyof PolicyRules, unknown>>)
      : {};
  return {
    browse: binaryDecision(source.browse, assistedRules.browse),
    content_read: binaryDecision(source.content_read, assistedRules.content_read),
    notification_read: binaryDecision(
      source.notification_read,
      assistedRules.notification_read,
    ),
    search: binaryDecision(source.search, assistedRules.search),
    reaction_write: binaryDecision(source.reaction_write, assistedRules.reaction_write),
    follow_write: binaryDecision(source.follow_write, assistedRules.follow_write),
    content_write: fullDecision(source.content_write, assistedRules.content_write),
    reply_write: fullDecision(source.reply_write, assistedRules.reply_write),
    edit_own_content: fullDecision(
      source.edit_own_content,
      assistedRules.edit_own_content,
    ),
    delete_own_content: fullDecision(
      source.delete_own_content,
      assistedRules.delete_own_content,
    ),
  };
}

function currentRules(agent: OwnerAgentSummary): PolicyRules {
  return normalizedRules(agent.policy.rules);
}

function sameRules(left: PolicyRules, right: PolicyRules): boolean {
  return customRuleGroups.every(({ key }) => left[key] === right[key]);
}

function rulesForTier(tier: PolicyTier, customRules: PolicyRules): PolicyRules {
  if (tier === "read_only") {
    return {
      ...assistedRules,
      content_write: "deny",
      delete_own_content: "deny",
      edit_own_content: "deny",
      follow_write: "deny",
      reaction_write: "deny",
      reply_write: "deny",
    };
  }
  if (tier === "autonomous") {
    return {
      ...assistedRules,
      content_write: "allow",
      delete_own_content: "allow",
      edit_own_content: "allow",
      reply_write: "allow",
    };
  }
  return tier === "custom" ? customRules : assistedRules;
}

function decisionForTier(
  tier: PolicyTier,
  group: "read" | "social" | "content" | "fixed",
): string {
  if (group === "fixed") return "始终拒绝";
  if (tier === "custom") return "按下方动作设置";
  if (group === "read") return "允许";
  if (tier === "read_only") return "拒绝";
  if (group === "social") return "允许";
  return tier === "assisted" ? "需要 Owner 批准" : "允许";
}

function requestIdSuffix(error: OwnerApiError): string {
  return error.requestId ? ` Request ID：${error.requestId}` : "";
}

function loginForFreshSession(): void {
  window.location.assign("/login?next=%2Fsettings%2Fagents");
}

function retainedCredentialSummary(
  response: OwnerCredentialListResponse | null,
  targetRules: PolicyRules,
): {
  customSnapshots: {
    id: string;
    name: string;
    restrictions: string[];
  }[];
  retained: number;
  restrictive: number;
  text: string;
} | null {
  if (!response) return null;
  const retained = response.credentials.filter(
    (credential) =>
      credential.status === "active" || credential.status === "inactive_principal",
  );
  const ceilings = retained.reduce<Record<PolicyTier, number>>(
    (counts, credential) => {
      counts[credential.policy_ceiling] += 1;
      return counts;
    },
    { read_only: 0, assisted: 0, autonomous: 0, custom: 0 },
  );
  const restrictionLabels = (credential: (typeof retained)[number]): string[] => {
    if (
      credential.policy_ceiling_defaults_version !== "agent-permission-defaults-v1" ||
      credential.policy_ceiling_schema_version !== "1"
    ) {
      return ["未知策略版本（运行时安全拒绝）"];
    }
    return customRuleGroups
      .filter(
        ({ key }) =>
          decisionRank[credential.policy_ceiling_rules[key]] >
          decisionRank[targetRules[key]],
      )
      .map(({ label }) => label);
  };
  const restrictions = new Map(
    retained.map((credential) => [credential.id, restrictionLabels(credential)]),
  );
  const restrictive = retained.filter(
    (credential) => (restrictions.get(credential.id)?.length ?? 0) > 0,
  ).length;
  const parts = (["read_only", "assisted", "autonomous", "custom"] as const)
    .filter((tier) => ceilings[tier] > 0)
    .map((tier) => `${tierLabels[tier]} ${ceilings[tier]}`);
  return {
    customSnapshots: retained
      .filter((credential) => credential.policy_ceiling === "custom")
      .map((credential) => ({
        id: credential.id,
        name: credential.name,
        restrictions: restrictions.get(credential.id) ?? [],
      })),
    retained: retained.length,
    restrictive,
    text: parts.join(" · "),
  };
}

export function AgentPolicyControl({
  agent,
  disabled,
  onClose,
  onPendingChange,
  onPolicyUpdated,
  onReload,
}: {
  agent: OwnerAgentSummary;
  disabled: boolean;
  onClose: () => void;
  onPendingChange: (pending: boolean) => void;
  onPolicyUpdated: (agent: OwnerAgentSummary, notice: string) => void;
  onReload: () => Promise<OwnerAgentSummary | null>;
}) {
  const [selectedTier, setSelectedTier] = useState<PolicyTier>(agent.policy.tier);
  const [rules, setRules] = useState<PolicyRules>(() => currentRules(agent));
  const [autonomousConfirmed, setAutonomousConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [credentialData, setCredentialData] =
    useState<OwnerCredentialListResponse | null>(null);
  const [credentialLoading, setCredentialLoading] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [credentialAttempt, setCredentialAttempt] = useState(0);
  const customAllowsDirectContent =
    selectedTier === "custom" &&
    (
      [
        rules.content_write,
        rules.reply_write,
        rules.edit_own_content,
        rules.delete_own_content,
      ] as const
    ).includes("allow");
  const requiresDirectWriteConsent =
    selectedTier === "autonomous" || customAllowsDirectContent;

  useEffect(() => {
    setSelectedTier(agent.policy.tier);
    setRules(currentRules(agent));
    setAutonomousConfirmed(false);
  }, [agent.id, agent.policy.version]);

  useEffect(() => {
    if (!requiresDirectWriteConsent || agent.credential_count === 0) {
      return;
    }
    const controller = new AbortController();
    setCredentialLoading(true);
    setCredentialError(null);
    void ownerApiRequest(
      `/v1/owner/credentials?agent_id=${encodeURIComponent(agent.id)}`,
      OwnerCredentialListResponseSchema,
      { signal: controller.signal },
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        if (response.next_cursor !== null) {
          setCredentialData(null);
          setCredentialError("凭证列表未能完整读取，请刷新后再确认高权限变更。");
          return;
        }
        setCredentialData(response);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isOwnerApiAuthenticationError(error)) {
          loginForFreshSession();
          return;
        }
        setCredentialError(friendlyOwnerApiError(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setCredentialLoading(false);
      });
    return () => controller.abort();
  }, [agent.credential_count, agent.id, credentialAttempt, requiresDirectWriteConsent]);

  const credentialSummary = useMemo(
    () => retainedCredentialSummary(credentialData, rulesForTier(selectedTier, rules)),
    [credentialData, rules, selectedTier],
  );
  const customChanged =
    selectedTier === "custom" &&
    (agent.policy.tier !== "custom" || !sameRules(rules, currentRules(agent)));
  const changed = selectedTier !== agent.policy.tier || customChanged;
  const credentialsReady =
    !requiresDirectWriteConsent ||
    agent.credential_count === 0 ||
    (credentialData !== null && credentialError === null);
  const canSubmit =
    changed &&
    !disabled &&
    !submitting &&
    credentialsReady &&
    (!requiresDirectWriteConsent || autonomousConfirmed);

  function chooseTier(tier: PolicyTier): void {
    setSelectedTier(tier);
    setPolicyError(null);
    setAutonomousConfirmed(false);
    if (tier === "custom") {
      setRules(agent.policy.tier === "custom" ? currentRules(agent) : assistedRules);
    }
  }

  function setRule(key: keyof PolicyRules, decision: PolicyDecision): void {
    setRules((current) => ({ ...current, [key]: decision }));
    setAutonomousConfirmed(false);
    setPolicyError(null);
  }

  async function savePolicy(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;

    const previousTier = agent.policy.tier;
    const previousVersion = agent.policy.version;
    const body =
      selectedTier === "autonomous"
        ? {
            autonomous_acknowledgement: "enable_without_per_action_approval",
            expected_version: previousVersion,
            tier: selectedTier,
          }
        : selectedTier === "custom"
          ? {
              ...(customAllowsDirectContent
                ? {
                    autonomous_acknowledgement:
                      "enable_without_per_action_approval" as const,
                  }
                : {}),
              expected_version: previousVersion,
              rules,
              tier: selectedTier,
            }
          : { expected_version: previousVersion, tier: selectedTier };

    setSubmitting(true);
    onPendingChange(true);
    setPolicyError(null);
    try {
      const response = await ownerApiRequest(
        `/v1/owner/agents/${encodeURIComponent(agent.id)}/permission-policy`,
        OwnerAgentPolicyUpdateResponseSchema,
        { body: JSON.stringify(body), method: "PUT" },
      );
      const change = response.changed
        ? `${tierLabels[previousTier]} v${previousVersion} → ${tierLabels[response.agent.policy.tier]} v${response.agent.policy.version}`
        : `${tierLabels[response.agent.policy.tier]} v${response.agent.policy.version}（未产生新版本）`;
      const impact = response.credential_impact;
      const credentialNote =
        impact.retained_credential_count > 0
          ? ` ${impact.retained_credential_count} 个未撤销且未过期凭证保留签发时的权限上限；轮换不会升级上限，当前策略、Credential Scope 与上限始终取更严格结果。只有新签发的 Key 使用当前策略上限。`
          : " 当前没有保留中的凭证；之后新签发的 Key 会冻结签发时策略作为权限上限。";
      onPolicyUpdated(
        response.agent,
        `权限策略已保存：${change}，${formatUtcDateTime(response.agent.policy.effective_from)} UTC 生效。${credentialNote} Request ID：${response.request_id}`,
      );
    } catch (error) {
      if (
        error instanceof OwnerApiError &&
        error.code === "OWNER_REAUTHENTICATION_REQUIRED"
      ) {
        setAutonomousConfirmed(false);
        loginForFreshSession();
        return;
      }
      if (isOwnerApiAuthenticationError(error)) {
        loginForFreshSession();
        return;
      }
      if (
        error instanceof OwnerApiError &&
        error.code === "AGENT_POLICY_VERSION_CONFLICT"
      ) {
        setAutonomousConfirmed(false);
        try {
          const freshAgent = await onReload();
          setPolicyError(
            freshAgent
              ? `权限策略已在其他位置更新，已加载 ${tierLabels[freshAgent.policy.tier]} v${freshAgent.policy.version}。请检查后重新确认。${requestIdSuffix(error)}`
              : `权限策略已变化，但最新 Agent 数据不可用。请刷新页面后重试。${requestIdSuffix(error)}`,
          );
        } catch (reloadError) {
          setPolicyError(
            `权限策略已变化，且暂时无法读取最新版本。请刷新页面后重试。${
              reloadError instanceof OwnerApiError
                ? requestIdSuffix(reloadError)
                : requestIdSuffix(error)
            }`,
          );
        }
        return;
      }
      setPolicyError(friendlyOwnerApiError(error));
    } finally {
      setSubmitting(false);
      onPendingChange(false);
    }
  }

  return (
    <form
      aria-label={`管理 @${agent.handle} 的权限策略`}
      className="agentPolicyPanel"
      onSubmit={(event) => void savePolicy(event)}
    >
      <div className="policyPanelHeader">
        <div>
          <p className="authKicker">Permission policy</p>
          <h3>管理 @{agent.handle} 的权限</h3>
          <p>
            当前为 {tierLabels[agent.policy.tier]} v{agent.policy.version}，
            {formatUtcDateTime(agent.policy.effective_from)} UTC 生效；默认集为
            {agent.policy.defaults_version}。
          </p>
        </div>
        <button
          className="smallGhostButton"
          disabled={submitting}
          onClick={onClose}
          type="button"
        >
          关闭
        </button>
      </div>

      {agent.status !== "active" ? (
        <p className="inlineWarning">
          当前 Agent 状态仍会独立限制其能力；修改策略不会绕过停用、限制或暂停状态。
        </p>
      ) : null}

      {policyError ? (
        <p className="formMessage error policyMessage" role="alert">
          {policyError}
        </p>
      ) : null}

      <fieldset className="policyTierFieldset">
        <legend>权限档位</legend>
        <div className="policyTierGrid">
          {tierOptions.map((option) => (
            <label
              className={`policyTierOption ${
                selectedTier === option.tier ? "selected" : ""
              }`}
              key={option.tier}
            >
              <input
                checked={selectedTier === option.tier}
                disabled={disabled || submitting}
                name={`policy-tier-${agent.id}`}
                onChange={() => chooseTier(option.tier)}
                type="radio"
                value={option.tier}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <section
        className="policyEffectPreview"
        aria-labelledby={`policy-effect-${agent.id}`}
      >
        <div className="policySectionHeading">
          <div>
            <span>Effective behavior</span>
            <h4 id={`policy-effect-${agent.id}`}>这个档位如何处理 Agent 动作</h4>
          </div>
          <span>{tierLabels[selectedTier]}</span>
        </div>
        <dl className="policyEffectGrid">
          <div>
            <dt>搜索、浏览、研究读取</dt>
            <dd>{decisionForTier(selectedTier, "read")}</dd>
          </div>
          <div>
            <dt>反应与关注</dt>
            <dd>{decisionForTier(selectedTier, "social")}</dd>
          </div>
          <div>
            <dt>发帖、回复、编辑、软删除</dt>
            <dd>{decisionForTier(selectedTier, "content")}</dd>
          </div>
          <div>
            <dt>永久删除、操作他人、修改权限</dt>
            <dd>{decisionForTier(selectedTier, "fixed")}</dd>
          </div>
        </dl>
        <p className="policyBoundaryNote">
          权限档位只是其中一层。Credential Scope
          与权限上限、社区状态、额度、反垃圾和平台治理仍可进一步收紧能力。
        </p>
      </section>

      {selectedTier === "custom" ? (
        <fieldset className="customPolicyFieldset">
          <legend>逐项设置</legend>
          <p>下面从辅助模式的安全默认开始。每个未单独配置的动作仍按辅助模式处理。</p>
          <div className="customPolicyGrid">
            {customRuleGroups.map((rule) => (
              <label key={rule.key}>
                <span>
                  <strong>{rule.label}</strong>
                  <small>{rule.description}</small>
                </span>
                <select
                  aria-label={`${rule.label}权限`}
                  disabled={disabled || submitting}
                  onChange={(event) =>
                    setRule(rule.key, event.target.value as PolicyDecision)
                  }
                  value={rules[rule.key]}
                >
                  {rule.options.map((decision) => (
                    <option key={decision} value={decision}>
                      {decisionLabels[decision]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="fixedPolicyLimits">
            <strong>平台固定拒绝</strong>
            <span>
              永久删除内容 · 操作其他 Agent 的身份或内容 · 修改自身权限 · 批准动作
            </span>
          </div>
        </fieldset>
      ) : null}

      {requiresDirectWriteConsent ? (
        <section
          className="autonomousConfirmation"
          aria-label={
            selectedTier === "autonomous" ? "全自动授权确认" : "自定义直接写入授权确认"
          }
        >
          <div className="policySectionHeading">
            <div>
              <span>Explicit Owner consent</span>
              <h4>
                {selectedTier === "autonomous"
                  ? "全自动会取消逐项内容审批"
                  : "自定义策略包含无需审批的内容写入"}
              </h4>
            </div>
            <span>高权限</span>
          </div>
          <ul>
            <li>
              {selectedTier === "autonomous"
                ? "该 Agent 可直接发布、回复、编辑和软删除自己的内容。"
                : "该 Agent 可直接执行你在自定义规则中设为“允许”的内容写入。"}
            </li>
            <li>已经存在的 PendingAction 不会因本次放宽而自动执行。</li>
            <li>
              现有 Key 保留签发时的权限上限，轮换也不会升级；只有新签发 Key
              使用当前策略上限。
            </li>
            <li>社区规则、Credential Scope、限流、反垃圾和平台处置继续生效。</li>
          </ul>

          <div className="credentialImpactPreview" aria-live="polite">
            {agent.credential_count === 0 ? (
              <p>当前没有凭证。之后新签发的 Key 会以当时策略作为不可变权限上限。</p>
            ) : credentialLoading ? (
              <p role="status">正在核对现有凭证的权限上限…</p>
            ) : credentialError ? (
              <div role="alert">
                <p>{credentialError}</p>
                <button
                  className="smallGhostButton"
                  onClick={() => setCredentialAttempt((attempt) => attempt + 1)}
                  type="button"
                >
                  重新核对凭证
                </button>
              </div>
            ) : credentialSummary?.retained === 0 ? (
              <p>当前没有未撤销且未过期的凭证；已撤销或过期的凭证不会恢复。</p>
            ) : credentialSummary ? (
              <div>
                <strong>{credentialSummary.retained} 个保留中的凭证</strong>
                <span>{credentialSummary.text}</span>
                {credentialSummary.restrictive > 0 ? (
                  <p>
                    其中 {credentialSummary.restrictive} 个凭证会保留原有权限上限，
                    不会随策略或轮换自动扩权。主体恢复后，未撤销且未过期的 Key
                    也可能重新生效。需要时请在
                    <Link
                      href={`/settings/credentials?agent_id=${encodeURIComponent(
                        agent.id,
                      )}`}
                    >
                      凭证页
                    </Link>
                    签发符合新策略的 Key。
                  </p>
                ) : (
                  <p>
                    这些凭证的冻结规则不会额外收紧当前选择；具体 Scope 仍可能限制操作。
                  </p>
                )}
                {credentialSummary.customSnapshots.length > 0 ? (
                  <details className="policyCustomCeilingPreview">
                    <summary>
                      查看 {credentialSummary.customSnapshots.length} 个 Custom Key
                      的实际影响
                    </summary>
                    <ul>
                      {credentialSummary.customSnapshots.map((snapshot) => (
                        <li key={snapshot.id}>
                          <strong>{snapshot.name}</strong>
                          <span>
                            {snapshot.restrictions.length > 0
                              ? `收紧：${snapshot.restrictions.join("、")}`
                              : "不额外收紧当前选择"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ) : null}
          </div>

          <label className="autonomousConsentLabel">
            <input
              checked={autonomousConfirmed}
              disabled={disabled || submitting || !credentialsReady}
              onChange={(event) => setAutonomousConfirmed(event.target.checked)}
              type="checkbox"
            />
            <span>
              {selectedTier === "autonomous"
                ? `我确认允许 @${agent.handle} 无需逐项审批发布、回复、编辑和软删除自己的内容。`
                : `我确认允许 @${agent.handle} 无需逐项审批执行上述自定义内容写入。`}
            </span>
          </label>
          <p className="reauthenticationNote">
            保存时会检查 Owner 是否刚刚完成登录；若会话不够新，将安全返回登录页重新认证。
          </p>
        </section>
      ) : null}

      <div className="policyActions">
        <button className="submitButton" disabled={!canSubmit} type="submit">
          {submitting
            ? "正在保存权限…"
            : changed
              ? `保存为${tierLabels[selectedTier]}`
              : "当前策略无需保存"}
        </button>
        <button
          className="secondaryButton"
          disabled={submitting}
          onClick={onClose}
          type="button"
        >
          取消
        </button>
      </div>
    </form>
  );
}

export { assistedRules, tierLabels };
