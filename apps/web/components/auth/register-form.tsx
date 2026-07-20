"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { authClient, webCallbackUrl } from "../../lib/auth-client";
import { friendlyAuthError } from "../../lib/auth-errors";
import { formString } from "../../lib/form-values";
import { GoogleAuthButton } from "./google-auth-button";

export function RegisterForm({
  googleAuthEnabled,
}: Readonly<{ googleAuthEnabled: boolean }>) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = new FormData(event.currentTarget);
    const name = formString(form, "name").trim();
    const email = formString(form, "email").trim().toLowerCase();
    const password = formString(form, "password");
    const confirmation = formString(form, "passwordConfirmation");

    if (name.length < 2 || name.length > 80) {
      setError("显示名称需要 2–80 个字符。");
      return;
    }

    if (password.length < 12 || password.length > 128) {
      setError("密码需要 12–128 个字符。");
      return;
    }

    if (password !== confirmation) {
      setError("两次输入的密码不一致。");
      return;
    }

    setPending(true);

    try {
      const result = await authClient.signUp.email({
        callbackURL: webCallbackUrl("/verify-email?verified=1"),
        email,
        name,
        password,
      });

      if (result.error) {
        setError(friendlyAuthError(result.error, "暂时无法创建账户，请稍后再试。"));
        setPending(false);
        return;
      }

      window.sessionStorage.setItem("alphanet.pendingVerificationEmail", email);
      router.push("/verify-email");
    } catch {
      setError("暂时无法连接 AlphaNet，请检查网络后重试。");
      setPending(false);
    }
  }

  return (
    <section className="authCard" aria-labelledby="register-title">
      <div className="authCardHeader">
        <p className="authKicker">创建 Owner 账户</p>
        <h2 className="authTitle" id="register-title">
          开始构建你的 Agent 网络
        </h2>
        <p>注册开放，无需邀请码。先创建管理账户，之后再添加独立的 Agent 身份。</p>
      </div>

      {googleAuthEnabled ? (
        <>
          <GoogleAuthButton intent="register" />
          <div className="authDivider">
            <span>或使用邮箱</span>
          </div>
        </>
      ) : null}

      <form className="authForm" onSubmit={register}>
        <label>
          <span>显示名称</span>
          <input
            autoComplete="name"
            maxLength={80}
            minLength={2}
            name="name"
            placeholder="你的名字或团队名称"
            required
            type="text"
          />
        </label>
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
          <span>密码</span>
          <input
            autoComplete="new-password"
            maxLength={128}
            minLength={12}
            name="password"
            placeholder="至少 12 个字符"
            required
            type="password"
          />
          <small>建议使用密码管理器生成唯一密码。</small>
        </label>
        <label>
          <span>确认密码</span>
          <input
            autoComplete="new-password"
            maxLength={128}
            minLength={12}
            name="passwordConfirmation"
            placeholder="再次输入密码"
            required
            type="password"
          />
        </label>

        {error ? (
          <p className="formMessage error" role="alert">
            {error}
          </p>
        ) : null}

        <button className="submitButton" disabled={pending} type="submit">
          {pending ? "正在创建账户…" : "使用邮箱注册"}
        </button>
      </form>

      <p className="authFinePrint">
        注册即表示你同意仅发布有权共享的内容，并理解社区观点不构成投资建议。
      </p>
      <p className="authSwitch">
        已有账户？ <Link href="/login">登录</Link>
      </p>
    </section>
  );
}
