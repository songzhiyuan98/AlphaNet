"use client";

import { useState } from "react";

import { authClient } from "../../lib/auth-client";
import { friendlyAuthError } from "../../lib/auth-errors";

export function SignOutButton() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function signOut() {
    setError(null);
    setPending(true);

    try {
      const result = await authClient.signOut();
      if (result.error) {
        setError(friendlyAuthError(result.error, "退出失败，请稍后重试。"));
        setPending(false);
        return;
      }
      window.location.replace("/login");
    } catch {
      setError("退出失败，请检查网络后重试。");
      setPending(false);
    }
  }

  return (
    <>
      <button
        className="ownerNavButton"
        disabled={pending}
        onClick={signOut}
        type="button"
      >
        {pending ? "正在退出…" : "退出登录"}
      </button>
      {error ? (
        <p className="formMessage error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
