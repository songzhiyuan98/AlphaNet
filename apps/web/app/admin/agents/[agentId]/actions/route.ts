import { randomUUID } from "node:crypto";

import {
  actOnAdminAgent,
  type AdminApiResult,
  type AdminApiSafeError,
} from "../../../../../lib/admin-api";
import {
  parseAdminAgentActionBffRequest,
  parseAdminAgentPath,
  readAdminAgentBffJson,
} from "../../../../../lib/admin-agent-bff";
import {
  isAdminPostOriginAllowed,
  loadAdminWebConfig,
} from "../../../../../lib/admin-web-config";

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
  if (result.kind === "unauthenticated") {
    return errorResponse(
      401,
      "ADMIN_AUTHENTICATION_REQUIRED",
      "A valid Workforce Admin session is required.",
    );
  }
  if (result.kind === "forbidden") {
    return errorResponse(
      403,
      result.error.code,
      "This identity cannot govern Agents.",
      result.error,
    );
  }
  if (result.kind === "not_found") {
    return errorResponse(
      404,
      result.error.code,
      "The Agent was not found.",
      result.error,
    );
  }
  if (result.kind === "conflict") {
    return errorResponse(
      409,
      result.error.code,
      "The Agent changed before this action.",
      result.error,
    );
  }
  if (result.kind === "invalid") {
    return errorResponse(
      422,
      result.error?.code ?? "INVALID_ARGUMENT",
      "The Agent action is invalid.",
      result.error,
    );
  }
  if (result.kind === "rate_limited") {
    return errorResponse(429, result.error.code, "Too many actions were attempted.", {
      ...result.error,
      retryAfterMs: result.retryAfterMs,
    });
  }
  if (result.kind === "disabled") {
    return errorResponse(404, "NOT_FOUND", "The Admin surface is not enabled.");
  }
  return errorResponse(
    503,
    result.error?.code ?? "TEMPORARILY_UNAVAILABLE",
    "Agent governance is temporarily unavailable.",
    result.error,
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ agentId: string }> },
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
  const agentId = parseAdminAgentPath((await context.params).agentId);
  const body = parseAdminAgentActionBffRequest(await readAdminAgentBffJson(request));
  if (!agentId || !body) {
    return errorResponse(
      422,
      "INVALID_ARGUMENT",
      "The Agent action is invalid or too large.",
    );
  }
  const result = await actOnAdminAgent({
    action: body.action,
    agentId,
    agentVersion: body.agentVersion,
    attemptId: body.attemptId,
  });
  if (result.kind !== "success") return failed(result);
  const success = Response.json(result.data, { status: result.status });
  success.headers.set("etag", `"${result.data.agent.governance_version}"`);
  return protectedResponse(success);
}
