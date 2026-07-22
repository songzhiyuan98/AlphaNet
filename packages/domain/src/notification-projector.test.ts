import type { OutboxEvent, PostgresClient } from "@alphanet/database";
import { describe, expect, it } from "vitest";

import { PostgresNotificationProjector } from "./notification-projector.js";

const authorActorId = "10000000-0000-4000-8000-000000000001";
const parentAuthorActorId = "10000000-0000-4000-8000-000000000002";
const mentionedFollowerActorId = "10000000-0000-4000-8000-000000000003";
const followOnlyActorId = "10000000-0000-4000-8000-000000000004";
const contentId = "20000000-0000-4000-8000-000000000001";
const parentContentId = "20000000-0000-4000-8000-000000000002";
const rootContentId = "20000000-0000-4000-8000-000000000003";
const revisionId = "30000000-0000-4000-8000-000000000001";
const communityId = "40000000-0000-4000-8000-000000000001";
const symbolId = "50000000-0000-4000-8000-000000000001";
const removedSymbolId = "50000000-0000-4000-8000-000000000002";
const followIds = {
  primary: "60000000-0000-4000-8000-000000000001",
  additional: "60000000-0000-4000-8000-000000000002",
  followOnly: "60000000-0000-4000-8000-000000000003",
  self: "60000000-0000-4000-8000-000000000004",
} as const;
const eventId = "70000000-0000-4000-8000-000000000001";
const notificationId = "80000000-0000-4000-8000-000000000001";
const occurredAt = new Date("2026-07-21T18:09:30.000Z");

interface Query {
  text: string;
  values: unknown[];
}

interface ContentFact {
  author_actor_id: string;
  community_ids: string[];
  content_id: string;
  current_revision_id: string;
  distribution_state: string;
  kind: "post" | "reply";
  lifecycle_state: string;
  parent_author_actor_id: string | null;
  parent_id: string | null;
  root_id: string;
  symbol_ids: string[];
  symbols: string[];
  topic_ids: string[];
  topic_slugs: string[];
}

interface FollowRow {
  follow_id: string;
  follower_actor_id: string;
  notification_level: "new_posts" | "all_events";
  target_id: string;
  target_type: "actor" | "symbol" | "topic" | "content";
}

function fakeSql(responder: (query: Query) => unknown[] | Promise<unknown[]>): {
  calls: Query[];
  sql: PostgresClient;
} {
  const calls: Query[] = [];
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join("?"), values };
    calls.push(query);
    return responder(query);
  };
  const sql = tag as typeof tag & {
    array(values: readonly unknown[]): unknown;
    begin<T>(callback: (transaction: typeof sql) => Promise<T>): Promise<T>;
    json(value: unknown): unknown;
  };
  sql.array = (values) => [...values];
  sql.begin = async (callback) => callback(sql);
  sql.json = (value) => value;
  return { calls, sql: sql as unknown as PostgresClient };
}

function contentFact(overrides: Partial<ContentFact> = {}): ContentFact {
  return {
    author_actor_id: authorActorId,
    community_ids: [communityId],
    content_id: contentId,
    current_revision_id: revisionId,
    distribution_state: "normal",
    kind: "post",
    lifecycle_state: "published",
    parent_author_actor_id: null,
    parent_id: null,
    root_id: contentId,
    symbol_ids: [symbolId],
    symbols: ["MU"],
    topic_ids: [],
    topic_slugs: [],
    ...overrides,
  };
}

function outboxEvent(
  eventType: OutboxEvent["eventType"],
  payload: Record<string, unknown>,
  aggregateSequence = "37",
): OutboxEvent {
  return {
    aggregateId: contentId,
    aggregateSequence,
    aggregateType: "content",
    attempts: 1,
    eventType,
    eventVersion: 1,
    id: eventId,
    leaseExpiresAt: new Date(occurredAt.valueOf() + 30_000),
    maxAttempts: 12,
    occurredAt,
    payload,
  };
}

function contentEventPayload(extra: Record<string, unknown> = {}) {
  return {
    actor_id: authorActorId,
    community_ids: [communityId],
    content_id: contentId,
    revision_id: revisionId,
    root_content_id: rootContentId,
    symbol_ids: [symbolId],
    topic_ids: [],
    ...extra,
  };
}

