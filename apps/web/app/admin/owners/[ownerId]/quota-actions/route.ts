import { actOnAdminOwnerQuota } from "../../../../../lib/admin-api";
import { readAdminAgentBffJson } from "../../../../../lib/admin-agent-bff";
import {
  parseAdminOwnerPath,
  parseAdminOwnerQuotaBffRequest,
} from "../../../../../lib/admin-owner-capacity-bff";
import {
  adminCapacityErrorResponse,
  failedAdminCapacityResult,
  protectAdminMutationResponse,
} from "../../../../../lib/admin-owner-capacity-route";
import {
  isAdminPostOriginAllowed,
  loadAdminWebConfig,
} from "../../../../../lib/admin-web-config";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ ownerId: string }> },
): Promise<Response> {
  let config;
  try {
    config = loadAdminWebConfig();
  } catch {
    return adminCapacityErrorResponse(
      503,
      "TEMPORARILY_UNAVAILABLE",
      "Admin configuration is unavailable.",
    );
  }
  if (!config.enabled) {
    return adminCapacityErrorResponse(
      404,
      "NOT_FOUND",
      "The Admin surface is not enabled.",
    );
  }
  if (!isAdminPostOriginAllowed(request.headers.get("origin"), config)) {
    return adminCapacityErrorResponse(
      403,
      "ORIGIN_REQUIRED",
      "An exact same-origin POST is required.",
    );
  }
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return adminCapacityErrorResponse(
      422,
      "INVALID_ARGUMENT",
      "The request URL is invalid.",
    );
  }
  if (requestUrl.searchParams.size !== 0) {
    return adminCapacityErrorResponse(
      422,
      "INVALID_ARGUMENT",
      "Query parameters are not accepted.",
    );
  }
  const ownerId = parseAdminOwnerPath((await context.params).ownerId);
  const body = parseAdminOwnerQuotaBffRequest(await readAdminAgentBffJson(request));
  if (!ownerId || !body) {
    return adminCapacityErrorResponse(
      422,
      "INVALID_ARGUMENT",
      "The Owner quota action is invalid or too large.",
    );
  }
  const result = await actOnAdminOwnerQuota({
    action: body.action,
    attemptId: body.attemptId,
    ownerId,
    quotaVersion: body.quotaVersion,
  });
  if (result.kind !== "success") {
    return failedAdminCapacityResult(result, "Owner quota");
  }
  const response = Response.json(result.data, { status: result.status });
  response.headers.set("etag", `"${result.data.owner.quota_version}"`);
  return protectAdminMutationResponse(response);
}
