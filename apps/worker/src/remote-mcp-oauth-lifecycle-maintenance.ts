import { REMOTE_MCP_OAUTH_CAPACITY_POLICY } from "@alphanet/config/remote-mcp-oauth-capacity";
import type { PostgresClient } from "@alphanet/database";
import type { Logger } from "pino";

const DEFAULT_BOOTSTRAP_GRACE_SECONDS = 120;
const DEFAULT_ENVELOPE_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const MAXIMUM_BATCH_SIZE = 1_000;
const MAXIMUM_BACKLOG_OBSERVATION_CAP = 100_000;
const MAXIMUM_ROWS_PER_STAGE = 100_000;

interface BacklogRow {
  expired_envelope_count: number | string;
  expired_envelope_oldest_age_seconds: number | string | null;
  purgeable_envelope_count: number | string;
  purgeable_envelope_oldest_age_seconds: number | string | null;
  unreconciled_grant_count: number | string;
  unreconciled_grant_oldest_age_seconds: number | string | null;
}

interface CountRow {
  count: number | string;
}

interface ReconciliationRow {
  coherent_count: number | string;
  inspected_count: number | string;
  terminated_count: number | string;
}

export interface RemoteMcpOAuthLifecycleBacklog {
  alarmThresholdExceeded: boolean;
  expiredEnvelopes: number;
  expiredEnvelopesOldestAgeSeconds: number | null;
  maximumCount: number;
  observationCapped: boolean;
  purgeableEnvelopes: number;
  purgeableEnvelopesOldestAgeSeconds: number | null;
  unreconciledGrants: number;
  unreconciledGrantsOldestAgeSeconds: number | null;
}

export interface RemoteMcpOAuthLifecycleMaintenanceResult {
  backlog: RemoteMcpOAuthLifecycleBacklog | null;
  batchQueryCount: number;
  coherentGrants: number;
  elapsedMilliseconds: number;
  expiredEnvelopes: number;
  inspectedGrants: number;
  purgedEnvelopes: number;
  rowLimitReached: boolean;
  terminatedGrants: number;
  timeLimitReached: boolean;
}

export interface RemoteMcpOAuthLifecycleMaintenanceOptions {
  backlogObservationCap?: number | undefined;
  batchSize?: number | undefined;
  bootstrapGraceSeconds?: number | undefined;
  clock?: (() => number) | undefined;
  envelopeRetentionSeconds?: number | undefined;
  failureRetryMilliseconds?: number | undefined;
  intervalMilliseconds?: number | undefined;
  logger: Logger;
  maximumRowsPerStage?: number | undefined;
  maximumRunMilliseconds?: number | undefined;
  sql: PostgresClient;
}

