import { NextResponse } from "next/server";

import {
  isAdminPostOriginAllowed,
  loadAdminWebConfig,
  normalizeAdminReturnTo,
  type EnabledAdminWebConfig,
} from "../../../../lib/admin-web-config";
import { getAdminOidcService } from "../../../../lib/admin-oidc";
import { getAdminSessionStore } from "../../../../lib/admin-session-store";

export const runtime = "nodejs";

function protectedResponse(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store, private");
  response.headers.set("pragma", "no-cache");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

function errorResponse(status: number, code: string): NextResponse {
  return protectedResponse(
    NextResponse.json(
      {
        error: {
          code,
          message: "The Admin sign-in request could not be completed.",
        },
      },
      { status },
    ),
  );
}

function errorRedirect(config: EnabledAdminWebConfig, code: "unavailable"): NextResponse {
  const query = new URLSearchParams({ code });
  return protectedResponse(
    NextResponse.redirect(
      `${config.publicOrigin}/admin/auth/error?${query.toString()}`,
      303,
    ),
  );
}

function loginCookie(
  response: NextResponse,
  config: EnabledAdminWebConfig,
  handle: string,
  expiresAt: Date,
): void {
  response.cookies.set({
    expires: expiresAt,
    httpOnly: true,
    name: config.loginCookieName,
    path: "/",
    sameSite: "lax",
    secure: config.secureCookies,
    value: handle,
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  let config;
  try {
    config = loadAdminWebConfig();
  } catch {
    return errorResponse(503, "ADMIN_AUTH_UNAVAILABLE");
  }
  if (!config.enabled) return errorResponse(404, "NOT_FOUND");
  if (!isAdminPostOriginAllowed(request.headers.get("origin"), config)) {
    return errorResponse(403, "ORIGIN_REQUIRED");
  }

  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return errorResponse(400, "INVALID_REQUEST");
  }
  const returnToValues = requestUrl.searchParams.getAll("return_to");
  if (
    returnToValues.length > 1 ||
    [...requestUrl.searchParams.keys()].some((name) => name !== "return_to")
  ) {
    return errorResponse(400, "INVALID_REQUEST");
  }
  const returnTo = normalizeAdminReturnTo(returnToValues[0]);

  try {
    const authorization =
      await getAdminOidcService(config).createAuthorizationRequest(returnTo);
    const transaction = await getAdminSessionStore(config).createLoginTransaction(
      authorization.transaction,
    );
    const response = protectedResponse(
      NextResponse.redirect(authorization.authorizationUrl, 303),
    );
    loginCookie(response, config, transaction.handle, transaction.expiresAt);
    return response;
  } catch {
    return errorRedirect(config, "unavailable");
  }
}
