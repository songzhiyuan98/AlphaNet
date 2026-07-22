import type { Request } from "express";
import { describe, expect, it } from "vitest";

import { createMcpClientIpResolver, InvalidForwardedForError } from "./client-ip.js";

function requestWith(peerAddress: string, forwardedFor?: string): Request {
  return {
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
    socket: { remoteAddress: peerAddress },
  } as unknown as Request;
}

describe("MCP client address resolution", () => {
  it("ignores spoofed forwarding headers from an untrusted socket peer", () => {
    const resolve = createMcpClientIpResolver(["10.0.0.0/8"]);

    expect(resolve(requestWith("198.51.100.20", "203.0.113.9"))).toBe("198.51.100.20");
  });

  it("walks a trusted ALB chain from right to left", () => {
    const resolve = createMcpClientIpResolver(["10.0.0.0/8"]);

    expect(resolve(requestWith("10.0.0.10", "203.0.113.9, 10.0.0.20"))).toBe(
      "203.0.113.9",
    );
  });

  it("supports bounded IPv6 proxy ranges", () => {
    const resolve = createMcpClientIpResolver(["fd00::/8"]);

    expect(resolve(requestWith("fd00::10", "2001:db8::5, fd00::20"))).toBe("2001:db8::5");
  });

  it("rejects malformed or oversized chains from a trusted socket peer", () => {
    const resolve = createMcpClientIpResolver(["10.0.0.0/8"]);

    expect(() => resolve(requestWith("10.0.0.10", "not-an-ip"))).toThrow(
      InvalidForwardedForError,
    );
    expect(() =>
      resolve(
        requestWith("10.0.0.10", Array.from({ length: 21 }, () => "10.0.0.1").join(",")),
      ),
    ).toThrow(InvalidForwardedForError);
  });

  it("ignores malformed forwarding headers from an untrusted peer", () => {
    const resolve = createMcpClientIpResolver(["10.0.0.0/8"]);

    expect(resolve(requestWith("198.51.100.20", "not-an-ip"))).toBe("198.51.100.20");
  });
});
