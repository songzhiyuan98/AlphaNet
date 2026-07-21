import { createHash } from "node:crypto";

import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it, vi } from "vitest";

import {
  PendingActionLeaseLostError,
  PostgresPendingActionExecutionRepository,
  type FencedPendingAction,
  type PendingActionExecutionClaim,
} from "./pending-action-execution.js";
import { PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM } from "./schema-migrations.js";

interface QueryCall {
  text: string;
  values: readonly unknown[];
}

type QueryResponder = (
  text: string,
  values: readonly unknown[],
) => readonly unknown[] | Promise<readonly unknown[]>;

interface TestSql {
  <T extends readonly unknown[]>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<T>;
  begin<T>(callback: (transaction: TestSql) => Promise<T>): Promise<T>;
  json(value: unknown): unknown;
}

function createTestSql(responder: QueryResponder): {
  calls: QueryCall[];
  sql: PostgresClient;
  transactions: { count: number };
} {
  const calls: QueryCall[] = [];
  const transactions = { count: 0 };
  const query = (async <T extends readonly unknown[]>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<T> => {
    const text = strings
      .reduce(
        (statement, fragment, index) =>
          `${statement}${fragment}${index < values.length ? "$value" : ""}`,
        "",
      )
      .replaceAll(/\s+/gu, " ")
      .trim();
    calls.push({ text, values });
    return (await responder(text, values)) as T;
  }) as TestSql;
  query.begin = async <T>(callback: (transaction: TestSql) => Promise<T>) => {
    transactions.count += 1;
    return callback(query);
  };
  query.json = (value: unknown): unknown => value;
  return { calls, sql: query as unknown as PostgresClient, transactions };
}

const actionId = "30000000-0000-4000-8000-000000000001";
const expiredActionId = "30000000-0000-4000-8000-000000000002";
const recoveredActionId = "30000000-0000-4000-8000-000000000003";
const failedActionId = "30000000-0000-4000-8000-000000000004";
const ownerId = "10000000-0000-4000-8000-000000000001";
const agentId = "20000000-0000-4000-8000-000000000001";
const credentialId = "40000000-0000-4000-8000-000000000001";
const idempotencyId = "50000000-0000-4000-8000-000000000001";
const decisionId = "60000000-0000-4000-8000-000000000001";
const policyId = "70000000-0000-4000-8000-000000000001";
const auditId = "80000000-0000-4000-8000-000000000001";
const decisionAuditId = "80000000-0000-4000-8000-000000000002";
const contentId = "90000000-0000-4000-8000-000000000002";
const revisionId = "90000000-0000-4000-8000-000000000003";
const rootContentId = "90000000-0000-4000-8000-000000000004";
const contentOutboxEventId = "a0000000-0000-4000-8000-000000000001";
const resolvedOutboxEventId = "a0000000-0000-4000-8000-000000000002";
const requestedAt = new Date("2026-07-20T12:00:00.000Z");
const databaseNow = new Date("2026-07-20T12:05:00.000Z");
const expiresAt = new Date("2026-07-20T13:00:00.000Z");
const leaseExpiresAt = new Date("2026-07-20T12:06:00.000Z");
const terminalAt = new Date("2026-07-20T12:05:01.000Z");
const idempotencyKey = "pending-action-idempotency-key";

function projectionRow(state: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: actionId,
    owner_id: ownerId,
    agent_id: agentId,
    operation: "create_post",
    state,
    version: "3",
    attempt_count: 1,
    failure_count: 0,
    requested_at: requestedAt,
    expires_at: expiresAt,
    terminal_at: null,
    result: null,
    error: null,
    idempotency_record_id: idempotencyId,
    decision_id: decisionId,
    policy_version: "2",
    expected_version: null,
    approval_summary: "Create one post in one Community.",
    input_digest_text: `sha256:${"a".repeat(64)}`,
    ...overrides,
  };
}

function fencedRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    ...projectionRow("executing"),
    credential_id: credentialId,
    decision_audit_id: decisionAuditId,
    target_type: "community",
    target_id: "90000000-0000-4000-8000-000000000001",
    normalized_input_ciphertext: Buffer.from("encrypted-command"),
    normalized_input_nonce: Buffer.alloc(12, 3),
    normalized_input_key_version: 1,
    normalized_input_format_version: 1,
    idempotency_key: idempotencyKey,
    input_digest: Buffer.alloc(32, 4),
    expected_version: null,
    policy_id: policyId,
    policy_snapshot: { tier: "assisted" },
    database_now: databaseNow,
    ...overrides,
  };
}

function committedRow(state: string, overrides: Readonly<Record<string, unknown>> = {}) {
  const status =
    state === "succeeded"
      ? "succeeded"
      : state === "failed" || state === "invalidated"
        ? "failed"
        : state === "expired"
          ? "denied"
          : "pending_approval";
  return {
    id: actionId,
    operation: "create_post",
    state,
    version: "4",
    attempt_count: 1,
    failure_count: 0,
    terminal_at: state === "approved" || state === "executing" ? null : terminalAt,
    result: null,
    error: null,
    idempotency_status: status,
    idempotency_response: { state },
    resource_id: null,
    ...overrides,
  };
}

function claim(
  token: Buffer = Buffer.alloc(32, 7),
  operation: PendingActionExecutionClaim["operation"] = "create_post",
): PendingActionExecutionClaim {
  return {
    actionId,
    attemptCount: 1,
    leaseExpiresAt,
    leaseOwner: "worker-a",
    leaseToken: token,
    operation,
    version: "3",
  };
}

