// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  NotificationHistoryListResponseSchema,
  type NotificationHistoryListResponse,
  type NotificationProjection,
} from "@alphanet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationInbox, type NotificationInboxAgent } from "./notification-inbox";

const ids = {
  action: "10000000-0000-4000-8000-000000000001",
  actorA: "20000000-0000-4000-8000-000000000001",
  actorB: "20000000-0000-4000-8000-000000000002",
  agentA: "30000000-0000-4000-8000-000000000001",
  agentB: "30000000-0000-4000-8000-000000000002",
  contentA: "40000000-0000-4000-8000-000000000001",
  contentB: "40000000-0000-4000-8000-000000000002",
  notificationA: "50000000-0000-4000-8000-000000000001",
  notificationB: "50000000-0000-4000-8000-000000000002",
  triggerActor: "60000000-0000-4000-8000-000000000001",
  triggerAgent: "70000000-0000-4000-8000-000000000001",
} as const;

const agents: NotificationInboxAgent[] = [
  { id: ids.agentA, displayName: "Memory Scout", handle: "memory-scout" },
  { id: ids.agentB, displayName: "Risk Scout", handle: "risk-scout" },
];

const firstTime = "2026-07-21T20:00:00.000Z";
const secondTime = "2026-07-21T19:00:00.000Z";

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

function contentNotification(options: {
  contentId?: string;
  id?: string;
  readAt?: string | null;
  recipientActorId?: string;
  summary: string;
  time?: string;
}): NotificationProjection {
  const contentId = options.contentId ?? ids.contentA;
  const time = options.time ?? firstTime;
  return {
    context: { symbols: ["MU"] },
    created_at: time,
    dedupe_key: `content.reply:${options.id ?? ids.notificationA}`,
    id: options.id ?? ids.notificationA,
    object: { id: contentId, type: "content" },
    occurred_at: time,
    read_at: options.readAt ?? null,
    recipient_actor_id: options.recipientActorId ?? ids.actorA,
    schema_version: "notification-v1",
    stable_target: {
      resource_id: contentId,
      resource_type: "content",
      web_path: `/content/${contentId}`,
    },
    summary: options.summary,
    trigger_actor: {
      actor_id: ids.triggerActor,
      agent_id: ids.triggerAgent,
      handle: "source-scout",
      kind: "agent",
    },
    type: "content.reply",
    updated_at: time,
    version: 1,
  };
}

function actionNotification(): NotificationProjection {
  return {
    context: {},
    created_at: firstTime,
    dedupe_key: `action.resolved:${ids.notificationA}`,
    id: ids.notificationA,
    object: { id: ids.action, type: "pending_action" },
    occurred_at: firstTime,
    read_at: null,
    recipient_actor_id: ids.actorA,
    schema_version: "notification-v1",
    stable_target: {
      resource_id: ids.action,
      resource_type: "pending_action",
      web_path: `/settings/approvals/${ids.action}`,
    },
    summary: "A pending action reached a terminal state.",
    trigger_actor: null,
    type: "action.resolved",
    updated_at: firstTime,
    version: 1,
  };
}

function historyResponse(
  options: {
    cursor?: string | null;
    filters?: { unread_only?: boolean };
    items?: NotificationProjection[];
    requestId?: string;
  } = {},
): NotificationHistoryListResponse {
  return NotificationHistoryListResponseSchema.parse({
    filters: options.filters ?? {},
    items: options.items ?? [],
    mode: "history",
    ordering: {
      as_of: "2026-07-21T21:00:00.000Z",
      ordering_version: "notifications-created-at-v1",
      snapshot_id: "nts_history_component",
    },
    page: {
      has_more: options.cursor !== undefined && options.cursor !== null,
      limit: 50,
      next_cursor: options.cursor ?? null,
    },
    poll: { has_more: false, next_cursor: "npc_component_poll" },
    request_id: options.requestId ?? "req-notification-component",
    schema_version: "1",
  });
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
  vi.unstubAllGlobals();
});

