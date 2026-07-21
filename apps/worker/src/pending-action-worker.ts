import {
  ApprovedResearchExecutionError,
  PendingActionLeaseLostError,
  type ApprovedResearchExecutionRepository,
  type ApprovedResearchExecutionResult,
  type PendingActionCasResult,
  type PendingActionCommittedState,
  type PendingActionExecutionClaim,
  type PendingActionHeartbeatResult,
  type PendingActionReapResult,
  type PendingActionRetryOptions,
} from "@alphanet/domain";
import type { Logger } from "pino";

export interface PendingActionWorkerRepository extends ApprovedResearchExecutionRepository {
  claimBatch(batchSize?: number): Promise<PendingActionExecutionClaim[]>;
  markInvalidated(claim: PendingActionExecutionClaim): Promise<PendingActionCasResult>;
  readCommittedState(actionId: string): Promise<PendingActionCommittedState | null>;
  reap(batchSize?: number): Promise<PendingActionReapResult>;
  renewHeartbeat(
    claim: PendingActionExecutionClaim,
  ): Promise<PendingActionHeartbeatResult>;
  scheduleRetry(
    claim: PendingActionExecutionClaim,
    options?: PendingActionRetryOptions,
  ): Promise<PendingActionCasResult>;
}

export interface ApprovedResearchExecutor {
  executeApprovedAction(
    repository: ApprovedResearchExecutionRepository,
    claim: PendingActionExecutionClaim,
  ): Promise<ApprovedResearchExecutionResult>;
}

export interface PendingActionWorkerOptions {
  batchSize: number;
  beforeClaim?: (() => Promise<void>) | undefined;
  executor: ApprovedResearchExecutor;
  heartbeatIntervalMilliseconds?: number | undefined;
  logger: Logger;
  reapBatchSize?: number | undefined;
  repository: PendingActionWorkerRepository;
}

function isTerminal(state: PendingActionCommittedState["state"]): boolean {
  return (
    state === "succeeded" ||
    state === "rejected" ||
    state === "expired" ||
    state === "cancelled" ||
    state === "failed" ||
    state === "invalidated"
  );
}

export class PendingActionWorker {
  constructor(private readonly options: PendingActionWorkerOptions) {
    if (
      !Number.isSafeInteger(options.batchSize) ||
      options.batchSize < 1 ||
      options.batchSize > 100
    ) {
      throw new RangeError("batchSize must be from one through one hundred.");
    }
    if (
      options.reapBatchSize !== undefined &&
      (!Number.isSafeInteger(options.reapBatchSize) ||
        options.reapBatchSize < 1 ||
        options.reapBatchSize > 100)
    ) {
      throw new RangeError("reapBatchSize must be from one through one hundred.");
    }
    if (
      options.heartbeatIntervalMilliseconds !== undefined &&
      (!Number.isSafeInteger(options.heartbeatIntervalMilliseconds) ||
        options.heartbeatIntervalMilliseconds < 100)
    ) {
      throw new RangeError("heartbeatIntervalMilliseconds must be at least one hundred.");
    }
  }

