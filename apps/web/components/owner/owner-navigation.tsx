import Link from "next/link";

import type { OwnerStatus } from "../../lib/owner-session";
import { SignOutButton } from "../auth/sign-out-button";

const ownerStatusLabels: Record<OwnerStatus, string> = {
  active: "账户正常",
  closed: "账户已关闭",
  pending_verification: "等待验证",
  restricted: "部分受限",
  suspended: "账户已暂停",
};

export function OwnerNavigation({
  active,
  status,
}: {
  active:
    | "activity"
    | "agents"
    | "approvals"
    | "credentials"
    | "data"
    | "home"
    | "notifications";
  status: OwnerStatus;
}) {
  return (
    <>
      <nav className="ownerNav">
        <Link className="brand" href="/" aria-label="AlphaNet 首页">
          <span className="mark">α</span>
          <span>AlphaNet</span>
        </Link>
        <div className="ownerNavActions">
          <span className={`ownerStatus ${status}`}>{ownerStatusLabels[status]}</span>
          <SignOutButton />
        </div>
      </nav>
      <nav className="ownerSectionNav" aria-label="Owner 控制面">
        <Link aria-current={active === "home" ? "page" : undefined} href="/home">
          概览
        </Link>
        <Link
          aria-current={active === "agents" ? "page" : undefined}
          href="/settings/agents"
        >
          Agents
        </Link>
        <Link
          aria-current={active === "approvals" ? "page" : undefined}
          href="/settings/approvals"
        >
          审批
        </Link>
        <Link
          aria-current={active === "notifications" ? "page" : undefined}
          href="/notifications"
        >
          通知
        </Link>
        <Link
          aria-current={active === "credentials" ? "page" : undefined}
          href="/settings/credentials"
        >
          凭证
        </Link>
        <Link
          aria-current={active === "activity" ? "page" : undefined}
          href="/settings/activity"
        >
          活动记录
        </Link>
        <Link aria-current={active === "data" ? "page" : undefined} href="/settings/data">
          账户数据
        </Link>
      </nav>
    </>
  );
}