describe("NotificationInbox", () => {
  it("waits for an explicit Agent selection before loading its isolated inbox", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(
          historyResponse({
            items: [contentNotification({ summary: "Agent A reply" })],
          }),
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<NotificationInbox agents={agents} />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("先选择一个 Agent")).toBeTruthy();
    const selector = screen.getByRole("combobox", { name: "当前 Agent" });
    expect((selector as HTMLSelectElement).value).toBe("");

    await user.selectOptions(selector, ids.agentA);
    expect(await screen.findByText("Agent A reply")).toBeTruthy();
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toBe(
      `/v1/owner/agents/${ids.agentA}/notifications?limit=50`,
    );
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts and ignores an older Agent request when a newer selection wins", async () => {
    const agentARequest = deferred<Response>();
    const agentBRequest = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.includes(ids.agentA)) return agentARequest.promise;
      if (url.includes(ids.agentB)) return agentBRequest.promise;
      throw new Error(`Unexpected notification request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<NotificationInbox agents={agents} />);
    const selector = screen.getByRole("combobox", { name: "当前 Agent" });
    await user.selectOptions(selector, ids.agentA);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const firstSignal = fetchMock.mock.calls[0]![1]?.signal;

    await user.selectOptions(selector, ids.agentB);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(firstSignal?.aborted).toBe(true);

    agentBRequest.resolve(
      Response.json(
        historyResponse({
          items: [
            contentNotification({
              contentId: ids.contentB,
              id: ids.notificationB,
              recipientActorId: ids.actorB,
              summary: "Agent B risk reply",
            }),
          ],
          requestId: "req-agent-b",
        }),
      ),
    );
    expect(await screen.findByText("Agent B risk reply")).toBeTruthy();

    const staleResponse = Response.json(
      historyResponse({
        items: [contentNotification({ summary: "Stale Agent A reply" })],
        requestId: "req-agent-a",
      }),
    );
    agentARequest.resolve(staleResponse);
    await waitFor(() => expect(staleResponse.bodyUsed).toBe(true));
    expect(screen.queryByText("Stale Agent A reply")).toBeNull();
    expect(screen.getByText("Agent B risk reply")).toBeTruthy();
  });

  it("loads later history pages with the selected unread filter intact", async () => {
    const firstUnread = contentNotification({ summary: "Newest unread reply" });
    const secondUnread = contentNotification({
      contentId: ids.contentB,
      id: ids.notificationB,
      summary: "Older unread reply",
      time: secondTime,
    });
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("?limit=50")) {
        return Promise.resolve(Response.json(historyResponse()));
      }
      if (url.endsWith("?limit=50&unread_only=true")) {
        return Promise.resolve(
          Response.json(
            historyResponse({
              cursor: "nhc_page_2",
              filters: { unread_only: true },
              items: [firstUnread],
            }),
          ),
        );
      }
      if (url.endsWith("?limit=50&unread_only=true&cursor=nhc_page_2")) {
        return Promise.resolve(
          Response.json(
            historyResponse({
              filters: { unread_only: true },
              items: [secondUnread],
              requestId: "req-page-2",
            }),
          ),
        );
      }
      throw new Error(`Unexpected notification request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<NotificationInbox agents={agents} />);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "当前 Agent" }),
      ids.agentA,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("checkbox", { name: "只看未读" }));
    expect(await screen.findByText("Newest unread reply")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("Older unread reply")).toBeTruthy();
    expect(screen.getByText("Newest unread reply")).toBeTruthy();
    expect(requestUrl(fetchMock.mock.calls[2]![0])).toContain(
      "unread_only=true&cursor=nhc_page_2",
    );
  });

  it("keeps mark-all available when the visible page has no unread item", async () => {
    const readNotification = contentNotification({
      readAt: "2026-07-21T20:05:00.000Z",
      summary: "Already read reply",
    });
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (init?.method === "POST" && url.endsWith("/notifications/read-all")) {
        return Promise.resolve(
          Response.json({
            marked_count: 0,
            read_at: "2026-07-21T20:10:00.000Z",
            request_id: "req-mark-all",
            schema_version: "1",
            unread_count: 0,
          }),
        );
      }
      return Promise.resolve(
        Response.json(historyResponse({ items: [readNotification] })),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<NotificationInbox agents={agents} />);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "当前 Agent" }),
      ids.agentA,
    );
    expect(await screen.findByText("Already read reply")).toBeTruthy();

    const markAll = screen.getByRole("button", { name: "全部已读" });
    expect((markAll as HTMLButtonElement).disabled).toBe(false);
    await user.click(markAll);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            requestUrl(input).endsWith("/notifications/read-all") &&
            init?.method === "POST",
        ),
      ).toBe(true),
    );
  });

  it("separates dependency failure from the real no-Agent state and exposes status text", () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<NotificationInbox agents={[]} unavailable />);
    expect(screen.getByRole("status").textContent).toContain("Agent 列表暂时不可用");
    expect(screen.queryByText("先创建一个 Agent")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    rerender(<NotificationInbox agents={[]} />);
    expect(screen.getByText("先创建一个 Agent")).toBeTruthy();
  });

  it("uses neutral resolved-action and explicit read-state labels", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(historyResponse({ items: [actionNotification()] }))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<NotificationInbox agents={agents} />);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "当前 Agent" }),
      ids.agentA,
    );

    expect(await screen.findByText("动作已处理")).toBeTruthy();
    expect(screen.getByText("未读")).toBeTruthy();
  });
});
