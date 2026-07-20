"use client";

import { V1ErrorResponseSchema } from "@alphanet/contracts";

export class OwnerApiError extends Error {
  readonly code: string;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;

  constructor(options: {
    code: string;
    message: string;
    requestId?: string | null;
    retryAfterMs?: number | null;
  }) {
    super(options.message);
    this.name = "OwnerApiError";
    this.code = options.code;
    this.requestId = options.requestId ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

function browserApiUrl(path: string): string {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!configured) {
    return path;
  }
  return `${configured.replace(/\/+$/, "")}${path}`;
}

export async function ownerApiRequest<T>(
  path: string,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(browserApiUrl(path), {
      ...init,
      credentials: "include",
      headers,
    });
  } catch {
    throw new OwnerApiError({
      code: "NETWORK_ERROR",
      message: "无法连接控制面，请检查网络后重试。",
    });
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = V1ErrorResponseSchema.safeParse(payload);
    if (parsed.success) {
      throw new OwnerApiError({
        code: parsed.data.error.code,
        message: parsed.data.error.message,
        requestId: parsed.data.request_id,
        retryAfterMs: parsed.data.error.retry_after_ms,
      });
    }
    throw new OwnerApiError({
      code: response.status === 401 ? "AUTHENTICATION_REQUIRED" : "API_ERROR",
      message: "请求未能完成，请稍后重试。",
    });
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new OwnerApiError({
      code: "INVALID_RESPONSE",
      message: "控制面返回了无法识别的数据，请刷新后重试。",
    });
  }
  return parsed.data;
}

const friendlyMessages: Record<string, string> = {
  AGENT_ACTIVE_QUOTA_EXCEEDED: "已达到可启用 Agent 数量上限。",
  AGENT_CREATE_RATE_LIMITED: "过去 24 小时创建 Agent 的次数已达上限。",
  AGENT_HANDLE_TAKEN: "这个 Handle 已被使用，请换一个。",
  AGENT_NOT_FOUND: "找不到这个 Agent，它可能已被移除。",
  AGENT_STATE_CONFLICT: "Agent 当前状态不允许执行此操作。",
  AUTHENTICATION_REQUIRED: "登录已过期，请重新登录。",
  CREDENTIAL_EXPIRY_INVALID: "有效期必须至少晚于当前时间 1 小时，且不能超过上限。",
  CREDENTIAL_ISSUE_RATE_LIMITED: "过去 24 小时签发凭证的次数已达上限。",
  CREDENTIAL_MUTATION_COOLDOWN: "凭证操作过于频繁，请稍后再试。",
  CREDENTIAL_NOT_FOUND: "找不到这个凭证。",
  CREDENTIAL_QUOTA_EXCEEDED: "已达到有效凭证数量上限。",
  CREDENTIAL_REVOKED: "这个凭证已经撤销。",
  CSRF_VALIDATION_FAILED: "请求来源校验失败，请从 AlphaNet 控制面重试。",
  NETWORK_ERROR: "无法连接控制面，请检查网络后重试。",
  OWNER_EMAIL_VERIFICATION_REQUIRED: "请先完成 Owner 邮箱验证。",
  OWNER_NOT_ACTIVE: "Owner 账户当前不能执行此操作。",
  PLATFORM_AGENT_CAPACITY_EXCEEDED: "平台容量暂时已满，请稍后重试。",
  TOKEN_EXPIRED: "这个凭证已经过期。",
  VALIDATION_FAILED: "提交内容不符合要求，请检查后重试。",
};

export function friendlyOwnerApiError(error: unknown): string {
  if (!(error instanceof OwnerApiError)) {
    return "操作未能完成，请稍后重试。";
  }

  const base = friendlyMessages[error.code] ?? error.message;
  if (error.retryAfterMs && error.retryAfterMs > 0) {
    const seconds = Math.max(1, Math.ceil(error.retryAfterMs / 1_000));
    return `${base} 约 ${seconds} 秒后可重试。`;
  }
  return base;
}
