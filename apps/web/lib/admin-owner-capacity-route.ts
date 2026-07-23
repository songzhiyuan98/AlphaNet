import { randomUUID } from "node:crypto";

import type { AdminApiResult, AdminApiSafeError } from "./admin-api";

export function protectAdminMutationResponse(response: Response): Response {
  response.headers.set("cache-control", "no-store, private");
  response.headers.set("pragma", "no-cache");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

export function adminCapacityErrorResponse(
  status: number,
  code: string,
  message: string,
  error: AdminApiSafeError | null = null,
): Response {
  const retryAfterMs = error?.retryAfterMs ?? null;
  const details = {
    ...(error?.currentVersion ? { current_version: error.currentVersion } : {}),
    ...(error?.requiredPermission
      ? { required_permission: error.requiredPermission }
      : {}),
  };
  const response = Response.json(
    {
      error: {
        code,
        details: Object.keys(details).length > 0 ? details : null,
        message,
        retry_after_ms: retryAfterMs,
        retryable: status === 429 || status === 503,
      },
      request_id: error?.requestId ?? `web-${randomUUID()}`,
      schema_version: "1",
    },
    { status },
  );
  if (status === 429 && retryAfterMs) {
    response.headers.set(
      "retry-after",
      String(Math.max(1, Math.ceil(retryAfterMs / 1_000))),
    );
  }
  return protectAdminMutationResponse(response);
}

export function failedAdminCapacityResult<T>(
  result: Exclude<AdminApiResult<T>, { kind: "success" }>,
  target: "Owner quota" | "community writes" | "registration capacity",
): Response {
  if (result.kind === "unauthenticated") {
    return adminCapacityErrorResponse(
      401,
      "ADMIN_AUTHENTICATION_REQUIRED",
      "A valid Workforce Admin session is required.",
    );
  }
  if (result.kind === "forbidden") {
    return adminCapacityErrorResponse(
      403,
      result.error.code,
      `This identity cannot manage ${target}.`,
      result.error,
    );
  }
  if (result.kind === "not_found") {
    return adminCapacityErrorResponse(
      404,
      result.error.code,
      "The Owner was not found.",
      result.error,
    );
  }
  if (result.kind === "conflict") {
    return adminCapacityErrorResponse(
      409,
      result.error.code,
      `The ${target} state changed before this action.`,
      result.error,
    );
  }
  if (result.kind === "invalid") {
    return adminCapacityErrorResponse(
      422,
      result.error?.code ?? "INVALID_ARGUMENT",
      `The ${target} action is invalid.`,
      result.error,
    );
  }
  if (result.kind === "rate_limited") {
    return adminCapacityErrorResponse(
      429,
      result.error.code,
      "Too many actions were attempted.",
      { ...result.error, retryAfterMs: result.retryAfterMs },
    );
  }
  if (result.kind === "disabled") {
    return adminCapacityErrorResponse(
      404,
      "NOT_FOUND",
      "The Admin surface is not enabled.",
    );
  }
  return adminCapacityErrorResponse(
    503,
    result.error?.code ?? "TEMPORARILY_UNAVAILABLE",
    `${target} is temporarily unavailable.`,
    result.error,
  );
}
