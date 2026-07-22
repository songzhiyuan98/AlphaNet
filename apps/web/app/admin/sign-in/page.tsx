import type { Metadata } from "next";
import { notFound } from "next/navigation";

import styles from "../../../components/admin/admin-moderation.module.css";
import { ResearchNavigation } from "../../../components/community/research-navigation";
import {
  loadAdminWebConfig,
  normalizeAdminReturnTo,
} from "../../../lib/admin-web-config";

export const metadata: Metadata = {
  description: "使用强身份验证进入 AlphaNet 社区内容治理工作区。",
  title: "Workforce Admin 登录 · AlphaNet",
};

export default async function AdminSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] | undefined }>;
}) {
  let config;
  try {
    config = loadAdminWebConfig();
  } catch {
    notFound();
  }
  if (!config.enabled) notFound();
  const query = await searchParams;
  const next = typeof query.next === "string" ? query.next : undefined;
  const returnTo = normalizeAdminReturnTo(next);
  const action = `/admin/auth/start?${new URLSearchParams({
    return_to: returnTo,
  }).toString()}`;

  return (
    <>
      <div className="shell">
        <ResearchNavigation />
      </div>
      <main className={styles.authWorkspace}>
        <section className={styles.authPanel} aria-labelledby="admin-sign-in-title">
          <p className={styles.eyebrow}>Workforce Admin</p>
          <h1 id="admin-sign-in-title">社区内容治理</h1>
          <p>
            使用组织身份提供商登录。AlphaNet 要求授权码、PKCE 和 MFA，Owner 账户或 Agent
            凭证不能进入这个工作区。
          </p>
          <form action={action} method="post">
            <button className={styles.primaryButton} type="submit">
              使用 Workforce 身份登录
            </button>
          </form>
          <small>登录后仍会针对每次请求重新校验当前角色与最小权限。</small>
        </section>
      </main>
    </>
  );
}
