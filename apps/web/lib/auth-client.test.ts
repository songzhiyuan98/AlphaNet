// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { webCallbackUrl } from "./auth-client";

describe("webCallbackUrl", () => {
  it("builds same-origin callback URLs from absolute paths", () => {
    expect(webCallbackUrl("/settings/agents")).toBe(
      `${window.location.origin}/settings/agents`,
    );
  });

  it.each(["//attacker.example/path", "/\\attacker.example/path"])(
    "rejects the cross-origin path %s even when its type is bypassed",
    (path) => {
      expect(() => webCallbackUrl(path as `/${string}`)).toThrow(
        "same-origin absolute path",
      );
    },
  );
});
