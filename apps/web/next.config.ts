import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const globalSecurityHeaders = [
  {
    key: "Content-Security-Policy",
    value: "base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
] as const;

const oauthConsentSecurityHeaders = [
  {
    key: "Referrer-Policy",
    value: "no-referrer",
  },
] as const;

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  headers() {
    return Promise.resolve([
      {
        headers: [...globalSecurityHeaders],
        source: "/:path*",
      },
      // Matching header rules are applied in order. Keep this route last so its
      // stricter policy replaces the global Referrer-Policy for consent URLs.
      {
        headers: [...oauthConsentSecurityHeaders],
        source: "/oauth/consent",
      },
    ]);
  },
  output: "standalone",
  poweredByHeader: false,
  turbopack: {
    root: workspaceRoot,
  },
  transpilePackages: ["@alphanet/contracts"],
};

export default nextConfig;
