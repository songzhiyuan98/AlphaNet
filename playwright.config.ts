import { defineConfig, devices } from "@playwright/test";

const publicApiPort = Number(process.env.E2E_PUBLIC_API_PORT ?? 49_999);
const webPort = Number(process.env.E2E_WEB_PORT ?? 3_000);
const publicApiBaseUrl = `http://127.0.0.1:${publicApiPort}`;
const webBaseUrl = `http://127.0.0.1:${webPort}`;
const ssrInternalRequestSecret =
  process.env.E2E_SSR_INTERNAL_REQUEST_SECRET?.trim() ||
  "4WupQK53UZdyRcwjAVo1MEYauDeueIMfyXoFaDQ4STY";

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
  ...(process.env.CI ? { workers: 1 } : {}),
});
