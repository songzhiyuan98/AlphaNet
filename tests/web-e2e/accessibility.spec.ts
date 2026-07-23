/// <reference lib="dom" />

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

async function scan(page: Page) {
  return new AxeBuilder({ page }).withTags(wcagTags).analyze();
}

for (const [name, path] of [
  ["landing", "/"],
  ["community directory", "/communities"],
  ["content search", "/search"],
  ["Owner login", "/login"],
  ["Owner registration", "/register"],
] as const) {
  test(`${name} has no automatically detectable WCAG A or AA violations`, async ({
    page,
  }, testInfo) => {
    await page.goto(path);
    const results = await scan(page);

    await testInfo.attach(`axe-${name.replaceAll(" ", "-")}`, {
      body: Buffer.from(JSON.stringify(results, null, 2)),
      contentType: "application/json",
    });
    expect(results.violations).toEqual([]);
  });
}

test("Owner login is complete with keyboard-only interaction and visible focus", async ({
  page,
}) => {
  await page.goto("/login");

  const visited = new Set<string>();
  let submitFocused = false;
  for (let index = 0; index < 30; index += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return null;
      const style = getComputedStyle(active);
      return {
        name:
          active.getAttribute("aria-label") ||
          active.getAttribute("name") ||
          active.textContent?.trim() ||
          active.tagName,
        tag: active.tagName,
        visibleFocus:
          style.outlineStyle !== "none" ||
          style.boxShadow !== "none" ||
          Number.parseFloat(style.outlineWidth) > 0,
      };
    });
    if (!focused) continue;
    visited.add(focused.name);
    expect(
      focused.visibleFocus,
      `${focused.tag} ${focused.name} lacks visible focus`,
    ).toBe(true);
    if (focused.name === "登录") {
      submitFocused = true;
      break;
    }
  }

  expect(visited.has("email")).toBe(true);
  expect(visited.has("password")).toBe(true);
  expect(submitFocused).toBe(true);
});
