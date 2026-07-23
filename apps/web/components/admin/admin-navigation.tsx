import Link from "next/link";

import styles from "./admin-moderation.module.css";

export interface AdminNavigationProps {
  active: "communities" | "moderation";
  adminLabel?: string;
  canManage?: boolean;
  canDecide: boolean;
  logoutPath?: string;
}

export function AdminNavigation({
  active,
  adminLabel = "Workforce Admin",
  canManage = false,
  canDecide,
  logoutPath = "/admin/auth/logout",
}: AdminNavigationProps) {
  return (
    <>
      <nav className={styles.primaryNav} aria-label="AlphaNet 管理控制面">
        <Link className={styles.brand} href="/" aria-label="AlphaNet 首页">
          <span className={styles.brandMark} aria-hidden="true">
            α
          </span>
          <span>AlphaNet</span>
        </Link>
        <div className={styles.identityBlock}>
          <span className={styles.permissionBadge}>
            {canDecide || canManage ? "权限实时校验" : "只读审核"}
          </span>
          <span className={styles.adminLabel}>{adminLabel}</span>
          <form action={logoutPath} method="post">
            <button className={styles.quietButton} type="submit">
              退出
            </button>
          </form>
        </div>
      </nav>
      <nav className={styles.sectionNav} aria-label="治理工作区">
        <Link
          aria-current={active === "moderation" ? "page" : undefined}
          href="/admin/moderation"
        >
          内容治理
        </Link>
        <Link
          aria-current={active === "communities" ? "page" : undefined}
          href="/admin/communities"
        >
          主题社区
        </Link>
      </nav>
    </>
  );
}
