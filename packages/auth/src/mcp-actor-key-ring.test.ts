import { describe, expect, it } from "vitest";

import { createMcpActorAssertionKeyRing } from "./mcp-actor-key-ring.js";

const key = (seed: number) => Buffer.alloc(32, seed);

describe("createMcpActorAssertionKeyRing", () => {
  it("builds an immutable current and previous verification ring", () => {
    const current = key(1);
    const previous = key(2);
    const cutoff = new Date("2030-01-01T00:00:00.000Z");
    const ring = createMcpActorAssertionKeyRing({
      currentKey: current,
      currentVersion: 2,
      previousKeys: {
        1: { key: previous, verificationExpiresAt: cutoff },
      },
    });

    current.fill(9);
    previous.fill(9);
    cutoff.setUTCFullYear(2040);

    expect(ring.currentVersion).toBe(2);
    expect(Buffer.from(ring.keys[2]!.key)).toEqual(key(1));
    expect(Buffer.from(ring.keys[1]!.key)).toEqual(key(2));
    expect(ring.keys[1]!.verificationExpiresAt).toEqual(
      new Date("2030-01-01T00:00:00.000Z"),
    );
    expect(Object.isFrozen(ring)).toBe(true);
    expect(Object.isFrozen(ring.keys)).toBe(true);
  });

  it.each([
    ["an invalid current version", { currentKey: key(1), currentVersion: 0 }],
    ["a short current key", { currentKey: Buffer.alloc(31), currentVersion: 1 }],
    [
      "the current version in previous keys",
      {
        currentKey: key(1),
        currentVersion: 1,
        previousKeys: {
          1: {
            key: key(2),
            verificationExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
          },
        },
      },
    ],
    [
      "reused key material",
      {
        currentKey: key(1),
        currentVersion: 2,
        previousKeys: {
          1: {
            key: key(1),
            verificationExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
          },
        },
      },
    ],
  ])("rejects %s", (_label, input) => {
    expect(() => createMcpActorAssertionKeyRing(input)).toThrow(
      "Invalid MCP ActorContext key ring configuration",
    );
  });
});
