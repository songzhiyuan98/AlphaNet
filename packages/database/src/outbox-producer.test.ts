import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { appendOutboxEvent, type AppendOutboxEventInput } from "./outbox-producer.js";

interface CapturedQuery {
  text: string;
  values: readonly unknown[];
}

interface JsonMarker {
  kind: "json";
  value: unknown;
}

interface FakeTransaction {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<unknown[]>;
  json(value: unknown): unknown;
}

interface HarnessOptions {
  eventId?: string;
  insertError?: Error;
  insertedSequence?: string;
  nextSequence?: string;
}

class TransactionHarness {
  readonly jsonValues: unknown[] = [];
  readonly queries: CapturedQuery[] = [];
  readonly transaction: postgres.TransactionSql;
  readonly #eventId: string;
  readonly #insertError: Error | undefined;
  readonly #insertedSequence: string;
  readonly #nextSequence: string;

  constructor(options: HarnessOptions = {}) {
    this.#eventId = options.eventId ?? "00000000-0000-4000-8000-000000000001";
    this.#insertError = options.insertError;
    this.#nextSequence = options.nextSequence ?? "1";
    this.#insertedSequence = options.insertedSequence ?? this.#nextSequence;

    const transaction = ((
      strings: TemplateStringsArray,
      ...values: readonly unknown[]
    ) => {
      try {
        return Promise.resolve(this.#execute(strings, values));
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error("Fake transaction failed"),
        );
      }
    }) as FakeTransaction;
    transaction.json = vi.fn((value: unknown): JsonMarker => {
      this.jsonValues.push(value);
      return { kind: "json", value };
    });
    this.transaction = transaction as unknown as postgres.TransactionSql;
  }

  #execute(strings: TemplateStringsArray, values: readonly unknown[]): unknown[] {
    const text = strings
      .reduce(
        (result, part, index) =>
          `${result}${part}${index < values.length ? `$${index + 1}` : ""}`,
        "",
      )
      .replaceAll(/\s+/g, " ")
      .trim();
    this.queries.push({ text, values });

    if (this.queries.length === 1) {
      return [{ pg_advisory_xact_lock: "" }];
    }
    if (this.queries.length === 2) {
      return [{ next_sequence: this.#nextSequence }];
    }
    if (this.queries.length === 3) {
      if (this.#insertError) {
        throw this.#insertError;
      }
      return [
        {
          aggregate_sequence: this.#insertedSequence,
          id: this.#eventId,
        },
      ];
    }
    throw new Error("Outbox producer executed an unexpected query");
  }
}

const occurredAt = new Date("2026-07-20T20:00:00.000Z");

function input(overrides: Partial<AppendOutboxEventInput> = {}): AppendOutboxEventInput {
  return {
    aggregateId: "content-123",
    aggregateType: "content",
    eventType: "content.published",
    eventVersion: 1,
    occurredAt,
    payload: {
      confidence: 0.84,
      evidence: ["filing", { source: null, verified: true }],
    },
    ...overrides,
  };
}

describe("appendOutboxEvent", () => {
  it("locks with the trigger key before allocating and inserting a sequence", async () => {
    const harness = new TransactionHarness();
    const event = input();

    await expect(appendOutboxEvent(harness.transaction, event)).resolves.toEqual({
      aggregateSequence: "1",
      id: "00000000-0000-4000-8000-000000000001",
    });

    expect(harness.queries).toHaveLength(3);
    expect(harness.queries[0]).toEqual({
      text: "select pg_catalog.pg_advisory_xact_lock( pg_catalog.hashtextextended( 'alphanet:outbox-aggregate:' || pg_catalog.octet_length($1::text)::text || ':' || $2::text || ':' || $3::text, 0 ) )",
      values: ["content", "content", "content-123"],
    });
    expect(harness.queries[1]).toEqual({
      text: "select coalesce( ( select head.last_sequence + 1 from system.outbox_aggregate_heads as head where head.aggregate_type = $1 and head.aggregate_id = $2 ), 1 )::text as next_sequence",
      values: ["content", "content-123"],
    });
    expect(harness.queries[2]?.text).toBe(
      "insert into system.outbox_events ( aggregate_type, aggregate_id, aggregate_sequence, event_type, event_version, payload, occurred_at, available_at, max_attempts, created_at ) values ( $1, $2, $3, $4, $5, $6, $7, $8, $9, $10 ) returning id, aggregate_sequence::text as aggregate_sequence",
    );
    expect(harness.queries[2]?.values).toEqual([
      "content",
      "content-123",
      "1",
      "content.published",
      1,
      {
        kind: "json",
        value: {
          confidence: 0.84,
          evidence: ["filing", { source: null, verified: true }],
        },
      },
      occurredAt,
      occurredAt,
      12,
      occurredAt,
    ]);
    expect(harness.jsonValues).toEqual([event.payload]);
    expect(harness.jsonValues[0]).not.toBe(event.payload);
  });

  it("preserves aggregate sequences beyond JavaScript's safe integer range", async () => {
    const sequence = "9007199254740993";
    const harness = new TransactionHarness({ nextSequence: sequence });

    await expect(
      appendOutboxEvent(harness.transaction, input({ maxAttempts: 100 })),
    ).resolves.toMatchObject({ aggregateSequence: sequence });

    expect(harness.queries[2]?.values[2]).toBe(sequence);
    expect(typeof harness.queries[2]?.values[2]).toBe("string");
    expect(harness.queries[2]?.values[8]).toBe(100);
  });

  it("propagates insertion failures so the surrounding transaction can roll back", async () => {
    const insertError = new Error("insert failed");
    const harness = new TransactionHarness({ insertError });

    await expect(appendOutboxEvent(harness.transaction, input())).rejects.toBe(
      insertError,
    );
    expect(harness.queries).toHaveLength(3);
  });

  it("rejects invalid payloads before taking the aggregate lock", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const sparse: unknown[] = new Array(1);
    const symbolKeyed = { visible: true } as Record<PropertyKey, unknown>;
    symbolKeyed[Symbol("hidden")] = "hidden";
    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => "dynamic",
    });

    const invalidPayloads: unknown[] = [
      undefined,
      null,
      [],
      { value: undefined },
      { value: () => undefined },
      { value: Symbol("value") },
      { value: 1n },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: new Date("2026-07-20T20:00:00.000Z") },
      { value: new Uint8Array([1, 2, 3]) },
      { value: sparse },
      circular,
      symbolKeyed,
      accessor,
    ];

