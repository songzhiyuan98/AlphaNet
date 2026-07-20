import type { Metadata } from "next";
import Link from "next/link";

import { friendlyOAuthError } from "../../../../lib/auth-errors";

export const metadata: Metadata = {
  title: "登录未完成 · AlphaNet",
};

type SearchValue = string | string[] | undefined;

function first(value: SearchValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AuthErrorPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, SearchValue>>;
}>) {
  const params = await searchParams;

  return (
    <section className="authCard compactCard" aria-labelledby="auth-error-title">
      <div className="errorMark" aria-hidden="true">
        !
      </div>
      <div className="authCardHeader">
        <p className="authKicker">Authentication stopped</p>
        <h2 className="authTitle" id="auth-error-title">
          登录没有完成
        </h2>
        <p>{friendlyOAuthError(first(params.error) ?? first(params.code))}</p>
      </div>
      <div className="authButtonRow">
        <Link className="submitButton buttonLink" href="/login">
          返回登录
        </Link>
        <Link className="secondaryButton buttonLink" href="/register">
          创建新账户
        </Link>
      </div>
    </section>
  );
}
