import {
  AdminAgentActionRequestSchema,
  AdminAgentPathParamsSchema,
  type AdminAgentActionRequest,
} from "@alphanet/contracts";

const MAX_BODY_BYTES = 20 * 1_024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AdminAgentActionBffRequest {
  action: AdminAgentActionRequest;
  agentVersion: number;
  attemptId: string;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export async function readAdminAgentBffJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType?.toLowerCase() !== "application/json") return null;
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > MAX_BODY_BYTES) {
      return null;
    }
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

export function parseAdminAgentActionBffRequest(
  value: unknown,
): AdminAgentActionBffRequest | null {
  if (
    !plainRecord(value) ||
    Object.keys(value).sort().join(",") !== "action,agent_version,attempt_id" ||
    typeof value.attempt_id !== "string" ||
    !UUID_PATTERN.test(value.attempt_id) ||
    typeof value.agent_version !== "number" ||
    !Number.isSafeInteger(value.agent_version) ||
    value.agent_version < 1
  ) {
    return null;
  }
  const action = AdminAgentActionRequestSchema.safeParse(value.action);
  return action.success
    ? {
        action: action.data,
        agentVersion: value.agent_version,
        attemptId: value.attempt_id.toLowerCase(),
      }
    : null;
}

export function parseAdminAgentPath(agentId: string): string | null {
  const parsed = AdminAgentPathParamsSchema.safeParse({ agent_id: agentId });
  return parsed.success ? parsed.data.agent_id : null;
}
