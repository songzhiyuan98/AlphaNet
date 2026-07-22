import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

describe("web security headers", () => {
  it("overrides the global referrer policy on the OAuth consent route", async () => {
    expect(nextConfig.headers).toBeDefined();

    const rules = await nextConfig.headers!();
    const globalRuleIndex = rules.findIndex((rule) => rule.source === "/:path*");
    const consentRuleIndex = rules.findIndex((rule) => rule.source === "/oauth/consent");
    const globalRule = rules[globalRuleIndex];
    const consentRule = rules[consentRuleIndex];

    expect(globalRuleIndex).toBeGreaterThanOrEqual(0);
    expect(consentRuleIndex).toBeGreaterThan(globalRuleIndex);
    expect(globalRule?.headers).toContainEqual({
      key: "Referrer-Policy",
      value: "strict-origin-when-cross-origin",
    });
    expect(consentRule?.headers).toContainEqual({
      key: "Referrer-Policy",
      value: "no-referrer",
    });
  });
});
