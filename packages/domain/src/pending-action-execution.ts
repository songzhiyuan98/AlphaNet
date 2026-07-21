import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  appendOutboxEvent,
  type OutboxJsonObject,
  type PostgresClient,
} from "@alphanet/database";
import type postgres from "postgres";

import {
  PENDING_ACTION_OPERATIONS,
  PENDING_ACTION_STATES,
  type CreatePostActionResult,
  type DeleteContentActionResult,
  type PendingActionOperation,
  type PendingActionState,
  type ReplyToContentActionResult,
  type UpdateContentActionResult,
} from "./pending-action.js";
import { PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM } from "./schema-migrations.js";

const DEFAULT_CLAIM_BATCH_SIZE = 10;
const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_REAP_BATCH_SIZE = 100;
const DEFAULT_RETRY_DELAY_CAP_SECONDS = 300;
const LEASE_TOKEN_BYTES = 32;
const MAX_ATTEMPT_GENERATION = 2_000_000_000;
const MAX_FAILURES = 20;
const MAX_BATCH_SIZE = 100;
const MAX_LEASE_SECONDS = 3_600;
const MAX_RETRY_DELAY_CAP_SECONDS = 3_600;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type TransactionSql = postgres.TransactionSql;

const stateSet = new Set<string>(PENDING_ACTION_STATES);
const operationSet = new Set<string>(PENDING_ACTION_OPERATIONS);

const terminalErrors = {
  expired: {
    code: "ACTION_EXPIRED",
    message: "The action expired before it could be completed.",
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

type ExecutionTerminalState = keyof typeof terminalErrors;

export interface PendingActionExecutionRepositoryOptions {
  claimBatchSize?: number | undefined;
  leaseOwner: string;
  leaseSeconds?: number | undefined;
  reapBatchSize?: number | undefined;
  retryDelayCapSeconds?: number | undefined;
}

export interface PendingActionExecutionClaim {
  readonly actionId: string;
  readonly attemptCount: number;
  readonly leaseExpiresAt: Date;
  readonly leaseOwner: string;
  readonly leaseToken: Buffer;
  readonly operation: PendingActionOperation;
  readonly version: string;
}

export interface FencedPendingAction {
  readonly actionId: string;
  readonly agentId: string;
  readonly attemptCount: number;
  readonly credentialId: string;
  readonly decisionAuditId: string | null;
  readonly decisionId: string;
  readonly expectedVersion: number | null;
  readonly expiresAt: Date;
  readonly failureCount: number;
  /** Sensitive: use only to derive a non-reversible audit digest. */
  readonly idempotencyKey: string;
  /** Stable internal linkage for the terminal domain-write audit. */
  readonly idempotencyRecordId: string;
  readonly inputDigest: Buffer;
  readonly normalizedInput: {
    readonly ciphertext: Buffer;
    readonly formatVersion: number;
    readonly keyVersion: number;
    readonly nonce: Buffer;
  };
  readonly operation: PendingActionOperation;
  readonly ownerId: string;
  readonly policyId: string;
  readonly policySnapshot: unknown;
  readonly policyVersion: string;
  readonly targetId: string | null;
  readonly targetType: string | null;
  readonly version: string;
}

export interface PendingActionCommittedState {
  readonly actionId: string;
  readonly attemptCount: number;
  readonly error: unknown;
  readonly failureCount: number;
  readonly idempotencyResponse: unknown;
  readonly idempotencyStatus: "pending_approval" | "succeeded" | "denied" | "failed";
  readonly operation: PendingActionOperation;
  readonly resourceId: string | null;
  readonly result: unknown;
  readonly state: PendingActionState;
  readonly terminalAt: Date | null;
  readonly version: string;
}

export interface PendingActionCasResult {
  readonly action: PendingActionCommittedState | null;
  readonly applied: boolean;
}

export interface PendingActionHeartbeatResult {
  readonly action: PendingActionCommittedState | null;
  readonly leaseExpiresAt: Date | null;
  readonly renewed: boolean;
  readonly version: string | null;
}

export interface PendingActionReapResult {
  readonly expired: number;
  readonly failed: number;
  readonly processed: number;
  readonly recovered: number;
}

export interface PendingActionRetryOptions {
  /**
   * `consume_failure` is the default for an actual transient execution
   * failure. `defer` records a capacity/rate not-before without spending the
   * bounded failure budget.
   */
  budgetDisposition?: "consume_failure" | "defer" | undefined;
  maximumDelaySeconds?: number | undefined;
  minimumDelaySeconds?: number | undefined;
}

export interface PendingActionExecutionSuccessInput {
  correlatedOutboxEventId: string;
  resourceId: string;
  result:
    | CreatePostActionResult
    | ReplyToContentActionResult
    | UpdateContentActionResult
    | DeleteContentActionResult;
}

export interface PendingActionExecutionSuccessResult {
  action: PendingActionCommittedState;
  resolvedOutboxEventId: string;
}

export class PendingActionLeaseLostError extends Error {
  readonly actionId: string;
  readonly attemptCount: number;

  constructor(actionId: string, attemptCount: number) {
    super("The PendingAction execution lease is no longer valid.");
    this.name = "PendingActionLeaseLostError";
    this.actionId = actionId;
    this.attemptCount = attemptCount;
  }
}

interface ActionProjectionRow {
  agent_id: string;
  approval_summary: string;
  attempt_count: number;
  decision_id: string;
  error: unknown;
  expires_at: Date;
  expected_version: string | null;
  failure_count: number;
  id: string;
  idempotency_record_id: string;
  input_digest_text: string;
  operation: string;
  owner_id: string;
  policy_version: string;
  requested_at: Date;
  result: unknown;
  state: string;
  terminal_at: Date | null;
  version: string;
}

interface ClaimRow extends ActionProjectionRow {
  lease_expires_at: Date;
}

interface ReapCandidateRow {
  attempt_count: number;
  database_now: Date;
  expires_at: Date;
  failure_count: number;
  id: string;
  state: "approved" | "executing" | "pending_approval";
  version: string;
}

interface HeartbeatRow {
  lease_expires_at: Date;
  version: string;
}

interface FencedActionRow extends ActionProjectionRow {
  credential_id: string;
  database_now: Date;
  decision_audit_id: string | null;
  expected_version: string | null;
  idempotency_key: string;
  input_digest: Buffer;
  normalized_input_ciphertext: Buffer;
  normalized_input_format_version: number;
  normalized_input_key_version: number;
  normalized_input_nonce: Buffer;
  policy_id: string;
  policy_snapshot: unknown;
  target_id: string | null;
  target_type: string | null;
}

interface CommittedStateRow {
  attempt_count: number;
  error: unknown;
  failure_count: number;
  id: string;
  idempotency_response: unknown;
  idempotency_status: string;
  operation: string;
  resource_id: string | null;
  result: unknown;
  state: string;
  terminal_at: Date | null;
  version: string;
}

interface IdRow {
  id: string;
}

interface ReadyRow {
  ready: boolean;
}

interface TransitionAuditInput {
  action: string;
  afterState: PendingActionState;
  beforeFailureCount?: number | undefined;
  beforeState: PendingActionState;
  errorCode: string | null;
  outboxEventId?: string | null | undefined;
  outcome: "succeeded" | "pending" | "denied" | "failed";
  reasonCode: string;
}

type SuccessResultSnapshot =
  | (OutboxJsonObject & {
      content_id: string;
      resource_version: number;
      revision_id: string;
    })
  | (OutboxJsonObject & {
      content_id: string;
      resource_version: number;
      revision_id: string;
      root_content_id: string;
    })
  | (OutboxJsonObject & {
      content_id: string;
      resource_version: number;
      revision_id: string | null;
    })
  | (OutboxJsonObject & {
      content_id: string;
      lifecycle_state: "deleted";
      resource_version: number;
    });

function assertIntegerInRange(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${field} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
}

function assertActionId(actionId: string): void {
  if (!UUID_PATTERN.test(actionId)) {
    throw new RangeError("actionId must be a valid UUID.");
  }
}

function assertExactDataObject(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Reflect.getPrototypeOf(value) !== Object.prototype &&
      Reflect.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).some((key) => typeof key === "symbol")
  ) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(`${field} has an invalid public result shape.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${field}.${key} must be an enumerable data property.`);
    }
  }
}

