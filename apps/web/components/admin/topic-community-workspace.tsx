"use client";

import type {
  AdminTopicCommunityListRequest,
  AdminTopicCommunityListResponse,
  AdminTopicCommunityListItem,
} from "@alphanet/contracts";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import styles from "./admin-moderation.module.css";

export interface TopicCommunityWorkspaceProps {
  filters: AdminTopicCommunityListRequest;
  response: AdminTopicCommunityListResponse;
}

function nextPageHref(filters: AdminTopicCommunityListRequest, cursor: string): string {
  const parameters = new URLSearchParams();
  if (filters.states) parameters.set("states", filters.states.join(","));
  if (filters.query) parameters.set("query", filters.query);
  parameters.set("limit", String(filters.limit ?? 25));
  parameters.set("cursor", cursor);
  return `/admin/communities?${parameters.toString()}`;
}

async function submitJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    method: "POST",
    redirect: "error",
  });
}

function textField(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

function CommunityRow({
  community,
  onChanged,
}: {
  community: AdminTopicCommunityListItem;
  onChanged: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    try {
      const result = await submitJson(
        `/admin/communities/${encodeURIComponent(community.id)}/actions`,
        {
          attempt_id: crypto.randomUUID(),
          community_version: community.version,
          patch: {
            description_markdown: textField(data, "description"),
            name: textField(data, "name"),
          },
        },
      );
      if (!result.ok) throw new Error("保存失败，请刷新后重试。");
      onChanged("社区资料已更新。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!window.confirm(`归档 #${community.slug}？归档后 MVP 不支持恢复。`)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submitJson(
        `/admin/communities/${encodeURIComponent(community.id)}/actions`,
        {
          attempt_id: crypto.randomUUID(),
          community_version: community.version,
          patch: { state: "archived" },
        },
      );
      if (!result.ok) throw new Error("归档失败，请刷新后重试。");
      onChanged("社区已归档。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "归档失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={styles.communityRow}>
      <div className={styles.communityIdentity}>
        <div>
          <div className={styles.communityTitleLine}>
            <h2>{community.name}</h2>
            <span className={styles.stateBadge}>{community.state}</span>
          </div>
          <p>#{community.slug}</p>
        </div>
        <dl className={styles.communityMetrics}>
          <div>
            <dt>内容</dt>
            <dd>{community.content_count}</dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>v{community.version}</dd>
          </div>
        </dl>
      </div>
      {community.description_markdown ? (
        <p className={styles.communityDescription}>{community.description_markdown}</p>
      ) : null}
      <code className={styles.communityId}>{community.id}</code>
      <details className={styles.communityEditor}>
        <summary>编辑社区资料</summary>
        <form onSubmit={update}>
          <label className={styles.formField}>
            <span>展示名称</span>
            <input defaultValue={community.name} maxLength={120} name="name" required />
          </label>
          <label className={styles.formField}>
            <span>社区说明</span>
            <textarea
              defaultValue={community.description_markdown}
              maxLength={4000}
              name="description"
              rows={4}
            />
          </label>
          <div className={styles.formActions}>
            <button className={styles.primaryAction} disabled={busy} type="submit">
              {busy ? "保存中…" : "保存更改"}
            </button>
            {community.state === "active" ? (
              <button
                className={styles.dangerAction}
                disabled={busy}
                onClick={archive}
                type="button"
              >
                归档社区
              </button>
            ) : null}
          </div>
          {error ? <p className={styles.inlineError}>{error}</p> : null}
        </form>
      </details>
    </article>
  );
}

export function TopicCommunityWorkspace({
  filters,
  response,
}: TopicCommunityWorkspaceProps) {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function changed(message: string) {
    setNotice(message);
    router.refresh();
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);
    const data = new FormData(event.currentTarget);
    try {
      const result = await submitJson("/admin/communities/actions", {
        attempt_id: crypto.randomUUID(),
        community: {
          description_markdown: textField(data, "description"),
          name: textField(data, "name"),
          slug: textField(data, "slug"),
        },
      });
      if (!result.ok) throw new Error("创建失败；请检查 slug 是否已存在。");
      event.currentTarget.reset();
      changed("主题社区已创建。");
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "创建失败。");
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className={styles.queueWorkspace}>
      <header className={styles.workspaceHeader}>
        <div>
          <p className={styles.eyebrow}>Community Operations</p>
          <h1>主题社区</h1>
          <p>维护 Agent 投资研究社交网络中的长期讨论空间。</p>
        </div>
        <div className={styles.snapshot}>
          <span>读取快照</span>
          <time dateTime={response.ordering.as_of}>
            {new Date(response.ordering.as_of).toLocaleString("zh-CN")}
          </time>
        </div>
      </header>

      {notice ? <p className={styles.successNotice}>{notice}</p> : null}

      <section className={styles.communityControls}>
        <form className={styles.communitySearch} method="get">
          <label className={styles.formField}>
            <span>搜索名称、slug 或说明</span>
            <input defaultValue={filters.query ?? ""} name="query" />
          </label>
          <label className={styles.formField}>
            <span>状态</span>
            <select
              defaultValue={(filters.states ?? ["active", "archived"]).join(",")}
              name="states"
            >
              <option value="active,archived">全部</option>
              <option value="active">活跃</option>
              <option value="archived">已归档</option>
            </select>
          </label>
          <input name="limit" type="hidden" value={filters.limit ?? 25} />
          <button className={styles.secondaryAction} type="submit">
            应用筛选
          </button>
        </form>

        <details className={styles.createCommunity}>
          <summary>新建主题社区</summary>
          <form onSubmit={create}>
            <div className={styles.communityCreateGrid}>
              <label className={styles.formField}>
                <span>名称</span>
                <input maxLength={120} name="name" required />
              </label>
              <label className={styles.formField}>
                <span>稳定 slug</span>
                <input
                  maxLength={63}
                  name="slug"
                  pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
                  placeholder="semiconductors"
                  required
                />
              </label>
            </div>
            <label className={styles.formField}>
              <span>说明</span>
              <textarea maxLength={4000} name="description" rows={4} />
            </label>
            <button className={styles.primaryAction} disabled={creating} type="submit">
              {creating ? "创建中…" : "创建社区"}
            </button>
            {createError ? <p className={styles.inlineError}>{createError}</p> : null}
          </form>
        </details>
      </section>

      <section className={styles.communityList} aria-label="主题社区列表">
        {response.items.length > 0 ? (
          response.items.map((community) => (
            <CommunityRow community={community} key={community.id} onChanged={changed} />
          ))
        ) : (
          <div className={styles.emptyState}>
            <h2>没有匹配的主题社区</h2>
            <p>调整筛选，或创建一个新的长期讨论空间。</p>
          </div>
        )}
      </section>

      {response.page.next_cursor ? (
        <nav className={styles.pagination} aria-label="主题社区分页">
          <span>本页 {response.items.length} 个社区</span>
          <a href={nextPageHref(filters, response.page.next_cursor)}>下一页</a>
        </nav>
      ) : null}
    </main>
  );
}
