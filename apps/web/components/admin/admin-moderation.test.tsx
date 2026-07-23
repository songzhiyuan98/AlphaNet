// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AdminModerationCaseDetailResponse,
  AdminModerationCaseListResponse,
  AdminModerationDecisionResponse,
} from "@alphanet/contracts";
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminNavigation } from "./admin-navigation";
import { ModerationCaseDetail } from "./moderation-case-detail";
import { ModerationDecisionForm } from "./moderation-decision-form";
import { ModerationQueue } from "./moderation-queue";
import { buildDecisionRequest, decisionReasons } from "./moderation-ui";

const ids = {
  action: "10000000-0000-4000-8000-000000000001",
  actor: "20000000-0000-4000-8000-000000000001",
  admin: "30000000-0000-4000-8000-000000000001",
  agent: "40000000-0000-4000-8000-000000000001",
  case: "50000000-0000-4000-8000-000000000001",
  content: "60000000-0000-4000-8000-000000000001",
  owner: "70000000-0000-4000-8000-000000000001",
  parent: "80000000-0000-4000-8000-000000000001",
  report: "90000000-0000-4000-8000-000000000001",
  revision: "a0000000-0000-4000-8000-000000000001",
} as const;

const times = {
  created: "2026-07-20T17:00:00.000Z",
  reported: "2026-07-20T18:00:00.000Z",
  updated: "2026-07-20T19:00:00.000Z",
  decided: "2026-07-20T20:00:00.000Z",
} as const;

const reasonCounts = {
  spam: 0,
  harassment: 0,
  impersonation: 0,
  malicious_link: 1,
  privacy_exposure: 0,
  other_rule_violation: 0,
} as const;

function caseListResponse(): AdminModerationCaseListResponse {
  return {
    capabilities: { can_decide: true },
    items: [
      {
        case_id: ids.case,
        case_version: 2,
        content_id: ids.content,
        content_version: 5,
        content_kind: "post",
        lifecycle_state: "published",
        distribution_state: "normal",
        author: {
          actor_id: ids.actor,
          kind: "agent",
          handle: "risk-scout",
          agent_id: ids.agent,
        },
        status: "open",
        priority: "urgent",
        report_count: 1,
        reason_counts: reasonCounts,
        opened_at: times.reported,
        last_reported_at: times.reported,
        updated_at: times.updated,
        resolved_at: null,
        resolution_action: null,
        latest_action_id: null,
        queue_rank: 1,
      },
    ],
    page: { has_more: true, limit: 20, next_cursor: "next-page" },
    ordering: {
      as_of: times.updated,
      ordering_version: "moderation-case-live-keyset-v1",
      snapshot_id: "queue-snapshot",
    },
    request_id: "req-queue",
    schema_version: "1",
  };
}

function caseDetailResponse(
  options: {
    body?: string;
    canDecide?: boolean;
    reportDetails?: string;
  } = {},
): AdminModerationCaseDetailResponse {
  const summary = caseListResponse().items[0];
  if (!summary) throw new Error("Expected moderation Case fixture");
  const { queue_rank: queueRank, ...moderationCase } = summary;
  if (queueRank < 1) throw new Error("Expected a positive queue rank");
  return {
    capabilities: { can_decide: options.canDecide ?? true },
    case: moderationCase,
    content: {
      content_id: ids.content,
      root_content_id: ids.content,
      parent_content_id: null,
      depth: 0,
      resource_version: 5,
      lifecycle_state: "published",
      distribution_state: "normal",
      current_revision_id: ids.revision,
      author: {
        actor_id: ids.actor,
        kind: "agent",
        handle: "risk-scout",
        agent_id: ids.agent,
      },
      created_at: times.created,
      updated_at: times.updated,
      deleted_at: null,
      kind: "post",
      title: "MU supply-chain risk review",
      body_markdown: options.body ?? "Research body",
    },
    reports: [
      {
        report_id: ids.report,
        report_version: 1,
        case_id: ids.case,
        content_id: ids.content,
        reporter_actor_id: ids.actor,
        reporter_owner_id: ids.owner,
        reason_code: "malicious_link",
        details: options.reportDetails ?? "Suspicious source redirection",
        status: "open",
        submitted_at: times.reported,
        updated_at: times.updated,
        resolved_at: null,
      },
    ],
    report_page: { has_more: true, limit: 20, next_cursor: "next-reports" },
    report_ordering: {
      as_of: times.updated,
      ordering_version: "moderation-report-list-v1",
      snapshot_id: "report-snapshot",
    },
    actions: [],
    action_page: { has_more: true, limit: 20, next_cursor: "next-actions" },
    action_ordering: {
      as_of: times.updated,
      ordering_version: "moderation-action-list-v1",
      snapshot_id: "action-snapshot",
    },
    request_id: "req-detail",
    schema_version: "1",
  };
}

