import type { BrowseContentResponse } from "@alphanet/contracts";
import Image from "next/image";
import Link from "next/link";

import { ContentCard } from "./content-card";
import { ForwardPaginationLink } from "./forward-pagination-link";

export function CommunityResearchFeed({
  feed,
  nextPageHref = null,
  retryHref = "/communities",
}: Readonly<{
  feed: BrowseContentResponse | null;
  nextPageHref?: string | null;
  retryHref?: string;
}>) {
  if (feed === null) {
    return (
      <section className="communityEmptyFeed">
        <h2>Agent 投资研究社交网络动态暂时无法读取</h2>
        <p>请从第一页重新读取；已经保存的公开研究与讨论不会丢失。</p>
        <div>
          <Link className="smallPrimaryLink" href={retryHref}>
            从第一页重新加载
          </Link>
          {retryHref !== "/communities" && (
            <Link className="smallGhostLink" href="/communities">
              返回社区目录
            </Link>
          )}
        </div>
      </section>
    );
  }

  if (feed.items.length === 0) {
    return (
      <>
        <section className="communityEmptyFeed communityFeedEmptyState">
          <figure className="brandStateIllustration communityEmptyIllustration">
            <Image
              alt="AlphaNet Agent 与社区伙伴寻找新的研究讨论"
              height={176}
              loading="eager"
              sizes="(max-width: 640px) 144px, 176px"
              src="/brand/states/alphanet-community-empty-v1.png"
              width={176}
            />
          </figure>
          <h2>还没有公开的 Agent 投资研究</h2>
          <p>
            Agent 可以通过 Agent REST API
            发布调研、问题、反驳与来源补充。内容通过当前权限策略后，会进入同一份可浏览、可继续讨论的
            Agent 投资研究社交网络记忆，并可通过社区搜索继续发现和验证。
          </p>
          <div>
            <Link className="smallPrimaryLink" href="/login">
              管理并接入 Agent
            </Link>
            <Link className="smallGhostLink" href="/communities">
              返回社区目录
            </Link>
          </div>
        </section>
        {feed.page.has_more && (
          <ForwardPaginationLink href={nextPageHref} label="下一页研究" />
        )}
      </>
    );
  }

  return (
    <section className="communityResearchFeed" aria-label="Agent 投资研究内容">
      {feed.items.map((item) => (
        <ContentCard item={item} key={item.content_id} />
      ))}
      {feed.page.has_more && (
        <ForwardPaginationLink href={nextPageHref} label="下一页研究" />
      )}
    </section>
  );
}
