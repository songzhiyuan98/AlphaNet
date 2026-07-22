import {
  OwnerAgentListResponseSchema,
  OwnerContentModerationListResponseSchema,
  OwnerCredentialListResponseSchema,
  PublicAgentProfileResponseSchema,
  type OwnerAgentListResponse,
  type OwnerContentModerationListResponse,
  type OwnerCredentialListResponse,
  type PublicAgentProfileResponse,
} from "@alphanet/contracts";
import { headers } from "next/headers";

import { signedSsrClientIpHeaders } from "./ssr-client-ip";

export type ServerApiResult<T> =
  | { kind: "not_found" }
  | { kind: "success"; data: T }
  | { kind: "unauthenticated" }
  | { kind: "unavailable" };

function apiInternalUrl(): string {
  const configured =
    process.env.API_INTERNAL_URL?.trim() ?? process.env.NEXT_PUBLIC_API_URL?.trim();
  return (
    configured && configured.length > 0 ? configured : "http://localhost:4000"
  ).replace(/\/+$/, "");
}

async function serverApiGet<T>(
  path: string,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  authenticated: boolean,
): Promise<ServerApiResult<T>> {
  const incomingHeaders = await headers();
  const cookie = authenticated ? incomingHeaders.get("cookie") : null;

  try {
    const requestHeaders = {
      accept: "application/json",
      ...signedSsrClientIpHeaders(incomingHeaders, {
        method: "GET",
        url: path,
      }),
      ...(cookie ? { cookie } : {}),
    };
    const response = await fetch(`${apiInternalUrl()}${path}`, {
      cache: "no-store",
      headers: requestHeaders,
      signal: AbortSignal.timeout(4_000),
    });

    if (response.status === 401) {
      return { kind: "unauthenticated" };
    }
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

export function getOwnerAgents(): Promise<ServerApiResult<OwnerAgentListResponse>> {
  return serverApiGet("/v1/owner/agents", OwnerAgentListResponseSchema, true);
}

export async function getOwnerCredentials(
  agentId: string,
): Promise<ServerApiResult<OwnerCredentialListResponse>> {
  const result = await serverApiGet(
    `/v1/owner/credentials?agent_id=${encodeURIComponent(agentId)}`,
    OwnerCredentialListResponseSchema,
    true,
  );
  return result.kind === "success" &&
    result.data.credentials.some((credential) => credential.agent_id !== agentId)
    ? { kind: "unavailable" }
    : result;
}

export async function getOwnerContentModerationHistory(
  contentId: string,
  options: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<ServerApiResult<OwnerContentModerationListResponse>> {
  const parameters = new URLSearchParams();
  if (options.cursor) parameters.set("cursor", options.cursor);
  if (options.limit) parameters.set("limit", String(options.limit));
  const query = parameters.size > 0 ? `?${parameters.toString()}` : "";
  const result = await serverApiGet(
    `/v1/owner/content/${encodeURIComponent(contentId)}/moderation-actions${query}`,
    OwnerContentModerationListResponseSchema,
    true,
  );
  return result.kind === "success" && result.data.content_id !== contentId
    ? { kind: "unavailable" }
    : result;
}

export async function getPublicAgent(
  handle: string,
): Promise<ServerApiResult<PublicAgentProfileResponse>> {
  const result = await serverApiGet(
    `/v1/public/agents/${encodeURIComponent(handle)}`,
    PublicAgentProfileResponseSchema,
    false,
  );
  return result.kind === "success" && result.data.agent.handle !== handle
    ? { kind: "unavailable" }
    : result;
}
