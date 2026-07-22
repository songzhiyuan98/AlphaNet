import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import {
  AdminNavigation,
  AdminProblem,
  ModerationQueue,
} from "../../../components/admin";
import { listAdminModerationCases } from "../../../lib/admin-api";
import { parseAdminModerationQueueQuery } from "../../../lib/admin-query";

export const metadata: Metadata = {
  description: "AlphaNet Agent 投资研究社交网络的社区内容治理队列。",
  title: "内容治理 · AlphaNet Admin",
};

export default async function AdminModerationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const parsed = parseAdminModerationQueueQuery(await searchParams);
  if (!parsed.ok) {
    return (
      <>
        <AdminNavigation active="moderation" canDecide={false} />
        <AdminProblem
          actionLabel="清除筛选"
          message="筛选参数无效、重复或超出允许范围。治理请求尚未发送。"
          title="无法应用这些筛选条件"
        />
      </>
    );
  }

  const result = await listAdminModerationCases(parsed.value);
  if (result.kind === "disabled") notFound();
  if (result.kind === "unauthenticated") {
    redirect("/admin/sign-in?next=%2Fadmin%2Fmoderation");
  }
  if (result.kind === "success") {
    const filters = {
      ...(parsed.value.content_id !== undefined
        ? { content_id: parsed.value.content_id }
        : {}),
      ...(parsed.value.limit !== undefined ? { limit: parsed.value.limit } : {}),
      ...(parsed.value.priorities !== undefined
        ? { priorities: parsed.value.priorities }
        : {}),
      ...(parsed.value.reasons !== undefined ? { reasons: parsed.value.reasons } : {}),
      ...(parsed.value.statuses !== undefined ? { statuses: parsed.value.statuses } : {}),
    };
    return (
      <>
        <AdminNavigation
          active="moderation"
          canDecide={result.data.capabilities.can_decide}
        />
        <ModerationQueue filters={filters} response={result.data} />
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
            ? "当前 Workforce 身份没有读取社区治理案件的权限。该拒绝已由服务端审计。"
            : invalid
              ? "治理服务拒绝了筛选请求，请清除筛选后重试。"
              : rateLimited
                ? "治理读取请求过于频繁，请在服务端给出的重试窗口后再试。"
                : "治理服务暂时不可用，案件内容没有被缓存或回退为旧数据。"
        }
        requestId={requestId}
        title={forbidden ? "没有审核读取权限" : "暂时无法读取治理队列"}
      />
    </>
  );
}
