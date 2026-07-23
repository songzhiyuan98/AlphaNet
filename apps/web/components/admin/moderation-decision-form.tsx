"use client";

import {
  AdminModerationDecisionRequestSchema,
  AdminModerationDecisionResponseSchema,
  V1ErrorResponseSchema,
  type AdminContentModerationAction,
  type AdminModerationDecisionResponse,
  type AdminModerationReasonCode,
  type ContentDistributionState,
  type ContentLifecycleState,
  type ModerationCaseStatus,
} from "@alphanet/contracts";
import { useEffect, useMemo, useState } from "react";

import styles from "./admin-moderation.module.css";
import {
  buildDecisionRequest,
  decisionReasons,
  moderationActionLabels,
  moderationReasonLabels,
} from "./moderation-ui";

interface ModerationRequestError {
  code: string;
  message: string;
  requestId: string | null;
  retryAfterMs: number | null;
}

export interface ModerationDecisionFormProps {
  caseId: string;
  caseVersion: number;
  canDecide: boolean;
  status: ModerationCaseStatus;
  lifecycleState: ContentLifecycleState;
  distributionState: ContentDistributionState;
  initialAttemptId: string;
  actionPath?: string;
  loginPath?: string;
  onAuthenticationRequired?: () => void;
  onConflict?: () => void;
  onDecision?: (response: AdminModerationDecisionResponse) => void;
}

function availableActions(
  status: ModerationCaseStatus,
  lifecycleState: ContentLifecycleState,
  distributionState: ContentDistributionState,
): AdminContentModerationAction[] {
  if (lifecycleState !== "published" && status !== "open" && status !== "reviewing") {
    return [];
  }

  if (status === "resolved_action") {
    return distributionState === "limited" || distributionState === "hidden"
      ? ["restore_content"]
      : [];
  }
  if (status !== "open" && status !== "reviewing") return [];

  const actions: AdminContentModerationAction[] = ["dismiss"];
  if (lifecycleState !== "published") return actions;
  if (distributionState === "normal" || distributionState === "hidden") {
    actions.push("limit_content");
  }
  if (distributionState === "normal" || distributionState === "limited") {
    actions.push("hide_content");
  }
  return actions;
}

function retryAfterFromHeaders(response: Response): number {
  const value = response.headers.get("retry-after");
  if (!value || !/^[1-9][0-9]*$/u.test(value)) return 0;
  return Number(value) * 1_000;
}

function parseRequestError(response: Response, payload: unknown): ModerationRequestError {
  const parsed = V1ErrorResponseSchema.safeParse(payload);
  const headerRetryAfter = retryAfterFromHeaders(response);
  if (parsed.success) {
    return {
      code: parsed.data.error.code,
      message: parsed.data.error.message,
      requestId: parsed.data.request_id,
      retryAfterMs: Math.max(parsed.data.error.retry_after_ms ?? 0, headerRetryAfter),
    };
  }
  return {
    code:
      response.status === 401
        ? "ADMIN_AUTHENTICATION_REQUIRED"
        : response.status === 403
          ? "ADMIN_PERMISSION_REQUIRED"
          : response.status === 429
            ? "RATE_LIMITED"
            : "ADMIN_REQUEST_FAILED",
    message: "治理请求未能完成。",
    requestId: null,
    retryAfterMs: headerRetryAfter,
  };
}

function friendlyRequestError(error: ModerationRequestError): string {
  const messages: Record<string, string> = {
    ADMIN_AUTHENTICATION_REQUIRED: "管理会话已失效，请重新完成 Workforce 登录。",
    ADMIN_PERMISSION_REQUIRED: "当前账户没有执行治理决定的权限。",
    CASE_ASSIGNMENT_CONFLICT: "案件已分配给另一位管理员。",
    CASE_NOT_ACTIONABLE: "案件状态已变化，当前不能再执行这项决定。",
    CASE_VERSION_CONFLICT: "案件已被更新，请刷新后基于最新版本重新审核。",
    CONTENT_STATE_CONFLICT: "内容状态已变化，请刷新后重新审核。",
    IDEMPOTENCY_CONFLICT: "本次提交标识与另一项决定冲突，请刷新后重试。",
    RATE_LIMITED: "治理操作过于频繁，请稍后重试。",
    VALIDATION_ERROR: "提交的治理决定不符合要求，请检查后重试。",
  };
  const base = messages[error.code] ?? error.message;
  return error.requestId ? `${base} Request ID：${error.requestId}` : base;
}

function redirectToLogin(loginPath: string): void {
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`${loginPath}?next=${encodeURIComponent(next)}`);
}

