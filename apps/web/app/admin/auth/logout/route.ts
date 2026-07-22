import { NextResponse } from "next/server";

import {
  isAdminPostOriginAllowed,
  loadAdminWebConfig,
  type EnabledAdminWebConfig,
} from "../../../../lib/admin-web-config";
import { getAdminSessionStore } from "../../../../lib/admin-session-store";

export const runtime = "nodejs";

function protectedResponse(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store, private");
  response.headers.set("pragma", "no-cache");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

function oneCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null || header.length > 8_192) return null;
  const values: string[] = [];
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    if (entry.slice(0, separator).trim() === name) {
      values.push(entry.slice(separator + 1).trim());
    }
  }
  return values.length === 1 ? values[0]! : null;
}

function clearCookie(
  response: NextResponse,
  config: EnabledAdminWebConfig,
  name: string,
): void {
  response.cookies.set({
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    name,
    path: "/",
    sameSite: "lax",
    secure: config.secureCookies,
    value: "",
  });
}

function errorResponse(status: number, code: string): NextResponse {
  return protectedResponse(
    NextResponse.json(
      {
        error: {
          code,
          message: "The Admin sign-out request could not be completed.",
        },
      },
      { status },
    ),
  );
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

  const sessionHandle = oneCookie(request, config.sessionCookieName);
  let deletionFailed = false;
  if (sessionHandle) {
    try {
      await getAdminSessionStore(config).deleteSession(sessionHandle);
    } catch {
      deletionFailed = true;
    }
  }

  const response = deletionFailed
    ? errorResponse(503, "ADMIN_AUTH_UNAVAILABLE")
    : protectedResponse(NextResponse.redirect(`${config.publicOrigin}/admin`, 303));
  clearCookie(response, config, config.sessionCookieName);
  clearCookie(response, config, config.loginCookieName);
  return response;
}
