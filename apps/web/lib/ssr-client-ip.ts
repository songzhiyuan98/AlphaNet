import { createHmac } from "node:crypto";
import { isIP } from "node:net";

const localDevelopmentSecret = "L8wq2Uox9sV7Gm1Xc4Kd6aJ0Ph5Rt3NyE1bZfQ7i";
const maximumForwardedChainLength = 1_024;
const maximumForwardedAddresses = 20;

const headerNames = {
  forwardedFor: "x-alphanet-ssr-forwarded-for",
  signature: "x-alphanet-ssr-signature",
  timestamp: "x-alphanet-ssr-timestamp",
} as const;

function internalSecret(): string | null {
  const configured = process.env.SSR_INTERNAL_REQUEST_SECRET?.trim();
  if (configured) {
    return configured;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("SSR_INTERNAL_REQUEST_SECRET is required in production");
  }
  return localDevelopmentSecret;
}

function normalizedForwardedFor(incomingHeaders: Headers): string | null {
  const forwardedFor = incomingHeaders.get("x-forwarded-for")?.trim();
  const realIp = incomingHeaders.get("x-real-ip")?.trim();
  const candidate = forwardedFor || realIp;
  if (!candidate || candidate.length > maximumForwardedChainLength) {
    return null;
  }

  const addresses = candidate.split(",").map((address) => address.trim());
  if (
    addresses.length === 0 ||
    addresses.length > maximumForwardedAddresses ||
    addresses.some((address) => isIP(address) === 0)
  ) {
    return null;
  }
  return addresses.join(",");
}

function mayOmitForwardedClientIp(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.SSR_ALLOW_MISSING_CLIENT_IP === "true"
  );
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

export function signedSsrClientIpHeaders(
  incomingHeaders: Headers,
  options: {
    method: string;
    now?: number | undefined;
    url: string;
  },
): Record<string, string> {
  const forwardedFor = normalizedForwardedFor(incomingHeaders);
  if (!forwardedFor) {
    if (!mayOmitForwardedClientIp()) {
      throw new Error(
        "A trusted ingress must provide x-forwarded-for or x-real-ip in production",
      );
    }
    return {};
  }

  const secret = internalSecret();
  if (!secret) {
    return {};
  }
  const timestamp = String(options.now ?? Date.now());
  const signature = createHmac("sha256", secret)
    .update(
      signaturePayload({
        forwardedFor,
        method: options.method,
        timestamp,
        url: options.url,
      }),
    )
    .digest("base64url");

  return {
    [headerNames.forwardedFor]: forwardedFor,
    [headerNames.signature]: signature,
    [headerNames.timestamp]: timestamp,
  };
}
