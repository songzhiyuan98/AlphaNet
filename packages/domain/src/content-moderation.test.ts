import { createHash } from "node:crypto";

import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it, vi } from "vitest";

import {
  type AdminModerationContext,
  type ContentModerationError,
  type DecideModerationCaseInput,
  PostgresContentModerationService,
} from "./content-moderation.js";

const now = new Date("2026-07-21T12:00:00.000Z");
const ids = {
  action: "10000000-0000-4000-8000-000000000001",
  actionLog: "10000000-0000-4000-8000-000000000002",
  admin: "20000000-0000-4000-8000-000000000001",
  agent: "30000000-0000-4000-8000-000000000001",
  actor: "30000000-0000-4000-8000-000000000002",
  case: "40000000-0000-4000-8000-000000000001",
  content: "50000000-0000-4000-8000-000000000001",
  outbox: "60000000-0000-4000-8000-000000000001",
  owner: "70000000-0000-4000-8000-000000000001",
  priorAction: "80000000-0000-4000-8000-000000000001",
  report: "90000000-0000-4000-8000-000000000001",
  revision: "a0000000-0000-4000-8000-000000000001",
  root: "b0000000-0000-4000-8000-000000000001",
  snapshot: "c0000000-0000-4000-8000-000000000001",
} as const;

const adminContext: AdminModerationContext = {
  adminId: ids.admin,
  authenticationAssurance: "workforce_oidc",
  mfa: { amrMfa: true, matchedAcr: null, method: "amr_mfa" },
  permission: "moderation:decide",
  permissions: ["moderation:decide", "moderation:read"],
  requestId: "req-moderation-01",
  roles: ["content_moderator"],
};

const decision: DecideModerationCaseInput = {
  action: "hide_content",
  expectedCaseVersion: 2,
  idempotencyKey: "moderation-decision-01",
  internalNote: "Private workforce note marker 51f8",
  reasonCode: "confirmed_report_violation",
};

interface CapturedQuery {
  text: string;
  values: unknown[];
}

function fakePostgres(
  resolve: (query: CapturedQuery) => unknown[] | Promise<unknown[]>,
): { begin: ReturnType<typeof vi.fn>; calls: CapturedQuery[]; sql: PostgresClient } {
  const calls: CapturedQuery[] = [];
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join("?"), values };
    calls.push(query);
    return resolve(query);
  };
  Object.assign(tag, {
    begin: vi.fn(
      async <T>(
        optionsOrCallback: string | ((transaction: typeof tag) => Promise<T>),
        possibleCallback?: (transaction: typeof tag) => Promise<T>,
      ): Promise<T> => {
        const callback =
          typeof optionsOrCallback === "string" ? possibleCallback : optionsOrCallback;
        if (!callback) throw new Error("Fake transaction callback is required.");
        return callback(tag);
      },
    ),
    json: (value: unknown) => value,
  });
  return {
    begin: (tag as unknown as { begin: ReturnType<typeof vi.fn> }).begin,
    calls,
    sql: tag as unknown as PostgresClient,
  };
}

function service(
  sql: PostgresClient,
  generatedIds: string[] = [ids.action, ids.actionLog, ids.snapshot],
): PostgresContentModerationService {
  let offset = 0;
  return new PostgresContentModerationService(sql, {
    clock: () => now,
    cursorSigningKey: Buffer.alloc(32, 7),
    idFactory: () => generatedIds[offset++] ?? ids.snapshot,
  });
}

function rbacRows(
  permission: "moderation:read" | "moderation:decide" = "moderation:decide",
) {
  return [
    {
      admin_id: ids.admin,
      permission,
      role_key: "content_moderator",
    },
    ...(permission === "moderation:decide"
      ? [
          {
            admin_id: ids.admin,
            permission: "moderation:read",
            role_key: "content_moderator",
          },
        ]
      : []),
  ];
}

