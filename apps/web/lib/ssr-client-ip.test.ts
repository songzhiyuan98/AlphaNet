import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { signedSsrClientIpHeaders } from "./ssr-client-ip";

const secret = "L8wq2Uox9sV7Gm1Xc4Kd6aJ0Ph5Rt3NyE1bZfQ7i";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SSR client IP forwarding", () => {
  it("signs a sanitized ingress chain without forwarding caller signatures", () => {
    vi.stubEnv("SSR_INTERNAL_REQUEST_SECRET", secret);
    const incoming = new Headers({
      "x-alphanet-ssr-signature": "caller-controlled",
      "x-forwarded-for": "198.51.100.25, 10.20.0.8",
    });
    const now = 1_784_582_400_000;
    const path = "/v1/public/agents/market-scout";

    const result = signedSsrClientIpHeaders(incoming, {
      method: "GET",
      now,
      url: path,
    });
    const expected = createHmac("sha256", secret)
      .update(
        [
          "alphanet-ssr-client-ip-v1",
          String(now),
          "GET",
          path,
          "198.51.100.25,10.20.0.8",
        ].join("\n"),
      )
      .digest("base64url");

    expect(result).toEqual({
      "x-alphanet-ssr-forwarded-for": "198.51.100.25,10.20.0.8",
      "x-alphanet-ssr-signature": expected,
      "x-alphanet-ssr-timestamp": String(now),
    });
    expect(result["x-alphanet-ssr-signature"]).not.toBe("caller-controlled");
  });

  it("does not sign malformed caller-controlled forwarding data", () => {
    vi.stubEnv("SSR_INTERNAL_REQUEST_SECRET", secret);
    const result = signedSsrClientIpHeaders(
      new Headers({ "x-forwarded-for": "forged.invalid, 198.51.100.25" }),
      {
        method: "GET",
        now: 1_784_582_400_000,
        url: "/v1/owner/agents",
      },
    );

    expect(result).toEqual({});
  });

  it("fails closed in production when the trusted ingress identity is absent", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SSR_INTERNAL_REQUEST_SECRET", secret);

    expect(() =>
      signedSsrClientIpHeaders(new Headers(), {
        method: "GET",
        now: 1_784_582_400_000,
        url: "/v1/public/agents/market-scout",
      }),
    ).toThrow("trusted ingress");
  });

  it("allows an explicit local-container exception without forging an identity", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SSR_ALLOW_MISSING_CLIENT_IP", "true");
    vi.stubEnv("SSR_INTERNAL_REQUEST_SECRET", secret);

    expect(
      signedSsrClientIpHeaders(new Headers(), {
        method: "GET",
        now: 1_784_582_400_000,
        url: "/v1/public/agents/market-scout",
      }),
    ).toEqual({});
  });
});
