import {
  BrowseContentResponseSchema,
  GetContentResponseSchema,
  GetDiscussionResponseSchema,
  SearchContentResponseSchema,
  type BrowseContentRequest,
  type BrowseContentResponse,
  type GetContentResponse,
  type GetDiscussionResponse,
  type SearchContentRequest,
  type SearchContentResponse,
} from "@alphanet/contracts";
import { headers } from "next/headers";

import { signedSsrClientIpHeaders } from "./ssr-client-ip";

export type PublicContentApiResult<T> =
  { kind: "not_found" } | { kind: "success"; data: T } | { kind: "unavailable" };

export type PublicContentScope =
  | { scope: "global" }
  | { communityId: string; scope: "community" }
  | { authorActorId: string; scope: "author" }
  | { scope: "symbol"; symbol: string }
  | { scope: "topic"; topic: string };

export type PublicContentBrowseOptions = PublicContentScope & {
  contentTypes?: readonly ("post" | "reply")[] | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  sort?: BrowseContentRequest["sort"] | undefined;
  topMetric?: BrowseContentRequest["top_metric"] | undefined;
  window?: BrowseContentRequest["window"] | undefined;
};

function apiInternalUrl(): string {
  const configured =
    process.env.API_INTERNAL_URL?.trim() ?? process.env.NEXT_PUBLIC_API_URL?.trim();
  return (
    configured && configured.length > 0 ? configured : "http://localhost:4000"
  ).replace(/\/+$/, "");
}

async function publicContentRequest<T>(
  path: string,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  init: RequestInit = {},
  timeoutMilliseconds = 4_000,
): Promise<PublicContentApiResult<T>> {
  try {
    const incomingHeaders = await headers();
    const method = init.method ?? "GET";
    const requestHeaders = new Headers(init.headers);
    requestHeaders.set("accept", "application/json");
    for (const [name, value] of Object.entries(
      signedSsrClientIpHeaders(incomingHeaders, { method, url: path }),
    )) {
      requestHeaders.set(name, value);
    }
    const response = await fetch(`${apiInternalUrl()}${path}`, {
      ...init,
      cache: "no-store",
      headers: requestHeaders,
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });

    if (response.status === 404) return { kind: "not_found" };
    if (!response.ok) return { kind: "unavailable" };

    const parsed = schema.safeParse(await response.json());
    return parsed.success
      ? { kind: "success", data: parsed.data }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

export function searchPublicContent(
  request: SearchContentRequest,
): Promise<PublicContentApiResult<SearchContentResponse>> {
  return publicContentRequest(
    "/v1/public/content/search",
    SearchContentResponseSchema,
    {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    8_000,
  );
}

export function getPublicContent(
  options: PublicContentBrowseOptions,
): Promise<PublicContentApiResult<BrowseContentResponse>> {
  const parameters = new URLSearchParams({
    scope: options.scope,
    sort: options.sort ?? "latest",
  });
  if (options.scope === "community") {
    parameters.set("community_id", options.communityId);
  } else if (options.scope === "author") {
    parameters.set("author_actor_id", options.authorActorId);
  } else if (options.scope === "symbol") {
    parameters.set("symbol", options.symbol.toUpperCase());
  } else if (options.scope === "topic") {
    parameters.set("topic", options.topic.toLowerCase());
  }
  if (options.contentTypes?.length) {
    parameters.set("content_types", options.contentTypes.join(","));
  }
  if (options.topMetric) parameters.set("top_metric", options.topMetric);
  if (options.window) parameters.set("window", options.window);
  if (options.limit) parameters.set("limit", String(options.limit));
  if (options.cursor) parameters.set("cursor", options.cursor);

  return publicContentRequest(
    `/v1/public/content?${parameters.toString()}`,
    BrowseContentResponseSchema,
  );
}

export function getPublicContentById(
  contentId: string,
): Promise<PublicContentApiResult<GetContentResponse>> {
  return publicContentRequest(
    `/v1/public/content/${encodeURIComponent(contentId)}`,
    GetContentResponseSchema,
  );
}

export function getPublicDiscussion(
  contentId: string,
  options: {
    cursor?: string | undefined;
    limit?: number | undefined;
    sort?: "latest" | "oldest" | undefined;
  } = {},
): Promise<PublicContentApiResult<GetDiscussionResponse>> {
  const parameters = new URLSearchParams({ sort: options.sort ?? "oldest" });
  if (options.limit) parameters.set("limit", String(options.limit));
  if (options.cursor) parameters.set("cursor", options.cursor);
  return publicContentRequest(
    `/v1/public/content/${encodeURIComponent(contentId)}/discussion?${parameters.toString()}`,
    GetDiscussionResponseSchema,
  );
}
