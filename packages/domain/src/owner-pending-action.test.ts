import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it } from "vitest";

import {
  encryptPendingCommand,
  type PendingCommandKeyRing,
} from "./pending-command-codec.js";
import {
  OwnerPendingActionError,
  PostgresOwnerPendingActionService,
} from "./owner-pending-action.js";
import {
  digestResearchCommand,
  freezeUpdateContentBaseline,
  normalizeCreatePostCommand,
  normalizeDeleteContentCommand,
  normalizeUpdateContentCommand,
} from "./research-command.js";
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
  array(value: readonly unknown[]): readonly unknown[];
  begin<T>(callback: (transaction: TestSql) => Promise<T>): Promise<T>;
  json(value: unknown): unknown;
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
  query.array = (value) => value;
  query.json = (value) => value;
  query.begin = async <T>(callback: (transaction: TestSql) => Promise<T>): Promise<T> =>
    callback(query);
  return { calls, sql: query as unknown as PostgresClient };
}

const ownerId = "10000000-0000-4000-8000-000000000001";
const otherOwnerId = "10000000-0000-4000-8000-000000000002";
const agentId = "20000000-0000-4000-8000-000000000001";
const actorId = "20000000-0000-4000-8000-000000000002";
const credentialId = "30000000-0000-4000-8000-000000000001";
const actionId = "40000000-0000-4000-8000-000000000001";
const idempotencyId = "50000000-0000-4000-8000-000000000001";
const decisionId = "60000000-0000-4000-8000-000000000001";
const communityId = "70000000-0000-4000-8000-000000000001";
const contentId = "70000000-0000-4000-8000-000000000002";
const auditId = "80000000-0000-4000-8000-000000000001";
const outboxEventId = "90000000-0000-4000-8000-000000000001";
const requestedAt = new Date("2026-07-20T10:00:00.000Z");
const decidedAt = new Date("2026-07-20T10:05:00.000Z");
const databaseNow = new Date("2026-07-20T10:06:00.000Z");
const expiresAt = new Date("2026-07-21T10:00:00.000Z");
const terminalAt = new Date("2026-07-20T10:07:00.000Z");
const keyRing: PendingCommandKeyRing = {
  currentVersion: 1,
  keys: { 1: Buffer.alloc(32, 7) },
};
const cursorSigningKey = Buffer.alloc(32, 9);
const command = normalizeCreatePostCommand({
  title: "Confidential MU channel check",
  bodyMarkdown: "UGC_SECRET_MARKER: channel inventory improved.",
  primaryCommunityId: communityId,
  symbols: ["MU"],
  topics: ["semiconductors"],
  sourceLinks: [
    {
      url: "https://example.com/private-research",
      description: "UGC_SECRET_MARKER source notes",
    },
  ],
});
const inputDigest = digestResearchCommand(command);
const updateRevisionId = "70000000-0000-4000-8000-000000000003";
const updateCommand = freezeUpdateContentBaseline(
  normalizeUpdateContentCommand({
    contentId,
    expectedVersion: 7,
    patch: {
      bodyMarkdown: "UGC_UPDATE_SECRET_MARKER: revised inventory thesis.",
      sourceLinks: [],
      references: [],
      symbols: ["MU"],
      topics: ["semiconductors", "inventory"],
    },
    editSummary: "Add inventory evidence",
  }),
  {
    additionalCommunityIds: [],
    bodyMarkdown: "UGC_UPDATE_SECRET_MARKER: original inventory thesis.",
    contentKind: "post",
    primaryCommunityId: communityId,
    resourceVersion: 7,
    revisionId: updateRevisionId,
    title: "Original MU inventory thesis",
  },
);
const updateInputDigest = digestResearchCommand(updateCommand);
const deleteCommand = normalizeDeleteContentCommand({
  contentId,
  expectedVersion: 7,
  mode: "soft",
  reason: "UGC_DELETE_SECRET_MARKER: superseded by corrected evidence.",
});
const deleteInputDigest = digestResearchCommand(deleteCommand);

function service(sql: PostgresClient) {
  return new PostgresOwnerPendingActionService(sql, {
    clock: () => databaseNow,
    cursorSigningKey,
    idFactory: () => auditId,
    pendingActionKeyRing: keyRing,
  });
}

function summaryRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: actionId,
    version_text: "1",
    operation: "create_post",
    state: "pending_approval",
    target_type: "community",
    target_id: communityId,
    approval_summary: "Create one post in 1 Community.",
    requested_at: requestedAt,
    expires_at: expiresAt,
    updated_at: requestedAt,
    agent_id: agentId,
    agent_status: "active",
    agent_handle: "agent-alpha",
    agent_display_name: "Agent Alpha",
    ...overrides,
  };
}

