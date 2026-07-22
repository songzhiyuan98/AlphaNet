// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  OwnerActionDetailResponseSchema,
  type OwnerActionDetail,
  type OwnerActionState,
  type OwnerActionSummary,
} from "@alphanet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalInbox } from "./approval-inbox";

const ids = {
  action: "10000000-0000-4000-8000-000000000001",
  agent: "20000000-0000-4000-8000-000000000001",
  community: "30000000-0000-4000-8000-000000000001",
  decision: "40000000-0000-4000-8000-000000000001",
  sourceContent: "50000000-0000-4000-8000-000000000001",
  content: "60000000-0000-4000-8000-000000000001",
} as const;
const requestedAt = "2026-07-20T18:00:00.000Z";
const decidedAt = "2026-07-20T18:01:00.000Z";
const terminalAt = "2026-07-20T18:02:00.000Z";
const expiresAt = "2026-07-21T18:00:00.000Z";
const queuePath =
  "/v1/owner/pending-actions?states=pending_approval,approved,executing&limit=50";
const detailPath = `/v1/owner/pending-actions/${ids.action}`;

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

function detailFor(
  state: OwnerActionState = "pending_approval",
  bodyMarkdown = "A frozen research draft.",
): OwnerActionDetail {
  const approved = ["approved", "executing", "succeeded", "failed"].includes(state);
  const rejected = state === "rejected";
  const terminal = [
    "succeeded",
    "rejected",
    "expired",
    "cancelled",
    "failed",
    "invalidated",
  ].includes(state);
  const approvalOutcome = approved
    ? "approved"
    : rejected
      ? "rejected"
      : state === "expired"
        ? "expired"
        : state === "cancelled"
          ? "cancelled"
          : state === "invalidated"
            ? "invalidated"
            : null;
  const publicError =
    state === "rejected"
      ? {
          code: "ACTION_REJECTED",
          message: "The Owner rejected this action.",
          retryable: false,
          details: null,
          retry_after_ms: null,
        }
      : state === "expired"
        ? {
            code: "ACTION_EXPIRED",
            message: "The action expired.",
            retryable: false,
            details: null,
            retry_after_ms: null,
          }
        : state === "cancelled"
          ? {
              code: "ACTION_CANCELLED",
              message: "The action was cancelled.",
              retryable: false,
              details: null,
              retry_after_ms: null,
            }
          : state === "failed"
            ? {
                code: "ACTION_EXECUTION_FAILED",
                message: "The action failed.",
                retryable: false,
                details: null,
                retry_after_ms: null,
              }
            : state === "invalidated"
              ? {
                  code: "ACTION_INVALIDATED",
                  message: "The action was invalidated.",
                  retryable: false,
                  details: null,
                  retry_after_ms: null,
                }
              : null;

  return OwnerActionDetailResponseSchema.parse({
    action: {
      id: ids.action,
      version: state === "pending_approval" ? 3 : 4,
      agent: {
        id: ids.agent,
        handle: "market-scout",
        display_name: "Market Scout",
        status: "active",
      },
      operation: "create_post",
      state,
      target: { id: ids.community, type: "community" },
      approval_summary: "Create one post in the Semiconductors community.",
      requested_at: requestedAt,
      expires_at: expiresAt,
      updated_at: terminal
        ? terminalAt
        : state === "pending_approval"
          ? requestedAt
          : decidedAt,
      preview: {
        operation: "create_post",
        title: "AMD data-center scenario review",
        body_markdown: bodyMarkdown,
        primary_community_id: ids.community,
        additional_community_ids: [],
        symbols: ["AMD"],
        topics: ["semiconductors"],
        source_links: [
          {
            url: "https://example.com/research",
            title: "研究来源",
            description: "外部资料，仅在 Owner 点击时打开。",
          },
        ],
        references: [
          { target_content_id: ids.sourceContent, relation_type: "reference" },
        ],
      },
      input_digest: `sha256:${"a".repeat(64)}`,
      idempotency_key_hint: "hmac-sha256:0123456789ab",
      approval_reason_category: "owner_approval_required",
      decision_id: ids.decision,
      policy_version: "assisted-policy:1",
      decided_at: approved || rejected || state === "cancelled" ? decidedAt : null,
      terminal_at: terminal ? terminalAt : null,
      approval_outcome: approvalOutcome,
      decision_reason_code: approved
        ? "owner_approved"
        : rejected
          ? "risk_not_accepted"
          : null,
      public_error: publicError,
    },
    request_id: "req-approval-detail",
    schema_version: "1",
  }).action;
}

