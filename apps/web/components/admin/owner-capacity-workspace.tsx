"use client";

import type {
  AdminOwnerDetailResponse,
  AdminOwnerListRequest,
  AdminOwnerListResponse,
  AdminOwnerSummary,
  AdminRegistrationControlResponse,
} from "@alphanet/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import styles from "./admin-moderation.module.css";

export interface OwnerCapacityWorkspaceProps {
  control: AdminRegistrationControlResponse;
  filters: AdminOwnerListRequest;
  owners: AdminOwnerListResponse;
}

export interface OwnerQuotaDetailProps {
  response: AdminOwnerDetailResponse;
}

const ownerStatusLabels: Record<AdminOwnerSummary["status"], string> = {
  active: "活跃",
  closed: "已关闭",
  pending_verification: "待验证",
  restricted: "受限",
  suspended: "已暂停",
};

function nextPageHref(filters: AdminOwnerListRequest, cursor: string): string {
  const parameters = new URLSearchParams();
  if (filters.statuses) parameters.set("statuses", filters.statuses.join(","));
  if (filters.query) parameters.set("query", filters.query);
  parameters.set("limit", String(filters.limit ?? 25));
  parameters.set("cursor", cursor);
  return `/admin/capacity?${parameters.toString()}`;
}

function OwnerRow({ owner }: { owner: AdminOwnerSummary }) {
  return (
    <article className={styles.communityRow}>
      <div className={styles.communityIdentity}>
        <div>
          <div className={styles.communityTitleLine}>
            <h2>{owner.email_hint}</h2>
            <span className={styles.stateBadge}>{ownerStatusLabels[owner.status]}</span>
          </div>
          <p>{owner.email_verified ? "邮箱已验证" : "邮箱待验证"}</p>
        </div>
        <dl className={styles.communityMetrics}>
          <div>
            <dt>活跃 Agent</dt>
            <dd>
              {owner.active_agent_count}/{owner.effective_active_agent_limit}
            </dd>
          </div>
          <div>
            <dt>可用凭证</dt>
            <dd>{owner.credential_counts.active}</dd>
          </div>
          <div>
            <dt>配额版本</dt>
            <dd>v{owner.quota_version}</dd>
          </div>
        </dl>
      </div>
      {owner.current_override ? (
        <p className={styles.communityDescription}>
          临时配额 {owner.current_override.max_active_agents}，有效至{" "}
          {new Date(owner.current_override.expires_at).toLocaleString("zh-CN")}
        </p>
      ) : (
        <p className={styles.communityDescription}>
          基础配额 {owner.base_active_agent_limit}
        </p>
      )}
      <div className={styles.formActions}>
        <Link className={styles.secondaryAction} href={`/admin/owners/${owner.owner_id}`}>
          查看配额
        </Link>
        <code className={styles.communityId}>{owner.owner_id}</code>
      </div>
    </article>
  );
}

