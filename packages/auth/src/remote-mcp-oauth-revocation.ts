import { createHmac, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import { digestInboundMcpTokenJti } from "./mcp-actor-context.js";
import {
  REMOTE_MCP_OAUTH_SCOPE_ORDER,
  type RemoteMcpOAuthScope,
} from "./remote-mcp-oauth-guard.js";
import type {
  AlphaNetRemoteMcpOAuthSecurityHooks,
  RemoteMcpDomainRevocationInput,
  RemoteMcpDomainRevocationOperation,
} from "./remote-mcp-oauth-provider.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REFRESH_TOKEN_PREFIX = "aln_rt_v1_";
const REFRESH_TOKEN_BODY_PATTERN = /^[A-Za-z0-9]{32}$/u;
const REFRESH_TOKEN_DIGEST_DOMAIN = "alphanet:refresh_token:v1\0";
const WHITESPACE_PATTERN = /\s/u;
const CONTENT_TYPE_PARAMETERS = /^\s*charset\s*=\s*(?:"utf-8"|utf-8)\s*$/iu;
const MAX_REQUEST_BODY_BYTES = 16 * 1_024;
const MAX_OUTBOX_ATTEMPTS = 12;
const SCOPE_SET = new Set<string>(REMOTE_MCP_OAUTH_SCOPE_ORDER);

export interface RemoteMcpOAuthRevocationOwnerSession {
  authUserId: string;
  ownerId: string;
  sessionId: string;
}

/**
 * Claims from a cryptographically verified AlphaNet Remote MCP access token.
 * Implementations must verify signature, issuer, audience, lifetime and the
 * exact access-token profile before returning these authority locators.
 */
export interface VerifiedRemoteMcpAccessTokenForRevocation {
  clientId: string;
  grantId: string;
  jti: string;
  resource: string;
}

export interface AlphaNetRemoteMcpOAuthRevocationOptions {
  /** Authenticate the Better Auth Owner session without exposing its raw token. */
  authenticateOwner(
    request: Request,
  ): Promise<RemoteMcpOAuthRevocationOwnerSession | null>;
  issuer: string;
  pool: Pool;
  /** Exact key used by the Provider's refresh-token HMAC storage adapter. */
  refreshTokenStorageKey: Uint8Array;
  resource: string;
  /** Independent, exact 32-byte key used for access-token JTI authority rows. */
  tokenJtiDigestKey: Uint8Array;
  /**
   * Verify a possible JWT without logging or persisting it. Invalid or unknown
   * values return null so RFC 7009 revocation does not become a token oracle.
   */
  verifyAccessTokenForRevocation(
    token: string,
  ): Promise<VerifiedRemoteMcpAccessTokenForRevocation | null>;
}

export type AlphaNetRemoteMcpOAuthRevocationService = Pick<
  AlphaNetRemoteMcpOAuthSecurityHooks,
  "executeDomainRevocationTransaction"
>;

interface GrantAuthorityRow extends QueryResultRow {
  agent_id: string;
  credential_id: string;
  grant_id: string;
  oauth_client_id: string;
  owner_id: string;
  status: string;
  token_epoch: string;
}

interface OutboxSequenceRow extends QueryResultRow {
  next_sequence: string;
}

interface OutboxEventRow extends QueryResultRow {
  id: string;
}

interface ParsedOwnerRequest {
  consentId: string;
}

interface ParsedTokenRequest {
  clientId: string;
  token: string;
}

type ParsedRevocationRequest = ParsedOwnerRequest | ParsedTokenRequest;

class RequestAdmissionError extends Error {
  readonly kind: "invalid_request" | "not_found" | "unauthorized";

  constructor(kind: "invalid_request" | "not_found" | "unauthorized") {
    super(kind);
    this.name = "RequestAdmissionError";
    this.kind = kind;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isOwnerSession(
  value: RemoteMcpOAuthRevocationOwnerSession | null,
): value is RemoteMcpOAuthRevocationOwnerSession {
  return (
    value !== null &&
    isUuid(value.authUserId) &&
    isUuid(value.ownerId) &&
    isUuid(value.sessionId)
  );
}

function isBoundedNonWhitespaceValue(
  value: unknown,
  maximumLength: number,
): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    WHITESPACE_PATTERN.test(value)
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f) {
      return false;
    }
  }
  return true;
}

