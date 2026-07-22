import type { PostgresClient } from "@alphanet/database";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { RemoteMcpOAuthLifecycleMaintenance } from "./remote-mcp-oauth-lifecycle-maintenance.js";

interface Query {
  text: string;
  values: unknown[];
}

function backlog(
  overrides: Partial<Record<string, number | null>> = {},
): Record<string, number | null> {
  return {
    expired_envelope_count: 45,
    expired_envelope_oldest_age_seconds: 180,
    purgeable_envelope_count: 27,
    purgeable_envelope_oldest_age_seconds: 360,
    unreconciled_grant_count: 43,
    unreconciled_grant_oldest_age_seconds: 240,
    ...overrides,
  };
}

function fakeSql(
  responses: readonly (unknown[] | Error)[],
  afterCall: (() => void) | undefined = undefined,
): {
  calls: Query[];
  sql: PostgresClient;
} {
  const calls: Query[] = [];
  const pending = [...responses];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    const response = pending.shift();
    afterCall?.();
    if (!response) throw new Error("unexpected maintenance query");
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
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

describe("RemoteMcpOAuthLifecycleMaintenance", () => {
  it("drains every stage across multiple fair batches and logs capped backlog gauges", async () => {
    let now = 1_000_000;
    const harness = fakeSql([
      [backlog()],
      [{ count: "20" }],
      [{ coherent_count: "12", inspected_count: "20", terminated_count: "8" }],
      [{ count: "20" }],
      [{ count: "20" }],
      [{ coherent_count: "10", inspected_count: "20", terminated_count: "10" }],
      [{ count: "7" }],
      [{ count: "5" }],
      [{ coherent_count: "2", inspected_count: "3", terminated_count: "1" }],
      [
        backlog({
          expired_envelope_count: 0,
          expired_envelope_oldest_age_seconds: null,
          purgeable_envelope_count: 0,
          purgeable_envelope_oldest_age_seconds: null,
          unreconciled_grant_count: 0,
          unreconciled_grant_oldest_age_seconds: null,
        }),
      ],
      [{ count: 0 }],
      [{ coherent_count: 0, inspected_count: 0, terminated_count: 0 }],
      [{ count: 0 }],
    ]);
    const log = logger();
    const maintenance = new RemoteMcpOAuthLifecycleMaintenance({
      backlogObservationCap: 100,
      batchSize: 20,
      bootstrapGraceSeconds: 90,
      clock: () => now,
      envelopeRetentionSeconds: 8 * 24 * 60 * 60,
      intervalMilliseconds: 60_000,
      logger: log,
      maximumRowsPerStage: 60,
      maximumRunMilliseconds: 50_000,
      sql: harness.sql,
    });

    await expect(maintenance.runIfDue()).resolves.toEqual({
      backlog: {
        alarmThresholdExceeded: false,
        expiredEnvelopes: 45,
        expiredEnvelopesOldestAgeSeconds: 180,
        maximumCount: 45,
        observationCapped: false,
        purgeableEnvelopes: 27,
        purgeableEnvelopesOldestAgeSeconds: 360,
        unreconciledGrants: 43,
        unreconciledGrantsOldestAgeSeconds: 240,
      },
      batchQueryCount: 8,
      coherentGrants: 24,
      elapsedMilliseconds: 0,
      expiredEnvelopes: 45,
      inspectedGrants: 43,
      purgedEnvelopes: 27,
      rowLimitReached: false,
      terminatedGrants: 19,
      timeLimitReached: false,
    });
    await expect(maintenance.runIfDue()).resolves.toMatchObject({
      backlog: null,
      batchQueryCount: 0,
    });
    now += 60_000;
    await expect(maintenance.runIfDue()).resolves.toMatchObject({
      backlog: {
        maximumCount: 0,
        observationCapped: false,
      },
      batchQueryCount: 3,
    });

    expect(harness.calls).toHaveLength(13);
    expect(harness.calls.slice(1, 9).map((call) => call.values[0])).toEqual([
      20, 20, 20, 20, 20, 20, 20, 20,
    ]);
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        backlog_count: 45,
        backlog_alarm_threshold_exceeded: false,
        backlog_observation_cap: 100,
        backlog_observation_capped: false,
        batch_query_count: 8,
        coherent_grant_count: 24,
        event: "remote_mcp_oauth_lifecycle_maintenance",
        expired_envelope_backlog_count: 45,
        expired_envelope_count: 45,
        inspected_grant_count: 43,
        outcome: "succeeded",
        purgeable_envelope_backlog_count: 27,
        purged_envelope_count: 27,
        row_limit_reached: false,
        terminated_grant_count: 19,
        time_limit_reached: false,
        unreconciled_grant_backlog_count: 43,
      }),
      "Remote MCP OAuth lifecycle maintenance completed",
    );
    const serializedLog = JSON.stringify(log.info.mock.calls);
    expect(serializedLog).not.toContain("grant_id");
    expect(serializedLog).not.toContain("token");
    expect(serializedLog).not.toContain("credential");
  });

  it("stops each full stage at its row limit without a full-batch busy loop", async () => {
    const harness = fakeSql([
      [
        backlog({
          expired_envelope_count: 1_300,
          purgeable_envelope_count: 1_300,
          unreconciled_grant_count: 1_300,
        }),
      ],
      [{ count: 20 }],
      [{ coherent_count: 10, inspected_count: 20, terminated_count: 10 }],
      [{ count: 20 }],
      [{ count: 20 }],
      [{ coherent_count: 10, inspected_count: 20, terminated_count: 10 }],
      [{ count: 20 }],
      [{ count: 5 }],
      [{ coherent_count: 3, inspected_count: 5, terminated_count: 2 }],
      [{ count: 5 }],
    ]);
    const maintenance = new RemoteMcpOAuthLifecycleMaintenance({
      backlogObservationCap: 2_000,
      batchSize: 20,
      intervalMilliseconds: 10_000,
      logger: logger(),
      maximumRowsPerStage: 45,
      maximumRunMilliseconds: 9_000,
      sql: harness.sql,
    });

    await expect(maintenance.runIfDue()).resolves.toMatchObject({
      backlog: {
        alarmThresholdExceeded: true,
        maximumCount: 1_300,
        observationCapped: false,
      },
      batchQueryCount: 9,
      expiredEnvelopes: 45,
      inspectedGrants: 45,
      purgedEnvelopes: 45,
      rowLimitReached: true,
      timeLimitReached: false,
    });
    expect(harness.calls).toHaveLength(10);
    expect(harness.calls.slice(1).map((call) => call.values[0])).toEqual([
      20, 20, 20, 20, 20, 20, 5, 5, 5,
    ]);
  });

  it("does not start another stage after the explicit run deadline", async () => {
    let now = 10_000;
    const harness = fakeSql(
      [
        [backlog()],
        [{ count: 20 }],
        [{ coherent_count: 10, inspected_count: 20, terminated_count: 10 }],
      ],
      () => {
        now += 100;
      },
    );
    const maintenance = new RemoteMcpOAuthLifecycleMaintenance({
      batchSize: 20,
      clock: () => now,
      failureRetryMilliseconds: 1_000,
      intervalMilliseconds: 1_000,
      logger: logger(),
      maximumRowsPerStage: 60,
      maximumRunMilliseconds: 250,
      sql: harness.sql,
    });

    await expect(maintenance.runIfDue()).resolves.toMatchObject({
      batchQueryCount: 2,
      expiredEnvelopes: 20,
      inspectedGrants: 20,
      purgedEnvelopes: 0,
      rowLimitReached: false,
      timeLimitReached: true,
    });
    expect(harness.calls).toHaveLength(3);
    expect(harness.calls.some((call) => call.text.includes("purge_terminal"))).toBe(
      false,
    );
  });

  it("backs off after failure and never logs database details", async () => {
    let now = 50_000;
    const sensitive = "authorization code and token material";
    const harness = fakeSql([new Error(sensitive), new Error(sensitive)]);
    const log = logger();
    const maintenance = new RemoteMcpOAuthLifecycleMaintenance({
      clock: () => now,
      failureRetryMilliseconds: 5_000,
      logger: log,
      sql: harness.sql,
    });

    await expect(maintenance.runIfDue()).rejects.toThrow(sensitive);
    await expect(maintenance.runIfDue()).resolves.toMatchObject({
      backlog: null,
      batchQueryCount: 0,
    });
    now += 5_000;
    await expect(maintenance.runIfDue()).rejects.toThrow(sensitive);

    expect(harness.calls).toHaveLength(2);
    expect(log.error).toHaveBeenCalledWith(
      {
        errorName: "Error",
        event: "remote_mcp_oauth_lifecycle_maintenance",
        outcome: "failed",
      },
      "Remote MCP OAuth lifecycle maintenance failed",
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(sensitive);
  });

  it("rejects unsafe bounds and inconsistent database aggregates", async () => {
    const log = logger();
    const valid = fakeSql([]).sql;
    expect(
      () =>
        new RemoteMcpOAuthLifecycleMaintenance({
          batchSize: 1_001,
          logger: log,
          sql: valid,
        }),
    ).toThrow(/1 through 1000/u);
    expect(
      () =>
        new RemoteMcpOAuthLifecycleMaintenance({
          batchSize: 20,
          logger: log,
          maximumRowsPerStage: 19,
          sql: valid,
        }),
    ).toThrow(/20 through 100000/u);
    expect(
      () =>
        new RemoteMcpOAuthLifecycleMaintenance({
          envelopeRetentionSeconds: 60,
          logger: log,
          sql: valid,
        }),
    ).toThrow(/86400 through 7776000/u);

    const impossible = fakeSql([
      [backlog()],
      [{ count: 0 }],
      [{ coherent_count: 2, inspected_count: 2, terminated_count: 1 }],
    ]);
    const maintenance = new RemoteMcpOAuthLifecycleMaintenance({
      logger: log,
      sql: impossible.sql,
    });
    await expect(maintenance.runIfDue()).rejects.toThrow("inconsistent counts");
  });
});
