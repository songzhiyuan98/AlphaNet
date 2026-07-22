import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it, vi } from "vitest";

import {
  PostgresContentReportService,
  type ContentReportError,
  type CreateContentReportInput,
  type OwnerReportRequestContext,
} from "./content-report.js";

const ids = {
  actor: "11111111-1111-4111-8111-111111111111",
  author: "77777777-7777-4777-8777-777777777777",
  case: "55555555-5555-4555-8555-555555555555",
  content: "22222222-2222-4222-8222-222222222222",
  owner: "33333333-3333-4333-8333-333333333333",
  report: "66666666-6666-4666-8666-666666666666",
} as const;

const context: OwnerReportRequestContext = {
  authenticationAssurance: "email_verified_owner_session",
  ownerId: ids.owner,
  requestId: "req-content-report-01",
};
const input: CreateContentReportInput = {
  contentId: ids.content,
  idempotencyKey: "content-report-01",
  reasonCode: "spam",
  reporterActorId: ids.actor,
};

function sqlWithoutTransactions(): {
  begin: ReturnType<typeof vi.fn>;
  sql: PostgresClient;
} {
  const begin = vi.fn();
  return { begin, sql: { begin } as unknown as PostgresClient };
}

async function expectValidationFailure(
  changedContext: OwnerReportRequestContext,
  changedInput: CreateContentReportInput,
): Promise<void> {
  const { begin, sql } = sqlWithoutTransactions();
  const service = new PostgresContentReportService(sql);
  await expect(service.createReport(changedContext, changedInput)).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
    statusCode: 400,
  } satisfies Partial<ContentReportError>);
  expect(begin).not.toHaveBeenCalled();
}

