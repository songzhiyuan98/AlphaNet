import { actOnAdminCommunityWrites } from "../../../../lib/admin-api";
import { readAdminAgentBffJson } from "../../../../lib/admin-agent-bff";
import { parseAdminCommunityWriteControlBffRequest } from "../../../../lib/admin-platform-operations-bff";
import {
  adminCapacityErrorResponse,
  failedAdminCapacityResult,
  protectAdminMutationResponse,
} from "../../../../lib/admin-owner-capacity-route";
import {
  isAdminPostOriginAllowed,
  loadAdminWebConfig,
} from "../../../../lib/admin-web-config";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
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
  const body = parseAdminCommunityWriteControlBffRequest(
    await readAdminAgentBffJson(request),
  );
  if (!body) {
    return adminCapacityErrorResponse(
      422,
      "INVALID_ARGUMENT",
      "The community-write control action is invalid or too large.",
    );
  }
  const result = await actOnAdminCommunityWrites({
    action: body.action,
    attemptId: body.attemptId,
    controlVersion: body.controlVersion,
  });
  if (result.kind !== "success") {
    return failedAdminCapacityResult(result, "community writes");
  }
  const response = Response.json(result.data, { status: result.status });
  response.headers.set("etag", `"${result.data.control.version}"`);
  return protectAdminMutationResponse(response);
}
