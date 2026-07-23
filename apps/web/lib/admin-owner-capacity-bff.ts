import {
  AdminOwnerPathParamsSchema,
  AdminOwnerQuotaActionRequestSchema,
  AdminRegistrationControlActionRequestSchema,
  type AdminOwnerQuotaActionRequest,
  type AdminRegistrationControlActionRequest,
} from "@alphanet/contracts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AdminOwnerQuotaBffRequest {
  action: AdminOwnerQuotaActionRequest;
  attemptId: string;
  quotaVersion: number;
}

export interface AdminRegistrationCapacityBffRequest {
  action: AdminRegistrationControlActionRequest;
  attemptId: string;
  capacityVersion: number;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function version(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function attempt(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

export function parseAdminOwnerQuotaBffRequest(
  value: unknown,
): AdminOwnerQuotaBffRequest | null {
  if (
    !plainRecord(value) ||
    Object.keys(value).sort().join(",") !== "action,attempt_id,quota_version"
  ) {
    return null;
  }
  const parsedAction = AdminOwnerQuotaActionRequestSchema.safeParse(value.action);
  const parsedAttempt = attempt(value.attempt_id);
  const parsedVersion = version(value.quota_version);
  return parsedAction.success && parsedAttempt && parsedVersion
    ? {
        action: parsedAction.data,
        attemptId: parsedAttempt,
        quotaVersion: parsedVersion,
      }
    : null;
}

export function parseAdminRegistrationCapacityBffRequest(
  value: unknown,
): AdminRegistrationCapacityBffRequest | null {
  if (
    !plainRecord(value) ||
    Object.keys(value).sort().join(",") !== "action,attempt_id,capacity_version"
  ) {
    return null;
  }
  const parsedAction = AdminRegistrationControlActionRequestSchema.safeParse(
    value.action,
  );
  const parsedAttempt = attempt(value.attempt_id);
  const parsedVersion = version(value.capacity_version);
  return parsedAction.success && parsedAttempt && parsedVersion
    ? {
        action: parsedAction.data,
        attemptId: parsedAttempt,
        capacityVersion: parsedVersion,
      }
    : null;
}

export function parseAdminOwnerPath(ownerId: string): string | null {
  const parsed = AdminOwnerPathParamsSchema.safeParse({ owner_id: ownerId });
  return parsed.success ? parsed.data.owner_id : null;
}
