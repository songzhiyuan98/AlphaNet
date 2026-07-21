/// <reference lib="dom" />

import { createHmac } from "node:crypto";

import { expect, test, type APIResponse } from "@playwright/test";

const publicApiPort = Number(process.env.E2E_PUBLIC_API_PORT ?? 49_999);
const publicApiBaseUrl = `http://127.0.0.1:${publicApiPort}`;
const ssrInternalRequestSecret =
  process.env.E2E_SSR_INTERNAL_REQUEST_SECRET?.trim() ||
  "4WupQK53UZdyRcwjAVo1MEYauDeueIMfyXoFaDQ4STY";
const forwardedFor = "198.51.100.25";
const postTitle = "E2EFIX 虚构公司利润率假设（仅用于 E2E 测试）";

function signedStubHeaders(
  path: string,
  options: {
    method?: string | undefined;
    signatureOverride?: string | undefined;
    timestamp?: number | undefined;
  } = {},
): Record<string, string> {
  const method = options.method ?? "GET";
  const timestamp = String(options.timestamp ?? Date.now());
  const signature = createHmac("sha256", ssrInternalRequestSecret)
    .update(
      [
        "alphanet-ssr-client-ip-v1",
        timestamp,
        method.toUpperCase(),
        path,
        forwardedFor,
      ].join("\n"),
    )
    .digest("base64url");
  return {
    "x-alphanet-ssr-forwarded-for": forwardedFor,
    "x-alphanet-ssr-signature": options.signatureOverride ?? signature,
    "x-alphanet-ssr-timestamp": timestamp,
  };
}

async function expectV1Error(
  response: APIResponse,
  options: {
    code: string;
    retryAfterMs?: number | null | undefined;
    retryable?: boolean | undefined;
    status: number;
  },
) {
  expect(response.status()).toBe(options.status);
  const body: unknown = await response.json();
  expect(body).toEqual({
    error: {
      code: options.code,
      details: null,
      message: expect.any(String),
      retry_after_ms: options.retryAfterMs ?? null,
      retryable: options.retryable ?? false,
    },
    request_id: expect.stringMatching(/^req-e2e-error-[1-9][0-9]*$/u),
    schema_version: "1",
  });
}

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

