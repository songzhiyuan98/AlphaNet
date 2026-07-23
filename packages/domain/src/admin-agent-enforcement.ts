import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { appendOutboxEvent, type PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import {
  ADMIN_PERMISSIONS,
  type AdminMfaEvidence,
  type AdminPermission,
} from "./content-moderation.js";
import { AGENT_ADMIN_ENFORCEMENT_MIGRATION_CHECKSUM } from "./schema-migrations.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROLE_PATTERN = /^[a-z][a-z0-9_.-]{0,79}$/u;
const ADMIN_PERMISSION_SET = new Set<string>(ADMIN_PERMISSIONS);
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const MAX_CURSOR_LENGTH = 4_096;
const LIST_PURPOSE = "alphanet.admin.agent-list.v1" as const;

export type AdminAgentStatus =
  "draft" | "active" | "restricted" | "suspended" | "archived";
export type AdminAgentEnforcementAction =
  "restrict_agent" | "suspend_agent" | "restore_agent" | "revoke_credentials";
export type AdminAgentActionPermission = "identity:restrict" | "credential:revoke";
export type AdminAgentActionReason =
  | "spam_automation"
  | "coordinated_manipulation"
  | "credential_compromise"
  | "security_incident"
  | "platform_policy_violation"
  | "moderation_error_corrected"
  | "owner_appeal_granted"
  | "risk_condition_resolved";

export interface AdminAgentContext {
  adminId: string;
  authenticationAssurance: "workforce_oidc";
  mfa: AdminMfaEvidence;
  permission: "identity:restrict";
  permissions: readonly AdminPermission[];
  requestId: string;
  roles: readonly string[];
}

export interface AdminAgentCredentialCounts {
  active: number;
  expired: number;
  revoked: number;
  total: number;
}

export interface AdminAgentSummaryView {
  activatedAt: Date | null;
  actorId: string;
  agentId: string;
  archivedAt: Date | null;
  createdAt: Date;
  credentialCounts: AdminAgentCredentialCounts;
  discoveryTags: string[];
  displayName: string;
  governanceVersion: number;
  handle: string;
  ownerId: string;
  restrictedAt: Date | null;
  restrictionReasonCode: string | null;
  status: AdminAgentStatus;
  suspendedAt: Date | null;
  updatedAt: Date;
}

export interface AdminAgentCredentialView {
  createdAt: Date;
  credentialId: string;
  credentialType: "api_key" | "oauth_grant";
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  name: string;
  prefix: string | null;
  revokedAt: Date | null;
  scopes: string[];
  status: "active" | "expired" | "revoked";
}

export interface AdminAgentCapabilities {
  canRestrict: boolean;
  canRevokeCredentials: boolean;
}

export interface AdminAgentDetailView {
  agent: AdminAgentSummaryView;
  capabilities: AdminAgentCapabilities;
  credentials: AdminAgentCredentialView[];
}

export interface ListAdminAgentsInput {
  cursor?: string | null | undefined;
  limit?: number | undefined;
  query?: string | undefined;
  statuses?: readonly AdminAgentStatus[] | undefined;
}

export interface AdminAgentPage {
  asOf: Date;
  capabilities: AdminAgentCapabilities;
  hasMore: boolean;
  items: AdminAgentSummaryView[];
  limit: number;
  nextCursor: string | null;
  orderingVersion: "admin-agent-created-keyset-v1";
  snapshotId: string;
}

export interface AdminAgentActionInput {
  action: AdminAgentEnforcementAction;
  expectedVersion: number;
  idempotencyKey: string;
  internalNote?: string | undefined;
  reasonCode: AdminAgentActionReason;
}

export interface AdminAgentMutation {
  action: {
    action: AdminAgentEnforcementAction;
    actionId: string;
    adminId: string;
    governanceVersionAfter: number;
    governanceVersionBefore: number;
    occurredAt: Date;
    permissionUsed: AdminAgentActionPermission;
    reasonCode: AdminAgentActionReason;
    revokedCredentialCount: number;
  };
  agent: AdminAgentSummaryView;
  replayed: boolean;
}

export interface AdminAgentEnforcementService {
  act(
    context: AdminAgentContext,
    agentId: string,
    input: AdminAgentActionInput,
  ): Promise<AdminAgentMutation>;
  checkReady(): Promise<void>;
  get(context: AdminAgentContext, agentId: string): Promise<AdminAgentDetailView>;
  list(context: AdminAgentContext, input: ListAdminAgentsInput): Promise<AdminAgentPage>;
}

export type AdminAgentEnforcementErrorCode =
  | "ADMIN_AUTHENTICATION_REQUIRED"
  | "ADMIN_PERMISSION_REQUIRED"
  | "AGENT_NOT_FOUND"
  | "AGENT_STATE_CONFLICT"
  | "AGENT_VERSION_CONFLICT"
  | "CURSOR_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "SCHEMA_NOT_READY"
  | "AGENT_ENFORCEMENT_UNAVAILABLE"
  | "VALIDATION_ERROR";

const ERROR_DEFINITIONS = {
  ADMIN_AUTHENTICATION_REQUIRED: [
    401,
    false,
    "Administrator authentication is required.",
  ],
  ADMIN_PERMISSION_REQUIRED: [
    403,
    false,
    "The required Agent governance permission is missing.",
  ],
  AGENT_NOT_FOUND: [404, false, "The Agent was not found."],
  AGENT_STATE_CONFLICT: [409, false, "The Agent cannot accept this action."],
  AGENT_VERSION_CONFLICT: [409, false, "The Agent governance version has changed."],
  CURSOR_INVALID: [422, false, "The Agent cursor is invalid."],
  IDEMPOTENCY_CONFLICT: [409, false, "The idempotency key was already used."],
  SCHEMA_NOT_READY: [503, true, "The Agent governance schema is not ready."],
  AGENT_ENFORCEMENT_UNAVAILABLE: [
    503,
    true,
    "Agent governance is temporarily unavailable.",
  ],
  VALIDATION_ERROR: [422, false, "The Agent governance request is invalid."],
} as const satisfies Record<
  AdminAgentEnforcementErrorCode,
  readonly [number, boolean, string]
>;

export class AdminAgentEnforcementError extends Error {
  readonly code: AdminAgentEnforcementErrorCode;
  readonly currentVersion: number | null;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    code: AdminAgentEnforcementErrorCode,
    options: { cause?: unknown; currentVersion?: number | undefined } = {},
  ) {
    const [statusCode, retryable, message] = ERROR_DEFINITIONS[code];
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AdminAgentEnforcementError";
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

interface AgentRow {
  activated_at: Date | null;
  active_credentials: string;
  actor_id: string;
  agent_id: string;
  archived_at: Date | null;
  created_at: Date;
  discovery_tags: string[];
  display_name: string;
  expired_credentials: string;
  governance_version: string;
  handle: string;
  owner_id: string;
  restricted_at: Date | null;
  restriction_reason_code: string | null;
  revoked_credentials: string;
  status: string;
  suspended_at: Date | null;
  total_credentials: string;
  updated_at: Date;
}

interface CredentialRow {
  created_at: Date;
  credential_id: string;
  credential_type: string;
  expires_at: Date | null;
  last_used_at: Date | null;
  name: string;
  revoked_at: Date | null;
  scopes: string[];
  token_prefix: string | null;
}

interface EffectiveAuthorization {
  permissions: AdminPermission[];
  roles: string[];
}

interface NormalizedListFilters {
  limit: number;
  query: string | null;
  statuses: AdminAgentStatus[];
}

interface ListCursorEnvelope {
  asOf: string;
  filters: NormalizedListFilters;
  position: { createdAt: string; id: string };
  purpose: typeof LIST_PURPOSE;
  snapshotId: string;
  version: 1;
}

interface ReplayRow {
  request_digest: Buffer;
  response_snapshot: unknown;
}

interface StoredMutationSnapshot {
  action: Omit<AdminAgentMutation["action"], "occurredAt"> & {
    occurredAt: string;
  };
  agent: Omit<
    AdminAgentSummaryView,
    | "activatedAt"
    | "archivedAt"
    | "createdAt"
    | "restrictedAt"
    | "suspendedAt"
    | "updatedAt"
  > & {
    activatedAt: string | null;
    archivedAt: string | null;
    createdAt: string;
    restrictedAt: string | null;
    suspendedAt: string | null;
    updatedAt: string;
  };
}

const AGENT_STATUSES: readonly AdminAgentStatus[] = [
  "draft",
  "active",
  "restricted",
  "suspended",
  "archived",
];
const ENFORCEMENT_REASONS = new Set<AdminAgentActionReason>([
  "spam_automation",
  "coordinated_manipulation",
  "credential_compromise",
  "security_incident",
  "platform_policy_violation",
]);
const RESTORATION_REASONS = new Set<AdminAgentActionReason>([
  "moderation_error_corrected",
  "owner_appeal_granted",
  "risk_condition_resolved",
]);
const REVOCATION_REASONS = new Set<AdminAgentActionReason>([
  "credential_compromise",
  "security_incident",
  "platform_policy_violation",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: object | null = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function normalizeUuid(value: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AdminAgentEnforcementError("VALIDATION_ERROR");
  }
  return value.toLowerCase();
}

function normalizeIdempotencyKey(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 200 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new AdminAgentEnforcementError("VALIDATION_ERROR");
  }
  return value;
}

function normalizeInternalNote(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    [...value].length > 4_000 ||
    Buffer.byteLength(value, "utf8") > 16_384 ||
    value.normalize("NFC") !== value ||
    /[^\P{Cc}\n\t]/u.test(value)
  ) {
    throw new AdminAgentEnforcementError("VALIDATION_ERROR");
  }
  return value;
}

function validateActionInput(input: AdminAgentActionInput): {
  action: AdminAgentEnforcementAction;
  expectedVersion: number;
  idempotencyKey: string;
  internalNote: string | undefined;
  permission: AdminAgentActionPermission;
  reasonCode: AdminAgentActionReason;
} {
  if (
    !isPlainRecord(input) ||
    !["restrict_agent", "suspend_agent", "restore_agent", "revoke_credentials"].includes(
      input.action,
    ) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    throw new AdminAgentEnforcementError("VALIDATION_ERROR");
  }
  const validReason =
    (input.action === "restore_agent" && RESTORATION_REASONS.has(input.reasonCode)) ||
    (input.action === "revoke_credentials" && REVOCATION_REASONS.has(input.reasonCode)) ||
    ((input.action === "restrict_agent" || input.action === "suspend_agent") &&
      ENFORCEMENT_REASONS.has(input.reasonCode));
  if (!validReason) throw new AdminAgentEnforcementError("VALIDATION_ERROR");
  return {
    action: input.action,
    expectedVersion: input.expectedVersion,
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    internalNote: normalizeInternalNote(input.internalNote),
    permission:
      input.action === "revoke_credentials" ? "credential:revoke" : "identity:restrict",
    reasonCode: input.reasonCode,
  };
}

function validateContext(context: AdminAgentContext): AdminAgentContext {
  if (
    !isPlainRecord(context) ||
    context.authenticationAssurance !== "workforce_oidc" ||
    context.permission !== "identity:restrict" ||
    typeof context.adminId !== "string" ||
    !UUID_PATTERN.test(context.adminId) ||
    typeof context.requestId !== "string" ||
    context.requestId.trim() !== context.requestId ||
    context.requestId.length < 1 ||
    context.requestId.length > 200 ||
    /\p{Cc}/u.test(context.requestId) ||
    !isPlainRecord(context.mfa) ||
    !hasExactKeys(context.mfa, ["amrMfa", "matchedAcr", "method"]) ||
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
    throw new AdminAgentEnforcementError("ADMIN_AUTHENTICATION_REQUIRED");
  }
  if (
    !Array.isArray(context.permissions) ||
    context.permissions.length > ADMIN_PERMISSIONS.length ||
    new Set(context.permissions).size !== context.permissions.length ||
    context.permissions.some(
      (permission) =>
        typeof permission !== "string" || !ADMIN_PERMISSION_SET.has(permission),
    ) ||
    !context.permissions.includes("identity:restrict") ||
    !Array.isArray(context.roles) ||
    context.roles.length > 100 ||
    new Set(context.roles).size !== context.roles.length ||
    context.roles.some((role) => typeof role !== "string" || !ROLE_PATTERN.test(role))
  ) {
    throw new AdminAgentEnforcementError("ADMIN_PERMISSION_REQUIRED");
  }
  return {
    ...context,
    adminId: context.adminId.toLowerCase(),
    permissions: sortedUnique(context.permissions),
    roles: sortedUnique(context.roles),
  };
}

function normalizeListFilters(input: ListAdminAgentsInput): NormalizedListFilters {
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new AdminAgentEnforcementError("VALIDATION_ERROR");
  }
  const statuses = input.statuses ?? [...AGENT_STATUSES];
  if (
    statuses.length < 1 ||
    statuses.length > AGENT_STATUSES.length ||
    new Set(statuses).size !== statuses.length ||
    statuses.some((status) => !AGENT_STATUSES.includes(status))
  ) {
    throw new AdminAgentEnforcementError("VALIDATION_ERROR");
  }
  let query: string | null = null;
  if (input.query !== undefined) {
    if (typeof input.query !== "string") {
      throw new AdminAgentEnforcementError("VALIDATION_ERROR");
    }
    query = input.query.normalize("NFC").trim();
    if (query.length < 1 || query.length > 200 || /\p{Cc}/u.test(query)) {
      throw new AdminAgentEnforcementError("VALIDATION_ERROR");
    }
  }
  return { limit, query, statuses: sortedUnique(statuses) };
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value ? date : null;
}

