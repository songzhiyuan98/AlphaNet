import type { PostgresClient } from "@alphanet/database";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { NotificationRetentionMaintenance } from "./notification-retention-maintenance.js";

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

describe("NotificationRetentionMaintenance", () => {
  it("purges at most once per interval and reports only aggregate fields", async () => {
    let now = 1_000_000;
    const harness = fakeSql(() => [{ purged: "37" }]);
    const log = logger();
    const maintenance = new NotificationRetentionMaintenance({
      clock: () => now,
      intervalMilliseconds: 60_000,
      logger: log,
      sql: harness.sql,
    });

    await expect(maintenance.runIfDue()).resolves.toBe(37);
    await expect(maintenance.runIfDue()).resolves.toBe(0);
    now += 60_000;
    await expect(maintenance.runIfDue()).resolves.toBe(37);

    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[0]?.text).toContain("system.purge_expired_notifications");
    expect(harness.calls[0]?.values).toEqual([1_000]);
    expect(log.info).toHaveBeenCalledWith(
      {
        event: "notification_retention_purge",
        outcome: "succeeded",
        purged_count: 37,
      },
      "Expired Notifications purged",
    );
  });

  it("retries after failure without logging database error details", async () => {
    const harness = fakeSql(() =>
      Promise.reject(new Error("sensitive database detail must not be logged")),
    );
    const log = logger();
    const maintenance = new NotificationRetentionMaintenance({
      logger: log,
      sql: harness.sql,
    });

    await expect(maintenance.runIfDue()).rejects.toThrow("sensitive database detail");
    await expect(maintenance.runIfDue()).rejects.toThrow("sensitive database detail");
    expect(harness.calls).toHaveLength(2);
    expect(log.error).toHaveBeenCalledWith(
      {
        errorName: "Error",
        event: "notification_retention_purge",
        outcome: "failed",
      },
      "Notification retention purge failed",
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(
      "sensitive database detail must not be logged",
    );
  });

  it("rejects unsafe configuration and impossible database counts", async () => {
    const harness = fakeSql(() => [{ purged: 101 }]);
    const log = logger();

    expect(
      () =>
        new NotificationRetentionMaintenance({
          batchSize: 10_001,
          logger: log,
          sql: harness.sql,
        }),
    ).toThrow(/1 through 10000/u);

    const maintenance = new NotificationRetentionMaintenance({
      batchSize: 100,
      logger: log,
      sql: harness.sql,
    });
    await expect(maintenance.runIfDue()).rejects.toThrow("invalid count");
  });
});
