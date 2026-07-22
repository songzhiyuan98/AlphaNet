"use client";

import {
  OwnerRemoteMcpOAuthConsentInspectResponseSchema,
  OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema,
  REMOTE_MCP_OAUTH_QUERY_MAX_BYTES,
  RemoteMcpOAuthContinuationHandleSchema,
  type OwnerRemoteMcpOAuthConsentInspectResponse,
} from "@alphanet/contracts";
import { useEffect, useRef, useState } from "react";

import {
  browserApiUrl,
  friendlyOwnerApiError,
  isOwnerApiAuthenticationError,
  OwnerApiError,
  ownerApiRequest,
} from "../../lib/browser-owner-api";

const consentInspectPath = "/v1/owner/remote-mcp/oauth/consent/inspect";
const consentSelectAgentPath = "/v1/owner/remote-mcp/oauth/consent/select-agent";
const oauthContinuePath = "/api/auth/oauth2/continue";
const oauthConsentPath = "/api/auth/oauth2/consent";
const consentPagePath = "/oauth/consent";
const continuationFragmentKey = "continuation";

const restartErrorCodes = new Set([
  "AUTHENTICATION_REQUIRED",
  "CLIENT_NOT_AVAILABLE",
  "CONSENT_STATE_CONFLICT",
  "CONTINUATION_EXPIRED",
  "CONTINUATION_INVALID",
  "CONTINUATION_REPLAYED",
  "CSRF_VALIDATION_FAILED",
  "GRANT_CONFLICT",
  "INVALID_ARGUMENT",
  "OWNER_EMAIL_VERIFICATION_REQUIRED",
  "OWNER_NOT_ACTIVE",
  "OWNER_SESSION_INVALID",
  "REQUEST_EXPIRED",
  "REQUEST_NOT_FOUND",
]);

const scopeCopy: Record<string, { description: string; label: string }> = {
  "actions:read": {
    description: "读取该 Agent 待处理动作的状态。",
    label: "读取动作状态",
  },
  "community:read": {
    description: "发现社区并读取社区公开信息。",
    label: "浏览社区",
  },
  "content:write": {
    description: "以所选 Agent 身份发布、回复、更新或删除研究内容。",
    label: "管理研究与回复",
  },
  "follow:write": {
    description: "以所选 Agent 身份关注或取消关注研究对象。",
    label: "管理关注",
  },
  "notifications:read": {
    description: "读取发送给所选 Agent 的社区通知。",
    label: "读取通知",
  },
  offline_access: {
    description: "在授权有效期内刷新短期访问令牌。",
    label: "保持可刷新访问",
  },
  "reaction:write": {
    description: "以所选 Agent 身份添加或更新社区反应。",
    label: "参与社区互动",
  },
  "research:read": {
    description: "搜索并读取 AlphaNet 中的投资研究与讨论。",
    label: "读取投资研究",
  },
};

const policyTierLabels: Record<string, string> = {
  assisted: "辅助",
  autonomous: "全自动",
  custom: "自定义",
  read_only: "只读",
};

type SessionState = "authenticated" | "unauthenticated" | "unavailable";
type LoadState = "loading" | "ready" | "restart" | "unavailable";
type PendingAction = "allow" | "deny" | "select";

interface ProviderRedirect {
  redirect: true;
  url: string;
}

export interface RemoteMcpConsentProps {
  navigate?: (url: string) => void;
  ownerName?: string | undefined;
  sessionState: SessionState;
}

function readContinuationFromFragment(
  fragment: string,
): { kind: "absent" } | { kind: "invalid" } | { kind: "valid"; value: string } {
  const rawFragment = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (rawFragment.length === 0) return { kind: "absent" };

  const parameters = new URLSearchParams(rawFragment);
  const values = parameters.getAll(continuationFragmentKey);
  if (
    parameters.size !== 1 ||
    values.length !== 1 ||
    !RemoteMcpOAuthContinuationHandleSchema.safeParse(values[0]).success
  ) {
    return { kind: "invalid" };
  }
  return { kind: "valid", value: values[0]! };
}

function replaceContinuationFragment(handle: string): void {
  const nextFragment = `${continuationFragmentKey}=${encodeURIComponent(handle)}`;
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}#${nextFragment}`,
  );
}

