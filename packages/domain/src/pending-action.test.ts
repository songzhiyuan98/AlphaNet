import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it } from "vitest";

import {
  PendingActionStatusError,
  PostgresPendingActionStatusService,
} from "./pending-action.js";

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
}

function createTestSql(responder: QueryResponder): {
  calls: QueryCall[];
  sql: PostgresClient;
} {
  const calls: QueryCall[] = [];
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
  query.begin = async <T>(callback: (transaction: TestSql) => Promise<T>): Promise<T> =>
    callback(query);

  return { calls, sql: query as unknown as PostgresClient };
}

const ownerId = "10000000-0000-4000-8000-000000000001";
const otherOwnerId = "10000000-0000-4000-8000-000000000002";
const agentId = "20000000-0000-4000-8000-000000000001";
const siblingAgentId = "20000000-0000-4000-8000-000000000002";
const actionId = "30000000-0000-4000-8000-000000000001";
const requestedAt = new Date("2026-07-19T19:15:00.000Z");
const expiresAt = new Date("2026-07-20T19:15:00.000Z");
const decidedAt = new Date("2026-07-19T19:16:12.000Z");
const completedAt = new Date("2026-07-19T19:16:13.000Z");

function pendingRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: actionId,
    operation: "create_post",
    state: "pending_approval",
    decision_id: "40000000-0000-4000-8000-000000000001",
    public_policy_version: "50000000-0000-4000-8000-000000000001:4",
    requested_at: requestedAt,
    expires_at: expiresAt,
    decided_at: null,
    executing_at: null,
    completed_at: null,
    terminal_at: null,
    public_input_digest: `sha256:${"a".repeat(64)}`,
    approval_summary: "Create one post in the Semiconductors community.",
    approval_method: null,
    decided_by_owner_id: null,
    result: null,
    error: null,
    ...overrides,
  };
}

const rejectedError = {
  code: "ACTION_REJECTED",
  message: "The Owner rejected this action.",
  retryable: false,
  details: null,
  retry_after_ms: null,
} as const;

describe("PostgresPendingActionStatusService visibility boundary", () => {
  it("uses one exact action + Owner + Agent predicate and returns a public allowlist", async () => {
    const rawRow = pendingRow({
      normalized_input_ciphertext: Buffer.from("private frozen command"),
      policy_snapshot: { internal: true },
      idempotency_key: "private-key",
      lease_owner: "worker-01",
      audit_id: "60000000-0000-4000-8000-000000000001",
    });
    const { calls, sql } = createTestSql((_text, values) =>
      values[0] === actionId && values[1] === ownerId && values[2] === agentId
        ? [rawRow]
        : [],
    );
    const service = new PostgresPendingActionStatusService(sql);

    const action = await service.getActionStatus({ ownerId, agentId }, actionId);

    expect(action).toEqual({
      id: actionId,
      operation: "create_post",
      decision: "require_approval",
      status: "pending_approval",
      state: "pending_approval",
      decisionId: rawRow.decision_id,
      policyVersion: rawRow.public_policy_version,
      requestedAt,
      expiresAt,
      decidedAt: null,
      executingAt: null,
      completedAt: null,
      terminalAt: null,
      inputDigest: rawRow.public_input_digest,
      approvalSummary: rawRow.approval_summary,
      approvalOutcome: null,
      approvalMethod: null,
      decidedByOwnerId: null,
      result: null,
      error: null,
    });
    expect(Object.keys(action)).not.toEqual(
      expect.arrayContaining([
        "ownerId",
        "agentId",
        "credentialId",
        "normalizedInputCiphertext",
        "policySnapshot",
        "idempotencyKey",
        "leaseOwner",
        "auditId",
      ]),
    );

    const query = calls.at(-1);
    expect(query?.values).toEqual([actionId, ownerId, agentId]);
    expect(query?.text).toMatch(
      /where id = \$value and owner_id = \$value and agent_id = \$value/u,
    );
    for (const internalColumn of [
      "normalized_input_ciphertext",
      "normalized_input_nonce",
      "credential_id",
      "principal_scope_key",
      "idempotency_key",
      "idempotency_record_id",
      "policy_snapshot",
      "lease_owner",
      "lease_token_digest",
      "audit_id",
    ]) {
      expect(query?.text).not.toContain(internalColumn);
    }
  });

  it("allows another credential of the same Agent without accepting a credential selector", async () => {
    const { sql } = createTestSql(() => [pendingRow()]);
    const service = new PostgresPendingActionStatusService(sql);

    await expect(
      service.getActionStatus({ ownerId, agentId }, actionId),
    ).resolves.toMatchObject({ id: actionId });
    expect(Object.keys({ ownerId, agentId })).toEqual(["ownerId", "agentId"]);
  });

  it.each([
    ["same-Owner sibling Agent", { ownerId, agentId: siblingAgentId }],
    ["cross-Owner Agent", { ownerId: otherOwnerId, agentId }],
  ])("makes %s indistinguishable from a missing action", async (_label, actor) => {
    const { sql } = createTestSql((_text, values) =>
      values[1] === ownerId && values[2] === agentId ? [pendingRow()] : [],
    );
    const service = new PostgresPendingActionStatusService(sql);

    await expect(service.getActionStatus(actor, actionId)).rejects.toMatchObject({
      code: "ACTION_NOT_FOUND",
      message: "The requested action was not found.",
      retryable: false,
      statusCode: 404,
    });
  });

  it("rejects a malformed database identifier as not found without querying", async () => {
    const { calls, sql } = createTestSql(() => [pendingRow()]);

    await expect(
      new PostgresPendingActionStatusService(sql).getActionStatus(
        { ownerId, agentId },
        "act_not-a-database-uuid",
      ),
    ).rejects.toMatchObject({ code: "ACTION_NOT_FOUND", statusCode: 404 });
    expect(calls).toHaveLength(0);
  });
});

