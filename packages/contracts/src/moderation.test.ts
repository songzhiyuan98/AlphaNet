import { describe, expect, it } from "vitest";

import {
  AdminContentModerationActionRecordSchema,
  AdminContentModerationActionSchema,
  AdminModerationCaseDetailRequestSchema,
  AdminModerationCaseDetailResponseSchema,
  AdminModerationCaseListRequestSchema,
  AdminModerationCaseListResponseSchema,
  AdminModerationDecisionHeadersSchema,
  AdminModerationDecisionRequestSchema,
  AdminModerationDecisionResponseSchema,
  AdminModerationReasonCodeSchema,
  ContentReportReasonSchema,
  ContentReportStatusSchema,
  ModerationCasePrioritySchema,
  ModerationCaseStatusSchema,
  ModerationContentSnapshotSchema,
  ModerationReasonCountsSchema,
  OwnerContentModerationListRequestSchema,
  OwnerContentModerationListResponseSchema,
  OwnerContentModerationPathParamsSchema,
  OwnerContentModerationRecordSchema,
  OwnerContentReportCreateRequestSchema,
  OwnerContentReportCreateResponseSchema,
  OwnerContentReportHeadersSchema,
  OwnerContentReportPathParamsSchema,
  StrictVersionEntityTagSchema,
} from "./moderation.ts";

const ids = {
  action: "mod_action_1",
  actor: "10000000-0000-4000-8000-000000000001",
  admin: "20000000-0000-4000-8000-000000000001",
  case: "mod_case_1",
  content: "30000000-0000-4000-8000-000000000001",
  reporter: "40000000-0000-4000-8000-000000000001",
  report: "mod_report_1",
  revision: "50000000-0000-4000-8000-000000000001",
} as const;

const times = {
  opened: "2026-07-21T18:00:00.000Z",
  reported: "2026-07-21T18:05:00.000Z",
  decided: "2026-07-21T18:20:00.000Z",
} as const;

const author = {
  actor_id: ids.actor,
  kind: "agent",
  handle: "risk-researcher",
  agent_id: "60000000-0000-4000-8000-000000000001",
} as const;

const reasonCounts = {
  spam: 0,
  harassment: 0,
  impersonation: 0,
  malicious_link: 1,
  privacy_exposure: 1,
  other_rule_violation: 0,
} as const;

const resolvedCase = {
  case_id: ids.case,
  case_version: 3,
  content_id: ids.content,
  content_version: 8,
  content_kind: "post",
  lifecycle_state: "published",
  distribution_state: "hidden",
  author,
  status: "resolved_action",
  priority: "urgent",
  report_count: 2,
  reason_counts: reasonCounts,
  opened_at: times.opened,
  last_reported_at: times.reported,
  updated_at: times.decided,
  resolved_at: times.decided,
  resolution_action: "hide_content",
  latest_action_id: ids.action,
} as const;

const resolvedReport = {
  report_id: ids.report,
  report_version: 2,
  case_id: ids.case,
  content_id: ids.content,
  reporter_actor_id: ids.actor,
  reason_code: "malicious_link",
  details: "The destination redirects to a credential collection page.",
  status: "resolved_action",
  submitted_at: times.reported,
  updated_at: times.decided,
  resolved_at: times.decided,
} as const;

const hiddenAction = {
  moderation_action_id: ids.action,
  action_version: 1,
  case_id: ids.case,
  content_id: ids.content,
  content_version_before: 7,
  content_version_after: 8,
  content_lifecycle_state: "published",
  action: "hide_content",
  reason_code: "confirmed_report_violation",
  internal_note: "URL evidence preserved in the restricted audit record.",
  distribution_before: "limited",
  distribution_after: "hidden",
  reverted_action_id: null,
  decided_by_admin_id: ids.admin,
  decided_at: times.decided,
} as const;

const contentSnapshot = {
  kind: "post",
  content_id: ids.content,
  root_content_id: ids.content,
  parent_content_id: null,
  depth: 0,
  resource_version: 8,
  lifecycle_state: "published",
  distribution_state: "hidden",
  current_revision_id: ids.revision,
  author,
  title: "MU supply-chain source integrity review",
  body_markdown: "The cited channel source redirects through an unknown domain.",
  created_at: times.opened,
  updated_at: times.decided,
  deleted_at: null,
} as const;

const page = {
  next_cursor: null,
  has_more: false,
  limit: 20,
} as const;

