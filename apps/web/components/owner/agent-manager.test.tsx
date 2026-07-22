// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AgentPermissionTier,
  AgentPolicyRules,
  OwnerAgentListResponse,
  OwnerAgentSummary,
  OwnerAgentPolicyUpdateResponse,
} from "@alphanet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentManager } from "./agent-manager";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  agent: "20000000-0000-4000-8000-000000000001",
  owner: "30000000-0000-4000-8000-000000000001",
  policy: "40000000-0000-4000-8000-000000000001",
  nextPolicy: "40000000-0000-4000-8000-000000000002",
  credentialAssisted: "50000000-0000-4000-8000-000000000001",
  credentialAutonomous: "50000000-0000-4000-8000-000000000002",
  credentialCustom: "50000000-0000-4000-8000-000000000003",
} as const;
const timestamp = "2026-07-21T07:00:00.000Z";
const nextTimestamp = "2026-07-21T07:05:00.000Z";

const assistedRules: AgentPolicyRules = {
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

const readOnlyRules: AgentPolicyRules = {
  ...assistedRules,
  content_write: "deny",
  delete_own_content: "deny",
  edit_own_content: "deny",
  follow_write: "deny",
  reaction_write: "deny",
  reply_write: "deny",
};

const autonomousRules: AgentPolicyRules = {
  ...assistedRules,
  content_write: "allow",
  delete_own_content: "allow",
  edit_own_content: "allow",
  reply_write: "allow",
};

function agentWithPolicy(
  tier: AgentPermissionTier = "assisted",
  version = 1,
  rules: AgentPolicyRules = assistedRules,
  credentialCount = 0,
): OwnerAgentSummary {
  return {
    activated_at: timestamp,
    actor_id: ids.actor,
    archived_at: null,
    bio: "Tracks memory and semiconductor markets.",
    created_at: timestamp,
    credential_count: credentialCount,
    discovery_tags: ["semiconductors"],
    display_name: "Market Scout",
    handle: "market-scout",
    id: ids.agent,
    owner_id: ids.owner,
    policy: {
      defaults_version: "agent-permission-defaults-v1",
      effective_from: version === 1 ? timestamp : nextTimestamp,
      id: version === 1 ? ids.policy : ids.nextPolicy,
      policy_schema_version: "1",
      rules,
      tier,
      version,
    },
    restriction_reason_code: null,
    status: "active",
    updated_at: version === 1 ? timestamp : nextTimestamp,
  };
}

function ownerList(agent = agentWithPolicy()): OwnerAgentListResponse {
  return {
    agents: [agent],
    next_cursor: null,
    quota: {
      active_agent_count: 1,
      active_agent_limit: 5,
      create_limit: 3,
      create_retry_at: null,
      created_last_24_hours: 1,
    },
    request_id: "req-agent-list",
    schema_version: "1",
  };
}

function emptyOwnerList(): OwnerAgentListResponse {
  return {
    ...ownerList(),
    agents: [],
    quota: {
      ...ownerList().quota,
      active_agent_count: 0,
      created_last_24_hours: 0,
    },
  };
}

function policyResponse(
  tier: AgentPermissionTier,
  rules: AgentPolicyRules,
  previousAgent = agentWithPolicy(),
): OwnerAgentPolicyUpdateResponse {
  return {
    agent: agentWithPolicy(
      tier,
      previousAgent.policy.version + 1,
      rules,
      previousAgent.credential_count,
    ),
    changed: true,
    credential_impact: {
      retained_credential_count: 0,
      ceiling_counts: {
        assisted: 0,
        autonomous: 0,
        custom: 0,
        read_only: 0,
      },
      existing_credentials_keep_ceiling: true,
    },
    previous_policy: previousAgent.policy,
    request_id: `req-policy-${tier}`,
    schema_version: "1",
  };
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(init.body);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AgentManager permission policy", () => {
  it("reserves the AlphaNet creation character for the real no-Agent state", () => {
    render(<AgentManager emailVerified initialData={ownerList()} />);
    expect(
      screen.queryByRole("img", {
        name: "AlphaNet Agent 与社区伙伴创建公开身份",
      }),
    ).toBeNull();

    cleanup();
    render(<AgentManager emailVerified initialData={emptyOwnerList()} />);

    expect(
      screen.getByRole("img", {
        name: "AlphaNet Agent 与社区伙伴创建公开身份",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "创建第一个 Agent" })).toBeTruthy();
  });

  it("renders localized policy metadata and all four explained tiers", async () => {
    const user = userEvent.setup();
    render(<AgentManager emailVerified initialData={ownerList()} />);

    const policySummary = screen.getByText("辅助", { selector: "strong" });
    expect(policySummary.parentElement?.textContent).toContain("v1");

    await user.click(screen.getByRole("button", { name: "管理权限" }));

    for (const label of ["只读", "辅助（默认）", "全自动", "自定义"]) {
      expect(screen.getByRole("radio", { name: new RegExp(label, "u") })).toBeTruthy();
    }
    expect(screen.getByText(/Credential Scope 与权限上限/u)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "当前策略无需保存" }).hasAttribute("disabled"),
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "管理权限" }),
      );
    });
  });

  it("sends an exact versioned Read-only request and updates from the response", async () => {
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (
        url === `/v1/owner/agents/${ids.agent}/permission-policy` &&
        init?.method === "PUT"
      ) {
        return Promise.resolve(Response.json(policyResponse("read_only", readOnlyRules)));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AgentManager emailVerified initialData={ownerList()} />);

    await user.click(screen.getByRole("button", { name: "管理权限" }));
    await user.click(screen.getByRole("radio", { name: /只读/u }));
    await user.click(screen.getByRole("button", { name: "保存为只读" }));

    const mutation = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestUrl(input).endsWith("/permission-policy") && init?.method === "PUT",
    );
    expect(requestBody(mutation?.[1])).toEqual({
      expected_version: 1,
      tier: "read_only",
    });
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("辅助 v1 → 只读 v2");
    expect(notice.textContent).toContain("Request ID：req-policy-read_only");
    expect(
      screen.getByText("只读", { selector: "strong" }).parentElement?.textContent,
    ).toContain("v2");
  });

  it("sends an exact versioned Assisted request", async () => {
    const initialAgent = agentWithPolicy("read_only", 1, readOnlyRules);
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/permission-policy") && init?.method === "PUT") {
        return Promise.resolve(
          Response.json(policyResponse("assisted", assistedRules, initialAgent)),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AgentManager emailVerified initialData={ownerList(initialAgent)} />);

    await user.click(screen.getByRole("button", { name: "管理权限" }));
    await user.click(screen.getByRole("radio", { name: /辅助（默认）/u }));
    await user.click(screen.getByRole("button", { name: "保存为辅助" }));

    const mutation = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestUrl(input).endsWith("/permission-policy") && init?.method === "PUT",
    );
    expect(requestBody(mutation?.[1])).toEqual({
      expected_version: 1,
      tier: "assisted",
    });
  });

  it("requires explicit consent before Autonomous and sends the acknowledgement", async () => {
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/permission-policy") && init?.method === "PUT") {
        return Promise.resolve(
          Response.json(policyResponse("autonomous", autonomousRules)),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AgentManager emailVerified initialData={ownerList()} />);

    await user.click(screen.getByRole("button", { name: "管理权限" }));
    await user.click(screen.getByRole("radio", { name: /全自动/u }));

    const save = screen.getByRole("button", { name: "保存为全自动" });
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/已经存在的 PendingAction 不会/u)).toBeTruthy();
    const consent = screen.getByRole("checkbox", {
      name: /无需逐项审批发布、回复、编辑和软删除/u,
    });
    await user.click(consent);
    expect(save.hasAttribute("disabled")).toBe(false);
    await user.click(save);

    const mutation = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestUrl(input).endsWith("/permission-policy") && init?.method === "PUT",
    );
    expect(requestBody(mutation?.[1])).toEqual({
      autonomous_acknowledgement: "enable_without_per_action_approval",
      expected_version: 1,
      tier: "autonomous",
    });
  });

  it("adds the same acknowledgement only when Custom directly allows content writes", async () => {
    const directRules: AgentPolicyRules = {
      ...assistedRules,
      content_write: "allow",
    };
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/permission-policy") && init?.method === "PUT") {
        return Promise.resolve(Response.json(policyResponse("custom", directRules)));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AgentManager emailVerified initialData={ownerList()} />);

    await user.click(screen.getByRole("button", { name: "管理权限" }));
    await user.click(screen.getByRole("radio", { name: /自定义/u }));
    expect(screen.queryByRole("checkbox", { name: /上述自定义内容写入/u })).toBeNull();

    const publishRule = screen.getByRole("combobox", { name: "发布帖子权限" });
    expect(
      within(publishRule).queryByRole("option", { name: "需要 Owner 批准" }),
    ).toBeTruthy();
    const readRule = screen.getByRole("combobox", { name: "浏览社区与 Feed权限" });
    expect(
      within(readRule).queryByRole("option", { name: "需要 Owner 批准" }),
    ).toBeNull();
    await user.selectOptions(publishRule, "allow");

    const save = screen.getByRole("button", { name: "保存为自定义" });
    expect(save.hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /上述自定义内容写入/u }));
    await user.click(save);

    const mutation = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestUrl(input).endsWith("/permission-policy") && init?.method === "PUT",
    );
    expect(requestBody(mutation?.[1])).toEqual({
      autonomous_acknowledgement: "enable_without_per_action_approval",
      expected_version: 1,
      rules: directRules,
      tier: "custom",
    });
  });

  it("does not send an acknowledgement for a safe Custom policy", async () => {
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/permission-policy") && init?.method === "PUT") {
        return Promise.resolve(Response.json(policyResponse("custom", assistedRules)));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AgentManager emailVerified initialData={ownerList()} />);

    await user.click(screen.getByRole("button", { name: "管理权限" }));
    await user.click(screen.getByRole("radio", { name: /自定义/u }));
    await user.click(screen.getByRole("button", { name: "保存为自定义" }));

    const mutation = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestUrl(input).endsWith("/permission-policy") && init?.method === "PUT",
    );
    expect(requestBody(mutation?.[1])).toEqual({
      expected_version: 1,
      rules: assistedRules,
      tier: "custom",
    });
  });

  it("refreshes a stale policy without retrying and clears elevated consent", async () => {
    const freshAgent = agentWithPolicy("read_only", 2, readOnlyRules);
    let mutationCount = 0;
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/permission-policy") && init?.method === "PUT") {
        mutationCount += 1;
        return Promise.resolve(
          Response.json(
            {
              error: {
                code: "AGENT_POLICY_VERSION_CONFLICT",
                details: { current_version: 2 },
                message: "The policy changed.",
                retry_after_ms: null,
                retryable: false,
              },
              request_id: "req-policy-conflict",
              schema_version: "1",
            },
            { status: 409 },
          ),
        );
      }
      if (url === "/v1/owner/agents" && init?.method === undefined) {
        return Promise.resolve(Response.json(ownerList(freshAgent)));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AgentManager emailVerified initialData={ownerList()} />);

    await user.click(screen.getByRole("button", { name: "管理权限" }));
    await user.click(screen.getByRole("radio", { name: /全自动/u }));
    await user.click(
      screen.getByRole("checkbox", { name: /无需逐项审批发布、回复、编辑和软删除/u }),
    );
    await user.click(screen.getByRole("button", { name: "保存为全自动" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("已加载 只读 v2");
    expect(alert.textContent).toContain("Request ID：req-policy-conflict");
    expect(mutationCount).toBe(1);
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>("radio", { name: /只读/u }).checked).toBe(
        true,
      );
    });
    expect(screen.queryByRole("checkbox", { name: /无需逐项审批/u })).toBeNull();
  });

  it("shows immutable credential ceilings before Autonomous consent", async () => {
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url === `/v1/owner/credentials?agent_id=${ids.agent}`) {
        return Promise.resolve(
          Response.json({
            credentials: [
              {
                agent_id: ids.agent,
                audience: "urn:alphanet:api:v1",
                credential_type: "static_api_key",
                expires_at: null,
                id: ids.credentialAssisted,
                issued_at: timestamp,
                last_used_at: null,
                name: "Assisted workflow",
                policy_ceiling: "assisted",
                policy_ceiling_defaults_version: "agent-permission-defaults-v1",
                policy_ceiling_rules: assistedRules,
                policy_ceiling_schema_version: "1",
                revoked_at: null,
                rotated_at: null,
                scopes: ["research:read", "content:write"],
                status: "inactive_principal",
                token_prefix: "aln_v1_assisted",
              },
              {
                agent_id: ids.agent,
                audience: "urn:alphanet:api:v1",
                credential_type: "static_api_key",
                expires_at: null,
                id: ids.credentialAutonomous,
                issued_at: timestamp,
                last_used_at: null,
                name: "Autonomous workflow",
                policy_ceiling: "autonomous",
                policy_ceiling_defaults_version: "agent-permission-defaults-v1",
                policy_ceiling_rules: autonomousRules,
                policy_ceiling_schema_version: "1",
                revoked_at: null,
                rotated_at: null,
                scopes: ["research:read", "content:write"],
                status: "active",
                token_prefix: "aln_v1_autonomous",
              },
              {
                agent_id: ids.agent,
                audience: "urn:alphanet:api:v1",
                credential_type: "static_api_key",
                expires_at: null,
                id: ids.credentialCustom,
                issued_at: timestamp,
                last_used_at: null,
                name: "Custom research workflow",
                policy_ceiling: "custom",
                policy_ceiling_defaults_version: "agent-permission-defaults-v1",
                policy_ceiling_rules: {
                  ...autonomousRules,
                  reaction_write: "deny",
                },
                policy_ceiling_schema_version: "1",
                revoked_at: null,
                rotated_at: null,
                scopes: ["research:read", "content:write", "reaction:write"],
                status: "active",
                token_prefix: "aln_v1_custom",
              },
            ],
            next_cursor: null,
            request_id: "req-credential-impact",
            schema_version: "1",
          }),
        );
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AgentManager
        emailVerified
        initialData={ownerList(agentWithPolicy("assisted", 1, assistedRules, 3))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "管理权限" }));
    await user.click(screen.getByRole("radio", { name: /全自动/u }));

    expect(await screen.findByText("辅助 1 · 全自动 1 · 自定义 1")).toBeTruthy();
    expect(screen.getByText(/其中 2 个凭证会保留原有权限上限/u)).toBeTruthy();
    await user.click(screen.getByText(/查看 1 个 Custom Key 的实际影响/u));
    expect(screen.getByText(/收紧：设置社交反应/u)).toBeTruthy();
    expect(screen.getByText(/轮换也不会升级/u)).toBeTruthy();
    expect(screen.getByRole("link", { name: "凭证页" }).getAttribute("href")).toContain(
      ids.agent,
    );
  });
});
