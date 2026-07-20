// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentCredentialSummary, OwnerAgentSummary } from "@alphanet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CredentialWorkspace } from "./credential-workspace";

const ids = {
  actor: "00000000-0000-4000-8000-000000000001",
  agent: "00000000-0000-4000-8000-000000000002",
  credential: "00000000-0000-4000-8000-000000000003",
  owner: "00000000-0000-4000-8000-000000000004",
  policy: "00000000-0000-4000-8000-000000000005",
} as const;
const timestamp = "2026-07-20T12:00:00.000Z";
const apiKey = `aln_v1_${"a".repeat(12)}_${"b".repeat(43)}`;

const agent: OwnerAgentSummary = {
  activated_at: timestamp,
  actor_id: ids.actor,
  archived_at: null,
  bio: "Component-test Agent.",
  created_at: timestamp,
  credential_count: 0,
  discovery_tags: ["risk"],
  display_name: "Component Agent",
  handle: "component-agent",
  id: ids.agent,
  owner_id: ids.owner,
  policy: {
    defaults_version: "agent-permission-defaults-v1",
    effective_from: timestamp,
    id: ids.policy,
    policy_schema_version: "1",
    tier: "assisted",
    version: 1,
  },
  restriction_reason_code: null,
  status: "active",
  updated_at: timestamp,
};

const credential: AgentCredentialSummary = {
  agent_id: ids.agent,
  audience: "urn:alphanet:api:v1",
  credential_type: "static_api_key",
  expires_at: "2026-10-18T12:00:00.000Z",
  id: ids.credential,
  issued_at: timestamp,
  last_used_at: null,
  name: "Primary workflow",
  revoked_at: null,
  rotated_at: null,
  scopes: ["research:read", "community:read", "notifications:read", "actions:read"],
  status: "active",
  token_prefix: `aln_v1_${"a".repeat(12)}`,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CredentialWorkspace", () => {
  it("shows a newly issued key once and clears it from the document", async () => {
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (
        url === `/v1/owner/agents/${ids.agent}/credentials` &&
        init?.method === "POST"
      ) {
        return Promise.resolve(
          Response.json(
            {
              api_key: apiKey,
              credential,
              request_id: "req-component-issue",
              schema_version: "1",
            },
            { status: 201 },
          ),
        );
      }
      if (url === `/v1/owner/credentials?agent_id=${ids.agent}`) {
        return Promise.resolve(
          Response.json({
            credentials: [credential],
            next_cursor: null,
            request_id: "req-component-list",
            schema_version: "1",
          }),
        );
      }
      throw new Error(`Unexpected component request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <CredentialWorkspace
        agents={[agent]}
        initialAgentId={ids.agent}
        initialCredentials={[]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "签发新 Key" }));

    const dialog = await screen.findByRole("dialog", {
      name: "现在保存这枚 API Key",
    });
    const secretField = screen.getByRole("textbox", { name: "完整 API Key" });
    expect((secretField as HTMLTextAreaElement).value).toBe(apiKey);
    expect(dialog.textContent).toContain("AlphaNet 不会再次显示完整密钥");

    const createCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        (typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url) === `/v1/owner/agents/${ids.agent}/credentials` &&
        init?.method === "POST",
    );
    expect(createCall).toBeDefined();
    const requestBody = createCall?.[1]?.body;
    expect(typeof requestBody).toBe("string");
    if (typeof requestBody !== "string") {
      throw new Error("Credential component did not send a JSON request body");
    }
    expect(JSON.parse(requestBody)).toEqual({
      name: "Primary workflow",
      scopes: ["research:read", "community:read", "notifications:read", "actions:read"],
    });

    await user.click(screen.getByRole("button", { name: "我已安全保存，清除并关闭" }));
    await waitFor(() => {
      expect(screen.queryByDisplayValue(apiKey)).toBeNull();
    });
    expect(screen.getByRole("status").textContent).toContain("完整密钥已从页面清除");
    expect(screen.getByText("Primary workflow")).toBeTruthy();
  });
});