describe("moderation taxonomies", () => {
  it("freezes the external report, Case, priority, action, and Admin reason values", () => {
    expect(ContentReportReasonSchema.options).toEqual([
      "spam",
      "harassment",
      "impersonation",
      "malicious_link",
      "privacy_exposure",
      "other_rule_violation",
    ]);
    expect(ContentReportStatusSchema.options).toEqual([
      "open",
      "reviewing",
      "resolved_action",
      "dismissed",
    ]);
    expect(ModerationCaseStatusSchema.options).toEqual(ContentReportStatusSchema.options);
    expect(ModerationCasePrioritySchema.options).toEqual(["normal", "high", "urgent"]);
    expect(AdminContentModerationActionSchema.options).toEqual([
      "dismiss",
      "limit_content",
      "hide_content",
      "restore_content",
    ]);
    expect(AdminModerationReasonCodeSchema.options).toEqual([
      "confirmed_report_violation",
      "precautionary_distribution_limit",
      "insufficient_evidence",
      "no_rule_violation",
      "duplicate_case",
      "moderation_error_corrected",
      "appeal_granted",
      "risk_condition_resolved",
    ]);
  });
});

describe("Owner Web content reports", () => {
  it("accepts every controlled reason and requires details only for the other reason", () => {
    for (const reason_code of ContentReportReasonSchema.options) {
      const request = {
        reporter_actor_id: ids.actor,
        reason_code,
        ...(reason_code === "other_rule_violation"
          ? { details: "This behavior violates another published community rule." }
          : {}),
      };
      expect(OwnerContentReportCreateRequestSchema.parse(request)).toEqual(request);
    }

    expect(
      OwnerContentReportCreateRequestSchema.safeParse({
        reporter_actor_id: ids.actor,
        reason_code: "other_rule_violation",
      }).success,
    ).toBe(false);
    expect(
      OwnerContentReportCreateRequestSchema.safeParse({
        reporter_actor_id: ids.actor,
        reason_code: "other_rule_violation",
        details: "  not trimmed  ",
      }).success,
    ).toBe(false);
  });

  it("requires an explicit reporter Actor but keeps authority and transport controls out of the body", () => {
    expect(
      OwnerContentReportCreateRequestSchema.safeParse({ reason_code: "spam" }).success,
    ).toBe(false);
    for (const forged of [
      { content_id: ids.content },
      { reporter_owner_id: ids.reporter },
      { reporter_agent_id: "forged-agent" },
      { idempotency_key: "report-key" },
      { expected_version: 1 },
    ]) {
      expect(
        OwnerContentReportCreateRequestSchema.safeParse({
          reporter_actor_id: ids.actor,
          reason_code: "spam",
          ...forged,
        }).success,
      ).toBe(false);
    }
  });

  it("validates strict path and exactly one normalized transport key", () => {
    expect(OwnerContentReportPathParamsSchema.parse({ content_id: ids.content })).toEqual(
      { content_id: ids.content },
    );
    expect(
      OwnerContentReportHeadersSchema.parse({ "idempotency-key": "report-key-1" }),
    ).toEqual({ "idempotency-key": "report-key-1" });

    expect(
      OwnerContentReportPathParamsSchema.safeParse({
        content_id: ids.content,
        actor_id: ids.actor,
      }).success,
    ).toBe(false);
    expect(
      OwnerContentReportHeadersSchema.safeParse({
        "idempotency-key": ["one", "two"],
      }).success,
    ).toBe(false);
    expect(
      OwnerContentReportHeadersSchema.safeParse({
        "idempotency-key": "one, two",
      }).success,
    ).toBe(false);
  });

  it("returns the stable report identity and current Report status", () => {
    const response = {
      created: true,
      report: {
        ...resolvedReport,
        report_version: 1,
        status: "open",
        updated_at: times.reported,
        resolved_at: null,
      },
      request_id: "req-report-1",
      schema_version: "1",
    } as const;
    expect(OwnerContentReportCreateResponseSchema.parse(response)).toEqual(response);
    expect(
      OwnerContentReportCreateResponseSchema.parse({ ...response, created: false }),
    ).toEqual({ ...response, created: false });
  });

  it("rejects inconsistent terminal timestamps", () => {
    expect(
      OwnerContentReportCreateResponseSchema.safeParse({
        created: true,
        report: { ...resolvedReport, resolved_at: null },
        request_id: "req-report-2",
        schema_version: "1",
      }).success,
    ).toBe(false);
  });
});

