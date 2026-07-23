import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { appendOutboxEvent, type PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import {
  ADMIN_PERMISSIONS,
  type AdminMfaEvidence,
  type AdminPermission,
} from "./content-moderation.js";
import { TOPIC_COMMUNITY_ADMIN_MIGRATION_CHECKSUM } from "./schema-migrations.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ROLE_PATTERN = /^[a-z][a-z0-9_.-]{0,79}$/u;
const ADMIN_PERMISSION_SET = new Set<string>(ADMIN_PERMISSIONS);

export interface AdminTopicCommunityContext {
  adminId: string;
  authenticationAssurance: "workforce_oidc";
  mfa: AdminMfaEvidence;
  permission: "community:manage";
  permissions: readonly AdminPermission[];
  requestId: string;
  roles: readonly string[];
}

export interface CreateTopicCommunityInput {
  descriptionMarkdown?: string | undefined;
  idempotencyKey: string;
  name: string;
  slug: string;
}

export interface UpdateTopicCommunityInput {
  communityId: string;
  descriptionMarkdown?: string | undefined;
  expectedVersion: number;
  idempotencyKey: string;
  name?: string | undefined;
  state?: "archived" | undefined;
}

export interface TopicCommunityView {
  canonicalTopic: { id: string; slug: string };
  createdAt: Date;
  descriptionMarkdown: string;
  id: string;
  kind: "topic";
  name: string;
  postingPolicy: {
    allowedContent: string[];
    maxPostsPerHour: number;
    repliesOpen: boolean;
    requiresSources: boolean;
  };
  slug: string;
  state: "active" | "archived";
  updatedAt: Date;
  version: number;
}

export interface TopicCommunityMutation {
  action: {
    action: "create" | "update" | "archive";
    actionId: string;
    adminId: string;
    communityVersionAfter: number;
    communityVersionBefore: number | null;
    occurredAt: Date;
    permissionUsed: "community:manage";
  };
  community: TopicCommunityView;
  replayed: boolean;
}

export interface TopicCommunityManagementService {
  checkReady(): Promise<void>;
  create(
    context: AdminTopicCommunityContext,
    input: CreateTopicCommunityInput,
  ): Promise<TopicCommunityMutation>;
  update(
    context: AdminTopicCommunityContext,
    input: UpdateTopicCommunityInput,
  ): Promise<TopicCommunityMutation>;
}

export type TopicCommunityManagementErrorCode =
  | "ADMIN_AUTHENTICATION_REQUIRED"
  | "ADMIN_PERMISSION_REQUIRED"
  | "COMMUNITY_VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "SCHEMA_NOT_READY"
  | "TOPIC_COMMUNITY_ARCHIVED"
  | "TOPIC_COMMUNITY_CONFLICT"
  | "TOPIC_COMMUNITY_NOT_FOUND"
  | "TOPIC_COMMUNITY_UNAVAILABLE"
  | "VALIDATION_ERROR";

const ERROR_DEFINITIONS = {
  ADMIN_AUTHENTICATION_REQUIRED: [
    401,
    false,
    "Administrator authentication is required.",
  ],
  ADMIN_PERMISSION_REQUIRED: [403, false, "Community management permission is required."],
  COMMUNITY_VERSION_CONFLICT: [409, false, "The community version has changed."],
  IDEMPOTENCY_CONFLICT: [409, false, "The idempotency key was already used."],
  SCHEMA_NOT_READY: [503, true, "Topic-community management schema is not ready."],
  TOPIC_COMMUNITY_ARCHIVED: [409, false, "The topic community is archived."],
  TOPIC_COMMUNITY_CONFLICT: [409, false, "The topic community already exists."],
  TOPIC_COMMUNITY_NOT_FOUND: [404, false, "The topic community was not found."],
  TOPIC_COMMUNITY_UNAVAILABLE: [503, true, "Topic-community management is unavailable."],
  VALIDATION_ERROR: [422, false, "The topic-community request is invalid."],
} as const satisfies Record<
  TopicCommunityManagementErrorCode,
  readonly [number, boolean, string]
>;

export class TopicCommunityManagementError extends Error {
  readonly code: TopicCommunityManagementErrorCode;
  readonly currentVersion: number | null;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    code: TopicCommunityManagementErrorCode,
    options: { cause?: unknown; currentVersion?: number | undefined } = {},
  ) {
    const [statusCode, retryable, message] = ERROR_DEFINITIONS[code];
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TopicCommunityManagementError";
    this.code = code;
    this.currentVersion = options.currentVersion ?? null;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

type TransactionSql = postgres.TransactionSql;

interface AdminRbacRow {
  admin_id: string;
  permission: string;
  role_key: string;
}

interface CommunityRow {
  allowed_content: string[];
  community_id: string;
  community_slug: string;
  created_at: Date;
  description: string | null;
  max_posts_per_hour: number;
  name: string;
  replies_open: boolean;
  requires_sources: boolean;
  status: string;
  topic_id: string;
  topic_slug: string;
  updated_at: Date;
  version: string;
}

interface ReplayRow {
  request_digest: Buffer;
  response_snapshot: unknown;
}

interface EffectiveAuthorization {
  permissions: AdminPermission[];
  roles: string[];
}

interface StoredMutationSnapshot {
  action: {
    action: "create" | "update" | "archive";
    actionId: string;
    adminId: string;
    communityVersionAfter: number;
    communityVersionBefore: number | null;
    occurredAt: string;
    permissionUsed: "community:manage";
  };
  community: Omit<TopicCommunityView, "createdAt" | "updatedAt"> & {
    createdAt: string;
    updatedAt: string;
  };
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: object | null = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateContext(
  context: AdminTopicCommunityContext,
): AdminTopicCommunityContext {
  if (
    !isPlainRecord(context) ||
    context.authenticationAssurance !== "workforce_oidc" ||
    context.permission !== "community:manage" ||
    typeof context.adminId !== "string" ||
    !UUID_PATTERN.test(context.adminId) ||
    typeof context.requestId !== "string" ||
    context.requestId.trim() !== context.requestId ||
    context.requestId.length < 1 ||
    context.requestId.length > 200 ||
    /\p{Cc}/u.test(context.requestId) ||
    !isPlainRecord(context.mfa) ||
    typeof context.mfa.amrMfa !== "boolean" ||
    (context.mfa.matchedAcr !== null &&
      (typeof context.mfa.matchedAcr !== "string" ||
        context.mfa.matchedAcr.trim() !== context.mfa.matchedAcr ||
        context.mfa.matchedAcr.length < 1 ||
        context.mfa.matchedAcr.length > 200 ||
        /\p{Cc}/u.test(context.mfa.matchedAcr))) ||
    !["acr", "amr_mfa", "acr_and_amr_mfa"].includes(context.mfa.method) ||
    (context.mfa.method === "acr" &&
      (context.mfa.matchedAcr === null || context.mfa.amrMfa)) ||
    (context.mfa.method === "amr_mfa" &&
      (!context.mfa.amrMfa || context.mfa.matchedAcr !== null)) ||
    (context.mfa.method === "acr_and_amr_mfa" &&
      (!context.mfa.amrMfa || context.mfa.matchedAcr === null))
  ) {
    throw new TopicCommunityManagementError("ADMIN_AUTHENTICATION_REQUIRED");
  }
  if (
    !Array.isArray(context.permissions) ||
    context.permissions.length > ADMIN_PERMISSIONS.length ||
    new Set(context.permissions).size !== context.permissions.length ||
    context.permissions.some(
      (permission) =>
        typeof permission !== "string" || !ADMIN_PERMISSION_SET.has(permission),
    ) ||
    !context.permissions.includes("community:manage") ||
    !Array.isArray(context.roles) ||
    context.roles.length > 100 ||
    new Set(context.roles).size !== context.roles.length ||
    context.roles.some((role) => typeof role !== "string" || !ROLE_PATTERN.test(role))
  ) {
    throw new TopicCommunityManagementError("ADMIN_PERMISSION_REQUIRED");
  }
  return {
    ...context,
    adminId: context.adminId.toLowerCase(),
    permissions: sortedUnique(context.permissions),
    roles: sortedUnique(context.roles),
  };
}

function normalizeText(value: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new TopicCommunityManagementError("VALIDATION_ERROR");
  }
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length < 1 ||
    normalized.length > maximum ||
    /[^\P{Cc}\n\t]/u.test(normalized)
  ) {
    throw new TopicCommunityManagementError("VALIDATION_ERROR");
  }
  return normalized;
}

function normalizeDescription(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TopicCommunityManagementError("VALIDATION_ERROR");
  }
  const normalized = value.normalize("NFC").trim();
  if (normalized.length > 4_000 || /[^\P{Cc}\n\t]/u.test(normalized)) {
    throw new TopicCommunityManagementError("VALIDATION_ERROR");
  }
  return normalized;
}

