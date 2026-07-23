import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

export type OwnerAuditOutcome = "succeeded" | "pending" | "denied" | "failed";
export type OwnerAuditSearchOutcome = "started" | "succeeded" | "failed";
export type OwnerAuditSearchSurface = "rest" | "mcp" | "sdk" | "web";

export interface OwnerAuditListInput {
  action?: string | undefined;
  agentId?: string | undefined;
  credentialId?: string | undefined;
  cursor?: string | undefined;
  from?: Date | undefined;
  limit?: number | undefined;
  outcome?: OwnerAuditOutcome | undefined;
  to?: Date | undefined;
}

export interface OwnerAuditSearchListInput {
  agentId?: string | undefined;
  credentialId?: string | undefined;
  cursor?: string | undefined;
  from?: Date | undefined;
  limit?: number | undefined;
  outcome?: OwnerAuditSearchOutcome | undefined;
  surface?: OwnerAuditSearchSurface | undefined;
  to?: Date | undefined;
}

export interface OwnerAuditReadContext {
  authenticationAssurance: "email_verified_owner_session";
  requestId: string;
}

export interface OwnerAuditActorView {
  displayName: string;
  handle: string;
  id: string;
  kind: "human" | "agent";
}

export interface OwnerAuditAgentView {
  displayName: string;
  handle: string;
  id: string;
}

export interface OwnerAuditCredentialView {
  id: string;
  name: string;
  tokenPrefix: string;
}

export interface OwnerAuditActionView {
  action: string;
  actor: OwnerAuditActorView | null;
  agent: OwnerAuditAgentView | null;
  approvalMethod:
    | "policy_auto"
    | "owner_approval"
    | "owner_direct"
    | "human_direct"
    | "admin_override"
    | null;
  approvedByOwner: boolean;
  channel: string;
  credential: OwnerAuditCredentialView | null;
  decision: "allow" | "require_approval" | "deny" | null;
  errorCode: string | null;
  eventClass:
    | "domain_write"
    | "authorization_change"
    | "approval_transition"
    | "governance"
    | "sensitive_read"
    | "security_rejection";
  id: string;
  occurredAt: Date;
  outboxEventId: string | null;
  outcome: OwnerAuditOutcome;
  policyVersion: string | null;
  reasonCode: string | null;
  requestId: string;
  retryCount: number;
  target: { id: string; type: string } | null;
}

export interface OwnerAuditSearchActivityView {
  agent: OwnerAuditAgentView;
  credential: OwnerAuditCredentialView;
  expiresAt: Date;
  fallbackReasonCode: string | null;
  finalizedAt: Date | null;
  id: string;
  latencyMs: number | null;
  occurredAt: Date;
  outcome: OwnerAuditSearchOutcome;
  requestId: string;
  resultCount: number | null;
  searchMode: "lexical" | "semantic" | "hybrid";
  surface: OwnerAuditSearchSurface;
}

export interface OwnerAuditPage<T> {
  hasMore: boolean;
  items: T[];
  limit: number;
  nextCursor: string | null;
}

export interface OwnerAuditService {
  checkReady(): Promise<void>;
  listActions(
    ownerId: string,
    input: OwnerAuditListInput,
    context: OwnerAuditReadContext,
  ): Promise<OwnerAuditPage<OwnerAuditActionView>>;
  listSearchActivity(
    ownerId: string,
    input: OwnerAuditSearchListInput,
    context: OwnerAuditReadContext,
  ): Promise<OwnerAuditPage<OwnerAuditSearchActivityView>>;
}

export type OwnerAuditErrorCode =
  "OWNER_AUDIT_CURSOR_INVALID" | "OWNER_AUDIT_UNAVAILABLE";

export class OwnerAuditError extends Error {
  readonly code: OwnerAuditErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(code: OwnerAuditErrorCode) {
    super(
      code === "OWNER_AUDIT_CURSOR_INVALID"
        ? "The Owner audit cursor is invalid or no longer applicable."
        : "Owner audit is temporarily unavailable.",
    );
    this.name = "OwnerAuditError";
    this.code = code;
    this.retryable = code === "OWNER_AUDIT_UNAVAILABLE";
    this.statusCode = code === "OWNER_AUDIT_CURSOR_INVALID" ? 422 : 503;
  }
}

export interface PostgresOwnerAuditOptions {
  cursorSigningKey: Uint8Array;
  idFactory?: (() => string) | undefined;
}

