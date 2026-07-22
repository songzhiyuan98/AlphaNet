import { createHmac, randomUUID } from "node:crypto";

import { AGENT_SCOPES, AgentScopeSchema, type AgentScope } from "@alphanet/contracts";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { jwt } from "better-auth/plugins";
import { decodeJwt, decodeProtectedHeader, type JWTPayload } from "jose";

import {
  executeRemoteMcpTokenEndpointBoundary,
  RemoteMcpOAuthGuardError,
  validateRemoteMcpAuthorizeQuery,
  type RemoteMcpOwnerClientRefreshLock,
  type ValidatedRemoteMcpAuthorizeQuery,
} from "./remote-mcp-oauth-guard.js";

export const REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
export const REMOTE_MCP_AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
export const REMOTE_MCP_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const REMOTE_MCP_JWKS_ROTATION_SECONDS = 30 * 24 * 60 * 60;
export const REMOTE_MCP_JWKS_GRACE_SECONDS = 7 * 24 * 60 * 60;
export const REMOTE_MCP_TOKEN_REQUEST_BODY_MAX_BYTES = 16 * 1_024;
export const REMOTE_MCP_OAUTH_SCOPES = [...AGENT_SCOPES, "offline_access"] as const;

type OAuthProviderOptions = Parameters<typeof oauthProvider>[0];
type OAuthPostLogin = NonNullable<OAuthProviderOptions["postLogin"]>;
type OAuthPostLoginContext = Parameters<OAuthPostLogin["consentReferenceId"]>[0];
type OAuthAccessTokenClaimsContext = Parameters<
  NonNullable<OAuthProviderOptions["customAccessTokenClaims"]>
>[0];

export interface RemoteMcpAccessTokenAuthorityPersistenceInput {
  /** Better Auth user id. The persistence transaction must re-resolve the Owner. */
  authUserId: string;
  expiresAt: Date;
  /** Provider consent reference id. It must resolve to the current AlphaNet Grant. */
  grantId: string;
  issuedAt: Date;
  /** Raw JWT identifier. Persist only its independently keyed digest. */
  jti: string;
  resource: string;
  /** Credential/domain scopes only; offline_access is deliberately excluded. */
  scopes: readonly AgentScope[];
}

export interface RemoteMcpAccessTokenAuthorityPersistenceResult {
  credentialId: string;
  grantEpoch: number;
  /** Independently keyed digest of the exact jti persisted in the authority row. */
  tokenJtiDigest: string;
}

export interface RemoteMcpAccessTokenSigningPayload extends JWTPayload {
  aud: string;
  azp: string;
  credential_id: string;
  exp: number;
  grant_epoch: number;
  iat: number;
  iss: string;
  jti: string;
  nbf: number;
  scope: string;
  /** AlphaNet Grant id. Owner/Agent/Actor identifiers are deliberately absent. */
  sub: string;
  token_jti_digest: string;
}

export type RemoteMcpDomainRevocationOperation =
  "delete_consent" | "revoke_token" | "update_consent";

export interface RemoteMcpDomainRevocationInput {
  operation: RemoteMcpDomainRevocationOperation;
  /** Sensitive request. The transaction handler must not log its headers or body. */
  request: Request;
}

export interface AlphaNetRemoteMcpOAuthSecurityHooks {
  /**
   * Must authenticate the Owner/client and atomically revoke the Grant,
   * Credential, token epoch/JTI state, consent, audit log and outbox before
   * returning a protocol response. The native Provider delete/revoke handlers
   * are never reached for these operations.
   */
  executeDomainRevocationTransaction(
    input: RemoteMcpDomainRevocationInput,
  ): Promise<Response>;
  /**
   * Must re-read the Grant/Credential/Owner/Agent/client authority and insert
   * the JTI digest in one transaction. Returning does not merely describe a
   * token: it attests that the corresponding authority row was persisted.
   */
  persistAccessTokenAuthority(
    input: RemoteMcpAccessTokenAuthorityPersistenceInput,
  ): Promise<RemoteMcpAccessTokenAuthorityPersistenceResult>;
  /**
   * Must insert or strongly revalidate the five-minute one-shot authorization
   * envelope before Better Auth receives the initial authorize request.
   */
  persistAuthorizationRequestEnvelope(
    input: ValidatedRemoteMcpAuthorizeQuery,
  ): Promise<void>;
  /** Sign only the canonical payload supplied here using the active ES256 JWK. */
  signAccessToken(payload: RemoteMcpAccessTokenSigningPayload): Promise<string>;
  postLogin: {
    page: string;
    /** Must consume the one-shot authorization envelope and return its Grant id. */
    resolveGrantId(context: OAuthPostLoginContext): Promise<string>;
    shouldRedirect: OAuthPostLogin["shouldRedirect"];
  };
  /**
   * Must hold a cross-replica Owner+Client lock while executeWhileLocked runs.
   * Reuse of a revoked token must invalidate that Owner+Client family and
   * reject without invoking executeWhileLocked.
   */
  withOwnerClientRefreshLock: RemoteMcpOwnerClientRefreshLock;
}

