import {
  ContentReportReasonSchema,
  ModerationCasePrioritySchema,
  ModerationCaseStatusSchema,
  type AdminModerationCaseListRequest,
  type AdminModerationCaseListResponse,
} from "@alphanet/contracts";
import Link from "next/link";

import styles from "./admin-moderation.module.css";
import {
  formatAdminDateTime,
  moderationPriorityLabels,
  moderationStatusLabels,
  reportReasonLabels,
} from "./moderation-ui";

export type ModerationQueueFilters = Pick<
  AdminModerationCaseListRequest,
  "content_id" | "limit" | "priorities" | "reasons" | "statuses"
>;

export interface ModerationQueueProps {
  response: AdminModerationCaseListResponse;
  filters?: ModerationQueueFilters;
  basePath?: string;
}

function appendArray(
  parameters: URLSearchParams,
  name: string,
  values: readonly string[] | undefined,
): void {
  if (values && values.length > 0) parameters.set(name, values.join(","));
}

function queueHref(
  basePath: string,
  filters: ModerationQueueFilters,
  cursor: string,
): string {
  const parameters = new URLSearchParams();
  appendArray(parameters, "statuses", filters.statuses);
  appendArray(parameters, "priorities", filters.priorities);
  appendArray(parameters, "reasons", filters.reasons);
  if (filters.content_id) parameters.set("content_id", filters.content_id);
  if (filters.limit) parameters.set("limit", String(filters.limit));
  parameters.set("cursor", cursor);
  return `${basePath}?${parameters.toString()}`;
}

export function ModerationQueue({
  response,
  filters = {},
  basePath = "/admin/moderation",
}: ModerationQueueProps) {
  return (
    <section className={styles.queueWorkspace} aria-labelledby="moderation-queue-title">
      <header className={styles.workspaceHeader}>
        <div>
          <p className={styles.eyebrow}>Moderation queue</p>
          <h1 id="moderation-queue-title">社区内容治理</h1>
          <p>按风险与报告时间排列，逐项核对内容、证据和历史处置。</p>
        </div>
        <div className={styles.snapshot}>
          <span>队列快照</span>
          <time dateTime={response.ordering.as_of}>
            {formatAdminDateTime(response.ordering.as_of)}
          </time>
        </div>
      </header>

      <form className={styles.filterPanel} action={basePath} method="get">
        <div className={styles.filterHeading}>
          <div>
            <h2>筛选案件</h2>
            <p>可多选状态、优先级与举报原因。</p>
          </div>
          <Link href={basePath}>清除筛选</Link>
        </div>
        <div className={styles.filterGrid}>
          <label>
            <span>状态</span>
            <select
              defaultValue={filters.statuses ?? []}
              multiple
              name="statuses"
              size={4}
            >
              {ModerationCaseStatusSchema.options.map((status) => (
                <option key={status} value={status}>
                  {moderationStatusLabels[status]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>优先级</span>
            <select
              defaultValue={filters.priorities ?? []}
              multiple
              name="priorities"
              size={3}
            >
              {ModerationCasePrioritySchema.options.map((priority) => (
                <option key={priority} value={priority}>
                  {moderationPriorityLabels[priority]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>举报原因</span>
            <select defaultValue={filters.reasons ?? []} multiple name="reasons" size={4}>
              {ContentReportReasonSchema.options.map((reason) => (
                <option key={reason} value={reason}>
                  {reportReasonLabels[reason]}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.filterTextFields}>
            <label>
              <span>内容 ID</span>
              <input
                defaultValue={filters.content_id ?? ""}
                name="content_id"
                placeholder="按目标内容精确查找"
                type="search"
              />
            </label>
            <label>
              <span>每页数量</span>
              <select
                defaultValue={String(filters.limit ?? response.page.limit)}
                name="limit"
              >
                {[20, 50, 100].map((limit) => (
                  <option key={limit} value={limit}>
                    {limit}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <button className={styles.primaryButton} type="submit">
          应用筛选
        </button>
      </form>

      <div className={styles.queueMeta} aria-live="polite">
        <span>本页 {response.items.length} 个案件</span>
        <span>Request ID：{response.request_id}</span>
      </div>

      {response.items.length === 0 ? (
        <div className={styles.emptyState}>
          <span aria-hidden="true">✓</span>
          <h2>当前筛选下没有案件</h2>
          <p>调整筛选条件，或稍后返回查看新报告。</p>
        </div>
      ) : (
        <ol className={styles.queueList} aria-label="治理案件队列">
          {response.items.map((item) => {
            const dominantReasons = Object.entries(item.reason_counts)
              .filter(([, count]) => count > 0)
              .sort((left, right) => right[1] - left[1])
              .slice(0, 3);
            return (
              <li key={item.case_id}>
                <Link
                  className={styles.queueItem}
                  href={`${basePath}/${encodeURIComponent(item.case_id)}`}
                >
                  <div
                    className={styles.queueRank}
                    aria-label={`队列序号 ${item.queue_rank}`}
                  >
                    {String(item.queue_rank).padStart(2, "0")}
                  </div>
                  <div className={styles.queueBody}>
                    <div className={styles.queueItemHeading}>
                      <div>
                        <span className={`${styles.stateBadge} ${styles[item.priority]}`}>
                          {moderationPriorityLabels[item.priority]}
                        </span>
                        <span className={styles.contentKind}>
                          {item.content_kind === "post" ? "帖子" : "回复"}
                        </span>
                      </div>
                      <span className={`${styles.stateBadge} ${styles[item.status]}`}>
                        {moderationStatusLabels[item.status]}
                      </span>
                    </div>
                    <strong>@{item.author.handle}</strong>
                    <code className={styles.resourceId}>{item.content_id}</code>
                    <div className={styles.reasonList}>
                      {dominantReasons.map(([reason, count]) => (
                        <span key={reason}>
                          {reportReasonLabels[reason as keyof typeof reportReasonLabels]}{" "}
                          · {count}
                        </span>
                      ))}
                    </div>
                  </div>
                  <dl className={styles.queueStats}>
                    <div>
                      <dt>报告</dt>
                      <dd>{item.report_count}</dd>
                    </div>
                    <div>
                      <dt>最近报告</dt>
                      <dd>{formatAdminDateTime(item.last_reported_at)}</dd>
                    </div>
                  </dl>
                </Link>
              </li>
            );
          })}
        </ol>
      )}

      <nav className={styles.pagination} aria-label="治理队列分页">
        <span>每页 {response.page.limit} 项</span>
        {response.page.next_cursor ? (
          <Link href={queueHref(basePath, filters, response.page.next_cursor)}>
            下一页
          </Link>
        ) : (
          <span>已到队列末尾</span>
        )}
      </nav>
    </section>
  );
}
