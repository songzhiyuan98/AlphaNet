import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createRemoteMcpOAuthAuthorizeRateLimiter,
  REMOTE_MCP_OAUTH_AUTHORIZE_RATE_LIMIT_RULES,
  RemoteMcpOAuthAuthorizeRateLimitUnavailableError,
} from "./remote-mcp-oauth-authorize-rate-limit.js";

const CLIENT_ID = "alphanet-desktop-v1";
const CLIENT_IP = "2001:db8::42";

function allowed() {
  return { allowed: true, retryAfter: null } as const;
}

function expectedKey(dimension: "client" | "global" | "ip", value: string): string {
  const digest = createHash("sha256")
    .update("alphanet:remote-mcp-oauth:authorize:v1", "utf8")
    .update("\0", "utf8")
    .update(dimension, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
  return `remote-mcp-oauth-authorize:v1:${dimension}:sha256:${digest}`;
}

describe("Remote MCP OAuth authorize pre-persistence rate limiter", () => {
  it("consumes IP, Client, and global limits from narrowest to broadest", async () => {
    const consume = vi.fn().mockResolvedValue(allowed());
    const admit = createRemoteMcpOAuthAuthorizeRateLimiter({ consume });

    await expect(admit({ clientId: CLIENT_ID, clientIp: CLIENT_IP })).resolves.toEqual({
      allowed: true,
    });

    expect(consume.mock.calls).toEqual([
      [expectedKey("ip", CLIENT_IP), REMOTE_MCP_OAUTH_AUTHORIZE_RATE_LIMIT_RULES.ip],
      [
        expectedKey("client", CLIENT_ID),
        REMOTE_MCP_OAUTH_AUTHORIZE_RATE_LIMIT_RULES.client,
      ],
      [
        expectedKey("global", "all-authorize-requests"),
        REMOTE_MCP_OAUTH_AUTHORIZE_RATE_LIMIT_RULES.global,
      ],
    ]);
  });

  it("never places raw Client or IP identifiers in Redis keys", async () => {
    const consume = vi.fn().mockResolvedValue(allowed());
    const admit = createRemoteMcpOAuthAuthorizeRateLimiter({ consume });

    await admit({ clientId: CLIENT_ID, clientIp: CLIENT_IP });

    const keys = consume.mock.calls.map(([key]) => String(key));
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      expect(key).toMatch(
        /^remote-mcp-oauth-authorize:v1:(?:global|client|ip):sha256:[a-f0-9]{64}$/u,
      );
      expect(key).not.toContain(CLIENT_ID);
      expect(key).not.toContain(CLIENT_IP);
    }
    expect(new Set(keys).size).toBe(3);
  });

  it.each([
    { deniedAt: 0, retryAfter: 41 },
    { deniedAt: 1, retryAfter: 23 },
    { deniedAt: 2, retryAfter: 7 },
  ])(
    "stops at denied dimension $deniedAt and returns its verified retry interval",
    async ({ deniedAt, retryAfter }) => {
      const consume = vi.fn();
      for (let index = 0; index < deniedAt; index += 1) {
        consume.mockResolvedValueOnce(allowed());
      }
      consume.mockResolvedValueOnce({ allowed: false, retryAfter });
      const admit = createRemoteMcpOAuthAuthorizeRateLimiter({ consume });

      await expect(admit({ clientId: CLIENT_ID, clientIp: CLIENT_IP })).resolves.toEqual({
        allowed: false,
        retryAfterSeconds: retryAfter,
      });
      expect(consume).toHaveBeenCalledTimes(deniedAt + 1);
    },
  );

  it.each([
    { deniedAt: 0, deniedDimension: "IP" },
    { deniedAt: 1, deniedDimension: "Client" },
  ])(
    "does not consume the global budget when the $deniedDimension budget rejects",
    async ({ deniedAt }) => {
      const consume = vi.fn();
      for (let index = 0; index < deniedAt; index += 1) {
        consume.mockResolvedValueOnce(allowed());
      }
      consume.mockResolvedValueOnce({ allowed: false, retryAfter: 12 });
      const admit = createRemoteMcpOAuthAuthorizeRateLimiter({ consume });

      await expect(admit({ clientId: CLIENT_ID, clientIp: CLIENT_IP })).resolves.toEqual({
        allowed: false,
        retryAfterSeconds: 12,
      });

      expect(
        consume.mock.calls.some(([key]) =>
          String(key).startsWith("remote-mcp-oauth-authorize:v1:global:sha256:"),
        ),
      ).toBe(false);
    },
  );

  it.each([
    undefined,
    null,
    "unexpected",
    { allowed: true, retryAfter: 1 },
    { allowed: false, retryAfter: null },
    { allowed: false, retryAfter: 0 },
    { allowed: false, retryAfter: 1.5 },
    { allowed: false, retryAfter: 61 },
    { allowed: "yes", retryAfter: null },
  ])("fails closed for malformed consume result %#", async (result) => {
    const consume = vi.fn().mockResolvedValue(result);
    const admit = createRemoteMcpOAuthAuthorizeRateLimiter({ consume });

    await expect(
      admit({ clientId: CLIENT_ID, clientIp: CLIENT_IP }),
    ).rejects.toBeInstanceOf(RemoteMcpOAuthAuthorizeRateLimitUnavailableError);
    expect(consume).toHaveBeenCalledOnce();
  });

  it("fails closed without leaking storage errors", async () => {
    const consume = vi.fn().mockRejectedValue(new Error(`Redis failed for ${CLIENT_ID}`));
    const admit = createRemoteMcpOAuthAuthorizeRateLimiter({ consume });

    await expect(
      admit({ clientId: CLIENT_ID, clientIp: CLIENT_IP }),
    ).rejects.toMatchObject({
      message: "Remote MCP OAuth authorize rate-limit protection is unavailable",
      name: "RemoteMcpOAuthAuthorizeRateLimitUnavailableError",
    });
  });

  it.each([
    { clientId: "", clientIp: CLIENT_IP },
    { clientId: ` ${CLIENT_ID}`, clientIp: CLIENT_IP },
    { clientId: CLIENT_ID, clientIp: `${CLIENT_IP}\n` },
    { clientId: "x".repeat(1_025), clientIp: CLIENT_IP },
  ])("rejects invalid identities before consuming Redis", async (input) => {
    const consume = vi.fn().mockResolvedValue(allowed());
    const admit = createRemoteMcpOAuthAuthorizeRateLimiter({ consume });

    await expect(admit(input)).rejects.toThrow(
      "Remote MCP OAuth authorize rate-limit identity is invalid",
    );
    expect(consume).not.toHaveBeenCalled();
  });
});
