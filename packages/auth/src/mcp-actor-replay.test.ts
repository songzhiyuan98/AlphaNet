import { describe, expect, it, vi } from "vitest";

import { RedisMcpActorAssertionReplayStore } from "./mcp-actor-replay.js";

const now = new Date("2026-07-21T20:00:00.000Z");
const jti = "30000000-0000-4000-8000-000000000003";

describe("RedisMcpActorAssertionReplayStore", () => {
  it("stores only a keyed jti digest with a bounded one-time TTL", async () => {
    const set = vi.fn().mockResolvedValue("OK");
    const store = new RedisMcpActorAssertionReplayStore(
      { set },
      {
        digestKey: Buffer.alloc(32, 0x44),
      },
    );

    await expect(store.consume(jti, new Date(now.valueOf() + 30_000), now)).resolves.toBe(
      true,
    );
    expect(set).toHaveBeenCalledTimes(1);
    const firstCall: unknown = set.mock.calls[0];
    if (!Array.isArray(firstCall)) {
      throw new Error("Expected Redis set to be called");
    }
    const key: unknown = firstCall[0];
    expect(key).toMatch(/^alphanet:mcp-actor-assertion:jti:[A-Za-z0-9_-]{43}$/);
    expect(key).not.toContain(jti);
    expect(firstCall.slice(1)).toEqual(["1", "PX", 30_000, "NX"]);
  });

  it("returns false when Redis reports that the jti was already consumed", async () => {
    const set = vi.fn().mockResolvedValue(null);
    const store = new RedisMcpActorAssertionReplayStore(
      { set },
      {
        digestKey: Buffer.alloc(32, 0x44),
      },
    );

    await expect(store.consume(jti, new Date(now.valueOf() + 10_000), now)).resolves.toBe(
      false,
    );
  });

  it("rejects expired or implausibly long assertions without touching Redis", async () => {
    const set = vi.fn();
    const store = new RedisMcpActorAssertionReplayStore(
      { set },
      {
        digestKey: Buffer.alloc(32, 0x44),
      },
    );

    await expect(store.consume(jti, now, now)).resolves.toBe(false);
    await expect(store.consume(jti, new Date(now.valueOf() + 35_001), now)).resolves.toBe(
      false,
    );
    expect(set).not.toHaveBeenCalled();
  });

  it("fails closed when Redis is unavailable", async () => {
    const set = vi.fn().mockRejectedValue(new Error("redis unavailable"));
    const store = new RedisMcpActorAssertionReplayStore(
      { set },
      {
        digestKey: Buffer.alloc(32, 0x44),
      },
    );

    await expect(
      store.consume(jti, new Date(now.valueOf() + 10_000), now),
    ).rejects.toThrow("redis unavailable");
  });
});