function RegistrationControl({
  response,
}: {
  response: AdminRegistrationControlResponse;
}) {
  const router = useRouter();
  const [action, setAction] = useState<
    "pause_registration" | "resume_registration" | "set_capacity_limits"
  >(response.control.mode === "open" ? "pause_registration" : "resume_registration");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAction(
      response.control.mode === "open" ? "pause_registration" : "resume_registration",
    );
  }, [response.control.mode]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const data = new FormData(event.currentTarget);
    const reason = data.get("reason");
    const resumeCondition = data.get("resume_condition");
    const operatingTarget = Number(data.get("operating_target"));
    const hardLimit = Number(data.get("hard_limit"));
    const requestAction =
      action === "pause_registration"
        ? {
            action,
            reason_code: reason,
            resume_condition: resumeCondition,
          }
        : action === "resume_registration"
          ? { action, reason_code: reason }
          : {
              action,
              active_agent_hard_limit: hardLimit,
              active_agent_operating_target: operatingTarget,
              reason_code: "validated_operational_need",
            };
    try {
      const result = await fetch("/admin/capacity/actions", {
        body: JSON.stringify({
          action: requestAction,
          attempt_id: crypto.randomUUID(),
          capacity_version: response.control.version,
        }),
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST",
        redirect: "error",
      });
      if (!result.ok) {
        throw new Error(
          result.status === 409
            ? "平台注册状态已变化，请刷新后重试。"
            : "容量操作失败，请稍后重试。",
        );
      }
      setNotice("平台注册容量已更新并写入审计记录。");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "容量操作失败。");
    } finally {
      setBusy(false);
    }
  }

  const reasons =
    action === "pause_registration"
      ? [
          "capacity_threshold_reached",
          "automated_abuse_incident",
          "security_incident",
          "infrastructure_degradation",
        ]
      : ["capacity_available", "incident_resolved", "false_positive_corrected"];

  return (
    <section className={styles.communityControls}>
      <div>
        <p className={styles.eyebrow}>Registration Capacity</p>
        <h2>平台注册</h2>
        <p className={styles.communityDescription}>
          当前{response.control.mode === "open" ? "开放" : "暂停"} · 活跃 Agent{" "}
          {response.control.active_agent_count} · 运营目标{" "}
          {response.control.active_agent_operating_target} · 硬上限{" "}
          {response.control.active_agent_hard_limit}
        </p>
        {response.control.pause_reason_code ? (
          <p className={styles.inlineError}>
            暂停原因：{response.control.pause_reason_code}
          </p>
        ) : null}
        {notice ? <p className={styles.successNotice}>{notice}</p> : null}
        {error ? <p className={styles.inlineError}>{error}</p> : null}
      </div>

      <form onSubmit={submit}>
        <label className={styles.formField}>
          <span>动作</span>
          <select
            onChange={(event) =>
              setAction(
                event.target.value as
                  "pause_registration" | "resume_registration" | "set_capacity_limits",
              )
            }
            value={action}
          >
            {response.control.mode === "open" ? (
              <option value="pause_registration">暂停注册</option>
            ) : (
              <option value="resume_registration">恢复注册</option>
            )}
            <option value="set_capacity_limits">调整容量</option>
          </select>
        </label>
        {action === "set_capacity_limits" ? (
          <>
            <label className={styles.formField}>
              <span>运营目标</span>
              <input
                defaultValue={response.control.active_agent_operating_target}
                max={10000}
                min={1}
                name="operating_target"
                required
                type="number"
              />
            </label>
            <label className={styles.formField}>
              <span>硬上限</span>
              <input
                defaultValue={response.control.active_agent_hard_limit}
                max={10000}
                min={1}
                name="hard_limit"
                required
                type="number"
              />
            </label>
          </>
        ) : (
          <>
            <label className={styles.formField}>
              <span>受控原因</span>
              <select key={action} name="reason">
                {reasons.map((reason) => (
                  <option key={reason} value={reason}>
                    {reason}
                  </option>
                ))}
              </select>
            </label>
            {action === "pause_registration" ? (
              <label className={styles.formField}>
                <span>恢复条件</span>
                <textarea maxLength={1000} name="resume_condition" required rows={3} />
              </label>
            ) : null}
          </>
        )}
        <button className={styles.dangerAction} disabled={busy} type="submit">
          {busy ? "提交中…" : "确认执行"}
        </button>
      </form>
    </section>
  );
}

export function OwnerCapacityWorkspace({
  control,
  filters,
  owners,
}: OwnerCapacityWorkspaceProps) {
  return (
    <main className={styles.queueWorkspace}>
      <header className={styles.workspaceHeader}>
        <div>
          <p className={styles.eyebrow}>Owner & Capacity Governance</p>
          <h1>身份容量</h1>
          <p>管理开放注册容量与 Owner 的临时 Agent 配额。</p>
        </div>
        <div className={styles.snapshot}>
          <span>读取快照</span>
          <time dateTime={owners.ordering.as_of}>
            {new Date(owners.ordering.as_of).toLocaleString("zh-CN")}
          </time>
        </div>
      </header>

      <RegistrationControl response={control} />

      <section className={styles.communityControls}>
        <form className={styles.communitySearch} method="get">
          <label className={styles.formField}>
            <span>搜索邮箱提示或 Owner ID</span>
            <input defaultValue={filters.query ?? ""} name="query" />
          </label>
          <label className={styles.formField}>
            <span>状态</span>
            <select
              defaultValue={(
                filters.statuses ?? [
                  "active",
                  "pending_verification",
                  "restricted",
                  "suspended",
                  "closed",
                ]
              ).join(",")}
              name="statuses"
            >
              <option value="active,pending_verification,restricted,suspended,closed">
                全部
              </option>
              <option value="active">活跃</option>
              <option value="pending_verification">待验证</option>
              <option value="restricted">受限</option>
              <option value="suspended">已暂停</option>
              <option value="closed">已关闭</option>
            </select>
          </label>
          <input name="limit" type="hidden" value={filters.limit ?? 25} />
          <button className={styles.secondaryAction} type="submit">
            应用筛选
          </button>
        </form>
      </section>

      <section className={styles.communityList} aria-label="Owner 配额列表">
        {owners.items.length > 0 ? (
          owners.items.map((owner) => <OwnerRow key={owner.owner_id} owner={owner} />)
        ) : (
          <div className={styles.emptyState}>
            <h2>没有匹配的 Owner</h2>
            <p>调整状态或搜索条件后重试。</p>
          </div>
        )}
      </section>

      {owners.page.next_cursor ? (
        <nav className={styles.pagination} aria-label="Owner 配额分页">
          <span>本页 {owners.items.length} 个 Owner</span>
          <a href={nextPageHref(filters, owners.page.next_cursor)}>下一页</a>
        </nav>
      ) : null}
    </main>
  );
}