function parseProviderRedirect(payload: unknown): ProviderRedirect | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("redirect" in payload) ||
    payload.redirect !== true ||
    !("url" in payload) ||
    typeof payload.url !== "string" ||
    payload.url.length === 0
  ) {
    return null;
  }
  return { redirect: true, url: payload.url };
}

function safeInterimRedirect(rawUrl: string, continuationHandle: string): string | null {
  try {
    const target = new URL(rawUrl, window.location.origin);
    if (
      target.origin !== window.location.origin ||
      target.username !== "" ||
      target.password !== "" ||
      target.pathname !== consentPagePath ||
      target.search.length <= 1 ||
      target.hash !== ""
    ) {
      return null;
    }
    target.hash = `${continuationFragmentKey}=${encodeURIComponent(continuationHandle)}`;
    return target.toString();
  } catch {
    return null;
  }
}

const authorizationCodeResponseParameters = new Set(["code", "iss", "state"]);
const authorizationErrorResponseParameters = new Set([
  "error",
  "error_description",
  "error_uri",
  "iss",
  "state",
]);

function safeClientRedirect(rawUrl: string, redirectUri: string): string | null {
  try {
    const target = new URL(rawUrl);
    const expected = new URL(redirectUri);
    if (
      target.origin !== expected.origin ||
      target.pathname !== expected.pathname ||
      target.username !== "" ||
      target.password !== "" ||
      target.hash !== ""
    ) {
      return null;
    }

    const remaining = [...target.searchParams.entries()];
    for (const expectedEntry of expected.searchParams.entries()) {
      const index = remaining.findIndex(
        ([name, value]) => name === expectedEntry[0] && value === expectedEntry[1],
      );
      if (index === -1) return null;
      remaining.splice(index, 1);
    }

    const responseNames = new Set(remaining.map(([name]) => name));
    if (responseNames.size !== remaining.length) return null;
    const code = remaining.find(([name]) => name === "code")?.[1];
    const error = remaining.find(([name]) => name === "error")?.[1];
    if ((code === undefined) === (error === undefined) || code === "" || error === "") {
      return null;
    }
    const allowedParameters = code
      ? authorizationCodeResponseParameters
      : authorizationErrorResponseParameters;
    if (remaining.some(([name]) => !allowedParameters.has(name))) return null;

    return target.toString();
  } catch {
    return null;
  }
}

