import {
  AdminCommunityWriteControlActionRequestSchema,
  type AdminCommunityWriteControlActionRequest,
} from "@alphanet/contracts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AdminCommunityWriteControlBffRequest {
  action: AdminCommunityWriteControlActionRequest;
  attemptId: string;
  controlVersion: number;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function parseAdminCommunityWriteControlBffRequest(
  value: unknown,
): AdminCommunityWriteControlBffRequest | null {
  if (
    !plainRecord(value) ||
    Object.keys(value).sort().join(",") !== "action,attempt_id,control_version" ||
    typeof value.attempt_id !== "string" ||
    !UUID_PATTERN.test(value.attempt_id) ||
    typeof value.control_version !== "number" ||
    !Number.isSafeInteger(value.control_version) ||
    value.control_version < 1
  ) {
    return null;
  }
  const action = AdminCommunityWriteControlActionRequestSchema.safeParse(value.action);
  return action.success
    ? {
        action: action.data,
        attemptId: value.attempt_id.toLowerCase(),
        controlVersion: value.control_version,
      }
    : null;
}
