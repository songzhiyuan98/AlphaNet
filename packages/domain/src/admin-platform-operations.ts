import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { appendOutboxEvent, type PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import {
  ADMIN_PERMISSIONS,
  type AdminMfaEvidence,
  type AdminPermission,
} from "./content-moderation.js";
import { PLATFORM_EMERGENCY_WRITE_CONTROL_MIGRATION_CHECKSUM } from "./schema-migrations.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROLE_PATTERN = /^[a-z][a-z0-9_.-]{0,79}$/u;
const PERMISSION_SET = new Set<string>(ADMIN_PERMISSIONS);
const PAUSE_REASONS = [
  "security_incident",
  "integrity_incident",
  "infrastructure_degradation",
  "emergency_maintenance",
] as const;
const RESUME_REASONS = [
  "incident_resolved",
  "integrity_restored",
  "infrastructure_recovered",
  "maintenance_completed",
  "false_positive_corrected",
] as const;

type TransactionSql = postgres.TransactionSql;

export type CommunityWriteControlMode = "open" | "paused";
export type CommunityWritePauseReason = (typeof PAUSE_REASONS)[number];
export type CommunityWriteResumeReason = (typeof RESUME_REASONS)[number];
export type CommunityWriteControlAction =
  "pause_community_writes" | "resume_community_writes";

export interface CommunityWriteControlView {
  mode: CommunityWriteControlMode;
  pauseReasonCode: CommunityWritePauseReason | null;
  pausedAt: Date | null;
  resumeCondition: string | null;
  updatedAt: Date;
  updatedByAdminId: string | null;
  version: number;
}

interface CommunityWriteControlRow {
  mode: string;
  pause_reason_code: string | null;
  paused_at: Date | null;
  resume_condition: string | null;
  updated_at: Date;
  updated_by_admin_id: string | null;
  version: string;
}

function positiveVersion(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error("Invalid community-write control version.");
  }
  return result;
}

function controlView(row: CommunityWriteControlRow): CommunityWriteControlView {
  if (row.mode !== "open" && row.mode !== "paused") {
    throw new Error("Invalid community-write control mode.");
  }
  const reason = row.pause_reason_code as CommunityWritePauseReason | null;
  if (reason !== null && !PAUSE_REASONS.includes(reason)) {
    throw new Error("Invalid community-write pause reason.");
  }
  const result: CommunityWriteControlView = {
    mode: row.mode,
    pauseReasonCode: reason,
    pausedAt: row.paused_at === null ? null : new Date(row.paused_at),
    resumeCondition: row.resume_condition,
    updatedAt: new Date(row.updated_at),
    updatedByAdminId: row.updated_by_admin_id,
    version: positiveVersion(row.version),
  };
  if (
    Number.isNaN(result.updatedAt.valueOf()) ||
    (result.pausedAt !== null && Number.isNaN(result.pausedAt.valueOf())) ||
    (result.updatedByAdminId !== null && !UUID_PATTERN.test(result.updatedByAdminId)) ||
    (result.mode === "open" &&
      (result.pauseReasonCode !== null ||
        result.pausedAt !== null ||
        result.resumeCondition !== null)) ||
    (result.mode === "paused" &&
      (result.pauseReasonCode === null ||
        result.pausedAt === null ||
        result.resumeCondition === null ||
        result.updatedByAdminId === null))
  ) {
    throw new Error("Inconsistent community-write control state.");
  }
  return result;
}

/**
 * Reads the live platform write gate inside a caller-owned mutation
 * transaction. Callers intentionally decide how to project a paused state into
 * their own public error contract.
 */
export async function readCommunityWriteControl(
  transaction: TransactionSql,
): Promise<CommunityWriteControlView> {
  const rows = await transaction<CommunityWriteControlRow[]>`
    select
      mode,
      version::text,
      pause_reason_code,
      paused_at,
      resume_condition,
      updated_by_admin_id::text,
      updated_at
    from platform.community_write_controls
    where id = true
  `;
  if (rows.length !== 1 || !rows[0]) {
    throw new Error("Community-write control is unavailable.");
  }
  return controlView(rows[0]);
}

