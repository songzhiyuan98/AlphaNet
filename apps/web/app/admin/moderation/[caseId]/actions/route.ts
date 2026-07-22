import { randomUUID } from "node:crypto";

import { AdminModerationCasePathParamsSchema } from "@alphanet/contracts";

import {
  decideAdminModerationCase,
  type AdminApiResult,
  type AdminApiSafeError,
} from "../../../../../lib/admin-api";
import { readAdminModerationBffRequest } from "../../../../../lib/admin-moderation-bff";
import {
  isAdminPostOriginAllowed,
  loadAdminWebConfig,
} from "../../../../../lib/admin-web-config";

export const runtime = "nodejs";

function protectedHeaders(response: Response): Response {
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
  return protectedHeaders(response);
}

function failedDecisionResponse<T>(
  result: Exclude<AdminApiResult<T>, { kind: "success" }>,
): Response {
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
        "The current Workforce identity is not authorized for this decision.",
        result.error,
      );
    case "not_found":
      return errorResponse(
        404,
        result.error.code,
        "The moderation Case was not found.",
        result.error,
      );
    case "invalid":
      return errorResponse(
        422,
        result.error?.code ?? "INVALID_ARGUMENT",
        "The moderation decision does not match the required contract.",
        result.error,
      );
    case "conflict":
      return errorResponse(
        409,
        result.error.code,
        "The moderation Case or content state has changed.",
        result.error,
      );
    case "rate_limited":
      return errorResponse(
        429,
        result.error.code,
        "Too many moderation decisions were attempted in this time window.",
        { ...result.error, retryAfterMs: result.retryAfterMs },
      );
    case "unavailable":
      return errorResponse(
        503,
        result.error?.code ?? "TEMPORARILY_UNAVAILABLE",
        "The moderation service is temporarily unavailable.",
        result.error,
      );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ caseId: string }> },
): Promise<Response> {
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
  if (!config.enabled) {
    return errorResponse(404, "NOT_FOUND", "The Admin surface is not enabled.");
  }
  if (!isAdminPostOriginAllowed(request.headers.get("origin"), config)) {
    return errorResponse(
      403,
      "ORIGIN_REQUIRED",
      "An exact same-origin POST is required.",
    );
  }
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return errorResponse(422, "INVALID_ARGUMENT", "The request URL is invalid.");
  }
  if (requestUrl.searchParams.size !== 0) {
    return errorResponse(422, "INVALID_ARGUMENT", "Query parameters are not accepted.");
  }
  const path = AdminModerationCasePathParamsSchema.safeParse({
    case_id: (await context.params).caseId,
  });
  if (!path.success) {
    return errorResponse(422, "INVALID_ARGUMENT", "The moderation Case ID is invalid.");
  }
  const body = await readAdminModerationBffRequest(request);
  if (!body) {
    return errorResponse(
      422,
      "INVALID_ARGUMENT",
      "The moderation decision body is invalid or too large.",
    );
  }

  const result = await decideAdminModerationCase({
    attemptId: body.attemptId,
    caseId: path.data.case_id,
    caseVersion: body.caseVersion,
    decision: body.decision,
  });
  if (result.kind !== "success") return failedDecisionResponse(result);
  const response = Response.json(result.data, { status: result.status });
  response.headers.set("etag", `"${result.data.case.case_version}"`);
  return protectedHeaders(response);
}