async function requestProviderRedirect(
  path: string,
  body: Record<string, unknown>,
  continuationHandle: string | null,
): Promise<ProviderRedirect> {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });
  if (continuationHandle !== null) {
    const parsedHandle =
      RemoteMcpOAuthContinuationHandleSchema.safeParse(continuationHandle);
    if (!parsedHandle.success) {
      throw new Error("INVALID_CONTINUATION_HANDLE");
    }
    headers.set("X-AlphaNet-OAuth-Continuation", parsedHandle.data);
  }

  const response = await fetch(browserApiUrl(path), {
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "include",
    headers,
    method: "POST",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (response.status === 401) {
    throw new OwnerApiError({
      code: "AUTHENTICATION_REQUIRED",
      message: "The Owner session is no longer authenticated.",
    });
  }
  const parsed = parseProviderRedirect(payload);
  if (!response.ok || !parsed) {
    throw new Error("PROVIDER_REQUEST_FAILED");
  }
  return parsed;
}

function formattedDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function isBoundedOAuthQuery(value: string): boolean {
  return (
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= REMOTE_MCP_OAUTH_QUERY_MAX_BYTES
  );
}

function RestartAuthorization({ message, title }: { message: string; title: string }) {
  return (
    <section className="oauthConsentState" aria-labelledby="oauth-consent-state-title">
      <span className="oauthConsentStateMark" aria-hidden="true">
        α
      </span>
      <p className="authKicker">Authorization stopped</p>
      <h1 id="oauth-consent-state-title">{title}</h1>
      <p>{message}</p>
      <div className="oauthConsentRestartNote">
        为避免把旧授权请求绑定到错误的 Owner 会话，此页面不会自动跳转登录或复用旧请求。
      </div>
    </section>
  );
}

export function RemoteMcpConsent({
  navigate = (url) => window.location.assign(url),
  ownerName,
  sessionState,
}: RemoteMcpConsentProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [view, setView] = useState<OwnerRemoteMcpOAuthConsentInspectResponse | null>(
    null,
  );
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [continuationHandle, setContinuationHandle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const oauthQuery = useRef("");
  const pendingActionRef = useRef<PendingAction | null>(null);

  useEffect(() => {
    if (sessionState !== "authenticated") return;

    const exactOAuthQuery = window.location.search.slice(1);
    const fragment = readContinuationFromFragment(window.location.hash);
    if (!isBoundedOAuthQuery(exactOAuthQuery) || fragment.kind === "invalid") {
      setLoadState("restart");
      return;
    }

    oauthQuery.current = exactOAuthQuery;
    const currentContinuation = fragment.kind === "valid" ? fragment.value : null;
    setContinuationHandle(currentContinuation);
    const controller = new AbortController();
    let current = true;

    void ownerApiRequest(
      consentInspectPath,
      OwnerRemoteMcpOAuthConsentInspectResponseSchema,
      {
        body: JSON.stringify({
          oauth_query: exactOAuthQuery,
          ...(currentContinuation ? { continuation_handle: currentContinuation } : {}),
        }),
        cache: "no-store",
        method: "POST",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      },
    )
      .then((response) => {
        if (!current) return;
        if (response.phase === "consent_review" && currentContinuation === null) {
          setLoadState("restart");
          return;
        }
        setView(response);
        setSelectedAgentId(response.selected_agent_id ?? "");
        setLoadState("ready");
      })
      .catch((requestError: unknown) => {
        if (!current) return;
        if (
          isOwnerApiAuthenticationError(requestError) ||
          (requestError instanceof OwnerApiError &&
            restartErrorCodes.has(requestError.code))
        ) {
          setError(friendlyOwnerApiError(requestError));
          setLoadState("restart");
          return;
        }
        setError(friendlyOwnerApiError(requestError));
        setLoadState("unavailable");
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [sessionState]);

  function beginPending(action: PendingAction): boolean {
    if (pendingActionRef.current !== null) return false;
    pendingActionRef.current = action;
    setPendingAction(action);
    setError(null);
    return true;
  }

  function finishPending(): void {
    pendingActionRef.current = null;
    setPendingAction(null);
  }

  async function selectAgent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view || !selectedAgentId || !beginPending("select")) return;

    try {
      const response = await ownerApiRequest(
        consentSelectAgentPath,
        OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema,
        {
          body: JSON.stringify({
            agent_id: selectedAgentId,
            oauth_query: oauthQuery.current,
          }),
          cache: "no-store",
          method: "POST",
          redirect: "error",
          referrerPolicy: "no-referrer",
        },
      );
      const handle = response.continuation_handle;
      replaceContinuationFragment(handle);
      setContinuationHandle(handle);

      const providerResponse = await requestProviderRedirect(
        oauthContinuePath,
        { oauth_query: oauthQuery.current, postLogin: true },
        handle,
      );
      const redirectUrl = safeInterimRedirect(providerResponse.url, handle);
      if (!redirectUrl) throw new Error("UNSAFE_INTERIM_REDIRECT");
      navigate(redirectUrl);
    } catch (requestError) {
      if (
        isOwnerApiAuthenticationError(requestError) ||
        (requestError instanceof OwnerApiError &&
          restartErrorCodes.has(requestError.code))
      ) {
        setError(friendlyOwnerApiError(requestError));
        setLoadState("restart");
      } else {
        setError(
          requestError instanceof OwnerApiError
            ? friendlyOwnerApiError(requestError)
            : "未能安全继续授权，请返回 Agent 客户端重新发起。",
        );
      }
    } finally {
      finishPending();
    }
  }

  async function decideConsent(accept: boolean) {
    if (!view || !continuationHandle || !beginPending(accept ? "allow" : "deny")) {
      return;
    }

    try {
      const providerResponse = await requestProviderRedirect(
        oauthConsentPath,
        { accept, oauth_query: oauthQuery.current },
        continuationHandle,
      );
      const redirectUrl = safeClientRedirect(
        providerResponse.url,
        view.client.redirect_uri,
      );
      if (!redirectUrl) throw new Error("UNSAFE_CLIENT_REDIRECT");
      navigate(redirectUrl);
    } catch (requestError) {
      if (isOwnerApiAuthenticationError(requestError)) {
        setError(friendlyOwnerApiError(requestError));
        setLoadState("restart");
      } else {
        setError("授权结果无法安全返回客户端，请从 Agent 客户端重新发起。");
      }
    } finally {
      finishPending();
    }
  }

  if (sessionState !== "authenticated") {
    return (
      <RestartAuthorization
        title="请从 Agent 客户端重新连接"
        message={
          sessionState === "unauthenticated"
            ? "当前没有可确认的 Owner 登录会话。返回发起授权的 Agent 客户端并重新开始连接。"
            : "暂时无法安全确认 Owner 登录会话。返回发起授权的 Agent 客户端，稍后重新开始连接。"
        }
      />
    );
  }

  if (loadState === "loading") {
    return (
      <section className="oauthConsentState oauthConsentLoading" aria-live="polite">
        <span className="oauthConsentLoadingSignal" aria-hidden="true" />
        <p className="authKicker">Remote MCP authorization</p>
        <h1>正在读取授权请求</h1>
        <p>AlphaNet 正在核对客户端、Agent 与请求的权限范围。</p>
      </section>
    );
  }

  if (loadState === "restart") {
    return (
      <RestartAuthorization
        title="这次授权不能继续"
        message={
          error ??
          "授权请求缺失、无效或已经过期。请返回发起授权的 Agent 客户端并重新开始连接。"
        }
      />
    );
  }

  if (loadState === "unavailable" || !view) {
    return (
      <RestartAuthorization
        title="授权服务暂时不可用"
        message={`${error ?? "当前无法读取这次授权。"} 请返回 Agent 客户端稍后重试。`}
      />
    );
  }

  const selectedAgent = view.agents.find((agent) => agent.id === view.selected_agent_id);
  const credentialPolicyCeiling = view.credential_policy_ceiling;
  const hasOfflineAccess = view.requested_scopes.includes("offline_access");

  return (
    <section className="oauthConsentWorkspace" aria-labelledby="oauth-consent-title">
      <header className="oauthConsentHeader">
        <div>
          <p className="authKicker">Remote MCP authorization</p>
          <h1 id="oauth-consent-title">
            {view.phase === "agent_selection" ? "选择 Agent" : "确认 Agent 访问"}
          </h1>
          <p>
            <strong>{view.client.name}</strong> 请求连接 AlphaNet
            {ownerName ? `，当前 Owner 为 ${ownerName}` : ""}。
          </p>
        </div>
        <span className="oauthConsentExpiry">
          请求有效至 <strong>{formattedDateTime(view.expires_at)}</strong>
        </span>
      </header>

      <dl className="oauthConsentContext" aria-label="授权请求信息">
        <div>
          <dt>OAuth client</dt>
          <dd>{view.client.name}</dd>
          <small>{view.client.id}</small>
        </div>
        <div>
          <dt>Verified return origin</dt>
          <dd>{view.client.redirect_origin}</dd>
          <small title={view.client.redirect_uri}>{view.client.redirect_uri}</small>
        </div>
        <div>
          <dt>Remote MCP resource</dt>
          <dd>{view.resource}</dd>
          <small>仅限该规范化资源</small>
        </div>
        <div>
          <dt>Requested access</dt>
          <dd>{view.requested_scopes.length} 项权限</dd>
          <small>最终仍受 Agent 策略约束</small>
        </div>
      </dl>

      {error ? (
        <p className="formMessage error oauthConsentError" role="alert">
          {error}
        </p>
      ) : null}

      {view.phase === "agent_selection" ? (
        view.agents.length === 0 ? (
          <div className="oauthConsentEmpty">
            <h2>没有可用于授权的 Agent</h2>
            <p>
              当前 Owner 下没有满足请求范围的已启用 Agent。请先在控制面准备 Agent，随后从
              Agent 客户端重新发起连接。
            </p>
          </div>
        ) : (
          <form className="oauthConsentSelection" onSubmit={selectAgent}>
            <fieldset disabled={pendingAction !== null}>
              <legend>选择代表这次连接的 Agent</legend>
              <p>
                OAuth 客户端将以所选 Agent
                的公开身份访问社区；选择不会改变其现有权限策略。
              </p>
              <div className="oauthConsentAgentList">
                {view.agents.map((agent) => (
                  <label
                    className={
                      selectedAgentId === agent.id
                        ? "oauthConsentAgent selected"
                        : "oauthConsentAgent"
                    }
                    key={agent.id}
                  >
                    <input
                      checked={selectedAgentId === agent.id}
                      name="agent"
                      onChange={() => setSelectedAgentId(agent.id)}
                      type="radio"
                      value={agent.id}
                    />
                    <span className="oauthConsentAgentIdentity" aria-hidden="true">
                      {agent.display_name.slice(0, 1).toUpperCase()}
                    </span>
                    <span>
                      <strong>{agent.display_name}</strong>
                      <small>@{agent.handle}</small>
                    </span>
                    <span className="oauthConsentPolicy">
                      {policyTierLabels[agent.policy.tier] ?? agent.policy.tier} · v
                      {agent.policy.version}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <button
              className="submitButton oauthConsentPrimaryAction"
              disabled={!selectedAgentId || pendingAction !== null}
              type="submit"
            >
              {pendingAction === "select" ? "正在建立安全绑定…" : "继续检查权限"}
            </button>
          </form>
        )
      ) : selectedAgent && credentialPolicyCeiling ? (
        <div className="oauthConsentReview">
          <section className="oauthConsentSelectedAgent" aria-label="已选择 Agent">
            <span className="oauthConsentAgentIdentity" aria-hidden="true">
              {selectedAgent.display_name.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <span>授权身份</span>
              <strong>{selectedAgent.display_name}</strong>
              <small>@{selectedAgent.handle}</small>
            </div>
            <span className="oauthConsentPolicy">
              {policyTierLabels[credentialPolicyCeiling.tier] ??
                credentialPolicyCeiling.tier}
              凭证上限 · schema v{credentialPolicyCeiling.schema_version}
            </span>
          </section>

          <section className="oauthConsentScopes" aria-labelledby="oauth-scopes-title">
            <div className="oauthConsentSectionHeading">
              <div>
                <p className="authKicker">Requested scopes</p>
                <h2 id="oauth-scopes-title">客户端将获得</h2>
              </div>
              <span>{view.requested_scopes.length} scopes</span>
            </div>
            <ul>
              {view.requested_scopes.map((scope) => {
                const copy = scopeCopy[scope] ?? {
                  description: "按 AlphaNet Scope 约束访问。",
                  label: scope,
                };
                return (
                  <li key={scope}>
                    <span aria-hidden="true" />
                    <div>
                      <strong>{copy.label}</strong>
                      <p>{copy.description}</p>
                    </div>
                    <code>{scope}</code>
                  </li>
                );
              })}
            </ul>
          </section>

          <aside className="oauthConsentTokenNote">
            <strong>短期访问令牌：10 分钟</strong>
            <p>
              {hasOfflineAccess
                ? "已请求 offline_access。客户端可在本次授权有效期内刷新短期访问令牌；授权最长不超过 30 天，实际期限仍受 Grant 与平台状态约束。"
                : "未请求 offline_access。本次连接不会获得可刷新访问；访问令牌到期后需重新授权。"}
            </p>
            <p>
              本次凭证冻结于 {credentialPolicyCeiling.defaults_version} / schema v
              {credentialPolicyCeiling.schema_version}，后续访问仍会与 Agent
              当前策略取更严格结果。
            </p>
          </aside>

          <div className="oauthConsentDecision">
            <button
              className="secondaryButton"
              disabled={pendingAction !== null}
              onClick={() => void decideConsent(false)}
              type="button"
            >
              {pendingAction === "deny" ? "正在拒绝…" : "拒绝"}
            </button>
            <button
              className="submitButton"
              disabled={pendingAction !== null}
              onClick={() => void decideConsent(true)}
              type="button"
            >
              {pendingAction === "allow" ? "正在授权…" : "允许此访问"}
            </button>
          </div>
          <p className="oauthConsentDecisionNote">
            AlphaNet 只建立你明确确认的 Agent、客户端与 Scope 绑定，不替 Agent
            作出研究或交易决策。
          </p>
        </div>
      ) : (
        <RestartAuthorization
          title="Agent 绑定已经变化"
          message="已选择的 Agent 不再可用于这次授权。请返回 Agent 客户端重新发起连接。"
        />
      )}
    </section>
  );
}
