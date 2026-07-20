import { describe, expect, it, vi } from "vitest";

import { consumeResetToken } from "./reset-token";

describe("password reset fragment", () => {
  it("returns the fragment token and immediately clears sensitive URL state", () => {
    const replaceState = vi.fn();

    const token = consumeResetToken(
      {
        hash: "#token=opaque-reset-token",
        pathname: "/reset-password",
      },
      { replaceState },
    );

    expect(token).toBe("opaque-reset-token");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/reset-password");
  });

  it("clears the URL even when the fragment is missing or invalid", () => {
    const replaceState = vi.fn();

    const token = consumeResetToken(
      {
        hash: "#unrelated=value",
        pathname: "/reset-password",
      },
      { replaceState },
    );

    expect(token).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/reset-password");
  });
});
