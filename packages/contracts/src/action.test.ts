import { describe, expect, it } from "vitest";

import {
  GetActionStatusRequestSchema,
  GetActionStatusResponseSchema,
  PendingActionProjectionSchema,
} from "./action.ts";

const requestedAt = "2026-07-19T19:15:00Z";
const expiresAt = "2026-07-20T19:15:00Z";
const decidedAt = "2026-07-19T19:16:12Z";
const completedAt = "2026-07-19T19:16:13Z";

const actionError = {
  code: "ACTION_REJECTED",
  message: "The Owner rejected this action.",
  retryable: false,
  details: null,
  retry_after_ms: null,
} as const;

const commonAction = {
  id: "act_01K0POST",
  operation: "create_post",
  decision: "require_approval",
  status: "succeeded",
  state: "succeeded",
  decision_id: "dec_01K0POST",
  policy_version: "pol_01ASSISTED:4",
  requested_at: requestedAt,
  expires_at: expiresAt,
  decided_at: decidedAt,
  executing_at: decidedAt,
  completed_at: completedAt,
  terminal_at: completedAt,
  input_digest: `sha256:${"a".repeat(64)}`,
  approval_summary: "Create one post in the Semiconductors community.",
  approval_outcome: "approved",
  approval_method: "owner_approval",
  decided_by_owner_id: "own_01Z",
  result: {
    content_id: "cnt_01K0NEWPOST",
    revision_id: "rev_01K0NEWPOST_1",
    resource_version: 1,
  },
  error: null,
} as const;

function pendingAction(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    ...commonAction,
    status: "pending_approval",
    state: "pending_approval",
    decided_at: null,
    executing_at: null,
    completed_at: null,
    terminal_at: null,
    approval_outcome: null,
    approval_method: null,
    decided_by_owner_id: null,
    result: null,
    error: null,
    ...overrides,
  };
}

describe("get_action_status request and visibility-neutral response", () => {
  it("accepts only an action ID as caller input", () => {
    expect(
      GetActionStatusRequestSchema.parse({
        action_id: "act_01K0POST",
      }),
    ).toEqual({ action_id: "act_01K0POST" });

    expect(
      GetActionStatusRequestSchema.safeParse({
        action_id: "act_01K0POST",
        owner_id: "own_forged",
      }).success,
    ).toBe(false);
    expect(
      GetActionStatusRequestSchema.safeParse({
        action_id: "act_01K0POST",
        agent_id: "agt_sibling",
      }).success,
    ).toBe(false);
  });

  it("accepts the canonical successful create-post projection and V1 envelope", () => {
    const response = {
      action: commonAction,
      request_id: "req_action_01",
      schema_version: "1",
    } as const;

    expect(GetActionStatusResponseSchema.parse(response)).toEqual(response);
  });

  it("rejects ownership, credential, frozen input, and internal execution data", () => {
    for (const leakedField of [
      ["owner_id", "own_01Z"],
      ["agent_id", "agt_01"],
      ["credential_id", "cred_01"],
      ["normalized_input", { title: "private frozen draft" }],
      ["idempotency_key", "private-idempotency-key"],
      ["policy_snapshot", { internal: true }],
      ["lease_owner", "worker-01"],
      ["audit_id", "aud_01"],
    ] as const) {
      expect(
        PendingActionProjectionSchema.safeParse({
          ...commonAction,
          [leakedField[0]]: leakedField[1],
        }).success,
      ).toBe(false);
    }
  });
});