function updateDetailFor(bodyMarkdown: string): OwnerActionDetail {
  const base = detailFor();
  return OwnerActionDetailResponseSchema.parse({
    action: {
      ...base,
      operation: "update_content",
      target: { id: ids.content, type: "content" },
      approval_summary: "Update one published research post.",
      preview: {
        operation: "update_content",
        content_id: ids.content,
        expected_version: 7,
        baseline: {
          content_kind: "post",
          resource_version: 7,
          revision_id: ids.sourceContent,
          title: "AMD data-center scenario review",
          body_markdown: "The original case used the prior FX assumptions.",
          primary_community_id: ids.community,
          additional_community_ids: [],
        },
        patch: {
          body_markdown: bodyMarkdown,
          source_links: [
            {
              url: "https://example.com/revised-research",
              title: "更新后的研究来源",
              description: "只有 Owner 主动点击才会打开。",
            },
          ],
          references: [],
          symbols: [],
        },
        edit_summary: "补充汇率敏感性",
      },
    },
    request_id: "req-update-approval-detail",
    schema_version: "1",
  }).action;
}

function deleteDetailFor(mode: "permanent" | "soft", reason?: string): OwnerActionDetail {
  const base = detailFor();
  return OwnerActionDetailResponseSchema.parse({
    action: {
      ...base,
      operation: "delete_content",
      target: { id: ids.content, type: "content" },
      approval_summary:
        mode === "permanent"
          ? "Permanently delete one research post."
          : "Soft-delete one research post.",
      preview: {
        operation: "delete_content",
        content_id: ids.content,
        expected_version: 7,
        mode,
        ...(reason === undefined ? {} : { reason }),
      },
    },
    request_id: "req-delete-approval-detail",
    schema_version: "1",
  }).action;
}

function summaryFor(action: OwnerActionDetail): OwnerActionSummary {
  return {
    id: action.id,
    version: action.version,
    agent: action.agent,
    operation: action.operation,
    state: action.state,
    target: action.target,
    approval_summary: action.approval_summary,
    requested_at: action.requested_at,
    expires_at: action.expires_at,
    updated_at: action.updated_at,
  };
}

function listPayload(actions: OwnerActionDetail[]) {
  return {
    items: actions.map(summaryFor),
    page: { next_cursor: null, has_more: false, limit: 50 },
    request_id: "req-approval-list",
    schema_version: "1",
  };
}