function normalizeIdempotencyKey(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 200 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TopicCommunityManagementError("VALIDATION_ERROR");
  }
  return value;
}

function normalizeUuid(value: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TopicCommunityManagementError("VALIDATION_ERROR");
  }
  return value.toLowerCase();
}

function digestRequest(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

function positiveVersion(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Topic community returned an invalid version.");
  }
  return parsed;
}

function rowToView(row: CommunityRow): TopicCommunityView {
  if (row.status !== "active" && row.status !== "archived") {
    throw new Error("Topic community returned an unsupported state.");
  }
  return {
    canonicalTopic: { id: row.topic_id, slug: row.topic_slug },
    createdAt: new Date(row.created_at),
    descriptionMarkdown: row.description ?? "",
    id: row.community_id,
    kind: "topic",
    name: row.name,
    postingPolicy: {
      allowedContent: row.allowed_content,
      maxPostsPerHour: row.max_posts_per_hour,
      repliesOpen: row.replies_open,
      requiresSources: row.requires_sources,
    },
    slug: row.community_slug,
    state: row.status,
    updatedAt: new Date(row.updated_at),
    version: positiveVersion(row.version),
  };
}

function snapshotMutation(mutation: TopicCommunityMutation): StoredMutationSnapshot {
  return {
    action: {
      ...mutation.action,
      occurredAt: mutation.action.occurredAt.toISOString(),
    },
    community: {
      ...mutation.community,
      createdAt: mutation.community.createdAt.toISOString(),
      updatedAt: mutation.community.updatedAt.toISOString(),
    },
  };
}