function encodeCursor(envelope: ListCursorEnvelope, signingKey: Buffer): string {
  const payload = Buffer.from(stableJson(envelope), "utf8").toString("base64url");
  const signature = createHmac("sha256", signingKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeCursor(
  cursor: string,
  signingKey: Buffer,
  filters: NormalizedListFilters,
): ListCursorEnvelope {
  if (
    typeof cursor !== "string" ||
    cursor.length < 3 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    /\s/u.test(cursor)
  ) {
    throw new AdminAgentEnforcementError("CURSOR_INVALID");
  }
  const [payload, signature, extra] = cursor.split(".");
  if (!payload || !signature || extra !== undefined) {
    throw new AdminAgentEnforcementError("CURSOR_INVALID");
  }
  const expected = createHmac("sha256", signingKey).update(payload).digest();
  let actual: Buffer;
  let parsed: unknown;
  try {
    actual = Buffer.from(signature, "base64url");
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new AdminAgentEnforcementError("CURSOR_INVALID");
  }
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected) ||
    !isPlainRecord(parsed) ||
    Object.keys(parsed).sort().join(",") !==
      "asOf,filters,position,purpose,snapshotId,version" ||
    parsed.version !== 1 ||
    parsed.purpose !== LIST_PURPOSE ||
    typeof parsed.snapshotId !== "string" ||
    !UUID_PATTERN.test(parsed.snapshotId) ||
    parseIsoDate(parsed.asOf) === null ||
    stableJson(parsed.filters) !== stableJson(filters) ||
    !isPlainRecord(parsed.position) ||
    Object.keys(parsed.position).sort().join(",") !== "createdAt,id" ||
    typeof parsed.position.id !== "string" ||
    !UUID_PATTERN.test(parsed.position.id) ||
    parseIsoDate(parsed.position.createdAt) === null
  ) {
    throw new AdminAgentEnforcementError("CURSOR_INVALID");
  }
  return parsed as unknown as ListCursorEnvelope;
}

