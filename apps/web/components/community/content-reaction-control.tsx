"use client";

import {
  SetReactionWriteResultSchema,
  type ReactionCounts,
  type ReactionType,
} from "@alphanet/contracts";
import { useRef, useState } from "react";

import { friendlyOwnerApiError, ownerApiRequest } from "../../lib/browser-owner-api";
import { useOwnerSocialIdentities } from "../../lib/use-owner-social-identities";
import { OwnerSocialIdentityField } from "./owner-social-identity-field";

const reactionOptions = [
  ["helpful", "Helpful"],
  ["agree", "Agree"],
  ["disagree", "Disagree"],
] as const satisfies readonly (readonly [ReactionType, string])[];

function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Secure browser randomness is unavailable.");
  }
  return `owner-web-reaction-${globalThis.crypto.randomUUID()}`;
}

interface ReactionAttempt {
  fingerprint: string;
  idempotencyKey: string;
}

export function ContentReactionControl({
  contentId,
  initialCounts,
  loginHref,
  compact = false,
}: Readonly<{
  compact?: boolean | undefined;
  contentId: string;
  initialCounts: ReactionCounts;
  loginHref: string;
}>) {
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState(initialCounts);
  const [viewerReactions, setViewerReactions] = useState<ReactionType[] | null>(null);
  const [pendingReaction, setPendingReaction] = useState<ReactionType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const attempt = useRef<ReactionAttempt | null>(null);
  const identities = useOwnerSocialIdentities(open);

  function resetIdentityState(): void {
    attempt.current = null;
    setViewerReactions(null);
    setError(null);
    setStatus(null);
  }

  async function setReaction(reaction: ReactionType): Promise<void> {
    const selected = identities.selectedIdentity;
    if (!selected) {
      setError("请选择一个可用的公开身份。");
      return;
    }
    const active = !(viewerReactions?.includes(reaction) ?? false);
    const identityKey =
      selected.selection.actor_kind === "agent"
        ? `agent:${selected.selection.agent_id}`
        : `human:${selected.selection.actor_id}`;
    const fingerprint = `${identityKey}:${reaction}:${active ? "add" : "remove"}`;
    if (attempt.current?.fingerprint !== fingerprint) {
      attempt.current = {
        fingerprint,
        idempotencyKey: newIdempotencyKey(),
      };
    }

    setPendingReaction(reaction);
    setError(null);
    setStatus(null);
    try {
      const response = await ownerApiRequest(
        `/v1/owner/social/content/${encodeURIComponent(contentId)}/reactions/${reaction}`,
        SetReactionWriteResultSchema,
        {
          body: JSON.stringify({
            actor_selection: selected.selection,
            active,
            idempotency_key: attempt.current.idempotencyKey,
          }),
          method: "PUT",
        },
      );
      if (response.status !== "succeeded" || response.result === null) {
        setError(response.error?.message ?? "Reaction 未能更新，请稍后重试。");
        return;
      }
      setCounts(response.result.reaction_counts);
      setViewerReactions(response.result.viewer_state.reactions);
      setStatus(`${active ? "已添加" : "已撤销"} ${reaction}.`);
      attempt.current = null;
    } catch (requestError) {
      setError(friendlyOwnerApiError(requestError));
    } finally {
      setPendingReaction(null);
    }
  }

  return (
    <div
      className={`contentReactionControl${
        compact ? " contentReactionControl--compact" : ""
      }`}
    >
      <button
        aria-expanded={open}
        className="smallGhostButton contentReactionTrigger"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        参与 Reaction
      </button>
      {open ? (
        <div className="contentReactionPanel">
          <OwnerSocialIdentityField
            disabled={pendingReaction !== null}
            error={identities.error}
            identities={identities.identities}
            label="互动身份"
            loginHref={loginHref}
            onReload={() => void identities.load()}
            onSelect={(value) => {
              identities.setSelectedKey(value);
              resetIdentityState();
            }}
            selectedKey={identities.selectedKey}
            state={identities.state}
          />
          {identities.state === "ready" && identities.identities.length > 0 ? (
            <>
              <div aria-label="选择社区 Reaction" className="contentReactionActions">
                {reactionOptions.map(([reaction, label]) => {
                  const active = viewerReactions?.includes(reaction) ?? false;
                  return (
                    <button
                      aria-pressed={active}
                      className={active ? "isActive" : undefined}
                      disabled={pendingReaction !== null}
                      key={reaction}
                      onClick={() => void setReaction(reaction)}
                      type="button"
                    >
                      <span>{active ? `撤销 ${label}` : `添加 ${label}`}</span>
                      <strong>{counts[reaction]}</strong>
                    </button>
                  );
                })}
              </div>
              {error ? (
                <p className="formMessage error" role="alert">
                  {error}
                </p>
              ) : null}
              {status ? (
                <p className="contentReactionStatus" role="status">
                  {status}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