function hasObjectValue(
  calls: readonly QueryCall[],
  predicate: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  for (const value of calls.flatMap((call) => call.values)) {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !Buffer.isBuffer(value) &&
      predicate(value as Record<string, unknown>)
    ) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

describe("PostgresPendingActionExecutionRepository readiness", () => {
  it("pins readiness to migration 000007 and its queue objects", async () => {
    const { calls, sql } = createTestSql((text) =>
      text.includes("as ready") ? [{ ready: true }] : [],
    );

    await expect(
      new PostgresPendingActionExecutionRepository(sql, {
        leaseOwner: "worker-a",
      }).checkReady(),
    ).resolves.toBeUndefined();

    const query = calls.find((call) => call.text.includes("as ready"));
    expect(query?.text).toContain("version = '000007'");
    expect(query?.text).toContain("pending_action_attempts");
    expect(query?.text).toContain("pending_actions_sync_attempt");
    expect(query?.text).toContain("checksum = $value");
    expect(query?.text).not.toContain("checksum ~");
    expect(query?.values).toContain(PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM);
  });
});

describe("PostgresPendingActionExecutionRepository claims and fencing", () => {
  it("allows two workers to compete while only one claims the due action", async () => {
    let reserved = false;
    const { calls, sql } = createTestSql((text) => {
      if (
        text.startsWith("select action.id") &&
        text.includes("for update of action skip locked")
      ) {
        if (reserved) return [];
        reserved = true;
        return [{ id: actionId }];
      }
      if (
        text.startsWith("with database_clock as materialized") &&
        text.includes("set state = 'executing'")
      ) {
        return [{ ...projectionRow("executing"), lease_expires_at: leaseExpiresAt }];
      }
      if (text.startsWith("insert into platform.action_logs")) return [{ id: auditId }];
      if (text.startsWith("update platform.pending_action_attempts")) {
        return [{ id: actionId }];
      }
      if (text.startsWith("update platform.idempotency_records")) {
        return [{ id: idempotencyId }];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const workerA = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-a",
    });
    const workerB = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-b",
    });

    const competing = await Promise.all([workerA.claimNext(), workerB.claimNext()]);
    const claimed = competing.filter(
      (value): value is PendingActionExecutionClaim => value !== null,
    );

    expect(claimed).toHaveLength(1);
    const winner = claimed[0]!;
    expect(winner.leaseToken).toHaveLength(32);
    expect(winner.attemptCount).toBe(1);
    const candidateQueries = calls.filter((call) =>
      call.text.includes("for update of action skip locked"),
    );
    expect(candidateQueries).toHaveLength(2);
    expect(candidateQueries[0]?.text).toContain("clock_timestamp()");

    const digest = createHash("sha256").update(winner.leaseToken).digest();
    expect(
      calls.some((call) =>
        call.values.some((value) => Buffer.isBuffer(value) && value.equals(digest)),
      ),
    ).toBe(true);
    for (const call of calls) {
      for (const value of call.values) {
        if (Buffer.isBuffer(value)) {
          expect(value.equals(winner.leaseToken)).toBe(false);
        }
        if (typeof value === "string") {
          expect(value).not.toContain(winner.leaseToken.toString("hex"));
          expect(value).not.toContain(winner.leaseToken.toString("base64"));
        }
      }
    }
    const audit = calls.find((call) =>
      call.text.startsWith("insert into platform.action_logs"),
    );
    expect(audit?.values).not.toContain(winner.leaseToken);
    const replay = hasObjectValue(
      calls,
      (value) => value.version === 1 && value.status === "pending_approval",
    );
    expect(replay?.pending_action).toMatchObject({ state: "executing" });
  });

  it("reads and validates the complete token fence without blocking heartbeats", async () => {
    const goodClaim = claim();
    const expectedDigest = createHash("sha256").update(goodClaim.leaseToken).digest();
    const { calls, sql } = createTestSql((text, values) => {
      if (
        text.includes("from platform.pending_actions as action") &&
        text.includes("normalized_input_ciphertext") &&
        !text.includes("for update")
      ) {
        return values.some(
          (value) => Buffer.isBuffer(value) && value.equals(expectedDigest),
        )
          ? [fencedRow()]
          : [];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const repository = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-a",
    });
    const callback = vi.fn((_transaction: unknown, action: FencedPendingAction) =>
      Promise.resolve({
        actionId: action.actionId,
        ciphertext: action.normalizedInput.ciphertext,
        decisionAuditId: action.decisionAuditId,
        decisionId: action.decisionId,
        idempotencyKey: action.idempotencyKey,
      }),
    );

    await expect(repository.withFencedClaim(goodClaim, callback)).resolves.toEqual({
      actionId,
      ciphertext: Buffer.from("encrypted-command"),
      decisionAuditId,
      decisionId,
      idempotencyKey,
    });
    expect(callback).toHaveBeenCalledOnce();

    const staleClaim = claim(Buffer.alloc(32, 8));
    await expect(repository.withFencedClaim(staleClaim, callback)).rejects.toBeInstanceOf(
      PendingActionLeaseLostError,
    );
    expect(callback).toHaveBeenCalledOnce();

    const fenceQueries = calls.filter((call) =>
      call.text.includes("normalized_input_ciphertext"),
    );
    expect(fenceQueries[0]?.text).toContain("action.state = 'executing'");
    expect(fenceQueries[0]?.text).toContain("action.attempt_count = $value");
    expect(fenceQueries[0]?.text).toContain("action.lease_owner = $value");
    expect(fenceQueries[0]?.text).toContain("action.lease_token_digest = $value");
    expect(fenceQueries[0]?.text).toContain("action.idempotency_key");
    expect(fenceQueries[0]?.text).toContain(
      "action.lease_expires_at > clock_timestamp()",
    );
    expect(fenceQueries).toHaveLength(2);
    expect(fenceQueries.every((query) => !query.text.includes("for update"))).toBe(true);
    expect(
      fenceQueries
        .flatMap((query) => query.values)
        .some((value) => Buffer.isBuffer(value) && value.equals(goodClaim.leaseToken)),
    ).toBe(false);
  });

  it("fails closed before exposing an invalid fenced idempotency key", async () => {
    const goodClaim = claim();
    const { sql } = createTestSql((text) => {
      if (
        text.includes("from platform.pending_actions as action") &&
        text.includes("normalized_input_ciphertext") &&
        !text.includes("for update")
      ) {
        return [fencedRow({ idempotency_key: "unsafe\nkey" })];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const repository = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-a",
    });
    const callback = vi.fn();

    await expect(repository.withFencedClaim(goodClaim, callback)).rejects.toThrow(
      "invalid idempotency key",
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it("renews a live heartbeat and reports committed state after lease loss", async () => {
    let heartbeatCount = 0;
    const goodClaim = claim();
    const { calls, sql } = createTestSql((text) => {
      if (
        text.startsWith("with database_clock as materialized") &&
        text.includes("last_heartbeat_at = database_clock.now")
      ) {
        heartbeatCount += 1;
        return heartbeatCount === 1
          ? [{ version: "4", lease_expires_at: leaseExpiresAt }]
          : [];
      }
      if (text.startsWith("select action.id, action.operation")) {
        return [committedRow("approved")];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const repository = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-a",
    });

    await expect(repository.renewHeartbeat(goodClaim)).resolves.toMatchObject({
      renewed: true,
      version: "4",
    });
    await expect(repository.renewHeartbeat(goodClaim)).resolves.toMatchObject({
      action: { state: "approved" },
      leaseExpiresAt: null,
      renewed: false,
    });

    const heartbeat = calls.find((call) =>
      call.text.includes("last_heartbeat_at = database_clock.now"),
    );
    expect(heartbeat?.text).toContain("clock_timestamp()");
    expect(heartbeat?.text).toContain("action.lease_token_digest = $value");
    expect(heartbeat?.text).toContain("action.lease_expires_at > database_clock.now");
  });
});

describe("PostgresPendingActionExecutionRepository recovery and completion", () => {
  it("finalizes publication, replay, audit, attempt, and resolved Outbox atomically", async () => {
    const goodClaim = claim();
    const publicResult = {
      content_id: contentId,
      resource_version: 1,
      revision_id: revisionId,
    };
    let replay: unknown = null;
    const { calls, sql, transactions } = createTestSql((text, values) => {
      if (text.includes("normalized_input_ciphertext") && !text.includes("for update")) {
        return [fencedRow()];
      }
      if (text.startsWith("select event.id")) {
        return [{ id: contentOutboxEventId }];
      }
      if (
        text.startsWith("with database_clock as materialized") &&
        text.includes("set state = 'succeeded'")
      ) {
        return [
          projectionRow("succeeded", {
            result: publicResult,
            terminal_at: terminalAt,
            version: "4",
          }),
        ];
      }
      if (text.startsWith("select pg_catalog.pg_advisory_xact_lock")) return [];
      if (text.startsWith("select coalesce(")) {
        return [{ next_sequence: "2" }];
      }
      if (text.startsWith("insert into system.outbox_events")) {
        return [{ aggregate_sequence: "2", id: resolvedOutboxEventId }];
      }
      if (text.startsWith("insert into platform.action_logs")) {
        return [{ id: auditId }];
      }
      if (text.startsWith("update platform.pending_action_attempts")) {
        return [{ id: actionId }];
      }
      if (text.startsWith("update platform.idempotency_records")) {
        replay = values.find(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            !Buffer.isBuffer(value) &&
            "version" in value,
        );
        return [{ id: idempotencyId }];
      }
      if (text.startsWith("select action.id, action.operation")) {
        return [
          committedRow("succeeded", {
            idempotency_response: replay,
            resource_id: contentId,
            result: publicResult,
          }),
        ];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const repository = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-a",
    });

    await expect(
      repository.withFencedClaim(goodClaim, async (transaction) =>
        repository.finalizeSucceeded(transaction, goodClaim, {
          correlatedOutboxEventId: contentOutboxEventId,
          resourceId: contentId,
          result: publicResult,
        }),
      ),
    ).resolves.toMatchObject({
      action: {
        idempotencyStatus: "succeeded",
        resourceId: contentId,
        result: publicResult,
        state: "succeeded",
      },
      resolvedOutboxEventId,
    });
    expect(transactions.count).toBe(1);

    const correlation = calls.find((call) => call.text.startsWith("select event.id"));
    expect(correlation?.text).toContain("aggregate_type = 'content'");
    expect(correlation?.text).toContain("event_type = $value");
    expect(correlation?.text).toContain("for share of event");

    const successUpdate = calls.find((call) =>
      call.text.includes("set state = 'succeeded'"),
    );
    expect(successUpdate?.text).toContain("action.state = 'executing'");
    expect(successUpdate?.text).toContain("action.attempt_count = $value");
    expect(successUpdate?.text).toContain("action.lease_owner = $value");
    expect(successUpdate?.text).toContain("action.lease_token_digest = $value");
    expect(successUpdate?.text).toContain("action.lease_expires_at > database_clock.now");
    expect(successUpdate?.text).toContain("clock_timestamp()");

    const resolvedPayload = hasObjectValue(
      calls,
      (value) => value.action_id === actionId && value.state === "succeeded",
    );
    expect(Object.keys(resolvedPayload ?? {}).sort()).toEqual([
      "action_id",
      "correlated_outbox_event_id",
      "operation",
      "resource_id",
      "result",
      "state",
    ]);
    expect(resolvedPayload).toMatchObject({
      action_id: actionId,
      correlated_outbox_event_id: contentOutboxEventId,
      operation: "create_post",
      resource_id: contentId,
      result: publicResult,
      state: "succeeded",
    });
    expect(replay).toMatchObject({
      error: null,
      operation: "create_post",
      pending_action: { id: actionId, state: "succeeded" },
      result: publicResult,
      status: "succeeded",
    });
    const idempotencyUpdate = calls.find((call) =>
      call.text.startsWith("update platform.idempotency_records"),
    );
    expect(idempotencyUpdate?.values).toContain(contentId);
    expect(idempotencyUpdate?.values).toContain(201);
    const audit = calls.find((call) =>
      call.text.startsWith("insert into platform.action_logs"),
    );
    expect(audit?.values).toContain(resolvedOutboxEventId);

    const serializedValues = JSON.stringify(
      calls.flatMap((call) => call.values.filter((value) => !Buffer.isBuffer(value))),
    );
    expect(serializedValues).not.toContain("encrypted-command");
    expect(serializedValues).not.toContain(goodClaim.leaseToken.toString("hex"));
    for (const value of calls.flatMap((call) => call.values)) {
      if (Buffer.isBuffer(value)) {
        expect(value.equals(goodClaim.leaseToken)).toBe(false);
      }
    }
  });

  it("finalizes an update with a nullable revision against content.revised", async () => {
    const updateClaim = claim(Buffer.alloc(32, 7), "update_content");
    const publicResult = {
      content_id: contentId,
      resource_version: 3,
      revision_id: null,
    } as const;
    let replay: unknown = null;
    const { calls, sql } = createTestSql((text, values) => {
      if (text.includes("normalized_input_ciphertext") && !text.includes("for update")) {
        return [
          fencedRow({
            expected_version: "2",
            operation: "update_content",
            target_id: contentId,
            target_type: "content",
          }),
        ];
      }
      if (text.startsWith("select event.id")) {
        return [{ id: contentOutboxEventId }];
      }
      if (
        text.startsWith("with database_clock as materialized") &&
        text.includes("set state = 'succeeded'")
      ) {
        return [
          projectionRow("succeeded", {
            expected_version: "2",
            operation: "update_content",
            result: publicResult,
            terminal_at: terminalAt,
            version: "4",
          }),
        ];
      }
      if (text.startsWith("select pg_catalog.pg_advisory_xact_lock")) return [];
      if (text.startsWith("select coalesce(")) return [{ next_sequence: "2" }];
      if (text.startsWith("insert into system.outbox_events")) {
        return [{ aggregate_sequence: "2", id: resolvedOutboxEventId }];
      }
      if (text.startsWith("insert into platform.action_logs")) return [{ id: auditId }];
      if (text.startsWith("update platform.pending_action_attempts")) {
        return [{ id: actionId }];
      }
      if (text.startsWith("update platform.idempotency_records")) {
        replay = values.find(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            !Buffer.isBuffer(value) &&
            "version" in value,
        );
        return [{ id: idempotencyId }];
      }
      if (text.startsWith("select action.id, action.operation")) {
        return [
          committedRow("succeeded", {
            idempotency_response: replay,
            operation: "update_content",
            resource_id: contentId,
            result: publicResult,
          }),
        ];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const repository = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-a",
    });

    await expect(
      repository.withFencedClaim(updateClaim, async (transaction, action) => {
        expect(action.expectedVersion).toBe(2);
        return repository.finalizeSucceeded(transaction, updateClaim, {
          correlatedOutboxEventId: contentOutboxEventId,
          resourceId: contentId,
          result: publicResult,
        });
      }),
    ).resolves.toMatchObject({
      action: { operation: "update_content", result: publicResult },
      resolvedOutboxEventId,
    });

    const correlation = calls.find((call) => call.text.startsWith("select event.id"));
    expect(correlation?.values).toContain("content.revised");
    const idempotencyUpdate = calls.find((call) =>
      call.text.startsWith("update platform.idempotency_records"),
    );
    expect(idempotencyUpdate?.values).toContain(200);
    expect(idempotencyUpdate?.values).not.toContain(201);
    expect(replay).toMatchObject({
      operation: "update_content",
      pending_action: {
        expected_version: 2,
        operation: "update_content",
        state: "succeeded",
      },
      result: publicResult,
      status: "succeeded",
    });
  });

  it("finalizes a delete with its exact tombstone result against content.deleted", async () => {
    const deleteClaim = claim(Buffer.alloc(32, 7), "delete_content");
    const publicResult = {
      content_id: contentId,
      lifecycle_state: "deleted",
      resource_version: 3,
    } as const;
    let replay: unknown = null;
    const { calls, sql } = createTestSql((text, values) => {
      if (text.includes("normalized_input_ciphertext") && !text.includes("for update")) {
        return [
          fencedRow({
            expected_version: "2",
            operation: "delete_content",
            target_id: contentId,
            target_type: "content",
          }),
        ];
      }
      if (text.startsWith("select event.id")) return [{ id: contentOutboxEventId }];
      if (
        text.startsWith("with database_clock as materialized") &&
        text.includes("set state = 'succeeded'")
      ) {
        return [
          projectionRow("succeeded", {
            expected_version: "2",
            operation: "delete_content",
            result: publicResult,
            terminal_at: terminalAt,
            version: "4",
          }),
        ];
      }
      if (text.startsWith("select pg_catalog.pg_advisory_xact_lock")) return [];
      if (text.startsWith("select coalesce(")) return [{ next_sequence: "2" }];
      if (text.startsWith("insert into system.outbox_events")) {
        return [{ aggregate_sequence: "2", id: resolvedOutboxEventId }];
      }
      if (text.startsWith("insert into platform.action_logs")) return [{ id: auditId }];
      if (text.startsWith("update platform.pending_action_attempts")) {
        return [{ id: actionId }];
      }
      if (text.startsWith("update platform.idempotency_records")) {
        replay = values.find(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            !Buffer.isBuffer(value) &&
            "version" in value,
        );
        return [{ id: idempotencyId }];
      }
      if (text.startsWith("select action.id, action.operation")) {
        return [
          committedRow("succeeded", {
            idempotency_response: replay,
            operation: "delete_content",
            resource_id: contentId,
            result: publicResult,
          }),
        ];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const repository = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-a",
    });

    await expect(
      repository.withFencedClaim(deleteClaim, async (transaction, action) => {
        expect(action.expectedVersion).toBe(2);
        return repository.finalizeSucceeded(transaction, deleteClaim, {
          correlatedOutboxEventId: contentOutboxEventId,
          resourceId: contentId,
          result: publicResult,
        });
      }),
    ).resolves.toMatchObject({
      action: { operation: "delete_content", result: publicResult },
      resolvedOutboxEventId,
    });

    const correlation = calls.find((call) => call.text.startsWith("select event.id"));
    expect(correlation?.values).toContain("content.deleted");
    const successUpdate = calls.find((call) =>
      call.text.includes("set state = 'succeeded'"),
    );
    expect(successUpdate?.text).toContain(
      "action.operation not in ('update_content', 'delete_content')",
    );
    const idempotencyUpdate = calls.find((call) =>
      call.text.startsWith("update platform.idempotency_records"),
    );
    expect(idempotencyUpdate?.values).toContain(200);
    expect(idempotencyUpdate?.values).not.toContain(201);
    expect(replay).toMatchObject({
      operation: "delete_content",
      pending_action: {
        expected_version: 2,
        operation: "delete_content",
        state: "succeeded",
      },
      result: publicResult,
      status: "succeeded",
    });
    expect(Object.keys((replay as { result: object }).result).sort()).toEqual([
      "content_id",
      "lifecycle_state",
      "resource_version",
    ]);
  });

  it("rejects a delete result that skips a resource version before audit", async () => {
    const deleteClaim = claim(Buffer.alloc(32, 7), "delete_content");
    const { calls, sql } = createTestSql((text) => {
      if (text.startsWith("select event.id")) return [{ id: contentOutboxEventId }];
      if (
        text.startsWith("with database_clock as materialized") &&
        text.includes("set state = 'succeeded'")
      ) {
        return [
          projectionRow("succeeded", {
            expected_version: "2",
            operation: "delete_content",
            result: {
              content_id: contentId,
              lifecycle_state: "deleted",
              resource_version: 4,
            },
            terminal_at: terminalAt,
            version: "4",
          }),
        ];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const repository = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-a",
    });

    await expect(
      repository.finalizeSucceeded(sql as never, deleteClaim, {
        correlatedOutboxEventId: contentOutboxEventId,
        resourceId: contentId,
        result: {
          content_id: contentId,
          lifecycle_state: "deleted",
          resource_version: 4,
        },
      }),
    ).rejects.toThrow("advance expected_version by exactly one");

    expect(
      calls.some((call) => call.text.startsWith("insert into platform.action_logs")),
    ).toBe(false);
  });

  it("rejects an update result that skips a resource version before audit or idempotency", async () => {
    const updateClaim = claim(Buffer.alloc(32, 7), "update_content");
    const { calls, sql } = createTestSql((text) => {
      if (text.startsWith("select event.id")) {
        return [{ id: contentOutboxEventId }];
      }
      if (
        text.startsWith("with database_clock as materialized") &&
        text.includes("set state = 'succeeded'")
      ) {
        return [
          projectionRow("succeeded", {
            expected_version: "2",
            operation: "update_content",
            result: {
              content_id: contentId,
              resource_version: 4,
              revision_id: null,
            },
            terminal_at: terminalAt,
            version: "4",
          }),
        ];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const repository = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-a",
    });

    await expect(
      repository.finalizeSucceeded(sql as never, updateClaim, {
        correlatedOutboxEventId: contentOutboxEventId,
        resourceId: contentId,
        result: {
          content_id: contentId,
          resource_version: 4,
          revision_id: null,
        },
      }),
    ).rejects.toThrow("advance expected_version by exactly one");

    const successUpdate = calls.find((call) =>
      call.text.includes("set state = 'succeeded'"),
    );
    expect(successUpdate?.text).toContain("action.operation = $value");
    expect(successUpdate?.text).toContain("action.expected_version + 1 = $value");
    expect(successUpdate?.values).toContain("update_content");
    expect(successUpdate?.values).toContain(4);
    expect(
      calls.some(
        (call) =>
          call.text.startsWith("insert into platform.action_logs") ||
          call.text.startsWith("update platform.idempotency_records"),
      ),
    ).toBe(false);
  });

  it("rolls back successful publication finalization when the second fence is lost", async () => {
    const goodClaim = claim();
    const { calls, sql, transactions } = createTestSql((text) => {
      if (text.includes("normalized_input_ciphertext") && !text.includes("for update")) {
        return [fencedRow()];
      }
      if (text.startsWith("select event.id")) {
        return [{ id: contentOutboxEventId }];
      }
      if (text.includes("set state = 'succeeded'")) return [];
      throw new Error(`Unexpected SQL after a lost fence: ${text}`);
    });
    const repository = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-a",
    });

    await expect(
      repository.withFencedClaim(goodClaim, async (transaction) =>
        repository.finalizeSucceeded(transaction, goodClaim, {
          correlatedOutboxEventId: contentOutboxEventId,
          resourceId: contentId,
          result: {
            content_id: contentId,
            resource_version: 1,
            revision_id: revisionId,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(PendingActionLeaseLostError);
    expect(transactions.count).toBe(1);
    expect(calls.some((call) => call.text.includes("pg_advisory_xact_lock"))).toBe(false);
    expect(
      calls.some((call) => call.text.startsWith("insert into platform.action_logs")),
    ).toBe(false);
    expect(
      calls.some((call) => call.text.startsWith("update platform.idempotency_records")),
    ).toBe(false);
  });

  it("rejects malformed operation-specific success results before touching SQL", async () => {
    const { calls, sql } = createTestSql((text) => {
      throw new Error(`Unexpected SQL for invalid success input: ${text}`);
    });
    const repository = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-a",
    });
    const transaction = sql as unknown as Parameters<
      PostgresPendingActionExecutionRepository["finalizeSucceeded"]
    >[0];

    await expect(
      repository.finalizeSucceeded(transaction, claim(), {
        correlatedOutboxEventId: contentOutboxEventId,
        resourceId: contentId,
        result: {
          content_id: contentId,
          resource_version: 1,
          revision_id: revisionId,
          root_content_id: rootContentId,
        },
      }),
    ).rejects.toThrow("invalid public result shape");
    await expect(
      repository.finalizeSucceeded(
        transaction,
        claim(Buffer.alloc(32, 7), "reply_to_content"),
        {
          correlatedOutboxEventId: contentOutboxEventId,
          resourceId: contentId,
          result: {
            content_id: contentId,
            resource_version: 1,
            revision_id: revisionId,
          },
        },
      ),
    ).rejects.toThrow("invalid public result shape");
    await expect(
      repository.finalizeSucceeded(
        transaction,
        claim(Buffer.alloc(32, 7), "update_content"),
        {
          correlatedOutboxEventId: contentOutboxEventId,
          resourceId: contentId,
          result: {
            content_id: contentId,
            resource_version: 3,
            revision_id: 7,
          } as never,
        },
      ),
    ).rejects.toThrow("revision_id");
    await expect(
      repository.finalizeSucceeded(
        transaction,
        claim(Buffer.alloc(32, 7), "delete_content"),
        {
          correlatedOutboxEventId: contentOutboxEventId,
          resourceId: contentId,
          result: {
            content_id: contentId,
            lifecycle_state: "deleted",
            resource_version: 3,
            revision_id: null,
          } as never,
        },
      ),
    ).rejects.toThrow("invalid public result shape");
    expect(calls).toHaveLength(0);
  });

  it("CAS-schedules a bounded retry while clearing every current lease field", async () => {
    const goodClaim = claim();
    const { calls, sql } = createTestSql((text) => {
      if (
        text.includes("normalized_input_ciphertext") &&
        text.endsWith("for update of action")
      ) {
        return [fencedRow()];
      }
      if (
        text.startsWith("with database_clock as materialized") &&
        text.includes("set state = 'approved'")
      ) {
        return [projectionRow("approved", { failure_count: 1, version: "4" })];
      }
      if (text.startsWith("insert into platform.action_logs")) return [{ id: auditId }];
      if (text.startsWith("update platform.pending_action_attempts")) {
        return [{ id: actionId }];
      }
      if (text.startsWith("update platform.idempotency_records")) {
        return [{ id: idempotencyId }];
      }
      if (text.startsWith("select action.id, action.operation")) {
        return [committedRow("approved", { failure_count: 1 })];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const repository = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-a",
    });

    await expect(
      repository.scheduleRetry(goodClaim, {
        maximumDelaySeconds: 45,
        minimumDelaySeconds: 30,
      }),
    ).resolves.toMatchObject({
      applied: true,
      action: { failureCount: 1, state: "approved" },
    });

    const retry = calls.find(
      (call) =>
        call.text.includes("set state = 'approved'") &&
        call.text.includes("retry_scheduled") === false,
    );
    expect(retry?.text).toContain("executing_at = null");
    expect(retry?.text).toContain("lease_owner = null");
    expect(retry?.text).toContain("lease_token_digest = null");
    expect(retry?.text).toContain("lease_expires_at = null");
    expect(retry?.text).toContain("last_heartbeat_at = null");
    expect(retry?.text).toContain("failure_count = action.failure_count + $value");
    expect(retry?.text).toContain("least(");
    expect(retry?.text).toContain("random() *");
    expect(retry?.text).toContain("$value::double precision - $value::double precision");
    expect(retry?.text).toContain("action.expires_at - interval '1 millisecond'");
    expect(retry?.text).toContain("clock_timestamp()");
    expect(retry?.values).toContain(30);
    expect(retry?.values).toContain(45);
    const replay = hasObjectValue(calls, (value) => value.status === "pending_approval");
    expect(replay?.pending_action).toMatchObject({ state: "approved" });
  });

  it("uses failure-count exponential full jitter for an ordinary retry", async () => {
    const goodClaim = { ...claim(), attemptCount: 57 };
    const { calls, sql } = createTestSql((text) => {
      if (
        text.includes("normalized_input_ciphertext") &&
        text.endsWith("for update of action")
      ) {
        return [fencedRow({ attempt_count: 57, failure_count: 4 })];
      }
      if (
        text.startsWith("with database_clock as materialized") &&
        text.includes("set state = 'approved'")
      ) {
        return [
          projectionRow("approved", {
            attempt_count: 57,
            failure_count: 5,
            version: "4",
          }),
        ];
      }
      if (text.startsWith("insert into platform.action_logs")) return [{ id: auditId }];
      if (text.startsWith("update platform.pending_action_attempts")) {
        return [{ id: actionId }];
      }
      if (text.startsWith("update platform.idempotency_records")) {
        return [{ id: idempotencyId }];
      }
      if (text.startsWith("select action.id, action.operation")) {
        return [
          committedRow("approved", {
            attempt_count: 57,
            failure_count: 5,
          }),
        ];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const repository = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-a",
      retryDelayCapSeconds: 300,
    });

    await expect(repository.scheduleRetry(goodClaim)).resolves.toMatchObject({
      applied: true,
      action: { attemptCount: 57, failureCount: 5, state: "approved" },
    });

    const retry = calls.find((call) => call.text.includes("set state = 'approved'"));
    expect(retry?.text).toContain("random() *");
    expect(retry?.values).toContain(32);
    expect(
      calls.some((call) => call.values.includes("pending_action.retry_scheduled")),
    ).toBe(true);
  });

  it("defers rate or quota capacity without consuming the failure budget", async () => {
    const goodClaim = { ...claim(), attemptCount: 20 };
    const { calls, sql } = createTestSql((text) => {
      if (
        text.includes("normalized_input_ciphertext") &&
        text.endsWith("for update of action")
      ) {
        return [fencedRow({ attempt_count: 20, failure_count: 19 })];
      }
      if (
        text.startsWith("with database_clock as materialized") &&
        text.includes("set state = 'approved'")
      ) {
        return [
          projectionRow("approved", {
            attempt_count: 20,
            failure_count: 19,
            version: "4",
          }),
        ];
      }
      if (text.startsWith("insert into platform.action_logs")) return [{ id: auditId }];
      if (text.startsWith("update platform.pending_action_attempts")) {
        return [{ id: actionId }];
      }
      if (text.startsWith("update platform.idempotency_records")) {
        return [{ id: idempotencyId }];
      }
      if (text.startsWith("select action.id, action.operation")) {
        return [
          committedRow("approved", {
            attempt_count: 20,
            failure_count: 19,
          }),
        ];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const repository = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-a",
    });

    await expect(
      repository.scheduleRetry(goodClaim, {
        budgetDisposition: "defer",
        maximumDelaySeconds: 91,
        minimumDelaySeconds: 91,
      }),
    ).resolves.toMatchObject({
      applied: true,
      action: { attemptCount: 20, failureCount: 19, state: "approved" },
    });

    expect(
      calls.some((call) => call.values.includes("pending_action.execution_deferred")),
    ).toBe(true);
    expect(calls.some((call) => call.values.includes("rate_or_quota_deferred"))).toBe(
      true,
    );
    expect(calls.some((call) => call.text.includes("set state = $value"))).toBe(false);
  });

  it("rejects a retry minimum above its maximum without touching the database", async () => {
    const goodClaim = claim();
    const { calls, sql } = createTestSql((text) => {
      throw new Error(`Unexpected SQL for invalid retry bounds: ${text}`);
    });
    const repository = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-a",
    });

    await expect(
      repository.scheduleRetry(goodClaim, {
        maximumDelaySeconds: 30,
        minimumDelaySeconds: 31,
      }),
    ).rejects.toThrow(
      "minimumDelaySeconds must be less than or equal to maximumDelaySeconds",
    );
    expect(calls).toHaveLength(0);
  });

  it("reaps expiry, charges a lease failure, and fails only the twentieth failure", async () => {
    const { calls, sql } = createTestSql((text, values) => {
      if (
        text.startsWith("select action.id, action.state") &&
        text.includes("for update of action skip locked")
      ) {
        return [
          {
            id: expiredActionId,
            state: "pending_approval",
            version: "1",
            attempt_count: 0,
            failure_count: 0,
            expires_at: databaseNow,
            database_now: databaseNow,
          },
          {
            id: recoveredActionId,
            state: "executing",
            version: "4",
            attempt_count: 202,
            failure_count: 2,
            expires_at: expiresAt,
            database_now: databaseNow,
          },
          {
            id: failedActionId,
            state: "executing",
            version: "22",
            attempt_count: 420,
            failure_count: 19,
            expires_at: expiresAt,
            database_now: databaseNow,
          },
        ];
      }
      if (text.includes("set state = 'expired'") && values.includes(expiredActionId)) {
        return [
          projectionRow("expired", {
            id: expiredActionId,
            attempt_count: 0,
            failure_count: 0,
            terminal_at: terminalAt,
          }),
        ];
      }
      if (text.includes("set state = 'approved'") && values.includes(recoveredActionId)) {
        return [
          projectionRow("approved", {
            id: recoveredActionId,
            attempt_count: 202,
            failure_count: 3,
          }),
        ];
      }
      if (text.includes("set state = 'failed'") && values.includes(failedActionId)) {
        return [
          projectionRow("failed", {
            id: failedActionId,
            attempt_count: 420,
            failure_count: 20,
            terminal_at: terminalAt,
          }),
        ];
      }
      if (text.startsWith("insert into platform.action_logs")) return [{ id: auditId }];
      if (text.startsWith("update platform.pending_action_attempts")) {
        return [{ id: actionId }];
      }
      if (text.startsWith("update platform.idempotency_records")) {
        return [{ id: idempotencyId }];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const repository = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-reaper",
      retryDelayCapSeconds: 120,
    });

    await expect(repository.reap()).resolves.toEqual({
      expired: 1,
      failed: 1,
      processed: 3,
      recovered: 1,
    });

    const candidateQuery = calls.find((call) =>
      call.text.includes("for update of action skip locked"),
    );
    expect(candidateQuery?.text).toContain("clock_timestamp()");
    const recovery = calls.find(
      (call) =>
        call.text.includes("set state = 'approved'") &&
        call.values.includes(recoveredActionId),
    );
    expect(recovery?.text).toContain("lease_token_digest = null");
    expect(recovery?.text).toContain("random()");
    expect(recovery?.text).toContain("action.expires_at - interval '1 millisecond'");
    expect(recovery?.text).toContain("failure_count = action.failure_count + 1");
    expect(recovery?.values).toContain(8);
    const maxFailure = calls.find(
      (call) =>
        call.text.includes("set state = 'failed'") &&
        call.values.includes(failedActionId),
    );
    expect(maxFailure?.text).toContain("action.failure_count + 1 >= $value");
    const databaseError = hasObjectValue(
      calls,
      (value) => value.code === "ACTION_EXECUTION_FAILED" && "retry_after_ms" in value,
    );
    expect(databaseError).toEqual({
      code: "ACTION_EXECUTION_FAILED",
      message: "The approved action could not be completed.",
      retryable: false,
      details: null,
      retry_after_ms: null,
    });
    const replay = hasObjectValue(
      calls,
      (value) => value.status === "failed" && value.decision === "require_approval",
    );
    expect(replay?.error).toMatchObject({
      code: "ACTION_EXECUTION_FAILED",
      retryAfterMs: null,
    });
  });

  it.each([
    ["markFailed", "failed", "ACTION_EXECUTION_FAILED"],
    ["markInvalidated", "invalidated", "ACTION_INVALIDATED"],
  ] as const)(
    "%s commits only the safe %s terminal projection",
    async (method, state, code) => {
      const goodClaim = claim();
      let replay: unknown = null;
      const { calls, sql } = createTestSql((text, values) => {
        if (
          text.includes("normalized_input_ciphertext") &&
          text.endsWith("for update of action")
        ) {
          return [fencedRow()];
        }
        if (
          text.startsWith("with database_clock as materialized") &&
          text.includes("terminal_at = database_clock.now")
        ) {
          return [
            projectionRow(state, {
              terminal_at: terminalAt,
              error: {
                code,
                message:
                  state === "failed"
                    ? "The approved action could not be completed."
                    : "The frozen action is no longer valid.",
                retryable: false,
                details: null,
                retry_after_ms: null,
              },
            }),
          ];
        }
        if (text.startsWith("insert into platform.action_logs")) return [{ id: auditId }];
        if (text.startsWith("update platform.pending_action_attempts")) {
          return [{ id: actionId }];
        }
        if (text.startsWith("update platform.idempotency_records")) {
          replay = values.find(
            (value) =>
              typeof value === "object" &&
              value !== null &&
              !Buffer.isBuffer(value) &&
              "version" in value,
          );
          return [{ id: idempotencyId }];
        }
        if (text.startsWith("select action.id, action.operation")) {
          return [
            committedRow(state, {
              error: { code },
              idempotency_response: replay,
            }),
          ];
        }
        throw new Error(`Unexpected SQL: ${text}`);
      });
      const repository = new PostgresPendingActionExecutionRepository(sql, {
        leaseOwner: "worker-a",
      });

      await expect(repository[method](goodClaim)).resolves.toMatchObject({
        applied: true,
        action: { state },
      });
      expect(replay).toMatchObject({
        status: "failed",
        pending_action: { state },
        error: { code, retryAfterMs: null },
      });
      expect(JSON.stringify(replay)).not.toContain("encrypted-command");
      expect(JSON.stringify(replay)).not.toContain(goodClaim.leaseToken.toString("hex"));
      const terminalUpdate = calls.find((call) =>
        call.text.includes("terminal_at = database_clock.now"),
      );
      expect(terminalUpdate?.text).toContain("action.lease_token_digest = $value");
      expect(terminalUpdate?.text).toContain(
        "action.lease_expires_at > database_clock.now",
      );
    },
  );

  it("does not move a committed terminal action backward and supports ACK reconciliation", async () => {
    const goodClaim = claim();
    const { calls, sql } = createTestSql((text) => {
      if (
        text.includes("normalized_input_ciphertext") &&
        text.endsWith("for update of action")
      ) {
        return [];
      }
      if (text.startsWith("select action.id, action.operation")) {
        return [
          committedRow("failed", {
            error: { code: "ACTION_EXECUTION_FAILED" },
            idempotency_response: {
              status: "failed",
              error: { code: "ACTION_EXECUTION_FAILED" },
            },
          }),
        ];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const repository = new PostgresPendingActionExecutionRepository(sql, {
      leaseOwner: "worker-a",
    });

    await expect(repository.markInvalidated(goodClaim)).resolves.toMatchObject({
      applied: false,
      action: { state: "failed" },
    });
    await expect(repository.readCommittedState(actionId)).resolves.toMatchObject({
      idempotencyStatus: "failed",
      state: "failed",
    });
    expect(calls.some((call) => call.text.includes("set state = $value"))).toBe(false);
  });
});