describe("PostgresPendingActionStatusService public state evidence", () => {
  it("projects an operation-specific successful result", async () => {
    const row = pendingRow({
      state: "succeeded",
      decided_at: decidedAt,
      executing_at: decidedAt,
      completed_at: completedAt,
      terminal_at: completedAt,
      approval_method: "owner_approval",
      decided_by_owner_id: ownerId,
      result: {
        content_id: "70000000-0000-4000-8000-000000000001",
        revision_id: "80000000-0000-4000-8000-000000000001",
        resource_version: 1,
      },
    });
    const { sql } = createTestSql(() => [row]);

    await expect(
      new PostgresPendingActionStatusService(sql).getActionStatus(
        { ownerId, agentId },
        actionId,
      ),
    ).resolves.toMatchObject({
      approvalOutcome: "approved",
      error: null,
      result: row.result,
      state: "succeeded",
      status: "succeeded",
    });
  });

  it("projects a rejected action as denied with structured terminal evidence", async () => {
    const row = pendingRow({
      state: "rejected",
      decided_at: decidedAt,
      terminal_at: decidedAt,
      approval_method: "owner_approval",
      decided_by_owner_id: ownerId,
      error: rejectedError,
    });
    const { sql } = createTestSql(() => [row]);

    await expect(
      new PostgresPendingActionStatusService(sql).getActionStatus(
        { ownerId, agentId },
        actionId,
      ),
    ).resolves.toMatchObject({
      approvalOutcome: "rejected",
      error: rejectedError,
      result: null,
      state: "rejected",
      status: "denied",
    });
  });

  it("maps arbitrary stored diagnostics to a server-owned public error", async () => {
    const privateMarker = "postgres://worker:secret@private.invalid/research-draft";
    const row = pendingRow({
      state: "failed",
      decided_at: decidedAt,
      executing_at: decidedAt,
      completed_at: completedAt,
      terminal_at: completedAt,
      approval_method: "owner_approval",
      decided_by_owner_id: ownerId,
      error: {
        code: "RAW_WORKER_EXCEPTION",
        message: privateMarker,
        retryable: true,
        details: { nested: { draft: privateMarker, oauth_token: "token-secret" } },
      },
    });
    const { sql } = createTestSql(() => [row]);

    const action = await new PostgresPendingActionStatusService(sql).getActionStatus(
      { ownerId, agentId },
      actionId,
    );

    expect(action.error).toEqual({
      code: "ACTION_EXECUTION_FAILED",
      message: "The approved action could not be completed.",
      retryable: false,
      details: null,
      retry_after_ms: null,
    });
    expect(JSON.stringify(action)).not.toContain(privateMarker);
    expect(JSON.stringify(action)).not.toContain("token-secret");
  });

  it.each([
    [
      "success without a result",
      pendingRow({
        state: "succeeded",
        decided_at: decidedAt,
        executing_at: decidedAt,
        completed_at: completedAt,
        terminal_at: completedAt,
        approval_method: "owner_approval",
        decided_by_owner_id: ownerId,
      }),
    ],
    [
      "terminal failure without an error",
      pendingRow({
        state: "rejected",
        decided_at: decidedAt,
        terminal_at: decidedAt,
        approval_method: "owner_approval",
        decided_by_owner_id: ownerId,
      }),
    ],
    [
      "contradictory decision evidence",
      pendingRow({
        state: "approved",
        decided_at: decidedAt,
        approval_method: null,
        decided_by_owner_id: ownerId,
      }),
    ],
  ])("fails closed for %s", async (_label, row) => {
    const { sql } = createTestSql(() => [row]);

    await expect(
      new PostgresPendingActionStatusService(sql).getActionStatus(
        { ownerId, agentId },
        actionId,
      ),
    ).rejects.toMatchObject({
      code: "ACTION_STATUS_UNAVAILABLE",
      retryable: true,
      statusCode: 503,
    });
  });

  it("turns database failures into a stable unavailable error without a cause", async () => {
    const { sql } = createTestSql(() => {
      throw new Error("postgres.internal.host:5432 secret query detail");
    });

    const error = await new PostgresPendingActionStatusService(sql)
      .getActionStatus({ ownerId, agentId }, actionId)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PendingActionStatusError);
    expect(error).toMatchObject({
      code: "ACTION_STATUS_UNAVAILABLE",
      message: "Action status is temporarily unavailable.",
    });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("postgres.internal.host");
  });
});