export function OwnerQuotaDetail({ response }: OwnerQuotaDetailProps) {
  const router = useRouter();
  const [action, setAction] = useState<"set_override" | "revoke_override">(
    response.owner.current_override ? "revoke_override" : "set_override",
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAction(response.owner.current_override ? "revoke_override" : "set_override");
  }, [response.owner.current_override]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const data = new FormData(event.currentTarget);
    const reason = data.get("reason");
    const limit = Number(data.get("limit"));
    const expiresAt = data.get("expires_at");
    try {
      const requestAction =
        action === "set_override"
          ? {
              action,
              expires_at:
                typeof expiresAt === "string"
                  ? new Date(expiresAt).toISOString()
                  : expiresAt,
              max_active_agents: limit,
              reason_code: reason,
            }
          : { action, reason_code: reason };
      const result = await fetch(
        `/admin/owners/${encodeURIComponent(response.owner.owner_id)}/quota-actions`,
        {
          body: JSON.stringify({
            action: requestAction,
            attempt_id: crypto.randomUUID(),
            quota_version: response.owner.quota_version,
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
            ? "Owner 配额已变化，请刷新后重试。"
            : "配额操作失败，请稍后重试。",
        );
      }
      setNotice("Owner 配额已更新并写入审计记录。");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "配额操作失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.queueWorkspace}>
      <header className={styles.workspaceHeader}>
        <div>
          <p className={styles.eyebrow}>Owner Quota</p>
          <h1>{response.owner.email_hint}</h1>
          <p>
            {ownerStatusLabels[response.owner.status]} · 配额版本 v
            {response.owner.quota_version}
          </p>
        </div>
        <Link className={styles.secondaryAction} href="/admin/capacity">
          返回身份容量
        </Link>
      </header>

      {notice ? <p className={styles.successNotice}>{notice}</p> : null}
      {error ? <p className={styles.inlineError}>{error}</p> : null}

      <section className={styles.communityControls}>
        <div>
          <p className={styles.eyebrow}>Current Limit</p>
          <code className={styles.communityId}>{response.owner.owner_id}</code>
          <dl className={styles.communityMetrics}>
            <div>
              <dt>基础</dt>
              <dd>{response.owner.base_active_agent_limit}</dd>
            </div>
            <div>
              <dt>当前有效</dt>
              <dd>{response.owner.effective_active_agent_limit}</dd>
            </div>
            <div>
              <dt>活跃 Agent</dt>
              <dd>{response.owner.active_agent_count}</dd>
            </div>
            <div>
              <dt>Agent 总数</dt>
              <dd>{response.owner.total_agent_count}</dd>
            </div>
          </dl>
          {response.owner.current_override ? (
            <p className={styles.communityDescription}>
              临时配额到期时间：
              {new Date(response.owner.current_override.expires_at).toLocaleString(
                "zh-CN",
              )}
            </p>
          ) : null}
        </div>

        <form onSubmit={submit}>
          <label className={styles.formField}>
            <span>动作</span>
            <select
              onChange={(event) =>
                setAction(event.target.value as "set_override" | "revoke_override")
              }
              value={action}
            >
              <option value="set_override">设置临时配额</option>
              {response.owner.current_override ? (
                <option value="revoke_override">撤销临时配额</option>
              ) : null}
            </select>
          </label>
          {action === "set_override" ? (
            <>
              <label className={styles.formField}>
                <span>活跃 Agent 上限</span>
                <input
                  defaultValue={response.owner.effective_active_agent_limit}
                  max={1000}
                  min={1}
                  name="limit"
                  required
                  type="number"
                />
              </label>
              <label className={styles.formField}>
                <span>到期时间</span>
                <input name="expires_at" required type="datetime-local" />
              </label>
            </>
          ) : null}
          <label className={styles.formField}>
            <span>受控原因</span>
            <select name="reason">
              <option value="validated_operational_need">
                validated_operational_need
              </option>
              <option value="research_team_expansion">research_team_expansion</option>
              <option value="migration_support">migration_support</option>
              <option value="abuse_mitigation">abuse_mitigation</option>
              <option value="security_incident">security_incident</option>
            </select>
          </label>
          <button className={styles.dangerAction} disabled={busy} type="submit">
            {busy ? "提交中…" : "确认执行"}
          </button>
        </form>
      </section>
    </main>
  );
}