function hiddenDecisionResponse(): AdminModerationDecisionResponse {
  const detail = caseDetailResponse();
  return {
    case_version_before: 2,
    case: {
      ...detail.case,
      case_version: 3,
      content_version: 6,
      distribution_state: "hidden",
      status: "resolved_action",
      resolved_at: times.decided,
      updated_at: times.decided,
      resolution_action: "hide_content",
      latest_action_id: ids.action,
    },
    action: {
      moderation_action_id: ids.action,
      action_version: 1,
      case_id: ids.case,
      content_id: ids.content,
      internal_note: "Escalated after source review",
      decided_by_admin_id: ids.admin,
      decided_at: times.decided,
      action: "hide_content",
      reason_code: "confirmed_report_violation",
      content_version_before: 5,
      content_version_after: 6,
      content_lifecycle_state: "published",
      distribution_before: "normal",
      distribution_after: "hidden",
      reverted_action_id: null,
    },
    content: {
      content_id: ids.content,
      resource_version: 6,
      lifecycle_state: "published",
      distribution_state: "hidden",
    },
    request_id: "req-decision",
    schema_version: "1",
  };
}

function resolvedCaseDetailResponse(
  internalNote: string,
): AdminModerationCaseDetailResponse {
  const detail = caseDetailResponse();
  const decision = hiddenDecisionResponse();
  return {
    ...detail,
    case: decision.case,
    content: {
      ...detail.content,
      distribution_state: "hidden",
      resource_version: 6,
      updated_at: times.decided,
    },
    reports: detail.reports.map((report) => ({
      ...report,
      resolved_at: times.decided,
      status: "resolved_action",
      updated_at: times.decided,
    })),
    actions: [{ ...decision.action, internal_note: internalNote }],
    action_page: { has_more: false, limit: 20, next_cursor: null },
  };
}

function errorResponse(code: string, status: number, retryAfterMs: number | null = null) {
  return Response.json(
    {
      error: {
        code,
        message: "Admin request rejected.",
        retryable: status === 429,
        details: null,
        retry_after_ms: retryAfterMs,
      },
      request_id: `req-${status}`,
      schema_version: "1",
    },
    { status },
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AdminNavigation", () => {
  it("keeps AlphaNet navigation language and exposes read-versus-decide access", () => {
    render(
      <AdminNavigation
        active="moderation"
        adminLabel="Risk Operations"
        canDecide={false}
      />,
    );

    expect(screen.getByRole("link", { name: "AlphaNet 首页" })).not.toBeNull();
    expect(screen.getByText("只读审核")).not.toBeNull();
    expect(screen.getByText("Risk Operations")).not.toBeNull();
    const logout = screen.getByRole("button", { name: "退出" });
    const logoutForm = logout.closest("form");
    expect(logoutForm?.getAttribute("method")).toBe("post");
    expect(logoutForm?.getAttribute("action")).toBe("/admin/auth/logout");
    expect(
      screen.getByRole("link", { name: "内容治理" }).getAttribute("aria-current"),
    ).toBe("page");
  });
});

describe("ModerationQueue", () => {
  it("renders filters and preserves them in the forward cursor link", () => {
    render(
      <ModerationQueue
        filters={{
          content_id: ids.content,
          limit: 20,
          priorities: ["urgent"],
          reasons: ["malicious_link"],
          statuses: ["open", "reviewing"],
        }}
        response={caseListResponse()}
      />,
    );

    expect(screen.getByRole("link", { name: /risk-scout/u })).not.toBeNull();
    expect(screen.getByText("恶意链接 · 1")).not.toBeNull();
    const next = screen.getByRole("link", { name: "下一页" });
    const href = new URL(next.getAttribute("href") ?? "", "https://alphanet.test");
    expect(href.pathname).toBe("/admin/moderation");
    expect(href.searchParams.get("statuses")).toBe("open,reviewing");
    expect(href.searchParams.get("priorities")).toBe("urgent");
    expect(href.searchParams.get("reasons")).toBe("malicious_link");
    expect(href.searchParams.get("content_id")).toBe(ids.content);
    expect(href.searchParams.get("cursor")).toBe("next-page");
  });
});

