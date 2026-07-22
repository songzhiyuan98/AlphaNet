import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import {
  AdminNavigation,
  AdminProblem,
  ModerationCaseDetail,
} from "../../../../components/admin";
import { getAdminModerationCase } from "../../../../lib/admin-api";
import { parseAdminCaseDetailQuery } from "../../../../lib/admin-query";

export const metadata: Metadata = {
  description: "核对举报证据、内容状态与不可变社区治理记录。",
  title: "审核案件 · AlphaNet Admin",
};

export default async function AdminModerationCasePage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const [{ caseId }, query] = await Promise.all([params, searchParams]);
  const parsed = parseAdminCaseDetailQuery(query);
  if (!parsed.ok) {
    return (
      <>
        <AdminNavigation active="moderation" canDecide={false} />
        <AdminProblem
          actionHref={`/admin/moderation/${encodeURIComponent(caseId)}`}
          actionLabel="清除分页参数"
          message="举报或处置记录的分页参数无效。案件请求尚未发送。"
          title="无法读取这个案件分页"
        />
      </>
    );
  }

  const result = await getAdminModerationCase(caseId, parsed.value);
  if (result.kind === "disabled" || result.kind === "not_found") notFound();
  if (result.kind === "unauthenticated") {
    redirect(
      `/admin/sign-in?next=${encodeURIComponent(
        `/admin/moderation/${encodeURIComponent(caseId)}`,
      )}`,
    );
  }
  if (result.kind === "success") {
    return (
      <>
        <AdminNavigation
          active="moderation"
          canDecide={result.data.capabilities.can_decide}
        />
        <ModerationCaseDetail
          {...(parsed.value.action_limit !== undefined
            ? { actionLimit: parsed.value.action_limit }
            : {})}
          {...(parsed.value.action_cursor
            ? { actionCursor: parsed.value.action_cursor }
            : {})}
          decisionAttemptId={randomUUID()}
          {...(parsed.value.report_limit !== undefined
            ? { reportLimit: parsed.value.report_limit }
            : {})}
          {...(parsed.value.report_cursor
            ? { reportCursor: parsed.value.report_cursor }
            : {})}
          response={result.data}
        />
      </>
    );
  }

  const forbidden = result.kind === "forbidden";
  const invalid = result.kind === "invalid";
  const rateLimited = result.kind === "rate_limited";
  const requestId = "error" in result ? (result.error?.requestId ?? null) : null;
  return (
    <>
      <AdminNavigation active="moderation" canDecide={false} />
      <AdminProblem
        message={
          forbidden
            ? "当前 Workforce 身份没有读取这项社区治理案件的权限。该拒绝已由服务端审计。"
            : invalid
              ? "治理服务拒绝了案件请求，请返回队列重新打开。"
              : rateLimited
                ? "案件读取请求过于频繁，请稍后重试。"
                : "治理服务暂时不可用，页面不会展示未经验证的旧案件数据。"
        }
        requestId={requestId}
        title={forbidden ? "没有案件读取权限" : "暂时无法读取案件"}
      />
    </>
  );
}
