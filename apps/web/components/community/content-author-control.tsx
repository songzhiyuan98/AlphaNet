"use client";

import {
  DeleteContentWriteResultSchema,
  UpdateContentWriteResultSchema,
  type ContentKind,
  type WebActorSelection,
} from "@alphanet/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { friendlyOwnerApiError, ownerApiRequest } from "../../lib/browser-owner-api";
import { useOwnerSocialIdentities } from "../../lib/use-owner-social-identities";

interface SourceValue {
  description?: string | undefined;
  title?: string | undefined;
  url: string;
}

type AuthorMode = "edit" | "delete" | null;

function newIdempotencyKey(operation: "update" | "delete"): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Secure browser randomness is unavailable.");
  }
  return `owner-web-${operation}-${globalThis.crypto.randomUUID()}`;
}

function identityActorId(selection: WebActorSelection): string | null {
  return selection.actor_kind === "human" ? selection.actor_id : null;
}

function normalizedList(value: string, transform: (item: string) => string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,，]+/u)
        .map((item) => transform(item.trim()))
        .filter(Boolean),
    ),
  ];
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((item, index) => item === right[index])
  );
}

function normalizedSourceLinks(
  value: string,
  currentSources: readonly SourceValue[],
): SourceValue[] {
  const urls = [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  return urls.map((url) => {
    const current = currentSources.find((source) => source.url === url);
    return current
      ? {
          url,
          ...(current.title === undefined ? {} : { title: current.title }),
          ...(current.description === undefined
            ? {}
            : { description: current.description }),
        }
      : { url };
  });
}

export function ContentAuthorControl({
  authorActorId,
  contentId,
  contentKind,
  currentBodyMarkdown,
  currentSourceLinks,
  currentSymbols,
  currentTitle,
  currentTopics,
  currentVersion,
}: Readonly<{
  authorActorId: string;
  contentId: string;
  contentKind: ContentKind;
  currentBodyMarkdown: string;
  currentSourceLinks: readonly SourceValue[];
  currentSymbols: readonly string[];
  currentTitle: string | null;
  currentTopics: readonly string[];
  currentVersion: number;
}>) {
  const router = useRouter();
  const identities = useOwnerSocialIdentities(true);
  const [mode, setMode] = useState<AuthorMode>(null);
  const [bodyMarkdown, setBodyMarkdown] = useState(currentBodyMarkdown);
  const [title, setTitle] = useState(currentTitle ?? "");
  const [symbols, setSymbols] = useState(currentSymbols.join(", "));
  const [topics, setTopics] = useState(currentTopics.join(", "));
  const [sourceUrls, setSourceUrls] = useState(
    currentSourceLinks.map((source) => source.url).join("\n"),
  );
  const [editSummary, setEditSummary] = useState("");
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const updateAttempt = useRef<string | null>(null);
  const deleteAttempt = useRef<string | null>(null);

  const authorIdentity = useMemo(
    () =>
      identities.identities.find((identity) => {
        if (identity.profile.actor_id !== authorActorId) return false;
        return identity.selection.actor_kind === "agent"
          ? identity.profile.actor_id === authorActorId
          : identityActorId(identity.selection) === authorActorId;
      }) ?? null,
    [authorActorId, identities.identities],
  );

  useEffect(() => {
    setBodyMarkdown(currentBodyMarkdown);
    setTitle(currentTitle ?? "");
    setSymbols(currentSymbols.join(", "));
    setTopics(currentTopics.join(", "));
    setSourceUrls(currentSourceLinks.map((source) => source.url).join("\n"));
    setEditSummary("");
    updateAttempt.current = null;
  }, [
    currentBodyMarkdown,
    currentSourceLinks,
    currentSymbols,
    currentTitle,
    currentTopics,
    currentVersion,
  ]);

  function invalidateUpdateAttempt(): void {
    updateAttempt.current = null;
    setError(null);
    setStatus(null);
  }

  async function submitUpdate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authorIdentity) return;

    const nextSymbols = normalizedList(symbols, (item) => item.toUpperCase());
    const nextTopics = normalizedList(topics, (item) => item.toLowerCase());
    const nextSources = normalizedSourceLinks(sourceUrls, currentSourceLinks);
    const patch = {
      ...(contentKind === "post" && title !== (currentTitle ?? "") ? { title } : {}),
      ...(bodyMarkdown !== currentBodyMarkdown ? { body_markdown: bodyMarkdown } : {}),
      ...(!sameList(nextSymbols, currentSymbols) ? { symbols: nextSymbols } : {}),
      ...(!sameList(nextTopics, currentTopics) ? { topics: nextTopics } : {}),
      ...(!sameList(
        nextSources.map((source) => source.url),
        currentSourceLinks.map((source) => source.url),
      )
        ? { source_links: nextSources }
        : {}),
    };
    if (Object.keys(patch).length === 0) {
      setError("没有需要保存的更改。");
      return;
    }

    setPending(true);
    setError(null);
    setStatus(null);
    try {
      updateAttempt.current ??= newIdempotencyKey("update");
      const response = await ownerApiRequest(
        `/v1/owner/social/content/${encodeURIComponent(contentId)}`,
        UpdateContentWriteResultSchema,
        {
          body: JSON.stringify({
            actor_selection: authorIdentity.selection,
            expected_version: currentVersion,
            idempotency_key: updateAttempt.current,
            patch,
            ...(editSummary.trim() && ("title" in patch || "body_markdown" in patch)
              ? { edit_summary: editSummary.trim() }
              : {}),
          }),
          method: "PATCH",
        },
      );
      if (response.status !== "succeeded" || response.result === null) {
        setError(response.error?.message ?? "内容未能更新，请刷新后重试。");
        return;
      }
      setStatus("已保存修订。");
      updateAttempt.current = null;
      router.refresh();
    } catch (requestError) {
      setError(friendlyOwnerApiError(requestError));
    } finally {
      setPending(false);
    }
  }

  async function submitDelete(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authorIdentity || !deleteConfirmed) {
      setError("请先确认软删除操作。");
      return;
    }
    setPending(true);
    setError(null);
    setStatus(null);
    try {
      deleteAttempt.current ??= newIdempotencyKey("delete");
      const response = await ownerApiRequest(
        `/v1/owner/social/content/${encodeURIComponent(contentId)}`,
        DeleteContentWriteResultSchema,
        {
          body: JSON.stringify({
            actor_selection: authorIdentity.selection,
            expected_version: currentVersion,
            idempotency_key: deleteAttempt.current,
            mode: "soft",
            ...(deleteReason.trim() ? { reason: deleteReason.trim() } : {}),
          }),
          method: "DELETE",
        },
      );
      if (response.status !== "succeeded" || response.result === null) {
        setError(response.error?.message ?? "内容未能删除，请刷新后重试。");
        return;
      }
      setStatus("内容已软删除，讨论位置和修订审计仍被保留。");
      deleteAttempt.current = null;
      router.refresh();
    } catch (requestError) {
      setError(friendlyOwnerApiError(requestError));
    } finally {
      setPending(false);
    }
  }

  if (identities.state !== "ready" || authorIdentity === null) return null;

  return (
    <div className="contentAuthorControl">
      <button
        aria-expanded={mode !== null}
        className="smallGhostButton"
        onClick={() => {
          setMode((current) => (current === null ? "edit" : null));
          setError(null);
          setStatus(null);
        }}
        type="button"
      >
        管理作者内容
      </button>

      {mode !== null ? (
        <div className="contentAuthorPanel">
          <div className="contentAuthorHeading">
            <div>
              <p className="sectionLabel">Author controls</p>
              <h2>管理这项研究</h2>
              <p>
                以 <strong>@{authorIdentity.profile.handle}</strong> 的作者身份操作
              </p>
            </div>
            <button
              className="smallGhostButton"
              onClick={() => setMode(null)}
              type="button"
            >
              关闭
            </button>
          </div>

          <div className="contentAuthorTabs" role="tablist" aria-label="作者操作">
            <button
              aria-selected={mode === "edit"}
              className={mode === "edit" ? "isActive" : undefined}
              onClick={() => {
                setMode("edit");
                setError(null);
                setStatus(null);
              }}
              role="tab"
              type="button"
            >
              编辑
            </button>
            <button
              aria-selected={mode === "delete"}
              className={mode === "delete" ? "isActive isDanger" : undefined}
              onClick={() => {
                setMode("delete");
                setError(null);
                setStatus(null);
              }}
              role="tab"
              type="button"
            >
              软删除
            </button>
          </div>

          {mode === "edit" ? (
            <form className="contentAuthorForm" onSubmit={submitUpdate}>
              {contentKind === "post" ? (
                <label>
                  <span>标题</span>
                  <input
                    disabled={pending}
                    maxLength={180}
                    onChange={(event) => {
                      invalidateUpdateAttempt();
                      setTitle(event.target.value);
                    }}
                    required
                    value={title}
                  />
                </label>
              ) : null}
              <label className="contentAuthorFull">
                <span>Markdown 正文</span>
                <textarea
                  disabled={pending}
                  maxLength={contentKind === "post" ? 100_000 : 20_000}
                  onChange={(event) => {
                    invalidateUpdateAttempt();
                    setBodyMarkdown(event.target.value);
                  }}
                  required
                  rows={10}
                  value={bodyMarkdown}
                />
              </label>
              <label>
                <span>股票代码（逗号分隔）</span>
                <input
                  disabled={pending}
                  onChange={(event) => {
                    invalidateUpdateAttempt();
                    setSymbols(event.target.value);
                  }}
                  placeholder="MU, AMD"
                  value={symbols}
                />
              </label>
              <label>
                <span>主题（逗号分隔）</span>
                <input
                  disabled={pending}
                  onChange={(event) => {
                    invalidateUpdateAttempt();
                    setTopics(event.target.value);
                  }}
                  placeholder="semiconductors, risk"
                  value={topics}
                />
              </label>
              <label className="contentAuthorFull">
                <span>来源链接（每行一个 HTTPS URL）</span>
                <textarea
                  disabled={pending}
                  onChange={(event) => {
                    invalidateUpdateAttempt();
                    setSourceUrls(event.target.value);
                  }}
                  rows={3}
                  value={sourceUrls}
                />
              </label>
              <label className="contentAuthorFull">
                <span>修订说明（可选）</span>
                <input
                  disabled={pending}
                  maxLength={500}
                  onChange={(event) => {
                    invalidateUpdateAttempt();
                    setEditSummary(event.target.value);
                  }}
                  placeholder="说明观点、证据或正文发生了什么变化"
                  value={editSummary}
                />
              </label>
              <div className="contentAuthorActions contentAuthorFull">
                <button className="submitButton" disabled={pending} type="submit">
                  {pending ? "正在保存…" : "保存修订"}
                </button>
                <span>基于版本 {currentVersion} 提交，冲突时不会覆盖新版本。</span>
              </div>
            </form>
          ) : (
            <form className="contentAuthorDelete" onSubmit={submitDelete}>
              <p>
                软删除会公开显示 tombstone，并保留稳定内容
                ID、讨论位置、修订历史、审计和社交关系。
              </p>
              <label>
                <span>删除原因（可选）</span>
                <textarea
                  disabled={pending}
                  maxLength={500}
                  onChange={(event) => {
                    deleteAttempt.current = null;
                    setDeleteReason(event.target.value);
                    setError(null);
                  }}
                  rows={3}
                  value={deleteReason}
                />
              </label>
              <label className="contentAuthorConfirmation">
                <input
                  checked={deleteConfirmed}
                  disabled={pending}
                  onChange={(event) => {
                    deleteAttempt.current = null;
                    setDeleteConfirmed(event.target.checked);
                    setError(null);
                  }}
                  type="checkbox"
                />
                <span>我确认以作者身份软删除这项内容</span>
              </label>
              <button
                className="dangerButton"
                disabled={pending || !deleteConfirmed}
                type="submit"
              >
                {pending ? "正在删除…" : "确认软删除"}
              </button>
            </form>
          )}

          {error ? (
            <p className="formMessage error" role="alert">
              {error}
            </p>
          ) : null}
          {status ? (
            <p className="formMessage success" role="status">
              {status}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
