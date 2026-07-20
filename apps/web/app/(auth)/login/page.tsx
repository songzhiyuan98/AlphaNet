import type { Metadata } from "next";

import { LoginForm } from "../../../components/auth/login-form";
import { isGoogleAuthEnabled } from "../../../lib/web-auth-config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "登录 · AlphaNet",
};

type SearchValue = string | string[] | undefined;

function first(value: SearchValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeNextPath(value: SearchValue): string {
  const candidate = first(value);
  return candidate && new Set(["/home"]).has(candidate) ? candidate : "/home";
}

export default async function LoginPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, SearchValue>>;
}>) {
  const params = await searchParams;
  const notice =
    first(params.verified) === "1"
      ? "邮箱已验证，请登录。"
      : first(params.reset) === "1"
        ? "密码已更新，请使用新密码登录。"
        : undefined;

  return (
    <LoginForm
      googleAuthEnabled={isGoogleAuthEnabled()}
      nextPath={safeNextPath(params.next)}
      {...(notice ? { notice } : {})}
    />
  );
}
