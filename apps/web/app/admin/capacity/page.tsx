import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import {
  AdminNavigation,
  AdminProblem,
  OwnerCapacityWorkspace,
} from "../../../components/admin";
import { getAdminRegistrationControl, listAdminOwners } from "../../../lib/admin-api";
import { parseAdminOwnerQuery } from "../../../lib/admin-owner-capacity-query";

export const metadata: Metadata = {
  description: "管理 AlphaNet Owner Agent 配额与平台注册容量。",
  title: "身份容量 · AlphaNet Admin",
};

export default async function AdminCapacityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const parsed = parseAdminOwnerQuery(await searchParams);
  if (!parsed.ok) {
    return (
      <>
        <AdminNavigation active="capacity" canDecide={false} />
        <AdminProblem
          actionLabel="清除筛选"
          message="筛选参数无效、重复或超出允许范围。Owner 请求尚未发送。"
          title="无法应用这些筛选条件"
        />
      </>
    );
  }
  const [owners, control] = await Promise.all([
    listAdminOwners(parsed.value),
    getAdminRegistrationControl(),
  ]);
  if (owners.kind === "disabled" || control.kind === "disabled") notFound();
  if (owners.kind === "unauthenticated" || control.kind === "unauthenticated") {
    redirect("/admin/sign-in?next=%2Fadmin%2Fcapacity");
  }
  if (owners.kind === "success" && control.kind === "success") {
    const canManage =
      owners.data.capabilities.can_manage_quota &&
      control.data.capabilities.can_manage_quota;
    return (
      <>
        <AdminNavigation
          active="capacity"
          canDecide={false}
          canManageCapacity={canManage}
        />
        <OwnerCapacityWorkspace
          control={control.data}
          filters={parsed.value}
          owners={owners.data}
        />
      </>
    );
  }
  const forbidden = owners.kind === "forbidden" || control.kind === "forbidden";
  const error =
    owners.kind !== "success" && "error" in owners
      ? owners.error
      : control.kind !== "success" && "error" in control
        ? control.error
        : null;
  return (
    <>
      <AdminNavigation active="capacity" canDecide={false} />
      <AdminProblem
        message={
          forbidden
            ? "当前 Workforce 身份没有身份容量管理权限。"
            : "身份容量服务暂时不可用，请稍后重试。"
        }
        requestId={error?.requestId ?? null}
        title={forbidden ? "没有身份容量权限" : "无法读取身份容量"}
      />
    </>
  );
}
