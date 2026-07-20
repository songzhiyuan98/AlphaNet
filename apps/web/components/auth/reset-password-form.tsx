"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";

import { authClient } from "../../lib/auth-client";
import { friendlyAuthError } from "../../lib/auth-errors";
import { formString } from "../../lib/form-values";
import { consumeResetToken } from "../../lib/reset-token";

export function ResetPasswordForm() {
  const [error, setError] = useState<string | null>(null);
  const [fragmentRead, setFragmentRead] = useState(false);
  const [pending, setPending] = useState(false);
  const [reset, setReset] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    setToken(consumeResetToken(window.location, window.history));
    setFragmentRead(true);
  }, []);

  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!token) {
      setError("重置链接无效或已过期，请重新申请。");
      return;
    }

    const form = new FormData(event.currentTarget);
    const password = formString(form, "password");
    const confirmation = formString(form, "passwordConfirmation");

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
      const result = await authClient.resetPassword({
        newPassword: password,
        token,
      });

      if (result.error) {
        setError(friendlyAuthError(result.error, "重置链接无效或已过期，请重新申请。"));
        setPending(false);
        return;
      }

      setReset(true);
      setPending(false);
    } catch {
      setError("暂时无法重置密码，请检查网络后重试。");
      setPending(false);
    }
  }

  if (reset) {
    return (
      <section className="authCard compactCard" aria-labelledby="reset-done-title">
        <div className="successMark" aria-hidden="true">
          ✓
        </div>
        <div className="authCardHeader">
          <p className="authKicker">Password updated</p>
          <h2 className="authTitle" id="reset-done-title">
            密码已更新
          </h2>
          <p>所有旧会话已撤销。请使用新密码重新登录。</p>
        </div>
        <Link className="submitButton buttonLink" href="/login?reset=1">
          返回登录
        </Link>
      </section>
    );
  }

  if (!fragmentRead) {
    return (
      <section className="authCard compactCard" aria-busy="true">
        <div className="authCardHeader">
          <p className="authKicker">验证重置链接</p>
          <h2 className="authTitle">正在安全读取凭证…</h2>
        </div>
      </section>
    );
  }

  if (!token) {
    return (
      <section className="authCard compactCard" aria-labelledby="invalid-reset-title">
        <div className="authCardHeader">
          <p className="authKicker">链接无效</p>
          <h2 className="authTitle" id="invalid-reset-title">
            需要新的重置链接
          </h2>
          <p>这个链接缺少凭证或已经失效。请重新发送密码重置邮件。</p>
        </div>
        <Link className="submitButton buttonLink" href="/forgot-password">
          重新申请
        </Link>
      </section>
    );
  }

  return (
    <section className="authCard compactCard" aria-labelledby="reset-title">
      <div className="authCardHeader">
        <p className="authKicker">设置新密码</p>
        <h2 className="authTitle" id="reset-title">
          保护你的 Owner 账户
        </h2>
        <p>创建一个未在其他网站使用过的新密码。</p>
      </div>

      <form className="authForm" onSubmit={updatePassword}>
        <label>
          <span>新密码</span>
          <input
            autoComplete="new-password"
            maxLength={128}
            minLength={12}
            name="password"
            placeholder="至少 12 个字符"
            required
            type="password"
          />
        </label>
        <label>
          <span>确认新密码</span>
          <input
            autoComplete="new-password"
            maxLength={128}
            minLength={12}
            name="passwordConfirmation"
            placeholder="再次输入新密码"
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
          {pending ? "正在更新…" : "更新密码"}
        </button>
      </form>
    </section>
  );
}
