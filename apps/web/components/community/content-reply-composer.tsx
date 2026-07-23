"use client";

import { ReplyToContentWriteResultSchema } from "@alphanet/contracts";
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
  return `owner-web-reply-${globalThis.crypto.randomUUID()}`;
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

export function ContentReplyComposer({
  contentId,
  loginHref,
  compact = false,
}: Readonly<{
  compact?: boolean | undefined;
  contentId: string;
  loginHref: string;
}>) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [bodyMarkdown, setBodyMarkdown] = useState("");
  const [sourceUrls, setSourceUrls] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyId, setReplyId] = useState<string | null>(null);
  const attemptKey = useRef<string | null>(null);
  const identities = useOwnerSocialIdentities(open);

  function invalidateAttempt(): void {
    attemptKey.current = null;
    setError(null);
    setReplyId(null);
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
    setReplyId(null);
    try {
      attemptKey.current ??= newIdempotencyKey();
      const sourceLinks = normalizedSources(sourceUrls);
      const response = await ownerApiRequest(
        `/v1/owner/social/content/${encodeURIComponent(contentId)}/replies`,
        ReplyToContentWriteResultSchema,
        {
          body: JSON.stringify({
            actor_selection: selected.selection,
            body_markdown: bodyMarkdown,
            ...(sourceLinks ? { source_links: sourceLinks } : {}),
            idempotency_key: attemptKey.current,
          }),
          method: "POST",
        },
      );
      if (response.status !== "succeeded" || response.result === null) {
        setError(response.error?.message ?? "回复未能发布，请检查内容后重试。");
        return;
      }
      setReplyId(response.result.content_id);
      setBodyMarkdown("");
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
    <div
      className={`socialReplyComposer${compact ? " socialReplyComposer--compact" : ""}`}
    >
      <button
        aria-expanded={open}
        className="smallGhostButton"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        回复
      </button>
      {open ? (
        <div className="socialComposerPanel">
          <div className="socialComposerHeading">
            <div>
              <p className="sectionLabel">Join discussion</p>
              <h2>回复这项内容</h2>
            </div>
            <button
              aria-label="关闭回复表单"
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
            label="回复身份"
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
              aria-label="发布讨论回复"
              className="socialComposerForm"
              onSubmit={submit}
            >
              <label className="socialComposerFull">
                <span>Markdown 回复</span>
                <textarea
                  disabled={pending}
                  maxLength={20_000}
                  onChange={(event) => {
                    invalidateAttempt();
                    setBodyMarkdown(event.target.value);
                  }}
                  placeholder="提出追问、反驳、补充来源，或说明需要进一步验证的地方。"
                  required
                  rows={compact ? 5 : 7}
                  value={bodyMarkdown}
                />
              </label>
              <label className="socialComposerFull">
                <span>来源链接（每行一个 HTTPS URL，可选）</span>
                <textarea
                  disabled={pending}
                  onChange={(event) => {
                    invalidateAttempt();
                    setSourceUrls(event.target.value);
                  }}
                  placeholder="https://example.com/source"
                  rows={2}
                  value={sourceUrls}
                />
              </label>
              {error ? (
                <p className="formMessage error socialComposerFull" role="alert">
                  {error}
                </p>
              ) : null}
              {replyId ? (
                <p className="formMessage success socialComposerFull" role="status">
                  回复成功。{" "}
                  <Link href={`/content/${encodeURIComponent(replyId)}`}>
                    打开这条回复
                  </Link>
                </p>
              ) : null}
              <div className="socialComposerActions socialComposerFull">
                <button className="submitButton" disabled={pending} type="submit">
                  {pending ? "正在回复…" : "发布回复"}
                </button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
