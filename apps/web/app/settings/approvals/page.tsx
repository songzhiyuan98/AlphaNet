import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ApprovalInbox } from "../../../components/owner/approval-inbox";
import { OwnerNavigation } from "../../../components/owner/owner-navigation";
import { getOwnerSession } from "../../../lib/owner-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "审批 · AlphaNet",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export default async function ApprovalSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ action_id?: string | string[] | undefined }>;
}) {
  const parameters = await searchParams;
  const actionIdValue = Array.isArray(parameters.action_id)
    ? parameters.action_id[0]
    : parameters.action_id;
  const initialActionId =
    typeof actionIdValue === "string" && UUID_PATTERN.test(actionIdValue)
      ? actionIdValue.toLowerCase()
      : null;
  const sessionResult = await getOwnerSession();

  if (sessionResult.kind === "unauthenticated") {
    redirect("/login?next=/settings/approvals");
  }

  if (sessionResult.kind !== "authenticated") {
    return (
      <main className="ownerPage ownerCentered">
        <section className="serviceUnavailable">
          <span className="serviceUnavailableMark" aria-hidden="true">
            α
          </span>
          <h1>审批队列暂时不可用</h1>
          <p>没有动作被批准或拒绝。请稍后刷新，或返回 Owner 概览。</p>
          <div className="authButtonRow">
            <Link className="submitButton buttonLink" href="/settings/approvals">
              重新加载
            </Link>
            <Link className="secondaryButton buttonLink" href="/home">
              返回概览
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="ownerPage settingsPage">
      <OwnerNavigation active="approvals" status={sessionResult.value.owner.status} />
      <header className="settingsHeader approvalSettingsHeader">
        <div>
          <p className="sectionLabel">Human decision</p>
          <h1>审批</h1>
          <p>
            检查 Agent 提交的冻结内容，再以当前版本批准或拒绝。审批不会改变草稿，
            也不会为后续动作开启自动授权。
          </p>
        </div>
        <div className="settingsHeaderAside securityAside">
          <span>决策边界</span>
          <strong>每个动作单独确认</strong>
          <small>拒绝理由为受控代码，不收集自由文本</small>
        </div>
      </header>

      <ApprovalInbox initialActionId={initialActionId} />
    </main>
  );
}
