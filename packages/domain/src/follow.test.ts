import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it } from "vitest";

import {
  PostgresFollowService,
  normalizeFollowListInput,
  normalizeFollowTarget,
  normalizeSetFollowCommand,
} from "./follow.js";

const sql = {} as PostgresClient;
const actorId = "10000000-0000-4000-8000-000000000001";
const contentId = "20000000-0000-4000-8000-000000000001";
const cursorSigningKey = Buffer.alloc(32, 7);
const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000;

describe("Follow target normalization", () => {
  it("canonicalizes every public target form", () => {
    expect(normalizeFollowTarget("actor", actorId.toUpperCase())).toEqual({
      targetId: actorId,
      targetType: "actor",
    });
    expect(normalizeFollowTarget("content", ` ${contentId} `)).toEqual({
      targetId: contentId,
      targetType: "content",
    });
    expect(normalizeFollowTarget("symbol", " mu ")).toEqual({
      targetId: "MU",
      targetType: "symbol",
    });
    expect(normalizeFollowTarget("topic", " Data-Center ")).toEqual({
      targetId: "data-center",
      targetType: "topic",
    });
  });

  it.each([
    ["actor", "not-a-uuid"],
    ["content", "not-a-uuid"],
    ["symbol", "BRK/B"],
    ["topic", "invalid topic"],
    ["community", actorId],
  ])("rejects invalid %s targets", (targetType, targetId) => {
    expect(() => normalizeFollowTarget(targetType, targetId)).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR", statusCode: 422 }),
    );
  });
});

describe("Follow command normalization", () => {
  it("removes notification level from inactive command identity", () => {
    expect(
      normalizeSetFollowCommand({
        active: false,
        idempotencyKey: "unfollow-mu",
        notificationLevel: "all_events",
        targetId: "mu",
        targetType: "symbol",
      }),
    ).toEqual({
      active: false,
      idempotencyKey: "unfollow-mu",
      notificationLevel: null,
      notificationLevelProvided: false,
      targetId: "MU",
      targetType: "symbol",
    });
  });

  it("distinguishes omitted notification level from an explicit preference", () => {
    expect(
      normalizeSetFollowCommand({
        active: true,
        idempotencyKey: "follow-mu-default",
        targetId: "MU",
        targetType: "symbol",
      }),
    ).toMatchObject({ notificationLevel: null, notificationLevelProvided: false });
    expect(
      normalizeSetFollowCommand({
        active: true,
        idempotencyKey: "follow-mu-events",
        notificationLevel: "all_events",
        targetId: "MU",
        targetType: "symbol",
      }),
    ).toMatchObject({
      notificationLevel: "all_events",
      notificationLevelProvided: true,
    });
  });

  it("rejects invalid levels, booleans, and idempotency keys", () => {
    expect(() =>
      normalizeSetFollowCommand({
        active: "true" as unknown as boolean,
        idempotencyKey: "follow-mu",
        targetId: "MU",
        targetType: "symbol",
      }),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      normalizeSetFollowCommand({
        active: true,
        idempotencyKey: "follow-mu",
        notificationLevel: "urgent" as "feed_only",
        targetId: "MU",
        targetType: "symbol",
      }),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      normalizeSetFollowCommand({
        active: true,
        idempotencyKey: "   ",
        targetId: "MU",
        targetType: "symbol",
      }),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });
});

describe("Follow list normalization", () => {
  it("applies bounded defaults and optional filters", () => {
    expect(normalizeFollowListInput({})).toEqual({
      cursor: null,
      limit: 20,
      targetType: null,
    });
    expect(
      normalizeFollowListInput({ cursor: null, limit: 100, targetType: "topic" }),
    ).toEqual({ cursor: null, limit: 100, targetType: "topic" });
  });

  it("rejects invalid filters and cursors", () => {
    expect(() => normalizeFollowListInput({ limit: 101 })).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    expect(() => normalizeFollowListInput({ cursor: "not opaque cursor" })).toThrow(
      expect.objectContaining({ code: "CURSOR_INVALID" }),
    );
    expect(() =>
      normalizeFollowListInput({ targetType: "community" as "actor" }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});

describe("PostgresFollowService configuration", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, sevenDaysMs - 1])(
    "rejects unsafe idempotency retention: %s",
    (idempotencyRetentionMs) => {
      expect(
        () =>
          new PostgresFollowService(sql, {
            cursorSigningKey,
            idempotencyRetentionMs,
          }),
      ).toThrow(RangeError);
    },
  );

  it("requires a strong cursor signing key", () => {
    expect(
      () => new PostgresFollowService(sql, { cursorSigningKey: Buffer.alloc(31) }),
    ).toThrow("at least 32 bytes");
  });

  it("accepts the exact seven-day retention floor", () => {
    expect(
      () =>
        new PostgresFollowService(sql, {
          cursorSigningKey,
          idempotencyRetentionMs: sevenDaysMs,
        }),
    ).not.toThrow();
  });
});
