"use client";

import type { AdminCommunityWriteControlResponse } from "@alphanet/contracts";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import styles from "./admin-moderation.module.css";

export interface PlatformOperationsWorkspaceProps {
  response: AdminCommunityWriteControlResponse;
}

const pauseReasons = [
  ["security_incident", "安全事件"],
  ["integrity_incident", "内容完整性事件"],
  ["infrastructure_degradation", "基础设施降级"],
  ["emergency_maintenance", "紧急维护"],
] as const;

const resumeReasons = [
  ["incident_resolved", "事件已解决"],
  ["integrity_restored", "内容完整性已恢复"],
  ["infrastructure_recovered", "基础设施已恢复"],
  ["maintenance_completed", "维护已完成"],
  ["false_positive_corrected", "误报已纠正"],
] as const;

export function PlatformOperationsWorkspace({
  response,
}: PlatformOperationsWorkspaceProps) {
  const router = useRouter();
  const paused = response.control.mode === "paused";
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const data = new FormData(event.currentTarget);
    const reasonValue = data.get("reason_code");
    const resumeConditionValue = data.get("resume_condition");
    const reasonCode = typeof reasonValue === "string" ? reasonValue : "";
    const resumeCondition =
      typeof resumeConditionValue === "string" ? resumeConditionValue : "";
    const action = paused
      ? {
          action: "resume_community_writes" as const,
          reason_code: reasonCode,
        }
      : {
          action: "pause_community_writes" as const,
          reason_code: reasonCode,
          resume_condition: resumeCondition,
        };
    try {
      const result = await fetch("/admin/operations/actions", {
        body: JSON.stringify({
          action,
          attempt_id: crypto.randomUUID(),
          control_version: response.control.version,
        }),
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST",
        redirect: "error",
      });
      if (!result.ok) {
        throw new Error(
          result.status === 409
            ? "平台写入状态已变化，请刷新后重试。"
            : result.status === 403
              ? "当前 Workforce 身份没有平台操作权限。"
              : "平台操作失败，请稍后重试。",
        );
      }
      setNotice(
        paused
          ? "社区写入已恢复，操作已写入审计记录。"
          : "社区写入已暂停，读取与治理能力保持可用。",
      );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "平台操作失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.queueWorkspace}>
      <header className={styles.workspaceHeader}>
        <div>
          <p className={styles.eyebrow}>Platform Operations</p>
          <h1>平台操作</h1>
          <p>在事故或紧急维护期间统一暂停社区写入，不中断读取与治理。</p>
        </div>
        <div className={styles.snapshot}>
          <span>当前状态</span>
          <strong>{paused ? "写入已暂停" : "写入开放"}</strong>
        </div>
      </header>

      <section className={styles.communityControls}>
        <div>
          <p className={styles.eyebrow}>Community Write Control</p>
          <h2>{paused ? "恢复社区写入" : "暂停社区写入"}</h2>
          <p className={styles.communityDescription}>
            控制版本 v{response.control.version} · 最近更新{" "}
            {new Date(response.control.updated_at).toLocaleString("zh-CN")}
          </p>
          {paused ? (
            <>
              <p className={styles.inlineError}>
                暂停原因：{response.control.pause_reason_code}
              </p>
              <p className={styles.communityDescription}>
                恢复条件：{response.control.resume_condition}
              </p>
            </>
          ) : null}
          {notice ? <p className={styles.successNotice}>{notice}</p> : null}
          {error ? <p className={styles.inlineError}>{error}</p> : null}
        </div>

        <form onSubmit={submit}>
          <label className={styles.formField}>
            <span>受控原因</span>
            <select name="reason_code" required>
              {(paused ? resumeReasons : pauseReasons).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {!paused ? (
            <label className={styles.formField}>
              <span>恢复条件</span>
              <textarea
                maxLength={1000}
                minLength={1}
                name="resume_condition"
                placeholder="描述恢复写入前必须满足并验证的条件"
                required
                rows={4}
              />
            </label>
          ) : null}
          <button className={styles.dangerAction} disabled={busy} type="submit">
            {busy ? "提交中…" : paused ? "确认恢复写入" : "确认暂停写入"}
          </button>
        </form>
      </section>
    </main>
  );
}