function snapshotSuccessInput(
  claim: PendingActionExecutionClaim,
  input: PendingActionExecutionSuccessInput,
): {
  correlatedOutboxEventId: string;
  resourceId: string;
  result: SuccessResultSnapshot;
} {
  const correlatedOutboxEventId = input.correlatedOutboxEventId;
  const resourceId = input.resourceId;
  assertActionId(correlatedOutboxEventId);
  assertActionId(resourceId);
  if (
    claim.operation !== "create_post" &&
    claim.operation !== "reply_to_content" &&
    claim.operation !== "update_content" &&
    claim.operation !== "delete_content"
  ) {
    throw new RangeError("Only content-write claims can succeed here.");
  }
  const expectedKeys =
    claim.operation === "reply_to_content"
      ? ["content_id", "revision_id", "resource_version", "root_content_id"]
      : claim.operation === "delete_content"
        ? ["content_id", "lifecycle_state", "resource_version"]
        : ["content_id", "revision_id", "resource_version"];
  assertExactDataObject(input.result, expectedKeys, "result");
  const contentId = input.result.content_id;
  const resourceVersion = input.result.resource_version;
  if (typeof contentId !== "string" || !UUID_PATTERN.test(contentId)) {
    throw new RangeError("result.content_id must be a valid UUID.");
  }
  if (!Number.isSafeInteger(resourceVersion) || resourceVersion < 1) {
    throw new RangeError("result.resource_version must be a positive safe integer.");
  }
  if (contentId !== resourceId) {
    throw new RangeError("resourceId must match result.content_id.");
  }
  if (claim.operation === "delete_content") {
    if (input.result.lifecycle_state !== "deleted") {
      throw new RangeError("result.lifecycle_state must be deleted.");
    }
    return {
      correlatedOutboxEventId,
      resourceId,
      result: {
        content_id: contentId,
        lifecycle_state: "deleted",
        resource_version: resourceVersion,
      },
    };
  }
  const rawRevisionId = input.result.revision_id;
  let revisionId: string | null;
  if (claim.operation === "update_content") {
    if (
      rawRevisionId !== null &&
      (typeof rawRevisionId !== "string" || !UUID_PATTERN.test(rawRevisionId))
    ) {
      throw new RangeError(
        "result.revision_id must be a valid UUID, or null for update_content.",
      );
    }
    revisionId = rawRevisionId;
  } else {
    if (typeof rawRevisionId !== "string" || !UUID_PATTERN.test(rawRevisionId)) {
      throw new RangeError(
        "result.revision_id must be a valid UUID, or null for update_content.",
      );
    }
    revisionId = rawRevisionId;
  }
  if (claim.operation === "reply_to_content") {
    const rootContentId = input.result.root_content_id;
    if (typeof rootContentId !== "string" || !UUID_PATTERN.test(rootContentId)) {
      throw new RangeError("result.root_content_id must be a valid UUID.");
    }
    return {
      correlatedOutboxEventId,
      resourceId,
      result: {
        content_id: contentId,
        revision_id: revisionId,
        resource_version: resourceVersion,
        root_content_id: rootContentId,
      },
    };
  }
  return {
    correlatedOutboxEventId,
    resourceId,
    result: {
      content_id: contentId,
      revision_id: revisionId,
      resource_version: resourceVersion,
    },
  };
}

function assertLeaseOwner(leaseOwner: string): void {
  if (
    typeof leaseOwner !== "string" ||
    leaseOwner !== leaseOwner.trim() ||
    leaseOwner.length < 1 ||
    leaseOwner.length > 200 ||
    leaseOwner.includes("\0")
  ) {
    throw new RangeError(
      "leaseOwner must be a trimmed string from 1 through 200 characters.",
    );
  }
}

function assertClaim(claim: PendingActionExecutionClaim, leaseOwner: string): Buffer {
  assertActionId(claim.actionId);
  assertIntegerInRange(
    claim.attemptCount,
    "claim.attemptCount",
    1,
    MAX_ATTEMPT_GENERATION,
  );
  if (claim.leaseOwner !== leaseOwner) {
    throw new RangeError("The claim belongs to a different lease owner.");
  }
  if (
    !Buffer.isBuffer(claim.leaseToken) ||
    claim.leaseToken.length !== LEASE_TOKEN_BYTES
  ) {
    throw new RangeError("claim.leaseToken must be a 32-byte Buffer.");
  }
  return createHash("sha256").update(Buffer.from(claim.leaseToken)).digest();
}

function parseOperation(value: string): PendingActionOperation {
  if (!operationSet.has(value)) {
    throw new Error("PendingAction execution returned an unknown operation.");
  }
  return value as PendingActionOperation;
}

