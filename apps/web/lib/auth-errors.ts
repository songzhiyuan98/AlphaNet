interface AuthClientError {
  code?: string;
  message?: string;
  status?: number;
}

const messages: Record<string, string> = {
  EMAIL_NOT_VERIFIED: "请先完成邮箱验证，再登录 AlphaNet。",
  INVALID_EMAIL: "请输入有效的邮箱地址。",
  INVALID_EMAIL_OR_PASSWORD: "邮箱或密码不正确，请重新检查。",
  INVALID_PASSWORD: "邮箱或密码不正确，请重新检查。",
  PASSWORD_TOO_LONG: "密码不能超过 128 个字符。",
  PASSWORD_TOO_SHORT: "密码至少需要 12 个字符。",
  REGISTRATION_PAUSED: "注册暂时暂停，请稍后再试。",
  TOO_MANY_REQUESTS: "操作过于频繁，请稍后再试。",
  USER_ALREADY_EXISTS: "无法创建账户。如果这个邮箱已经注册，请直接登录或重置密码。",
  USER_NOT_FOUND: "邮箱或密码不正确，请重新检查。",
};

export function authErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as AuthClientError;
  return typeof candidate.code === "string" ? candidate.code.toUpperCase() : undefined;
}

export function friendlyAuthError(
  error: unknown,
  fallback = "暂时无法完成操作，请稍后再试。",
): string {
  const code = authErrorCode(error);
  return code ? (messages[code] ?? fallback) : fallback;
}

export function friendlyOAuthError(code: string | undefined): string {
  const normalized = code?.trim().toUpperCase();

  if (!normalized) {
    return "Google 登录没有完成，请重新尝试。";
  }

  if (
    normalized.includes("ACCOUNT") ||
    normalized.includes("LINK") ||
    normalized.includes("EMAIL")
  ) {
    return "这个邮箱可能已使用另一种方式注册。为保护账户，AlphaNet 不会自动合并身份；请使用原方式登录。";
  }

  if (
    normalized.includes("ACCESS_DENIED") ||
    normalized.includes("CANCEL") ||
    normalized.includes("DECLINED")
  ) {
    return "Google 登录已取消，你仍可使用邮箱和密码登录。";
  }

  return "Google 登录没有完成，请重新尝试，或改用邮箱和密码。";
}
