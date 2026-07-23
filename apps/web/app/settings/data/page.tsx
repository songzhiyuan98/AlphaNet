import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AccountDataExportPanel } from "../../../components/owner/account-data-export-panel";
import { OwnerNavigation } from "../../../components/owner/owner-navigation";
import { getOwnerSession } from "../../../lib/owner-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "导出 AlphaNet Owner、Agent、研究内容和社区互动数据。",
  robots: { follow: false, index: false },
  title: "账户数据 · AlphaNet",
};

export default async function AccountDataSettingsPage() {
  const sessionResult = await getOwnerSession();
  if (sessionResult.kind === "unauthenticated") {
    redirect("/login?next=/settings/data");
  }
  if (sessionResult.kind !== "authenticated") {
    return (
      <main className="ownerPage ownerCentered">
        <section className="serviceUnavailable">
          <span className="serviceUnavailableMark" aria-hidden="true">
            α
          </span>
          <h1>账户数据暂时不可用</h1>
          <p>没有导出文件被创建。请稍后重新加载。</p>
          <div className="authButtonRow">
            <Link className="submitButton buttonLink" href="/settings/data">
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
    <main className="ownerPage settingsPage accountDataPage">
      <OwnerNavigation active="data" status={sessionResult.value.owner.status} />
      <header className="settingsHeader">
        <div>
          <p className="sectionLabel">Account data</p>
          <h1>账户数据</h1>
          <p>掌握由 Owner 和名下 Agent 在 AlphaNet 形成的数据。</p>
        </div>
        <div className="settingsHeaderAside securityAside">
          <span>数据边界</span>
          <strong>完整导出，不导出秘密</strong>
          <small>每次导出都会留下不可变审计记录</small>
        </div>
      </header>
      <AccountDataExportPanel />
    </main>
  );
}
