import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { AGENT_SCOPES, type AgentScope } from "@alphanet/contracts";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import {
  createRemoteMcpAuthorizationRequestEnvelope,
  RemoteMcpOAuthGuardError,
  type RemoteMcpOAuthScope,
  type RemoteMcpRefreshLockedAuthority,
  type ValidatedRemoteMcpAuthorizeQuery,
} from "./remote-mcp-oauth-guard.js";
import { digestInboundMcpTokenJti } from "./mcp-actor-context.js";
import type {
  AlphaNetRemoteMcpOAuthSecurityHooks,
  RemoteMcpAuthorizationCodeExchangeLockInput,
  RemoteMcpAuthorizationCodeLockedAuthority,
  RemoteMcpAuthorizationGrantActivationInput,
  RemoteMcpAuthorizationGrantExchangeCompensationInput,
  RemoteMcpAccessTokenAuthorityPersistenceInput,
  RemoteMcpAccessTokenAuthorityPersistenceResult,
} from "./remote-mcp-oauth-provider.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AUTHORIZATION_CODE_PATTERN = /^[A-Za-z0-9]{32}$/u;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const REFRESH_TOKEN_PREFIX = "aln_rt_v1_";
const REFRESH_TOKEN_BODY_PATTERN = /^[A-Za-z0-9]{32}$/u;
const PROVIDER_AUTHORIZATION_CODE_DIGEST_DOMAIN = "alphanet:authorization_code:v1\0";
const PROVIDER_REFRESH_DIGEST_DOMAIN = "alphanet:refresh_token:v1\0";
const ACCESS_TOKEN_LIFETIME_MILLISECONDS = 10 * 60 * 1_000;
const CLOCK_SKEW_MILLISECONDS = 5_000;
const AGENT_SCOPE_SET = new Set<string>(AGENT_SCOPES);

export type RemoteMcpOAuthSecurityStoreErrorCode =
  | "ACCESS_TOKEN_AUTHORITY_INVALID"
  | "AUTHORIZATION_REQUEST_INVALID"
  | "CONFIG_INVALID"
  | "DATABASE_UNAVAILABLE";

/** Log-safe store failure. Messages and fields never contain request secrets. */
export class RemoteMcpOAuthSecurityStoreError extends Error {
  readonly code: RemoteMcpOAuthSecurityStoreErrorCode;

  constructor(code: RemoteMcpOAuthSecurityStoreErrorCode, message: string) {
    super(message);
    this.name = "RemoteMcpOAuthSecurityStoreError";
    this.code = code;
  }
}

export interface AlphaNetRemoteMcpOAuthSecurityStoreOptions {
  /** One-shot authorization-request HMAC key. It must not be reused. */
  authorizationBindingKey: Uint8Array;
  /** PostgreSQL pool for bounded authority transactions and Provider-spawned writes. */
  pool: Pool;
  /**
   * Independent PostgreSQL pool used only while holding OAuth exchange locks.
   * It must not share Pool identity with `pool`: Provider callbacks can mint a
   * JWT and persist authority before this lock transaction is released.
   */
  lockPool: Pool;
  /** Exact key passed to the Provider's storeTokens HMAC configuration. */
  refreshTokenStorageKey: Uint8Array;
  /** Independent HMAC key used only for platform.oauth_access_token_jtis. */
  tokenJtiDigestKey: Uint8Array;
}

export type AlphaNetRemoteMcpOAuthSecurityStore = Pick<
  AlphaNetRemoteMcpOAuthSecurityHooks,
  | "activateAuthorizationGrant"
  | "compensateFailedAuthorizationGrantExchange"
  | "persistAccessTokenAuthority"
  | "persistAuthorizationRequestEnvelope"
  | "withAuthorizationCodeExchangeLock"
  | "withOwnerClientRefreshLock"
>;

interface AuthorizationCodeVerificationRow extends QueryResultRow {
  authority_checked_at: Date;
  expires_at: Date;
  value: string;
}

interface AuthorizationRequestRow extends QueryResultRow {
  agent_id: string | null;
  code_challenge: string;
  code_challenge_method: string;
  expires_at: Date;
  grant_id: string | null;
  oauth_client_id: string;
  owner_id: string | null;
  owner_session_id: string | null;
  redirect_uri: string;
  requested_scopes: string[];
  resource: string;
  status: string;
}

interface OwnerLocatorRow extends QueryResultRow {
  owner_id: string;
}

interface GrantLocatorRow extends OwnerLocatorRow {
  auth_user_id: string;
  oauth_client_id: string;
}

interface OwnerRow extends QueryResultRow {
  auth_user_id: string;
  deleted_at: Date | null;
  email_verified_at: Date | null;
  id: string;
  status: string;
}

interface AccessAuthorityRow extends QueryResultRow {
  agent_id: string;
  agent_deleted_at: Date | null;
  agent_owner_id: string;
  agent_status: string;
  actor_deleted_at: Date | null;
  actor_kind: string;
  actor_owner_id: string;
  actor_status: string;
  authority_checked_at: Date;
  client_disabled: boolean | null;
  client_grant_types: unknown;
  client_id: string;
  client_public: boolean | null;
  client_require_pkce: boolean | null;
  client_redirect_uris: unknown;
  client_secret: string | null;
  client_scopes: unknown;
  client_skip_consent: boolean | null;
  client_token_endpoint_auth_method: string | null;
  configured_resource: string;
  credential_audience: string;
  credential_expires_at: Date | null;
  credential_id: string;
  credential_revoked_at: Date | null;
  credential_scopes: string[];
  credential_type: string;
  grant_activated_at: Date | null;
  grant_agent_id: string;
  grant_auth_user_id: string;
  grant_credential_id: string;
  grant_expires_at: Date;
  grant_id: string;
  grant_offline_access: boolean;
  grant_owner_id: string;
  grant_resource: string;
  grant_scopes: string[];
  grant_status: string;
  grant_token_epoch: string;
  oauth_client_id: string;
  request_agent_id: string | null;
  request_expires_at: Date;
  request_code_challenge: string;
  request_code_challenge_method: string;
  request_grant_id: string | null;
  request_id: string;
  request_oauth_client_id: string;
  request_owner_id: string | null;
  request_owner_session_id: string | null;
  request_redirect_uri: string;
  request_requested_scopes: string[];
  request_resource: string;
  request_status: string;
}

interface RefreshLocatorRow extends QueryResultRow {
  auth_user_id: string;
  client_id: string;
  owner_id: string;
}

interface RefreshAuthorityRow extends QueryResultRow {
  actor_deleted_at: Date | null;
  actor_kind: string;
  actor_owner_id: string;
  actor_status: string;
  agent_deleted_at: Date | null;
  agent_id: string;
  agent_owner_id: string;
  agent_status: string;
  authority_checked_at: Date;
  client_disabled: boolean | null;
  client_grant_types: unknown;
  client_id: string;
  client_public: boolean | null;
  client_require_pkce: boolean | null;
  client_secret: string | null;
  client_scopes: unknown;
  client_skip_consent: boolean | null;
  client_token_endpoint_auth_method: string | null;
  configured_resource: string;
  credential_audience: string;
  credential_expires_at: Date | null;
  credential_id: string;
  credential_revoked_at: Date | null;
  credential_scopes: string[];
  grant_expires_at: Date;
  grant_agent_id: string;
  grant_id: string;
  grant_offline_access: boolean;
  grant_resource: string;
  grant_scopes: string[];
  grant_status: string;
  oauth_client_id: string;
  owner_id: string;
  refresh_auth_user_id: string;
  refresh_client_id: string;
  refresh_created_at: Date;
  refresh_expires_at: Date;
  refresh_reference_id: string | null;
  refresh_revoked_at: Date | null;
  refresh_scopes: unknown;
}

function storeError(
  code: RemoteMcpOAuthSecurityStoreErrorCode,
): RemoteMcpOAuthSecurityStoreError {
  switch (code) {
    case "ACCESS_TOKEN_AUTHORITY_INVALID":
      return new RemoteMcpOAuthSecurityStoreError(
        code,
        "Remote MCP OAuth access-token authority is invalid",
      );
    case "AUTHORIZATION_REQUEST_INVALID":
      return new RemoteMcpOAuthSecurityStoreError(
        code,
        "Remote MCP OAuth authorization request is invalid",
      );
    case "CONFIG_INVALID":
      return new RemoteMcpOAuthSecurityStoreError(
        code,
        "Remote MCP OAuth security store configuration is invalid",
      );
    case "DATABASE_UNAVAILABLE":
      return new RemoteMcpOAuthSecurityStoreError(
        code,
        "Remote MCP OAuth security store is unavailable",
      );
  }
}

function invalidRefreshGrant(): RemoteMcpOAuthGuardError {
  return new RemoteMcpOAuthGuardError({
    code: "REFRESH_AUTHORITY_INVALID",
    message: "The refresh authority is invalid.",
    oauthError: "invalid_grant",
    statusCode: 400,
  });
}

