import { timingSafeEqual } from "node:crypto";

import type { PostgresClient } from "@alphanet/database";

import {
  AGENT_SCOPES,
  AgentConnectionError,
  type AgentCredentialContext,
  type AgentPolicyTier,
  type AgentScope,
  type OAuthGrantCredentialContext,
  type OwnerAgentView,
} from "./agent-connection.js";
import {
  AGENT_POLICY_DEFAULTS_VERSION,
  AGENT_POLICY_SCHEMA_VERSION,
  materializeAgentPolicyRules,
  parsePersistedAgentPolicyRules,
} from "./agent-policy.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN_JTI_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const INPUT_KEYS = ["credentialId", "grantId", "scopes", "tokenJtiDigest"] as const;
const AGENT_SCOPE_SET = new Set<string>(AGENT_SCOPES);
const POLICY_TIERS = new Set<string>(["read_only", "assisted", "autonomous", "custom"]);

export interface RemoteMcpActorAuthorityInput {
  readonly credentialId: string;
  readonly grantId: string;
  readonly scopes: readonly AgentScope[];
  /** Canonical base64url encoding of the independently keyed 32-byte JTI digest. */
  readonly tokenJtiDigest: string;
}

export interface RemoteMcpAuthorityService {
  authenticateActorContext(
    input: RemoteMcpActorAuthorityInput,
  ): Promise<AgentCredentialContext>;
}

interface NormalizedAuthorityInput {
  credentialId: string;
  grantId: string;
  scopes: AgentScope[];
  tokenJtiDigest: Buffer;
}

interface OwnerAuthorityRow {
  id: string;
  auth_user_id: string;
  status: string;
  email_verified_at: Date | null;
  deleted_at: Date | null;
}

interface RemoteMcpAuthorityRow {
  authority_checked_at: Date;
  grant_id: string;
  grant_owner_id: string;
  grant_auth_user_id: string;
  grant_agent_id: string;
  grant_credential_id: string;
  grant_client_id: string;
  grant_resource: string;
  grant_scopes: string[];
  grant_offline_access: boolean;
  grant_status: string;
  grant_token_epoch: string;
  grant_activated_at: Date | null;
  grant_expires_at: Date;

  token_jti_digest: Buffer;
  token_grant_id: string;
  token_owner_id: string;
  token_agent_id: string;
  token_grant_epoch: string;
  token_client_id: string;
  token_resource: string;
  token_scopes: string[];
  token_status: string;
  token_issued_at: Date;
  token_expires_at: Date;
  token_revoked_at: Date | null;

  client_id: string;
  client_disabled: boolean | null;
  client_public: boolean | null;
  client_secret: string | null;
  client_skip_consent: boolean | null;
  client_require_pkce: boolean | null;
  client_scopes: unknown;
  client_grant_types: unknown;
  client_token_endpoint_auth_method: string | null;

  configured_resource: string;

  credential_id: string;
  credential_owner_id: string;
  credential_agent_id: string;
  credential_name: string;
  credential_type: string;
  credential_token_prefix: string | null;
  credential_secret_digest: Buffer | null;
  credential_pepper_version: number | null;
  credential_scopes: string[];
  credential_audience: string;
  credential_policy_ceiling: string;
  credential_policy_ceiling_defaults_version: string;
  credential_policy_ceiling_schema_version: number;
  credential_policy_ceiling_rules: unknown;
  credential_issued_at: Date;
  credential_expires_at: Date | null;
  credential_last_used_at: Date | null;
  credential_revoked_at: Date | null;
  credential_replaces_id: string | null;

  agent_id: string;
  agent_actor_id: string;
  agent_owner_id: string;
  agent_discovery_tags: string[];
  agent_status: string;
  agent_restriction_reason_code: string | null;
  agent_created_at: Date;
  agent_updated_at: Date;
  agent_activated_at: Date | null;
  agent_archived_at: Date | null;
  agent_deleted_at: Date | null;
  credential_count: number;

