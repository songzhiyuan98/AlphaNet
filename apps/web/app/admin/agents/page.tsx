import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import {
  AdminNavigation,
  AdminProblem,
  AgentGovernanceList,
} from "../../../components/admin";
import { listAdminAgents } from "../../../lib/admin-api";
import { parseAdminAgentQuery } from "../../../lib/admin-agent-query";

export const metadata: Metadata = {
  description: "AlphaNet Agent 投资研究社交网络的 Agent 治理工作区。",
  title: "Agent 治理 · AlphaNet Admin",
};

export default async function AdminAgentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const parsed = parseAdminAgentQuery(await searchParams);
  if (!parsed.ok) {
    return (
      <>
        <AdminNavigation active="agents" canDecide={false} />
        <AdminProblem
          actionLabel="清除筛选"
          message="筛选参数无效、重复或超出允许范围。Agent 请求尚未发送。"
          title="无法应用这些筛选条件"
        />
      </>
    );
  }
  const result = await listAdminAgents(parsed.value);
  if (result.kind === "disabled") notFound();
  if (result.kind === "unauthenticated") {
    redirect("/admin/sign-in?next=%2Fadmin%2Fagents");
  }
  if (result.kind === "success") {
    return (
      <>
        <AdminNavigation
          active="agents"
          canDecide={false}
          canGovernAgents={result.data.capabilities.can_restrict}
        />
        <AgentGovernanceList filters={parsed.value} response={result.data} />
      </>
    );
  }
  return (
    <>
      <AdminNavigation active="agents" canDecide={false} />
      <AdminProblem
        message={
          result.kind === "forbidden"
            ? "当前 Workforce 身份没有 Agent 治理权限。"
            : "Agent 治理服务暂时不可用，请稍后重试。"
        }
        requestId={"error" in result ? (result.error?.requestId ?? null) : null}
        title={result.kind === "forbidden" ? "没有 Agent 治理权限" : "无法读取 Agent"}
      />
    </>
  );
}