function summaryRow(overrides: Record<string, unknown> = {}) {
  return {
    actor_id: ids.actor,
    actor_kind: "agent",
    agent_id: ids.agent,
    case_id: ids.case,
    case_version: "3",
    closed_at: now,
    content_id: ids.content,
    content_kind: "post",
    content_version: "8",
    distribution_state: "hidden",
    handle: "alpha-agent",
    harassment_count: "0",
    impersonation_count: "0",
    last_reported_at: new Date("2026-07-21T11:00:00.000Z"),
    latest_action: "hide_content",
    latest_action_id: ids.action,
    lifecycle_state: "published",
    malicious_link_count: "0",
    opened_at: new Date("2026-07-21T10:00:00.000Z"),
    other_rule_violation_count: "0",
    priority: "normal",
    privacy_exposure_count: "0",
    report_count: "1",
    spam_count: "1",
    status: "resolved_action",
    updated_at: now,
    ...overrides,
  };
}

function actionRow(overrides: Record<string, unknown> = {}) {
  return {
    action: "hide_content",
    admin_id: ids.admin,
    after_distribution_state: "hidden",
    before_distribution_state: "normal",
    case_closed_at_after: now,
    case_id: ids.case,
    case_updated_at_after: now,
    case_version_after: "3",
    case_version_before: "2",
    content_id: ids.content,
    id: ids.action,
    internal_note: decision.internalNote ?? null,
    occurred_at: now,
    reason_code: decision.reasonCode,
    response_content_distribution_state: "hidden",
    response_content_lifecycle_state: "published",
    response_content_version: "8",
    reverts_action_id: null,
    target_version_after: "8",
    target_version_before: "7",
    ...overrides,
  };
}

function decisionDigest(input: DecideModerationCaseInput): Buffer {
  return createHash("sha256")
    .update(
      JSON.stringify({
        action: input.action,
        case_id: ids.case,
        expected_case_version: input.expectedCaseVersion,
        internal_note: input.internalNote ?? null,
        reason_code: input.reasonCode,
        schema: "admin-content-moderation-decision-v1",
      }),
      "utf8",
    )
    .digest();
}

describe("PostgresContentModerationService request boundary", () => {
  it("rejects unsafe Admin evidence before opening a transaction", async () => {
    const { begin, sql } = fakePostgres(() => []);
    const moderation = service(sql);
    const withToken = {
      ...adminContext,
      token: "must-never-enter-domain",
    } as unknown as AdminModerationContext;
    await expect(
      moderation.decideCase(withToken, ids.case, decision),
    ).rejects.toMatchObject({
      code: "ADMIN_AUTHENTICATION_REQUIRED",
      statusCode: 401,
    } satisfies Partial<ContentModerationError>);
    expect(begin).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...decision, expectedCaseVersion: 0 }, "VALIDATION_ERROR"],
    [
      {
        ...decision,
        action: "dismiss",
        reasonCode: "confirmed_report_violation",
      },
      "DECISION_NOT_ALLOWED",
    ],
    [{ ...decision, idempotencyKey: "duplicate,key" }, "VALIDATION_ERROR"],
    [{ ...decision, internalNote: "private\0note" }, "VALIDATION_ERROR"],
  ] as const)("rejects malformed decisions before SQL: %j", async (input, code) => {
    const { begin, sql } = fakePostgres(() => []);
    await expect(
      service(sql).decideCase(adminContext, ids.case, input),
    ).rejects.toMatchObject({ code });
    expect(begin).not.toHaveBeenCalled();
  });

  it("requires at least 256 bits of cursor HMAC key material", () => {
    const { sql } = fakePostgres(() => []);
    expect(
      () =>
        new PostgresContentModerationService(sql, {
          cursorSigningKey: Buffer.alloc(31),
        }),
    ).toThrow("at least 32 bytes");
  });
});

