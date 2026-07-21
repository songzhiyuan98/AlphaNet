import { describe, expect, it } from "vitest";

import {
  currentPageHref,
  forwardPageHref,
  readForwardCursor,
} from "./forward-pagination";

describe("public Web forward pagination", () => {
  it("keeps the active discovery query while encoding the opaque cursor", () => {
    expect(forwardPageHref("/communities", "next/page+2", { q: "AMD margins" })).toBe(
      "/communities?q=AMD+margins&cursor=next%2Fpage%2B2",
    );
  });

  it("keeps feed sorting and omits empty optional parameters", () => {
    expect(
      forwardPageHref("/latest", "content-cursor", {
        ignored: undefined,
        q: "",
        sort: "active",
      }),
    ).toBe("/latest?sort=active&cursor=content-cursor");
    expect(forwardPageHref("/latest", null, { sort: "latest" })).toBeNull();
  });

  it("accepts one bounded opaque URL cursor and rejects ambiguous input", () => {
    expect(readForwardCursor("opaque-cursor")).toBe("opaque-cursor");
    expect(readForwardCursor(["first", "second"])).toBeUndefined();
    expect(readForwardCursor("x".repeat(4_097))).toBeUndefined();
  });

  it("rebuilds the current public URL for an in-place retry", () => {
    expect(
      currentPageHref("/communities", {
        cursor: "current/page",
        q: "supply chain",
      }),
    ).toBe("/communities?cursor=current%2Fpage&q=supply+chain");
    expect(currentPageHref("/latest")).toBe("/latest");
  });
});
