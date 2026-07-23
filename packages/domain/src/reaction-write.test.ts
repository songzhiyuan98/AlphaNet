import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it } from "vitest";

import type { AgentCredentialContext } from "./agent-connection.js";
import { PostgresReactionWriteService } from "./reaction-write.js";

const sql = {} as PostgresClient;
const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000;
const ownerId = "10000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000002";
const agentId = "10000000-0000-4000-8000-000000000003";
const credentialId = "10000000-0000-4000-8000-000000000004";
const policyId = "10000000-0000-4000-8000-000000000005";
const contentId = "10000000-0000-4000-8000-000000000006";

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
      displayName: "Reaction Agent",
      handle: "reaction-agent",
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
      name: "Reaction test",
      ownerId,
      policyCeiling: "autonomous",
      policyCeilingDefaultsVersion: "agent-permission-defaults-v1",
      policyCeilingRules: { operations: {} },
      policyCeilingSchemaVersion: 1,
      prefix: "aln_v1_reaction",
      replacesCredentialId: null,
      revokedAt: null,
      scopes: ["reaction:write"],
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
    if (text.startsWith("set local")) return [];
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
          credential_scopes: ["reaction:write"],
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
          updated_by_admin_id: "10000000-0000-4000-8000-000000000099",
          version: "2",
        },
      ];
    }
    throw new Error(`Unexpected Reaction SQL: ${text}`);
  }) as FakeRoot;
  tag.begin = (callback) => callback(tag);
  tag.json = (value) => value;
  return tag as unknown as PostgresClient;
}

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

  it("rejects a new Reaction transiently while platform writes are paused", async () => {
    const service = new PostgresReactionWriteService(pausedSql());
    const outcome = await service.setReaction(
      context(),
      {
        active: true,
        contentId,
        idempotencyKey: "reaction-platform-pause",
        reaction: "helpful",
      },
      { requestId: "req-reaction-platform-pause" },
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
