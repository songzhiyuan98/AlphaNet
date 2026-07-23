/// <reference lib="dom" />

import { createRequire } from "node:module";

import { expect, test, type Page } from "@playwright/test";

const fixture = Object.freeze({
  adminId: "e4000000-0000-4000-8000-000000000501",
  adminSubject: "alphanet-e2e-content-moderator",
  authorEmail: "demo.owner@alphanet.local",
  authorPassword: process.env.E2E_AUTHOR_PASSWORD ?? "Author-owner-e2e-password-2026",
  contentBodyMarker: "出口限制、仓位调整与短期库存信号",
  contentId: "d3000000-0000-4000-8000-000000001101",
  contentTitle: "[本地演示] MU 下跌：需求变化还是风险折价？",
  hideInternalNote: "E2E private Admin evidence: hide after independent review",
  reporterDetails: "E2E private reporter evidence: suspicious redirect chain",
  reporterEmail: "reporter.owner@alphanet.local",
  reporterAgentId: "e4000000-0000-4000-8000-000000000201",
  reporterHandle: "moderation-e2e-reporter",
  reporterPassword:
    process.env.E2E_REPORTER_PASSWORD ?? "Reporter-owner-e2e-password-2026",
  restoreInternalNote: "E2E private Admin evidence: corrected after verification",
});

const databaseUrl =
  process.env.DATABASE_URL ??
  `postgresql://alphanet:alphanet_admin_e2e_local_only@127.0.0.1:${
    process.env.E2E_POSTGRES_PORT ?? "55432"
  }/alphanet_admin_e2e`;
const requireFromAuth = createRequire(`${process.cwd()}/packages/auth/package.json`);

interface QueryResult<T> {
  rows: T[];
}

interface DatabaseClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query<T>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
}

const PgClient = (
  requireFromAuth("pg") as {
    Client: new (options: { connectionString: string }) => DatabaseClient;
  }
).Client;

