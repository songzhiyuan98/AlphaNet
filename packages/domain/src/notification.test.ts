import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it } from "vitest";

import { NotificationError, PostgresNotificationService } from "./notification.js";

interface QueryCall {
  text: string;
  values: readonly unknown[];
}

type QueryResponder = (
  text: string,
  values: readonly unknown[],
  calls: readonly QueryCall[],
) => readonly unknown[] | Promise<readonly unknown[]>;

interface TestSql {
  <T extends readonly unknown[]>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<T>;
  array(value: readonly unknown[]): readonly unknown[];
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
    const call = { text, values };
    calls.push(call);
    return (await responder(text, values, calls)) as T;
  }) as TestSql;
  query.array = (value) => value;
  query.begin = async <T>(callback: (transaction: TestSql) => Promise<T>): Promise<T> =>
    callback(query);

  return { calls, sql: query as unknown as PostgresClient };
}

const ownerId = "10000000-0000-4000-8000-000000000001";
const otherOwnerId = "10000000-0000-4000-8000-000000000002";
const agentId = "20000000-0000-4000-8000-000000000001";
const actorId = "30000000-0000-4000-8000-000000000001";
const otherActorId = "30000000-0000-4000-8000-000000000002";
const contentId = "40000000-0000-4000-8000-000000000001";
const communityId = "50000000-0000-4000-8000-000000000001";
const triggerActorId = "60000000-0000-4000-8000-000000000001";
const notificationId1 = "70000000-0000-4000-8000-000000000001";
const notificationId2 = "70000000-0000-4000-8000-000000000002";
const notificationId3 = "70000000-0000-4000-8000-000000000003";
const now = new Date("2026-07-21T18:00:00.000Z");
const sequenceAsOf = new Date("2026-07-21T17:59:59.000Z");

function service(sql: PostgresClient) {
  return new PostgresNotificationService(sql, {
    clock: () => now,
    cursorSigningKey: Buffer.alloc(32, 17),
  });
}

function notificationRow(id: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    aggregate_agent_count: null,
    aggregate_distinct_actor_count: null,
    aggregate_human_count: null,
    change_sequence: "10",
    community_ids: [communityId],
    context: { research_path: "supply-chain", private_hint: "redact-me" },
    created_at: new Date("2026-07-21T17:58:00.000Z"),
    created_sequence: "5",
    dedupe_key: `notification:${id}`,
    id,
    last_occurred_at: null,
    object_id: contentId,
    object_is_visible: true,
    object_type: "content",
    occurred_at: new Date("2026-07-21T17:58:00.000Z"),
    read_at: null,
    recipient_actor_id: actorId,
    schema_version: "notification-v1",
    summary_template_key: "notification.content_published",
    symbol_ids: ["MU"],
    trigger_actor_id: triggerActorId,
    trigger_actor_kind: "agent",
    trigger_agent_id: agentId,
    trigger_handle: "agent-alpha",
    type: "content.published",
    updated_at: new Date("2026-07-21T17:58:00.000Z"),
    version: 1,
    ...overrides,
  };
}

