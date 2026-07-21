import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { appendOutboxEvent, type PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import {
  decryptPendingCommand,
  type PendingCommandKeyRing,
} from "./pending-command-codec.js";
import {
  PENDING_ACTION_STATES,
  type PendingActionApprovalOutcome,
  type PendingActionState,
} from "./pending-action.js";
import type { NormalizedResearchCommand } from "./research-command.js";
import { PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM } from "./schema-migrations.js";

export type OwnerPendingActionOperation = NormalizedResearchCommand["operation"];
export type OwnerPendingActionDecisionReason =
  | "owner_approved"
  | "owner_rejected"
  | "needs_revision"
  | "insufficient_evidence"
  | "risk_not_accepted"
  | "no_longer_needed";

export interface OwnerPendingActionAgentView {
  displayName: string;
  handle: string;
  id: string;
  status: "active" | "archived" | "draft" | "restricted" | "suspended";
}

export interface OwnerPendingActionSummaryView {
  agent: OwnerPendingActionAgentView;
  approvalSummary: string;
  expiresAt: Date;
  id: string;
  operation: OwnerPendingActionOperation;
  requestedAt: Date;
  state: PendingActionState;
  target: {
    id: string;
    type: "community" | "content";
  };
  updatedAt: Date;
  version: number;
}

export interface OwnerPendingActionPublicError {
  code:
    | "ACTION_REJECTED"
    | "ACTION_EXPIRED"
    | "ACTION_CANCELLED"
    | "ACTION_EXECUTION_FAILED"
    | "ACTION_INVALIDATED";
  details: null;
  message: string;
  retryAfterMs: null;
  retryable: false;
}

export interface OwnerPendingActionDetailView extends OwnerPendingActionSummaryView {
  approvalOutcome: PendingActionApprovalOutcome | null;
  command: NormalizedResearchCommand;
  decidedAt: Date | null;
  decisionId: string;
  decisionReasonCode: OwnerPendingActionDecisionReason | null;
  inputDigest: string;
  policyVersion: string;
  publicError: OwnerPendingActionPublicError | null;
  terminalAt: Date | null;
}

export interface OwnerPendingActionListInput {
  agentId?: string | undefined;
  cursor?: string | null | undefined;
  limit?: number | undefined;
  operations?: readonly OwnerPendingActionOperation[] | undefined;
  states?: readonly PendingActionState[] | undefined;
}

export interface OwnerPendingActionPage {
  hasMore: boolean;
  items: OwnerPendingActionSummaryView[];
  limit: number;
  nextCursor: string | null;
}

export interface OwnerPendingActionReadContext {
  requestId: string;
}

export interface OwnerPendingActionDecisionInput {
  expectedVersion: number;
  reasonCode: OwnerPendingActionDecisionReason;
  requestId: string;
}

export type OwnerPendingActionErrorCode =
  | "ACTION_DECISION_CONFLICT"
  | "ACTION_NOT_FOUND"
  | "ACTION_VERSION_CONFLICT"
  | "OWNER_ACTION_CURSOR_INVALID"
  | "OWNER_ACTION_UNAVAILABLE";

const ownerPendingActionErrors = {
  ACTION_DECISION_CONFLICT: {
    message: "The action can no longer accept this decision.",
    retryable: false,
    statusCode: 409,
  },
  ACTION_NOT_FOUND: {
    message: "The requested action was not found.",
    retryable: false,
    statusCode: 404,
  },
  ACTION_VERSION_CONFLICT: {
    message: "The action changed before this decision was applied.",
    retryable: false,
    statusCode: 409,
  },
  OWNER_ACTION_CURSOR_INVALID: {
    message: "The Owner action cursor is invalid or no longer applicable.",
    retryable: false,
    statusCode: 422,
  },
  OWNER_ACTION_UNAVAILABLE: {
    message: "Owner action operations are temporarily unavailable.",
    retryable: true,
    statusCode: 503,
  },
} as const satisfies Record<
  OwnerPendingActionErrorCode,
  { message: string; retryable: boolean; statusCode: number }
>;

export class OwnerPendingActionError extends Error {
  readonly code: OwnerPendingActionErrorCode;
  readonly currentState: PendingActionState | null;
  readonly currentVersion: number | null;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    code: OwnerPendingActionErrorCode,
    options: {
      currentState?: PendingActionState | null | undefined;
      currentVersion?: number | null | undefined;
    } = {},
  ) {
    const definition = ownerPendingActionErrors[code];
    super(definition.message);
    this.name = "OwnerPendingActionError";
    this.code = code;
    this.currentState = options.currentState ?? null;
    this.currentVersion = options.currentVersion ?? null;
    this.retryable = definition.retryable;
    this.statusCode = definition.statusCode;
  }
}

export interface OwnerPendingActionService {
  approveAction(
    ownerId: string,
    actionId: string,
    input: OwnerPendingActionDecisionInput & { reasonCode: "owner_approved" },
  ): Promise<OwnerPendingActionDetailView>;
  checkReady(): Promise<void>;
  getAction(
    ownerId: string,
    actionId: string,
    context: OwnerPendingActionReadContext,
  ): Promise<OwnerPendingActionDetailView>;
  listActions(
    ownerId: string,
    input: OwnerPendingActionListInput,
  ): Promise<OwnerPendingActionPage>;
  rejectAction(
    ownerId: string,
    actionId: string,
    input: OwnerPendingActionDecisionInput & {
      reasonCode: Exclude<OwnerPendingActionDecisionReason, "owner_approved">;
    },
  ): Promise<OwnerPendingActionDetailView>;
}

export interface PostgresOwnerPendingActionOptions {
  clock?: (() => Date) | undefined;
  cursorSigningKey: Uint8Array;
  idFactory?: (() => string) | undefined;
  pendingActionKeyRing: PendingCommandKeyRing;
}

type TransactionSql = postgres.TransactionSql;

interface SummaryRow {
  agent_display_name: string;
  agent_handle: string;
  agent_id: string;
  agent_status: string;
  approval_summary: string;
  expires_at: Date;
  id: string;
  operation: string;
  requested_at: Date;
  state: string;
  target_id: string | null;
  target_type: string | null;
  updated_at: Date;
  version_text: string;
}