function isVerifiedAccessToken(
  value: VerifiedRemoteMcpAccessTokenForRevocation | null,
): value is VerifiedRemoteMcpAccessTokenForRevocation {
  return (
    value !== null &&
    isBoundedNonWhitespaceValue(value.clientId, 200) &&
    isUuid(value.grantId) &&
    isBoundedNonWhitespaceValue(value.jti, 8_192) &&
    typeof value.resource === "string"
  );
}

function exactContentType(request: Request, expected: string): boolean {
  const contentType = request.headers.get("content-type");
  if (contentType === null) return false;
  const parts = contentType.split(";");
  if (parts.length > 2 || parts[0]?.trim().toLowerCase() !== expected) return false;
  return parts.length === 1 || CONTENT_TYPE_PARAMETERS.test(parts[1] ?? "");
}

async function readBoundedUtf8(request: Request): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) ||
      Number(contentLength) > MAX_REQUEST_BODY_BYTES)
  ) {
    throw new RequestAdmissionError("invalid_request");
  }
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const readResult: unknown = await reader.read();
      if (!isRecord(readResult) || typeof readResult["done"] !== "boolean") {
        throw new RequestAdmissionError("invalid_request");
      }
      if (readResult["done"]) break;
      const chunk = readResult["value"];
      if (!(chunk instanceof Uint8Array)) {
        throw new RequestAdmissionError("invalid_request");
      }
      total += chunk.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        throw new RequestAdmissionError("invalid_request");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new RequestAdmissionError("invalid_request");
  }
}

function hasExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStrictScopeList(value: unknown): value is readonly RemoteMcpOAuthScope[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SCOPE_SET.size) {
    return false;
  }
  const seen = new Set<string>();
  return (
    value.some((scope) => scope !== "offline_access") &&
    value.every((scope) => {
      if (typeof scope !== "string" || !SCOPE_SET.has(scope) || seen.has(scope)) {
        return false;
      }
      seen.add(scope);
      return true;
    })
  );
}

async function parseOwnerRequest(
  operation: "delete_consent" | "update_consent",
  request: Request,
): Promise<ParsedOwnerRequest> {
  if (!exactContentType(request, "application/json")) {
    throw new RequestAdmissionError("invalid_request");
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedUtf8(request)) as unknown;
  } catch (error) {
    if (error instanceof RequestAdmissionError) throw error;
    throw new RequestAdmissionError("invalid_request");
  }
  if (!isRecord(body)) throw new RequestAdmissionError("invalid_request");

  if (operation === "delete_consent") {
    if (!hasExactKeys(body, ["id"]) || !isUuid(body.id)) {
      throw new RequestAdmissionError("invalid_request");
    }
    return { consentId: body.id };
  }

  if (
    !hasExactKeys(body, ["id", "update"]) ||
    !isUuid(body.id) ||
    !isRecord(body.update) ||
    !hasExactKeys(body.update, ["scopes"]) ||
    !isStrictScopeList(body.update.scopes)
  ) {
    throw new RequestAdmissionError("invalid_request");
  }
  return { consentId: body.id };
}

async function parseTokenRequest(request: Request): Promise<ParsedTokenRequest> {
  if (
    request.headers.has("authorization") ||
    !exactContentType(request, "application/x-www-form-urlencoded")
  ) {
    throw new RequestAdmissionError("invalid_request");
  }
  const parameters = new URLSearchParams(await readBoundedUtf8(request));
  const supported = new Set(["client_id", "token", "token_type_hint"]);
  const counts = new Map<string, number>();
  for (const [key] of parameters) {
    if (!supported.has(key)) throw new RequestAdmissionError("invalid_request");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (
    counts.get("client_id") !== 1 ||
    counts.get("token") !== 1 ||
    (counts.get("token_type_hint") ?? 0) > 1
  ) {
    throw new RequestAdmissionError("invalid_request");
  }
  const clientId = parameters.get("client_id");
  const token = parameters.get("token");
  const hint = parameters.get("token_type_hint");
  if (
    clientId === null ||
    token === null ||
    !isBoundedNonWhitespaceValue(clientId, 200) ||
    !isBoundedNonWhitespaceValue(token, 8_192) ||
    (hint !== null && hint !== "access_token" && hint !== "refresh_token")
  ) {
    throw new RequestAdmissionError("invalid_request");
  }
  return { clientId, token };
}

function operationPath(operation: RemoteMcpDomainRevocationOperation): string {
  switch (operation) {
    case "delete_consent":
      return "/oauth2/delete-consent";
    case "revoke_token":
      return "/oauth2/revoke";
    case "update_consent":
      return "/oauth2/update-consent";
    default:
      throw new RequestAdmissionError("invalid_request");
  }
}

async function parseRequest(
  issuer: URL,
  input: RemoteMcpDomainRevocationInput,
): Promise<ParsedRevocationRequest> {
  if (!(input?.request instanceof Request)) {
    throw new RequestAdmissionError("invalid_request");
  }
  const issuerPath = issuer.pathname.replace(/\/+$/u, "");
  const expectedUrl = `${issuer.origin}${issuerPath}${operationPath(input.operation)}`;
  if (input.request.method !== "POST" || input.request.url !== expectedUrl) {
    throw new RequestAdmissionError("invalid_request");
  }
  return input.operation === "revoke_token"
    ? parseTokenRequest(input.request)
    : parseOwnerRequest(input.operation, input.request);
}

function refreshTokenDigest(token: string, key: Buffer): Buffer | null {
  if (!token.startsWith(REFRESH_TOKEN_PREFIX)) return null;
  const body = token.slice(REFRESH_TOKEN_PREFIX.length);
  if (!REFRESH_TOKEN_BODY_PATTERN.test(body)) return null;
  return createHmac("sha256", key)
    .update(REFRESH_TOKEN_DIGEST_DOMAIN, "utf8")
    .update(body, "utf8")
    .digest();
}

function response(status: number, error?: string): Response {
  const headers = new Headers({ "Cache-Control": "no-store", Pragma: "no-cache" });
  if (error === undefined) return new Response(null, { headers, status });
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ error }), { headers, status });
}

