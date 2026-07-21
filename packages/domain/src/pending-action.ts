import type { PostgresClient } from "@alphanet/database";

export const PENDING_ACTION_STATES = [
  "pending_approval",
  "approved",
  "executing",
  "succeeded",
  "rejected",
  "expired",
  "cancelled",
  "failed",
  "invalidated",
] as const;

export const PENDING_ACTION_OPERATIONS = [
  "create_post",
  "reply_to_content",
  "update_content",
  "delete_content",
  "set_reaction",
  "set_follow",
] as const;

export type PendingActionState = (typeof PENDING_ACTION_STATES)[number];
export type PendingActionOperation = (typeof PENDING_ACTION_OPERATIONS)[number];
export type PendingActionWriteStatus =
  "pending_approval" | "succeeded" | "denied" | "failed";
export type PendingActionApprovalOutcome =
  "approved" | "rejected" | "expired" | "cancelled" | "invalidated";

export interface PendingActionActorContext {
  ownerId: string;
  agentId: string;
}

export interface PendingActionErrorDetail {
  code: string;
  message: string;
  retryable: boolean;
  details: Readonly<Record<string, unknown>> | null;
  retry_after_ms: number | null;
}

export interface CreatePostActionResult {
  content_id: string;
  revision_id: string;
  resource_version: number;
}

export interface ReplyToContentActionResult extends CreatePostActionResult {
  root_content_id: string;
}

export interface UpdateContentActionResult {
  content_id: string;
  revision_id: string | null;
  resource_version: number;
}

export interface DeleteContentActionResult {
  content_id: string;
  lifecycle_state: "deleted";
  resource_version: number;
}

export interface SetReactionActionResult {
  content_id: string;
  viewer_state: {
    reactions: ("helpful" | "agree" | "disagree")[];
    following: boolean;
  };
  reaction_counts: {
    helpful: number;
    agree: number;
    disagree: number;
  };
}

export interface SetFollowActionResult {
  target_type: "actor" | "symbol" | "topic" | "content";
  target_id: string;
  active: boolean;
  notification_level: "feed_only" | "new_posts" | "all_events" | null;
  updated_at: string;
}

export type PendingActionResult =
  | CreatePostActionResult
  | ReplyToContentActionResult
  | UpdateContentActionResult
  | DeleteContentActionResult
  | SetReactionActionResult
  | SetFollowActionResult;

export interface AgentPendingActionView {
  id: string;
  operation: PendingActionOperation;
  decision: "require_approval";
  status: PendingActionWriteStatus;
  state: PendingActionState;
  decisionId: string;
  policyVersion: string;
  requestedAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  executingAt: Date | null;
  expectedVersion: number | null;
  completedAt: Date | null;
  terminalAt: Date | null;
  inputDigest: string;
  approvalSummary: string;
  approvalOutcome: PendingActionApprovalOutcome | null;
  approvalMethod: "owner_approval" | null;
  decidedByOwnerId: string | null;
  result: PendingActionResult | null;
  error: PendingActionErrorDetail | null;
}

export type PendingActionStatusErrorCode =
  "ACTION_NOT_FOUND" | "ACTION_STATUS_UNAVAILABLE";

const errorProperties = {
  ACTION_NOT_FOUND: {
    message: "The requested action was not found.",
    retryable: false,
    statusCode: 404,
  },
  ACTION_STATUS_UNAVAILABLE: {
    message: "Action status is temporarily unavailable.",
    retryable: true,
    statusCode: 503,
  },
} as const satisfies Record<
  PendingActionStatusErrorCode,
  { message: string; retryable: boolean; statusCode: number }
>;

export class PendingActionStatusError extends Error {
  readonly code: PendingActionStatusErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(code: PendingActionStatusErrorCode) {
    super(errorProperties[code].message);
    this.name = "PendingActionStatusError";
    this.code = code;
    this.retryable = errorProperties[code].retryable;
    this.statusCode = errorProperties[code].statusCode;
  }
}

export interface PendingActionStatusService {
  checkReady(): Promise<void>;
  getActionStatus(
    actor: PendingActionActorContext,
    actionId: string,
  ): Promise<AgentPendingActionView>;
}

interface PendingActionRow {
  id: string;
  operation: string;
  state: string;
  decision_id: string;
  public_policy_version: string;
  requested_at: Date;
  expires_at: Date;
  decided_at: Date | null;
  executing_at: Date | null;
  expected_version_text: string | null;
  completed_at: Date | null;
  terminal_at: Date | null;
  public_input_digest: string;
  approval_summary: string;
  approval_method: string | null;
  decided_by_owner_id: string | null;
  result: unknown;
  error: unknown;
}

