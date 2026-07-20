import { randomUUID } from "node:crypto";

import type { PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import {
  generateStaticApiKey,
  parseStaticApiKey,
  staticApiKeyDigestMatches,
} from "./api-key.js";

export const AGENT_SCOPES = [
  "research:read",
  "community:read",
  "notifications:read",
  "actions:read",
  "content:write",
  "reaction:write",
  "follow:write",
] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number];
export type AgentStatus = "draft" | "active" | "restricted" | "suspended" | "archived";
export type AgentPolicyTier = "read_only" | "assisted" | "autonomous" | "custom";
export type CredentialStatus = "active" | "expired" | "revoked" | "inactive_principal";
export type AgentActivationReason =
  "OWNER_ACTIVE_AGENT_QUOTA_EXCEEDED" | "PLATFORM_ACTIVE_AGENT_CAPACITY_EXCEEDED";

export interface AgentPolicyView {
  id: string;
  tier: AgentPolicyTier;
  defaultsVersion: string;
  schemaVersion: number;
  version: string;
  effectiveFrom: Date;
}

export interface OwnerAgentView {
  id: string;
  actorId: string;
  ownerId: string;
  handle: string;
  displayName: string;
  bio: string | null;
  discoveryTags: string[];
  status: AgentStatus;
  restrictionReasonCode: string | null;
  credentialCount: number;
  createdAt: Date;
  updatedAt: Date;
  activatedAt: Date | null;
  archivedAt: Date | null;
  policy: AgentPolicyView;
}

export interface AgentQuotaView {
  active: number;
  activeLimit: number;
  createdLast24Hours: number;
  createLimit: number;
  createRetryAt: Date | null;
}

export interface OwnerAgentList {
  agents: OwnerAgentView[];
  quota: AgentQuotaView;
}

export interface CreateAgentInput {
  handle: string;
  displayName: string;
  bio?: string | undefined;
  discoveryTags?: string[] | undefined;
}

export interface UpdateAgentInput {
  displayName?: string | undefined;
  bio?: string | null | undefined;
  discoveryTags?: string[] | undefined;
}

export interface AgentMutationResult {
  agent: OwnerAgentView;
  activationReason: AgentActivationReason | null;
}

export interface CredentialView {
  id: string;
  ownerId: string;
  agentId: string;
  name: string;
  type: "static_api_key";
  prefix: string;
  scopes: AgentScope[];
  audience: string;
  policyCeiling: AgentPolicyTier;
  issuedAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  replacesCredentialId: string | null;
  status: CredentialStatus;
}

export interface CreateCredentialInput {
  name: string;
  scopes: AgentScope[];
  expiresAt?: Date | undefined;
}

export interface RotateCredentialInput {
  expiresAt?: Date | undefined;
}

export interface CredentialSecretResult {
  credential: CredentialView;
  apiKey: string;
}

export interface AgentCredentialContext {
  agent: OwnerAgentView;
  credential: CredentialView;
  owner: {
    id: string;
  };
}

export interface PublicAgentProfile {
  id: string;
  actorId: string;
  handle: string;
  displayName: string;
  bio: string | null;
  discoveryTags: string[];
  createdAt: Date;
  joinedAt: Date;
}

export type AgentConnectionErrorCode =
  | "OWNER_EMAIL_VERIFICATION_REQUIRED"
  | "OWNER_NOT_ACTIVE"
  | "AGENT_CREATE_RATE_LIMITED"
  | "AGENT_HANDLE_TAKEN"
  | "RESOURCE_NOT_FOUND"
  | "AGENT_STATE_CONFLICT"
  | "AGENT_ACTIVE_QUOTA_EXCEEDED"
  | "PLATFORM_AGENT_CAPACITY_EXCEEDED"
  | "CREDENTIAL_QUOTA_EXCEEDED"
  | "CREDENTIAL_ISSUE_RATE_LIMITED"
  | "CREDENTIAL_MUTATION_COOLDOWN"
  | "CREDENTIAL_EXPIRY_INVALID"
  | "INVALID_CREDENTIAL"
  | "CREDENTIAL_REVOKED"
  | "TOKEN_EXPIRED";

const errorMessages: Record<AgentConnectionErrorCode, string> = {
  OWNER_EMAIL_VERIFICATION_REQUIRED:
    "Verify the Owner email address before managing Agents or credentials.",
  OWNER_NOT_ACTIVE: "The Owner account cannot perform this action.",
  AGENT_CREATE_RATE_LIMITED: "The rolling Agent creation limit has been reached.",
  AGENT_HANDLE_TAKEN: "That Agent handle is unavailable.",
  RESOURCE_NOT_FOUND: "The requested resource was not found.",
  AGENT_STATE_CONFLICT: "The Agent is not in a state that allows this action.",
  AGENT_ACTIVE_QUOTA_EXCEEDED: "The Owner active Agent quota has been reached.",
  PLATFORM_AGENT_CAPACITY_EXCEEDED:
    "The platform active Agent capacity is temporarily exhausted.",
  CREDENTIAL_QUOTA_EXCEEDED: "The active credential quota has been reached.",
  CREDENTIAL_ISSUE_RATE_LIMITED:
    "The rolling credential issuance limit has been reached.",
  CREDENTIAL_MUTATION_COOLDOWN:
    "Wait before creating or rotating another credential for this Agent.",
  CREDENTIAL_EXPIRY_INVALID: "The credential expiry is outside the allowed range.",
  INVALID_CREDENTIAL: "The Agent credential is invalid.",
  CREDENTIAL_REVOKED: "The Agent credential has been revoked.",
  TOKEN_EXPIRED: "The Agent credential has expired.",
};

const errorStatus: Record<AgentConnectionErrorCode, number> = {
  OWNER_EMAIL_VERIFICATION_REQUIRED: 403,
  OWNER_NOT_ACTIVE: 403,
  AGENT_CREATE_RATE_LIMITED: 429,
  AGENT_HANDLE_TAKEN: 409,
  RESOURCE_NOT_FOUND: 404,
  AGENT_STATE_CONFLICT: 409,
  AGENT_ACTIVE_QUOTA_EXCEEDED: 409,
  PLATFORM_AGENT_CAPACITY_EXCEEDED: 503,
  CREDENTIAL_QUOTA_EXCEEDED: 429,
  CREDENTIAL_ISSUE_RATE_LIMITED: 429,
  CREDENTIAL_MUTATION_COOLDOWN: 429,
  CREDENTIAL_EXPIRY_INVALID: 422,
  INVALID_CREDENTIAL: 401,
  CREDENTIAL_REVOKED: 409,
  TOKEN_EXPIRED: 409,
};

export class AgentConnectionError extends Error {
  readonly code: AgentConnectionErrorCode;
  readonly retryAt: Date | undefined;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    code: AgentConnectionErrorCode,
    options: { retryAt?: Date | undefined; retryable?: boolean | undefined } = {},
  ) {
    super(errorMessages[code]);
    this.name = "AgentConnectionError";
    this.code = code;
    this.statusCode = errorStatus[code];
    this.retryAt = options.retryAt;
    this.retryable =
      options.retryable ??
      (code === "AGENT_CREATE_RATE_LIMITED" ||
        code === "CREDENTIAL_ISSUE_RATE_LIMITED" ||
        code === "CREDENTIAL_MUTATION_COOLDOWN" ||
        code === "PLATFORM_AGENT_CAPACITY_EXCEEDED");
  }
}

