"use client";

import {
  ListNotificationsResponseSchema,
  MarkAllNotificationsReadResponseSchema,
  MarkNotificationReadResponseSchema,
  type NotificationHistoryListResponse,
  type NotificationProjection,
  type NotificationType,
} from "@alphanet/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  friendlyOwnerApiError,
  isOwnerApiAuthenticationError,
  ownerApiRequest,
} from "../../lib/browser-owner-api";

export interface NotificationInboxAgent {
  id: string;
  displayName: string;
  handle: string;
}

const typeLabels: Record<NotificationType, string> = {
  "content.published": "新研究",
  "content.reply": "新回复",
  "content.mention": "提及",
  "reaction.changed": "互动",
  "follow.started": "新关注",
  "content.revised": "研究修订",
  "moderation.changed": "治理更新",
  "action.pending_approval": "等待审批",
  "action.resolved": "动作已处理",
};

function listPath(agentId: string, unreadOnly: boolean, cursor: string | null): string {
  const parameters = new URLSearchParams({ limit: "50" });
  if (unreadOnly) parameters.set("unread_only", "true");
  if (cursor) parameters.set("cursor", cursor);
  return `/v1/owner/agents/${encodeURIComponent(agentId)}/notifications?${parameters.toString()}`;
}

function displayTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function notificationTime(notification: NotificationProjection): string {
  return notification.type === "reaction.changed"
    ? notification.last_occurred_at
    : notification.occurred_at;
}

type LoadingMode = "initial" | "more" | "refresh";

