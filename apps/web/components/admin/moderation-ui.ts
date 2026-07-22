import type {
  AdminContentModerationAction,
  AdminModerationDecisionRequest,
  AdminModerationReasonCode,
  ContentReportReason,
  ModerationCasePriority,
  ModerationCaseStatus,
} from "@alphanet/contracts";

export const moderationStatusLabels: Record<ModerationCaseStatus, string> = {
  open: "待处理",
  reviewing: "审核中",
  resolved_action: "已执行处置",
  dismissed: "已驳回",
};

export const moderationPriorityLabels: Record<ModerationCasePriority, string> = {
  normal: "常规",
  high: "高优先级",
  urgent: "紧急",
};

export const reportReasonLabels: Record<ContentReportReason, string> = {
  spam: "垃圾内容",
  harassment: "骚扰",
  impersonation: "冒充身份",
  malicious_link: "恶意链接",
  privacy_exposure: "隐私泄露",
  other_rule_violation: "其他规则违规",
};

export const moderationActionLabels: Record<AdminContentModerationAction, string> = {
  dismiss: "驳回举报",
  limit_content: "限制分发",
  hide_content: "隐藏内容",
  restore_content: "恢复分发",
};

export const moderationReasonLabels: Record<AdminModerationReasonCode, string> = {
  confirmed_report_violation: "确认违反社区规则",
  precautionary_distribution_limit: "预防性限制分发",
  insufficient_evidence: "证据不足",
  no_rule_violation: "未违反社区规则",
  duplicate_case: "重复案件",
  moderation_error_corrected: "纠正治理错误",
  appeal_granted: "申诉成立",
  risk_condition_resolved: "风险条件已解除",
};

export const decisionReasons = {
  dismiss: ["insufficient_evidence", "no_rule_violation", "duplicate_case"],
  limit_content: ["confirmed_report_violation", "precautionary_distribution_limit"],
  hide_content: ["confirmed_report_violation", "precautionary_distribution_limit"],
  restore_content: [
    "moderation_error_corrected",
    "appeal_granted",
    "risk_condition_resolved",
  ],
} as const satisfies Record<
  AdminContentModerationAction,
  readonly AdminModerationReasonCode[]
>;

export function buildDecisionRequest(
  action: AdminContentModerationAction,
  reasonCode: AdminModerationReasonCode,
  internalNote: string,
): AdminModerationDecisionRequest | null {
  const note = internalNote.trim();
  const optionalNote = note.length === 0 ? {} : { internal_note: note };

  switch (action) {
    case "dismiss":
      if (
        reasonCode !== "insufficient_evidence" &&
        reasonCode !== "no_rule_violation" &&
        reasonCode !== "duplicate_case"
      ) {
        return null;
      }
      return { action, reason_code: reasonCode, ...optionalNote };
    case "limit_content":
    case "hide_content":
      if (
        reasonCode !== "confirmed_report_violation" &&
        reasonCode !== "precautionary_distribution_limit"
      ) {
        return null;
      }
      return { action, reason_code: reasonCode, ...optionalNote };
    case "restore_content":
      if (
        reasonCode !== "moderation_error_corrected" &&
        reasonCode !== "appeal_granted" &&
        reasonCode !== "risk_condition_resolved"
      ) {
        return null;
      }
      return { action, reason_code: reasonCode, ...optionalNote };
  }
}

export function formatAdminDateTime(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}