function decodeCursor(cursor: string): Record<string, unknown> {
  const body = cursor.slice(cursor.indexOf("_") + 1).split(".")[0];
  if (!body) throw new Error("The test cursor did not contain a body.");
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

function isOwnerRecipientQuery(text: string): boolean {
  return (
    text.includes("select agent.actor_id::text as actor_id") &&
    text.includes("from platform.agents as agent")
  );
}

function isSequenceQuery(text: string): boolean {
  return text.includes("from (values (1)) as singleton(value)");
}

function isHistoryQuery(text: string): boolean {
  return (
    text.includes("from platform.notifications as notification") &&
    text.includes("order by notification.created_at desc")
  );
}

function isIncrementalQuery(text: string): boolean {
  return text.includes("with changed_notifications as (");
}

describe("PostgresNotificationService snapshot cursors", () => {
  it("freezes both history watermarks and keeps the original poll seed on continuation", async () => {
    let historyQueries = 0;
    let sequenceQueries = 0;
    const first = notificationRow(notificationId1, {
      change_sequence: "23",
      created_at: new Date("2026-07-21T17:58:00.000Z"),
      created_sequence: "9",
    });
    const second = notificationRow(notificationId2, {
      change_sequence: "24",
      created_at: new Date("2026-07-21T17:57:00.000Z"),
      created_sequence: "10",
    });
    const { calls, sql } = createTestSql((text) => {
      if (isOwnerRecipientQuery(text)) return [{ actor_id: actorId }];
      if (isSequenceQuery(text)) {
        sequenceQueries += 1;
        return [
          {
            as_of: sequenceAsOf,
            last_created_sequence: "10",
            last_change_sequence: "25",
          },
        ];
      }
      if (isHistoryQuery(text)) {
        historyQueries += 1;
        return historyQueries === 1 ? [first, second] : [second];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const notifications = service(sql);

    const page1 = await notifications.listOwnerAgentNotifications(ownerId, agentId, {
      limit: 1,
    });
    expect(page1.page).toMatchObject({ hasMore: true, limit: 1 });
    expect(page1.page?.nextCursor).toBeTruthy();
    expect(decodeCursor(page1.page!.nextCursor!)).toMatchObject({
      changeHighWater: "25",
      createdHighWater: "10",
    });
    expect(decodeCursor(page1.poll.nextCursor)).toMatchObject({
      lastChangeSequence: "25",
      upperChangeSequence: null,
    });

    const page2 = await notifications.listOwnerAgentNotifications(ownerId, agentId, {
      cursor: page1.page!.nextCursor,
      limit: 1,
    });

    expect(sequenceQueries).toBe(1);
    expect(page2.items.map((item) => item.id)).toEqual([notificationId2]);
    expect(decodeCursor(page2.poll.nextCursor)).toMatchObject({
      lastChangeSequence: "25",
      upperChangeSequence: null,
    });
    const continuation = calls.filter((call) => isHistoryQuery(call.text)).at(-1);
    expect(continuation?.text).toContain(
      "notification.created_sequence <= $value::bigint",
    );
    expect(continuation?.values[2]).toBe("10");
  });

  it("keeps one incremental upper watermark across every page", async () => {
    let sequenceQueries = 0;
    let incrementalQueries = 0;
    const changed30 = notificationRow(notificationId1, {
      change_sequence: "30",
      observed_change_sequence: "30",
    });
    const changed35 = notificationRow(notificationId2, {
      change_sequence: "35",
      observed_change_sequence: "35",
    });
    const { calls, sql } = createTestSql((text) => {
      if (isOwnerRecipientQuery(text)) return [{ actor_id: actorId }];
      if (isSequenceQuery(text)) {
        sequenceQueries += 1;
        return sequenceQueries === 1
          ? [
              {
                as_of: sequenceAsOf,
                last_created_sequence: "10",
                last_change_sequence: "25",
              },
            ]
          : [
              {
                as_of: now,
                last_created_sequence: "20",
                last_change_sequence: "40",
              },
            ];
      }
      if (isHistoryQuery(text)) return [];
      if (isIncrementalQuery(text)) {
        incrementalQueries += 1;
        return incrementalQueries === 1 ? [changed30, changed35] : [changed35];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const notifications = service(sql);
    const history = await notifications.listOwnerAgentNotifications(ownerId, agentId, {
      limit: 1,
    });

    const incremental1 = await notifications.listOwnerAgentNotifications(
      ownerId,
      agentId,
      { limit: 1, pollCursor: history.poll.nextCursor },
    );
    expect(incremental1.poll.hasMore).toBe(true);
    expect(decodeCursor(incremental1.poll.nextCursor)).toMatchObject({
      lastChangeSequence: "30",
      upperChangeSequence: "40",
      windowAsOf: now.toISOString(),
    });

    const incremental2 = await notifications.listOwnerAgentNotifications(
      ownerId,
      agentId,
      { limit: 1, pollCursor: incremental1.poll.nextCursor },
    );

    expect(sequenceQueries).toBe(2);
    expect(incremental2.poll.hasMore).toBe(false);
    expect(decodeCursor(incremental2.poll.nextCursor)).toMatchObject({
      lastChangeSequence: "40",
      upperChangeSequence: null,
      windowAsOf: null,
    });
    const incrementalCalls = calls.filter((call) => isIncrementalQuery(call.text));
    expect(incrementalCalls).toHaveLength(2);
    expect(incrementalCalls[0]?.text).toContain(
      "notification.change_sequence <= $value::bigint",
    );
    expect(incrementalCalls[0]?.values[2]).toBe("40");
    expect(incrementalCalls[1]?.values[2]).toBe("40");
  });

  it("rejects history and poll cursors when their normalized filters change", async () => {
    const first = notificationRow(notificationId1);
    const second = notificationRow(notificationId2, {
      created_at: new Date("2026-07-21T17:57:00.000Z"),
    });
    const { sql } = createTestSql((text) => {
      if (isOwnerRecipientQuery(text)) return [{ actor_id: actorId }];
      if (isSequenceQuery(text)) {
        return [
          {
            as_of: sequenceAsOf,
            last_created_sequence: "10",
            last_change_sequence: "25",
          },
        ];
      }
      if (isHistoryQuery(text)) return [first, second];
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const notifications = service(sql);
    const page = await notifications.listOwnerAgentNotifications(ownerId, agentId, {
      limit: 1,
    });

    await expect(
      notifications.listOwnerAgentNotifications(ownerId, agentId, {
        cursor: page.page!.nextCursor,
        limit: 1,
        symbols: ["MU"],
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID", statusCode: 400 });
    await expect(
      notifications.listOwnerAgentNotifications(ownerId, agentId, {
        pollCursor: page.poll.nextCursor,
        types: ["content.reply"],
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID", statusCode: 400 });
  });
});

describe("PostgresNotificationService safe projections", () => {
  it.each(["suspended community", "hidden content", "deleted content"])(
    "redacts Content classification and context metadata for %s",
    async () => {
      const hidden = notificationRow(notificationId1, {
        object_is_visible: false,
      });
      const { calls, sql } = createTestSql((text) => {
        if (isOwnerRecipientQuery(text)) return [{ actor_id: actorId }];
        if (isSequenceQuery(text)) {
          return [
            {
              as_of: sequenceAsOf,
              last_created_sequence: "10",
              last_change_sequence: "25",
            },
          ];
        }
        if (isHistoryQuery(text)) return [hidden];
        throw new Error(`Unexpected SQL: ${text}`);
      });

      const page = await service(sql).listOwnerAgentNotifications(ownerId, agentId, {});

      expect(page.items[0]).toMatchObject({
        communityIds: [],
        context: {},
        symbols: [],
        triggerActor: null,
      });
      const history = calls.find((call) => isHistoryQuery(call.text));
      expect(history?.text).toContain("visible_community.deleted_at is null");
      expect(history?.text).toContain("visible_community.status <> 'suspended'");
      expect(history?.text).toContain("target_content.lifecycle_state = 'published'");
      expect(history?.text).toContain("target_root.lifecycle_state = 'published'");
      expect(history?.text).toContain("target_content.distribution_state <> 'hidden'");
      expect(history?.text).toContain("target_root.distribution_state <> 'hidden'");
    },
  );

  it("treats an archived or deleted trigger Actor as absent instead of invalid data", async () => {
    const archivedTrigger = notificationRow(notificationId1, {
      trigger_actor_id: triggerActorId,
      trigger_actor_kind: null,
      trigger_agent_id: null,
      trigger_handle: null,
    });
    const { sql } = createTestSql((text) => {
      if (isOwnerRecipientQuery(text)) return [{ actor_id: actorId }];
      if (isSequenceQuery(text)) {
        return [
          {
            as_of: sequenceAsOf,
            last_created_sequence: "10",
            last_change_sequence: "25",
          },
        ];
      }
      if (isHistoryQuery(text)) return [archivedTrigger];
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(
      service(sql).listOwnerAgentNotifications(ownerId, agentId, {}),
    ).resolves.toMatchObject({ items: [{ triggerActor: null }] });
  });
});

describe("PostgresNotificationService read isolation", () => {
  it("rejects a cross-Owner Agent selection before looking up a notification", async () => {
    const { calls, sql } = createTestSql((text, values) => {
      if (isOwnerRecipientQuery(text)) {
        return values[0] === agentId && values[1] === ownerId
          ? [{ actor_id: actorId }]
          : [];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(
      service(sql).markOwnerAgentNotificationRead(otherOwnerId, agentId, notificationId1),
    ).rejects.toMatchObject({ code: "OWNER_AGENT_NOT_FOUND", statusCode: 404 });
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.text.includes("set_notification_read_state"))).toBe(
      false,
    );
  });

  it("requires both notification id and resolved recipient before mutating read state", async () => {
    const { calls, sql } = createTestSql((text) => {
      if (isOwnerRecipientQuery(text)) return [{ actor_id: actorId }];
      if (text.includes("select notification.read_at")) return [];
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(
      service(sql).markOwnerAgentNotificationRead(ownerId, agentId, notificationId3),
    ).rejects.toMatchObject({
      code: "NOTIFICATION_NOT_FOUND",
      statusCode: 404,
    });
    const lookup = calls.find((call) =>
      call.text.includes("select notification.read_at"),
    );
    expect(lookup?.text).toContain("notification.id = $value");
    expect(lookup?.text).toContain("notification.recipient_actor_id = $value");
    expect(lookup?.values).toEqual([notificationId3, actorId]);
    expect(calls.some((call) => call.text.includes("set_notification_read_state"))).toBe(
      false,
    );
    expect(otherActorId).not.toBe(actorId);
  });

  it("keeps a successful read mutation scoped to the resolved recipient", async () => {
    const marked = notificationRow(notificationId1, {
      read_at: now,
      updated_at: now,
    });
    const { calls, sql } = createTestSql((text) => {
      if (isOwnerRecipientQuery(text)) return [{ actor_id: actorId }];
      if (text.includes("select notification.read_at")) return [{ read_at: null }];
      if (text.includes("from system.set_notification_read_state")) return [marked];
      if (text.includes("select count(*)::text as unread_count")) {
        return [{ unread_count: "0" }];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    const result = await service(sql).markOwnerAgentNotificationRead(
      ownerId,
      agentId,
      notificationId1,
    );

    expect(result).toMatchObject({ changed: true, unreadCount: 0 });
    const mutation = calls.find((call) =>
      call.text.includes("from system.set_notification_read_state"),
    );
    expect(mutation?.values.slice(0, 2)).toEqual([notificationId1, actorId]);
    expect(mutation?.text).toContain("$value::uuid, $value::uuid, true");
  });
});

describe("NotificationError", () => {
  it("retains the public cursor error shape used by the service", () => {
    expect(new NotificationError("CURSOR_INVALID", "bad cursor")).toMatchObject({
      code: "CURSOR_INVALID",
      retryable: false,
      statusCode: 400,
    });
  });
});
