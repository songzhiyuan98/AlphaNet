import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";

import {
  AGENT_SCOPES,
  AgentScopeSchema,
  RemoteMcpOAuthContinuationHandleSchema,
  type AgentScope,
} from "@alphanet/contracts";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { jwt } from "better-auth/plugins";
import { decodeJwt, decodeProtectedHeader, type JWTPayload } from "jose";

import {
  executeRemoteMcpTokenEndpointBoundary,
  RemoteMcpOAuthGuardError,
  validateRemoteMcpAuthorizeQuery,
  type RemoteMcpOwnerClientRefreshLock,
  type RemoteMcpOAuthScope,
  type ValidatedRemoteMcpTokenRequest,
  type ValidatedRemoteMcpAuthorizeQuery,
} from "./remote-mcp-oauth-guard.js";
import type { RemoteMcpOAuthAuthorizeRateLimiter } from "./remote-mcp-oauth-authorize-rate-limit.js";
import { validateRemoteMcpOAuthTokenSuccessResponse } from "./remote-mcp-oauth-token-response.js";

export const REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
export const REMOTE_MCP_AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
export const REMOTE_MCP_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const REMOTE_MCP_JWKS_ROTATION_SECONDS = 30 * 24 * 60 * 60;
export const REMOTE_MCP_JWKS_GRACE_SECONDS = 7 * 24 * 60 * 60;
export const REMOTE_MCP_TOKEN_REQUEST_BODY_MAX_BYTES = 16 * 1_024;
export const REMOTE_MCP_OAUTH_SCOPES = [...AGENT_SCOPES, "offline_access"] as const;

const REMOTE_MCP_OAUTH_SCOPE_INDEX = new Map<string, number>(
  REMOTE_MCP_OAUTH_SCOPES.map((scope, index) => [scope, index]),
);
const REMOTE_MCP_OAUTH_SCOPE_SET = new Set<string>(REMOTE_MCP_OAUTH_SCOPES);

type OAuthProviderOptions = Parameters<typeof oauthProvider>[0];
type OAuthPostLogin = NonNullable<OAuthProviderOptions["postLogin"]>;
type OAuthPostLoginContext = Parameters<OAuthPostLogin["consentReferenceId"]>[0];
type OAuthAccessTokenClaimsContext = Parameters<
  NonNullable<OAuthProviderOptions["customAccessTokenClaims"]>
>[0];
type OAuthTokenResponseFields = NonNullable<
  OAuthProviderOptions["customTokenResponseFields"]
>;
type OAuthTokenResponseFieldsContext = Parameters<OAuthTokenResponseFields>[0];

export type RemoteMcpOAuthConsentReferencePhase = "claim" | "inspect";

/**
 * Log-safe authority fields recovered from Provider-owned authorization-code
 * state. Raw codes, code verifiers, tokens, client secrets and state are
 * deliberately absent.
 */
export interface RemoteMcpAuthorizationGrantActivationInput {
  authUserId: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  grantId: string;
  oauthClientId: string;
  ownerSessionId: string;
  redirectUri: string;
  resource: string;
  /** Full protocol scopes, including offline_access when granted. */
  scopes: readonly RemoteMcpOAuthScope[];
}

/**
 * Minimal log-safe handle for undoing a Grant claimed or activated by a
 * Provider request that failed before it returned a successful response.
 */
export interface RemoteMcpAuthorizationGrantExchangeCompensationInput {
  grantId: string;
}

export interface RemoteMcpAuthorizationCodeExchangeLockInput {
  /** Raw one-shot Provider code. It must never be logged or persisted in plaintext. */
  authorizationCode: string;
  clientId: string;
  /** Raw PKCE verifier. It must never be logged or persisted. */
  codeVerifier: string;
  redirectUri: string;
  resource: string;
}

export interface RemoteMcpAuthorizationCodeLockedAuthority {
  /** Log-safe Grant correlation recovered from the unconsumed Provider code row. */
  grantId: string;
}

