import type { PostgresClient } from "@alphanet/database";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { ContentRankingSnapshotMaintenance } from "./content-ranking-snapshot-maintenance.js";

interface Query {
  text: string;
  values: unknown[];
}

function fakeSql(responder: (query: Query) => unknown[] | Promise<unknown[]>): {
  calls: Query[];
  sql: PostgresClient;
} {
  const calls: Query[] = [];
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join("?"), values };
    calls.push(query);
    return responder(query);
  };
  return { calls, sql: tag as unknown as PostgresClient };
}

function logger(): Logger & {
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
} {
  return {
    error: vi.fn(),
    info: vi.fn(),
  } as unknown as Logger & {
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
}

describe("ContentRankingSnapshotMaintenance", () => {
  it("purges a bounded batch and emits only aggregate operational fields", async () => {
    const harness = fakeSql(() => [{ purged: 37 }]);
    const log = logger();
    const maintenance = new ContentRankingSnapshotMaintenance({
      logger: log,
      sql: harness.sql,
    });

    await expect(maintenance.runOnce()).resolves.toBe(37);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.text).toContain(
      "system.purge_expired_content_ranking_candidate_snapshots",
    );
    expect(harness.calls[0]?.values).toEqual([1_000]);
    expect(log.info).toHaveBeenCalledWith(
      {
        event: "content_ranking_candidate_snapshot_purge",
        outcome: "succeeded",
        purged_count: 37,
      },
      "Expired Content Ranking candidate snapshots purged",
    );
    expect(JSON.stringify(log.info.mock.calls)).not.toMatch(
      /snapshot_id|binding_hmac|candidates|query/iu,
    );
  });

  it("fails the worker cycle without logging database error details", async () => {
    const harness = fakeSql(() =>
      Promise.reject(new Error("sensitive database detail must not be logged")),
    );
    const log = logger();
    const maintenance = new ContentRankingSnapshotMaintenance({
      batchSize: 250,
      logger: log,
      sql: harness.sql,
    });

    await expect(maintenance.runOnce()).rejects.toThrow(
      "sensitive database detail must not be logged",
    );
    expect(harness.calls[0]?.values).toEqual([250]);
    expect(log.error).toHaveBeenCalledWith(
      {
        errorName: "Error",
        event: "content_ranking_candidate_snapshot_purge",
        outcome: "failed",
      },
      "Content Ranking candidate snapshot purge failed",
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(
      "sensitive database detail must not be logged",
    );
  });

  it("rejects unsafe batches and impossible database counts", async () => {
    const harness = fakeSql(() => [{ purged: 101 }]);
    const unsafeCountHarness = fakeSql(() => [{ purged: 99.5 }]);
    const log = logger();

    expect(
      () =>
        new ContentRankingSnapshotMaintenance({
          batchSize: 10_001,
          logger: log,
          sql: harness.sql,
        }),
    ).toThrow(/1 through 10000/u);
    expect(
      () =>
        new ContentRankingSnapshotMaintenance({
          batchSize: Number.MAX_SAFE_INTEGER + 1,
          logger: log,
          sql: harness.sql,
        }),
    ).toThrow(/1 through 10000/u);

    const maintenance = new ContentRankingSnapshotMaintenance({
      batchSize: 100,
      logger: log,
      sql: harness.sql,
    });
    await expect(maintenance.runOnce()).rejects.toThrow("invalid count");

    const unsafeCountMaintenance = new ContentRankingSnapshotMaintenance({
      batchSize: 100,
      logger: log,
      sql: unsafeCountHarness.sql,
    });
    await expect(unsafeCountMaintenance.runOnce()).rejects.toThrow("invalid count");
  });
});
