import { createHmac } from "node:crypto";

import { AGENT_SCOPES } from "@alphanet/contracts";

/**
 * AlphaNet's Remote MCP OAuth V1 profile has one configured resource. This
 * guard deliberately does not implement RFC 8707 multi-resource requests.
 *
 * Callers must pass the original URLSearchParams (or the raw query/form
 * string). A parsed object is intentionally not accepted because it has
 * already lost duplicate-parameter information.
 */
export type RemoteMcpOAuthRawParameters = string | URLSearchParams;

export const REMOTE_MCP_OAUTH_SCOPE_ORDER = [...AGENT_SCOPES, "offline_access"] as const;

export type RemoteMcpOAuthScope = (typeof REMOTE_MCP_OAUTH_SCOPE_ORDER)[number];

export type RemoteMcpOAuthGuardErrorCode =
  | "CLIENT_AUTH_AMBIGUOUS"
  | "CLIENT_AUTH_INVALID"
  | "CLIENT_AUTH_REPEATED"
  | "CLIENT_ID_INVALID"
  | "FLOW_DIGEST_KEY_INVALID"
  | "GRANT_TYPE_UNSUPPORTED"
  | "OPAQUE_VALUE_INVALID"
  | "PARAMETER_DUPLICATE"
  | "PARAMETER_MISSING"
  | "PARAMETER_UNSUPPORTED"
  | "PKCE_CHALLENGE_INVALID"
  | "PKCE_METHOD_UNSUPPORTED"
  | "PKCE_VERIFIER_INVALID"
  | "REDIRECT_URI_INVALID"
  | "RESOURCE_INVALID"
  | "RESOURCE_MISMATCH"
  | "REFRESH_AUTHORITY_INVALID"
  | "REFRESH_LOCK_BYPASSED"
  | "RESPONSE_TYPE_UNSUPPORTED"
  | "SCOPE_INVALID";

export type RemoteMcpOAuthProtocolError =
  | "invalid_client"
  | "invalid_grant"
  | "invalid_request"
  | "invalid_scope"
  | "unsupported_grant_type"
  | "unsupported_response_type";

interface RemoteMcpOAuthGuardErrorOptions {
  code: RemoteMcpOAuthGuardErrorCode;
  message: string;
  oauthError: RemoteMcpOAuthProtocolError;
  parameter?: string;
  statusCode?: 400 | 401 | 500;
}

/** A log-safe protocol error. It never includes a client-supplied value. */
export class RemoteMcpOAuthGuardError extends Error {
  readonly code: RemoteMcpOAuthGuardErrorCode;
  readonly oauthError: RemoteMcpOAuthProtocolError;
  readonly parameter: string | undefined;
  readonly statusCode: 400 | 401 | 500;

  constructor(options: RemoteMcpOAuthGuardErrorOptions) {
    super(options.message);
    this.name = "RemoteMcpOAuthGuardError";
    this.code = options.code;
    this.oauthError = options.oauthError;
    this.parameter = options.parameter;
    this.statusCode = options.statusCode ?? 400;
  }

  toOAuthErrorBody(): Readonly<{
    error: RemoteMcpOAuthProtocolError;
    error_description: string;
  }> {
    return {
      error: this.oauthError,
      error_description: this.message,
    };
  }
}

export interface RemoteMcpOAuthGuardOptions {
  /** The only MCP resource accepted by the V1 authorization server. */
  resource: string;
  /** Testable clock used only for refresh authority/absolute-expiry checks. */
  now?: Date;
}

export interface ValidatedRemoteMcpAuthorizeQuery {
  clientId: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  /** Stable provider-order serialization of requestedScopes. */
  canonicalScope: string;
  redirectUri: string;
  requestedScopes: readonly RemoteMcpOAuthScope[];
  resource: string;
  responseType: "code";
}

interface ValidatedRemoteMcpTokenFormBase {
  clientId?: string;
  resource: string;
}

export type RemoteMcpOAuthClientAuthenticationMethod =
  "client_secret_basic" | "client_secret_post" | "none";

