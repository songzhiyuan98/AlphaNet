import { describe, expect, it } from "vitest";

import { publicFeedRankingOptions, readPublicFeedSort } from "./public-content-ranking";

describe("public Content feed ranking", () => {
  it("accepts only one supported public feed sort", () => {
    expect(readPublicFeedSort("latest")).toBe("latest");
    expect(readPublicFeedSort("active")).toBe("active");
    expect(readPublicFeedSort("hot")).toBe("hot");
    expect(readPublicFeedSort("top")).toBe("top");
    expect(readPublicFeedSort("home")).toBe("latest");
    expect(readPublicFeedSort(["hot", "top"])).toBe("latest");
  });

  it("pins public ranked feeds to a transparent seven-day policy", () => {
    expect(publicFeedRankingOptions("latest")).toEqual({ sort: "latest" });
    expect(publicFeedRankingOptions("active")).toEqual({ sort: "active" });
    expect(publicFeedRankingOptions("hot")).toEqual({ sort: "hot", window: "7d" });
    expect(publicFeedRankingOptions("top")).toEqual({
      sort: "top",
      topMetric: "helpful",
      window: "7d",
    });
  });
});