describe("ModerationCaseDetail", () => {
  it("renders content and report evidence only as untrusted text", () => {
    const body = '**not bold** <img src="x" onerror="alert(1)">';
    const report = "<script>window.stolen = true</script>";
    render(
      <ModerationCaseDetail
        decisionAttemptId="b0000000-0000-4000-8000-000000000010"
        response={caseDetailResponse({
          body,
          canDecide: false,
          reportDetails: report,
        })}
      />,
    );

    expect(screen.getByTestId("moderation-untrusted-content").textContent).toBe(body);
    expect(screen.getByText(report, { exact: true })).not.toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText(/没有治理决定权限/u)).not.toBeNull();
    expect(screen.getByRole("button", { name: /确认/u }).hasAttribute("disabled")).toBe(
      true,
    );

    const reportNext = screen.getByRole("link", { name: "查看更多举报" });
    const reportHref = new URL(
      reportNext.getAttribute("href") ?? "",
      "https://alphanet.test",
    );
    expect(reportHref.searchParams.get("report_cursor")).toBe("next-reports");
    const actionNext = screen.getByRole("link", { name: "查看更多处置" });
    const actionHref = new URL(
      actionNext.getAttribute("href") ?? "",
      "https://alphanet.test",
    );
    expect(actionHref.searchParams.get("action_cursor")).toBe("next-actions");
  });

  it("keeps internal audit notes as inert text", () => {
    const note = '<img src="x" onerror="window.stolen=true"> audit note';
    render(
      <ModerationCaseDetail
        decisionAttemptId="b0000000-0000-4000-8000-000000000011"
        response={resolvedCaseDetailResponse(note)}
      />,
    );

    expect(screen.getByText(note, { exact: true })).not.toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("moderation decision taxonomy", () => {
  it("binds every action to its exact allowed reasons", () => {
    expect(decisionReasons).toEqual({
      dismiss: ["insufficient_evidence", "no_rule_violation", "duplicate_case"],
      limit_content: ["confirmed_report_violation", "precautionary_distribution_limit"],
      hide_content: ["confirmed_report_violation", "precautionary_distribution_limit"],
      restore_content: [
        "moderation_error_corrected",
        "appeal_granted",
        "risk_condition_resolved",
      ],
    });
    expect(buildDecisionRequest("dismiss", "no_rule_violation", "")).toEqual({
      action: "dismiss",
      reason_code: "no_rule_violation",
    });
    expect(
      buildDecisionRequest("limit_content", "precautionary_distribution_limit", "note"),
    ).toEqual({
      action: "limit_content",
      reason_code: "precautionary_distribution_limit",
      internal_note: "note",
    });
    expect(
      buildDecisionRequest("hide_content", "confirmed_report_violation", ""),
    ).toEqual({
      action: "hide_content",
      reason_code: "confirmed_report_violation",
    });
    expect(buildDecisionRequest("restore_content", "appeal_granted", "")).toEqual({
      action: "restore_content",
      reason_code: "appeal_granted",
    });
    expect(buildDecisionRequest("dismiss", "confirmed_report_violation", "")).toBeNull();
    expect(buildDecisionRequest("restore_content", "duplicate_case", "")).toBeNull();
  });
});

describe("ModerationDecisionForm", () => {
  it("keeps the attempt UUID stable and gates decisions through hydration", async () => {
    const initialAttemptId = "b0000000-0000-4000-8000-000000000000";
    const element = (
      <ModerationDecisionForm
        canDecide
        caseId={ids.case}
        caseVersion={2}
        distributionState="normal"
        initialAttemptId={initialAttemptId}
        lifecycleState="published"
        status="open"
      />
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.append(container);
    expect(
      container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    ).toBe(true);
    const recoverableError = vi.fn();
    let root: Root | undefined;

    act(() => {
      root = hydrateRoot(container, element, {
        onRecoverableError: recoverableError,
      });
    });

    expect(recoverableError).not.toHaveBeenCalled();
    expect(container.textContent).toContain(initialAttemptId);
    await waitFor(() => {
      expect(
        container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
      ).toBe(false);
    });
    act(() => root?.unmount());
    container.remove();
  });

  it("binds action-specific reasons and reuses one attempt UUID across a network retry", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(Response.json(hiddenDecisionResponse(), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ModerationDecisionForm
        canDecide
        caseId={ids.case}
        caseVersion={2}
        distributionState="normal"
        initialAttemptId="b0000000-0000-4000-8000-000000000001"
        lifecycleState="published"
        status="open"
      />,
    );

    await user.click(screen.getByLabelText("隐藏内容"));
    const reason = screen.getByLabelText("决定原因");
    expect(within(reason).queryByRole("option", { name: "证据不足" })).toBeNull();
    await user.selectOptions(reason, "confirmed_report_violation");
    await user.type(
      screen.getByLabelText(/内部备注/u),
      "  Escalated after source review  ",
    );
    await user.click(screen.getByRole("button", { name: "确认隐藏内容" }));
    await screen.findByText(/提交标识已保留/u);
    await user.click(screen.getByRole("button", { name: "确认隐藏内容" }));

    await screen.findByText(/案件更新至 v3/u);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.has("if-match")).toBe(false);
      expect(headers.has("idempotency-key")).toBe(false);
      expect(init?.credentials).toBe("include");
      expect(init?.method).toBe("POST");
    }
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/admin/moderation/${ids.case}/actions`);
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe("string");
    if (typeof body !== "string") throw new Error("Expected serialized decision");
    expect(JSON.parse(body)).toEqual({
      attempt_id: "b0000000-0000-4000-8000-000000000001",
      case_version: 2,
      decision: {
        action: "hide_content",
        reason_code: "confirmed_report_violation",
        internal_note: "Escalated after source review",
      },
    });
  });

  it("surfaces conflict, permission, authentication and rate-limit states", async () => {
    const user = userEvent.setup();
    const onConflict = vi.fn();
    const onAuthenticationRequired = vi.fn();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(errorResponse("CASE_VERSION_CONFLICT", 409))
      .mockResolvedValueOnce(errorResponse("ADMIN_PERMISSION_REQUIRED", 403))
      .mockResolvedValueOnce(errorResponse("ADMIN_AUTHENTICATION_REQUIRED", 401))
      .mockResolvedValueOnce(errorResponse("RATE_LIMITED", 429, 4_000));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ModerationDecisionForm
        canDecide
        caseId={ids.case}
        caseVersion={2}
        distributionState="normal"
        initialAttemptId="b0000000-0000-4000-8000-000000000002"
        lifecycleState="published"
        onAuthenticationRequired={onAuthenticationRequired}
        onConflict={onConflict}
        status="open"
      />,
    );

    const submit = screen.getByRole("button", { name: "确认驳回举报" });
    await user.click(submit);
    expect((await screen.findByRole("alert")).textContent).toContain("请刷新");
    expect(onConflict).toHaveBeenCalledOnce();

    await user.click(submit);
    expect((await screen.findByRole("alert")).textContent).toContain("没有执行治理决定");
    expect(screen.getByText(/本页已切换为只读/u)).not.toBeNull();
    expect(submit.hasAttribute("disabled")).toBe(true);
  });

  it("handles authentication and rate limiting without changing the attempt", async () => {
    const user = userEvent.setup();
    const onAuthenticationRequired = vi.fn();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(errorResponse("ADMIN_AUTHENTICATION_REQUIRED", 401))
      .mockResolvedValueOnce(errorResponse("RATE_LIMITED", 429, 4_000));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ModerationDecisionForm
        canDecide
        caseId={ids.case}
        caseVersion={2}
        distributionState="normal"
        initialAttemptId="b0000000-0000-4000-8000-000000000003"
        lifecycleState="published"
        onAuthenticationRequired={onAuthenticationRequired}
        status="open"
      />,
    );

    const submit = screen.getByRole("button", { name: "确认驳回举报" });
    await user.click(submit);
    await waitFor(() => expect(onAuthenticationRequired).toHaveBeenCalledOnce());
    await user.click(submit);
    expect((await screen.findByRole("alert")).textContent).toContain("操作过于频繁");
    expect(
      screen.getByRole("button", { name: "4 秒后重试" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});
