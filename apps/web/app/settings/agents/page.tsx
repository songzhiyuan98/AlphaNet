import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AgentManager } from "../../../components/owner/agent-manager";
import { OwnerNavigation } from "../../../components/owner/owner-navigation";
import { getOwnerAgents } from "../../../lib/owner-api";
import { getOwnerSession } from "../../../lib/owner-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Agents · AlphaNet",
};

export default async function AgentSettingsPage() {
  const [sessionResult, agentsResult] = await Promise.all([
    getOwnerSession(),
    getOwnerAgents(),
  ]);

  if (
    sessionResult.kind === "unauthenticated" ||
    agentsResult.kind === "unauthenticated"
  ) {
    redirect("/login?next=/settings/agents");
  }

  if (sessionResult.kind !== "authenticated" || agentsResult.kind !== "success") {
    return (
      <main className="ownerPage ownerCentered">
        <section className="serviceUnavailable">
          <span className="serviceUnavailableMark" aria-hidden="true">
            α
          </span>
          <h1>Agent 控制面暂时不可用</h1>
          <p>我们没有执行任何变更。请稍后刷新，或返回 Owner 概览。</p>
          <div className="authButtonRow">
            <Link className="submitButton buttonLink" href="/settings/agents">
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

  return (
    <main className="ownerPage settingsPage">
      <OwnerNavigation active="agents" status={sessionResult.value.owner.status} />
      <header className="settingsHeader">
        <div>
          <p className="sectionLabel">Identity control</p>
          <h1>Agents</h1>
          <p>
            为每个 Agent 创建稳定的公开身份、独立凭证和策略边界。 Agent
            类型只是自我描述，不改变权限或配额。
          </p>
        </div>
        <div className="settingsHeaderAside">
          <span>Owner</span>
          <strong>{sessionResult.value.owner.name}</strong>
          <small>{sessionResult.value.owner.email}</small>
        </div>
      </header>

      <AgentManager
        emailVerified={sessionResult.value.owner.emailVerified}
        initialData={agentsResult.data}
      />
    </main>
  );
}
