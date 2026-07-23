import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { RemoteMcpOAuthGuardError } from "./remote-mcp-oauth-guard.js";
import {
  parseRemoteMcpOAuthConsentQuery,
  REMOTE_MCP_OAUTH_CONSENT_QUERY_MAX_PARAMETERS,
  RemoteMcpOAuthConsentQueryError,
} from "./remote-mcp-oauth-consent-query.js";

const resource = "https://mcp.alphanet.example/mcp";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const codeChallenge = createHash("sha256").update(verifier, "ascii").digest("base64url");

function signedConsentQuery(
  mutate?: (parameters: URLSearchParams) => void,
): URLSearchParams {
  const parameters = new URLSearchParams({
    response_type: "code",
    client_id: "alphanet-research-client",
    redirect_uri: "https://client.example/callback",
    scope: "offline_access research:read",
    state: "opaque-state",
    prompt: "consent",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    resource,
    exp: "1784722200",
    ba_iat: "1784721600123",
  });
  mutate?.(parameters);
  parameters.set("sig", `${"A".repeat(43)}=`);
  return parameters;
}

function expectStructuralError(
  query: string,
  code: RemoteMcpOAuthConsentQueryError["code"],
  parameter?: string,
): void {
  try {
    parseRemoteMcpOAuthConsentQuery(query, { resource });
    throw new Error("Expected the consent query to be rejected");
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteMcpOAuthConsentQueryError);
    expect(error).toMatchObject({
      code,
      statusCode: 400,
      ...(parameter === undefined ? {} : { parameter }),
    });
  }
}

describe("parseRemoteMcpOAuthConsentQuery", () => {
  it("extracts only AlphaNet's standard authorize fields from Better Auth 1.7 transport", () => {
    const query = signedConsentQuery((parameters) => {
      parameters.set("ba_pl", "30000000-0000-4000-8000-000000000003");
    });

    expect(parseRemoteMcpOAuthConsentQuery(query.toString(), { resource })).toEqual({
      clientId: "alphanet-research-client",
      codeChallenge,
      codeChallengeMethod: "S256",
      canonicalScope: "research:read offline_access",
      redirectUri: "https://client.example/callback",
      requestedScopes: ["research:read", "offline_access"],
      resource,
      responseType: "code",
    });
  });

  it("requires the configured singleton resource in Provider 1.7 signed transport", () => {
    const query = signedConsentQuery();
    query.delete("resource");

    expect(() =>
      parseRemoteMcpOAuthConsentQuery(query.toString(), { resource }),
    ).toThrowError(
      expect.objectContaining<Partial<RemoteMcpOAuthGuardError>>({
        code: "PARAMETER_MISSING",
        parameter: "resource",
      }),
    );
  });

  it.each(["sig", "exp", "ba_iat"] as const)(
    "requires the %s signed-transport parameter",
    (name) => {
      const query = signedConsentQuery();
      query.delete(name);
      expectStructuralError(query.toString(), "PARAMETER_MISSING", name);
    },
  );

  it.each(["sig", "exp", "ba_iat", "ba_pl", "client_id"] as const)(
    "rejects duplicate non-manifest parameter %s",
    (name) => {
      const query = signedConsentQuery((parameters) => {
        if (name === "ba_pl") parameters.set(name, "session-one");
      });
      query.append(name, query.get(name) ?? "duplicate");
      expectStructuralError(query.toString(), "PARAMETER_DUPLICATE", name);
    },
  );

  it("rejects unknown transport parameters before OAuth validation", () => {
    const query = signedConsentQuery();
    query.append("nonce", "not-supported");
    expectStructuralError(query.toString(), "PARAMETER_UNSUPPORTED", "nonce");
  });

  it("validates Better Auth control-field encodings", () => {
    const badSignature = signedConsentQuery();
    badSignature.set("sig", "not-base64url-or-base64");
    expectStructuralError(badSignature.toString(), "SIGNED_PARAMETER_INVALID", "sig");

    const badExpiry = signedConsentQuery();
    badExpiry.set("exp", "1.5");
    expectStructuralError(badExpiry.toString(), "SIGNED_PARAMETER_INVALID", "exp");

    const badIssuedAt = signedConsentQuery();
    badIssuedAt.set("ba_iat", "0");
    expectStructuralError(badIssuedAt.toString(), "SIGNED_PARAMETER_INVALID", "ba_iat");
  });

  it("bounds raw bytes and decoded parameter count before domain use", () => {
    expectStructuralError("q".repeat(16_385), "QUERY_TOO_LARGE");

    const excessive = signedConsentQuery();
    while ([...excessive].length <= REMOTE_MCP_OAUTH_CONSENT_QUERY_MAX_PARAMETERS) {
      excessive.append("padding", `${[...excessive].length}`);
    }
    expectStructuralError(excessive.toString(), "QUERY_TOO_MANY_PARAMETERS");
  });

  it("delegates extracted OAuth semantics and configured-resource checks to the guard", () => {
    const mismatch = signedConsentQuery((parameters) => {
      parameters.set("resource", "https://other.example/mcp");
    });
    expect(() =>
      parseRemoteMcpOAuthConsentQuery(mismatch.toString(), { resource }),
    ).toThrowError(
      expect.objectContaining<Partial<RemoteMcpOAuthGuardError>>({
        code: "RESOURCE_MISMATCH",
        parameter: "resource",
      }),
    );
  });
});
