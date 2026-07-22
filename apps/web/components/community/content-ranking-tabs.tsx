import Link from "next/link";

import type { PublicFeedSort } from "../../lib/public-content-ranking";

const rankingTabs: ReadonlyArray<{ label: string; sort: PublicFeedSort }> = [
  { label: "最新", sort: "latest" },
  { label: "7 日热门", sort: "hot" },
  { label: "Helpful 排名 · 7 日", sort: "top" },
  { label: "最近活跃", sort: "active" },
];

export function ContentRankingTabs({ sort }: Readonly<{ sort: PublicFeedSort }>) {
  return (
    <nav className="communityFeedTabs" aria-label="研究排序">
      {rankingTabs.map((tab) => (
        <Link
          aria-current={sort === tab.sort ? "page" : undefined}
          href={`?sort=${tab.sort}`}
          key={tab.sort}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