interface DetailRow extends SummaryRow {
  approval_method: string | null;
  attempt_count: number;
  completed_at: Date | null;
  credential_id: string;
  decided_at: Date | null;
  decided_by_owner_id: string | null;
  decision_id: string;
  decision_reason_code: string | null;
  error: unknown;
  executing_at: Date | null;
  failure_count: number;
  has_result: boolean;
  idempotency_record_id: string;
  input_digest_text: string;
  lease_shape_valid: boolean;
  normalized_input_ciphertext: Buffer;
  normalized_input_format_version: number;
  normalized_input_key_version: number;
  normalized_input_nonce: Buffer;
  owner_id: string;
  policy_version_text: string;
  terminal_at: Date | null;
}

interface DecisionRow extends DetailRow {
  database_now: Date;
  owner_email_verified: boolean;
  owner_status: string;
}

interface DecisionUpdateRow {
  decided_at: Date | null;
  decision_reason_code: string | null;
  error: unknown;
  state: string;
  terminal_at: Date | null;
  updated_at: Date;
  version_text: string;
}

interface CursorPayload {
  filters: {
    agent_id: string | null;
    limit: number;
    operations: OwnerPendingActionOperation[];
    states: PendingActionState[];
  };
  id: string;
  owner_id: string;
  purpose: typeof CURSOR_PURPOSE;
  requested_at: string;
  version: 1;
}

interface NormalizedListFilters {
  agentId: string | null;
  limit: number;
  operations: OwnerPendingActionOperation[];
  states: PendingActionState[];
}

interface CursorPosition {
  id: string;
  requestedAt: Date;
}

const CURSOR_PURPOSE = "alphanet.owner-pending-actions.cursor.v1";
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const MAX_CURSOR_LENGTH = 4_096;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;
const operationValues = ["create_post", "reply_to_content"] as const;
const operationSet = new Set<string>(operationValues);
const stateSet = new Set<string>(PENDING_ACTION_STATES);
const agentStatusSet = new Set<string>([
  "active",
  "archived",
  "draft",
  "restricted",
  "suspended",
]);
const decisionReasonSet = new Set<string>([
  "owner_approved",
  "owner_rejected",
  "needs_revision",
  "insufficient_evidence",
  "risk_not_accepted",
  "no_longer_needed",
]);
const rejectionReasonSet = new Set<string>([
  "owner_rejected",
  "needs_revision",
  "insufficient_evidence",
  "risk_not_accepted",
  "no_longer_needed",
]);
const terminalStates = new Set<PendingActionState>([
  "succeeded",
  "rejected",
  "expired",
  "cancelled",
  "failed",
  "invalidated",
]);

const terminalErrorDefinitions = {
  rejected: {
    code: "ACTION_REJECTED",
    message: "The Owner rejected this action.",
  },
  expired: {
    code: "ACTION_EXPIRED",
    message: "The action expired before it could be completed.",
  },
  cancelled: {
    code: "ACTION_CANCELLED",
    message: "The action was cancelled.",
  },
  failed: {
    code: "ACTION_EXECUTION_FAILED",
    message: "The approved action could not be completed.",
  },
  invalidated: {
    code: "ACTION_INVALIDATED",
    message: "The frozen action is no longer valid.",
  },
} as const;

const rejectedDatabaseError = {
  code: "ACTION_REJECTED",
  message: "The Owner rejected this action.",
  retryable: false,
  details: null,
  retry_after_ms: null,
} as const;

const rejectedReplayError = {
  code: "ACTION_REJECTED",
  message: "The Owner rejected this action.",
  retryable: false,
  details: null,
  retryAfterMs: null,
} as const;

function unavailable(): OwnerPendingActionError {
  return new OwnerPendingActionError("OWNER_ACTION_UNAVAILABLE");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isNullableDate(value: unknown): value is Date | null {
  return value === null || isValidDate(value);
}

function normalizeUuid(value: string): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

function parsePositiveSafeInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string" || !POSITIVE_DECIMAL_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function assertRequestId(requestId: string): void {
  if (
    typeof requestId !== "string" ||
    requestId.trim().length < 1 ||
    [...requestId].length > 200 ||
    /\p{Cc}/u.test(requestId)
  ) {
    throw unavailable();
  }
}

function assertActionArguments(
  ownerId: string,
  actionId: string,
): {
  actionId: string;
  ownerId: string;
} {
  const normalizedOwnerId = normalizeUuid(ownerId);
  const normalizedActionId = normalizeUuid(actionId);
  if (normalizedOwnerId === null || normalizedActionId === null) {
    throw new OwnerPendingActionError("ACTION_NOT_FOUND");
  }
  return { actionId: normalizedActionId, ownerId: normalizedOwnerId };
}

function parseState(value: unknown): PendingActionState {
  if (typeof value !== "string" || !stateSet.has(value)) throw unavailable();
  return value as PendingActionState;
}

function parseOperation(value: unknown): OwnerPendingActionOperation {
  if (typeof value !== "string" || !operationSet.has(value)) throw unavailable();
  return value as OwnerPendingActionOperation;
}

function parseDecisionReason(value: unknown): OwnerPendingActionDecisionReason | null {
  if (value === null) return null;
  if (typeof value !== "string" || !decisionReasonSet.has(value)) throw unavailable();
  return value as OwnerPendingActionDecisionReason;
}

function parsePublicError(
  state: PendingActionState,
  value: unknown,
): OwnerPendingActionPublicError | null {
  const definition =
    state === "rejected" ||
    state === "expired" ||
    state === "cancelled" ||
    state === "failed" ||
    state === "invalidated"
      ? terminalErrorDefinitions[state]
      : null;
  if (definition === null) {
    if (value !== null) throw unavailable();
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["code", "details", "message", "retry_after_ms", "retryable"]) ||
    value.code !== definition.code ||
    value.message !== definition.message ||
    value.retryable !== false ||
    value.details !== null ||
    value.retry_after_ms !== null
  ) {
    throw unavailable();
  }
  return {
    code: definition.code,
    details: null,
    message: definition.message,
    retryAfterMs: null,
    retryable: false,
  };
}

function approvalOutcome(
  state: PendingActionState,
  decidedAt: Date | null,
): PendingActionApprovalOutcome | null {
  switch (state) {
    case "pending_approval":
      return null;
    case "approved":
    case "executing":
    case "succeeded":
    case "failed":
      return "approved";
    case "rejected":
      return "rejected";
    case "cancelled":
      return "cancelled";
    case "expired":
      return decidedAt === null ? "expired" : "approved";
    case "invalidated":
      return decidedAt === null ? "invalidated" : "approved";
  }
}

