import { TLSSocket } from "node:tls";

import type { DetailedPeerCertificate } from "node:tls";

import type { PrivateMcpTransportIdentityGuard } from "./private-mcp-app.js";

const MCP_CLIENT_SUBJECT = "alphanet-mcp";
const MCP_CLIENT_SPIFFE_ID = "URI:spiffe://alphanet.internal/service/mcp";
const TLS_CLIENT_AUTH_EXTENDED_KEY_USAGE = "1.3.6.1.5.5.7.3.2";
const canonicalFingerprintPattern = /^[0-9A-F]{64}$/u;
const nodeFingerprintPattern = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u;

export interface PrivateMcpTlsIdentityGuardOptions {
  allowedClientCertificateFingerprints: readonly string[];
}

function canonicalPeerFingerprint(value: unknown): string | null {
  if (typeof value !== "string" || !nodeFingerprintPattern.test(value)) {
    return null;
  }
  return value.replaceAll(":", "");
}

function validPeerIdentity(peer: DetailedPeerCertificate): boolean {
  return (
    Buffer.isBuffer(peer.raw) &&
    peer.raw.byteLength > 0 &&
    peer.subject?.CN === MCP_CLIENT_SUBJECT &&
    peer.subjectaltname === MCP_CLIENT_SPIFFE_ID &&
    Array.isArray(peer.ext_key_usage) &&
    peer.ext_key_usage.includes(TLS_CLIENT_AUTH_EXTENDED_KEY_USAGE)
  );
}

export function verifyPinnedMcpClientTlsSocket(
  socket: TLSSocket,
  allowedFingerprints: ReadonlySet<string>,
): boolean {
  if (
    socket.encrypted !== true ||
    socket.authorized !== true ||
    socket.authorizationError != null
  ) {
    return false;
  }
  let peer: DetailedPeerCertificate;
  try {
    peer = socket.getPeerCertificate(true);
  } catch {
    return false;
  }
  const fingerprint = canonicalPeerFingerprint(peer.fingerprint256);
  return (
    fingerprint !== null &&
    allowedFingerprints.has(fingerprint) &&
    validPeerIdentity(peer)
  );
}

export function createPrivateMcpTlsIdentityGuard(
  options: PrivateMcpTlsIdentityGuardOptions,
): PrivateMcpTransportIdentityGuard {
  if (
    options.allowedClientCertificateFingerprints.length < 1 ||
    options.allowedClientCertificateFingerprints.length > 3 ||
    options.allowedClientCertificateFingerprints.some(
      (value) => !canonicalFingerprintPattern.test(value),
    ) ||
    new Set(options.allowedClientCertificateFingerprints).size !==
      options.allowedClientCertificateFingerprints.length
  ) {
    throw new Error("Invalid private MCP client certificate fingerprint configuration");
  }
  const allowedFingerprints = new Set(options.allowedClientCertificateFingerprints);
  return (request) => {
    const socket = request.raw.socket;
    if (
      !(socket instanceof TLSSocket) ||
      !verifyPinnedMcpClientTlsSocket(socket, allowedFingerprints)
    ) {
      return null;
    }
    return { authentication: "mutual_tls", service: "mcp" };
  };
}
