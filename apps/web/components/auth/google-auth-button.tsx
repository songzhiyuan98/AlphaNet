"use client";

import { useState } from "react";

import { authClient, webCallbackUrl } from "../../lib/auth-client";
import { friendlyAuthError } from "../../lib/auth-errors";

export function GoogleAuthButton({ intent }: Readonly<{ intent: "login" | "register" }>) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function continueWithGoogle() {
    setError(null);
    setPending(true);

    try {
      const result = await authClient.signIn.social({
        callbackURL: webCallbackUrl("/home"),
        errorCallbackURL: webCallbackUrl("/auth/error"),
        provider: "google",
      });

      if (result.error) {
        setError(friendlyAuthError(result.error, "暂时无法连接 Google，请稍后再试。"));
        setPending(false);
      }
    } catch {
      setError("暂时无法连接 Google，请检查网络后重试。");
      setPending(false);
    }
  }

  return (
    <>
      <button
        className="googleButton"
        disabled={pending}
        onClick={continueWithGoogle}
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path
            d="M21.8 12.2c0-.7-.1-1.5-.2-2.2H12v4h5.5a4.7 4.7 0 0 1-2 3.1v2.6h3.3c1.9-1.8 3-4.4 3-7.5Z"
            fill="#4285F4"
          />
          <path
            d="M12 22c2.7 0 5-.9 6.8-2.3l-3.3-2.6c-.9.6-2.1 1-3.5 1a6 6 0 0 1-5.6-4.2H3v2.7A10.3 10.3 0 0 0 12 22Z"
            fill="#34A853"
          />
          <path
            d="M6.4 13.9A6.1 6.1 0 0 1 6.1 12c0-.7.1-1.3.3-1.9V7.4H3A10 10 0 0 0 2 12c0 1.6.4 3.1 1 4.6l3.4-2.7Z"
            fill="#FBBC05"
          />
          <path
            d="M12 5.9c1.5 0 2.8.5 3.9 1.5l2.9-2.9A9.8 9.8 0 0 0 12 2a10.3 10.3 0 0 0-9 5.4l3.4 2.7A6 6 0 0 1 12 5.9Z"
            fill="#EA4335"
          />
        </svg>
        {pending
          ? "正在连接 Google…"
          : intent === "register"
            ? "使用 Google 注册"
            : "使用 Google 登录"}
      </button>
      {error ? (
        <p className="formMessage error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
