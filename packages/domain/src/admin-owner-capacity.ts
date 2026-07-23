import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { appendOutboxEvent, type PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import {
  ADMIN_PERMISSIONS,
  type AdminMfaEvidence,
  type AdminPermission,
} from "./content-moderation.js";
import { ADMIN_OWNER_CAPACITY_MIGRATION_CHECKSUM } from "./schema-migrations.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROLE_PATTERN = /^[a-z][a-z0-9_.-]{0,79}$/u;
const PERMISSION_SET = new Set<string>(ADMIN_PERMISSIONS);
const OWNER_STATUSES = [
  "pending_verification",
  "active",
  "restricted",
  "suspended",
  "closed",
] as const;
const QUOTA_REASONS = [
  "validated_operational_need",
  "research_team_expansion",
  "migration_support",
  "abuse_mitigation",
  "security_incident",
] as const;
const PAUSE_REASONS = [
  "capacity_threshold_reached",
  "automated_abuse_incident",
  "security_incident",
  "infrastructure_degradation",
] as const;
const RESUME_REASONS = [
  "capacity_available",
  "incident_resolved",
  "false_positive_corrected",
] as const;
const LIST_PURPOSE = "alphanet.admin.owner-list.v1" as const;
const HOUR_MS = 3_600_000;
const MAX_OVERRIDE_MS = 90 * 24 * HOUR_MS;

export type AdminOwnerStatus = (typeof OWNER_STATUSES)[number];
export type AdminOwnerQuotaReason = (typeof QUOTA_REASONS)[number];
export type AdminRegistrationPauseReason = (typeof PAUSE_REASONS)[number];
export type AdminRegistrationResumeReason = (typeof RESUME_REASONS)[number];
export type AdminRegistrationAction =
  "pause_registration" | "resume_registration" | "set_capacity_limits";

export interface AdminOwnerCapacityContext {
  adminId: string;
  authenticationAssurance: "workforce_oidc";
  mfa: AdminMfaEvidence;
  permission: "identity:quota_manage";
  permissions: readonly AdminPermission[];
  requestId: string;
  roles: readonly string[];
}

export interface AdminOwnerCredentialCounts {
  active: number;
  expired: number;
  revoked: number;
  total: number;
}

export interface AdminOwnerQuotaOverrideView {
  createdAt: Date;
  expiresAt: Date;
  maxActiveAgents: number;
  overrideId: string;
  reasonCode: AdminOwnerQuotaReason;
}

export interface AdminOwnerSummaryView {
  activeAgentCount: number;
  baseActiveAgentLimit: number;
  closedAt: Date | null;
  createdAt: Date;
  credentialCounts: AdminOwnerCredentialCounts;
  currentOverride: AdminOwnerQuotaOverrideView | null;
  effectiveActiveAgentLimit: number;
  emailHint: string;
  emailVerified: boolean;
  ownerId: string;
  quotaVersion: number;
  restrictedAt: Date | null;
  status: AdminOwnerStatus;
  suspendedAt: Date | null;
  totalAgentCount: number;
  updatedAt: Date;
}

export interface AdminOwnerCapacityCapabilities {
  canManageQuota: boolean;
}

export interface ListAdminOwnersInput {
  cursor?: string | null | undefined;
  limit?: number | undefined;
  query?: string | undefined;
  statuses?: readonly AdminOwnerStatus[] | undefined;
}

export interface AdminOwnerPage {
  asOf: Date;
  capabilities: AdminOwnerCapacityCapabilities;
  hasMore: boolean;
  items: AdminOwnerSummaryView[];
  limit: number;
  nextCursor: string | null;
  orderingVersion: "admin-owner-created-keyset-v1";
  snapshotId: string;
}

export type AdminOwnerQuotaActionInput =
  | {
      action: "set_override";
      expectedVersion: number;
      expiresAt: Date;
      idempotencyKey: string;
      maxActiveAgents: number;
      reasonCode: AdminOwnerQuotaReason;
    }
  | {
      action: "revoke_override";
      expectedVersion: number;
      idempotencyKey: string;
      reasonCode: AdminOwnerQuotaReason;
    };

export interface AdminOwnerQuotaMutation {
  action: {
    action: "set_override" | "revoke_override";
    actionId: string;
    adminId: string;
    occurredAt: Date;
    permissionUsed: "identity:quota_manage";
    quotaVersionAfter: number;
    quotaVersionBefore: number;
    reasonCode: AdminOwnerQuotaReason;
  };
  owner: AdminOwnerSummaryView;
  replayed: boolean;
}

export type AdminRegistrationActionInput =
  | {
      action: "pause_registration";
      expectedVersion: number;
      idempotencyKey: string;
      reasonCode: AdminRegistrationPauseReason;
      resumeCondition: string;
    }
  | {
      action: "resume_registration";
      expectedVersion: number;
      idempotencyKey: string;
      reasonCode: AdminRegistrationResumeReason;
    }
  | {
      action: "set_capacity_limits";
      activeAgentHardLimit: number;
      activeAgentOperatingTarget: number;
      expectedVersion: number;
      idempotencyKey: string;
      reasonCode: "validated_operational_need";
    };

export interface AdminRegistrationControlView {
  activeAgentCount: number;
  activeAgentHardLimit: number;
  activeAgentOperatingTarget: number;
  mode: "open" | "paused";
  pauseReasonCode: AdminRegistrationPauseReason | null;
  pausedAt: Date | null;
  resumeCondition: string | null;
  updatedAt: Date;
  version: number;
}

export interface AdminRegistrationMutation {
  action: {
    action: AdminRegistrationAction;
    actionId: string;
    adminId: string;
    occurredAt: Date;
    permissionUsed: "identity:quota_manage";
    reasonCode:
      | AdminRegistrationPauseReason
      | AdminRegistrationResumeReason
      | "validated_operational_need";
    versionAfter: number;
    versionBefore: number;
  };
  control: AdminRegistrationControlView;
  replayed: boolean;
}

export interface AdminOwnerCapacityService {
  actOnOwnerQuota(
    context: AdminOwnerCapacityContext,
    ownerId: string,
    input: AdminOwnerQuotaActionInput,
  ): Promise<AdminOwnerQuotaMutation>;
  actOnRegistration(
    context: AdminOwnerCapacityContext,
    input: AdminRegistrationActionInput,
  ): Promise<AdminRegistrationMutation>;
  checkReady(): Promise<void>;
  getOwner(
    context: AdminOwnerCapacityContext,
    ownerId: string,
  ): Promise<AdminOwnerSummaryView>;
  getRegistration(context: AdminOwnerCapacityContext): Promise<{
    capabilities: AdminOwnerCapacityCapabilities;
    control: AdminRegistrationControlView;
  }>;
  listOwners(
    context: AdminOwnerCapacityContext,
    input: ListAdminOwnersInput,
  ): Promise<AdminOwnerPage>;
}

export type AdminOwnerCapacityErrorCode =
  | "ADMIN_AUTHENTICATION_REQUIRED"
  | "ADMIN_PERMISSION_REQUIRED"
  | "CAPACITY_STATE_CONFLICT"
  | "CAPACITY_VERSION_CONFLICT"
  | "CURSOR_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "OWNER_NOT_FOUND"
  | "OWNER_QUOTA_STATE_CONFLICT"
  | "OWNER_QUOTA_VERSION_CONFLICT"
  | "SCHEMA_NOT_READY"
  | "OWNER_CAPACITY_UNAVAILABLE"
  | "VALIDATION_ERROR";

const ERRORS = {
  ADMIN_AUTHENTICATION_REQUIRED: [
    401,
    false,
    "Administrator authentication is required.",
  ],
  ADMIN_PERMISSION_REQUIRED: [403, false, "Identity capacity permission is missing."],
  CAPACITY_STATE_CONFLICT: [
    409,
    false,
    "Registration control cannot accept this action.",
  ],
  CAPACITY_VERSION_CONFLICT: [409, false, "Registration-control version changed."],
  CURSOR_INVALID: [422, false, "Owner cursor is invalid."],
  IDEMPOTENCY_CONFLICT: [409, false, "Idempotency key was already used."],
  OWNER_NOT_FOUND: [404, false, "Owner was not found."],
  OWNER_QUOTA_STATE_CONFLICT: [409, false, "Owner quota cannot accept this action."],
  OWNER_QUOTA_VERSION_CONFLICT: [409, false, "Owner quota version changed."],
  SCHEMA_NOT_READY: [503, true, "Identity capacity schema is not ready."],
  OWNER_CAPACITY_UNAVAILABLE: [
    503,
    true,
    "Identity capacity is temporarily unavailable.",
  ],
  VALIDATION_ERROR: [422, false, "Identity capacity request is invalid."],
} as const satisfies Record<
  AdminOwnerCapacityErrorCode,
  readonly [number, boolean, string]
>;

export class AdminOwnerCapacityError extends Error {
  readonly code: AdminOwnerCapacityErrorCode;
  readonly currentVersion: number | null;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    code: AdminOwnerCapacityErrorCode,
    options: { cause?: unknown; currentVersion?: number } = {},
  ) {
    const [statusCode, retryable, message] = ERRORS[code];
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AdminOwnerCapacityError";
    this.code = code;
    this.currentVersion = options.currentVersion ?? null;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

type Tx = postgres.TransactionSql;
interface AdminRow {
  admin_id: string;
  permission: string;
  role_key: string;
}
interface Effective {
  permissions: AdminPermission[];
  roles: string[];
}
interface OwnerRow {
  active_agent_count: string;
  active_credentials: string;
  base_active_agent_limit: number;
  created_at: Date;
  deleted_at: Date | null;
  effective_active_agent_limit: number;
  email: string;
  email_verified_at: Date | null;
  expired_credentials: string;
  override_created_at: Date | null;
  override_expires_at: Date | null;
  override_id: string | null;
  override_max_active_agents: number | null;
  override_reason_code: string | null;
  owner_id: string;
  quota_version: string;
  restricted_at: Date | null;
  revoked_credentials: string;
  status: string;
  suspended_at: Date | null;
  total_agent_count: string;
  total_credentials: string;
  updated_at: Date;
}
interface ControlRow {
  active_agent_count: string;
  active_agent_hard_limit: string;
  active_agent_operating_target: string;
  mode: string;
  pause_reason_code: string | null;
  paused_at: Date | null;
  resume_condition: string | null;
  updated_at: Date;
  version: string;
}
interface Filters {
  limit: number;
  query: string | null;
  statuses: AdminOwnerStatus[];
}
interface CursorEnvelope {
  asOf: string;
  filters: Filters;
  position: { createdAt: string; id: string };
  purpose: typeof LIST_PURPOSE;
  snapshotId: string;
  version: 1;
}
interface ReplayRow {
  request_digest: Buffer;
  response_snapshot: unknown;
  target_kind: string;
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
}
function digest(value: unknown): Buffer {
  return createHash("sha256").update(stable(value), "utf8").digest();
}
function uuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new AdminOwnerCapacityError("VALIDATION_ERROR");
  return value.toLowerCase();
}
function idempotency(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 200 ||
    value.includes(",") ||
    /\p{Cc}/u.test(value)
  ) {
    throw new AdminOwnerCapacityError("VALIDATION_ERROR");
  }
  return value;
}
function context(input: AdminOwnerCapacityContext): AdminOwnerCapacityContext {
  if (
    !plain(input) ||
    input.authenticationAssurance !== "workforce_oidc" ||
    input.permission !== "identity:quota_manage" ||
    !UUID_PATTERN.test(input.adminId) ||
    typeof input.requestId !== "string" ||
    input.requestId.trim() !== input.requestId ||
    input.requestId.length < 1 ||
    input.requestId.length > 200 ||
    !plain(input.mfa) ||
    typeof input.mfa.amrMfa !== "boolean" ||
    !["acr", "amr_mfa", "acr_and_amr_mfa"].includes(input.mfa.method) ||
    (input.mfa.matchedAcr !== null && typeof input.mfa.matchedAcr !== "string")
  ) {
    throw new AdminOwnerCapacityError("ADMIN_AUTHENTICATION_REQUIRED");
  }
  if (
    !Array.isArray(input.permissions) ||
    !input.permissions.includes("identity:quota_manage") ||
    new Set(input.permissions).size !== input.permissions.length ||
    input.permissions.some(
      (permission) => typeof permission !== "string" || !PERMISSION_SET.has(permission),
    ) ||
    !Array.isArray(input.roles) ||
    new Set(input.roles).size !== input.roles.length ||
    input.roles.some((role) => typeof role !== "string" || !ROLE_PATTERN.test(role))
  ) {
    throw new AdminOwnerCapacityError("ADMIN_PERMISSION_REQUIRED");
  }
  return {
    ...input,
    adminId: input.adminId.toLowerCase(),
    permissions: sorted(input.permissions),
    roles: sorted(input.roles),
  };
}
function filters(input: ListAdminOwnersInput): Filters {
  const limit = input.limit ?? 25;
  const statuses = input.statuses ?? OWNER_STATUSES;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    statuses.length < 1 ||
    statuses.length > OWNER_STATUSES.length ||
    new Set(statuses).size !== statuses.length ||
    statuses.some((status) => !OWNER_STATUSES.includes(status))
  ) {
    throw new AdminOwnerCapacityError("VALIDATION_ERROR");
  }
  const query = input.query?.normalize("NFC").trim() ?? null;
  if (
    input.query !== undefined &&
    (query === null || query.length < 1 || query.length > 200 || /\p{Cc}/u.test(query))
  ) {
    throw new AdminOwnerCapacityError("VALIDATION_ERROR");
  }
  return { limit, query, statuses: sorted(statuses) };
}
function quotaCommand(
  input: AdminOwnerQuotaActionInput,
  now: Date,
): AdminOwnerQuotaActionInput {
  if (
    !plain(input) ||
    !["set_override", "revoke_override"].includes(input.action) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    !QUOTA_REASONS.includes(input.reasonCode)
  ) {
    throw new AdminOwnerCapacityError("VALIDATION_ERROR");
  }
  const key = idempotency(input.idempotencyKey);
  if (
    input.action === "set_override" &&
    (!Number.isSafeInteger(input.maxActiveAgents) ||
      input.maxActiveAgents < 1 ||
      input.maxActiveAgents > 1_000 ||
      !(input.expiresAt instanceof Date) ||
      input.expiresAt.valueOf() <= now.valueOf() + HOUR_MS ||
      input.expiresAt.valueOf() > now.valueOf() + MAX_OVERRIDE_MS)
  ) {
    throw new AdminOwnerCapacityError("VALIDATION_ERROR");
  }
  return { ...input, idempotencyKey: key };
}
function registrationCommand(
  input: AdminRegistrationActionInput,
): AdminRegistrationActionInput {
  if (
    !plain(input) ||
    !["pause_registration", "resume_registration", "set_capacity_limits"].includes(
      input.action,
    ) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    throw new AdminOwnerCapacityError("VALIDATION_ERROR");
  }
  const key = idempotency(input.idempotencyKey);
  if (input.action === "pause_registration") {
    const condition = input.resumeCondition?.normalize("NFC").trim();
    if (
      !PAUSE_REASONS.includes(input.reasonCode) ||
      !condition ||
      condition.length > 1_000 ||
      /\p{Cc}/u.test(condition)
    ) {
      throw new AdminOwnerCapacityError("VALIDATION_ERROR");
    }
    return { ...input, idempotencyKey: key, resumeCondition: condition };
  }
  if (
    input.action === "resume_registration" &&
    !RESUME_REASONS.includes(input.reasonCode)
  ) {
    throw new AdminOwnerCapacityError("VALIDATION_ERROR");
  }
  if (
    input.action === "set_capacity_limits" &&
    (input.reasonCode !== "validated_operational_need" ||
      !Number.isSafeInteger(input.activeAgentOperatingTarget) ||
      !Number.isSafeInteger(input.activeAgentHardLimit) ||
      input.activeAgentOperatingTarget < 1 ||
      input.activeAgentHardLimit < input.activeAgentOperatingTarget ||
      input.activeAgentHardLimit > 10_000)
  ) {
    throw new AdminOwnerCapacityError("VALIDATION_ERROR");
  }
  return { ...input, idempotencyKey: key };
}
function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value
    ? parsed
    : null;
}
function encodeCursor(value: CursorEnvelope, key: Buffer): string {
  const payload = Buffer.from(stable(value), "utf8").toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}