export interface RemoteMcpAuthorizationCodeExchangeLock {
  /**
   * Serialize one code across replicas, validate its frozen PKCE/client binding,
   * and keep the lock through Provider consumption and token creation.
   */
  <Result>(
    input: RemoteMcpAuthorizationCodeExchangeLockInput,
    executeWhileLocked: (
      authority: RemoteMcpAuthorizationCodeLockedAuthority,
    ) => Promise<Result>,
  ): Promise<Result>;
}

export interface RemoteMcpAccessTokenAuthorityPersistenceInput {
  /** Better Auth user id. The persistence transaction must re-resolve the Owner. */
  authUserId: string;
  expiresAt: Date;
  /** Provider consent reference id. It must resolve to the current AlphaNet Grant. */
  grantId: string;
  issuedAt: Date;
  /** Raw JWT identifier. Persist only its independently keyed digest. */
  jti: string;
  /** Exact Provider client copied into the JWT azp claim. */
  oauthClientId: string;
  /** Full canonical Provider scope set, including offline_access when granted. */
  protocolScopes: readonly RemoteMcpOAuthScope[];
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
   * Dedicated fail-closed admission that runs before an Authorization Request
   * Envelope can write to PostgreSQL. Provider and edge limits do not replace it.
   */
  admitAuthorizationRequest: RemoteMcpOAuthAuthorizeRateLimiter;
  /**
   * Atomically claim/revalidate the pending Grant immediately before the
   * Provider creates access and refresh tokens in parallel.
   */
  activateAuthorizationGrant(
    input: RemoteMcpAuthorizationGrantActivationInput,
  ): Promise<void>;
  /**
   * Restore/revoke the claimed authority when Provider code issuance or the
   * first authorization-code token exchange fails after the domain hook ran.
   */
  compensateFailedAuthorizationGrantExchange(
    input: RemoteMcpAuthorizationGrantExchangeCompensationInput,
  ): Promise<void>;
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
    /** Inspect or claim the one-shot authorization envelope and return its Grant id. */
    resolveGrantId(
      context: OAuthPostLoginContext,
      phase: RemoteMcpOAuthConsentReferencePhase,
      continuationHandle: string | undefined,
    ): Promise<string>;
    shouldRedirect: OAuthPostLogin["shouldRedirect"];
  };
  withAuthorizationCodeExchangeLock: RemoteMcpAuthorizationCodeExchangeLock;
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
  /**
   * Every X-AlphaNet-OAuth-Continuation field-value from the server's raw
   * header list. The continuation is session-bound and must not be recovered
   * from Fetch Headers after duplicate fields have been collapsed.
   */
  continuationHeaders: readonly string[];
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

type RemoteMcpAuthorizationCodeTokenRequest = Extract<
  ValidatedRemoteMcpTokenRequest,
  { grantType: "authorization_code" }
>;

interface RemoteMcpOAuthProviderRequestState {
  activatedGrantId?: string;
  authorizationCodeGrantId?: string;
  authorizationCodeTokenRequest?: RemoteMcpAuthorizationCodeTokenRequest;
  claimedGrantId?: string;
  compensationAttempted: boolean;
  continuationHandle?: string;
  consentReferencePhase: RemoteMcpOAuthConsentReferencePhase;
  inspectedGrantId?: string;
  postLoginContinuationConfirmed: boolean;
  tokenClientId?: string;
  tokenGrantType?: "authorization_code" | "refresh_token";
  tokenProtocolScopes?: readonly RemoteMcpOAuthScope[];
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
    typeof security.admitAuthorizationRequest !== "function" ||
    typeof security.activateAuthorizationGrant !== "function" ||
    typeof security.compensateFailedAuthorizationGrantExchange !== "function" ||
    typeof security.executeDomainRevocationTransaction !== "function" ||
    typeof security.persistAccessTokenAuthority !== "function" ||
    typeof security.persistAuthorizationRequestEnvelope !== "function" ||
    !security.postLogin ||
    typeof security.postLogin.page !== "string" ||
    security.postLogin.page.length < 1 ||
    typeof security.postLogin.resolveGrantId !== "function" ||
    typeof security.postLogin.shouldRedirect !== "function" ||
    typeof security.signAccessToken !== "function" ||
    typeof security.withAuthorizationCodeExchangeLock !== "function" ||
    typeof security.withOwnerClientRefreshLock !== "function"
  ) {
    throw new Error("Remote MCP OAuth live security hooks are incomplete");
  }
}