function nonnegative(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("Agent governance returned an invalid count.");
  }
  return number;
}

function positive(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("Agent governance returned an invalid version.");
  }
  return number;
}

function rowToSummary(row: AgentRow): AdminAgentSummaryView {
  if (!AGENT_STATUSES.includes(row.status as AdminAgentStatus)) {
    throw new Error("Agent governance returned an unsupported state.");
  }
  return {
    activatedAt: row.activated_at ? new Date(row.activated_at) : null,
    actorId: row.actor_id,
    agentId: row.agent_id,
    archivedAt: row.archived_at ? new Date(row.archived_at) : null,
    createdAt: new Date(row.created_at),
    credentialCounts: {
      active: nonnegative(row.active_credentials),
      expired: nonnegative(row.expired_credentials),
      revoked: nonnegative(row.revoked_credentials),
      total: nonnegative(row.total_credentials),
    },
    discoveryTags: row.discovery_tags,
    displayName: row.display_name,
    governanceVersion: positive(row.governance_version),
    handle: row.handle,
    ownerId: row.owner_id,
    restrictedAt: row.restricted_at ? new Date(row.restricted_at) : null,
    restrictionReasonCode: row.restriction_reason_code,
    status: row.status as AdminAgentStatus,
    suspendedAt: row.suspended_at ? new Date(row.suspended_at) : null,
    updatedAt: new Date(row.updated_at),
  };
}

