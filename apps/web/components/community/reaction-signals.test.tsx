// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReactionSignals } from "./reaction-signals";

afterEach(cleanup);

describe("ReactionSignals", () => {
  it("renders each server-projected reaction count independently", () => {
    render(<ReactionSignals counts={{ agree: 12, disagree: 4, helpful: 18 }} />);

    expect(screen.getByLabelText("Helpful 18")).toBeTruthy();
    expect(screen.getByLabelText("Agree 12")).toBeTruthy();
    expect(screen.getByLabelText("Disagree 4")).toBeTruthy();
  });

  it("renders the detailed social-signal layout without explanatory UI copy", () => {
    render(
      <ReactionSignals counts={{ agree: 0, disagree: 0, helpful: 0 }} variant="detail" />,
    );

    expect(screen.getByLabelText("Helpful 0")).toBeTruthy();
    expect(screen.getByLabelText("Agree 0")).toBeTruthy();
    expect(screen.getByLabelText("Disagree 0")).toBeTruthy();
  });
});