async function queryDatabase<T>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const client = new PgClient({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

async function loginOwner(
  page: Page,
  email: string,
  password: string,
  nextPath: string,
): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(nextPath)}`);
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { exact: true, name: "登录" }).click();
  await page.waitForURL((url) => url.pathname === nextPath || url.pathname === "/home", {
    timeout: 15_000,
  });
  if (new URL(page.url()).pathname !== nextPath) {
    await page.goto(nextPath);
  }
}

async function latestModerationCaseId(): Promise<string> {
  const rows = await queryDatabase<{ case_id: string }>(
    `select moderation_case.id::text as case_id
     from platform.moderation_cases as moderation_case
     where moderation_case.target_type = 'content'
       and moderation_case.target_content_id = $1::uuid
     order by moderation_case.opened_at desc, moderation_case.id desc
     limit 1`,
    [fixture.contentId],
  );
  const caseId = rows[0]?.case_id;
  if (!caseId) throw new Error("The browser report did not create a moderation Case.");
  return caseId;
}

test("real Owner report flows through Admin OIDC MFA, hide, redacted history, and restore", async ({
  browser,
}) => {
  const contentPath = `/content/${fixture.contentId}`;

  const reporterContext = await browser.newContext();
  const reporterPage = await reporterContext.newPage();
  await loginOwner(
    reporterPage,
    fixture.reporterEmail,
    fixture.reporterPassword,
    contentPath,
  );
  await expect(
    reporterPage.getByRole("heading", { name: fixture.contentTitle }),
  ).toBeVisible();
  await reporterPage.getByRole("button", { name: "举报内容" }).click();
  await expect(reporterPage.getByLabel("代表 Agent")).toContainText(
    `@${fixture.reporterHandle}`,
  );
  await reporterPage.getByLabel("原因").selectOption("malicious_link");
  await reporterPage.getByLabel(/补充说明/u).fill(fixture.reporterDetails);
  await reporterPage.getByRole("button", { name: "提交举报" }).click();
  await expect(
    reporterPage.getByText("举报已提交，社区治理队列会独立处理。"),
  ).toBeVisible();
  const caseId = await latestModerationCaseId();
  await reporterContext.close();

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await adminPage.goto("/admin/moderation");
  await expect(adminPage.getByRole("heading", { name: "社区管理" })).toBeVisible();
  await adminPage.getByRole("button", { name: "使用 Workforce 身份登录" }).click();
  await expect(
    adminPage.getByRole("heading", { name: "Complete workforce MFA" }),
  ).toBeVisible();
  await adminPage.getByRole("button", { name: "Approve with MFA" }).click();
  await adminPage.waitForURL((url) => url.pathname === "/admin/moderation", {
    timeout: 20_000,
  });
  await expect(adminPage.getByRole("heading", { name: "社区内容治理" })).toBeVisible();
  const queueLink = adminPage.locator(`a[href="/admin/moderation/${caseId}"]`);
  await expect(queueLink).toBeVisible();
  await queueLink.click();
  await expect(
    adminPage.getByText(fixture.reporterDetails, { exact: true }),
  ).toBeVisible();
  const hideAction = adminPage.getByRole("radio", { name: "隐藏内容" });
  await expect(hideAction).toBeEnabled();
  await hideAction.locator("xpath=..").click();
  await expect(hideAction).toBeChecked();
  await expect(adminPage.getByRole("button", { name: "确认隐藏内容" })).toBeEnabled();
  await adminPage
    .getByLabel("内部备注（不会向内容 Owner 展示）")
    .fill(fixture.hideInternalNote);
  await adminPage.getByRole("button", { name: "确认隐藏内容" }).click();
  await expect(adminPage.getByText(/已执行“隐藏内容”/u)).toBeVisible();

  const publicContext = await browser.newContext();
  const publicPage = await publicContext.newPage();
  await publicPage.goto(contentPath);
  await expect(
    publicPage.getByText("这项内容已根据社区规则移除；稳定身份与讨论位置被保留。"),
  ).toBeVisible();
  await expect(publicPage.getByText(fixture.contentBodyMarker)).toHaveCount(0);
  await expect(publicPage.getByRole("button", { name: "举报内容" })).toHaveCount(0);

  const authorContext = await browser.newContext();
  const authorPage = await authorContext.newPage();
  await loginOwner(authorPage, fixture.authorEmail, fixture.authorPassword, contentPath);
  await expect(authorPage.getByText("内容已移出公共分发")).toBeVisible();
  const authorHistoryAfterHide = await authorPage.locator("body").innerText();
  expect(authorHistoryAfterHide).not.toContain(fixture.reporterDetails);
  expect(authorHistoryAfterHide).not.toContain(fixture.hideInternalNote);
  expect(authorHistoryAfterHide).not.toContain(fixture.reporterHandle);
  expect(authorHistoryAfterHide).not.toContain(fixture.adminSubject);
  expect(authorHistoryAfterHide).not.toContain(fixture.adminId);

  await adminPage.reload();
  const restoreAction = adminPage.getByRole("radio", { name: "恢复分发" });
  await expect(restoreAction).toBeVisible();
  await restoreAction.locator("xpath=..").click();
  await expect(restoreAction).toBeChecked();
  await adminPage
    .getByLabel("内部备注（不会向内容 Owner 展示）")
    .fill(fixture.restoreInternalNote);
  await adminPage.getByRole("button", { name: "确认恢复分发" }).click();
  await expect(adminPage.getByText(/已执行“恢复分发”/u)).toBeVisible();

  await publicPage.reload();
  await expect(
    publicPage.getByRole("heading", { name: fixture.contentTitle }),
  ).toBeVisible();
  await expect(publicPage.getByText(fixture.contentBodyMarker)).toBeVisible();
  await expect(publicPage.getByText(/这项内容已根据社区规则移除/u)).toHaveCount(0);

  await authorPage.reload();
  await expect(authorPage.getByText("内容已移出公共分发")).toBeVisible();
  await expect(authorPage.getByText("内容分发已恢复")).toBeVisible();
  const authorHistoryAfterRestore = await authorPage.locator("body").innerText();
  expect(authorHistoryAfterRestore).not.toContain(fixture.reporterDetails);
  expect(authorHistoryAfterRestore).not.toContain(fixture.hideInternalNote);
  expect(authorHistoryAfterRestore).not.toContain(fixture.restoreInternalNote);
  expect(authorHistoryAfterRestore).not.toContain(fixture.adminId);

  const reports = await queryDatabase<{
    case_id: string;
    description: string;
    reason_code: string;
    report_status: string;
  }>(
    `select
       moderation_case.id::text as case_id,
       report.description,
       report.reason_code,
       report.status as report_status
     from platform.reports as report
     join platform.moderation_case_items as case_item
       on case_item.report_id = report.id
     join platform.moderation_cases as moderation_case
       on moderation_case.id = case_item.case_id
     where report.target_content_id = $1::uuid
     order by report.created_at desc, report.id desc`,
    [fixture.contentId],
  );
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({
    case_id: caseId,
    description: fixture.reporterDetails,
    reason_code: "malicious_link",
    report_status: "resolved_action",
  });

  const state = await queryDatabase<{
    case_status: string;
    content_version: number;
    distribution_state: string;
    resolution_code: string;
  }>(
    `select
       moderation_case.status as case_status,
       content.version::integer as content_version,
       content.distribution_state,
       moderation_case.resolution_code
     from platform.moderation_cases as moderation_case
     join platform.content_items as content
       on content.id = moderation_case.target_content_id
     where moderation_case.id = $1::uuid`,
    [caseId],
  );
  expect(state).toEqual([
    {
      case_status: "resolved_action",
      content_version: 3,
      distribution_state: "normal",
      resolution_code: "content_restored",
    },
  ]);

  const actions = await queryDatabase<{
    action: string;
    after_distribution_state: string;
    before_distribution_state: string;
    internal_note: string;
    moderation_action_id: string;
    reverts_action_id: string | null;
  }>(
    `select
       moderation_action.id::text as moderation_action_id,
       moderation_action.action,
       moderation_action.before_distribution_state,
       moderation_action.after_distribution_state,
       moderation_action.internal_note,
       moderation_action.reverts_action_id::text as reverts_action_id
     from platform.moderation_actions as moderation_action
     where moderation_action.case_id = $1::uuid
     order by moderation_action.occurred_at, moderation_action.id`,
    [caseId],
  );
  expect(actions).toHaveLength(2);
  expect(actions[0]).toMatchObject({
    action: "hide_content",
    after_distribution_state: "hidden",
    before_distribution_state: "normal",
    internal_note: fixture.hideInternalNote,
    reverts_action_id: null,
  });
  expect(actions[1]).toMatchObject({
    action: "restore_content",
    after_distribution_state: "normal",
    before_distribution_state: "hidden",
    internal_note: fixture.restoreInternalNote,
    reverts_action_id: actions[0]?.moderation_action_id,
  });

  const provenance = await queryDatabase<{
    action_logs: number;
    leaked_private_values: number;
    moderation_actions: number;
    moderation_events: number;
  }>(
    `select
       count(distinct moderation_action.id)::integer as moderation_actions,
       count(distinct action_log.id)::integer as action_logs,
       count(distinct outbox_event.id)::integer as moderation_events,
       count(*) filter (
         where action_log::text like '%' || $2 || '%'
            or action_log::text like '%' || $3 || '%'
            or action_log::text like '%' || $4 || '%'
            or outbox_event.payload::text like '%' || $2 || '%'
            or outbox_event.payload::text like '%' || $3 || '%'
            or outbox_event.payload::text like '%' || $4 || '%'
       )::integer as leaked_private_values
     from platform.moderation_actions as moderation_action
     join platform.action_logs as action_log
       on action_log.id = moderation_action.action_log_id
     join system.outbox_events as outbox_event
       on outbox_event.id = moderation_action.outbox_event_id
      and outbox_event.event_type = 'content.moderation_changed'
     where moderation_action.case_id = $1::uuid`,
    [
      caseId,
      fixture.reporterDetails,
      fixture.hideInternalNote,
      fixture.restoreInternalNote,
    ],
  );
  expect(provenance).toEqual([
    {
      action_logs: 2,
      leaked_private_values: 0,
      moderation_actions: 2,
      moderation_events: 2,
    },
  ]);

  const reportEvents = await queryDatabase<{ report_events: number }>(
    `select count(*)::integer as report_events
     from system.outbox_events
     where aggregate_type = 'report'
       and event_type = 'report.created'
       and payload ->> 'content_id' = $1`,
    [fixture.contentId],
  );
  expect(reportEvents).toEqual([{ report_events: 1 }]);

  await Promise.all([adminContext.close(), publicContext.close(), authorContext.close()]);
});

test("workforce Admin creates, edits, and archives a topic community", async ({
  page,
}) => {
  const slug = "ai-infrastructure-e2e";
  await page.goto("/admin/communities");
  await expect(page.getByRole("heading", { name: "社区管理" })).toBeVisible();
  await page.getByRole("button", { name: "使用 Workforce 身份登录" }).click();
  await expect(
    page.getByRole("heading", { name: "Complete workforce MFA" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve with MFA" }).click();
  await page.waitForURL((url) => url.pathname === "/admin/communities", {
    timeout: 20_000,
  });
  await expect(page.getByRole("heading", { name: "主题社区" })).toBeVisible();
  await expect(page.getByRole("link", { name: "主题社区" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await page.getByText("新建主题社区", { exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("AI Infrastructure");
  await page.getByLabel("稳定 slug").fill(slug);
  await page
    .getByLabel("说明", { exact: true })
    .fill("AI infrastructure and compute-market research.");
  await page.getByRole("button", { name: "创建社区" }).click();
  await expect(page.getByText("主题社区已创建。")).toBeVisible();

  const row = page.locator("article").filter({ hasText: `#${slug}` });
  await expect(row).toBeVisible();
  await expect(row.getByText("AI Infrastructure", { exact: true })).toBeVisible();
  await row.getByText("编辑社区资料", { exact: true }).click();
  await row.getByLabel("展示名称").fill("AI Infrastructure & Compute");
  await row
    .getByLabel("社区说明")
    .fill("Agent research on compute, datacenters, and AI infrastructure.");
  await row.getByRole("button", { name: "保存更改" }).click();
  await expect(page.getByText("社区资料已更新。")).toBeVisible();
  await expect(
    row.getByText("AI Infrastructure & Compute", { exact: true }),
  ).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "归档社区" }).click();
  await expect(page.getByText("社区已归档。")).toBeVisible();
  await expect(row.getByText("archived", { exact: true })).toBeVisible();

  const state = await queryDatabase<{
    action_count: number;
    community_name: string;
    community_state: string;
    community_version: number;
  }>(
    `select
       community.name as community_name,
       community.status as community_state,
       community.version::integer as community_version,
       count(admin_action.id)::integer as action_count
     from platform.communities as community
     join platform.topic_community_admin_actions as admin_action
       on admin_action.community_id = community.id
     where community.slug = $1::citext
     group by community.id`,
    [slug],
  );
  expect(state).toEqual([
    {
      action_count: 3,
      community_name: "AI Infrastructure & Compute",
      community_state: "archived",
      community_version: 3,
    },
  ]);
});

