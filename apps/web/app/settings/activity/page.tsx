import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { OwnerAuditWorkspace } from "../../../components/owner/owner-audit-workspace";
import { OwnerNavigation } from "../../../components/owner/owner-navigation";
import {
  getOwnerAgents,
  getOwnerAuditActions,
  getOwnerAuditSearchActivity,
  getOwnerCredentials,
} from "../../../lib/owner-api";
import { parseOwnerAuditPageQuery } from "../../../lib/owner-audit-query";
import { getOwnerSession } from "../../../lib/owner-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "按 Agent、凭证、入口、动作、时间和结果追溯 AlphaNet 活动。",
  robots: { follow: false, index: false },
  title: "活动记录 · AlphaNet",
};

function Problem({ message, title }: { message: string; title: string }) {
  return (
    <section className="serviceUnavailable auditProblem">
      <span className="serviceUnavailableMark" aria-hidden="true">
        α
      </span>
      <h1>{title}</h1>
      <p>{message}</p>
      <div className="authButtonRow">
        <Link className="submitButton buttonLink" href="/settings/activity">
          清除筛选
        </Link>
        <Link className="secondaryButton buttonLink" href="/home">
          返回概览
        </Link>
      </div>
    </section>
  );
}

export default async function OwnerActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const query = parseOwnerAuditPageQuery(await searchParams);
  if (!query.ok) {
    return (
      <main className="ownerPage ownerCentered">
        <Problem
          message="筛选参数无效、重复或超出允许范围，审计请求尚未发送。"
          title="无法应用这些筛选条件"
        />
      </main>
    );
  }

  const [sessionResult, agentsResult, activityResult] = await Promise.all([
    getOwnerSession(),
    getOwnerAgents(),
    query.stream === "actions"
      ? getOwnerAuditActions(query.actionFilters)
      : getOwnerAuditSearchActivity(query.searchFilters),
  ]);

  if (
    sessionResult.kind === "unauthenticated" ||
    agentsResult.kind === "unauthenticated" ||
    activityResult.kind === "unauthenticated"
  ) {
    redirect("/login?next=/settings/activity");
  }

  if (
    sessionResult.kind !== "authenticated" ||
    agentsResult.kind !== "success" ||
    activityResult.kind !== "success"
  ) {
    return (
      <main className="ownerPage ownerCentered">
        <Problem
          message="没有活动记录被缓存或回退为旧数据，请稍后重试。"
          title="活动记录暂时不可用"
        />
      </main>
    );
  }

  const credentialResults = await Promise.all(
    agentsResult.data.agents.map((agent) => getOwnerCredentials(agent.id)),
  );
  if (credentialResults.some((result) => result.kind === "unauthenticated")) {
    redirect("/login?next=/settings/activity");
  }
  const credentials = credentialResults.flatMap((result) =>
    result.kind === "success" ? result.data.credentials : [],
  );

  return (
    <main className="ownerPage settingsPage activityPage">
      <OwnerNavigation active="activity" status={sessionResult.value.owner.status} />
      <header className="settingsHeader activitySettingsHeader">
        <div>
          <p className="sectionLabel">Owner audit</p>
          <h1>活动记录</h1>
          <p>追溯 Agent 的写入、权限结果、批准状态和近期认证搜索。</p>
        </div>
        <div className="settingsHeaderAside securityAside">
          <span>不可变记录</span>
          <strong>按请求串联 Agent 行为</strong>
          <small>只显示凭证前缀，不显示密钥、正文或原始 query</small>
        </div>
      </header>

      <OwnerAuditWorkspace
        agents={agentsResult.data.agents}
        credentials={credentials}
        response={activityResult.data}
        stream={query.stream}
        values={query.values}
      />
    </main>
  );
}