    for (const payload of invalidPayloads) {
      const harness = new TransactionHarness();
      await expect(
        appendOutboxEvent(harness.transaction, input({ payload: payload as never })),
      ).rejects.toThrow(TypeError);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("rejects invalid retry, version, and timestamp values before querying", async () => {
    const invalidInputs: AppendOutboxEventInput[] = [
      input({ maxAttempts: 0 }),
      input({ maxAttempts: 101 }),
      input({ eventVersion: 0 }),
      input({ eventVersion: 2_147_483_648 }),
      input({ occurredAt: new Date(Number.NaN) }),
    ];

    for (const invalidInput of invalidInputs) {
      const harness = new TransactionHarness();
      await expect(appendOutboxEvent(harness.transaction, invalidInput)).rejects.toThrow(
        RangeError,
      );
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("allows shared acyclic objects while snapshotting each branch", async () => {
    const shared = { source: "10-Q" };
    const payload = { first: shared, second: shared };
    const harness = new TransactionHarness();

    await appendOutboxEvent(harness.transaction, input({ payload }));

    expect(harness.jsonValues).toEqual([payload]);
    const snapshot = harness.jsonValues[0] as {
      first: unknown;
      second: unknown;
    };
    expect(snapshot.first).not.toBe(snapshot.second);
  });

  it("snapshots mutable input before waiting for the aggregate lock", async () => {
    const harness = new TransactionHarness();
    const event = input();
    const originalOccurredAt = event.occurredAt.getTime();

    const pending = appendOutboxEvent(harness.transaction, event);
    event.aggregateType = "mutated";
    event.aggregateId = "mutated";
    event.eventType = "mutated";
    event.eventVersion = 2;
    event.occurredAt.setTime(originalOccurredAt + 60_000);
    await pending;

    expect(harness.queries[1]?.values).toEqual(["content", "content-123"]);
    expect(harness.queries[2]?.values.slice(0, 5)).toEqual([
      "content",
      "content-123",
      "1",
      "content.published",
      1,
    ]);
    const insertedTimestamp = harness.queries[2]?.values[6];
    expect(insertedTimestamp).toBeInstanceOf(Date);
    expect((insertedTimestamp as Date).getTime()).toBe(originalOccurredAt);
    expect(insertedTimestamp).not.toBe(event.occurredAt);
  });
});
