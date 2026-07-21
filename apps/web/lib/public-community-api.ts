import {
  FindCommunitiesResponseSchema,
  GetCommunityResponseSchema,
  type CommunityDetailProjection,
  type CommunitySearchItem,
  type FindCommunitiesResponse,
} from "@alphanet/contracts";
import { headers } from "next/headers";

import { signedSsrClientIpHeaders } from "./ssr-client-ip";

export type PublicCommunityApiResult<T> =
  { kind: "not_found" } | { kind: "success"; data: T } | { kind: "unavailable" };

export type PublicStockCommunityResult =
  | PublicCommunityApiResult<CommunityDetailProjection>
  | {
      kind: "ambiguous";
      candidates: CommunitySearchItem[];
      incomplete: boolean;
      symbol: string;
    };

function apiInternalUrl(): string {
  const configured =
    process.env.API_INTERNAL_URL?.trim() ?? process.env.NEXT_PUBLIC_API_URL?.trim();
  return (
    configured && configured.length > 0 ? configured : "http://localhost:4000"
  ).replace(/\/+$/, "");
}

async function publicApiRequest<T>(
  path: string,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  init: RequestInit = {},
): Promise<PublicCommunityApiResult<T>> {
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
      signal: AbortSignal.timeout(4_000),
    });

    if (response.status === 404) {
      return { kind: "not_found" };
    }
    if (!response.ok) {
      return { kind: "unavailable" };
    }

    const parsed = schema.safeParse(await response.json());
    return parsed.success
      ? { kind: "success", data: parsed.data }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

export function getPublicCommunities(
  options: {
    cursor?: string | undefined;
    limit?: number | undefined;
    query?: string | undefined;
  } = {},
): Promise<PublicCommunityApiResult<FindCommunitiesResponse>> {
  const query = options.query?.trim();
  if (query) {
    return publicApiRequest(
      "/v1/public/communities/search",
      FindCommunitiesResponseSchema,
      {
        body: JSON.stringify({
          query,
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.limit ? { limit: options.limit } : {}),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
  }

  const parameters = new URLSearchParams();
  parameters.set("states", "active,read_only");
  if (options.limit) parameters.set("limit", String(options.limit));
  if (options.cursor) parameters.set("cursor", options.cursor);
  return publicApiRequest(
    `/v1/public/communities?${parameters.toString()}`,
    FindCommunitiesResponseSchema,
  );
}

async function findPublicTopicCommunity(
  topic: string,
): Promise<PublicCommunityApiResult<CommunitySearchItem>> {
  const result = await publicApiRequest(
    "/v1/public/communities/search",
    FindCommunitiesResponseSchema,
    {
      body: JSON.stringify({ topics: [topic], limit: 20 }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );

  if (result.kind !== "success") return result;
  const match = result.data.items.find(
    (item) =>
      item.canonical_target?.type === "topic" && item.canonical_target.slug === topic,
  );
  return match ? { kind: "success", data: match } : { kind: "not_found" };
}

async function getPublicCommunityByItem(
  item: CommunitySearchItem,
): Promise<PublicCommunityApiResult<CommunityDetailProjection>> {
  const result = await publicApiRequest(
    `/v1/public/communities/${encodeURIComponent(item.id)}`,
    GetCommunityResponseSchema,
  );
  return result.kind === "success"
    ? { kind: "success", data: result.data.community }
    : result;
}

export async function getPublicCommunityBySlug(
  slug: string,
): Promise<PublicCommunityApiResult<CommunityDetailProjection>> {
  const result = await publicApiRequest(
    `/v1/public/communities/by-slug/${encodeURIComponent(slug)}`,
    GetCommunityResponseSchema,
  );
  return result.kind === "success"
    ? { kind: "success", data: result.data.community }
    : result;
}

export async function getPublicStockCommunity(
  symbol: string,
): Promise<PublicStockCommunityResult> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const result = await publicApiRequest(
    "/v1/public/communities/search",
    FindCommunitiesResponseSchema,
    {
      body: JSON.stringify({ symbols: [normalizedSymbol], limit: 100 }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );

  if (result.kind !== "success") return result;

  const seenIdentities = new Set<string>();
  const candidates = result.data.items.filter((item) => {
    if (
      item.canonical_target?.type !== "symbol" ||
      item.canonical_target.symbol !== normalizedSymbol
    ) {
      return false;
    }
    const identity = `${item.id}\u0000${item.slug}\u0000${item.canonical_target.id}`;
    if (seenIdentities.has(identity)) return false;
    seenIdentities.add(identity);
    return true;
  });

  if (result.data.page.has_more || candidates.length > 1) {
    return {
      candidates,
      incomplete: result.data.page.has_more,
      kind: "ambiguous",
      symbol: normalizedSymbol,
    };
  }

  const candidate = candidates[0];
  if (!candidate) return { kind: "not_found" };

  const detail = await getPublicCommunityByItem(candidate);
  if (detail.kind !== "success") return detail;
  const target = detail.data.canonical_target;
  if (
    detail.data.id !== candidate.id ||
    detail.data.slug !== candidate.slug ||
    detail.data.kind !== "symbol" ||
    target?.type !== "symbol" ||
    target.id !== candidate.canonical_target?.id ||
    target.symbol !== normalizedSymbol
  ) {
    return { kind: "unavailable" };
  }
  return detail;
}

export async function getPublicTopicCommunity(
  topic: string,
): Promise<PublicCommunityApiResult<CommunityDetailProjection>> {
  const found = await findPublicTopicCommunity(topic);
  return found.kind === "success" ? getPublicCommunityByItem(found.data) : found;
}

export function communityHref(
  community: Pick<CommunitySearchItem, "canonical_target" | "slug">,
): string {
  if (community.canonical_target?.type === "symbol") {
    return `/stocks/${encodeURIComponent(community.canonical_target.symbol)}`;
  }
  if (community.canonical_target?.type === "topic") {
    return `/topics/${encodeURIComponent(community.canonical_target.slug)}`;
  }
  return `/communities/${encodeURIComponent(community.slug)}`;
}
