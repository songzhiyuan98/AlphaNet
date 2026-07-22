import type {
  BrowseContentResponse,
  CommunityDetailProjection,
} from "@alphanet/contracts";
import Link from "next/link";

import { communityStateLabel } from "../../lib/community-presentation";
import { contentSearchScopeHref } from "../../lib/content-search-query";
import type { PublicFeedSort } from "../../lib/public-content-ranking";
import { CommunityResearchFeed } from "./community-research-feed";
import { ContentRankingTabs } from "./content-ranking-tabs";
import { ResearchNavigation } from "./research-navigation";

const kindLabels: Record<CommunityDetailProjection["kind"], string> = {
  general: "综合市场社区",
  symbol: "股票研究社区",
  topic: "主题研究社区",
};

export function CommunityDetail({
  community,
  feed,
  nextPageHref,
  retryHref,
  sort,
}: Readonly<{
  community: CommunityDetailProjection;
  feed: BrowseContentResponse | null;
  nextPageHref: string | null;
  retryHref: string;
  sort: PublicFeedSort;
}>) {
  const target = community.canonical_target;
  const identifier =
    target?.type === "symbol"
      ? `$${target.symbol}`
      : target?.type === "topic"
        ? `#${target.slug}`
        : "MARKET";

  return (
    <main className="researchPage">
      <ResearchNavigation active="communities" />

      <header className="communityDetailHero">
        <div>
          <p className="sectionLabel">{kindLabels[community.kind]}</p>
          <span className="communityDetailIdentifier">{identifier}</span>
          <h1>{community.name}</h1>
          <p>{community.description_markdown}</p>
        </div>
        <aside className="communityDetailMeta">
          <span>社区状态</span>
          <strong>{communityStateLabel(community.state)}</strong>
          <small>
            {community.state === "archived"
              ? "保留历史研究、讨论和来源记录，不再接受新的社区写入"
              : community.materialization_state === "catalog_only"
                ? "首篇合规研究发布时建立社区记录"
                : "使用一个稳定社区 ID 保存长期研究记忆"}
          </small>
          <Link
            className="smallGhostLink scopeSearchLink"
            href={contentSearchScopeHref({
              communityId: community.id,
              scope: "community",
            })}
          >
            搜索此社区的研究与讨论
          </Link>
        </aside>
      </header>

      <ContentRankingTabs sort={sort} />

      <CommunityResearchFeed
        feed={feed}
        nextPageHref={nextPageHref}
        retryHref={retryHref}
      />
    </main>
  );
}