function decodeCursor(
  value: string,
  key: Buffer,
  expectedFilters: Filters,
): CursorEnvelope {
  if (value.length > 4_096 || /\s/u.test(value)) {
    throw new AdminOwnerCapacityError("CURSOR_INVALID");
  }
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) {
    throw new AdminOwnerCapacityError("CURSOR_INVALID");
  }
  const expected = createHmac("sha256", key).update(payload).digest();
  let actual: Buffer;
  let parsed: unknown;
  try {
    actual = Buffer.from(signature, "base64url");
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new AdminOwnerCapacityError("CURSOR_INVALID");
  }
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected) ||
    !plain(parsed) ||
    parsed.version !== 1 ||
    parsed.purpose !== LIST_PURPOSE ||
    !UUID_PATTERN.test(String(parsed.snapshotId)) ||
    date(parsed.asOf) === null ||
    stable(parsed.filters) !== stable(expectedFilters) ||
    !plain(parsed.position) ||
    !UUID_PATTERN.test(String(parsed.position.id)) ||
    date(parsed.position.createdAt) === null
  ) {
    throw new AdminOwnerCapacityError("CURSOR_INVALID");
  }
  return parsed as unknown as CursorEnvelope;
}
function count(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Invalid count.");
  return result;
}
function version(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error("Invalid version.");
  return result;
}
function emailHint(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) throw new Error("Invalid Owner email.");
  const local = email.slice(0, at);
  return `${local[0]}***${local.length > 1 ? local.at(-1) : ""}${email.slice(at)}`;
}
function ownerView(row: OwnerRow): AdminOwnerSummaryView {
  if (!OWNER_STATUSES.includes(row.status as AdminOwnerStatus)) {
    throw new Error("Invalid Owner state.");
  }
  const reason = row.override_reason_code as AdminOwnerQuotaReason | null;
  if (reason !== null && !QUOTA_REASONS.includes(reason)) {
    throw new Error("Invalid quota reason.");
  }
  const credentials = {
    active: count(row.active_credentials),
    expired: count(row.expired_credentials),
    revoked: count(row.revoked_credentials),
    total: count(row.total_credentials),
  };
  if (
    credentials.active + credentials.expired + credentials.revoked !==
    credentials.total
  ) {
    throw new Error("Inconsistent Credential counts.");
  }
  return {
    activeAgentCount: count(row.active_agent_count),
    baseActiveAgentLimit: row.base_active_agent_limit,
    closedAt: row.deleted_at ? new Date(row.deleted_at) : null,
    createdAt: new Date(row.created_at),
    credentialCounts: credentials,
    currentOverride:
      row.override_id === null
        ? null
        : {
            createdAt: new Date(row.override_created_at!),
            expiresAt: new Date(row.override_expires_at!),
            maxActiveAgents: row.override_max_active_agents!,
            overrideId: row.override_id,
            reasonCode: reason!,
          },
    effectiveActiveAgentLimit: row.effective_active_agent_limit,
    emailHint: emailHint(row.email),
    emailVerified: row.email_verified_at !== null,
    ownerId: row.owner_id,
    quotaVersion: version(row.quota_version),
    restrictedAt: row.restricted_at ? new Date(row.restricted_at) : null,
    status: row.status as AdminOwnerStatus,
    suspendedAt: row.suspended_at ? new Date(row.suspended_at) : null,
    totalAgentCount: count(row.total_agent_count),
    updatedAt: new Date(row.updated_at),
  };
}
function controlView(row: ControlRow): AdminRegistrationControlView {
  if (row.mode !== "open" && row.mode !== "paused") throw new Error("Invalid mode.");
  const reason = row.pause_reason_code as AdminRegistrationPauseReason | null;
  if (reason !== null && !PAUSE_REASONS.includes(reason))
    throw new Error("Invalid reason.");
  const result: AdminRegistrationControlView = {
    activeAgentCount: count(row.active_agent_count),
    activeAgentHardLimit: version(row.active_agent_hard_limit),
    activeAgentOperatingTarget: version(row.active_agent_operating_target),
    mode: row.mode,
    pauseReasonCode: reason,
    pausedAt: row.paused_at ? new Date(row.paused_at) : null,
    resumeCondition: row.resume_condition,
    updatedAt: new Date(row.updated_at),
    version: version(row.version),
  };
  if (
    result.activeAgentCount > result.activeAgentHardLimit ||
    result.activeAgentOperatingTarget > result.activeAgentHardLimit ||
    (result.mode === "open" &&
      (result.pauseReasonCode !== null ||
        result.pausedAt !== null ||
        result.resumeCondition !== null)) ||
    (result.mode === "paused" &&
      (result.pauseReasonCode === null ||
        result.pausedAt === null ||
        result.resumeCondition === null))
  ) {
    throw new Error("Inconsistent registration control.");
  }
  return result;
}

