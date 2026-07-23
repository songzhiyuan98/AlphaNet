import { randomUUID } from "node:crypto";

import { appendOutboxEvent, type PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import {
  OwnerWebSessionContextError,
  type OwnerWebContextVerifier,
  type OwnerWebMutationContext,
  type OwnerWebSessionContext,
} from "./owner-web-session-context.js";
import { OWNER_WEB_SOCIAL_V1_MIGRATION_CHECKSUM } from "./schema-migrations.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const DISPLAY_NAME_MAX_LENGTH = 80;
const BIO_MAX_LENGTH = 1_000;

type TransactionSql = postgres.TransactionSql;
type QuerySql = postgres.Sql | postgres.TransactionSql;

export type OwnerSocialIdentityErrorCode =
  | "INVALID_ARGUMENT"
  | "HUMAN_PROFILE_INPUT_INVALID"
  | "OWNER_EMAIL_VERIFICATION_REQUIRED"
  | "OWNER_NOT_ACTIVE"
  | "HUMAN_PROFILE_HANDLE_TAKEN"
  | "HUMAN_PROFILE_ALREADY_ENABLED"
  | "HUMAN_PROFILE_NOT_ENABLED"
  | "HUMAN_PROFILE_STATE_CONFLICT";

const ERROR_MESSAGES: Record<OwnerSocialIdentityErrorCode, string> = {
  INVALID_ARGUMENT: "The Owner social identity request is invalid.",
  HUMAN_PROFILE_INPUT_INVALID: "The human profile fields are invalid.",
  OWNER_EMAIL_VERIFICATION_REQUIRED:
    "Verify the Owner email address before managing public identities.",
  OWNER_NOT_ACTIVE: "The Owner account cannot manage public identities.",
  HUMAN_PROFILE_HANDLE_TAKEN: "That public handle is unavailable.",
  HUMAN_PROFILE_ALREADY_ENABLED:
    "This Owner already has a public human profile; update the existing profile instead.",
  HUMAN_PROFILE_NOT_ENABLED: "This Owner has not enabled a public human profile.",
  HUMAN_PROFILE_STATE_CONFLICT:
    "The public human profile is not active and cannot be changed.",
};

const ERROR_STATUS: Record<OwnerSocialIdentityErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  HUMAN_PROFILE_INPUT_INVALID: 422,
  OWNER_EMAIL_VERIFICATION_REQUIRED: 403,
  OWNER_NOT_ACTIVE: 403,
  HUMAN_PROFILE_HANDLE_TAKEN: 409,
  HUMAN_PROFILE_ALREADY_ENABLED: 409,
  HUMAN_PROFILE_NOT_ENABLED: 404,
  HUMAN_PROFILE_STATE_CONFLICT: 409,
};

export class OwnerSocialIdentityError extends Error {
  readonly code: OwnerSocialIdentityErrorCode;
  readonly retryable = false;
  readonly statusCode: number;

  constructor(code: OwnerSocialIdentityErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "OwnerSocialIdentityError";
    this.code = code;
    this.statusCode = ERROR_STATUS[code];
  }
}

interface PublicIdentityBase {
  actorId: string;
  bio: string | null;
  createdAt: Date;
  displayName: string;
  handle: string;
  joinedAt: Date;
  status: "active";
  updatedAt: Date;
}

export interface OwnerHumanPublicIdentityView extends PublicIdentityBase {
  agentId: null;
  discoveryTags: string[];
  kind: "human";
}

export interface OwnerAgentPublicIdentityView extends PublicIdentityBase {
  agentId: string;
  discoveryTags: string[];
  kind: "agent";
}

export type OwnerPublicIdentityView =
  OwnerHumanPublicIdentityView | OwnerAgentPublicIdentityView;

export type HumanProfileView = OwnerHumanPublicIdentityView;

export interface EnableHumanProfileInput {
  bio?: string | null | undefined;
  displayName: string;
  handle: string;
}

export interface UpdateHumanProfileInput {
  bio?: string | null | undefined;
  displayName?: string | undefined;
}

