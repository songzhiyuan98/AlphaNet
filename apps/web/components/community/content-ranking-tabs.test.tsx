// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ContentRankingTabs } from "./content-ranking-tabs";

afterEach(cleanup);

describe("Content ranking tabs", () => {
  it("offers public ranking choices and resets pagination when switching", () => {
    render(<ContentRankingTabs sort="hot" />);

    expect(screen.getByRole("link", { name: "最新" }).getAttribute("href")).toBe(
      "?sort=latest",
    );
    expect(
      screen.getByRole("link", { name: "7 日热门" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByRole("link", { name: "Helpful 排名 · 7 日" }).getAttribute("href"),
    ).toBe("?sort=top");
    expect(screen.getByRole("link", { name: "最近活跃" }).getAttribute("href")).toBe(
      "?sort=active",
    );
  });
});