const stateSet = new Set<string>(PENDING_ACTION_STATES);
const operationSet = new Set<string>(PENDING_ACTION_OPERATIONS);
const terminalStates = new Set<PendingActionState>([
  "succeeded",
  "rejected",
  "expired",
  "cancelled",
  "failed",
  "invalidated",
]);
const statusByState = {
  pending_approval: "pending_approval",
  approved: "pending_approval",
  executing: "pending_approval",
  succeeded: "succeeded",
  rejected: "denied",
  expired: "denied",
  cancelled: "denied",
  failed: "failed",
  invalidated: "failed",
} as const satisfies Record<PendingActionState, PendingActionWriteStatus>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpected.length &&
    actualKeys.every((key, index) => key === sortedExpected[index])
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseExpectedVersion(
  operation: PendingActionOperation,
  value: string | null,
): number | null {
  const requiresExpectedVersion =
    operation === "update_content" || operation === "delete_content";
  if (value === null) {
    if (requiresExpectedVersion) {
      throw new PendingActionStatusError("ACTION_STATUS_UNAVAILABLE");
    }
    return null;
  }
  if (!requiresExpectedVersion || !/^[1-9][0-9]*$/u.test(value)) {
    throw new PendingActionStatusError("ACTION_STATUS_UNAVAILABLE");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new PendingActionStatusError("ACTION_STATUS_UNAVAILABLE");
  }
  return parsed;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isNullableDate(value: unknown): value is Date | null {
  return value === null || isValidDate(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !Number.isNaN(Date.parse(value)) &&
    /(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  );
}

const publicTerminalErrors = {
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
} as const satisfies Record<
  Exclude<
    PendingActionState,
    "pending_approval" | "approved" | "executing" | "succeeded"
  >,
  { code: string; message: string }
>;

function publicTerminalError(
  state: PendingActionState,
  storedError: unknown,
): PendingActionErrorDetail | null {
  if (storedError === null) return null;
  if (!isRecord(storedError)) {
    throw new PendingActionStatusError("ACTION_STATUS_UNAVAILABLE");
  }
  if (
    state === "pending_approval" ||
    state === "approved" ||
    state === "executing" ||
    state === "succeeded"
  ) {
    return null;
  }
  const publicError = publicTerminalErrors[state];
  return {
    code: publicError.code,
    message: publicError.message,
    retryable: false,
    details: null,
    retry_after_ms: null,
  };
}

function parseCreatePostResult(value: unknown): CreatePostActionResult | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["content_id", "revision_id", "resource_version"]) ||
    !isNonEmptyString(value.content_id) ||
    !isNonEmptyString(value.revision_id) ||
    !isPositiveInteger(value.resource_version)
  ) {
    return null;
  }
  return {
    content_id: value.content_id,
    revision_id: value.revision_id,
    resource_version: value.resource_version,
  };
}

function parseReplyResult(value: unknown): ReplyToContentActionResult | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "content_id",
      "revision_id",
      "resource_version",
      "root_content_id",
    ]) ||
    !isNonEmptyString(value.content_id) ||
    !isNonEmptyString(value.root_content_id) ||
    !isNonEmptyString(value.revision_id) ||
    !isPositiveInteger(value.resource_version)
  ) {
    return null;
  }
  return {
    content_id: value.content_id,
    root_content_id: value.root_content_id,
    revision_id: value.revision_id,
    resource_version: value.resource_version,
  };
}

function parseUpdateResult(value: unknown): UpdateContentActionResult | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["content_id", "revision_id", "resource_version"]) ||
    !isNonEmptyString(value.content_id) ||
    (value.revision_id !== null && !isNonEmptyString(value.revision_id)) ||
    !isPositiveInteger(value.resource_version)
  ) {
    return null;
  }
  return {
    content_id: value.content_id,
    revision_id: value.revision_id,
    resource_version: value.resource_version,
  };
}

function parseDeleteResult(value: unknown): DeleteContentActionResult | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["content_id", "lifecycle_state", "resource_version"]) ||
    !isNonEmptyString(value.content_id) ||
    value.lifecycle_state !== "deleted" ||
    !isPositiveInteger(value.resource_version)
  ) {
    return null;
  }
  return {
    content_id: value.content_id,
    lifecycle_state: "deleted",
    resource_version: value.resource_version,
  };
}