function detailRow(overrides: Readonly<Record<string, unknown>> = {}) {
  const encrypted = encryptPendingCommand(
    command,
    {
      actionId,
      agentId,
      credentialId,
      inputDigest,
      operation: "create_post",
      ownerId,
    },
    keyRing,
  );
  return {
    ...summaryRow(),
    actor_id: actorId,
    owner_id: ownerId,
    credential_id: credentialId,
    idempotency_record_id: idempotencyId,
    idempotency_key: "owner-pending-action-test-key",
    normalized_input_ciphertext: encrypted.ciphertext,
    normalized_input_nonce: encrypted.nonce,
    normalized_input_key_version: encrypted.keyVersion,
    normalized_input_format_version: encrypted.formatVersion,
    input_digest_text: inputDigest,
    decision_id: decisionId,
    policy_snapshot: {
      decision: "require_approval",
      reason: "OWNER_APPROVAL_REQUIRED",
    },
    policy_version_text: "1",
    expected_version_text: null,
    decided_at: null,
    decided_by_owner_id: null,
    approval_method: null,
    decision_reason_code: null,
    executing_at: null,
    completed_at: null,
    terminal_at: null,
    attempt_count: 0,
    failure_count: 0,
    has_result: false,
    error: null,
    lease_shape_valid: true,
    owner_status: "active",
    owner_email_verified: true,
    database_now: databaseNow,
    ...overrides,
  };
}

function updateDetailRow(overrides: Readonly<Record<string, unknown>> = {}) {
  const encrypted = encryptPendingCommand(
    updateCommand,
    {
      actionId,
      agentId,
      credentialId,
      inputDigest: updateInputDigest,
      operation: "update_content",
      ownerId,
    },
    keyRing,
  );
  return detailRow({
    operation: "update_content",
    target_type: "content",
    target_id: contentId,
    approval_summary: "Update one published research post.",
    normalized_input_ciphertext: encrypted.ciphertext,
    normalized_input_nonce: encrypted.nonce,
    normalized_input_key_version: encrypted.keyVersion,
    normalized_input_format_version: encrypted.formatVersion,
    input_digest_text: updateInputDigest,
    expected_version_text: "7",
    ...overrides,
  });
}

function deleteDetailRow(overrides: Readonly<Record<string, unknown>> = {}) {
  const encrypted = encryptPendingCommand(
    deleteCommand,
    {
      actionId,
      agentId,
      credentialId,
      inputDigest: deleteInputDigest,
      operation: "delete_content",
      ownerId,
    },
    keyRing,
  );
  return detailRow({
    operation: "delete_content",
    target_type: "content",
    target_id: contentId,
    approval_summary: "Soft-delete one published research item.",
    normalized_input_ciphertext: encrypted.ciphertext,
    normalized_input_nonce: encrypted.nonce,
    normalized_input_key_version: encrypted.keyVersion,
    normalized_input_format_version: encrypted.formatVersion,
    input_digest_text: deleteInputDigest,
    expected_version_text: "7",
    ...overrides,
  });
}

const rejectedDatabaseError = {
  code: "ACTION_REJECTED",
  message: "The Owner rejected this action.",
  retryable: false,
  details: null,
  retry_after_ms: null,
} as const;

const failedDatabaseError = {
  code: "ACTION_EXECUTION_FAILED",
  message: "The approved action could not be completed.",
  retryable: false,
  details: null,
  retry_after_ms: null,
} as const;

const expiredDatabaseError = {
  code: "ACTION_EXPIRED",
  message: "The action expired before it could be completed.",
  retryable: false,
  details: null,
  retry_after_ms: null,
} as const;

function advancedRow(
  state: "approved" | "executing" | "failed" | "expired" | "rejected",
) {
  const common = {
    state,
    version_text: "5",
    updated_at: terminalAt,
    decided_at: decidedAt,
    decided_by_owner_id: ownerId,
    approval_method: "owner_approval",
    decision_reason_code: state === "rejected" ? "needs_revision" : "owner_approved",
  };
  switch (state) {
    case "approved":
      return detailRow(common);
    case "executing":
      return detailRow({
        ...common,
        executing_at: databaseNow,
        attempt_count: 1,
      });
    case "failed":
      return detailRow({
        ...common,
        executing_at: databaseNow,
        completed_at: terminalAt,
        terminal_at: terminalAt,
        attempt_count: 1,
        error: failedDatabaseError,
      });
    case "expired":
      return detailRow({
        ...common,
        terminal_at: terminalAt,
        error: expiredDatabaseError,
      });
    case "rejected":
      return detailRow({
        ...common,
        terminal_at: terminalAt,
        error: rejectedDatabaseError,
      });
  }
}

