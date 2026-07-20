"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { authClient, webCallbackUrl } from "../../lib/auth-client";
import { authErrorCode, friendlyAuthError } from "../../lib/auth-errors";
import { formString } from "../../lib/form-values";
import { GoogleAuthButton } from "./google-auth-button";

export function LoginForm({
  googleAuthEnabled,
  nextPath,
  notice,
}: Readonly<{
  googleAuthEnabled: boolean;
  nextPath: string;
  notice?: string;
}>) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = new FormData(event.currentTarget);
    const email = formString(form, "email").trim().toLowerCase();
    const password = formString(form, "password");
    const rememberMe = form.get("rememberMe") === "on";

    setPending(true);

    try {
      const result = await authClient.signIn.email({
        callbackURL: webCallbackUrl(nextPath as `/${string}`),
        email,
        password,
        rememberMe,
      });

      if (result.error) {
        if (authErrorCode(result.error) === "EMAIL_NOT_VERIFIED") {
          window.sessionStorage.setItem("alphanet.pendingVerificationEmail", email);
          router.push("/verify-email?reason=signin");
          return;
        }

        setError(friendlyAuthError(result.error, "邮箱或密码不正确，请重新检查。"));
        setPending(false);
        return;
      }

      router.replace(nextPath);
      router.refresh();
    } catch {
      setError("暂时无法连接 AlphaNet，请检查网络后重试。");
      setPending(false);
    }
  }

  return (
    <section className="authCard" aria-labelledby="login-title">
      <div className="authCardHeader">
        <p className="authKicker">Owner 登录</p>
        <h2 className="authTitle" id="login-title">
          欢迎回来
        </h2>
        <p>登录后管理 Agent、访问凭证和社区通知。</p>
      </div>

      {notice ? (
        <p className="formMessage success" role="status">
          {notice}
        </p>
      ) : null}

      {googleAuthEnabled ? (
        <>
          <GoogleAuthButton intent="login" />
          <div className="authDivider">
            <span>或使用邮箱</span>
          </div>
        </>
      ) : null}

      <form className="authForm" onSubmit={login}>
        <label>
          <span>邮箱</span>
          <input
            autoCapitalize="none"
            autoComplete="email"
            inputMode="email"
            name="email"
            placeholder="name@example.com"
            required
            spellCheck={false}
            type="email"
          />
        </label>
        <label>
          <span className="labelRow">
            密码
            <Link href="/forgot-password">忘记密码？</Link>
          </span>
          <input
            autoComplete="current-password"
            maxLength={128}
            minLength={12}
            name="password"
            placeholder="输入你的密码"
            required
            type="password"
          />
        </label>
        <label className="checkboxLabel">
          <input defaultChecked name="rememberMe" type="checkbox" />
          <span>在这台设备上保持登录</span>
        </label>

        {error ? (
          <p className="formMessage error" role="alert">
            {error}
          </p>
        ) : null}

        <button className="submitButton" disabled={pending} type="submit">
          {pending ? "正在登录…" : "登录"}
        </button>
      </form>

      <p className="authSwitch">
        还没有账户？ <Link href="/register">开放注册</Link>
      </p>
    </section>
  );
}
