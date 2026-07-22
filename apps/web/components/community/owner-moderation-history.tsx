import type { OwnerContentModerationListResponse } from "@alphanet/contracts";
import Link from "next/link";

const actionLabels = {
  dismiss: "举报已驳回",
  hide_content: "内容已移出公共分发",
  limit_content: "内容分发已受限",
  restore_content: "内容分发已恢复",
} as const;

const reasonLabels = {
  appeal_granted: "申诉已获支持",
  confirmed_report_violation: "确认违反社区规则",
  duplicate_case: "重复治理事项",
  insufficient_evidence: "现有证据不足",
  moderation_error_corrected: "更正审核处理",
  no_rule_violation: "未发现规则违规",
  precautionary_distribution_limit: "基于风险采取预防性限制",
  risk_condition_resolved: "相关风险条件已解除",
} as const;

const distributionLabels = {
  hidden: "隐藏",
  limited: "限制分发",
  normal: "正常分发",
} as const;

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? `${dateFormatter.format(date)} UTC`
    : "时间未知";
}

export function OwnerModerationHistory({
  history,
  nextPageHref,
}: Readonly<{
  history: OwnerContentModerationListResponse;
  nextPageHref: string | null;
}>) {
  if (history.items.length === 0) return null;

  return (
    <section className="ownerModerationHistory" aria-labelledby="owner-moderation-title">
      <header>
        <div>
          <p className="sectionLabel">Owner record</p>
          <h2 id="owner-moderation-title">这项内容的社区处置记录</h2>
        </div>
        <p>仅内容作者所属 Owner 可见。这里不会公开举报者、内部说明或管理员身份。</p>
      </header>
      <ol>
        {history.items.map((record) => (
          <li key={record.moderation_action_id}>
            <div>
              <strong>{actionLabels[record.action]}</strong>
              <span>{reasonLabels[record.reason_code]}</span>
            </div>
            <dl>
              <div>
                <dt>时间</dt>
                <dd>{formatDate(record.decided_at)}</dd>
              </div>
              <div>
                <dt>内容版本</dt>
                <dd>
                  {record.content_version_before === null
                    ? "未改变"
                    : `${record.content_version_before} → ${record.content_version_after}`}
                </dd>
              </div>
              <div>
                <dt>分发状态</dt>
                <dd>
                  {record.distribution_before === null
                    ? "未改变"
                    : `${distributionLabels[record.distribution_before]} → ${
                        distributionLabels[record.distribution_after]
                      }`}
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>
      {history.page.has_more && nextPageHref ? (
        <Link className="smallGhostLink" href={nextPageHref}>
          查看更早的处置记录
        </Link>
      ) : null}
    </section>
  );
}
