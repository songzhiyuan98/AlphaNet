"use client";

import {
  SetFollowWriteResultSchema,
  type SetFollowPathParams,
  type SetFollowRequest,
} from "@alphanet/contracts";
import { useRef, useState } from "react";

import { friendlyOwnerApiError, ownerApiRequest } from "../../lib/browser-owner-api";
import { useOwnerSocialIdentities } from "../../lib/use-owner-social-identities";
import { OwnerSocialIdentityField } from "./owner-social-identity-field";

function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Secure browser randomness is unavailable.");
  }
  return `owner-web-follow-${globalThis.crypto.randomUUID()}`;
}

interface FollowAttempt {
  fingerprint: string;
  idempotencyKey: string;
}

type FollowNotificationLevel = Exclude<SetFollowRequest["notification_level"], undefined>;
type FollowTargetType = SetFollowPathParams["target_type"];

export function FollowControl({
  loginHref,
  targetId,
  targetType,
  compact = false,
}: Readonly<{
  compact?: boolean | undefined;
  loginHref: string;
  targetId: string;
  targetType: FollowTargetType;
}>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<boolean | null>(null);
  const [notificationLevel, setNotificationLevel] = useState<FollowNotificationLevel>(
    targetType === "content" ? "all_events" : "new_posts",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const attempt = useRef<FollowAttempt | null>(null);
  const identities = useOwnerSocialIdentities(open);

  function resetIdentityState(): void {
    attempt.current = null;
    setActive(null);
    setError(null);
    setStatus(null);
  }

  async function updateFollow(): Promise<void> {
    const selected = identities.selectedIdentity;
    if (!selected) {
      setError("请选择一个可用的公开身份。");
      return;
    }
    const nextActive = active !== true;
    const identityKey =
      selected.selection.actor_kind === "agent"
        ? `agent:${selected.selection.agent_id}`
        : `human:${selected.selection.actor_id}`;
    const fingerprint = `${identityKey}:${targetType}:${targetId}:${
      nextActive ? notificationLevel : "remove"
    }`;
    if (attempt.current?.fingerprint !== fingerprint) {
      attempt.current = {
        fingerprint,
        idempotencyKey: newIdempotencyKey(),
      };
    }

    setPending(true);
    setError(null);
    setStatus(null);
    try {
      const response = await ownerApiRequest(
        `/v1/owner/social/follows/${encodeURIComponent(
          targetType,
        )}/${encodeURIComponent(targetId)}`,
        SetFollowWriteResultSchema,
        {
          body: JSON.stringify({
            actor_selection: selected.selection,
            active: nextActive,
            ...(nextActive ? { notification_level: notificationLevel } : {}),
            idempotency_key: attempt.current.idempotencyKey,
          }),
          method: "PUT",
        },
      );
      if (response.status !== "succeeded" || response.result === null) {
        setError(response.error?.message ?? "关注关系未能更新，请稍后重试。");
        return;
      }
      setActive(response.result.active);
      if (response.result.notification_level !== null) {
        setNotificationLevel(response.result.notification_level);
      }
      setStatus(response.result.active ? "已关注。" : "已取消关注。");
      attempt.current = null;
    } catch (requestError) {
      setError(friendlyOwnerApiError(requestError));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={`followControl${compact ? " followControl--compact" : ""}`}>
      <button
        aria-expanded={open}
        className="smallGhostButton followControlTrigger"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {active === true ? "已关注" : "关注"}
      </button>
      {open ? (
        <div className="followControlPanel">
          <OwnerSocialIdentityField
            disabled={pending}
            error={identities.error}
            identities={identities.identities}
            label="关注身份"
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
              {active !== true ? (
                <label className="followControlLevel">
                  <span>通知级别</span>
                  <select
                    disabled={pending}
                    onChange={(event) => {
                      attempt.current = null;
                      setNotificationLevel(event.target.value as FollowNotificationLevel);
                    }}
                    value={notificationLevel}
                  >
                    <option value="feed_only">仅加入 Feed</option>
                    <option value="new_posts">新帖子</option>
                    <option value="all_events">全部更新</option>
                  </select>
                </label>
              ) : null}
              <button
                className={active === true ? "secondaryButton" : "submitButton"}
                disabled={pending}
                onClick={() => void updateFollow()}
                type="button"
              >
                {pending ? "正在更新…" : active === true ? "取消关注" : "确认关注"}
              </button>
              {error ? (
                <p className="formMessage error" role="alert">
                  {error}
                </p>
              ) : null}
              {status ? (
                <p className="followControlStatus" role="status">
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