function parseReactionResult(value: unknown): SetReactionActionResult | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["content_id", "reaction_counts", "viewer_state"]) ||
    !isNonEmptyString(value.content_id) ||
    !isRecord(value.viewer_state) ||
    !hasExactKeys(value.viewer_state, ["following", "reactions"]) ||
    typeof value.viewer_state.following !== "boolean" ||
    !Array.isArray(value.viewer_state.reactions) ||
    value.viewer_state.reactions.length > 3 ||
    !value.viewer_state.reactions.every(
      (reaction) =>
        typeof reaction === "string" &&
        ["helpful", "agree", "disagree"].includes(reaction),
    ) ||
    new Set(value.viewer_state.reactions).size !== value.viewer_state.reactions.length ||
    !isRecord(value.reaction_counts) ||
    !hasExactKeys(value.reaction_counts, ["agree", "disagree", "helpful"]) ||
    !isNonnegativeInteger(value.reaction_counts.helpful) ||
    !isNonnegativeInteger(value.reaction_counts.agree) ||
    !isNonnegativeInteger(value.reaction_counts.disagree)
  ) {
    return null;
  }
  return value as unknown as SetReactionActionResult;
}

function parseFollowResult(value: unknown): SetFollowActionResult | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "active",
      "notification_level",
      "target_id",
      "target_type",
      "updated_at",
    ]) ||
    typeof value.target_type !== "string" ||
    !["actor", "symbol", "topic", "content"].includes(value.target_type) ||
    !isNonEmptyString(value.target_id) ||
    typeof value.active !== "boolean" ||
    (value.notification_level !== null &&
      (typeof value.notification_level !== "string" ||
        !["feed_only", "new_posts", "all_events"].includes(value.notification_level))) ||
    !isTimestamp(value.updated_at)
  ) {
    return null;
  }
  return value as unknown as SetFollowActionResult;
}