function snapshotOwner(owner: AdminOwnerSummaryView): Record<string, unknown> {
  return {
    ...owner,
    closedAt: owner.closedAt?.toISOString() ?? null,
    createdAt: owner.createdAt.toISOString(),
    currentOverride: owner.currentOverride
      ? {
          ...owner.currentOverride,
          createdAt: owner.currentOverride.createdAt.toISOString(),
          expiresAt: owner.currentOverride.expiresAt.toISOString(),
        }
      : null,
    restrictedAt: owner.restrictedAt?.toISOString() ?? null,
    suspendedAt: owner.suspendedAt?.toISOString() ?? null,
    updatedAt: owner.updatedAt.toISOString(),
  };
}
function snapshotQuotaMutation(value: AdminOwnerQuotaMutation): Record<string, unknown> {
  return {
    action: { ...value.action, occurredAt: value.action.occurredAt.toISOString() },
    owner: snapshotOwner(value.owner),
  };
}
function snapshotRegistration(value: AdminRegistrationMutation): Record<string, unknown> {
  return {
    action: { ...value.action, occurredAt: value.action.occurredAt.toISOString() },
    control: {
      ...value.control,
      pausedAt: value.control.pausedAt?.toISOString() ?? null,
      updatedAt: value.control.updatedAt.toISOString(),
    },
  };
}
function restoreQuota(value: unknown): AdminOwnerQuotaMutation {
  if (!plain(value) || !plain(value.action) || !plain(value.owner)) {
    throw new Error("Invalid stored Owner quota response.");
  }
  const occurredAt = date(value.action.occurredAt);
  const createdAt = date(value.owner.createdAt);
  const updatedAt = date(value.owner.updatedAt);
  const closedAt = value.owner.closedAt === null ? null : date(value.owner.closedAt);
  const restrictedAt =
    value.owner.restrictedAt === null ? null : date(value.owner.restrictedAt);
  const suspendedAt =
    value.owner.suspendedAt === null ? null : date(value.owner.suspendedAt);
  let currentOverride: AdminOwnerQuotaOverrideView | null = null;
  if (value.owner.currentOverride !== null) {
    if (!plain(value.owner.currentOverride)) throw new Error("Invalid stored override.");
    const overrideCreated = date(value.owner.currentOverride.createdAt);
    const overrideExpires = date(value.owner.currentOverride.expiresAt);
    if (!overrideCreated || !overrideExpires) throw new Error("Invalid stored override.");
    currentOverride = {
      ...(value.owner.currentOverride as unknown as AdminOwnerQuotaOverrideView),
      createdAt: overrideCreated,
      expiresAt: overrideExpires,
    };
  }
  if (!occurredAt || !createdAt || !updatedAt) throw new Error("Invalid stored dates.");
  return {
    action: {
      ...(value.action as unknown as AdminOwnerQuotaMutation["action"]),
      occurredAt,
    },
    owner: {
      ...(value.owner as unknown as AdminOwnerSummaryView),
      closedAt,
      createdAt,
      currentOverride,
      restrictedAt,
      suspendedAt,
      updatedAt,
    },
    replayed: true,
  };
}
function restoreRegistration(value: unknown): AdminRegistrationMutation {
  if (!plain(value) || !plain(value.action) || !plain(value.control)) {
    throw new Error("Invalid stored registration response.");
  }
  const occurredAt = date(value.action.occurredAt);
  const updatedAt = date(value.control.updatedAt);
  const pausedAt = value.control.pausedAt === null ? null : date(value.control.pausedAt);
  if (!occurredAt || !updatedAt) throw new Error("Invalid stored dates.");
  return {
    action: {
      ...(value.action as unknown as AdminRegistrationMutation["action"]),
      occurredAt,
    },
    control: {
      ...(value.control as unknown as AdminRegistrationControlView),
      pausedAt,
      updatedAt,
    },
    replayed: true,
  };
}

