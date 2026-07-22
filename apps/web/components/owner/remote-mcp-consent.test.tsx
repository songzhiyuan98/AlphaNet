// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { REMOTE_MCP_OAUTH_QUERY_MAX_BYTES } from "@alphanet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  default as RemoteMcpConsentPage,
  dynamic as consentPageRendering,
  metadata as consentPageMetadata,
} from "../../app/oauth/consent/page";
import { RemoteMcpConsent } from "./remote-mcp-consent";

const ids = {
  agentA: "10000000-0000-4000-8000-000000000001",
  agentB: "10000000-0000-4000-8000-000000000002",
};
const exactOAuthQuery =
  "client_id=agent-client&scope=research%3Aread+offline_access&sig=a%2Bb%3D";
const continuationHandle = "opaque_continuation-handle_1";

function agent(id: string, handle: string, displayName: string) {
  return {
    display_name: displayName,
    handle,
    id,
    policy: {
      defaults_version: "agent-permission-defaults-v1",
      schema_version: 1,
      tier: "assisted" as const,
      version: "2",
    },
  };
}

function consentView(
  options: {
    agents?: ReturnType<typeof agent>[];
    phase?: "agent_selection" | "consent_review";
    redirectUri?: string;
    requestedScopes?: readonly ("content:write" | "offline_access" | "research:read")[];
    selectedAgentId?: string | null;
  } = {},
) {
  const phase = options.phase ?? "agent_selection";
  return {
    agents: options.agents ?? [
      agent(ids.agentA, "market-scout", "Market Scout"),
      agent(ids.agentB, "risk-scout", "Risk Scout"),
    ],
    client: {
      id: "desktop-agent-client",
      name: "Alpha Research Desktop",
      redirect_origin: "https://client.example",
      redirect_uri: options.redirectUri ?? "https://client.example/oauth/callback",
    },
    credential_policy_ceiling:
      phase === "consent_review"
        ? {
            defaults_version: "agent-permission-defaults-v1",
            schema_version: 1,
            tier: "assisted" as const,
          }
        : null,
    expires_at: "2026-07-22T20:15:00.000Z",
    phase,
    request_id: "req-consent-inspect",
    requested_scopes:
      options.requestedScopes ?? (["research:read", "offline_access"] as const),
    resource: "https://api.alphanet.example/mcp",
    schema_version: "1" as const,
    selected_agent_id:
      options.selectedAgentId ?? (phase === "consent_review" ? ids.agentA : null),
  };
}