function mapSummaryRow(row: SummaryRow): OwnerPendingActionSummaryView {
  const id = normalizeUuid(row.id);
  const agentId = normalizeUuid(row.agent_id);
  const targetId = row.target_id === null ? null : normalizeUuid(row.target_id);
  const operation = parseOperation(row.operation);
  const state = parseState(row.state);
  const version = parsePositiveSafeInteger(row.version_text);
  if (
    id === null ||
    agentId === null ||
    targetId === null ||
    version === null ||
    (row.target_type !== "community" && row.target_type !== "content") ||
    (operation === "create_post" && row.target_type !== "community") ||
    (operation === "reply_to_content" && row.target_type !== "content") ||
    typeof row.agent_handle !== "string" ||
    !/^[a-z0-9][a-z0-9_.-]{2,31}$/u.test(row.agent_handle) ||
    typeof row.agent_display_name !== "string" ||
    row.agent_display_name.trim().length < 1 ||
    [...row.agent_display_name].length > 120 ||
    /\p{Cc}/u.test(row.agent_display_name) ||
    typeof row.agent_status !== "string" ||
    !agentStatusSet.has(row.agent_status) ||
    typeof row.approval_summary !== "string" ||
    row.approval_summary.trim() !== row.approval_summary ||
    row.approval_summary.length < 1 ||
    [...row.approval_summary].length > 2_000 ||
    /\p{Cc}/u.test(row.approval_summary) ||
    !isValidDate(row.requested_at) ||
    !isValidDate(row.expires_at) ||
    !isValidDate(row.updated_at) ||
    row.expires_at.getTime() <= row.requested_at.getTime() ||
    row.updated_at.getTime() < row.requested_at.getTime()
  ) {
    throw unavailable();
  }
  return {
    agent: {
      displayName: row.agent_display_name,
      handle: row.agent_handle,
      id: agentId,
      status: row.agent_status as OwnerPendingActionAgentView["status"],
    },
    approvalSummary: row.approval_summary,
    expiresAt: row.expires_at,
    id,
    operation,
    requestedAt: row.requested_at,
    state,
    target: { id: targetId, type: row.target_type },
    updatedAt: row.updated_at,
    version,
  };
}

function validateLifecycle(
  row: DetailRow,
  summary: OwnerPendingActionSummaryView,
): {
  approvalOutcome: PendingActionApprovalOutcome | null;
  decidedAt: Date | null;
  decisionReason: OwnerPendingActionDecisionReason | null;
  publicError: OwnerPendingActionPublicError | null;
  terminalAt: Date | null;
} {
  if (
    !isNullableDate(row.decided_at) ||
    !isNullableDate(row.executing_at) ||
    !isNullableDate(row.completed_at) ||
    !isNullableDate(row.terminal_at) ||
    !Number.isSafeInteger(row.attempt_count) ||
    row.attempt_count < 0 ||
    row.attempt_count > 2_000_000_000 ||
    !Number.isSafeInteger(row.failure_count) ||
    row.failure_count < 0 ||
    row.failure_count > 20 ||
    row.failure_count > row.attempt_count ||
    typeof row.has_result !== "boolean" ||
    row.lease_shape_valid !== true
  ) {
    throw unavailable();
  }
  const decisionReason = parseDecisionReason(row.decision_reason_code);
  const hasOwnerEvidence =
    row.decided_at !== null &&
    row.approval_method === "owner_approval" &&
    row.decided_by_owner_id === row.owner_id;
  const hasNoOwnerEvidence =
    row.decided_at === null &&
    row.approval_method === null &&
    row.decided_by_owner_id === null;
  if (!hasOwnerEvidence && !hasNoOwnerEvidence) throw unavailable();
  if ((decisionReason !== null) !== hasOwnerEvidence) throw unavailable();

  const timestamps = [
    row.decided_at,
    row.executing_at,
    row.completed_at,
    row.terminal_at,
  ];
  if (
    timestamps.some(
      (value) => value !== null && value.getTime() < summary.requestedAt.getTime(),
    ) ||
    (row.completed_at !== null &&
      (row.executing_at === null ||
        row.completed_at.getTime() < row.executing_at.getTime())) ||
    (row.terminal_at !== null &&
      row.completed_at !== null &&
      row.terminal_at.getTime() < row.completed_at.getTime())
  ) {
    throw unavailable();
  }

  const terminal = terminalStates.has(summary.state);
  if (terminal !== (row.terminal_at !== null)) throw unavailable();
  const publicError = parsePublicError(summary.state, row.error);
  switch (summary.state) {
    case "pending_approval":
      if (
        !hasNoOwnerEvidence ||
        row.executing_at !== null ||
        row.completed_at !== null ||
        row.attempt_count !== 0 ||
        row.failure_count !== 0 ||
        row.has_result ||
        publicError !== null
      ) {
        throw unavailable();
      }
      break;
    case "approved":
      if (
        !hasOwnerEvidence ||
        decisionReason !== "owner_approved" ||
        row.executing_at !== null ||
        row.completed_at !== null ||
        row.has_result ||
        publicError !== null
      ) {
        throw unavailable();
      }
      break;
    case "executing":
      if (
        !hasOwnerEvidence ||
        decisionReason !== "owner_approved" ||
        row.executing_at === null ||
        row.completed_at !== null ||
        row.attempt_count < 1 ||
        row.has_result ||
        publicError !== null
      ) {
        throw unavailable();
      }
      break;
    case "succeeded":
      if (
        !hasOwnerEvidence ||
        decisionReason !== "owner_approved" ||
        row.executing_at === null ||
        row.completed_at === null ||
        row.attempt_count < 1 ||
        !row.has_result ||
        publicError !== null
      ) {
        throw unavailable();
      }
      break;
    case "failed":
      if (
        !hasOwnerEvidence ||
        decisionReason !== "owner_approved" ||
        row.executing_at === null ||
        row.completed_at === null ||
        row.attempt_count < 1 ||
        row.has_result ||
        publicError === null
      ) {
        throw unavailable();
      }
      break;
    case "rejected":
      if (
        !hasOwnerEvidence ||
        decisionReason === null ||
        !rejectionReasonSet.has(decisionReason) ||
        row.executing_at !== null ||
        row.completed_at !== null ||
        row.attempt_count !== 0 ||
        row.failure_count !== 0 ||
        row.has_result ||
        publicError === null
      ) {
        throw unavailable();
      }
      break;
    case "cancelled":
      if (
        !hasOwnerEvidence ||
        (decisionReason !== "owner_approved" && decisionReason !== "no_longer_needed") ||
        row.executing_at !== null ||
        row.completed_at !== null ||
        row.attempt_count !== 0 ||
        row.failure_count !== 0 ||
        row.has_result ||
        publicError === null
      ) {
        throw unavailable();
      }
      break;
    case "expired":
    case "invalidated":
      if (
        (!hasNoOwnerEvidence &&
          (!hasOwnerEvidence || decisionReason !== "owner_approved")) ||
        row.executing_at !== null ||
        row.completed_at !== null ||
        row.has_result ||
        publicError === null
      ) {
        throw unavailable();
      }
      break;
  }
  return {
    approvalOutcome: approvalOutcome(summary.state, row.decided_at),
    decidedAt: row.decided_at,
    decisionReason,
    publicError,
    terminalAt: row.terminal_at,
  };
}