export interface AlphaNetRemoteMcpOAuthProviderOptions {
  consentPage: string;
  issuer: string;
  /** JWKS published by the same ES256 signer used by security.signAccessToken. */
  jwksUrl: string;
  loginPage: string;
  resource: string;
  security: AlphaNetRemoteMcpOAuthSecurityHooks;
  tokenStorageKey: Uint8Array;
}

export interface AlphaNetRemoteMcpOAuthRawHttpRequest {
  /**
   * Every Authorization field-value from the server's raw header list. Fetch
   * Headers alone is insufficient because it collapses duplicate fields.
   */
  authorizationHeaders: readonly string[];
  request: Request;
}

export type AlphaNetRemoteMcpOAuthProviderHandler = (
  request: Request,
) => Promise<Response>;

export interface AlphaNetRemoteMcpOAuthLiveBoundary {
  /** Install these plugins before any plugin that replaces the Request object. */
  plugins: readonly [BetterAuthPlugin, BetterAuthPlugin, BetterAuthPlugin];
  /**
   * This is the only live entry point for the Better Auth handler. Directly
   * serving the handler leaves /oauth2/token blocked with 503.
   */
  wrapProviderHandler(
    providerHandler: AlphaNetRemoteMcpOAuthProviderHandler,
  ): (input: AlphaNetRemoteMcpOAuthRawHttpRequest) => Promise<Response>;
}

/**
 * Schema generation only. Plugins from this path contain a request blocker
 * and must never be installed by a live auth runtime.
 */
export interface AlphaNetRemoteMcpOAuthSchemaOnlyOptions {
  consentPage: string;
  issuer: string;
  loginPage: string;
  resource: string;
}

export const remoteMcpOAuthProviderSchema = {
  oauthAccessToken: {
    modelName: "oauth_access_tokens",
    fields: {
      clientId: "client_id",
      createdAt: "created_at",
      expiresAt: "expires_at",
      referenceId: "reference_id",
      refreshId: "refresh_id",
      scopes: "scopes",
      sessionId: "session_id",
      token: "token",
      userId: "user_id",
    },
  },
  oauthClient: {
    modelName: "oauth_clients",
    fields: {
      clientId: "client_id",
      clientSecret: "client_secret",
      contacts: "contacts",
      createdAt: "created_at",
      disabled: "disabled",
      enableEndSession: "enable_end_session",
      grantTypes: "grant_types",
      icon: "icon",
      metadata: "metadata",
      name: "name",
      policy: "policy",
      postLogoutRedirectUris: "post_logout_redirect_uris",
      public: "public",
      redirectUris: "redirect_uris",
      referenceId: "reference_id",
      requirePKCE: "require_pkce",
      responseTypes: "response_types",
      scopes: "scopes",
      skipConsent: "skip_consent",
      softwareId: "software_id",
      softwareStatement: "software_statement",
      softwareVersion: "software_version",
      subjectType: "subject_type",
      tokenEndpointAuthMethod: "token_endpoint_auth_method",
      tos: "tos",
      type: "type",
      updatedAt: "updated_at",
      uri: "uri",
      userId: "user_id",
    },
  },
  oauthConsent: {
    modelName: "oauth_consents",
    fields: {
      clientId: "client_id",
      createdAt: "created_at",
      referenceId: "reference_id",
      scopes: "scopes",
      updatedAt: "updated_at",
      userId: "user_id",
    },
  },
  oauthRefreshToken: {
    modelName: "oauth_refresh_tokens",
    fields: {
      authTime: "auth_time",
      clientId: "client_id",
      createdAt: "created_at",
      expiresAt: "expires_at",
      referenceId: "reference_id",
      revoked: "revoked",
      scopes: "scopes",
      sessionId: "session_id",
      token: "token",
      userId: "user_id",
    },
  },
} as const;

