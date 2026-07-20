import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import proxyAddr from "@fastify/proxy-addr";
import type { FastifyRequest } from "fastify";

export const ssrClientIpHeaders = {
  forwardedFor: "x-alphanet-ssr-forwarded-for",
  signature: "x-alphanet-ssr-signature",
  timestamp: "x-alphanet-ssr-timestamp",
} as const;

const maximumForwardedChainLength = 1_024;
const maximumForwardedAddresses = 20;
const signatureMaximumAgeMilliseconds = 60_000;
const signaturePattern = /^[A-Za-z0-9_-]{43}$/;
const timestampPattern = /^[1-9][0-9]{11,12}$/;

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function signaturePayload(options: {
  forwardedFor: string;
  method: string;
  timestamp: string;
  url: string;
}): string {
  return [
    "alphanet-ssr-client-ip-v1",
    options.timestamp,
    options.method.toUpperCase(),
    options.url,
    options.forwardedFor,
  ].join("\n");
}

function signatureIsValid(signature: string, payload: string, secret: string): boolean {
  if (!signaturePattern.test(signature)) {
    return false;
  }
  const supplied = Buffer.from(signature, "base64url");
  const expected = createHmac("sha256", secret).update(payload).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function normalizedAddress(address: string): string {
  if (isIP(address) !== 6) {
    return address;
  }
  const hostname = new URL(`http://[${address}]/`).hostname;
  return hostname.slice(1, -1);
}

function resolveForwardedAddress(
  forwardedFor: string,
  trustProxy: (address: string, hop: number) => boolean,
): string | null {
  if (forwardedFor.length === 0 || forwardedFor.length > maximumForwardedChainLength) {
    return null;
  }

  const addresses = forwardedFor.split(",").map((address) => address.trim());
  if (
    addresses.length === 0 ||
    addresses.length > maximumForwardedAddresses ||
    addresses.some((address) => isIP(address) === 0)
  ) {
    return null;
  }

  for (let index = addresses.length - 1; index >= 0; index -= 1) {
    const address = addresses[index]!;
    const hop = addresses.length - 1 - index;
    if (index === 0 || !trustProxy(address, hop)) {
      return normalizedAddress(address);
    }
  }
  return null;
}

export function createRequestClientIpResolver(options: {
  internalSsrRequestSecret?: string | undefined;
  now?: number | undefined;
  trustedProxyCidrs?: readonly string[] | undefined;
}): (request: FastifyRequest) => string {
  const trustedProxyCidrs = options.trustedProxyCidrs ?? [];
  const trustProxy =
    trustedProxyCidrs.length > 0
      ? proxyAddr.compile([...trustedProxyCidrs])
      : () => false;

  return (request) => {
    const secret = options.internalSsrRequestSecret;
    if (!secret) {
      return request.ip;
    }

    const forwardedFor = singleHeader(request.headers[ssrClientIpHeaders.forwardedFor]);
    const signature = singleHeader(request.headers[ssrClientIpHeaders.signature]);
    const timestamp = singleHeader(request.headers[ssrClientIpHeaders.timestamp]);
    if (!forwardedFor || !signature || !timestamp || !timestampPattern.test(timestamp)) {
      return request.ip;
    }

    const timestampMilliseconds = Number(timestamp);
    const now = options.now ?? Date.now();
    if (
      !Number.isSafeInteger(timestampMilliseconds) ||
      Math.abs(now - timestampMilliseconds) > signatureMaximumAgeMilliseconds
    ) {
      return request.ip;
    }

    const payload = signaturePayload({
      forwardedFor,
      method: request.method,
      timestamp,
      url: request.url,
    });
    if (!signatureIsValid(signature, payload, secret)) {
      return request.ip;
    }

    return resolveForwardedAddress(forwardedFor, trustProxy) ?? request.ip;
  };
}