function rowChanged(result: QueryResult): boolean {
  return (result.rowCount ?? 0) > 0;
}

async function assertPublicClient(
  client: PoolClient,
  clientId: string,
): Promise<boolean> {
  const result = await client.query(
    `/* remote_mcp_oauth_revocation:lock_public_client */
     select oauth_client.client_id
     from auth.oauth_clients as oauth_client
     where oauth_client.client_id = $1
       and oauth_client.disabled is distinct from true
       and oauth_client.public is true
       and oauth_client.client_secret is null
       and oauth_client.token_endpoint_auth_method = 'none'
     for share`,
    [clientId],
  );
  return result.rows.length === 1;
}

async function locateOwnerGrant(
  client: PoolClient,
  consentId: string,
  session: RemoteMcpOAuthRevocationOwnerSession,
  resource: string,
): Promise<GrantAuthorityRow | undefined> {
  const result = await client.query<GrantAuthorityRow>(
    `/* remote_mcp_oauth_revocation:lock_owner_consent_grant */
     select oauth_grant.id::text as grant_id,
            oauth_grant.owner_id::text,
            oauth_grant.agent_id::text,
            oauth_grant.credential_id::text,
            oauth_grant.oauth_client_id,
            oauth_grant.status,
            oauth_grant.token_epoch::text
     from auth.oauth_consents as oauth_consent
     inner join platform.oauth_grants as oauth_grant
       on oauth_grant.id::text = oauth_consent.reference_id
      and oauth_grant.oauth_client_id = oauth_consent.client_id
     inner join platform.owners as owner
       on owner.id = oauth_grant.owner_id
      and owner.auth_user_id = oauth_grant.auth_user_id
     inner join auth.sessions as owner_session
       on owner_session.id = $4::uuid
      and owner_session.user_id = owner.auth_user_id
      and owner_session.expires_at > statement_timestamp()
     inner join auth.oauth_clients as oauth_client
       on oauth_client.client_id = oauth_grant.oauth_client_id
      and oauth_client.public is true
      and oauth_client.client_secret is null
      and oauth_client.token_endpoint_auth_method = 'none'
     where oauth_consent.id = $1::uuid
       and oauth_consent.user_id = $2::uuid
       and owner.id = $3::uuid
       and owner.auth_user_id = $2::uuid
       and owner.status = 'active'
       and owner.email_verified_at is not null
       and owner.deleted_at is null
       and oauth_grant.resource = $5
     for update of oauth_consent, oauth_grant, owner_session
     for share of owner, oauth_client`,
    [consentId, session.authUserId, session.ownerId, session.sessionId, resource],
  );
  return result.rows[0];
}

