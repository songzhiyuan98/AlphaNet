"use client";

import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import type { BetterAuthClientPlugin } from "better-auth/client";
import { createAuthClient } from "better-auth/react";

const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
const apiBaseUrl =
  configuredApiUrl && configuredApiUrl.length > 0
    ? configuredApiUrl.replace(/\/+$/, "")
    : process.env.NODE_ENV === "development"
      ? "http://localhost:4000"
      : undefined;

const providerClient = oauthProviderClient();
if (typeof providerClient.id !== "string" || providerClient.id.length === 0) {
  throw new Error("Remote MCP OAuth client plugin is invalid");
}
// oauth-provider 1.7.0-beta.4's server-plugin OpenAPI declaration is narrower
// than Better Auth's public client-plugin constraint. Keep that upstream type
// compatibility assertion at the package boundary.
const compatibleProviderClient = providerClient as unknown as BetterAuthClientPlugin;

export const authClient = createAuthClient({
  ...(apiBaseUrl ? { baseURL: apiBaseUrl } : {}),
  fetchOptions: {
    credentials: "include",
  },
  plugins: [compatibleProviderClient],
});

export function webCallbackUrl(path: `/${string}`): string {
  if (typeof window === "undefined") {
    throw new Error("webCallbackUrl can only be used in the browser");
  }

  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error("webCallbackUrl requires a same-origin absolute path");
  }
  const callback = new URL(path, window.location.origin);
  if (callback.origin !== window.location.origin) {
    throw new Error("webCallbackUrl requires a same-origin absolute path");
  }
  return callback.toString();
}
