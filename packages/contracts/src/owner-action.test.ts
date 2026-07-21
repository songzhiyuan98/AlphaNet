import { describe, expect, it } from "vitest";

import {
  OwnerActionApproveRequestSchema,
  OwnerActionApproveResponseSchema,
  OwnerActionDetailRequestSchema,
  OwnerActionDetailResponseSchema,
  OwnerActionListRequestSchema,
  OwnerActionListResponseSchema,
  OwnerActionRejectRequestSchema,
  OwnerActionRejectResponseSchema,
  OwnerActionStateSchema,
} from "./owner-action.ts";

const requestedAt = "2026-07-20T18:00:00.000Z";
const expiresAt = "2026-07-21T18:00:00.000Z";
const actionSummary = {
  id: "act_01K0POST",
  version: 3,
  agent: {
    id: "agt_01K0SCOUT",
    handle: "market-scout",
    display_name: "Market Scout",
    status: "active",
  },
  operation: "create_post",
  state: "pending_approval",
  target: { type: "community", id: "com_01K0SEMIS" },
  approval_summary: "Create one post in the Semiconductors community.",
  requested_at: requestedAt,
  expires_at: expiresAt,
  updated_at: requestedAt,
} as const;
const action = {
  ...actionSummary,
  preview: {
    operation: "create_post",
    title: "AMD data-center scenario review",
    body_markdown: "Base case revenue remains sensitive to product mix.",
    primary_community_id: "com_01K0SEMIS",
    additional_community_ids: ["com_01K0CHIPS"],
    symbols: ["AMD"],
    topics: ["semiconductors"],
    source_links: [
      {
        url: "https://example.com/amd-source",
        title: "AMD source",
      },
    ],
    references: [{ target_content_id: "cnt_01K0SOURCE", relation_type: "reference" }],
  },
  input_digest: `sha256:${"a".repeat(64)}`,
  idempotency_key_hint: "hmac-sha256:0123456789ab",
  approval_reason_category: "owner_approval_required",
  decision_id: "dec_01K0POST",
  policy_version: "pol_01ASSISTED:4",
  decided_at: null,
  terminal_at: null,
  approval_outcome: null,
  decision_reason_code: null,
  public_error: null,
} as const;

const envelope = {
  request_id: "req_owner_action_01",
  schema_version: "1",
} as const;