export const remoteMcpJwtSchema = {
  jwks: {
    modelName: "oauth_jwks",
    fields: {
      createdAt: "created_at",
      expiresAt: "expires_at",
      privateKey: "private_key",
      publicKey: "public_key",
    },
  },
} as const;

function validateOAuthUrl(value: string, label: string): void {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, query, or fragment`);
  }
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error(`${label} must use HTTPS except on loopback`);
  }
  if (url.toString() !== value) {
    throw new Error(`${label} must use its canonical URL serialization`);
  }
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  );
}

function assertSecurityHooks(security: AlphaNetRemoteMcpOAuthSecurityHooks): void {
  if (
    !security ||
    typeof security.executeDomainRevocationTransaction !== "function" ||
    typeof security.persistAccessTokenAuthority !== "function" ||
    typeof security.persistAuthorizationRequestEnvelope !== "function" ||
    !security.postLogin ||
    typeof security.postLogin.page !== "string" ||
    security.postLogin.page.length < 1 ||
    typeof security.postLogin.resolveGrantId !== "function" ||
    typeof security.postLogin.shouldRedirect !== "function" ||
    typeof security.signAccessToken !== "function" ||
    typeof security.withOwnerClientRefreshLock !== "function"
  ) {
    throw new Error("Remote MCP OAuth live security hooks are incomplete");
  }
}

function isTokenJtiDigest(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}

function normalizeAuthorityScopes(scopes: readonly string[]): readonly AgentScope[] {
  const result: AgentScope[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (seen.has(scope)) {
      throw new Error("Remote MCP OAuth access-token scopes are invalid");
    }
    seen.add(scope);
    if (scope === "offline_access") {
      continue;
    }
    const parsed = AgentScopeSchema.safeParse(scope);
    if (!parsed.success) {
      throw new Error("Remote MCP OAuth access-token scopes are invalid");
    }
    result.push(parsed.data);
  }
  if (result.length < 1) {
    throw new Error("Remote MCP OAuth access-token scopes are invalid");
  }
  return Object.freeze(result);
}

function createLiveAccessTokenClaims(
  options: AlphaNetRemoteMcpOAuthProviderOptions,
): NonNullable<OAuthProviderOptions["customAccessTokenClaims"]> {
  return (context: OAuthAccessTokenClaimsContext) => {
    return Promise.resolve().then(() => {
      if (
        !context.user ||
        !isUuid(context.user.id) ||
        !isUuid(context.referenceId) ||
        context.resource !== options.resource
      ) {
        throw new Error("Remote MCP OAuth token authority is unavailable");
      }
      normalizeAuthorityScopes(context.scopes);
      return {
        grant_id: context.referenceId,
        jti: randomUUID(),
      };
    });
  };
}

const ACCESS_TOKEN_PAYLOAD_KEYS = [
  "aud",
  "azp",
  "credential_id",
  "exp",
  "grant_epoch",
  "iat",
  "iss",
  "jti",
  "nbf",
  "scope",
  "sub",
  "token_jti_digest",
] as const;

interface ValidatedProviderAccessTokenSeed {
  authUserId: string;
  azp: string;
  exp: number;
  grantId: string;
  iat: number;
  jti: string;
  protocolScopes: readonly string[];
  scopes: readonly AgentScope[];
}

function validateProviderAccessTokenSeed(
  payload: JWTPayload,
  options: AlphaNetRemoteMcpOAuthProviderOptions,
): ValidatedProviderAccessTokenSeed {
  const grantId = payload["grant_id"];
  const azp = payload["azp"];
  const scope = payload["scope"];
  if (
    !isUuid(grantId) ||
    payload["credential_id"] !== undefined ||
    payload["grant_epoch"] !== undefined ||
    payload["token_jti_digest"] !== undefined ||
    !isUuid(payload.sub) ||
    !isUuid(payload.jti) ||
    payload.iss !== options.issuer ||
    payload.aud !== options.resource ||
    typeof azp !== "string" ||
    azp.length < 1 ||
    azp.length > 200 ||
    !/^[\x21-\x7e]+$/u.test(azp) ||
    typeof scope !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    payload.iat <= 0 ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat !== REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS
  ) {
    throw new Error("Remote MCP OAuth access-token signing payload is invalid");
  }
  const protocolScopes = scope.split(" ");
  const scopes = normalizeAuthorityScopes(protocolScopes);
  return {
    authUserId: payload.sub,
    azp,
    exp: payload.exp,
    grantId,
    iat: payload.iat,
    jti: payload.jti,
    protocolScopes: Object.freeze(protocolScopes),
    scopes,
  };
}

function canonicalAccessTokenSigningPayload(
  seed: ValidatedProviderAccessTokenSeed,
  authority: RemoteMcpAccessTokenAuthorityPersistenceResult,
  options: AlphaNetRemoteMcpOAuthProviderOptions,
): RemoteMcpAccessTokenSigningPayload {
  if (
    !authority ||
    !isUuid(authority.credentialId) ||
    !Number.isSafeInteger(authority.grantEpoch) ||
    authority.grantEpoch <= 0 ||
    !isTokenJtiDigest(authority.tokenJtiDigest)
  ) {
    throw new Error("Remote MCP OAuth token authority persistence failed");
  }
  return {
    aud: options.resource,
    azp: seed.azp,
    credential_id: authority.credentialId,
    exp: seed.exp,
    grant_epoch: authority.grantEpoch,
    iat: seed.iat,
    iss: options.issuer,
    jti: seed.jti,
    nbf: seed.iat,
    scope: seed.protocolScopes.join(" "),
    sub: seed.grantId,
    token_jti_digest: authority.tokenJtiDigest,
  };
}

function accessTokenPayloadMatches(
  expected: RemoteMcpAccessTokenSigningPayload,
  actual: JWTPayload,
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = [...ACCESS_TOKEN_PAYLOAD_KEYS].sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    ACCESS_TOKEN_PAYLOAD_KEYS.every((key) => actual[key] === expected[key])
  );
}

function createLiveJwtSigner(
  options: AlphaNetRemoteMcpOAuthProviderOptions,
): (payload: JWTPayload) => Promise<string> {
  return async (payload) => {
    const seed = validateProviderAccessTokenSeed(payload, options);
    const authority = await options.security.persistAccessTokenAuthority({
      authUserId: seed.authUserId,
      expiresAt: new Date(seed.exp * 1_000),
      grantId: seed.grantId,
      issuedAt: new Date(seed.iat * 1_000),
      jti: seed.jti,
      resource: options.resource,
      scopes: seed.scopes,
    });
    const canonical = Object.freeze(
      canonicalAccessTokenSigningPayload(seed, authority, options),
    );
    const token = await options.security.signAccessToken(canonical);
    if (typeof token !== "string" || token.length < 1 || token.length > 16_384) {
      throw new Error("Remote MCP OAuth access-token signer failed");
    }
    try {
      const segments = token.split(".");
      const signature = segments[2];
      const header = decodeProtectedHeader(token);
      const signedPayload = decodeJwt(token);
      const headerKeys = Object.keys(header).sort();
      const signatureBytes =
        typeof signature === "string"
          ? Buffer.from(signature, "base64url")
          : Buffer.alloc(0);
      if (
        segments.length !== 3 ||
        typeof signature !== "string" ||
        signatureBytes.byteLength !== 64 ||
        signatureBytes.toString("base64url") !== signature ||
        headerKeys.length !== 3 ||
        headerKeys[0] !== "alg" ||
        headerKeys[1] !== "kid" ||
        headerKeys[2] !== "typ" ||
        header.alg !== "ES256" ||
        header.typ !== "JWT" ||
        typeof header.kid !== "string" ||
        header.kid.length < 1 ||
        header.kid.length > 200 ||
        !/^[\x21-\x7e]+$/u.test(header.kid) ||
        !accessTokenPayloadMatches(canonical, signedPayload)
      ) {
        throw new Error("signed token does not match canonical payload");
      }
    } catch {
      throw new Error("Remote MCP OAuth access-token signer failed");
    }
    return token;
  };
}

function createLivePostLogin(
  security: AlphaNetRemoteMcpOAuthSecurityHooks,
): OAuthPostLogin {
  return {
    consentReferenceId: async (context) => {
      const grantId = await security.postLogin.resolveGrantId(context);
      if (!isUuid(grantId)) {
        throw new Error("Remote MCP OAuth consent Grant is unavailable");
      }
      return grantId;
    },
    page: security.postLogin.page,
    shouldRedirect: security.postLogin.shouldRedirect,
  };
}

function oauthRelativePath(pathname: string, issuer: string): string | undefined {
  const issuerUrl = new URL(issuer);
  const basePath = issuerUrl.pathname.replace(/\/+$/u, "");
  return pathname.startsWith(`${basePath}/`)
    ? pathname.slice(basePath.length)
    : undefined;
}

function domainOperation(
  relativePath: string | undefined,
): RemoteMcpDomainRevocationOperation | undefined {
  switch (relativePath) {
    case "/oauth2/delete-consent":
      return "delete_consent";
    case "/oauth2/revoke":
      return "revoke_token";
    case "/oauth2/update-consent":
      // Provider 1.6.23 implements update as deletion; it must use the same
      // AlphaNet revoke transaction instead of the native endpoint.
      return "update_consent";
    default:
      return undefined;
  }
}

function createDomainBoundaryPlugin(
  options: AlphaNetRemoteMcpOAuthProviderOptions,
  requestAdmissions: WeakSet<Request>,
): BetterAuthPlugin {
  const issuer = new URL(options.issuer);
  return {
    id: "alphanet-remote-mcp-domain-boundary",
    async onRequest(request) {
      const requestUrl = new URL(request.url);
      const relativePath = oauthRelativePath(requestUrl.pathname, options.issuer);
      if (relativePath === "/oauth2/introspect") {
        return {
          response: new Response(null, {
            headers: { "Cache-Control": "no-store" },
            status: 503,
          }),
        };
      }
      if (relativePath === "/oauth2/authorize" || relativePath === "/oauth2/token") {
        if (requestUrl.origin !== issuer.origin || !requestAdmissions.delete(request)) {
          return {
            response: new Response(null, {
              headers: { "Cache-Control": "no-store" },
              status: 503,
            }),
          };
        }
        return;
      }
      if (requestUrl.origin !== issuer.origin) {
        return;
      }
      const operation = domainOperation(relativePath);
      if (!operation) {
        return;
      }
      const response = await options.security.executeDomainRevocationTransaction({
        operation,
        request,
      });
      if (!(response instanceof Response)) {
        throw new Error("Remote MCP OAuth domain revocation did not return a response");
      }
      return { response };
    },
  };
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((element: unknown) => typeof element === "string")
  );
}

function assertRawAuthorizationHeaderSnapshot(
  request: Request,
  authorizationHeaders: unknown,
): asserts authorizationHeaders is readonly string[] {
  if (!isStringArray(authorizationHeaders)) {
    throw new Error("Remote MCP OAuth raw Authorization headers are unavailable");
  }
  // Repeated fields are intentionally left to the protocol guard so it can
  // return its stable invalid_request response without exposing their values.
  if (authorizationHeaders.length > 1) {
    return;
  }
  const collapsed = request.headers.get("authorization");
  const raw = authorizationHeaders[0] ?? null;
  if (collapsed !== raw) {
    throw new Error("Remote MCP OAuth raw Authorization headers are unavailable");
  }
}

class RemoteMcpOAuthTokenBodyTooLargeError extends Error {
  constructor() {
    super("Remote MCP OAuth token request body is too large");
    this.name = "RemoteMcpOAuthTokenBodyTooLargeError";
  }
}

interface BoundedRemoteMcpTokenRequest {
  parameters: string;
  providerRequest: Request;
}

function rebuildTokenRequest(request: Request, body: Uint8Array<ArrayBuffer>): Request {
  const headers = new Headers(request.headers);
  // Never forward attacker-declared framing for the bounded in-memory body.
  headers.delete("Content-Length");
  headers.delete("Transfer-Encoding");
  const bodyBuffer =
    body.byteLength > 0
      ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
      : null;
  return new Request(request.url, {
    body: bodyBuffer,
    headers,
    method: request.method,
    signal: request.signal,
  });
}

async function readBoundedTokenRequestBody(
  request: Request,
): Promise<BoundedRemoteMcpTokenRequest> {
  const clonedBody = request.clone().body;
  if (!clonedBody) {
    return {
      parameters: "",
      providerRequest: rebuildTokenRequest(request, new Uint8Array()),
    };
  }
  const reader = clonedBody.getReader();
  const chunks: Uint8Array[] = [];
  let actualBytesRead = 0;
  try {
    while (true) {
      const result: unknown = await reader.read();
      if (!isUnknownRecord(result) || typeof result["done"] !== "boolean") {
        throw new Error("Remote MCP OAuth token request body stream is invalid");
      }
      if (result["done"]) {
        const body = new Uint8Array(actualBytesRead);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        if (request.body) {
          await Promise.allSettled([request.body.cancel()]);
        }
        return {
          parameters: new TextDecoder().decode(body),
          providerRequest: rebuildTokenRequest(request, body),
        };
      }
      const value = result["value"];
      if (!(value instanceof Uint8Array)) {
        throw new Error("Remote MCP OAuth token request body stream is invalid");
      }
      if (value.byteLength > REMOTE_MCP_TOKEN_REQUEST_BODY_MAX_BYTES - actualBytesRead) {
        const cancellations: Promise<unknown>[] = [reader.cancel()];
        if (request.body) {
          cancellations.push(request.body.cancel());
        }
        await Promise.allSettled(cancellations);
        throw new RemoteMcpOAuthTokenBodyTooLargeError();
      }
      actualBytesRead += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function tokenBodyTooLargeResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "invalid_request",
      error_description: "The OAuth token request body is too large.",
    }),
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        Pragma: "no-cache",
      },
      status: 413,
    },
  );
}

function guardErrorResponse(error: RemoteMcpOAuthGuardError): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    Pragma: "no-cache",
  });
  if (error.oauthError === "invalid_client" && error.statusCode === 401) {
    headers.set("WWW-Authenticate", 'Basic realm="AlphaNet Remote MCP OAuth"');
  }
  return new Response(JSON.stringify(error.toOAuthErrorBody()), {
    headers,
    status: error.statusCode,
  });
}

function wrapLiveProviderHandler(
  options: AlphaNetRemoteMcpOAuthProviderOptions,
  requestAdmissions: WeakSet<Request>,
  providerHandler: AlphaNetRemoteMcpOAuthProviderHandler,
): (input: AlphaNetRemoteMcpOAuthRawHttpRequest) => Promise<Response> {
  if (typeof providerHandler !== "function") {
    throw new Error("Remote MCP OAuth provider handler is unavailable");
  }
  const issuer = new URL(options.issuer);
  return async ({ authorizationHeaders, request }) => {
    const requestUrl = new URL(request.url);
    const relativePath = oauthRelativePath(requestUrl.pathname, options.issuer);
    const isCanonicalAuthorizeRequest =
      requestUrl.origin === issuer.origin &&
      relativePath === "/oauth2/authorize" &&
      request.method === "GET";
    if (isCanonicalAuthorizeRequest) {
      try {
        const authorization = validateRemoteMcpAuthorizeQuery(requestUrl.search, {
          resource: options.resource,
        });
        await options.security.persistAuthorizationRequestEnvelope(authorization);
        requestAdmissions.add(request);
        try {
          return await providerHandler(request);
        } finally {
          requestAdmissions.delete(request);
        }
      } catch (error) {
        if (error instanceof RemoteMcpOAuthGuardError) {
          return guardErrorResponse(error);
        }
        throw error;
      }
    }
    const isCanonicalTokenRequest =
      requestUrl.origin === issuer.origin && relativePath === "/oauth2/token";
    if (!isCanonicalTokenRequest || request.method !== "POST") {
      return providerHandler(request);
    }

    assertRawAuthorizationHeaderSnapshot(request, authorizationHeaders);
    try {
      const { parameters, providerRequest } = await readBoundedTokenRequestBody(request);
      return await executeRemoteMcpTokenEndpointBoundary(
        { authorizationHeaders, parameters },
        { resource: options.resource },
        options.security.withOwnerClientRefreshLock,
        async () => {
          requestAdmissions.add(providerRequest);
          try {
            return await providerHandler(providerRequest);
          } finally {
            requestAdmissions.delete(providerRequest);
          }
        },
      );
    } catch (error) {
      if (error instanceof RemoteMcpOAuthTokenBodyTooLargeError) {
        return tokenBodyTooLargeResponse();
      }
      if (error instanceof RemoteMcpOAuthGuardError) {
        return guardErrorResponse(error);
      }
      throw error;
    }
  };
}

function createSchemaOnlyRequestBlocker(): BetterAuthPlugin {
  return {
    id: "alphanet-remote-mcp-schema-only-do-not-serve",
    onRequest: () =>
      Promise.resolve({
        response: new Response(null, {
          headers: { "Cache-Control": "no-store" },
          status: 503,
        }),
      }),
  };
}

function createJwtPlugin(
  issuer: string,
  live?: AlphaNetRemoteMcpOAuthProviderOptions,
): BetterAuthPlugin {
  const plugin = jwt({
    disableSettingJwtHeader: true,
    jwks: {
      gracePeriod: REMOTE_MCP_JWKS_GRACE_SECONDS,
      jwksPath: "/jwks",
      keyPairConfig: { alg: "ES256" },
      ...(live ? { remoteUrl: live.jwksUrl } : {}),
      rotationInterval: REMOTE_MCP_JWKS_ROTATION_SECONDS,
    },
    jwt: {
      issuer,
      ...(live ? { sign: createLiveJwtSigner(live) } : {}),
    },
    schema: remoteMcpJwtSchema,
  });
  if (!live || !plugin.endpoints) {
    return plugin;
  }
  // The shared Owner auth surface must not gain Better Auth's generic session
  // JWT endpoint. Live JWKS is published only by the domain signer URL.
  const disabledLiveJwtEndpoints = new Set(["getJwks", "getToken"]);
  return {
    ...plugin,
    endpoints: Object.fromEntries(
      Object.entries(plugin.endpoints).filter(
        ([name]) => !disabledLiveJwtEndpoints.has(name),
      ),
    ),
  };
}

const NATIVE_INTROSPECTION_METADATA_FIELDS = [
  "introspection_endpoint",
  "introspection_endpoint_auth_methods_supported",
  "introspection_endpoint_auth_signing_alg_values_supported",
] as const;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function oauthMetadataPathnames(issuer: string): ReadonlySet<string> {
  const issuerPath = new URL(issuer).pathname.replace(/\/+$/u, "");
  return new Set([
    `/.well-known/oauth-authorization-server${issuerPath}`,
    `${issuerPath}/.well-known/oauth-authorization-server`,
    `${issuerPath}/.well-known/openid-configuration`,
  ]);
}

function unavailableMetadataResponse(): Response {
  return new Response(null, {
    headers: { "Cache-Control": "no-store" },
    status: 503,
  });
}

async function removeNativeIntrospectionMetadata(response: Response): Promise<Response> {
  try {
    const metadata: unknown = await response.json();
    if (!isUnknownRecord(metadata)) {
      return unavailableMetadataResponse();
    }
    const sanitized = { ...metadata };
    for (const field of NATIVE_INTROSPECTION_METADATA_FIELDS) {
      delete sanitized[field];
    }
    const headers = new Headers(response.headers);
    headers.delete("Content-Length");
    return new Response(JSON.stringify(sanitized), {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  } catch {
    return unavailableMetadataResponse();
  }
}

function createProviderPlugin(
  options: AlphaNetRemoteMcpOAuthSchemaOnlyOptions,
  live?: AlphaNetRemoteMcpOAuthProviderOptions,
): BetterAuthPlugin {
  const tokenStorageKey = live?.tokenStorageKey;
  const provider = oauthProvider({
    accessTokenExpiresIn: REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS,
    allowDynamicClientRegistration: false,
    allowPublicClientPrelogin: false,
    allowUnauthenticatedClientRegistration: false,
    clientPrivileges: () => false,
    codeExpiresIn: REMOTE_MCP_AUTHORIZATION_CODE_TTL_SECONDS,
    consentPage: options.consentPage,
    ...(live
      ? {
          customAccessTokenClaims: createLiveAccessTokenClaims(live),
          postLogin: createLivePostLogin(live.security),
        }
      : {}),
    grantTypes: ["authorization_code", "refresh_token"],
    loginPage: options.loginPage,
    prefix: {
      clientSecret: "aln_cs_v1_",
      refreshToken: "aln_rt_v1_",
    },
    refreshTokenExpiresIn: REMOTE_MCP_REFRESH_TOKEN_TTL_SECONDS,
    schema: remoteMcpOAuthProviderSchema,
    scopes: [...REMOTE_MCP_OAUTH_SCOPES],
    storeClientSecret: "hashed",
    storeTokens:
      live && tokenStorageKey
        ? {
            hash: (token, type) =>
              createHmac("sha256", tokenStorageKey)
                .update(`alphanet:${type}:v1\0`, "utf8")
                .update(token, "utf8")
                .digest("base64url"),
          }
        : "hashed",
    validAudiences: [options.resource],
  });
  const disabledNativeEndpoints = new Set([
    "getOAuthServerConfig",
    "getOpenIdConfig",
    "oauth2Introspect",
    ...(live ? ["deleteOAuthConsent", "oauth2Revoke", "updateOAuthConsent"] : []),
  ]);
  const endpoints = provider.endpoints
    ? Object.fromEntries(
        Object.entries(provider.endpoints).filter(
          ([name]) => !disabledNativeEndpoints.has(name),
        ),
      )
    : undefined;
  const providerOnRequest = provider.onRequest;
  if (!providerOnRequest) {
    return { ...provider, ...(endpoints ? { endpoints } : {}) };
  }
  const metadataPathnames = oauthMetadataPathnames(options.issuer);
  return {
    ...provider,
    ...(endpoints ? { endpoints } : {}),
    async onRequest(request, context) {
      const result = await providerOnRequest(request, context);
      if (
        !result ||
        !("response" in result) ||
        request.method === "HEAD" ||
        !metadataPathnames.has(new URL(request.url).pathname)
      ) {
        return result;
      }
      return {
        ...result,
        response: await removeNativeIntrospectionMetadata(result.response),
      };
    },
  };
}

export function createAlphaNetRemoteMcpOAuthLiveBoundary(
  options: AlphaNetRemoteMcpOAuthProviderOptions,
): AlphaNetRemoteMcpOAuthLiveBoundary {
  validateOAuthUrl(options.issuer, "Remote MCP OAuth issuer");
  validateOAuthUrl(options.jwksUrl, "Remote MCP OAuth JWKS URL");
  validateOAuthUrl(options.resource, "Remote MCP OAuth resource");
  const resourceUrl = new URL(options.resource);
  if (resourceUrl.pathname !== "/mcp" || resourceUrl.toString() !== options.resource) {
    throw new Error("Remote MCP OAuth resource must use the canonical /mcp path");
  }
  if (
    !(options.tokenStorageKey instanceof Uint8Array) ||
    options.tokenStorageKey.byteLength < 32
  ) {
    throw new Error("Remote MCP OAuth token storage key must be at least 32 bytes");
  }
  assertSecurityHooks(options.security);

  const requestAdmissions = new WeakSet<Request>();
  const plugins = [
    createDomainBoundaryPlugin(options, requestAdmissions),
    createJwtPlugin(options.issuer, options),
    createProviderPlugin(options, options),
  ] as const;
  return {
    plugins,
    wrapProviderHandler: (providerHandler) =>
      wrapLiveProviderHandler(options, requestAdmissions, providerHandler),
  };
}

/**
 * Build only the third-party schemas for snapshot generation. The first
 * plugin blocks every request, so this tuple cannot accidentally become a
 * reduced-security live OAuth runtime.
 */
export function createAlphaNetRemoteMcpOAuthSchemaOnlyPlugins(
  options: AlphaNetRemoteMcpOAuthSchemaOnlyOptions,
): readonly [BetterAuthPlugin, BetterAuthPlugin, BetterAuthPlugin] {
  validateOAuthUrl(options.issuer, "Remote MCP OAuth issuer");
  validateOAuthUrl(options.resource, "Remote MCP OAuth resource");
  const resourceUrl = new URL(options.resource);
  if (resourceUrl.pathname !== "/mcp" || resourceUrl.toString() !== options.resource) {
    throw new Error("Remote MCP OAuth resource must use the canonical /mcp path");
  }
  return [
    createSchemaOnlyRequestBlocker(),
    createJwtPlugin(options.issuer),
    createProviderPlugin(options),
  ] as const;
}