export interface HumanProfileMutationResult {
  changed: boolean;
  profile: HumanProfileView;
}

export interface OwnerSocialIdentityService {
  checkReady(): Promise<void>;
  enableHumanProfile(
    context: OwnerWebMutationContext,
    input: EnableHumanProfileInput,
  ): Promise<HumanProfileMutationResult>;
  listOwnerPublicIdentities(
    context: OwnerWebSessionContext,
  ): Promise<OwnerPublicIdentityView[]>;
  updateHumanProfile(
    context: OwnerWebMutationContext,
    input: UpdateHumanProfileInput,
  ): Promise<HumanProfileMutationResult>;
}

export interface PostgresOwnerSocialIdentityOptions {
  contextVerifier: OwnerWebContextVerifier;
  idFactory?: (() => string) | undefined;
}

interface OwnerRow {
  email_verified_at: Date | null;
  id: string;
  status: string;
}

interface ActorRow {
  actor_id: string;
  agent_id: string | null;
  bio: string | null;
  created_at: Date;
  discovery_tags: string[];
  display_name: string;
  handle: string;
  joined_at: Date;
  kind: string;
  status: string;
  updated_at: Date;
}

interface AuthorityTimeRow {
  authority_checked_at: Date;
}

interface NormalizedHumanProfile {
  bio: string | null;
  displayName: string;
  handle: string;
}

interface NormalizedHumanProfileUpdate {
  bioProvided: boolean;
  bio: string | null;
  displayNameProvided: boolean;
  displayName: string | null;
}

function isDatabaseError(
  error: unknown,
): error is { code?: string; constraint_name?: string } {
  return typeof error === "object" && error !== null;
}

function finiteDateMilliseconds(value: unknown): number | null {
  if (!(value instanceof Date)) return null;
  try {
    const milliseconds = Date.prototype.getTime.call(value);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  } catch {
    return null;
  }
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new OwnerSocialIdentityError("HUMAN_PROFILE_INPUT_INVALID");
  }
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > DISPLAY_NAME_MAX_LENGTH ||
    normalized.includes("\0")
  ) {
    throw new OwnerSocialIdentityError("HUMAN_PROFILE_INPUT_INVALID");
  }
  return normalized;
}

function normalizeBio(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length > BIO_MAX_LENGTH ||
    value.includes("\0")
  ) {
    throw new OwnerSocialIdentityError("HUMAN_PROFILE_INPUT_INVALID");
  }
  return value;
}

function normalizeEnableInput(input: EnableHumanProfileInput): NormalizedHumanProfile {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new OwnerSocialIdentityError("HUMAN_PROFILE_INPUT_INVALID");
  }
  if (
    !Object.keys(input).every((key) => ["bio", "displayName", "handle"].includes(key))
  ) {
    throw new OwnerSocialIdentityError("HUMAN_PROFILE_INPUT_INVALID");
  }
  if (
    typeof input.handle !== "string" ||
    input.handle.length < 3 ||
    input.handle.length > 32 ||
    !HANDLE_PATTERN.test(input.handle)
  ) {
    throw new OwnerSocialIdentityError("HUMAN_PROFILE_INPUT_INVALID");
  }
  return {
    bio: normalizeBio(input.bio),
    displayName: normalizeDisplayName(input.displayName),
    handle: input.handle,
  };
}

function normalizeUpdateInput(
  input: UpdateHumanProfileInput,
): NormalizedHumanProfileUpdate {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new OwnerSocialIdentityError("HUMAN_PROFILE_INPUT_INVALID");
  }
  if (!Object.keys(input).every((key) => ["bio", "displayName"].includes(key))) {
    throw new OwnerSocialIdentityError("HUMAN_PROFILE_INPUT_INVALID");
  }
  const displayNameProvided = input.displayName !== undefined;
  const bioProvided = input.bio !== undefined;
  if (!displayNameProvided && !bioProvided) {
    throw new OwnerSocialIdentityError("HUMAN_PROFILE_INPUT_INVALID");
  }
  return {
    bio: bioProvided ? normalizeBio(input.bio) : null,
    bioProvided,
    displayName: displayNameProvided ? normalizeDisplayName(input.displayName) : null,
    displayNameProvided,
  };
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.valueOf());
}