async function locateRefreshGrant(
  client: PoolClient,
  digest: Buffer,
  clientId: string,
  resource: string,
): Promise<GrantAuthorityRow | undefined> {
  const result = await client.query<GrantAuthorityRow>(
    `/* remote_mcp_oauth_revocation:lock_refresh_grant */
     select oauth_grant.id::text as grant_id,
            oauth_grant.owner_id::text,
            oauth_grant.agent_id::text,
            oauth_grant.credential_id::text,
            oauth_grant.oauth_client_id,
            oauth_grant.status,
            oauth_grant.token_epoch::text
     from auth.oauth_refresh_tokens as refresh
     inner join platform.oauth_grants as oauth_grant
       on oauth_grant.id::text = refresh.reference_id
      and oauth_grant.oauth_client_id = refresh.client_id
     where refresh.token = $1
       and refresh.client_id = $2
       and oauth_grant.resource = $3
     for update of refresh, oauth_grant`,
    [digest.toString("base64url"), clientId, resource],
  );
  return result.rows[0];
}

async function locateAccessGrant(
  client: PoolClient,
  claims: VerifiedRemoteMcpAccessTokenForRevocation,
  digestKey: Buffer,
): Promise<GrantAuthorityRow | undefined> {
  let digest: Buffer;
  try {
    digest = Buffer.from(digestInboundMcpTokenJti(claims.jti, digestKey), "base64url");
  } catch {
    return undefined;
  }
  const result = await client.query<GrantAuthorityRow>(
    `/* remote_mcp_oauth_revocation:lock_access_grant */
     select oauth_grant.id::text as grant_id,
            oauth_grant.owner_id::text,
            oauth_grant.agent_id::text,
            oauth_grant.credential_id::text,
            oauth_grant.oauth_client_id,
            oauth_grant.status,
            oauth_grant.token_epoch::text
     from platform.oauth_access_token_jtis as token_jti
     inner join platform.oauth_grants as oauth_grant
       on oauth_grant.id = token_jti.grant_id
      and oauth_grant.owner_id = token_jti.owner_id
      and oauth_grant.agent_id = token_jti.agent_id
     where token_jti.jti_digest = $1::bytea
       and token_jti.grant_id = $2::uuid
       and token_jti.oauth_client_id = $3
       and token_jti.resource = $4
       and oauth_grant.oauth_client_id = $3
       and oauth_grant.resource = $4
     for update of token_jti, oauth_grant`,
    [digest, claims.grantId, claims.clientId, claims.resource],
  );
  return result.rows[0];
}

async function appendOutboxEvent(
  client: PoolClient,
  grant: GrantAuthorityRow,
  operation: RemoteMcpDomainRevocationOperation,
  reasonCode: string,
  epoch: string,
): Promise<string> {
  const aggregateType = "oauth_grant";
  await client.query(
    `/* remote_mcp_oauth_revocation:lock_outbox_aggregate */
     select pg_catalog.pg_advisory_xact_lock(
       pg_catalog.hashtextextended(
         'alphanet:outbox-aggregate:' ||
         pg_catalog.octet_length($1::text)::text || ':' || $1::text || ':' || $2::text,
         0
       )
     )`,
    [aggregateType, grant.grant_id],
  );
  const sequenceResult = await client.query<OutboxSequenceRow>(
    `/* remote_mcp_oauth_revocation:allocate_outbox_sequence */
     select coalesce(
       (select head.last_sequence + 1
        from system.outbox_aggregate_heads as head
        where head.aggregate_type = $1 and head.aggregate_id = $2),
       1
     )::text as next_sequence`,
    [aggregateType, grant.grant_id],
  );
  const nextSequence = sequenceResult.rows[0]?.next_sequence;
  if (!nextSequence || !/^[1-9][0-9]*$/u.test(nextSequence)) {
    throw new Error("Outbox sequence unavailable");
  }
  const eventResult = await client.query<OutboxEventRow>(
    `/* remote_mcp_oauth_revocation:insert_outbox_event */
     insert into system.outbox_events (
       aggregate_type, aggregate_id, aggregate_sequence, event_type, event_version,
       payload, occurred_at, available_at, max_attempts, created_at
     )
     values ($1, $2, $3::bigint, $4, 1, $5::jsonb, statement_timestamp(),
             statement_timestamp(), $6, statement_timestamp())
     returning id::text`,
    [
      aggregateType,
      grant.grant_id,
      nextSequence,
      "oauth_grant.revoked.v1",
      JSON.stringify({
        agent_id: grant.agent_id,
        epoch,
        grant_id: grant.grant_id,
        oauth_client_id: grant.oauth_client_id,
        operation,
        owner_id: grant.owner_id,
        reason_code: reasonCode,
      }),
      MAX_OUTBOX_ATTEMPTS,
    ],
  );
  const eventId = eventResult.rows[0]?.id;
  if (!isUuid(eventId)) throw new Error("Outbox event unavailable");
  return eventId;
}