export interface AdminPlatformOperationsContext {
  adminId: string;
  authenticationAssurance: "workforce_oidc";
  mfa: AdminMfaEvidence;
  permission: "platform:operate";
  permissions: readonly AdminPermission[];
  requestId: string;
  roles: readonly string[];
}

export type AdminCommunityWriteControlActionInput =
  | {
      action: "pause_community_writes";
      expectedVersion: number;
      idempotencyKey: string;
      reasonCode: CommunityWritePauseReason;
      resumeCondition: string;
    }
  | {
      action: "resume_community_writes";
      expectedVersion: number;
      idempotencyKey: string;
      reasonCode: CommunityWriteResumeReason;
    };

export interface AdminCommunityWriteControlMutation {
  action: {
    action: CommunityWriteControlAction;
    actionId: string;
    adminId: string;
    occurredAt: Date;
    permissionUsed: "platform:operate";
    reasonCode: CommunityWritePauseReason | CommunityWriteResumeReason;
    versionAfter: number;
    versionBefore: number;
  };
  control: CommunityWriteControlView;
  replayed: boolean;
}

export interface AdminPlatformOperationsService {
  actOnCommunityWrites(
    context: AdminPlatformOperationsContext,
    input: AdminCommunityWriteControlActionInput,
  ): Promise<AdminCommunityWriteControlMutation>;
  checkReady(): Promise<void>;
  getCommunityWriteControl(context: AdminPlatformOperationsContext): Promise<{
    canOperatePlatform: boolean;
    control: CommunityWriteControlView;
  }>;
}

export type AdminPlatformOperationsErrorCode =
  | "ADMIN_AUTHENTICATION_REQUIRED"
  | "ADMIN_PERMISSION_REQUIRED"
  | "CONTROL_STATE_CONFLICT"
  | "CONTROL_VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "PLATFORM_OPERATIONS_UNAVAILABLE"
  | "SCHEMA_NOT_READY"
  | "VALIDATION_ERROR";

const ERRORS = {
  ADMIN_AUTHENTICATION_REQUIRED: [
    401,
    false,
    "Administrator authentication is required.",
  ],
  ADMIN_PERMISSION_REQUIRED: [403, false, "Platform operation permission is missing."],
  CONTROL_STATE_CONFLICT: [
    409,
    false,
    "Community-write control cannot accept this action.",
  ],
  CONTROL_VERSION_CONFLICT: [409, false, "Community-write control version changed."],
  IDEMPOTENCY_CONFLICT: [409, false, "Idempotency key was already used."],
  PLATFORM_OPERATIONS_UNAVAILABLE: [
    503,
    true,
    "Platform operations are temporarily unavailable.",
  ],
  SCHEMA_NOT_READY: [503, true, "Platform operations schema is not ready."],
  VALIDATION_ERROR: [422, false, "Platform operation request is invalid."],
} as const satisfies Record<
  AdminPlatformOperationsErrorCode,
  readonly [number, boolean, string]
>;

export class AdminPlatformOperationsError extends Error {
  readonly code: AdminPlatformOperationsErrorCode;
  readonly currentVersion: number | null;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    code: AdminPlatformOperationsErrorCode,
    options: { cause?: unknown; currentVersion?: number } = {},
  ) {
    const [statusCode, retryable, message] = ERRORS[code];
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AdminPlatformOperationsError";
    this.code = code;
    this.currentVersion = options.currentVersion ?? null;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

interface AdminRow {
  admin_id: string;
  permission: string;
  role_key: string;
}

interface EffectiveAuthorization {
  permissions: AdminPermission[];
  roles: string[];
}

interface ReplayRow {
  request_digest: Buffer;
  response_snapshot: unknown;
}

function sorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): Buffer {
  return createHash("sha256").update(stable(value), "utf8").digest();
}

