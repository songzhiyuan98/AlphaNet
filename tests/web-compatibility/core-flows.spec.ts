/// <reference lib="dom" />

import { expect, test } from "@playwright/test";

const postTitle = "E2EFIX 虚构公司利润率假设（仅用于 E2E 测试）";

test("public discovery and research discussion remain usable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome to AlphaNet" })).toBeVisible();
  await page.getByRole("link", { exact: true, name: "社区" }).click();

  await expect(page).toHaveURL(/\/communities$/u);
  await expect(page.getByRole("heading", { name: "Market Structure Lab" })).toBeVisible();
  await page.getByRole("link", { name: "MARKET Market Structure Lab" }).click();

  await expect(page).toHaveURL(/\/communities\/market-structure$/u);
  await page.getByRole("link", { name: postTitle }).click();
  await expect(page.getByRole("heading", { name: postTitle })).toBeVisible();
  await expect(page.getByRole("heading", { name: "追问、反驳与补充" })).toBeVisible();
  await expect(page.getByText(/E2E 反方夹具/u)).toBeVisible();
});

test("public search keeps the research question out of the URL", async ({ page }) => {
  await page.goto("/search");
  const question = "E2EFIX 利润率假设有哪些反方证据?";

  await page.getByLabel("你希望从社区记忆中找到什么？").fill(question);
  await page.getByRole("button", { name: "搜索研究与讨论" }).click();

  await expect(page.getByRole("heading", { name: postTitle })).toBeVisible();
  await expect(page).toHaveURL(/\/search$/u);
  expect(page.url()).not.toContain(encodeURIComponent(question));
});

test("Owner login and registration remain operable", async ({ page }) => {
  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "登录 AlphaNet" })).toBeVisible();
  await page.getByLabel("邮箱").fill("owner@example.test");
  await page.locator('input[name="password"]').fill("A-secure-password-2026!");
  await expect(page.getByRole("button", { name: "登录" })).toBeEnabled();

  await page.getByRole("link", { name: "创建账户" }).click();
  await expect(page.getByRole("heading", { name: "创建账户" })).toBeVisible();
  await expect(page.getByLabel("显示名称")).toBeVisible();
  await expect(page.getByLabel("邮箱")).toBeVisible();
});

test("mobile navigation and primary surfaces do not overflow", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-safari", "mobile release project only");

  for (const path of ["/", "/communities", "/search", "/login"]) {
    await page.goto(path);
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth, `${path} has horizontal overflow`).toBeLessThanOrEqual(
      dimensions.clientWidth,
    );
  }

  await page.goto("/communities");
  await expect(
    page.getByRole("navigation", { name: "AlphaNet Agent 投资研究社交网络" }),
  ).toBeVisible();
  await expect(page.getByText("更多")).toBeVisible();
});
