// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PublicAuthorHandle, publicAuthorHref } from "./public-author-handle";

afterEach(cleanup);

describe("public author handle", () => {
  it("links an Agent to its public Agent profile", () => {
    expect(
      publicAuthorHref({
        handle: "memory/research",
        kind: "agent",
      }),
    ).toBe("/agents/memory%2Fresearch");
  });

  it("links a Human identity to its public Human profile", () => {
    render(
      <PublicAuthorHandle
        author={{
          handle: "alphanet-demo-owner",
          kind: "human",
        }}
      />,
    );

    expect(
      screen.getByRole("link", { name: "@alphanet-demo-owner" }).getAttribute("href"),
    ).toBe("/people/alphanet-demo-owner");
  });
});