function rowToCredential(row: CredentialRow, now: Date): AdminAgentCredentialView {
  if (row.credential_type !== "static_api_key" && row.credential_type !== "oauth_grant") {
    throw new Error("Agent governance returned an unsupported Credential type.");
  }
  const status =
    row.revoked_at !== null
      ? "revoked"
      : row.expires_at !== null && row.expires_at.valueOf() <= now.valueOf()
        ? "expired"
        : "active";
  return {
    createdAt: new Date(row.created_at),
    credentialId: row.credential_id,
    credentialType: row.credential_type === "static_api_key" ? "api_key" : "oauth_grant",
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    name: row.name,
    prefix: row.token_prefix,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    scopes: row.scopes,
    status,
  };
}

function digestRequest(value: unknown): Buffer {
  return createHash("sha256").update(stableJson(value)).digest();
}

function snapshotMutation(mutation: AdminAgentMutation): StoredMutationSnapshot {
  return {
    action: {
      ...mutation.action,
      occurredAt: mutation.action.occurredAt.toISOString(),
    },
    agent: {
      ...mutation.agent,
      activatedAt: mutation.agent.activatedAt?.toISOString() ?? null,
      archivedAt: mutation.agent.archivedAt?.toISOString() ?? null,
      createdAt: mutation.agent.createdAt.toISOString(),
      restrictedAt: mutation.agent.restrictedAt?.toISOString() ?? null,
      suspendedAt: mutation.agent.suspendedAt?.toISOString() ?? null,
      updatedAt: mutation.agent.updatedAt.toISOString(),
    },
  };
}

