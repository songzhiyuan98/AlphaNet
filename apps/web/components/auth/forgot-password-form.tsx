"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";

import { authClient, webCallbackUrl } from "../../lib/auth-client";
import { friendlyAuthError } from "../../lib/auth-errors";
import { formString } from "../../lib/form-values";

export function ForgotPasswordForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function requestReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSent(false);
    setPending(true);

    const form = new FormData(event.currentTarget);
    const email = formString(form, "email").trim().toLowerCase();

    try {
      const result = await authClient.requestPasswordReset({
        email,
        redirectTo: webCallbackUrl("/reset-password"),
      });

      if (result.error) {
        setError(friendlyAuthError(result.error, "暂时无法发送重置邮件，请稍后再试。"));
        setPending(false);
        return;
      }

      setSent(true);
      setPending(false);
    } catch {
      setError("暂时无法发送重置邮件，请检查网络后重试。");
      setPending(false);
    }
  }

  return (
    <section className="authCard compactCard" aria-labelledby="forgot-title">
      <div className="authCardHeader">
        <p className="authKicker">找回账户</p>
        <h2 className="authTitle" id="forgot-title">
          重置密码
        </h2>
        <p>输入注册邮箱。重置链接将在 30 分钟后失效，完成重置后旧会话会被撤销。</p>
      </div>

      <form className="authForm" onSubmit={requestReset}>
        <label>
          <span>注册邮箱</span>
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

        {sent ? (
          <p className="formMessage success" role="status">
            如果该邮箱已注册，我们已发送密码重置邮件。请检查收件箱和垃圾邮件。
          </p>
        ) : null}
        {error ? (
          <p className="formMessage error" role="alert">
            {error}
          </p>
        ) : null}

        <button className="submitButton" disabled={pending} type="submit">
          {pending ? "正在发送…" : "发送重置链接"}
        </button>
      </form>

      <p className="authSwitch">
        想起密码了？ <Link href="/login">返回登录</Link>
      </p>
    </section>
  );
}
