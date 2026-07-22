import { describe, expect, it, vi } from "vitest";

import {
  createMcpActorRateLimiter,
  createMcpRequestRateLimiter,
  MCP_ACTOR_RATE_LIMIT,
  MCP_IP_RATE_LIMIT,
} from "./rate-limiters.js";

function allowed() {
  return { allowed: true, retryAfter: null } as const;
}

describe("Remote MCP Redis limiter adapters", () => {
  it("applies the pre-auth IP ceiling before authorization", async () => {
    const consume = vi.fn().mockResolvedValue(allowed());
    const limiter = createMcpRequestRateLimiter({ consume });

    await expect(
      limiter({
        clientIp: "2001:db8::10",
        requestId: "4fcb9cc4-fdc5-4d95-964f-1fa84387056d",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ allowed: true });

    expect(consume).toHaveBeenCalledWith("ip:2001:db8::10", MCP_IP_RATE_LIMIT);
  });

  it("returns a bounded retry interval when the IP ceiling denies", async () => {
    const limiter = createMcpRequestRateLimiter({
      consume: vi.fn().mockResolvedValue({ allowed: false, retryAfter: 19 }),
    });

    await expect(
      limiter({
        clientIp: "203.0.113.9",
        requestId: "4fcb9cc4-fdc5-4d95-964f-1fa84387056d",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 19 });
  });

  it("consumes Client, Grant, and Credential ceilings in a fixed order", async () => {
    const consume = vi.fn().mockResolvedValue(allowed());
    const limiter = createMcpActorRateLimiter({ consume });

    await expect(
      limiter({
        clientId: "mcpcli_01JTEST000000000000000001",
        clientIp: "203.0.113.9",
        credentialId: "cred_01JTEST000000000000000001",
        grantId: "mcpgrant_01JTEST000000000000001",
        method: "tools/call",
        requestId: "4fcb9cc4-fdc5-4d95-964f-1fa84387056d",
        signal: new AbortController().signal,
        toolName: "get_agent_context",
      }),
    ).resolves.toEqual({ allowed: true });

    expect(consume.mock.calls).toEqual([
      ["client:mcpcli_01JTEST000000000000000001", MCP_ACTOR_RATE_LIMIT],
      ["grant:mcpgrant_01JTEST000000000000001", MCP_ACTOR_RATE_LIMIT],
      ["credential:cred_01JTEST000000000000000001", MCP_ACTOR_RATE_LIMIT],
    ]);
  });

  it("stops at the first denied actor dimension", async () => {
    const consume = vi
      .fn()
      .mockResolvedValueOnce(allowed())
      .mockResolvedValueOnce({ allowed: false, retryAfter: 8 });
    const limiter = createMcpActorRateLimiter({ consume });

    await expect(
      limiter({
        clientId: "client-a",
        clientIp: "203.0.113.9",
        credentialId: "credential-a",
        grantId: "grant-a",
        method: "tools/list",
        requestId: "4fcb9cc4-fdc5-4d95-964f-1fa84387056d",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 8 });

    expect(consume).toHaveBeenCalledTimes(2);
  });

  it("fails closed for malformed Redis decisions", async () => {
    const limiter = createMcpRequestRateLimiter({
      consume: vi.fn().mockResolvedValue({ allowed: true, retryAfter: 4 }),
    });

    await expect(
      limiter({
        clientIp: "203.0.113.9",
        requestId: "4fcb9cc4-fdc5-4d95-964f-1fa84387056d",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("invalid Remote MCP rate-limit decision");
  });

  it("does not touch Redis after its protection signal is aborted", async () => {
    const consume = vi.fn().mockResolvedValue(allowed());
    const limiter = createMcpActorRateLimiter({ consume });
    const controller = new AbortController();
    controller.abort();

    await expect(
      limiter({
        clientId: "client-a",
        clientIp: "203.0.113.9",
        credentialId: "credential-a",
        grantId: "grant-a",
        method: "tools/list",
        requestId: "4fcb9cc4-fdc5-4d95-964f-1fa84387056d",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(consume).not.toHaveBeenCalled();
  });
});