async function revokeGrantAuthority(
  client: PoolClient,
  grant: GrantAuthorityRow,
  operation: RemoteMcpDomainRevocationOperation,
): Promise<void> {
  const reasonCode =
    operation === "delete_consent"
      ? "owner_consent_deleted"
      : operation === "update_consent"
        ? "owner_consent_updated"
        : "oauth_token_revoked";
  let changed = false;

  changed =
    rowChanged(
      await client.query(
        `/* remote_mcp_oauth_revocation:revoke_refresh_authority */
         update auth.oauth_refresh_tokens
         set revoked = greatest(statement_timestamp(), created_at)
         where reference_id = $1 and client_id = $2 and revoked is null`,
        [grant.grant_id, grant.oauth_client_id],
      ),
    ) || changed;
  changed =
    rowChanged(
      await client.query(
        `/* remote_mcp_oauth_revocation:delete_provider_access_authority */
         delete from auth.oauth_access_tokens
         where reference_id = $1 and client_id = $2`,
        [grant.grant_id, grant.oauth_client_id],
      ),
    ) || changed;
  changed =
    rowChanged(
      await client.query(
        `/* remote_mcp_oauth_revocation:delete_consent_authority */
         delete from auth.oauth_consents
         where reference_id = $1 and client_id = $2`,
        [grant.grant_id, grant.oauth_client_id],
      ),
    ) || changed;
  changed =
    rowChanged(
      await client.query(
        `/* remote_mcp_oauth_revocation:revoke_jti_authority */
         update platform.oauth_access_token_jtis
         set status = 'revoked',
             revoked_at = greatest(statement_timestamp(), issued_at),
             revocation_reason_code = $2
         where grant_id = $1::uuid and status = 'active'`,
        [grant.grant_id, reasonCode],
      ),
    ) || changed;
  changed =
    rowChanged(
      await client.query(
        `/* remote_mcp_oauth_revocation:revoke_credential_authority */
         update platform.credentials
         set revoked_at = greatest(statement_timestamp(), issued_at)
         where id = $1::uuid and owner_id = $2::uuid and agent_id = $3::uuid
           and revoked_at is null`,
        [grant.credential_id, grant.owner_id, grant.agent_id],
      ),
    ) || changed;
  const grantResult = await client.query<
    { status: string; token_epoch: string } & QueryResultRow
  >(
    `/* remote_mcp_oauth_revocation:revoke_grant_authority */
     update platform.oauth_grants
     set status = 'revoked', token_epoch = token_epoch + 1, reason_code = $2
     where id = $1::uuid and status in ('pending', 'active')
     returning status, token_epoch::text`,
    [grant.grant_id, reasonCode],
  );
  changed = rowChanged(grantResult) || changed;
  if (!changed) return;

  const nextEpoch = grantResult.rows[0]?.token_epoch ?? grant.token_epoch;
  const nextStatus = grantResult.rows[0]?.status ?? grant.status;
  const outboxEventId = await appendOutboxEvent(
    client,
    grant,
    operation,
    reasonCode,
    nextEpoch,
  );
  const ownerAuthenticated = operation !== "revoke_token";
  await client.query(
    `/* remote_mcp_oauth_revocation:insert_action_log */
     insert into platform.action_logs (
       event_class, owner_id, agent_id, credential_id, channel, approval_method,
       approved_by_owner_id, authentication_assurance, authorization_snapshot,
       action, target_type, target_id, decision, outcome, outbox_event_id,
       request_id, before_state, after_state, reason_code
     )
     values (
       'authorization_change', $1::uuid, $2::uuid, $3::uuid, 'remote_mcp_oauth',
       $4, $5::uuid, $6, $7::jsonb, 'oauth.grant.revoke', 'oauth_grant', $8,
       'allow', 'succeeded', $9::uuid, $10, $11::jsonb, $12::jsonb, $13
     )`,
    [
      grant.owner_id,
      grant.agent_id,
      grant.credential_id,
      ownerAuthenticated ? "owner_direct" : null,
      ownerAuthenticated ? grant.owner_id : null,
      ownerAuthenticated ? "owner_session" : "oauth_public_client",
      JSON.stringify({ authority: ownerAuthenticated ? "owner" : "public_client" }),
      grant.grant_id,
      outboxEventId,
      randomUUID(),
      JSON.stringify({ epoch: grant.token_epoch, status: grant.status }),
      JSON.stringify({ epoch: nextEpoch, status: nextStatus }),
      reasonCode,
    ],
  );
}

