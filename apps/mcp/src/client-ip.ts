import { isIP } from "node:net";

import proxyAddr from "@fastify/proxy-addr";
import type { Request } from "express";

const maximumForwardedChainLength = 1_024;
const maximumForwardedAddresses = 20;
const trustedViewerIpHeader = "x-alphanet-viewer-ip";

export class InvalidForwardedForError extends Error {
  constructor() {
    super("MCP X-Forwarded-For header is invalid");
    this.name = "InvalidForwardedForError";
  }
}

function normalizedAddress(address: string): string {
  if (isIP(address) !== 6) {
    return address;
  }
  const hostname = new URL(`http://[${address}]/`).hostname;
  return hostname.slice(1, -1);
}

function forwardedAddresses(value: string | string[] | undefined): string[] | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumForwardedChainLength
  ) {
    return null;
  }
  const addresses = value.split(",").map((address) => address.trim());
  if (
    addresses.length === 0 ||
    addresses.length > maximumForwardedAddresses ||
    addresses.some((address) => isIP(address) === 0)
  ) {
    return null;
  }
  return addresses;
}

function singleRawHeader(
  request: Request,
  expectedName: string,
): string | null | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name?.toLowerCase() === expectedName && typeof value === "string") {
      values.push(value);
    }
  }
  const normalized = request.headers[expectedName];
  if (values.length === 0 && normalized === undefined) return undefined;
  return values.length === 1 && normalized === values[0] ? values[0]! : null;
}

/**
 * Resolves the first untrusted address from the right of the ALB/proxy chain.
 * X-Forwarded-For is ignored unless the direct socket peer is trusted.
 */
export function createMcpClientIpResolver(
  trustedProxyCidrs: readonly string[],
): (request: Request) => string {
  const trustProxy =
    trustedProxyCidrs.length > 0
      ? proxyAddr.compile([...trustedProxyCidrs])
      : () => false;

  return (request) => {
    const peerAddress = request.socket.remoteAddress;
    if (!peerAddress || isIP(peerAddress) === 0) {
      throw new Error("MCP socket peer address is unavailable");
    }

    const forwardedHeader = request.headers["x-forwarded-for"];
    if (!trustProxy(peerAddress, 0)) {
      return normalizedAddress(peerAddress);
    }

    // CloudFront overwrites this header with event.viewer.ip before the
    // request reaches the origin. Trust it only from the configured ALB peer;
    // this avoids treating the CloudFront origin node as the rate-limit actor.
    const trustedViewerIp = singleRawHeader(request, trustedViewerIpHeader);
    if (trustedViewerIp === null || (trustedViewerIp && isIP(trustedViewerIp) === 0)) {
      throw new InvalidForwardedForError();
    }
    if (trustedViewerIp) {
      return normalizedAddress(trustedViewerIp);
    }

    if (forwardedHeader === undefined) {
      return normalizedAddress(peerAddress);
    }

    const forwarded = forwardedAddresses(forwardedHeader);
    if (!forwarded) {
      throw new InvalidForwardedForError();
    }

    const chain = [...forwarded, peerAddress];
    for (let index = chain.length - 1; index > 0; index -= 1) {
      const address = chain[index]!;
      const hop = chain.length - 1 - index;
      if (!trustProxy(address, hop)) {
        return normalizedAddress(address);
      }
    }
    return normalizedAddress(chain[0]!);
  };
}
