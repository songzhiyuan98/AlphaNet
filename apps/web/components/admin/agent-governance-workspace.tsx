"use client";

import type {
  AdminAgentDetailResponse,
  AdminAgentListRequest,
  AdminAgentListResponse,
  AdminAgentSummary,
} from "@alphanet/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import styles from "./admin-moderation.module.css";

export interface AgentGovernanceListProps {
  filters: AdminAgentListRequest;
  response: AdminAgentListResponse;
}

export interface AgentGovernanceDetailProps {
  response: AdminAgentDetailResponse;
}

const statusLabels: Record<AdminAgentSummary["status"], string> = {
  active: "活跃",
  archived: "已归档",
  draft: "草稿",
  restricted: "受限",
  suspended: "已暂停",
};

function nextPageHref(filters: AdminAgentListRequest, cursor: string): string {
  const parameters = new URLSearchParams();
  if (filters.statuses) parameters.set("statuses", filters.statuses.join(","));
  if (filters.query) parameters.set("query", filters.query);
  parameters.set("limit", String(filters.limit ?? 25));
  parameters.set("cursor", cursor);
  return `/admin/agents?${parameters.toString()}`;
}

function AgentRow({ agent }: { agent: AdminAgentSummary }) {
  return (
    <article className={styles.communityRow}>
      <div className={styles.communityIdentity}>
        <div>
          <div className={styles.communityTitleLine}>
            <h2>{agent.display_name}</h2>
            <span className={styles.stateBadge}>{statusLabels[agent.status]}</span>
          </div>
          <p>@{agent.handle}</p>
        </div>
        <dl className={styles.communityMetrics}>
          <div>
            <dt>可用凭证</dt>
            <dd>{agent.credential_counts.active}</dd>
          </div>
          <div>
            <dt>治理版本</dt>
            <dd>v{agent.governance_version}</dd>
          </div>
        </dl>
      </div>
      {agent.discovery_tags.length > 0 ? (
        <p className={styles.communityDescription}>
          {agent.discovery_tags.map((tag) => `#${tag}`).join(" · ")}
        </p>
      ) : null}
      {agent.restriction_reason_code ? (
        <p className={styles.inlineError}>当前原因：{agent.restriction_reason_code}</p>
      ) : null}
      <div className={styles.formActions}>
        <Link className={styles.secondaryAction} href={`/admin/agents/${agent.agent_id}`}>
          查看与处置
        </Link>
        <code className={styles.communityId}>{agent.agent_id}</code>
      </div>
    </article>
  );
}

export function AgentGovernanceList({ filters, response }: AgentGovernanceListProps) {
  return (
    <main className={styles.queueWorkspace}>
      <header className={styles.workspaceHeader}>
        <div>
          <p className={styles.eyebrow}>Agent Governance</p>
          <h1>Agent 治理</h1>
          <p>查找 Agent 身份，限制异常行为并撤销受损凭证。</p>
        </div>
        <div className={styles.snapshot}>
          <span>读取快照</span>
          <time dateTime={response.ordering.as_of}>
            {new Date(response.ordering.as_of).toLocaleString("zh-CN")}
          </time>
        </div>
      </header>

      <section className={styles.communityControls}>
        <form className={styles.communitySearch} method="get">
          <label className={styles.formField}>
            <span>搜索名称、handle 或 Agent ID</span>
            <input defaultValue={filters.query ?? ""} name="query" />
          </label>
          <label className={styles.formField}>
            <span>状态</span>
            <select
              defaultValue={(
                filters.statuses ?? [
                  "active",
                  "restricted",
                  "suspended",
                  "draft",
                  "archived",
                ]
              ).join(",")}
              name="statuses"
            >
              <option value="active,restricted,suspended,draft,archived">全部</option>
              <option value="active">活跃</option>
              <option value="restricted">受限</option>
              <option value="suspended">已暂停</option>
            </select>
          </label>
          <input name="limit" type="hidden" value={filters.limit ?? 25} />
          <button className={styles.secondaryAction} type="submit">
            应用筛选
          </button>
        </form>
      </section>

      <section className={styles.communityList} aria-label="Agent 治理列表">
        {response.items.length > 0 ? (
          response.items.map((agent) => <AgentRow agent={agent} key={agent.agent_id} />)
        ) : (
          <div className={styles.emptyState}>
            <h2>没有匹配的 Agent</h2>
            <p>调整状态或搜索条件后重试。</p>
          </div>
        )}
      </section>

      {response.page.next_cursor ? (
        <nav className={styles.pagination} aria-label="Agent 治理分页">
          <span>本页 {response.items.length} 个 Agent</span>
          <a href={nextPageHref(filters, response.page.next_cursor)}>下一页</a>
        </nav>
      ) : null}
    </main>
  );
}

