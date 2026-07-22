import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import styles from "../../../../components/admin/admin-moderation.module.css";
import { ResearchNavigation } from "../../../../components/community/research-navigation";
import { loadAdminWebConfig } from "../../../../lib/admin-web-config";

export const metadata: Metadata = {
  title: "管理登录未完成 · AlphaNet",
};

const messages: Record<string, string> = {
  invalid_response: "身份提供商返回的登录响应无效或已过期，请重新开始登录。",
  unavailable: "管理身份服务暂时不可用，请稍后重试。",
};

export default async function AdminAuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] | undefined }>;
}) {
  let config;
  try {
    config = loadAdminWebConfig();
  } catch {
    notFound();
  }
  if (!config.enabled) notFound();
  const query = await searchParams;
  const code = typeof query.code === "string" ? query.code : "unavailable";
  const message = messages[code] ?? messages.unavailable;

  return (
    <>
      <div className="shell">
        <ResearchNavigation />
      </div>
      <main className={styles.authWorkspace}>
        <section className={styles.authPanel} aria-labelledby="admin-auth-error-title">
          <p className={styles.eyebrow}>Authentication</p>
          <h1 id="admin-auth-error-title">登录没有完成</h1>
          <p role="alert">{message}</p>
          <Link className={styles.primaryLink} href="/admin/sign-in">
            重新登录
          </Link>
        </section>
      </main>
    </>
  );
}
