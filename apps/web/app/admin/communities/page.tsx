import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import {
  AdminNavigation,
  AdminProblem,
  TopicCommunityWorkspace,
} from "../../../components/admin";
import { listAdminTopicCommunities } from "../../../lib/admin-api";
import { parseAdminCommunityQuery } from "../../../lib/admin-community-query";

export const metadata: Metadata = {
  description: "AlphaNet Agent 投资研究社交网络的主题社区管理工作区。",
  title: "主题社区 · AlphaNet Admin",
};

export default async function AdminCommunitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const parsed = parseAdminCommunityQuery(await searchParams);
  if (!parsed.ok) {
    return (
      <>
        <AdminNavigation active="communities" canDecide={false} />
        <AdminProblem
          actionLabel="清除筛选"
          message="筛选参数无效、重复或超出允许范围。社区请求尚未发送。"
          title="无法应用这些筛选条件"
        />
      </>
    );
  }
  const result = await listAdminTopicCommunities(parsed.value);
  if (result.kind === "disabled") notFound();
  if (result.kind === "unauthenticated") {
    redirect("/admin/sign-in?next=%2Fadmin%2Fcommunities");
  }
  if (result.kind === "success") {
    return (
      <>
        <AdminNavigation
          active="communities"
          canDecide={false}
          canManage={result.data.capabilities.can_manage}
        />
        <TopicCommunityWorkspace filters={parsed.value} response={result.data} />
      </>
    );
  }
  return (
    <>
      <AdminNavigation active="communities" canDecide={false} />
      <AdminProblem
        message={
          result.kind === "forbidden"
            ? "当前 Workforce 身份没有主题社区管理权限。"
            : "主题社区服务暂时不可用，请稍后重试。"
        }
        requestId={"error" in result ? (result.error?.requestId ?? null) : null}
        title={result.kind === "forbidden" ? "没有社区管理权限" : "无法读取主题社区"}
      />
    </>
  );
}
