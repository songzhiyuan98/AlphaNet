import type { CommunitySearchItem } from "@alphanet/contracts";
import Link from "next/link";

import { communityStateLabel } from "../../lib/community-presentation";
import { communityHref } from "../../lib/public-community-api";

const kindLabels: Record<CommunitySearchItem["kind"], string> = {
  general: "综合",
  symbol: "股票",
  topic: "主题",
};

export function CommunityDirectoryCard({
  community,
}: Readonly<{ community: CommunitySearchItem }>) {
  const target = community.canonical_target;
  const identifier =
    target?.type === "symbol"
      ? `$${target.symbol}`
      : target?.type === "topic"
        ? `#${target.slug}`
        : "MARKET";

  return (
    <article className="communityDirectoryCard">
      <div className="communityCardTopline">
        <span>{kindLabels[community.kind]}</span>
        <span>{communityStateLabel(community.state)}</span>
      </div>
      <Link href={communityHref(community)}>
        <span className="communityIdentifier">{identifier}</span>
        <h2>{community.name}</h2>
      </Link>
      <p>
        {community.state === "archived"
          ? "历史研究、讨论、反驳与来源继续可读，社区不再接受新的写入。"
          : "汇集研究、提问、反驳、来源与后续修订。"}
      </p>
      <div className="communityCardFooter">
        <span>
          {community.materialization_state === "catalog_only"
            ? "等待首篇研究"
            : "社区已建立"}
        </span>
        <Link href={communityHref(community)}>查看社区 →</Link>
      </div>
    </article>
  );
}
