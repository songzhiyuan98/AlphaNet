import { describe, expect, it } from "vitest";

import {
  FollowListRequestSchema,
  FollowListResponseSchema,
  FollowProjectionSchema,
  SetFollowPathParamsSchema,
  SetFollowRequestSchema,
  SetFollowWriteResultSchema,
} from "./follow.ts";
import { UnifiedContentWriteResultSchema } from "./content-write.ts";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  follow: "20000000-0000-4000-8000-000000000001",
} as const;
const timestamp = "2026-07-21T18:00:00.000Z";

describe("Follow request contracts", () => {
  it("accepts all four target types and keeps target normalization in the domain", () => {
    for (const target_type of ["actor", "symbol", "topic", "content"] as const) {
      expect(
        SetFollowPathParamsSchema.parse({
          target_type,
          target_id: target_type === "symbol" ? "mu" : ids.actor,
        }),
      ).toEqual({
        target_type,
        target_id: target_type === "symbol" ? "mu" : ids.actor,
      });
    }
  });

  it("accepts follow, preference update, and unfollow requests", () => {
    expect(
      SetFollowRequestSchema.parse({
        active: true,
        idempotency_key: "follow-mu-1",
      }),
    ).toEqual({ active: true, idempotency_key: "follow-mu-1" });
    expect(
      SetFollowRequestSchema.parse({
        active: true,
        notification_level: "all_events",
        idempotency_key: "follow-mu-2",
      }),
    ).toEqual({
      active: true,
      notification_level: "all_events",
      idempotency_key: "follow-mu-2",
    });
    expect(
      SetFollowRequestSchema.parse({
        active: false,
        notification_level: "new_posts",
        idempotency_key: "unfollow-mu-1",
      }),
    ).toEqual({
      active: false,
      notification_level: "new_posts",
      idempotency_key: "unfollow-mu-1",
    });
  });

  it("rejects unknown target types, blank keys, and unknown fields", () => {
    expect(
      SetFollowPathParamsSchema.safeParse({ target_type: "community", target_id: "mu" })
        .success,
    ).toBe(false);
    expect(
      SetFollowRequestSchema.safeParse({ active: true, idempotency_key: "   " }).success,
    ).toBe(false);
    expect(
      SetFollowRequestSchema.safeParse({
        active: true,
        idempotency_key: "key",
        follower_actor_id: ids.actor,
      }).success,
    ).toBe(false);
  });
});

describe("Follow result contracts", () => {
  const activeResult = {
    decision: "allow",
    error: null,
    pending_action: null,
    request_id: "request-1",
    result: {
      active: true,
      notification_level: "feed_only",
      target_id: "MU",
      target_type: "symbol",
      updated_at: timestamp,
    },
    schema_version: "1",
    status: "succeeded",
  } as const;

  it("requires an active result to carry a notification level", () => {
    expect(SetFollowWriteResultSchema.parse(activeResult)).toEqual(activeResult);
    expect(UnifiedContentWriteResultSchema.parse(activeResult)).toEqual(activeResult);
    expect(
      SetFollowWriteResultSchema.safeParse({
        ...activeResult,
        result: { ...activeResult.result, notification_level: null },
      }).success,
    ).toBe(false);
  });

  it("requires an inactive result to clear its notification level", () => {
    const inactive = {
      ...activeResult,
      result: {
        ...activeResult.result,
        active: false,
        notification_level: null,
      },
    } as const;
    expect(SetFollowWriteResultSchema.parse(inactive)).toEqual(inactive);
    expect(
      SetFollowWriteResultSchema.safeParse({
        ...inactive,
        result: { ...inactive.result, notification_level: "feed_only" },
      }).success,
    ).toBe(false);
  });

  it("accepts structured denials and never exposes a PendingAction", () => {
    const denied = {
      ...activeResult,
      decision: "deny",
      error: {
        code: "POLICY_DENIED",
        details: null,
        message: "The current Agent policy denies Follow writes.",
        retry_after_ms: null,
        retryable: false,
      },
      result: null,
      status: "denied",
    } as const;
    expect(SetFollowWriteResultSchema.parse(denied)).toEqual(denied);
    expect(
      SetFollowWriteResultSchema.safeParse({
        ...denied,
        pending_action: { id: ids.follow },
      }).success,
    ).toBe(false);
  });
});

describe("Follow list contracts", () => {
  const projection = {
    created_at: timestamp,
    follow_id: ids.follow,
    notification_level: "new_posts",
    target_id: "MU",
    target_type: "symbol",
    updated_at: timestamp,
  } as const;

  it("projects only active canonical relationships", () => {
    expect(FollowProjectionSchema.parse(projection)).toEqual(projection);
    expect(
      FollowProjectionSchema.safeParse({ ...projection, active: true }).success,
    ).toBe(false);
  });

  it("supports optional target filtering and bounded cursor pagination", () => {
    expect(FollowListRequestSchema.parse({})).toEqual({});
    expect(
      FollowListRequestSchema.parse({ target_type: "topic", limit: 100, cursor: null }),
    ).toEqual({ target_type: "topic", limit: 100, cursor: null });
    expect(FollowListRequestSchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("requires a stable ordering snapshot and cursor invariants", () => {
    const response = {
      items: [projection],
      ordering: {
        as_of: timestamp,
        ordering_version: "follow-list-v1",
        snapshot_id: "snapshot-1",
      },
      page: {
        has_more: false,
        limit: 20,
        next_cursor: null,
      },
      request_id: "request-1",
      schema_version: "1",
    } as const;
    expect(FollowListResponseSchema.parse(response)).toEqual(response);
    expect(
      FollowListResponseSchema.safeParse({
        ...response,
        page: { ...response.page, has_more: true },
      }).success,
    ).toBe(false);
    expect(
      FollowListResponseSchema.safeParse({
        ...response,
        items: [projection, projection],
      }).success,
    ).toBe(false);
  });
});