export type ValidatedRemoteMcpTokenRequest =
  | (Omit<ValidatedRemoteMcpAuthorizationCodeTokenForm, "clientId"> & {
      clientAuthenticationMethod: RemoteMcpOAuthClientAuthenticationMethod;
      clientId: string;
    })
  | (Omit<ValidatedRemoteMcpRefreshTokenForm, "clientId"> & {
      clientAuthenticationMethod: RemoteMcpOAuthClientAuthenticationMethod;
      clientId: string;
    });

export interface RemoteMcpOAuthRawTokenRequest {
  /**
   * Every raw Authorization header field-value, before a framework joins or
   * overwrites duplicates. A joined value containing a comma is rejected too.
   */
  authorizationHeaders: readonly string[];
  parameters: RemoteMcpOAuthRawParameters;
}

export interface RemoteMcpRefreshLockedAuthority {
  clientEnabled: boolean;
  clientId: string;
  /** Frozen domain scopes on the oauth_grant Credential (no offline_access). */
  credentialScopes: readonly string[];
  credentialResource: string;
  credentialExpiresAt: Date;
  credentialRevokedAt: Date | null;
  credentialId: string;
  grantExpiresAt: Date;
  grantId: string;
  grantResource: string;
  grantStatus: "active" | "compromised" | "expired" | "pending" | "revoked";
  /** Full protocol scope set, including offline_access when granted. */
  grantScopes: readonly string[];
  /** Full scope set on the refresh-token row. */
  originalRefreshTokenScopes: readonly string[];
  ownerId: string;
  refreshTokenExpiresAt: Date;
  refreshTokenIssuedAt: Date;
  refreshTokenRevokedAt: Date | null;
}

export interface RemoteMcpSensitiveRefreshLockInput {
  clientId: string;
  /** Raw bearer secret. It must never be logged or persisted in plaintext. */
  refreshToken: string;
  resource: string;
}

export interface RemoteMcpOwnerClientRefreshLock {
  /**
   * The implementation must resolve the token and acquire its Owner+Client
   * advisory lock before calling executeWhileLocked. A revoked-token replay
   * must invalidate the whole Owner+Client refresh family and reject without
   * calling executeWhileLocked.
   */
  <Result>(
    input: RemoteMcpSensitiveRefreshLockInput,
    executeWhileLocked: (authority: RemoteMcpRefreshLockedAuthority) => Promise<Result>,
  ): Promise<Result>;
}

export interface ValidatedRemoteMcpAuthorizationCodeTokenForm extends ValidatedRemoteMcpTokenFormBase {
  grantType: "authorization_code";
  redirectUri: string;
}

export interface ValidatedRemoteMcpRefreshTokenForm extends ValidatedRemoteMcpTokenFormBase {
  canonicalScope?: string;
  grantType: "refresh_token";
  requestedScopes?: readonly RemoteMcpOAuthScope[];
}

export type ValidatedRemoteMcpTokenForm =
  ValidatedRemoteMcpAuthorizationCodeTokenForm | ValidatedRemoteMcpRefreshTokenForm;

export interface RemoteMcpAuthorizationBindingInput {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  requestedScopes: readonly string[];
}

export interface RemoteMcpAuthorizationRequestEnvelopeInput extends RemoteMcpAuthorizationBindingInput {
  resource: string;
}

/** DB-ready, non-secret fields for platform.oauth_authorization_requests. */
export interface RemoteMcpAuthorizationRequestEnvelope {
  bindingDigest: Buffer;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  oauthClientId: string;
  redirectUri: string;
  requestedScopes: readonly RemoteMcpOAuthScope[];
  resource: string;
}