  async runOnce(): Promise<number> {
    await this.options.beforeClaim?.();
    const reaped = await this.options.repository.reap(
      this.options.reapBatchSize ?? this.options.batchSize,
    );
    const claims = await this.options.repository.claimBatch(this.options.batchSize);
    await Promise.all(claims.map((claim) => this.#process(claim)));
    return reaped.processed + claims.length;
  }

  async #process(claim: PendingActionExecutionClaim): Promise<void> {
    let heartbeat: NodeJS.Timeout | undefined;
    let heartbeatStopped = false;
    let leaseLost = false;
    let localLeaseDeadline = claim.leaseExpiresAt.valueOf();
    let renewal = Promise.resolve();
    const configuredInterval = this.options.heartbeatIntervalMilliseconds ?? 20_000;

    const markLeaseLost = (reason: string) => {
      if (leaseLost) return;
      leaseLost = true;
      this.options.logger.warn(
        {
          actionId: claim.actionId,
          attemptCount: claim.attemptCount,
          reason,
        },
        "pending action lease is no longer live",
      );
    };
    const scheduleHeartbeat = () => {
      if (heartbeatStopped || leaseLost) return;
      const remaining = localLeaseDeadline - Date.now();
      if (remaining <= 0) {
        markLeaseLost("local_deadline_elapsed");
        return;
      }
      const interval = Math.min(
        configuredInterval,
        Math.max(1, Math.floor(remaining / 2)),
      );
      heartbeat = setTimeout(() => {
        heartbeat = undefined;
        if (heartbeatStopped || leaseLost) return;
        renewal = this.options.repository
          .renewHeartbeat(claim)
          .then((result) => {
            if (!result.renewed || result.leaseExpiresAt === null) {
              markLeaseLost("heartbeat_rejected");
              return;
            }
            localLeaseDeadline = result.leaseExpiresAt.valueOf();
            scheduleHeartbeat();
          })
          .catch(() => {
            if (Date.now() >= localLeaseDeadline) {
              markLeaseLost("heartbeat_failed_until_deadline");
              return;
            }
            this.options.logger.warn(
              {
                actionId: claim.actionId,
                attemptCount: claim.attemptCount,
              },
              "pending action heartbeat failed and will retry",
            );
            scheduleHeartbeat();
          });
      }, interval);
    };
    const stopHeartbeat = async () => {
      heartbeatStopped = true;
      if (heartbeat) {
        clearTimeout(heartbeat);
        heartbeat = undefined;
      }
      await renewal;
    };

    scheduleHeartbeat();
    try {
      await this.options.executor.executeApprovedAction(this.options.repository, claim);
      await stopHeartbeat();
      return;
    } catch (error) {
      await stopHeartbeat();
      if (error instanceof PendingActionLeaseLostError || leaseLost) {
        return;
      }
      if (error instanceof ApprovedResearchExecutionError) {
        if (error.disposition === "invalidate") {
          try {
            const invalidated = await this.options.repository.markInvalidated(claim);
            if (!invalidated.applied && invalidated.action === null) {
              this.options.logger.warn(
                {
                  actionId: claim.actionId,
                  attemptCount: claim.attemptCount,
                },
                "approved action invalidation lost its execution fence",
              );
            }
          } catch {
            this.options.logger.error(
              {
                actionId: claim.actionId,
                attemptCount: claim.attemptCount,
              },
              "approved action invalidation could not be recorded; lease recovery will reconcile it",
            );
          }
          return;
        }
        const minimumDelaySeconds =
          error.retryAfterMs === null
            ? 0
            : Math.max(1, Math.ceil(error.retryAfterMs / 1_000));
        try {
          await this.options.repository.scheduleRetry(claim, {
            budgetDisposition: "defer",
            maximumDelaySeconds: Math.max(1, minimumDelaySeconds),
            ...(minimumDelaySeconds === 0 ? {} : { minimumDelaySeconds }),
          });
        } catch {
          this.options.logger.error(
            {
              actionId: claim.actionId,
              attemptCount: claim.attemptCount,
            },
            "rate-limited action retry could not be recorded; lease recovery will reconcile it",
          );
        }
        return;
      }

      // A connection can fail after PostgreSQL committed the success
      // transaction. Read the durable state before deciding to retry.
      let committed: PendingActionCommittedState | null;
      try {
        committed = await this.options.repository.readCommittedState(claim.actionId);
      } catch {
        this.options.logger.error(
          {
            actionId: claim.actionId,
            attemptCount: claim.attemptCount,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "pending action outcome is ambiguous; lease recovery will reconcile it",
        );
        return;
      }
      if (committed && isTerminal(committed.state)) {
        return;
      }
      try {
        await this.options.repository.scheduleRetry(claim);
      } catch {
        this.options.logger.error(
          {
            actionId: claim.actionId,
            attemptCount: claim.attemptCount,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "pending action retry could not be scheduled; lease recovery will reconcile it",
        );
      }
    } finally {
      if (heartbeat) clearTimeout(heartbeat);
    }
  }
}