function mapDetailRow(
  row: DetailRow,
  keyRing: PendingCommandKeyRing,
): OwnerPendingActionDetailView {
  const summary = mapSummaryRow(row);
  const ownerId = normalizeUuid(row.owner_id);
  const credentialId = normalizeUuid(row.credential_id);
  const idempotencyRecordId = normalizeUuid(row.idempotency_record_id);
  const decisionId = normalizeUuid(row.decision_id);
  const policyVersion =
    typeof row.policy_version_text === "string" &&
    POSITIVE_DECIMAL_PATTERN.test(row.policy_version_text)
      ? row.policy_version_text
      : null;
  if (
    ownerId === null ||
    credentialId === null ||
    idempotencyRecordId === null ||
    decisionId === null ||
    policyVersion === null ||
    !/^sha256:[0-9a-f]{64}$/u.test(row.input_digest_text) ||
    !Buffer.isBuffer(row.normalized_input_ciphertext) ||
    !Buffer.isBuffer(row.normalized_input_nonce) ||
    !Number.isSafeInteger(row.normalized_input_key_version) ||
    row.normalized_input_key_version < 1 ||
    !Number.isSafeInteger(row.normalized_input_format_version) ||
    row.normalized_input_format_version < 1
  ) {
    throw unavailable();
  }
  const lifecycle = validateLifecycle(row, summary);
  let command: NormalizedResearchCommand;
  try {
    command = decryptPendingCommand(
      {
        ciphertext: Buffer.from(row.normalized_input_ciphertext),
        formatVersion: row.normalized_input_format_version,
        keyVersion: row.normalized_input_key_version,
        nonce: Buffer.from(row.normalized_input_nonce),
      },
      {
        actionId: summary.id,
        agentId: summary.agent.id,
        credentialId,
        inputDigest: row.input_digest_text,
        operation: summary.operation,
        ownerId,
      },
      keyRing,
    );
  } catch {
    throw unavailable();
  }
  const commandTargetId =
    command.operation === "create_post"
      ? command.primaryCommunityId
      : command.parentContentId;
  if (normalizeUuid(commandTargetId) !== summary.target.id) throw unavailable();
  return {
    ...summary,
    approvalOutcome: lifecycle.approvalOutcome,
    command,
    decidedAt: lifecycle.decidedAt,
    decisionId,
    decisionReasonCode: lifecycle.decisionReason,
    inputDigest: row.input_digest_text,
    policyVersion,
    publicError: lifecycle.publicError,
    terminalAt: lifecycle.terminalAt,
  };
}

function jsonForReplay(view: OwnerPendingActionDetailView): postgres.JSONValue {
  return {
    version: 1,
    operation: view.operation,
    decision: "require_approval",
    status:
      view.state === "succeeded"
        ? "succeeded"
        : view.state === "rejected" ||
            view.state === "expired" ||
            view.state === "cancelled"
          ? "denied"
          : view.state === "failed" || view.state === "invalidated"
            ? "failed"
            : "pending_approval",
    result: null,
    pending_action: {
      id: view.id,
      operation: view.operation,
      state: view.state,
      expires_at: view.expiresAt.toISOString(),
      input_digest: view.inputDigest,
      requested_at: view.requestedAt.toISOString(),
      decision_id: view.decisionId,
      policy_version: view.policyVersion,
      approval_summary: view.approvalSummary,
    },
    error: view.state === "rejected" ? rejectedReplayError : null,
  };
}

function canonicalFilters(filters: NormalizedListFilters): CursorPayload["filters"] {
  return {
    agent_id: filters.agentId,
    limit: filters.limit,
    operations: [...filters.operations],
    states: [...filters.states],
  };
}

function normalizeListFilters(input: OwnerPendingActionListInput): NormalizedListFilters {
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new OwnerPendingActionError("OWNER_ACTION_CURSOR_INVALID");
  }
  const agentId = input.agentId === undefined ? null : normalizeUuid(input.agentId);
  if (input.agentId !== undefined && agentId === null) {
    throw new OwnerPendingActionError("OWNER_ACTION_CURSOR_INVALID");
  }
  const rawOperations = input.operations ?? operationValues;
  const rawStates = input.states ?? (["pending_approval"] as const);
  if (
    rawOperations.length < 1 ||
    rawStates.length < 1 ||
    rawOperations.some((value) => !operationSet.has(value)) ||
    rawStates.some((value) => !stateSet.has(value))
  ) {
    throw new OwnerPendingActionError("OWNER_ACTION_CURSOR_INVALID");
  }
  return {
    agentId,
    limit,
    operations: [...new Set(rawOperations)].sort(),
    states: [...new Set(rawStates)].sort(),
  };
}

function payloadHasExactShape(value: unknown): value is CursorPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "filters",
      "id",
      "owner_id",
      "purpose",
      "requested_at",
      "version",
    ]) ||
    value.version !== 1 ||
    value.purpose !== CURSOR_PURPOSE ||
    typeof value.owner_id !== "string" ||
    typeof value.id !== "string" ||
    typeof value.requested_at !== "string" ||
    !isRecord(value.filters) ||
    !hasExactKeys(value.filters, ["agent_id", "limit", "operations", "states"]) ||
    (value.filters.agent_id !== null && typeof value.filters.agent_id !== "string") ||
    !Number.isSafeInteger(value.filters.limit) ||
    !Array.isArray(value.filters.operations) ||
    !value.filters.operations.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.filters.states) ||
    !value.filters.states.every((entry) => typeof entry === "string")
  ) {
    return false;
  }
  return true;
}