const AUTHORIZE_PARAMETERS = new Set([
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

const AUTHORIZATION_CODE_TOKEN_PARAMETERS = new Set([
  "client_id",
  "client_secret",
  "code",
  "code_verifier",
  "grant_type",
  "redirect_uri",
  "resource",
]);

const REFRESH_TOKEN_PARAMETERS = new Set([
  "client_id",
  "client_secret",
  "grant_type",
  "refresh_token",
  "resource",
  "scope",
]);

const SUPPORTED_PROMPTS = new Set([
  "consent",
  "create",
  "login",
  "login consent",
  "none",
  "select_account",
  "select_account consent",
]);

const REMOTE_MCP_SCOPE_SET: ReadonlySet<string> = new Set(REMOTE_MCP_OAUTH_SCOPE_ORDER);
const REMOTE_MCP_SCOPE_INDEX = new Map<string, number>(
  REMOTE_MCP_OAUTH_SCOPE_ORDER.map((scope, index) => [scope, index]),
);

const WHITESPACE = /\s/u;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/u;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;
const BASIC_CREDENTIALS = /^Basic ([A-Za-z0-9+/]+={0,2})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FLOW_DIGEST_DOMAIN = "alphanet:remote-mcp-oauth:authorization-request-binding:v1\0";

function containsControlOrWhitespace(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      WHITESPACE.test(character)
    );
  });
}

function fail(
  code: RemoteMcpOAuthGuardErrorCode,
  oauthError: RemoteMcpOAuthProtocolError,
  message: string,
  parameter?: string,
  statusCode?: 400 | 401 | 500,
): never {
  throw new RemoteMcpOAuthGuardError({
    code,
    message,
    oauthError,
    ...(parameter === undefined ? {} : { parameter }),
    ...(statusCode === undefined ? {} : { statusCode }),
  });
}

function parseRawParameters(input: RemoteMcpOAuthRawParameters): URLSearchParams {
  if (typeof input === "string") {
    return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
  }
  return new URLSearchParams(input);
}

function assertNoDuplicateParameters(parameters: URLSearchParams): void {
  const seen = new Set<string>();
  for (const [name] of parameters) {
    if (seen.has(name)) {
      fail(
        "PARAMETER_DUPLICATE",
        "invalid_request",
        "An OAuth parameter was supplied more than once.",
        name,
      );
    }
    seen.add(name);
  }
}

function assertAllowedParameters(
  parameters: URLSearchParams,
  allowed: ReadonlySet<string>,
): void {
  for (const [name] of parameters) {
    if (!allowed.has(name)) {
      fail(
        "PARAMETER_UNSUPPORTED",
        "invalid_request",
        "The OAuth request contains an unsupported parameter.",
        name,
      );
    }
  }
}

function requireParameter(parameters: URLSearchParams, name: string): string {
  const value = parameters.get(name);
  if (value === null) {
    fail(
      "PARAMETER_MISSING",
      "invalid_request",
      "A required OAuth parameter is missing.",
      name,
    );
  }
  return value;
}

function clientIdIsValid(value: string): boolean {
  return !(
    value.length < 1 ||
    value.length > 200 ||
    Buffer.byteLength(value, "utf8") > 200 ||
    !PRINTABLE_ASCII.test(value)
  );
}

function validateClientId(value: string): string {
  if (!clientIdIsValid(value)) {
    fail(
      "CLIENT_ID_INVALID",
      "invalid_request",
      "The OAuth client identifier is invalid.",
      "client_id",
    );
  }
  return value;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function parseAbsoluteUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function validateRedirectUri(value: string): string {
  if (
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > 2_048 ||
    containsControlOrWhitespace(value) ||
    value.includes("#")
  ) {
    fail(
      "REDIRECT_URI_INVALID",
      "invalid_request",
      "The OAuth redirect URI is invalid.",
      "redirect_uri",
    );
  }

  const url = parseAbsoluteUrl(value);
  if (
    !url ||
    url.username !== "" ||
    url.password !== "" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopbackHost(url.hostname)))
  ) {
    fail(
      "REDIRECT_URI_INVALID",
      "invalid_request",
      "The OAuth redirect URI is invalid.",
      "redirect_uri",
    );
  }

  // Preserve the exact registered URI. URL normalization must not weaken the
  // redirect comparison or the authorization-request binding digest.
  return value;
}

function validateFixedResource(value: string): string {
  const url = parseAbsoluteUrl(value);
  const schemeSeparator = value.indexOf("://");
  const explicitPath =
    schemeSeparator >= 0 && value.indexOf("/", schemeSeparator + 3) >= 0;

  if (
    value.length < 1 ||
    value.length > 500 ||
    Buffer.byteLength(value, "utf8") > 500 ||
    containsControlOrWhitespace(value) ||
    value.includes("?") ||
    value.includes("#") ||
    !url ||
    !explicitPath ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/mcp" ||
    url.toString() !== value ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopbackHost(url.hostname)))
  ) {
    fail(
      "RESOURCE_INVALID",
      "invalid_request",
      "The configured Remote MCP resource is invalid.",
      "resource",
    );
  }
  return value;
}