function normalizeProtocolScopes(
  value: unknown,
): readonly RemoteMcpOAuthScope[] | undefined {
  if (
    !isStringArray(value) ||
    value.length < 1 ||
    value.length > REMOTE_MCP_OAUTH_SCOPES.length
  ) {
    return undefined;
  }
  const unique = new Set(value);
  if (
    unique.size !== value.length ||
    value.some((scope) => !REMOTE_MCP_OAUTH_SCOPE_SET.has(scope)) ||
    !value.some((scope) => scope !== "offline_access")
  ) {
    return undefined;
  }
  return Object.freeze(
    [...value]
      .sort(
        (left, right) =>
          (REMOTE_MCP_OAUTH_SCOPE_INDEX.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (REMOTE_MCP_OAUTH_SCOPE_INDEX.get(right) ?? Number.MAX_SAFE_INTEGER),
      )
      .map((scope) => scope as RemoteMcpOAuthScope),
  );
}

function normalizeProtocolScopeString(
  value: unknown,
): readonly RemoteMcpOAuthScope[] | undefined {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.startsWith(" ") ||
    value.endsWith(" ") ||
    value.includes("  ") ||
    [...value.replaceAll(" ", "")].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || codePoint <= 0x20 || codePoint === 0x7f;
    })
  ) {
    return undefined;
  }
  return normalizeProtocolScopes(value.split(" "));
}

function sameProtocolScopes(
  left: readonly RemoteMcpOAuthScope[],
  right: readonly RemoteMcpOAuthScope[],
): boolean {
  return (
    left.length === right.length && left.every((scope, index) => scope === right[index])
  );
}

function isPkceS256Challenge(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}

function validateAuthorizationGrantActivation(
  context: OAuthTokenResponseFieldsContext,
  options: AlphaNetRemoteMcpOAuthProviderOptions,
  state: RemoteMcpOAuthProviderRequestState | undefined,
): RemoteMcpAuthorizationGrantActivationInput {
  const verification = context.verificationValue;
  const query = verification?.query;
  const tokenRequest = state?.authorizationCodeTokenRequest;
  const contextScopes = normalizeProtocolScopes(context.scopes);
  const queryScopes = normalizeProtocolScopeString(query?.scope);
  if (
    context.grantType !== "authorization_code" ||
    !state ||
    !tokenRequest ||
    !context.user ||
    !isUuid(context.user.id) ||
    !verification ||
    verification.type !== "authorization_code" ||
    verification.userId !== context.user.id ||
    !isUuid(verification.referenceId) ||
    verification.referenceId !== state.authorizationCodeGrantId ||
    !isUuid(verification.sessionId) ||
    !query ||
    query.response_type !== "code" ||
    query.client_id !== tokenRequest.clientId ||
    query.redirect_uri !== tokenRequest.redirectUri ||
    tokenRequest.resource !== options.resource ||
    !isPkceS256Challenge(query.code_challenge) ||
    query.code_challenge_method !== "S256" ||
    !contextScopes ||
    !queryScopes ||
    !sameProtocolScopes(contextScopes, queryScopes)
  ) {
    throw new Error("Remote MCP OAuth authorization Grant activation is unavailable");
  }
  return Object.freeze({
    authUserId: context.user.id,
    codeChallenge: query.code_challenge,
    codeChallengeMethod: "S256",
    grantId: verification.referenceId,
    oauthClientId: tokenRequest.clientId,
    ownerSessionId: verification.sessionId,
    redirectUri: tokenRequest.redirectUri,
    resource: tokenRequest.resource,
    scopes: queryScopes,
  });
}

