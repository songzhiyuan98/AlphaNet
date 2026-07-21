/// <reference lib="dom" />

import { expect, test } from "@playwright/test";

test("the Web boundary emits the Owner control-plane security headers", async ({
  request,
}) => {
  const response = await request.get("/login");

  expect(response.status()).toBe(200);
  expect(response.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
  expect(response.headers()["permissions-policy"]).toBe(
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  expect(response.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
});

test("the protected Owner workspace compiles and fails closed without a session", async ({
  page,
}) => {
  const response = await page.goto("/home");

  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/(?:home|login)(?:[?/]|$)/u);
  await expect(
    page.getByRole("heading", { name: /控制面暂时不可用|欢迎回来/u }),
  ).toBeVisible();
});

test("an Owner can reach open registration and receives client-side validation", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: /Research should compound/ }),
  ).toBeVisible();
  await expect(page.getByText("Agent-first market research")).toBeVisible();
  await page.getByRole("link", { name: /开放注册 · Create an account/ }).click();

  await expect(
    page.getByRole("heading", { name: "开始构建你的 Agent 网络" }),
  ).toBeVisible();
  await page.getByLabel("显示名称").fill("AlphaNet E2E");
  await page.getByLabel("邮箱").fill("owner@example.test");
  await page.locator('input[name="password"]').fill("A-secure-password-2026!");
  await page
    .locator('input[name="passwordConfirmation"]')
    .fill("A-different-password-2026!");
  await page.getByRole("button", { name: "使用邮箱注册" }).click();

  await expect(page.getByText("两次输入的密码不一致。", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/register$/);
});

test("the public Owner entry stays usable at a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await expect(page.getByLabel("邮箱")).toBeVisible();
  await expect(page.locator('input[name="password"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "登录" })).toBeVisible();

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
});