describe("Admin moderation queue", () => {
  it("accepts bounded unique filters and rejects duplicate or forged query fields", () => {
    const request = {
      statuses: ["open", "reviewing"],
      priorities: ["urgent"],
      reasons: ["privacy_exposure", "malicious_link"],
      content_id: ids.content,
      limit: 50,
      cursor: null,
    } as const;
    expect(AdminModerationCaseListRequestSchema.parse(request)).toEqual(request);
    expect(
      AdminModerationCaseListRequestSchema.safeParse({
        statuses: ["open", "open"],
      }).success,
    ).toBe(false);
    expect(
      AdminModerationCaseListRequestSchema.safeParse({
        limit: 101,
        reporter_owner_id: ids.reporter,
      }).success,
    ).toBe(false);
  });

  it("requires exact reason totals and terminal Case resolution state", () => {
    expect(ModerationReasonCountsSchema.parse(reasonCounts)).toEqual(reasonCounts);
    const response = {
      capabilities: { can_decide: true },
      items: [{ ...resolvedCase, queue_rank: 1 }],
      page,
      ordering: {
        snapshot_id: "snapshot-cases-1",
        ordering_version: "moderation-case-live-keyset-v1",
        as_of: times.decided,
      },
      request_id: "req-cases-1",
      schema_version: "1",
    } as const;
    expect(AdminModerationCaseListResponseSchema.parse(response)).toEqual(response);
    expect(
      AdminModerationCaseListResponseSchema.parse({
        ...response,
        capabilities: { can_decide: false },
      }).capabilities,
    ).toEqual({ can_decide: false });
    expect(
      AdminModerationCaseListResponseSchema.safeParse({
        ...response,
        capabilities: { can_decide: true, forged_permission: true },
      }).success,
    ).toBe(false);
    const withoutCapabilities = Object.fromEntries(
      Object.entries(response).filter(([key]) => key !== "capabilities"),
    );
    expect(
      AdminModerationCaseListResponseSchema.safeParse(withoutCapabilities).success,
    ).toBe(false);

    expect(
      AdminModerationCaseListResponseSchema.safeParse({
        ...response,
        items: [
          {
            ...response.items[0],
            reason_counts: { ...reasonCounts, spam: 1 },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AdminModerationCaseListResponseSchema.safeParse({
        ...response,
        items: [
          {
            ...response.items[0],
            status: "dismissed",
            resolution_action: "hide_content",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("enforces unique ascending frozen queue ranks and declared page size", () => {
    const response = {
      capabilities: { can_decide: true },
      items: [
        { ...resolvedCase, case_id: "case-2", queue_rank: 2 },
        { ...resolvedCase, case_id: "case-1", queue_rank: 1 },
      ],
      page: { ...page, limit: 1 },
      ordering: {
        snapshot_id: "snapshot-cases-2",
        ordering_version: "moderation-case-live-keyset-v1",
        as_of: times.decided,
      },
      request_id: "req-cases-2",
      schema_version: "1",
    } as const;
    expect(AdminModerationCaseListResponseSchema.safeParse(response).success).toBe(false);
  });
});

describe("Admin Case detail", () => {
  it("validates independently paged report and action collections", () => {
    expect(
      AdminModerationCaseDetailRequestSchema.parse({
        report_limit: 50,
        report_cursor: null,
        action_limit: 20,
        action_cursor: "next-actions",
      }),
    ).toEqual({
      report_limit: 50,
      report_cursor: null,
      action_limit: 20,
      action_cursor: "next-actions",
    });
    expect(
      AdminModerationCaseDetailRequestSchema.safeParse({
        report_limit: 0,
        case_id: ids.case,
      }).success,
    ).toBe(false);
  });

  it("accepts a full internal content snapshot and rejects invalid locations or lifecycle dates", () => {
    expect(ModerationContentSnapshotSchema.parse(contentSnapshot)).toEqual(
      contentSnapshot,
    );
    expect(
      ModerationContentSnapshotSchema.safeParse({
        ...contentSnapshot,
        root_content_id: "different-root",
      }).success,
    ).toBe(false);
    expect(
      ModerationContentSnapshotSchema.safeParse({
        ...contentSnapshot,
        lifecycle_state: "deleted",
        deleted_at: null,
      }).success,
    ).toBe(false);
  });

  it("binds the Case, content, reports, actions, and their ordering snapshots", () => {
    const response = {
      capabilities: { can_decide: true },
      case: resolvedCase,
      content: contentSnapshot,
      reports: [{ ...resolvedReport, reporter_owner_id: ids.reporter }],
      report_page: page,
      report_ordering: {
        snapshot_id: "snapshot-reports-1",
        ordering_version: "moderation-report-list-v1",
        as_of: times.decided,
      },
      actions: [hiddenAction],
      action_page: page,
      action_ordering: {
        snapshot_id: "snapshot-actions-1",
        ordering_version: "moderation-action-list-v1",
        as_of: times.decided,
      },
      request_id: "req-case-detail-1",
      schema_version: "1",
    } as const;
    expect(AdminModerationCaseDetailResponseSchema.parse(response)).toEqual(response);
    expect(
      AdminModerationCaseDetailResponseSchema.parse({
        ...response,
        capabilities: { can_decide: false },
      }).capabilities,
    ).toEqual({ can_decide: false });
    expect(
      AdminModerationCaseDetailResponseSchema.safeParse({
        ...response,
        capabilities: { can_decide: "true" },
      }).success,
    ).toBe(false);
    expect(
      AdminModerationCaseDetailResponseSchema.safeParse({
        ...response,
        reports: [
          {
            ...response.reports[0],
            case_id: "another-case",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AdminModerationCaseDetailResponseSchema.safeParse({
        ...response,
        content: { ...response.content, resource_version: 9 },
      }).success,
    ).toBe(false);
  });
});

describe("Admin moderation decisions", () => {
  it("keeps If-Match and idempotency in strict headers", () => {
    const headers = {
      "if-match": '"3"',
      "idempotency-key": "moderate-case-3",
    } as const;
    expect(AdminModerationDecisionHeadersSchema.parse(headers)).toEqual(headers);
    expect(StrictVersionEntityTagSchema.safeParse('W/"3"').success).toBe(false);
    expect(StrictVersionEntityTagSchema.safeParse('"0"').success).toBe(false);
    expect(
      StrictVersionEntityTagSchema.safeParse(`"${Number.MAX_SAFE_INTEGER + 1}"`).success,
    ).toBe(false);
    expect(
      AdminModerationDecisionHeadersSchema.safeParse({
        ...headers,
        "if-match": ['"3"', '"4"'],
      }).success,
    ).toBe(false);
  });

  it("allows only reason codes valid for each action and rejects transport controls in the body", () => {
    const valid = [
      { action: "dismiss", reason_code: "insufficient_evidence" },
      {
        action: "limit_content",
        reason_code: "precautionary_distribution_limit",
      },
      { action: "hide_content", reason_code: "confirmed_report_violation" },
      { action: "restore_content", reason_code: "appeal_granted" },
    ] as const;
    for (const request of valid) {
      expect(AdminModerationDecisionRequestSchema.parse(request)).toEqual(request);
    }

    for (const request of [
      { action: "dismiss", reason_code: "confirmed_report_violation" },
      { action: "hide_content", reason_code: "no_rule_violation" },
      { action: "restore_content", reason_code: "duplicate_case" },
      {
        action: "restore_content",
        reason_code: "appeal_granted",
        reverted_action_id: ids.action,
      },
      {
        action: "hide_content",
        reason_code: "confirmed_report_violation",
        expected_version: 2,
      },
      {
        action: "hide_content",
        reason_code: "confirmed_report_violation",
        idempotency_key: "forged-body-key",
      },
    ]) {
      expect(AdminModerationDecisionRequestSchema.safeParse(request).success).toBe(false);
    }
  });

  it("requires exact Case and Content transitions for dismiss, limit, hide, and restore", () => {
    expect(AdminContentModerationActionRecordSchema.parse(hiddenAction)).toEqual(
      hiddenAction,
    );
    const dismissAction = {
      ...hiddenAction,
      moderation_action_id: "dismiss-action",
      action: "dismiss",
      reason_code: "no_rule_violation",
      content_version_before: null,
      content_version_after: null,
      content_lifecycle_state: null,
      distribution_before: null,
      distribution_after: null,
    } as const;
    expect(AdminContentModerationActionRecordSchema.parse(dismissAction)).toEqual(
      dismissAction,
    );
    const limitAction = {
      ...hiddenAction,
      moderation_action_id: "limit-action",
      action: "limit_content",
      reason_code: "precautionary_distribution_limit",
      distribution_before: "normal",
      distribution_after: "limited",
    } as const;
    expect(AdminContentModerationActionRecordSchema.parse(limitAction)).toEqual(
      limitAction,
    );
    const restoreAction = {
      ...hiddenAction,
      moderation_action_id: "restore-action",
      action: "restore_content",
      reason_code: "moderation_error_corrected",
      distribution_before: "hidden",
      distribution_after: "normal",
      reverted_action_id: ids.action,
    } as const;
    expect(AdminContentModerationActionRecordSchema.parse(restoreAction)).toEqual(
      restoreAction,
    );

    expect(
      AdminContentModerationActionRecordSchema.safeParse({
        ...restoreAction,
        reverted_action_id: null,
      }).success,
    ).toBe(false);
    expect(
      AdminContentModerationActionRecordSchema.safeParse({
        ...hiddenAction,
        content_version_after: hiddenAction.content_version_before,
      }).success,
    ).toBe(false);
  });

  it("returns consistent post-decision Case, action, and resource versions", () => {
    const response = {
      case_version_before: 2,
      case: resolvedCase,
      action: hiddenAction,
      content: {
        content_id: ids.content,
        resource_version: 8,
        lifecycle_state: "published",
        distribution_state: "hidden",
      },
      request_id: "req-decision-1",
      schema_version: "1",
    } as const;
    expect(AdminModerationDecisionResponseSchema.parse(response)).toEqual(response);
    expect(
      AdminModerationDecisionResponseSchema.safeParse({
        ...response,
        content: { ...response.content, resource_version: 7 },
      }).success,
    ).toBe(false);

    const dismissedCase = {
      ...resolvedCase,
      case_version: 4,
      status: "dismissed",
      resolution_action: "dismiss",
      latest_action_id: "dismiss-action",
    } as const;
    const dismissAction = {
      ...hiddenAction,
      moderation_action_id: "dismiss-action",
      action: "dismiss",
      reason_code: "no_rule_violation",
      content_version_before: null,
      content_version_after: null,
      content_lifecycle_state: null,
      distribution_before: null,
      distribution_after: null,
    } as const;
    expect(
      AdminModerationDecisionResponseSchema.parse({
        ...response,
        case_version_before: 3,
        case: dismissedCase,
        action: dismissAction,
        request_id: "req-decision-dismiss-1",
      }),
    ).toEqual({
      ...response,
      case_version_before: 3,
      case: dismissedCase,
      action: dismissAction,
      request_id: "req-decision-dismiss-1",
    });
  });
});

describe("Owner content disposition history", () => {
  const ownerRecord = {
    moderation_action_id: ids.action,
    action_version: 1,
    case_id: ids.case,
    content_id: ids.content,
    content_version_before: 7,
    content_version_after: 8,
    action: "hide_content",
    reason_code: "confirmed_report_violation",
    distribution_before: "limited",
    distribution_after: "hidden",
    reverted_action_id: null,
    decided_at: times.decided,
  } as const;

  it("exposes a sanitized record without reporter, Admin, evidence, or internal notes", () => {
    expect(OwnerContentModerationRecordSchema.parse(ownerRecord)).toEqual(ownerRecord);
    for (const extra of [
      { reporter_owner_id: ids.reporter },
      { decided_by_admin_id: ids.admin },
      { internal_note: "sensitive evidence" },
      { case_version: 3 },
      { report_details: "sensitive reporter text" },
    ]) {
      expect(
        OwnerContentModerationRecordSchema.safeParse({
          ...ownerRecord,
          ...extra,
        }).success,
      ).toBe(false);
    }

    expect(
      OwnerContentModerationRecordSchema.parse({
        ...ownerRecord,
        moderation_action_id: "dismiss-action",
        action: "dismiss",
        reason_code: "insufficient_evidence",
        content_version_before: null,
        content_version_after: null,
        distribution_before: null,
        distribution_after: null,
      }),
    ).toEqual({
      ...ownerRecord,
      moderation_action_id: "dismiss-action",
      action: "dismiss",
      reason_code: "insufficient_evidence",
      content_version_before: null,
      content_version_after: null,
      distribution_before: null,
      distribution_after: null,
    });
  });

  it("uses strict target and pagination DTOs and descending action order", () => {
    expect(
      OwnerContentModerationPathParamsSchema.parse({ content_id: ids.content }),
    ).toEqual({ content_id: ids.content });
    expect(
      OwnerContentModerationListRequestSchema.parse({ limit: 20, cursor: null }),
    ).toEqual({ limit: 20, cursor: null });

    const response = {
      content_id: ids.content,
      content_version: 8,
      distribution_state: "hidden",
      items: [ownerRecord],
      page,
      ordering: {
        snapshot_id: "snapshot-owner-actions-1",
        ordering_version: "owner-content-moderation-list-v1",
        as_of: times.decided,
      },
      request_id: "req-owner-actions-1",
      schema_version: "1",
    } as const;
    expect(OwnerContentModerationListResponseSchema.parse(response)).toEqual(response);
    expect(
      OwnerContentModerationListResponseSchema.safeParse({
        ...response,
        items: [{ ...ownerRecord, content_id: "other-content" }],
      }).success,
    ).toBe(false);
  });
});
