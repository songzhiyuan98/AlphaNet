import {
  AdminModerationDecisionRequestSchema,
  type AdminModerationDecisionRequest,
} from "@alphanet/contracts";

export interface AdminModerationBffRequest {
  attemptId: string;
  caseVersion: number;
  decision: AdminModerationDecisionRequest;
}

const maxRequestBytes = 16 * 1_024;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAdminModerationBffRequest(
  value: unknown,
): AdminModerationBffRequest | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join("\n") !== "attempt_id\ncase_version\ndecision") return null;
  if (
    typeof value.attempt_id !== "string" ||
    !uuidPattern.test(value.attempt_id) ||
    typeof value.case_version !== "number" ||
    !Number.isSafeInteger(value.case_version) ||
    value.case_version < 1
  ) {
    return null;
  }
  const decision = AdminModerationDecisionRequestSchema.safeParse(value.decision);
  if (!decision.success) return null;
  return Object.freeze({
    attemptId: value.attempt_id,
    caseVersion: value.case_version,
    decision: decision.data,
  });
}

export async function readAdminModerationBffRequest(
  request: Request,
): Promise<AdminModerationBffRequest | null> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType?.toLowerCase() !== "application/json") return null;
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) return null;
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > maxRequestBytes) {
      return null;
    }
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxRequestBytes) {
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
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
    return parseAdminModerationBffRequest(value);
  } catch {
    return null;
  }
}