function selectAgentResponse() {
  return {
    ...consentView({ phase: "consent_review", selectedAgentId: ids.agentB }),
    continuation_handle: continuationHandle,
    grant_expires_at: "2026-08-21T20:10:00.000Z",
    idempotent: false,
    request_id: "req-consent-select",
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
  if (typeof init?.body !== "string") throw new Error("Expected JSON body");
  return JSON.parse(init.body);
}

function requestHeaders(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

function setPageUrl(fragment = ""): void {
  window.history.replaceState(null, "", `/oauth/consent?${exactOAuthQuery}${fragment}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("RemoteMcpConsent", () => {
  it("keeps authorization rendering dynamic and out of search/referrer surfaces", () => {
    expect(consentPageRendering).toBe("force-dynamic");
    expect(consentPageMetadata).toMatchObject({
      referrer: "no-referrer",
      robots: { follow: false, index: false },
    });
  });

  it("returns a real 404 unless the server-only consent gate is exactly true", async () => {
    const previous = process.env.MCP_OAUTH_OWNER_CONSENT_ENABLED;
    delete process.env.MCP_OAUTH_OWNER_CONSENT_ENABLED;
    try {
      await expect(RemoteMcpConsentPage()).rejects.toMatchObject({
        digest: "NEXT_HTTP_ERROR_FALLBACK;404",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.MCP_OAUTH_OWNER_CONSENT_ENABLED;
      } else {
        process.env.MCP_OAUTH_OWNER_CONSENT_ENABLED = previous;
      }
    }
  });

  it("does not inspect or redirect when the Owner session is unavailable", () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    render(<RemoteMcpConsent sessionState="unauthenticated" />);

    expect(
      screen.getByRole("heading", { name: "请从 Agent 客户端重新连接" }),
    ).toBeTruthy();
    expect(screen.getByText(/不会自动跳转登录/u)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the exact signed query and reads continuation only from the fragment", async () => {
    setPageUrl(`#continuation=${continuationHandle}`);
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(
          consentView({ phase: "consent_review", selectedAgentId: ids.agentA }),
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RemoteMcpConsent sessionState="authenticated" />);

    expect(await screen.findByRole("heading", { name: "确认 Agent 访问" })).toBeTruthy();
    expect(screen.getByText("https://client.example")).toBeTruthy();
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toBe(
      "/v1/owner/remote-mcp/oauth/consent/inspect",
    );
    expect(requestBody(fetchMock.mock.calls[0]![1])).toEqual({
      continuation_handle: continuationHandle,
      oauth_query: exactOAuthQuery,
    });
    expect(fetchMock.mock.calls[0]![1]?.referrerPolicy).toBe("no-referrer");
    expect(fetchMock.mock.calls[0]![1]?.redirect).toBe("error");
  });

  it("never treats a continuation-looking query parameter as the continuation", async () => {
    window.history.replaceState(
      null,
      "",
      `/oauth/consent?continuation=query_value&${exactOAuthQuery}`,
    );
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(consentView())),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RemoteMcpConsent sessionState="authenticated" />);
    await screen.findByRole("heading", { name: "选择 Agent" });

    expect(requestBody(fetchMock.mock.calls[0]![1])).toEqual({
      oauth_query: `continuation=query_value&${exactOAuthQuery}`,
    });
  });

  it("rejects an oversized exact query before any API request", async () => {
    window.history.replaceState(
      null,
      "",
      `/oauth/consent?${"a".repeat(REMOTE_MCP_OAUTH_QUERY_MAX_BYTES + 1)}`,
    );
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    render(<RemoteMcpConsent sessionState="authenticated" />);

    expect(await screen.findByRole("heading", { name: "这次授权不能继续" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("selects an Agent, stores the bounded handle in the fragment, then continues", async () => {
    setPageUrl();
    const navigate = vi.fn();
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/consent/inspect")) {
        return Promise.resolve(Response.json(consentView()));
      }
      if (url.endsWith("/consent/select-agent")) {
        return Promise.resolve(Response.json(selectAgentResponse()));
      }
      if (url.endsWith("/api/auth/oauth2/continue")) {
        return Promise.resolve(
          Response.json({
            redirect: true,
            url: `${window.location.origin}/oauth/consent?new=signed%2Bquery`,
          }),
        );
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <RemoteMcpConsent
        navigate={navigate}
        ownerName="Demo Owner"
        sessionState="authenticated"
      />,
    );

    await screen.findByRole("heading", { name: "选择 Agent" });
    await user.click(screen.getByRole("radio", { name: /Risk Scout/u }));
    await user.click(screen.getByRole("button", { name: "继续检查权限" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    const selectCall = fetchMock.mock.calls.find(([input]) =>
      requestUrl(input).endsWith("/consent/select-agent"),
    );
    expect(requestBody(selectCall?.[1])).toEqual({
      agent_id: ids.agentB,
      oauth_query: exactOAuthQuery,
    });
    expect(window.location.hash).toBe(`#continuation=${continuationHandle}`);

    const continueCall = fetchMock.mock.calls.find(([input]) =>
      requestUrl(input).endsWith("/api/auth/oauth2/continue"),
    );
    expect(requestBody(continueCall?.[1])).toEqual({
      oauth_query: exactOAuthQuery,
      postLogin: true,
    });
    expect(requestHeaders(continueCall?.[1]).get("X-AlphaNet-OAuth-Continuation")).toBe(
      continuationHandle,
    );
    expect(continueCall?.[1]?.credentials).toBe("include");
    expect(continueCall?.[1]?.referrerPolicy).toBe("no-referrer");
    expect(navigate).toHaveBeenCalledWith(
      `${window.location.origin}/oauth/consent?new=signed%2Bquery#continuation=${continuationHandle}`,
    );
  });

  it("blocks credentials in a same-origin interim redirect and does not navigate", async () => {
    setPageUrl();
    const navigate = vi.fn();
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/consent/inspect")) {
        return Promise.resolve(Response.json(consentView()));
      }
      if (url.endsWith("/consent/select-agent")) {
        return Promise.resolve(Response.json(selectAgentResponse()));
      }
      return Promise.resolve(
        Response.json({
          redirect: true,
          url: `${window.location.protocol}//user:pass@${window.location.host}/oauth/consent?new=signed`,
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<RemoteMcpConsent navigate={navigate} sessionState="authenticated" />);

    await screen.findByRole("heading", { name: "选择 Agent" });
    await user.click(screen.getByRole("radio", { name: /Risk Scout/u }));
    await user.click(screen.getByRole("button", { name: "继续检查权限" }));

    expect(await screen.findByText(/未能安全继续授权/u, { selector: "p" })).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("allows once, sends the exact query and handle, and validates client origin", async () => {
    setPageUrl(`#continuation=${continuationHandle}`);
    const navigate = vi.fn();
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/consent/inspect")) {
        return Promise.resolve(
          Response.json(
            consentView({
              phase: "consent_review",
              requestedScopes: ["research:read", "content:write", "offline_access"],
              redirectUri: "https://client.example/oauth/callback?tenant=research",
              selectedAgentId: ids.agentA,
            }),
          ),
        );
      }
      if (url.endsWith("/api/auth/oauth2/consent")) {
        return Promise.resolve(
          Response.json({
            redirect: true,
            url: "https://client.example/oauth/callback?tenant=research&code=one&state=two",
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<RemoteMcpConsent navigate={navigate} sessionState="authenticated" />);

    await screen.findByRole("heading", { name: "确认 Agent 访问" });
    expect(screen.getByText("短期访问令牌：10 分钟")).toBeTruthy();
    expect(screen.getByText(/授权最长不超过 30 天/u)).toBeTruthy();
    expect(screen.getByText(/发布、回复、更新或删除研究内容/u)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "允许此访问" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    const consentCall = fetchMock.mock.calls.find(([input]) =>
      requestUrl(input).endsWith("/api/auth/oauth2/consent"),
    );
    expect(requestBody(consentCall?.[1])).toEqual({
      accept: true,
      oauth_query: exactOAuthQuery,
    });
    expect(requestHeaders(consentCall?.[1]).get("X-AlphaNet-OAuth-Continuation")).toBe(
      continuationHandle,
    );
    expect(navigate).toHaveBeenCalledWith(
      "https://client.example/oauth/callback?tenant=research&code=one&state=two",
    );
  });

  it("rejects credentials in a final redirect even when its origin matches", async () => {
    setPageUrl(`#continuation=${continuationHandle}`);
    const navigate = vi.fn();
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/consent/inspect")) {
        return Promise.resolve(
          Response.json(
            consentView({ phase: "consent_review", selectedAgentId: ids.agentA }),
          ),
        );
      }
      return Promise.resolve(
        Response.json({
          redirect: true,
          url: "https://user:pass@client.example/callback",
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<RemoteMcpConsent navigate={navigate} sessionState="authenticated" />);

    await screen.findByRole("heading", { name: "确认 Agent 访问" });
    await user.click(screen.getByRole("button", { name: "拒绝" }));

    expect(await screen.findByText(/授权结果无法安全返回客户端/u)).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    const consentCall = fetchMock.mock.calls.find(([input]) =>
      requestUrl(input).endsWith("/api/auth/oauth2/consent"),
    );
    expect(requestBody(consentCall?.[1])).toEqual({
      accept: false,
      oauth_query: exactOAuthQuery,
    });
  });

  it("rejects a final redirect to a sibling path on the verified origin", async () => {
    setPageUrl(`#continuation=${continuationHandle}`);
    const navigate = vi.fn();
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/consent/inspect")) {
        return Promise.resolve(
          Response.json(
            consentView({ phase: "consent_review", selectedAgentId: ids.agentA }),
          ),
        );
      }
      return Promise.resolve(
        Response.json({
          redirect: true,
          url: "https://client.example/sibling-app?code=stolen&state=opaque",
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<RemoteMcpConsent navigate={navigate} sessionState="authenticated" />);

    await screen.findByRole("heading", { name: "确认 Agent 访问" });
    await user.click(screen.getByRole("button", { name: "允许此访问" }));

    expect(await screen.findByText(/授权结果无法安全返回客户端/u)).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("rejects a final redirect that drops the registered URI query binding", async () => {
    setPageUrl(`#continuation=${continuationHandle}`);
    const navigate = vi.fn();
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/consent/inspect")) {
        return Promise.resolve(
          Response.json(
            consentView({
              phase: "consent_review",
              redirectUri: "https://client.example/oauth/callback?tenant=research",
              selectedAgentId: ids.agentA,
            }),
          ),
        );
      }
      return Promise.resolve(
        Response.json({
          redirect: true,
          url: "https://client.example/oauth/callback?code=one&state=two",
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<RemoteMcpConsent navigate={navigate} sessionState="authenticated" />);

    await screen.findByRole("heading", { name: "确认 Agent 访问" });
    await user.click(screen.getByRole("button", { name: "允许此访问" }));

    expect(await screen.findByText(/授权结果无法安全返回客户端/u)).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("renders the no-Agent state without offering an unsafe shortcut", async () => {
    setPageUrl();
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(consentView({ agents: [] }))),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<RemoteMcpConsent sessionState="authenticated" />);

    expect(
      await screen.findByRole("heading", { name: "没有可用于授权的 Agent" }),
    ).toBeTruthy();
    expect(screen.getByText(/Agent 客户端重新发起连接/u)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /登录/u })).toBeNull();
  });

  it("stops a replayed continuation and tells the Owner to restart", async () => {
    setPageUrl(`#continuation=${continuationHandle}`);
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(
          {
            error: {
              code: "CONTINUATION_REPLAYED",
              details: null,
              message: "Continuation already used.",
              retry_after_ms: null,
              retryable: false,
            },
            request_id: "req-replayed",
            schema_version: "1",
          },
          { status: 409 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<RemoteMcpConsent sessionState="authenticated" />);

    expect(await screen.findByRole("heading", { name: "这次授权不能继续" })).toBeTruthy();
    expect(screen.getByText(/已经被处理/u)).toBeTruthy();
  });

  it("treats an Owner boundary rejection as a restart, not service downtime", async () => {
    setPageUrl();
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(
          {
            error: {
              code: "OWNER_NOT_ACTIVE",
              details: null,
              message: "Owner is not active.",
              retry_after_ms: null,
              retryable: false,
            },
            request_id: "req-owner-inactive",
            schema_version: "1",
          },
          { status: 403 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<RemoteMcpConsent sessionState="authenticated" />);

    expect(await screen.findByRole("heading", { name: "这次授权不能继续" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "授权服务暂时不可用" })).toBeNull();
  });

  it("uses a synchronous lock to prevent duplicate Agent-selection submissions", async () => {
    setPageUrl();
    const pendingSelection = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/consent/inspect")) {
        return Promise.resolve(Response.json(consentView()));
      }
      if (url.endsWith("/consent/select-agent")) return pendingSelection.promise;
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<RemoteMcpConsent sessionState="authenticated" />);

    await screen.findByRole("heading", { name: "选择 Agent" });
    await user.click(screen.getByRole("radio", { name: /Market Scout/u }));
    const submit = screen.getByRole("button", { name: "继续检查权限" });
    const form = submit.closest("form");
    if (!form) throw new Error("Expected selection form");
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          requestUrl(input).endsWith("/consent/select-agent"),
        ),
      ).toHaveLength(1);
    });
    pendingSelection.resolve(Response.json(selectAgentResponse()));
  });
});
