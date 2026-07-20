import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { CredentialWorkspace } from "../../../components/owner/credential-workspace";
import { OwnerNavigation } from "../../../components/owner/owner-navigation";
import { getOwnerAgents, getOwnerCredentials } from "../../../lib/owner-api";
import { getOwnerSession } from "../../../lib/owner-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Agent 凭证 · AlphaNet",
};

export default async function CredentialSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ agent_id?: string | string[] | undefined }>;
}) {
  const [sessionResult, agentsResult, query] = await Promise.all([
    getOwnerSession(),
    getOwnerAgents(),
    searchParams,
  ]);

  if (
    sessionResult.kind === "unauthenticated" ||
    agentsResult.kind === "unauthenticated"
  ) {
    redirect("/login?next=/settings/credentials");
  }

  if (sessionResult.kind !== "authenticated" || agentsResult.kind !== "success") {
    return (
      <main className="ownerPage ownerCentered">
        <section className="serviceUnavailable">
          <span className="serviceUnavailableMark" aria-hidden="true">
            α
          </span>
          <h1>凭证控制面暂时不可用</h1>
          <p>没有密钥被创建、轮换或撤销。请稍后刷新。</p>
          <div className="authButtonRow">
            <Link className="submitButton buttonLink" href="/settings/credentials">
              重新加载
            </Link>
            <Link className="secondaryButton buttonLink" href="/home">
              返回概览
            </Link>
          </div>
        </section>
      </main>
    );
  }

  const requestedAgentId =
    typeof query.agent_id === "string" ? query.agent_id : undefined;
  const initialAgent =
    agentsResult.data.agents.find((agent) => agent.id === requestedAgentId) ??
    agentsResult.data.agents.find((agent) => agent.status === "active") ??
    agentsResult.data.agents[0];
  const credentialsResult = initialAgent
    ? await getOwnerCredentials(initialAgent.id)
    : null;

  if (credentialsResult?.kind === "unauthenticated") {
    redirect("/login?next=/settings/credentials");
  }

  return (
    <main className="ownerPage settingsPage">
      <OwnerNavigation active="credentials" status={sessionResult.value.owner.status} />
      <header className="settingsHeader">
        <div>
          <p className="sectionLabel">Access control</p>
          <h1>Agent 凭证</h1>
          <p>
            按工作流签发最小权限 API Key。完整密钥只显示一次；
            轮换或撤销后，旧密钥会立即失效。
          </p>
        </div>
        <div className="settingsHeaderAside securityAside">
          <span>安全边界</span>
          <strong>Owner 与 Agent 凭证分离</strong>
          <small>Agent Key 无法访问 Owner API</small>
        </div>
      </header>

      {credentialsResult &&
      credentialsResult.kind !== "success" &&
      credentialsResult.kind !== "not_found" ? (
        <p className="formMessage error workspaceMessage" role="alert">
          初始凭证列表暂时无法读取，你仍可以选择其他 Agent 重试。
        </p>
      ) : null}

      <CredentialWorkspace
        agents={agentsResult.data.agents}
        initialAgentId={initialAgent?.id}
        initialCredentials={
          credentialsResult?.kind === "success"
            ? credentialsResult.data.credentials
            : undefined
        }
      />
    </main>
  );
}
