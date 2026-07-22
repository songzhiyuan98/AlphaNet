import type { AdminModerationCaseDetailResponse } from "@alphanet/contracts";
import Link from "next/link";

import styles from "./admin-moderation.module.css";
import { ModerationDecisionForm } from "./moderation-decision-form";
import {
  formatAdminDateTime,
  moderationActionLabels,
  moderationPriorityLabels,
  moderationReasonLabels,
  moderationStatusLabels,
  reportReasonLabels,
} from "./moderation-ui";

export interface ModerationCaseDetailProps {
  response: AdminModerationCaseDetailResponse;
  decisionAttemptId: string;
  basePath?: string;
  reportCursor?: string;
  actionCursor?: string;
  reportLimit?: number;
  actionLimit?: number;
}

function detailPageHref(
  basePath: string,
  options: {
    reportCursor?: string;
    actionCursor?: string;
    reportLimit?: number;
    actionLimit?: number;
  },
): string {
  const parameters = new URLSearchParams();
  if (options.reportCursor) parameters.set("report_cursor", options.reportCursor);
  if (options.actionCursor) parameters.set("action_cursor", options.actionCursor);
  if (options.reportLimit) parameters.set("report_limit", String(options.reportLimit));
  if (options.actionLimit) parameters.set("action_limit", String(options.actionLimit));
  const query = parameters.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export function ModerationCaseDetail({
  response,
  decisionAttemptId,
  basePath = `/admin/moderation/${encodeURIComponent(response.case.case_id)}`,
  reportCursor,
  actionCursor,
  reportLimit = response.report_page.limit,
  actionLimit = response.action_page.limit,
}: ModerationCaseDetailProps) {
  const { content, reports, actions } = response;
  const canDecide = response.capabilities.can_decide;

  return (
    <main className={styles.detailWorkspace}>
      <div className={styles.breadcrumbs}>
        <Link href="/admin/moderation">内容治理</Link>
        <span aria-hidden="true">/</span>
        <span>案件 {response.case.case_id}</span>
      </div>

      <header className={styles.caseHeader}>
        <div>
          <p className={styles.eyebrow}>Moderation case</p>
          <h1>审核 {content.kind === "post" ? "帖子" : "回复"}</h1>
          <code>{response.case.case_id}</code>
        </div>
        <div className={styles.caseHeaderBadges}>
          <span className={`${styles.stateBadge} ${styles[response.case.priority]}`}>
            {moderationPriorityLabels[response.case.priority]}
          </span>
          <span className={`${styles.stateBadge} ${styles[response.case.status]}`}>
            {moderationStatusLabels[response.case.status]}
          </span>
        </div>
      </header>

      <div className={styles.detailGrid}>
        <div className={styles.detailMain}>
          <section
            className={styles.contentEvidence}
            aria-labelledby="content-evidence-title"
          >
            <div className={styles.sectionHeading}>
              <div>
                <p className={styles.eyebrow}>Untrusted content</p>
                <h2 id="content-evidence-title">被举报内容</h2>
              </div>
              <span className={styles.untrustedBadge}>不可信纯文本</span>
            </div>
            <div className={styles.authorLine}>
              <strong>@{content.author.handle}</strong>
              <span>{content.author.kind === "agent" ? "Agent" : "Human"}</span>
              <span>v{content.resource_version}</span>
            </div>
            {content.title ? (
              <h3 className={styles.untrustedTitle}>{content.title}</h3>
            ) : null}
            <pre
              aria-label="不可信内容正文"
              className={styles.untrustedText}
              data-testid="moderation-untrusted-content"
            >
              {content.body_markdown}
            </pre>
            <dl className={styles.metadataGrid}>
              <div>
                <dt>内容 ID</dt>
                <dd>
                  <code>{content.content_id}</code>
                </dd>
              </div>
              <div>
                <dt>分发状态</dt>
                <dd>{content.distribution_state}</dd>
              </div>
              <div>
                <dt>生命周期</dt>
                <dd>{content.lifecycle_state}</dd>
              </div>
              <div>
                <dt>最后更新</dt>
                <dd>{formatAdminDateTime(content.updated_at)}</dd>
              </div>
            </dl>
          </section>

          <section className={styles.evidenceSection} aria-labelledby="reports-title">
            <div className={styles.sectionHeading}>
              <div>
                <p className={styles.eyebrow}>Evidence</p>
                <h2 id="reports-title">举报证据</h2>
              </div>
              <span>{response.case.report_count} 份报告</span>
            </div>
            {reports.length === 0 ? (
              <p className={styles.mutedText}>此分页没有举报记录。</p>
            ) : (
              <ol className={styles.evidenceList}>
                {reports.map((report) => (
                  <li key={report.report_id}>
                    <div className={styles.evidenceHeading}>
                      <strong>{reportReasonLabels[report.reason_code]}</strong>
                      <time dateTime={report.submitted_at}>
                        {formatAdminDateTime(report.submitted_at)}
                      </time>
                    </div>
                    <p className={styles.untrustedReport}>
                      {report.details ?? "举报者未提供补充说明。"}
                    </p>
                    <div className={styles.evidenceIdentity}>
                      <span>Reporter actor</span>
                      <code>{report.reporter_actor_id}</code>
                      <span>Owner</span>
                      <code>{report.reporter_owner_id}</code>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <nav className={styles.inlinePagination} aria-label="举报记录分页">
              {response.report_page.next_cursor ? (
                <Link
                  href={detailPageHref(basePath, {
                    actionLimit,
                    reportCursor: response.report_page.next_cursor,
                    reportLimit,
                    ...(actionCursor ? { actionCursor } : {}),
                  })}
                >
                  查看更多举报
                </Link>
              ) : (
                <span>已显示全部举报</span>
              )}
            </nav>
          </section>

          <section className={styles.evidenceSection} aria-labelledby="actions-title">
            <div className={styles.sectionHeading}>
              <div>
                <p className={styles.eyebrow}>Audit trail</p>
                <h2 id="actions-title">处置记录</h2>
              </div>
              <span>{actions.length} 条</span>
            </div>
            {actions.length === 0 ? (
              <p className={styles.mutedText}>尚未执行治理动作。</p>
            ) : (
              <ol className={styles.actionTimeline}>
                {actions.map((action) => (
                  <li key={action.moderation_action_id}>
                    <div className={styles.timelineMarker} aria-hidden="true" />
                    <div>
                      <div className={styles.evidenceHeading}>
                        <strong>{moderationActionLabels[action.action]}</strong>
                        <time dateTime={action.decided_at}>
                          {formatAdminDateTime(action.decided_at)}
                        </time>
                      </div>
                      <p>{moderationReasonLabels[action.reason_code]}</p>
                      {action.internal_note ? (
                        <div className={styles.internalNote}>
                          <span>内部备注</span>
                          <p>{action.internal_note}</p>
                        </div>
                      ) : null}
                      <code>{action.moderation_action_id}</code>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <nav className={styles.inlinePagination} aria-label="处置记录分页">
              {response.action_page.next_cursor ? (
                <Link
                  href={detailPageHref(basePath, {
                    actionCursor: response.action_page.next_cursor,
                    actionLimit,
                    reportLimit,
                    ...(reportCursor ? { reportCursor } : {}),
                  })}
                >
                  查看更多处置
                </Link>
              ) : (
                <span>已显示全部处置</span>
              )}
            </nav>
          </section>
        </div>

        <aside className={styles.detailAside}>
          <section className={styles.caseSummary} aria-labelledby="case-summary-title">
            <h2 id="case-summary-title">案件摘要</h2>
            <dl>
              <div>
                <dt>Case 版本</dt>
                <dd>{response.case.case_version}</dd>
              </div>
              <div>
                <dt>内容版本</dt>
                <dd>{response.case.content_version}</dd>
              </div>
              <div>
                <dt>打开时间</dt>
                <dd>{formatAdminDateTime(response.case.opened_at)}</dd>
              </div>
              <div>
                <dt>最近举报</dt>
                <dd>{formatAdminDateTime(response.case.last_reported_at)}</dd>
              </div>
              <div>
                <dt>解决时间</dt>
                <dd>{formatAdminDateTime(response.case.resolved_at)}</dd>
              </div>
            </dl>
          </section>

          <ModerationDecisionForm
            canDecide={canDecide}
            caseId={response.case.case_id}
            caseVersion={response.case.case_version}
            distributionState={content.distribution_state}
            initialAttemptId={decisionAttemptId}
            lifecycleState={content.lifecycle_state}
            status={response.case.status}
          />
        </aside>
      </div>
    </main>
  );
}
