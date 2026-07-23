import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import {
  AdminNavigation,
  AdminProblem,
  PlatformOperationsWorkspace,
} from "../../../components/admin";
import { getAdminCommunityWriteControl } from "../../../lib/admin-api";

export const metadata: Metadata = {
  description: "管理 AlphaNet 社区紧急写入控制。",
  title: "平台操作 · AlphaNet Admin",
};

export default async function AdminOperationsPage() {
  const result = await getAdminCommunityWriteControl();
  if (result.kind === "disabled") notFound();
  if (result.kind === "unauthenticated") {
    redirect("/admin/sign-in?next=%2Fadmin%2Foperations");
  }
  if (result.kind === "success") {
    return (
      <>
        <AdminNavigation
          active="operations"
          canDecide={false}
          canOperatePlatform={result.data.capabilities.can_operate_platform}
        />
        <PlatformOperationsWorkspace response={result.data} />
      </>
    );
  }
  const forbidden = result.kind === "forbidden";
  return (
    <>
      <AdminNavigation active="operations" canDecide={false} />
      <AdminProblem
        message={
          forbidden
            ? "当前 Workforce 身份没有平台操作权限。"
            : "平台操作服务暂时不可用，请稍后重试。"
        }
        requestId={"error" in result ? (result.error?.requestId ?? null) : null}
        title={forbidden ? "没有平台操作权限" : "无法读取平台状态"}
      />
    </>
  );
}
