import { defineConfig, devices } from "@playwright/test";

const publicApiPort = Number(process.env.E2E_PUBLIC_API_PORT ?? 50_999);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5_100);
const publicApiBaseUrl = `http://127.0.0.1:${publicApiPort}`;
const webBaseUrl = `http://127.0.0.1:${webPort}`;
const ssrInternalRequestSecret =
  process.env.E2E_SSR_INTERNAL_REQUEST_SECRET?.trim() ||
  "4WupQK53UZdyRcwjAVo1MEYauDeueIMfyXoFaDQ4STY";

export default defineConfig({
  expect: {
    timeout: 7_500,
  },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: "test-results/web-compatibility",
  projects: [
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "safari",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "edge",
      use: { ...devices["Desktop Edge"], channel: "msedge" },
    },
    {
      name: "mobile-safari",
      use: { ...devices["iPhone 15"] },
    },
  ],
  reporter: process.env.CI
    ? [
        ["line"],
        ["json", { outputFile: "artifacts/release/web-compatibility-playwright.json" }],
        ["html", { open: "never", outputFolder: "playwright-compatibility-report" }],
      ]
    : "list",
  retries: process.env.CI ? 1 : 0,
  testDir: "tests/web-compatibility",
  timeout: 45_000,
  use: {
    baseURL: webBaseUrl,
    extraHTTPHeaders: {
      "x-forwarded-for": "198.51.100.25",
    },
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "node tests/web-e2e/public-api-stub.mjs",
      env: {
        ...process.env,
        HOSTNAME: "127.0.0.1",
        PORT: String(publicApiPort),
        SSR_INTERNAL_REQUEST_SECRET: ssrInternalRequestSecret,
      },
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 30_000,
      url: `${publicApiBaseUrl}/health/ready`,
    },
    {
      command: "bash .github/scripts/start-web-e2e.sh",
      env: {
        ...process.env,
        API_INTERNAL_URL: publicApiBaseUrl,
        NEXT_PUBLIC_API_URL: publicApiBaseUrl,
        PORT: String(webPort),
        SSR_INTERNAL_REQUEST_SECRET: ssrInternalRequestSecret,
      },
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 120_000,
      url: `${webBaseUrl}/health`,
    },
  ],
  workers: 1,
});