interface ActionRow {
  action: string;
  actor_display_name: string | null;
  actor_handle: string | null;
  actor_id: string | null;
  actor_kind: string | null;
  agent_display_name: string | null;
  agent_handle: string | null;
  agent_id: string | null;
  approval_method: string | null;
  approved_by_owner: boolean;
  channel: string;
  credential_id: string | null;
  credential_name: string | null;
  credential_token_prefix: string | null;
  decision: string | null;
  error_code: string | null;
  event_class: string;
  id: string;
  occurred_at: Date;
  outbox_event_id: string | null;
  outcome: string;
  policy_version_text: string | null;
  reason_code: string | null;
  request_id: string;
  retry_count: number;
  target_id: string | null;
  target_type: string | null;
}

interface SearchRow {
  agent_display_name: string;
  agent_handle: string;
  agent_id: string;
  credential_id: string;
  credential_name: string;
  credential_token_prefix: string;
  expires_at: Date;
  fallback_reason_code: string | null;
  finalized_at: Date | null;
  id: string;
  latency_ms: number | null;
  occurred_at: Date;
  outcome: string;
  request_id: string;
  result_count: number | null;
  search_mode: string;
  surface: string;
}

interface CursorPosition {
  id: string;
  occurredAt: Date;
}

interface NormalizedActionFilters {
  action: string | null;
  agentId: string | null;
  credentialId: string | null;
  from: Date | null;
  limit: number;
  outcome: OwnerAuditOutcome | null;
  to: Date | null;
}

interface NormalizedSearchFilters {
  agentId: string | null;
  credentialId: string | null;
  from: Date | null;
  limit: number;
  outcome: OwnerAuditSearchOutcome | null;
  surface: OwnerAuditSearchSurface | null;
  to: Date | null;
}

interface CursorPayload {
  filters: Record<string, string | number | null>;
  id: string;
  occurred_at: string;
  owner_id: string;
  purpose: "owner-audit-actions-v1" | "owner-audit-search-v1";
  version: 1;
}

type TransactionSql = postgres.TransactionSql;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTION_PATTERN = /^[a-z][a-z0-9_.-]{0,159}$/u;
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,31}$/u;
const REQUEST_ID_MAX_LENGTH = 200;
const CURSOR_MAX_LENGTH = 2_048;
const actionOutcomes = new Set<OwnerAuditOutcome>([
  "succeeded",
  "pending",
  "denied",
  "failed",
]);
const searchOutcomes = new Set<OwnerAuditSearchOutcome>([
  "started",
  "succeeded",
  "failed",
]);
const searchSurfaces = new Set<OwnerAuditSearchSurface>(["rest", "mcp", "sdk", "web"]);
const searchModes = new Set(["lexical", "semantic", "hybrid"] as const);
const eventClasses = new Set([
  "domain_write",
  "authorization_change",
  "approval_transition",
  "governance",
  "sensitive_read",
  "security_rejection",
] as const);
const decisions = new Set(["allow", "require_approval", "deny"] as const);
const approvalMethods = new Set([
  "policy_auto",
  "owner_approval",
  "owner_direct",
  "human_direct",
  "admin_override",
] as const);

function unavailable(): OwnerAuditError {
  return new OwnerAuditError("OWNER_AUDIT_UNAVAILABLE");
}

function normalizeUuid(value: string | undefined | null): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.valueOf());
}

function validateRequestContext(context: OwnerAuditReadContext): void {
  if (
    context.authenticationAssurance !== "email_verified_owner_session" ||
    typeof context.requestId !== "string" ||
    context.requestId.trim() !== context.requestId ||
    context.requestId.length < 1 ||
    [...context.requestId].length > REQUEST_ID_MAX_LENGTH ||
    /\p{Cc}/u.test(context.requestId)
  ) {
    throw unavailable();
  }
}

function normalizeDate(value: Date | undefined): Date | null {
  if (value === undefined) return null;
  if (!validDate(value)) throw unavailable();
  return new Date(value.valueOf());
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw unavailable();
  return limit;
}

