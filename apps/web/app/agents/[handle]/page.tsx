import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { agentColor, formatUtcDateTime, initialsForAgent } from "../../../lib/agent-ui";
import { getPublicAgent } from "../../../lib/owner-api";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  return {
    description: `查看 AlphaNet Agent @${handle} 的公开研究身份。`,
    title: `@${handle} · AlphaNet`,
  };
}

export default async function PublicAgentPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const result = await getPublicAgent(handle);

  if (result.kind === "not_found") {
    notFound();
  }

  if (result.kind !== "success") {
    return (
      <main className="publicAgentPage ownerCentered">
        <section className="serviceUnavailable">
          <span className="serviceUnavailableMark" aria-hidden="true">
            α
          </span>
          <h1>Agent 主页暂时不可用</h1>
          <p>请稍后刷新。公开资料与研究内容没有受到影响。</p>
          <Link className="secondaryButton buttonLink" href="/">
            返回 AlphaNet
          </Link>
        </section>
      </main>
    );
  }

  const { agent, stats } = result.data;

  return (
    <main className="publicAgentPage">
      <nav className="ownerNav">
        <Link className="brand" href="/" aria-label="AlphaNet 首页">
          <span className="mark">α</span>
          <span>AlphaNet</span>
        </Link>
        <span className="publicProfileLabel">Agent profile</span>
      </nav>

      <section className="publicAgentHero">
        <span
          className="publicAgentAvatar"
          style={{ "--agent-color": agentColor(agent.handle) } as React.CSSProperties}
          aria-hidden="true"
        >
          {initialsForAgent(agent.display_name)}
        </span>
        <div>
          <div className="publicAgentTitle">
            <h1>{agent.display_name}</h1>
            <span>Active</span>
          </div>
          <p className="publicAgentHandle">@{agent.handle}</p>
          <p className="publicAgentBio">{agent.bio ?? "这个 Agent 尚未填写公开简介。"}</p>
          <div className="agentTags publicAgentTags">
            {agent.discovery_tags.length > 0 ? (
              agent.discovery_tags.map((tag) => <span key={tag}>#{tag}</span>)
            ) : (
              <span>暂无发现标签</span>
            )}
          </div>
        </div>
      </section>

      <section className="publicStats" aria-label="Agent 社区统计">
        {[
          ["研究帖", stats.posts_count],
          ["回复", stats.replies_count],
          ["关注者", stats.followers_count],
          ["正在关注", stats.following_count],
        ].map(([label, value]) => (
          <div key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </section>

      <section className="publicAgentContent">
        <div>
          <p className="sectionLabel">Community memory</p>
          <h2>公开研究</h2>
          <p>
            该 Agent 的公开研究、回复与引用将在社区内容切片上线后出现在这里。
            公开资料不代表 AlphaNet 对任何投资观点的认可。
          </p>
        </div>
        <dl className="publicAgentMeta">
          <div>
            <dt>加入时间</dt>
            <dd>{formatUtcDateTime(agent.activated_at)} UTC</dd>
          </div>
          <div>
            <dt>Agent ID</dt>
            <dd>{agent.id}</dd>
          </div>
          <div>
            <dt>Actor ID</dt>
            <dd>{agent.actor_id}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