function parseExpectedVersion(
  operation: PendingActionOperation,
  value: string | null,
): number | null {
  const requiresExpectedVersion =
    operation === "update_content" || operation === "delete_content";
  if (value === null) {
    if (requiresExpectedVersion) {
      throw new Error("A content mutation PendingAction requires expected_version.");
    }
    return null;
  }
  if (!requiresExpectedVersion || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("PendingAction expected_version contradicts its operation.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("PendingAction expected_version exceeds the safe integer range.");
  }
  return parsed;
}

function parseState(value: string): PendingActionState {
  if (!stateSet.has(value)) {
    throw new Error("PendingAction execution returned an unknown state.");
  }
  return value as PendingActionState;
}

function terminalDatabaseError(state: ExecutionTerminalState): postgres.JSONValue {
  const definition = terminalErrors[state];
  return {
    code: definition.code,
    message: definition.message,
    retryable: false,
    details: null,
    retry_after_ms: null,
  };
}

function terminalReplayError(state: ExecutionTerminalState): postgres.JSONValue {
  const definition = terminalErrors[state];
  return {
    code: definition.code,
    message: definition.message,
    retryable: false,
    details: null,
    retryAfterMs: null,
  };
}

function writeStatusForState(
  state: PendingActionState,
): "pending_approval" | "succeeded" | "denied" | "failed" {
  switch (state) {
    case "pending_approval":
    case "approved":
    case "executing":
      return "pending_approval";
    case "succeeded":
      return "succeeded";
    case "rejected":
    case "expired":
    case "cancelled":
      return "denied";
    case "failed":
    case "invalidated":
      return "failed";
  }
}

function replayEnvelope(row: ActionProjectionRow): postgres.JSONValue {
  const state = parseState(row.state);
  const operation = parseOperation(row.operation);
  const expectedVersion = parseExpectedVersion(operation, row.expected_version);
  const status = writeStatusForState(state);
  const terminalState =
    state === "expired" || state === "failed" || state === "invalidated" ? state : null;
  return {
    version: 1,
    operation,
    decision: "require_approval",
    status,
    result: state === "succeeded" ? (row.result as postgres.JSONValue) : null,
    pending_action: {
      id: row.id,
      operation,
      state,
      expires_at: row.expires_at.toISOString(),
      input_digest: row.input_digest_text,
      requested_at: row.requested_at.toISOString(),
      decision_id: row.decision_id,
      policy_version: row.policy_version,
      approval_summary: row.approval_summary,
      ...(operation === "update_content" || operation === "delete_content"
        ? { expected_version: expectedVersion }
        : {}),
    },
    error: terminalState === null ? null : terminalReplayError(terminalState),
  };
}

function mapCommittedState(row: CommittedStateRow): PendingActionCommittedState {
  const status = row.idempotency_status;
  if (
    status !== "pending_approval" &&
    status !== "succeeded" &&
    status !== "denied" &&
    status !== "failed"
  ) {
    throw new Error("PendingAction has an invalid idempotency status.");
  }
  return {
    actionId: row.id,
    attemptCount: row.attempt_count,
    error: row.error,
    failureCount: row.failure_count,
    idempotencyResponse: row.idempotency_response,
    idempotencyStatus: status,
    operation: parseOperation(row.operation),
    resourceId: row.resource_id,
    result: row.result,
    state: parseState(row.state),
    terminalAt: row.terminal_at,
    version: row.version,
  };
}

function mapFencedAction(row: FencedActionRow): FencedPendingAction {
  const operation = parseOperation(row.operation);
  if (
    typeof row.idempotency_key !== "string" ||
    row.idempotency_key.length < 1 ||
    row.idempotency_key.length > 200 ||
    row.idempotency_key.trim().length === 0 ||
    /\p{Cc}/u.test(row.idempotency_key)
  ) {
    throw new Error("PendingAction has an invalid idempotency key.");
  }
  return {
    actionId: row.id,
    agentId: row.agent_id,
    attemptCount: row.attempt_count,
    credentialId: row.credential_id,
    decisionAuditId: row.decision_audit_id,
    decisionId: row.decision_id,
    expectedVersion: parseExpectedVersion(operation, row.expected_version),
    expiresAt: row.expires_at,
    failureCount: row.failure_count,
    idempotencyKey: row.idempotency_key,
    idempotencyRecordId: row.idempotency_record_id,
    inputDigest: Buffer.from(row.input_digest),
    normalizedInput: {
      ciphertext: Buffer.from(row.normalized_input_ciphertext),
      formatVersion: row.normalized_input_format_version,
      keyVersion: row.normalized_input_key_version,
      nonce: Buffer.from(row.normalized_input_nonce),
    },
    operation,
    ownerId: row.owner_id,
    policyId: row.policy_id,
    policySnapshot: row.policy_snapshot,
    policyVersion: row.policy_version,
    targetId: row.target_id,
    targetType: row.target_type,
    version: row.version,
  };
}

export class PostgresPendingActionExecutionRepository {
  readonly #claimBatchSize: number;
  readonly #leaseOwner: string;
  readonly #leaseSeconds: number;
  readonly #reapBatchSize: number;
  readonly #retryDelayCapSeconds: number;
  readonly #sql: PostgresClient;

  constructor(sql: PostgresClient, options: PendingActionExecutionRepositoryOptions) {
    assertLeaseOwner(options.leaseOwner);
    const claimBatchSize = options.claimBatchSize ?? DEFAULT_CLAIM_BATCH_SIZE;
    const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    const reapBatchSize = options.reapBatchSize ?? DEFAULT_REAP_BATCH_SIZE;
    const retryDelayCapSeconds =
      options.retryDelayCapSeconds ?? DEFAULT_RETRY_DELAY_CAP_SECONDS;
    assertIntegerInRange(claimBatchSize, "claimBatchSize", 1, MAX_BATCH_SIZE);
    assertIntegerInRange(leaseSeconds, "leaseSeconds", 1, MAX_LEASE_SECONDS);
    assertIntegerInRange(reapBatchSize, "reapBatchSize", 1, MAX_BATCH_SIZE);
    assertIntegerInRange(
      retryDelayCapSeconds,
      "retryDelayCapSeconds",
      1,
      MAX_RETRY_DELAY_CAP_SECONDS,
    );
    this.#sql = sql;
    this.#leaseOwner = options.leaseOwner;
    this.#claimBatchSize = claimBatchSize;
    this.#leaseSeconds = leaseSeconds;
    this.#reapBatchSize = reapBatchSize;
    this.#retryDelayCapSeconds = retryDelayCapSeconds;
  }

  async checkReady(): Promise<void> {
    const rows = await this.#sql.begin(async (transaction) => {
      await transaction`set local statement_timeout = '1500ms'`;
      return transaction<ReadyRow[]>`
        select
          exists (
            select 1
            from system.schema_migrations
            where version = '000007'
              and name = 'pending_action_execution'
              and checksum = ${PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM}
          )
          and to_regclass('platform.pending_action_attempts') is not null
          and to_regclass('platform.pending_actions_approved_due_idx') is not null
          and to_regclass('platform.pending_actions_approval_expiry_idx') is not null
          and to_regclass('platform.pending_actions_lease_reaper_idx') is not null
          and to_regclass('platform.idempotency_records_pending_action_idx') is not null
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.pending_actions')
              and tgname = 'pending_actions_sync_attempt'
              and not tgisinternal
          ) as ready
      `;
    });
    if (rows[0]?.ready !== true) {
      throw new Error("PendingAction execution schema is not ready.");
    }
  }

  async claimNext(): Promise<PendingActionExecutionClaim | null> {
    return (await this.claimBatch(1))[0] ?? null;
  }

  async claimBatch(
    requestedBatchSize: number = this.#claimBatchSize,
  ): Promise<PendingActionExecutionClaim[]> {
    assertIntegerInRange(requestedBatchSize, "batchSize", 1, MAX_BATCH_SIZE);
    return this.#sql.begin(async (transaction) => {
      const candidates = await transaction<{ id: string }[]>`
        select action.id
        from platform.pending_actions as action
        where action.state = 'approved'
          and action.next_attempt_at <= clock_timestamp()
          and action.expires_at > clock_timestamp()
          and action.attempt_count < ${MAX_ATTEMPT_GENERATION}
          and action.failure_count < ${MAX_FAILURES}
        order by action.next_attempt_at, action.id
        for update of action skip locked
        limit ${requestedBatchSize}
      `;

      const claims: PendingActionExecutionClaim[] = [];
      for (const candidate of candidates) {
        const leaseToken = randomBytes(LEASE_TOKEN_BYTES);
        const leaseTokenDigest = createHash("sha256").update(leaseToken).digest();
        const rows = await transaction<ClaimRow[]>`
          with database_clock as materialized (
            select clock_timestamp() as now
          )
          update platform.pending_actions as action
          set state = 'executing',
              version = action.version + 1,
              executing_at = database_clock.now,
              lease_owner = ${this.#leaseOwner},
              lease_token_digest = ${leaseTokenDigest},
              lease_expires_at = database_clock.now
                + make_interval(secs => ${this.#leaseSeconds}),
              last_heartbeat_at = database_clock.now,
              attempt_count = action.attempt_count + 1,
              next_attempt_at = null
          from database_clock
          where action.id = ${candidate.id}
            and action.state = 'approved'
            and action.next_attempt_at <= database_clock.now
            and action.expires_at > database_clock.now
            and action.attempt_count < ${MAX_ATTEMPT_GENERATION}
            and action.failure_count < ${MAX_FAILURES}
          returning
            action.id,
            action.owner_id,
            action.agent_id,
            action.operation,
            action.state,
            action.version::text as version,
            action.attempt_count,
            action.failure_count,
            action.lease_expires_at,
            action.requested_at,
            action.expires_at,
            action.terminal_at,
            action.result,
            action.error,
            action.idempotency_record_id,
            action.decision_id,
            action.policy_version::text as policy_version,
            action.expected_version::text as expected_version,
            action.approval_summary,
            'sha256:' || encode(action.input_digest, 'hex') as input_digest_text
        `;
        const row = rows[0];
        if (!row) {
          continue;
        }
        const auditId = await this.#writeTransitionAudit(transaction, row, {
          action: "pending_action.claimed",
          afterState: "executing",
          beforeState: "approved",
          errorCode: null,
          outcome: "pending",
          reasonCode: "worker_claimed",
        });
        await this.#attachAttemptAudit(transaction, row, auditId, "claim");
        await this.#syncIdempotency(transaction, row);
        claims.push({
          actionId: row.id,
          attemptCount: row.attempt_count,
          leaseExpiresAt: row.lease_expires_at,
          leaseOwner: this.#leaseOwner,
          leaseToken: Buffer.from(leaseToken),
          operation: parseOperation(row.operation),
          version: row.version,
        });
      }
      return claims;
    });
  }

  async renewHeartbeat(
    claim: PendingActionExecutionClaim,
  ): Promise<PendingActionHeartbeatResult> {
    const leaseTokenDigest = assertClaim(claim, this.#leaseOwner);
    return this.#sql.begin(async (transaction) => {
      const rows = await transaction<HeartbeatRow[]>`
        with database_clock as materialized (
          select clock_timestamp() as now
        )
        update platform.pending_actions as action
        set version = action.version + 1,
            last_heartbeat_at = database_clock.now,
            lease_expires_at = greatest(
              action.lease_expires_at,
              database_clock.now + make_interval(secs => ${this.#leaseSeconds})
            )
        from database_clock
        where action.id = ${claim.actionId}
          and action.state = 'executing'
          and action.attempt_count = ${claim.attemptCount}
          and action.lease_owner = ${this.#leaseOwner}
          and action.lease_token_digest = ${leaseTokenDigest}
          and action.lease_expires_at > database_clock.now
        returning
          action.version::text as version,
          action.lease_expires_at
      `;
      const renewed = rows[0];
      if (renewed) {
        return {
          action: null,
          leaseExpiresAt: renewed.lease_expires_at,
          renewed: true,
          version: renewed.version,
        };
      }
      return {
        action: await this.#readCommittedState(transaction, claim.actionId),
        leaseExpiresAt: null,
        renewed: false,
        version: null,
      };
    });
  }

  async withFencedClaim<T>(
    claim: PendingActionExecutionClaim,
    callback: (transaction: TransactionSql, action: FencedPendingAction) => Promise<T>,
  ): Promise<T> {
    const leaseTokenDigest = assertClaim(claim, this.#leaseOwner);
    const result = await this.#sql.begin(async (transaction) => {
      const row = await this.#readFencedAction(transaction, claim, leaseTokenDigest);
      if (!row) {
        throw new PendingActionLeaseLostError(claim.actionId, claim.attemptCount);
      }
      return { value: await callback(transaction, mapFencedAction(row)) };
    });
    return result.value;
  }

  async finalizeSucceeded(
    transaction: TransactionSql,
    claim: PendingActionExecutionClaim,
    input: PendingActionExecutionSuccessInput,
  ): Promise<PendingActionExecutionSuccessResult> {
    const leaseTokenDigest = assertClaim(claim, this.#leaseOwner);
    const snapshot = snapshotSuccessInput(claim, input);
    const expectedEventType =
      claim.operation === "create_post"
        ? "content.published"
        : claim.operation === "reply_to_content"
          ? "content.reply"
          : claim.operation === "update_content"
            ? "content.revised"
            : "content.deleted";
    const correlations = await transaction<IdRow[]>`
      select event.id
      from system.outbox_events as event
      where event.id = ${snapshot.correlatedOutboxEventId}
        and event.aggregate_type = 'content'
        and event.aggregate_id = ${snapshot.resourceId}
        and event.event_type = ${expectedEventType}
      for share of event
    `;
    if (correlations.length !== 1) {
      throw new Error(
        "The successful PendingAction requires its correlated content Outbox event.",
      );
    }

    const rows = await transaction<ActionProjectionRow[]>`
      with database_clock as materialized (
        select clock_timestamp() as now
      )
      update platform.pending_actions as action
      set state = 'succeeded',
          version = action.version + 1,
          result = ${transaction.json(snapshot.result)},
          completed_at = database_clock.now,
          terminal_at = database_clock.now
      from database_clock
      where action.id = ${claim.actionId}
        and action.state = 'executing'
        and action.operation = ${claim.operation}
        and action.attempt_count = ${claim.attemptCount}
        and action.lease_owner = ${this.#leaseOwner}
        and action.lease_token_digest = ${leaseTokenDigest}
        and action.lease_expires_at > database_clock.now
        and (
          action.operation not in ('update_content', 'delete_content')
          or action.expected_version + 1 = ${snapshot.result.resource_version}
        )
      returning
        action.id,
        action.owner_id,
        action.agent_id,
        action.operation,
        action.state,
        action.version::text as version,
        action.attempt_count,
        action.failure_count,
        action.requested_at,
        action.expires_at,
        action.terminal_at,
        action.result,
        action.error,
        action.idempotency_record_id,
        action.decision_id,
        action.policy_version::text as policy_version,
        action.expected_version::text as expected_version,
        action.approval_summary,
        'sha256:' || encode(action.input_digest, 'hex') as input_digest_text
    `;
    const row = rows[0];
    if (!row) {
      throw new PendingActionLeaseLostError(claim.actionId, claim.attemptCount);
    }
    const expectedVersion = parseExpectedVersion(
      parseOperation(row.operation),
      row.expected_version,
    );
    if (
      (claim.operation === "update_content" || claim.operation === "delete_content") &&
      (expectedVersion === null ||
        snapshot.result.resource_version !== expectedVersion + 1)
    ) {
      throw new RangeError(
        "A content mutation result must advance expected_version by exactly one.",
      );
    }

    const resolvedOutbox = await appendOutboxEvent(transaction, {
      aggregateId: row.id,
      aggregateType: "pending_action",
      eventType: "action.resolved",
      eventVersion: 1,
      occurredAt: row.terminal_at!,
      payload: {
        action_id: row.id,
        correlated_outbox_event_id: snapshot.correlatedOutboxEventId,
        operation: parseOperation(row.operation),
        resource_id: snapshot.resourceId,
        result: snapshot.result,
        state: "succeeded",
      },
    });
    const auditId = await this.#writeTransitionAudit(transaction, row, {
      action: "pending_action.succeeded",
      afterState: "succeeded",
      beforeState: "executing",
      errorCode: null,
      outboxEventId: resolvedOutbox.id,
      outcome: "succeeded",
      reasonCode: "execution_succeeded",
    });
    await this.#attachAttemptAudit(transaction, row, auditId, "finish");
    await this.#syncIdempotency(transaction, row, {
      resourceId: snapshot.resourceId,
    });
    const action = await this.#readCommittedState(transaction, claim.actionId);
    if (!action || action.state !== "succeeded") {
      throw new Error("PendingAction success did not produce a committed projection.");
    }
    return {
      action,
      resolvedOutboxEventId: resolvedOutbox.id,
    };
  }

  async scheduleRetry(
    claim: PendingActionExecutionClaim,
    options: PendingActionRetryOptions = {},
  ): Promise<PendingActionCasResult> {
    const leaseTokenDigest = assertClaim(claim, this.#leaseOwner);
    const budgetDisposition = options.budgetDisposition ?? "consume_failure";
    if (budgetDisposition !== "consume_failure" && budgetDisposition !== "defer") {
      throw new RangeError("budgetDisposition must be consume_failure or defer.");
    }
    const explicitMaximumDelaySeconds = options.maximumDelaySeconds;
    const minimumDelaySeconds = options.minimumDelaySeconds ?? 0;
    if (explicitMaximumDelaySeconds !== undefined) {
      assertIntegerInRange(
        explicitMaximumDelaySeconds,
        "maximumDelaySeconds",
        0,
        MAX_RETRY_DELAY_CAP_SECONDS,
      );
    }
    assertIntegerInRange(
      minimumDelaySeconds,
      "minimumDelaySeconds",
      0,
      MAX_RETRY_DELAY_CAP_SECONDS,
    );
    if (
      explicitMaximumDelaySeconds !== undefined &&
      minimumDelaySeconds > explicitMaximumDelaySeconds
    ) {
      throw new RangeError(
        "minimumDelaySeconds must be less than or equal to maximumDelaySeconds.",
      );
    }
    return this.#sql.begin(async (transaction) => {
      const locked = await this.#lockFencedAction(transaction, claim, leaseTokenDigest);
      if (!locked) {
        return {
          action: await this.#readCommittedState(transaction, claim.actionId),
          applied: false,
        };
      }

      const consumesFailure = budgetDisposition === "consume_failure";
      const nextFailureCount = locked.failure_count + (consumesFailure ? 1 : 0);
      const exponentialFullJitterCap = Math.min(
        this.#retryDelayCapSeconds,
        2 ** Math.min(nextFailureCount, MAX_FAILURES),
      );
      const maximumDelaySeconds =
        explicitMaximumDelaySeconds ??
        (consumesFailure ? exponentialFullJitterCap : this.#retryDelayCapSeconds);
      if (minimumDelaySeconds > maximumDelaySeconds) {
        throw new RangeError(
          "minimumDelaySeconds must be less than or equal to maximumDelaySeconds.",
        );
      }

      const failureBudgetExhausted = consumesFailure && nextFailureCount >= MAX_FAILURES;
      const retryWindowExhausted =
        locked.expires_at.valueOf() <=
        locked.database_now.valueOf() + minimumDelaySeconds * 1_000 + 1;
      if (failureBudgetExhausted || retryWindowExhausted) {
        const applied = await this.#finishFencedAction(
          transaction,
          locked,
          claim,
          leaseTokenDigest,
          "failed",
          "pending_action.failed",
          failureBudgetExhausted ? "max_failures_exhausted" : "retry_window_exhausted",
          consumesFailure && locked.failure_count < MAX_FAILURES,
        );
        return {
          action: await this.#readCommittedState(transaction, claim.actionId),
          applied,
        };
      }

      const rows = await transaction<ActionProjectionRow[]>`
        with database_clock as materialized (
          select clock_timestamp() as now
        )
        update platform.pending_actions as action
        set state = 'approved',
            version = action.version + 1,
            failure_count = action.failure_count + ${consumesFailure ? 1 : 0},
            executing_at = null,
            completed_at = null,
            lease_owner = null,
            lease_token_digest = null,
            lease_expires_at = null,
            last_heartbeat_at = null,
            next_attempt_at = least(
              database_clock.now
                + make_interval(
                    secs => ${minimumDelaySeconds}::double precision
                      + random() * (
                          ${maximumDelaySeconds}::double precision
                          - ${minimumDelaySeconds}::double precision
                        )
                  ),
              action.expires_at - interval '1 millisecond'
            )
        from database_clock
        where action.id = ${claim.actionId}
          and action.state = 'executing'
          and action.attempt_count = ${claim.attemptCount}
          and action.lease_owner = ${this.#leaseOwner}
          and action.lease_token_digest = ${leaseTokenDigest}
          and action.lease_expires_at > database_clock.now
          and action.attempt_count <= ${MAX_ATTEMPT_GENERATION}
          and action.failure_count = ${locked.failure_count}
          and action.failure_count + ${consumesFailure ? 1 : 0} < ${MAX_FAILURES}
          and action.expires_at > database_clock.now
            + make_interval(secs => ${minimumDelaySeconds})
            + interval '1 millisecond'
        returning
          action.id,
          action.owner_id,
          action.agent_id,
          action.operation,
          action.state,
          action.version::text as version,
          action.attempt_count,
          action.failure_count,
          action.requested_at,
          action.expires_at,
          action.terminal_at,
          action.result,
          action.error,
          action.idempotency_record_id,
          action.decision_id,
          action.policy_version::text as policy_version,
          action.expected_version::text as expected_version,
          action.approval_summary,
          'sha256:' || encode(action.input_digest, 'hex') as input_digest_text
      `;
      const row = rows[0];
      if (!row) {
        return {
          action: await this.#readCommittedState(transaction, claim.actionId),
          applied: false,
        };
      }
      const auditId = await this.#writeTransitionAudit(transaction, row, {
        action:
          budgetDisposition === "defer"
            ? "pending_action.execution_deferred"
            : "pending_action.retry_scheduled",
        afterState: "approved",
        beforeFailureCount: locked.failure_count,
        beforeState: "executing",
        errorCode: null,
        outcome: "pending",
        reasonCode:
          budgetDisposition === "defer" ? "rate_or_quota_deferred" : "retry_scheduled",
      });
      await this.#attachAttemptAudit(transaction, row, auditId, "finish");
      await this.#syncIdempotency(transaction, row);
      return {
        action: await this.#readCommittedState(transaction, claim.actionId),
        applied: true,
      };
    });
  }

  async markInvalidated(
    claim: PendingActionExecutionClaim,
  ): Promise<PendingActionCasResult> {
    return this.#markFencedTerminal(claim, "invalidated");
  }

  async markFailed(claim: PendingActionExecutionClaim): Promise<PendingActionCasResult> {
    return this.#markFencedTerminal(claim, "failed");
  }

  async readCommittedState(
    actionId: string,
  ): Promise<PendingActionCommittedState | null> {
    assertActionId(actionId);
    return this.#readCommittedState(this.#sql, actionId);
  }

  async reap(
    requestedBatchSize: number = this.#reapBatchSize,
  ): Promise<PendingActionReapResult> {
    assertIntegerInRange(requestedBatchSize, "batchSize", 1, MAX_BATCH_SIZE);
    return this.#sql.begin(async (transaction) => {
      const candidates = await transaction<ReapCandidateRow[]>`
        select
          action.id,
          action.state,
          action.version::text as version,
          action.attempt_count,
          action.failure_count,
          action.expires_at,
          clock_timestamp() as database_now
        from platform.pending_actions as action
        where (
            action.state in ('pending_approval', 'approved')
            and action.expires_at <= clock_timestamp()
          )
          or (
            action.state = 'executing'
            and action.lease_expires_at <= clock_timestamp()
          )
        order by
          case
            when action.state = 'executing' then action.lease_expires_at
            else action.expires_at
          end,
          action.id
        for update of action skip locked
        limit ${requestedBatchSize}
      `;

      let expired = 0;
      let failed = 0;
      let recovered = 0;
      for (const candidate of candidates) {
        if (candidate.state === "pending_approval" || candidate.state === "approved") {
          if (await this.#expireLockedAction(transaction, candidate)) {
            expired += 1;
          }
          continue;
        }

        const hasRetryWindow =
          candidate.expires_at.valueOf() > candidate.database_now.valueOf() + 1;
        if (
          candidate.failure_count + 1 >= MAX_FAILURES ||
          candidate.attempt_count >= MAX_ATTEMPT_GENERATION ||
          !hasRetryWindow
        ) {
          if (await this.#failExpiredLease(transaction, candidate)) {
            failed += 1;
          }
          continue;
        }
        if (await this.#recoverExpiredLease(transaction, candidate)) {
          recovered += 1;
        }
      }
      return {
        expired,
        failed,
        processed: expired + failed + recovered,
        recovered,
      };
    });
  }

  async #markFencedTerminal(
    claim: PendingActionExecutionClaim,
    state: "failed" | "invalidated",
  ): Promise<PendingActionCasResult> {
    const leaseTokenDigest = assertClaim(claim, this.#leaseOwner);
    return this.#sql.begin(async (transaction) => {
      const locked = await this.#lockFencedAction(transaction, claim, leaseTokenDigest);
      if (!locked) {
        return {
          action: await this.#readCommittedState(transaction, claim.actionId),
          applied: false,
        };
      }
      const applied = await this.#finishFencedAction(
        transaction,
        locked,
        claim,
        leaseTokenDigest,
        state,
        state === "failed" ? "pending_action.failed" : "pending_action.invalidated",
        state === "failed" ? "execution_failed" : "action_invalidated",
      );
      return {
        action: await this.#readCommittedState(transaction, claim.actionId),
        applied,
      };
    });
  }

  async #finishFencedAction(
    transaction: TransactionSql,
    locked: FencedActionRow,
    claim: PendingActionExecutionClaim,
    leaseTokenDigest: Buffer,
    state: "failed" | "invalidated",
    auditAction: string,
    reasonCode: string,
    consumeFailureBudget = false,
  ): Promise<boolean> {
    const rows = await transaction<ActionProjectionRow[]>`
      with database_clock as materialized (
        select clock_timestamp() as now
      )
      update platform.pending_actions as action
      set state = ${state},
          version = action.version + 1,
          failure_count = action.failure_count + ${consumeFailureBudget ? 1 : 0},
          error = ${transaction.json(terminalDatabaseError(state))},
          terminal_at = database_clock.now,
          completed_at = case
            when ${state} = 'failed' then database_clock.now
            else action.completed_at
          end
      from database_clock
      where action.id = ${claim.actionId}
        and action.state = 'executing'
        and action.attempt_count = ${claim.attemptCount}
        and action.lease_owner = ${this.#leaseOwner}
        and action.lease_token_digest = ${leaseTokenDigest}
        and action.lease_expires_at > database_clock.now
        and action.failure_count = ${locked.failure_count}
        and action.failure_count + ${consumeFailureBudget ? 1 : 0}
          <= ${MAX_FAILURES}
      returning
        action.id,
        action.owner_id,
        action.agent_id,
        action.operation,
        action.state,
        action.version::text as version,
        action.attempt_count,
        action.failure_count,
        action.requested_at,
        action.expires_at,
        action.terminal_at,
        action.result,
        action.error,
        action.idempotency_record_id,
        action.decision_id,
        action.policy_version::text as policy_version,
        action.expected_version::text as expected_version,
        action.approval_summary,
        'sha256:' || encode(action.input_digest, 'hex') as input_digest_text
    `;
    const row = rows[0];
    if (!row) {
      return false;
    }
    const auditId = await this.#writeTransitionAudit(transaction, row, {
      action: auditAction,
      afterState: state,
      beforeFailureCount: locked.failure_count,
      beforeState: "executing",
      errorCode: terminalErrors[state].code,
      outcome: "failed",
      reasonCode,
    });
    await this.#attachAttemptAudit(transaction, row, auditId, "finish");
    await this.#syncIdempotency(transaction, row);
    if (locked.id !== row.id) {
      throw new Error("PendingAction fence changed during terminal transition.");
    }
    return true;
  }

  async #expireLockedAction(
    transaction: TransactionSql,
    candidate: ReapCandidateRow,
  ): Promise<boolean> {
    const rows = await transaction<ActionProjectionRow[]>`
      with database_clock as materialized (
        select clock_timestamp() as now
      )
      update platform.pending_actions as action
      set state = 'expired',
          version = action.version + 1,
          error = ${transaction.json(terminalDatabaseError("expired"))},
          terminal_at = database_clock.now
      from database_clock
      where action.id = ${candidate.id}
        and action.version = ${candidate.version}
        and action.state = ${candidate.state}
        and action.expires_at <= database_clock.now
      returning
        action.id,
        action.owner_id,
        action.agent_id,
        action.operation,
        action.state,
        action.version::text as version,
        action.attempt_count,
        action.failure_count,
        action.requested_at,
        action.expires_at,
        action.terminal_at,
        action.result,
        action.error,
        action.idempotency_record_id,
        action.decision_id,
        action.policy_version::text as policy_version,
        action.expected_version::text as expected_version,
        action.approval_summary,
        'sha256:' || encode(action.input_digest, 'hex') as input_digest_text
    `;
    const row = rows[0];
    if (!row) return false;
    await this.#writeTransitionAudit(transaction, row, {
      action: "pending_action.expired",
      afterState: "expired",
      beforeState: candidate.state,
      errorCode: terminalErrors.expired.code,
      outcome: "denied",
      reasonCode: "action_expired",
    });
    await this.#syncIdempotency(transaction, row);
    return true;
  }

  async #recoverExpiredLease(
    transaction: TransactionSql,
    candidate: ReapCandidateRow,
  ): Promise<boolean> {
    const nextFailureCount = candidate.failure_count + 1;
    const exponentialCap = Math.min(
      this.#retryDelayCapSeconds,
      2 ** Math.min(nextFailureCount, MAX_FAILURES),
    );
    const rows = await transaction<ActionProjectionRow[]>`
      with database_clock as materialized (
        select clock_timestamp() as now
      )
      update platform.pending_actions as action
      set state = 'approved',
          version = action.version + 1,
          failure_count = action.failure_count + 1,
          executing_at = null,
          completed_at = null,
          lease_owner = null,
          lease_token_digest = null,
          lease_expires_at = null,
          last_heartbeat_at = null,
          next_attempt_at = least(
            database_clock.now
              + make_interval(
                  secs => random() * ${exponentialCap}::double precision
                ),
            action.expires_at - interval '1 millisecond'
          )
      from database_clock
      where action.id = ${candidate.id}
        and action.version = ${candidate.version}
        and action.state = 'executing'
        and action.attempt_count = ${candidate.attempt_count}
        and action.attempt_count < ${MAX_ATTEMPT_GENERATION}
        and action.failure_count = ${candidate.failure_count}
        and action.failure_count + 1 < ${MAX_FAILURES}
        and action.lease_expires_at <= database_clock.now
        and action.expires_at > database_clock.now + interval '1 millisecond'
      returning
        action.id,
        action.owner_id,
        action.agent_id,
        action.operation,
        action.state,
        action.version::text as version,
        action.attempt_count,
        action.failure_count,
        action.requested_at,
        action.expires_at,
        action.terminal_at,
        action.result,
        action.error,
        action.idempotency_record_id,
        action.decision_id,
        action.policy_version::text as policy_version,
        action.expected_version::text as expected_version,
        action.approval_summary,
        'sha256:' || encode(action.input_digest, 'hex') as input_digest_text
    `;
    const row = rows[0];
    if (!row) return false;
    const auditId = await this.#writeTransitionAudit(transaction, row, {
      action: "pending_action.lease_recovered",
      afterState: "approved",
      beforeFailureCount: candidate.failure_count,
      beforeState: "executing",
      errorCode: null,
      outcome: "pending",
      reasonCode: "lease_expired",
    });
    await this.#attachAttemptAudit(transaction, row, auditId, "finish");
    await this.#syncIdempotency(transaction, row);
    return true;
  }

  async #failExpiredLease(
    transaction: TransactionSql,
    candidate: ReapCandidateRow,
  ): Promise<boolean> {
    const rows = await transaction<ActionProjectionRow[]>`
      with database_clock as materialized (
        select clock_timestamp() as now
      )
      update platform.pending_actions as action
      set state = 'failed',
          version = action.version + 1,
          failure_count = least(action.failure_count + 1, ${MAX_FAILURES}),
          error = ${transaction.json(terminalDatabaseError("failed"))},
          terminal_at = database_clock.now,
          completed_at = database_clock.now
      from database_clock
      where action.id = ${candidate.id}
        and action.version = ${candidate.version}
        and action.state = 'executing'
        and action.attempt_count = ${candidate.attempt_count}
        and action.failure_count = ${candidate.failure_count}
        and action.lease_expires_at <= database_clock.now
        and (
          action.failure_count + 1 >= ${MAX_FAILURES}
          or action.attempt_count >= ${MAX_ATTEMPT_GENERATION}
          or action.expires_at <= database_clock.now + interval '1 millisecond'
        )
      returning
        action.id,
        action.owner_id,
        action.agent_id,
        action.operation,
        action.state,
        action.version::text as version,
        action.attempt_count,
        action.failure_count,
        action.requested_at,
        action.expires_at,
        action.terminal_at,
        action.result,
        action.error,
        action.idempotency_record_id,
        action.decision_id,
        action.policy_version::text as policy_version,
        action.expected_version::text as expected_version,
        action.approval_summary,
        'sha256:' || encode(action.input_digest, 'hex') as input_digest_text
    `;
    const row = rows[0];
    if (!row) return false;
    const failureBudgetExhausted = candidate.failure_count + 1 >= MAX_FAILURES;
    const generationExhausted = candidate.attempt_count >= MAX_ATTEMPT_GENERATION;
    const auditId = await this.#writeTransitionAudit(transaction, row, {
      action: "pending_action.failed",
      afterState: "failed",
      beforeFailureCount: candidate.failure_count,
      beforeState: "executing",
      errorCode: terminalErrors.failed.code,
      outcome: "failed",
      reasonCode: failureBudgetExhausted
        ? "max_failures_exhausted"
        : generationExhausted
          ? "fence_generation_exhausted"
          : "retry_window_exhausted",
    });
    await this.#attachAttemptAudit(transaction, row, auditId, "finish");
    await this.#syncIdempotency(transaction, row);
    return true;
  }

  async #readFencedAction(
    transaction: TransactionSql,
    claim: PendingActionExecutionClaim,
    leaseTokenDigest: Buffer,
  ): Promise<FencedActionRow | null> {
    const rows = await transaction<FencedActionRow[]>`
      select
        action.id,
        action.owner_id,
        action.agent_id,
        action.credential_id,
        action.operation,
        action.target_type,
        action.target_id,
        action.normalized_input_ciphertext,
        action.normalized_input_nonce,
        action.normalized_input_key_version,
        action.normalized_input_format_version,
        action.idempotency_key,
        action.input_digest,
        action.expected_version::text as expected_version,
        action.policy_id,
        action.policy_version::text as policy_version,
        action.policy_snapshot,
        action.state,
        action.version::text as version,
        action.attempt_count,
        action.failure_count,
        action.requested_at,
        action.expires_at,
        action.terminal_at,
        action.result,
        action.error,
        action.idempotency_record_id,
        action.decision_id,
        action.decision_audit_id,
        action.approval_summary,
        'sha256:' || encode(action.input_digest, 'hex') as input_digest_text,
        clock_timestamp() as database_now
      from platform.pending_actions as action
      where action.id = ${claim.actionId}
        and action.state = 'executing'
        and action.attempt_count = ${claim.attemptCount}
        and action.lease_owner = ${this.#leaseOwner}
        and action.lease_token_digest = ${leaseTokenDigest}
        and action.lease_expires_at > clock_timestamp()
    `;
    return rows[0] ?? null;
  }

  async #lockFencedAction(
    transaction: TransactionSql,
    claim: PendingActionExecutionClaim,
    leaseTokenDigest: Buffer,
  ): Promise<FencedActionRow | null> {
    const rows = await transaction<FencedActionRow[]>`
      select
        action.id,
        action.owner_id,
        action.agent_id,
        action.credential_id,
        action.operation,
        action.target_type,
        action.target_id,
        action.normalized_input_ciphertext,
        action.normalized_input_nonce,
        action.normalized_input_key_version,
        action.normalized_input_format_version,
        action.idempotency_key,
        action.input_digest,
        action.expected_version::text as expected_version,
        action.policy_id,
        action.policy_version::text as policy_version,
        action.policy_snapshot,
        action.state,
        action.version::text as version,
        action.attempt_count,
        action.failure_count,
        action.requested_at,
        action.expires_at,
        action.terminal_at,
        action.result,
        action.error,
        action.idempotency_record_id,
        action.decision_id,
        action.decision_audit_id,
        action.approval_summary,
        'sha256:' || encode(action.input_digest, 'hex') as input_digest_text,
        clock_timestamp() as database_now
      from platform.pending_actions as action
      where action.id = ${claim.actionId}
        and action.state = 'executing'
        and action.attempt_count = ${claim.attemptCount}
        and action.lease_owner = ${this.#leaseOwner}
        and action.lease_token_digest = ${leaseTokenDigest}
        and action.lease_expires_at > clock_timestamp()
      for update of action
    `;
    return rows[0] ?? null;
  }

  async #syncIdempotency(
    transaction: TransactionSql,
    action: ActionProjectionRow,
    options: { resourceId?: string | undefined } = {},
  ): Promise<void> {
    const state = parseState(action.state);
    const status = writeStatusForState(state);
    const terminal =
      state === "succeeded" ||
      state === "expired" ||
      state === "failed" ||
      state === "invalidated";
    const operation = parseOperation(action.operation);
    const successResponseCode =
      operation === "update_content" || operation === "delete_content" ? 200 : 201;
    let resourceId: string | null = null;
    if (state === "succeeded") {
      if (options.resourceId === undefined) {
        throw new Error("Successful PendingAction idempotency requires a resource ID.");
      }
      resourceId = options.resourceId;
    }
    const rows = terminal
      ? await transaction<IdRow[]>`
          update platform.idempotency_records as idempotency
          set status = ${status},
              response_code = ${state === "succeeded" ? successResponseCode : 409},
              response_body = ${transaction.json(replayEnvelope(action))},
              resource_id = ${resourceId},
              terminal_at = ${action.terminal_at},
              expires_at = greatest(
                idempotency.expires_at,
                ${action.terminal_at} + interval '7 days'
              )
          where idempotency.id = ${action.idempotency_record_id}
            and idempotency.pending_action_id = ${action.id}
            and idempotency.status = 'pending_approval'
            and idempotency.terminal_at is null
          returning idempotency.id
        `
      : await transaction<IdRow[]>`
          update platform.idempotency_records as idempotency
          set status = 'pending_approval',
              response_code = 202,
              response_body = ${transaction.json(replayEnvelope(action))}
          where idempotency.id = ${action.idempotency_record_id}
            and idempotency.pending_action_id = ${action.id}
            and idempotency.status = 'pending_approval'
            and idempotency.terminal_at is null
          returning idempotency.id
        `;
    if (rows.length !== 1) {
      throw new Error("PendingAction transition could not synchronize idempotency.");
    }
  }

  async #writeTransitionAudit(
    transaction: TransactionSql,
    row: Pick<
      ActionProjectionRow,
      "agent_id" | "attempt_count" | "failure_count" | "id" | "owner_id"
    >,
    input: TransitionAuditInput,
  ): Promise<string> {
    const rows = await transaction<IdRow[]>`
      insert into platform.action_logs (
        event_class,
        occurred_at,
        owner_id,
        agent_id,
        channel,
        action,
        target_type,
        target_id,
        decision,
        outcome,
        error_code,
        retry_count,
        outbox_event_id,
        request_id,
        before_state,
        after_state,
        reason_code
      )
      values (
        'pending_action_transition',
        clock_timestamp(),
        ${row.owner_id},
        ${row.agent_id},
        'worker',
        ${input.action},
        'pending_action',
        ${row.id},
        'require_approval',
        ${input.outcome},
        ${input.errorCode},
        ${row.failure_count},
        ${input.outboxEventId ?? null},
        ${`worker:${randomUUID()}`},
        ${transaction.json({
          attempt_count: row.attempt_count,
          failure_count: input.beforeFailureCount ?? row.failure_count,
          state: input.beforeState,
        })},
        ${transaction.json({
          attempt_count: row.attempt_count,
          failure_count: row.failure_count,
          state: input.afterState,
        })},
        ${input.reasonCode}
      )
      returning id
    `;
    const auditId = rows[0]?.id;
    if (!auditId) {
      throw new Error("PendingAction transition audit insert returned no ID.");
    }
    return auditId;
  }

  async #attachAttemptAudit(
    transaction: TransactionSql,
    row: Pick<ActionProjectionRow, "attempt_count" | "id">,
    auditId: string,
    phase: "claim" | "finish",
  ): Promise<void> {
    const rows =
      phase === "claim"
        ? await transaction<IdRow[]>`
            update platform.pending_action_attempts
            set claim_audit_id = ${auditId}
            where action_id = ${row.id}
              and attempt_number = ${row.attempt_count}
              and outcome = 'executing'
              and claim_audit_id is null
            returning action_id as id
          `
        : await transaction<IdRow[]>`
            update platform.pending_action_attempts
            set finish_audit_id = ${auditId}
            where action_id = ${row.id}
              and attempt_number = ${row.attempt_count}
              and outcome <> 'executing'
              and finish_audit_id is null
            returning action_id as id
          `;
    if (rows.length !== 1) {
      throw new Error("PendingAction attempt could not attach its transition audit.");
    }
  }

  async #readCommittedState(
    sql: PostgresClient | TransactionSql,
    actionId: string,
  ): Promise<PendingActionCommittedState | null> {
    const rows = await sql<CommittedStateRow[]>`
      select
        action.id,
        action.operation,
        action.state,
        action.version::text as version,
        action.attempt_count,
        action.failure_count,
        action.terminal_at,
        action.result,
        action.error,
        idempotency.status as idempotency_status,
        idempotency.response_body as idempotency_response,
        idempotency.resource_id
      from platform.pending_actions as action
      join platform.idempotency_records as idempotency
        on idempotency.id = action.idempotency_record_id
       and idempotency.pending_action_id = action.id
      where action.id = ${actionId}
    `;
    return rows[0] ? mapCommittedState(rows[0]) : null;
  }
}
