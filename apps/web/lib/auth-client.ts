"use client";

import { createAuthClient } from "better-auth/react";

const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
const apiBaseUrl =
  configuredApiUrl && configuredApiUrl.length > 0
    ? configuredApiUrl.replace(/\/+$/, "")
    : process.env.NODE_ENV === "development"
      ? "http://localhost:4000"
      : undefined;

export const authClient = createAuthClient({
  ...(apiBaseUrl ? { baseURL: apiBaseUrl } : {}),
  fetchOptions: {
    credentials: "include",
  },
});

export function webCallbackUrl(path: `/${string}`): string {
  if (typeof window === "undefined") {
    throw new Error("webCallbackUrl can only be used in the browser");
  }

  return new URL(path, window.location.origin).toString();
}
