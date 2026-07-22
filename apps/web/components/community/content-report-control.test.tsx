// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentPolicyRules, OwnerAgentListResponse } from "@alphanet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContentReportControl } from "./content-report-control";

const ids = {
  authorActor: "10000000-0000-4000-8000-000000000001",
  reporterActor: "10000000-0000-4000-8000-000000000002",
  reporterAgent: "20000000-0000-4000-8000-000000000002",
  authorAgent: "20000000-0000-4000-8000-000000000001",
  owner: "30000000-0000-4000-8000-000000000001",
  policy: "40000000-0000-4000-8000-000000000001",
  content: "50000000-0000-4000-8000-000000000001",
  report: "60000000-0000-4000-8000-000000000001",
  case: "70000000-0000-4000-8000-000000000001",
} as const;

const timestamp = "2026-07-21T19:00:00.000Z";
const rules: AgentPolicyRules = {
  browse: "allow",
  content_read: "allow",
  content_write: "require_approval",
  delete_own_content: "require_approval",
  edit_own_content: "require_approval",
  follow_write: "allow",
  notification_read: "allow",
  reaction_write: "allow",
  reply_write: "require_approval",
  search: "allow",
};

function ownerAgents(options: { includeAuthor?: boolean } = {}): OwnerAgentListResponse {
  const agent = (
    id: string,
    actorId: string,
    handle: string,
  ): OwnerAgentListResponse["agents"][number] => ({
    activated_at: timestamp,
    actor_id: actorId,
    archived_at: null,
    bio: null,
    created_at: timestamp,
    credential_count: 0,
    discovery_tags: [],
    display_name: handle === "author-agent" ? "Author Agent" : "Risk Scout",
    handle,
    id,
    owner_id: ids.owner,
    policy: {
      defaults_version: "agent-permission-defaults-v1",
      effective_from: timestamp,
      id: ids.policy,
      policy_schema_version: "1",
      rules,
      tier: "assisted",
      version: 1,
    },
    restriction_reason_code: null,
    status: "active",
    updated_at: timestamp,
  });

  const agents = [agent(ids.reporterAgent, ids.reporterActor, "risk-scout")];
  if (options.includeAuthor === true) {
    agents.unshift(agent(ids.authorAgent, ids.authorActor, "author-agent"));
  }

  return {
    agents,
    next_cursor: null,
    quota: {
      active_agent_count: 2,
      active_agent_limit: 5,
      create_limit: 10,
      create_retry_at: null,
      created_last_24_hours: 0,
    },
    request_id: "req-agent-list",
    schema_version: "1",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ContentReportControl", () => {
  it("loads eligible Agent identities lazily and submits a bounded report", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(ownerAgents()))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            created: true,
            report: {
              report_id: ids.report,
              report_version: 1,
              case_id: ids.case,
              content_id: ids.content,
              reporter_actor_id: ids.reporterActor,
              reason_code: "spam",
              details: null,
              status: "open",
              submitted_at: timestamp,
              updated_at: timestamp,
              resolved_at: null,
            },
            request_id: "req-report",
            schema_version: "1",
          },
          201,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "80000000-0000-4000-8000-000000000001" });

    render(
      <ContentReportControl authorActorId={ids.authorActor} contentId={ids.content} />,
    );

    await user.click(screen.getByRole("button", { name: "举报内容" }));
    const form = await screen.findByRole("form", { name: "举报这项内容" });
    expect(within(form).queryByText("Author Agent")).toBeNull();
    expect(within(form).getByText(/Risk Scout/u)).not.toBeNull();

    await user.selectOptions(within(form).getByLabelText("原因"), "spam");
    await user.click(within(form).getByRole("button", { name: "提交举报" }));

    await screen.findByText("举报已提交，社区治理队列会独立处理。", {
      exact: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/v1/owner/agents");
    const [reportUrl, reportInit] = fetchMock.mock.calls[1] ?? [];
    expect(reportUrl).toBe(`/v1/owner/content/${ids.content}/reports`);
    expect(reportInit?.method).toBe("POST");
    expect(new Headers(reportInit?.headers).get("idempotency-key")).toBe(
      "content-report-80000000-0000-4000-8000-000000000001",
    );
    if (typeof reportInit?.body !== "string") {
      throw new Error("Expected a JSON report request body");
    }
    expect(JSON.parse(reportInit.body)).toEqual({
      reporter_actor_id: ids.reporterActor,
      reason_code: "spam",
    });
  });

  it("requires context for other violations without issuing a mutation", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(ownerAgents()));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ContentReportControl authorActorId={ids.authorActor} contentId={ids.content} />,
    );
    await user.click(screen.getByRole("button", { name: "举报内容" }));
    const form = await screen.findByRole("form", { name: "举报这项内容" });
    await user.selectOptions(within(form).getByLabelText("原因"), "other_rule_violation");
    await user.click(within(form).getByRole("button", { name: "提交举报" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "请补充说明具体违反了哪项社区规则。",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("blocks every sibling Agent when the current Owner owns the author", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(ownerAgents({ includeAuthor: true })));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ContentReportControl authorActorId={ids.authorActor} contentId={ids.content} />,
    );
    await user.click(screen.getByRole("button", { name: "举报内容" }));

    expect(
      await screen.findByText(/Owner 不能举报自己名下任何 Agent 发布的内容/u),
    ).not.toBeNull();
    expect(screen.queryByRole("form", { name: "举报这项内容" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("still detects ownership when the author Agent is archived", async () => {
    const user = userEvent.setup();
    const response = ownerAgents({ includeAuthor: true });
    const author = response.agents.find((agent) => agent.actor_id === ids.authorActor);
    if (!author) throw new Error("Expected the author Agent fixture");
    author.status = "archived";
    author.archived_at = timestamp;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ContentReportControl authorActorId={ids.authorActor} contentId={ids.content} />,
    );
    await user.click(screen.getByRole("button", { name: "举报内容" }));

    expect(
      await screen.findByText(/Owner 不能举报自己名下任何 Agent 发布的内容/u),
    ).not.toBeNull();
    expect(screen.queryByRole("form", { name: "举报这项内容" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("offers sign-in when the Owner session is missing", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "AUTHENTICATION_REQUIRED",
              message: "A valid Owner session is required.",
              retryable: false,
              details: null,
              retry_after_ms: null,
            },
            request_id: "req-auth",
            schema_version: "1",
          },
          401,
        ),
      ),
    );

    render(
      <ContentReportControl authorActorId={ids.authorActor} contentId={ids.content} />,
    );
    await user.click(screen.getByRole("button", { name: "举报内容" }));

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "登录后举报" }).getAttribute("href")).toBe(
        `/login?next=%2Fcontent%2F${ids.content}`,
      );
    });
  });

  it("keeps a recoverable retry path when Agent identities cannot be loaded", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("preview network unavailable"))
      .mockResolvedValueOnce(jsonResponse(ownerAgents()));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ContentReportControl authorActorId={ids.authorActor} contentId={ids.content} />,
    );
    await user.click(screen.getByRole("button", { name: "举报内容" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "无法连接控制面，请检查网络后重试。",
    );
    await user.click(screen.getByRole("button", { name: "重新加载" }));

    await screen.findByRole("form", { name: "举报这项内容" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
