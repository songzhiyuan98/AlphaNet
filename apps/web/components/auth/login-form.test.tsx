// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  signInEmail: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.push,
    refresh: mocks.refresh,
    replace: mocks.replace,
  }),
}));

vi.mock("../../lib/auth-client", () => ({
  authClient: { signIn: { email: mocks.signInEmail } },
  webCallbackUrl: (path: string) => `https://alphanet.test${path}`,
}));

import { LoginForm } from "./login-form";

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  mocks.refresh.mockReset();
  mocks.replace.mockReset();
  mocks.signInEmail.mockReset();
});

async function submitLogin(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "邮箱" }), "OWNER@Example.com");
  await user.type(screen.getByLabelText(/^密码/), "A-secure-password-2026!");
  await user.click(screen.getByRole("button", { name: "登录" }));
}

describe("LoginForm OAuth recovery", () => {
  it("keeps ordinary Owner login on the requested same-origin page", async () => {
    mocks.signInEmail.mockResolvedValue({
      data: { redirect: false, token: "opaque", url: undefined, user: {} },
      error: null,
    });
    render(<LoginForm googleAuthEnabled={false} nextPath="/settings/agents" />);

    await submitLogin();

    await waitFor(() => {
      expect(mocks.signInEmail).toHaveBeenCalledExactlyOnceWith({
        callbackURL: "https://alphanet.test/settings/agents",
        email: "owner@example.com",
        password: "A-secure-password-2026!",
        rememberMe: true,
      });
      expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/settings/agents");
      expect(mocks.refresh).toHaveBeenCalledOnce();
    });
  });

  it("does not replace the Provider-owned redirect when OAuth login resumes", async () => {
    mocks.signInEmail.mockResolvedValue({
      data: {
        redirect: true,
        token: "opaque",
        url: "https://api.alphanet.test/api/auth/oauth2/authorize?signed=1",
        user: {},
      },
      error: null,
    });
    render(<LoginForm googleAuthEnabled={false} nextPath="/home" />);

    await submitLogin();

    await waitFor(() => {
      expect(mocks.signInEmail).toHaveBeenCalledOnce();
    });
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