function createLiveTokenResponseFields(
  options: AlphaNetRemoteMcpOAuthProviderOptions,
  requestState: AsyncLocalStorage<RemoteMcpOAuthProviderRequestState>,
): OAuthTokenResponseFields {
  return async (context) => {
    const state = requestState.getStore();
    const protocolScopes = normalizeProtocolScopes(context.scopes);
    if (!state || !protocolScopes) {
      throw new Error("Remote MCP OAuth token response authority is unavailable");
    }
    if (context.grantType === "refresh_token") {
      state.tokenProtocolScopes = protocolScopes;
      return {};
    }
    const activation = validateAuthorizationGrantActivation(context, options, state);
    await options.security.activateAuthorizationGrant(activation);
    state.activatedGrantId = activation.grantId;
    state.tokenProtocolScopes = activation.scopes;
    return {};
  };
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
        context.resources?.length !== 1 ||
        context.resources[0] !== options.resource
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
  protocolScopes: readonly RemoteMcpOAuthScope[];
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
  const protocolScopes = normalizeProtocolScopeString(scope);
  if (!protocolScopes) {
    throw new Error("Remote MCP OAuth access-token signing payload is invalid");
  }
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
      oauthClientId: seed.azp,
      protocolScopes: seed.protocolScopes,
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
  requestState: AsyncLocalStorage<RemoteMcpOAuthProviderRequestState>,
): OAuthPostLogin {
  async function resolveGrantId(
    context: OAuthPostLoginContext,
    state: RemoteMcpOAuthProviderRequestState,
    phase: RemoteMcpOAuthConsentReferencePhase,
  ): Promise<string> {
    const cached = phase === "claim" ? state.claimedGrantId : state.inspectedGrantId;
    if (cached) return cached;
    const grantId = await security.postLogin.resolveGrantId(
      context,
      phase,
      state.continuationHandle,
    );
    if (!isUuid(grantId)) {
      throw new Error("Remote MCP OAuth consent Grant is unavailable");
    }
    if (phase === "claim") state.claimedGrantId = grantId;
    else state.inspectedGrantId = grantId;
    return grantId;
  }

  return {
    consentReferenceId: async (context) => {
      const state = requestState.getStore();
      if (!state) {
        throw new Error("Remote MCP OAuth consent Grant is unavailable");
      }
      return resolveGrantId(context, state, state.consentReferencePhase);
    },
    page: security.postLogin.page,
    shouldRedirect: async (context) => {
      const state = requestState.getStore();
      if (!state) return security.postLogin.shouldRedirect(context);
      // Provider 1.6.23 does not mark its POST /oauth2/continue post-login
      // branch as cleared. Only the request-local continuation admission can
      // skip the otherwise mandatory Agent-selection redirect.
      if (state.claimedGrantId) return false;
      if (!state.postLoginContinuationConfirmed) {
        return security.postLogin.shouldRedirect(context);
      }
      await resolveGrantId(context, state, "inspect");
      return false;
    },
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

function validatedContinuationHeaderSnapshot(
  request: Request,
  continuationHeaders: unknown,
): string | undefined {
  if (!isStringArray(continuationHeaders)) {
    throw new Error("Remote MCP OAuth raw continuation headers are unavailable");
  }
  if (continuationHeaders.length > 1) {
    throw new Error("Remote MCP OAuth continuation header must not be repeated");
  }
  const collapsed = request.headers.get("x-alphanet-oauth-continuation");
  const raw = continuationHeaders[0] ?? null;
  if (collapsed !== raw) {
    throw new Error("Remote MCP OAuth raw continuation headers are unavailable");
  }
  if (raw === null) {
    return undefined;
  }
  const parsed = RemoteMcpOAuthContinuationHandleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Remote MCP OAuth continuation header is invalid");
  }
  return parsed.data;
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

function authorizeRateLimitResponse(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      error: "temporarily_unavailable",
      error_description: "OAuth authorization is temporarily rate limited.",
    }),
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        Pragma: "no-cache",
        "Retry-After": String(retryAfterSeconds),
      },
      status: 429,
    },
  );
}

