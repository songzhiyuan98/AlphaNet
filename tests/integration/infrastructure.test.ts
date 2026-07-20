import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  createRedisDependency,
  OutboxConsumerSubscriptionMismatchError,
  PostgresOutboxRepository,
  type HealthDependency,
} from "../../packages/database/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";
const hasConfiguration = Boolean(databaseUrl && redisUrl);
const replayFromBeginning = new Date(0);

if (mustRun && !hasConfiguration) {
  throw new Error(
    "DATABASE_URL and REDIS_URL are required when REQUIRE_INTEGRATION_SERVICES=true",
  );
}

const describeInfrastructure = hasConfiguration ? describe : describe.skip;
const dependencies: HealthDependency[] = [];

describeInfrastructure("local infrastructure", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const redis = createRedisDependency(redisUrl ?? "");
  dependencies.push(postgres, redis);

  async function insertOutboxEvent(options: {
    aggregateId: string;
    aggregateSequence?: number | string;
    createdAt?: Date;
    eventType?: string;
    maxAttempts?: number;
  }): Promise<string> {
    const inserted = await postgres.sql<{ id: string }[]>`
      insert into system.outbox_events (
        aggregate_type,
        aggregate_id,
        aggregate_sequence,
        event_type,
        payload,
        max_attempts,
        created_at
      )
      values (
        'integration_test',
        ${options.aggregateId},
        ${options.aggregateSequence ?? 1},
        ${options.eventType ?? "integration_test.created"},
        '{"source":"integration"}'::jsonb,
        ${options.maxAttempts ?? 12},
        ${options.createdAt ?? new Date()}
      )
      returning id
    `;
    const eventId = inserted[0]?.id;
    if (!eventId) {
      throw new Error("integration event insert did not return an id");
    }
    return eventId;
  }

  async function deleteOutboxEvents(eventIds: string[]): Promise<void> {
    await postgres.sql`
      delete from system.outbox_consumer_receipts
      where event_id = any(${eventIds}::uuid[])
    `;
    await postgres.sql`
      delete from system.outbox_events
      where id = any(${eventIds}::uuid[])
    `;
  }

  async function waitForAdvisoryLock(backendPid: number): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const sessions = await postgres.sql<
        { wait_event: string | null; wait_event_type: string | null }[]
      >`
        select wait_event, wait_event_type
        from pg_stat_activity
        where pid = ${backendPid}
      `;
      if (
        sessions[0]?.wait_event_type === "Lock" &&
        sessions[0]?.wait_event === "advisory"
      ) {
        return;
      }
      await delay(10);
    }
    throw new Error("producer did not wait for the aggregate advisory lock");
  }

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("accepts Postgres queries", async () => {
    await expect(postgres.check()).resolves.toBeUndefined();
  });

  it("accepts Redis commands", async () => {
    await expect(redis.check()).resolves.toBeUndefined();
  });

  it("leases and acknowledges a transactional outbox event", async () => {
    const aggregateId = randomUUID();
    const leaseOwner = `integration-test:${randomUUID()}`;
    const repository = new PostgresOutboxRepository(
      postgres.sql,
      "integration-test-consumer",
    );
    const eventId = await insertOutboxEvent({ aggregateId });

    try {
      const events = await repository.claim({
        batchSize: 100,
        eventTypes: ["integration_test.created"],
        leaseOwner,
        replayFrom: replayFromBeginning,
      });
      const event = events.find((candidate) => candidate.id === eventId);
      expect(event).toMatchObject({
        aggregateId,
        aggregateSequence: "1",
        attempts: 1,
        eventType: "integration_test.created",
        leaseExpiresAt: expect.any(Date),
      });

      await expect(
        repository.markDelivered(eventId, leaseOwner, { processed: true }),
      ).resolves.toBe(true);
      await expect(repository.markDelivered(eventId, leaseOwner)).resolves.toBe(false);

      const completed = await postgres.sql<
        { delivered: boolean; has_receipt: boolean }[]
      >`
        select
          delivery.delivered_at is not null as delivered,
          exists (
            select 1
            from system.outbox_consumer_receipts as receipt
            where receipt.consumer_name = 'integration-test-consumer'
              and receipt.event_id = delivery.event_id
          ) as has_receipt
        from system.outbox_consumer_deliveries as delivery
        where delivery.consumer_name = 'integration-test-consumer'
          and delivery.event_id = ${eventId}
      `;
      expect(completed[0]).toEqual({
        delivered: true,
        has_receipt: true,
      });
    } finally {
      await deleteOutboxEvents([eventId]);
    }
  });

  it("tracks delivery independently for each consumer", async () => {
    const aggregateId = randomUUID();
    const eventId = await insertOutboxEvent({ aggregateId });
    const first = new PostgresOutboxRepository(postgres.sql, "consumer-a");
    const second = new PostgresOutboxRepository(postgres.sql, "consumer-b");
    const firstOwner = `consumer-a:${randomUUID()}`;
    const secondOwner = `consumer-b:${randomUUID()}`;

    try {
      const [firstEvents, secondEvents] = await Promise.all([
        first.claim({
          batchSize: 20,
          eventTypes: ["integration_test.created"],
          leaseOwner: firstOwner,
          replayFrom: replayFromBeginning,
        }),
        second.claim({
          batchSize: 20,
          eventTypes: ["integration_test.created"],
          leaseOwner: secondOwner,
          replayFrom: replayFromBeginning,
        }),
      ]);
      expect(firstEvents.some((event) => event.id === eventId)).toBe(true);
      expect(secondEvents.some((event) => event.id === eventId)).toBe(true);

      await expect(first.markDelivered(eventId, firstOwner)).resolves.toBe(true);
      await expect(second.markDelivered(eventId, secondOwner)).resolves.toBe(true);

      const receipts = await postgres.sql<{ consumer_name: string }[]>`
        select consumer_name
        from system.outbox_consumer_receipts
        where event_id = ${eventId}
        order by consumer_name
      `;
      expect(receipts.map((receipt) => receipt.consumer_name)).toEqual([
        "consumer-a",
        "consumer-b",
      ]);
    } finally {
      await deleteOutboxEvents([eventId]);
    }
  });

  it("never claims a later sequence before the same consumer delivers its predecessor", async () => {
    const aggregateId = randomUUID();
    const firstId = await insertOutboxEvent({ aggregateId, aggregateSequence: 1 });
    const secondId = await insertOutboxEvent({ aggregateId, aggregateSequence: 2 });
    const repository = new PostgresOutboxRepository(postgres.sql, "ordered-consumer");
    const firstOwner = `ordered:${randomUUID()}`;
    const secondOwner = `ordered:${randomUUID()}`;

    try {
      const firstClaim = await repository.claim({
        batchSize: 20,
        eventTypes: ["integration_test.created"],
        leaseOwner: firstOwner,
        replayFrom: replayFromBeginning,
      });
      expect(firstClaim.find((event) => event.id === firstId)).toBeDefined();
      expect(firstClaim.find((event) => event.id === secondId)).toBeUndefined();
      await expect(repository.markDelivered(firstId, firstOwner)).resolves.toBe(true);

      const secondClaim = await repository.claim({
        batchSize: 20,
        eventTypes: ["integration_test.created"],
        leaseOwner: secondOwner,
        replayFrom: replayFromBeginning,
      });
      expect(secondClaim.find((event) => event.id === secondId)).toMatchObject({
        aggregateSequence: "2",
      });
    } finally {
      await deleteOutboxEvents([firstId, secondId]);
    }
  });

  it("serializes concurrent producers before a higher aggregate sequence can commit", async () => {
    const aggregateId = randomUUID();
    const firstConnection = await postgres.sql.reserve();
    const secondConnection = await postgres.sql.reserve();
    const eventIds: string[] = [];
    let firstTransactionOpen = false;
    let secondTransactionOpen = false;
    let secondInsert: Promise<{ id: string }[]> | undefined;

    try {
      await firstConnection`begin`;
      firstTransactionOpen = true;
      await secondConnection`begin`;
      secondTransactionOpen = true;

      const firstRows = await firstConnection<{ id: string }[]>`
        insert into system.outbox_events (
          aggregate_type,
          aggregate_id,
          aggregate_sequence,
          event_type,
          payload
        )
        values (
          'integration_test',
          ${aggregateId},
          1,
          'integration_test.concurrent',
          '{"source":"first-producer"}'::jsonb
        )
        returning id
      `;
      const firstId = firstRows[0]?.id;
      if (!firstId) {
        throw new Error("first producer insert did not return an event id");
      }
      eventIds.push(firstId);

      const backendRows = await secondConnection<{ pid: number }[]>`
        select pg_backend_pid()::integer as pid
      `;
      const secondBackendPid = backendRows[0]?.pid;
      if (!secondBackendPid) {
        throw new Error("second producer did not return a backend pid");
      }

      secondInsert = Promise.resolve(
        secondConnection<{ id: string }[]>`
          insert into system.outbox_events (
            aggregate_type,
            aggregate_id,
            aggregate_sequence,
            event_type,
            payload
          )
          values (
            'integration_test',
            ${aggregateId},
            2,
            'integration_test.concurrent',
            '{"source":"second-producer"}'::jsonb
          )
          returning id
        `,
      );

      await waitForAdvisoryLock(secondBackendPid);
      const prematurelyVisible = await postgres.sql<{ count: number }[]>`
        select count(*)::integer as count
        from system.outbox_events
        where aggregate_type = 'integration_test'
          and aggregate_id = ${aggregateId}
      `;
      expect(prematurelyVisible[0]?.count).toBe(0);

      await firstConnection`commit`;
      firstTransactionOpen = false;
      const secondRows = await secondInsert;
      const secondId = secondRows[0]?.id;
      if (!secondId) {
        throw new Error("second producer insert did not return an event id");
      }
      eventIds.push(secondId);
      await secondConnection`commit`;
      secondTransactionOpen = false;

      const repository = new PostgresOutboxRepository(
        postgres.sql,
        `concurrent-producer-consumer-${randomUUID()}:v1`,
      );
      const firstOwner = `concurrent-first:${randomUUID()}`;
      const firstClaim = await repository.claim({
        batchSize: 20,
        eventTypes: ["integration_test.concurrent"],
        leaseOwner: firstOwner,
        replayFrom: replayFromBeginning,
      });
      expect(firstClaim.find((event) => event.id === firstId)).toBeDefined();
      expect(firstClaim.find((event) => event.id === secondId)).toBeUndefined();
      await expect(repository.markDelivered(firstId, firstOwner)).resolves.toBe(true);

      const secondClaim = await repository.claim({
        batchSize: 20,
        eventTypes: ["integration_test.concurrent"],
        leaseOwner: `concurrent-second:${randomUUID()}`,
        replayFrom: replayFromBeginning,
      });
      expect(secondClaim.find((event) => event.id === secondId)).toBeDefined();
    } finally {
      if (firstTransactionOpen) {
        await firstConnection`rollback`;
      }
      if (secondTransactionOpen) {
        await secondConnection`rollback`;
      }
      await secondInsert?.catch(() => undefined);
      firstConnection.release();
      secondConnection.release();
      if (eventIds.length > 0) {
        await deleteOutboxEvents(eventIds);
      }
    }
  });

  it("orders only the event types registered by a consumer", async () => {
    const aggregateId = randomUUID();
    const ignoredId = await insertOutboxEvent({
      aggregateId,
      aggregateSequence: 1,
      eventType: "integration_test.ignored",
    });
    const relevantId = await insertOutboxEvent({
      aggregateId,
      aggregateSequence: 2,
      eventType: "integration_test.relevant",
    });
    const repository = new PostgresOutboxRepository(postgres.sql, "filtered-consumer");

    try {
      const events = await repository.claim({
        batchSize: 20,
        eventTypes: ["integration_test.relevant"],
        leaseOwner: `filtered:${randomUUID()}`,
        replayFrom: replayFromBeginning,
      });
      expect(events.find((event) => event.id === ignoredId)).toBeUndefined();
      expect(events.find((event) => event.id === relevantId)).toBeDefined();
    } finally {
      await deleteOutboxEvents([ignoredId, relevantId]);
    }
  });

  it("rejects handler-set drift and accepts an explicitly versioned subscription", async () => {
    const aggregateId = randomUUID();
    const suffix = randomUUID();
    const firstEventType = `integration_test.type_a.${suffix}`;
    const secondEventType = `integration_test.type_b.${suffix}`;
    const firstId = await insertOutboxEvent({
      aggregateId,
      aggregateSequence: 1,
      eventType: firstEventType,
    });
    const secondId = await insertOutboxEvent({
      aggregateId,
      aggregateSequence: 2,
      eventType: secondEventType,
    });
    const firstVersionName = `rolling-consumer-${suffix}:v1`;
    const firstVersion = new PostgresOutboxRepository(postgres.sql, firstVersionName);
    const secondVersion = new PostgresOutboxRepository(
      postgres.sql,
      `rolling-consumer-${suffix}:v2`,
    );

    try {
      const firstVersionClaim = await firstVersion.claim({
        batchSize: 20,
        eventTypes: [secondEventType],
        leaseOwner: `rolling-v1:${randomUUID()}`,
        replayFrom: replayFromBeginning,
      });
      expect(firstVersionClaim.find((event) => event.id === firstId)).toBeUndefined();
      expect(firstVersionClaim.find((event) => event.id === secondId)).toBeDefined();

      await expect(
        firstVersion.claim({
          batchSize: 20,
          eventTypes: [firstEventType, secondEventType],
          leaseOwner: `rolling-drift:${randomUUID()}`,
          replayFrom: replayFromBeginning,
        }),
      ).rejects.toBeInstanceOf(OutboxConsumerSubscriptionMismatchError);
      await expect(
        firstVersion.claim({
          batchSize: 20,
          eventTypes: [secondEventType],
          leaseOwner: `rolling-watermark-drift:${randomUUID()}`,
          replayFrom: new Date(1),
        }),
      ).rejects.toBeInstanceOf(OutboxConsumerSubscriptionMismatchError);
      await expect(
        postgres.sql`
          update system.outbox_consumers
          set replay_from = replay_from + interval '1 second'
          where consumer_name = ${firstVersionName}
        `,
      ).rejects.toThrow(/immutable/);
      await expect(
        postgres.sql`
          delete from system.outbox_consumers
          where consumer_name = ${firstVersionName}
        `,
      ).rejects.toThrow(/retire the version/);

      const unexpectedlyRegistered = await postgres.sql<{ count: number }[]>`
        select count(*)::integer as count
        from system.outbox_consumer_deliveries
        where consumer_name = ${firstVersionName}
          and event_id = ${firstId}
      `;
      expect(unexpectedlyRegistered[0]?.count).toBe(0);

      const secondVersionClaim = await secondVersion.claim({
        batchSize: 20,
        eventTypes: [secondEventType, firstEventType],
        leaseOwner: `rolling-v2:${randomUUID()}`,
        replayFrom: replayFromBeginning,
      });
      expect(secondVersionClaim.find((event) => event.id === firstId)).toBeDefined();
      expect(secondVersionClaim.find((event) => event.id === secondId)).toBeUndefined();
      await expect(
        secondVersion.claim({
          batchSize: 20,
          eventTypes: [firstEventType, secondEventType],
          leaseOwner: `rolling-v2-peer:${randomUUID()}`,
          replayFrom: replayFromBeginning,
        }),
      ).resolves.toEqual([]);
    } finally {
      await deleteOutboxEvents([firstId, secondId]);
    }
  });

  it("uses replayFrom as an inclusive created_at watermark", async () => {
    const aggregateId = randomUUID();
    const suffix = randomUUID();
    const eventType = `integration_test.watermark.${suffix}`;
    const historicId = await insertOutboxEvent({
      aggregateId,
      aggregateSequence: 1,
      createdAt: new Date("2025-12-31T23:59:59.000Z"),
      eventType,
    });
    const currentId = await insertOutboxEvent({
      aggregateId,
      aggregateSequence: 2,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      eventType,
    });
    const repository = new PostgresOutboxRepository(
      postgres.sql,
      `watermark-consumer-${suffix}:v1`,
    );

    try {
      const events = await repository.claim({
        batchSize: 20,
        eventTypes: [eventType],
        leaseOwner: `watermark:${randomUUID()}`,
        replayFrom: new Date("2026-01-01T00:00:00.000Z"),
      });
      expect(events.find((event) => event.id === historicId)).toBeUndefined();
      expect(events.find((event) => event.id === currentId)).toBeDefined();
    } finally {
      await deleteOutboxEvents([historicId, currentId]);
    }
  });

  it("preserves aggregate sequences beyond JavaScript's safe integer range", async () => {
    const aggregateId = randomUUID();
    await postgres.sql`
      insert into system.outbox_aggregate_heads (
        aggregate_type,
        aggregate_id,
        last_sequence
      )
      values (
        'integration_test',
        ${aggregateId},
        9007199254740992
      )
    `;
    const eventId = await insertOutboxEvent({
      aggregateId,
      aggregateSequence: "9007199254740993",
    });
    const repository = new PostgresOutboxRepository(
      postgres.sql,
      `bigint-consumer-${randomUUID()}:v1`,
    );

    try {
      const events = await repository.claim({
        batchSize: 20,
        eventTypes: ["integration_test.created"],
        leaseOwner: `bigint:${randomUUID()}`,
        replayFrom: replayFromBeginning,
      });
      expect(events.find((event) => event.id === eventId)).toMatchObject({
        aggregateSequence: "9007199254740993",
      });
    } finally {
      await deleteOutboxEvents([eventId]);
      await postgres.sql`
        delete from system.outbox_aggregate_heads
        where aggregate_type = 'integration_test'
          and aggregate_id = ${aggregateId}
      `;
    }
  });

  it("allows only one worker for a consumer to lease the same event", async () => {
    const aggregateId = randomUUID();
    const eventId = await insertOutboxEvent({ aggregateId });
    const repository = new PostgresOutboxRepository(postgres.sql, "competing-consumer");

    try {
      const claims = await Promise.all([
        repository.claim({
          batchSize: 20,
          eventTypes: ["integration_test.created"],
          leaseOwner: `competitor-a:${randomUUID()}`,
          replayFrom: replayFromBeginning,
        }),
        repository.claim({
          batchSize: 20,
          eventTypes: ["integration_test.created"],
          leaseOwner: `competitor-b:${randomUUID()}`,
          replayFrom: replayFromBeginning,
        }),
      ]);
      expect(claims.flat().filter((event) => event.id === eventId)).toHaveLength(1);
    } finally {
      await deleteOutboxEvents([eventId]);
    }
  });

  it("rejects an acknowledgement from a stale lease owner", async () => {
    const aggregateId = randomUUID();
    const eventId = await insertOutboxEvent({ aggregateId, maxAttempts: 2 });
    const repository = new PostgresOutboxRepository(
      postgres.sql,
      "lease-handoff-consumer",
    );
    const staleOwner = `stale:${randomUUID()}`;
    const currentOwner = `current:${randomUUID()}`;

    try {
      const staleClaim = await repository.claim({
        batchSize: 20,
        eventTypes: ["integration_test.created"],
        leaseOwner: staleOwner,
        leaseSeconds: 0,
        replayFrom: replayFromBeginning,
      });
      expect(staleClaim.find((event) => event.id === eventId)).toBeDefined();

      const currentClaim = await repository.claim({
        batchSize: 20,
        eventTypes: ["integration_test.created"],
        leaseOwner: currentOwner,
        replayFrom: replayFromBeginning,
      });
      expect(currentClaim.find((event) => event.id === eventId)).toMatchObject({
        attempts: 2,
      });

      await expect(repository.markDelivered(eventId, staleOwner)).resolves.toBe(false);
      await expect(repository.markDelivered(eventId, currentOwner)).resolves.toBe(true);
    } finally {
      await deleteOutboxEvents([eventId]);
    }
  });

  it("dead-letters an expired final attempt instead of exceeding the attempt bound", async () => {
    const aggregateId = randomUUID();
    const eventId = await insertOutboxEvent({ aggregateId, maxAttempts: 1 });
    const successorId = await insertOutboxEvent({
      aggregateId,
      aggregateSequence: 2,
    });
    const repository = new PostgresOutboxRepository(
      postgres.sql,
      "crash-recovery-consumer",
    );

    try {
      const firstClaim = await repository.claim({
        batchSize: 20,
        eventTypes: ["integration_test.created"],
        leaseOwner: `crashed:${randomUUID()}`,
        leaseSeconds: 0,
        replayFrom: replayFromBeginning,
      });
      expect(firstClaim.find((event) => event.id === eventId)).toMatchObject({
        attempts: 1,
        maxAttempts: 1,
      });

      const recoveryClaim = await repository.claim({
        batchSize: 20,
        eventTypes: ["integration_test.created"],
        leaseOwner: `recovery:${randomUUID()}`,
        replayFrom: replayFromBeginning,
      });
      expect(recoveryClaim.find((event) => event.id === eventId)).toBeUndefined();
      expect(recoveryClaim.find((event) => event.id === successorId)).toBeUndefined();

      const deliveries = await postgres.sql<
        {
          attempts: number;
          dead_letter_reason: string | null;
          dead_lettered: boolean;
        }[]
      >`
        select
          attempts,
          dead_letter_reason,
          dead_lettered_at is not null as dead_lettered
        from system.outbox_consumer_deliveries
        where consumer_name = 'crash-recovery-consumer'
          and event_id = ${eventId}
      `;
      expect(deliveries[0]).toEqual({
        attempts: 1,
        dead_letter_reason: "lease_expired_after_max_attempts",
        dead_lettered: true,
      });
    } finally {
      await deleteOutboxEvents([eventId, successorId]);
    }
  });
});