  actor_id: string;
  actor_owner_id: string;
  actor_kind: string;
  actor_handle: string;
  actor_display_name: string;
  actor_bio: string | null;
  actor_status: string;
  actor_deleted_at: Date | null;

  policy_id: string;
  policy_agent_id: string;
  policy_tier: string;
  policy_defaults_version: string;
  policy_schema_version: number;
  policy_version: string;
  policy_rules: unknown;
  policy_effective_from: Date;
  policy_is_active: boolean;
  policy_owner_id: string;
}

function invalidCredential(): AgentConnectionError {
  return new AgentConnectionError("INVALID_CREDENTIAL");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function parseTokenJtiDigest(value: unknown): Buffer | null {
  if (typeof value !== "string" || !TOKEN_JTI_DIGEST_PATTERN.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value
    ? decoded
    : null;
}

function parseScopes(value: unknown): AgentScope[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > AGENT_SCOPES.length) {
    return null;
  }
  const scopes: AgentScope[] = [];
  const seen = new Set<string>();
  for (const scope of value) {
    if (typeof scope !== "string" || !AGENT_SCOPE_SET.has(scope) || seen.has(scope)) {
      return null;
    }
    seen.add(scope);
    scopes.push(scope as AgentScope);
  }
  return scopes;
}

function normalizeInput(input: RemoteMcpActorAuthorityInput): NormalizedAuthorityInput {
  if (!isPlainRecord(input) || !hasExactKeys(input, INPUT_KEYS)) {
    throw invalidCredential();
  }
  const credentialId = input["credentialId"];
  const grantId = input["grantId"];
  const scopes = parseScopes(input["scopes"]);
  const tokenJtiDigest = parseTokenJtiDigest(input["tokenJtiDigest"]);
  if (!isUuid(credentialId) || !isUuid(grantId) || !scopes || !tokenJtiDigest) {
    throw invalidCredential();
  }
  return { credentialId, grantId, scopes, tokenJtiDigest };
}

function sameScopeSet(left: unknown, right: readonly AgentScope[]): boolean {
  const parsed = parseScopes(left);
  if (!parsed || parsed.length !== right.length) return false;
  const rightSet = new Set<string>(right);
  return parsed.every((scope) => rightSet.has(scope));
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return (
    left instanceof Date &&
    right instanceof Date &&
    Number.isFinite(left.valueOf()) &&
    Number.isFinite(right.valueOf()) &&
    left.valueOf() === right.valueOf()
  );
}

function activeAt(date: Date | null, now: Date): date is Date {
  return date instanceof Date && Number.isFinite(date.valueOf()) && date > now;
}

function isPolicyTier(value: unknown): value is AgentPolicyTier {
  return typeof value === "string" && POLICY_TIERS.has(value);
}

function clientSupportsGrant(row: RemoteMcpAuthorityRow): boolean {
  if (
    !Array.isArray(row.client_scopes) ||
    row.client_scopes.length < 1 ||
    row.client_scopes.length > AGENT_SCOPES.length + 1
  ) {
    return false;
  }
  const configuredScopes = new Set<string>();
  for (const value of row.client_scopes) {
    if (
      typeof value !== "string" ||
      (value !== "offline_access" && !AGENT_SCOPE_SET.has(value)) ||
      configuredScopes.has(value)
    ) {
      return false;
    }
    configuredScopes.add(value);
  }
  if (!row.grant_scopes.every((scope) => configuredScopes.has(scope))) return false;
  if (row.grant_offline_access && !configuredScopes.has("offline_access")) return false;

  if (
    !Array.isArray(row.client_grant_types) ||
    !row.client_grant_types.every((value) => typeof value === "string") ||
    !row.client_grant_types.includes("authorization_code") ||
    (row.grant_offline_access && !row.client_grant_types.includes("refresh_token"))
  ) {
    return false;
  }
  return true;
}

function buildContext(
  owner: OwnerAuthorityRow,
  row: RemoteMcpAuthorityRow,
  input: NormalizedAuthorityInput,
  now: Date,
): AgentCredentialContext | null {
  const grantEpoch = Number(row.grant_token_epoch);
  const tokenEpoch = Number(row.token_grant_epoch);
  const policyTier = isPolicyTier(row.policy_tier) ? row.policy_tier : null;
  const credentialPolicyCeiling = isPolicyTier(row.credential_policy_ceiling)
    ? row.credential_policy_ceiling
    : null;
  const policyRules = policyTier
    ? parsePersistedAgentPolicyRules(policyTier, row.policy_rules)
    : null;
  const credentialPolicyRules = credentialPolicyCeiling
    ? parsePersistedAgentPolicyRules(
        credentialPolicyCeiling,
        row.credential_policy_ceiling_rules,
      )
    : null;

  if (
    !(row.authority_checked_at instanceof Date) ||
    !Number.isFinite(row.authority_checked_at.valueOf()) ||
    row.authority_checked_at.valueOf() !== now.valueOf() ||
    owner.status !== "active" ||
    !(owner.email_verified_at instanceof Date) ||
    !Number.isFinite(owner.email_verified_at.valueOf()) ||
    owner.email_verified_at > now ||
    owner.deleted_at !== null ||
    row.grant_id !== input.grantId ||
    row.grant_owner_id !== owner.id ||
    row.grant_auth_user_id !== owner.auth_user_id ||
    row.grant_credential_id !== input.credentialId ||
    row.grant_status !== "active" ||
    !(row.grant_activated_at instanceof Date) ||
    !Number.isFinite(row.grant_activated_at.valueOf()) ||
    row.grant_activated_at > now ||
    !activeAt(row.grant_expires_at, now) ||
    !Number.isSafeInteger(grantEpoch) ||
    grantEpoch <= 0 ||
    row.credential_id !== row.grant_credential_id ||
    row.credential_owner_id !== row.grant_owner_id ||
    row.credential_agent_id !== row.grant_agent_id ||
    row.credential_type !== "oauth_grant" ||
    row.credential_token_prefix !== null ||
    row.credential_secret_digest !== null ||
    row.credential_pepper_version !== null ||
    row.credential_revoked_at !== null ||
    row.credential_replaces_id !== null ||
    !(row.credential_issued_at instanceof Date) ||
    !Number.isFinite(row.credential_issued_at.valueOf()) ||
    row.credential_issued_at > now ||
    !activeAt(row.credential_expires_at, now) ||
    row.credential_expires_at <= row.credential_issued_at ||
    !sameDate(row.credential_expires_at, row.grant_expires_at) ||
    row.token_grant_id !== row.grant_id ||
    row.token_owner_id !== row.grant_owner_id ||
    row.token_agent_id !== row.grant_agent_id ||
    row.token_status !== "active" ||
    row.token_revoked_at !== null ||
    !(row.token_issued_at instanceof Date) ||
    !Number.isFinite(row.token_issued_at.valueOf()) ||
    row.token_issued_at > now ||
    !activeAt(row.token_expires_at, now) ||
    row.token_expires_at <= row.token_issued_at ||
    row.token_expires_at > row.grant_expires_at ||
    !Number.isSafeInteger(tokenEpoch) ||
    tokenEpoch !== grantEpoch ||
    !Buffer.isBuffer(row.token_jti_digest) ||
    row.token_jti_digest.byteLength !== input.tokenJtiDigest.byteLength ||
    !timingSafeEqual(row.token_jti_digest, input.tokenJtiDigest) ||
    row.grant_resource !== row.configured_resource ||
    row.credential_audience !== row.grant_resource ||
    row.token_resource !== row.grant_resource ||
    row.client_id !== row.grant_client_id ||
    row.token_client_id !== row.grant_client_id ||
    row.client_disabled !== false ||
    row.client_public !== true ||
    row.client_secret !== null ||
    row.client_skip_consent !== false ||
    row.client_require_pkce !== true ||
    row.client_token_endpoint_auth_method !== "none" ||
    !clientSupportsGrant(row) ||
    !sameScopeSet(row.grant_scopes, input.scopes) ||
    !sameScopeSet(row.credential_scopes, input.scopes) ||
    !sameScopeSet(row.token_scopes, input.scopes) ||
    row.agent_id !== row.grant_agent_id ||
    row.agent_owner_id !== row.grant_owner_id ||
    row.agent_status !== "active" ||
    row.agent_deleted_at !== null ||
    !(row.agent_activated_at instanceof Date) ||
    !Number.isFinite(row.agent_activated_at.valueOf()) ||
    row.agent_activated_at > now ||
    row.actor_id !== row.agent_actor_id ||
    row.actor_owner_id !== row.grant_owner_id ||
    row.actor_kind !== "agent" ||
    row.actor_status !== "active" ||
    row.actor_deleted_at !== null ||
    row.policy_owner_id !== row.grant_owner_id ||
    row.policy_is_active !== true ||
    !(row.policy_effective_from instanceof Date) ||
    !Number.isFinite(row.policy_effective_from.valueOf()) ||
    row.policy_effective_from > now ||
    !policyTier ||
    row.policy_defaults_version !== AGENT_POLICY_DEFAULTS_VERSION ||
    row.policy_schema_version !== AGENT_POLICY_SCHEMA_VERSION ||
    !policyRules ||
    !credentialPolicyCeiling ||
    row.credential_policy_ceiling_defaults_version !== AGENT_POLICY_DEFAULTS_VERSION ||
    row.credential_policy_ceiling_schema_version !== AGENT_POLICY_SCHEMA_VERSION ||
    !credentialPolicyRules ||
    !Number.isSafeInteger(row.credential_count) ||
    row.credential_count < 1 ||
    !Array.isArray(row.agent_discovery_tags)
  ) {
    return null;
  }

  const agent: OwnerAgentView = {
    id: row.agent_id,
    actorId: row.actor_id,
    ownerId: row.agent_owner_id,
    handle: row.actor_handle,
    displayName: row.actor_display_name,
    bio: row.actor_bio,
    discoveryTags: [...row.agent_discovery_tags],
    status: "active",
    restrictionReasonCode: row.agent_restriction_reason_code,
    credentialCount: row.credential_count,
    createdAt: row.agent_created_at,
    updatedAt: row.agent_updated_at,
    activatedAt: row.agent_activated_at,
    archivedAt: row.agent_archived_at,
    policy: {
      id: row.policy_id,
      tier: policyTier,
      defaultsVersion: row.policy_defaults_version,
      schemaVersion: row.policy_schema_version,
      version: row.policy_version,
      effectiveFrom: row.policy_effective_from,
      rules: {
        operations: materializeAgentPolicyRules(policyTier, policyRules),
      },
    },
  };
  const credential: OAuthGrantCredentialContext = {
    id: row.credential_id,
    ownerId: row.credential_owner_id,
    agentId: row.credential_agent_id,
    name: row.credential_name,
    type: "oauth_grant",
    prefix: null,
    scopes: [...input.scopes],
    audience: row.credential_audience,
    policyCeiling: credentialPolicyCeiling,
    policyCeilingDefaultsVersion: row.credential_policy_ceiling_defaults_version,
    policyCeilingRules: credentialPolicyRules,
    policyCeilingSchemaVersion: row.credential_policy_ceiling_schema_version,
    issuedAt: row.credential_issued_at,
    expiresAt: row.credential_expires_at,
    lastUsedAt: row.credential_last_used_at,
    revokedAt: null,
    replacesCredentialId: null,
    status: "active",
  };
  return { agent, credential, owner: { id: owner.id } };
}

/**
 * Converts a verified, one-shot MCP assertion into current domain authority.
 * The assertion is only a routing hint: every mutable authorization fact is
 * re-read under an Owner-first shared-lock snapshot before a context exists.
 */
export class PostgresRemoteMcpAuthorityService implements RemoteMcpAuthorityService {
  readonly #sql: PostgresClient;

  constructor(sql: PostgresClient) {
    this.#sql = sql;
  }

  async authenticateActorContext(
    rawInput: RemoteMcpActorAuthorityInput,
  ): Promise<AgentCredentialContext> {
    const input = normalizeInput(rawInput);
    // The assertion deliberately carries no Owner identifier. This unlocked
    // lookup discovers only the immutable lock root; it is not an authority
    // decision. All authorization facts are re-read after the Owner lock.
    const subjects = await this.#sql<{ owner_id: string }[]>`
        select owner_id
        from platform.oauth_grants
        where id = ${input.grantId}
        limit 1
      `;
    const ownerId = subjects[0]?.owner_id;
    if (!isUuid(ownerId)) throw invalidCredential();

    const context = await this.#sql.begin(async (transaction) => {
      const owners = await transaction<OwnerAuthorityRow[]>`
          select id, auth_user_id, status, email_verified_at, deleted_at
          from platform.owners
          where id = ${ownerId}
          for share
        `;
      const owner = owners[0];
      if (!owner) throw invalidCredential();

      const rows = await transaction<RemoteMcpAuthorityRow[]>`
          select
            statement_timestamp() as authority_checked_at,
            oauth_grant.id as grant_id,
            oauth_grant.owner_id as grant_owner_id,
            oauth_grant.auth_user_id as grant_auth_user_id,
            oauth_grant.agent_id as grant_agent_id,
            oauth_grant.credential_id as grant_credential_id,
            oauth_grant.oauth_client_id as grant_client_id,
            oauth_grant.resource as grant_resource,
            oauth_grant.scopes as grant_scopes,
            oauth_grant.offline_access as grant_offline_access,
            oauth_grant.status as grant_status,
            oauth_grant.token_epoch::text as grant_token_epoch,
            oauth_grant.activated_at as grant_activated_at,
            oauth_grant.expires_at as grant_expires_at,

            token_jti.jti_digest as token_jti_digest,
            token_jti.grant_id as token_grant_id,
            token_jti.owner_id as token_owner_id,
            token_jti.agent_id as token_agent_id,
            token_jti.grant_epoch::text as token_grant_epoch,
            token_jti.oauth_client_id as token_client_id,
            token_jti.resource as token_resource,
            token_jti.scopes as token_scopes,
            token_jti.status as token_status,
            token_jti.issued_at as token_issued_at,
            token_jti.expires_at as token_expires_at,
            token_jti.revoked_at as token_revoked_at,

            oauth_client.client_id,
            oauth_client.disabled as client_disabled,
            oauth_client.public as client_public,
            oauth_client.client_secret,
            oauth_client.skip_consent as client_skip_consent,
            oauth_client.require_pkce as client_require_pkce,
            oauth_client.scopes as client_scopes,
            oauth_client.grant_types as client_grant_types,
            oauth_client.token_endpoint_auth_method
              as client_token_endpoint_auth_method,

            resource_configuration.resource as configured_resource,

            credential.id as credential_id,
            credential.owner_id as credential_owner_id,
            credential.agent_id as credential_agent_id,
            credential.name as credential_name,
            credential.credential_type,
            credential.token_prefix as credential_token_prefix,
            credential.secret_digest as credential_secret_digest,
            credential.pepper_version as credential_pepper_version,
            credential.scopes as credential_scopes,
            credential.audience as credential_audience,
            credential.policy_ceiling as credential_policy_ceiling,
            credential.policy_ceiling_defaults_version
              as credential_policy_ceiling_defaults_version,
            credential.policy_ceiling_schema_version
              as credential_policy_ceiling_schema_version,
            credential.policy_ceiling_rules as credential_policy_ceiling_rules,
            credential.issued_at as credential_issued_at,
            credential.expires_at as credential_expires_at,
            credential.last_used_at as credential_last_used_at,
            credential.revoked_at as credential_revoked_at,
            credential.replaces_credential_id as credential_replaces_id,

            agent.id as agent_id,
            agent.actor_id as agent_actor_id,
            agent.owner_id as agent_owner_id,
            agent.discovery_tags as agent_discovery_tags,
            agent.status as agent_status,
            agent.restriction_reason_code as agent_restriction_reason_code,
            agent.created_at as agent_created_at,
            agent.updated_at as agent_updated_at,
            agent.activated_at as agent_activated_at,
            agent.archived_at as agent_archived_at,
            agent.deleted_at as agent_deleted_at,
            (
              select count(*)::integer
              from platform.credentials as owned_credential
              where owned_credential.owner_id = agent.owner_id
                and owned_credential.agent_id = agent.id
            ) as credential_count,

            actor.id as actor_id,
            actor.owner_id as actor_owner_id,
            actor.kind as actor_kind,
            actor.handle::text as actor_handle,
            actor.display_name as actor_display_name,
            actor.bio as actor_bio,
            actor.status as actor_status,
            actor.deleted_at as actor_deleted_at,

            policy.id as policy_id,
            policy.agent_id as policy_agent_id,
            policy.tier as policy_tier,
            policy.defaults_version as policy_defaults_version,
            policy.policy_schema_version as policy_schema_version,
            policy.version::text as policy_version,
            policy.rules as policy_rules,
            policy.effective_from as policy_effective_from,
            policy.is_active as policy_is_active,
            policy.configured_by_owner_id as policy_owner_id
          from platform.oauth_grants as oauth_grant
          inner join platform.credentials as credential
            on credential.id = oauth_grant.credential_id
           and credential.owner_id = oauth_grant.owner_id
           and credential.agent_id = oauth_grant.agent_id
          inner join platform.oauth_access_token_jtis as token_jti
            on token_jti.grant_id = oauth_grant.id
           and token_jti.owner_id = oauth_grant.owner_id
           and token_jti.agent_id = oauth_grant.agent_id
           and token_jti.jti_digest = ${input.tokenJtiDigest}
          inner join auth.oauth_clients as oauth_client
            on oauth_client.client_id = oauth_grant.oauth_client_id
          inner join platform.oauth_resource_configuration as resource_configuration
            on resource_configuration.id = true
          inner join platform.agents as agent
            on agent.id = oauth_grant.agent_id
           and agent.owner_id = oauth_grant.owner_id
          inner join platform.actors as actor
            on actor.id = agent.actor_id
           and actor.owner_id = oauth_grant.owner_id
          inner join platform.agent_policies as policy
            on policy.agent_id = agent.id
           and policy.is_active
          where oauth_grant.id = ${input.grantId}
            and oauth_grant.owner_id = ${ownerId}
            and oauth_grant.credential_id = ${input.credentialId}
          limit 1
          for share of oauth_grant, credential, token_jti, oauth_client,
            resource_configuration, agent, actor, policy
        `;
      const checkedAt = rows[0]?.authority_checked_at;
      const authorized =
        rows[0] && checkedAt instanceof Date
          ? buildContext(owner, rows[0], input, checkedAt)
          : null;
      if (!authorized) throw invalidCredential();
      return authorized;
    });

    // Telemetry cannot grant authority and must not upgrade the shared locks
    // held by the authorization snapshot. Keep both writes best effort and
    // outside that transaction so a monitoring failure never rejects a valid
    // request or deadlocks concurrent requests for the same Grant.
    await Promise.allSettled([
      this.#sql`
        update platform.oauth_grants
        set last_used_at = clock_timestamp(),
            updated_at = clock_timestamp()
        where id = ${input.grantId}
          and status = 'active'
          and expires_at > clock_timestamp()
          and (
            last_used_at is null
            or last_used_at < clock_timestamp() - interval '5 minutes'
          )
      `,
      this.#sql`
        update platform.credentials
        set last_used_at = clock_timestamp(),
            updated_at = clock_timestamp()
        where id = ${context.credential.id}
          and credential_type = 'oauth_grant'
          and revoked_at is null
          and expires_at > clock_timestamp()
          and (
            last_used_at is null
            or last_used_at < clock_timestamp() - interval '5 minutes'
          )
      `,
    ]);
    return context;
  }
}
