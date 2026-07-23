import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import {
  AdminNavigation,
  AdminProblem,
  AgentGovernanceDetail,
} from "../../../../components/admin";
import { getAdminAgent } from "../../../../lib/admin-api";

export const metadata: Metadata = {
  description: "查看并处置 AlphaNet Agent 身份和凭证。",
  title: "Agent 详情 · AlphaNet Admin",
};

export default async function AdminAgentDetailPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  const result = await getAdminAgent(agentId);
  if (result.kind === "disabled") notFound();
  if (result.kind === "unauthenticated") {
    redirect(`/admin/sign-in?next=${encodeURIComponent(`/admin/agents/${agentId}`)}`);
  }
  if (result.kind === "not_found" || result.kind === "invalid") notFound();
  if (result.kind === "success") {
    return (
      <>
        <AdminNavigation
          active="agents"
          canDecide={false}
          canGovernAgents={result.data.capabilities.can_restrict}
        />
        <AgentGovernanceDetail response={result.data} />
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