function parseResult(
  operation: PendingActionOperation,
  value: unknown,
): PendingActionResult | null {
  switch (operation) {
    case "create_post":
      return parseCreatePostResult(value);
    case "reply_to_content":
      return parseReplyResult(value);
    case "update_content":
      return parseUpdateResult(value);
    case "delete_content":
      return parseDeleteResult(value);
    case "set_reaction":
      return parseReactionResult(value);
    case "set_follow":
      return parseFollowResult(value);
  }
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

function mapPendingActionRow(
  row: PendingActionRow,
  actor: PendingActionActorContext,
): AgentPendingActionView {
  if (
    !isNonEmptyString(row.id) ||
    !operationSet.has(row.operation) ||
    !stateSet.has(row.state) ||
    !isNonEmptyString(row.decision_id) ||
    !isNonEmptyString(row.public_policy_version) ||
    !isValidDate(row.requested_at) ||
    !isValidDate(row.expires_at) ||
    !isNullableDate(row.decided_at) ||
    !isNullableDate(row.executing_at) ||
    !isNullableDate(row.completed_at) ||
    !isNullableDate(row.terminal_at) ||
    !/^sha256:[0-9a-f]{64}$/u.test(row.public_input_digest) ||
    !isNonEmptyString(row.approval_summary) ||
    [...row.approval_summary].length > 2_000 ||
    row.approval_summary.trim() !== row.approval_summary ||
    /\p{Cc}/u.test(row.approval_summary) ||
    (row.approval_method !== null && row.approval_method !== "owner_approval") ||
    (row.decided_by_owner_id !== null && row.decided_by_owner_id !== actor.ownerId)
  ) {
    throw new PendingActionStatusError("ACTION_STATUS_UNAVAILABLE");
  }

  const operation = row.operation as PendingActionOperation;
  const state = row.state as PendingActionState;
  const expectedVersion = parseExpectedVersion(operation, row.expected_version_text);
  const ownerEvidencePresent =
    row.decided_at !== null &&
    row.approval_method === "owner_approval" &&
    row.decided_by_owner_id === actor.ownerId;
  const ownerEvidenceAbsent =
    row.decided_at === null &&
    row.approval_method === null &&
    row.decided_by_owner_id === null;
  if (!ownerEvidencePresent && !ownerEvidenceAbsent) {
    throw new PendingActionStatusError("ACTION_STATUS_UNAVAILABLE");
  }

  const terminal = terminalStates.has(state);
  const executionCompleted = state === "succeeded" || state === "failed";
  const usedExecution =
    state === "executing" || state === "succeeded" || state === "failed";
  const lifecycleIsConsistent =
    terminal === (row.terminal_at !== null) &&
    executionCompleted === (row.completed_at !== null) &&
    usedExecution === (row.executing_at !== null) &&
    row.expires_at.getTime() > row.requested_at.getTime() &&
    [row.decided_at, row.executing_at, row.completed_at, row.terminal_at].every(
      (timestamp) =>
        timestamp === null || timestamp.getTime() >= row.requested_at.getTime(),
    ) &&
    (row.completed_at === null ||
      row.executing_at === null ||
      row.completed_at.getTime() >= row.executing_at.getTime()) &&
    (row.terminal_at === null ||
      row.completed_at === null ||
      row.terminal_at.getTime() >= row.completed_at.getTime());
  if (!lifecycleIsConsistent) {
    throw new PendingActionStatusError("ACTION_STATUS_UNAVAILABLE");
  }

  const result = row.result === null ? null : parseResult(operation, row.result);
  const error = publicTerminalError(state, row.error);
  const requiresError = terminal && state !== "succeeded";
  if (
    (state === "succeeded" && (result === null || row.error !== null)) ||
    (state !== "succeeded" && row.result !== null) ||
    (requiresError && error === null) ||
    (!requiresError && row.error !== null)
  ) {
    throw new PendingActionStatusError("ACTION_STATUS_UNAVAILABLE");
  }

  const outcome = approvalOutcome(state, row.decided_at);
  const requiresOwnerEvidence =
    outcome === "approved" || outcome === "rejected" || outcome === "cancelled";
  if (requiresOwnerEvidence !== ownerEvidencePresent) {
    throw new PendingActionStatusError("ACTION_STATUS_UNAVAILABLE");
  }

  return {
    id: row.id,
    operation,
    decision: "require_approval",
    status: statusByState[state],
    state,
    decisionId: row.decision_id,
    policyVersion: row.public_policy_version,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    expectedVersion,
    decidedAt: row.decided_at,
    executingAt: row.executing_at,
    completedAt: row.completed_at,
    terminalAt: row.terminal_at,
    inputDigest: row.public_input_digest,
    approvalSummary: row.approval_summary,
    approvalOutcome: outcome,
    approvalMethod: row.approval_method,
    decidedByOwnerId: row.decided_by_owner_id,
    result,
    error,
  };
}

const RESEARCH_CORE_MIGRATION_CHECKSUM =
  "392fe32a45cd57357caf1638a110108194fa3e0b14302a197877134e01ae171f";

export class PostgresPendingActionStatusService implements PendingActionStatusService {
  readonly #sql: PostgresClient;

  constructor(sql: PostgresClient) {
    this.#sql = sql;
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
              where version = '000006'
                and name = 'community_research_core'
                and checksum = ${RESEARCH_CORE_MIGRATION_CHECKSUM}
            )
            and to_regclass('platform.pending_actions') is not null
            and to_regclass('platform.pending_actions_agent_history_idx') is not null
            and exists (
              select 1
              from pg_catalog.pg_attribute
              where attrelid = to_regclass('platform.pending_actions')
                and attname = 'normalized_input_ciphertext'
                and not attisdropped
            )
            and exists (
              select 1
              from pg_catalog.pg_attribute
              where attrelid = to_regclass('platform.pending_actions')
                and attname = 'terminal_at'
                and not attisdropped
            )
            and exists (
              select 1
              from pg_catalog.pg_constraint
              where conrelid = to_regclass('platform.pending_actions')
                and conname = 'pending_actions_agent_owner'
            )
            and exists (
              select 1
              from pg_catalog.pg_trigger
              where tgrelid = to_regclass('platform.pending_actions')
                and tgname = 'pending_actions_prepare_update'
                and not tgisinternal
            ) as ready
        `;
      });
      if (rows[0]?.ready !== true) {
        throw new PendingActionStatusError("ACTION_STATUS_UNAVAILABLE");
      }
    } catch {
      throw new PendingActionStatusError("ACTION_STATUS_UNAVAILABLE");
    }
  }

  async getActionStatus(
    actor: PendingActionActorContext,
    actionId: string,
  ): Promise<AgentPendingActionView> {
    if (!isUuid(actor.ownerId) || !isUuid(actor.agentId) || !isUuid(actionId)) {
      throw new PendingActionStatusError("ACTION_NOT_FOUND");
    }

    let rows: PendingActionRow[];
    try {
      rows = await this.#sql.begin(async (transaction) => {
        await transaction`set local statement_timeout = '1500ms'`;
        return transaction<PendingActionRow[]>`
          select
            id,
            operation,
            state,
            decision_id,
            policy_id::text || ':' || policy_version::text as public_policy_version,
            requested_at,
            expires_at,
            decided_at,
            executing_at,
            expected_version::text as expected_version_text,
            completed_at,
            terminal_at,
            'sha256:' || encode(input_digest, 'hex') as public_input_digest,
            approval_summary,
            approval_method,
            decided_by_owner_id,
            result,
            error
          from platform.pending_actions
          where id = ${actionId}
            and owner_id = ${actor.ownerId}
            and agent_id = ${actor.agentId}
          limit 1
        `;
      });
    } catch {
      throw new PendingActionStatusError("ACTION_STATUS_UNAVAILABLE");
    }

    const row = rows[0];
    if (!row) {
      throw new PendingActionStatusError("ACTION_NOT_FOUND");
    }
    return mapPendingActionRow(row, actor);
  }
}
