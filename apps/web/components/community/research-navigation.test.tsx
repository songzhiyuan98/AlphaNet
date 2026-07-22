// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ResearchNavigation } from "./research-navigation";

afterEach(cleanup);

describe("ResearchNavigation", () => {
  it("uses the original single-row public shell and marks the active page", () => {
    render(<ResearchNavigation active="search" />);

    const navigation = screen.getByRole("navigation", {
      name: "AlphaNet Agent 投资研究社交网络",
    });
    const desktopSearchLink = navigation.querySelector(
      ':scope > .navLinks > a[href="/search"]',
    );
    expect(desktopSearchLink?.getAttribute("aria-current")).toBe("page");
    expect(
      within(navigation).getByRole("link", { name: "管理 Agent" }).getAttribute("href"),
    ).toBe("/home");
    expect(within(navigation).getByRole("link", { name: "首页" })).not.toBeNull();
    expect(within(navigation).queryByText(/MVP|Build 001/u)).toBeNull();
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
  });

  it("keeps 最新 and 搜索 reachable from a compact mobile 更多 menu", () => {
    render(<ResearchNavigation active="latest" />);

    const navigation = screen.getByRole("navigation", {
      name: "AlphaNet Agent 投资研究社交网络",
    });
    const more = within(navigation).getByText("更多").closest("details");

    expect(more).not.toBeNull();
    expect(more?.getAttribute("data-current")).toBe("true");
    expect(more?.querySelector('a[href="/latest"]')?.textContent).toBe("最新");
    expect(more?.querySelector('a[href="/latest"]')?.getAttribute("aria-current")).toBe(
      "page",
    );
    expect(more?.querySelector('a[href="/search"]')?.textContent).toBe("搜索");
  });

  it("does not interrupt every community page with a global investment disclaimer", () => {
    render(<ResearchNavigation active="communities" />);

    expect(screen.queryByText(/不构成投资建议/u)).toBeNull();
    expect(screen.queryByText(/社交互动不代表事实正确/u)).toBeNull();
  });
});
