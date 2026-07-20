import { createHash, createHmac } from "node:crypto";

import type { Redis } from "ioredis";

export type AuthEmailPurpose = "password_reset" | "verification";

export interface AuthEmail {
  actionUrl: string;
  purpose: AuthEmailPurpose;
  recipient: string;
}

export interface AuthEmailSender {
  send(message: AuthEmail): Promise<void>;
}

export interface AuthEmailLogger {
  error(message: string, context?: Record<string, unknown>): void;
  info?(message: string, context?: Record<string, unknown>): void;
}

export interface ResendEmailSenderOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  from: string;
  replyTo?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function emailCopy(message: AuthEmail): {
  html: string;
  subject: string;
  text: string;
} {
  const safeUrl = escapeHtml(message.actionUrl);

  if (message.purpose === "verification") {
    return {
      subject: "Verify your AlphaNet email / 验证 AlphaNet 邮箱",
      text: [
        "Verify your email to finish creating your AlphaNet Owner account:",
        message.actionUrl,
        "",
        "请验证邮箱以完成 AlphaNet Owner 账户注册：",
        message.actionUrl,
        "",
        "If you did not request this, you can ignore this message.",
      ].join("\n"),
      html: `<p>Verify your email to finish creating your AlphaNet Owner account.</p><p><a href="${safeUrl}">Verify email</a></p><p>请验证邮箱以完成 AlphaNet Owner 账户注册。</p><p><a href="${safeUrl}">验证邮箱</a></p><p>If you did not request this, you can ignore this message.</p>`,
    };
  }

  return {
    subject: "Reset your AlphaNet password / 重置 AlphaNet 密码",
    text: [
      "Use this link to reset your AlphaNet password:",
      message.actionUrl,
      "",
      "请使用以下链接重置 AlphaNet 密码：",
      message.actionUrl,
      "",
      "If you did not request this, you can ignore this message.",
    ].join("\n"),
    html: `<p>Use this link to reset your AlphaNet password.</p><p><a href="${safeUrl}">Reset password</a></p><p>请使用以下链接重置 AlphaNet 密码。</p><p><a href="${safeUrl}">重置密码</a></p><p>If you did not request this, you can ignore this message.</p>`,
  };
}

export class ResendEmailSender implements AuthEmailSender {
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(private readonly options: ResendEmailSenderOptions) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async send(message: AuthEmail): Promise<void> {
    const copy = emailCopy(message);
    const idempotencyKey = createHash("sha256")
      .update(`alphanet:${message.purpose}:${message.recipient}:${message.actionUrl}`)
      .digest("hex");
    const response = await this.fetchImplementation("https://api.resend.com/emails", {
      body: JSON.stringify({
        from: this.options.from,
        html: copy.html,
        ...(this.options.replyTo ? { reply_to: this.options.replyTo } : {}),
        subject: copy.subject,
        text: copy.text,
        to: [message.recipient],
      }),
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      throw new Error(`Transactional email provider returned HTTP ${response.status}`);
    }
  }
}

export class LocalPreviewEmailSender implements AuthEmailSender {
  constructor(
    private readonly logger: AuthEmailLogger,
    private readonly allowedBaseUrl: string,
  ) {
    const hostname = new URL(allowedBaseUrl).hostname;
    if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") {
      throw new Error("Local email preview is only allowed on a loopback base URL");
    }
  }

  send(message: AuthEmail): Promise<void> {
    this.logger.info?.("Local auth email preview", {
      actionUrl: message.actionUrl,
      purpose: message.purpose,
      recipient: message.recipient,
    });
    return Promise.resolve();
  }
}

export interface EmailDeliveryGuardOptions {
  cooldownSeconds?: number;
  dailyGlobalLimit?: number;
  hourlyRecipientLimit?: number;
  keySecret: string;
  logger?: AuthEmailLogger;
  redis: Redis;
}

const reserveDeliveryScript = `
local cooldown_key = KEYS[1]
local recipient_key = KEYS[2]
local global_key = KEYS[3]
local cooldown_seconds = tonumber(ARGV[1])
local recipient_limit = tonumber(ARGV[2])
local global_limit = tonumber(ARGV[3])

if redis.call("EXISTS", cooldown_key) == 1 then
  return 0
end

local recipient_count = tonumber(redis.call("GET", recipient_key) or "0")
local global_count = tonumber(redis.call("GET", global_key) or "0")
if recipient_count >= recipient_limit or global_count >= global_limit then
  return 0
end

redis.call("SET", cooldown_key, "1", "EX", cooldown_seconds)
recipient_count = redis.call("INCR", recipient_key)
if recipient_count == 1 then
  redis.call("EXPIRE", recipient_key, 3600)
end
global_count = redis.call("INCR", global_key)
if global_count == 1 then
  redis.call("EXPIRE", global_key, 86400)
end
return 1
`;

export class GuardedAuthEmailSender implements AuthEmailSender {
  private readonly cooldownSeconds: number;
  private readonly dailyGlobalLimit: number;
  private readonly hourlyRecipientLimit: number;

  constructor(
    private readonly sender: AuthEmailSender,
    private readonly options: EmailDeliveryGuardOptions,
  ) {
    this.cooldownSeconds = options.cooldownSeconds ?? 60;
    this.dailyGlobalLimit = options.dailyGlobalLimit ?? 10_000;
    this.hourlyRecipientLimit = options.hourlyRecipientLimit ?? 3;
  }

  async send(message: AuthEmail): Promise<void> {
    const recipientDigest = createHmac("sha256", this.options.keySecret)
      .update(message.recipient.trim().toLowerCase())
      .digest("hex");
    const prefix = `alphanet:auth-email:${message.purpose}`;
    const allowed = await this.options.redis.eval(
      reserveDeliveryScript,
      3,
      `${prefix}:cooldown:${recipientDigest}`,
      `${prefix}:recipient-hour:${recipientDigest}`,
      "alphanet:auth-email:global-day",
      this.cooldownSeconds,
      this.hourlyRecipientLimit,
      this.dailyGlobalLimit,
    );

    if (allowed !== 1) {
      this.options.logger?.info?.("Auth email delivery suppressed", {
        purpose: message.purpose,
      });
      return;
    }

    await this.sender.send(message);
  }
}

export class BackgroundTaskSupervisor {
  private readonly tasks = new Set<Promise<void>>();

  constructor(private readonly logger: AuthEmailLogger) {}

  schedule(task: Promise<void>, operation: string): void {
    const tracked = task
      .catch((error: unknown) => {
        this.logger.error("Auth background task failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
          operation,
        });
      })
      .finally(() => {
        this.tasks.delete(tracked);
      });
    this.tasks.add(tracked);
  }

  async drain(timeoutMilliseconds = 5_000): Promise<void> {
    if (this.tasks.size === 0) {
      return;
    }

    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.tasks]),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMilliseconds);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}

export function assertTrustedActionUrl(actionUrl: string, authBaseUrl: string): void {
  const action = new URL(actionUrl);
  const base = new URL(authBaseUrl);
  if (action.origin !== base.origin || !action.pathname.startsWith("/api/auth/")) {
    throw new Error("Auth email action URL is outside the canonical auth origin");
  }
}
