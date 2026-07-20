import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";

import {
  assertTrustedActionUrl,
  BackgroundTaskSupervisor,
  GuardedAuthEmailSender,
  LocalPreviewEmailSender,
  ResendEmailSender,
  type AuthEmail,
  type AuthEmailLogger,
} from "./email.js";

const verificationEmail: AuthEmail = {
  actionUrl:
    "https://api.alphanet.test/api/auth/verify-email?token=opaque-verification-token",
  purpose: "verification",
  recipient: "owner@example.test",
};

function createLogger(): {
  errors: Array<{ context?: Record<string, unknown>; message: string }>;
  infos: Array<{ context?: Record<string, unknown>; message: string }>;
  logger: AuthEmailLogger;
} {
  const errors: Array<{ context?: Record<string, unknown>; message: string }> = [];
  const infos: Array<{ context?: Record<string, unknown>; message: string }> = [];
  return {
    errors,
    infos,
    logger: {
      error: (message, context) => {
        errors.push({ ...(context ? { context } : {}), message });
      },
      info: (message, context) => {
        infos.push({ ...(context ? { context } : {}), message });
      },
    },
  };
}

describe("auth email delivery", () => {
  it("only allows local email previews on a loopback origin", async () => {
    const logger = createLogger();

    expect(
      () => new LocalPreviewEmailSender(logger.logger, "https://alphanet.example"),
    ).toThrow("loopback");

    const sender = new LocalPreviewEmailSender(logger.logger, "http://127.0.0.1:4000");
    await sender.send(verificationEmail);
    expect(
      () => new LocalPreviewEmailSender(logger.logger, "http://[::1]:4000"),
    ).not.toThrow();

    expect(logger.infos).toEqual([
      {
        context: {
          actionUrl: verificationEmail.actionUrl,
          purpose: "verification",
          recipient: "owner@example.test",
        },
        message: "Local auth email preview",
      },
    ]);
  });

  it("rejects action URLs outside the canonical auth endpoint", () => {
    expect(() =>
      assertTrustedActionUrl(
        "https://evil.example/api/auth/verify-email?token=stolen",
        "https://api.alphanet.test",
      ),
    ).toThrow("canonical auth origin");
    expect(() =>
      assertTrustedActionUrl(
        "https://api.alphanet.test/reset-password?token=stolen",
        "https://api.alphanet.test",
      ),
    ).toThrow("canonical auth origin");
    expect(() =>
      assertTrustedActionUrl(verificationEmail.actionUrl, "https://api.alphanet.test"),
    ).not.toThrow();
  });

  it("sends bilingual transactional email without exposing provider failures", async () => {
    const fetchImplementation = vi.fn(
      (): Promise<Response> => Promise.resolve(new Response(null, { status: 202 })),
    ) as unknown as typeof fetch;
    const sender = new ResendEmailSender({
      apiKey: "re_test_secret",
      fetch: fetchImplementation,
      from: "AlphaNet <auth@example.test>",
    });

    await sender.send(verificationEmail);

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [, request] = vi.mocked(fetchImplementation).mock.calls[0] ?? [];
    const requestBody = request?.body;
    expect(typeof requestBody).toBe("string");
    const body: unknown = JSON.parse(
      typeof requestBody === "string" ? requestBody : "{}",
    );
    expect(body).toMatchObject({
      subject: "Verify your AlphaNet email / 验证 AlphaNet 邮箱",
      to: ["owner@example.test"],
    });
    const html =
      body && typeof body === "object" && "html" in body ? body.html : undefined;
    expect(html).toEqual(expect.stringContaining("验证邮箱"));
    const requestHeaders = request?.headers as Record<string, string> | undefined;
    expect(requestHeaders?.Authorization).toBe("Bearer re_test_secret");
    expect(requestHeaders?.["Idempotency-Key"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("atomically reserves delivery capacity before invoking the provider", async () => {
    const sent: AuthEmail[] = [];
    const evalCall = vi.fn(() => Promise.resolve(1));
    const redis = { eval: evalCall } as unknown as Redis;
    const sender = new GuardedAuthEmailSender(
      {
        send: (message) => {
          sent.push(message);
          return Promise.resolve();
        },
      },
      {
        keySecret: "a-secret-long-enough-for-a-test-only-hmac",
        redis,
      },
    );

    await sender.send(verificationEmail);

    expect(evalCall).toHaveBeenCalledOnce();
    expect(sent).toEqual([verificationEmail]);
    expect(evalCall.mock.calls[0]).toContain("alphanet:auth-email:global-day");
    expect(JSON.stringify(evalCall.mock.calls)).not.toContain("owner@example.test");
  });

  it("suppresses over-budget delivery without logging recipient data", async () => {
    const provider = { send: vi.fn(() => Promise.resolve()) };
    const logger = createLogger();
    const sender = new GuardedAuthEmailSender(provider, {
      keySecret: "a-secret-long-enough-for-a-test-only-hmac",
      logger: logger.logger,
      redis: { eval: () => Promise.resolve(0) } as unknown as Redis,
    });

    await sender.send(verificationEmail);

    expect(provider.send).not.toHaveBeenCalled();
    expect(logger.infos).toEqual([
      {
        context: { purpose: "verification" },
        message: "Auth email delivery suppressed",
      },
    ]);
    expect(JSON.stringify(logger.infos)).not.toContain("owner@example.test");
  });

  it("drains background tasks and logs only sanitized failure metadata", async () => {
    const logger = createLogger();
    const supervisor = new BackgroundTaskSupervisor(logger.logger);
    supervisor.schedule(
      Promise.reject(new Error("provider token re_secret must not be logged")),
      "verification_email",
    );

    await supervisor.drain();

    expect(logger.errors).toEqual([
      {
        context: {
          errorName: "Error",
          operation: "verification_email",
        },
        message: "Auth background task failed",
      },
    ]);
    expect(JSON.stringify(logger.errors)).not.toContain("re_secret");
  });
});