describe("PostgresPendingActionStatusService readiness", () => {
  it("pins the exact forward-only migration and critical schema shape", async () => {
    const { calls, sql } = createTestSql((text) =>
      text.startsWith("select exists") ? [{ ready: true }] : [],
    );
    const service = new PostgresPendingActionStatusService(sql);

    await expect(service.checkReady()).resolves.toBeUndefined();

    const readinessQuery = calls.find((call) => call.text.startsWith("select exists"));
    const migrationBytes = await readFile(
      new URL(
        "../../../db/migrations/000006_community_research_core.up.sql",
        import.meta.url,
      ),
    );
    const checksum = createHash("sha256").update(migrationBytes).digest("hex");
    expect(readinessQuery?.values).toEqual([checksum]);
    expect(readinessQuery?.text).toContain("version = '000006'");
    expect(readinessQuery?.text).toContain("name = 'community_research_core'");
    expect(readinessQuery?.text).toContain("pending_actions_agent_owner");
    expect(readinessQuery?.text).toContain("pending_actions_prepare_update");
  });

  it.each([
    ["schema mismatch", () => [{ ready: false }]],
    [
      "database failure",
      () => {
        throw new Error("database unavailable");
      },
    ],
  ])("fails readiness closed for %s", async (_label, responder) => {
    const { sql } = createTestSql((text) =>
      text.startsWith("select exists") ? responder() : [],
    );

    await expect(
      new PostgresPendingActionStatusService(sql).checkReady(),
    ).rejects.toMatchObject({
      code: "ACTION_STATUS_UNAVAILABLE",
      retryable: true,
      statusCode: 503,
    });
  });
});