describe("PostgresContentReportService request boundary", () => {
  it.each([
    ["owner", { ...context, ownerId: "not-a-uuid" }, input],
    ["actor", context, { ...input, reporterActorId: "not-a-uuid" }],
    ["content", context, { ...input, contentId: "not-a-uuid" }],
    ["request ID", { ...context, requestId: "\n" }, input],
    ["assurance", { ...context, authenticationAssurance: "\0" }, input],
    ["blank idempotency", context, { ...input, idempotencyKey: "   " }],
    ["control idempotency", context, { ...input, idempotencyKey: "report\n1" }],
  ])("rejects invalid %s before opening a transaction", async (_label, ctx, body) => {
    await expectValidationFailure(ctx, body);
  });

  it("requires bounded details for the catch-all reason", async () => {
    await expectValidationFailure(context, {
      ...input,
      reasonCode: "other_rule_violation",
    });
    await expectValidationFailure(context, {
      ...input,
      details: "x".repeat(4_001),
      reasonCode: "other_rule_violation",
    });
    await expectValidationFailure(context, {
      ...input,
      details: "unsafe\0details",
      reasonCode: "other_rule_violation",
    });
  });

  it("rejects an invalid clock before opening a transaction", async () => {
    const { begin, sql } = sqlWithoutTransactions();
    const service = new PostgresContentReportService(sql, {
      clock: () => new Date(Number.NaN),
    });
    await expect(service.createReport(context, input)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
    expect(begin).not.toHaveBeenCalled();
  });
});

describe("PostgresContentReportService readiness", () => {
  it.each([true, false])("requires the complete reporting schema: %s", async (ready) => {
    const sql = Object.assign(
      vi.fn(() => Promise.resolve([{ ready }])),
      {
        begin: vi.fn(),
      },
    ) as unknown as PostgresClient;
    const service = new PostgresContentReportService(sql);
    if (ready) {
      await expect(service.checkReady()).resolves.toBeUndefined();
    } else {
      await expect(service.checkReady()).rejects.toThrow(
        "Content reporting schema is not ready.",
      );
    }
  });
});

describe("PostgresContentReportService active deduplication", () => {
  it("persists the new request key before returning the existing Report", async () => {
    const captured: Array<{ text: string; values: readonly unknown[] }> = [];
    const now = new Date("2026-07-21T19:00:00.000Z");
    const transaction = vi.fn(
      (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
        const text = strings.join("?").replaceAll(/\s+/gu, " ").trim();
        captured.push({ text, values });
        if (text.includes("select count(*)::text") && text.includes("active_report")) {
          return [
            {
              active_count: "1",
              actor_count: "1",
              actor_retry_at: new Date(now.valueOf() + 60_000),
              owner_count: "1",
              owner_retry_at: new Date(now.valueOf() + 60_000),
            },
          ];
        }
        if (text.includes("from platform.report_submission_idempotency")) return [];
        if (text.includes("from platform.owners as owner")) {
          return [{ actor_id: ids.actor }];
        }
        if (text.includes("from platform.content_items as content")) {
          return [
            {
              author_actor_id: ids.author,
              author_owner_id: "88888888-8888-4888-8888-888888888888",
              content_version: "1",
              distribution_state: "normal",
              lifecycle_state: "published",
              root_distribution_state: "normal",
              root_lifecycle_state: "published",
            },
          ];
        }
        if (
          text.includes("from platform.reports as report") &&
          text.includes("report.status in ('open', 'reviewing')")
        ) {
          return [
            {
              case_id: ids.case,
              content_id: ids.content,
              created_at: now,
              description: "existing private detail",
              id: ids.report,
              reason_code: "spam",
              reporter_actor_id: ids.actor,
              resolved_at: null,
              status: "open",
              updated_at: now,
              version: "1",
            },
          ];
        }
        return [];
      },
    );
    const begin = vi.fn(async (callback: (sql: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    );
    const service = new PostgresContentReportService({
      begin,
    } as unknown as PostgresClient);

    await expect(service.createReport(context, input)).resolves.toMatchObject({
      created: false,
      deduplicated: true,
      replayed: false,
      report: { id: ids.report },
    });
    const mappingInserts = captured.filter((query) =>
      query.text.startsWith("insert into platform.report_submission_idempotency"),
    );
    expect(mappingInserts).toHaveLength(1);
    expect(mappingInserts[0]?.values).toEqual([
      ids.owner,
      ids.actor,
      input.idempotencyKey,
      expect.any(Buffer),
      ids.report,
    ]);
    const activeDuplicateQuery = captured.find(
      (query) =>
        query.text.includes("from platform.reports as report") &&
        query.text.includes("report.status in ('open', 'reviewing')"),
    );
    expect(activeDuplicateQuery?.text).toContain("where report.reporter_owner_id = ?");
    expect(activeDuplicateQuery?.values).toEqual([ids.owner, ids.content]);
    expect(
      captured.some((query) => query.text.startsWith("insert into platform.reports")),
    ).toBe(false);
  });

  it("rate-limits new duplicate aliases while exact-key replay remains separately exempt", async () => {
    const captured: string[] = [];
    const now = new Date("2026-07-21T19:00:00.000Z");
    const transaction = vi.fn((strings: TemplateStringsArray) => {
      const text = strings.join("?").replaceAll(/\s+/gu, " ").trim();
      captured.push(text);
      if (text.includes("select count(*)::text") && text.includes("active_report")) {
        return [
          {
            active_count: "1",
            actor_count: "5",
            actor_retry_at: new Date(now.valueOf() + 60_000),
            owner_count: "5",
            owner_retry_at: new Date(now.valueOf() + 60_000),
          },
        ];
      }
      if (text.includes("from platform.report_submission_idempotency")) return [];
      if (text.includes("from platform.owners as owner")) {
        return [{ actor_id: ids.actor }];
      }
      if (text.includes("from platform.content_items as content")) {
        return [
          {
            author_actor_id: ids.author,
            author_owner_id: "88888888-8888-4888-8888-888888888888",
            content_version: "1",
            distribution_state: "normal",
            lifecycle_state: "published",
            root_distribution_state: "normal",
            root_lifecycle_state: "published",
          },
        ];
      }
      return [];
    });
    const begin = vi.fn(async (callback: (sql: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    );
    const service = new PostgresContentReportService(
      { begin } as unknown as PostgresClient,
      { clock: () => now },
    );

    await expect(service.createReport(context, input)).rejects.toMatchObject({
      code: "REPORT_LIMIT_REACHED",
      statusCode: 429,
    } satisfies Partial<ContentReportError>);
    expect(
      captured.some((text) =>
        text.startsWith("insert into platform.report_submission_idempotency"),
      ),
    ).toBe(false);
    const quotaQuery = captured.find(
      (text) => text.includes("select count(*)::text") && text.includes("active_report"),
    );
    expect(quotaQuery).toContain("submission.reporter_actor_id = ?");
    expect(
      captured.some(
        (text) =>
          text.includes("select report.id::text as id") &&
          text.includes("where report.reporter_owner_id = ?") &&
          text.includes("report.status in ('open', 'reviewing')"),
      ),
    ).toBe(false);
  });
});