interface DrainState {
  complete: boolean;
  count: number;
  rowLimitReached: boolean;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be from ${minimum} through ${maximum}.`);
  }
  return value;
}

function count(value: unknown, maximum: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new TypeError(`${label} returned an invalid count.`);
  }
  return parsed;
}

function nullableAge(value: unknown, label: string): number | null {
  if (value === null) return null;
  return count(value, 2_147_483_647, label);
}

function emptyResult(): RemoteMcpOAuthLifecycleMaintenanceResult {
  return {
    backlog: null,
    batchQueryCount: 0,
    coherentGrants: 0,
    elapsedMilliseconds: 0,
    expiredEnvelopes: 0,
    inspectedGrants: 0,
    purgedEnvelopes: 0,
    rowLimitReached: false,
    terminatedGrants: 0,
    timeLimitReached: false,
  };
}

/**
 * Drains cross-store OAuth bootstrap crash state and envelope retention with a
 * fair, finite sequence of SKIP LOCKED batches. Only aggregate counts reach
 * logs; the pre-drain capped backlog observation is safe for CloudWatch metric
 * filters and remains available even when the run reaches its time budget.
 */
export class RemoteMcpOAuthLifecycleMaintenance {
  readonly #backlogObservationCap: number;
  readonly #batchSize: number;
  readonly #bootstrapGraceSeconds: number;
  readonly #clock: () => number;
  readonly #envelopeRetentionSeconds: number;
  readonly #failureRetryMilliseconds: number;
  readonly #intervalMilliseconds: number;
  readonly #logger: Logger;
  readonly #maximumRowsPerStage: number;
  readonly #maximumRunMilliseconds: number;
  readonly #sql: PostgresClient;
  #nextRunAt = 0;

  constructor(options: RemoteMcpOAuthLifecycleMaintenanceOptions) {
    const policy = REMOTE_MCP_OAUTH_CAPACITY_POLICY.lifecycle;
    this.#batchSize = boundedInteger(
      options.batchSize ?? policy.batchSize,
      1,
      MAXIMUM_BATCH_SIZE,
      "Remote MCP OAuth maintenance batchSize",
    );
    this.#maximumRowsPerStage = boundedInteger(
      options.maximumRowsPerStage ?? policy.maximumRowsPerStage,
      this.#batchSize,
      MAXIMUM_ROWS_PER_STAGE,
      "Remote MCP OAuth maintenance maximumRowsPerStage",
    );
    this.#backlogObservationCap = boundedInteger(
      options.backlogObservationCap ?? policy.backlogObservationCap,
      1,
      MAXIMUM_BACKLOG_OBSERVATION_CAP,
      "Remote MCP OAuth maintenance backlogObservationCap",
    );
    this.#bootstrapGraceSeconds = boundedInteger(
      options.bootstrapGraceSeconds ?? DEFAULT_BOOTSTRAP_GRACE_SECONDS,
      0,
      600,
      "Remote MCP OAuth maintenance bootstrapGraceSeconds",
    );
    this.#envelopeRetentionSeconds = boundedInteger(
      options.envelopeRetentionSeconds ?? DEFAULT_ENVELOPE_RETENTION_SECONDS,
      24 * 60 * 60,
      90 * 24 * 60 * 60,
      "Remote MCP OAuth maintenance envelopeRetentionSeconds",
    );
    this.#intervalMilliseconds = boundedInteger(
      options.intervalMilliseconds ?? policy.intervalMilliseconds,
      1_000,
      24 * 60 * 60 * 1_000,
      "Remote MCP OAuth maintenance intervalMilliseconds",
    );
    this.#maximumRunMilliseconds = boundedInteger(
      options.maximumRunMilliseconds ?? policy.maximumRunMilliseconds,
      1,
      this.#intervalMilliseconds - 1,
      "Remote MCP OAuth maintenance maximumRunMilliseconds",
    );
    this.#failureRetryMilliseconds = boundedInteger(
      options.failureRetryMilliseconds ?? policy.failureRetryMilliseconds,
      1,
      this.#intervalMilliseconds,
      "Remote MCP OAuth maintenance failureRetryMilliseconds",
    );
    this.#clock = options.clock ?? Date.now;
    this.#logger = options.logger;
    this.#sql = options.sql;
  }

  #readClock(): number {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError(
        "Remote MCP OAuth maintenance clock returned an invalid value.",
      );
    }
    return now;
  }

  async #observeBacklog(): Promise<RemoteMcpOAuthLifecycleBacklog> {
    const rows = await this.#sql<BacklogRow[]>`
      select
        expired_envelope_count,
        expired_envelope_oldest_age_seconds,
        unreconciled_grant_count,
        unreconciled_grant_oldest_age_seconds,
        purgeable_envelope_count,
        purgeable_envelope_oldest_age_seconds
      from system.inspect_remote_mcp_oauth_lifecycle_backlog(
        ${this.#bootstrapGraceSeconds},
        ${this.#envelopeRetentionSeconds},
        ${this.#backlogObservationCap}
      )
    `;
    const row = rows[0];
    const expiredEnvelopes = count(
      row?.expired_envelope_count,
      this.#backlogObservationCap,
      "Remote MCP OAuth expired-envelope backlog observation",
    );
    const unreconciledGrants = count(
      row?.unreconciled_grant_count,
      this.#backlogObservationCap,
      "Remote MCP OAuth unreconciled-Grant backlog observation",
    );
    const purgeableEnvelopes = count(
      row?.purgeable_envelope_count,
      this.#backlogObservationCap,
      "Remote MCP OAuth purgeable-envelope backlog observation",
    );
    return {
      alarmThresholdExceeded:
        Math.max(expiredEnvelopes, unreconciledGrants, purgeableEnvelopes) >
        REMOTE_MCP_OAUTH_CAPACITY_POLICY.lifecycle.backlogAlarmThreshold,
      expiredEnvelopes,
      expiredEnvelopesOldestAgeSeconds: nullableAge(
        row?.expired_envelope_oldest_age_seconds,
        "Remote MCP OAuth expired-envelope oldest age",
      ),
      maximumCount: Math.max(expiredEnvelopes, unreconciledGrants, purgeableEnvelopes),
      observationCapped:
        expiredEnvelopes === this.#backlogObservationCap ||
        unreconciledGrants === this.#backlogObservationCap ||
        purgeableEnvelopes === this.#backlogObservationCap,
      purgeableEnvelopes,
      purgeableEnvelopesOldestAgeSeconds: nullableAge(
        row?.purgeable_envelope_oldest_age_seconds,
        "Remote MCP OAuth purgeable-envelope oldest age",
      ),
      unreconciledGrants,
      unreconciledGrantsOldestAgeSeconds: nullableAge(
        row?.unreconciled_grant_oldest_age_seconds,
        "Remote MCP OAuth unreconciled-Grant oldest age",
      ),
    };
  }

  async #expire(batchSize: number): Promise<number> {
    const rows = await this.#sql<CountRow[]>`
      select system.expire_remote_mcp_oauth_authorization_requests(
        ${batchSize}
      ) as count
    `;
    return count(rows[0]?.count, batchSize, "Remote MCP OAuth envelope expiry");
  }

  async #purge(batchSize: number): Promise<number> {
    const rows = await this.#sql<CountRow[]>`
      select system.purge_terminal_remote_mcp_oauth_authorization_requests(
        ${batchSize},
        ${this.#envelopeRetentionSeconds}
      ) as count
    `;
    return count(rows[0]?.count, batchSize, "Remote MCP OAuth envelope purge");
  }

  async #reconcile(
    batchSize: number,
  ): Promise<{ coherent: number; inspected: number; terminated: number }> {
    const rows = await this.#sql<ReconciliationRow[]>`
      select inspected_count, coherent_count, terminated_count
      from system.reconcile_remote_mcp_oauth_grant_bootstraps(
        ${batchSize},
        ${this.#bootstrapGraceSeconds}
      )
    `;
    const row = rows[0];
    const inspected = count(
      row?.inspected_count,
      batchSize,
      "Remote MCP OAuth bootstrap reconciliation",
    );
    const coherent = count(
      row?.coherent_count,
      inspected,
      "Remote MCP OAuth coherent bootstrap reconciliation",
    );
    const terminated = count(
      row?.terminated_count,
      inspected,
      "Remote MCP OAuth terminated bootstrap reconciliation",
    );
    if (coherent + terminated !== inspected) {
      throw new TypeError(
        "Remote MCP OAuth bootstrap reconciliation returned inconsistent counts.",
      );
    }
    return { coherent, inspected, terminated };
  }

  async runIfDue(): Promise<RemoteMcpOAuthLifecycleMaintenanceResult> {
    const startedAt = this.#readClock();
    if (startedAt < this.#nextRunAt) return emptyResult();

    // Reserve the next slot before the first await so accidental concurrent
    // calls cannot launch duplicate drain loops.
    this.#nextRunAt = startedAt + this.#intervalMilliseconds;
    const deadline = startedAt + this.#maximumRunMilliseconds;

    try {
      const backlog = await this.#observeBacklog();
      const expiry: DrainState = {
        complete: false,
        count: 0,
        rowLimitReached: false,
      };
      const reconciliation: DrainState = {
        complete: false,
        count: 0,
        rowLimitReached: false,
      };
      const purge: DrainState = {
        complete: false,
        count: 0,
        rowLimitReached: false,
      };
      let batchQueryCount = 0;
      let coherentGrants = 0;
      let terminatedGrants = 0;
      let timeLimitReached = false;

      // One batch per stage per round prevents a large expiry backlog from
      // starving Grant reconciliation or retained-envelope cleanup.
      drain: while (!expiry.complete || !reconciliation.complete || !purge.complete) {
        if (this.#readClock() >= deadline) {
          timeLimitReached = true;
          break;
        }

        if (!expiry.complete) {
          const batchSize = Math.min(
            this.#batchSize,
            this.#maximumRowsPerStage - expiry.count,
          );
          const processed = await this.#expire(batchSize);
          batchQueryCount += 1;
          expiry.count += processed;
          expiry.complete = processed < batchSize;
          if (expiry.count >= this.#maximumRowsPerStage) {
            expiry.complete = true;
            expiry.rowLimitReached = processed === batchSize;
          }
        }

        if (!reconciliation.complete) {
          if (this.#readClock() >= deadline) {
            timeLimitReached = true;
            break drain;
          }
          const batchSize = Math.min(
            this.#batchSize,
            this.#maximumRowsPerStage - reconciliation.count,
          );
          const processed = await this.#reconcile(batchSize);
          batchQueryCount += 1;
          reconciliation.count += processed.inspected;
          coherentGrants += processed.coherent;
          terminatedGrants += processed.terminated;
          reconciliation.complete = processed.inspected < batchSize;
          if (reconciliation.count >= this.#maximumRowsPerStage) {
            reconciliation.complete = true;
            reconciliation.rowLimitReached = processed.inspected === batchSize;
          }
        }

        if (!purge.complete) {
          if (this.#readClock() >= deadline) {
            timeLimitReached = true;
            break drain;
          }
          const batchSize = Math.min(
            this.#batchSize,
            this.#maximumRowsPerStage - purge.count,
          );
          const processed = await this.#purge(batchSize);
          batchQueryCount += 1;
          purge.count += processed;
          purge.complete = processed < batchSize;
          if (purge.count >= this.#maximumRowsPerStage) {
            purge.complete = true;
            purge.rowLimitReached = processed === batchSize;
          }
        }
      }

      const finishedAt = this.#readClock();
      if (finishedAt < startedAt) {
        throw new TypeError("Remote MCP OAuth maintenance clock moved backwards.");
      }
      const result = {
        backlog,
        batchQueryCount,
        coherentGrants,
        elapsedMilliseconds: finishedAt - startedAt,
        expiredEnvelopes: expiry.count,
        inspectedGrants: reconciliation.count,
        purgedEnvelopes: purge.count,
        rowLimitReached:
          expiry.rowLimitReached ||
          reconciliation.rowLimitReached ||
          purge.rowLimitReached,
        terminatedGrants,
        timeLimitReached,
      } satisfies RemoteMcpOAuthLifecycleMaintenanceResult;

      this.#logger.info(
        {
          backlog_count: backlog.maximumCount,
          backlog_alarm_threshold_exceeded: backlog.alarmThresholdExceeded,
          backlog_observation_cap: this.#backlogObservationCap,
          backlog_observation_capped: backlog.observationCapped,
          batch_query_count: batchQueryCount,
          coherent_grant_count: coherentGrants,
          elapsed_ms: result.elapsedMilliseconds,
          event: "remote_mcp_oauth_lifecycle_maintenance",
          expired_envelope_backlog_count: backlog.expiredEnvelopes,
          expired_envelope_count: expiry.count,
          expired_envelope_oldest_age_seconds: backlog.expiredEnvelopesOldestAgeSeconds,
          inspected_grant_count: reconciliation.count,
          outcome: "succeeded",
          purgeable_envelope_backlog_count: backlog.purgeableEnvelopes,
          purgeable_envelope_oldest_age_seconds:
            backlog.purgeableEnvelopesOldestAgeSeconds,
          purged_envelope_count: purge.count,
          row_limit_reached: result.rowLimitReached,
          terminated_grant_count: terminatedGrants,
          time_limit_reached: timeLimitReached,
          unreconciled_grant_backlog_count: backlog.unreconciledGrants,
          unreconciled_grant_oldest_age_seconds:
            backlog.unreconciledGrantsOldestAgeSeconds,
        },
        "Remote MCP OAuth lifecycle maintenance completed",
      );
      return result;
    } catch (error) {
      let failureAt = startedAt;
      try {
        failureAt = Math.max(startedAt, this.#readClock());
      } catch {
        // Preserve the original failure and still enforce a retry delay.
      }
      this.#nextRunAt = failureAt + this.#failureRetryMilliseconds;
      this.#logger.error(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          event: "remote_mcp_oauth_lifecycle_maintenance",
          outcome: "failed",
        },
        "Remote MCP OAuth lifecycle maintenance failed",
      );
      throw error;
    }
  }
}