function validateResource(suppliedResource: string, configuredResource: string): string {
  const resource = validateFixedResource(configuredResource);
  if (suppliedResource !== resource) {
    fail(
      "RESOURCE_MISMATCH",
      "invalid_request",
      "The requested resource does not match the Remote MCP resource.",
      "resource",
    );
  }
  return resource;
}

function normalizeScopesFromValues(
  scopeValues: readonly string[],
): readonly RemoteMcpOAuthScope[] {
  if (
    scopeValues.length < 1 ||
    scopeValues.length > REMOTE_MCP_OAUTH_SCOPE_ORDER.length
  ) {
    fail(
      "SCOPE_INVALID",
      "invalid_scope",
      "The requested OAuth scope set is invalid.",
      "scope",
    );
  }

  const unique = new Set(scopeValues);
  if (
    unique.size !== scopeValues.length ||
    scopeValues.some((scope) => !REMOTE_MCP_SCOPE_SET.has(scope)) ||
    !scopeValues.some((scope) => scope !== "offline_access")
  ) {
    fail(
      "SCOPE_INVALID",
      "invalid_scope",
      "The requested OAuth scope set is invalid.",
      "scope",
    );
  }

  const normalized = [...scopeValues]
    .sort(
      (left, right) =>
        (REMOTE_MCP_SCOPE_INDEX.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (REMOTE_MCP_SCOPE_INDEX.get(right) ?? Number.MAX_SAFE_INTEGER),
    )
    .map((scope) => scope as RemoteMcpOAuthScope);
  return Object.freeze(normalized);
}

function normalizeScopeParameter(value: string): readonly RemoteMcpOAuthScope[] {
  // OAuth scope tokens use one literal ASCII space as their separator. This
  // rejects tabs, leading/trailing spaces, and empty tokens before sorting.
  if (
    value === "" ||
    value.startsWith(" ") ||
    value.endsWith(" ") ||
    value.includes("  ") ||
    containsControlOrWhitespace(value.replaceAll(" ", ""))
  ) {
    fail(
      "SCOPE_INVALID",
      "invalid_scope",
      "The requested OAuth scope set is invalid.",
      "scope",
    );
  }
  return normalizeScopesFromValues(value.split(" "));
}

function hasNonDegenerateDistribution(value: string): boolean {
  // Randomness cannot be proven at a request boundary. The RFC minimum length
  // plus this distribution check rejects obvious constants and test values.
  return new Set(value).size >= 8;
}

function validateCodeChallenge(value: string): string {
  if (!PKCE_CHALLENGE.test(value) || !hasNonDegenerateDistribution(value)) {
    fail(
      "PKCE_CHALLENGE_INVALID",
      "invalid_request",
      "The PKCE code challenge is invalid.",
      "code_challenge",
    );
  }

  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    fail(
      "PKCE_CHALLENGE_INVALID",
      "invalid_request",
      "The PKCE code challenge is invalid.",
      "code_challenge",
    );
  }
  return value;
}

function validateCodeVerifier(value: string): void {
  if (!PKCE_VERIFIER.test(value) || !hasNonDegenerateDistribution(value)) {
    fail(
      "PKCE_VERIFIER_INVALID",
      "invalid_request",
      "The PKCE code verifier is invalid.",
      "code_verifier",
    );
  }
}

function validateOpaqueValue(
  value: string,
  parameter: string,
  maximumBytes: number,
): void {
  if (
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    !PRINTABLE_ASCII.test(value)
  ) {
    fail(
      "OPAQUE_VALUE_INVALID",
      "invalid_request",
      "An opaque OAuth parameter is invalid.",
      parameter,
    );
  }
}

function optionalValidatedClientId(
  parameters: URLSearchParams,
): Readonly<{ clientId?: string }> {
  const value = parameters.get("client_id");
  return value === null ? {} : { clientId: validateClientId(value) };
}