function restoreMutation(value: unknown): AdminAgentMutation {
  const snapshot = value as StoredMutationSnapshot;
  if (
    !isPlainRecord(snapshot) ||
    !isPlainRecord(snapshot.action) ||
    !isPlainRecord(snapshot.agent)
  ) {
    throw new Error("Agent governance replay snapshot is invalid.");
  }
  return {
    action: {
      ...snapshot.action,
      occurredAt: new Date(snapshot.action.occurredAt),
    },
    agent: {
      ...snapshot.agent,
      activatedAt: snapshot.agent.activatedAt
        ? new Date(snapshot.agent.activatedAt)
        : null,
      archivedAt: snapshot.agent.archivedAt ? new Date(snapshot.agent.archivedAt) : null,
      createdAt: new Date(snapshot.agent.createdAt),
      restrictedAt: snapshot.agent.restrictedAt
        ? new Date(snapshot.agent.restrictedAt)
        : null,
      suspendedAt: snapshot.agent.suspendedAt
        ? new Date(snapshot.agent.suspendedAt)
        : null,
      updatedAt: new Date(snapshot.agent.updatedAt),
    },
    replayed: true,
  };
}

export class PostgresAdminAgentEnforcementService implements AdminAgentEnforcementService {
  readonly #clock: () => Date;
  readonly #cursorSigningKey: Buffer;
  readonly #idFactory: () => string;
  readonly #sql: PostgresClient;