function validPermissionList(value: unknown): value is readonly AdminPermission[] {
  return (
    Array.isArray(value) &&
    value.length <= ADMIN_PERMISSIONS.length &&
    value.every(
      (permission) => typeof permission === "string" && PERMISSION_SET.has(permission),
    ) &&
    new Set(value).size === value.length
  );
}

function validRoleList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every((role) => typeof role === "string" && ROLE_PATTERN.test(role)) &&
    new Set(value).size === value.length
  );
}

function normalizedContext(
  context: AdminPlatformOperationsContext,
): AdminPlatformOperationsContext {
  if (
    context.authenticationAssurance !== "workforce_oidc" ||
    context.permission !== "platform:operate" ||
    !UUID_PATTERN.test(context.adminId) ||
    typeof context.requestId !== "string" ||
    context.requestId.trim().length < 1 ||
    context.requestId.length > 200 ||
    !validPermissionList(context.permissions) ||
    !validRoleList(context.roles) ||
    typeof context.mfa?.amrMfa !== "boolean" ||
    (context.mfa.matchedAcr !== null && typeof context.mfa.matchedAcr !== "string") ||
    !["acr", "amr_mfa", "acr_and_amr_mfa"].includes(context.mfa.method)
  ) {
    throw new AdminPlatformOperationsError("ADMIN_AUTHENTICATION_REQUIRED");
  }
  return {
    ...context,
    adminId: context.adminId.toLowerCase(),
    requestId: context.requestId.trim(),
    permissions: sorted(context.permissions),
    roles: sorted(context.roles),
  };
}

function normalizedCommand(
  input: AdminCommunityWriteControlActionInput,
): AdminCommunityWriteControlActionInput {
  const idempotencyKey = input.idempotencyKey.trim();
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    idempotencyKey.length < 1 ||
    idempotencyKey.length > 200 ||
    /[\p{Cc},]/u.test(idempotencyKey)
  ) {
    throw new AdminPlatformOperationsError("VALIDATION_ERROR");
  }
  if (input.action === "pause_community_writes") {
    const resumeCondition = input.resumeCondition.trim();
    if (
      !PAUSE_REASONS.includes(input.reasonCode) ||
      resumeCondition.length < 1 ||
      resumeCondition.length > 1_000 ||
      /\p{Cc}/u.test(resumeCondition)
    ) {
      throw new AdminPlatformOperationsError("VALIDATION_ERROR");
    }
    return { ...input, idempotencyKey, resumeCondition };
  }
  if (
    input.action !== "resume_community_writes" ||
    !RESUME_REASONS.includes(input.reasonCode)
  ) {
    throw new AdminPlatformOperationsError("VALIDATION_ERROR");
  }
  return { ...input, idempotencyKey };
}

function snapshotControl(control: CommunityWriteControlView): Record<string, unknown> {
  return {
    ...control,
    pausedAt: control.pausedAt?.toISOString() ?? null,
    updatedAt: control.updatedAt.toISOString(),
  };
}