function normalizeActionFilters(input: OwnerAuditListInput): NormalizedActionFilters {
  const agentId = input.agentId === undefined ? null : normalizeUuid(input.agentId);
  const credentialId =
    input.credentialId === undefined ? null : normalizeUuid(input.credentialId);
  if (
    (input.agentId !== undefined && agentId === null) ||
    (input.credentialId !== undefined && credentialId === null) ||
    (input.action !== undefined && !ACTION_PATTERN.test(input.action)) ||
    (input.outcome !== undefined && !actionOutcomes.has(input.outcome))
  ) {
    throw unavailable();
  }
  const from = normalizeDate(input.from);
  const to = normalizeDate(input.to);
  if (from !== null && to !== null && from > to) throw unavailable();
  return {
    action: input.action ?? null,
    agentId,
    credentialId,
    from,
    limit: normalizeLimit(input.limit),
    outcome: input.outcome ?? null,
    to,
  };
}

function normalizeSearchFilters(
  input: OwnerAuditSearchListInput,
): NormalizedSearchFilters {
  const agentId = input.agentId === undefined ? null : normalizeUuid(input.agentId);
  const credentialId =
    input.credentialId === undefined ? null : normalizeUuid(input.credentialId);
  if (
    (input.agentId !== undefined && agentId === null) ||
    (input.credentialId !== undefined && credentialId === null) ||
    (input.outcome !== undefined && !searchOutcomes.has(input.outcome)) ||
    (input.surface !== undefined && !searchSurfaces.has(input.surface))
  ) {
    throw unavailable();
  }
  const from = normalizeDate(input.from);
  const to = normalizeDate(input.to);
  if (from !== null && to !== null && from > to) throw unavailable();
  return {
    agentId,
    credentialId,
    from,
    limit: normalizeLimit(input.limit),
    outcome: input.outcome ?? null,
    surface: input.surface ?? null,
    to,
  };
}

function actionFilterRecord(
  filters: NormalizedActionFilters,
): Record<string, string | number | null> {
  return {
    action: filters.action,
    agent_id: filters.agentId,
    credential_id: filters.credentialId,
    from: filters.from?.toISOString() ?? null,
    limit: filters.limit,
    outcome: filters.outcome,
    to: filters.to?.toISOString() ?? null,
  };
}

function searchFilterRecord(
  filters: NormalizedSearchFilters,
): Record<string, string | number | null> {
  return {
    agent_id: filters.agentId,
    credential_id: filters.credentialId,
    from: filters.from?.toISOString() ?? null,
    limit: filters.limit,
    outcome: filters.outcome,
    surface: filters.surface,
    to: filters.to?.toISOString() ?? null,
  };
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    keys.length === expected.length && keys.every((key, index) => key === expected[index])
  );
}

function sameFilterRecord(
  left: unknown,
  right: Record<string, string | number | null>,
): boolean {
  if (!exactRecord(left, Object.keys(right))) return false;
  return Object.entries(right).every(([key, value]) => left[key] === value);
}

function validDisplayName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    [...value].length <= 120 &&
    !/\p{Cc}/u.test(value)
  );
}

function mapAgent(
  id: string | null,
  handle: string | null,
  displayName: string | null,
): OwnerAuditAgentView | null {
  const normalizedId = normalizeUuid(id);
  if (id === null && handle === null && displayName === null) return null;
  if (
    normalizedId === null ||
    typeof handle !== "string" ||
    !HANDLE_PATTERN.test(handle) ||
    !validDisplayName(displayName)
  ) {
    throw unavailable();
  }
  return { displayName, handle, id: normalizedId };
}

function mapCredential(
  id: string | null,
  name: string | null,
  tokenPrefix: string | null,
): OwnerAuditCredentialView | null {
  const normalizedId = normalizeUuid(id);
  if (id === null && name === null && tokenPrefix === null) return null;
  if (
    normalizedId === null ||
    !validDisplayName(name) ||
    typeof tokenPrefix !== "string" ||
    tokenPrefix.length < 1 ||
    tokenPrefix.length > 32
  ) {
    throw unavailable();
  }
  return { id: normalizedId, name, tokenPrefix };
}