function parseBasicClientAuthentication(header: string): string {
  const match = BASIC_CREDENTIALS.exec(header);
  if (!match?.[1] || header.includes(",")) {
    fail(
      "CLIENT_AUTH_INVALID",
      "invalid_client",
      "The OAuth client authentication is invalid.",
      "authorization",
      401,
    );
  }
  const encoded = match[1];
  let decoded: string;
  try {
    const bytes = Buffer.from(encoded, "base64");
    const canonical = bytes.toString("base64");
    if (
      bytes.byteLength < 3 ||
      (encoded !== canonical && encoded !== canonical.replace(/=+$/u, ""))
    ) {
      throw new Error("non-canonical base64");
    }
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(
      "CLIENT_AUTH_INVALID",
      "invalid_client",
      "The OAuth client authentication is invalid.",
      "authorization",
      401,
    );
  }
  const separator = decoded.indexOf(":");
  if (separator <= 0 || separator === decoded.length - 1) {
    fail(
      "CLIENT_AUTH_INVALID",
      "invalid_client",
      "The OAuth client authentication is invalid.",
      "authorization",
      401,
    );
  }
  const clientId = decoded.slice(0, separator);
  const clientSecret = decoded.slice(separator + 1);
  if (
    !clientIdIsValid(clientId) ||
    Buffer.byteLength(clientSecret, "utf8") > 4_096 ||
    !PRINTABLE_ASCII.test(clientSecret)
  ) {
    fail(
      "CLIENT_AUTH_INVALID",
      "invalid_client",
      "The OAuth client authentication is invalid.",
      "authorization",
      401,
    );
  }
  return clientId;
}

function validateClientAuthentication(
  parameters: URLSearchParams,
  authorizationHeaders: readonly string[],
): Readonly<{
  clientAuthenticationMethod: RemoteMcpOAuthClientAuthenticationMethod;
  clientId: string;
}> {
  if (authorizationHeaders.length > 1) {
    fail(
      "CLIENT_AUTH_REPEATED",
      "invalid_request",
      "OAuth client authentication was supplied more than once.",
      "authorization",
    );
  }
  const authorization = authorizationHeaders[0];
  const bodyClientId = parameters.get("client_id");
  const bodyClientSecret = parameters.get("client_secret");
  if (authorization !== undefined) {
    if (bodyClientId !== null || bodyClientSecret !== null) {
      fail(
        "CLIENT_AUTH_AMBIGUOUS",
        "invalid_request",
        "OAuth client authentication methods cannot be combined.",
        "authorization",
      );
    }
    return {
      clientAuthenticationMethod: "client_secret_basic",
      clientId: parseBasicClientAuthentication(authorization),
    };
  }
  if (bodyClientId === null) {
    fail(
      "CLIENT_AUTH_INVALID",
      "invalid_client",
      "The OAuth client identifier is required.",
      "client_id",
      401,
    );
  }
  const clientId = validateClientId(bodyClientId);
  if (bodyClientSecret === null) {
    return { clientAuthenticationMethod: "none", clientId };
  }
  validateOpaqueValue(bodyClientSecret, "client_secret", 4_096);
  return { clientAuthenticationMethod: "client_secret_post", clientId };
}

/**
 * Validate the raw /oauth2/authorize query before Better Auth parses it.
 * PAR/request_uri and OIDC-only extras are deliberately unsupported in V1.
 */