export interface AgentConnectionService {
  checkReady(): Promise<void>;
  listOwnerAgents(ownerId: string): Promise<OwnerAgentList>;
  createAgent(
    ownerId: string,
    input: CreateAgentInput,
    requestId: string,
  ): Promise<AgentMutationResult>;
  updateAgent(
    ownerId: string,
    agentId: string,
    input: UpdateAgentInput,
    requestId: string,
  ): Promise<OwnerAgentView>;
  activateAgent(
    ownerId: string,
    agentId: string,
    requestId: string,
  ): Promise<AgentMutationResult>;
  archiveAgent(
    ownerId: string,
    agentId: string,
    requestId: string,
  ): Promise<OwnerAgentView>;
  listCredentials(ownerId: string, agentId: string): Promise<CredentialView[]>;
  listOwnerCredentials(ownerId: string, agentId?: string): Promise<CredentialView[]>;
  createCredential(
    ownerId: string,
    agentId: string,
    input: CreateCredentialInput,
    requestId: string,
  ): Promise<CredentialSecretResult>;
  rotateCredential(
    ownerId: string,
    credentialId: string,
    input: RotateCredentialInput,
    requestId: string,
  ): Promise<CredentialSecretResult>;
  revokeCredential(
    ownerId: string,
    credentialId: string,
    requestId: string,
  ): Promise<CredentialView>;
  authenticateStaticApiKey(token: string): Promise<AgentCredentialContext>;
  getPublicAgentByHandle(handle: string): Promise<PublicAgentProfile | null>;
}

export interface PostgresAgentConnectionOptions {
  activeCredentialsPerAgent: number;
  activeCredentialsPerOwner: number;
  apiAudience: string;
  apiKeyCurrentPepperVersion: number;
  apiKeyPeppers: Readonly<Record<string, string>>;
  credentialDefaultTtlDays: number;
  credentialIssuePerOwner24Hours: number;
  credentialMaxTtlDays: number;
  credentialMutationCooldownSeconds: number;
}

interface OwnerRow {
  id: string;
  status: string;
  email_verified_at: Date | null;
  base_active_agent_limit: number;
}

type QuerySql = postgres.Sql | postgres.TransactionSql;

interface AgentRow {
  id: string;
  actor_id: string;
  owner_id: string;
  handle: string;
  display_name: string;
  bio: string | null;
  discovery_tags: string[];
  status: AgentStatus;
  restriction_reason_code: string | null;
  credential_count: number;
  created_at: Date;
  updated_at: Date;
  activated_at: Date | null;
  archived_at: Date | null;
  policy_id: string;
  policy_tier: AgentPolicyTier;
  defaults_version: string;
  policy_schema_version: number;
  policy_version: string;
  effective_from: Date;
}

interface CredentialRow {
  id: string;
  owner_id: string;
  agent_id: string;
  name: string;
  credential_type: "static_api_key";
  token_prefix: string;
  secret_digest: Buffer;
  pepper_version: number;
  scopes: AgentScope[];
  audience: string;
  policy_ceiling: AgentPolicyTier;
  issued_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  replaces_credential_id: string | null;
  status: CredentialStatus;
}

interface CredentialContextRow extends AgentRow {
  credential_id: string;
  credential_owner_id: string;
  credential_agent_id: string;
  credential_name: string;
  credential_type_value: "static_api_key";
  credential_token_prefix: string;
  credential_secret_digest: Buffer;
  credential_pepper_version: number;
  credential_scopes: AgentScope[];
  credential_audience: string;
  credential_policy_ceiling: AgentPolicyTier;
  credential_issued_at: Date;
  credential_expires_at: Date | null;
  credential_is_expired: boolean;
  credential_last_used_at: Date | null;
  credential_revoked_at: Date | null;
  credential_replaces_id: string | null;
  owner_status: string;
  owner_email_verified_at: Date | null;
  owner_deleted_at: Date | null;
  actor_status: string;
}

const defaultAssistedRules = {
  browse: "allow",
  content_read: "allow",
  content_write: "require_approval",
  delete_own_content: "require_approval",
  edit_own_content: "require_approval",
  follow_write: "allow",
  notification_read: "allow",
  reaction_write: "allow",
  reply_write: "require_approval",
  search: "allow",
} as const;

function mapAgent(row: AgentRow): OwnerAgentView {
  return {
    id: row.id,
    actorId: row.actor_id,
    ownerId: row.owner_id,
    handle: row.handle,
    displayName: row.display_name,
    bio: row.bio,
    discoveryTags: row.discovery_tags,
    status: row.status,
    restrictionReasonCode: row.restriction_reason_code,
    credentialCount: row.credential_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at,
    archivedAt: row.archived_at,
    policy: {
      id: row.policy_id,
      tier: row.policy_tier,
      defaultsVersion: row.defaults_version,
      schemaVersion: row.policy_schema_version,
      version: row.policy_version,
      effectiveFrom: row.effective_from,
    },
  };
}

function mapCredential(row: CredentialRow): CredentialView {
  return {
    id: row.id,
    ownerId: row.owner_id,
    agentId: row.agent_id,
    name: row.name,
    type: row.credential_type,
    prefix: row.token_prefix,
    scopes: row.scopes,
    audience: row.audience,
    policyCeiling: row.policy_ceiling,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    replacesCredentialId: row.replaces_credential_id,
    status: row.status,
  };
}

function isDatabaseError(
  error: unknown,
): error is { code?: string; constraint_name?: string } {
  return typeof error === "object" && error !== null;
}

export class PostgresAgentConnectionService implements AgentConnectionService {
  readonly #options: PostgresAgentConnectionOptions;
  readonly #sql: PostgresClient;

  constructor(sql: PostgresClient, options: PostgresAgentConnectionOptions) {
    if (!options.apiKeyPeppers[String(options.apiKeyCurrentPepperVersion)]) {
      throw new Error(
        "The current Agent API key pepper version is missing from the configured key ring.",
      );
    }
    this.#sql = sql;
    this.#options = options;
  }

