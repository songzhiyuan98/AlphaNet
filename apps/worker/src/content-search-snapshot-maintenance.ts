import type { PostgresClient } from "@alphanet/database";
import type { Logger } from "pino";

const DEFAULT_PURGE_BATCH_SIZE = 1_000;
const MAXIMUM_PURGE_BATCH_SIZE = 10_000;

interface PurgeRow {
  purged: number;
}

export interface ContentSearchSnapshotMaintenanceOptions {
  batchSize?: number | undefined;
  logger: Logger;
  sql: PostgresClient;
}

/** Physically removes expired Search candidate snapshots in bounded batches. */
export class ContentSearchSnapshotMaintenance {
  readonly #batchSize: number;
  readonly #logger: Logger;
  readonly #sql: PostgresClient;

  constructor(options: ContentSearchSnapshotMaintenanceOptions) {
    const batchSize = options.batchSize ?? DEFAULT_PURGE_BATCH_SIZE;
    if (
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > MAXIMUM_PURGE_BATCH_SIZE
    ) {
      throw new RangeError(
        "Search snapshot purge batchSize must be from 1 through 10000.",
      );
    }
    this.#batchSize = batchSize;
    this.#logger = options.logger;
    this.#sql = options.sql;
  }

  async runOnce(): Promise<number> {
    try {
      const rows = await this.#sql<PurgeRow[]>`
        select system.purge_expired_content_search_candidate_snapshots(
          ${this.#batchSize}
        ) as purged
      `;
      const purged = rows[0]?.purged;
      if (
        purged === undefined ||
        !Number.isSafeInteger(purged) ||
        purged < 0 ||
        purged > this.#batchSize
      ) {
        throw new TypeError("Search snapshot purge returned an invalid count.");
      }
      if (purged > 0) {
        this.#logger.info(
          {
            event: "content_search_candidate_snapshot_purge",
            outcome: "succeeded",
            purged_count: purged,
          },
          "Expired Content Search candidate snapshots purged",
        );
      }
      return purged;
    } catch (error) {
      this.#logger.error(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          event: "content_search_candidate_snapshot_purge",
          outcome: "failed",
        },
        "Content Search candidate snapshot purge failed",
      );
      throw error;
    }
  }
}
