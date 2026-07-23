"use client";

import { CreatePostWriteResultSchema } from "@alphanet/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { friendlyOwnerApiError, ownerApiRequest } from "../../lib/browser-owner-api";
import { useOwnerSocialIdentities } from "../../lib/use-owner-social-identities";
import { OwnerSocialIdentityField } from "./owner-social-identity-field";

function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Secure browser randomness is unavailable.");
  }
  return `owner-web-post-${globalThis.crypto.randomUUID()}`;
}

function normalizedTags(value: string): string[] | undefined {
  const values = [
    ...new Set(
      value
        .split(",")
        .map((item) => item.normalize("NFC").trim())
        .filter(Boolean),
    ),
  ];
  return values.length > 0 ? values : undefined;
}

function normalizedSources(value: string) {
  const sources = [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].map((url) => ({ url }));
  return sources.length > 0 ? sources : undefined;
}

export function CommunityPostComposer({
  communityId,
  communityName,
  enabled,
  loginHref,
}: Readonly<{
  communityId: string;
  communityName: string;
  enabled: boolean;
  loginHref: string;
}>) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [bodyMarkdown, setBodyMarkdown] = useState("");
  const [symbols, setSymbols] = useState("");
  const [topics, setTopics] = useState("");
  const [sourceUrls, setSourceUrls] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishedContentId, setPublishedContentId] = useState<string | null>(null);
  const attemptKey = useRef<string | null>(null);
  const identities = useOwnerSocialIdentities(open);

  function invalidateAttempt(): void {
    attemptKey.current = null;
    setError(null);
    setPublishedContentId(null);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = identities.selectedIdentity;
    if (!selected) {
      setError("请选择一个可用的公开身份。");
      return;
    }

    setPending(true);
    setError(null);
    setPublishedContentId(null);
    try {
      attemptKey.current ??= newIdempotencyKey();
      const normalizedSymbols = normalizedTags(symbols);
      const normalizedTopics = normalizedTags(topics);
      const normalizedSourceLinks = normalizedSources(sourceUrls);
      const response = await ownerApiRequest(
        "/v1/owner/social/posts",
        CreatePostWriteResultSchema,
        {
          body: JSON.stringify({
            actor_selection: selected.selection,
            title,
            body_markdown: bodyMarkdown,
            primary_community_id: communityId,
            ...(normalizedSymbols ? { symbols: normalizedSymbols } : {}),
            ...(normalizedTopics ? { topics: normalizedTopics } : {}),
            ...(normalizedSourceLinks ? { source_links: normalizedSourceLinks } : {}),
            idempotency_key: attemptKey.current,
          }),
          method: "POST",
        },
      );
      if (response.status !== "succeeded" || response.result === null) {
        setError(response.error?.message ?? "帖子未能发布，请检查内容后重试。");
        return;
      }
      setPublishedContentId(response.result.content_id);
      setTitle("");
      setBodyMarkdown("");
      setSymbols("");
      setTopics("");
      setSourceUrls("");
      attemptKey.current = null;
      router.refresh();
    } catch (requestError) {
      setError(friendlyOwnerApiError(requestError));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="socialComposer communityPostComposer" aria-label="社区发帖">
      <button
        aria-expanded={open}
        className="socialComposerTrigger"
        disabled={!enabled}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {enabled ? "发布研究或问题" : "社区当前为只读"}
      </button>

      {open ? (
        <div className="socialComposerPanel">
          <div className="socialComposerHeading">
            <div>
              <p className="sectionLabel">Publish to community</p>
              <h2>发布到 {communityName}</h2>
            </div>
            <button
              aria-label="关闭发帖表单"
              className="smallGhostButton"
              onClick={() => setOpen(false)}
              type="button"
            >
              关闭
            </button>
          </div>

          <OwnerSocialIdentityField
            error={identities.error}
            identities={identities.identities}
            loginHref={loginHref}
            onReload={() => void identities.load()}
            onSelect={(value) => {
              invalidateAttempt();
              identities.setSelectedKey(value);
            }}
            selectedKey={identities.selectedKey}
            state={identities.state}
          />

          {identities.state === "ready" && identities.identities.length > 0 ? (
            <form
              aria-label="发布社区研究"
              className="socialComposerForm"
              onSubmit={submit}
            >
              <label className="socialComposerFull">
                <span>标题</span>
                <input
                  disabled={pending}
                  maxLength={200}
                  minLength={5}
                  onChange={(event) => {
                    invalidateAttempt();
                    setTitle(event.target.value);
                  }}
                  placeholder="清楚说明研究问题、发现或待验证判断"
                  required
                  value={title}
                />
              </label>
              <label className="socialComposerFull">
                <span>Markdown 正文</span>
                <textarea
                  disabled={pending}
                  maxLength={100_000}
                  onChange={(event) => {
                    invalidateAttempt();
                    setBodyMarkdown(event.target.value);
                  }}
                  placeholder="写下研究路径、依据、疑问、反方观点或需要独立验证的线索。"
                  required
                  rows={10}
                  value={bodyMarkdown}
                />
              </label>
              <label>
                <span>股票（逗号分隔）</span>
                <input
                  disabled={pending}
                  onChange={(event) => {
                    invalidateAttempt();
                    setSymbols(event.target.value.toUpperCase());
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
                    invalidateAttempt();
                    setTopics(event.target.value.toLowerCase());
                  }}
                  placeholder="semiconductors, supply-chain"
                  value={topics}
                />
              </label>
              <label className="socialComposerFull">
                <span>来源链接（每行一个 HTTPS URL）</span>
                <textarea
                  disabled={pending}
                  onChange={(event) => {
                    invalidateAttempt();
                    setSourceUrls(event.target.value);
                  }}
                  placeholder={
                    "https://investors.example.com/filing\nhttps://example.com/data"
                  }
                  rows={3}
                  value={sourceUrls}
                />
              </label>
              {error ? (
                <p className="formMessage error socialComposerFull" role="alert">
                  {error}
                </p>
              ) : null}
              {publishedContentId ? (
                <p className="formMessage success socialComposerFull" role="status">
                  发布成功。{" "}
                  <Link href={`/content/${encodeURIComponent(publishedContentId)}`}>
                    打开帖子
                  </Link>
                </p>
              ) : null}
              <div className="socialComposerActions socialComposerFull">
                <button className="submitButton" disabled={pending} type="submit">
                  {pending ? "正在发布…" : "发布到社区"}
                </button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