function trustedAuthorizeClientIp(request: Request): string {
  const clientIp = request.headers.get("x-alphanet-client-ip");
  if (clientIp === null || isIP(clientIp) === 0) {
    throw new Error("Remote MCP OAuth authorize client IP is unavailable");
  }
  return clientIp;
}

function validatedAuthorizeAdmission(
  value: Awaited<ReturnType<RemoteMcpOAuthAuthorizeRateLimiter>>,
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  if (value?.allowed === true && Object.keys(value).length === 1) {
    return { allowed: true };
  }
  if (
    value?.allowed === false &&
    Object.keys(value).length === 2 &&
    Number.isSafeInteger(value.retryAfterSeconds) &&
    value.retryAfterSeconds >= 1 &&
    value.retryAfterSeconds <= 60
  ) {
    return { allowed: false, retryAfterSeconds: value.retryAfterSeconds };
  }
  throw new Error("Remote MCP OAuth authorize rate-limit decision is invalid");
}

function authorizationCodeExchangeLockInput(
  parameters: string,
  request: RemoteMcpAuthorizationCodeTokenRequest,
): RemoteMcpAuthorizationCodeExchangeLockInput {
  const form = new URLSearchParams(parameters);
  const authorizationCode = form.get("code");
  const codeVerifier = form.get("code_verifier");
  if (authorizationCode === null || codeVerifier === null) {
    throw new Error("Remote MCP OAuth authorization-code state is unavailable");
  }
  return Object.freeze({
    authorizationCode,
    clientId: request.clientId,
    codeVerifier,
    redirectUri: request.redirectUri,
    resource: request.resource,
  });
}

async function compensateFailedProviderRequest(
  security: AlphaNetRemoteMcpOAuthSecurityHooks,
  state: RemoteMcpOAuthProviderRequestState,
): Promise<void> {
  const grantId = state.activatedGrantId ?? state.authorizationCodeGrantId;
  if (!grantId || state.compensationAttempted) {
    return;
  }
  state.compensationAttempted = true;
  await security.compensateFailedAuthorizationGrantExchange(Object.freeze({ grantId }));
}

function secureTokenSuccessResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  // OAuth Provider 1.6.23 drops the endpoint-level headers supplied to
  // `ctx.json` before this boundary observes the Response. Reapply the
  // protocol-required cache controls here, then validate and return this same
  // response so the outward transport cannot accidentally serve a cacheable
  // token document.
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function executeTrackedProviderRequest(
  options: AlphaNetRemoteMcpOAuthProviderOptions,
  state: RemoteMcpOAuthProviderRequestState,
  providerHandler: AlphaNetRemoteMcpOAuthProviderHandler,
  request: Request,
): Promise<Response> {
  try {
    const providerResponse = await providerHandler(request);
    if (!(providerResponse instanceof Response)) {
      await compensateFailedProviderRequest(options.security, state);
      throw new Error("Remote MCP OAuth provider handler returned an invalid response");
    }
    if (!providerResponse.ok) {
      await compensateFailedProviderRequest(options.security, state);
      return providerResponse;
    }
    if (state.tokenGrantType) {
      if (!state.tokenClientId || !state.tokenProtocolScopes) {
        throw new Error("Remote MCP OAuth token response authority is unavailable");
      }
      const response = secureTokenSuccessResponse(providerResponse);
      await validateRemoteMcpOAuthTokenSuccessResponse(response, {
        clientId: state.tokenClientId,
        issuer: options.issuer,
        resource: options.resource,
        scopes: state.tokenProtocolScopes,
      });
      return response;
    }
    return providerResponse;
  } catch (error) {
    await compensateFailedProviderRequest(options.security, state);
    throw error;
  }
}

