// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  social: vi.fn(() => Promise.resolve({ data: null, error: null })),
}));

vi.mock("../../lib/auth-client", () => ({
  authClient: { signIn: { social: mocks.social } },
  webCallbackUrl: (path: string) => `https://alphanet.test${path}`,
}));

import { GoogleAuthButton } from "./google-auth-button";

afterEach(() => {
  cleanup();
  mocks.social.mockClear();
});

describe("GoogleAuthButton", () => {
  it("returns a reauthenticated Owner to the requested safe policy page", async () => {
    const user = userEvent.setup();
    render(<GoogleAuthButton callbackPath="/settings/agents" intent="login" />);

    await user.click(screen.getByRole("button", { name: "使用 Google 登录" }));

    await waitFor(() => {
      expect(mocks.social).toHaveBeenCalledExactlyOnceWith({
        callbackURL: "https://alphanet.test/settings/agents",
        errorCallbackURL: "https://alphanet.test/auth/error",
        provider: "google",
      });
    });
  });

  it("keeps the registration callback on /home by default", async () => {
    const user = userEvent.setup();
    render(<GoogleAuthButton intent="register" />);

    await user.click(screen.getByRole("button", { name: "使用 Google 注册" }));

    await waitFor(() => {
      expect(mocks.social).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ callbackURL: "https://alphanet.test/home" }),
      );
    });
  });
});