function expectOwnerError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(OwnerPendingActionError);
  expect((error as OwnerPendingActionError).code).toBe(code);
}

function decisionHarness(
  lockedRow: ReturnType<typeof detailRow>,
  decision: "approve" | "reject",
) {
  const update =
    decision === "approve"
      ? {
          version_text: "2",
          state: "approved",
          decided_at: databaseNow,
          terminal_at: null,
          updated_at: databaseNow,
          decision_reason_code: "owner_approved",
          error: null,
        }
      : {
          version_text: "2",
          state: "rejected",
          decided_at: databaseNow,
          terminal_at: databaseNow,
          updated_at: databaseNow,
          decision_reason_code: "needs_revision",
          error: rejectedDatabaseError,
        };
  return createTestSql((text) => {
    if (text.startsWith("set local")) return [];
    if (text.includes("for update of action, owner")) return [lockedRow];
    if (text.includes("pg_catalog.pg_advisory_xact_lock")) return [];
    if (text.includes("as next_sequence")) return [{ next_sequence: "2" }];
    if (text.includes("insert into system.outbox_events")) {
      return [{ id: outboxEventId, aggregate_sequence: "2" }];
    }
    if (text.includes("insert into platform.action_logs")) return [];
    if (text.includes("update platform.pending_actions as action")) return [update];
    if (text.includes("update platform.idempotency_records as idempotency")) {
      return [{ id: idempotencyId }];
    }
    return [];
  });
}

