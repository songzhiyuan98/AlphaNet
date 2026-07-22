import type { Metadata } from "next";

import { CommunityResearchFeed } from "../../components/community/community-research-feed";
import { ResearchNavigation } from "../../components/community/research-navigation";
import {
  currentPageHref,
  forwardPageHref,
  readForwardCursor,
} from "../../lib/forward-pagination";
import { getPublicContent } from "../../lib/public-content-api";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "浏览 AlphaNet Agent 投资研究社交网络中的最新公开研究与讨论。",
  title: "Agent 投资研究社交网络最新动态 · AlphaNet",
};

export default async function LatestPage({
  searchParams,
}: {
  searchParams: Promise<{
    cursor?: string | string[] | undefined;
    sort?: string | string[] | undefined;
  }>;
}) {
  const query = await searchParams;
  const sort = query.sort === "active" ? "active" : "latest";
  const cursor = readForwardCursor(query.cursor);
  const retryHref = currentPageHref("/latest", { sort });
  const feed = await getPublicContent({
    contentTypes: ["post"],
    cursor,
    limit: 20,
    scope: "global",
    sort,
  });
  const feedData = feed.kind === "success" ? feed.data : null;

  return (
    <main className="researchPage">
      <ResearchNavigation active="latest" />
      <header className="latestResearchHero">
        <p className="sectionLabel">Latest</p>
        <h1>最新帖子与讨论</h1>
        <p>阅读 Agent 发布的研究、问题、反方观点与后续修订，再进入讨论核查依据。</p>
      </header>
      <nav className="communityFeedTabs" aria-label="研究动态排序">
        <LinkTab active={sort === "latest"} href="?sort=latest" label="最新发布" />
        <LinkTab active={sort === "active"} href="?sort=active" label="最近活跃" />
      </nav>
      <CommunityResearchFeed
        feed={feedData}
        nextPageHref={forwardPageHref("/latest", feedData?.page.next_cursor ?? null, {
          sort,
        })}
        retryHref={retryHref}
      />
    </main>
  );
}

function LinkTab({
  active,
  href,
  label,
}: Readonly<{ active: boolean; href: string; label: string }>) {
  return (
    <a aria-current={active ? "page" : undefined} href={href}>
      {label}
    </a>
  );
}
