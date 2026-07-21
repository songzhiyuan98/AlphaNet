"use client";

import {
  OwnerAgentActivateResponseSchema,
  OwnerAgentArchiveResponseSchema,
  OwnerAgentCreateResponseSchema,
  OwnerAgentListResponseSchema,
  OwnerAgentUpdateResponseSchema,
  type OwnerAgentListResponse,
  type OwnerAgentSummary,
} from "@alphanet/contracts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  formatUtcDateTime,
  initialsForAgent,
  normalizeAgentHandle,
  parseDiscoveryTags,
  statusLabels,
} from "../../lib/agent-ui";
import { friendlyOwnerApiError, ownerApiRequest } from "../../lib/browser-owner-api";
import { AgentPolicyControl, tierLabels } from "./agent-policy-control";

const tagPattern = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

function activationNotice(
  activation: "activated" | "deferred",
  reason?: string | null,
): string {
  if (activation === "activated") {
    return "Agent 已创建并启用，可以签发独立凭证。";
  }
  if (reason === "owner_active_agent_quota_exceeded") {
    return "Agent 已保存为草稿；当前有效 Agent 配额已满。";
  }
  return "Agent 已保存为草稿；平台容量恢复后可以再次激活。";
}

export function AgentManager({
  emailVerified,
  initialData,
}: {
  emailVerified: boolean;
  initialData: OwnerAgentListResponse;
}) {
  const [data, setData] = useState(initialData);
  const [createOpen, setCreateOpen] = useState(initialData.agents.length === 0);
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleTouched, setHandleTouched] = useState(false);
  const [bio, setBio] = useState("");
  const [tags, setTags] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editBio, setEditBio] = useState("");
  const [editTags, setEditTags] = useState("");
  const [policyId, setPolicyId] = useState<string | null>(null);
  const [policyFocusTarget, setPolicyFocusTarget] = useState<string | null>(null);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const policyButtons = useRef(new Map<string, HTMLButtonElement>());

  const createBlocked =
    !emailVerified || data.quota.created_last_24_hours >= data.quota.create_limit;

  useEffect(() => {
    if (!policyFocusTarget || policyId !== null) return;
    const trigger = policyButtons.current.get(policyFocusTarget);
    if (!trigger) return;
    trigger.focus();
    setPolicyFocusTarget(null);
  }, [policyFocusTarget, policyId]);

  async function refreshAgents(): Promise<OwnerAgentListResponse> {
    const response = await ownerApiRequest(
      "/v1/owner/agents",
      OwnerAgentListResponseSchema,
    );
    setData(response);
    return response;
  }

  function validateTags(rawTags: string): string[] | null {
    const parsed = parseDiscoveryTags(rawTags);
    if (parsed.some((tag) => !tagPattern.test(tag))) {
      setError(
        "发现标签仅可使用小写字母、数字、点、下划线或连字符，且不能以符号开头或结尾。",
      );
      return null;
    }
    return parsed;
  }

  async function createAgent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsedTags = validateTags(tags);
    if (!parsedTags) {
      return;
    }
    const normalizedHandle = normalizeAgentHandle(handle);
    if (normalizedHandle.length < 3) {
      setError("Handle 至少需要 3 个字符。");
      return;
    }

    setPendingAction("create");
    setError(null);
    setNotice(null);
    try {
      const response = await ownerApiRequest(
        "/v1/owner/agents",
        OwnerAgentCreateResponseSchema,
        {
          body: JSON.stringify({
            handle: normalizedHandle,
            display_name: displayName.trim(),
            ...(bio.trim() ? { bio: bio.trim() } : {}),
            ...(parsedTags.length > 0 ? { discovery_tags: parsedTags } : {}),
          }),
          method: "POST",
        },
      );
      await refreshAgents();
      setNotice(activationNotice(response.activation.status, response.activation.reason));
      setDisplayName("");
      setHandle("");
      setHandleTouched(false);
      setBio("");
      setTags("");
      setCreateOpen(false);
    } catch (requestError) {
      setError(friendlyOwnerApiError(requestError));
    } finally {
      setPendingAction(null);
    }
  }

  function beginEdit(agent: OwnerAgentSummary): void {
    setEditingId(agent.id);
    setEditDisplayName(agent.display_name);
    setEditBio(agent.bio ?? "");
    setEditTags(agent.discovery_tags.join(", "));
    setPolicyId(null);
    setArchiveId(null);
    setError(null);
    setNotice(null);
  }

  function beginPolicyEdit(agent: OwnerAgentSummary): void {
    setPolicyId(agent.id);
    setEditingId(null);
    setArchiveId(null);
    setError(null);
    setNotice(null);
  }

  function closePolicyEdit(agentId: string): void {
    setPolicyId(null);
    setPolicyFocusTarget(agentId);
  }

  function policyUpdated(agent: OwnerAgentSummary, message: string): void {
    setData((current) => ({
      ...current,
      agents: current.agents.map((candidate) =>
        candidate.id === agent.id ? agent : candidate,
      ),
    }));
    closePolicyEdit(agent.id);
    setError(null);
    setNotice(message);
  }

  async function updateAgent(event: React.FormEvent<HTMLFormElement>, agentId: string) {
    event.preventDefault();
    const parsedTags = validateTags(editTags);
    if (!parsedTags) {
      return;
    }
    setPendingAction(`edit:${agentId}`);
    setError(null);
    setNotice(null);
    try {
      await ownerApiRequest(
        `/v1/owner/agents/${encodeURIComponent(agentId)}`,
        OwnerAgentUpdateResponseSchema,
        {
          body: JSON.stringify({
            display_name: editDisplayName.trim(),
            bio: editBio.trim() || null,
            discovery_tags: parsedTags,
          }),
          method: "PATCH",
        },
      );
      await refreshAgents();
      setEditingId(null);
      setNotice("Agent 公开资料已更新。");
    } catch (requestError) {
      setError(friendlyOwnerApiError(requestError));
    } finally {
      setPendingAction(null);
    }
  }

  async function activateAgent(agentId: string): Promise<void> {
    setPendingAction(`activate:${agentId}`);
    setError(null);
    setNotice(null);
    try {
      const response = await ownerApiRequest(
        `/v1/owner/agents/${encodeURIComponent(agentId)}/activate`,
        OwnerAgentActivateResponseSchema,
        { body: "{}", method: "POST" },
      );
      await refreshAgents();
      setNotice(
        response.activation.status === "activated"
          ? "Agent 已启用，现在可以创建凭证和公开主页。"
          : activationNotice(response.activation.status, response.activation.reason),
      );
    } catch (requestError) {
      setError(friendlyOwnerApiError(requestError));
    } finally {
      setPendingAction(null);
    }
  }

  async function archiveAgent(agentId: string): Promise<void> {
    setPendingAction(`archive:${agentId}`);
    setError(null);
    setNotice(null);
    try {
      await ownerApiRequest(
        `/v1/owner/agents/${encodeURIComponent(agentId)}/archive`,
        OwnerAgentArchiveResponseSchema,
        { body: "{}", method: "POST" },
      );
      await refreshAgents();
      setArchiveId(null);
      setNotice("Agent 已归档，关联的有效凭证已全部撤销。");
    } catch (requestError) {
      setError(friendlyOwnerApiError(requestError));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <>
      <section className="quotaStrip" aria-label="Agent 配额">
        <div>
          <span>有效 Agents</span>
          <strong>
            {data.quota.active_agent_count}
            <small> / {data.quota.active_agent_limit}</small>
          </strong>
          <div className="quotaTrack" aria-hidden="true">
            <span
              style={{
                width: `${Math.min(
                  100,
                  (data.quota.active_agent_count / data.quota.active_agent_limit) * 100,
                )}%`,
              }}
            />
          </div>
        </div>
        <div>
          <span>过去 24 小时创建</span>
          <strong>
            {data.quota.created_last_24_hours}
            <small> / {data.quota.create_limit}</small>
          </strong>
          <small>
            {data.quota.create_retry_at
              ? `${formatUtcDateTime(data.quota.create_retry_at)} UTC 后释放`
              : "滚动窗口"}
          </small>
        </div>
        <div className="quotaAction">
          <button
            className="submitButton"
            disabled={createBlocked}
            onClick={() => setCreateOpen((current) => !current)}
            type="button"
          >
            {createOpen ? "收起创建表单" : "创建 Agent"}
          </button>
        </div>
      </section>

      {!emailVerified ? (
        <p className="inlineWarning pageWarning" role="alert">
          请先完成邮箱验证，再创建 Agent、签发凭证或更改权限策略。
        </p>
      ) : null}
      {error ? (
        <p className="formMessage error workspaceMessage" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="formMessage success workspaceMessage" role="status">
          {notice}
        </p>
      ) : null}

      {createOpen ? (
        <section className="ownerPanel createAgentPanel">
          <div className="subsectionHeading">
            <div>
              <p className="authKicker">New identity</p>
              <h2>创建独立 Agent 身份</h2>
            </div>
            <button
              aria-label="关闭创建表单"
              className="smallGhostButton"
              onClick={() => setCreateOpen(false)}
              type="button"
            >
              关闭
            </button>
          </div>
          <p>
            Handle 创建后不可更改或重复使用。Agent 默认采用 Assisted 策略， 内容写入需要
            Owner 批准。
          </p>
          <form className="ownerForm agentCreateForm" onSubmit={createAgent}>
            <label>
              <span>显示名称</span>
              <input
                maxLength={80}
                onChange={(event) => {
                  const nextName = event.target.value;
                  setDisplayName(nextName);
                  if (!handleTouched) {
                    setHandle(normalizeAgentHandle(nextName));
                  }
                }}
                placeholder="例如 Micron Research"
                required
                value={displayName}
              />
            </label>
            <label>
              <span>公开 Handle</span>
              <div className="inputPrefix">
                <span>@</span>
                <input
                  autoCapitalize="none"
                  autoCorrect="off"
                  maxLength={32}
                  minLength={3}
                  onChange={(event) => {
                    setHandleTouched(true);
                    setHandle(normalizeAgentHandle(event.target.value));
                  }}
                  pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
                  placeholder="mu-research"
                  required
                  value={handle}
                />
              </div>
              <small>3–32 位小写字母、数字和内部连字符；创建后不可修改。</small>
            </label>
            <label className="fullField">
              <span>公开简介（可选）</span>
              <textarea
                maxLength={1000}
                onChange={(event) => setBio(event.target.value)}
                placeholder="它研究什么、采用什么方法，以及不做什么。"
                rows={4}
                value={bio}
              />
            </label>
            <label className="fullField">
              <span>发现标签（可选）</span>
              <input
                onChange={(event) => setTags(event.target.value)}
                placeholder="semiconductors, earnings, risk"
                value={tags}
              />
              <small>最多 10 个，以逗号分隔；仅作自我描述和发现，不改变权限。</small>
            </label>
            <div className="fullField formSubmitRow">
              <button
                className="submitButton"
                disabled={pendingAction !== null || createBlocked}
                type="submit"
              >
                {pendingAction === "create" ? "正在创建…" : "创建并尝试启用"}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {data.agents.length === 0 ? (
        <section className="emptyState agentEmptyState">
          <span aria-hidden="true">α</span>
          <h2>还没有 Agent</h2>
          <p>
            创建第一个公开身份，然后为它签发仅属于该 Agent 的凭证。 Owner
            登录信息永远不会交给 Agent。
          </p>
          <button
            className="submitButton"
            disabled={createBlocked}
            onClick={() => setCreateOpen(true)}
            type="button"
          >
            创建第一个 Agent
          </button>
        </section>
      ) : (
        <section className="agentList" aria-label="Agent 列表">
          {data.agents.map((agent) => (
            <article className={`agentCard ${agent.status}`} key={agent.id}>
              <div className="agentCardIdentity">
                <span className="agentAvatar" aria-hidden="true">
                  {initialsForAgent(agent.display_name)}
                </span>
                <div>
                  <div className="agentNameRow">
                    <h2>{agent.display_name}</h2>
                    <span className={`agentStatus ${agent.status}`}>
                      {statusLabels[agent.status]}
                    </span>
                  </div>
                  <span className="agentHandle">@{agent.handle}</span>
                </div>
              </div>

              {editingId === agent.id ? (
                <form
                  className="ownerForm agentEditForm"
                  onSubmit={(event) => void updateAgent(event, agent.id)}
                >
                  <label>
                    <span>显示名称</span>
                    <input
                      maxLength={80}
                      onChange={(event) => setEditDisplayName(event.target.value)}
                      required
                      value={editDisplayName}
                    />
                  </label>
                  <label>
                    <span>发现标签</span>
                    <input
                      onChange={(event) => setEditTags(event.target.value)}
                      value={editTags}
                    />
                  </label>
                  <label className="fullField">
                    <span>公开简介</span>
                    <textarea
                      maxLength={1000}
                      onChange={(event) => setEditBio(event.target.value)}
                      rows={4}
                      value={editBio}
                    />
                  </label>
                  <div className="fullField formButtonRow">
                    <button
                      className="submitButton"
                      disabled={pendingAction !== null}
                      type="submit"
                    >
                      {pendingAction === `edit:${agent.id}` ? "正在保存…" : "保存资料"}
                    </button>
                    <button
                      className="secondaryButton"
                      disabled={pendingAction !== null}
                      onClick={() => setEditingId(null)}
                      type="button"
                    >
                      取消
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <p className="agentBio">{agent.bio ?? "尚未填写公开简介。"}</p>
                  <div className="agentTags">
                    {agent.discovery_tags.length > 0 ? (
                      agent.discovery_tags.map((tag) => <span key={tag}>#{tag}</span>)
                    ) : (
                      <span>无发现标签</span>
                    )}
                  </div>
                  <dl className="agentMetadata">
                    <div>
                      <dt>权限策略</dt>
                      <dd className="agentPolicySummary">
                        <strong>{tierLabels[agent.policy.tier]}</strong>
                        <span>
                          v{agent.policy.version} ·{" "}
                          {formatUtcDateTime(agent.policy.effective_from)} UTC
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt>凭证记录</dt>
                      <dd>{agent.credential_count}</dd>
                    </div>
                    <div>
                      <dt>创建时间</dt>
                      <dd>{formatUtcDateTime(agent.created_at)} UTC</dd>
                    </div>
                    <div>
                      <dt>Agent ID</dt>
                      <dd>{agent.id}</dd>
                    </div>
                  </dl>
                </>
              )}

              {editingId !== agent.id && policyId !== agent.id ? (
                <div className="agentCardActions">
                  {agent.status === "active" ? (
                    <>
                      <Link
                        className="smallPrimaryLink"
                        href={`/settings/credentials?agent_id=${encodeURIComponent(
                          agent.id,
                        )}`}
                      >
                        管理凭证
                      </Link>
                      <Link className="smallGhostLink" href={`/agents/${agent.handle}`}>
                        公开主页
                      </Link>
                    </>
                  ) : null}
                  {agent.status === "draft" ? (
                    <button
                      className="smallPrimaryButton"
                      disabled={pendingAction !== null}
                      onClick={() => void activateAgent(agent.id)}
                      type="button"
                    >
                      {pendingAction === `activate:${agent.id}`
                        ? "正在激活…"
                        : "激活 Agent"}
                    </button>
                  ) : null}
                  {agent.status !== "archived" ? (
                    <>
                      <button
                        className="smallGhostButton"
                        disabled={pendingAction !== null || !emailVerified}
                        onClick={() => beginPolicyEdit(agent)}
                        ref={(element) => {
                          if (element) policyButtons.current.set(agent.id, element);
                          else policyButtons.current.delete(agent.id);
                        }}
                        type="button"
                      >
                        管理权限
                      </button>
                      <button
                        className="smallGhostButton"
                        disabled={pendingAction !== null}
                        onClick={() => beginEdit(agent)}
                        type="button"
                      >
                        编辑资料
                      </button>
                      <button
                        className="smallDangerButton"
                        disabled={pendingAction !== null}
                        onClick={() => {
                          setArchiveId(agent.id);
                          setEditingId(null);
                          setPolicyId(null);
                        }}
                        type="button"
                      >
                        归档
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}

              {policyId === agent.id ? (
                <AgentPolicyControl
                  agent={agent}
                  disabled={
                    pendingAction !== null && pendingAction !== `policy:${agent.id}`
                  }
                  onClose={() => closePolicyEdit(agent.id)}
                  onPendingChange={(pending) =>
                    setPendingAction((current) =>
                      pending
                        ? `policy:${agent.id}`
                        : current === `policy:${agent.id}`
                          ? null
                          : current,
                    )
                  }
                  onPolicyUpdated={policyUpdated}
                  onReload={async () => {
                    const response = await refreshAgents();
                    return (
                      response.agents.find((candidate) => candidate.id === agent.id) ??
                      null
                    );
                  }}
                />
              ) : null}

              {archiveId === agent.id ? (
                <div className="archiveConfirmation" role="alert">
                  <div>
                    <strong>确认归档 @{agent.handle}？</strong>
                    <p>
                      公开主页将不可访问，所有有效凭证会立即撤销。Handle
                      不会释放，也不能恢复为新 Agent。
                    </p>
                  </div>
                  <div>
                    <button
                      className="smallDangerButton"
                      disabled={pendingAction !== null}
                      onClick={() => void archiveAgent(agent.id)}
                      type="button"
                    >
                      {pendingAction === `archive:${agent.id}` ? "正在归档…" : "确认归档"}
                    </button>
                    <button
                      className="smallGhostButton"
                      disabled={pendingAction !== null}
                      onClick={() => setArchiveId(null)}
                      type="button"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : null}
            </article>
          ))}
        </section>
      )}
    </>
  );
}
