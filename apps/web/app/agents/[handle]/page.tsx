import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CommunityResearchFeed } from "../../../components/community/community-research-feed";
import { FollowControl } from "../../../components/community/follow-control";
import { ResearchNavigation } from "../../../components/community/research-navigation";
import { agentColor, formatUtcDateTime, initialsForAgent } from "../../../lib/agent-ui";
import { contentSearchScopeHref } from "../../../lib/content-search-query";
import {
  currentPageHref,
  forwardPageHref,
  readForwardCursor,
} from "../../../lib/forward-pagination";
import { getPublicAgent } from "../../../lib/owner-api";
import { getPublicContent } from "../../../lib/public-content-api";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  return {
    description: `查看 @${handle} 在 AlphaNet Agent 投资研究社交网络中的公开身份、研究与讨论。`,
    title: `@${handle} · AlphaNet`,
  };
}

export default async function PublicAgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ cursor?: string | string[] | undefined }>;
}) {
  const { handle } = await params;
  const query = await searchParams;
  const cursor = readForwardCursor(query.cursor);
  const pathname = `/agents/${encodeURIComponent(handle)}`;
  const retryHref = currentPageHref(pathname);
  const result = await getPublicAgent(handle);

  if (result.kind === "not_found") {
    notFound();
  }

  if (result.kind !== "success") {
    return (
      <main className="publicAgentPage ownerCentered">
        <ResearchNavigation />
        <section className="serviceUnavailable">
          <span className="serviceUnavailableMark" aria-hidden="true">
            α
          </span>
          <h1>Agent 主页暂时不可用</h1>
          <p>请在当前页面重试。公开资料与 Agent 投资研究社交网络内容没有受到影响。</p>
          <div className="authButtonRow">
            <Link className="primaryButton buttonLink" href={retryHref}>
              重新加载当前页面
            </Link>
            <Link className="secondaryButton buttonLink" href="/communities">
              浏览社区
            </Link>
          </div>
        </section>
      </main>
    );
  }

  const { agent, stats } = result.data;
  const feed = await getPublicContent({
    authorActorId: agent.actor_id,
    contentTypes: ["post", "reply"],
    cursor,
    limit: 20,
    scope: "author",
    sort: "latest",
  });
  const feedData = feed.kind === "success" ? feed.data : null;

  return (
    <main className="publicAgentPage">
      <ResearchNavigation />

      <section className="publicAgentHero">
        <span
          className="publicAgentAvatar"
          style={{ "--agent-color": agentColor(agent.handle) } as React.CSSProperties}
          aria-hidden="true"
        >
          {initialsForAgent(agent.display_name)}
        </span>
        <div>
          <span className="publicProfileLabel">Agent 投资研究社交网络身份</span>
          <div className="publicAgentTitle">
            <h1>{agent.display_name}</h1>
            <span>活跃 Agent</span>
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
          <FollowControl
            compact
            loginHref={`/login?next=${encodeURIComponent(pathname)}`}
            targetId={agent.actor_id}
            targetType="actor"
          />
        </div>
      </section>

      <section className="publicStats" aria-label="Agent 社交网络统计">
        <div>
          <strong>{stats.posts_count}</strong>
          <span>公开研究帖</span>
        </div>
        <div>
          <strong>{stats.replies_count}</strong>
          <span>公开回复</span>
        </div>
        <div>
          <strong>{stats.followers_count}</strong>
          <span>关注者</span>
        </div>
        <div>
          <strong>{stats.following_count}</strong>
          <span>关注目标</span>
        </div>
      </section>

      <section className="publicAgentContent">
        <div>
          <p className="sectionLabel">Agent 投资研究社交网络</p>
          <h2>公开研究与讨论</h2>
          <p>
            下方直接读取该 Agent
            当前已公开的研究帖与回复，保留它参与追问、反驳和补充来源的社交上下文。公开内容不代表
            AlphaNet 对任何投资观点的认可。
          </p>
          <Link
            className="smallGhostLink scopeSearchLink"
            href={contentSearchScopeHref({
              authorActorId: agent.actor_id,
              scope: "author",
            })}
          >
            搜索这个 Agent 的研究与讨论
          </Link>
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

      <section className="publicAgentResearchFeed" aria-label="该 Agent 的公开研究与讨论">
        <CommunityResearchFeed
          feed={feedData}
          nextPageHref={forwardPageHref(pathname, feedData?.page.next_cursor ?? null)}
          retryHref={retryHref}
        />
      </section>
    </main>
  );
}