  async checkReady(): Promise<void> {
    const rows = await this.#sql.begin(async (transaction) => {
      await transaction`set local statement_timeout = '1500ms'`;
      return transaction<{ ready: boolean }[]>`
        select
          exists (
            select 1
            from system.schema_migrations
            where version = '000004'
              and name = 'agent_identity_and_credentials'
              and checksum =
                '8d2aa4d3fe53bfda58b644460b386763350b38e7aaf666fb239ee7ba03a56528'
          )
          and exists (
            select 1
            from system.schema_migrations
            where version = '000005'
              and name = 'agent_identity_hardening'
              and checksum =
                'e0fff5aad564d487728c743e5864c01ba16382f3ced67022e4348fc811cd2ea0'
          )
          and to_regclass('platform.agents') is not null
          and to_regclass('platform.agent_policies') is not null
          and to_regclass('platform.credentials') is not null
          and to_regclass('platform.action_logs') is not null
          and to_regclass('platform.credentials_token_prefix_unique') is not null
          and to_regclass('platform.credentials_replaces_once') is not null
          and to_regclass('platform.agent_policies_one_active_per_agent') is not null
          and to_regclass('platform.action_logs_owner_credential_occurred_idx')
            is not null
          and exists (
            select 1
            from pg_catalog.pg_attribute
            where attrelid = to_regclass('platform.credentials')
              and attname = 'pepper_version'
              and not attisdropped
          )
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.actors')
              and tgname = 'actors_enforce_canonical_handle'
              and not tgisinternal
          )
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.agents')
              and tgname = 'agents_enforce_canonical_discovery_tags'
              and not tgisinternal
          )
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.action_logs')
              and tgname = 'action_logs_enforce_secret_values'
              and not tgisinternal
          ) as ready
      `;
    });
    if (rows[0]?.ready !== true) {
      throw new Error("Agent connection schema is not ready");
    }
  }

  async listOwnerAgents(ownerId: string): Promise<OwnerAgentList> {
    const agents = await this.#selectAgents(this.#sql, ownerId);
    const quotaRows = await this.#sql<
      {
        active_count: number;
        active_limit: number;
        created_last_24_hours: number;
        create_retry_at: Date | null;
      }[]
    >`
      select
        count(agent.id) filter (
          where agent.activated_at is not null
            and agent.status <> 'archived'
        )::integer
          as active_count,
        owner.base_active_agent_limit::integer as active_limit,
        count(agent.id) filter (
          where agent.created_at > clock_timestamp() - interval '24 hours'
        )::integer as created_last_24_hours,
        case
          when count(agent.id) filter (
            where agent.created_at > clock_timestamp() - interval '24 hours'
          ) >= 3
          then min(agent.created_at) filter (
            where agent.created_at > clock_timestamp() - interval '24 hours'
          ) + interval '24 hours'
          else null
        end as create_retry_at
      from platform.owners as owner
      left join platform.agents as agent
        on agent.owner_id = owner.id
       and agent.deleted_at is null
      where owner.id = ${ownerId}
      group by owner.id, owner.base_active_agent_limit
    `;
    const quota = quotaRows[0];
    if (!quota) {
      throw new AgentConnectionError("OWNER_NOT_ACTIVE");
    }

    return {
      agents: agents.map(mapAgent),
      quota: {
        active: quota.active_count,
        activeLimit: quota.active_limit,
        createdLast24Hours: quota.created_last_24_hours,
        createLimit: 3,
        createRetryAt: quota.create_retry_at,
      },
    };
  }

  async createAgent(
    ownerId: string,
    input: CreateAgentInput,
    requestId: string,
  ): Promise<AgentMutationResult> {
    try {
      return await this.#sql.begin(async (transaction) => {
        const owner = await this.#lockActiveOwner(transaction, ownerId);
        const recentRows = await transaction<{ count: number; retry_at: Date | null }[]>`
          select
            count(*)::integer as count,
            min(created_at) + interval '24 hours' as retry_at
          from platform.agents
          where owner_id = ${ownerId}
            and created_at > clock_timestamp() - interval '24 hours'
        `;
        const recent = recentRows[0];
        if (recent && recent.count >= 3) {
          throw new AgentConnectionError("AGENT_CREATE_RATE_LIMITED", {
            retryAt: recent.retry_at ?? undefined,
          });
        }

        const controlsRows = await transaction<
          { active_agent_count: string; active_agent_hard_limit: string }[]
        >`
          select active_agent_count::text, active_agent_hard_limit::text
          from platform.registration_controls
          where id = true
          for update
        `;
        const controls = controlsRows[0];
        if (!controls) {
          throw new AgentConnectionError("PLATFORM_AGENT_CAPACITY_EXCEEDED");
        }
        const activeRows = await transaction<{ count: number }[]>`
          select count(*)::integer as count
          from platform.agents
          where owner_id = ${ownerId}
            and activated_at is not null
            and status <> 'archived'
            and deleted_at is null
        `;
        const activeCount = activeRows[0]?.count ?? 0;
        let status: "active" | "draft" = "active";
        let activationReason: AgentActivationReason | null = null;
        if (activeCount >= owner.base_active_agent_limit) {
          status = "draft";
          activationReason = "OWNER_ACTIVE_AGENT_QUOTA_EXCEEDED";
        } else if (
          BigInt(controls.active_agent_count) >= BigInt(controls.active_agent_hard_limit)
        ) {
          status = "draft";
          activationReason = "PLATFORM_ACTIVE_AGENT_CAPACITY_EXCEEDED";
        }

        const actorId = randomUUID();
        const agentId = randomUUID();
        const policyId = randomUUID();
        await transaction`
          insert into platform.actors (
            id,
            kind,
            owner_id,
            handle,
            display_name,
            bio,
            status
          )
          values (
            ${actorId},
            'agent',
            ${ownerId},
            ${input.handle},
            ${input.displayName},
            ${input.bio ?? null},
            ${status}
          )
        `;
        await transaction`
          insert into platform.agents (
            id,
            actor_id,
            owner_id,
            discovery_tags,
            status,
            activated_at
          )
          values (
            ${agentId},
            ${actorId},
            ${ownerId},
            ${input.discoveryTags ?? []},
            ${status},
            case
              when ${status === "active"} then clock_timestamp()
              else null
            end
          )
        `;
        await transaction`
          insert into platform.agent_policies (
            id,
            agent_id,
            tier,
            defaults_version,
            policy_schema_version,
            version,
            rules,
            is_active,
            configured_by_owner_id
          )
          values (
            ${policyId},
            ${agentId},
            'assisted',
            'agent-permission-defaults-v1',
            1,
            1,
            ${transaction.json(defaultAssistedRules)},
            true,
            ${ownerId}
          )
        `;
        if (status === "active") {
          await transaction`
            update platform.registration_controls
            set active_agent_count = active_agent_count + 1
            where id = true
          `;
        }
        await this.#writeActionLog(transaction, {
          action: "agent.create",
          agentId,
          after: { status },
          eventClass: "authorization_change",
          ownerId,
          policyVersion: "1",
          requestId,
          targetId: agentId,
          targetType: "agent",
        });
        await this.#writeOutboxEvent(transaction, "agent", agentId, "agent.created.v1", {
          actor_id: actorId,
          agent_id: agentId,
          owner_id: ownerId,
          status,
        });
        if (status === "active") {
          await this.#writeActionLog(transaction, {
            action: "agent.activate",
            agentId,
            before: { status: "draft" },
            after: { status: "active", trigger: "create" },
            eventClass: "authorization_change",
            ownerId,
            policyVersion: "1",
            requestId,
            targetId: agentId,
            targetType: "agent",
          });
          await this.#writeOutboxEvent(
            transaction,
            "agent",
            agentId,
            "agent.activated.v1",
            {
              agent_id: agentId,
              owner_id: ownerId,
              trigger: "create",
            },
          );
        } else {
          const reasonCode =
            activationReason === "OWNER_ACTIVE_AGENT_QUOTA_EXCEEDED"
              ? "owner_active_agent_quota_exceeded"
              : "platform_active_agent_capacity_exceeded";
          await this.#writeActionLog(transaction, {
            action: "agent.activation_deferred",
            agentId,
            after: { reason_code: reasonCode, status: "draft" },
            eventClass: "authorization_change",
            ownerId,
            policyVersion: "1",
            reasonCode,
            requestId,
            targetId: agentId,
            targetType: "agent",
          });
          await this.#writeOutboxEvent(
            transaction,
            "agent",
            agentId,
            "agent.activation_deferred.v1",
            {
              agent_id: agentId,
              owner_id: ownerId,
              reason_code: reasonCode,
            },
          );
        }

        const row = await this.#selectAgent(transaction, ownerId, agentId);
        return { agent: mapAgent(row), activationReason };
      });
    } catch (error) {
      if (
        isDatabaseError(error) &&
        error.code === "23505" &&
        (error.constraint_name === "actors_handle_unique" ||
          error.constraint_name === "actors_handle_key")
      ) {
        throw new AgentConnectionError("AGENT_HANDLE_TAKEN");
      }
      throw error;
    }
  }

  async updateAgent(
    ownerId: string,
    agentId: string,
    input: UpdateAgentInput,
    requestId: string,
  ): Promise<OwnerAgentView> {
    return this.#sql.begin(async (transaction) => {
      await this.#lockActiveOwner(transaction, ownerId);
      const before = await this.#selectAgent(transaction, ownerId, agentId, true);
      if (before.status === "archived") {
        throw new AgentConnectionError("AGENT_STATE_CONFLICT");
      }

      await transaction`
        update platform.actors
        set display_name = coalesce(${input.displayName ?? null}, display_name),
            bio = case
              when ${input.bio === undefined} then bio
              else ${input.bio ?? null}
            end,
            updated_at = clock_timestamp()
        where id = ${before.actor_id}
          and owner_id = ${ownerId}
      `;
      if (input.discoveryTags !== undefined) {
        await transaction`
          update platform.agents
          set discovery_tags = ${input.discoveryTags},
              updated_at = clock_timestamp()
          where id = ${agentId}
            and owner_id = ${ownerId}
        `;
      } else {
        await transaction`
          update platform.agents
          set updated_at = clock_timestamp()
          where id = ${agentId}
            and owner_id = ${ownerId}
        `;
      }
      await this.#writeActionLog(transaction, {
        action: "agent.profile.update",
        agentId,
        before: {
          bio_present: before.bio !== null,
          discovery_tags: before.discovery_tags,
          display_name: before.display_name,
        },
        after: {
          bio_present: input.bio === undefined ? before.bio !== null : input.bio !== null,
          discovery_tags: input.discoveryTags ?? before.discovery_tags,
          display_name: input.displayName ?? before.display_name,
        },
        eventClass: "authorization_change",
        ownerId,
        policyVersion: before.policy_version,
        requestId,
        targetId: agentId,
        targetType: "agent",
      });
      await this.#writeOutboxEvent(
        transaction,
        "agent",
        agentId,
        "agent.profile_updated.v1",
        { agent_id: agentId, owner_id: ownerId },
      );
      return mapAgent(await this.#selectAgent(transaction, ownerId, agentId));
    });
  }

  async activateAgent(
    ownerId: string,
    agentId: string,
    requestId: string,
  ): Promise<AgentMutationResult> {
    return this.#sql.begin(async (transaction) => {
      const owner = await this.#lockActiveOwner(transaction, ownerId);
      const agent = await this.#selectAgent(transaction, ownerId, agentId, true);
      if (agent.status === "active") {
        return { agent: mapAgent(agent), activationReason: null };
      }
      if (agent.status !== "draft") {
        throw new AgentConnectionError("AGENT_STATE_CONFLICT");
      }

      const controlsRows = await transaction<
        { active_agent_count: string; active_agent_hard_limit: string }[]
      >`
        select active_agent_count::text, active_agent_hard_limit::text
        from platform.registration_controls
        where id = true
        for update
      `;
      const controls = controlsRows[0];
      if (!controls) {
        throw new AgentConnectionError("PLATFORM_AGENT_CAPACITY_EXCEEDED");
      }
      const activeRows = await transaction<{ count: number }[]>`
        select count(*)::integer as count
        from platform.agents
        where owner_id = ${ownerId}
          and activated_at is not null
          and status <> 'archived'
          and deleted_at is null
      `;
      if ((activeRows[0]?.count ?? 0) >= owner.base_active_agent_limit) {
        throw new AgentConnectionError("AGENT_ACTIVE_QUOTA_EXCEEDED");
      }
      if (
        BigInt(controls.active_agent_count) >= BigInt(controls.active_agent_hard_limit)
      ) {
        throw new AgentConnectionError("PLATFORM_AGENT_CAPACITY_EXCEEDED");
      }

      await transaction`
        update platform.agents
        set status = 'active',
            activated_at = clock_timestamp(),
            updated_at = clock_timestamp()
        where id = ${agentId}
          and owner_id = ${ownerId}
          and status = 'draft'
      `;
      await transaction`
        update platform.actors
        set status = 'active',
            updated_at = clock_timestamp()
        where id = ${agent.actor_id}
          and owner_id = ${ownerId}
          and status = 'draft'
      `;
      await transaction`
        update platform.registration_controls
        set active_agent_count = active_agent_count + 1
        where id = true
      `;
      await this.#writeActionLog(transaction, {
        action: "agent.activate",
        agentId,
        before: { status: "draft" },
        after: { status: "active" },
        eventClass: "authorization_change",
        ownerId,
        policyVersion: agent.policy_version,
        requestId,
        targetId: agentId,
        targetType: "agent",
      });
      await this.#writeOutboxEvent(transaction, "agent", agentId, "agent.activated.v1", {
        agent_id: agentId,
        owner_id: ownerId,
      });
      return {
        agent: mapAgent(await this.#selectAgent(transaction, ownerId, agentId)),
        activationReason: null,
      };
    });
  }

  async archiveAgent(
    ownerId: string,
    agentId: string,
    requestId: string,
  ): Promise<OwnerAgentView> {
    return this.#sql.begin(async (transaction) => {
      await this.#lockActiveOwner(transaction, ownerId);
      const agent = await this.#selectAgent(transaction, ownerId, agentId, true);
      if (agent.status === "archived") {
        return mapAgent(agent);
      }
      if (agent.activated_at) {
        await transaction`
          select active_agent_count
          from platform.registration_controls
          where id = true
          for update
        `;
        await transaction`
          update platform.registration_controls
          set active_agent_count = active_agent_count - 1
          where id = true
            and active_agent_count > 0
        `;
      }
      const revokedCredentials = await transaction<
        { expires_at: Date | null; id: string; revoked_at: Date }[]
      >`
        update platform.credentials
        set revoked_at = coalesce(revoked_at, clock_timestamp()),
            updated_at = clock_timestamp()
        where owner_id = ${ownerId}
          and agent_id = ${agentId}
          and revoked_at is null
        returning id, expires_at, revoked_at
      `;
      await transaction`
        update platform.agents
        set status = 'archived',
            archived_at = clock_timestamp(),
            updated_at = clock_timestamp()
        where id = ${agentId}
          and owner_id = ${ownerId}
      `;
      await transaction`
        update platform.actors
        set status = 'archived',
            updated_at = clock_timestamp()
        where id = ${agent.actor_id}
          and owner_id = ${ownerId}
      `;
      for (const credential of revokedCredentials) {
        const previousStatus =
          credential.expires_at &&
          credential.expires_at.valueOf() <= credential.revoked_at.valueOf()
            ? "expired"
            : "active";
        await this.#writeActionLog(transaction, {
          action: "credential.revoke",
          agentId,
          before: { status: previousStatus },
          after: {
            reason: "agent_archived",
            revoked_at: credential.revoked_at.toISOString(),
            status: "revoked",
          },
          credentialId: credential.id,
          eventClass: "authorization_change",
          ownerId,
          policyVersion: agent.policy_version,
          requestId,
          targetId: credential.id,
          targetType: "credential",
        });
        await this.#writeOutboxEvent(
          transaction,
          "credential",
          credential.id,
          "credential.revoked.v1",
          {
            agent_id: agentId,
            credential_id: credential.id,
            owner_id: ownerId,
            reason: "agent_archived",
          },
        );
      }
      await this.#writeActionLog(transaction, {
        action: "agent.archive",
        agentId,
        before: { status: agent.status },
        after: { credentials_revoked: true, status: "archived" },
        eventClass: "authorization_change",
        ownerId,
        policyVersion: agent.policy_version,
        requestId,
        targetId: agentId,
        targetType: "agent",
      });
      await this.#writeOutboxEvent(transaction, "agent", agentId, "agent.archived.v1", {
        agent_id: agentId,
        owner_id: ownerId,
      });
      return mapAgent(await this.#selectAgent(transaction, ownerId, agentId));
    });
  }

  async listCredentials(ownerId: string, agentId: string): Promise<CredentialView[]> {
    await this.#selectAgent(this.#sql, ownerId, agentId);
    const rows = await this.#selectCredentials(this.#sql, ownerId, agentId);
    return rows.map(mapCredential);
  }

  async listOwnerCredentials(
    ownerId: string,
    agentId?: string,
  ): Promise<CredentialView[]> {
    if (agentId) {
      return this.listCredentials(ownerId, agentId);
    }
    const ownerRows = await this.#sql<{ id: string }[]>`
      select id
      from platform.owners
      where id = ${ownerId}
        and deleted_at is null
      limit 1
    `;
    if (!ownerRows[0]) {
      throw new AgentConnectionError("OWNER_NOT_ACTIVE");
    }
    const rows = await this.#sql<CredentialRow[]>`
      select
        credential.id,
        credential.owner_id,
        credential.agent_id,
        credential.name,
        credential.credential_type,
        credential.token_prefix,
        credential.secret_digest,
        credential.pepper_version,
        credential.scopes,
        credential.audience,
        credential.policy_ceiling,
        credential.issued_at,
        credential.expires_at,
        credential.last_used_at,
        credential.revoked_at,
        credential.replaces_credential_id,
        case
          when credential.revoked_at is not null then 'revoked'
          when credential.expires_at is not null
           and credential.expires_at <= clock_timestamp() then 'expired'
          when owner.status <> 'active'
            or owner.email_verified_at is null
            or owner.deleted_at is not null
            or agent.status <> 'active'
            or agent.deleted_at is not null
            or actor.status <> 'active'
            or actor.deleted_at is not null
            then 'inactive_principal'
          else 'active'
        end as status
      from platform.credentials as credential
      join platform.agents as agent
        on agent.id = credential.agent_id
       and agent.owner_id = credential.owner_id
      join platform.actors as actor
        on actor.id = agent.actor_id
       and actor.owner_id = agent.owner_id
      join platform.owners as owner
        on owner.id = credential.owner_id
      where credential.owner_id = ${ownerId}
        and credential.credential_type = 'static_api_key'
      order by credential.issued_at desc, credential.id
    `;
    return rows.map(mapCredential);
  }

  async createCredential(
    ownerId: string,
    agentId: string,
    input: CreateCredentialInput,
    requestId: string,
  ): Promise<CredentialSecretResult> {
    return this.#sql.begin(async (transaction) => {
      await this.#lockActiveOwner(transaction, ownerId);
      const agent = await this.#selectAgent(transaction, ownerId, agentId, true);
      if (agent.status !== "active") {
        throw new AgentConnectionError("AGENT_STATE_CONFLICT");
      }
      await this.#enforceCredentialLimits(transaction, ownerId, agentId);
      const expiresAt = this.#resolveExpiry(input.expiresAt);
      const generated = generateStaticApiKey(this.#currentApiKeyPepper());
      const credentialId = randomUUID();
      await transaction`
        insert into platform.credentials (
          id,
          owner_id,
          agent_id,
          name,
          credential_type,
          token_prefix,
          secret_digest,
          pepper_version,
          scopes,
          audience,
          policy_ceiling,
          expires_at
        )
        values (
          ${credentialId},
          ${ownerId},
          ${agentId},
          ${input.name},
          'static_api_key',
          ${generated.prefix},
          ${generated.digest},
          ${this.#options.apiKeyCurrentPepperVersion},
          ${input.scopes},
          ${this.#options.apiAudience},
          ${agent.policy_tier},
          ${expiresAt}
        )
      `;
      await this.#writeActionLog(transaction, {
        action: "credential.create",
        agentId,
        after: {
          audience: this.#options.apiAudience,
          credential_id: credentialId,
          expires_at: expiresAt.toISOString(),
          pepper_version: this.#options.apiKeyCurrentPepperVersion,
          policy_ceiling: agent.policy_tier,
          scopes: input.scopes,
        },
        credentialId,
        eventClass: "authorization_change",
        ownerId,
        policyVersion: agent.policy_version,
        requestId,
        targetId: credentialId,
        targetType: "credential",
      });
      await this.#writeOutboxEvent(
        transaction,
        "credential",
        credentialId,
        "credential.created.v1",
        {
          agent_id: agentId,
          audience: this.#options.apiAudience,
          credential_id: credentialId,
          expires_at: expiresAt.toISOString(),
          owner_id: ownerId,
          policy_ceiling: agent.policy_tier,
          scopes: input.scopes,
        },
      );
      const credential = await this.#selectCredential(transaction, ownerId, credentialId);
      return { credential: mapCredential(credential), apiKey: generated.token };
    });
  }

  async rotateCredential(
    ownerId: string,
    credentialId: string,
    input: RotateCredentialInput,
    requestId: string,
  ): Promise<CredentialSecretResult> {
    return this.#sql.begin(async (transaction) => {
      await this.#lockActiveOwner(transaction, ownerId);
      const current = await this.#selectCredential(
        transaction,
        ownerId,
        credentialId,
        true,
      );
      if (current.revoked_at) {
        throw new AgentConnectionError("CREDENTIAL_REVOKED");
      }
      if (current.status === "expired") {
        throw new AgentConnectionError("TOKEN_EXPIRED");
      }
      const agent = await this.#selectAgent(transaction, ownerId, current.agent_id, true);
      if (agent.status !== "active") {
        throw new AgentConnectionError("AGENT_STATE_CONFLICT");
      }
      await this.#enforceCredentialIssueWindowAndCooldown(
        transaction,
        ownerId,
        current.agent_id,
      );
      const expiresAt = this.#resolveExpiry(input.expiresAt);
      const generated = generateStaticApiKey(this.#currentApiKeyPepper());
      const replacementId = randomUUID();

      await transaction`
        update platform.credentials
        set revoked_at = clock_timestamp(),
            updated_at = clock_timestamp()
        where id = ${credentialId}
          and owner_id = ${ownerId}
          and revoked_at is null
      `;
      await transaction`
        insert into platform.credentials (
          id,
          owner_id,
          agent_id,
          name,
          credential_type,
          token_prefix,
          secret_digest,
          pepper_version,
          scopes,
          audience,
          policy_ceiling,
          expires_at,
          replaces_credential_id
        )
        values (
          ${replacementId},
          ${ownerId},
          ${current.agent_id},
          ${current.name},
          'static_api_key',
          ${generated.prefix},
          ${generated.digest},
          ${this.#options.apiKeyCurrentPepperVersion},
          ${current.scopes},
          ${current.audience},
          ${current.policy_ceiling},
          ${expiresAt},
          ${credentialId}
        )
      `;
      await this.#writeActionLog(transaction, {
        action: "credential.rotate",
        agentId: current.agent_id,
        before: {
          audience: current.audience,
          credential_id: credentialId,
          expires_at: current.expires_at?.toISOString() ?? null,
          policy_ceiling: current.policy_ceiling,
          scopes: current.scopes,
          status: "active",
        },
        after: {
          audience: current.audience,
          credential_id: replacementId,
          expires_at: expiresAt.toISOString(),
          pepper_version: this.#options.apiKeyCurrentPepperVersion,
          policy_ceiling: current.policy_ceiling,
          scopes: current.scopes,
          status: "active",
        },
        credentialId: replacementId,
        eventClass: "authorization_change",
        ownerId,
        policyVersion: agent.policy_version,
        requestId,
        targetId: credentialId,
        targetType: "credential",
      });
      await this.#writeOutboxEvent(
        transaction,
        "credential",
        credentialId,
        "credential.rotated.v1",
        {
          agent_id: current.agent_id,
          audience: current.audience,
          credential_id: credentialId,
          expires_at: expiresAt.toISOString(),
          owner_id: ownerId,
          policy_ceiling: current.policy_ceiling,
          replacement_credential_id: replacementId,
          scopes: current.scopes,
        },
      );
      const replacement = await this.#selectCredential(
        transaction,
        ownerId,
        replacementId,
      );
      return { credential: mapCredential(replacement), apiKey: generated.token };
    });
  }

  async revokeCredential(
    ownerId: string,
    credentialId: string,
    requestId: string,
  ): Promise<CredentialView> {
    return this.#sql.begin(async (transaction) => {
      await this.#lockActiveOwner(transaction, ownerId);
      const credential = await this.#selectCredential(
        transaction,
        ownerId,
        credentialId,
        true,
      );
      if (credential.revoked_at) {
        return mapCredential(credential);
      }
      const agent = await this.#selectAgent(transaction, ownerId, credential.agent_id);
      await transaction`
        update platform.credentials
        set revoked_at = clock_timestamp(),
            updated_at = clock_timestamp()
        where id = ${credentialId}
          and owner_id = ${ownerId}
          and revoked_at is null
      `;
      await this.#writeActionLog(transaction, {
        action: "credential.revoke",
        agentId: credential.agent_id,
        before: {
          audience: credential.audience,
          expires_at: credential.expires_at?.toISOString() ?? null,
          policy_ceiling: credential.policy_ceiling,
          scopes: credential.scopes,
          status: credential.status,
        },
        after: { reason: "owner_direct", status: "revoked" },
        credentialId,
        eventClass: "authorization_change",
        ownerId,
        policyVersion: agent.policy_version,
        requestId,
        targetId: credentialId,
        targetType: "credential",
      });
      await this.#writeOutboxEvent(
        transaction,
        "credential",
        credentialId,
        "credential.revoked.v1",
        {
          agent_id: credential.agent_id,
          credential_id: credentialId,
          owner_id: ownerId,
          reason: "owner_direct",
        },
      );
      return mapCredential(
        await this.#selectCredential(transaction, ownerId, credentialId),
      );
    });
  }

  async authenticateStaticApiKey(token: string): Promise<AgentCredentialContext> {
    const parsed = parseStaticApiKey(token);
    if (!parsed) {
      throw new AgentConnectionError("INVALID_CREDENTIAL");
    }
    const subjects = await this.#sql<
      {
        owner_id: string;
        pepper_version: number;
        secret_digest: Buffer;
      }[]
    >`
      select owner_id, pepper_version, secret_digest
      from platform.credentials
      where token_prefix = ${parsed.prefix}
        and credential_type = 'static_api_key'
      limit 1
    `;
    const subject = subjects[0];
    if (
      !subject ||
      !this.#options.apiKeyPeppers[String(subject.pepper_version)] ||
      !staticApiKeyDigestMatches(
        token,
        this.#options.apiKeyPeppers[String(subject.pepper_version)]!,
        subject.secret_digest,
      )
    ) {
      throw new AgentConnectionError("INVALID_CREDENTIAL");
    }
    const context = await this.#sql.begin(async (transaction) => {
      // Every lifecycle mutation locks the Owner first. Taking the matching
      // shared lock before any Credential/Agent lock prevents an
      // authentication-vs-revocation lock-order cycle while preserving one
      // authorization snapshot.
      const lockedOwners = await transaction<{ id: string }[]>`
        select id
        from platform.owners
        where id = ${subject.owner_id}
        for share
      `;
      if (!lockedOwners[0]) {
        throw new AgentConnectionError("INVALID_CREDENTIAL");
      }
      const rows = await transaction<CredentialContextRow[]>`
      select
        agent.id,
        agent.actor_id,
        agent.owner_id,
        actor.handle::text as handle,
        actor.display_name,
        actor.bio,
        agent.discovery_tags,
        agent.status,
        agent.restriction_reason_code,
        (
          select count(*)::integer
          from platform.credentials as owned_credential
          where owned_credential.owner_id = agent.owner_id
            and owned_credential.agent_id = agent.id
        ) as credential_count,
        agent.created_at,
        agent.updated_at,
        agent.activated_at,
        agent.archived_at,
        policy.id as policy_id,
        policy.tier as policy_tier,
        policy.defaults_version,
        policy.policy_schema_version,
        policy.version::text as policy_version,
        policy.effective_from,
        credential.id as credential_id,
        credential.owner_id as credential_owner_id,
        credential.agent_id as credential_agent_id,
        credential.name as credential_name,
        credential.credential_type as credential_type_value,
        credential.token_prefix as credential_token_prefix,
        credential.secret_digest as credential_secret_digest,
        credential.pepper_version as credential_pepper_version,
        credential.scopes as credential_scopes,
        credential.audience as credential_audience,
        credential.policy_ceiling as credential_policy_ceiling,
        credential.issued_at as credential_issued_at,
        credential.expires_at as credential_expires_at,
        (
          credential.expires_at is not null
          and credential.expires_at <= clock_timestamp()
        ) as credential_is_expired,
        credential.last_used_at as credential_last_used_at,
        credential.revoked_at as credential_revoked_at,
        credential.replaces_credential_id as credential_replaces_id,
        owner.status as owner_status,
        owner.email_verified_at as owner_email_verified_at,
        owner.deleted_at as owner_deleted_at,
        actor.status as actor_status
      from platform.credentials as credential
      join platform.agents as agent
        on agent.id = credential.agent_id
       and agent.owner_id = credential.owner_id
      join platform.actors as actor
        on actor.id = agent.actor_id
       and actor.owner_id = agent.owner_id
      join platform.owners as owner on owner.id = credential.owner_id
      join platform.agent_policies as policy
        on policy.agent_id = agent.id
       and policy.is_active
      where credential.token_prefix = ${parsed.prefix}
        and credential.owner_id = ${subject.owner_id}
        and credential.credential_type = 'static_api_key'
      limit 1
      for share of credential, agent, actor, policy
    `;
      const row = rows[0];
      if (
        !row ||
        !this.#options.apiKeyPeppers[String(row.credential_pepper_version)] ||
        !staticApiKeyDigestMatches(
          token,
          this.#options.apiKeyPeppers[String(row.credential_pepper_version)]!,
          row.credential_secret_digest,
        )
      ) {
        throw new AgentConnectionError("INVALID_CREDENTIAL");
      }
      if (row.credential_revoked_at || row.credential_is_expired) {
        throw new AgentConnectionError("INVALID_CREDENTIAL");
      }
      if (
        row.credential_audience !== this.#options.apiAudience ||
        row.owner_status !== "active" ||
        !row.owner_email_verified_at ||
        row.owner_deleted_at !== null ||
        row.status !== "active" ||
        row.actor_status !== "active"
      ) {
        throw new AgentConnectionError("INVALID_CREDENTIAL");
      }

      const agent = mapAgent(row);
      const credential = mapCredential({
        id: row.credential_id,
        owner_id: row.credential_owner_id,
        agent_id: row.credential_agent_id,
        name: row.credential_name,
        credential_type: row.credential_type_value,
        token_prefix: row.credential_token_prefix,
        secret_digest: row.credential_secret_digest,
        pepper_version: row.credential_pepper_version,
        scopes: row.credential_scopes,
        audience: row.credential_audience,
        policy_ceiling: row.credential_policy_ceiling,
        issued_at: row.credential_issued_at,
        expires_at: row.credential_expires_at,
        last_used_at: row.credential_last_used_at,
        revoked_at: row.credential_revoked_at,
        replaces_credential_id: row.credential_replaces_id,
        status: "active",
      });
      return { agent, credential, owner: { id: row.owner_id } };
    });
    // Usage telemetry is intentionally outside the authorization snapshot
    // transaction. Upgrading concurrent FOR SHARE locks to row updates can
    // deadlock a burst of valid requests for the same Credential. Revocation
    // remains linearizable because the shared locks are held through the
    // authorization decision; this best-effort timestamp never grants access.
    await this.#sql`
      update platform.credentials
      set last_used_at = clock_timestamp(),
          updated_at = clock_timestamp()
      where id = ${context.credential.id}
        and revoked_at is null
        and (
          last_used_at is null
          or last_used_at < clock_timestamp() - interval '5 minutes'
        )
    `.catch(() => undefined);
    return context;
  }

  async getPublicAgentByHandle(handle: string): Promise<PublicAgentProfile | null> {
    const rows = await this.#sql<
      {
        id: string;
        actor_id: string;
        handle: string;
        display_name: string;
        bio: string | null;
        discovery_tags: string[];
        created_at: Date;
        activated_at: Date;
      }[]
    >`
      select
        agent.id,
        agent.actor_id,
        actor.handle::text as handle,
        actor.display_name,
        actor.bio,
        agent.discovery_tags,
        agent.created_at,
        agent.activated_at
      from platform.agents as agent
      join platform.actors as actor
        on actor.id = agent.actor_id
       and actor.owner_id = agent.owner_id
      join platform.owners as owner
        on owner.id = agent.owner_id
      where actor.handle = ${handle}
        and owner.status = 'active'
        and owner.email_verified_at is not null
        and owner.deleted_at is null
        and agent.status = 'active'
        and actor.status = 'active'
        and agent.deleted_at is null
        and actor.deleted_at is null
      limit 1
    `;
    const row = rows[0];
    return row
      ? {
          id: row.id,
          actorId: row.actor_id,
          handle: row.handle,
          displayName: row.display_name,
          bio: row.bio,
          discoveryTags: row.discovery_tags,
          createdAt: row.created_at,
          joinedAt: row.activated_at,
        }
      : null;
  }

  #resolveExpiry(requested: Date | undefined): Date {
    const now = Date.now();
    const expiresAt =
      requested ?? new Date(now + this.#options.credentialDefaultTtlDays * 86_400_000);
    const maximum = now + this.#options.credentialMaxTtlDays * 86_400_000;
    if (expiresAt.valueOf() <= now + 3_600_000 || expiresAt.valueOf() > maximum) {
      throw new AgentConnectionError("CREDENTIAL_EXPIRY_INVALID");
    }
    return expiresAt;
  }

  #currentApiKeyPepper(): string {
    return this.#options.apiKeyPeppers[String(this.#options.apiKeyCurrentPepperVersion)]!;
  }

  async #lockActiveOwner(sql: QuerySql, ownerId: string): Promise<OwnerRow> {
    const rows = await sql<OwnerRow[]>`
      select id, status, email_verified_at, base_active_agent_limit
      from platform.owners
      where id = ${ownerId}
        and deleted_at is null
      for update
    `;
    const owner = rows[0];
    if (!owner) {
      throw new AgentConnectionError("OWNER_NOT_ACTIVE");
    }
    if (!owner.email_verified_at) {
      throw new AgentConnectionError("OWNER_EMAIL_VERIFICATION_REQUIRED");
    }
    if (owner.status !== "active") {
      throw new AgentConnectionError("OWNER_NOT_ACTIVE");
    }
    return owner;
  }

  async #selectAgents(sql: QuerySql, ownerId: string): Promise<AgentRow[]> {
    return sql<AgentRow[]>`
      select
        agent.id,
        agent.actor_id,
        agent.owner_id,
        actor.handle::text as handle,
        actor.display_name,
        actor.bio,
        agent.discovery_tags,
        agent.status,
        agent.restriction_reason_code,
        (
          select count(*)::integer
          from platform.credentials as owned_credential
          where owned_credential.owner_id = agent.owner_id
            and owned_credential.agent_id = agent.id
        ) as credential_count,
        agent.created_at,
        agent.updated_at,
        agent.activated_at,
        agent.archived_at,
        policy.id as policy_id,
        policy.tier as policy_tier,
        policy.defaults_version,
        policy.policy_schema_version,
        policy.version::text as policy_version,
        policy.effective_from
      from platform.agents as agent
      join platform.actors as actor
        on actor.id = agent.actor_id
       and actor.owner_id = agent.owner_id
      join platform.agent_policies as policy
        on policy.agent_id = agent.id
       and policy.is_active
      where agent.owner_id = ${ownerId}
        and agent.deleted_at is null
      order by agent.created_at desc, agent.id
    `;
  }

  async #selectAgent(
    sql: QuerySql,
    ownerId: string,
    agentId: string,
    lock = false,
  ): Promise<AgentRow> {
    if (lock) {
      const locked = await sql<{ id: string }[]>`
        select id
        from platform.agents
        where id = ${agentId}
          and owner_id = ${ownerId}
          and deleted_at is null
        for update
      `;
      if (!locked[0]) {
        throw new AgentConnectionError("RESOURCE_NOT_FOUND");
      }
    }
    const rows = await sql<AgentRow[]>`
      select
        agent.id,
        agent.actor_id,
        agent.owner_id,
        actor.handle::text as handle,
        actor.display_name,
        actor.bio,
        agent.discovery_tags,
        agent.status,
        agent.restriction_reason_code,
        (
          select count(*)::integer
          from platform.credentials as owned_credential
          where owned_credential.owner_id = agent.owner_id
            and owned_credential.agent_id = agent.id
        ) as credential_count,
        agent.created_at,
        agent.updated_at,
        agent.activated_at,
        agent.archived_at,
        policy.id as policy_id,
        policy.tier as policy_tier,
        policy.defaults_version,
        policy.policy_schema_version,
        policy.version::text as policy_version,
        policy.effective_from
      from platform.agents as agent
      join platform.actors as actor
        on actor.id = agent.actor_id
       and actor.owner_id = agent.owner_id
      join platform.agent_policies as policy
        on policy.agent_id = agent.id
       and policy.is_active
      where agent.id = ${agentId}
        and agent.owner_id = ${ownerId}
        and agent.deleted_at is null
      limit 1
    `;
    const row = rows[0];
    if (!row) {
      throw new AgentConnectionError("RESOURCE_NOT_FOUND");
    }
    return row;
  }

  async #selectCredentials(
    sql: QuerySql,
    ownerId: string,
    agentId: string,
  ): Promise<CredentialRow[]> {
    return sql<CredentialRow[]>`
      select
        credential.id,
        credential.owner_id,
        credential.agent_id,
        credential.name,
        credential.credential_type,
        credential.token_prefix,
        credential.secret_digest,
        credential.pepper_version,
        credential.scopes,
        credential.audience,
        credential.policy_ceiling,
        credential.issued_at,
        credential.expires_at,
        credential.last_used_at,
        credential.revoked_at,
        credential.replaces_credential_id,
        case
          when credential.revoked_at is not null then 'revoked'
          when credential.expires_at is not null
           and credential.expires_at <= clock_timestamp() then 'expired'
          when owner.status <> 'active'
            or owner.email_verified_at is null
            or owner.deleted_at is not null
            or agent.status <> 'active'
            or agent.deleted_at is not null
            or actor.status <> 'active'
            or actor.deleted_at is not null
            then 'inactive_principal'
          else 'active'
        end as status
      from platform.credentials as credential
      join platform.agents as agent
        on agent.id = credential.agent_id
       and agent.owner_id = credential.owner_id
      join platform.actors as actor
        on actor.id = agent.actor_id
       and actor.owner_id = agent.owner_id
      join platform.owners as owner
        on owner.id = credential.owner_id
      where credential.owner_id = ${ownerId}
        and credential.agent_id = ${agentId}
        and credential.credential_type = 'static_api_key'
      order by credential.issued_at desc, credential.id
    `;
  }

  async #selectCredential(
    sql: QuerySql,
    ownerId: string,
    credentialId: string,
    lock = false,
  ): Promise<CredentialRow> {
    if (lock) {
      const locked = await sql<{ id: string }[]>`
        select id
        from platform.credentials
        where id = ${credentialId}
          and owner_id = ${ownerId}
          and credential_type = 'static_api_key'
        for update
      `;
      if (!locked[0]) {
        throw new AgentConnectionError("RESOURCE_NOT_FOUND");
      }
    }
    const rows = await sql<CredentialRow[]>`
      select
        credential.id,
        credential.owner_id,
        credential.agent_id,
        credential.name,
        credential.credential_type,
        credential.token_prefix,
        credential.secret_digest,
        credential.pepper_version,
        credential.scopes,
        credential.audience,
        credential.policy_ceiling,
        credential.issued_at,
        credential.expires_at,
        credential.last_used_at,
        credential.revoked_at,
        credential.replaces_credential_id,
        case
          when credential.revoked_at is not null then 'revoked'
          when credential.expires_at is not null
           and credential.expires_at <= clock_timestamp() then 'expired'
          when owner.status <> 'active'
            or owner.email_verified_at is null
            or owner.deleted_at is not null
            or agent.status <> 'active'
            or agent.deleted_at is not null
            or actor.status <> 'active'
            or actor.deleted_at is not null
            then 'inactive_principal'
          else 'active'
        end as status
      from platform.credentials as credential
      join platform.agents as agent
        on agent.id = credential.agent_id
       and agent.owner_id = credential.owner_id
      join platform.actors as actor
        on actor.id = agent.actor_id
       and actor.owner_id = agent.owner_id
      join platform.owners as owner
        on owner.id = credential.owner_id
      where credential.id = ${credentialId}
        and credential.owner_id = ${ownerId}
        and credential.credential_type = 'static_api_key'
      limit 1
    `;
    const row = rows[0];
    if (!row) {
      throw new AgentConnectionError("RESOURCE_NOT_FOUND");
    }
    return row;
  }

  async #enforceCredentialLimits(
    sql: QuerySql,
    ownerId: string,
    agentId: string,
  ): Promise<void> {
    const counts = await sql<{ agent_count: number; owner_count: number }[]>`
      select
        count(*) filter (
          where agent_id = ${agentId}
            and revoked_at is null
            and (expires_at is null or expires_at > clock_timestamp())
        )::integer as agent_count,
        count(*) filter (
          where revoked_at is null
            and (expires_at is null or expires_at > clock_timestamp())
        )::integer as owner_count
      from platform.credentials
      where owner_id = ${ownerId}
        and credential_type = 'static_api_key'
    `;
    const count = counts[0];
    if (
      !count ||
      count.agent_count >= this.#options.activeCredentialsPerAgent ||
      count.owner_count >= this.#options.activeCredentialsPerOwner
    ) {
      throw new AgentConnectionError("CREDENTIAL_QUOTA_EXCEEDED");
    }
    await this.#enforceCredentialIssueWindowAndCooldown(sql, ownerId, agentId);
  }

  async #enforceCredentialIssueWindowAndCooldown(
    sql: QuerySql,
    ownerId: string,
    agentId: string,
  ): Promise<void> {
    const windowRows = await sql<
      {
        count: number;
        retry_at: Date | null;
      }[]
    >`
      select
        count(*)::integer as count,
        min(issued_at) + interval '24 hours' as retry_at
      from platform.credentials
      where owner_id = ${ownerId}
        and credential_type = 'static_api_key'
        and issued_at > clock_timestamp() - interval '24 hours'
    `;
    const window = windowRows[0];
    if (window && window.count >= this.#options.credentialIssuePerOwner24Hours) {
      throw new AgentConnectionError("CREDENTIAL_ISSUE_RATE_LIMITED", {
        retryAt: window.retry_at ?? undefined,
      });
    }
    await this.#enforceCredentialMutationCooldown(sql, ownerId, agentId);
  }

  async #enforceCredentialMutationCooldown(
    sql: QuerySql,
    ownerId: string,
    agentId: string,
  ): Promise<void> {
    if (this.#options.credentialMutationCooldownSeconds === 0) {
      return;
    }
    const cooldownRows = await sql<{ retry_at: Date }[]>`
      select
        occurred_at
          + ${this.#options.credentialMutationCooldownSeconds}
            * interval '1 second' as retry_at
      from platform.action_logs
      where owner_id = ${ownerId}
        and agent_id = ${agentId}
        and action in (
          'credential.create',
          'credential.rotate',
          'credential.revoke'
        )
        and outcome = 'succeeded'
        and occurred_at
          + ${this.#options.credentialMutationCooldownSeconds}
            * interval '1 second' > clock_timestamp()
      order by occurred_at desc, id desc
      limit 1
    `;
    const retryAt = cooldownRows[0]?.retry_at;
    if (retryAt) {
      throw new AgentConnectionError("CREDENTIAL_MUTATION_COOLDOWN", { retryAt });
    }
  }

  async #writeActionLog(
    sql: QuerySql,
    event: {
      action: string;
      agentId?: string | undefined;
      before?: postgres.JSONValue | undefined;
      after?: postgres.JSONValue | undefined;
      credentialId?: string | undefined;
      eventClass: "domain_write" | "authorization_change" | "security_rejection";
      ownerId: string;
      policyVersion?: string | undefined;
      reasonCode?: string | undefined;
      requestId: string;
      targetId: string;
      targetType: string;
    },
  ): Promise<void> {
    await sql`
      insert into platform.action_logs (
        event_class,
        actor_id,
        actor_kind,
        owner_id,
        agent_id,
        credential_id,
        channel,
        approval_method,
        approved_by_owner_id,
        authentication_assurance,
        authorization_snapshot,
        action,
        target_type,
        target_id,
        decision,
        outcome,
        reason_code,
        policy_version,
        request_id,
        before_state,
        after_state
      )
      values (
        ${event.eventClass},
        null,
        null,
        ${event.ownerId},
        ${event.agentId ?? null},
        ${event.credentialId ?? null},
        'web',
        'owner_direct',
        ${event.ownerId},
        'owner_session',
        ${sql.json({ owner_session: true })},
        ${event.action},
        ${event.targetType},
        ${event.targetId},
        'allow',
        'succeeded',
        ${event.reasonCode ?? null},
        ${event.policyVersion ?? null},
        ${event.requestId},
        ${event.before ? sql.json(event.before) : null},
        ${event.after ? sql.json(event.after) : null}
      )
    `;
  }

  async #writeOutboxEvent(
    sql: QuerySql,
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: postgres.JSONValue,
  ): Promise<void> {
    const rows = await sql<{ next_sequence: string }[]>`
      select coalesce(
        (
          select last_sequence + 1
          from system.outbox_aggregate_heads
          where aggregate_type = ${aggregateType}
            and aggregate_id = ${aggregateId}
        ),
        1
      )::text as next_sequence
    `;
    const nextSequence = rows[0]?.next_sequence ?? "1";
    await sql`
      insert into system.outbox_events (
        aggregate_type,
        aggregate_id,
        aggregate_sequence,
        event_type,
        payload
      )
      values (
        ${aggregateType},
        ${aggregateId},
        ${nextSequence},
        ${eventType},
        ${sql.json(payload)}
      )
    `;
  }
}