function snapshotMutation(
  mutation: AdminCommunityWriteControlMutation,
): Record<string, unknown> {
  return {
    action: {
      ...mutation.action,
      occurredAt: mutation.action.occurredAt.toISOString(),
    },
    control: snapshotControl(mutation.control),
  };
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function restoreMutation(value: unknown): AdminCommunityWriteControlMutation {
  if (!plain(value) || !plain(value.action) || !plain(value.control)) {
    throw new AdminPlatformOperationsError("IDEMPOTENCY_CONFLICT");
  }
  const occurredAtValue = value.action.occurredAt;
  const updatedAtValue = value.control.updatedAt;
  const pausedAtValue = value.control.pausedAt;
  if (
    typeof occurredAtValue !== "string" ||
    typeof updatedAtValue !== "string" ||
    (pausedAtValue !== null && typeof pausedAtValue !== "string")
  ) {
    throw new AdminPlatformOperationsError("IDEMPOTENCY_CONFLICT");
  }
  const occurredAt = new Date(occurredAtValue);
  const updatedAt = new Date(updatedAtValue);
  const pausedAt = pausedAtValue === null ? null : new Date(pausedAtValue);
  if (
    Number.isNaN(occurredAt.valueOf()) ||
    Number.isNaN(updatedAt.valueOf()) ||
    (pausedAt !== null && Number.isNaN(pausedAt.valueOf()))
  ) {
    throw new AdminPlatformOperationsError("IDEMPOTENCY_CONFLICT");
  }
  return {
    action: {
      ...(value.action as unknown as AdminCommunityWriteControlMutation["action"]),
      occurredAt,
    },
    control: {
      ...(value.control as unknown as CommunityWriteControlView),
      pausedAt,
      updatedAt,
    },
    replayed: true,
  };
}

export class PostgresAdminPlatformOperationsService implements AdminPlatformOperationsService {
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
    try {
      const rows = await this.#sql<{ ready: boolean }[]>`
        select
          exists (
            select 1
            from system.schema_migrations
            where version = '000026'
              and checksum =
                ${PLATFORM_EMERGENCY_WRITE_CONTROL_MIGRATION_CHECKSUM}
          )
          and to_regclass('platform.community_write_controls') is not null
          and to_regclass(
            'platform.community_write_control_admin_actions'
          ) is not null
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid =
              'platform.community_write_control_admin_actions'::regclass
              and tgname =
                'community_write_control_actions_validate_provenance'
              and not tgisinternal
          )
          and exists (
            select 1
            from platform.admin_role_permissions as role_permission
            join platform.admin_roles as role
              on role.id = role_permission.role_id
            where role.key = 'security_administrator'
              and role.status = 'active'
              and role_permission.permission = 'platform:operate'
          ) as ready
      `;
      if (rows[0]?.ready !== true) {
        throw new AdminPlatformOperationsError("SCHEMA_NOT_READY");
      }
    } catch (error) {
      if (error instanceof AdminPlatformOperationsError) throw error;
      throw new AdminPlatformOperationsError("SCHEMA_NOT_READY", { cause: error });
    }
  }

  async getCommunityWriteControl(
    inputContext: AdminPlatformOperationsContext,
  ): Promise<{ canOperatePlatform: boolean; control: CommunityWriteControlView }> {
    const context = normalizedContext(inputContext);
    try {
      return await this.#sql.begin(
        "isolation level repeatable read",
        async (transaction) => {
          await transaction`set local statement_timeout = '10s'`;
          const authorization = await this.#authorize(transaction, context);
          return {
            canOperatePlatform: authorization.permissions.includes("platform:operate"),
            control: await readCommunityWriteControl(transaction),
          };
        },
      );
    } catch (error) {
      throw this.#unavailable(error);
    }
  }

  async actOnCommunityWrites(
    inputContext: AdminPlatformOperationsContext,
    input: AdminCommunityWriteControlActionInput,
  ): Promise<AdminCommunityWriteControlMutation> {
    const context = normalizedContext(inputContext);
    const command = normalizedCommand(input);
    const requestDigest = digest(
      command.action === "pause_community_writes"
        ? {
            action: command.action,
            expectedVersion: command.expectedVersion,
            reasonCode: command.reasonCode,
            resumeCondition: command.resumeCondition,
          }
        : {
            action: command.action,
            expectedVersion: command.expectedVersion,
            reasonCode: command.reasonCode,
          },
    );
    try {
      return await this.#sql.begin(async (transaction) => {
        await transaction`set local statement_timeout = '10s'`;
        const authorization = await this.#authorize(transaction, context);
        await this.#lockKey(transaction, context.adminId, command.idempotencyKey);
        const replay = await this.#findReplay(
          transaction,
          context.adminId,
          command.idempotencyKey,
          requestDigest,
        );
        if (replay !== null) return restoreMutation(replay);

        const rows = await transaction<CommunityWriteControlRow[]>`
          select
            mode,
            version::text,
            pause_reason_code,
            paused_at,
            resume_condition,
            updated_by_admin_id::text,
            updated_at
          from platform.community_write_controls
          where id = true
          for update
        `;
        if (rows.length !== 1 || !rows[0]) {
          throw new AdminPlatformOperationsError("SCHEMA_NOT_READY");
        }
        const before = controlView(rows[0]);
        if (before.version !== command.expectedVersion) {
          throw new AdminPlatformOperationsError("CONTROL_VERSION_CONFLICT", {
            currentVersion: before.version,
          });
        }
        if (
          (command.action === "pause_community_writes" && before.mode !== "open") ||
          (command.action === "resume_community_writes" && before.mode !== "paused")
        ) {
          throw new AdminPlatformOperationsError("CONTROL_STATE_CONFLICT");
        }

        if (command.action === "pause_community_writes") {
          await transaction`
            update platform.community_write_controls
            set mode = 'paused',
                pause_reason_code = ${command.reasonCode},
                resume_condition = ${command.resumeCondition},
                updated_by_admin_id = ${context.adminId}
            where id = true
          `;
        } else {
          await transaction`
            update platform.community_write_controls
            set mode = 'open',
                updated_by_admin_id = ${context.adminId}
            where id = true
          `;
        }
        const control = await readCommunityWriteControl(transaction);
        const mutation: AdminCommunityWriteControlMutation = {
          action: {
            action: command.action,
            actionId: this.#newId(),
            adminId: context.adminId,
            occurredAt: control.updatedAt,
            permissionUsed: "platform:operate",
            reasonCode: command.reasonCode,
            versionAfter: control.version,
            versionBefore: before.version,
          },
          control,
          replayed: false,
        };
        await this.#record(
          transaction,
          context,
          authorization,
          command,
          before,
          mutation,
          requestDigest,
        );
        return mutation;
      });
    } catch (error) {
      throw this.#unavailable(error);
    }
  }

  #newId(): string {
    const id = this.#idFactory().toLowerCase();
    if (!UUID_PATTERN.test(id)) {
      throw new Error("UUID factory returned invalid data.");
    }
    return id;
  }

  #unavailable(error: unknown): AdminPlatformOperationsError {
    return error instanceof AdminPlatformOperationsError
      ? error
      : new AdminPlatformOperationsError("PLATFORM_OPERATIONS_UNAVAILABLE", {
          cause: error,
        });
  }

  async #authorize(
    transaction: TransactionSql,
    context: AdminPlatformOperationsContext,
  ): Promise<EffectiveAuthorization> {
    const rows = await transaction<AdminRow[]>`
      select
        administrator.id::text as admin_id,
        role.key as role_key,
        role_permission.permission
      from platform.admins as administrator
      join platform.admin_assignments as assignment
        on assignment.admin_id = administrator.id
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
      where administrator.id = ${context.adminId}
        and administrator.status = 'active'
    `;
    if (
      rows.length === 0 ||
      rows.some(
        (row) =>
          row.admin_id !== context.adminId ||
          !ROLE_PATTERN.test(row.role_key) ||
          !PERMISSION_SET.has(row.permission),
      )
    ) {
      throw new AdminPlatformOperationsError("ADMIN_PERMISSION_REQUIRED");
    }
    const permissions = sorted(rows.map((row) => row.permission as AdminPermission));
    if (!permissions.includes("platform:operate")) {
      throw new AdminPlatformOperationsError("ADMIN_PERMISSION_REQUIRED");
    }
    return {
      permissions,
      roles: sorted(rows.map((row) => row.role_key)),
    };
  }

  async #lockKey(
    transaction: TransactionSql,
    adminId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await transaction`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'alphanet:platform-operation:'
            || pg_catalog.octet_length(${adminId}::text)::text
            || ':' || ${adminId}::text || ':' || ${idempotencyKey}::text,
          0
        )
      )
    `;
  }

  async #findReplay(
    transaction: TransactionSql,
    adminId: string,
    idempotencyKey: string,
    requestDigest: Buffer,
  ): Promise<Record<string, unknown> | null> {
    const rows = await transaction<ReplayRow[]>`
      select request_digest, response_snapshot
      from platform.community_write_control_admin_actions
      where admin_id = ${adminId}
        and idempotency_key = ${idempotencyKey}
    `;
    const row = rows[0];
    if (!row) return null;
    if (
      rows.length !== 1 ||
      row.request_digest.length !== requestDigest.length ||
      !timingSafeEqual(row.request_digest, requestDigest) ||
      !plain(row.response_snapshot)
    ) {
      throw new AdminPlatformOperationsError("IDEMPOTENCY_CONFLICT");
    }
    return row.response_snapshot;
  }

  async #record(
    transaction: TransactionSql,
    context: AdminPlatformOperationsContext,
    authorization: EffectiveAuthorization,
    command: AdminCommunityWriteControlActionInput,
    before: CommunityWriteControlView,
    mutation: AdminCommunityWriteControlMutation,
    requestDigest: Buffer,
  ): Promise<void> {
    const authorizationSnapshot = {
      permission: "platform:operate",
      permissions: authorization.permissions,
      roles: authorization.roles,
    };
    const beforeState = {
      mode: before.mode,
      pause_reason_code: before.pauseReasonCode,
      version: before.version,
    };
    const afterState = {
      mode: mutation.control.mode,
      pause_reason_code: mutation.control.pauseReasonCode,
      version: mutation.control.version,
    };
    const paused = command.action === "pause_community_writes";
    const outbox = await appendOutboxEvent(transaction, {
      aggregateId: "singleton",
      aggregateType: "community_write_control",
      eventType: paused
        ? "platform.community_writes_paused"
        : "platform.community_writes_resumed",
      eventVersion: 1,
      occurredAt: mutation.action.occurredAt,
      payload: {
        action_id: mutation.action.actionId,
        mode: mutation.control.mode,
        reason_code: mutation.action.reasonCode,
        version: mutation.control.version,
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
        ${actionLogId}, 'governance', ${mutation.action.occurredAt}, null, null,
        null, null, null, ${context.adminId}, 'admin_web', 'admin_override',
        null, 'workforce_oidc', ${transaction.json(authorizationSnapshot)},
        ${
          paused ? "platform.community_writes.pause" : "platform.community_writes.resume"
        },
        'community_write_control', 'singleton', 'allow', 'succeeded', null, 0,
        ${outbox.id}, null, ${context.requestId}, null,
        ${transaction.json(beforeState)}, ${transaction.json(afterState)},
        ${mutation.action.reasonCode}
      )
    `;
    await transaction`
      insert into platform.community_write_control_admin_actions (
        id, admin_id, permission_used, action, reason_code, version_before,
        version_after, idempotency_key, request_digest, request_id,
        authorization_snapshot, before_state, after_state, response_snapshot,
        action_log_id, outbox_event_id, occurred_at
      )
      values (
        ${mutation.action.actionId}, ${context.adminId}, 'platform:operate',
        ${mutation.action.action}, ${mutation.action.reasonCode},
        ${mutation.action.versionBefore}, ${mutation.action.versionAfter},
        ${command.idempotencyKey}, ${requestDigest}, ${context.requestId},
        ${transaction.json(authorizationSnapshot)},
        ${transaction.json(beforeState)}, ${transaction.json(afterState)},
        ${transaction.json(
          JSON.parse(JSON.stringify(snapshotMutation(mutation))) as postgres.JSONValue,
        )},
        ${actionLogId}, ${outbox.id}, ${mutation.action.occurredAt}
      )
    `;
  }
}