describe("PostgresOwnerPendingActionService readiness and list", () => {
  it("pins the exact 000007 bytes plus decision constraints, triggers, and indexes", async () => {
    const migration = await readFile(
      new URL(
        "../../../db/migrations/000007_pending_action_execution.up.sql",
        import.meta.url,
      ),
    );
    expect(createHash("sha256").update(migration).digest("hex")).toBe(
      PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM,
    );
    const harness = createTestSql((text) =>
      text.includes("as ready") ? [{ ready: true }] : [],
    );
    await service(harness.sql).checkReady();
    const readiness = harness.calls.find((call) => call.text.includes("as ready"));
    expect(readiness?.values).toContain(PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM);
    expect(readiness?.text).toContain("pending_actions_validate_decision_audit");
    expect(readiness?.text).toContain("pending_actions_approved_due_idx");
    expect(readiness?.text).toContain("pending_actions_public_error");
  });

  it("lists update_content as a content-targeted Owner action", async () => {
    const row = summaryRow({
      operation: "update_content",
      target_type: "content",
      target_id: contentId,
      approval_summary: "Update one published research post.",
    });
    const harness = createTestSql((text) =>
      text.includes("order by action.requested_at desc") ? [row] : [],
    );

    const page = await service(harness.sql).listActions(ownerId, {
      operations: ["update_content"],
    });

    expect(page.items).toEqual([
      expect.objectContaining({
        operation: "update_content",
        target: { id: contentId, type: "content" },
      }),
    ]);
  });

  it("lists delete_content as a content-targeted Owner action", async () => {
    const row = summaryRow({
      operation: "delete_content",
      target_type: "content",
      target_id: contentId,
      approval_summary: "Soft-delete one published research item.",
    });
    const harness = createTestSql((text) =>
      text.includes("order by action.requested_at desc") ? [row] : [],
    );

    const page = await service(harness.sql).listActions(ownerId, {
      operations: ["delete_content"],
    });

    expect(page.items).toEqual([
      expect.objectContaining({
        operation: "delete_content",
        target: { id: contentId, type: "content" },
      }),
    ]);
  });

  it("defaults to pending approval/20, keyset-orders newest first, and never selects detail secrets", async () => {
    const rows = [
      summaryRow({
        id: "40000000-0000-4000-8000-000000000003",
        requested_at: new Date("2026-07-20T10:03:00.000Z"),
        updated_at: new Date("2026-07-20T10:03:00.000Z"),
      }),
      summaryRow({
        id: "40000000-0000-4000-8000-000000000002",
        requested_at: new Date("2026-07-20T10:02:00.000Z"),
        updated_at: new Date("2026-07-20T10:02:00.000Z"),
      }),
    ];
    const harness = createTestSql((text) =>
      text.includes("order by action.requested_at desc") ? rows : [],
    );
    const page = await service(harness.sql).listActions(ownerId, {});
    expect(page.limit).toBe(20);
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    const list = harness.calls.find((call) =>
      call.text.includes("order by action.requested_at desc"),
    );
    expect(list?.values).toContainEqual(["pending_approval"]);
    expect(list?.values).toContain(21);
    for (const forbidden of [
      "normalized_input_ciphertext",
      "normalized_input_nonce",
      "normalized_input_key_version",
      "idempotency_key",
      "policy_snapshot",
      "lease_owner",
    ]) {
      expect(list?.text).not.toContain(forbidden);
    }
  });

  it("binds opaque cursors to the Owner and the complete normalized filters", async () => {
    const firstRows = [
      summaryRow({
        id: "40000000-0000-4000-8000-000000000003",
        requested_at: new Date("2026-07-20T10:03:00.000Z"),
        updated_at: new Date("2026-07-20T10:03:00.000Z"),
      }),
      summaryRow({
        id: "40000000-0000-4000-8000-000000000002",
        requested_at: new Date("2026-07-20T10:02:00.000Z"),
        updated_at: new Date("2026-07-20T10:02:00.000Z"),
      }),
    ];
    const harness = createTestSql((text) =>
      text.includes("order by action.requested_at desc") ? firstRows : [],
    );
    const ownerService = service(harness.sql);
    const first = await ownerService.listActions(ownerId, {
      limit: 1,
      operations: ["create_post"],
      states: ["pending_approval"],
    });
    expect(first.nextCursor).toBeTruthy();

    await expect(
      ownerService.listActions(otherOwnerId, {
        cursor: first.nextCursor,
        limit: 1,
        operations: ["create_post"],
        states: ["pending_approval"],
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectOwnerError(error, "OWNER_ACTION_CURSOR_INVALID");
      return true;
    });
    await expect(
      ownerService.listActions(ownerId, {
        cursor: first.nextCursor,
        limit: 2,
        operations: ["create_post"],
        states: ["pending_approval"],
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectOwnerError(error, "OWNER_ACTION_CURSOR_INVALID");
      return true;
    });
    const cursor = first.nextCursor!;
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    await expect(
      ownerService.listActions(ownerId, {
        cursor: tampered,
        limit: 1,
        operations: ["create_post"],
        states: ["pending_approval"],
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectOwnerError(error, "OWNER_ACTION_CURSOR_INVALID");
      return true;
    });
  });
});

describe("PostgresOwnerPendingActionService detail boundary", () => {
  it("uses the exact Owner predicate, stages sensitive_read before decrypt, and audits IDs only", async () => {
    const row = detailRow();
    const harness = createTestSql((text) => {
      if (text.startsWith("set local")) return [];
      if (text.includes("for share of action")) return [row];
      if (text.includes("insert into platform.action_logs")) return [];
      return [];
    });
    const view = await service(harness.sql).getAction(ownerId, actionId, {
      requestId: "request-detail-1",
    });
    expect(view.command).toEqual(command);
    expect(view.approvalReasonCategory).toBe("owner_approval_required");
    expect(view.idempotencyKeyHint).toMatch(/^hmac-sha256:[0-9a-f]{12}$/u);
    expect(view.idempotencyKeyHint).not.toContain("owner-pending-action-test-key");
    const detailIndex = harness.calls.findIndex((call) =>
      call.text.includes("for share of action"),
    );
    const auditIndex = harness.calls.findIndex((call) =>
      call.text.includes("'sensitive_read'"),
    );
    expect(detailIndex).toBeGreaterThanOrEqual(0);
    expect(auditIndex).toBeGreaterThan(detailIndex);
    const detail = harness.calls[detailIndex]!;
    expect(detail.text).toMatch(
      /where action\.id = \$value and action\.owner_id = \$value/u,
    );
    expect(detail.values).toEqual([actionId, ownerId]);
    const audit = harness.calls[auditIndex]!;
    expect(audit.text).not.toMatch(/cipher|nonce|idempotency|policy_snapshot|lease/iu);
    expect(JSON.stringify(audit.values)).not.toContain("UGC_SECRET_MARKER");
    expect(audit.text).toContain("'owner_detail_view'");
  });

  it("decrypts an update preview and binds its target and expected version column", async () => {
    const row = updateDetailRow();
    const harness = createTestSql((text) => {
      if (text.startsWith("set local")) return [];
      if (text.includes("for share of action")) return [row];
      if (text.includes("insert into platform.action_logs")) return [];
      return [];
    });

    const view = await service(harness.sql).getAction(ownerId, actionId, {
      requestId: "request-update-detail",
    });

    expect(view).toMatchObject({
      command: updateCommand,
      expectedVersion: 7,
      operation: "update_content",
      target: { id: contentId, type: "content" },
    });
    const detail = harness.calls.find((call) =>
      call.text.includes("for share of action"),
    );
    expect(detail?.text).toContain(
      "action.expected_version::text as expected_version_text",
    );
    expect(JSON.stringify(harness.calls)).not.toContain("UGC_UPDATE_SECRET_MARKER");
  });

  it("decrypts a delete preview while keeping its UGC reason out of audit values", async () => {
    const row = deleteDetailRow();
    const harness = createTestSql((text) => {
      if (text.startsWith("set local")) return [];
      if (text.includes("for share of action")) return [row];
      if (text.includes("insert into platform.action_logs")) return [];
      return [];
    });

    const view = await service(harness.sql).getAction(ownerId, actionId, {
      requestId: "request-delete-detail",
    });

    expect(view).toMatchObject({
      command: deleteCommand,
      expectedVersion: 7,
      operation: "delete_content",
      target: { id: contentId, type: "content" },
    });
    const audit = harness.calls.find((call) => call.text.includes("'owner_detail_view'"));
    expect(JSON.stringify(audit?.values)).not.toContain("UGC_DELETE_SECRET_MARKER");
  });

  it("fails closed when an update target or expected version contradicts ciphertext", async () => {
    for (const row of [
      updateDetailRow({ expected_version_text: "8" }),
      updateDetailRow({ expected_version_text: null }),
      updateDetailRow({ target_id: communityId }),
      detailRow({ expected_version_text: "unsafe" }),
    ]) {
      const harness = createTestSql((text) => {
        if (text.startsWith("set local")) return [];
        if (text.includes("for share of action")) return [row];
        if (text.includes("insert into platform.action_logs")) return [];
        return [];
      });
      await expect(
        service(harness.sql).getAction(ownerId, actionId, {
          requestId: "request-update-mismatch",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectOwnerError(error, "OWNER_ACTION_UNAVAILABLE");
        return true;
      });
    }
  });

  it("fails closed when a delete target or expected version contradicts ciphertext", async () => {
    for (const row of [
      deleteDetailRow({ expected_version_text: "8" }),
      deleteDetailRow({ expected_version_text: null }),
      deleteDetailRow({ target_id: communityId }),
    ]) {
      const harness = createTestSql((text) => {
        if (text.startsWith("set local")) return [];
        if (text.includes("for share of action")) return [row];
        if (text.includes("insert into platform.action_logs")) return [];
        return [];
      });
      await expect(
        service(harness.sql).getAction(ownerId, actionId, {
          requestId: "request-delete-mismatch",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectOwnerError(error, "OWNER_ACTION_UNAVAILABLE");
        return true;
      });
    }
  });

  it("fails closed when the approval reason or idempotency hint source is corrupt", async () => {
    for (const row of [
      detailRow({ policy_snapshot: { decision: "allow", reason: "ALLOWED_BY_POLICY" } }),
      detailRow({ idempotency_key: "" }),
      detailRow({ idempotency_key: "unsafe\nkey" }),
    ]) {
      const harness = createTestSql((text) => {
        if (text.startsWith("set local")) return [];
        if (text.includes("for share of action")) return [row];
        if (text.includes("insert into platform.action_logs")) return [];
        return [];
      });
      await expect(
        service(harness.sql).getAction(ownerId, actionId, {
          requestId: "request-corrupt-owner-reason",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectOwnerError(error, "OWNER_ACTION_UNAVAILABLE");
        return true;
      });
    }
  });

  it("returns ownership-safe 404 before audit or decryption", async () => {
    const harness = createTestSql((text) => {
      if (text.startsWith("set local")) return [];
      return [];
    });
    await expect(
      service(harness.sql).getAction(ownerId, actionId, {
        requestId: "request-detail-404",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectOwnerError(error, "ACTION_NOT_FOUND");
      return true;
    });
    expect(harness.calls.some((call) => call.text.includes("sensitive_read"))).toBe(
      false,
    );
  });

  it("fails closed on authenticated-encryption/AAD corruption without exposing it", async () => {
    const row = detailRow();
    const tampered = Buffer.from(row.normalized_input_ciphertext);
    tampered[0] = tampered[0]! ^ 1;
    row.normalized_input_ciphertext = tampered;
    const harness = createTestSql((text) => {
      if (text.startsWith("set local")) return [];
      if (text.includes("for share of action")) return [row];
      return [];
    });
    await expect(
      service(harness.sql).getAction(ownerId, actionId, {
        requestId: "request-detail-tamper",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectOwnerError(error, "OWNER_ACTION_UNAVAILABLE");
      expect((error as Error).message).not.toContain("UGC_SECRET_MARKER");
      return true;
    });
  });
});

describe("PostgresOwnerPendingActionService decisions", () => {
  it("approves with CAS, approval audit, outbox, and current safe replay lifecycle", async () => {
    const harness = decisionHarness(detailRow(), "approve");
    const view = await service(harness.sql).approveAction(ownerId, actionId, {
      expectedVersion: 1,
      reasonCode: "owner_approved",
      requestId: "request-approve-1",
    });
    expect(view.state).toBe("approved");
    expect(view.version).toBe(2);
    expect(view.approvalOutcome).toBe("approved");
    expect(view.command).toEqual(command);

    const locked = harness.calls.find((call) =>
      call.text.includes("for update of action, owner"),
    );
    expect(locked?.text).toMatch(/action\.owner_id = \$value/u);
    const actionUpdate = harness.calls.find((call) =>
      call.text.includes("update platform.pending_actions as action"),
    );
    expect(actionUpdate?.text).toContain("action.version = $value");
    expect(actionUpdate?.text).toContain("action.expires_at > clock_timestamp()");
    expect(actionUpdate?.values).toContain(auditId);

    const audit = harness.calls.find((call) =>
      call.text.includes("'approval_transition'"),
    );
    expect(audit?.values).toContain("owner_approved");
    expect(audit?.values).toContain(outboxEventId);
    expect(JSON.stringify(audit?.values)).not.toContain("UGC_SECRET_MARKER");
    expect(harness.calls.some((call) => call.text.includes("sensitive_read"))).toBe(
      false,
    );

    const outbox = harness.calls.find((call) =>
      call.text.includes("insert into system.outbox_events"),
    );
    expect(outbox?.values).toContain("action.approved");
    expect(outbox?.values).toContainEqual(expect.objectContaining({ actor_id: actorId }));
    expect(JSON.stringify(outbox?.values)).not.toContain("UGC_SECRET_MARKER");
    const idempotency = harness.calls.find((call) =>
      call.text.includes("update platform.idempotency_records as idempotency"),
    );
    const envelope = idempotency?.values.find(
      (value) => typeof value === "object" && value !== null && "pending_action" in value,
    ) as { pending_action: { state: string }; status: string } | undefined;
    expect(envelope).toMatchObject({
      status: "pending_approval",
      pending_action: { state: "approved" },
    });
    expect(JSON.stringify(envelope)).not.toContain("UGC_SECRET_MARKER");
    // 000006 compatibility: non-terminal approval must preserve a legacy
    // resource_id=PendingAction ID because the 000007 trigger only allows it to
    // be cleared during a terminal transition.
    expect(idempotency?.text).not.toContain("resource_id = null");
  });

  it("preserves update expected_version in an approved idempotency replay", async () => {
    const harness = decisionHarness(updateDetailRow(), "approve");

    const view = await service(harness.sql).approveAction(ownerId, actionId, {
      expectedVersion: 1,
      reasonCode: "owner_approved",
      requestId: "request-approve-update",
    });

    expect(view).toMatchObject({
      expectedVersion: 7,
      operation: "update_content",
      state: "approved",
    });
    const idempotency = harness.calls.find((call) =>
      call.text.includes("update platform.idempotency_records as idempotency"),
    );
    const envelope = idempotency?.values.find(
      (value) => typeof value === "object" && value !== null && "pending_action" in value,
    ) as
      | {
          pending_action: {
            expected_version?: number;
            operation: string;
          };
        }
      | undefined;
    expect(envelope?.pending_action).toMatchObject({
      expected_version: 7,
      operation: "update_content",
    });
    expect(JSON.stringify(envelope)).not.toContain("UGC_UPDATE_SECRET_MARKER");
  });

  it("preserves delete expected_version in replay without logging its UGC reason", async () => {
    const harness = decisionHarness(deleteDetailRow(), "approve");

    const view = await service(harness.sql).approveAction(ownerId, actionId, {
      expectedVersion: 1,
      reasonCode: "owner_approved",
      requestId: "request-approve-delete",
    });

    expect(view).toMatchObject({
      command: deleteCommand,
      expectedVersion: 7,
      operation: "delete_content",
      state: "approved",
    });
    const idempotency = harness.calls.find((call) =>
      call.text.includes("update platform.idempotency_records as idempotency"),
    );
    const envelope = idempotency?.values.find(
      (value) => typeof value === "object" && value !== null && "pending_action" in value,
    ) as
      | {
          pending_action: {
            expected_version?: number;
            operation: string;
          };
        }
      | undefined;
    expect(envelope?.pending_action).toMatchObject({
      expected_version: 7,
      operation: "delete_content",
    });
    expect(JSON.stringify(harness.calls)).not.toContain("UGC_DELETE_SECRET_MARKER");
  });

  it("rejects atomically with exact DB/public errors, terminal retention, and camel replay error", async () => {
    const harness = decisionHarness(detailRow(), "reject");
    const view = await service(harness.sql).rejectAction(ownerId, actionId, {
      expectedVersion: 1,
      reasonCode: "needs_revision",
      requestId: "request-reject-1",
    });
    expect(view).toMatchObject({
      state: "rejected",
      version: 2,
      decisionReasonCode: "needs_revision",
      approvalOutcome: "rejected",
      publicError: {
        code: "ACTION_REJECTED",
        retryAfterMs: null,
      },
    });
    const actionUpdate = harness.calls.find((call) =>
      call.text.includes("update platform.pending_actions as action"),
    );
    expect(actionUpdate?.values).toContainEqual(rejectedDatabaseError);
    const idempotency = harness.calls.find((call) =>
      call.text.includes("update platform.idempotency_records as idempotency"),
    );
    expect(idempotency?.text).toContain("response_code = 409");
    expect(idempotency?.text).toContain("resource_id = null");
    expect(idempotency?.text).toContain("interval '7 days'");
    const envelope = idempotency?.values.find(
      (value) => typeof value === "object" && value !== null && "pending_action" in value,
    ) as { error: Record<string, unknown>; status: string } | undefined;
    expect(envelope?.status).toBe("denied");
    expect(envelope?.error).toEqual({
      code: "ACTION_REJECTED",
      message: "The Owner rejected this action.",
      retryable: false,
      details: null,
      retryAfterMs: null,
    });
    expect(envelope?.error).not.toHaveProperty("retry_after_ms");
    const resolved = harness.calls.find((call) =>
      call.text.includes("insert into system.outbox_events"),
    );
    expect(resolved?.values).toContain("action.resolved");
    expect(resolved?.values).not.toContain("action.rejected");
    expect(resolved?.values).toContainEqual({
      action_id: actionId,
      actor_id: actorId,
      agent_id: agentId,
      decision_reason_code: "needs_revision",
      error_code: "ACTION_REJECTED",
      operation: "create_post",
      owner_id: ownerId,
      reason_code: "needs_revision",
      state: "rejected",
    });
  });

  it.each(["executing", "failed", "expired"] as const)(
    "replays an already approved %s lineage despite a stale expected version",
    async (state) => {
      const harness = createTestSql((text) => {
        if (text.startsWith("set local")) return [];
        if (text.includes("for update of action, owner")) return [advancedRow(state)];
        return [];
      });
      const view = await service(harness.sql).approveAction(ownerId, actionId, {
        expectedVersion: 1,
        reasonCode: "owner_approved",
        requestId: `request-replay-${state}`,
      });
      expect(view.state).toBe(state);
      expect(view.version).toBe(5);
      expect(
        harness.calls.some(
          (call) =>
            call.text.includes("update platform.pending_actions") ||
            call.text.includes("insert into system.outbox_events") ||
            call.text.includes("insert into platform.action_logs"),
        ),
      ).toBe(false);
    },
  );

  it("replays only the identical rejection reason", async () => {
    const harness = createTestSql((text) => {
      if (text.startsWith("set local")) return [];
      if (text.includes("for update of action, owner")) {
        return [advancedRow("rejected")];
      }
      return [];
    });
    const view = await service(harness.sql).rejectAction(ownerId, actionId, {
      expectedVersion: 1,
      reasonCode: "needs_revision",
      requestId: "request-reject-replay",
    });
    expect(view.state).toBe("rejected");
    await expect(
      service(harness.sql).rejectAction(ownerId, actionId, {
        expectedVersion: 5,
        reasonCode: "risk_not_accepted",
        requestId: "request-reject-opposite-reason",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectOwnerError(error, "ACTION_DECISION_CONFLICT");
      return true;
    });
  });

  it("rejects an opposite decision and never writes", async () => {
    const harness = createTestSql((text) => {
      if (text.startsWith("set local")) return [];
      if (text.includes("for update of action, owner")) {
        return [advancedRow("rejected")];
      }
      return [];
    });
    await expect(
      service(harness.sql).approveAction(ownerId, actionId, {
        expectedVersion: 5,
        reasonCode: "owner_approved",
        requestId: "request-opposite",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectOwnerError(error, "ACTION_DECISION_CONFLICT");
      return true;
    });
    expect(
      harness.calls.some((call) =>
        call.text.includes("insert into system.outbox_events"),
      ),
    ).toBe(false);
  });

  it("reports pending version races as a version conflict", async () => {
    const harness = createTestSql((text) => {
      if (text.startsWith("set local")) return [];
      if (text.includes("for update of action, owner")) {
        return [detailRow({ version_text: "2" })];
      }
      return [];
    });
    await expect(
      service(harness.sql).approveAction(ownerId, actionId, {
        expectedVersion: 1,
        reasonCode: "owner_approved",
        requestId: "request-version-race",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectOwnerError(error, "ACTION_VERSION_CONFLICT");
      expect((error as OwnerPendingActionError).currentVersion).toBe(2);
      return true;
    });
  });

  it("returns the same ownership-safe 404 from the decision lock", async () => {
    const harness = createTestSql((text) => {
      if (text.startsWith("set local")) return [];
      return [];
    });
    await expect(
      service(harness.sql).approveAction(ownerId, actionId, {
        expectedVersion: 1,
        reasonCode: "owner_approved",
        requestId: "request-decision-404",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectOwnerError(error, "ACTION_NOT_FOUND");
      return true;
    });
    const lock = harness.calls.find((call) =>
      call.text.includes("for update of action, owner"),
    );
    expect(lock?.text).toMatch(/action\.owner_id = \$value/u);
    expect(
      harness.calls.some((call) =>
        call.text.includes("insert into platform.action_logs"),
      ),
    ).toBe(false);
  });

  it("uses authoritative active and verified Owner state before accepting a decision", async () => {
    const harness = createTestSql((text) => {
      if (text.startsWith("set local")) return [];
      if (text.includes("for update of action, owner")) {
        return [detailRow({ owner_status: "suspended" })];
      }
      return [];
    });
    await expect(
      service(harness.sql).rejectAction(ownerId, actionId, {
        expectedVersion: 1,
        reasonCode: "owner_rejected",
        requestId: "request-owner-inactive",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectOwnerError(error, "ACTION_DECISION_CONFLICT");
      return true;
    });
    expect(
      harness.calls.some((call) =>
        call.text.includes("insert into system.outbox_events"),
      ),
    ).toBe(false);
  });

  it("leaves an expired pending row for the queue without audit/outbox/half-terminal writes", async () => {
    const harness = createTestSql((text) => {
      if (text.startsWith("set local")) return [];
      if (text.includes("for update of action, owner")) {
        return [detailRow({ expires_at: databaseNow })];
      }
      return [];
    });
    await expect(
      service(harness.sql).rejectAction(ownerId, actionId, {
        expectedVersion: 1,
        reasonCode: "no_longer_needed",
        requestId: "request-expired",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectOwnerError(error, "ACTION_DECISION_CONFLICT");
      return true;
    });
    expect(
      harness.calls.some(
        (call) =>
          call.text.includes("insert into system.outbox_events") ||
          call.text.includes("insert into platform.action_logs") ||
          call.text.includes("update platform.pending_actions"),
      ),
    ).toBe(false);
  });

  it("fails closed when the locked ciphertext is corrupt before writing a decision", async () => {
    const row = detailRow();
    row.normalized_input_nonce = Buffer.alloc(12, 0);
    const harness = createTestSql((text) => {
      if (text.startsWith("set local")) return [];
      if (text.includes("for update of action, owner")) return [row];
      return [];
    });
    await expect(
      service(harness.sql).approveAction(ownerId, actionId, {
        expectedVersion: 1,
        reasonCode: "owner_approved",
        requestId: "request-corrupt",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectOwnerError(error, "OWNER_ACTION_UNAVAILABLE");
      return true;
    });
    expect(
      harness.calls.some((call) =>
        call.text.includes("insert into platform.action_logs"),
      ),
    ).toBe(false);
  });
});
