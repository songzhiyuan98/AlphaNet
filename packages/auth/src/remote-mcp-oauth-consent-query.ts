import { REMOTE_MCP_OAUTH_QUERY_MAX_BYTES } from "@alphanet/contracts";

import {
  validateRemoteMcpAuthorizeQuery,
  type ValidatedRemoteMcpAuthorizeQuery,
} from "./remote-mcp-oauth-guard.js";

export const REMOTE_MCP_OAUTH_CONSENT_QUERY_MAX_PARAMETERS = 32;

const STANDARD_AUTHORIZE_PARAMETERS = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "prompt",
  "redirect_uri",
  "resource",
  "response_type",
  "scope",
  "state",
]);
const SIGNED_TRANSPORT_PARAMETERS = new Set([
  ...STANDARD_AUTHORIZE_PARAMETERS,
  "exp",
  "ba_iat",
  "ba_pl",
  "sig",
]);
const REQUIRED_TRANSPORT_PARAMETERS = ["exp", "ba_iat", "sig"] as const;
const POSITIVE_DECIMAL_INTEGER = /^[1-9][0-9]*$/u;
const BETTER_AUTH_HMAC_SHA256_BASE64 = /^[A-Za-z0-9+/]{43}=$/u;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/u;

export type RemoteMcpOAuthConsentQueryErrorCode =
  | "PARAMETER_DUPLICATE"
  | "PARAMETER_MISSING"
  | "PARAMETER_UNSUPPORTED"
  | "QUERY_INVALID"
  | "QUERY_TOO_LARGE"
  | "QUERY_TOO_MANY_PARAMETERS"
  | "SIGNED_PARAMETER_INVALID";

/** Log-safe structural rejection for Better Auth's signed consent transport. */
export class RemoteMcpOAuthConsentQueryError extends Error {
  readonly code: RemoteMcpOAuthConsentQueryErrorCode;
  readonly parameter: string | undefined;
  readonly statusCode = 400 as const;

  constructor(code: RemoteMcpOAuthConsentQueryErrorCode, parameter?: string) {
    super("The Remote MCP OAuth consent query is invalid.");
    this.name = "RemoteMcpOAuthConsentQueryError";
    this.code = code;
    this.parameter = parameter;
  }
}

export interface ParseRemoteMcpOAuthConsentQueryOptions {
  /** The one canonical Remote MCP resource accepted by AlphaNet V1. */
  resource: string;
}

function fail(code: RemoteMcpOAuthConsentQueryErrorCode, parameter?: string): never {
  throw new RemoteMcpOAuthConsentQueryError(code, parameter);
}

function requireTransportParameter(
  parameters: URLSearchParams,
  name: (typeof REQUIRED_TRANSPORT_PARAMETERS)[number],
): string {
  const value = parameters.get(name);
  if (value === null || value === "") fail("PARAMETER_MISSING", name);
  return value;
}

function assertPositiveSafeInteger(value: string, parameter: "ba_iat" | "exp"): void {
  if (!POSITIVE_DECIMAL_INTEGER.test(value)) {
    fail("SIGNED_PARAMETER_INVALID", parameter);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail("SIGNED_PARAMETER_INVALID", parameter);
  }
}

function validateSignedTransport(parameters: URLSearchParams): void {
  const entries = [...parameters.entries()];
  if (entries.length === 0) fail("QUERY_INVALID");
  if (entries.length > REMOTE_MCP_OAUTH_CONSENT_QUERY_MAX_PARAMETERS) {
    fail("QUERY_TOO_MANY_PARAMETERS");
  }

  const seen = new Set<string>();
  for (const [name] of entries) {
    if (!SIGNED_TRANSPORT_PARAMETERS.has(name)) {
      fail("PARAMETER_UNSUPPORTED", name);
    }
    if (seen.has(name)) {
      fail("PARAMETER_DUPLICATE", name);
    }
    seen.add(name);
  }

  for (const name of REQUIRED_TRANSPORT_PARAMETERS) {
    requireTransportParameter(parameters, name);
  }

  const signature = requireTransportParameter(parameters, "sig");
  if (!BETTER_AUTH_HMAC_SHA256_BASE64.test(signature)) {
    fail("SIGNED_PARAMETER_INVALID", "sig");
  }
  const expiresAt = requireTransportParameter(parameters, "exp");
  const issuedAt = requireTransportParameter(parameters, "ba_iat");
  assertPositiveSafeInteger(expiresAt, "exp");
  assertPositiveSafeInteger(issuedAt, "ba_iat");

  const postLoginSession = parameters.get("ba_pl");
  if (
    postLoginSession !== null &&
    (postLoginSession.length > 512 || !PRINTABLE_ASCII.test(postLoginSession))
  ) {
    fail("SIGNED_PARAMETER_INVALID", "ba_pl");
  }
}

function extractAuthorizeParameters(parameters: URLSearchParams): URLSearchParams {
  const authorization = new URLSearchParams();
  for (const name of STANDARD_AUTHORIZE_PARAMETERS) {
    const value = parameters.get(name);
    if (value !== null) authorization.set(name, value);
  }
  return authorization;
}

/**
 * Parse the exact signed-query shape emitted by @better-auth/oauth-provider
 * 1.7.0-beta.4 for its consent redirect. Cryptographic verification remains at the
 * Better Auth consent endpoint; this parser prevents unsigned or extension
 * fields from entering AlphaNet's authorization-request binding.
 */
export function parseRemoteMcpOAuthConsentQuery(
  oauthQuery: string,
  options: ParseRemoteMcpOAuthConsentQueryOptions,
): ValidatedRemoteMcpAuthorizeQuery {
  if (
    typeof oauthQuery !== "string" ||
    oauthQuery.length === 0 ||
    Buffer.byteLength(oauthQuery, "utf8") > REMOTE_MCP_OAUTH_QUERY_MAX_BYTES
  ) {
    fail(oauthQuery.length === 0 ? "QUERY_INVALID" : "QUERY_TOO_LARGE");
  }

  const parameters = new URLSearchParams(oauthQuery);
  validateSignedTransport(parameters);
  const authorization = extractAuthorizeParameters(parameters);
  return validateRemoteMcpAuthorizeQuery(authorization, {
    resource: options.resource,
  });
}