function validateConfiguration(options: AlphaNetRemoteMcpOAuthRevocationOptions): {
  digestKey: Buffer;
  issuer: URL;
  refreshKey: Buffer;
} {
  let issuer: URL;
  let resource: URL;
  try {
    issuer = new URL(options.issuer);
    resource = new URL(options.resource);
  } catch {
    throw new TypeError("Remote MCP OAuth revocation configuration is invalid");
  }
  const isSafeUrl = (url: URL, exact: string): boolean =>
    url.toString() === exact &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "localhost" ||
          url.hostname === "127.0.0.1" ||
          url.hostname === "[::1]")));
  if (
    !isSafeUrl(issuer, options.issuer) ||
    !isSafeUrl(resource, options.resource) ||
    resource.pathname !== "/mcp" ||
    typeof options.authenticateOwner !== "function" ||
    typeof options.verifyAccessTokenForRevocation !== "function" ||
    !options.pool ||
    typeof options.pool.connect !== "function" ||
    !(options.refreshTokenStorageKey instanceof Uint8Array) ||
    options.refreshTokenStorageKey.byteLength < 32 ||
    !(options.tokenJtiDigestKey instanceof Uint8Array) ||
    options.tokenJtiDigestKey.byteLength !== 32
  ) {
    throw new TypeError("Remote MCP OAuth revocation configuration is invalid");
  }
  return {
    digestKey: Buffer.from(options.tokenJtiDigestKey),
    issuer,
    refreshKey: Buffer.from(options.refreshTokenStorageKey),
  };
}

export function createAlphaNetRemoteMcpOAuthRevocationService(
  options: AlphaNetRemoteMcpOAuthRevocationOptions,
): AlphaNetRemoteMcpOAuthRevocationService {
  const { digestKey, issuer, refreshKey } = validateConfiguration(options);

  return Object.freeze({
    async executeDomainRevocationTransaction(
      input: RemoteMcpDomainRevocationInput,
    ): Promise<Response> {
      let parsed: ParsedRevocationRequest;
      try {
        parsed = await parseRequest(issuer, input);
      } catch {
        return response(400, "invalid_request");
      }

      let ownerSession: RemoteMcpOAuthRevocationOwnerSession | undefined;
      if (input.operation !== "revoke_token") {
        try {
          const authenticated = await options.authenticateOwner(input.request);
          if (!isOwnerSession(authenticated)) return response(401, "unauthorized");
          ownerSession = authenticated;
        } catch {
          return response(503, "temporarily_unavailable");
        }
      }

      let client: PoolClient | undefined;
      let transactionStarted = false;
      try {
        client = await options.pool.connect();
        await client.query("begin");
        transactionStarted = true;

        let grant: GrantAuthorityRow | undefined;
        if (input.operation === "revoke_token") {
          const tokenRequest = parsed as ParsedTokenRequest;
          if (!(await assertPublicClient(client, tokenRequest.clientId))) {
            await client.query("rollback");
            transactionStarted = false;
            return response(401, "invalid_client");
          }
          const refreshDigest = refreshTokenDigest(tokenRequest.token, refreshKey);
          if (refreshDigest) {
            grant = await locateRefreshGrant(
              client,
              refreshDigest,
              tokenRequest.clientId,
              options.resource,
            );
          } else {
            const verified = await options.verifyAccessTokenForRevocation(
              tokenRequest.token,
            );
            if (
              isVerifiedAccessToken(verified) &&
              verified.clientId === tokenRequest.clientId &&
              verified.resource === options.resource
            ) {
              grant = await locateAccessGrant(client, verified, digestKey);
            }
          }
        } else {
          grant = await locateOwnerGrant(
            client,
            (parsed as ParsedOwnerRequest).consentId,
            ownerSession as RemoteMcpOAuthRevocationOwnerSession,
            options.resource,
          );
          if (!grant) {
            await client.query("rollback");
            transactionStarted = false;
            return response(404, "not_found");
          }
        }

        if (grant) await revokeGrantAuthority(client, grant, input.operation);
        await client.query("commit");
        transactionStarted = false;
        return response(200);
      } catch {
        if (client && transactionStarted) {
          try {
            await client.query("rollback");
          } catch {
            // Preserve the stable fail-closed response without exposing DB details.
          }
        }
        return response(503, "temporarily_unavailable");
      } finally {
        client?.release();
      }
    },
  });
}
