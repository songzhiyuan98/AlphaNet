"use client";

import {
  AGENT_SCOPES,
  OwnerCredentialCreateResponseSchema,
  OwnerCredentialListResponseSchema,
  OwnerCredentialRevokeResponseSchema,
  OwnerCredentialRotateResponseSchema,
  type AgentCredentialSummary,
  type AgentScope,
  type OwnerAgentSummary,
} from "@alphanet/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { friendlyOwnerApiError, ownerApiRequest } from "../../lib/browser-owner-api";
import { formatUtcDateTime, scopeLabels } from "../../lib/agent-ui";

interface RevealedSecret {
  apiKey: string;
  credential: AgentCredentialSummary;
  agentHandle: string;
  reason: "created" | "rotated";
}

function credentialStatusLabel(status: AgentCredentialSummary["status"]): string {
  return {
    active: "有效",
    expired: "已过期",
    revoked: "已撤销",
  }[status];
}

function downloadSecret(secret: RevealedSecret): void {
  const contents = [
    "AlphaNet Agent API credential",
    `Agent: @${secret.agentHandle}`,
    `Credential: ${secret.credential.name}`,
    `Credential ID: ${secret.credential.id}`,
    `Issued at: ${secret.credential.issued_at}`,
    "",
    secret.apiKey,
    "",
    "Store this secret in a password manager or secret vault. Never commit it to source control.",
  ].join("\n");
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safeName = `${secret.agentHandle}-${secret.credential.name}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  link.download = `${safeName || "alphanet-agent"}-api-key.txt`;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}

export function CredentialWorkspace({
  agents,
  initialCredentials,
  initialAgentId,
  onCredentialsChanged,
}: {
  agents: OwnerAgentSummary[];
  initialCredentials?: AgentCredentialSummary[] | undefined;
  initialAgentId?: string | undefined;
  onCredentialsChanged?: (() => void | Promise<void>) | undefined;
}) {
  const defaultAgentId =
    initialAgentId ??
    agents.find((agent) => agent.status === "active")?.id ??
    agents[0]?.id ??
    "";
  const [selectedAgentId, setSelectedAgentId] = useState(defaultAgentId);
  const [credentials, setCredentials] = useState<AgentCredentialSummary[]>(
    initialCredentials ?? [],
  );
  const [loading, setLoading] = useState(
    defaultAgentId.length > 0 && initialCredentials === undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("Primary workflow");
  const [expiresAt, setExpiresAt] = useState("");
  const [scopes, setScopes] = useState<AgentScope[]>([
    "research:read",
    "community:read",
    "notifications:read",
    "actions:read",
  ]);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    credentialId: string;
    kind: "revoke" | "rotate";
  } | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<RevealedSecret | null>(null);
  const [copied, setCopied] = useState(false);
  const skippedInitialRequest = useRef(false);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  useEffect(() => {
    if (
      selectedAgentId.length > 0 &&
      !agents.some((agent) => agent.id === selectedAgentId)
    ) {
      setSelectedAgentId(defaultAgentId);
    }
  }, [agents, defaultAgentId, selectedAgentId]);

  useEffect(() => {
    if (!selectedAgentId) {
      setCredentials([]);
      setLoading(false);
      return;
    }
    if (
      !skippedInitialRequest.current &&
      initialCredentials !== undefined &&
      selectedAgentId === defaultAgentId
    ) {
      skippedInitialRequest.current = true;
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void ownerApiRequest(
      `/v1/owner/credentials?agent_id=${encodeURIComponent(selectedAgentId)}`,
      OwnerCredentialListResponseSchema,
      { signal: controller.signal },
    )
      .then((response) => {
        setCredentials(response.credentials);
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) {
          setError(friendlyOwnerApiError(requestError));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [defaultAgentId, initialCredentials, selectedAgentId]);

  async function refreshCredentials(): Promise<void> {
    if (!selectedAgentId) {
      return;
    }
    const response = await ownerApiRequest(
      `/v1/owner/credentials?agent_id=${encodeURIComponent(selectedAgentId)}`,
      OwnerCredentialListResponseSchema,
    );
    setCredentials(response.credentials);
    await onCredentialsChanged?.();
  }

  function toggleScope(scope: AgentScope): void {
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((candidate) => candidate !== scope)
        : [...current, scope],
    );
  }

  async function issueCredential(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAgent || selectedAgent.status !== "active") {
      setError("只有已启用的 Agent 可以签发凭证。");
      return;
    }
    if (scopes.length === 0) {
      setError("请至少选择一个 Scope。");
      return;
    }

    setPendingAction("create");
    setError(null);
    setNotice(null);
    try {
      const response = await ownerApiRequest(
        `/v1/owner/agents/${encodeURIComponent(selectedAgent.id)}/credentials`,
        OwnerCredentialCreateResponseSchema,
        {
          body: JSON.stringify({
            name: name.trim(),
            scopes,
            ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
          }),
          method: "POST",
        },
      );
      setRevealedSecret({
        agentHandle: selectedAgent.handle,
        apiKey: response.api_key,
        credential: response.credential,
        reason: "created",
      });
      setCopied(false);
      setName("Primary workflow");
      setExpiresAt("");
      await refreshCredentials();
    } catch (requestError) {
      setError(friendlyOwnerApiError(requestError));
    } finally {
      setPendingAction(null);
    }
  }

  async function rotateCredential(credentialId: string): Promise<void> {
    if (!selectedAgent) {
      return;
    }
    setPendingAction(`rotate:${credentialId}`);
    setError(null);
    setNotice(null);
    try {
      const response = await ownerApiRequest(
        `/v1/owner/credentials/${encodeURIComponent(credentialId)}/rotate`,
        OwnerCredentialRotateResponseSchema,
        { body: "{}", method: "POST" },
      );
      setRevealedSecret({
        agentHandle: selectedAgent.handle,
        apiKey: response.api_key,
        credential: response.credential,
        reason: "rotated",
      });
      setCopied(false);
      setConfirmation(null);
      await refreshCredentials();
    } catch (requestError) {
      setError(friendlyOwnerApiError(requestError));
    } finally {
      setPendingAction(null);
    }
  }

  async function revokeCredential(credentialId: string): Promise<void> {
    setPendingAction(`revoke:${credentialId}`);
    setError(null);
    setNotice(null);
    try {
      await ownerApiRequest(
        `/v1/owner/credentials/${encodeURIComponent(credentialId)}`,
        OwnerCredentialRevokeResponseSchema,
        { method: "DELETE" },
      );
      setConfirmation(null);
      setNotice("凭证已撤销，旧密钥立即失效。");
      await refreshCredentials();
    } catch (requestError) {
      setError(friendlyOwnerApiError(requestError));
    } finally {
      setPendingAction(null);
    }
  }

  async function copySecret(): Promise<void> {
    if (!revealedSecret) {
      return;
    }
    try {
      await navigator.clipboard.writeText(revealedSecret.apiKey);
      setCopied(true);
    } catch {
      setError("浏览器无法访问剪贴板，请手动选择并复制密钥。");
    }
  }

  if (agents.length === 0) {
    return (
      <div className="emptyState credentialEmptyState">
        <span aria-hidden="true">⌁</span>
        <h3>先创建一个 Agent</h3>
        <p>凭证绑定到独立 Agent 身份，不能直接签发给 Owner 账户。</p>
      </div>
    );
  }

  return (
    <section className="credentialWorkspace" id="credentials">
      <div className="credentialToolbar">
        <label>
          <span>管理 Agent</span>
          <select
            onChange={(event) => {
              setSelectedAgentId(event.target.value);
              setConfirmation(null);
              setNotice(null);
            }}
            value={selectedAgentId}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                @{agent.handle} · {credentialStatusLabelForAgent(agent.status)}
              </option>
            ))}
          </select>
        </label>
        {selectedAgent ? (
          <div className="credentialAgentMeta">
            <strong>{selectedAgent.display_name}</strong>
            <span>{selectedAgent.credential_count} 个历史凭证</span>
          </div>
        ) : null}
      </div>

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

      <div className="credentialGrid">
        <form className="ownerForm credentialIssueForm" onSubmit={issueCredential}>
          <div className="subsectionHeading">
            <div>
              <p className="authKicker">Issue key</p>
              <h3>签发 API Key</h3>
            </div>
            <span className="securityBadge">仅显示一次</span>
          </div>

          {selectedAgent?.status !== "active" ? (
            <p className="inlineWarning">当前 Agent 未启用，激活后才能签发凭证。</p>
          ) : null}

          <label>
            <span>凭证名称</span>
            <input
              autoComplete="off"
              disabled={selectedAgent?.status !== "active"}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如 Trading workflow"
              required
              value={name}
            />
          </label>
          <label>
            <span>到期时间（可选）</span>
            <input
              disabled={selectedAgent?.status !== "active"}
              min={new Date(Date.now() + 3_600_000).toISOString().slice(0, 16)}
              onChange={(event) => setExpiresAt(event.target.value)}
              type="datetime-local"
              value={expiresAt}
            />
            <small>留空时使用平台默认有效期。时间按你的本地时区输入。</small>
          </label>

          <fieldset className="scopeFieldset">
            <legend>Scopes</legend>
            <p>遵循最小权限原则；之后可单独签发不同用途的 Key。</p>
            <div className="scopeGrid">
              {AGENT_SCOPES.map((scope) => (
                <label key={scope}>
                  <input
                    checked={scopes.includes(scope)}
                    disabled={selectedAgent?.status !== "active"}
                    onChange={() => toggleScope(scope)}
                    type="checkbox"
                  />
                  <span>
                    <strong>{scope}</strong>
                    <small>{scopeLabels[scope]}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <button
            className="submitButton"
            disabled={
              pendingAction !== null ||
              selectedAgent?.status !== "active" ||
              scopes.length === 0
            }
            type="submit"
          >
            {pendingAction === "create" ? "正在签发…" : "签发新 Key"}
          </button>
        </form>

        <div className="credentialListPanel">
          <div className="subsectionHeading">
            <div>
              <p className="authKicker">Credentials</p>
              <h3>凭证记录</h3>
            </div>
            <span>{credentials.length}</span>
          </div>

          {loading ? (
            <div className="listLoading" role="status">
              正在读取凭证…
            </div>
          ) : credentials.length === 0 ? (
            <div className="emptyState compactEmptyState">
              <span aria-hidden="true">⌁</span>
              <h3>还没有凭证</h3>
              <p>签发后，完整密钥只会在当前窗口显示一次。</p>
            </div>
          ) : (
            <div className="credentialList">
              {credentials.map((credential) => {
                const isActive = credential.status === "active";
                const confirm = confirmation?.credentialId === credential.id;
                return (
                  <article className="credentialCard" key={credential.id}>
                    <div className="credentialCardHeader">
                      <div>
                        <strong>{credential.name}</strong>
                        <code>{credential.token_prefix}…</code>
                      </div>
                      <span className={`credentialStatus ${credential.status}`}>
                        {credentialStatusLabel(credential.status)}
                      </span>
                    </div>
                    <dl className="credentialDetails">
                      <div>
                        <dt>Scopes</dt>
                        <dd>{credential.scopes.length}</dd>
                      </div>
                      <div>
                        <dt>签发</dt>
                        <dd>{formatUtcDateTime(credential.issued_at)} UTC</dd>
                      </div>
                      <div>
                        <dt>到期</dt>
                        <dd>{formatUtcDateTime(credential.expires_at)} UTC</dd>
                      </div>
                      <div>
                        <dt>最近使用</dt>
                        <dd>{formatUtcDateTime(credential.last_used_at)} UTC</dd>
                      </div>
                    </dl>
                    <div className="credentialScopes">
                      {credential.scopes.map((scope) => (
                        <span key={scope}>{scope}</span>
                      ))}
                    </div>

                    {isActive && selectedAgent?.status === "active" ? (
                      confirm ? (
                        <div className="inlineConfirmation" role="alert">
                          <p>
                            {confirmation.kind === "rotate"
                              ? "轮换会立即撤销旧 Key，并生成只显示一次的新 Key。"
                              : "撤销后无法恢复，使用此 Key 的工作流会立即失去访问权限。"}
                          </p>
                          <div>
                            <button
                              className="smallDangerButton"
                              disabled={pendingAction !== null}
                              onClick={() => {
                                if (confirmation.kind === "rotate") {
                                  void rotateCredential(credential.id);
                                } else {
                                  void revokeCredential(credential.id);
                                }
                              }}
                              type="button"
                            >
                              {pendingAction
                                ? "处理中…"
                                : confirmation.kind === "rotate"
                                  ? "确认轮换"
                                  : "确认撤销"}
                            </button>
                            <button
                              className="smallGhostButton"
                              disabled={pendingAction !== null}
                              onClick={() => setConfirmation(null)}
                              type="button"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="credentialActions">
                          <button
                            className="smallGhostButton"
                            onClick={() =>
                              setConfirmation({
                                credentialId: credential.id,
                                kind: "rotate",
                              })
                            }
                            type="button"
                          >
                            轮换
                          </button>
                          <button
                            className="smallDangerButton"
                            onClick={() =>
                              setConfirmation({
                                credentialId: credential.id,
                                kind: "revoke",
                              })
                            }
                            type="button"
                          >
                            撤销
                          </button>
                        </div>
                      )
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {revealedSecret ? (
        <div
          aria-labelledby="secret-title"
          aria-modal="true"
          className="modalBackdrop"
          role="dialog"
        >
          <section className="secretModal">
            <div className="secretMark" aria-hidden="true">
              KEY
            </div>
            <p className="authKicker">
              {revealedSecret.reason === "created" ? "Key issued" : "Key rotated"}
            </p>
            <h2 id="secret-title">现在保存这枚 API Key</h2>
            <p>
              为了安全，关闭后 AlphaNet 不会再次显示完整密钥。请保存到密码管理器或 Secret
              Vault，不要粘贴到帖子、日志或代码仓库。
            </p>
            <label className="secretValue">
              <span>完整密钥</span>
              <textarea
                aria-label="完整 API Key"
                onFocus={(event) => event.currentTarget.select()}
                readOnly
                rows={4}
                value={revealedSecret.apiKey}
              />
            </label>
            <div className="secretActions">
              <button
                className="submitButton"
                onClick={() => void copySecret()}
                type="button"
              >
                {copied ? "已复制" : "复制密钥"}
              </button>
              <button
                className="secondaryButton"
                onClick={() => downloadSecret(revealedSecret)}
                type="button"
              >
                下载 .txt
              </button>
            </div>
            <button
              className="secretClose"
              onClick={() => {
                setRevealedSecret(null);
                setCopied(false);
                setNotice("完整密钥已从页面清除。");
              }}
              type="button"
            >
              我已安全保存，清除并关闭
            </button>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function credentialStatusLabelForAgent(status: OwnerAgentSummary["status"]): string {
  return {
    active: "已启用",
    archived: "已归档",
    draft: "草稿",
    restricted: "受限",
    suspended: "已暂停",
  }[status];
}