function invalidAuthorizationCodeGrant(): RemoteMcpOAuthGuardError {
  return new RemoteMcpOAuthGuardError({
    code: "AUTHORIZATION_CODE_AUTHORITY_INVALID",
    message: "The authorization code authority is invalid.",
    oauthError: "invalid_grant",
    statusCode: 400,
  });
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.valueOf());
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeClientId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 200 &&
    !/[\s\p{Cc}]/u.test(value)
  );
}

function isSafeResource(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 500) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.toString() === value &&
      parsed.pathname === "/mcp" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      (parsed.protocol === "https:" ||
        (parsed.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)))
    );
  } catch {
    return false;
  }
}

function isSafeRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    return (
      parsed.toString() === value &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback))
    );
  } catch {
    return false;
  }
}

function isPkceS256Challenge(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function copyKey(value: Uint8Array, label: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 32) {
    throw new RemoteMcpOAuthSecurityStoreError(
      "CONFIG_INVALID",
      `${label} must be at least 32 bytes`,
    );
  }
  return Buffer.from(value);
}

function copyExactKey(value: Uint8Array, length: number, label: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new RemoteMcpOAuthSecurityStoreError(
      "CONFIG_INVALID",
      `${label} must be exactly ${length} bytes`,
    );
  }
  return Buffer.from(value);
}

