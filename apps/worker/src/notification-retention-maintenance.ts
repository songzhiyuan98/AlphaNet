import type { PostgresClient } from "@alphanet/database";
import type { Logger } from "pino";

const DEFAULT_PURGE_BATCH_SIZE = 1_000;
const DEFAULT_INTERVAL_MILLISECONDS = 60 * 60 * 1_000;
const MAXIMUM_PURGE_BATCH_SIZE = 10_000;

interface PurgeRow {
  purged: number | string;
}

export interface NotificationRetentionMaintenanceOptions {
  batchSize?: number | undefined;
  clock?: (() => number) | undefined;
  intervalMilliseconds?: number | undefined;
  logger: Logger;
  sql: PostgresClient;
}

/** Runs the fixed 90-day Notification retention purge in bounded, low-frequency batches. */
export class NotificationRetentionMaintenance {
  readonly #batchSize: number;
  readonly #clock: () => number;
  readonly #intervalMilliseconds: number;
  readonly #logger: Logger;
  readonly #sql: PostgresClient;
  #nextRunAt = 0;

  constructor(options: NotificationRetentionMaintenanceOptions) {
    const batchSize = options.batchSize ?? DEFAULT_PURGE_BATCH_SIZE;
    const intervalMilliseconds =
      options.intervalMilliseconds ?? DEFAULT_INTERVAL_MILLISECONDS;
    if (
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > MAXIMUM_PURGE_BATCH_SIZE
    ) {
      throw new RangeError("Notification purge batchSize must be from 1 through 10000.");
    }
    if (
      !Number.isSafeInteger(intervalMilliseconds) ||
      intervalMilliseconds < 60_000 ||
      intervalMilliseconds > 24 * 60 * 60 * 1_000
    ) {
      throw new RangeError(
        "Notification purge intervalMilliseconds must be from 60000 through 86400000.",
      );
    }
    this.#batchSize = batchSize;
    this.#clock = options.clock ?? Date.now;
    this.#intervalMilliseconds = intervalMilliseconds;
    this.#logger = options.logger;
    this.#sql = options.sql;
  }

  async runIfDue(): Promise<number> {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("Notification retention clock returned an invalid value.");
    }
    if (now < this.#nextRunAt) return 0;

    try {
      const rows = await this.#sql<PurgeRow[]>`
        select system.purge_expired_notifications(${this.#batchSize}) as purged
      `;
      const purged = Number(rows[0]?.purged);
      if (!Number.isSafeInteger(purged) || purged < 0 || purged > this.#batchSize) {
        throw new TypeError("Notification purge returned an invalid count.");
      }
      this.#nextRunAt = now + this.#intervalMilliseconds;
      if (purged > 0) {
        this.#logger.info(
          {
            event: "notification_retention_purge",
            outcome: "succeeded",
            purged_count: purged,
          },
          "Expired Notifications purged",
        );
      }
      return purged;
    } catch (error) {
      this.#logger.error(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          event: "notification_retention_purge",
          outcome: "failed",
        },
        "Notification retention purge failed",
      );
      throw error;
    }
  }
}