function sameFilters(
  left: CursorPayload["filters"],
  right: CursorPayload["filters"],
): boolean {
  return (
    left.agent_id === right.agent_id &&
    left.limit === right.limit &&
    left.operations.length === right.operations.length &&
    left.operations.every((value, index) => value === right.operations[index]) &&
    left.states.length === right.states.length &&
    left.states.every((value, index) => value === right.states[index])
  );
}

function viewWithDecisionUpdate(
  row: DetailRow,
  update: DecisionUpdateRow,
  keyRing: PendingCommandKeyRing,
): OwnerPendingActionDetailView {
  return mapDetailRow(
    {
      ...row,
      approval_method: "owner_approval",
      decided_at: update.decided_at,
      decided_by_owner_id: row.owner_id,
      decision_reason_code: update.decision_reason_code,
      error: update.error,
      state: update.state,
      terminal_at: update.terminal_at,
      updated_at: update.updated_at,
      version_text: update.version_text,
    },
    keyRing,
  );
}

export class PostgresOwnerPendingActionService implements OwnerPendingActionService {
  readonly #clock: () => Date;
  readonly #cursorSigningKey: Buffer;
  readonly #idFactory: () => string;
  readonly #keyRing: PendingCommandKeyRing;
  readonly #sql: PostgresClient;

