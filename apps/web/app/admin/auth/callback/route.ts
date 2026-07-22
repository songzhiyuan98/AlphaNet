import { NextResponse } from "next/server";

import {
  loadAdminWebConfig,
  type EnabledAdminWebConfig,
} from "../../../../lib/admin-web-config";
import { AdminOidcError, getAdminOidcService } from "../../../../lib/admin-oidc";
import { getAdminSessionStore } from "../../../../lib/admin-session-store";

export const runtime = "nodejs";

function protectedResponse(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store, private");
  response.headers.set("pragma", "no-cache");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

function clearLoginCookie(response: NextResponse, config: EnabledAdminWebConfig): void {
  response.cookies.set({
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    name: config.loginCookieName,
    path: "/",
    sameSite: "lax",
    secure: config.secureCookies,
    value: "",
  });
}

function errorRedirect(
  config: EnabledAdminWebConfig,
  code: "invalid_response" | "unavailable",
): NextResponse {
  const query = new URLSearchParams({ code });
  const response = protectedResponse(
    NextResponse.redirect(
      `${config.publicOrigin}/admin/auth/error?${query.toString()}`,
      303,
    ),
  );
  clearLoginCookie(response, config);
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

export async function GET(request: Request): Promise<NextResponse> {
  let config;
  try {
    config = loadAdminWebConfig();
  } catch {
    return protectedResponse(
      NextResponse.json(
        {
          error: {
            code: "ADMIN_AUTH_UNAVAILABLE",
            message: "Admin authentication is temporarily unavailable.",
          },
        },
        { status: 503 },
      ),
    );
  }
  if (!config.enabled) {
    return protectedResponse(
      NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Not found." } },
        { status: 404 },
      ),
    );
  }

  const loginHandle = oneCookie(request, config.loginCookieName);
  if (!loginHandle) return errorRedirect(config, "invalid_response");

  let callbackUrl: URL;
  let callbackState: string;
  try {
    const incomingUrl = new URL(request.url);
    const stateValues = incomingUrl.searchParams.getAll("state");
    if (stateValues.length !== 1 || !stateValues[0]) {
      return errorRedirect(config, "invalid_response");
    }
    callbackState = stateValues[0];
    callbackUrl = new URL(config.callbackUrl);
    callbackUrl.search = incomingUrl.search;
  } catch {
    return errorRedirect(config, "invalid_response");
  }

  let transaction;
  try {
    transaction = await getAdminSessionStore(config).consumeLoginTransaction(
      loginHandle,
      callbackState,
    );
  } catch {
    return errorRedirect(config, "unavailable");
  }
  if (!transaction) return errorRedirect(config, "invalid_response");

  try {
    const token = await getAdminOidcService(config).exchangeAuthorizationCode(
      callbackUrl,
      transaction,
    );
    const session = await getAdminSessionStore(config).createSession(token);
    const response = protectedResponse(
      NextResponse.redirect(`${config.publicOrigin}${transaction.returnTo}`, 303),
    );
    clearLoginCookie(response, config);
    response.cookies.set({
      expires: session.expiresAt,
      httpOnly: true,
      name: config.sessionCookieName,
      path: "/",
      sameSite: "lax",
      secure: config.secureCookies,
      value: session.handle,
    });
    return response;
  } catch (error) {
    return errorRedirect(
      config,
      error instanceof AdminOidcError && error.code === "authentication_failed"
        ? "invalid_response"
        : "unavailable",
    );
  }
}