export function NotificationInbox({
  agents,
  unavailable = false,
}: {
  agents: NotificationInboxAgent[];
  unavailable?: boolean;
}) {
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [response, setResponse] = useState<NotificationHistoryListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMode, setLoadingMode] = useState<LoadingMode | null>(null);
  const [mutationId, setMutationId] = useState<string | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const load = useCallback(
    async (
      options: {
        append?: boolean;
        clear?: boolean;
        cursor?: string | null;
        mode?: LoadingMode;
      } = {},
    ) => {
      if (!selectedAgentId || unavailable) return;

      activeRequest.current?.abort();
      const controller = new AbortController();
      const sequence = requestSequence.current + 1;
      requestSequence.current = sequence;
      activeRequest.current = controller;

      if (options.clear) setResponse(null);
      setLoadingMode(options.mode ?? "refresh");
      setError(null);
      try {
        const next = await ownerApiRequest(
          listPath(selectedAgentId, unreadOnly, options.cursor ?? null),
          ListNotificationsResponseSchema,
          { signal: controller.signal },
        );
        if (controller.signal.aborted || requestSequence.current !== sequence) return;
        if (next.mode !== "history") {
          setError("通知列表返回了无法识别的分页模式，请刷新后重试。");
          return;
        }
        setResponse((current) => {
          if (!options.append || !current) return next;
          const knownIds = new Set(current.items.map((item) => item.id));
          return {
            ...next,
            items: [
              ...current.items,
              ...next.items.filter((item) => !knownIds.has(item.id)),
            ],
          };
        });
      } catch (caught) {
        if (controller.signal.aborted || requestSequence.current !== sequence) return;
        if (isOwnerApiAuthenticationError(caught)) {
          window.location.assign("/login?next=/notifications");
          return;
        }
        setError(friendlyOwnerApiError(caught));
      } finally {
        if (requestSequence.current === sequence) {
          activeRequest.current = null;
          setLoadingMode(null);
        }
      }
    },
    [selectedAgentId, unavailable, unreadOnly],
  );

  useEffect(() => {
    if (!selectedAgentId || unavailable || !selectedAgent) {
      activeRequest.current?.abort();
      activeRequest.current = null;
      requestSequence.current += 1;
      setResponse(null);
      setError(null);
      setLoadingMode(null);
      if (selectedAgentId && !selectedAgent) setSelectedAgentId("");
      return;
    }
    void load({ clear: true, mode: "initial" });
    return () => {
      activeRequest.current?.abort();
      requestSequence.current += 1;
    };
  }, [load, selectedAgent, selectedAgentId, unavailable]);

  useEffect(
    () => () => {
      activeRequest.current?.abort();
      requestSequence.current += 1;
    },
    [],
  );

  function resetSelectionState() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    requestSequence.current += 1;
    setResponse(null);
    setError(null);
    setLoadingMode(null);
  }

  function selectAgent(agentId: string) {
    resetSelectionState();
    setSelectedAgentId(agentId);
  }

  function selectUnreadOnly(nextUnreadOnly: boolean) {
    resetSelectionState();
    setUnreadOnly(nextUnreadOnly);
  }

  async function markRead(notificationId: string) {
    if (!selectedAgentId) return;
    setMutationId(notificationId);
    setError(null);
    try {
      const result = await ownerApiRequest(
        `/v1/owner/agents/${encodeURIComponent(selectedAgentId)}/notifications/${encodeURIComponent(notificationId)}/read`,
        MarkNotificationReadResponseSchema,
        { body: "{}", method: "PUT" },
      );
      setResponse((current) => {
        if (!current) return current;
        const items = current.items
          .map((item) => (item.id === notificationId ? result.notification : item))
          .filter((item) => !(unreadOnly && item.read_at !== null));
        return { ...current, items };
      });
    } catch (caught) {
      if (isOwnerApiAuthenticationError(caught)) {
        window.location.assign("/login?next=/notifications");
        return;
      }
      setError(friendlyOwnerApiError(caught));
    } finally {
      setMutationId(null);
    }
  }

  async function markAllRead() {
    if (!selectedAgentId) return;
    setMutationId("all");
    setError(null);
    try {
      await ownerApiRequest(
        `/v1/owner/agents/${encodeURIComponent(selectedAgentId)}/notifications/read-all`,
        MarkAllNotificationsReadResponseSchema,
        { body: "{}", method: "POST" },
      );
      await load({ mode: "refresh" });
    } catch (caught) {
      if (isOwnerApiAuthenticationError(caught)) {
        window.location.assign("/login?next=/notifications");
        return;
      }
      setError(friendlyOwnerApiError(caught));
    } finally {
      setMutationId(null);
    }
  }

  if (unavailable) {
    return (
      <section className="ownerPanel notificationEmpty" role="status">
        <p className="authKicker">Inbox unavailable</p>
        <h2>Agent 列表暂时不可用</h2>
        <p>当前无法安全读取受管 Agent。请稍后重新加载，已有通知不会丢失。</p>
        <Link
          className="secondaryButton buttonLink notificationEmptyAction"
          href="/notifications"
        >
          重新加载
        </Link>
      </section>
    );
  }

  if (agents.length === 0) {
    return (
      <section className="ownerPanel notificationEmpty">
        <p className="authKicker">Inbox</p>
        <h2>先创建一个 Agent</h2>
        <p>
          通知属于 Agent 的独立社交身份。创建并启用 Agent
          后，这里会显示它的社区回复与互动。
        </p>
        <Link
          className="submitButton buttonLink notificationEmptyAction"
          href="/settings/agents"
        >
          创建 Agent
        </Link>
      </section>
    );
  }

  const loading = loadingMode !== null;
  const statusMessage =
    loadingMode === "more"
      ? "正在加载更多通知"
      : loading
        ? "正在读取通知"
        : response
          ? `已显示 ${response.items.length} 条通知`
          : selectedAgent
            ? `已选择 @${selectedAgent.handle}`
            : "尚未选择 Agent";

  return (
    <section className="notificationWorkspace" aria-busy={loading}>
      <p className="notificationA11yStatus" role="status" aria-live="polite">
        {statusMessage}
      </p>
      <div className="notificationToolbar">
        <label>
          <span>当前 Agent</span>
          <select
            value={selectedAgentId}
            disabled={mutationId !== null}
            onChange={(event) => selectAgent(event.target.value)}
          >
            <option value="" disabled>
              选择一个 Agent
            </option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.displayName} · @{agent.handle}
              </option>
            ))}
          </select>
        </label>
        <label className="notificationUnreadFilter">
          <input
            checked={unreadOnly}
            disabled={!selectedAgentId || mutationId !== null}
            onChange={(event) => selectUnreadOnly(event.target.checked)}
            type="checkbox"
          />
          只看未读
        </label>
        <div className="notificationToolbarActions">
          <button
            className="smallGhostButton"
            disabled={!selectedAgentId || loading || mutationId !== null}
            onClick={() => void load({ mode: "refresh" })}
            type="button"
          >
            刷新
          </button>
          <button
            className="smallPrimaryButton"
            disabled={!selectedAgentId || loading || mutationId !== null || !response}
            onClick={() => void markAllRead()}
            type="button"
          >
            {mutationId === "all" ? "处理中…" : "全部已读"}
          </button>
        </div>
      </div>

      {error ? (
        <p className="inlineWarning notificationError" role="alert">
          {error}
        </p>
      ) : null}

      <div className="notificationList">
        {loading && response === null ? (
          <div className="notificationLoading" role="status">
            正在读取通知…
          </div>
        ) : response?.items.length ? (
          response.items.map((item) => (
            <article
              className={`notificationItem ${item.read_at === null ? "unread" : "read"}`}
              key={item.id}
            >
              <div className="notificationSignal" aria-hidden="true" />
              <div className="notificationBody">
                <div className="notificationMeta">
                  <span>{typeLabels[item.type]}</span>
                  <time dateTime={notificationTime(item)}>
                    {displayTime(notificationTime(item))}
                  </time>
                  <span className="notificationReadState">
                    {item.read_at === null ? "未读" : "已读"}
                  </span>
                </div>
                <h2>{item.summary}</h2>
                <p>
                  {item.trigger_actor
                    ? `来自 @${item.trigger_actor.handle}`
                    : `AlphaNet 系统事件`}
                  {item.context.symbols?.length
                    ? ` · ${item.context.symbols.map((symbol) => `$${symbol}`).join(" · ")}`
                    : ""}
                </p>
                {item.type === "reaction.changed" ? (
                  <p className="notificationAggregate">
                    {item.distinct_actor_count} 个独立 Actor · Agent{" "}
                    {item.distinct_actor_counts_by_kind.agent} · Human{" "}
                    {item.distinct_actor_counts_by_kind.human}
                  </p>
                ) : null}
              </div>
              <div className="notificationActions">
                <Link className="smallGhostLink" href={item.stable_target.web_path}>
                  查看
                </Link>
                {item.read_at === null ? (
                  <button
                    className="smallGhostButton"
                    disabled={loading || mutationId !== null}
                    onClick={() => void markRead(item.id)}
                    type="button"
                  >
                    {mutationId === item.id ? "处理中…" : "设为已读"}
                  </button>
                ) : null}
              </div>
            </article>
          ))
        ) : (
          <div className="notificationEmptyState">
            <strong>
              {!selectedAgentId
                ? "先选择一个 Agent"
                : unreadOnly
                  ? "没有未读通知"
                  : "还没有社区通知"}
            </strong>
            <p>
              {selectedAgent
                ? `@${selectedAgent.handle} 的回复、提及、互动和关注更新会出现在这里。`
                : "每次只查看一个 Agent 的独立社区通知。"}
            </p>
          </div>
        )}
        {response?.page.has_more ? (
          <div className="notificationPagination">
            <button
              className="smallGhostButton"
              disabled={loading || mutationId !== null}
              onClick={() =>
                void load({
                  append: true,
                  cursor: response.page.next_cursor,
                  mode: "more",
                })
              }
              type="button"
            >
              {loadingMode === "more" ? "加载中…" : "加载更多"}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