export function validateRemoteMcpAuthorizeQuery(
  input: RemoteMcpOAuthRawParameters,
  options: RemoteMcpOAuthGuardOptions,
): ValidatedRemoteMcpAuthorizeQuery {
  const parameters = parseRawParameters(input);
  assertNoDuplicateParameters(parameters);
  assertAllowedParameters(parameters, AUTHORIZE_PARAMETERS);

  const responseType = requireParameter(parameters, "response_type");
  if (responseType !== "code") {
    fail(
      "RESPONSE_TYPE_UNSUPPORTED",
      "unsupported_response_type",
      "Only the authorization code response type is supported.",
      "response_type",
    );
  }

  const clientId = validateClientId(requireParameter(parameters, "client_id"));
  const redirectUri = validateRedirectUri(requireParameter(parameters, "redirect_uri"));
  const requestedScopes = normalizeScopeParameter(requireParameter(parameters, "scope"));
  const resource = validateResource(
    requireParameter(parameters, "resource"),
    options.resource,
  );

  const codeChallengeMethod = requireParameter(parameters, "code_challenge_method");
  if (codeChallengeMethod !== "S256") {
    fail(
      "PKCE_METHOD_UNSUPPORTED",
      "invalid_request",
      "Only the S256 PKCE method is supported.",
      "code_challenge_method",
    );
  }
  const codeChallenge = validateCodeChallenge(
    requireParameter(parameters, "code_challenge"),
  );

  const state = parameters.get("state");
  if (state !== null) {
    validateOpaqueValue(state, "state", 1_024);
  }
  const prompt = parameters.get("prompt");
  if (prompt !== null && !SUPPORTED_PROMPTS.has(prompt)) {
    fail(
      "PARAMETER_UNSUPPORTED",
      "invalid_request",
      "The OAuth prompt value is unsupported.",
      "prompt",
    );
  }

  return {
    clientId,
    codeChallenge,
    codeChallengeMethod: "S256",
    canonicalScope: requestedScopes.join(" "),
    redirectUri,
    requestedScopes,
    resource,
    responseType: "code",
  };
}

/** Validate the original application/x-www-form-urlencoded token body. */
export function validateRemoteMcpTokenForm(
  input: RemoteMcpOAuthRawParameters,
  options: RemoteMcpOAuthGuardOptions,
): ValidatedRemoteMcpTokenForm {
  const parameters = parseRawParameters(input);
  assertNoDuplicateParameters(parameters);

  const grantType = requireParameter(parameters, "grant_type");
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    fail(
      "GRANT_TYPE_UNSUPPORTED",
      "unsupported_grant_type",
      "Only authorization_code and refresh_token grants are supported.",
      "grant_type",
    );
  }

  const allowed =
    grantType === "authorization_code"
      ? AUTHORIZATION_CODE_TOKEN_PARAMETERS
      : REFRESH_TOKEN_PARAMETERS;
  assertAllowedParameters(parameters, allowed);

  const resource = validateResource(
    requireParameter(parameters, "resource"),
    options.resource,
  );
  const client = optionalValidatedClientId(parameters);

  const clientSecret = parameters.get("client_secret");
  if (clientSecret !== null) {
    validateOpaqueValue(clientSecret, "client_secret", 4_096);
  }

  if (grantType === "authorization_code") {
    validateOpaqueValue(requireParameter(parameters, "code"), "code", 4_096);
    validateCodeVerifier(requireParameter(parameters, "code_verifier"));
    const redirectUri = validateRedirectUri(requireParameter(parameters, "redirect_uri"));
    return {
      ...client,
      grantType: "authorization_code",
      redirectUri,
      resource,
    };
  }

  validateOpaqueValue(
    requireParameter(parameters, "refresh_token"),
    "refresh_token",
    4_096,
  );
  const scope = parameters.get("scope");
  if (scope === null) {
    return { ...client, grantType: "refresh_token", resource };
  }
  const requestedScopes = normalizeScopeParameter(scope);
  return {
    ...client,
    canonicalScope: requestedScopes.join(" "),
    grantType: "refresh_token",
    requestedScopes,
    resource,
  };
}

/**
 * Validate the raw token form together with the uncollapsed Authorization
 * header list. The returned object contains only the effective client id and
 * authentication method; no client secret, code verifier, code, or refresh
 * token crosses this boundary.
 */
export function validateRemoteMcpTokenRequest(
  input: RemoteMcpOAuthRawTokenRequest,
  options: RemoteMcpOAuthGuardOptions,
): ValidatedRemoteMcpTokenRequest {
  const parameters = parseRawParameters(input.parameters);
  const validated = validateRemoteMcpTokenForm(parameters, options);
  const client = validateClientAuthentication(parameters, input.authorizationHeaders);
  return { ...validated, ...client };
}