function keysEqual(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function assertIndependentKeys(keys: readonly Buffer[]): void {
  for (let leftIndex = 0; leftIndex < keys.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < keys.length; rightIndex += 1) {
      const left = keys[leftIndex];
      const right = keys[rightIndex];
      if (left && right && keysEqual(left, right)) {
        throw new RemoteMcpOAuthSecurityStoreError(
          "CONFIG_INVALID",
          "Remote MCP OAuth security-store keys must be independent",
        );
      }
    }
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  if (leftSet.size !== left.length) return false;
  return right.every((value) => leftSet.has(value));
}

function normalizeDomainScopes(value: unknown): AgentScope[] | null {
  if (!isStringArray(value) || value.length < 1 || value.length > AGENT_SCOPES.length) {
    return null;
  }
  const input = new Set(value);
  if (input.size !== value.length || value.some((scope) => !AGENT_SCOPE_SET.has(scope))) {
    return null;
  }
  return AGENT_SCOPES.filter((scope) => input.has(scope));
}

function normalizeProtocolScopes(value: unknown): string[] | null {
  if (
    !isStringArray(value) ||
    value.length < 1 ||
    value.length > AGENT_SCOPES.length + 1
  ) {
    return null;
  }
  const allowed = new Set<string>([...AGENT_SCOPES, "offline_access"]);
  const input = new Set(value);
  if (input.size !== value.length || value.some((scope) => !allowed.has(scope))) {
    return null;
  }
  return [...AGENT_SCOPES, "offline_access"].filter((scope) => input.has(scope));
}

interface ParsedAuthorizationCodeVerification {
  authUserId: string;
  codeChallenge: string;
  grantId: string;
  ownerSessionId: string;
  scopes: string[];
}

function parseAuthorizationCodeVerification(
  row: AuthorizationCodeVerificationRow | undefined,
  input: RemoteMcpAuthorizationCodeExchangeLockInput,
): ParsedAuthorizationCodeVerification {
  if (
    !row ||
    !isDate(row.authority_checked_at) ||
    !isDate(row.expires_at) ||
    row.expires_at.valueOf() <= row.authority_checked_at.valueOf() ||
    typeof row.value !== "string"
  ) {
    throw invalidAuthorizationCodeGrant();
  }
  let value: unknown;
  try {
    value = JSON.parse(row.value) as unknown;
  } catch {
    throw invalidAuthorizationCodeGrant();
  }
  if (!isUnknownRecord(value) || !isUnknownRecord(value["query"])) {
    throw invalidAuthorizationCodeGrant();
  }
  const query = value["query"];
  const grantId = value["referenceId"];
  const authUserId = value["userId"];
  const ownerSessionId = value["sessionId"];
  const scopes =
    typeof query["scope"] === "string"
      ? normalizeProtocolScopes(query["scope"].split(" "))
      : null;
  const computedChallenge = createHash("sha256")
    .update(input.codeVerifier, "ascii")
    .digest("base64url");
  if (
    value["type"] !== "authorization_code" ||
    !isUuid(grantId) ||
    !isUuid(authUserId) ||
    !isUuid(ownerSessionId) ||
    query["response_type"] !== "code" ||
    query["client_id"] !== input.clientId ||
    query["redirect_uri"] !== input.redirectUri ||
    query["code_challenge_method"] !== "S256" ||
    typeof query["code_challenge"] !== "string" ||
    query["code_challenge"] !== computedChallenge ||
    !scopes
  ) {
    throw invalidAuthorizationCodeGrant();
  }
  return {
    authUserId,
    codeChallenge: computedChallenge,
    grantId,
    ownerSessionId,
    scopes,
  };
}

function providerScopesForGrant(
  scopes: readonly AgentScope[],
  offlineAccess: boolean,
): string[] {
  return offlineAccess ? [...scopes, "offline_access"] : [...scopes];
}

function parsePositiveEpoch(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function safePoolQuery<Row extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<Row>> {
  try {
    return await pool.query<Row>(text, values);
  } catch {
    throw storeError("DATABASE_UNAVAILABLE");
  }
}

async function safeClientQuery<Row extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: unknown[] = [],
  uniqueViolationCode?: RemoteMcpOAuthSecurityStoreErrorCode,
): Promise<QueryResult<Row>> {
  try {
    return await client.query<Row>(text, values);
  } catch (error) {
    if (
      error instanceof RemoteMcpOAuthSecurityStoreError ||
      error instanceof RemoteMcpOAuthGuardError
    ) {
      throw error;
    }
    if (
      uniqueViolationCode &&
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw storeError(uniqueViolationCode);
    }
    throw storeError("DATABASE_UNAVAILABLE");
  }
}

async function connect(pool: Pool): Promise<PoolClient> {
  try {
    return await pool.connect();
  } catch {
    throw storeError("DATABASE_UNAVAILABLE");
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("rollback");
  } catch {
    // The original log-safe failure remains authoritative.
  }
}

function validOwner(row: OwnerRow | undefined, expectedOwnerId: string): boolean {
  return Boolean(
    row &&
    row.id === expectedOwnerId &&
    isUuid(row.auth_user_id) &&
    row.status === "active" &&
    isDate(row.email_verified_at) &&
    row.deleted_at === null,
  );
}

function validateActivationInput(input: RemoteMcpAuthorizationGrantActivationInput): {
  domainScopes: AgentScope[];
  protocolScopes: string[];
} {
  const protocolScopes = normalizeProtocolScopes(input?.scopes);
  const domainScopes = protocolScopes
    ? normalizeDomainScopes(protocolScopes.filter((scope) => scope !== "offline_access"))
    : null;
  if (
    !input ||
    !isUuid(input.authUserId) ||
    !isUuid(input.grantId) ||
    !isUuid(input.ownerSessionId) ||
    !isSafeClientId(input.oauthClientId) ||
    !isSafeRedirectUri(input.redirectUri) ||
    !isPkceS256Challenge(input.codeChallenge) ||
    input.codeChallengeMethod !== "S256" ||
    !isSafeResource(input.resource) ||
    !protocolScopes ||
    !domainScopes
  ) {
    throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
  }
  return { domainScopes, protocolScopes };
}

function validateCompensationInput(
  input: RemoteMcpAuthorizationGrantExchangeCompensationInput,
): void {
  if (!input || !isUuid(input.grantId)) {
    throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
  }
}

function validateAccessInput(input: RemoteMcpAccessTokenAuthorityPersistenceInput): {
  protocolScopes: RemoteMcpOAuthScope[];
  scopes: AgentScope[];
} {
  const scopes = normalizeDomainScopes(input?.scopes);
  const protocolScopes = normalizeProtocolScopes(input?.protocolScopes);
  if (
    !input ||
    !isUuid(input.authUserId) ||
    !isUuid(input.grantId) ||
    !isUuid(input.jti) ||
    !isSafeClientId(input.oauthClientId) ||
    !isSafeResource(input.resource) ||
    !isDate(input.issuedAt) ||
    !isDate(input.expiresAt) ||
    !scopes ||
    !protocolScopes ||
    !sameSet(
      scopes,
      protocolScopes.filter((scope) => scope !== "offline_access"),
    ) ||
    input.expiresAt.valueOf() - input.issuedAt.valueOf() !==
      ACCESS_TOKEN_LIFETIME_MILLISECONDS
  ) {
    throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
  }
  return { protocolScopes: protocolScopes as RemoteMcpOAuthScope[], scopes };
}

function validateAccessAuthority(
  row: AccessAuthorityRow | undefined,
  owner: OwnerRow,
  input: RemoteMcpAccessTokenAuthorityPersistenceInput,
  protocolScopes: readonly RemoteMcpOAuthScope[],
  scopes: readonly AgentScope[],
): { epoch: number } {
  if (!row || !isDate(row.authority_checked_at)) {
    throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
  }
  const epoch = parsePositiveEpoch(row.grant_token_epoch);
  const credentialScopes = normalizeDomainScopes(row.credential_scopes);
  const grantScopes = normalizeDomainScopes(row.grant_scopes);
  const requestScopes = normalizeProtocolScopes(row.request_requested_scopes);
  const clientScopes = normalizeProtocolScopes(row.client_scopes);
  const clientGrantTypes = isStringArray(row.client_grant_types)
    ? row.client_grant_types
    : null;
  const expectedProtocolScopes = grantScopes
    ? providerScopesForGrant(grantScopes, row.grant_offline_access)
    : null;
  const checkedAt = row.authority_checked_at.valueOf();
  const issuedAt = input.issuedAt.valueOf();
  const expiresAt = input.expiresAt.valueOf();
  if (
    !epoch ||
    !credentialScopes ||
    !grantScopes ||
    !requestScopes ||
    !clientScopes ||
    !clientGrantTypes ||
    !expectedProtocolScopes ||
    !sameSet(scopes, credentialScopes) ||
    !sameSet(scopes, grantScopes) ||
    !sameSet(protocolScopes, expectedProtocolScopes) ||
    !sameSet(expectedProtocolScopes, requestScopes) ||
    expectedProtocolScopes.some((scope) => !clientScopes.includes(scope)) ||
    !clientGrantTypes.includes("authorization_code") ||
    (row.grant_offline_access && !clientGrantTypes.includes("refresh_token")) ||
    !isUuid(row.agent_id) ||
    !isUuid(row.credential_id) ||
    !isSafeClientId(row.client_id) ||
    row.grant_id !== input.grantId ||
    row.grant_owner_id !== owner.id ||
    row.grant_auth_user_id !== input.authUserId ||
    row.grant_agent_id !== row.agent_id ||
    row.agent_owner_id !== owner.id ||
    row.agent_status !== "active" ||
    row.agent_deleted_at !== null ||
    row.actor_owner_id !== owner.id ||
    row.actor_kind !== "agent" ||
    row.actor_status !== "active" ||
    row.actor_deleted_at !== null ||
    row.grant_credential_id !== row.credential_id ||
    row.grant_resource !== input.resource ||
    row.oauth_client_id !== input.oauthClientId ||
    row.client_id !== input.oauthClientId ||
    row.configured_resource !== input.resource ||
    row.client_disabled !== false ||
    row.client_public !== true ||
    row.client_skip_consent !== false ||
    row.client_require_pkce !== true ||
    row.client_secret !== null ||
    row.client_token_endpoint_auth_method !== "none" ||
    row.credential_type !== "oauth_grant" ||
    row.credential_audience !== input.resource ||
    row.credential_revoked_at !== null ||
    !isDate(row.credential_expires_at) ||
    !isDate(row.grant_expires_at) ||
    !isDate(row.request_expires_at) ||
    row.credential_expires_at.valueOf() < expiresAt ||
    row.grant_expires_at.valueOf() < expiresAt ||
    expiresAt <= checkedAt ||
    issuedAt > checkedAt + CLOCK_SKEW_MILLISECONDS ||
    row.request_id.length < 1 ||
    row.request_owner_id !== owner.id ||
    row.request_agent_id !== row.agent_id ||
    row.request_oauth_client_id !== input.oauthClientId ||
    row.request_resource !== input.resource ||
    row.grant_status !== "active" ||
    row.request_status !== "consumed" ||
    row.request_grant_id !== row.grant_id ||
    !isDate(row.grant_activated_at) ||
    issuedAt < row.grant_activated_at.valueOf() - CLOCK_SKEW_MILLISECONDS
  ) {
    throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
  }
  return { epoch };
}

function validateActivationAuthority(
  row: AccessAuthorityRow | undefined,
  owner: OwnerRow,
  input: RemoteMcpAuthorizationGrantActivationInput,
  domainScopes: readonly AgentScope[],
  protocolScopes: readonly string[],
): { epoch: number; lifecycle: "active" | "pending" } {
  if (!row || !isDate(row.authority_checked_at)) {
    throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
  }
  const epoch = parsePositiveEpoch(row.grant_token_epoch);
  const credentialScopes = normalizeDomainScopes(row.credential_scopes);
  const grantScopes = normalizeDomainScopes(row.grant_scopes);
  const requestScopes = normalizeProtocolScopes(row.request_requested_scopes);
  const clientScopes = normalizeProtocolScopes(row.client_scopes);
  const clientGrantTypes = isStringArray(row.client_grant_types)
    ? row.client_grant_types
    : null;
  const clientRedirectUris = isStringArray(row.client_redirect_uris)
    ? row.client_redirect_uris
    : null;
  const expectedProtocolScopes = grantScopes
    ? providerScopesForGrant(grantScopes, row.grant_offline_access)
    : null;
  const checkedAt = row.authority_checked_at.valueOf();
  if (row.grant_status !== "pending" && row.grant_status !== "active") {
    throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
  }
  const lifecycle = row.grant_status;
  if (
    !epoch ||
    !credentialScopes ||
    !grantScopes ||
    !requestScopes ||
    !clientScopes ||
    !clientGrantTypes ||
    !clientRedirectUris ||
    !expectedProtocolScopes ||
    !sameSet(domainScopes, credentialScopes) ||
    !sameSet(domainScopes, grantScopes) ||
    !sameSet(protocolScopes, requestScopes) ||
    !sameSet(protocolScopes, expectedProtocolScopes) ||
    protocolScopes.some((scope) => !clientScopes.includes(scope)) ||
    !clientGrantTypes.includes("authorization_code") ||
    (row.grant_offline_access && !clientGrantTypes.includes("refresh_token")) ||
    !clientRedirectUris.includes(input.redirectUri) ||
    !isUuid(row.agent_id) ||
    !isUuid(row.credential_id) ||
    row.grant_id !== input.grantId ||
    row.grant_owner_id !== owner.id ||
    row.grant_auth_user_id !== input.authUserId ||
    row.grant_agent_id !== row.agent_id ||
    row.agent_owner_id !== owner.id ||
    row.agent_status !== "active" ||
    row.agent_deleted_at !== null ||
    row.actor_owner_id !== owner.id ||
    row.actor_kind !== "agent" ||
    row.actor_status !== "active" ||
    row.actor_deleted_at !== null ||
    row.grant_credential_id !== row.credential_id ||
    row.grant_resource !== input.resource ||
    row.oauth_client_id !== input.oauthClientId ||
    row.client_id !== input.oauthClientId ||
    row.configured_resource !== input.resource ||
    row.client_disabled !== false ||
    row.client_public !== true ||
    row.client_skip_consent !== false ||
    row.client_require_pkce !== true ||
    row.client_secret !== null ||
    row.client_token_endpoint_auth_method !== "none" ||
    row.credential_type !== "oauth_grant" ||
    row.credential_audience !== input.resource ||
    row.credential_revoked_at !== null ||
    !isDate(row.credential_expires_at) ||
    !isDate(row.grant_expires_at) ||
    !isDate(row.request_expires_at) ||
    row.credential_expires_at.valueOf() <
      checkedAt + ACCESS_TOKEN_LIFETIME_MILLISECONDS + CLOCK_SKEW_MILLISECONDS ||
    row.grant_expires_at.valueOf() <
      checkedAt + ACCESS_TOKEN_LIFETIME_MILLISECONDS + CLOCK_SKEW_MILLISECONDS ||
    row.request_owner_id !== owner.id ||
    row.request_owner_session_id !== input.ownerSessionId ||
    row.request_agent_id !== row.agent_id ||
    row.request_oauth_client_id !== input.oauthClientId ||
    row.request_resource !== input.resource ||
    row.request_redirect_uri !== input.redirectUri ||
    row.request_code_challenge !== input.codeChallenge ||
    row.request_code_challenge_method !== input.codeChallengeMethod ||
    (lifecycle === "pending" &&
      (row.request_status !== "consumed" ||
        row.request_grant_id !== row.grant_id ||
        row.grant_activated_at !== null)) ||
    (lifecycle === "active" &&
      (row.request_status !== "consumed" ||
        row.request_grant_id !== row.grant_id ||
        !isDate(row.grant_activated_at)))
  ) {
    throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
  }
  return { epoch, lifecycle };
}

function refreshDigest(rawRefreshToken: string, key: Buffer): string {
  if (
    typeof rawRefreshToken !== "string" ||
    !rawRefreshToken.startsWith(REFRESH_TOKEN_PREFIX)
  ) {
    throw invalidRefreshGrant();
  }
  const tokenBody = rawRefreshToken.slice(REFRESH_TOKEN_PREFIX.length);
  if (!REFRESH_TOKEN_BODY_PATTERN.test(tokenBody)) throw invalidRefreshGrant();
  return createHmac("sha256", key)
    .update(PROVIDER_REFRESH_DIGEST_DOMAIN, "utf8")
    .update(tokenBody, "utf8")
    .digest("base64url");
}

function authorizationCodeDigest(
  input: RemoteMcpAuthorizationCodeExchangeLockInput,
  key: Buffer,
): string {
  if (
    !input ||
    !AUTHORIZATION_CODE_PATTERN.test(input.authorizationCode) ||
    !CODE_VERIFIER_PATTERN.test(input.codeVerifier) ||
    !isSafeClientId(input.clientId) ||
    !isSafeRedirectUri(input.redirectUri) ||
    !isSafeResource(input.resource)
  ) {
    throw invalidAuthorizationCodeGrant();
  }
  const providerDigest = createHmac("sha256", key)
    .update(PROVIDER_AUTHORIZATION_CODE_DIGEST_DOMAIN, "utf8")
    .update(input.authorizationCode, "utf8")
    .digest("base64url");
  // Better Auth 1.6.23 applies the runtime's verification.storeIdentifier
  // transform after the OAuth Provider storeTokens hook. AlphaNet configures
  // that transform as SHA-256, so the transaction lock must locate exactly the
  // doubly protected identifier persisted by the real Provider runtime.
  return createHash("sha256").update(providerDigest, "utf8").digest("base64url");
}

function buildRefreshAuthority(
  row: RefreshAuthorityRow | undefined,
  owner: OwnerRow,
  clientId: string,
  resource: string,
): { authority: RemoteMcpRefreshLockedAuthority; replay: boolean } {
  if (!row || !isDate(row.authority_checked_at)) throw invalidRefreshGrant();
  const credentialScopes = normalizeDomainScopes(row.credential_scopes);
  const grantDomainScopes = normalizeDomainScopes(row.grant_scopes);
  const originalScopes = normalizeProtocolScopes(row.refresh_scopes);
  const clientScopes = normalizeProtocolScopes(row.client_scopes);
  const clientGrantTypes = isStringArray(row.client_grant_types)
    ? row.client_grant_types
    : null;
  const expectedProtocolScopes = grantDomainScopes
    ? providerScopesForGrant(grantDomainScopes, row.grant_offline_access)
    : null;
  if (
    !credentialScopes ||
    !grantDomainScopes ||
    !originalScopes ||
    !clientScopes ||
    !clientGrantTypes ||
    !expectedProtocolScopes ||
    !sameSet(credentialScopes, grantDomainScopes) ||
    !sameSet(originalScopes, expectedProtocolScopes) ||
    expectedProtocolScopes.some((scope) => !clientScopes.includes(scope)) ||
    !clientGrantTypes.includes("authorization_code") ||
    !clientGrantTypes.includes("refresh_token") ||
    !isUuid(row.grant_id) ||
    !isUuid(row.agent_id) ||
    !isUuid(row.credential_id) ||
    row.owner_id !== owner.id ||
    row.grant_agent_id !== row.agent_id ||
    row.agent_owner_id !== owner.id ||
    row.actor_owner_id !== owner.id ||
    row.actor_kind !== "agent" ||
    row.refresh_auth_user_id !== owner.auth_user_id ||
    row.refresh_client_id !== clientId ||
    row.oauth_client_id !== clientId ||
    row.client_id !== clientId ||
    row.refresh_reference_id !== row.grant_id ||
    row.grant_resource !== resource ||
    row.credential_audience !== resource ||
    row.configured_resource !== resource ||
    !isDate(row.refresh_created_at) ||
    !isDate(row.refresh_expires_at) ||
    !isDate(row.grant_expires_at) ||
    !isDate(row.credential_expires_at) ||
    (row.refresh_revoked_at !== null && !isDate(row.refresh_revoked_at))
  ) {
    throw invalidRefreshGrant();
  }

  const replay = row.refresh_revoked_at !== null;
  const checkedAt = row.authority_checked_at.valueOf();
  if (
    !replay &&
    (row.client_disabled !== false ||
      row.client_public !== true ||
      row.client_skip_consent !== false ||
      row.client_require_pkce !== true ||
      row.client_secret !== null ||
      row.client_token_endpoint_auth_method !== "none" ||
      row.agent_status !== "active" ||
      row.agent_deleted_at !== null ||
      row.actor_status !== "active" ||
      row.actor_deleted_at !== null ||
      row.grant_status !== "active" ||
      row.credential_revoked_at !== null ||
      row.refresh_created_at.valueOf() > checkedAt + CLOCK_SKEW_MILLISECONDS ||
      row.refresh_expires_at.valueOf() <= checkedAt ||
      row.refresh_expires_at.valueOf() <= row.refresh_created_at.valueOf() ||
      row.refresh_expires_at.valueOf() - row.refresh_created_at.valueOf() >
        30 * 24 * 60 * 60 * 1_000 ||
      row.grant_offline_access !== true ||
      row.grant_expires_at.valueOf() <
        checkedAt + ACCESS_TOKEN_LIFETIME_MILLISECONDS + CLOCK_SKEW_MILLISECONDS ||
      row.credential_expires_at.valueOf() <
        checkedAt + ACCESS_TOKEN_LIFETIME_MILLISECONDS + CLOCK_SKEW_MILLISECONDS ||
      row.refresh_expires_at.valueOf() > row.grant_expires_at.valueOf() ||
      row.refresh_expires_at.valueOf() > row.credential_expires_at.valueOf())
  ) {
    throw invalidRefreshGrant();
  }

  return {
    authority: {
      clientEnabled: row.client_disabled === false,
      clientId,
      credentialExpiresAt: row.credential_expires_at,
      credentialId: row.credential_id,
      credentialResource: row.credential_audience,
      credentialRevokedAt: row.credential_revoked_at,
      credentialScopes,
      grantExpiresAt: row.grant_expires_at,
      grantId: row.grant_id,
      grantResource: row.grant_resource,
      grantScopes: expectedProtocolScopes,
      grantStatus:
        row.grant_status === "pending" ||
        row.grant_status === "expired" ||
        row.grant_status === "revoked" ||
        row.grant_status === "compromised"
          ? row.grant_status
          : "active",
      originalRefreshTokenScopes: originalScopes,
      ownerId: owner.id,
      refreshTokenExpiresAt: row.refresh_expires_at,
      refreshTokenIssuedAt: row.refresh_created_at,
      refreshTokenRevokedAt: row.refresh_revoked_at,
    },
    replay,
  };
}

export function createAlphaNetRemoteMcpOAuthSecurityStore(
  options: AlphaNetRemoteMcpOAuthSecurityStoreOptions,
): AlphaNetRemoteMcpOAuthSecurityStore {
  if (
    !options ||
    !options.pool ||
    typeof options.pool.query !== "function" ||
    typeof options.pool.connect !== "function" ||
    !options.lockPool ||
    typeof options.lockPool.query !== "function" ||
    typeof options.lockPool.connect !== "function" ||
    options.lockPool === options.pool
  ) {
    throw storeError("CONFIG_INVALID");
  }
  const authorizationBindingKey = copyKey(
    options.authorizationBindingKey,
    "Remote MCP OAuth authorization binding key",
  );
  const refreshTokenStorageKey = copyKey(
    options.refreshTokenStorageKey,
    "Remote MCP OAuth refresh-token storage key",
  );
  const tokenJtiDigestKey = copyExactKey(
    options.tokenJtiDigestKey,
    32,
    "Remote MCP OAuth JTI digest key",
  );
  assertIndependentKeys([
    authorizationBindingKey,
    refreshTokenStorageKey,
    tokenJtiDigestKey,
  ]);
  const { lockPool, pool } = options;

  async function readGrantAuthority(
    client: PoolClient,
    grantId: string,
    ownerId: string,
    lock: "share" | "update",
  ): Promise<QueryResult<AccessAuthorityRow>> {
    const rowLocks =
      lock === "update"
        ? `for update of oauth_grant, authorization_request
           for share of agent, actor, credential, oauth_client, resource_configuration`
        : `for share of oauth_grant, authorization_request, agent, actor,
           credential, oauth_client, resource_configuration`;
    return safeClientQuery<AccessAuthorityRow>(
      client,
      `/* remote_mcp_oauth_store:read_access_authority */
       select
         statement_timestamp() as authority_checked_at,
         oauth_grant.id::text as grant_id,
         oauth_grant.owner_id::text as grant_owner_id,
         oauth_grant.auth_user_id::text as grant_auth_user_id,
         oauth_grant.agent_id::text as grant_agent_id,
         oauth_grant.credential_id::text as grant_credential_id,
         oauth_grant.oauth_client_id,
         oauth_grant.resource as grant_resource,
         oauth_grant.scopes as grant_scopes,
         oauth_grant.offline_access as grant_offline_access,
         oauth_grant.status as grant_status,
         oauth_grant.token_epoch::text as grant_token_epoch,
         oauth_grant.activated_at as grant_activated_at,
         oauth_grant.expires_at as grant_expires_at,
         agent.id::text as agent_id,
         agent.owner_id::text as agent_owner_id,
         agent.status as agent_status,
         agent.deleted_at as agent_deleted_at,
         actor.owner_id::text as actor_owner_id,
         actor.kind as actor_kind,
         actor.status as actor_status,
         actor.deleted_at as actor_deleted_at,
         credential.id::text as credential_id,
         credential.credential_type,
         credential.scopes as credential_scopes,
         credential.audience as credential_audience,
         credential.expires_at as credential_expires_at,
         credential.revoked_at as credential_revoked_at,
         oauth_client.client_id,
         oauth_client.disabled as client_disabled,
         oauth_client.public as client_public,
         oauth_client.skip_consent as client_skip_consent,
         oauth_client.require_pkce as client_require_pkce,
         oauth_client.client_secret,
         oauth_client.token_endpoint_auth_method as client_token_endpoint_auth_method,
         oauth_client.scopes as client_scopes,
         oauth_client.redirect_uris as client_redirect_uris,
         oauth_client.grant_types as client_grant_types,
         resource_configuration.resource as configured_resource,
         authorization_request.id::text as request_id,
         authorization_request.owner_id::text as request_owner_id,
         authorization_request.owner_session_id::text as request_owner_session_id,
         authorization_request.agent_id::text as request_agent_id,
         authorization_request.oauth_client_id as request_oauth_client_id,
         authorization_request.resource as request_resource,
         authorization_request.requested_scopes as request_requested_scopes,
         authorization_request.redirect_uri as request_redirect_uri,
         authorization_request.code_challenge as request_code_challenge,
         authorization_request.code_challenge_method as request_code_challenge_method,
         authorization_request.status as request_status,
         authorization_request.grant_id::text as request_grant_id,
         authorization_request.expires_at as request_expires_at
       from platform.oauth_grants as oauth_grant
       inner join platform.agents as agent
         on agent.id = oauth_grant.agent_id
        and agent.owner_id = oauth_grant.owner_id
       inner join platform.actors as actor
         on actor.id = agent.actor_id
        and actor.owner_id = oauth_grant.owner_id
       inner join platform.credentials as credential
         on credential.id = oauth_grant.credential_id
        and credential.owner_id = oauth_grant.owner_id
        and credential.agent_id = oauth_grant.agent_id
       inner join auth.oauth_clients as oauth_client
         on oauth_client.client_id = oauth_grant.oauth_client_id
       inner join platform.oauth_resource_configuration as resource_configuration
         on resource_configuration.resource = oauth_grant.resource
       inner join platform.oauth_authorization_requests as authorization_request
         on authorization_request.id = oauth_grant.authorization_request_id
       where oauth_grant.id = $1::uuid
         and oauth_grant.owner_id = $2::uuid
       limit 1
       ${rowLocks}`,
      [grantId, ownerId],
    );
  }

  async function acquireOwnerClientRefreshLock(
    client: PoolClient,
    ownerId: string,
    clientId: string,
  ): Promise<void> {
    await safeClientQuery(
      client,
      `select pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended(
           'alphanet:remote-mcp-refresh:' ||
           pg_catalog.octet_length($1::text)::text || ':' || $1::text || ':' ||
           pg_catalog.octet_length($2::text)::text || ':' || $2::text,
           0
         )
       )`,
      [ownerId, clientId],
    );
  }

  async function compromiseOwnerClientRefreshFamily(
    client: PoolClient,
    ownerId: string,
    authUserId: string,
    clientId: string,
    reasonCode: "refresh_rotation_failed" | "refresh_token_reuse",
  ): Promise<void> {
    await safeClientQuery(
      client,
      `/* remote_mcp_oauth_store:revoke_refresh_family */
       update auth.oauth_refresh_tokens
       set revoked = greatest(statement_timestamp(), created_at)
       where user_id = $1::uuid
         and client_id = $2
         and revoked is null`,
      [authUserId, clientId],
    );
    await safeClientQuery(
      client,
      `/* remote_mcp_oauth_store:delete_provider_access_family */
       delete from auth.oauth_access_tokens
       where user_id = $1::uuid
         and client_id = $2`,
      [authUserId, clientId],
    );
    await safeClientQuery(
      client,
      `/* remote_mcp_oauth_store:revoke_jti_family */
       update platform.oauth_access_token_jtis as token_jti
       set status = 'revoked',
           revoked_at = greatest(statement_timestamp(), token_jti.issued_at),
           revocation_reason_code = $3
       where token_jti.status = 'active'
         and exists (
           select 1
           from platform.oauth_grants as oauth_grant
           where oauth_grant.id = token_jti.grant_id
             and oauth_grant.owner_id = $1::uuid
             and oauth_grant.oauth_client_id = $2
         )`,
      [ownerId, clientId, reasonCode],
    );
    await safeClientQuery(
      client,
      `/* remote_mcp_oauth_store:revoke_credential_family */
       update platform.credentials as credential
       set revoked_at = greatest(statement_timestamp(), credential.issued_at)
       where credential.revoked_at is null
         and exists (
           select 1
           from platform.oauth_grants as oauth_grant
           where oauth_grant.credential_id = credential.id
             and oauth_grant.owner_id = $1::uuid
             and oauth_grant.oauth_client_id = $2
         )`,
      [ownerId, clientId],
    );
    await safeClientQuery(
      client,
      `/* remote_mcp_oauth_store:compromise_grant_family */
       update platform.oauth_grants
       set status = 'compromised',
           token_epoch = token_epoch + 1,
           reason_code = $3
       where owner_id = $1::uuid
         and oauth_client_id = $2
         and status in ('pending', 'active')`,
      [ownerId, clientId, reasonCode],
    );
  }

  async function persistAuthorizationRequestEnvelope(
    input: ValidatedRemoteMcpAuthorizeQuery,
  ): Promise<void> {
    let envelope;
    try {
      envelope = createRemoteMcpAuthorizationRequestEnvelope(
        input,
        authorizationBindingKey,
      );
    } catch {
      throw storeError("AUTHORIZATION_REQUEST_INVALID");
    }
    const client = await connect(pool);
    let transactionStarted = false;
    try {
      await safeClientQuery(client, "begin");
      transactionStarted = true;
      const inserted = await safeClientQuery<{ id: string }>(
        client,
        `/* remote_mcp_oauth_store:insert_authorization_request */
         insert into platform.oauth_authorization_requests (
           binding_digest,
           oauth_client_id,
           resource,
           requested_scopes,
           redirect_uri,
           code_challenge,
           code_challenge_method,
           created_at,
           expires_at
         )
         values ($1, $2, $3, $4::text[], $5, $6, 'S256',
           statement_timestamp(), statement_timestamp() + interval '5 minutes')
         on conflict (binding_digest) do nothing
         returning id::text`,
        [
          envelope.bindingDigest,
          envelope.oauthClientId,
          envelope.resource,
          [...envelope.requestedScopes],
          envelope.redirectUri,
          envelope.codeChallenge,
        ],
      );
      if (inserted.rowCount === 0) {
        const existing = await safeClientQuery<AuthorizationRequestRow>(
          client,
          `/* remote_mcp_oauth_store:revalidate_authorization_request */
           select
             oauth_client_id,
             resource,
             requested_scopes,
             redirect_uri,
             code_challenge,
             code_challenge_method,
             owner_id::text,
             agent_id::text,
             owner_session_id::text,
             grant_id::text,
             status,
             expires_at
           from platform.oauth_authorization_requests
           where binding_digest = $1
             and oauth_client_id = $2
             and resource = $3
             and requested_scopes <@ $4::text[]
             and $4::text[] <@ requested_scopes
             and redirect_uri = $5
             and code_challenge = $6
             and code_challenge_method = 'S256'
             and owner_id is null
             and agent_id is null
             and owner_session_id is null
             and grant_id is null
             and status = 'pending'
             and created_at <= statement_timestamp()
             and expires_at > statement_timestamp()
             and expires_at <= created_at + interval '5 minutes'
           for share`,
          [
            envelope.bindingDigest,
            envelope.oauthClientId,
            envelope.resource,
            [...envelope.requestedScopes],
            envelope.redirectUri,
            envelope.codeChallenge,
          ],
        );
        const row = existing.rows[0];
        if (
          existing.rowCount !== 1 ||
          !row ||
          row.oauth_client_id !== envelope.oauthClientId ||
          row.resource !== envelope.resource ||
          !sameSet(row.requested_scopes, envelope.requestedScopes) ||
          row.redirect_uri !== envelope.redirectUri ||
          row.code_challenge !== envelope.codeChallenge ||
          row.code_challenge_method !== "S256" ||
          row.owner_id !== null ||
          row.agent_id !== null ||
          row.owner_session_id !== null ||
          row.grant_id !== null ||
          row.status !== "pending" ||
          !isDate(row.expires_at)
        ) {
          throw storeError("AUTHORIZATION_REQUEST_INVALID");
        }
      } else if (inserted.rowCount !== 1) {
        throw storeError("AUTHORIZATION_REQUEST_INVALID");
      }
      await safeClientQuery(client, "commit");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) await rollbackQuietly(client);
      if (error instanceof RemoteMcpOAuthSecurityStoreError) throw error;
      throw storeError("DATABASE_UNAVAILABLE");
    } finally {
      client.release();
    }
  }

  async function activateAuthorizationGrant(
    input: RemoteMcpAuthorizationGrantActivationInput,
  ): Promise<void> {
    const { domainScopes, protocolScopes } = validateActivationInput(input);
    const ownerLocator = await safePoolQuery<OwnerLocatorRow>(
      pool,
      `/* remote_mcp_oauth_store:locate_activation_owner */
       select owner_id::text
       from platform.oauth_grants
       where id = $1::uuid
       limit 1`,
      [input.grantId],
    );
    const ownerId = ownerLocator.rows[0]?.owner_id;
    if (!isUuid(ownerId)) throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");

    const client = await connect(pool);
    let transactionStarted = false;
    try {
      await safeClientQuery(client, "begin");
      transactionStarted = true;
      const owners = await safeClientQuery<OwnerRow>(
        client,
        `/* remote_mcp_oauth_store:lock_activation_owner */
         select id::text, auth_user_id::text, status, email_verified_at, deleted_at
         from platform.owners
         where id = $1::uuid
         for share`,
        [ownerId],
      );
      const owner = owners.rows[0];
      if (
        owners.rowCount !== 1 ||
        !validOwner(owner, ownerId) ||
        owner?.auth_user_id !== input.authUserId
      ) {
        throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
      }

      const authorityResult = await readGrantAuthority(
        client,
        input.grantId,
        ownerId,
        "update",
      );
      const authority = validateActivationAuthority(
        authorityResult.rows[0],
        owner,
        input,
        domainScopes,
        protocolScopes,
      );
      const row = authorityResult.rows[0];
      if (authorityResult.rowCount !== 1 || !row) {
        throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
      }

      const liveSession = await safeClientQuery<{ id: string }>(
        client,
        `/* remote_mcp_oauth_store:lock_activation_session */
         select owner_session.id::text
         from auth.sessions as owner_session
         inner join auth.users as auth_user
           on auth_user.id = owner_session.user_id
          and auth_user.email_verified
         where owner_session.id = $1::uuid
           and owner_session.user_id = $2::uuid
           and owner_session.expires_at > statement_timestamp()
         for share of owner_session, auth_user`,
        [input.ownerSessionId, input.authUserId],
      );
      if (liveSession.rowCount !== 1) {
        throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
      }

      if (authority.lifecycle === "pending") {
        const activated = await safeClientQuery<{ token_epoch: string }>(
          client,
          `/* remote_mcp_oauth_store:activate_grant */
           update platform.oauth_grants
           set status = 'active'
           where id = $1::uuid
             and owner_id = $2::uuid
             and status = 'pending'
             and token_epoch = $3::bigint
             and expires_at >=
               statement_timestamp() + interval '10 minutes 5 seconds'
           returning token_epoch::text`,
          [input.grantId, ownerId, authority.epoch],
        );
        if (
          activated.rowCount !== 1 ||
          parsePositiveEpoch(activated.rows[0]?.token_epoch) !== authority.epoch
        ) {
          throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
        }
      }

      await safeClientQuery(client, "commit");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) await rollbackQuietly(client);
      if (error instanceof RemoteMcpOAuthSecurityStoreError) throw error;
      throw storeError("DATABASE_UNAVAILABLE");
    } finally {
      client.release();
    }
  }

  async function persistAccessTokenAuthority(
    input: RemoteMcpAccessTokenAuthorityPersistenceInput,
  ): Promise<RemoteMcpAccessTokenAuthorityPersistenceResult> {
    const { protocolScopes, scopes } = validateAccessInput(input);
    const jtiDigest = Buffer.from(
      digestInboundMcpTokenJti(input.jti, tokenJtiDigestKey),
      "base64url",
    );
    const ownerLocator = await safePoolQuery<OwnerLocatorRow>(
      pool,
      `/* remote_mcp_oauth_store:locate_access_owner */
       select owner_id::text
       from platform.oauth_grants
       where id = $1::uuid
       limit 1`,
      [input.grantId],
    );
    const ownerId = ownerLocator.rows[0]?.owner_id;
    if (!isUuid(ownerId)) throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");

    const client = await connect(pool);
    let transactionStarted = false;
    try {
      await safeClientQuery(client, "begin");
      transactionStarted = true;
      const owners = await safeClientQuery<OwnerRow>(
        client,
        `/* remote_mcp_oauth_store:lock_access_owner */
         select id::text, auth_user_id::text, status, email_verified_at, deleted_at
         from platform.owners
         where id = $1::uuid
         for share`,
        [ownerId],
      );
      const owner = owners.rows[0];
      if (
        !validOwner(owner, ownerId) ||
        owner?.auth_user_id !== input.authUserId ||
        owners.rowCount !== 1
      ) {
        throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
      }

      const authorityResult = await safeClientQuery<AccessAuthorityRow>(
        client,
        `/* remote_mcp_oauth_store:read_access_authority */
         select
           statement_timestamp() as authority_checked_at,
           oauth_grant.id::text as grant_id,
           oauth_grant.owner_id::text as grant_owner_id,
           oauth_grant.auth_user_id::text as grant_auth_user_id,
           oauth_grant.agent_id::text as grant_agent_id,
           oauth_grant.credential_id::text as grant_credential_id,
           oauth_grant.oauth_client_id,
           oauth_grant.resource as grant_resource,
           oauth_grant.scopes as grant_scopes,
           oauth_grant.offline_access as grant_offline_access,
           oauth_grant.status as grant_status,
           oauth_grant.token_epoch::text as grant_token_epoch,
           oauth_grant.activated_at as grant_activated_at,
           oauth_grant.expires_at as grant_expires_at,
           agent.id::text as agent_id,
           agent.owner_id::text as agent_owner_id,
           agent.status as agent_status,
           agent.deleted_at as agent_deleted_at,
           actor.owner_id::text as actor_owner_id,
           actor.kind as actor_kind,
           actor.status as actor_status,
           actor.deleted_at as actor_deleted_at,
           credential.id::text as credential_id,
           credential.credential_type,
           credential.scopes as credential_scopes,
           credential.audience as credential_audience,
           credential.expires_at as credential_expires_at,
           credential.revoked_at as credential_revoked_at,
           oauth_client.client_id,
           oauth_client.disabled as client_disabled,
           oauth_client.public as client_public,
           oauth_client.skip_consent as client_skip_consent,
           oauth_client.require_pkce as client_require_pkce,
           oauth_client.client_secret,
           oauth_client.token_endpoint_auth_method as client_token_endpoint_auth_method,
           oauth_client.scopes as client_scopes,
           oauth_client.grant_types as client_grant_types,
           resource_configuration.resource as configured_resource,
           authorization_request.id::text as request_id,
           authorization_request.owner_id::text as request_owner_id,
           authorization_request.agent_id::text as request_agent_id,
           authorization_request.oauth_client_id as request_oauth_client_id,
           authorization_request.resource as request_resource,
           authorization_request.requested_scopes as request_requested_scopes,
           authorization_request.status as request_status,
           authorization_request.grant_id::text as request_grant_id,
           authorization_request.expires_at as request_expires_at
         from platform.oauth_grants as oauth_grant
         inner join platform.agents as agent
           on agent.id = oauth_grant.agent_id
          and agent.owner_id = oauth_grant.owner_id
         inner join platform.actors as actor
           on actor.id = agent.actor_id
          and actor.owner_id = oauth_grant.owner_id
         inner join platform.credentials as credential
           on credential.id = oauth_grant.credential_id
          and credential.owner_id = oauth_grant.owner_id
          and credential.agent_id = oauth_grant.agent_id
         inner join auth.oauth_clients as oauth_client
           on oauth_client.client_id = oauth_grant.oauth_client_id
         inner join platform.oauth_resource_configuration as resource_configuration
           on resource_configuration.resource = oauth_grant.resource
         inner join platform.oauth_authorization_requests as authorization_request
           on authorization_request.id = oauth_grant.authorization_request_id
         where oauth_grant.id = $1::uuid
           and oauth_grant.owner_id = $2::uuid
         limit 1
         for share of oauth_grant, authorization_request, agent, actor, credential,
           oauth_client, resource_configuration`,
        [input.grantId, ownerId],
      );
      const authority = validateAccessAuthority(
        authorityResult.rows[0],
        owner,
        input,
        protocolScopes,
        scopes,
      );
      if (authorityResult.rowCount !== 1) {
        throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
      }

      const row = authorityResult.rows[0];
      if (!row) throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
      const inserted = await safeClientQuery<{ id: string }>(
        client,
        `/* remote_mcp_oauth_store:insert_access_jti */
         insert into platform.oauth_access_token_jtis (
           jti_digest,
           grant_id,
           owner_id,
           agent_id,
           grant_epoch,
           oauth_client_id,
           resource,
           scopes,
           status,
           issued_at,
           expires_at,
           created_at,
           updated_at
         )
         values (
           $1, $2::uuid, $3::uuid, $4::uuid, $5::bigint,
           $6, $7, $8::text[], 'active', $9::timestamptz,
           $10::timestamptz, $9::timestamptz,
           greatest(clock_timestamp(), $9::timestamptz)
         )
         returning id::text`,
        [
          jtiDigest,
          input.grantId,
          ownerId,
          row.agent_id,
          authority.epoch,
          row.client_id,
          input.resource,
          scopes,
          input.issuedAt,
          input.expiresAt,
        ],
        "ACCESS_TOKEN_AUTHORITY_INVALID",
      );
      if (inserted.rowCount !== 1) {
        throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
      }
      await safeClientQuery(client, "commit");
      transactionStarted = false;
      return {
        credentialId: row.credential_id,
        grantEpoch: authority.epoch,
        tokenJtiDigest: jtiDigest.toString("base64url"),
      };
    } catch (error) {
      if (transactionStarted) await rollbackQuietly(client);
      if (error instanceof RemoteMcpOAuthSecurityStoreError) throw error;
      throw storeError("DATABASE_UNAVAILABLE");
    } finally {
      client.release();
    }
  }

  async function compensateFailedAuthorizationGrantExchange(
    input: RemoteMcpAuthorizationGrantExchangeCompensationInput,
  ): Promise<void> {
    validateCompensationInput(input);
    const locator = await safePoolQuery<GrantLocatorRow>(
      pool,
      `/* remote_mcp_oauth_store:locate_failed_exchange_grant */
       select owner_id::text, auth_user_id::text, oauth_client_id
       from platform.oauth_grants
       where id = $1::uuid
       limit 1`,
      [input.grantId],
    );
    const located = locator.rows[0];
    if (
      locator.rowCount !== 1 ||
      !located ||
      !isUuid(located.owner_id) ||
      !isUuid(located.auth_user_id) ||
      !isSafeClientId(located.oauth_client_id)
    ) {
      throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
    }

    const client = await connect(pool);
    let transactionStarted = false;
    try {
      await safeClientQuery(client, "begin");
      transactionStarted = true;
      const owners = await safeClientQuery<OwnerRow>(
        client,
        `/* remote_mcp_oauth_store:lock_failed_exchange_owner */
         select id::text, auth_user_id::text, status, email_verified_at, deleted_at
         from platform.owners
         where id = $1::uuid
         for share`,
        [located.owner_id],
      );
      if (
        owners.rowCount !== 1 ||
        owners.rows[0]?.auth_user_id !== located.auth_user_id
      ) {
        throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
      }
      await acquireOwnerClientRefreshLock(
        client,
        located.owner_id,
        located.oauth_client_id,
      );
      const grant = await safeClientQuery<{
        credential_id: string;
        status: string;
      }>(
        client,
        `/* remote_mcp_oauth_store:lock_failed_exchange_grant */
         select credential_id::text, status
         from platform.oauth_grants
         where id = $1::uuid
           and owner_id = $2::uuid
           and auth_user_id = $3::uuid
           and oauth_client_id = $4
         for update`,
        [input.grantId, located.owner_id, located.auth_user_id, located.oauth_client_id],
      );
      const grantRow = grant.rows[0];
      if (!grantRow || grant.rowCount !== 1 || !isUuid(grantRow.credential_id)) {
        throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
      }

      await safeClientQuery(
        client,
        `/* remote_mcp_oauth_store:revoke_failed_exchange_refresh */
         update auth.oauth_refresh_tokens
         set revoked = greatest(statement_timestamp(), created_at)
         where reference_id = $1
           and client_id = $2
           and user_id = $3::uuid
           and revoked is null`,
        [input.grantId, located.oauth_client_id, located.auth_user_id],
      );
      await safeClientQuery(
        client,
        `/* remote_mcp_oauth_store:delete_failed_exchange_provider_access */
         delete from auth.oauth_access_tokens
         where reference_id = $1
           and client_id = $2
           and user_id = $3::uuid`,
        [input.grantId, located.oauth_client_id, located.auth_user_id],
      );
      await safeClientQuery(
        client,
        `/* remote_mcp_oauth_store:delete_failed_exchange_consent */
         delete from auth.oauth_consents
         where reference_id = $1
           and client_id = $2
           and user_id = $3::uuid`,
        [input.grantId, located.oauth_client_id, located.auth_user_id],
      );
      await safeClientQuery(
        client,
        `/* remote_mcp_oauth_store:revoke_failed_exchange_jtis */
         update platform.oauth_access_token_jtis
         set status = 'revoked',
             revoked_at = greatest(statement_timestamp(), issued_at),
             revocation_reason_code = 'oauth_bootstrap_failed'
         where grant_id = $1::uuid
           and status = 'active'`,
        [input.grantId],
      );
      await safeClientQuery(
        client,
        `/* remote_mcp_oauth_store:revoke_failed_exchange_credential */
         update platform.credentials
         set revoked_at = greatest(statement_timestamp(), issued_at)
         where id = $1::uuid
           and revoked_at is null`,
        [grantRow.credential_id],
      );
      if (grantRow.status === "pending" || grantRow.status === "active") {
        const compromised = await safeClientQuery<{ id: string }>(
          client,
          `/* remote_mcp_oauth_store:compromise_failed_exchange_grant */
           update platform.oauth_grants
           set status = 'compromised',
               token_epoch = token_epoch + 1,
               reason_code = 'oauth_bootstrap_failed'
           where id = $1::uuid
             and status in ('pending', 'active')
           returning id::text`,
          [input.grantId],
        );
        if (compromised.rowCount !== 1) {
          throw storeError("ACCESS_TOKEN_AUTHORITY_INVALID");
        }
      }
      await safeClientQuery(client, "commit");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) await rollbackQuietly(client);
      if (error instanceof RemoteMcpOAuthSecurityStoreError) throw error;
      throw storeError("DATABASE_UNAVAILABLE");
    } finally {
      client.release();
    }
  }

  async function withAuthorizationCodeExchangeLock<Result>(
    input: RemoteMcpAuthorizationCodeExchangeLockInput,
    executeWhileLocked: (
      authority: RemoteMcpAuthorizationCodeLockedAuthority,
    ) => Promise<Result>,
  ): Promise<Result> {
    if (typeof executeWhileLocked !== "function") {
      throw invalidAuthorizationCodeGrant();
    }
    const digest = authorizationCodeDigest(input, refreshTokenStorageKey);
    const client = await connect(lockPool);
    let transactionStarted = false;
    try {
      await safeClientQuery(client, "begin");
      transactionStarted = true;
      await safeClientQuery(
        client,
        `select pg_catalog.pg_advisory_xact_lock(
           pg_catalog.hashtextextended(
             'alphanet:remote-mcp-authorization-code:' || $1::text,
             0
           )
         )`,
        [digest],
      );
      const verification = await safeClientQuery<AuthorizationCodeVerificationRow>(
        client,
        `/* remote_mcp_oauth_store:read_authorization_code */
         select statement_timestamp() as authority_checked_at,
                value,
                expires_at
         from auth.verifications
         where identifier = $1
           and expires_at > statement_timestamp()
         order by id
         limit 2`,
        [digest],
      );
      if (verification.rowCount !== 1) {
        throw invalidAuthorizationCodeGrant();
      }
      const parsed = parseAuthorizationCodeVerification(verification.rows[0], input);
      const binding = await safeClientQuery<{ grant_id: string }>(
        client,
        `/* remote_mcp_oauth_store:bind_authorization_code_grant */
         select oauth_grant.id::text as grant_id
         from platform.oauth_grants as oauth_grant
         inner join platform.oauth_authorization_requests as authorization_request
           on authorization_request.id = oauth_grant.authorization_request_id
          and authorization_request.owner_id = oauth_grant.owner_id
          and authorization_request.agent_id = oauth_grant.agent_id
         where oauth_grant.id = $1::uuid
           and oauth_grant.auth_user_id = $2::uuid
           and oauth_grant.oauth_client_id = $3
           and oauth_grant.resource = $4
           and oauth_grant.status in ('pending', 'active')
           and authorization_request.status = 'consumed'
           and authorization_request.grant_id = oauth_grant.id
           and authorization_request.owner_session_id = $5::uuid
           and authorization_request.oauth_client_id = $3
           and authorization_request.resource = $4
           and authorization_request.redirect_uri = $6
           and authorization_request.code_challenge = $7
           and authorization_request.code_challenge_method = 'S256'
           and authorization_request.requested_scopes <@ $8::text[]
           and $8::text[] <@ authorization_request.requested_scopes
         limit 1`,
        [
          parsed.grantId,
          parsed.authUserId,
          input.clientId,
          input.resource,
          parsed.ownerSessionId,
          input.redirectUri,
          parsed.codeChallenge,
          parsed.scopes,
        ],
      );
      if (binding.rowCount !== 1 || binding.rows[0]?.grant_id !== parsed.grantId) {
        throw invalidAuthorizationCodeGrant();
      }

      const result = await executeWhileLocked(Object.freeze({ grantId: parsed.grantId }));
      await safeClientQuery(client, "commit");
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) await rollbackQuietly(client);
      if (
        error instanceof RemoteMcpOAuthSecurityStoreError ||
        error instanceof RemoteMcpOAuthGuardError
      ) {
        throw error;
      }
      throw error instanceof Error ? error : storeError("DATABASE_UNAVAILABLE");
    } finally {
      client.release();
    }
  }

  async function withOwnerClientRefreshLock<Result>(
    input: { clientId: string; refreshToken: string; resource: string },
    executeWhileLocked: (authority: RemoteMcpRefreshLockedAuthority) => Promise<Result>,
  ): Promise<Result> {
    if (
      !input ||
      !isSafeClientId(input.clientId) ||
      !isSafeResource(input.resource) ||
      typeof executeWhileLocked !== "function"
    ) {
      throw invalidRefreshGrant();
    }
    const digest = refreshDigest(input.refreshToken, refreshTokenStorageKey);
    const locator = await safePoolQuery<RefreshLocatorRow>(
      pool,
      `/* remote_mcp_oauth_store:locate_refresh_owner */
       select
         owner.id::text as owner_id,
         owner.auth_user_id::text as auth_user_id,
         refresh_token.client_id
       from auth.oauth_refresh_tokens as refresh_token
       inner join platform.owners as owner
         on owner.auth_user_id = refresh_token.user_id
       where refresh_token.token = $1
       limit 1`,
      [digest],
    );
    const located = locator.rows[0];
    if (
      locator.rowCount !== 1 ||
      !located ||
      !isUuid(located.owner_id) ||
      !isUuid(located.auth_user_id) ||
      located.client_id !== input.clientId
    ) {
      throw invalidRefreshGrant();
    }

    const client = await connect(lockPool);
    let callbackError: Error | undefined;
    let replayDetected = false;
    let result: Result | undefined;
    let transactionStarted = false;
    try {
      await safeClientQuery(client, "begin");
      transactionStarted = true;
      const owners = await safeClientQuery<OwnerRow>(
        client,
        `/* remote_mcp_oauth_store:lock_refresh_owner */
         select id::text, auth_user_id::text, status, email_verified_at, deleted_at
         from platform.owners
         where id = $1::uuid
         for share`,
        [located.owner_id],
      );
      const owner = owners.rows[0];
      if (
        owners.rowCount !== 1 ||
        !validOwner(owner, located.owner_id) ||
        owner?.auth_user_id !== located.auth_user_id
      ) {
        throw invalidRefreshGrant();
      }
      await acquireOwnerClientRefreshLock(client, located.owner_id, located.client_id);
      const authorityRows = await safeClientQuery<RefreshAuthorityRow>(
        client,
        `/* remote_mcp_oauth_store:read_refresh_authority */
         select
           statement_timestamp() as authority_checked_at,
           refresh_token.user_id::text as refresh_auth_user_id,
           refresh_token.client_id as refresh_client_id,
           refresh_token.reference_id as refresh_reference_id,
           refresh_token.scopes as refresh_scopes,
           refresh_token.created_at as refresh_created_at,
           refresh_token.expires_at as refresh_expires_at,
           refresh_token.revoked as refresh_revoked_at,
           oauth_grant.id::text as grant_id,
           oauth_grant.owner_id::text as owner_id,
           oauth_grant.agent_id::text as grant_agent_id,
           oauth_grant.oauth_client_id,
           oauth_grant.resource as grant_resource,
           oauth_grant.scopes as grant_scopes,
           oauth_grant.offline_access as grant_offline_access,
           oauth_grant.status as grant_status,
           oauth_grant.expires_at as grant_expires_at,
           agent.id::text as agent_id,
           agent.owner_id::text as agent_owner_id,
           agent.status as agent_status,
           agent.deleted_at as agent_deleted_at,
           actor.owner_id::text as actor_owner_id,
           actor.kind as actor_kind,
           actor.status as actor_status,
           actor.deleted_at as actor_deleted_at,
           credential.id::text as credential_id,
           credential.scopes as credential_scopes,
           credential.audience as credential_audience,
           credential.expires_at as credential_expires_at,
           credential.revoked_at as credential_revoked_at,
           oauth_client.client_id,
           oauth_client.disabled as client_disabled,
           oauth_client.public as client_public,
           oauth_client.skip_consent as client_skip_consent,
           oauth_client.require_pkce as client_require_pkce,
           oauth_client.client_secret,
           oauth_client.token_endpoint_auth_method as client_token_endpoint_auth_method,
           oauth_client.scopes as client_scopes,
           oauth_client.grant_types as client_grant_types,
           resource_configuration.resource as configured_resource
         from auth.oauth_refresh_tokens as refresh_token
         inner join platform.oauth_grants as oauth_grant
           on oauth_grant.id::text = refresh_token.reference_id
          and oauth_grant.auth_user_id = refresh_token.user_id
          and oauth_grant.oauth_client_id = refresh_token.client_id
         inner join platform.credentials as credential
           on credential.id = oauth_grant.credential_id
          and credential.owner_id = oauth_grant.owner_id
          and credential.agent_id = oauth_grant.agent_id
         inner join platform.agents as agent
           on agent.id = oauth_grant.agent_id
          and agent.owner_id = oauth_grant.owner_id
         inner join platform.actors as actor
           on actor.id = agent.actor_id
          and actor.owner_id = oauth_grant.owner_id
         inner join auth.oauth_clients as oauth_client
           on oauth_client.client_id = oauth_grant.oauth_client_id
         inner join platform.oauth_resource_configuration as resource_configuration
           on resource_configuration.resource = oauth_grant.resource
         where refresh_token.token = $1
           and oauth_grant.owner_id = $2::uuid
           and oauth_grant.oauth_client_id = $3
         limit 1
         for share of oauth_grant, credential, agent, actor, oauth_client,
           resource_configuration`,
        [digest, located.owner_id, located.client_id],
      );
      const current = buildRefreshAuthority(
        authorityRows.rows[0],
        owner,
        located.client_id,
        input.resource,
      );
      if (authorityRows.rowCount !== 1) throw invalidRefreshGrant();

      if (current.replay) {
        replayDetected = true;
        await compromiseOwnerClientRefreshFamily(
          client,
          located.owner_id,
          located.auth_user_id,
          located.client_id,
          "refresh_token_reuse",
        );
      } else {
        try {
          result = await executeWhileLocked(current.authority);
        } catch (error) {
          callbackError =
            error instanceof Error
              ? error
              : new Error("Remote MCP OAuth refresh provider failed");
        }
        if (
          (callbackError !== undefined &&
            !(callbackError instanceof RemoteMcpOAuthGuardError)) ||
          (result instanceof Response && !result.ok)
        ) {
          await compromiseOwnerClientRefreshFamily(
            client,
            located.owner_id,
            located.auth_user_id,
            located.client_id,
            "refresh_rotation_failed",
          );
        }
      }
      await safeClientQuery(client, "commit");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) await rollbackQuietly(client);
      if (callbackError !== undefined) throw callbackError;
      if (
        error instanceof RemoteMcpOAuthSecurityStoreError ||
        error instanceof RemoteMcpOAuthGuardError
      ) {
        throw error;
      }
      throw storeError("DATABASE_UNAVAILABLE");
    } finally {
      client.release();
    }
    if (callbackError !== undefined) throw callbackError;
    if (replayDetected) throw invalidRefreshGrant();
    return result as Result;
  }

  return {
    activateAuthorizationGrant,
    compensateFailedAuthorizationGrantExchange,
    persistAccessTokenAuthority,
    persistAuthorizationRequestEnvelope,
    withAuthorizationCodeExchangeLock,
    withOwnerClientRefreshLock,
  };
}
