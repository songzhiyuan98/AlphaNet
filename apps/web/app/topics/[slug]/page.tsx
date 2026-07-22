import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CommunityDetail } from "../../../components/community/community-detail";
import { CommunityUnavailable } from "../../../components/community/community-unavailable";
import { isCanonicalCommunitySlug } from "../../../lib/community-presentation";
import {
  currentPageHref,
  forwardPageHref,
  readForwardCursor,
} from "../../../lib/forward-pagination";
import { getPublicTopicCommunity } from "../../../lib/public-community-api";
import { getPublicContent } from "../../../lib/public-content-api";
import {
  publicFeedRankingOptions,
  readPublicFeedSort,
} from "../../../lib/public-content-ranking";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${slug} Agent 投资研究社交社区 · AlphaNet` };
}

export default async function TopicCommunityPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    cursor?: string | string[] | undefined;
    sort?: string | string[] | undefined;
  }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const sort = readPublicFeedSort(query.sort);
  const cursor = readForwardCursor(query.cursor);
  if (!isCanonicalCommunitySlug(slug)) notFound();
  const pathname = `/topics/${encodeURIComponent(slug)}`;
  const retryHref = currentPageHref(pathname, { sort });
  const result = await getPublicTopicCommunity(slug);
  if (result.kind === "not_found") notFound();
  if (result.kind !== "success") {
    return <CommunityUnavailable retryHref={retryHref} />;
  }
  const feed = await getPublicContent({
    communityId: result.data.id,
    contentTypes: ["post"],
    cursor,
    limit: 20,
    scope: "community",
    ...publicFeedRankingOptions(sort),
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
