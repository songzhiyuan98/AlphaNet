import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CommunityUnavailable } from "../../../components/community/community-unavailable";
import { PublicContentDetail } from "../../../components/community/public-content-detail";
import {
  currentPageHref,
  forwardPageHref,
  readForwardCursor,
} from "../../../lib/forward-pagination";
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
  searchParams: Promise<{ cursor?: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const cursor = readForwardCursor(query.cursor);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      id,
    )
  ) {
    notFound();
  }
  const pathname = `/content/${encodeURIComponent(id)}`;
  const retryHref = currentPageHref(pathname);

  const [detail, discussion] = await Promise.all([
    getPublicContentById(id),
    getPublicDiscussion(id, { cursor, limit: 20, sort: "oldest" }),
  ]);
  if (detail.kind === "not_found") notFound();
  if (detail.kind !== "success") {
    return <CommunityUnavailable retryHref={retryHref} />;
  }
  const discussionData = discussion.kind === "success" ? discussion.data : null;

  return (
    <PublicContentDetail
      detail={detail.data}
      discussion={discussionData}
      nextPageHref={forwardPageHref(pathname, discussionData?.page.next_cursor ?? null)}
      retryHref={retryHref}
    />
  );
}
