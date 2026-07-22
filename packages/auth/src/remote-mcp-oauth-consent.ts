import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  AgentScopeSchema,
  type AgentPermissionTier,
  type AgentScope,
} from "@alphanet/contracts";
import type { PoolClient, QueryResultRow } from "pg";

import {
  createRemoteMcpAuthorizationRequestEnvelope,
  REMOTE_MCP_REFRESH_ACCESS_HORIZON_MILLISECONDS,
  type RemoteMcpAuthorizationRequestEnvelope,
  type RemoteMcpAuthorizationRequestEnvelopeInput,
  type RemoteMcpOAuthScope,
} from "./remote-mcp-oauth-guard.js";

const CONTINUATION_AEAD_DOMAIN =
  "alphanet:remote-mcp-oauth:consent-continuation-aead:v2\0";
const CONTINUATION_ENCRYPTION_KEY_DOMAIN =
  "alphanet:remote-mcp-oauth:consent-continuation-encryption-key:v2\0";
const CONTINUATION_SCOPE_DOMAIN =
  "alphanet:remote-mcp-oauth:consent-continuation-scope:v1\0";
const CONTINUATION_VERSION = 2;
const CONTINUATION_PLAINTEXT_BYTES = 112;
const CONTINUATION_NONCE_BYTES = 12;
const CONTINUATION_AUTH_TAG_BYTES = 16;
const CONTINUATION_HEADER_BYTES = 1 + CONTINUATION_NONCE_BYTES;
const CONTINUATION_HANDLE_BYTES =
  CONTINUATION_HEADER_BYTES + CONTINUATION_PLAINTEXT_BYTES + CONTINUATION_AUTH_TAG_BYTES;
const MAX_CONTINUATION_TTL_SECONDS = 5 * 60;
const DEFAULT_CONTINUATION_TTL_SECONDS = 2 * 60;
const MAX_GRANT_TTL_SECONDS = 30 * 24 * 60 * 60;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type RemoteMcpOAuthConsentErrorCode =
  | "AGENT_NOT_AVAILABLE"
  | "CLIENT_NOT_AVAILABLE"
  | "CONSENT_STATE_CONFLICT"
  | "CONTINUATION_EXPIRED"
  | "CONTINUATION_INVALID"
  | "CONTINUATION_REPLAYED"
  | "GRANT_CONFLICT"
  | "OWNER_SESSION_INVALID"
  | "REQUEST_EXPIRED"
  | "REQUEST_NOT_FOUND";

const consentErrorStatus: Record<RemoteMcpOAuthConsentErrorCode, number> = {
  AGENT_NOT_AVAILABLE: 404,
  CLIENT_NOT_AVAILABLE: 400,
  CONSENT_STATE_CONFLICT: 409,
  CONTINUATION_EXPIRED: 410,
  CONTINUATION_INVALID: 400,
  CONTINUATION_REPLAYED: 409,
  GRANT_CONFLICT: 409,
  OWNER_SESSION_INVALID: 401,
  REQUEST_EXPIRED: 410,
  REQUEST_NOT_FOUND: 404,
};

/** Log-safe domain failure. No binding, handle, PKCE, or redirect value is included. */
export class RemoteMcpOAuthConsentError extends Error {
  readonly code: RemoteMcpOAuthConsentErrorCode;
  readonly statusCode: number;

  constructor(code: RemoteMcpOAuthConsentErrorCode) {
    super(code);
    this.name = "RemoteMcpOAuthConsentError";
    this.code = code;
    this.statusCode = consentErrorStatus[code];
  }
}

export interface LoadRemoteMcpOAuthConsentRequestInput extends RemoteMcpAuthorizationRequestEnvelopeInput {
  /** The current Better Auth session id, resolved from the authenticated request. */
  ownerSessionId: string;
}

export interface SelectRemoteMcpOAuthAgentInput extends LoadRemoteMcpOAuthConsentRequestInput {
  agentId: string;
}

export interface ResolveRemoteMcpOAuthContinuationInput {
  continuationHandle: string;
  /** The current session must still be the session frozen at Agent selection. */
  ownerSessionId: string;
  /** Inspect is pre-consent; claim is the one-shot code-issuance boundary. */
  phase: "claim" | "inspect";
}

export interface RemoteMcpOAuthConsentAgent {
  actorId: string;
  displayName: string;
  handle: string;
  id: string;
  policy: {
    defaultsVersion: string;
    schemaVersion: number;
    tier: AgentPermissionTier;
    /** Decimal bigint serialization; it is never rounded through JavaScript. */
    version: string;
  };
}

export interface RemoteMcpOAuthConsentRequestView {
  agents: RemoteMcpOAuthConsentAgent[];
  client: {
    id: string;
    name: string;
    redirectOrigin: string;
  };
  expiresAt: Date;
  id: string;
  ownerId: string;
  requestedScopes: RemoteMcpOAuthScope[];
  resource: string;
  selectedAgentId: string | null;
  status: "pending" | "selected";
}

export interface RemoteMcpOAuthPreparedGrant {
  authorizationRequestId: string;
  continuationHandle: string;
  /** Exact credential policy ceiling frozen when this Grant was prepared. */
  credentialPolicyCeiling: {
    defaultsVersion: string;
    schemaVersion: number;
    tier: AgentPermissionTier;
  };
  credentialId: string;
  expiresAt: Date;
  grantId: string;
  idempotent: boolean;
  scopes: AgentScope[];
}