function mapHumanProfile(row: ActorRow): HumanProfileView {
  if (
    row.kind !== "human" ||
    row.agent_id !== null ||
    row.status !== "active" ||
    !isValidDate(row.created_at) ||
    !isValidDate(row.updated_at) ||
    !isValidDate(row.joined_at)
  ) {
    throw new Error("The persisted human profile is invalid.");
  }
  return {
    actorId: row.actor_id,
    agentId: null,
    bio: row.bio,
    createdAt: row.created_at,
    discoveryTags: [],
    displayName: row.display_name,
    handle: row.handle,
    joinedAt: row.joined_at,
    kind: "human",
    status: "active",
    updatedAt: row.updated_at,
  };
}

function mapPublicIdentity(row: ActorRow): OwnerPublicIdentityView {
  if (row.kind === "human") return mapHumanProfile(row);
  if (
    row.kind !== "agent" ||
    row.agent_id === null ||
    row.status !== "active" ||
    !Array.isArray(row.discovery_tags) ||
    !row.discovery_tags.every((tag) => typeof tag === "string") ||
    !isValidDate(row.created_at) ||
    !isValidDate(row.updated_at) ||
    !isValidDate(row.joined_at)
  ) {
    throw new Error("The persisted Agent public identity is invalid.");
  }
  return {
    actorId: row.actor_id,
    agentId: row.agent_id,
    bio: row.bio,
    createdAt: row.created_at,
    discoveryTags: [...row.discovery_tags],
    displayName: row.display_name,
    handle: row.handle,
    joinedAt: row.joined_at,
    kind: "agent",
    status: "active",
    updatedAt: row.updated_at,
  };
}

export class PostgresOwnerSocialIdentityService implements OwnerSocialIdentityService {
  readonly #contextVerifier: OwnerWebContextVerifier;
  readonly #idFactory: () => string;
  readonly #sql: PostgresClient;

