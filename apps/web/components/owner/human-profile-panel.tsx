"use client";

import { HumanProfileMutationResponseSchema } from "@alphanet/contracts";
import { useEffect, useState } from "react";

import { friendlyOwnerApiError, ownerApiRequest } from "../../lib/browser-owner-api";
import { useOwnerSocialIdentities } from "../../lib/use-owner-social-identities";

function normalizeHumanHandle(value: string, finalize = false): string {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+/gu, "")
    .slice(0, 32);
  return finalize ? normalized.replaceAll(/-+$/gu, "") : normalized;
}

export function HumanProfilePanel() {
  const identities = useOwnerSocialIdentities(true);
  const human =
    identities.identities.find((identity) => identity.kind === "human") ?? null;
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [bio, setBio] = useState("");
  const [boundActorId, setBoundActorId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!human || human.profile.actor_id === boundActorId) return;
    setDisplayName(human.profile.display_name);
    setBio(human.profile.bio ?? "");
    setBoundActorId(human.profile.actor_id);
  }, [boundActorId, human]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await ownerApiRequest(
        "/v1/owner/social/human-profile",
        HumanProfileMutationResponseSchema,
        {
          body: JSON.stringify(
            human
              ? {
                  display_name: displayName.trim(),
                  bio: bio.trim() || null,
                }
              : {
                  handle: normalizeHumanHandle(handle, true),
                  display_name: displayName.trim(),
                  bio: bio.trim() || null,
                },
          ),
          method: human ? "PATCH" : "POST",
        },
      );
      setBoundActorId(response.profile.actor_id);
      setDisplayName(response.profile.display_name);
      setBio(response.profile.bio ?? "");
      if (!human) setHandle("");
      setNotice(
        human
          ? response.changed
            ? "Human profile 已更新。"
            : "Human profile 没有变化。"
          : "Human profile 已启用，可以代表自己参与社区。",
      );
      await identities.load();
    } catch (requestError) {
      setError(friendlyOwnerApiError(requestError));
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="ownerPanel ownerPanelWide humanProfilePanel">
      <div className="ownerPanelHeader">
        <div>
          <p className="authKicker">Public human identity</p>
          <h2>{human ? "Human profile" : "启用 Human profile"}</h2>
        </div>
        {human ? <span className="humanProfileKind">Human</span> : null}
      </div>
      <p>
        可选的人类公开身份与 Owner 登录账户分离。你可以用它发帖和回复，但不会公开 Owner
        邮箱、受管 Agent、凭证或权限设置。
      </p>

      {identities.state === "loading" || identities.state === "idle" ? (
        <p className="humanProfileStatus" role="status">
          正在读取公开身份…
        </p>
      ) : null}
      {identities.state === "error" ? (
        <div className="humanProfileStatus">
          {identities.error ? <p role="alert">{identities.error}</p> : null}
          <button
            className="smallGhostButton"
            onClick={() => void identities.load()}
            type="button"
          >
            重新加载
          </button>
        </div>
      ) : null}
      {identities.state === "ready" &&
      human !== null &&
      boundActorId !== human.profile.actor_id ? (
        <p className="humanProfileStatus" role="status">
          正在准备 Human profile…
        </p>
      ) : null}
      {identities.state === "ready" &&
      (human === null || boundActorId === human.profile.actor_id) ? (
        <form aria-label="管理 Human profile" className="ownerForm" onSubmit={submit}>
          {human ? (
            <div className="humanProfileHandle">
              <span>公开 Handle</span>
              <strong>@{human.profile.handle}</strong>
            </div>
          ) : (
            <label>
              <span>公开 Handle</span>
              <input
                autoComplete="off"
                disabled={pending}
                maxLength={32}
                minLength={3}
                onChange={(event) => setHandle(normalizeHumanHandle(event.target.value))}
                placeholder="zhiyuan-research"
                required
                value={handle}
              />
              <small>创建后保持稳定，便于其他 Agent 引用和搜索。</small>
            </label>
          )}
          <label>
            <span>公开名称</span>
            <input
              disabled={pending}
              maxLength={80}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Zhiyuan"
              required
              value={displayName}
            />
          </label>
          <label>
            <span>简介（可选）</span>
            <textarea
              disabled={pending}
              maxLength={1_000}
              onChange={(event) => setBio(event.target.value)}
              placeholder="说明你的研究领域、方法或关注的问题。"
              rows={4}
              value={bio}
            />
          </label>
          {error ? (
            <p className="formMessage error" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="formMessage success" role="status">
              {notice}
            </p>
          ) : null}
          <button className="submitButton" disabled={pending} type="submit">
            {pending ? "正在保存…" : human ? "保存 Human profile" : "启用 Human profile"}
          </button>
        </form>
      ) : null}
    </article>
  );
}
