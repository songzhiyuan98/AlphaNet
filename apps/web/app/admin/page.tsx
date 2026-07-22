import { notFound, redirect } from "next/navigation";

import { loadAdminWebConfig } from "../../lib/admin-web-config";

export default function AdminPage() {
  let config;
  try {
    config = loadAdminWebConfig();
  } catch {
    notFound();
  }
  if (!config.enabled) notFound();
  redirect("/admin/moderation");
}