function sameScopeSet(
  left: readonly RemoteMcpOAuthScope[],
  right: readonly RemoteMcpOAuthScope[],
): boolean {
  return (
    left.length === right.length && left.every((scope, index) => scope === right[index])
  );
}

/**
 * V1 intentionally rejects both refresh scope narrowing and expansion. The
 * Grant and original refresh-token row must already be the same full protocol
 * scope set. An explicitly submitted scope must equal that set too.
 */
export function validateRemoteMcpExactRefreshScopes(
  form: ValidatedRemoteMcpRefreshTokenForm,
  grantScopes: readonly string[],
  originalRefreshTokenScopes: readonly string[],
): readonly RemoteMcpOAuthScope[] {
  const grant = normalizeScopesFromValues(grantScopes);
  const original = normalizeScopesFromValues(originalRefreshTokenScopes);
  if (
    !grant.includes("offline_access") ||
    !original.includes("offline_access") ||
    !sameScopeSet(grant, original)
  ) {
    fail(
      "SCOPE_INVALID",
      "invalid_scope",
      "The refresh scope set does not match the current Grant.",
      "scope",
    );
  }
  if (form.requestedScopes && !sameScopeSet(form.requestedScopes, original)) {
    fail(
      "SCOPE_INVALID",
      "invalid_scope",
      "The refresh scope set must exactly match the original Grant.",
      "scope",
    );
  }
  return original;
}

function validateLockedRefreshAuthority(
  request: ValidatedRemoteMcpTokenRequest & { grantType: "refresh_token" },
  authority: RemoteMcpRefreshLockedAuthority,
  now: Date,
): void {
  const refreshIssuedAt = authority?.refreshTokenIssuedAt?.valueOf();
  const refreshExpiresAt = authority?.refreshTokenExpiresAt?.valueOf();
  const grantExpiresAt = authority?.grantExpiresAt?.valueOf();
  const credentialExpiresAt = authority?.credentialExpiresAt?.valueOf();
  const nowValue = now.valueOf();
  if (
    !authority ||
    authority.clientEnabled !== true ||
    !UUID.test(authority.ownerId) ||
    !UUID.test(authority.grantId) ||
    !UUID.test(authority.credentialId) ||
    authority.clientId !== request.clientId ||
    authority.grantResource !== request.resource ||
    authority.credentialResource !== request.resource ||
    authority.grantStatus !== "active" ||
    authority.credentialRevokedAt !== null ||
    authority.refreshTokenRevokedAt !== null ||
    !Number.isFinite(nowValue) ||
    !Number.isFinite(refreshIssuedAt) ||
    !Number.isFinite(refreshExpiresAt) ||
    !Number.isFinite(grantExpiresAt) ||
    !Number.isFinite(credentialExpiresAt) ||
    refreshIssuedAt > nowValue ||
    refreshExpiresAt <= nowValue ||
    grantExpiresAt <= nowValue ||
    credentialExpiresAt <= nowValue ||
    refreshExpiresAt <= refreshIssuedAt ||
    refreshExpiresAt - refreshIssuedAt > 30 * 24 * 60 * 60 * 1_000 ||
    refreshExpiresAt > grantExpiresAt ||
    refreshExpiresAt > credentialExpiresAt
  ) {
    fail(
      "REFRESH_AUTHORITY_INVALID",
      "invalid_grant",
      "The refresh authority is invalid.",
      undefined,
      500,
    );
  }
  const exactScopes = validateRemoteMcpExactRefreshScopes(
    request,
    authority.grantScopes,
    authority.originalRefreshTokenScopes,
  );
  const credentialScopes = normalizeScopesFromValues(authority.credentialScopes);
  const exactDomainScopes = exactScopes.filter((scope) => scope !== "offline_access");
  if (
    credentialScopes.includes("offline_access") ||
    !sameScopeSet(credentialScopes, exactDomainScopes)
  ) {
    fail(
      "REFRESH_AUTHORITY_INVALID",
      "invalid_grant",
      "The refresh authority is invalid.",
      undefined,
      500,
    );
  }
}

/**
 * Execute the token provider only after raw request validation. Refresh
 * requests additionally require a hook that holds the Owner+Client lock while
 * it re-reads authority, calls executeWhileLocked, and awaits its result.
 */
