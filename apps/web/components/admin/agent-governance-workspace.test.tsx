// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AdminAgentDetailResponse,
  AdminAgentListResponse,
} from "@alphanet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminNavigation } from "./admin-navigation";
import { AgentGovernanceDetail, AgentGovernanceList } from "./agent-governance-workspace";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const ids = {
  agent: "40000000-0000-4000-8000-000000000003",
  actor: "40000000-0000-4000-8000-000000000004",
  owner: "40000000-0000-4000-8000-000000000005",
  credential: "40000000-0000-4000-8000-000000000006",
} as const;

afterEach(() => {
  cleanup();
  refresh.mockReset();
  vi.unstubAllGlobals();
});

function listResponse(): AdminAgentListResponse {
  return {
    capabilities: { can_restrict: true, can_revoke_credentials: true },
    items: [
      {
        activated_at: "2026-07-23T19:00:00.000Z",
        actor_id: ids.actor,
        agent_id: ids.agent,
        archived_at: null,
        created_at: "2026-07-23T19:00:00.000Z",
        credential_counts: { active: 2, expired: 0, revoked: 0, total: 2 },
        discovery_tags: ["semiconductors"],
        display_name: "Semiconductor Research Agent",
        governance_version: 3,
        handle: "semi-research",
        owner_id: ids.owner,
        restricted_at: null,
        restriction_reason_code: null,
        status: "active",
        suspended_at: null,
        updated_at: "2026-07-23T19:00:00.000Z",
      },
    ],
    ordering: {
      as_of: "2026-07-23T19:00:00.000Z",
      ordering_version: "admin-agent-created-keyset-v1",
      snapshot_id: "40000000-0000-4000-8000-000000000007",
    },
    page: { has_more: true, limit: 25, next_cursor: "agent-next" },
    request_id: "request-agent-list",
    schema_version: "1",
  };
}

function detailResponse(): AdminAgentDetailResponse {
  const listed = listResponse();
  return {
    agent: listed.items[0]!,
    capabilities: listed.capabilities,
    credentials: [
      {
        created_at: "2026-07-23T19:00:00.000Z",
        credential_id: ids.credential,
        credential_type: "api_key",
        expires_at: null,
        last_used_at: null,
        name: "Primary key",
        prefix: "aln_v1_abcdefghijkl",
        revoked_at: null,
        scopes: ["research:read"],
        status: "active",
      },
    ],
    request_id: "request-agent-detail",
    schema_version: "1",
  };
}

describe("Admin Agent governance workspace", () => {
  it("shares the Admin navigation and exposes stable Agent facts", () => {
    render(
      <>
        <AdminNavigation active="agents" canDecide={false} canGovernAgents />
        <AgentGovernanceList
          filters={{ limit: 25, statuses: ["active"] }}
          response={listResponse()}
        />
      </>,
    );
    expect(
      screen.getByRole("link", { name: "Agent 治理" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByRole("heading", { name: "Semiconductor Research Agent" }),
    ).toBeTruthy();
    expect(screen.getByText(ids.agent)).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看与处置" }).getAttribute("href")).toBe(
      `/admin/agents/${ids.agent}`,
    );
    expect(screen.getByRole("link", { name: "下一页" }).getAttribute("href")).toContain(
      "cursor=agent-next",
    );
  });

  it("submits a versioned Agent action and refreshes current authority", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ request_id: "request-action" }), {
          headers: { "content-type": "application/json" },
          status: 201,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("crypto", {
      randomUUID: () => "40000000-0000-4000-8000-000000000008",
    });
    const user = userEvent.setup();
    render(<AgentGovernanceDetail response={detailResponse()} />);

    await user.selectOptions(screen.getByLabelText("治理动作"), "suspend_agent");
    await user.selectOptions(
      screen.getByLabelText("受控原因"),
      "platform_policy_violation",
    );
    await user.type(screen.getByLabelText("内部审计备注（可选）"), "Confirmed.");
    await user.click(screen.getByRole("button", { name: "确认执行" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith(
      `/admin/agents/${ids.agent}/actions`,
      expect.objectContaining({
        body: JSON.stringify({
          action: {
            action: "suspend_agent",
            internal_note: "Confirmed.",
            reason_code: "platform_policy_violation",
          },
          agent_version: 3,
          attempt_id: "40000000-0000-4000-8000-000000000008",
        }),
      }),
    );
    expect(screen.getByText("Agent 治理操作已完成并写入审计记录。")).toBeTruthy();
  });
});
