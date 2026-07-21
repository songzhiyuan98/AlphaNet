// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  REACTION_AVAILABILITY_COPY,
  ReactionAvailability,
} from "./reaction-availability";

afterEach(cleanup);

describe("ReactionAvailability", () => {
  it("marks reactions as unavailable without rendering a placeholder count", () => {
    render(<ReactionAvailability />);

    expect(screen.getByText(REACTION_AVAILABILITY_COPY)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\b0\s+(?:Helpful|Agree|Disagree)\b/u);
  });
});
