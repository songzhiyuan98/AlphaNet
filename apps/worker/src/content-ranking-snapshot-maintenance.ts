import type { PostgresClient } from "@alphanet/database";
import type { Logger } from "pino";

const DEFAULT_PURGE_BATCH_SIZE = 1_000;
const MAXIMUM_PURGE_BATCH_SIZE = 10_000;

interface PurgeRow {
  purged: number;
}

export interface ContentRankingSnapshotMaintenanceOptions {
  batchSize?: number | undefined;
  logger: Logger;
  sql: PostgresClient;
}

/** Physically removes expired Content Ranking candidate snapshots in bounded batches. */
export class ContentRankingSnapshotMaintenance {
  readonly #batchSize: number;
  readonly #logger: Logger;
  readonly #sql: PostgresClient;

  constructor(options: ContentRankingSnapshotMaintenanceOptions) {
    const batchSize = options.batchSize ?? DEFAULT_PURGE_BATCH_SIZE;
    if (
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > MAXIMUM_PURGE_BATCH_SIZE
    ) {
      throw new RangeError(
        "Content ranking snapshot purge batchSize must be from 1 through 10000.",
      );
    }
    this.#batchSize = batchSize;
    this.#logger = options.logger;
    this.#sql = options.sql;
  }

  async runOnce(): Promise<number> {
    try {
      const rows = await this.#sql<PurgeRow[]>`
        select system.purge_expired_content_ranking_candidate_snapshots(
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
        throw new TypeError("Content ranking snapshot purge returned an invalid count.");
      }
      if (purged > 0) {
        this.#logger.info(
          {
            event: "content_ranking_candidate_snapshot_purge",
            outcome: "succeeded",
            purged_count: purged,
          },
          "Expired Content Ranking candidate snapshots purged",
        );
      }
      return purged;
    } catch (error) {
      this.#logger.error(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          event: "content_ranking_candidate_snapshot_purge",
          outcome: "failed",
        },
        "Content Ranking candidate snapshot purge failed",
      );
      throw error;
    }
  }
}
