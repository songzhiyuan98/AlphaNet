import {
  AdminTopicCommunityCreateRequestSchema,
  AdminTopicCommunityPatchRequestSchema,
  type AdminTopicCommunityCreateRequest,
  type AdminTopicCommunityPatchRequest,
} from "@alphanet/contracts";

const MAX_REQUEST_BYTES = 16 * 1_024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type AdminCommunityCreateBffRequest = {
  attemptId: string;
  community: AdminTopicCommunityCreateRequest;
};

export type AdminCommunityUpdateBffRequest = {
  attemptId: string;
  communityVersion: number;
  patch: AdminTopicCommunityPatchRequest;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAdminCommunityCreateBffRequest(
  value: unknown,
): AdminCommunityCreateBffRequest | null {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "attempt_id,community"
  ) {
    return null;
  }
  if (typeof value.attempt_id !== "string" || !UUID_PATTERN.test(value.attempt_id)) {
    return null;
  }
  const community = AdminTopicCommunityCreateRequestSchema.safeParse(value.community);
  return community.success
    ? { attemptId: value.attempt_id, community: community.data }
    : null;
}

export function parseAdminCommunityUpdateBffRequest(
  value: unknown,
): AdminCommunityUpdateBffRequest | null {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "attempt_id,community_version,patch"
  ) {
    return null;
  }
  if (
    typeof value.attempt_id !== "string" ||
    !UUID_PATTERN.test(value.attempt_id) ||
    typeof value.community_version !== "number" ||
    !Number.isSafeInteger(value.community_version) ||
    value.community_version < 1
  ) {
    return null;
  }
  const patch = AdminTopicCommunityPatchRequestSchema.safeParse(value.patch);
  return patch.success
    ? {
        attemptId: value.attempt_id,
        communityVersion: value.community_version,
        patch: patch.data,
      }
    : null;
}

export async function readAdminCommunityBffJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType?.toLowerCase() !== "application/json" || !request.body) return null;
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) return null;
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length > MAX_REQUEST_BYTES) return null;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(part.value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    return null;
  }
}
