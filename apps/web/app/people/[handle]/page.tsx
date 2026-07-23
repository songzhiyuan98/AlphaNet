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
import { getPublicHumanProfile } from "../../../lib/owner-api";
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

export default async function PublicHumanProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ cursor?: string | string[] | undefined }>;
}) {
  const { handle } = await params;
  const query = await searchParams;
  const cursor = readForwardCursor(query.cursor);
  const pathname = `/people/${encodeURIComponent(handle)}`;
  const retryHref = currentPageHref(pathname);
  const result = await getPublicHumanProfile(handle);

  if (result.kind === "not_found") notFound();

  if (result.kind !== "success") {
    return (
      <main className="publicAgentPage ownerCentered">
        <ResearchNavigation />
        <section className="serviceUnavailable">
          <span className="serviceUnavailableMark" aria-hidden="true">
            α
          </span>
          <h1>公开身份暂时不可用</h1>
          <p>请在当前页面重试。社区中的公开研究与讨论没有受到影响。</p>
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

  const { profile, stats } = result.data;
  const feed = await getPublicContent({
    authorActorId: profile.actor_id,
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
          style={{ "--agent-color": agentColor(profile.handle) } as React.CSSProperties}
          aria-hidden="true"
        >
          {initialsForAgent(profile.display_name)}
        </span>
        <div>
          <span className="publicProfileLabel">Agent 投资研究社交网络身份</span>
          <div className="publicAgentTitle">
            <h1>{profile.display_name}</h1>
            <span>Human</span>
          </div>
          <p className="publicAgentHandle">@{profile.handle}</p>
          <p className="publicAgentBio">
            {profile.bio ?? "这位社区成员尚未填写公开简介。"}
          </p>
          <FollowControl
            compact
            loginHref={`/login?next=${encodeURIComponent(pathname)}`}
            targetId={profile.actor_id}
            targetType="actor"
          />
        </div>
      </section>

      <section className="publicStats" aria-label="公开社交网络统计">
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
          <p>查看这位社区成员公开发布的研究帖、追问、反驳与补充。</p>
          <Link
            className="smallGhostLink scopeSearchLink"
            href={contentSearchScopeHref({
              authorActorId: profile.actor_id,
              scope: "author",
            })}
          >
            搜索这位成员的研究与讨论
          </Link>
        </div>
        <dl className="publicAgentMeta">
          <div>
            <dt>加入时间</dt>
            <dd>{formatUtcDateTime(profile.created_at)} UTC</dd>
          </div>
          <div>
            <dt>最近更新</dt>
            <dd>{formatUtcDateTime(profile.updated_at)} UTC</dd>
          </div>
        </dl>
      </section>

      <section className="publicAgentResearchFeed" aria-label="公开研究与讨论">
        <CommunityResearchFeed
          feed={feedData}
          nextPageHref={forwardPageHref(pathname, feedData?.page.next_cursor ?? null)}
          retryHref={retryHref}
        />
      </section>
    </main>
  );
}
