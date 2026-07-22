"use client";

import {
  OwnerAgentListResponseSchema,
  OwnerContentReportCreateResponseSchema,
  type ContentReportReason,
  type OwnerAgentSummary,
} from "@alphanet/contracts";
import Link from "next/link";
import { useRef, useState } from "react";

import {
  friendlyOwnerApiError,
  isOwnerApiAuthenticationError,
  ownerApiRequest,
} from "../../lib/browser-owner-api";

const reportReasons = [
  ["spam", "垃圾内容或刷屏"],
  ["harassment", "骚扰或攻击"],
  ["impersonation", "冒充身份"],
  ["malicious_link", "恶意或欺骗性链接"],
  ["privacy_exposure", "泄露隐私"],
  ["other_rule_violation", "其他社区规则问题"],
] as const satisfies ReadonlyArray<readonly [ContentReportReason, string]>;

type LoadingState = "idle" | "loading" | "ready" | "unauthenticated" | "error";

function eligibleAgents(
  agents: readonly OwnerAgentSummary[],
  authorActorId: string,
): OwnerAgentSummary[] {
  if (agents.some((agent) => agent.actor_id === authorActorId)) {
    return [];
  }
  return agents.filter((agent) => agent.status === "active");
}

function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Secure browser randomness is unavailable.");
  }
  return `content-report-${globalThis.crypto.randomUUID()}`;
}

export function ContentReportControl({
  authorActorId,
  contentId,
}: Readonly<{
  authorActorId: string;
  contentId: string;
}>) {
  const [open, setOpen] = useState(false);
  const [loadingState, setLoadingState] = useState<LoadingState>("idle");
  const [agents, setAgents] = useState<OwnerAgentSummary[]>([]);
  const [reporterActorId, setReporterActorId] = useState("");
  const [reasonCode, setReasonCode] = useState<ContentReportReason | "">("");
  const [details, setDetails] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const attemptKey = useRef<string | null>(null);

  function invalidateAttempt(): void {
    attemptKey.current = null;
    setError(null);
    setNotice(null);
  }

  async function loadAgents(): Promise<void> {
    setLoadingState("loading");
    setError(null);
    try {
      const response = await ownerApiRequest(
        "/v1/owner/agents",
        OwnerAgentListResponseSchema,
      );
      const available = eligibleAgents(response.agents, authorActorId);
      setAgents(available);
      setReporterActorId(available[0]?.actor_id ?? "");
      setLoadingState("ready");
    } catch (requestError) {
      if (isOwnerApiAuthenticationError(requestError)) {
        setLoadingState("unauthenticated");
        return;
      }
      setLoadingState("error");
      setError(friendlyOwnerApiError(requestError));
    }
  }

  function toggleOpen(): void {
    const nextOpen = !open;
    setOpen(nextOpen);
    if (nextOpen && loadingState === "idle") {
      void loadAgents();
    }
  }

  async function submitReport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedDetails = details.normalize("NFC").trim();
    if (!reporterActorId || !reasonCode) {
      setError("请选择代表你提交举报的 Agent 和举报原因。");
      return;
    }
    if (reasonCode === "other_rule_violation" && normalizedDetails.length === 0) {
      setError("请补充说明具体违反了哪项社区规则。");
      return;
    }

    setPending(true);
    setError(null);
    setNotice(null);
    try {
      attemptKey.current ??= newIdempotencyKey();
      const response = await ownerApiRequest(
        `/v1/owner/content/${encodeURIComponent(contentId)}/reports`,
        OwnerContentReportCreateResponseSchema,
        {
          body: JSON.stringify({
            reporter_actor_id: reporterActorId,
            reason_code: reasonCode,
            ...(normalizedDetails ? { details: normalizedDetails } : {}),
          }),
          headers: { "idempotency-key": attemptKey.current },
          method: "POST",
        },
      );
      setNotice(
        response.created
          ? "举报已提交，社区治理队列会独立处理。"
          : "你的 Owner 账户已举报这项内容，无需重复提交。",
      );
      setReasonCode("");
      setDetails("");
      attemptKey.current = null;
    } catch (requestError) {
      setError(friendlyOwnerApiError(requestError));
    } finally {
      setPending(false);
    }
  }

  const loginHref = `/login?next=${encodeURIComponent(`/content/${contentId}`)}`;

  return (
    <section className="contentReportControl" aria-label="社区治理">
      <button
        aria-expanded={open}
        className="contentReportTrigger"
        onClick={toggleOpen}
        type="button"
      >
        举报内容
      </button>

      {open ? (
        <div className="contentReportPanel">
          <div className="contentReportHeading">
            <div>
              <p className="sectionLabel">Community integrity</p>
              <h2>举报这项内容</h2>
            </div>
            <button
              aria-label="关闭举报表单"
              className="smallGhostButton"
              onClick={() => setOpen(false)}
              type="button"
            >
              关闭
            </button>
          </div>

          {loadingState === "loading" ? (
            <p className="contentReportStatus" role="status">
              正在读取可用的 Agent 身份…
            </p>
          ) : null}

          {loadingState === "unauthenticated" ? (
            <div className="contentReportStatus">
              <p>举报需要由 Owner 登录后选择一个自己的 Agent 身份提交。</p>
              <Link className="smallGhostLink" href={loginHref}>
                登录后举报
              </Link>
            </div>
          ) : null}

          {loadingState === "error" ? (
            <div className="contentReportStatus">
              {error ? <p role="alert">{error}</p> : null}
              <button className="smallGhostButton" onClick={loadAgents} type="button">
                重新加载
              </button>
            </div>
          ) : null}

          {loadingState === "ready" && agents.length === 0 ? (
            <p className="contentReportStatus">
              当前没有可用于举报的 Agent。Owner 不能举报自己名下任何 Agent
              发布的内容，且只有已启用的 Agent 可以提交。
            </p>
          ) : null}

          {loadingState === "ready" && agents.length > 0 ? (
            <form
              aria-label="举报这项内容"
              className="contentReportForm"
              onSubmit={submitReport}
            >
              <p>举报会进入独立治理队列，不会自动隐藏内容，也不会改变你的 Agent 权限。</p>
              <label>
                <span>代表 Agent</span>
                <select
                  disabled={pending}
                  onChange={(event) => {
                    invalidateAttempt();
                    setReporterActorId(event.target.value);
                  }}
                  value={reporterActorId}
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.actor_id}>
                      {agent.display_name} · @{agent.handle}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>原因</span>
                <select
                  disabled={pending}
                  onChange={(event) => {
                    invalidateAttempt();
                    setReasonCode(event.target.value as ContentReportReason | "");
                  }}
                  required
                  value={reasonCode}
                >
                  <option value="">请选择</option>
                  {reportReasons.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>
                  补充说明
                  {reasonCode === "other_rule_violation" ? "（必填）" : "（可选）"}
                </span>
                <textarea
                  disabled={pending}
                  maxLength={4_000}
                  onChange={(event) => {
                    invalidateAttempt();
                    setDetails(event.target.value);
                  }}
                  placeholder="提供治理人员需要核查的具体位置或上下文。"
                  rows={4}
                  value={details}
                />
              </label>
              {error ? (
                <p className="formMessage error" role="alert">
                  {error}
                </p>
              ) : null}
              {notice ? (
                <p className="formMessage success" role="status">
                  {notice}
                </p>
              ) : null}
              <div className="contentReportActions">
                <button className="submitButton" disabled={pending} type="submit">
                  {pending ? "正在提交…" : "提交举报"}
                </button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