export function ModerationDecisionForm({
  caseId,
  caseVersion,
  canDecide,
  status,
  lifecycleState,
  distributionState,
  initialAttemptId,
  actionPath = `/admin/moderation/${encodeURIComponent(caseId)}/actions`,
  loginPath = "/admin/sign-in",
  onAuthenticationRequired,
  onConflict,
  onDecision,
}: ModerationDecisionFormProps) {
  const actions = useMemo(
    () => availableActions(status, lifecycleState, distributionState),
    [distributionState, lifecycleState, status],
  );
  const [action, setAction] = useState<AdminContentModerationAction>(
    actions[0] ?? "dismiss",
  );
  const [reasonCode, setReasonCode] = useState<AdminModerationReasonCode>(
    decisionReasons[actions[0] ?? "dismiss"][0],
  );
  const [internalNote, setInternalNote] = useState("");
  const [attemptId] = useState(initialAttemptId);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<AdminModerationDecisionResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [retrySeconds, setRetrySeconds] = useState(0);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (retrySeconds <= 0) return;
    const timer = window.setTimeout(() => {
      setRetrySeconds((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [retrySeconds]);

  const actionable =
    hydrated && canDecide && !permissionDenied && actions.length > 0 && success === null;
  const disabled = !actionable || pending || retrySeconds > 0;

  async function submitDecision(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;

    const request = buildDecisionRequest(action, reasonCode, internalNote);
    const parsedRequest = AdminModerationDecisionRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      setError("请选择与治理动作匹配的原因，并检查内部备注。");
      return;
    }

    setError(null);
    setPending(true);
    try {
      const response = await fetch(actionPath, {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          attempt_id: attemptId,
          case_version: caseVersion,
          decision: parsedRequest.data,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const requestError = parseRequestError(response, payload);
        if (response.status === 401) {
          if (onAuthenticationRequired) onAuthenticationRequired();
          else redirectToLogin(loginPath);
          return;
        }
        if (response.status === 409 && onConflict) onConflict();
        if (
          response.status === 403 &&
          requestError.code === "ADMIN_PERMISSION_REQUIRED"
        ) {
          setPermissionDenied(true);
        }
        if (response.status === 429) {
          setRetrySeconds(
            Math.max(1, Math.ceil((requestError.retryAfterMs ?? 1_000) / 1_000)),
          );
        }
        setError(friendlyRequestError(requestError));
        return;
      }

      const parsedResponse = AdminModerationDecisionResponseSchema.safeParse(payload);
      if (!parsedResponse.success) {
        setError("治理服务返回了无法识别的数据，请刷新案件确认实际状态。");
        return;
      }
      setSuccess(parsedResponse.data);
      onDecision?.(parsedResponse.data);
    } catch {
      setError("无法连接治理服务。提交标识已保留，可安全重试本次决定。");
    } finally {
      setPending(false);
    }
  }

  function selectAction(nextAction: AdminContentModerationAction): void {
    setAction(nextAction);
    setReasonCode(decisionReasons[nextAction][0]);
    setError(null);
  }

  return (
    <section className={styles.decisionPanel} aria-labelledby="decision-form-title">
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>Decision</p>
          <h2 id="decision-form-title">治理决定</h2>
        </div>
        <span className={styles.versionBadge}>Case v{caseVersion}</span>
      </div>

      {!canDecide ? (
        <div className={styles.permissionNotice} role="status">
          当前账户具有审核读取权限，但没有治理决定权限。
        </div>
      ) : permissionDenied ? (
        <div className={styles.permissionNotice} role="status">
          服务端确认当前账户没有治理决定权限，本页已切换为只读。
        </div>
      ) : actions.length === 0 ? (
        <div className={styles.permissionNotice} role="status">
          当前案件状态没有可执行的治理动作。
        </div>
      ) : null}

      <form aria-label="提交治理决定" onSubmit={submitDecision}>
        <fieldset disabled={!actionable || pending}>
          <legend>选择动作</legend>
          <div className={styles.actionChoices}>
            {actions.map((candidate) => (
              <label key={candidate}>
                <input
                  checked={action === candidate}
                  name="moderation_action"
                  onChange={() => selectAction(candidate)}
                  type="radio"
                  value={candidate}
                />
                <span>{moderationActionLabels[candidate]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className={styles.formField}>
          <span>决定原因</span>
          <select
            disabled={!actionable || pending}
            onChange={(event) =>
              setReasonCode(event.target.value as AdminModerationReasonCode)
            }
            value={reasonCode}
          >
            {decisionReasons[action].map((reason) => (
              <option key={reason} value={reason}>
                {moderationReasonLabels[reason]}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.formField}>
          <span>内部备注（不会向内容 Owner 展示）</span>
          <textarea
            disabled={!actionable || pending}
            maxLength={4_000}
            onChange={(event) => setInternalNote(event.target.value)}
            placeholder="记录证据判断、复核依据或交接信息"
            rows={5}
            value={internalNote}
          />
          <small>{[...internalNote].length} / 4,000</small>
        </label>

        <div className={styles.submissionMeta}>
          <span>
            版本锁 <code>&quot;{caseVersion}&quot;</code>
          </span>
          <span>
            Attempt <code>{attemptId}</code>
          </span>
        </div>

        {error ? (
          <p className={styles.errorNotice} role="alert">
            {error}
          </p>
        ) : null}
        {success ? (
          <p className={styles.successNotice} role="status">
            已执行“{moderationActionLabels[success.action.action]}”，案件更新至 v
            {success.case.case_version}。
          </p>
        ) : null}

        <div className={styles.formActions}>
          <button className={styles.primaryButton} disabled={disabled} type="submit">
            {pending
              ? "提交中…"
              : retrySeconds > 0
                ? `${retrySeconds} 秒后重试`
                : `确认${moderationActionLabels[action]}`}
          </button>
          {success || error?.includes("刷新") ? (
            <a className={styles.quietLink} href="">
              刷新案件
            </a>
          ) : null}
        </div>
      </form>
    </section>
  );
}