function restoreMutation(value: unknown): TopicCommunityMutation {
  const snapshot = value as StoredMutationSnapshot;
  if (
    !isPlainRecord(snapshot) ||
    !isPlainRecord(snapshot.action) ||
    !isPlainRecord(snapshot.community)
  ) {
    throw new Error("Topic-community replay snapshot is invalid.");
  }
  return {
    action: {
      ...snapshot.action,
      occurredAt: new Date(snapshot.action.occurredAt),
    },
    community: {
      ...snapshot.community,
      createdAt: new Date(snapshot.community.createdAt),
      updatedAt: new Date(snapshot.community.updatedAt),
    },
    replayed: true,
  };
}

export class PostgresTopicCommunityManagementService implements TopicCommunityManagementService {
  readonly #idFactory: () => string;
  readonly #sql: PostgresClient;

  constructor(
    sql: PostgresClient,
    options: { idFactory?: (() => string) | undefined } = {},
  ) {
    this.#sql = sql;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async checkReady(): Promise<void> {
    const rows = await this.#sql<{ ready: boolean }[]>`
      select
        exists (
          select 1
          from system.schema_migrations
          where version = '000023'
            and name = 'admin_topic_community_v1'
            and checksum = ${TOPIC_COMMUNITY_ADMIN_MIGRATION_CHECKSUM}
        )
        and to_regclass('platform.topic_community_admin_actions') is not null
        and to_regprocedure(
          'platform.validate_topic_community_admin_action_provenance()'
        ) is not null
        as ready
    `;
    if (rows.length !== 1 || rows[0]?.ready !== true) {
      throw new TopicCommunityManagementError("SCHEMA_NOT_READY");
    }
  }

  async create(
    context: AdminTopicCommunityContext,
    input: CreateTopicCommunityInput,
  ): Promise<TopicCommunityMutation> {
    const admin = validateContext(context);
    const slug =
      typeof input.slug === "string" ? input.slug.normalize("NFC").toLowerCase() : "";
    if (!SLUG_PATTERN.test(slug)) {
      throw new TopicCommunityManagementError("VALIDATION_ERROR");
    }
    const name = normalizeText(input.name, 120);
    const description = normalizeDescription(input.descriptionMarkdown) ?? "";
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const digest = digestRequest({ description, name, operation: "create", slug });

    try {
      return await this.#sql.begin(async (transaction) => {
        const effective = await this.#revalidateAdmin(transaction, admin);
        await this.#lockIdempotency(transaction, admin.adminId, idempotencyKey);
        const replay = await this.#findReplay(
          transaction,
          admin.adminId,
          idempotencyKey,
          digest,
        );
        if (replay) return replay;

        const actionId = this.#newId();
        const communityId = this.#newId();
        const topicId = this.#newId();

        await transaction`
          insert into platform.topics (id, slug, name, description)
          values (${topicId}, ${slug}, ${name}, ${description || null})
        `;
        const inserted = await transaction<CommunityRow[]>`
          with community_insert as (
            insert into platform.communities (
              id, slug, name, description, kind
            )
            values (
              ${communityId}, ${slug}, ${name}, ${description || null}, 'topic'
            )
            returning *
          ),
          mapping_insert as (
            insert into platform.community_topics (community_id, topic_id)
            values (${communityId}, ${topicId})
          )
          select
            community.id::text as community_id,
            community.slug::text as community_slug,
            community.name,
            community.description,
            community.status,
            community.version::text,
            community.created_at,
            community.updated_at,
            topic.id::text as topic_id,
            topic.slug::text as topic_slug,
            array(
              select jsonb_array_elements_text(
                community.posting_rules -> 'allowed_content'
              )
            ) as allowed_content,
            (community.posting_rules ->> 'max_posts_per_hour')::integer
              as max_posts_per_hour,
            (community.posting_rules ->> 'requires_sources')::boolean
              as requires_sources,
            (community.posting_rules ->> 'replies_open')::boolean
              as replies_open
          from community_insert as community
          join platform.topics as topic on topic.id = ${topicId}
        `;
        const community = inserted[0] ? rowToView(inserted[0]) : null;
        if (!community) throw new Error("Topic community insert returned no row.");
        const occurredAt = community.createdAt;
        const mutation = this.#mutation(
          "create",
          actionId,
          admin.adminId,
          null,
          community,
          occurredAt,
        );
        await this.#recordMutation(
          transaction,
          admin,
          effective,
          mutation,
          idempotencyKey,
          digest,
          null,
        );
        return mutation;
      });
    } catch (error) {
      if (isPlainRecord(error) && error.code === "23505") {
        throw new TopicCommunityManagementError("TOPIC_COMMUNITY_CONFLICT", {
          cause: error,
        });
      }
      throw this.#asUnavailable(error);
    }
  }

  async update(
    context: AdminTopicCommunityContext,
    input: UpdateTopicCommunityInput,
  ): Promise<TopicCommunityMutation> {
    const admin = validateContext(context);
    const communityId = normalizeUuid(input.communityId);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new TopicCommunityManagementError("VALIDATION_ERROR");
    }
    const hasName = Object.prototype.hasOwnProperty.call(input, "name");
    const hasDescription = Object.prototype.hasOwnProperty.call(
      input,
      "descriptionMarkdown",
    );
    const name = hasName ? normalizeText(input.name as string, 120) : undefined;
    const description = hasDescription
      ? (normalizeDescription(input.descriptionMarkdown) ?? "")
      : undefined;
    if (!hasName && !hasDescription && input.state !== "archived") {
      throw new TopicCommunityManagementError("VALIDATION_ERROR");
    }
    if (input.state !== undefined && input.state !== "archived") {
      throw new TopicCommunityManagementError("VALIDATION_ERROR");
    }
    const digest = digestRequest({
      communityId,
      description,
      expectedVersion: input.expectedVersion,
      name,
      operation: "update",
      state: input.state,
    });

    try {
      return await this.#sql.begin(async (transaction) => {
        const effective = await this.#revalidateAdmin(transaction, admin);
        await this.#lockIdempotency(transaction, admin.adminId, idempotencyKey);
        const replay = await this.#findReplay(
          transaction,
          admin.adminId,
          idempotencyKey,
          digest,
        );
        if (replay) return replay;

        const currentRows = await this.#selectCommunity(transaction, communityId, true);
        const current = currentRows[0] ? rowToView(currentRows[0]) : null;
        if (!current) {
          throw new TopicCommunityManagementError("TOPIC_COMMUNITY_NOT_FOUND");
        }
        if (current.state === "archived") {
          throw new TopicCommunityManagementError("TOPIC_COMMUNITY_ARCHIVED");
        }
        if (current.version !== input.expectedVersion) {
          throw new TopicCommunityManagementError("COMMUNITY_VERSION_CONFLICT", {
            currentVersion: current.version,
          });
        }

        const action = input.state === "archived" ? "archive" : "update";
        const finalName = name ?? current.name;
        const finalDescription = description ?? current.descriptionMarkdown;
        await transaction`
          update platform.topics as topic
          set name = ${finalName},
              description = ${finalDescription || null},
              updated_at = clock_timestamp()
          from platform.community_topics as mapping
          where mapping.community_id = ${communityId}
            and mapping.topic_id = topic.id
            and mapping.is_primary
        `;
        await transaction`
          update platform.communities
          set name = ${finalName},
              description = ${finalDescription || null},
              status = ${action === "archive" ? "archived" : "active"},
              version = version + 1
          where id = ${communityId}
        `;
        const updatedRows = await this.#selectCommunity(transaction, communityId, false);
        const community = updatedRows[0] ? rowToView(updatedRows[0]) : null;
        if (!community) throw new Error("Topic community update returned no row.");
        const mutation = this.#mutation(
          action,
          this.#newId(),
          admin.adminId,
          current.version,
          community,
          community.updatedAt,
        );
        await this.#recordMutation(
          transaction,
          admin,
          effective,
          mutation,
          idempotencyKey,
          digest,
          current,
        );
        return mutation;
      });
    } catch (error) {
      throw this.#asUnavailable(error);
    }
  }

  #newId(): string {
    const value = this.#idFactory().toLowerCase();
    if (!UUID_PATTERN.test(value)) throw new Error("UUID factory returned invalid data.");
    return value;
  }

  #mutation(
    action: "create" | "update" | "archive",
    actionId: string,
    adminId: string,
    beforeVersion: number | null,
    community: TopicCommunityView,
    occurredAt: Date,
  ): TopicCommunityMutation {
    return {
      action: {
        action,
        actionId,
        adminId,
        communityVersionAfter: community.version,
        communityVersionBefore: beforeVersion,
        occurredAt,
        permissionUsed: "community:manage",
      },
      community,
      replayed: false,
    };
  }

  async #recordMutation(
    transaction: TransactionSql,
    admin: AdminTopicCommunityContext,
    effective: EffectiveAuthorization,
    mutation: TopicCommunityMutation,
    idempotencyKey: string,
    digest: Buffer,
    before: TopicCommunityView | null,
  ): Promise<void> {
    const { action, community } = mutation;
    const authorizationSnapshot = {
      permission: "community:manage",
      permissions: effective.permissions,
      roles: effective.roles,
    };
    const beforeState =
      before === null
        ? null
        : {
            community_id: before.id,
            description_markdown: before.descriptionMarkdown,
            name: before.name,
            state: before.state,
            version: before.version,
          };
    const afterState = {
      community_id: community.id,
      description_markdown: community.descriptionMarkdown,
      name: community.name,
      state: community.state,
      version: community.version,
    };
    const outbox = await appendOutboxEvent(transaction, {
      aggregateId: community.id,
      aggregateType: "community",
      eventType: `community.topic_${action.action === "create" ? "created" : action.action === "update" ? "updated" : "archived"}`,
      eventVersion: 1,
      occurredAt: action.occurredAt,
      payload: {
        action_id: action.actionId,
        community_id: community.id,
        community_slug: community.slug,
        community_version: community.version,
        topic_id: community.canonicalTopic.id,
      },
    });
    const actionLogId = this.#newId();
    await transaction`
      insert into platform.action_logs (
        id, event_class, occurred_at, actor_id, actor_kind, owner_id,
        agent_id, credential_id, admin_id, channel, approval_method,
        approved_by_owner_id, authentication_assurance,
        authorization_snapshot, action, target_type, target_id, decision,
        outcome, error_code, retry_count, outbox_event_id, policy_version,
        request_id, security_subject_digest, before_state, after_state,
        reason_code
      )
      values (
        ${actionLogId}, 'governance', ${action.occurredAt}, null, null, null,
        null, null, ${admin.adminId}, 'admin_web', 'admin_override',
        null, 'workforce_oidc', ${transaction.json(authorizationSnapshot)},
        ${`community.topic_${action.action}`}, 'community', ${community.id},
        'allow', 'succeeded', null, 0, ${outbox.id}, null,
        ${admin.requestId}, null,
        ${beforeState === null ? null : transaction.json(beforeState)},
        ${transaction.json(afterState)},
        ${`topic_community_${action.action === "create" ? "created" : action.action === "update" ? "updated" : "archived"}`}
      )
    `;
    await transaction`
      insert into platform.topic_community_admin_actions (
        id, admin_id, permission_used, action, community_id,
        community_version_before, community_version_after, idempotency_key,
        request_digest, request_id, authorization_snapshot, before_state,
        after_state, response_snapshot, action_log_id, outbox_event_id,
        occurred_at
      )
      values (
        ${action.actionId}, ${admin.adminId}, 'community:manage',
        ${action.action}, ${community.id}, ${action.communityVersionBefore},
        ${action.communityVersionAfter}, ${idempotencyKey}, ${digest},
        ${admin.requestId}, ${transaction.json(authorizationSnapshot)},
        ${beforeState === null ? null : transaction.json(beforeState)},
        ${transaction.json(afterState)},
        ${transaction.json(
          JSON.parse(JSON.stringify(snapshotMutation(mutation))) as postgres.JSONValue,
        )},
        ${actionLogId}, ${outbox.id}, ${action.occurredAt}
      )
    `;
  }

  async #revalidateAdmin(
    transaction: TransactionSql,
    context: AdminTopicCommunityContext,
  ): Promise<EffectiveAuthorization> {
    const rows = await transaction<AdminRbacRow[]>`
      select
        admin.id::text as admin_id,
        role.key as role_key,
        role_permission.permission
      from platform.admins as admin
      join platform.admin_assignments as assignment
        on assignment.admin_id = admin.id
       and assignment.granted_at <= clock_timestamp()
       and assignment.revoked_at is null
       and (
         assignment.expires_at is null
         or assignment.expires_at > clock_timestamp()
       )
      join platform.admin_roles as role
        on role.id = assignment.role_id
       and role.status = 'active'
      join platform.admin_role_permissions as role_permission
        on role_permission.role_id = role.id
      where admin.id = ${context.adminId}
        and admin.status = 'active'
    `;
    if (
      rows.length === 0 ||
      rows.some(
        (row) =>
          row.admin_id !== context.adminId ||
          !ROLE_PATTERN.test(row.role_key) ||
          !ADMIN_PERMISSION_SET.has(row.permission),
      )
    ) {
      throw new TopicCommunityManagementError("ADMIN_PERMISSION_REQUIRED");
    }
    const permissions = sortedUnique(
      rows.map((row) => row.permission as AdminPermission),
    );
    if (!permissions.includes("community:manage")) {
      throw new TopicCommunityManagementError("ADMIN_PERMISSION_REQUIRED");
    }
    return { permissions, roles: sortedUnique(rows.map((row) => row.role_key)) };
  }

  async #lockIdempotency(
    transaction: TransactionSql,
    adminId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await transaction`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'alphanet:topic-community-admin:'
            || pg_catalog.octet_length(${adminId}::text)::text
            || ':' || ${adminId}::text
            || ':' || ${idempotencyKey}::text,
          0
        )
      )
    `;
  }

  async #findReplay(
    transaction: TransactionSql,
    adminId: string,
    idempotencyKey: string,
    digest: Buffer,
  ): Promise<TopicCommunityMutation | null> {
    const rows = await transaction<ReplayRow[]>`
      select request_digest, response_snapshot
      from platform.topic_community_admin_actions
      where admin_id = ${adminId}
        and idempotency_key = ${idempotencyKey}
    `;
    const row = rows[0];
    if (!row) return null;
    if (
      rows.length !== 1 ||
      row.request_digest.length !== digest.length ||
      !timingSafeEqual(row.request_digest, digest)
    ) {
      throw new TopicCommunityManagementError("IDEMPOTENCY_CONFLICT");
    }
    return restoreMutation(row.response_snapshot);
  }

  async #selectCommunity(
    transaction: TransactionSql,
    communityId: string,
    forUpdate: boolean,
  ): Promise<CommunityRow[]> {
    const lock = forUpdate ? transaction`for update of community` : transaction``;
    return transaction<CommunityRow[]>`
      select
        community.id::text as community_id,
        community.slug::text as community_slug,
        community.name,
        community.description,
        community.status,
        community.version::text,
        community.created_at,
        community.updated_at,
        topic.id::text as topic_id,
        topic.slug::text as topic_slug,
        array(
          select jsonb_array_elements_text(
            community.posting_rules -> 'allowed_content'
          )
        ) as allowed_content,
        (community.posting_rules ->> 'max_posts_per_hour')::integer
          as max_posts_per_hour,
        (community.posting_rules ->> 'requires_sources')::boolean
          as requires_sources,
        (community.posting_rules ->> 'replies_open')::boolean
          as replies_open
      from platform.communities as community
      join platform.community_topics as mapping
        on mapping.community_id = community.id
       and mapping.is_primary
      join platform.topics as topic
        on topic.id = mapping.topic_id
       and topic.deleted_at is null
      where community.id = ${communityId}
        and community.kind = 'topic'
        and community.deleted_at is null
      ${lock}
    `;
  }

  #asUnavailable(error: unknown): TopicCommunityManagementError {
    if (error instanceof TopicCommunityManagementError) return error;
    return new TopicCommunityManagementError("TOPIC_COMMUNITY_UNAVAILABLE", {
      cause: error,
    });
  }
}
