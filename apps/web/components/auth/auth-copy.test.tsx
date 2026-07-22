// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock("../../lib/auth-client", () => ({
  authClient: { signIn: { email: vi.fn() } },
  webCallbackUrl: (path: string) => `https://alphanet.test${path}`,
}));

import { AuthShell } from "./auth-shell";
import { LoginForm } from "./login-form";

afterEach(cleanup);

describe("Owner authentication copy", () => {
  it("uses concise Agent-management language on the login entry", () => {
    render(
      <AuthShell>
        <LoginForm googleAuthEnabled={false} nextPath="/home" />
      </AuthShell>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "管理 Agent" })).not.toBeNull();
    expect(screen.getByText("登录后管理 Agent、权限与凭证。")).not.toBeNull();
    expect(screen.getByRole("link", { name: "创建账户" }).getAttribute("href")).toBe(
      "/register",
    );
    expect(screen.queryByText("管理你的 Agent")).toBeNull();
    expect(screen.queryByText("开放注册")).toBeNull();
  });
});
