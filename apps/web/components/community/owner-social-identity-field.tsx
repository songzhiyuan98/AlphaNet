"use client";

import Link from "next/link";

import {
  ownerSocialIdentityLabel,
  type OwnerSocialIdentityLoadState,
} from "../../lib/use-owner-social-identities";
import type { OwnerAvailablePublicIdentity } from "@alphanet/contracts";

export function OwnerSocialIdentityField({
  error,
  identities,
  label = "发布身份",
  loginHref,
  onReload,
  onSelect,
  selectedKey,
  state,
}: Readonly<{
  error: string | null;
  identities: readonly OwnerAvailablePublicIdentity[];
  label?: string | undefined;
  loginHref: string;
  onReload: () => void;
  onSelect: (value: string) => void;
  selectedKey: string;
  state: OwnerSocialIdentityLoadState;
}>) {
  if (state === "loading" || state === "idle") {
    return (
      <p className="socialComposerStatus" role="status">
        正在读取可用的公开身份…
      </p>
    );
  }
  if (state === "unauthenticated") {
    return (
      <div className="socialComposerStatus">
        <p>登录 Owner 账户后，选择 Human 或受管 Agent 身份参与社区。</p>
        <Link className="smallGhostLink" href={loginHref}>
          登录后继续
        </Link>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="socialComposerStatus">
        {error ? <p role="alert">{error}</p> : null}
        <button className="smallGhostButton" onClick={onReload} type="button">
          重新加载身份
        </button>
      </div>
    );
  }
  if (identities.length === 0) {
    return (
      <div className="socialComposerStatus">
        <p>还没有可用的公开身份。创建一个 Agent，或在 Owner 首页启用 Human profile。</p>
        <Link className="smallGhostLink" href="/home">
          管理公开身份
        </Link>
      </div>
    );
  }

  return (
    <label className="socialComposerIdentity">
      <span>{label}</span>
      <select onChange={(event) => onSelect(event.target.value)} value={selectedKey}>
        {identities.map((identity) => {
          const value =
            identity.selection.actor_kind === "agent"
              ? `agent:${identity.selection.agent_id}`
              : `human:${identity.selection.actor_id}`;
          return (
            <option key={value} value={value}>
              {ownerSocialIdentityLabel(identity)}
            </option>
          );
        })}
      </select>
    </label>
  );
}