describe("Owner action list and detail contracts", () => {
  it("accepts every durable PendingAction state and structured list filters", () => {
    expect(OwnerActionStateSchema.options).toEqual([
      "pending_approval",
      "approved",
      "executing",
      "succeeded",
      "rejected",
      "expired",
      "cancelled",
      "failed",
      "invalidated",
    ]);
    const request = {
      agent_id: "agt_01K0SCOUT",
      states: [...OwnerActionStateSchema.options],
      operations: ["create_post", "reply_to_content", "update_content", "delete_content"],
      limit: 50,
      cursor: "cursor_01K0ACTIONS",
    } as const;
    expect(OwnerActionListRequestSchema.parse(request)).toEqual(request);

    for (const state of OwnerActionStateSchema.options) {
      const response = {
        items: [{ ...actionSummary, state }],
        page: { next_cursor: null, has_more: false, limit: 50 },
        ...envelope,
      };
      expect(OwnerActionListResponseSchema.safeParse(response).success).toBe(true);
    }
  });

  it("keeps list and detail inputs strict", () => {
    expect(
      OwnerActionListRequestSchema.safeParse({
        states: ["pending_approval", "pending_approval"],
      }).success,
    ).toBe(false);
    expect(
      OwnerActionListRequestSchema.safeParse({
        state: "pending_approval",
      }).success,
    ).toBe(false);
    expect(OwnerActionListRequestSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(
      OwnerActionDetailRequestSchema.safeParse({
        action_id: action.id,
        owner_id: "own_forged",
      }).success,
    ).toBe(false);
  });

  it.each([
    ["pending_approval", action],
    [
      "approved",
      {
        ...action,
        state: "approved",
        decided_at: "2026-07-20T18:01:00.000Z",
        approval_outcome: "approved",
        decision_reason_code: "owner_approved",
      },
    ],
    [
      "executing",
      {
        ...action,
        state: "executing",
        decided_at: "2026-07-20T18:01:00.000Z",
        approval_outcome: "approved",
        decision_reason_code: "owner_approved",
      },
    ],
    [
      "succeeded",
      {
        ...action,
        state: "succeeded",
        decided_at: "2026-07-20T18:01:00.000Z",
        terminal_at: "2026-07-20T18:02:00.000Z",
        approval_outcome: "approved",
        decision_reason_code: "owner_approved",
      },
    ],
    [
      "rejected",
      {
        ...action,
        state: "rejected",
        decided_at: "2026-07-20T18:01:00.000Z",
        terminal_at: "2026-07-20T18:01:00.000Z",
        approval_outcome: "rejected",
        decision_reason_code: "owner_rejected",
        public_error: {
          code: "ACTION_REJECTED",
          message: "The Owner rejected this action.",
          retryable: false,
          details: null,
          retry_after_ms: null,
        },
      },
    ],
    [
      "expired",
      {
        ...action,
        state: "expired",
        terminal_at: "2026-07-21T18:00:00.000Z",
        approval_outcome: "expired",
        public_error: {
          code: "ACTION_EXPIRED",
          message: "The action expired before it could be completed.",
          retryable: false,
          details: null,
          retry_after_ms: null,
        },
      },
    ],
    [
      "cancelled",
      {
        ...action,
        state: "cancelled",
        decided_at: "2026-07-20T18:01:00.000Z",
        terminal_at: "2026-07-20T18:01:00.000Z",
        approval_outcome: "cancelled",
        decision_reason_code: "no_longer_needed",
        public_error: {
          code: "ACTION_CANCELLED",
          message: "The action was cancelled.",
          retryable: false,
          details: null,
          retry_after_ms: null,
        },
      },
    ],
    [
      "failed",
      {
        ...action,
        state: "failed",
        decided_at: "2026-07-20T18:01:00.000Z",
        terminal_at: "2026-07-20T18:02:00.000Z",
        approval_outcome: "approved",
        decision_reason_code: "owner_approved",
        public_error: {
          code: "ACTION_EXECUTION_FAILED",
          message: "The approved action could not be completed.",
          retryable: false,
          details: null,
          retry_after_ms: null,
        },
      },
    ],
    [
      "invalidated",
      {
        ...action,
        state: "invalidated",
        terminal_at: "2026-07-20T18:02:00.000Z",
        approval_outcome: "invalidated",
        public_error: {
          code: "ACTION_INVALIDATED",
          message: "The frozen action is no longer valid.",
          retryable: false,
          details: null,
          retry_after_ms: null,
        },
      },
    ],
  ] as const)("accepts a valid %s detail projection", (_state, detail) => {
    expect(
      OwnerActionDetailResponseSchema.safeParse({
        action: detail,
        ...envelope,
      }).success,
    ).toBe(true);
  });

  it("returns an operation-specific frozen preview without internal secrets", () => {
    const response = { action, ...envelope };
    expect(OwnerActionDetailResponseSchema.parse(response)).toEqual(response);

    const replyAction = {
      ...action,
      operation: "reply_to_content",
      target: { type: "content", id: "cnt_01K0PARENT" },
      preview: {
        operation: "reply_to_content",
        parent_content_id: "cnt_01K0PARENT",
        body_markdown: "A substantive reply with independent evidence.",
        symbols: ["AMD"],
        references: [{ target_content_id: "cnt_01K0SOURCE", relation_type: "reference" }],
      },
    } as const;
    expect(
      OwnerActionDetailResponseSchema.safeParse({
        action: replyAction,
        ...envelope,
      }).success,
    ).toBe(true);

    const updateAction = {
      ...action,
      operation: "update_content",
      target: { type: "content", id: "cnt_01K0POST" },
      preview: {
        operation: "update_content",
        content_id: "cnt_01K0POST",
        expected_version: 2,
        baseline: {
          content_kind: "post",
          resource_version: 2,
          revision_id: "rev_01K0POST",
          title: "AMD data-center scenario review",
          body_markdown: "The original thesis used the prior FX assumptions.",
          primary_community_id: "com_01K0SEMIS",
          additional_community_ids: ["com_01K0CHIPS"],
        },
        patch: {
          body_markdown: "A revised thesis with new FX sensitivity evidence.",
          source_links: [
            {
              url: "https://example.com/revised-source",
              title: "Revised evidence",
            },
          ],
          references: [],
          symbols: ["AMD"],
          topics: ["semiconductors", "fx"],
        },
        edit_summary: "Add FX sensitivity",
      },
    } as const;
    expect(
      OwnerActionDetailResponseSchema.safeParse({
        action: updateAction,
        ...envelope,
      }).success,
    ).toBe(true);

    const deleteAction = {
      ...action,
      operation: "delete_content",
      target: { type: "content", id: "cnt_01K0POST" },
      preview: {
        operation: "delete_content",
        content_id: "cnt_01K0POST",
        expected_version: 2,
        mode: "permanent",
        reason: "Superseded by a corrected research post.",
      },
    } as const;
    expect(
      OwnerActionDetailResponseSchema.safeParse({
        action: deleteAction,
        ...envelope,
      }).success,
    ).toBe(true);
    expect(
      OwnerActionDetailResponseSchema.safeParse({
        action: {
          ...deleteAction,
          preview: { ...deleteAction.preview, expected_version: undefined },
        },
        ...envelope,
      }).success,
    ).toBe(false);
    expect(
      OwnerActionDetailResponseSchema.safeParse({
        action: {
          ...deleteAction,
          preview: { ...deleteAction.preview, reason: "<img src=x onerror=alert(1)>" },
        },
        ...envelope,
      }).success,
    ).toBe(true);
    expect(
      OwnerActionDetailResponseSchema.safeParse({
        action: {
          ...deleteAction,
          preview: { ...deleteAction.preview, reason: "not trimmed " },
        },
        ...envelope,
      }).success,
    ).toBe(false);

    expect(
      OwnerActionDetailResponseSchema.safeParse({
        action: {
          ...updateAction,
          preview: { ...updateAction.preview, expected_version: undefined },
        },
        ...envelope,
      }).success,
    ).toBe(false);
    expect(
      OwnerActionDetailResponseSchema.safeParse({
        action: {
          ...updateAction,
          preview: { ...updateAction.preview, patch: {} },
        },
        ...envelope,
      }).success,
    ).toBe(false);

    for (const [field, value] of [
      ["normalized_input_ciphertext", "ciphertext"],
      ["normalized_input_nonce", "nonce"],
      ["normalized_input_key_version", 2],
      ["idempotency_key", "raw-idempotency-key"],
      ["policy_snapshot", { internal: true }],
      ["lease_owner", "worker-1"],
      ["lease_token", "lease-secret"],
      ["lease_token_digest", "digest"],
    ] as const) {
      expect(
        OwnerActionDetailResponseSchema.safeParse({
          action: { ...action, [field]: value },
          ...envelope,
        }).success,
      ).toBe(false);
      expect(
        OwnerActionDetailResponseSchema.safeParse({
          action: {
            ...action,
            preview: { ...action.preview, [field]: value },
          },
          ...envelope,
        }).success,
      ).toBe(false);
    }
  });

  it("requires the outer operation, target, and frozen preview to agree", () => {
    expect(
      OwnerActionDetailResponseSchema.safeParse({
        action: {
          ...action,
          preview: {
            operation: "reply_to_content",
            parent_content_id: "cnt_01K0PARENT",
            body_markdown: "A substantive reply.",
          },
        },
        ...envelope,
      }).success,
    ).toBe(false);
    expect(
      OwnerActionDetailResponseSchema.safeParse({
        action: {
          ...action,
          target: { type: "content", id: "cnt_01K0PARENT" },
        },
        ...envelope,
      }).success,
    ).toBe(false);

    expect(
      OwnerActionDetailResponseSchema.safeParse({
        action: {
          ...action,
          operation: "update_content",
          target: { type: "content", id: "cnt_01K0POST" },
          preview: {
            operation: "update_content",
            content_id: "cnt_01K0OTHER",
            expected_version: 2,
            patch: { body_markdown: "A revised research thesis." },
          },
        },
        ...envelope,
      }).success,
    ).toBe(false);

    expect(
      OwnerActionDetailResponseSchema.safeParse({
        action: {
          ...action,
          operation: "delete_content",
          target: { type: "content", id: "cnt_01K0POST" },
          preview: {
            operation: "delete_content",
            content_id: "cnt_01K0OTHER",
            expected_version: 2,
            mode: "soft",
          },
        },
        ...envelope,
      }).success,
    ).toBe(false);
  });

  it.each(["no_longer_needed", "owner_approved"] as const)(
    "accepts cancelled actions with durable reason %s",
    (decisionReasonCode) => {
      const cancelledAction = {
        ...action,
        state: "cancelled",
        decided_at: "2026-07-20T18:01:00.000Z",
        terminal_at: "2026-07-20T18:01:00.000Z",
        approval_outcome: "cancelled",
        decision_reason_code: decisionReasonCode,
        public_error: {
          code: "ACTION_CANCELLED",
          message: "The action was cancelled.",
          retryable: false,
          details: null,
          retry_after_ms: null,
        },
      } as const;

      expect(
        OwnerActionDetailResponseSchema.safeParse({
          action: cancelledAction,
          ...envelope,
        }).success,
      ).toBe(true);
    },
  );

  it.each([null, "owner_rejected"] as const)(
    "rejects cancelled actions with non-durable reason %s",
    (decisionReasonCode) => {
      expect(
        OwnerActionDetailResponseSchema.safeParse({
          action: {
            ...action,
            state: "cancelled",
            decided_at: "2026-07-20T18:01:00.000Z",
            terminal_at: "2026-07-20T18:01:00.000Z",
            approval_outcome: "cancelled",
            decision_reason_code: decisionReasonCode,
            public_error: {
              code: "ACTION_CANCELLED",
              message: "The action was cancelled.",
              retryable: false,
              details: null,
              retry_after_ms: null,
            },
          },
          ...envelope,
        }).success,
      ).toBe(false);
    },
  );
});

describe("Owner action decision contracts", () => {
  it("accepts only expected_version plus the single approval reason", () => {
    expect(
      OwnerActionApproveRequestSchema.parse({
        expected_version: 3,
        reason_code: "owner_approved",
      }),
    ).toEqual({ expected_version: 3, reason_code: "owner_approved" });
    expect(
      OwnerActionApproveRequestSchema.safeParse({
        expected_version: 3,
        reason_code: "owner_approved",
        comment: "free text is not accepted",
      }).success,
    ).toBe(false);
    expect(
      OwnerActionApproveRequestSchema.safeParse({
        expected_version: 3,
        reason_code: "needs_revision",
      }).success,
    ).toBe(false);
  });

  it.each([
    "owner_rejected",
    "needs_revision",
    "insufficient_evidence",
    "risk_not_accepted",
    "no_longer_needed",
  ] as const)("accepts controlled rejection reason %s", (reasonCode) => {
    expect(
      OwnerActionRejectRequestSchema.parse({
        expected_version: 3,
        reason_code: reasonCode,
      }),
    ).toEqual({ expected_version: 3, reason_code: reasonCode });
  });

  it("rejects free-text and unbounded rejection reasons", () => {
    expect(
      OwnerActionRejectRequestSchema.safeParse({
        expected_version: 3,
        reason_code: "other",
        reason: "Please reject this request.",
      }).success,
    ).toBe(false);
    expect(
      OwnerActionRejectRequestSchema.safeParse({
        expected_version: 0,
        reason_code: "owner_rejected",
      }).success,
    ).toBe(false);
  });

  it("requires decision responses to carry matching controlled reason codes", () => {
    const approvedAction = {
      ...action,
      state: "approved",
      decided_at: "2026-07-20T18:01:00.000Z",
      approval_outcome: "approved",
      decision_reason_code: "owner_approved",
    } as const;
    const rejectedAction = {
      ...action,
      state: "rejected",
      decided_at: "2026-07-20T18:01:00.000Z",
      terminal_at: "2026-07-20T18:01:00.000Z",
      approval_outcome: "rejected",
      decision_reason_code: "insufficient_evidence",
      public_error: {
        code: "ACTION_REJECTED",
        message: "The Owner rejected this action.",
        retryable: false,
        details: null,
        retry_after_ms: null,
      },
    } as const;
    const succeededReplay = {
      ...approvedAction,
      state: "succeeded",
      terminal_at: "2026-07-20T18:02:00.000Z",
    } as const;

    expect(
      OwnerActionApproveResponseSchema.safeParse({
        action: approvedAction,
        ...envelope,
      }).success,
    ).toBe(true);
    expect(
      OwnerActionRejectResponseSchema.safeParse({
        action: rejectedAction,
        ...envelope,
      }).success,
    ).toBe(true);
    expect(
      OwnerActionApproveResponseSchema.safeParse({
        action: succeededReplay,
        ...envelope,
      }).success,
    ).toBe(true);
    expect(
      OwnerActionApproveResponseSchema.safeParse({
        action: rejectedAction,
        ...envelope,
      }).success,
    ).toBe(false);
  });
});
