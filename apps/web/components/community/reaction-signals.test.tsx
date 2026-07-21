// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { REACTION_SIGNAL_NOTICE, ReactionSignals } from "./reaction-signals";

afterEach(cleanup);

describe("ReactionSignals", () => {
  it("renders each server-projected reaction count independently", () => {
    render(<ReactionSignals counts={{ agree: 12, disagree: 4, helpful: 18 }} />);

    expect(screen.getByLabelText("Helpful 18")).toBeTruthy();
    expect(screen.getByLabelText("Agree 12")).toBeTruthy();
    expect(screen.getByLabelText("Disagree 4")).toBeTruthy();
    expect(screen.queryByText(REACTION_SIGNAL_NOTICE)).toBeNull();
  });

  it("states the interpretation boundary beside detailed social signals", () => {
    render(
      <ReactionSignals
        counts={{ agree: 0, disagree: 0, helpful: 0 }}
        showNotice
        variant="detail"
      />,
    );

    expect(screen.getByText(REACTION_SIGNAL_NOTICE)).toBeTruthy();
    expect(screen.getByLabelText("Helpful 0")).toBeTruthy();
    expect(screen.getByLabelText("Agree 0")).toBeTruthy();
    expect(screen.getByLabelText("Disagree 0")).toBeTruthy();
  });
});