function wrapLiveProviderHandler(
  options: AlphaNetRemoteMcpOAuthProviderOptions,
  requestAdmissions: WeakSet<Request>,
  requestState: AsyncLocalStorage<RemoteMcpOAuthProviderRequestState>,
  providerHandler: AlphaNetRemoteMcpOAuthProviderHandler,
): (input: AlphaNetRemoteMcpOAuthRawHttpRequest) => Promise<Response> {
  if (typeof providerHandler !== "function") {
    throw new Error("Remote MCP OAuth provider handler is unavailable");
  }
  const issuer = new URL(options.issuer);
  return async ({ authorizationHeaders, continuationHeaders, request }) => {
    const requestUrl = new URL(request.url);
    const relativePath = oauthRelativePath(requestUrl.pathname, options.issuer);
    const continuationHandle = validatedContinuationHeaderSnapshot(
      request,
      continuationHeaders,
    );
    const requiresContinuation =
      requestUrl.origin === issuer.origin &&
      request.method === "POST" &&
      (relativePath === "/oauth2/continue" || relativePath === "/oauth2/consent");
    if (requiresContinuation && continuationHandle === undefined) {
      throw new Error("Remote MCP OAuth continuation header is required");
    }
    const state: RemoteMcpOAuthProviderRequestState = {
      compensationAttempted: false,
      ...(continuationHandle ? { continuationHandle } : {}),
      consentReferencePhase:
        requestUrl.origin === issuer.origin && relativePath === "/oauth2/consent"
          ? "claim"
          : "inspect",
      postLoginContinuationConfirmed:
        requestUrl.origin === issuer.origin &&
        request.method === "POST" &&
        relativePath === "/oauth2/continue" &&
        continuationHandle !== undefined,
    };
    return requestState.run(state, async () => {
      const isCanonicalAuthorizeRequest =
        requestUrl.origin === issuer.origin &&
        relativePath === "/oauth2/authorize" &&
        request.method === "GET";
      if (isCanonicalAuthorizeRequest) {
        try {
          const authorization = validateRemoteMcpAuthorizeQuery(requestUrl.search, {
            resource: options.resource,
          });
          const admission = validatedAuthorizeAdmission(
            await options.security.admitAuthorizationRequest({
              clientId: authorization.clientId,
              clientIp: trustedAuthorizeClientIp(request),
            }),
          );
          if (!admission.allowed) {
            return authorizeRateLimitResponse(admission.retryAfterSeconds);
          }
          await options.security.persistAuthorizationRequestEnvelope(authorization);
          requestAdmissions.add(request);
          try {
            return await executeTrackedProviderRequest(
              options,
              state,
              providerHandler,
              request,
            );
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
        return executeTrackedProviderRequest(options, state, providerHandler, request);
      }

      assertRawAuthorizationHeaderSnapshot(request, authorizationHeaders);
      try {
        const { parameters, providerRequest } =
          await readBoundedTokenRequestBody(request);
        return await executeRemoteMcpTokenEndpointBoundary(
          { authorizationHeaders, parameters },
          { resource: options.resource },
          options.security.withOwnerClientRefreshLock,
          async (validatedRequest) => {
            state.tokenClientId = validatedRequest.clientId;
            state.tokenGrantType = validatedRequest.grantType;
            const executeProvider = async (): Promise<Response> => {
              requestAdmissions.add(providerRequest);
              try {
                return await executeTrackedProviderRequest(
                  options,
                  state,
                  providerHandler,
                  providerRequest,
                );
              } finally {
                requestAdmissions.delete(providerRequest);
              }
            };
            if (validatedRequest.grantType === "authorization_code") {
              state.authorizationCodeTokenRequest = validatedRequest;
              try {
                return await options.security.withAuthorizationCodeExchangeLock(
                  authorizationCodeExchangeLockInput(parameters, validatedRequest),
                  async (authority) => {
                    if (!authority || !isUuid(authority.grantId)) {
                      throw new Error(
                        "Remote MCP OAuth authorization-code authority is unavailable",
                      );
                    }
                    state.authorizationCodeGrantId = authority.grantId;
                    return executeProvider();
                  },
                );
              } catch (error) {
                await compensateFailedProviderRequest(options.security, state);
                throw error;
              }
            }
            return executeProvider();
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
    });
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

async function sanitizeRemoteMcpOAuthMetadata(response: Response): Promise<Response> {
  try {
    const metadata: unknown = await response.json();
    if (!isUnknownRecord(metadata)) {
      return unavailableMetadataResponse();
    }
    const sanitized = { ...metadata };
    for (const field of NATIVE_INTROSPECTION_METADATA_FIELDS) {
      delete sanitized[field];
    }
    // V1 clients are pre-registered public PKCE clients. Dynamic registration
    // remains disabled, but discovery must still advertise the one token and
    // domain-revocation authentication method the live boundary accepts.
    sanitized["token_endpoint_auth_methods_supported"] = ["none"];
    sanitized["revocation_endpoint_auth_methods_supported"] = ["none"];
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
  requestState?: AsyncLocalStorage<RemoteMcpOAuthProviderRequestState>,
): BetterAuthPlugin {
  const tokenStorageKey = live?.tokenStorageKey;
  if (live && !requestState) {
    throw new Error("Remote MCP OAuth Provider request state is unavailable");
  }
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
          customTokenResponseFields: createLiveTokenResponseFields(
            live,
            requestState as AsyncLocalStorage<RemoteMcpOAuthProviderRequestState>,
          ),
          postLogin: createLivePostLogin(
            live.security,
            requestState as AsyncLocalStorage<RemoteMcpOAuthProviderRequestState>,
          ),
        }
      : {}),
    grantTypes: ["authorization_code", "refresh_token"],
    loginPage: options.loginPage,
    prefix: {
      clientSecret: "aln_cs_v1_",
      refreshToken: "aln_rt_v1_",
    },
    // Authorization admission is enforced by AlphaNet's Redis-backed,
    // pre-persistence global/client/IP limiter. The Provider's in-memory
    // limiter runs after its request envelope is stored, so leaving it enabled
    // would both double-limit and permit rejected requests to consume storage.
    rateLimit: { authorize: false },
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
  // oauth-provider 1.7.0-beta.4 ships endpoint OpenAPI declarations that are
  // structurally valid at runtime but narrower than BetterAuthPlugin's public
  // endpoint index signature. Keep the compatibility assertion at this single
  // reviewed package boundary instead of weakening AlphaNet's plugin types.
  if (typeof provider.id !== "string" || provider.id.length === 0) {
    throw new Error("Remote MCP OAuth Provider plugin is invalid");
  }
  const compatibleProvider = provider as unknown as BetterAuthPlugin;
  const disabledNativeEndpoints = new Set([
    "getOAuthServerConfig",
    "getOpenIdConfig",
    "oauth2Introspect",
    ...(live ? ["deleteOAuthConsent", "oauth2Revoke", "updateOAuthConsent"] : []),
  ]);
  const endpoints = compatibleProvider.endpoints
    ? Object.fromEntries(
        Object.entries(compatibleProvider.endpoints).filter(
          ([name]) => !disabledNativeEndpoints.has(name),
        ),
      )
    : undefined;
  const providerOnRequest = compatibleProvider.onRequest;
  if (!providerOnRequest) {
    return { ...compatibleProvider, ...(endpoints ? { endpoints } : {}) };
  }
  const metadataPathnames = oauthMetadataPathnames(options.issuer);
  return {
    ...compatibleProvider,
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
        response: await sanitizeRemoteMcpOAuthMetadata(result.response),
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
  const requestState = new AsyncLocalStorage<RemoteMcpOAuthProviderRequestState>();
  const plugins = [
    createDomainBoundaryPlugin(options, requestAdmissions),
    createJwtPlugin(options.issuer, options),
    createProviderPlugin(options, options, requestState),
  ] as const;
  return {
    plugins,
    wrapProviderHandler: (providerHandler) =>
      wrapLiveProviderHandler(options, requestAdmissions, requestState, providerHandler),
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