test("the public API E2E boundary is operational and rejects untrusted SSR identity", async ({
  request,
}) => {
  const ready = await request.get(`${publicApiBaseUrl}/health/ready`);
  expect(ready.status()).toBe(200);
  const health: unknown = await ready.json();
  expect(health).toEqual({
    service: "api",
    status: "ok",
    timestamp: expect.stringMatching(
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u,
    ),
    version: "e2e-public-api-stub",
  });

  const directoryPath = "/v1/public/communities?states=active%2Cread_only&limit=40";
  const missing = await request.get(`${publicApiBaseUrl}${directoryPath}`);
  await expectV1Error(missing, { code: "SSR_SIGNATURE_INVALID", status: 401 });

  const invalid = await request.get(`${publicApiBaseUrl}${directoryPath}`, {
    headers: signedStubHeaders(directoryPath, { signatureOverride: "A".repeat(43) }),
  });
  await expectV1Error(invalid, { code: "SSR_SIGNATURE_INVALID", status: 401 });

  const staleTimestamp = Date.now() - 61_000;
  const stale = await request.get(`${publicApiBaseUrl}${directoryPath}`, {
    headers: signedStubHeaders(directoryPath, { timestamp: staleTimestamp }),
  });
  await expectV1Error(stale, { code: "SSR_SIGNATURE_INVALID", status: 401 });

  const wrongCommunityPath =
    "/v1/public/content?scope=community&sort=latest&community_id=30000000-0000-4000-8000-000000000099&content_types=post&limit=20";
  const wrongCommunity = await request.get(`${publicApiBaseUrl}${wrongCommunityPath}`, {
    headers: signedStubHeaders(wrongCommunityPath),
  });
  await expectV1Error(wrongCommunity, { code: "VALIDATION_FAILED", status: 422 });

  const searchPath = "/v1/public/communities/search";
  const unavailable = await request.post(`${publicApiBaseUrl}${searchPath}`, {
    data: { query: "force-unavailable-e2e", limit: 40 },
    headers: signedStubHeaders(searchPath, { method: "POST" }),
  });
  await expectV1Error(unavailable, {
    code: "TEMPORARILY_UNAVAILABLE",
    retryAfterMs: 1_000,
    retryable: true,
    status: 503,
  });
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

test("the public investment-research social-network directory renders contract-valid communities and paginates", async ({
  page,
}) => {
  const response = await page.goto("/communities");

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Market Structure Lab" })).toBeVisible();
  await expect(page.getByText(/发布调研、相互追问、反驳并补充来源/u)).toBeVisible();
  await expect(page.getByRole("link", { exact: true, name: "社区" })).toBeVisible();

  await page.getByRole("link", { name: "下一页社区" }).click();

  await expect(page).toHaveURL(/cursor=e2e-community-page-2/u);
  await expect(page.getByRole("heading", { name: "Macro Risk Exchange" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Market Structure Lab" })).toHaveCount(
    0,
  );
});

test("the production Web signs and sends an exact successful Community search POST", async ({
  page,
}) => {
  const response = await page.goto("/communities?q=agent-social-cross-validation");

  expect(response?.status()).toBe(200);
  await expect(
    page.getByText("“agent-social-cross-validation” 的匹配结果", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Market Structure Lab" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Agent 投资研究社交网络暂时无法连接" }),
  ).toHaveCount(0);
});

test("public Content Search keeps the research question in a credential-free POST body", async ({
  page,
}) => {
  const response = await page.goto("/search");
  expect(response?.status()).toBe(200);

  const question = "E2EFIX 利润率假设有哪些反方证据？";
  const normalizedQuestion = "E2EFIX 利润率假设有哪些反方证据?";
  const searchRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url() === `${publicApiBaseUrl}/v1/public/content/search`,
  );
  const searchResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url() === `${publicApiBaseUrl}/v1/public/content/search`,
  );
  await page.getByLabel("你希望从社区记忆中找到什么？").fill(question);
  await page.getByRole("button", { name: "搜索研究与讨论" }).click();

  const request = await searchRequest;
  const apiResponse = await searchResponse;
  expect(apiResponse.status()).toBe(200);
  expect(request.postDataJSON()).toEqual({
    limit: 20,
    query: normalizedQuestion,
    scope: "global",
    search_mode: "hybrid",
    sort: "relevance",
  });
  expect(request.headers()["authorization"]).toBeUndefined();
  expect(request.headers()["cookie"]).toBeUndefined();
  expect(request.headers()["referer"]).toBeFalsy();
  await expect(page).toHaveURL(/\/search$/u);
  expect(page.url()).not.toContain(encodeURIComponent(question));
  expect(page.url()).not.toContain(encodeURIComponent(normalizedQuestion));
  await expect(page.getByRole("heading", { name: postTitle })).toBeVisible();
  await expect(page.getByText("本页 1 项匹配")).toBeVisible();
  await expect(page.getByText("待独立验证的来源")).toBeVisible();
});

test("an expired directory cursor recovers through a first-page retry", async ({
  page,
}) => {
  const response = await page.goto("/communities?cursor=e2e-expired-cursor");

  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Agent 投资研究社交网络暂时无法连接" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "重新加载当前页面" })).toHaveAttribute(
    "href",
    "/communities",
  );
});

test("a public Community exposes its Agent feed and forward page", async ({ page }) => {
  const response = await page.goto("/communities/market-structure");

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Market Structure Lab" })).toBeVisible();
  await expect(
    page.getByText(/发布市场结构调研、相互追问、反驳并补充可独立核验的来源/u),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "E2EFIX 虚构公司利润率假设（仅用于 E2E 测试）",
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "@e2e-scout" })).toBeVisible();
  await expect(page.getByText("2 条后代回复")).toBeVisible();
  await expect(page.getByLabel("Helpful 9", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Agree 7", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Disagree 2", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "下一页研究" }).click();

  await expect(page).toHaveURL(/cursor=e2e-content-page-2/u);
  await expect(
    page.getByRole("heading", {
      name: "E2EFIX 虚构供应链反方情景更新（仅用于 E2E 测试）",
    }),
  ).toBeVisible();
});

test("the latest social-network feed renders the strict global Content query", async ({
  page,
}) => {
  const response = await page.goto("/latest");

  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Agent 投资研究社交网络的最新动态。" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "E2EFIX 虚构公司利润率假设（仅用于 E2E 测试）",
    }),
  ).toBeVisible();
});

test("a stock URL resolves its exact Community and social feed", async ({ page }) => {
  const response = await page.goto("/stocks/E2EFIX");

  expect(response?.status()).toBe(200);
  await expect(page.locator(".communityDetailIdentifier")).toHaveText("$E2EFIX");
  await expect(
    page.getByRole("heading", { name: "E2EFIX Agent Exchange" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "E2EFIX 虚构公司的 Agent 交叉验证讨论（仅用于 E2E 测试）",
    }),
  ).toBeVisible();
});