test("workforce Admin suspends and restores an Agent with audited authority changes", async ({
  page,
}) => {
  await page.goto("/admin/agents");
  await expect(page.getByRole("heading", { name: "社区管理" })).toBeVisible();
  await page.getByRole("button", { name: "使用 Workforce 身份登录" }).click();
  await expect(
    page.getByRole("heading", { name: "Complete workforce MFA" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve with MFA" }).click();
  await page.waitForURL((url) => url.pathname === "/admin/agents", {
    timeout: 20_000,
  });

  await expect(page.getByRole("heading", { name: "Agent 治理" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Agent 治理" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const row = page.locator("article").filter({ hasText: `@${fixture.reporterHandle}` });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "查看与处置" }).click();
  await expect(
    page.getByRole("heading", { name: "Moderation E2E Reporter" }),
  ).toBeVisible();

  await page.getByLabel("治理动作").selectOption("suspend_agent");
  await page.getByLabel("受控原因").selectOption("platform_policy_violation");
  await page
    .getByLabel("内部审计备注（可选）")
    .fill("E2E confirmed automated platform-policy violation.");
  await page.getByRole("button", { name: "确认执行" }).click();
  await expect(page.getByText("Agent 治理操作已完成并写入审计记录。")).toBeVisible();
  await expect(page.getByText(/已暂停 · v2/u)).toBeVisible();

  await page.getByLabel("治理动作").selectOption("restore_agent");
  await page.getByLabel("受控原因").selectOption("risk_condition_resolved");
  await page.getByLabel("内部审计备注（可选）").fill("E2E risk condition resolved.");
  await page.getByRole("button", { name: "确认执行" }).click();
  await expect(page.getByText(/活跃 · v3/u)).toBeVisible();

  const state = await queryDatabase<{
    action_count: number;
    action_log_count: number;
    actor_status: string;
    agent_status: string;
    governance_version: number;
    outbox_count: number;
  }>(
    `select
       agent.status as agent_status,
       actor.status as actor_status,
       agent.governance_version::integer as governance_version,
       (
         select count(*)::integer
         from platform.agent_admin_actions
         where agent_id = agent.id
       ) as action_count,
       (
         select count(*)::integer
         from platform.action_logs
         where target_type = 'agent'
           and target_id = agent.id::text
           and event_class = 'governance'
       ) as action_log_count,
       (
         select count(*)::integer
         from system.outbox_events
         where aggregate_type = 'agent'
           and aggregate_id = agent.id::text
           and event_type = any(array['agent.suspended', 'agent.restored'])
       ) as outbox_count
     from platform.agents as agent
     join platform.actors as actor on actor.id = agent.actor_id
     where agent.id = $1::uuid`,
    [fixture.reporterAgentId],
  );
  expect(state).toEqual([
    {
      action_count: 2,
      action_log_count: 2,
      actor_status: "active",
      agent_status: "active",
      governance_version: 3,
      outbox_count: 2,
    },
  ]);
});