export class PostgresAdminOwnerCapacityService implements AdminOwnerCapacityService {
  readonly #clock: () => Date;
  readonly #cursorKey: Buffer;
  readonly #idFactory: () => string;
  readonly #sql: PostgresClient;

  constructor(
    sql: PostgresClient,
    options: {
      clock?: () => Date;
      cursorSigningKey: Buffer | string;
      idFactory?: () => string;
    },
  ) {
    const key =
      typeof options.cursorSigningKey === "string"
        ? Buffer.from(options.cursorSigningKey, "utf8")
        : Buffer.from(options.cursorSigningKey);
    if (key.length < 32) throw new Error("Admin Owner cursor key is too short.");
    this.#sql = sql;
    this.#cursorKey = key;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async checkReady(): Promise<void> {
    try {
      const rows = await this.#sql<{ ready: boolean }[]>`
        select
          exists (
            select 1 from system.schema_migrations
            where version = '000025'
              and checksum = ${ADMIN_OWNER_CAPACITY_MIGRATION_CHECKSUM}
          )
          and to_regclass('platform.owner_agent_quota_overrides') is not null
          and to_regclass('platform.owner_capacity_admin_actions') is not null
          and exists (
            select 1 from pg_catalog.pg_attribute
            where attrelid = 'platform.owners'::regclass
              and attname = 'quota_version'
              and not attisdropped
          )
          and exists (
            select 1 from pg_catalog.pg_trigger
            where tgrelid = 'platform.owner_capacity_admin_actions'::regclass
              and tgname = 'owner_capacity_admin_actions_validate_provenance'
              and not tgisinternal
          ) as ready
      `;
      if (rows[0]?.ready !== true) {
        throw new AdminOwnerCapacityError("SCHEMA_NOT_READY");
      }
    } catch (error) {
      if (error instanceof AdminOwnerCapacityError) throw error;
      throw new AdminOwnerCapacityError("SCHEMA_NOT_READY", { cause: error });
    }
  }

  async listOwners(
    inputContext: AdminOwnerCapacityContext,
    input: ListAdminOwnersInput,
  ): Promise<AdminOwnerPage> {
    const admin = context(inputContext);
    const normalized = filters(input);
    const cursor = input.cursor
      ? decodeCursor(input.cursor, this.#cursorKey, normalized)
      : null;
    const asOf = cursor ? new Date(cursor.asOf) : new Date(this.#clock().valueOf());
    const snapshotId = cursor?.snapshotId ?? this.#newId();
    try {
      return await this.#sql.begin(
        "isolation level repeatable read",
        async (transaction) => {
          await transaction`set local statement_timeout = '10s'`;
          const effective = await this.#authorize(transaction, admin);
          const rows = await this.#selectOwners(
            transaction,
            asOf,
            normalized,
            cursor?.position ?? null,
          );
          const hasMore = rows.length > normalized.limit;
          const items = rows.slice(0, normalized.limit).map(ownerView);
          const last = items.at(-1);
          return {
            asOf,
            capabilities: {
              canManageQuota: effective.permissions.includes("identity:quota_manage"),
            },
            hasMore,
            items,
            limit: normalized.limit,
            nextCursor:
              hasMore && last
                ? encodeCursor(
                    {
                      asOf: asOf.toISOString(),
                      filters: normalized,
                      position: {
                        createdAt: last.createdAt.toISOString(),
                        id: last.ownerId,
                      },
                      purpose: LIST_PURPOSE,
                      snapshotId,
                      version: 1,
                    },
                    this.#cursorKey,
                  )
                : null,
            orderingVersion: "admin-owner-created-keyset-v1",
            snapshotId,
          };
        },
      );
    } catch (error) {
      throw this.#unavailable(error);
    }
  }

  async getOwner(
    inputContext: AdminOwnerCapacityContext,
    ownerId: string,
  ): Promise<AdminOwnerSummaryView> {
    const admin = context(inputContext);
    const normalizedOwnerId = uuid(ownerId);
    try {
      return await this.#sql.begin(
        "isolation level repeatable read",
        async (transaction) => {
          await transaction`set local statement_timeout = '10s'`;
          await this.#authorize(transaction, admin);
          const row = (await this.#selectOwner(transaction, normalizedOwnerId, false))[0];
          if (!row) throw new AdminOwnerCapacityError("OWNER_NOT_FOUND");
          return ownerView(row);
        },
      );
    } catch (error) {
      throw this.#unavailable(error);
    }
  }

  async getRegistration(inputContext: AdminOwnerCapacityContext): Promise<{
    capabilities: AdminOwnerCapacityCapabilities;
    control: AdminRegistrationControlView;
  }> {
    const admin = context(inputContext);
    try {
      return await this.#sql.begin(
        "isolation level repeatable read",
        async (transaction) => {
          await transaction`set local statement_timeout = '10s'`;
          const effective = await this.#authorize(transaction, admin);
          const row = (await this.#selectControl(transaction, false))[0];
          if (!row) throw new AdminOwnerCapacityError("SCHEMA_NOT_READY");
          return {
            capabilities: {
              canManageQuota: effective.permissions.includes("identity:quota_manage"),
            },
            control: controlView(row),
          };
        },
      );
    } catch (error) {
      throw this.#unavailable(error);
    }
  }

  async actOnOwnerQuota(
    inputContext: AdminOwnerCapacityContext,
    ownerId: string,
    input: AdminOwnerQuotaActionInput,
  ): Promise<AdminOwnerQuotaMutation> {
    const admin = context(inputContext);
    const normalizedOwnerId = uuid(ownerId);
    const command = quotaCommand(input, this.#clock());
    const requestDigest = digest({
      action: command.action,
      expectedVersion: command.expectedVersion,
      expiresAt:
        command.action === "set_override" ? command.expiresAt.toISOString() : null,
      maxActiveAgents: command.action === "set_override" ? command.maxActiveAgents : null,
      ownerId: normalizedOwnerId,
      reasonCode: command.reasonCode,
    });
    try {
      return await this.#sql.begin(async (transaction) => {
        await transaction`set local statement_timeout = '10s'`;
        const effective = await this.#authorize(transaction, admin);
        await this.#lockKey(transaction, admin.adminId, command.idempotencyKey);
        const replay = await this.#replay(
          transaction,
          admin.adminId,
          command.idempotencyKey,
          requestDigest,
          "owner_quota",
        );
        if (replay !== null) return restoreQuota(replay);

        const currentRow = (
          await this.#selectOwner(transaction, normalizedOwnerId, true)
        )[0];
        if (!currentRow) throw new AdminOwnerCapacityError("OWNER_NOT_FOUND");
        const before = ownerView(currentRow);
        if (before.quotaVersion !== command.expectedVersion) {
          throw new AdminOwnerCapacityError("OWNER_QUOTA_VERSION_CONFLICT", {
            currentVersion: before.quotaVersion,
          });
        }
        const occurredAt = new Date(
          (
            await transaction<{ occurred_at: Date }[]>`
              select clock_timestamp() as occurred_at
            `
          )[0]!.occurred_at,
        );
        if (command.action === "set_override") {
          if (
            command.expiresAt.valueOf() <= occurredAt.valueOf() + HOUR_MS ||
            command.expiresAt.valueOf() > occurredAt.valueOf() + MAX_OVERRIDE_MS
          ) {
            throw new AdminOwnerCapacityError("VALIDATION_ERROR");
          }
          await transaction`
            update platform.owner_agent_quota_overrides
            set revoked_at = ${occurredAt},
                revoked_by_admin_id = ${admin.adminId}
            where owner_id = ${normalizedOwnerId}
              and revoked_at is null
          `;
          await transaction`
            insert into platform.owner_agent_quota_overrides (
              id, owner_id, max_active_agents, reason_code, set_by_admin_id,
              created_at, expires_at
            )
            values (
              ${this.#newId()}, ${normalizedOwnerId}, ${command.maxActiveAgents},
              ${command.reasonCode}, ${admin.adminId}, ${occurredAt},
              ${command.expiresAt}
            )
          `;
        } else {
          const revoked = await transaction<{ id: string }[]>`
            update platform.owner_agent_quota_overrides
            set revoked_at = ${occurredAt},
                revoked_by_admin_id = ${admin.adminId}
            where owner_id = ${normalizedOwnerId}
              and revoked_at is null
            returning id::text
          `;
          if (revoked.length !== 1) {
            throw new AdminOwnerCapacityError("OWNER_QUOTA_STATE_CONFLICT");
          }
        }
        await transaction`
          update platform.owners
          set quota_version = quota_version + 1
          where id = ${normalizedOwnerId}
        `;
        const updatedRow = (
          await this.#selectOwner(transaction, normalizedOwnerId, false)
        )[0];
        if (!updatedRow) throw new Error("Owner quota update returned no row.");
        const owner = ownerView(updatedRow);
        const mutation: AdminOwnerQuotaMutation = {
          action: {
            action: command.action,
            actionId: this.#newId(),
            adminId: admin.adminId,
            occurredAt,
            permissionUsed: "identity:quota_manage",
            quotaVersionAfter: owner.quotaVersion,
            quotaVersionBefore: before.quotaVersion,
            reasonCode: command.reasonCode,
          },
          owner,
          replayed: false,
        };
        await this.#recordQuota(
          transaction,
          admin,
          effective,
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

  async actOnRegistration(
    inputContext: AdminOwnerCapacityContext,
    input: AdminRegistrationActionInput,
  ): Promise<AdminRegistrationMutation> {
    const admin = context(inputContext);
    const command = registrationCommand(input);
    const requestDigest = digest(
      command.action === "set_capacity_limits"
        ? {
            action: command.action,
            activeAgentHardLimit: command.activeAgentHardLimit,
            activeAgentOperatingTarget: command.activeAgentOperatingTarget,
            expectedVersion: command.expectedVersion,
            reasonCode: command.reasonCode,
          }
        : command.action === "pause_registration"
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
        const effective = await this.#authorize(transaction, admin);
        await this.#lockKey(transaction, admin.adminId, command.idempotencyKey);
        const replay = await this.#replay(
          transaction,
          admin.adminId,
          command.idempotencyKey,
          requestDigest,
          "registration_control",
        );
        if (replay !== null) return restoreRegistration(replay);

        const currentRow = (await this.#selectControl(transaction, true))[0];
        if (!currentRow) throw new AdminOwnerCapacityError("SCHEMA_NOT_READY");
        const before = controlView(currentRow);
        if (before.version !== command.expectedVersion) {
          throw new AdminOwnerCapacityError("CAPACITY_VERSION_CONFLICT", {
            currentVersion: before.version,
          });
        }
        if (
          (command.action === "pause_registration" && before.mode !== "open") ||
          (command.action === "resume_registration" && before.mode !== "paused") ||
          (command.action === "set_capacity_limits" &&
            (before.activeAgentCount > command.activeAgentHardLimit ||
              (before.activeAgentOperatingTarget === command.activeAgentOperatingTarget &&
                before.activeAgentHardLimit === command.activeAgentHardLimit)))
        ) {
          throw new AdminOwnerCapacityError("CAPACITY_STATE_CONFLICT");
        }
        if (command.action === "pause_registration") {
          await transaction`
            update platform.registration_controls
            set mode = 'paused',
                pause_reason_code = ${command.reasonCode},
                resume_condition = ${command.resumeCondition},
                updated_by_admin_id = ${admin.adminId}
            where id = true
          `;
        } else if (command.action === "resume_registration") {
          await transaction`
            update platform.registration_controls
            set mode = 'open',
                updated_by_admin_id = ${admin.adminId}
            where id = true
          `;
        } else {
          await transaction`
            update platform.registration_controls
            set active_agent_operating_target = ${command.activeAgentOperatingTarget},
                active_agent_hard_limit = ${command.activeAgentHardLimit},
                updated_by_admin_id = ${admin.adminId}
            where id = true
          `;
        }
        const updatedRow = (await this.#selectControl(transaction, false))[0];
        if (!updatedRow) throw new Error("Registration update returned no row.");
        const control = controlView(updatedRow);
        const mutation: AdminRegistrationMutation = {
          action: {
            action: command.action,
            actionId: this.#newId(),
            adminId: admin.adminId,
            occurredAt: control.updatedAt,
            permissionUsed: "identity:quota_manage",
            reasonCode: command.reasonCode,
            versionAfter: control.version,
            versionBefore: before.version,
          },
          control,
          replayed: false,
        };
        await this.#recordRegistration(
          transaction,
          admin,
          effective,
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
    const result = this.#idFactory().toLowerCase();
    if (!UUID_PATTERN.test(result))
      throw new Error("UUID factory returned invalid data.");
    return result;
  }

  #unavailable(error: unknown): AdminOwnerCapacityError {
    return error instanceof AdminOwnerCapacityError
      ? error
      : new AdminOwnerCapacityError("OWNER_CAPACITY_UNAVAILABLE", { cause: error });
  }

  async #selectOwners(
    transaction: Tx,
    asOf: Date,
    normalized: Filters,
    position: { createdAt: string; id: string } | null,
  ): Promise<OwnerRow[]> {
    return transaction<OwnerRow[]>`
      select
        owner.id::text as owner_id,
        owner.email::text,
        owner.status,
        owner.email_verified_at,
        owner.base_active_agent_limit,
        owner.quota_version::text,
        owner.created_at,
        owner.updated_at,
        owner.restricted_at,
        owner.suspended_at,
        owner.deleted_at,
        quota_override.id::text as override_id,
        quota_override.max_active_agents as override_max_active_agents,
        quota_override.reason_code as override_reason_code,
        quota_override.created_at as override_created_at,
        quota_override.expires_at as override_expires_at,
        coalesce(
          quota_override.max_active_agents,
          owner.base_active_agent_limit
        )::integer as effective_active_agent_limit,
        (
          select count(*)::text from platform.agents as agent
          where agent.owner_id = owner.id and agent.deleted_at is null
        ) as total_agent_count,
        (
          select count(*)::text from platform.agents as agent
          where agent.owner_id = owner.id
            and agent.activated_at is not null
            and agent.status <> 'archived'
            and agent.deleted_at is null
        ) as active_agent_count,
        (
          select count(*)::text from platform.credentials as credential
          where credential.owner_id = owner.id
        ) as total_credentials,
        (
          select count(*)::text from platform.credentials as credential
          where credential.owner_id = owner.id
            and credential.revoked_at is null
            and (
              credential.expires_at is null
              or credential.expires_at > clock_timestamp()
            )
        ) as active_credentials,
        (
          select count(*)::text from platform.credentials as credential
          where credential.owner_id = owner.id
            and credential.revoked_at is null
            and credential.expires_at <= clock_timestamp()
        ) as expired_credentials,
        (
          select count(*)::text from platform.credentials as credential
          where credential.owner_id = owner.id
            and credential.revoked_at is not null
        ) as revoked_credentials
      from platform.owners as owner
      left join lateral (
        select quota.*
        from platform.owner_agent_quota_overrides as quota
        where quota.owner_id = owner.id
          and quota.revoked_at is null
          and quota.expires_at > clock_timestamp()
        order by quota.created_at desc, quota.id desc
        limit 1
      ) as quota_override on true
      where owner.created_at <= ${asOf}
        and owner.status = any(${normalized.statuses})
        and (
          ${normalized.query}::text is null
          or position(
            lower(${normalized.query}::text)
            in lower(owner.id::text || ' ' || owner.email::text)
          ) > 0
        )
        and (
          ${position?.createdAt ?? null}::timestamptz is null
          or (owner.created_at, owner.id) <
            (
              ${position?.createdAt ?? null}::timestamptz,
              ${position?.id ?? null}::uuid
            )
        )
      order by owner.created_at desc, owner.id desc
      limit ${normalized.limit + 1}
    `;
  }

  async #selectOwner(
    transaction: Tx,
    ownerId: string,
    forUpdate: boolean,
  ): Promise<OwnerRow[]> {
    const lock = forUpdate ? transaction`for update of owner` : transaction``;
    return transaction<OwnerRow[]>`
      select
        owner.id::text as owner_id,
        owner.email::text,
        owner.status,
        owner.email_verified_at,
        owner.base_active_agent_limit,
        owner.quota_version::text,
        owner.created_at,
        owner.updated_at,
        owner.restricted_at,
        owner.suspended_at,
        owner.deleted_at,
        quota_override.id::text as override_id,
        quota_override.max_active_agents as override_max_active_agents,
        quota_override.reason_code as override_reason_code,
        quota_override.created_at as override_created_at,
        quota_override.expires_at as override_expires_at,
        coalesce(
          quota_override.max_active_agents,
          owner.base_active_agent_limit
        )::integer as effective_active_agent_limit,
        (
          select count(*)::text from platform.agents as agent
          where agent.owner_id = owner.id and agent.deleted_at is null
        ) as total_agent_count,
        (
          select count(*)::text from platform.agents as agent
          where agent.owner_id = owner.id
            and agent.activated_at is not null
            and agent.status <> 'archived'
            and agent.deleted_at is null
        ) as active_agent_count,
        (
          select count(*)::text from platform.credentials as credential
          where credential.owner_id = owner.id
        ) as total_credentials,
        (
          select count(*)::text from platform.credentials as credential
          where credential.owner_id = owner.id
            and credential.revoked_at is null
            and (
              credential.expires_at is null
              or credential.expires_at > clock_timestamp()
            )
        ) as active_credentials,
        (
          select count(*)::text from platform.credentials as credential
          where credential.owner_id = owner.id
            and credential.revoked_at is null
            and credential.expires_at <= clock_timestamp()
        ) as expired_credentials,
        (
          select count(*)::text from platform.credentials as credential
          where credential.owner_id = owner.id
            and credential.revoked_at is not null
        ) as revoked_credentials
      from platform.owners as owner
      left join lateral (
        select quota.*
        from platform.owner_agent_quota_overrides as quota
        where quota.owner_id = owner.id
          and quota.revoked_at is null
          and quota.expires_at > clock_timestamp()
        order by quota.created_at desc, quota.id desc
        limit 1
      ) as quota_override on true
      where owner.id = ${ownerId}
      ${lock}
    `;
  }

  async #selectControl(transaction: Tx, forUpdate: boolean): Promise<ControlRow[]> {
    const lock = forUpdate ? transaction`for update` : transaction``;
    return transaction<ControlRow[]>`
      select
        mode,
        version::text,
        pause_reason_code,
        paused_at,
        resume_condition,
        active_agent_count::text,
        active_agent_operating_target::text,
        active_agent_hard_limit::text,
        updated_at
      from platform.registration_controls
      where id = true
      ${lock}
    `;
  }

  async #recordQuota(
    transaction: Tx,
    admin: AdminOwnerCapacityContext,
    effective: Effective,
    command: AdminOwnerQuotaActionInput,
    before: AdminOwnerSummaryView,
    mutation: AdminOwnerQuotaMutation,
    requestDigest: Buffer,
  ): Promise<void> {
    const authorization = {
      permission: "identity:quota_manage",
      permissions: effective.permissions,
      roles: effective.roles,
    };
    const beforeState = {
      active_agent_count: before.activeAgentCount,
      effective_active_agent_limit: before.effectiveActiveAgentLimit,
      owner_id: before.ownerId,
      override_id: before.currentOverride?.overrideId ?? null,
      quota_version: before.quotaVersion,
    };
    const afterState = {
      active_agent_count: mutation.owner.activeAgentCount,
      effective_active_agent_limit: mutation.owner.effectiveActiveAgentLimit,
      owner_id: mutation.owner.ownerId,
      override_id: mutation.owner.currentOverride?.overrideId ?? null,
      quota_version: mutation.owner.quotaVersion,
    };
    const eventType =
      command.action === "set_override"
        ? "owner.agent_quota_override_set"
        : "owner.agent_quota_override_revoked";
    const outbox = await appendOutboxEvent(transaction, {
      aggregateId: mutation.owner.ownerId,
      aggregateType: "owner",
      eventType,
      eventVersion: 1,
      occurredAt: mutation.action.occurredAt,
      payload: {
        action_id: mutation.action.actionId,
        effective_active_agent_limit: mutation.owner.effectiveActiveAgentLimit,
        expires_at: mutation.owner.currentOverride?.expiresAt.toISOString() ?? null,
        owner_id: mutation.owner.ownerId,
        quota_version: mutation.owner.quotaVersion,
        reason_code: mutation.action.reasonCode,
      },
    });
    const logId = this.#newId();
    const logAction =
      command.action === "set_override"
        ? "owner.agent_quota_override.set"
        : "owner.agent_quota_override.revoke";
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
        ${logId}, 'governance', ${mutation.action.occurredAt}, null, null,
        ${mutation.owner.ownerId}, null, null, ${admin.adminId}, 'admin_web',
        'admin_override', null, 'workforce_oidc',
        ${transaction.json(authorization)}, ${logAction}, 'owner',
        ${mutation.owner.ownerId}, 'allow', 'succeeded', null, 0, ${outbox.id},
        null, ${admin.requestId}, null, ${transaction.json(beforeState)},
        ${transaction.json(afterState)}, ${mutation.action.reasonCode}
      )
    `;
    await transaction`
      insert into platform.owner_capacity_admin_actions (
        id, admin_id, permission_used, target_kind, owner_id, action,
        reason_code, version_before, version_after, idempotency_key,
        request_digest, request_id, authorization_snapshot, before_state,
        after_state, response_snapshot, action_log_id, outbox_event_id,
        occurred_at
      )
      values (
        ${mutation.action.actionId}, ${admin.adminId}, 'identity:quota_manage',
        'owner_quota', ${mutation.owner.ownerId}, ${mutation.action.action},
        ${mutation.action.reasonCode}, ${mutation.action.quotaVersionBefore},
        ${mutation.action.quotaVersionAfter}, ${command.idempotencyKey},
        ${requestDigest}, ${admin.requestId}, ${transaction.json(authorization)},
        ${transaction.json(beforeState)}, ${transaction.json(afterState)},
        ${transaction.json(
          JSON.parse(
            JSON.stringify(snapshotQuotaMutation(mutation)),
          ) as postgres.JSONValue,
        )},
        ${logId}, ${outbox.id}, ${mutation.action.occurredAt}
      )
    `;
  }

  async #recordRegistration(
    transaction: Tx,
    admin: AdminOwnerCapacityContext,
    effective: Effective,
    command: AdminRegistrationActionInput,
    before: AdminRegistrationControlView,
    mutation: AdminRegistrationMutation,
    requestDigest: Buffer,
  ): Promise<void> {
    const authorization = {
      permission: "identity:quota_manage",
      permissions: effective.permissions,
      roles: effective.roles,
    };
    const state = (control: AdminRegistrationControlView) => ({
      active_agent_count: control.activeAgentCount,
      active_agent_hard_limit: control.activeAgentHardLimit,
      active_agent_operating_target: control.activeAgentOperatingTarget,
      mode: control.mode,
      pause_reason_code: control.pauseReasonCode,
      version: control.version,
    });
    const beforeState = state(before);
    const afterState = state(mutation.control);
    const eventType =
      command.action === "pause_registration"
        ? "registration.paused"
        : command.action === "resume_registration"
          ? "registration.resumed"
          : "registration.capacity_limits_changed";
    const outbox = await appendOutboxEvent(transaction, {
      aggregateId: "singleton",
      aggregateType: "registration_control",
      eventType,
      eventVersion: 1,
      occurredAt: mutation.action.occurredAt,
      payload: {
        action_id: mutation.action.actionId,
        active_agent_count: mutation.control.activeAgentCount,
        active_agent_hard_limit: mutation.control.activeAgentHardLimit,
        active_agent_operating_target: mutation.control.activeAgentOperatingTarget,
        mode: mutation.control.mode,
        reason_code: mutation.action.reasonCode,
        version: mutation.control.version,
      },
    });
    const logId = this.#newId();
    const logAction =
      command.action === "pause_registration"
        ? "registration.pause"
        : command.action === "resume_registration"
          ? "registration.resume"
          : "registration.capacity_limits.set";
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
        ${logId}, 'governance', ${mutation.action.occurredAt}, null, null,
        null, null, null, ${admin.adminId}, 'admin_web', 'admin_override', null,
        'workforce_oidc', ${transaction.json(authorization)}, ${logAction},
        'registration_control', 'singleton', 'allow', 'succeeded', null, 0,
        ${outbox.id}, null, ${admin.requestId}, null,
        ${transaction.json(beforeState)}, ${transaction.json(afterState)},
        ${mutation.action.reasonCode}
      )
    `;
    await transaction`
      insert into platform.owner_capacity_admin_actions (
        id, admin_id, permission_used, target_kind, owner_id, action,
        reason_code, version_before, version_after, idempotency_key,
        request_digest, request_id, authorization_snapshot, before_state,
        after_state, response_snapshot, action_log_id, outbox_event_id,
        occurred_at
      )
      values (
        ${mutation.action.actionId}, ${admin.adminId}, 'identity:quota_manage',
        'registration_control', null, ${mutation.action.action},
        ${mutation.action.reasonCode}, ${mutation.action.versionBefore},
        ${mutation.action.versionAfter}, ${command.idempotencyKey},
        ${requestDigest}, ${admin.requestId}, ${transaction.json(authorization)},
        ${transaction.json(beforeState)}, ${transaction.json(afterState)},
        ${transaction.json(
          JSON.parse(
            JSON.stringify(snapshotRegistration(mutation)),
          ) as postgres.JSONValue,
        )},
        ${logId}, ${outbox.id}, ${mutation.action.occurredAt}
      )
    `;
  }

  async #authorize(
    transaction: Tx,
    admin: AdminOwnerCapacityContext,
  ): Promise<Effective> {
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
      where administrator.id = ${admin.adminId}
        and administrator.status = 'active'
    `;
    if (
      rows.length === 0 ||
      rows.some(
        (row) =>
          row.admin_id !== admin.adminId ||
          !ROLE_PATTERN.test(row.role_key) ||
          !PERMISSION_SET.has(row.permission),
      )
    ) {
      throw new AdminOwnerCapacityError("ADMIN_PERMISSION_REQUIRED");
    }
    const permissions = sorted(rows.map((row) => row.permission as AdminPermission));
    if (!permissions.includes("identity:quota_manage")) {
      throw new AdminOwnerCapacityError("ADMIN_PERMISSION_REQUIRED");
    }
    return { permissions, roles: sorted(rows.map((row) => row.role_key)) };
  }

