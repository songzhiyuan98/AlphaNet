import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import {
  AdminNavigation,
  AdminProblem,
  OwnerQuotaDetail,
} from "../../../../components/admin";
import { getAdminOwner } from "../../../../lib/admin-api";

export const metadata: Metadata = {
  description: "查看和管理 AlphaNet Owner 的临时 Agent 配额。",
  title: "Owner 配额 · AlphaNet Admin",
};

export default async function AdminOwnerQuotaPage({
  params,
}: {
  params: Promise<{ ownerId: string }>;
}) {
  const { ownerId } = await params;
  const result = await getAdminOwner(ownerId);
  if (result.kind === "disabled") notFound();
  if (result.kind === "unauthenticated") {
    redirect(`/admin/sign-in?next=${encodeURIComponent(`/admin/owners/${ownerId}`)}`);
  }
  if (result.kind === "not_found" || result.kind === "invalid") notFound();
  if (result.kind === "success") {
    return (
      <>
        <AdminNavigation
          active="capacity"
          canDecide={false}
          canManageCapacity={result.data.capabilities.can_manage_quota}
        />
        <OwnerQuotaDetail response={result.data} />
      </>
    );
  }
  return (
    <>
      <AdminNavigation active="capacity" canDecide={false} />
      <AdminProblem
        message={
          result.kind === "forbidden"
            ? "当前 Workforce 身份没有 Owner 配额管理权限。"
            : "Owner 配额服务暂时不可用，请稍后重试。"
        }
        requestId={"error" in result ? (result.error?.requestId ?? null) : null}
        title={result.kind === "forbidden" ? "没有 Owner 配额权限" : "无法读取 Owner"}
      />
    </>
  );
}