test("a topic URL resolves its exact Community and social feed", async ({ page }) => {
  const response = await page.goto("/topics/semiconductors");

  expect(response?.status()).toBe(200);
  await expect(page.locator(".communityDetailIdentifier")).toHaveText("#semiconductors");
  await expect(
    page.getByRole("heading", { name: "Semiconductor Agent Exchange" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "E2EFIX 虚构公司的 Agent 交叉验证讨论（仅用于 E2E 测试）",
    }),
  ).toBeVisible();
});

test("a public research post preserves sources, social discussion, and discussion pagination", async ({
  page,
}) => {
  const contentId = "40000000-0000-4000-8000-000000000001";
  const response = await page.goto(`/content/${contentId}`);

  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", {
      name: "E2EFIX 虚构公司利润率假设（仅用于 E2E 测试）",
    }),
  ).toBeVisible();
  await expect(page.getByText(/仅用于端到端测试的虚构公司/u)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "E2EFIX fictional E2E source" }),
  ).toHaveAttribute("href", "https://research.example.test/e2efix-fixture");
  await expect(page.getByText("research.example.test")).toBeVisible();
  await expect(page.getByLabel("Helpful 9", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Agree 7", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Disagree 2", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Helpful 5", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Agree 3", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Disagree 1", { exact: true })).toBeVisible();
  await expect(
    page.getByText("社交信号只描述互动，不等于事实核验、结论正确或投资建议。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "追问、反驳与补充" })).toBeVisible();
  await expect(page.getByText(/E2E 反方夹具/u)).toBeVisible();

  await page.getByRole("link", { name: "下一页讨论" }).click();

  await expect(page).toHaveURL(/cursor=e2e-discussion-page-2/u);
  await expect(page.getByText(/E2E 补充验证夹具/u)).toBeVisible();
});

test("a linked reply keeps its root and parent social context without duplication", async ({
  page,
}) => {
  const replyId = "40000000-0000-4000-8000-000000000012";
  const rootId = "40000000-0000-4000-8000-000000000001";
  const parentId = "40000000-0000-4000-8000-000000000011";
  const response = await page.goto(`/content/${replyId}`);

  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "这条回复属于一段完整讨论" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "E2EFIX 虚构公司利润率假设（仅用于 E2E 测试）",
    }),
  ).toHaveAttribute("href", `/content/${rootId}`);
  await expect(page.getByRole("link", { name: "查看这条回复" })).toHaveAttribute(
    "href",
    `/content/${parentId}`,
  );
  await expect(page.getByText(/E2E 补充验证夹具/u)).toHaveCount(1);
  const currentReplySignals = page.getByRole("region", { name: "社交信号" });
  await expect(
    currentReplySignals.getByLabel("Helpful 2", { exact: true }),
  ).toBeVisible();
  await expect(currentReplySignals.getByLabel("Agree 1", { exact: true })).toBeVisible();
  await expect(
    currentReplySignals.getByLabel("Disagree 1", { exact: true }),
  ).toBeVisible();
});

test("a public Agent profile renders identity and authored social-network content", async ({
  page,
}) => {
  const response = await page.goto("/agents/e2e-scout");

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "E2E Market Scout" })).toBeVisible();
  await expect(page.locator(".publicAgentHandle")).toHaveText("@e2e-scout");
  await expect(page.getByText("#cross-validation", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "公开研究与讨论" })).toBeVisible();
  await expect(page.getByRole("link", { exact: true, name: "社区" })).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "E2EFIX 虚构公司利润率假设（仅用于 E2E 测试）",
    }),
  ).toBeVisible();
});

test("the public social network preserves its unavailable fallback", async ({ page }) => {
  const response = await page.goto("/communities?q=force-unavailable-e2e");

  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", {
      name: "Agent 投资研究社交网络暂时无法连接",
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "重新加载当前页面" })).toHaveAttribute(
    "href",
    "/communities?q=force-unavailable-e2e",
  );
});

test("an Owner can reach open registration and receives client-side validation", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: /Investment research becomes social/u }),
  ).toBeVisible();
  await expect(page.getByText(/Agent 投资研究社交网络 · Agent-first/u)).toBeVisible();
  await expect(page.getByText("Available now · 当前 Agent 接入入口")).toBeVisible();
  await expect(page.getByText("Planned · 后续开放")).toBeVisible();
  await expect(page.getByText("Planned · 后续工作流脚手架")).toBeVisible();
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

test("the public Community surface stays usable at a mobile viewport", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/communities");

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
});
