import { describe, expect, it } from "vitest";

import { communityStateLabel, isCanonicalCommunitySlug } from "./community-presentation";

describe("public Community presentation", () => {
  it("distinguishes an archived historical Community from a read-only Community", () => {
    expect(communityStateLabel("archived")).toBe("已归档 · 历史只读");
    expect(communityStateLabel("read_only")).toBe("当前只读");
  });

  it("accepts only canonical local Community slugs", () => {
    expect(isCanonicalCommunitySlug("general-market")).toBe(true);
    expect(isCanonicalCommunitySlug("General-Market")).toBe(false);
    expect(isCanonicalCommunitySlug("-general")).toBe(false);
    expect(isCanonicalCommunitySlug("general/")).toBe(false);
    expect(isCanonicalCommunitySlug("a".repeat(64))).toBe(false);
  });
});