  constructor(sql: PostgresClient, options: PostgresOwnerPendingActionOptions) {
    if (!options.pendingActionKeyRing) {
      throw new TypeError("A PendingAction encryption key ring is required.");
    }
    if (
      !(options.cursorSigningKey instanceof Uint8Array) ||
      options.cursorSigningKey.byteLength < 32
    ) {
      throw new TypeError(
        "The Owner action cursor signing key must be at least 32 bytes.",
      );
    }
    this.#sql = sql;
    this.#keyRing = options.pendingActionKeyRing;
    this.#cursorSigningKey = Buffer.from(options.cursorSigningKey);
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async checkReady(): Promise<void> {
    try {
      const rows = await this.#sql.begin(async (transaction) => {
        await transaction`set local statement_timeout = '1500ms'`;
        return transaction<{ ready: boolean }[]>`
          select
            exists (
              select 1
              from system.schema_migrations
              where version = '000007'
                and name = 'pending_action_execution'
                and checksum = ${PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM}
            )
            and to_regclass('platform.pending_actions') is not null
            and to_regclass('platform.pending_action_attempts') is not null
            and to_regclass('platform.pending_actions_owner_queue_idx') is not null
            and to_regclass('platform.pending_actions_approved_due_idx') is not null
            and to_regclass('platform.pending_actions_approval_expiry_idx') is not null
            and to_regclass('platform.pending_actions_lease_reaper_idx') is not null
            and to_regclass('platform.idempotency_records_pending_action_idx') is not null
            and (
              select count(*) = 9
              from pg_catalog.pg_constraint
              where conname = any (array[
                'pending_actions_decision_reason_code',
                'pending_actions_decision_reason_state',
                'pending_actions_public_error',
                'pending_actions_state_shape',
                'pending_actions_decision_audit_shape',
                'pending_actions_attempt_generation',
                'pending_actions_failure_budget',
                'idempotency_records_pending_action',
                'idempotency_records_resource_shape'
              ]::name[])
                and convalidated
            )
            and (
              select count(*) = 7
              from pg_catalog.pg_trigger
              where not tgisinternal
                and tgenabled <> 'D'
                and tgname = any (array[
                  'pending_actions_link_idempotency',
                  'idempotency_records_validate_pending_action',
                  'pending_actions_validate_idempotency_terminal',
                  'idempotency_records_validate_action_terminal',
                  'pending_actions_prepare_update',
                  'pending_actions_sync_attempt',
                  'pending_actions_validate_decision_audit'
                ]::name[])
            ) as ready
        `;
      });
      if (rows.length !== 1 || rows[0]?.ready !== true) throw unavailable();
    } catch (error) {
      if (error instanceof OwnerPendingActionError) throw error;
      throw unavailable();
    }
  }

  async listActions(
    ownerId: string,
    input: OwnerPendingActionListInput,
  ): Promise<OwnerPendingActionPage> {
    const normalizedOwnerId = normalizeUuid(ownerId);
    if (normalizedOwnerId === null) throw unavailable();
    const filters = normalizeListFilters(input);
    const cursor =
      input.cursor === undefined || input.cursor === null
        ? null
        : this.#decodeCursor(input.cursor, normalizedOwnerId, filters);
    try {
      const rows = await this.#sql.begin(async (transaction) => {
        await transaction`set local statement_timeout = '5s'`;
        return transaction<SummaryRow[]>`
          select
            action.id,
            action.version::text as version_text,
            action.operation,
            action.state,
            action.target_type,
            action.target_id,
            action.approval_summary,
            action.requested_at,
            action.expires_at,
            action.updated_at,
            agent.id as agent_id,
            agent.status as agent_status,
            actor.handle::text as agent_handle,
            actor.display_name as agent_display_name
          from platform.pending_actions as action
          inner join platform.agents as agent
            on agent.id = action.agent_id
           and agent.owner_id = action.owner_id
          inner join platform.actors as actor
            on actor.id = agent.actor_id
           and actor.owner_id = action.owner_id
          where action.owner_id = ${normalizedOwnerId}
            and action.state = any (${transaction.array(filters.states)}::text[])
            and action.operation = any (
              ${transaction.array(filters.operations)}::text[]
            )
            and (
              ${filters.agentId}::uuid is null
              or action.agent_id = ${filters.agentId}::uuid
            )
            and (
              ${cursor?.requestedAt ?? null}::timestamptz is null
              or (action.requested_at, action.id) < (
                ${cursor?.requestedAt ?? null}::timestamptz,
                ${cursor?.id ?? null}::uuid
              )
            )
          order by action.requested_at desc, action.id desc
          limit ${filters.limit + 1}
        `;
      });
      const hasMore = rows.length > filters.limit;
      const visibleRows = hasMore ? rows.slice(0, filters.limit) : rows;
      const items = visibleRows.map(mapSummaryRow);
      const last = visibleRows.at(-1);
      return {
        hasMore,
        items,
        limit: filters.limit,
        nextCursor:
          hasMore && last
            ? this.#encodeCursor(normalizedOwnerId, filters, {
                id: last.id,
                requestedAt: last.requested_at,
              })
            : null,
      };
    } catch (error) {
      if (error instanceof OwnerPendingActionError) throw error;
      throw unavailable();
    }
  }

  async getAction(
    ownerId: string,
    actionId: string,
    context: OwnerPendingActionReadContext,
  ): Promise<OwnerPendingActionDetailView> {
    const ids = assertActionArguments(ownerId, actionId);
    assertRequestId(context.requestId);
    try {
      return await this.#sql.begin(async (transaction) => {
        await transaction`set local statement_timeout = '5s'`;
        const rows = await this.#selectOwnedDetail(
          transaction,
          ids.ownerId,
          ids.actionId,
        );
        const row = rows[0];
        if (!row) throw new OwnerPendingActionError("ACTION_NOT_FOUND");
        if (rows.length !== 1) throw unavailable();
        if (
          normalizeUuid(row.id) !== ids.actionId ||
          normalizeUuid(row.owner_id) !== ids.ownerId
        ) {
          throw unavailable();
        }

        // Validate only the controlled identifiers needed by the audit first.
        // The encrypted command is not touched until this durable sensitive-read
        // record has been staged in the same transaction.
        const summary = mapSummaryRow(row);
        const policyVersion =
          typeof row.policy_version_text === "string" &&
          POSITIVE_DECIMAL_PATTERN.test(row.policy_version_text)
            ? row.policy_version_text
            : null;
        const credentialId = normalizeUuid(row.credential_id);
        if (policyVersion === null || credentialId === null) throw unavailable();
        await this.#writeSensitiveReadAudit(transaction, {
          actionId: summary.id,
          agentId: summary.agent.id,
          credentialId,
          occurredAt: this.#now(),
          ownerId: ids.ownerId,
          policyVersion,
          requestId: context.requestId,
        });
        return mapDetailRow(row, this.#keyRing);
      });
    } catch (error) {
      if (error instanceof OwnerPendingActionError) throw error;
      throw unavailable();
    }
  }

  async approveAction(
    ownerId: string,
    actionId: string,
    input: OwnerPendingActionDecisionInput & { reasonCode: "owner_approved" },
  ): Promise<OwnerPendingActionDetailView> {
    return this.#decide(ownerId, actionId, input, "approve");
  }

  async rejectAction(
    ownerId: string,
    actionId: string,
    input: OwnerPendingActionDecisionInput & {
      reasonCode: Exclude<OwnerPendingActionDecisionReason, "owner_approved">;
    },
  ): Promise<OwnerPendingActionDetailView> {
    return this.#decide(ownerId, actionId, input, "reject");
  }

  async #decide(
    ownerId: string,
    actionId: string,
    input: OwnerPendingActionDecisionInput,
    decision: "approve" | "reject",
  ): Promise<OwnerPendingActionDetailView> {
    const ids = assertActionArguments(ownerId, actionId);
    assertRequestId(input.requestId);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new OwnerPendingActionError("ACTION_VERSION_CONFLICT");
    }
    if (
      !decisionReasonSet.has(input.reasonCode) ||
      (decision === "approve" && input.reasonCode !== "owner_approved") ||
      (decision === "reject" && !rejectionReasonSet.has(input.reasonCode))
    ) {
      throw new OwnerPendingActionError("ACTION_DECISION_CONFLICT");
    }
    try {
      return await this.#sql.begin(async (transaction) => {
        await transaction`set local statement_timeout = '10s'`;
        const rows = await this.#selectDecisionRow(
          transaction,
          ids.ownerId,
          ids.actionId,
        );
        const row = rows[0];
        if (!row) throw new OwnerPendingActionError("ACTION_NOT_FOUND");
        if (rows.length !== 1 || !isValidDate(row.database_now)) throw unavailable();
        if (
          normalizeUuid(row.id) !== ids.actionId ||
          normalizeUuid(row.owner_id) !== ids.ownerId
        ) {
          throw unavailable();
        }

        // Decrypt and validate the frozen row before any decision mutation. A
        // corrupt command or authority binding must never be approved/rejected.
        const current = mapDetailRow(row, this.#keyRing);
        if (row.owner_status !== "active" || row.owner_email_verified !== true) {
          throw new OwnerPendingActionError("ACTION_DECISION_CONFLICT", {
            currentState: current.state,
            currentVersion: current.version,
          });
        }
        const sameDecision =
          (decision === "approve" &&
            current.state !== "pending_approval" &&
            current.decisionReasonCode === "owner_approved") ||
          (decision === "reject" &&
            current.state === "rejected" &&
            current.decisionReasonCode === input.reasonCode);
        if (sameDecision) return current;
        if (current.state !== "pending_approval") {
          throw new OwnerPendingActionError("ACTION_DECISION_CONFLICT", {
            currentState: current.state,
            currentVersion: current.version,
          });
        }
        if (current.expiresAt.getTime() <= row.database_now.getTime()) {
          // Expiration belongs to the queue/reaper. This path deliberately does
          // not synthesize a half-terminal state, audit, or outbox event.
          throw new OwnerPendingActionError("ACTION_DECISION_CONFLICT", {
            currentState: current.state,
            currentVersion: current.version,
          });
        }
        if (current.version !== input.expectedVersion) {
          throw new OwnerPendingActionError("ACTION_VERSION_CONFLICT", {
            currentState: current.state,
            currentVersion: current.version,
          });
        }

        const auditId = this.#newId();
        const nextState = decision === "approve" ? "approved" : "rejected";
        const event = await appendOutboxEvent(transaction, {
          aggregateId: current.id,
          aggregateType: "pending_action",
          eventType: decision === "approve" ? "action.approved" : "action.rejected",
          eventVersion: 1,
          occurredAt: row.database_now,
          payload: {
            action_id: current.id,
            agent_id: current.agent.id,
            decision_reason_code: input.reasonCode,
            operation: current.operation,
            owner_id: ids.ownerId,
            state: nextState,
          },
        });
        await this.#writeDecisionAudit(transaction, {
          actionId: current.id,
          agentId: current.agent.id,
          auditId,
          credentialId: row.credential_id,
          decision,
          eventId: event.id,
          occurredAt: row.database_now,
          ownerId: ids.ownerId,
          policyVersion: current.policyVersion,
          reasonCode: input.reasonCode,
          requestId: input.requestId,
          version: current.version,
        });

        const updates =
          decision === "approve"
            ? await transaction<DecisionUpdateRow[]>`
                update platform.pending_actions as action
                set state = 'approved',
                    version = action.version + 1,
                    decided_at = ${row.database_now},
                    decided_by_owner_id = ${ids.ownerId},
                    approval_method = 'owner_approval',
                    decision_reason_code = 'owner_approved',
                    decision_audit_id = ${auditId}
                where action.id = ${current.id}
                  and action.owner_id = ${ids.ownerId}
                  and action.state = 'pending_approval'
                  and action.version = ${input.expectedVersion}
                  and action.expires_at > clock_timestamp()
                returning
                  action.version::text as version_text,
                  action.state,
                  action.decided_at,
                  action.terminal_at,
                  action.updated_at,
                  action.decision_reason_code,
                  action.error
              `
            : await transaction<DecisionUpdateRow[]>`
                update platform.pending_actions as action
                set state = 'rejected',
                    version = action.version + 1,
                    decided_at = ${row.database_now},
                    decided_by_owner_id = ${ids.ownerId},
                    approval_method = 'owner_approval',
                    decision_reason_code = ${input.reasonCode},
                    decision_audit_id = ${auditId},
                    terminal_at = ${row.database_now},
                    error = ${transaction.json(rejectedDatabaseError)}
                where action.id = ${current.id}
                  and action.owner_id = ${ids.ownerId}
                  and action.state = 'pending_approval'
                  and action.version = ${input.expectedVersion}
                  and action.expires_at > clock_timestamp()
                returning
                  action.version::text as version_text,
                  action.state,
                  action.decided_at,
                  action.terminal_at,
                  action.updated_at,
                  action.decision_reason_code,
                  action.error
              `;
        const update = updates[0];
        if (!update) {
          throw new OwnerPendingActionError("ACTION_DECISION_CONFLICT", {
            currentState: current.state,
            currentVersion: current.version,
          });
        }
        if (updates.length !== 1) throw unavailable();
        const decided = viewWithDecisionUpdate(row, update, this.#keyRing);

        const idempotencyRows =
          decision === "approve"
            ? await transaction<{ id: string }[]>`
                -- 000006 stored the PendingAction ID in resource_id. The 000007
                -- immutability trigger permits clearing that compatibility value
                -- only when the idempotency record becomes terminal, so approval
                -- refreshes the safe response while preserving resource_id.
                update platform.idempotency_records as idempotency
                set status = 'pending_approval',
                    response_code = 202,
                    response_body = ${transaction.json(jsonForReplay(decided))},
                    pending_action_id = ${current.id},
                    updated_at = ${row.database_now}
                where idempotency.id = ${row.idempotency_record_id}
                  and idempotency.owner_id = ${ids.ownerId}
                  and idempotency.pending_action_id = ${current.id}
                  and idempotency.status = 'pending_approval'
                  and idempotency.terminal_at is null
                returning idempotency.id
              `
            : await transaction<{ id: string }[]>`
                update platform.idempotency_records as idempotency
                set status = 'denied',
                    response_code = 409,
                    response_body = ${transaction.json(jsonForReplay(decided))},
                    resource_id = null,
                    pending_action_id = ${current.id},
                    terminal_at = ${update.terminal_at},
                    expires_at = greatest(
                      idempotency.expires_at,
                      ${update.terminal_at}::timestamptz + interval '7 days'
                    ),
                    updated_at = ${row.database_now}
                where idempotency.id = ${row.idempotency_record_id}
                  and idempotency.owner_id = ${ids.ownerId}
                  and idempotency.pending_action_id = ${current.id}
                  and idempotency.status = 'pending_approval'
                  and idempotency.terminal_at is null
                returning idempotency.id
              `;
        if (idempotencyRows.length !== 1) throw unavailable();
        return decided;
      });
    } catch (error) {
      if (error instanceof OwnerPendingActionError) throw error;
      throw unavailable();
    }
  }

  async #selectOwnedDetail(
    transaction: TransactionSql,
    ownerId: string,
    actionId: string,
  ): Promise<DetailRow[]> {
    return transaction<DetailRow[]>`
      select
        action.id,
        action.version::text as version_text,
        action.owner_id,
        action.agent_id,
        action.credential_id,
        action.idempotency_record_id,
        action.operation,
        action.state,
        action.target_type,
        action.target_id,
        action.normalized_input_ciphertext,
        action.normalized_input_nonce,
        action.normalized_input_key_version,
        action.normalized_input_format_version,
        'sha256:' || encode(action.input_digest, 'hex') as input_digest_text,
        action.decision_id,
        action.policy_version::text as policy_version_text,
        action.approval_summary,
        action.requested_at,
        action.expires_at,
        action.decided_at,
        action.decided_by_owner_id,
        action.approval_method,
        action.decision_reason_code,
        action.executing_at,
        action.completed_at,
        action.terminal_at,
        action.attempt_count,
        action.failure_count,
        action.result is not null as has_result,
        action.error,
        (
          (
            action.lease_owner is null
            and action.lease_token_digest is null
            and action.lease_expires_at is null
          )
          or (
            action.state = 'executing'
            and action.lease_owner is not null
            and action.lease_token_digest is not null
            and action.lease_expires_at is not null
          )
        ) as lease_shape_valid,
        action.updated_at,
        agent.status as agent_status,
        actor.handle::text as agent_handle,
        actor.display_name as agent_display_name
      from platform.pending_actions as action
      inner join platform.agents as agent
        on agent.id = action.agent_id
       and agent.owner_id = action.owner_id
      inner join platform.actors as actor
        on actor.id = agent.actor_id
       and actor.owner_id = action.owner_id
      where action.id = ${actionId}
        and action.owner_id = ${ownerId}
      for share of action
    `;
  }

  async #selectDecisionRow(
    transaction: TransactionSql,
    ownerId: string,
    actionId: string,
  ): Promise<DecisionRow[]> {
    return transaction<DecisionRow[]>`
      select
        action.id,
        action.version::text as version_text,
        action.owner_id,
        action.agent_id,
        action.credential_id,
        action.idempotency_record_id,
        action.operation,
        action.state,
        action.target_type,
        action.target_id,
        action.normalized_input_ciphertext,
        action.normalized_input_nonce,
        action.normalized_input_key_version,
        action.normalized_input_format_version,
        'sha256:' || encode(action.input_digest, 'hex') as input_digest_text,
        action.decision_id,
        action.policy_version::text as policy_version_text,
        action.approval_summary,
        action.requested_at,
        action.expires_at,
        action.decided_at,
        action.decided_by_owner_id,
        action.approval_method,
        action.decision_reason_code,
        action.executing_at,
        action.completed_at,
        action.terminal_at,
        action.attempt_count,
        action.failure_count,
        action.result is not null as has_result,
        action.error,
        (
          (
            action.lease_owner is null
            and action.lease_token_digest is null
            and action.lease_expires_at is null
          )
          or (
            action.state = 'executing'
            and action.lease_owner is not null
            and action.lease_token_digest is not null
            and action.lease_expires_at is not null
          )
        ) as lease_shape_valid,
        action.updated_at,
        agent.status as agent_status,
        actor.handle::text as agent_handle,
        actor.display_name as agent_display_name,
        owner.status as owner_status,
        owner.email_verified_at is not null as owner_email_verified,
        clock_timestamp() as database_now
      from platform.pending_actions as action
      inner join platform.owners as owner
        on owner.id = action.owner_id
      inner join platform.agents as agent
        on agent.id = action.agent_id
       and agent.owner_id = action.owner_id
      inner join platform.actors as actor
        on actor.id = agent.actor_id
       and actor.owner_id = action.owner_id
      where action.id = ${actionId}
        and action.owner_id = ${ownerId}
      for update of action, owner
    `;
  }

  async #writeSensitiveReadAudit(
    transaction: TransactionSql,
    input: {
      actionId: string;
      agentId: string;
      credentialId: string;
      occurredAt: Date;
      ownerId: string;
      policyVersion: string;
      requestId: string;
    },
  ): Promise<void> {
    await transaction`
      insert into platform.action_logs (
        id,
        event_class,
        occurred_at,
        owner_id,
        agent_id,
        credential_id,
        channel,
        authentication_assurance,
        action,
        target_type,
        target_id,
        outcome,
        policy_version,
        request_id,
        reason_code
      )
      values (
        ${this.#newId()},
        'sensitive_read',
        ${input.occurredAt},
        ${input.ownerId},
        ${input.agentId},
        ${input.credentialId},
        'owner_api',
        'owner_session',
        'pending_action.read',
        'pending_action',
        ${input.actionId},
        'succeeded',
        ${input.policyVersion},
        ${input.requestId},
        'owner_detail_view'
      )
    `;
  }

  async #writeDecisionAudit(
    transaction: TransactionSql,
    input: {
      actionId: string;
      agentId: string;
      auditId: string;
      credentialId: string;
      decision: "approve" | "reject";
      eventId: string;
      occurredAt: Date;
      ownerId: string;
      policyVersion: string;
      reasonCode: OwnerPendingActionDecisionReason;
      requestId: string;
      version: number;
    },
  ): Promise<void> {
    await transaction`
      insert into platform.action_logs (
        id,
        event_class,
        occurred_at,
        owner_id,
        agent_id,
        credential_id,
        channel,
        approval_method,
        approved_by_owner_id,
        authentication_assurance,
        action,
        target_type,
        target_id,
        decision,
        outcome,
        error_code,
        retry_count,
        outbox_event_id,
        policy_version,
        request_id,
        before_state,
        after_state,
        reason_code
      )
      values (
        ${input.auditId},
        'approval_transition',
        ${input.occurredAt},
        ${input.ownerId},
        ${input.agentId},
        ${input.credentialId},
        'owner_api',
        'owner_approval',
        ${input.ownerId},
        'owner_session',
        ${
          input.decision === "approve"
            ? "pending_action.approve"
            : "pending_action.reject"
        },
        'pending_action',
        ${input.actionId},
        'require_approval',
        ${input.decision === "approve" ? "pending" : "denied"},
        ${input.decision === "approve" ? null : "ACTION_REJECTED"},
        0,
        ${input.eventId},
        ${input.policyVersion},
        ${input.requestId},
        ${transaction.json({
          action_id: input.actionId,
          state: "pending_approval",
          version: input.version,
        })},
        ${transaction.json({
          action_id: input.actionId,
          state: input.decision === "approve" ? "approved" : "rejected",
          version: input.version + 1,
        })},
        ${input.reasonCode}
      )
    `;
  }

  #encodeCursor(
    ownerId: string,
    filters: NormalizedListFilters,
    position: CursorPosition,
  ): string {
    if (!isValidDate(position.requestedAt) || normalizeUuid(position.id) === null) {
      throw unavailable();
    }
    const payload: CursorPayload = {
      filters: canonicalFilters(filters),
      id: position.id.toLowerCase(),
      owner_id: ownerId,
      purpose: CURSOR_PURPOSE,
      requested_at: position.requestedAt.toISOString(),
      version: 1,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = this.#cursorMac(encoded).toString("base64url");
    return `${encoded}.${signature}`;
  }

  #decodeCursor(
    cursor: string,
    ownerId: string,
    filters: NormalizedListFilters,
  ): CursorPosition {
    try {
      if (
        typeof cursor !== "string" ||
        cursor.length < 3 ||
        cursor.length > MAX_CURSOR_LENGTH
      ) {
        throw new Error("invalid");
      }
      const parts = cursor.split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid");
      const [encoded, encodedSignature] = parts;
      const signature = Buffer.from(encodedSignature, "base64url");
      if (signature.toString("base64url") !== encodedSignature) {
        throw new Error("invalid");
      }
      const expected = this.#cursorMac(encoded);
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
        throw new Error("invalid");
      }
      const decoded = Buffer.from(encoded, "base64url");
      if (decoded.toString("base64url") !== encoded) throw new Error("invalid");
      const payload = JSON.parse(decoded.toString("utf8")) as unknown;
      if (!payloadHasExactShape(payload)) throw new Error("invalid");
      const payloadOwner = normalizeUuid(payload.owner_id);
      const payloadId = normalizeUuid(payload.id);
      const requestedAt = new Date(payload.requested_at);
      if (
        payloadOwner !== ownerId ||
        payloadId === null ||
        !isValidDate(requestedAt) ||
        requestedAt.toISOString() !== payload.requested_at ||
        !sameFilters(payload.filters, canonicalFilters(filters))
      ) {
        throw new Error("invalid");
      }
      return { id: payloadId, requestedAt };
    } catch {
      throw new OwnerPendingActionError("OWNER_ACTION_CURSOR_INVALID");
    }
  }

  #cursorMac(encodedPayload: string): Buffer {
    return createHmac("sha256", this.#cursorSigningKey)
      .update(CURSOR_PURPOSE, "utf8")
      .update("\0", "utf8")
      .update(encodedPayload, "ascii")
      .digest();
  }

  #newId(): string {
    const id = this.#idFactory();
    const normalized = normalizeUuid(id);
    if (normalized === null) throw unavailable();
    return normalized;
  }

  #now(): Date {
    const value = this.#clock();
    if (!isValidDate(value)) throw unavailable();
    return new Date(value.getTime());
  }
}
