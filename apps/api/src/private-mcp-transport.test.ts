import { TLSSocket } from "node:tls";

import { describe, expect, it } from "vitest";

import {
  createPrivateMcpTlsIdentityGuard,
  verifyPinnedMcpClientTlsSocket,
} from "./private-mcp-transport.js";

const fingerprint = "A1".repeat(32);
const nodeFingerprint = Array.from({ length: 32 }, () => "A1").join(":");

function socket(overrides: Record<string, unknown> = {}): TLSSocket {
  const value = Object.create(TLSSocket.prototype) as TLSSocket;
  Object.defineProperties(value, {
    authorizationError: { value: null, configurable: true },
    authorized: { value: true, configurable: true },
    encrypted: { value: true, configurable: true },
    getPeerCertificate: {
      configurable: true,
      value: () => ({
        ext_key_usage: ["1.3.6.1.5.5.7.3.2"],
        fingerprint256: nodeFingerprint,
        raw: Buffer.from("certificate"),
        subject: { CN: "alphanet-mcp" },
        subjectaltname: "URI:spiffe://alphanet.internal/service/mcp",
      }),
    },
    ...Object.fromEntries(
      Object.entries(overrides).map(([name, value]) => [
        name,
        { value, configurable: true },
      ]),
    ),
  });
  return value;
}

describe("private MCP mTLS transport identity", () => {
  it("accepts only the authorized, pinned MCP client identity", () => {
    expect(verifyPinnedMcpClientTlsSocket(socket(), new Set([fingerprint]))).toBe(true);
  });

  it.each([
    ["an unauthorized chain", { authorized: false }],
    ["an authorization error", { authorizationError: new Error("bad chain") }],
    ["a cleartext socket", { encrypted: false }],
    [
      "a different fingerprint",
      {
        getPeerCertificate: () => ({
          ext_key_usage: ["1.3.6.1.5.5.7.3.2"],
          fingerprint256: Array.from({ length: 32 }, () => "B2").join(":"),
          raw: Buffer.from("certificate"),
          subject: { CN: "alphanet-mcp" },
          subjectaltname: "URI:spiffe://alphanet.internal/service/mcp",
        }),
      },
    ],
    [
      "a different SAN",
      {
        getPeerCertificate: () => ({
          ext_key_usage: ["1.3.6.1.5.5.7.3.2"],
          fingerprint256: nodeFingerprint,
          raw: Buffer.from("certificate"),
          subject: { CN: "alphanet-mcp" },
          subjectaltname: "URI:spiffe://attacker.invalid/service/mcp",
        }),
      },
    ],
    [
      "a certificate without clientAuth EKU",
      {
        getPeerCertificate: () => ({
          ext_key_usage: ["1.3.6.1.5.5.7.3.1"],
          fingerprint256: nodeFingerprint,
          raw: Buffer.from("certificate"),
          subject: { CN: "alphanet-mcp" },
          subjectaltname: "URI:spiffe://alphanet.internal/service/mcp",
        }),
      },
    ],
  ])("rejects %s", (_label, overrides) => {
    expect(
      verifyPinnedMcpClientTlsSocket(socket(overrides), new Set([fingerprint])),
    ).toBe(false);
  });

  it("rejects a non-TLS Fastify socket before certificate inspection", () => {
    const guard = createPrivateMcpTlsIdentityGuard({
      allowedClientCertificateFingerprints: [fingerprint],
    });

    expect(guard({ raw: { socket: {} } } as never)).toBeNull();
  });

  it("returns the fixed MCP service identity after transport verification", () => {
    const guard = createPrivateMcpTlsIdentityGuard({
      allowedClientCertificateFingerprints: [fingerprint],
    });

    expect(guard({ raw: { socket: socket() } } as never)).toEqual({
      authentication: "mutual_tls",
      service: "mcp",
    });
  });

  it("rejects malformed or duplicate configured fingerprints at assembly time", () => {
    expect(() =>
      createPrivateMcpTlsIdentityGuard({
        allowedClientCertificateFingerprints: [fingerprint.toLowerCase()],
      }),
    ).toThrow("Invalid private MCP client certificate fingerprint configuration");
    expect(() =>
      createPrivateMcpTlsIdentityGuard({
        allowedClientCertificateFingerprints: [fingerprint, fingerprint],
      }),
    ).toThrow("Invalid private MCP client certificate fingerprint configuration");
  });
});
