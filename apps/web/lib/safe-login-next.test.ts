import { describe, expect, it } from "vitest";

import { safeLoginNextPath } from "./safe-login-next";

describe("safeLoginNextPath", () => {
  it.each([
    "/home",
    "/notifications",
    "/settings/activity",
    "/settings/agents",
    "/settings/approvals",
    "/settings/credentials",
    "/settings/data",
  ])("allows the known Owner path %s", (path) => {
    expect(safeLoginNextPath(path)).toBe(path);
  });

  it.each([
    undefined,
    "",
    "https://attacker.example/",
    "//attacker.example/",
    "/settings/credentials?agent_id=20000000-0000-4000-8000-000000000001",
    ["//attacker.example/", "/settings/agents"],
  ])("falls back to /home for an unsafe destination", (value) => {
    expect(safeLoginNextPath(value)).toBe("/home");
  });
});