function detailPayload(action: OwnerActionDetail) {
  return {
    action,
    request_id: "req-approval-detail",
    schema_version: "1",
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ApprovalInbox", () => {
  it("shows the AlphaNet approval character when the queue is empty", async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url === queuePath) {
        return Promise.resolve(Response.json(listPayload([])));
      }
      throw new Error(`Unexpected approval request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ApprovalInbox />);

    expect(
      await screen.findByAltText("AlphaNet Agent 与社区伙伴确认当前无需审批"),
    ).toBeTruthy();
    expect(screen.getByText("当前没有动作")).toBeTruthy();
  });

  it("renders frozen Markdown as inert text and never fetches source links", async () => {
    const malicious = '<script>alert("xss")</script><img src="x" onerror="alert(1)">';
    const pending = detailFor("pending_approval", malicious);
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url === queuePath) {
        return Promise.resolve(Response.json(listPayload([pending])));
      }
      if (url === detailPath) {
        return Promise.resolve(Response.json(detailPayload(pending)));
      }
      throw new Error(`Unexpected approval request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ApprovalInbox />);

    const markdown = await screen.findByTestId("approval-markdown");
    expect(markdown.textContent).toBe(malicious);
    expect(markdown.querySelector("script")).toBeNull();
    expect(markdown.querySelector("img")).toBeNull();
    const source = screen.getByRole("link", { name: "研究来源" });
    expect(source.getAttribute("target")).toBe("_blank");
    expect(source.getAttribute("rel")).toContain("noopener");
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).not.toContain(
      "https://example.com/research",
    );
  });

  it("renders the frozen update patch without executing embedded markup", async () => {
    const malicious = '<img src="x" onerror="alert(1)"> revised thesis';
    const pending = updateDetailFor(malicious);
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url === queuePath) {
        return Promise.resolve(Response.json(listPayload([pending])));
      }
      if (url === detailPath) {
        return Promise.resolve(Response.json(detailPayload(pending)));
      }
      throw new Error(`Unexpected approval request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ApprovalInbox />);

    const markdown = await screen.findByTestId("approval-markdown-diff");
    expect(markdown.textContent).toContain(malicious);
    expect(markdown.textContent).toContain(
      "The original case used the prior FX assumptions.",
    );
    expect(markdown.querySelector("img")).toBeNull();
    expect(screen.getByTestId("approval-content-baseline-version").textContent).toBe("7");
    expect(screen.getByTestId("approval-content-expected-version").textContent).toBe("7");
    expect(screen.getByText("Agent 权限策略要求 Owner 审批")).toBeTruthy();
    expect(screen.getByText("hmac-sha256:0123456789ab")).toBeTruthy();
    expect(screen.getAllByText("更新内容").length).toBeGreaterThan(0);
    expect(screen.getByText("补充汇率敏感性")).toBeTruthy();
    expect(screen.getByText("将清空全部内容引用")).toBeTruthy();
    expect(screen.queryByText("新的主题")).toBeNull();

    const source = screen.getByRole("link", { name: "更新后的研究来源" });
    expect(source.getAttribute("target")).toBe("_blank");
    expect(source.getAttribute("rel")).toContain("noopener");
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).not.toContain(
      "https://example.com/revised-research",
    );
  });

  it.each([
    {
      intent: "软删除",
      mode: "soft" as const,
      reason: "研究结论已被更正。",
      summary: "使其退出社区公开内容流",
    },
    {
      intent: "永久删除",
      mode: "permanent" as const,
      reason: '<img src="x" onerror="alert(1)">永久删除原因',
      summary: "请求永久删除目标内容",
    },
  ])("renders the frozen $intent intent and reason as inert text", async (scenario) => {
    const pending = deleteDetailFor(scenario.mode, scenario.reason);
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url === queuePath) {
        return Promise.resolve(Response.json(listPayload([pending])));
      }
      if (url === detailPath) {
        return Promise.resolve(Response.json(detailPayload(pending)));
      }
      throw new Error(`Unexpected approval request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ApprovalInbox />);

    const intent = await screen.findByTestId("approval-delete-intent");
    expect(intent.textContent).toContain(scenario.summary);
    expect(screen.getAllByText(scenario.intent).length).toBeGreaterThan(0);
    expect(screen.getByText(ids.content)).toBeTruthy();
    expect(screen.getByTestId("approval-content-expected-version").textContent).toBe("7");
    const reason = screen.getByTestId("approval-delete-reason");
    expect(reason.textContent).toBe(scenario.reason);
    expect(reason.querySelector("img")).toBeNull();
  });

  it.each([
    {
      button: "批准动作",
      endpoint: `${detailPath}/approve`,
      expectedBody: { expected_version: 3, reason_code: "owner_approved" },
      kind: "approve" as const,
    },
    {
      button: "拒绝动作",
      endpoint: `${detailPath}/reject`,
      expectedBody: { expected_version: 3, reason_code: "risk_not_accepted" },
      kind: "reject" as const,
    },
  ])("sends the strict $kind payload and refreshes the queue", async (scenario) => {
    const pending = detailFor();
    const approved = detailFor("approved");
    const rejected = detailFor("rejected");
    let decisionComplete = false;
    let queueRequests = 0;
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url === queuePath) {
        queueRequests += 1;
        const queue = decisionComplete
          ? scenario.kind === "approve"
            ? [approved]
            : []
          : [pending];
        return Promise.resolve(Response.json(listPayload(queue)));
      }
      if (url === detailPath) {
        return Promise.resolve(Response.json(detailPayload(pending)));
      }
      if (url === scenario.endpoint && init?.method === "POST") {
        decisionComplete = true;
        return Promise.resolve(
          Response.json(
            detailPayload(scenario.kind === "approve" ? approved : rejected),
            { status: scenario.kind === "approve" ? 202 : 200 },
          ),
        );
      }
      throw new Error(`Unexpected approval request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ApprovalInbox />);
    await screen.findByTestId("approval-markdown");
    if (scenario.kind === "reject") {
      await user.selectOptions(screen.getByLabelText("拒绝理由"), "risk_not_accepted");
    }
    await user.click(screen.getByRole("button", { name: scenario.button }));

    await waitFor(() => {
      expect(queueRequests).toBe(2);
    });
    const decisionCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestUrl(input) === scenario.endpoint && init?.method === "POST",
    );
    expect(decisionCall).toBeDefined();
    const body = decisionCall?.[1]?.body;
    expect(typeof body).toBe("string");
    if (typeof body !== "string") {
      throw new Error("Approval decision body was not serialized as JSON");
    }
    expect(JSON.parse(body)).toEqual(scenario.expectedBody);
  });

  it("shows a 409 conflict and refreshes the selected detail", async () => {
    const pending = detailFor();
    const approved = detailFor("approved");
    let detailRequests = 0;
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url === queuePath) {
        return Promise.resolve(Response.json(listPayload([pending])));
      }
      if (url === detailPath && init?.method !== "POST") {
        detailRequests += 1;
        return Promise.resolve(
          Response.json(detailPayload(detailRequests === 1 ? pending : approved)),
        );
      }
      if (url === `${detailPath}/approve` && init?.method === "POST") {
        return Promise.resolve(
          Response.json(
            {
              error: {
                code: "ACTION_VERSION_CONFLICT",
                message: "The action changed before this decision was applied.",
                retryable: false,
                details: { current_state: "approved", current_version: 4 },
                retry_after_ms: null,
              },
              request_id: "req-approval-conflict",
              schema_version: "1",
            },
            { status: 409 },
          ),
        );
      }
      throw new Error(`Unexpected approval request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ApprovalInbox />);
    await screen.findByTestId("approval-markdown");
    await user.click(screen.getByRole("button", { name: "批准动作" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("已刷新为最新版本");
    await waitFor(() => {
      expect(detailRequests).toBe(2);
      expect(screen.getByTestId("approval-version").textContent).toBe("4");
    });
    expect(
      screen.getByRole("button", { name: "批准动作" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("disables every decision control for a terminal action", async () => {
    const succeeded = detailFor("succeeded");
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url === queuePath) {
        return Promise.resolve(Response.json(listPayload([succeeded])));
      }
      if (url === detailPath) {
        return Promise.resolve(Response.json(detailPayload(succeeded)));
      }
      throw new Error(`Unexpected approval request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ApprovalInbox />);
    await screen.findByText("动作已进入终态，不能再次批准或拒绝。");

    expect(screen.getByLabelText("拒绝理由").hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "拒绝动作" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "批准动作" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });
});
