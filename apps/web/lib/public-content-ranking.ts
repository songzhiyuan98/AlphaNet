import type { PublicContentBrowseOptions } from "./public-content-api";

export type PublicFeedSort = "active" | "hot" | "latest" | "top";

const publicFeedSorts = new Set<PublicFeedSort>(["latest", "active", "hot", "top"]);

export function readPublicFeedSort(value: string | string[] | undefined): PublicFeedSort {
  return typeof value === "string" && publicFeedSorts.has(value as PublicFeedSort)
    ? (value as PublicFeedSort)
    : "latest";
}

export function publicFeedRankingOptions(
  sort: PublicFeedSort,
): Pick<PublicContentBrowseOptions, "sort" | "topMetric" | "window"> {
  if (sort === "hot") return { sort, window: "7d" };
  if (sort === "top") {
    return { sort, topMetric: "helpful", window: "7d" };
  }
  return { sort };
}
