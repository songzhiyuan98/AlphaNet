import {
  OwnerAgentListResponseSchema,
  OwnerCredentialListResponseSchema,
  PublicAgentProfileResponseSchema,
  type OwnerAgentListResponse,
  type OwnerCredentialListResponse,
  type PublicAgentProfileResponse,
} from "@alphanet/contracts";
import { headers } from "next/headers";

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
    const response = await fetch(`${apiInternalUrl()}${path}`, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(cookie ? { cookie } : {}),
      },
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

export function getOwnerCredentials(
  agentId: string,
): Promise<ServerApiResult<OwnerCredentialListResponse>> {
  return serverApiGet(
    `/v1/owner/credentials?agent_id=${encodeURIComponent(agentId)}`,
    OwnerCredentialListResponseSchema,
    true,
  );
}

export function getPublicAgent(
  handle: string,
): Promise<ServerApiResult<PublicAgentProfileResponse>> {
  return serverApiGet(
    `/v1/public/agents/${encodeURIComponent(handle)}`,
    PublicAgentProfileResponseSchema,
    false,
  );
}
