import type { ReactNode } from "react";

import styles from "../../components/admin/admin-moderation.module.css";

export const dynamic = "force-dynamic";

export default function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <div className={styles.adminSurface}>{children}</div>;
}