  constructor(
    sql: PostgresClient,
    options: {
      clock?: (() => Date) | undefined;
      cursorSigningKey: Uint8Array;
      idFactory?: (() => string) | undefined;
    },
  ) {
    if (
      !(options.cursorSigningKey instanceof Uint8Array) ||
      options.cursorSigningKey.byteLength < 32
    ) {
      throw new Error("The Agent governance cursor key must contain 32 bytes.");
    }
    this.#sql = sql;
    this.#clock = options.clock ?? (() => new Date());
    this.#cursorSigningKey = Buffer.from(options.cursorSigningKey);
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async checkReady(): Promise<void> {
    const rows = await this.#sql<{ ready: boolean }[]>`
      select
        exists (
          select 1
          from system.schema_migrations
          where version = '000024'
            and name = 'admin_agent_enforcement_v1'
            and checksum = ${AGENT_ADMIN_ENFORCEMENT_MIGRATION_CHECKSUM}
        )
        and to_regclass('platform.agent_admin_actions') is not null
        and to_regprocedure(
          'platform.validate_agent_admin_action_provenance()'
        ) is not null
        as ready
    `;
    if (rows.length !== 1 || rows[0]?.ready !== true) {
      throw new AdminAgentEnforcementError("SCHEMA_NOT_READY");
    }
  }

  async list(
    context: AdminAgentContext,
    input: ListAdminAgentsInput,
  ): Promise<AdminAgentPage> {
    const admin = validateContext(context);
    const filters = normalizeListFilters(input);
    const cursor =
      input.cursor === undefined || input.cursor === null
        ? null
        : decodeCursor(input.cursor, this.#cursorSigningKey, filters);
    const asOf = cursor ? new Date(cursor.asOf) : new Date(this.#clock().valueOf());
    if (!Number.isFinite(asOf.valueOf())) {
      throw new AdminAgentEnforcementError("VALIDATION_ERROR");
    }
    const snapshotId = cursor?.snapshotId ?? this.#newId();
    const position = cursor?.position ?? null;

    try {
      return await this.#sql.begin(
        "isolation level repeatable read",
        async (transaction) => {
          await transaction`set local statement_timeout = '10s'`;
          const effective = await this.#revalidateAdmin(
            transaction,
            admin,
            "identity:restrict",
          );
          const rows = await this.#selectAgents(transaction, {
            asOf,
            filters,
            position,
          });
          const hasMore = rows.length > filters.limit;
          const items = rows.slice(0, filters.limit).map(rowToSummary);
          const last = items.at(-1);
          return {
            asOf,
            capabilities: this.#capabilities(effective),
            hasMore,
            items,
            limit: filters.limit,
            nextCursor:
              hasMore && last
                ? encodeCursor(
                    {
                      asOf: asOf.toISOString(),
                      filters,
                      position: {
                        createdAt: last.createdAt.toISOString(),
                        id: last.agentId,
                      },
                      purpose: LIST_PURPOSE,
                      snapshotId,
                      version: 1,
                    },
                    this.#cursorSigningKey,
                  )
                : null,
            orderingVersion: "admin-agent-created-keyset-v1",
            snapshotId,
          };
        },
      );
    } catch (error) {
      throw this.#asUnavailable(error);
    }
  }

  async get(context: AdminAgentContext, agentId: string): Promise<AdminAgentDetailView> {
    const admin = validateContext(context);
    const normalizedAgentId = normalizeUuid(agentId);
    try {
      return await this.#sql.begin(
        "isolation level repeatable read",
        async (transaction) => {
          await transaction`set local statement_timeout = '10s'`;
          const effective = await this.#revalidateAdmin(
            transaction,
            admin,
            "identity:restrict",
          );
          const rows = await this.#selectAgent(transaction, normalizedAgentId, false);
          const row = rows[0];
          if (!row) throw new AdminAgentEnforcementError("AGENT_NOT_FOUND");
          const credentialRows = await transaction<CredentialRow[]>`
            select
              credential.id::text as credential_id,
              credential.name,
              credential.credential_type,
              credential.token_prefix,
              credential.scopes,
              credential.issued_at as created_at,
              credential.expires_at,
              credential.last_used_at,
              credential.revoked_at
            from platform.credentials as credential
            where credential.agent_id = ${normalizedAgentId}
            order by credential.issued_at desc, credential.id desc
            limit 101
          `;
          if (credentialRows.length > 100) {
            throw new Error("Agent credential projection exceeded its bound.");
          }
          const now = new Date(this.#clock().valueOf());
          return {
            agent: rowToSummary(row),
            capabilities: this.#capabilities(effective),
            credentials: credentialRows.map((credential) =>
              rowToCredential(credential, now),
            ),
          };
        },
      );
    } catch (error) {
      throw this.#asUnavailable(error);
    }
  }

  async act(
    context: AdminAgentContext,
    agentId: string,
    input: AdminAgentActionInput,
  ): Promise<AdminAgentMutation> {
    const admin = validateContext(context);
    const normalizedAgentId = normalizeUuid(agentId);
    const command = validateActionInput(input);
    const digest = digestRequest({
      action: command.action,
      agentId: normalizedAgentId,
      expectedVersion: command.expectedVersion,
      internalNote: command.internalNote ?? null,
      reasonCode: command.reasonCode,
    });

    try {
      return await this.#sql.begin(async (transaction) => {
        await transaction`set local statement_timeout = '10s'`;
        const effective = await this.#revalidateAdmin(
          transaction,
          admin,
          command.permission,
        );
        await this.#lockIdempotency(transaction, admin.adminId, command.idempotencyKey);
        const replay = await this.#findReplay(
          transaction,
          admin.adminId,
          command.idempotencyKey,
          digest,
        );
        if (replay) return replay;

        const currentRows = await this.#selectAgent(transaction, normalizedAgentId, true);
        const currentRow = currentRows[0];
        if (!currentRow) throw new AdminAgentEnforcementError("AGENT_NOT_FOUND");
        const current = rowToSummary(currentRow);
        if (current.governanceVersion !== command.expectedVersion) {
          throw new AdminAgentEnforcementError("AGENT_VERSION_CONFLICT", {
            currentVersion: current.governanceVersion,
          });
        }
        this.#assertTransition(current.status, command.action);

        let revokedCredentialCount = 0;
        if (command.action === "revoke_credentials") {
          const revoked = await transaction<{ id: string }[]>`
            update platform.credentials
            set revoked_at = clock_timestamp(),
                updated_at = clock_timestamp()
            where agent_id = ${normalizedAgentId}
              and revoked_at is null
              and (expires_at is null or expires_at > clock_timestamp())
            returning id::text
          `;
          revokedCredentialCount = revoked.length;
        } else {
          const nextStatus =
            command.action === "restrict_agent"
              ? "restricted"
              : command.action === "suspend_agent"
                ? "suspended"
                : "active";
          await transaction`
            update platform.actors
            set status = ${nextStatus},
                updated_at = clock_timestamp()
            where id = ${current.actorId}
              and owner_id = ${current.ownerId}
              and kind = 'agent'
          `;
        }

        const nextStatus =
          command.action === "restrict_agent"
            ? "restricted"
            : command.action === "suspend_agent"
              ? "suspended"
              : command.action === "restore_agent"
                ? "active"
                : current.status;
        await transaction`
          update platform.agents
          set status = ${nextStatus},
              restriction_reason_code = ${
                nextStatus === "active" ? null : command.reasonCode
              },
              restricted_at = case
                when ${nextStatus} = 'restricted' then clock_timestamp()
                else null
              end,
              suspended_at = case
                when ${nextStatus} = 'suspended' then clock_timestamp()
                else null
              end,
              governance_version = governance_version + 1,
              updated_at = clock_timestamp()
          where id = ${normalizedAgentId}
        `;

        const updatedRows = await this.#selectAgent(
          transaction,
          normalizedAgentId,
          false,
        );
        const updatedRow = updatedRows[0];
        if (!updatedRow) throw new Error("Agent update returned no row.");
        const agent = rowToSummary(updatedRow);
        const occurredAt = agent.updatedAt;
        const mutation: AdminAgentMutation = {
          action: {
            action: command.action,
            actionId: this.#newId(),
            adminId: admin.adminId,
            governanceVersionAfter: agent.governanceVersion,
            governanceVersionBefore: current.governanceVersion,
            occurredAt,
            permissionUsed: command.permission,
            reasonCode: command.reasonCode,
            revokedCredentialCount,
          },
          agent,
          replayed: false,
        };
        await this.#recordMutation(
          transaction,
          admin,
          effective,
          command,
          current,
          mutation,
          digest,
        );
        return mutation;
      });
    } catch (error) {
      throw this.#asUnavailable(error);
    }
  }

  #assertTransition(status: AdminAgentStatus, action: AdminAgentEnforcementAction): void {
    if (status === "draft" || status === "archived") {
      throw new AdminAgentEnforcementError("AGENT_STATE_CONFLICT");
    }
    if (action === "restore_agent" && status === "active") {
      throw new AdminAgentEnforcementError("AGENT_STATE_CONFLICT");
    }
  }

  #capabilities(effective: EffectiveAuthorization): AdminAgentCapabilities {
    return {
      canRestrict: effective.permissions.includes("identity:restrict"),
      canRevokeCredentials: effective.permissions.includes("credential:revoke"),
    };
  }

  #newId(): string {
    const value = this.#idFactory().toLowerCase();
    if (!UUID_PATTERN.test(value)) throw new Error("UUID factory returned invalid data.");
    return value;
  }

  async #selectAgents(
    transaction: TransactionSql,
    options: {
      asOf: Date;
      filters: NormalizedListFilters;
      position: { createdAt: string; id: string } | null;
    },
  ): Promise<AgentRow[]> {
    const { asOf, filters, position } = options;
    return transaction<AgentRow[]>`
      select
        agent.id::text as agent_id,
        agent.actor_id::text,
        agent.owner_id::text,
        actor.handle::text,
        actor.display_name,
        agent.discovery_tags,
        agent.status,
        agent.restriction_reason_code,
        agent.governance_version::text,
        agent.created_at,
        agent.updated_at,
        agent.activated_at,
        agent.restricted_at,
        agent.suspended_at,
        agent.archived_at,
        count(credential.id)::text as total_credentials,
        count(credential.id) filter (
          where credential.revoked_at is null
            and (
              credential.expires_at is null
              or credential.expires_at > clock_timestamp()
            )
        )::text as active_credentials,
        count(credential.id) filter (
          where credential.revoked_at is null
            and credential.expires_at <= clock_timestamp()
        )::text as expired_credentials,
        count(credential.id) filter (
          where credential.revoked_at is not null
        )::text as revoked_credentials
      from platform.agents as agent
      join platform.actors as actor
        on actor.id = agent.actor_id
       and actor.owner_id = agent.owner_id
       and actor.kind = 'agent'
      left join platform.credentials as credential
        on credential.agent_id = agent.id
       and credential.owner_id = agent.owner_id
      where agent.created_at <= ${asOf}
        and agent.status = any(${filters.statuses})
        and (
          ${filters.query}::text is null
          or position(
            lower(${filters.query}::text)
            in lower(
              agent.id::text || ' ' || actor.handle::text || ' '
              || actor.display_name
            )
          ) > 0
        )
        and (
          ${position?.createdAt ?? null}::timestamptz is null
          or (agent.created_at, agent.id) <
            (
              ${position?.createdAt ?? null}::timestamptz,
              ${position?.id ?? null}::uuid
            )
        )
      group by agent.id, actor.id
      order by agent.created_at desc, agent.id desc
      limit ${filters.limit + 1}
    `;
  }

  async #selectAgent(
    transaction: TransactionSql,
    agentId: string,
    forUpdate: boolean,
  ): Promise<AgentRow[]> {
    const lock = forUpdate ? transaction`for update of agent, actor` : transaction``;
    return transaction<AgentRow[]>`
      select
        agent.id::text as agent_id,
        agent.actor_id::text,
        agent.owner_id::text,
        actor.handle::text,
        actor.display_name,
        agent.discovery_tags,
        agent.status,
        agent.restriction_reason_code,
        agent.governance_version::text,
        agent.created_at,
        agent.updated_at,
        agent.activated_at,
        agent.restricted_at,
        agent.suspended_at,
        agent.archived_at,
        (
          select count(*)::text
          from platform.credentials as credential
          where credential.agent_id = agent.id
        ) as total_credentials,
        (
          select count(*)::text
          from platform.credentials as credential
          where credential.agent_id = agent.id
            and credential.revoked_at is null
            and (
              credential.expires_at is null
              or credential.expires_at > clock_timestamp()
            )
        ) as active_credentials,
        (
          select count(*)::text
          from platform.credentials as credential
          where credential.agent_id = agent.id
            and credential.revoked_at is null
            and credential.expires_at <= clock_timestamp()
        ) as expired_credentials,
        (
          select count(*)::text
          from platform.credentials as credential
          where credential.agent_id = agent.id
            and credential.revoked_at is not null
        ) as revoked_credentials
      from platform.agents as agent
      join platform.actors as actor
        on actor.id = agent.actor_id
       and actor.owner_id = agent.owner_id
       and actor.kind = 'agent'
      where agent.id = ${agentId}
      ${lock}
    `;
  }

  async #recordMutation(
    transaction: TransactionSql,
    admin: AdminAgentContext,
    effective: EffectiveAuthorization,
    command: ReturnType<typeof validateActionInput>,
    before: AdminAgentSummaryView,
    mutation: AdminAgentMutation,
    digest: Buffer,
  ): Promise<void> {
    const { action, agent } = mutation;
    const authorizationSnapshot = {
      permission: action.permissionUsed,
      permissions: effective.permissions,
      roles: effective.roles,
    };
    const beforeState = {
      active_credential_count: before.credentialCounts.active,
      agent_id: before.agentId,
      governance_version: before.governanceVersion,
      restriction_reason_code: before.restrictionReasonCode,
      status: before.status,
    };
    const afterState = {
      active_credential_count: agent.credentialCounts.active,
      agent_id: agent.agentId,
      governance_version: agent.governanceVersion,
      restriction_reason_code: agent.restrictionReasonCode,
      revoked_credential_count: action.revokedCredentialCount,
      status: agent.status,
    };
    const eventType =
      action.action === "restrict_agent"
        ? "agent.restricted"
        : action.action === "suspend_agent"
          ? "agent.suspended"
          : action.action === "restore_agent"
            ? "agent.restored"
            : "agent.credentials_revoked";
    const outbox = await appendOutboxEvent(transaction, {
      aggregateId: agent.agentId,
      aggregateType: "agent",
      eventType,
      eventVersion: 1,
      occurredAt: action.occurredAt,
      payload: {
        action_id: action.actionId,
        agent_id: agent.agentId,
        governance_version: agent.governanceVersion,
        reason_code: action.reasonCode,
        revoked_credential_count: action.revokedCredentialCount,
        status: agent.status,
      },
    });
    const actionLogId = this.#newId();
    const logAction =
      action.action === "restrict_agent"
        ? "agent.restrict"
        : action.action === "suspend_agent"
          ? "agent.suspend"
          : action.action === "restore_agent"
            ? "agent.restore"
            : "credential.revoke_all";
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
        ${actionLogId}, 'governance', ${action.occurredAt}, null, null,
        ${agent.ownerId}, ${agent.agentId}, null, ${admin.adminId},
        'admin_web', 'admin_override', null, 'workforce_oidc',
        ${transaction.json(authorizationSnapshot)}, ${logAction}, 'agent',
        ${agent.agentId}, 'allow', 'succeeded', null, 0, ${outbox.id}, null,
        ${admin.requestId}, null, ${transaction.json(beforeState)},
        ${transaction.json(afterState)}, ${action.reasonCode}
      )
    `;
    await transaction`
      insert into platform.agent_admin_actions (
        id, admin_id, permission_used, action, reason_code, internal_note,
        agent_id, owner_id, governance_version_before,
        governance_version_after, revoked_credential_count, idempotency_key,
        request_digest, request_id, authorization_snapshot, before_state,
        after_state, response_snapshot, action_log_id, outbox_event_id,
        occurred_at
      )
      values (
        ${action.actionId}, ${admin.adminId}, ${action.permissionUsed},
        ${action.action}, ${action.reasonCode}, ${command.internalNote ?? null},
        ${agent.agentId}, ${agent.ownerId}, ${action.governanceVersionBefore},
        ${action.governanceVersionAfter}, ${action.revokedCredentialCount},
        ${command.idempotencyKey}, ${digest}, ${admin.requestId},
        ${transaction.json(authorizationSnapshot)},
        ${transaction.json(beforeState)}, ${transaction.json(afterState)},
        ${transaction.json(
          JSON.parse(JSON.stringify(snapshotMutation(mutation))) as postgres.JSONValue,
        )},
        ${actionLogId}, ${outbox.id}, ${action.occurredAt}
      )
    `;
  }

  async #revalidateAdmin(
    transaction: TransactionSql,
    context: AdminAgentContext,
    requiredPermission: AdminAgentActionPermission,
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
      throw new AdminAgentEnforcementError("ADMIN_PERMISSION_REQUIRED");
    }
    const permissions = sortedUnique(
      rows.map((row) => row.permission as AdminPermission),
    );
    if (
      !permissions.includes("identity:restrict") ||
      !permissions.includes(requiredPermission)
    ) {
      throw new AdminAgentEnforcementError("ADMIN_PERMISSION_REQUIRED");
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
          'alphanet:agent-admin:'
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
  ): Promise<AdminAgentMutation | null> {
    const rows = await transaction<ReplayRow[]>`
      select request_digest, response_snapshot
      from platform.agent_admin_actions
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
      throw new AdminAgentEnforcementError("IDEMPOTENCY_CONFLICT");
    }
    return restoreMutation(row.response_snapshot);
  }

  #asUnavailable(error: unknown): AdminAgentEnforcementError {
    if (error instanceof AdminAgentEnforcementError) return error;
    return new AdminAgentEnforcementError("AGENT_ENFORCEMENT_UNAVAILABLE", {
      cause: error,
    });
  }
}