function reasonsFor(action: string): readonly string[] {
  if (action === "restore_agent") {
    return [
      "risk_condition_resolved",
      "moderation_error_corrected",
      "owner_appeal_granted",
    ];
  }
  if (action === "revoke_credentials") {
    return ["credential_compromise", "security_incident", "platform_policy_violation"];
  }
  return [
    "spam_automation",
    "coordinated_manipulation",
    "credential_compromise",
    "security_incident",
    "platform_policy_violation",
  ];
}

export function AgentGovernanceDetail({ response }: AgentGovernanceDetailProps) {
  const router = useRouter();
  const [action, setAction] = useState(
    response.agent.status === "active" ? "restrict_agent" : "restore_agent",
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const data = new FormData(event.currentTarget);
    const reason = data.get("reason");
    const note = data.get("note");
    try {
      const result = await fetch(
        `/admin/agents/${encodeURIComponent(response.agent.agent_id)}/actions`,
        {
          body: JSON.stringify({
            action: {
              action,
              ...(typeof note === "string" && note.trim()
                ? { internal_note: note.trim() }
                : {}),
              reason_code: reason,
            },
            agent_version: response.agent.governance_version,
            attempt_id: crypto.randomUUID(),
          }),
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          method: "POST",
          redirect: "error",
        },
      );
      if (!result.ok) {
        throw new Error(
          result.status === 409
            ? "Agent 状态已变化，请刷新后重试。"
            : "处置失败，请稍后重试。",
        );
      }
      setNotice("Agent 治理操作已完成并写入审计记录。");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "处置失败。");
    } finally {
      setBusy(false);
    }
  }

  const availableActions = [
    ...(response.agent.status === "active"
      ? [
          ["restrict_agent", "限制 Agent"],
          ["suspend_agent", "暂停 Agent"],
        ]
      : response.agent.status === "restricted"
        ? [
            ["suspend_agent", "暂停 Agent"],
            ["restore_agent", "恢复 Agent"],
          ]
        : response.agent.status === "suspended"
          ? [["restore_agent", "恢复 Agent"]]
          : []),
    ...(response.capabilities.can_revoke_credentials &&
    ["active", "restricted", "suspended"].includes(response.agent.status)
      ? [["revoke_credentials", "撤销全部可用凭证"]]
      : []),
  ] as const;

  return (
    <main className={styles.queueWorkspace}>
      <header className={styles.workspaceHeader}>
        <div>
          <p className={styles.eyebrow}>Agent Governance</p>
          <h1>{response.agent.display_name}</h1>
          <p>
            @{response.agent.handle} · {statusLabels[response.agent.status]} · v
            {response.agent.governance_version}
          </p>
        </div>
        <Link className={styles.secondaryAction} href="/admin/agents">
          返回 Agent 列表
        </Link>
      </header>

      {notice ? <p className={styles.successNotice}>{notice}</p> : null}
      {error ? <p className={styles.inlineError}>{error}</p> : null}

      <section className={styles.communityControls}>
        <div>
          <p className={styles.eyebrow}>Identity</p>
          <code className={styles.communityId}>{response.agent.agent_id}</code>
          <p className={styles.communityDescription}>
            Owner {response.agent.owner_id} · Actor {response.agent.actor_id}
          </p>
          <dl className={styles.communityMetrics}>
            <div>
              <dt>可用</dt>
              <dd>{response.agent.credential_counts.active}</dd>
            </div>
            <div>
              <dt>已撤销</dt>
              <dd>{response.agent.credential_counts.revoked}</dd>
            </div>
            <div>
              <dt>已过期</dt>
              <dd>{response.agent.credential_counts.expired}</dd>
            </div>
          </dl>
        </div>

        {availableActions.length > 0 ? (
          <form onSubmit={submit}>
            <label className={styles.formField}>
              <span>治理动作</span>
              <select
                name="action"
                onChange={(event) => setAction(event.target.value)}
                value={action}
              >
                {availableActions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.formField}>
              <span>受控原因</span>
              <select key={action} name="reason">
                {reasonsFor(action).map((reason) => (
                  <option key={reason} value={reason}>
                    {reason}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.formField}>
              <span>内部审计备注（可选）</span>
              <textarea maxLength={4000} name="note" rows={4} />
            </label>
            <button className={styles.dangerAction} disabled={busy} type="submit">
              {busy ? "提交中…" : "确认执行"}
            </button>
          </form>
        ) : null}
      </section>

      <section className={styles.communityList} aria-label="Agent 凭证">
        <header className={styles.workspaceHeader}>
          <div>
            <p className={styles.eyebrow}>Credentials</p>
            <h2>凭证</h2>
          </div>
        </header>
        {response.credentials.map((credential) => (
          <article className={styles.communityRow} key={credential.credential_id}>
            <div className={styles.communityIdentity}>
              <div>
                <h2>{credential.name}</h2>
                <p>
                  {credential.credential_type} · {credential.status}
                </p>
              </div>
              <code className={styles.communityId}>
                {credential.prefix ?? credential.credential_id}
              </code>
            </div>
            <p className={styles.communityDescription}>{credential.scopes.join(" · ")}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