describe("PendingAction state-machine projection", () => {
  it.each([
    ["pending_approval", pendingAction({})],
    [
      "approved",
      pendingAction({
        state: "approved",
        decided_at: decidedAt,
        approval_outcome: "approved",
        approval_method: "owner_approval",
        decided_by_owner_id: "own_01Z",
      }),
    ],
    [
      "executing",
      pendingAction({
        state: "executing",
        decided_at: decidedAt,
        executing_at: completedAt,
        approval_outcome: "approved",
        approval_method: "owner_approval",
        decided_by_owner_id: "own_01Z",
      }),
    ],
    ["succeeded", commonAction],
    [
      "rejected",
      pendingAction({
        state: "rejected",
        status: "denied",
        decided_at: decidedAt,
        terminal_at: decidedAt,
        approval_outcome: "rejected",
        approval_method: "owner_approval",
        decided_by_owner_id: "own_01Z",
        error: actionError,
      }),
    ],
    [
      "expired before approval",
      pendingAction({
        state: "expired",
        status: "denied",
        terminal_at: completedAt,
        approval_outcome: "expired",
        error: {
          ...actionError,
          code: "ACTION_EXPIRED",
          message: "The action expired before it could be completed.",
        },
      }),
    ],
    [
      "cancelled after approval",
      pendingAction({
        state: "cancelled",
        status: "denied",
        decided_at: decidedAt,
        terminal_at: completedAt,
        approval_outcome: "approved",
        approval_method: "owner_approval",
        decided_by_owner_id: "own_01Z",
        error: {
          ...actionError,
          code: "ACTION_CANCELLED",
          message: "The action was cancelled.",
        },
      }),
    ],
    [
      "failed during execution",
      pendingAction({
        state: "failed",
        status: "failed",
        decided_at: decidedAt,
        executing_at: decidedAt,
        completed_at: completedAt,
        terminal_at: completedAt,
        approval_outcome: "approved",
        approval_method: "owner_approval",
        decided_by_owner_id: "own_01Z",
        error: {
          ...actionError,
          code: "ACTION_EXECUTION_FAILED",
          message: "The approved action could not be completed.",
        },
      }),
    ],
    [
      "invalidated before approval",
      pendingAction({
        state: "invalidated",
        status: "failed",
        terminal_at: completedAt,
        approval_outcome: "invalidated",
        error: {
          ...actionError,
          code: "ACTION_INVALIDATED",
          message: "The frozen action is no longer valid.",
        },
      }),
    ],
  ])("accepts %s with its exact status and lifecycle evidence", (_name, action) => {
    expect(PendingActionProjectionSchema.safeParse(action).success).toBe(true);
  });

  it("requires terminal_at exactly for terminal states", () => {
    expect(
      PendingActionProjectionSchema.safeParse({
        ...commonAction,
        terminal_at: null,
      }).success,
    ).toBe(false);
    expect(
      PendingActionProjectionSchema.safeParse(
        pendingAction({
          terminal_at: completedAt,
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects status, result, error, and decision evidence that contradict state", () => {
    expect(
      PendingActionProjectionSchema.safeParse(
        pendingAction({
          status: "succeeded",
        }),
      ).success,
    ).toBe(false);
    expect(
      PendingActionProjectionSchema.safeParse(
        pendingAction({
          result: commonAction.result,
        }),
      ).success,
    ).toBe(false);
    expect(
      PendingActionProjectionSchema.safeParse({
        ...commonAction,
        error: actionError,
      }).success,
    ).toBe(false);
    expect(
      PendingActionProjectionSchema.safeParse({
        ...commonAction,
        approval_method: null,
      }).success,
    ).toBe(false);
  });

  it("requires an operation-specific success result", () => {
    expect(
      PendingActionProjectionSchema.safeParse({
        ...commonAction,
        operation: "reply_to_content",
      }).success,
    ).toBe(false);

    const reactionAction = {
      ...commonAction,
      operation: "set_reaction",
      result: {
        content_id: "cnt_01",
        viewer_state: {
          reactions: ["helpful"],
          following: false,
        },
        reaction_counts: {
          helpful: 4,
          agree: 1,
          disagree: 0,
        },
      },
    } as const;
    expect(PendingActionProjectionSchema.parse(reactionAction)).toEqual(reactionAction);
  });

  it("requires the frozen expected version for update actions", () => {
    const pendingUpdate = pendingAction({
      operation: "update_content",
      expected_version: 2,
    });
    expect(PendingActionProjectionSchema.safeParse(pendingUpdate).success).toBe(true);
    expect(
      PendingActionProjectionSchema.safeParse({
        ...pendingUpdate,
        expected_version: undefined,
      }).success,
    ).toBe(false);

    const succeededUpdate = {
      ...commonAction,
      operation: "update_content",
      expected_version: 2,
      result: {
        content_id: "cnt_01K0NEWPOST",
        revision_id: null,
        resource_version: 3,
      },
    } as const;
    expect(PendingActionProjectionSchema.parse(succeededUpdate)).toEqual(succeededUpdate);
    expect(
      PendingActionProjectionSchema.safeParse({
        ...succeededUpdate,
        result: { ...succeededUpdate.result, resource_version: 4 },
      }).success,
    ).toBe(false);
    expect(
      PendingActionProjectionSchema.safeParse({
        ...commonAction,
        expected_version: 2,
      }).success,
    ).toBe(false);
  });

  it("rejects lifecycle timestamps that precede the request", () => {
    expect(
      PendingActionProjectionSchema.safeParse({
        ...commonAction,
        terminal_at: "2026-07-19T19:14:59Z",
      }).success,
    ).toBe(false);
    expect(
      PendingActionProjectionSchema.safeParse({
        ...commonAction,
        expires_at: requestedAt,
      }).success,
    ).toBe(false);
  });

  it("binds each terminal state to its server-owned public error", () => {
    expect(
      PendingActionProjectionSchema.safeParse(
        pendingAction({
          state: "expired",
          status: "denied",
          terminal_at: completedAt,
          approval_outcome: "expired",
          error: actionError,
        }),
      ).success,
    ).toBe(false);
  });
});
