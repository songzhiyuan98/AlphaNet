import { randomUUID } from "node:crypto";

import {
  createAdminTopicCommunity,
  type AdminApiResult,
  type AdminApiSafeError,
} from "../../../../lib/admin-api";
import {
  parseAdminCommunityCreateBffRequest,
  readAdminCommunityBffJson,
} from "../../../../lib/admin-community-bff";
import {
  isAdminPostOriginAllowed,
  loadAdminWebConfig,
} from "../../../../lib/admin-web-config";

export const runtime = "nodejs";

function protectedResponse(response: Response): Response {
  response.headers.set("cache-control", "no-store, private");
  response.headers.set("pragma", "no-cache");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

function errorResponse(
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
  return protectedResponse(response);
}

function failed<T>(result: Exclude<AdminApiResult<T>, { kind: "success" }>): Response {
  switch (result.kind) {
    case "disabled":
      return errorResponse(404, "NOT_FOUND", "The Admin surface is not enabled.");
    case "unauthenticated":
      return errorResponse(
        401,
        "ADMIN_AUTHENTICATION_REQUIRED",
        "A valid Workforce Admin session is required.",
      );
    case "forbidden":
      return errorResponse(
        403,
        result.error.code,
        "The current Workforce identity cannot manage communities.",
        result.error,
      );
    case "not_found":
      return errorResponse(
        404,
        result.error.code,
        "The community was not found.",
        result.error,
      );
    case "invalid":
      return errorResponse(
        422,
        result.error?.code ?? "INVALID_ARGUMENT",
        "The community request does not match the required contract.",
        result.error,
      );
    case "conflict":
      return errorResponse(
        409,
        result.error.code,
        "The community already exists or changed before this action.",
        result.error,
      );
    case "rate_limited":
      return errorResponse(
        429,
        result.error.code,
        "Too many community actions were attempted.",
        { ...result.error, retryAfterMs: result.retryAfterMs },
      );
    case "unavailable":
      return errorResponse(
        503,
        result.error?.code ?? "TEMPORARILY_UNAVAILABLE",
        "Community management is temporarily unavailable.",
        result.error,
      );
  }
}

export async function POST(request: Request): Promise<Response> {
  let config;
  try {
    config = loadAdminWebConfig();
  } catch {
    return errorResponse(
      503,
      "TEMPORARILY_UNAVAILABLE",
      "Admin configuration is unavailable.",
    );
  }
  if (!config.enabled)
    return errorResponse(404, "NOT_FOUND", "The Admin surface is not enabled.");
  if (!isAdminPostOriginAllowed(request.headers.get("origin"), config)) {
    return errorResponse(
      403,
      "ORIGIN_REQUIRED",
      "An exact same-origin POST is required.",
    );
  }
  const requestUrl = new URL(request.url);
  if (requestUrl.searchParams.size !== 0) {
    return errorResponse(422, "INVALID_ARGUMENT", "Query parameters are not accepted.");
  }
  const body = parseAdminCommunityCreateBffRequest(
    await readAdminCommunityBffJson(request),
  );
  if (!body) {
    return errorResponse(
      422,
      "INVALID_ARGUMENT",
      "The community body is invalid or too large.",
    );
  }
  const result = await createAdminTopicCommunity(body);
  if (result.kind !== "success") return failed(result);
  return protectedResponse(Response.json(result.data, { status: result.status }));
}
