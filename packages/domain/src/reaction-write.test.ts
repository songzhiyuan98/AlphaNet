import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it } from "vitest";

import { PostgresReactionWriteService } from "./reaction-write.js";

const sql = {} as PostgresClient;
const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000;

describe("PostgresReactionWriteService configuration", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, sevenDaysMs - 1])(
    "rejects an unsafe idempotency retention value: %s",
    (idempotencyRetentionMs) => {
      expect(
        () => new PostgresReactionWriteService(sql, { idempotencyRetentionMs }),
      ).toThrow(RangeError);
    },
  );

  it("accepts the exact seven-day minimum retention", () => {
    expect(
      () =>
        new PostgresReactionWriteService(sql, {
          idempotencyRetentionMs: sevenDaysMs,
        }),
    ).not.toThrow();
  });
});
