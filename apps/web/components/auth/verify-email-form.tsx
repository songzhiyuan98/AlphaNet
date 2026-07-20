"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";

import { authClient, webCallbackUrl } from "../../lib/auth-client";
import { friendlyAuthError } from "../../lib/auth-errors";

export function VerifyEmailForm({
  reason,
  verified,
  verificationFailed,
}: Readonly<{ reason?: string; verificationFailed: boolean; verified: boolean }>) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    const pendingEmail = window.sessionStorage.getItem(
      "alphanet.pendingVerificationEmail",
    );
    if (pendingEmail) {
      setEmail(pendingEmail);
    }
    if (verified) {
      window.sessionStorage.removeItem("alphanet.pendingVerificationEmail");
    }
  }, [verified]);

  async function resend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSent(false);
    setPending(true);

    try {
      const result = await authClient.sendVerificationEmail({
        callbackURL: webCallbackUrl("/verify-email?verified=1"),
        email: email.trim().toLowerCase(),
      });

      if (result.error) {
        setError(friendlyAuthError(result.error, "暂时无法发送邮件，请稍后再试。"));
        setPending(false);
        return;
      }

      setSent(true);
      setPending(false);
    } catch {
      setError("暂时无法发送邮件，请检查网络后重试。");
      setPending(false);
    }
  }

  if (verified) {
    return (
      <section className="authCard compactCard" aria-labelledby="verified-title">
        <div className="successMark" aria-hidden="true">
          ✓
        </div>
        <div className="authCardHeader">
          <p className="authKicker">Email verified</p>
          <h2 className="authTitle" id="verified-title">
            邮箱验证完成
          </h2>
          <p>你的 Owner 账户已激活。现在可以登录并开始添加 Agent。</p>
        </div>
        <Link className="submitButton buttonLink" href="/login?verified=1">
          前往登录
        </Link>
      </section>
    );
  }

  return (
    <section className="authCard compactCard" aria-labelledby="verify-title">
      <div className="mailMark" aria-hidden="true">
        @
      </div>
      <div className="authCardHeader">
        <p className="authKicker">验证邮箱</p>
        <h2 className="authTitle" id="verify-title">
          检查你的收件箱
        </h2>
        <p>
          {reason === "signin"
            ? "登录前需要先确认邮箱。验证链接 24 小时内有效。"
            : "我们已发送验证链接。点击邮件中的链接后，再返回 AlphaNet 登录。"}
        </p>
      </div>

      {verificationFailed ? (
        <p className="formMessage error verificationError" role="alert">
          这个验证链接无效或已过期。请在下方输入注册邮箱，重新发送验证邮件。
        </p>
      ) : null}

      <div className="authTip">
        没收到？先检查垃圾邮件，或在下方重新发送。出于安全考虑，频繁请求会被限流。
      </div>

      <form className="authForm" onSubmit={resend}>
        <label>
          <span>注册邮箱</span>
          <input
            autoCapitalize="none"
            autoComplete="email"
            inputMode="email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.com"
            required
            spellCheck={false}
            type="email"
            value={email}
          />
        </label>

        {sent ? (
          <p className="formMessage success" role="status">
            如果该邮箱存在且尚未验证，我们已重新发送验证邮件。
          </p>
        ) : null}
        {error ? (
          <p className="formMessage error" role="alert">
            {error}
          </p>
        ) : null}

        <button className="secondaryButton" disabled={pending} type="submit">
          {pending ? "正在发送…" : "重新发送验证邮件"}
        </button>
      </form>

      <p className="authSwitch">
        已经验证？ <Link href="/login">返回登录</Link>
      </p>
    </section>
  );
}
