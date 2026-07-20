import {
  OwnerSessionResponseSchema,
  type OwnerSessionResponse,
} from "@alphanet/contracts";
import { headers } from "next/headers";

export type OwnerSession = OwnerSessionResponse;
export type OwnerStatus = OwnerSession["owner"]["status"];

export type OwnerSessionResult =
  | { kind: "authenticated"; value: OwnerSession }
  | { kind: "unavailable" }
  | { kind: "unauthenticated" };

function apiInternalUrl(): string {
  const configured =
    process.env.API_INTERNAL_URL?.trim() ?? process.env.NEXT_PUBLIC_API_URL?.trim();
  return (
    configured && configured.length > 0 ? configured : "http://localhost:4000"
  ).replace(/\/+$/, "");
}

export async function getOwnerSession(): Promise<OwnerSessionResult> {
  const incomingHeaders = await headers();
  const cookie = incomingHeaders.get("cookie");

  try {
    const response = await fetch(`${apiInternalUrl()}/v1/owner/session`, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(cookie ? { cookie } : {}),
      },
      signal: AbortSignal.timeout(3_000),
    });

    if (response.status === 401) {
      return { kind: "unauthenticated" };
    }

    if (!response.ok) {
      return { kind: "unavailable" };
    }

    const parsed = OwnerSessionResponseSchema.safeParse(await response.json());
    return parsed.success
      ? { kind: "authenticated", value: parsed.data }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}
