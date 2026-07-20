import { defineConfig, devices } from "@playwright/test";

const webPort = 3_000;
const webBaseUrl = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  expect: {
    timeout: 5_000,
  },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  outputDir: "test-results/web-e2e",
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "list",
  retries: process.env.CI ? 1 : 0,
  testDir: "tests/web-e2e",
  timeout: 30_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: webBaseUrl,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  webServer: {
    command: "bash .github/scripts/start-web-e2e.sh",
    env: {
      ...process.env,
      API_INTERNAL_URL: "http://127.0.0.1:49999",
      NEXT_PUBLIC_API_URL: "http://127.0.0.1:49999",
    },
    reuseExistingServer: !process.env.CI,
    stderr: "pipe",
    stdout: "pipe",
    timeout: 120_000,
    url: `${webBaseUrl}/health`,
  },
  ...(process.env.CI ? { workers: 1 } : {}),
});