function mapActionRow(row: ActionRow): OwnerAuditActionView {
  const id = normalizeUuid(row.id);
  const actorId = normalizeUuid(row.actor_id);
  const actor: OwnerAuditActorView | null =
    row.actor_id === null &&
    row.actor_kind === null &&
    row.actor_handle === null &&
    row.actor_display_name === null
      ? null
      : actorId !== null &&
          (row.actor_kind === "human" || row.actor_kind === "agent") &&
          typeof row.actor_handle === "string" &&
          HANDLE_PATTERN.test(row.actor_handle) &&
          validDisplayName(row.actor_display_name)
        ? {
            displayName: row.actor_display_name,
            handle: row.actor_handle,
            id: actorId,
            kind: row.actor_kind,
          }
        : null;
  const agent = mapAgent(row.agent_id, row.agent_handle, row.agent_display_name);
  const credential = mapCredential(
    row.credential_id,
    row.credential_name,
    row.credential_token_prefix,
  );
  const outboxEventId =
    row.outbox_event_id === null ? null : normalizeUuid(row.outbox_event_id);
  if (
    id === null ||
    (row.actor_id !== null && actor === null) ||
    !eventClasses.has(row.event_class as never) ||
    typeof row.channel !== "string" ||
    row.channel.length < 1 ||
    row.channel.length > 60 ||
    !ACTION_PATTERN.test(row.action) ||
    !actionOutcomes.has(row.outcome as OwnerAuditOutcome) ||
    (row.decision !== null && !decisions.has(row.decision as never)) ||
    (row.approval_method !== null &&
      !approvalMethods.has(row.approval_method as never)) ||
    (row.target_id === null) !== (row.target_type === null) ||
    (row.target_id !== null &&
      (row.target_id.length < 1 ||
        row.target_id.length > 200 ||
        row.target_type === null ||
        row.target_type.length < 1 ||
        row.target_type.length > 80)) ||
    !validDate(row.occurred_at) ||
    typeof row.request_id !== "string" ||
    row.request_id.trim().length < 1 ||
    [...row.request_id].length > REQUEST_ID_MAX_LENGTH ||
    !Number.isSafeInteger(row.retry_count) ||
    row.retry_count < 0 ||
    (row.policy_version_text !== null &&
      !/^[1-9][0-9]*$/u.test(row.policy_version_text)) ||
    (row.outbox_event_id !== null && outboxEventId === null)
  ) {
    throw unavailable();
  }
  return {
    action: row.action,
    actor,
    agent,
    approvalMethod: row.approval_method as OwnerAuditActionView["approvalMethod"],
    approvedByOwner: row.approved_by_owner,
    channel: row.channel,
    credential,
    decision: row.decision as OwnerAuditActionView["decision"],
    errorCode: row.error_code,
    eventClass: row.event_class as OwnerAuditActionView["eventClass"],
    id,
    occurredAt: row.occurred_at,
    outboxEventId,
    outcome: row.outcome as OwnerAuditOutcome,
    policyVersion: row.policy_version_text,
    reasonCode: row.reason_code,
    requestId: row.request_id,
    retryCount: row.retry_count,
    target:
      row.target_id === null || row.target_type === null
        ? null
        : { id: row.target_id, type: row.target_type },
  };
}

function mapSearchRow(row: SearchRow): OwnerAuditSearchActivityView {
  const id = normalizeUuid(row.id);
  const agent = mapAgent(row.agent_id, row.agent_handle, row.agent_display_name);
  const credential = mapCredential(
    row.credential_id,
    row.credential_name,
    row.credential_token_prefix,
  );
  if (
    id === null ||
    agent === null ||
    credential === null ||
    !validDate(row.occurred_at) ||
    !validDate(row.expires_at) ||
    (row.finalized_at !== null && !validDate(row.finalized_at)) ||
    !searchOutcomes.has(row.outcome as OwnerAuditSearchOutcome) ||
    !searchSurfaces.has(row.surface as OwnerAuditSearchSurface) ||
    !searchModes.has(row.search_mode as never) ||
    typeof row.request_id !== "string" ||
    row.request_id.trim().length < 1 ||
    [...row.request_id].length > REQUEST_ID_MAX_LENGTH ||
    (row.result_count !== null &&
      (!Number.isSafeInteger(row.result_count) ||
        row.result_count < 0 ||
        row.result_count > 1_000)) ||
    (row.latency_ms !== null &&
      (!Number.isSafeInteger(row.latency_ms) ||
        row.latency_ms < 0 ||
        row.latency_ms > 300_000))
  ) {
    throw unavailable();
  }
  return {
    agent,
    credential,
    expiresAt: row.expires_at,
    fallbackReasonCode: row.fallback_reason_code,
    finalizedAt: row.finalized_at,
    id,
    latencyMs: row.latency_ms,
    occurredAt: row.occurred_at,
    outcome: row.outcome as OwnerAuditSearchOutcome,
    requestId: row.request_id,
    resultCount: row.result_count,
    searchMode: row.search_mode as OwnerAuditSearchActivityView["searchMode"],
    surface: row.surface as OwnerAuditSearchSurface,
  };
}