export interface RemoteMcpOAuthResolvedContinuation {
  authorizationRequestId: string;
  /** Exact credential policy ceiling frozen when this Grant was prepared. */
  credentialPolicyCeiling: {
    defaultsVersion: string;
    schemaVersion: number;
    tier: AgentPermissionTier;
  };
  grantId: string;
}

export interface RemoteMcpOAuthConsentServiceOptions {
  authorizationBindingKey: Uint8Array;
  continuationKey: Uint8Array;
  continuationTtlSeconds?: number | undefined;
  grantTtlSeconds?: number | undefined;
  now?: (() => Date) | undefined;
}

export interface RemoteMcpOAuthConsentPool {
  connect(): Promise<PoolClient>;
}

export interface RemoteMcpOAuthConsentService {
  loadConsentRequest(
    input: LoadRemoteMcpOAuthConsentRequestInput,
  ): Promise<RemoteMcpOAuthConsentRequestView>;
  resolveContinuationHandle(
    input: ResolveRemoteMcpOAuthContinuationInput,
  ): Promise<RemoteMcpOAuthResolvedContinuation>;
  selectAgentAndPrepareGrant(
    input: SelectRemoteMcpOAuthAgentInput,
  ): Promise<RemoteMcpOAuthPreparedGrant>;
}

interface OwnerSessionRow extends QueryResultRow {
  auth_user_id: string;
  owner_id: string;
}

interface AuthorizationRequestRow extends QueryResultRow {
  agent_id: string | null;
  client_disabled: boolean | null;
  client_grant_types: unknown;
  client_name: string | null;
  client_public: boolean | null;
  client_redirect_uris: unknown;
  client_require_pkce: boolean | null;
  client_secret: string | null;
  client_scopes: unknown;
  client_skip_consent: boolean | null;
  client_token_endpoint_auth_method: string | null;
  code_challenge: string;
  code_challenge_method: string;
  expires_at: Date;
  id: string;
  is_expired: boolean;
  oauth_client_id: string;
  owner_id: string | null;
  owner_session_id: string | null;
  redirect_uri: string;
  requested_scopes: string[];
  resource: string;
  status: "consumed" | "denied" | "expired" | "pending" | "selected";
}

interface ConsentAgentRow extends QueryResultRow {
  actor_id: string;
  defaults_version: string;
  display_name: string;
  handle: string;
  id: string;
  policy_schema_version: number;
  policy_tier: AgentPermissionTier;
  policy_version: string;
}

interface SelectedAgentRow extends ConsentAgentRow {
  policy_rules: unknown;
}

interface ExistingGrantRow extends QueryResultRow {
  credential_id: string;
  expires_at: Date;
  grant_id: string;
  offline_access: boolean;
  policy_ceiling: AgentPermissionTier;
  policy_ceiling_defaults_version: string;
  policy_ceiling_schema_version: number;
  scopes: string[];
}

type InsertedGrantRow = ExistingGrantRow;

interface ContinuationAuthorityRow extends QueryResultRow {
  authority_checked_at: Date;
  agent_id: string;
  grant_id: string;
  grant_offline_access: boolean;
  grant_scopes: string[];
  grant_status: string;
  grant_expires_at: Date;
  is_expired: boolean;
  oauth_client_id: string;
  client_disabled: boolean | null;
  client_grant_types: unknown;
  client_public: boolean | null;
  client_redirect_uris: unknown;
  client_require_pkce: boolean | null;
  client_secret: string | null;
  client_scopes: unknown;
  client_skip_consent: boolean | null;
  client_token_endpoint_auth_method: string | null;
  credential_expires_at: Date;
  credential_policy_ceiling: AgentPermissionTier;
  credential_policy_ceiling_defaults_version: string;
  credential_policy_ceiling_schema_version: number;
  owner_id: string;
  owner_session_id: string;
  redirect_uri: string;
  request_grant_id: string | null;
  request_status: string;
  requested_scopes: string[];
  resource: string;
}

interface DecodedContinuation {
  expiresAtSeconds: number;
  grantId: string;
  issuedAtSeconds: number;
  requestId: string;
  scopeDigest: Buffer;
  sessionId: string;
}

function fail(code: RemoteMcpOAuthConsentErrorCode): never {
  throw new RemoteMcpOAuthConsentError(code);
}

function assertKey(key: Uint8Array, label: string): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) {
    throw new Error(`${label} must be at least 32 bytes`);
  }
  return Buffer.from(key);
}

function boundedInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} is outside its supported range`);
  }
  return value;
}

function assertUuid(value: string, code: RemoteMcpOAuthConsentErrorCode): void {
  if (!UUID_PATTERN.test(value)) fail(code);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return null;
  }
  return value as string[];
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    right.every((value) => left.includes(value))
  );
}

function clientIsUsable(
  row: AuthorizationRequestRow,
  envelope: RemoteMcpAuthorizationRequestEnvelope,
): boolean {
  const redirectUris = stringArray(row.client_redirect_uris);
  const supportedScopes = stringArray(row.client_scopes);
  const grantTypes =
    row.client_grant_types === null ? null : stringArray(row.client_grant_types);
  return (
    row.client_disabled === false &&
    row.client_skip_consent === false &&
    row.client_require_pkce === true &&
    row.client_token_endpoint_auth_method === "none" &&
    row.client_public === true &&
    row.client_secret === null &&
    redirectUris !== null &&
    redirectUris.includes(envelope.redirectUri) &&
    supportedScopes !== null &&
    envelope.requestedScopes.every((scope) => supportedScopes.includes(scope)) &&
    grantTypes !== null &&
    grantTypes.includes("authorization_code") &&
    (!envelope.requestedScopes.includes("offline_access") ||
      grantTypes.includes("refresh_token"))
  );
}

function requestMatchesEnvelope(
  row: AuthorizationRequestRow,
  envelope: RemoteMcpAuthorizationRequestEnvelope,
): boolean {
  return (
    row.oauth_client_id === envelope.oauthClientId &&
    row.resource === envelope.resource &&
    arraysEqual(row.requested_scopes, envelope.requestedScopes) &&
    row.redirect_uri === envelope.redirectUri &&
    row.code_challenge === envelope.codeChallenge &&
    row.code_challenge_method === envelope.codeChallengeMethod
  );
}

function domainScopes(scopes: readonly RemoteMcpOAuthScope[]): AgentScope[] {
  return scopes
    .filter((scope) => scope !== "offline_access")
    .map((scope) => AgentScopeSchema.parse(scope));
}

function scopeDigest(scopes: readonly string[], key: Uint8Array): Buffer {
  return createHmac("sha256", key)
    .update(CONTINUATION_SCOPE_DOMAIN, "utf8")
    .update(JSON.stringify(scopes), "utf8")
    .digest();
}

function continuationEncryptionKey(key: Uint8Array): Buffer {
  return createHmac("sha256", key)
    .update(CONTINUATION_ENCRYPTION_KEY_DOMAIN, "utf8")
    .digest();
}

function continuationAad(): Buffer {
  return Buffer.concat([
    Buffer.from(CONTINUATION_AEAD_DOMAIN, "utf8"),
    Buffer.from([CONTINUATION_VERSION]),
  ]);
}

function uuidToBytes(value: string): Buffer {
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function uuidFromBytes(value: Uint8Array): string {
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isDatabaseError(value: unknown): value is { code: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string"
  );
}

export class PostgresRemoteMcpOAuthConsentService implements RemoteMcpOAuthConsentService {
  readonly #authorizationBindingKey: Buffer;
  readonly #continuationEncryptionKey: Buffer;
  readonly #continuationKey: Buffer;
  readonly #continuationTtlSeconds: number;
  readonly #grantTtlSeconds: number;
  readonly #now: () => Date;
  readonly #pool: RemoteMcpOAuthConsentPool;

  constructor(
    pool: RemoteMcpOAuthConsentPool,
    options: RemoteMcpOAuthConsentServiceOptions,
  ) {
    this.#pool = pool;
    this.#authorizationBindingKey = assertKey(
      options.authorizationBindingKey,
      "Remote MCP OAuth authorization binding key",
    );
    this.#continuationKey = assertKey(
      options.continuationKey,
      "Remote MCP OAuth continuation key",
    );
    if (
      this.#authorizationBindingKey.byteLength === this.#continuationKey.byteLength &&
      timingSafeEqual(this.#authorizationBindingKey, this.#continuationKey)
    ) {
      throw new Error(
        "Remote MCP OAuth authorization binding and continuation keys must be independent",
      );
    }
    this.#continuationEncryptionKey = continuationEncryptionKey(this.#continuationKey);
    this.#continuationTtlSeconds = boundedInteger(
      options.continuationTtlSeconds ?? DEFAULT_CONTINUATION_TTL_SECONDS,
      MAX_CONTINUATION_TTL_SECONDS,
      "Remote MCP OAuth continuation TTL",
    );
    this.#grantTtlSeconds = boundedInteger(
      options.grantTtlSeconds ?? MAX_GRANT_TTL_SECONDS,
      MAX_GRANT_TTL_SECONDS,
      "Remote MCP OAuth Grant TTL",
    );
    this.#now = options.now ?? (() => new Date());
  }

  async loadConsentRequest(
    input: LoadRemoteMcpOAuthConsentRequestInput,
  ): Promise<RemoteMcpOAuthConsentRequestView> {
    assertUuid(input.ownerSessionId, "OWNER_SESSION_INVALID");
    const envelope = this.#envelope(input);

    return this.#transaction("repeatable read", async (client) => {
      const owner = await this.#lockOwnerSession(client, input.ownerSessionId, false);
      const request = await this.#loadAuthorizationRequest(client, envelope, false);
      this.#assertLiveRequest(request, envelope);
      if (
        request.status === "selected" &&
        (request.owner_id !== owner.owner_id ||
          request.owner_session_id !== input.ownerSessionId)
      ) {
        fail("CONSENT_STATE_CONFLICT");
      }

      const agents = await client.query<ConsentAgentRow>(
        `select agent.id,
                actor.id as actor_id,
                actor.handle::text as handle,
                actor.display_name,
                policy.tier as policy_tier,
                policy.defaults_version,
                policy.policy_schema_version,
                policy.version::text as policy_version
           from platform.agents as agent
           inner join platform.actors as actor
             on actor.id = agent.actor_id
            and actor.owner_id = agent.owner_id
            and actor.kind = 'agent'
            and actor.status = 'active'
            and actor.deleted_at is null
           inner join platform.agent_policies as policy
             on policy.agent_id = agent.id
            and policy.is_active
          where agent.owner_id = $1::uuid
            and agent.status = 'active'
            and agent.deleted_at is null
          order by lower(actor.display_name), actor.handle, agent.id
          for share of agent, actor, policy`,
        [owner.owner_id],
      );

      return {
        agents: agents.rows.map((agent) => ({
          actorId: agent.actor_id,
          displayName: agent.display_name,
          handle: agent.handle,
          id: agent.id,
          policy: {
            defaultsVersion: agent.defaults_version,
            schemaVersion: agent.policy_schema_version,
            tier: agent.policy_tier,
            version: agent.policy_version,
          },
        })),
        client: {
          id: request.oauth_client_id,
          name: request.client_name?.trim() || request.oauth_client_id,
          redirectOrigin: new URL(request.redirect_uri).origin,
        },
        expiresAt: request.expires_at,
        id: request.id,
        ownerId: owner.owner_id,
        requestedScopes: [...envelope.requestedScopes],
        resource: request.resource,
        selectedAgentId: request.agent_id,
        status: request.status as "pending" | "selected",
      };
    });
  }

  async selectAgentAndPrepareGrant(
    input: SelectRemoteMcpOAuthAgentInput,
  ): Promise<RemoteMcpOAuthPreparedGrant> {
    assertUuid(input.ownerSessionId, "OWNER_SESSION_INVALID");
    assertUuid(input.agentId, "AGENT_NOT_AVAILABLE");
    const envelope = this.#envelope(input);

    try {
      return await this.#transaction("read committed", async (client) => {
        // Lock order is part of the cross-service contract: Owner first, then
        // the one-shot envelope, then the selected Agent/policy snapshot.
        const owner = await this.#lockOwnerSession(client, input.ownerSessionId, true);
        const request = await this.#loadAuthorizationRequest(client, envelope, true);
        this.#assertLiveRequest(request, envelope);

        const selectedAgent = await this.#lockSelectedAgent(
          client,
          owner.owner_id,
          input.agentId,
        );
        const scopes = domainScopes(envelope.requestedScopes);
        const offlineAccess = envelope.requestedScopes.includes("offline_access");

        if (request.status === "selected") {
          if (
            request.owner_id !== owner.owner_id ||
            request.owner_session_id !== input.ownerSessionId ||
            request.agent_id !== input.agentId
          ) {
            fail("CONSENT_STATE_CONFLICT");
          }
          const existing = await this.#loadExistingGrant(
            client,
            request.id,
            owner.owner_id,
            input.agentId,
            envelope,
            scopes,
            offlineAccess,
          );
          return this.#preparedGrant(existing, request, envelope, true);
        }

        const selection = await client.query<{ id: string }>(
          `update platform.oauth_authorization_requests
              set status = 'selected',
                  owner_id = $2::uuid,
                  agent_id = $3::uuid,
                  owner_session_id = $4::uuid
            where id = $1::uuid
              and status = 'pending'
              and owner_id is null
              and agent_id is null
              and owner_session_id is null
              and expires_at > statement_timestamp()
          returning id`,
          [request.id, owner.owner_id, input.agentId, input.ownerSessionId],
        );
        if (selection.rowCount !== 1) fail("CONSENT_STATE_CONFLICT");

        const credentialId = randomUUID();
        const grantId = randomUUID();
        const inserted = await client.query<InsertedGrantRow>(
          `with inserted_credential as (
             insert into platform.credentials (
               id,
               owner_id,
               agent_id,
               name,
               credential_type,
               scopes,
               audience,
               policy_ceiling,
               policy_ceiling_defaults_version,
               policy_ceiling_schema_version,
               policy_ceiling_rules,
               expires_at
             )
             values (
               $1::uuid,
               $2::uuid,
               $3::uuid,
               'Remote MCP OAuth Grant',
               'oauth_grant',
               $4::text[],
               $5::text,
               $6::text,
               $7::text,
               $8::integer,
               $9::jsonb,
               statement_timestamp() + ($10::integer * interval '1 second')
             )
             returning id,
                       expires_at,
                       policy_ceiling,
                       policy_ceiling_defaults_version,
                       policy_ceiling_schema_version
           ), inserted_grant as (
             insert into platform.oauth_grants (
               id,
               owner_id,
               auth_user_id,
               agent_id,
               credential_id,
               authorization_request_id,
               oauth_client_id,
               resource,
               scopes,
               offline_access,
               expires_at
             )
             select $11::uuid,
                    $2::uuid,
                    $12::uuid,
                    $3::uuid,
                    inserted_credential.id,
                    $13::uuid,
                    $14::text,
                    $5::text,
                    $4::text[],
                    $15::boolean,
                    inserted_credential.expires_at
               from inserted_credential
             returning id, credential_id, scopes, offline_access, expires_at
           )
           select inserted_grant.id as grant_id,
                  inserted_grant.credential_id,
                  inserted_grant.scopes,
                  inserted_grant.offline_access,
                  inserted_grant.expires_at,
                  inserted_credential.policy_ceiling,
                  inserted_credential.policy_ceiling_defaults_version,
                  inserted_credential.policy_ceiling_schema_version
             from inserted_grant
             inner join inserted_credential
               on inserted_credential.id = inserted_grant.credential_id`,
          [
            credentialId,
            owner.owner_id,
            input.agentId,
            scopes,
            envelope.resource,
            selectedAgent.policy_tier,
            selectedAgent.defaults_version,
            selectedAgent.policy_schema_version,
            JSON.stringify(selectedAgent.policy_rules),
            this.#grantTtlSeconds,
            grantId,
            owner.auth_user_id,
            request.id,
            envelope.oauthClientId,
            offlineAccess,
          ],
        );
        const grant = inserted.rows[0];
        if (!grant || inserted.rowCount !== 1) fail("CONSENT_STATE_CONFLICT");
        return this.#preparedGrant(
          grant,
          {
            ...request,
            agent_id: input.agentId,
            owner_id: owner.owner_id,
            owner_session_id: input.ownerSessionId,
            status: "selected",
          },
          envelope,
          false,
        );
      });
    } catch (error) {
      if (error instanceof RemoteMcpOAuthConsentError) throw error;
      if (isDatabaseError(error)) {
        if (error.code === "23505") fail("GRANT_CONFLICT");
        if (["22023", "23514", "42501", "40001", "40P01"].includes(error.code)) {
          fail("CONSENT_STATE_CONFLICT");
        }
      }
      throw error;
    }
  }

  async resolveContinuationHandle(
    input: ResolveRemoteMcpOAuthContinuationInput,
  ): Promise<RemoteMcpOAuthResolvedContinuation> {
    if (input.phase !== "inspect" && input.phase !== "claim") {
      fail("CONTINUATION_INVALID");
    }
    assertUuid(input.ownerSessionId, "OWNER_SESSION_INVALID");
    const continuation = this.#decodeContinuation(input.continuationHandle);
    if (continuation.sessionId !== input.ownerSessionId) {
      fail("CONTINUATION_INVALID");
    }

    return this.#transaction("read committed", async (client) => {
      const owner = await this.#lockOwnerSession(client, input.ownerSessionId, true);
      const authority = await client.query<ContinuationAuthorityRow>(
        `select statement_timestamp() as authority_checked_at,
                authorization_request.status as request_status,
                authorization_request.grant_id as request_grant_id,
                authorization_request.owner_id,
                authorization_request.agent_id,
                authorization_request.owner_session_id,
                authorization_request.oauth_client_id,
                authorization_request.resource,
                authorization_request.redirect_uri,
                authorization_request.requested_scopes,
                authorization_request.expires_at <= statement_timestamp() as is_expired,
                oauth_grant.id as grant_id,
                oauth_grant.status as grant_status,
                oauth_grant.scopes as grant_scopes,
                oauth_grant.offline_access as grant_offline_access,
                oauth_grant.expires_at as grant_expires_at,
                credential.expires_at as credential_expires_at,
                credential.policy_ceiling as credential_policy_ceiling,
                credential.policy_ceiling_defaults_version
                  as credential_policy_ceiling_defaults_version,
                credential.policy_ceiling_schema_version
                  as credential_policy_ceiling_schema_version,
                oauth_client.disabled as client_disabled,
                oauth_client.skip_consent as client_skip_consent,
                oauth_client.require_pkce as client_require_pkce,
                oauth_client.token_endpoint_auth_method
                  as client_token_endpoint_auth_method,
                oauth_client.public as client_public,
                oauth_client.client_secret,
                oauth_client.scopes as client_scopes,
                oauth_client.redirect_uris as client_redirect_uris,
                oauth_client.grant_types as client_grant_types
           from platform.oauth_authorization_requests as authorization_request
           inner join platform.oauth_grants as oauth_grant
             on oauth_grant.authorization_request_id = authorization_request.id
            and oauth_grant.id = $2::uuid
            and oauth_grant.owner_id = authorization_request.owner_id
            and oauth_grant.agent_id = authorization_request.agent_id
           inner join platform.credentials as credential
             on credential.id = oauth_grant.credential_id
            and credential.owner_id = oauth_grant.owner_id
            and credential.agent_id = oauth_grant.agent_id
            and credential.credential_type = 'oauth_grant'
            and credential.revoked_at is null
            and credential.expires_at = oauth_grant.expires_at
            and credential.expires_at > statement_timestamp()
           inner join platform.agents as agent
             on agent.id = oauth_grant.agent_id
            and agent.owner_id = oauth_grant.owner_id
            and agent.status = 'active'
            and agent.deleted_at is null
           inner join platform.actors as actor
             on actor.id = agent.actor_id
            and actor.owner_id = oauth_grant.owner_id
            and actor.kind = 'agent'
            and actor.status = 'active'
            and actor.deleted_at is null
           inner join auth.oauth_clients as oauth_client
             on oauth_client.client_id = oauth_grant.oauth_client_id
           inner join platform.oauth_resource_configuration as resource_configuration
             on resource_configuration.resource = oauth_grant.resource
          where authorization_request.id = $1::uuid
          for update of authorization_request
          for share of oauth_grant, credential, agent, actor, oauth_client,
            resource_configuration`,
        [continuation.requestId, continuation.grantId],
      );
      const row = authority.rows[0];
      if (!row) fail("CONTINUATION_INVALID");
      if (
        row.request_status === "consumed" &&
        row.request_grant_id === continuation.grantId
      ) {
        fail("CONTINUATION_REPLAYED");
      }
      if (row.request_status !== "selected" || row.request_grant_id !== null) {
        fail("CONSENT_STATE_CONFLICT");
      }
      if (row.is_expired) fail("CONTINUATION_EXPIRED");
      if (
        row.owner_id !== owner.owner_id ||
        row.owner_session_id !== input.ownerSessionId ||
        row.grant_id !== continuation.grantId ||
        row.grant_status !== "pending"
      ) {
        fail("CONTINUATION_INVALID");
      }
      const redirectUris = stringArray(row.client_redirect_uris);
      const supportedScopes = stringArray(row.client_scopes);
      const grantTypes = stringArray(row.client_grant_types);
      if (
        row.client_disabled !== false ||
        row.client_skip_consent !== false ||
        row.client_require_pkce !== true ||
        row.client_token_endpoint_auth_method !== "none" ||
        row.client_public !== true ||
        row.client_secret !== null ||
        redirectUris === null ||
        !redirectUris.includes(row.redirect_uri) ||
        supportedScopes === null ||
        !row.requested_scopes.every((scope) => supportedScopes.includes(scope)) ||
        grantTypes === null ||
        !grantTypes.includes("authorization_code") ||
        (row.requested_scopes.includes("offline_access") &&
          !grantTypes.includes("refresh_token"))
      ) {
        fail("CLIENT_NOT_AVAILABLE");
      }
      if (
        !(row.authority_checked_at instanceof Date) ||
        !(row.grant_expires_at instanceof Date) ||
        !(row.credential_expires_at instanceof Date) ||
        row.grant_expires_at.getTime() <
          row.authority_checked_at.getTime() +
            REMOTE_MCP_REFRESH_ACCESS_HORIZON_MILLISECONDS ||
        row.credential_expires_at.getTime() <
          row.authority_checked_at.getTime() +
            REMOTE_MCP_REFRESH_ACCESS_HORIZON_MILLISECONDS
      ) {
        fail("CONTINUATION_EXPIRED");
      }
      if (
        !timingSafeEqual(
          continuation.scopeDigest,
          scopeDigest(row.requested_scopes, this.#continuationKey),
        )
      ) {
        fail("CONTINUATION_INVALID");
      }
      const expectedGrantScopes = row.requested_scopes.filter(
        (scope) => scope !== "offline_access",
      );
      if (
        !sameSet(row.grant_scopes, expectedGrantScopes) ||
        row.grant_offline_access !== row.requested_scopes.includes("offline_access")
      ) {
        fail("CONTINUATION_INVALID");
      }

      if (input.phase === "claim") {
        const consumed = await client.query<{ id: string }>(
          `update platform.oauth_authorization_requests
              set status = 'consumed',
                  grant_id = $2::uuid
            where id = $1::uuid
              and status = 'selected'
              and grant_id is null
          returning id`,
          [continuation.requestId, continuation.grantId],
        );
        if (consumed.rowCount !== 1) fail("CONSENT_STATE_CONFLICT");
      }

      return {
        authorizationRequestId: continuation.requestId,
        credentialPolicyCeiling: {
          defaultsVersion: row.credential_policy_ceiling_defaults_version,
          schemaVersion: row.credential_policy_ceiling_schema_version,
          tier: row.credential_policy_ceiling,
        },
        grantId: continuation.grantId,
      };
    });
  }

  #envelope(
    input: RemoteMcpAuthorizationRequestEnvelopeInput,
  ): RemoteMcpAuthorizationRequestEnvelope {
    return createRemoteMcpAuthorizationRequestEnvelope(
      input,
      this.#authorizationBindingKey,
    );
  }

  async #lockOwnerSession(
    client: PoolClient,
    sessionId: string,
    update: boolean,
  ): Promise<OwnerSessionRow> {
    const result = await client.query<OwnerSessionRow>(
      `select owner.id as owner_id,
              owner.auth_user_id
         from auth.sessions as owner_session
         inner join auth.users as auth_user
           on auth_user.id = owner_session.user_id
          and auth_user.email_verified
         inner join platform.owners as owner
           on owner.auth_user_id = auth_user.id
          and owner.status = 'active'
          and owner.email_verified_at is not null
          and owner.deleted_at is null
        where owner_session.id = $1::uuid
          and owner_session.expires_at > statement_timestamp()
        ${
          update
            ? "for update of owner for share of owner_session, auth_user"
            : "for share of owner, owner_session, auth_user"
        }`,
      [sessionId],
    );
    const owner = result.rows[0];
    if (!owner) fail("OWNER_SESSION_INVALID");
    return owner;
  }

  async #loadAuthorizationRequest(
    client: PoolClient,
    envelope: RemoteMcpAuthorizationRequestEnvelope,
    update: boolean,
  ): Promise<AuthorizationRequestRow> {
    const result = await client.query<AuthorizationRequestRow>(
      `select authorization_request.id,
              authorization_request.oauth_client_id,
              authorization_request.resource,
              authorization_request.requested_scopes,
              authorization_request.redirect_uri,
              authorization_request.code_challenge,
              authorization_request.code_challenge_method,
              authorization_request.owner_id,
              authorization_request.agent_id,
              authorization_request.owner_session_id,
              authorization_request.status,
              authorization_request.expires_at,
              authorization_request.expires_at <= statement_timestamp() as is_expired,
              oauth_client.name as client_name,
              oauth_client.disabled as client_disabled,
              oauth_client.skip_consent as client_skip_consent,
              oauth_client.require_pkce as client_require_pkce,
              oauth_client.token_endpoint_auth_method
                as client_token_endpoint_auth_method,
              oauth_client.public as client_public,
              oauth_client.client_secret,
              oauth_client.scopes as client_scopes,
              oauth_client.redirect_uris as client_redirect_uris,
              oauth_client.grant_types as client_grant_types
         from platform.oauth_authorization_requests as authorization_request
         inner join auth.oauth_clients as oauth_client
           on oauth_client.client_id = authorization_request.oauth_client_id
         inner join platform.oauth_resource_configuration as resource_configuration
           on resource_configuration.resource = authorization_request.resource
        where authorization_request.binding_digest = $1::bytea
        ${
          update
            ? "for update of authorization_request for share of oauth_client"
            : "for share of authorization_request, oauth_client"
        }`,
      [envelope.bindingDigest],
    );
    const request = result.rows[0];
    if (!request) fail("REQUEST_NOT_FOUND");
    return request;
  }

  #assertLiveRequest(
    request: AuthorizationRequestRow,
    envelope: RemoteMcpAuthorizationRequestEnvelope,
  ): void {
    if (!requestMatchesEnvelope(request, envelope)) fail("REQUEST_NOT_FOUND");
    if (!clientIsUsable(request, envelope)) fail("CLIENT_NOT_AVAILABLE");
    if (request.is_expired || request.status === "expired") fail("REQUEST_EXPIRED");
    if (request.status !== "pending" && request.status !== "selected") {
      fail("CONSENT_STATE_CONFLICT");
    }
  }

  async #lockSelectedAgent(
    client: PoolClient,
    ownerId: string,
    agentId: string,
  ): Promise<SelectedAgentRow> {
    const result = await client.query<SelectedAgentRow>(
      `select agent.id,
              actor.id as actor_id,
              actor.handle::text as handle,
              actor.display_name,
              policy.tier as policy_tier,
              policy.defaults_version,
              policy.policy_schema_version,
              policy.version::text as policy_version,
              case when policy.tier = 'custom' then policy.rules else '{}'::jsonb end
                as policy_rules
         from platform.agents as agent
         inner join platform.actors as actor
           on actor.id = agent.actor_id
          and actor.owner_id = agent.owner_id
          and actor.kind = 'agent'
          and actor.status = 'active'
          and actor.deleted_at is null
         inner join platform.agent_policies as policy
           on policy.agent_id = agent.id
          and policy.is_active
        where agent.id = $1::uuid
          and agent.owner_id = $2::uuid
          and agent.status = 'active'
          and agent.deleted_at is null
        for update of agent
        for share of actor, policy`,
      [agentId, ownerId],
    );
    const agent = result.rows[0];
    if (!agent) fail("AGENT_NOT_AVAILABLE");
    return agent;
  }

  async #loadExistingGrant(
    client: PoolClient,
    requestId: string,
    ownerId: string,
    agentId: string,
    envelope: RemoteMcpAuthorizationRequestEnvelope,
    scopes: readonly AgentScope[],
    offlineAccess: boolean,
  ): Promise<ExistingGrantRow> {
    const result = await client.query<ExistingGrantRow>(
      `select oauth_grant.id as grant_id,
              oauth_grant.credential_id,
              oauth_grant.scopes,
              oauth_grant.offline_access,
              oauth_grant.expires_at,
              credential.policy_ceiling,
              credential.policy_ceiling_defaults_version,
              credential.policy_ceiling_schema_version
         from platform.oauth_grants as oauth_grant
         inner join platform.credentials as credential
           on credential.id = oauth_grant.credential_id
          and credential.owner_id = oauth_grant.owner_id
          and credential.agent_id = oauth_grant.agent_id
          and credential.credential_type = 'oauth_grant'
          and credential.scopes = oauth_grant.scopes
          and credential.audience = oauth_grant.resource
          and credential.expires_at = oauth_grant.expires_at
          and credential.revoked_at is null
        where oauth_grant.authorization_request_id = $1::uuid
          and oauth_grant.owner_id = $2::uuid
          and oauth_grant.agent_id = $3::uuid
          and oauth_grant.oauth_client_id = $4::text
          and oauth_grant.resource = $5::text
          and oauth_grant.status = 'pending'
          and oauth_grant.expires_at > statement_timestamp()
          and platform.oauth_text_arrays_are_same_set(oauth_grant.scopes, $6::text[])
          and oauth_grant.offline_access = $7::boolean
        for share of oauth_grant, credential`,
      [
        requestId,
        ownerId,
        agentId,
        envelope.oauthClientId,
        envelope.resource,
        scopes,
        offlineAccess,
      ],
    );
    const grant = result.rows[0];
    if (!grant) fail("CONSENT_STATE_CONFLICT");
    return grant;
  }

  #preparedGrant(
    grant: ExistingGrantRow,
    request: AuthorizationRequestRow,
    envelope: RemoteMcpAuthorizationRequestEnvelope,
    idempotent: boolean,
  ): RemoteMcpOAuthPreparedGrant {
    const scopes = domainScopes(envelope.requestedScopes);
    if (
      !sameSet(grant.scopes, scopes) ||
      grant.offline_access !== envelope.requestedScopes.includes("offline_access")
    ) {
      fail("CONSENT_STATE_CONFLICT");
    }
    return {
      authorizationRequestId: request.id,
      continuationHandle: this.#createContinuation(
        request.id,
        request.owner_session_id,
        grant.grant_id,
        envelope.requestedScopes,
        request.expires_at,
      ),
      credentialPolicyCeiling: {
        defaultsVersion: grant.policy_ceiling_defaults_version,
        schemaVersion: grant.policy_ceiling_schema_version,
        tier: grant.policy_ceiling,
      },
      credentialId: grant.credential_id,
      expiresAt: grant.expires_at,
      grantId: grant.grant_id,
      idempotent,
      scopes,
    };
  }

  #createContinuation(
    requestId: string,
    sessionId: string | null,
    grantId: string,
    scopes: readonly string[],
    requestExpiresAt: Date,
  ): string {
    if (sessionId === null) fail("CONSENT_STATE_CONFLICT");
    const now = this.#now();
    if (!Number.isFinite(now.valueOf())) throw new Error("Invalid consent clock");
    const issuedAtSeconds = Math.floor(now.valueOf() / 1_000);
    const expiresAtSeconds = Math.min(
      Math.floor(requestExpiresAt.valueOf() / 1_000),
      issuedAtSeconds + this.#continuationTtlSeconds,
    );
    if (expiresAtSeconds <= issuedAtSeconds) fail("REQUEST_EXPIRED");

    const plaintext = Buffer.alloc(CONTINUATION_PLAINTEXT_BYTES);
    plaintext.writeUInt32BE(issuedAtSeconds, 0);
    plaintext.writeUInt32BE(expiresAtSeconds, 4);
    randomBytes(16).copy(plaintext, 8);
    uuidToBytes(requestId).copy(plaintext, 24);
    uuidToBytes(sessionId).copy(plaintext, 40);
    uuidToBytes(grantId).copy(plaintext, 56);
    scopeDigest(scopes, this.#continuationKey).copy(plaintext, 72);
    randomBytes(8).copy(plaintext, 104);

    const nonce = randomBytes(CONTINUATION_NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#continuationEncryptionKey, nonce);
    cipher.setAAD(continuationAad(), {
      plaintextLength: CONTINUATION_PLAINTEXT_BYTES,
    });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([
      Buffer.from([CONTINUATION_VERSION]),
      nonce,
      ciphertext,
      authTag,
    ]).toString("base64url");
  }

  #decodeContinuation(handle: string): DecodedContinuation {
    if (
      typeof handle !== "string" ||
      !/^[A-Za-z0-9_-]+$/u.test(handle) ||
      handle.length > 512
    ) {
      fail("CONTINUATION_INVALID");
    }
    const encoded = Buffer.from(handle, "base64url");
    if (
      encoded.byteLength !== CONTINUATION_HANDLE_BYTES ||
      encoded.toString("base64url") !== handle
    ) {
      fail("CONTINUATION_INVALID");
    }
    if (encoded[0] !== CONTINUATION_VERSION) fail("CONTINUATION_INVALID");
    const nonce = encoded.subarray(1, CONTINUATION_HEADER_BYTES);
    const ciphertext = encoded.subarray(
      CONTINUATION_HEADER_BYTES,
      CONTINUATION_HEADER_BYTES + CONTINUATION_PLAINTEXT_BYTES,
    );
    const suppliedAuthTag = encoded.subarray(
      CONTINUATION_HEADER_BYTES + CONTINUATION_PLAINTEXT_BYTES,
    );
    const plaintext = (() => {
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          this.#continuationEncryptionKey,
          nonce,
        );
        decipher.setAAD(continuationAad(), {
          plaintextLength: CONTINUATION_PLAINTEXT_BYTES,
        });
        decipher.setAuthTag(suppliedAuthTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        fail("CONTINUATION_INVALID");
      }
    })();
    if (plaintext.byteLength !== CONTINUATION_PLAINTEXT_BYTES) {
      fail("CONTINUATION_INVALID");
    }

    const issuedAtSeconds = plaintext.readUInt32BE(0);
    const expiresAtSeconds = plaintext.readUInt32BE(4);
    const now = this.#now();
    if (!Number.isFinite(now.valueOf())) throw new Error("Invalid consent clock");
    const nowSeconds = Math.floor(now.valueOf() / 1_000);
    if (expiresAtSeconds <= nowSeconds) fail("CONTINUATION_EXPIRED");
    if (
      issuedAtSeconds > nowSeconds + 5 ||
      expiresAtSeconds <= issuedAtSeconds ||
      expiresAtSeconds - issuedAtSeconds > MAX_CONTINUATION_TTL_SECONDS
    ) {
      fail("CONTINUATION_INVALID");
    }

    return {
      expiresAtSeconds,
      grantId: uuidFromBytes(plaintext.subarray(56, 72)),
      issuedAtSeconds,
      requestId: uuidFromBytes(plaintext.subarray(24, 40)),
      scopeDigest: Buffer.from(plaintext.subarray(72, 104)),
      sessionId: uuidFromBytes(plaintext.subarray(40, 56)),
    };
  }

  async #transaction<Result>(
    isolation: "read committed" | "repeatable read",
    execute: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.#pool.connect();
    let began = false;
    try {
      await client.query(`begin isolation level ${isolation}`);
      began = true;
      const result = await execute(client);
      await client.query("commit");
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query("rollback");
          began = false;
        } catch {
          client.release(true);
          throw error;
        }
      }
      throw error;
    } finally {
      if (began) {
        // A failed rollback marks the connection unusable in the catch path.
      } else {
        client.release();
      }
    }
  }
}

export function createRemoteMcpOAuthConsentService(
  pool: RemoteMcpOAuthConsentPool,
  options: RemoteMcpOAuthConsentServiceOptions,
): RemoteMcpOAuthConsentService {
  return new PostgresRemoteMcpOAuthConsentService(pool, options);
}
