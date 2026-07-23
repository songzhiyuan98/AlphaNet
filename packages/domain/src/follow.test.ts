import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it } from "vitest";

import type { AgentCredentialContext } from "./agent-connection.js";
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
const ownerId = "11000000-0000-4000-8000-000000000001";
const agentId = "11000000-0000-4000-8000-000000000003";
const credentialId = "11000000-0000-4000-8000-000000000004";
const policyId = "11000000-0000-4000-8000-000000000005";
const followTargetActorId = "11000000-0000-4000-8000-000000000006";

function context(): AgentCredentialContext {
  const at = new Date("2026-07-01T00:00:00.000Z");
  return {
    owner: { id: ownerId },
    agent: {
      activatedAt: at,
      actorId,
      archivedAt: null,
      bio: null,
      createdAt: at,
      credentialCount: 1,
      discoveryTags: [],
      displayName: "Follow Agent",
      handle: "follow-agent",
      id: agentId,
      ownerId,
      policy: {
        defaultsVersion: "agent-permission-defaults-v1",
        effectiveFrom: at,
        id: policyId,
        rules: { operations: {} },
        schemaVersion: 1,
        tier: "autonomous",
        version: "1",
      },
      restrictionReasonCode: null,
      status: "active",
      updatedAt: at,
    },
    credential: {
      agentId,
      audience: "alphanet-api",
      expiresAt: null,
      id: credentialId,
      issuedAt: at,
      lastUsedAt: null,
      name: "Follow test",
      ownerId,
      policyCeiling: "autonomous",
      policyCeilingDefaultsVersion: "agent-permission-defaults-v1",
      policyCeilingRules: { operations: {} },
      policyCeilingSchemaVersion: 1,
      prefix: "aln_v1_follow",
      replacesCredentialId: null,
      revokedAt: null,
      scopes: ["follow:write"],
      status: "active",
      type: "static_api_key",
    },
  };
}

function pausedSql(): PostgresClient {
  type FakeTransaction = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown[]>) & {
    json(value: unknown): unknown;
  };
  type FakeRoot = FakeTransaction & {
    begin<T>(callback: (transaction: FakeTransaction) => Promise<T>): Promise<T>;
  };
  const tag = (async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    await Promise.resolve();
    void values;
    const text = strings.join(" ? ").replace(/\s+/gu, " ").trim();
    if (
      text.startsWith("set local") ||
      text.startsWith("select set_config('statement_timeout'")
    ) {
      return [];
    }
    if (text.includes("select owner.id::text as id")) return [{ id: ownerId }];
    if (
      text.includes("from platform.credentials as credential") &&
      text.includes("policy.version::text as policy_version")
    ) {
      return [
        {
          actor_id: actorId,
          agent_activated_at: new Date("2026-07-01T00:00:00.000Z"),
          credential_policy_ceiling: "autonomous",
          credential_policy_ceiling_defaults_version: "agent-permission-defaults-v1",
          credential_policy_ceiling_rules: { operations: {} },
          credential_policy_ceiling_schema_version: 1,
          credential_scopes: ["follow:write"],
          defaults_version: "agent-permission-defaults-v1",
          policy_id: policyId,
          policy_rules: { operations: {} },
          policy_schema_version: 1,
          policy_tier: "autonomous",
          policy_version: "1",
        },
      ];
    }
    if (text.includes("pg_catalog.pg_advisory_xact_lock")) return [];
    if (
      text.includes("from platform.idempotency_records") &&
      text.includes("for update")
    ) {
      return [];
    }
    if (text.includes("from platform.community_write_controls")) {
      return [
        {
          mode: "paused",
          pause_reason_code: "security_incident",
          paused_at: new Date("2026-07-23T20:00:00.000Z"),
          resume_condition: "Resume after containment.",
          updated_at: new Date("2026-07-23T20:00:00.000Z"),
          updated_by_admin_id: "11000000-0000-4000-8000-000000000099",
          version: "2",
        },
      ];
    }
    throw new Error(`Unexpected Follow SQL: ${text}`);
  }) as FakeRoot;
  tag.begin = (callback) => callback(tag);
  tag.json = (value) => value;
  return tag as unknown as PostgresClient;
}

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

  it("rejects a new Follow transiently while platform writes are paused", async () => {
    const service = new PostgresFollowService(pausedSql(), {
      cursorSigningKey,
    });
    const outcome = await service.setFollow(
      context(),
      {
        active: true,
        idempotencyKey: "follow-platform-pause",
        targetId: followTargetActorId,
        targetType: "actor",
      },
      { requestId: "req-follow-platform-pause" },
    );
    expect(outcome).toMatchObject({
      error: {
        code: "PLATFORM_WRITE_PAUSED",
        details: {
          control_version: 2,
          reason_code: "security_incident",
        },
        retryable: true,
      },
      replayed: false,
      status: "failed",
    });
  });
});
