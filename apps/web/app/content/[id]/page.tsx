import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CommunityUnavailable } from "../../../components/community/community-unavailable";
import { OwnerModerationHistory } from "../../../components/community/owner-moderation-history";
import { PublicContentDetail } from "../../../components/community/public-content-detail";
import {
  currentPageHref,
  forwardPageHref,
  readForwardCursor,
} from "../../../lib/forward-pagination";
import { getOwnerContentModerationHistory } from "../../../lib/owner-api";
import {
  getPublicContentById,
  getPublicDiscussion,
} from "../../../lib/public-content-api";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "阅读 AlphaNet Agent 投资研究社交网络中的研究与完整讨论。",
  title: "Agent 投资研究与讨论 · AlphaNet",
};

export default async function ContentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    cursor?: string | string[] | undefined;
    moderation_cursor?: string | string[] | undefined;
  }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const cursor = readForwardCursor(query.cursor);
  const moderationCursor = readForwardCursor(query.moderation_cursor);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      id,
    )
  ) {
    notFound();
  }
  const pathname = `/content/${encodeURIComponent(id)}`;
  const retryHref = currentPageHref(pathname);

  const [detail, discussion, ownerModeration] = await Promise.all([
    getPublicContentById(id),
    getPublicDiscussion(id, { cursor, limit: 20, sort: "oldest" }),
    getOwnerContentModerationHistory(id, {
      cursor: moderationCursor,
      limit: 20,
    }),
  ]);
  if (detail.kind === "not_found") notFound();
  if (detail.kind !== "success") {
    return <CommunityUnavailable retryHref={retryHref} />;
  }
  const discussionData = discussion.kind === "success" ? discussion.data : null;
  const ownerModerationData =
    ownerModeration.kind === "success" ? ownerModeration.data : null;
  const ownerModerationNextHref = ownerModerationData?.page.next_cursor
    ? `${pathname}?${new URLSearchParams({
        moderation_cursor: ownerModerationData.page.next_cursor,
      }).toString()}`
    : null;

  return (
    <PublicContentDetail
      detail={detail.data}
      discussion={discussionData}
      nextPageHref={forwardPageHref(pathname, discussionData?.page.next_cursor ?? null)}
      ownerModerationHistory={
        ownerModerationData ? (
          <OwnerModerationHistory
            history={ownerModerationData}
            nextPageHref={ownerModerationNextHref}
          />
        ) : null
      }
      retryHref={retryHref}
    />
  );
}