describe("PostgresContentModerationService decisions", () => {
  it("atomically hides Content, resolves all Reports, and writes exact redacted provenance", async () => {
    const { calls, sql } = fakePostgres((query) => {
      if (query.text.includes("from platform.admins as admin")) return rbacRows();
      if (
        query.text.includes("from platform.moderation_actions as action") &&
        query.text.includes("idempotency_key")
      ) {
        return [];
      }
      if (query.text.includes("from platform.moderation_cases as case_target")) {
        return [
          {
            target_content_id: ids.content,
            target_type: "content",
          },
        ];
      }
      if (
        query.text.includes("from platform.moderation_cases as moderation_case") &&
        query.text.includes("for update")
      ) {
        return [
          {
            assigned_admin_id: null,
            case_id: ids.case,
            status: "open",
            target_content_id: ids.content,
            target_type: "content",
            version: "2",
          },
        ];
      }
      if (
        query.text.includes("from platform.content_items as content") &&
        query.text.includes("for update")
      ) {
        return [
          {
            current_revision_id: ids.revision,
            distribution_state: "normal",
            kind: "post",
            lifecycle_state: "published",
            root_id: ids.root,
            version: "7",
          },
        ];
      }
      if (query.text.includes("update platform.content_items as content")) {
        return [
          {
            current_revision_id: ids.revision,
            distribution_state: "hidden",
            kind: "post",
            lifecycle_state: "published",
            root_id: ids.root,
            version: "8",
          },
        ];
      }
      if (
        query.text.includes("with changed as") &&
        query.text.includes("update platform.reports")
      ) {
        return [{ count: "1" }];
      }
      if (query.text.includes("update platform.moderation_cases as moderation_case")) {
        return [{ closed_at: now, updated_at: now, version: "3" }];
      }
      if (query.text.includes("as next_sequence")) return [{ next_sequence: "1" }];
      if (query.text.includes("insert into system.outbox_events")) {
        return [{ aggregate_sequence: "1", id: ids.outbox }];
      }
      if (query.text.includes("insert into platform.moderation_actions")) {
        return [actionRow()];
      }
      if (query.text.includes("join lateral") && query.text.includes("report_totals")) {
        return [summaryRow()];
      }
      return [];
    });

    const result = await service(sql).decideCase(adminContext, ids.case, decision);
    expect(result).toMatchObject({
      action: {
        action: "hide_content",
        actionVersion: 1,
        contentLifecycleState: "published",
        contentVersionAfter: 8,
        contentVersionBefore: 7,
        distributionAfter: "hidden",
        distributionBefore: "normal",
      },
      case: { status: "resolved_action", version: 3 },
      caseVersionBefore: 2,
      content: { distributionState: "hidden", resourceVersion: 8 },
      replayed: false,
    });

    const reportUpdate = calls.find((query) =>
      query.text.includes("update platform.reports"),
    );
    const caseUpdate = calls.find((query) =>
      query.text.includes("update platform.moderation_cases as moderation_case"),
    );
    const outbox = calls.find((query) =>
      query.text.includes("insert into system.outbox_events"),
    );
    const audit = calls.find((query) =>
      query.text.includes("insert into platform.action_logs"),
    );
    const action = calls.find((query) =>
      query.text.includes("insert into platform.moderation_actions"),
    );
    expect(reportUpdate?.text).toContain("report.version + 1");
    expect(caseUpdate?.text).toContain("assigned_admin_id");
    expect(outbox?.values).toContainEqual({
      after_distribution_state: "hidden",
      before_distribution_state: "normal",
      case_id: ids.case,
      content_id: ids.content,
      current_revision_id: ids.revision,
      kind: "post",
      moderation_action_id: ids.action,
      reason_code: "confirmed_report_violation",
      resource_version: 8,
      root_content_id: ids.root,
    });
    expect(audit?.values).toContainEqual({
      permission: "moderation:decide",
      permissions: ["moderation:decide", "moderation:read"],
      roles: ["content_moderator"],
    });
    const publicEvidence = JSON.stringify([outbox?.values, audit?.values]);
    expect(publicEvidence).not.toContain("Private workforce note marker 51f8");
    expect(action?.values).toContain("Private workforce note marker 51f8");
    const targetReadIndex = calls.findIndex((query) =>
      query.text.includes("from platform.moderation_cases as case_target"),
    );
    const contentScopeLockIndex = calls.findIndex((query) =>
      query.text.includes("alphanet:content-report:"),
    );
    const caseLockIndex = calls.findIndex(
      (query) =>
        query.text.includes("from platform.moderation_cases as moderation_case") &&
        query.text.includes("for update"),
    );
    const contentLockIndex = calls.findIndex(
      (query) =>
        query.text.includes("from platform.content_items as content") &&
        query.text.includes("for update"),
    );
    expect(targetReadIndex).toBeGreaterThanOrEqual(0);
    expect(calls[targetReadIndex]?.text).not.toContain("for update");
    expect(targetReadIndex).toBeLessThan(contentScopeLockIndex);
    expect(contentScopeLockIndex).toBeLessThan(caseLockIndex);
    expect(caseLockIndex).toBeLessThan(contentLockIndex);
    expect(
      calls.findIndex((query) => query.text.includes("update platform.content_items")),
    ).toBeLessThan(
      calls.findIndex((query) =>
        query.text.includes("insert into platform.moderation_actions"),
      ),
    );
  });

  it("restores only the latest still-effective action from the same Case", async () => {
    const restore: DecideModerationCaseInput = {
      action: "restore_content",
      expectedCaseVersion: 4,
      idempotencyKey: "moderation-restore-01",
      reasonCode: "appeal_granted",
    };
    const { calls, sql } = fakePostgres((query) => {
      if (query.text.includes("from platform.admins as admin")) return rbacRows();
      if (
        query.text.includes("from platform.moderation_actions as action") &&
        query.text.includes("idempotency_key")
      ) {
        return [];
      }
      if (query.text.includes("from platform.moderation_cases as case_target")) {
        return [
          {
            target_content_id: ids.content,
            target_type: "content",
          },
        ];
      }
      if (query.text.includes("for update") && query.text.includes("moderation_cases")) {
        return [
          {
            assigned_admin_id: ids.admin,
            case_id: ids.case,
            status: "resolved_action",
            target_content_id: ids.content,
            target_type: "content",
            version: "4",
          },
        ];
      }
      if (query.text.includes("for update") && query.text.includes("content_items")) {
        return [
          {
            current_revision_id: ids.revision,
            distribution_state: "hidden",
            kind: "post",
            lifecycle_state: "published",
            root_id: ids.root,
            version: "11",
          },
        ];
      }
      if (query.text.includes("from platform.moderation_actions as prior")) {
        return [{ id: ids.priorAction }];
      }
      if (query.text.includes("update platform.content_items")) {
        return [
          {
            current_revision_id: ids.revision,
            distribution_state: "normal",
            kind: "post",
            lifecycle_state: "published",
            root_id: ids.root,
            version: "12",
          },
        ];
      }
      if (query.text.includes("with changed as")) return [{ count: "2" }];
      if (query.text.includes("update platform.moderation_cases"))
        return [{ closed_at: now, updated_at: now, version: "5" }];
      if (query.text.includes("as next_sequence")) return [{ next_sequence: "4" }];
      if (query.text.includes("insert into system.outbox_events")) {
        return [{ aggregate_sequence: "4", id: ids.outbox }];
      }
      if (query.text.includes("insert into platform.moderation_actions")) {
        return [
          actionRow({
            action: "restore_content",
            after_distribution_state: "normal",
            before_distribution_state: "hidden",
            case_version_after: "5",
            case_version_before: "4",
            internal_note: null,
            reason_code: "appeal_granted",
            response_content_distribution_state: "normal",
            response_content_lifecycle_state: "published",
            response_content_version: "12",
            reverts_action_id: ids.priorAction,
            target_version_after: "12",
            target_version_before: "11",
          }),
        ];
      }
      if (query.text.includes("join lateral") && query.text.includes("report_totals")) {
        return [
          summaryRow({
            case_version: "5",
            content_version: "12",
            distribution_state: "normal",
            latest_action: "restore_content",
          }),
        ];
      }
      return [];
    });
    const result = await service(sql).decideCase(adminContext, ids.case, restore);
    expect(result.action).toMatchObject({
      action: "restore_content",
      distributionAfter: "normal",
      revertedActionId: ids.priorAction,
    });
    const restoreLookup = calls.find((query) =>
      query.text.includes("from platform.moderation_actions as prior"),
    );
    expect(restoreLookup?.text).toContain("reverter.reverts_action_id = prior.id");
    expect(restoreLookup?.text).toContain("where prior.case_id =");
    expect(restoreLookup?.text).toContain("prior.case_version_after =");
    expect(restoreLookup?.text).toContain("later_case.target_content_id");
    expect(restoreLookup?.text).toContain("order by prior.target_version_after desc");
  });

  it("replays a completed decision before locking a now-closed Case", async () => {
    const digest = decisionDigest(decision);
    const { calls, sql } = fakePostgres((query) => {
      if (query.text.includes("from platform.admins as admin")) return rbacRows();
      if (query.text.includes("idempotency_key")) {
        return [{ ...actionRow(), request_digest: digest }];
      }
      if (query.text.includes("join lateral") && query.text.includes("report_totals")) {
        return [
          summaryRow({
            content_version: "12",
            distribution_state: "normal",
            lifecycle_state: "deleted",
          }),
        ];
      }
      return [];
    });
    const result = await service(sql).decideCase(adminContext, ids.case, decision);
    expect(result.replayed).toBe(true);
    expect(result.case).toMatchObject({
      contentVersion: 8,
      distributionState: "hidden",
      lifecycleState: "published",
    });
    expect(result.content).toEqual({
      contentId: ids.content,
      distributionState: "hidden",
      lifecycleState: "published",
      resourceVersion: 8,
    });
    expect(calls.some((query) => query.text.includes("for update"))).toBe(false);
    expect(calls.some((query) => query.text.includes("insert into"))).toBe(false);
  });

  it("does not replay an Admin idempotency key with a different digest", async () => {
    const { sql } = fakePostgres((query) => {
      if (query.text.includes("from platform.admins as admin")) return rbacRows();
      if (query.text.includes("idempotency_key")) {
        return [{ ...actionRow(), request_digest: Buffer.alloc(32, 9) }];
      }
      return [];
    });
    await expect(
      service(sql).decideCase(adminContext, ids.case, decision),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
  });
});

describe("PostgresContentModerationService reads", () => {
  const readContext: AdminModerationContext = {
    ...adminContext,
    permission: "moderation:read",
  };

  it("audits sensitive Case detail reads without copying report details or internal notes", async () => {
    const privateReportDetails = "Reporter private evidence marker e2bd";
    const privateInternalNote = "Admin private note marker 73ca";
    const { calls, sql } = fakePostgres((query) => {
      if (query.text.includes("from platform.admins as admin")) {
        return rbacRows("moderation:read");
      }
      if (query.text.includes("join lateral") && query.text.includes("report_totals")) {
        return [
          summaryRow({
            case_version: "2",
            closed_at: null,
            latest_action: null,
            latest_action_id: null,
            status: "reviewing",
            updated_at: new Date("2026-07-21T11:30:00.000Z"),
          }),
        ];
      }
      if (query.text.includes("join platform.content_revisions as revision")) {
        return [
          {
            actor_id: ids.actor,
            actor_kind: "agent",
            agent_id: ids.agent,
            body_markdown: "Untrusted report target body.",
            content_id: ids.content,
            created_at: new Date("2026-07-20T10:00:00.000Z"),
            current_revision_id: ids.revision,
            deleted_at: null,
            depth: 0,
            distribution_state: "hidden",
            handle: "alpha-agent",
            kind: "post",
            lifecycle_state: "published",
            parent_id: null,
            root_id: ids.content,
            title: "Target research post",
            updated_at: new Date("2026-07-21T10:30:00.000Z"),
            version: "8",
          },
        ];
      }
      if (query.text.includes("from platform.moderation_case_items as item")) {
        return [
          {
            case_id: ids.case,
            content_id: ids.content,
            created_at: new Date("2026-07-21T11:00:00.000Z"),
            description: privateReportDetails,
            id: ids.report,
            reason_code: "spam",
            reporter_actor_id: ids.actor,
            reporter_owner_id: ids.owner,
            resolved_at: null,
            status: "reviewing",
            updated_at: new Date("2026-07-21T11:30:00.000Z"),
            version: "2",
          },
        ];
      }
      if (
        query.text.includes("from platform.moderation_actions as action") &&
        !query.text.includes("idempotency_key")
      ) {
        return [actionRow({ internal_note: privateInternalNote })];
      }
      return [];
    });
    const moderation = service(sql, [ids.snapshot, ids.actionLog]);
    const detail = await moderation.getCase(readContext, ids.case, {});
    expect(detail.reports.items[0]?.details).toBe(privateReportDetails);
    expect(detail.actions.items[0]?.internalNote).toBe(privateInternalNote);
    const audit = calls.find((query) =>
      query.text.includes("'moderation.case_sensitive_read'"),
    );
    expect(audit).toBeDefined();
    expect(audit?.values).toContainEqual({
      permission: "moderation:read",
      permissions: ["moderation:read"],
      roles: ["content_moderator"],
    });
    expect(JSON.stringify(audit?.values)).not.toContain(privateReportDetails);
    expect(JSON.stringify(audit?.values)).not.toContain(privateInternalNote);
  });

  it("uses signed filter-bound Case cursors and rejects tampering before SQL", async () => {
    const secondCase = "40000000-0000-4000-8000-000000000002";
    const { begin, sql } = fakePostgres((query) => {
      if (query.text.includes("from platform.admins as admin")) {
        return rbacRows("moderation:read");
      }
      if (query.text.includes("join lateral") && query.text.includes("report_totals")) {
        return [
          summaryRow({
            case_id: ids.case,
            case_version: "1",
            closed_at: null,
            latest_action: null,
            latest_action_id: null,
            priority: "urgent",
            status: "open",
            updated_at: new Date("2026-07-21T11:30:00.000Z"),
          }),
          summaryRow({
            case_id: secondCase,
            case_version: "1",
            closed_at: null,
            latest_action: null,
            latest_action_id: null,
            priority: "high",
            status: "open",
            updated_at: new Date("2026-07-21T11:30:00.000Z"),
          }),
        ];
      }
      return [];
    });
    const moderation = service(sql, [ids.snapshot]);
    const page = await moderation.listCases(readContext, { limit: 1 });
    expect(page).toMatchObject({
      hasMore: true,
      items: [{ caseId: ids.case, queueRank: 1 }],
      orderingVersion: "moderation-case-live-keyset-v1",
      snapshotId: ids.snapshot,
    });
    expect(page.nextCursor).toBeTypeOf("string");
    const callsBeforeTamper = begin.mock.calls.length;
    const cursor = page.nextCursor ?? "";
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
    await expect(
      moderation.listCases(readContext, { cursor: tampered, limit: 1 }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID", statusCode: 422 });
    expect(begin).toHaveBeenCalledTimes(callsBeforeTamper);
    await expect(
      moderation.listCases(readContext, { cursor, limit: 2 }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
  });

  it("rechecks current database RBAC instead of trusting the request snapshot", async () => {
    const { calls, sql } = fakePostgres((query) => {
      if (query.text.includes("from platform.admins as admin")) {
        return rbacRows("moderation:read");
      }
      return [];
    });
    await expect(
      service(sql).decideCase(adminContext, ids.case, decision),
    ).rejects.toMatchObject({ code: "ADMIN_PERMISSION_REQUIRED", statusCode: 403 });
    expect(calls.some((query) => query.text.includes("update platform"))).toBe(false);
  });
});

describe("PostgresContentModerationService Owner history", () => {
  it("proves author ownership and strips Admin identity and internal notes", async () => {
    const { sql } = fakePostgres((query) => {
      if (query.text.includes("from platform.owners as owner")) {
        return [
          {
            content_id: ids.content,
            distribution_state: "hidden",
            version: "8",
          },
        ];
      }
      if (query.text.includes("moderation_case.target_content_id")) {
        return [actionRow()];
      }
      return [];
    });
    const history = await service(sql, [ids.snapshot]).listContentActions(
      ids.owner,
      ids.content,
      {},
    );
    expect(history).toMatchObject({
      contentId: ids.content,
      contentVersion: 8,
      distributionState: "hidden",
      page: {
        items: [
          {
            action: "hide_content",
            contentVersionAfter: 8,
            distributionAfter: "hidden",
          },
        ],
        orderingVersion: "owner-content-moderation-list-v1",
      },
    });
    const item = history.page.items[0] as unknown as Record<string, unknown>;
    expect(Object.hasOwn(item, "decidedByAdminId")).toBe(false);
    expect(Object.hasOwn(item, "internalNote")).toBe(false);
  });

  it("does not reveal whether another Owner's Content exists", async () => {
    const { sql } = fakePostgres(() => []);
    await expect(
      service(sql, [ids.snapshot]).listContentActions(ids.owner, ids.content, {}),
    ).rejects.toMatchObject({ code: "OWNER_CONTENT_NOT_FOUND", statusCode: 404 });
  });
});

describe("PostgresContentModerationService readiness", () => {
  it.each([true, false])(
    "requires exact governance migration and trigger state: %s",
    async (ready) => {
      const sql = Object.assign(
        vi.fn(() => Promise.resolve([{ ready }])),
        {
          begin: vi.fn(),
        },
      ) as unknown as PostgresClient;
      if (ready) {
        await expect(service(sql).checkReady()).resolves.toBeUndefined();
      } else {
        await expect(service(sql).checkReady()).rejects.toThrow(
          "Content moderation schema is not ready.",
        );
      }
    },
  );
});
