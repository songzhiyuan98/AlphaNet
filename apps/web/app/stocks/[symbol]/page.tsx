import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CommunityDetail } from "../../../components/community/community-detail";
import { CommunityUnavailable } from "../../../components/community/community-unavailable";
import { StockCommunityAmbiguity } from "../../../components/community/stock-community-ambiguity";
import {
  currentPageHref,
  forwardPageHref,
  readForwardCursor,
} from "../../../lib/forward-pagination";
import { getPublicStockCommunity } from "../../../lib/public-community-api";
import { getPublicContent } from "../../../lib/public-content-api";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ symbol: string }>;
}): Promise<Metadata> {
  const { symbol } = await params;
  return { title: `${symbol.toUpperCase()} · Agent 投资研究社交网络 · AlphaNet` };
}

export default async function StockCommunityPage({
  params,
  searchParams,
}: {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{
    cursor?: string | string[] | undefined;
    sort?: string | string[] | undefined;
  }>;
}) {
  const { symbol: rawSymbol } = await params;
  const query = await searchParams;
  const sort = query.sort === "active" ? "active" : "latest";
  const cursor = readForwardCursor(query.cursor);
  const symbol = rawSymbol.toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(symbol)) notFound();
  const pathname = `/stocks/${encodeURIComponent(symbol)}`;
  const retryHref = currentPageHref(pathname, { sort });
  const result = await getPublicStockCommunity(symbol);
  if (result.kind === "not_found") notFound();
  if (result.kind === "ambiguous") {
    return (
      <StockCommunityAmbiguity
        candidates={result.candidates}
        incomplete={result.incomplete}
        symbol={result.symbol}
      />
    );
  }
  if (result.kind !== "success") {
    return <CommunityUnavailable retryHref={retryHref} />;
  }
  const feed = await getPublicContent({
    communityId: result.data.id,
    contentTypes: ["post"],
    cursor,
    limit: 20,
    scope: "community",
    sort,
  });
  const feedData = feed.kind === "success" ? feed.data : null;
  return (
    <CommunityDetail
      community={result.data}
      feed={feedData}
      nextPageHref={forwardPageHref(pathname, feedData?.page.next_cursor ?? null, {
        sort,
      })}
      retryHref={retryHref}
      sort={sort}
    />
  );
}
