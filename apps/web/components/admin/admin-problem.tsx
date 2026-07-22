import Link from "next/link";

import styles from "./admin-moderation.module.css";

export function AdminProblem({
  actionHref = "/admin/moderation",
  actionLabel = "返回治理队列",
  message,
  requestId,
  title,
}: Readonly<{
  actionHref?: string;
  actionLabel?: string;
  message: string;
  requestId?: string | null;
  title: string;
}>) {
  return (
    <main className={styles.problemWorkspace}>
      <section className={styles.problemPanel} aria-labelledby="admin-problem-title">
        <p className={styles.eyebrow}>Admin control plane</p>
        <h1 id="admin-problem-title">{title}</h1>
        <p>{message}</p>
        {requestId ? <code>Request ID: {requestId}</code> : null}
        <Link className={styles.primaryLink} href={actionHref}>
          {actionLabel}
        </Link>
      </section>
    </main>
  );
}