  constructor(sql: PostgresClient, options: PostgresOwnerSocialIdentityOptions) {
    this.#sql = sql;
    this.#contextVerifier = options.contextVerifier;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async checkReady(): Promise<void> {
    const rows = await this.#sql.begin(async (transaction) => {
      await transaction`set local statement_timeout = '1500ms'`;
      return transaction<{ ready: boolean }[]>`
        select
          exists (
            select 1
            from system.schema_migrations
            where version = '000021'
              and name = 'owner_web_social_v1'
              and checksum = ${OWNER_WEB_SOCIAL_V1_MIGRATION_CHECKSUM}
          )
          and to_regclass('platform.actors') is not null
          and to_regclass('platform.agents') is not null
          and to_regclass('platform.actors_one_human_per_owner') is not null
          and to_regclass('platform.action_logs') is not null
          and to_regclass('system.outbox_events') is not null
          and exists (
            select 1
            from pg_catalog.pg_trigger as trigger_record
            where not trigger_record.tgisinternal
              and trigger_record.tgrelid = to_regclass('platform.actors')
              and trigger_record.tgname = 'actors_enforce_canonical_handle'
              and trigger_record.tgfoid =
                to_regprocedure('platform.enforce_canonical_actor_handle()')
              and trigger_record.tgenabled in ('O', 'A')
          )
          and exists (
            select 1
            from pg_catalog.pg_trigger as trigger_record
            where not trigger_record.tgisinternal
              and trigger_record.tgrelid = to_regclass('platform.actors')
              and trigger_record.tgname = 'actors_prepare_update'
              and trigger_record.tgfoid =
                to_regprocedure('platform.prepare_actor_update()')
              and trigger_record.tgenabled in ('O', 'A')
          ) as ready
      `;
    });
    if (rows[0]?.ready !== true) {
      throw new Error("Owner social identity schema is not ready");
    }
  }

  async listOwnerPublicIdentities(
    rawContext: OwnerWebSessionContext,
  ): Promise<OwnerPublicIdentityView[]> {
    return this.#sql.begin(async (transaction) => {
      const authorityCheckedAt = await this.#authorityCheckedAt(transaction);
      const context = this.#contextVerifier.normalizeSessionContext(
        rawContext,
        authorityCheckedAt,
      );
      await transaction`set local statement_timeout = '5s'`;
      await this.#requireEligibleOwner(
        transaction,
        context.ownerId,
        "read",
        authorityCheckedAt,
      );
      const rows = await transaction<ActorRow[]>`
        select
          actor.id::text as actor_id,
          actor.kind,
          actor.handle::text as handle,
          actor.display_name,
          actor.bio,
          actor.status,
          case
            when actor.kind = 'agent' then agent.created_at
            else actor.created_at
          end as created_at,
          actor.updated_at,
          agent.id::text as agent_id,
          coalesce(agent.discovery_tags, array[]::text[]) as discovery_tags,
          coalesce(agent.activated_at, actor.created_at) as joined_at
        from platform.actors as actor
        left join platform.agents as agent
          on agent.actor_id = actor.id
         and agent.owner_id = actor.owner_id
         and actor.kind = 'agent'
        where actor.owner_id = ${context.ownerId}
          and actor.status = 'active'
          and actor.deleted_at is null
          and (
            actor.kind = 'human'
            or (
              actor.kind = 'agent'
              and agent.id is not null
              and agent.status = 'active'
              and agent.activated_at is not null
              and agent.deleted_at is null
            )
          )
        order by
          case actor.kind when 'human' then 0 else 1 end,
          lower(actor.display_name),
          actor.handle,
          actor.id
      `;
      return rows.map(mapPublicIdentity);
    });
  }

  async enableHumanProfile(
    rawContext: OwnerWebMutationContext,
    input: EnableHumanProfileInput,
  ): Promise<HumanProfileMutationResult> {
    try {
      return await this.#sql.begin(async (transaction) => {
        const authorityCheckedAt = await this.#authorityCheckedAt(transaction);
        const context = this.#contextVerifier.normalizeMutationContext(
          rawContext,
          authorityCheckedAt,
        );
        const normalized = normalizeEnableInput(input);
        await transaction`set local statement_timeout = '10s'`;
        await this.#requireEligibleOwner(
          transaction,
          context.ownerId,
          "mutation",
          authorityCheckedAt,
        );
        const existing = await this.#lockHumanProfile(transaction, context.ownerId);
        if (existing) {
          if (existing.status !== "active") {
            throw new OwnerSocialIdentityError("HUMAN_PROFILE_STATE_CONFLICT");
          }
          const profile = mapHumanProfile(existing);
          if (
            profile.handle === normalized.handle &&
            profile.displayName === normalized.displayName &&
            profile.bio === normalized.bio
          ) {
            return { changed: false, profile };
          }
          throw new OwnerSocialIdentityError("HUMAN_PROFILE_ALREADY_ENABLED");
        }

        const actorId = this.#newId();
        const rows = await transaction<ActorRow[]>`
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
            'human',
            ${context.ownerId},
            ${normalized.handle},
            ${normalized.displayName},
            ${normalized.bio},
            'active'
          )
          returning
            id::text as actor_id,
            kind,
            handle::text as handle,
            display_name,
            bio,
            status,
            created_at,
            updated_at,
            null::text as agent_id,
            array[]::text[] as discovery_tags,
            created_at as joined_at
        `;
        const inserted = rows[0];
        if (!inserted) throw new Error("The human profile insert returned no row.");
        const profile = mapHumanProfile(inserted);
        const { id: outboxEventId } = await appendOutboxEvent(transaction, {
          aggregateId: profile.actorId,
          aggregateType: "actor",
          eventType: "human_profile.enabled",
          eventVersion: 1,
          occurredAt: profile.createdAt,
          payload: {
            actor_id: profile.actorId,
            handle: profile.handle,
            kind: "human",
            status: "active",
          },
        });
        await this.#writeLifecycleActionLog(transaction, {
          action: "human_profile.enable",
          after: {
            bio_present: profile.bio !== null,
            handle: profile.handle,
            status: "active",
          },
          actorId: profile.actorId,
          occurredAt: profile.createdAt,
          outboxEventId,
          ownerId: context.ownerId,
          requestId: context.requestId,
          authenticatedAt: context.authenticatedAt,
          authenticationAssurance: context.authenticationAssurance,
        });
        return { changed: true, profile };
      });
    } catch (error) {
      if (
        isDatabaseError(error) &&
        error.code === "23505" &&
        error.constraint_name === "actors_handle_unique"
      ) {
        throw new OwnerSocialIdentityError("HUMAN_PROFILE_HANDLE_TAKEN");
      }
      if (
        isDatabaseError(error) &&
        error.code === "23505" &&
        error.constraint_name === "actors_one_human_per_owner"
      ) {
        throw new OwnerSocialIdentityError("HUMAN_PROFILE_ALREADY_ENABLED");
      }
      throw error;
    }
  }

  async updateHumanProfile(
    rawContext: OwnerWebMutationContext,
    input: UpdateHumanProfileInput,
  ): Promise<HumanProfileMutationResult> {
    return this.#sql.begin(async (transaction) => {
      const authorityCheckedAt = await this.#authorityCheckedAt(transaction);
      const context = this.#contextVerifier.normalizeMutationContext(
        rawContext,
        authorityCheckedAt,
      );
      const normalized = normalizeUpdateInput(input);
      await transaction`set local statement_timeout = '10s'`;
      await this.#requireEligibleOwner(
        transaction,
        context.ownerId,
        "mutation",
        authorityCheckedAt,
      );
      const existing = await this.#lockHumanProfile(transaction, context.ownerId);
      if (!existing) {
        throw new OwnerSocialIdentityError("HUMAN_PROFILE_NOT_ENABLED");
      }
      if (existing.status !== "active") {
        throw new OwnerSocialIdentityError("HUMAN_PROFILE_STATE_CONFLICT");
      }
      const before = mapHumanProfile(existing);
      const nextDisplayName = normalized.displayNameProvided
        ? normalized.displayName!
        : before.displayName;
      const nextBio = normalized.bioProvided ? normalized.bio : before.bio;
      const changedFields = [
        ...(nextDisplayName === before.displayName ? [] : ["display_name"]),
        ...(nextBio === before.bio ? [] : ["bio"]),
      ];
      if (changedFields.length === 0) {
        return { changed: false, profile: before };
      }

      const rows = await transaction<ActorRow[]>`
        update platform.actors
        set display_name = ${nextDisplayName},
            bio = ${nextBio},
            updated_at = clock_timestamp()
        where id = ${before.actorId}
          and owner_id = ${context.ownerId}
          and kind = 'human'
          and status = 'active'
          and deleted_at is null
        returning
          id::text as actor_id,
          kind,
          handle::text as handle,
          display_name,
          bio,
          status,
          created_at,
          updated_at,
          null::text as agent_id,
          array[]::text[] as discovery_tags,
          created_at as joined_at
      `;
      const updated = rows[0];
      if (!updated) {
        throw new OwnerSocialIdentityError("HUMAN_PROFILE_STATE_CONFLICT");
      }
      const profile = mapHumanProfile(updated);
      const { id: outboxEventId } = await appendOutboxEvent(transaction, {
        aggregateId: profile.actorId,
        aggregateType: "actor",
        eventType: "human_profile.updated",
        eventVersion: 1,
        occurredAt: profile.updatedAt,
        payload: {
          actor_id: profile.actorId,
          changed_fields: changedFields,
          handle: profile.handle,
          kind: "human",
        },
      });
      await this.#writeLifecycleActionLog(transaction, {
        action: "human_profile.update",
        after: {
          bio_present: profile.bio !== null,
          changed_fields: changedFields,
          status: "active",
        },
        actorId: profile.actorId,
        before: {
          bio_present: before.bio !== null,
          status: "active",
        },
        occurredAt: profile.updatedAt,
        outboxEventId,
        ownerId: context.ownerId,
        requestId: context.requestId,
        authenticatedAt: context.authenticatedAt,
        authenticationAssurance: context.authenticationAssurance,
      });
      return { changed: true, profile };
    });
  }

  #newId(): string {
    const id = this.#idFactory();
    if (!UUID_PATTERN.test(id))
      throw new Error("The identity id factory returned invalid UUID.");
    return id;
  }

  async #authorityCheckedAt(transaction: TransactionSql): Promise<Date> {
    const rows = await transaction<AuthorityTimeRow[]>`
      select statement_timestamp() as authority_checked_at
    `;
    const authorityCheckedAt = rows[0]?.authority_checked_at;
    if (authorityCheckedAt === undefined) {
      throw new OwnerWebSessionContextError("INVALID_DATABASE_CHECKED_AT");
    }
    return authorityCheckedAt;
  }

  async #requireEligibleOwner(
    sql: QuerySql,
    ownerId: string,
    access: "mutation" | "read",
    authorityCheckedAt: Date,
  ): Promise<void> {
    const rows =
      access === "mutation"
        ? await sql<OwnerRow[]>`
          select id::text as id, status, email_verified_at
          from platform.owners
          where id = ${ownerId}
            and deleted_at is null
          for update
        `
        : await sql<OwnerRow[]>`
          select id::text as id, status, email_verified_at
          from platform.owners
          where id = ${ownerId}
            and deleted_at is null
          for share
        `;
    const owner = rows[0];
    if (!owner) throw new OwnerSocialIdentityError("OWNER_NOT_ACTIVE");
    const verifiedAtMilliseconds = finiteDateMilliseconds(owner.email_verified_at);
    if (
      verifiedAtMilliseconds === null ||
      verifiedAtMilliseconds > Date.prototype.getTime.call(authorityCheckedAt)
    ) {
      throw new OwnerSocialIdentityError("OWNER_EMAIL_VERIFICATION_REQUIRED");
    }
    if (
      owner.status !== "active" &&
      !(access === "read" && owner.status === "restricted")
    ) {
      throw new OwnerSocialIdentityError("OWNER_NOT_ACTIVE");
    }
  }

  async #lockHumanProfile(sql: QuerySql, ownerId: string): Promise<ActorRow | null> {
    const rows = await sql<ActorRow[]>`
      select
        actor.id::text as actor_id,
        actor.kind,
        actor.handle::text as handle,
        actor.display_name,
        actor.bio,
        actor.status,
        actor.created_at,
        actor.updated_at,
        null::text as agent_id,
        array[]::text[] as discovery_tags,
        actor.created_at as joined_at
      from platform.actors as actor
      where actor.owner_id = ${ownerId}
        and actor.kind = 'human'
      limit 1
      for update
    `;
    return rows[0] ?? null;
  }

  async #writeLifecycleActionLog(
    transaction: TransactionSql,
    event: {
      action: "human_profile.enable" | "human_profile.update";
      actorId: string;
      after: postgres.JSONValue;
      authenticatedAt: Date;
      authenticationAssurance: OwnerWebMutationContext["authenticationAssurance"];
      before?: postgres.JSONValue | undefined;
      occurredAt: Date;
      outboxEventId: string;
      ownerId: string;
      requestId: string;
    },
  ): Promise<void> {
    await transaction`
      insert into platform.action_logs (
        event_class,
        occurred_at,
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
        outbox_event_id,
        policy_version,
        request_id,
        before_state,
        after_state
      )
      values (
        'authorization_change',
        ${event.occurredAt},
        null,
        null,
        ${event.ownerId},
        null,
        null,
        'web',
        'owner_direct',
        ${event.ownerId},
        ${event.authenticationAssurance},
        ${transaction.json({
          authenticated_at: event.authenticatedAt.toISOString(),
          csrf_validated: true,
          owner_session: true,
        })},
        ${event.action},
        'human_profile',
        ${event.actorId},
        'allow',
        'succeeded',
        ${event.outboxEventId},
        null,
        ${event.requestId},
        ${event.before === undefined ? null : transaction.json(event.before)},
        ${transaction.json(event.after)}
      )
    `;
  }
}