  async #lockKey(transaction: Tx, adminId: string, key: string): Promise<void> {
    await transaction`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'alphanet:owner-capacity-admin:'
            || pg_catalog.octet_length(${adminId}::text)::text
            || ':' || ${adminId}::text || ':' || ${key}::text,
          0
        )
      )
    `;
  }

  async #replay(
    transaction: Tx,
    adminId: string,
    key: string,
    requestDigest: Buffer,
    targetKind: "owner_quota" | "registration_control",
  ): Promise<Record<string, unknown> | null> {
    const rows = await transaction<ReplayRow[]>`
      select request_digest, response_snapshot, target_kind
      from platform.owner_capacity_admin_actions
      where admin_id = ${adminId}
        and idempotency_key = ${key}
    `;
    const row = rows[0];
    if (!row) return null;
    if (
      rows.length !== 1 ||
      row.target_kind !== targetKind ||
      row.request_digest.length !== requestDigest.length ||
      !timingSafeEqual(row.request_digest, requestDigest)
    ) {
      throw new AdminOwnerCapacityError("IDEMPOTENCY_CONFLICT");
    }
    if (!plain(row.response_snapshot)) {
      throw new AdminOwnerCapacityError("IDEMPOTENCY_CONFLICT");
    }
    return row.response_snapshot;
  }
}