function projectorHarness(options: {
  content: ContentFact;
  follows?: readonly FollowRow[];
  mentions?: readonly string[];
}) {
  return fakeSql((query) => {
    if (query.text.includes("from platform.content_items as content")) {
      return [options.content];
    }
    if (query.text.includes("from platform.symbols as symbol")) {
      return [{ id: symbolId, value: "MU" }];
    }
    if (query.text.includes("from platform.topics as topic")) return [];
    if (query.text.includes("from platform.follows as follow")) {
      return [...(options.follows ?? [])];
    }
    if (query.text.includes("from platform.mentions as mention")) {
      return (options.mentions ?? []).map((actor_id) => ({ actor_id }));
    }
    if (query.text.includes("from system.project_notification(")) {
      return [{ id: notificationId }];
    }
    if (query.text.includes("from system.project_reaction_notification(")) {
      return [{ id: notificationId }];
    }
    return [];
  });
}

function projectionCalls(calls: readonly Query[]): Query[] {
  return calls.filter((call) => call.text.includes("from system.project_notification("));
}

function projectedContext(call: Query): Record<string, unknown> {
  return call.values[11] as Record<string, unknown>;
}

describe("PostgresNotificationProjector recipient collapse", () => {
  it("prefers a mention over a published Follow and preserves every Follow match", async () => {
    const harness = projectorHarness({
      content: contentFact(),
      follows: [
        {
          follow_id: followIds.primary,
          follower_actor_id: mentionedFollowerActorId,
          notification_level: "all_events",
          target_id: "MU",
          target_type: "symbol",
        },
        {
          follow_id: followIds.additional,
          follower_actor_id: mentionedFollowerActorId,
          notification_level: "all_events",
          target_id: "memory",
          target_type: "topic",
        },
      ],
      mentions: [mentionedFollowerActorId],
    });
    const projector = new PostgresNotificationProjector(harness.sql);

    await expect(
      projector.project(outboxEvent("content.published", contentEventPayload())),
    ).resolves.toMatchObject({ accepted: true, projected: 1 });

    const calls = projectionCalls(harness.calls);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toMatchObject({
      1: mentionedFollowerActorId,
      2: "content.mention",
      8: "symbol",
      9: "MU",
      10: "all_events",
      14: `content.mention:${eventId}:${mentionedFollowerActorId}`,
    });
    expect(projectedContext(calls[0]!)).toMatchObject({
      matched_follow: {
        notification_level: "all_events",
        target_id: "MU",
        target_type: "symbol",
      },
      additional_matched_follow_ids: [followIds.additional],
    });
  });

  it("prefers the direct reply over mention and Follow, then mention over Follow", async () => {
    const harness = projectorHarness({
      content: contentFact({
        kind: "reply",
        parent_author_actor_id: parentAuthorActorId,
        parent_id: parentContentId,
        root_id: rootContentId,
      }),
      follows: [
        {
          follow_id: followIds.primary,
          follower_actor_id: parentAuthorActorId,
          notification_level: "all_events",
          target_id: rootContentId,
          target_type: "content",
        },
        {
          follow_id: followIds.additional,
          follower_actor_id: mentionedFollowerActorId,
          notification_level: "all_events",
          target_id: authorActorId,
          target_type: "actor",
        },
      ],
      mentions: [parentAuthorActorId, mentionedFollowerActorId],
    });
    const projector = new PostgresNotificationProjector(harness.sql);

    await expect(
      projector.project(
        outboxEvent(
          "content.reply",
          contentEventPayload({ parent_content_id: parentContentId }),
        ),
      ),
    ).resolves.toMatchObject({ accepted: true, projected: 2 });

    const calls = projectionCalls(harness.calls);
    expect(calls).toHaveLength(2);
    const direct = calls.find((call) => call.values[1] === parentAuthorActorId);
    const mention = calls.find((call) => call.values[1] === mentionedFollowerActorId);
    expect(direct?.values).toMatchObject({
      2: "content.reply",
      8: "content",
      14: `content.reply:${eventId}:${parentAuthorActorId}`,
    });
    expect(mention?.values).toMatchObject({
      2: "content.mention",
      8: "actor",
      14: `content.mention:${eventId}:${mentionedFollowerActorId}`,
    });
    expect(projectedContext(direct!)).toHaveProperty(
      "matched_follow.target_type",
      "content",
    );
    expect(projectedContext(mention!)).toHaveProperty(
      "matched_follow.target_type",
      "actor",
    );
  });

  it("prefers a revision mention while retaining a separate Follow-only recipient", async () => {
    const harness = projectorHarness({
      content: contentFact(),
      follows: [
        {
          follow_id: followIds.primary,
          follower_actor_id: mentionedFollowerActorId,
          notification_level: "all_events",
          target_id: authorActorId,
          target_type: "actor",
        },
        {
          follow_id: followIds.followOnly,
          follower_actor_id: followOnlyActorId,
          notification_level: "all_events",
          target_id: contentId,
          target_type: "content",
        },
      ],
      mentions: [mentionedFollowerActorId],
    });
    const projector = new PostgresNotificationProjector(harness.sql);

    await expect(
      projector.project(
        outboxEvent(
          "content.revised",
          contentEventPayload({ changed_groups: ["body_markdown"] }),
        ),
      ),
    ).resolves.toMatchObject({ accepted: true, projected: 2 });

    const calls = projectionCalls(harness.calls);
    expect(calls).toHaveLength(2);
    expect(
      calls.find((call) => call.values[1] === mentionedFollowerActorId)?.values[2],
    ).toBe("content.mention");
    expect(calls.find((call) => call.values[1] === followOnlyActorId)?.values[2]).toBe(
      "content.revised",
    );
    for (const call of calls) {
      expect(projectedContext(call)).toHaveProperty("matched_follow");
    }
  });

  it("matches revised Follow targets removed by the classification change", async () => {
    const harness = projectorHarness({
      content: contentFact(),
      follows: [
        {
          follow_id: followIds.primary,
          follower_actor_id: followOnlyActorId,
          notification_level: "all_events",
          target_id: "MU-REMOVED",
          target_type: "symbol",
        },
      ],
    });
    const projector = new PostgresNotificationProjector(harness.sql);

    await expect(
      projector.project(
        outboxEvent(
          "content.revised",
          contentEventPayload({
            affected_symbol_ids: [symbolId, removedSymbolId].sort(),
            affected_topic_ids: [],
            changed_groups: ["symbols"],
          }),
        ),
      ),
    ).resolves.toMatchObject({ accepted: true, projected: 1 });

    const followQuery = harness.calls.find((call) =>
      call.text.includes("from platform.follows as follow"),
    );
    expect(followQuery?.values).toContainEqual([removedSymbolId, symbolId].sort());
    expect(projectionCalls(harness.calls)[0]?.values[2]).toBe("content.revised");
  });

  it("suppresses self notification even if a malformed query result repeats self roles", async () => {
    const harness = projectorHarness({
      content: contentFact({
        kind: "reply",
        parent_author_actor_id: authorActorId,
        parent_id: parentContentId,
        root_id: rootContentId,
      }),
      follows: [
        {
          follow_id: followIds.self,
          follower_actor_id: authorActorId,
          notification_level: "all_events",
          target_id: authorActorId,
          target_type: "actor",
        },
      ],
      mentions: [authorActorId],
    });
    const projector = new PostgresNotificationProjector(harness.sql);

    await expect(
      projector.project(
        outboxEvent(
          "content.reply",
          contentEventPayload({ parent_content_id: parentContentId }),
        ),
      ),
    ).resolves.toMatchObject({ accepted: true, projected: 0 });
    expect(projectionCalls(harness.calls)).toHaveLength(0);
  });
});

describe("PostgresNotificationProjector reaction sequence", () => {
  it("checks the nine-argument function and passes aggregate sequence as the fence", async () => {
    const readiness = fakeSql((query) =>
      query.text.includes("as ready") ? [{ ready: true }] : [],
    );
    const readyProjector = new PostgresNotificationProjector(readiness.sql);
    await expect(readyProjector.checkReady()).resolves.toBeUndefined();
    expect(readiness.calls[0]?.text).toContain("timestamp with time zone,bigint)");

    const harness = projectorHarness({ content: contentFact() });
    const projector = new PostgresNotificationProjector(harness.sql);
    await expect(
      projector.project(
        outboxEvent("reaction.changed", {
          active: true,
          actor_id: mentionedFollowerActorId,
          changed: true,
          content_id: contentId,
          reaction: "helpful",
        }),
      ),
    ).resolves.toMatchObject({ accepted: true, projected: 1 });

    const call = harness.calls.find((candidate) =>
      candidate.text.includes("from system.project_reaction_notification("),
    );
    expect(call?.values[8]).toBe("37");
  });
});