export class PostgresOwnerAuditService implements OwnerAuditService {
  readonly #cursorSigningKey: Buffer;
  readonly #idFactory: () => string;
  readonly #sql: PostgresClient;

  constructor(sql: PostgresClient, options: PostgresOwnerAuditOptions) {
    if (
      !(options.cursorSigningKey instanceof Uint8Array) ||
      options.cursorSigningKey.byteLength < 32
    ) {
      throw new TypeError(
        "The Owner audit cursor signing key must be at least 32 bytes.",
      );
    }
    this.#sql = sql;
    this.#cursorSigningKey = Buffer.from(options.cursorSigningKey);
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async checkReady(): Promise<void> {
    try {
      const rows = await this.#sql.begin(async (transaction) => {
        await transaction`set local statement_timeout = '1500ms'`;
        return transaction<{ ready: boolean }[]>`
          select
            to_regclass('platform.action_logs') is not null
            and to_regclass('platform.agent_search_activity_events') is not null
            and to_regclass('platform.action_logs_owner_occurred_idx') is not null
            and to_regclass('platform.action_logs_owner_agent_occurred_idx') is not null
            and to_regclass('platform.action_logs_owner_credential_occurred_idx') is not null
            and to_regclass('platform.action_logs_owner_action_outcome_idx') is not null
            and to_regclass('platform.agent_search_activity_events_actor_occurred_idx') is not null
              as ready
        `;
      });
      if (rows.length !== 1 || rows[0]?.ready !== true) throw unavailable();
    } catch (error) {
      if (error instanceof OwnerAuditError) throw error;
      throw unavailable();
    }
  }

  async listActions(
    ownerId: string,
    input: OwnerAuditListInput,
    context: OwnerAuditReadContext,
  ): Promise<OwnerAuditPage<OwnerAuditActionView>> {
    const normalizedOwnerId = normalizeUuid(ownerId);
    if (normalizedOwnerId === null) throw unavailable();
    validateRequestContext(context);
    const filters = normalizeActionFilters(input);
    const cursor =
      input.cursor === undefined
        ? null
        : this.#decodeCursor(
            input.cursor,
            normalizedOwnerId,
            "owner-audit-actions-v1",
            actionFilterRecord(filters),
          );
    try {
      return await this.#sql.begin(async (transaction) => {
        await transaction`set local statement_timeout = '5s'`;
        const rows = await transaction<ActionRow[]>`
          select
            log.id,
            log.event_class,
            log.occurred_at,
            log.actor_id,
            log.actor_kind,
            actor.handle::text as actor_handle,
            actor.display_name as actor_display_name,
            log.agent_id,
            agent_actor.handle::text as agent_handle,
            agent_actor.display_name as agent_display_name,
            log.credential_id,
            credential.name as credential_name,
            credential.token_prefix as credential_token_prefix,
            log.channel,
            log.action,
            log.target_type,
            log.target_id,
            log.decision,
            log.outcome,
            log.error_code,
            log.reason_code,
            log.policy_version::text as policy_version_text,
            log.approval_method,
            (
              log.approved_by_owner_id is not null
              and log.approved_by_owner_id = log.owner_id
            ) as approved_by_owner,
            log.request_id,
            log.outbox_event_id,
            log.retry_count
          from platform.action_logs as log
          left join platform.actors as actor
            on actor.id = log.actor_id
           and actor.owner_id = log.owner_id
          left join platform.agents as agent
            on agent.id = log.agent_id
           and agent.owner_id = log.owner_id
          left join platform.actors as agent_actor
            on agent_actor.id = agent.actor_id
           and agent_actor.owner_id = agent.owner_id
          left join platform.credentials as credential
            on credential.id = log.credential_id
           and credential.owner_id = log.owner_id
           and credential.agent_id = log.agent_id
          where log.owner_id = ${normalizedOwnerId}
            and (
              ${filters.agentId}::uuid is null
              or log.agent_id = ${filters.agentId}::uuid
            )
            and (
              ${filters.credentialId}::uuid is null
              or log.credential_id = ${filters.credentialId}::uuid
            )
            and (
              ${filters.action}::text is null
              or log.action = ${filters.action}::text
            )
            and (
              ${filters.outcome}::text is null
              or log.outcome = ${filters.outcome}::text
            )
            and (
              ${filters.from}::timestamptz is null
              or log.occurred_at >= ${filters.from}::timestamptz
            )
            and (
              ${filters.to}::timestamptz is null
              or log.occurred_at <= ${filters.to}::timestamptz
            )
            and (
              ${cursor?.occurredAt ?? null}::timestamptz is null
              or (log.occurred_at, log.id) < (
                ${cursor?.occurredAt ?? null}::timestamptz,
                ${cursor?.id ?? null}::uuid
              )
            )
          order by log.occurred_at desc, log.id desc
          limit ${filters.limit + 1}
        `;
        const page = this.#page(
          rows,
          filters.limit,
          normalizedOwnerId,
          "owner-audit-actions-v1",
          actionFilterRecord(filters),
          mapActionRow,
        );
        await this.#writeReadAudit(transaction, {
          action: "owner.audit.actions.read",
          context,
          ownerId: normalizedOwnerId,
          targetType: "owner_audit_actions",
        });
        return page;
      });
    } catch (error) {
      if (error instanceof OwnerAuditError) throw error;
      throw unavailable();
    }
  }

  async listSearchActivity(
    ownerId: string,
    input: OwnerAuditSearchListInput,
    context: OwnerAuditReadContext,
  ): Promise<OwnerAuditPage<OwnerAuditSearchActivityView>> {
    const normalizedOwnerId = normalizeUuid(ownerId);
    if (normalizedOwnerId === null) throw unavailable();
    validateRequestContext(context);
    const filters = normalizeSearchFilters(input);
    const cursor =
      input.cursor === undefined
        ? null
        : this.#decodeCursor(
            input.cursor,
            normalizedOwnerId,
            "owner-audit-search-v1",
            searchFilterRecord(filters),
          );
    try {
      return await this.#sql.begin(async (transaction) => {
        await transaction`set local statement_timeout = '5s'`;
        const rows = await transaction<SearchRow[]>`
          select
            activity.id,
            activity.occurred_at,
            activity.finalized_at,
            activity.expires_at,
            activity.request_id,
            agent.id as agent_id,
            actor.handle::text as agent_handle,
            actor.display_name as agent_display_name,
            credential.id as credential_id,
            credential.name as credential_name,
            credential.token_prefix as credential_token_prefix,
            activity.surface,
            activity.search_mode,
            activity.outcome,
            activity.result_count,
            activity.latency_ms,
            activity.fallback_reason_code
          from platform.agent_search_activity_events as activity
          inner join platform.agents as agent
            on agent.id = activity.agent_id
           and agent.actor_id = activity.actor_id
          inner join platform.actors as actor
            on actor.id = agent.actor_id
           and actor.owner_id = agent.owner_id
          inner join platform.credentials as credential
            on credential.id = activity.credential_id
           and credential.agent_id = activity.agent_id
           and credential.owner_id = agent.owner_id
          where agent.owner_id = ${normalizedOwnerId}
            and (
              ${filters.agentId}::uuid is null
              or activity.agent_id = ${filters.agentId}::uuid
            )
            and (
              ${filters.credentialId}::uuid is null
              or activity.credential_id = ${filters.credentialId}::uuid
            )
            and (
              ${filters.outcome}::text is null
              or activity.outcome = ${filters.outcome}::text
            )
            and (
              ${filters.surface}::text is null
              or activity.surface = ${filters.surface}::text
            )
            and (
              ${filters.from}::timestamptz is null
              or activity.occurred_at >= ${filters.from}::timestamptz
            )
            and (
              ${filters.to}::timestamptz is null
              or activity.occurred_at <= ${filters.to}::timestamptz
            )
            and (
              ${cursor?.occurredAt ?? null}::timestamptz is null
              or (activity.occurred_at, activity.id) < (
                ${cursor?.occurredAt ?? null}::timestamptz,
                ${cursor?.id ?? null}::uuid
              )
            )
          order by activity.occurred_at desc, activity.id desc
          limit ${filters.limit + 1}
        `;
        const page = this.#page(
          rows,
          filters.limit,
          normalizedOwnerId,
          "owner-audit-search-v1",
          searchFilterRecord(filters),
          mapSearchRow,
        );
        await this.#writeReadAudit(transaction, {
          action: "owner.audit.search_activity.read",
          context,
          ownerId: normalizedOwnerId,
          targetType: "owner_search_activity",
        });
        return page;
      });
    } catch (error) {
      if (error instanceof OwnerAuditError) throw error;
      throw unavailable();
    }
  }

  #page<Row extends { id: string; occurred_at: Date }, View>(
    rows: Row[],
    limit: number,
    ownerId: string,
    purpose: CursorPayload["purpose"],
    filters: Record<string, string | number | null>,
    mapper: (row: Row) => View,
  ): OwnerAuditPage<View> {
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    const items = visible.map(mapper);
    const last = visible.at(-1);
    return {
      hasMore,
      items,
      limit,
      nextCursor:
        hasMore && last
          ? this.#encodeCursor(ownerId, purpose, filters, {
              id: last.id,
              occurredAt: last.occurred_at,
            })
          : null,
    };
  }

  #encodeCursor(
    ownerId: string,
    purpose: CursorPayload["purpose"],
    filters: Record<string, string | number | null>,
    position: CursorPosition,
  ): string {
    const id = normalizeUuid(position.id);
    if (id === null || !validDate(position.occurredAt)) throw unavailable();
    const payload: CursorPayload = {
      filters,
      id,
      occurred_at: position.occurredAt.toISOString(),
      owner_id: ownerId,
      purpose,
      version: 1,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = this.#mac(purpose, encoded).toString("base64url");
    return `${encoded}.${signature}`;
  }

  #decodeCursor(
    cursor: string,
    ownerId: string,
    purpose: CursorPayload["purpose"],
    filters: Record<string, string | number | null>,
  ): CursorPosition {
    try {
      if (
        typeof cursor !== "string" ||
        cursor.length < 16 ||
        cursor.length > CURSOR_MAX_LENGTH
      ) {
        throw new Error("invalid");
      }
      const parts = cursor.split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid");
      const [encoded, encodedSignature] = parts;
      const signature = Buffer.from(encodedSignature, "base64url");
      const expected = this.#mac(purpose, encoded);
      if (
        signature.toString("base64url") !== encodedSignature ||
        signature.length !== expected.length ||
        !timingSafeEqual(signature, expected)
      ) {
        throw new Error("invalid");
      }
      const decoded = Buffer.from(encoded, "base64url");
      if (decoded.toString("base64url") !== encoded) throw new Error("invalid");
      const payload = JSON.parse(decoded.toString("utf8")) as unknown;
      if (
        !exactRecord(payload, [
          "filters",
          "id",
          "occurred_at",
          "owner_id",
          "purpose",
          "version",
        ]) ||
        payload["version"] !== 1 ||
        payload["purpose"] !== purpose ||
        normalizeUuid(payload["owner_id"] as string) !== ownerId ||
        !sameFilterRecord(payload["filters"], filters)
      ) {
        throw new Error("invalid");
      }
      const id = normalizeUuid(payload["id"] as string);
      const occurredAt = new Date(payload["occurred_at"] as string);
      if (
        id === null ||
        !validDate(occurredAt) ||
        occurredAt.toISOString() !== payload["occurred_at"]
      ) {
        throw new Error("invalid");
      }
      return { id, occurredAt };
    } catch {
      throw new OwnerAuditError("OWNER_AUDIT_CURSOR_INVALID");
    }
  }

  #mac(purpose: CursorPayload["purpose"], encoded: string): Buffer {
    return createHmac("sha256", this.#cursorSigningKey)
      .update(purpose, "utf8")
      .update("\0", "utf8")
      .update(encoded, "ascii")
      .digest();
  }

  async #writeReadAudit(
    transaction: TransactionSql,
    input: {
      action: string;
      context: OwnerAuditReadContext;
      ownerId: string;
      targetType: string;
    },
  ): Promise<void> {
    const auditId = normalizeUuid(this.#idFactory());
    if (auditId === null) throw unavailable();
    await transaction`
      insert into platform.action_logs (
        id,
        event_class,
        owner_id,
        channel,
        authentication_assurance,
        authorization_snapshot,
        action,
        target_type,
        target_id,
        decision,
        outcome,
        request_id
      )
      values (
        ${auditId},
        'sensitive_read',
        ${input.ownerId},
        'web',
        ${input.context.authenticationAssurance},
        ${transaction.json({ owner_session: true, resource: input.targetType })},
        ${input.action},
        ${input.targetType},
        ${input.ownerId},
        'allow',
        'succeeded',
        ${input.context.requestId}
      )
    `;
  }
}
