import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";

import { RedisRateLimitStorage } from "./rate-limit.js";

describe("Redis auth rate-limit storage", () => {
  it("uses an atomic consume operation and reports retry time", async () => {
    const evalCall = vi.fn(() => Promise.resolve([0, 42]));
    const storage = new RedisRateLimitStorage({
      eval: evalCall,
    } as unknown as Redis);

    await expect(
      storage.consume("sign-in:203.0.113.4", { max: 5, window: 60 }),
    ).resolves.toEqual({
      allowed: false,
      retryAfter: 42,
    });
    expect(evalCall).toHaveBeenCalledOnce();
  });

  it("rejects malformed Redis results instead of bypassing limits", async () => {
    const storage = new RedisRateLimitStorage({
      eval: () => Promise.resolve("unexpected"),
    } as unknown as Redis);

    await expect(
      storage.consume("sign-in:203.0.113.4", { max: 5, window: 60 }),
    ).rejects.toThrow("invalid auth rate-limit");
  });

  it("ignores malformed stored values", async () => {
    const storage = new RedisRateLimitStorage({
      get: () => Promise.resolve(JSON.stringify({ count: "not-a-number" })),
    } as unknown as Redis);

    await expect(storage.get("malformed")).resolves.toBeNull();
  });
});
