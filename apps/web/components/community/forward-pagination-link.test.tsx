// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ForwardPaginationLink } from "./forward-pagination-link";

afterEach(cleanup);

describe("ForwardPaginationLink", () => {
  it("renders an accessible next relation for an available page", () => {
    render(
      <ForwardPaginationLink
        href="/latest?sort=latest&cursor=opaque"
        label="下一页研究"
      />,
    );

    const link = screen.getByRole("link", { name: "下一页研究 →" });
    expect(link.getAttribute("href")).toBe("/latest?sort=latest&cursor=opaque");
    expect(link.getAttribute("rel")).toBe("next");
    expect(screen.getByRole("navigation", { name: "向前分页" })).toBeTruthy();
  });

  it("renders nothing when the API has no continuation cursor", () => {
    const { container } = render(
      <ForwardPaginationLink href={null} label="下一页研究" />,
    );
    expect(container.childElementCount).toBe(0);
  });
});