export async function executeRemoteMcpTokenEndpointBoundary<Result>(
  input: RemoteMcpOAuthRawTokenRequest,
  options: RemoteMcpOAuthGuardOptions,
  withOwnerClientRefreshLock: RemoteMcpOwnerClientRefreshLock,
  executeProvider: (request: ValidatedRemoteMcpTokenRequest) => Promise<Result>,
): Promise<Result> {
  if (typeof withOwnerClientRefreshLock !== "function") {
    fail(
      "REFRESH_LOCK_BYPASSED",
      "invalid_grant",
      "The refresh lock boundary is unavailable.",
      undefined,
      500,
    );
  }
  const request = validateRemoteMcpTokenRequest(input, options);
  if (request.grantType !== "refresh_token") {
    return executeProvider(request);
  }

  const parameters = parseRawParameters(input.parameters);
  const refreshToken = requireParameter(parameters, "refresh_token");
  const completionMarker = Symbol("remote-mcp-refresh-provider-complete");
  let providerStarted = false;
  const lockedResult = await withOwnerClientRefreshLock(
    {
      clientId: request.clientId,
      refreshToken,
      resource: request.resource,
    },
    async (authority) => {
      if (providerStarted) {
        fail(
          "REFRESH_LOCK_BYPASSED",
          "invalid_grant",
          "The refresh provider can run only once.",
          undefined,
          500,
        );
      }
      providerStarted = true;
      validateLockedRefreshAuthority(request, authority, options.now ?? new Date());
      return {
        marker: completionMarker,
        value: await executeProvider(request),
      };
    },
  );
  if (
    !lockedResult ||
    typeof lockedResult !== "object" ||
    !("marker" in lockedResult) ||
    lockedResult.marker !== completionMarker ||
    !("value" in lockedResult)
  ) {
    fail(
      "REFRESH_LOCK_BYPASSED",
      "invalid_grant",
      "The refresh provider did not complete inside the lock.",
      undefined,
      500,
    );
  }
  return lockedResult.value;
}

/**
 * Compute the one-shot authorization-request binding. It intentionally binds
 * only non-secret protocol fields and never state, a verifier, a code, or a
 * client secret. Scope order is canonicalized before hashing.
 */
export function createRemoteMcpAuthorizationBindingDigest(
  input: RemoteMcpAuthorizationBindingInput,
  key: Uint8Array,
): Buffer {
  if (key.byteLength < 32) {
    fail(
      "FLOW_DIGEST_KEY_INVALID",
      "invalid_request",
      "The authorization-request binding key must be at least 32 bytes.",
    );
  }

  const clientId = validateClientId(input.clientId);
  const redirectUri = validateRedirectUri(input.redirectUri);
  const requestedScopes = normalizeScopesFromValues(input.requestedScopes);
  const codeChallenge = validateCodeChallenge(input.codeChallenge);
  const payload = JSON.stringify({
    client_id: clientId,
    code_challenge: codeChallenge,
    redirect_uri: redirectUri,
    scope: requestedScopes,
  });

  return createHmac("sha256", key)
    .update(FLOW_DIGEST_DOMAIN, "utf8")
    .update(payload, "utf8")
    .digest();
}

export function createRemoteMcpAuthorizationRequestEnvelope(
  input: RemoteMcpAuthorizationRequestEnvelopeInput,
  key: Uint8Array,
): RemoteMcpAuthorizationRequestEnvelope {
  const resource = validateFixedResource(input.resource);
  const oauthClientId = validateClientId(input.clientId);
  const redirectUri = validateRedirectUri(input.redirectUri);
  const requestedScopes = normalizeScopesFromValues(input.requestedScopes);
  const codeChallenge = validateCodeChallenge(input.codeChallenge);

  return {
    bindingDigest: createRemoteMcpAuthorizationBindingDigest(
      {
        clientId: oauthClientId,
        codeChallenge,
        redirectUri,
        requestedScopes,
      },
      key,
    ),
    codeChallenge,
    codeChallengeMethod: "S256",
    oauthClientId,
    redirectUri,
    requestedScopes,
    resource,
  };
}
