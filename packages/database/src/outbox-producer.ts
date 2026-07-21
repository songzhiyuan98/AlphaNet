import type postgres from "postgres";

export type OutboxJsonValue =
  null | boolean | number | string | readonly OutboxJsonValue[] | OutboxJsonObject;

export interface OutboxJsonObject {
  readonly [key: string]: OutboxJsonValue;
}

export interface AppendOutboxEventInput {
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  eventVersion: number;
  maxAttempts?: number;
  occurredAt: Date;
  payload: OutboxJsonObject;
}

export interface AppendOutboxEventResult {
  aggregateSequence: string;
  id: string;
}

interface AggregateSequenceRow {
  next_sequence: string;
}

interface InsertedOutboxEventRow {
  aggregate_sequence: string;
  id: string;
}

const DEFAULT_MAX_ATTEMPTS = 12;
const MAX_EVENT_VERSION = 2_147_483_647;
const MAX_MAX_ATTEMPTS = 100;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;

function invalidPayload(path: string, reason: string): never {
  throw new TypeError(`Outbox payload ${path} ${reason}`);
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) {
    return false;
  }
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function cloneJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): OutboxJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return invalidPayload(path, "must contain only finite numbers");
    }
    return value;
  }
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    return invalidPayload(path, `cannot contain ${typeof value} values`);
  }
  if (typeof value !== "object") {
    return invalidPayload(path, "contains an unsupported value");
  }
  if (ancestors.has(value)) {
    return invalidPayload(path, "cannot contain circular references");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      const indexKeys: string[] = [];
      for (const key of keys) {
        if (typeof key === "symbol") {
          return invalidPayload(path, "cannot contain symbol-keyed properties");
        }
        if (key === "length") {
          continue;
        }
        if (!isArrayIndex(key, value.length)) {
          return invalidPayload(path, "arrays cannot contain non-index properties");
        }
        indexKeys.push(key);
      }
      if (indexKeys.length !== value.length) {
        return invalidPayload(path, "arrays cannot be sparse");
      }

      const clone = Array.from({ length: value.length }, (): OutboxJsonValue => null);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          return invalidPayload(
            `${path}[${index}]`,
            "must be an enumerable data property",
          );
        }
        clone[index] = cloneJsonValue(descriptor.value, `${path}[${index}]`, ancestors);
      }
      return clone;
    }

    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidPayload(path, "must contain only plain objects and arrays");
    }

    const clone = Object.create(null) as Record<string, OutboxJsonValue>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        return invalidPayload(path, "cannot contain symbol-keyed properties");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        return invalidPayload(`${path}.${key}`, "must be an enumerable data property");
      }
      clone[key] = cloneJsonValue(descriptor.value, `${path}.${key}`, ancestors);
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function snapshotPayload(payload: unknown): OutboxJsonObject {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return invalidPayload("root", "must be a plain object");
  }
  const clone = cloneJsonValue(payload, "root", new Set());
  if (clone === null || typeof clone !== "object" || Array.isArray(clone)) {
    return invalidPayload("root", "must be a plain object");
  }
  return clone as OutboxJsonObject;
}

function assertBoundedString(value: string, field: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new RangeError(
      `${field} must be a trimmed string between 1 and ${maximum} characters`,
    );
  }
}

function assertPositiveInteger(value: number, field: string, maximum: number): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${field} must be an integer between 1 and ${maximum}`);
  }
}

export async function appendOutboxEvent(
  transaction: postgres.TransactionSql,
  input: AppendOutboxEventInput,
): Promise<AppendOutboxEventResult> {
  const aggregateType = input.aggregateType;
  const aggregateId = input.aggregateId;
  const eventType = input.eventType;
  const eventVersion = input.eventVersion;
  assertBoundedString(aggregateType, "aggregateType", 120);
  assertBoundedString(aggregateId, "aggregateId", 200);
  assertBoundedString(eventType, "eventType", 160);
  assertPositiveInteger(eventVersion, "eventVersion", MAX_EVENT_VERSION);
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  assertPositiveInteger(maxAttempts, "maxAttempts", MAX_MAX_ATTEMPTS);
  if (
    !(input.occurredAt instanceof Date) ||
    !Number.isFinite(input.occurredAt.getTime())
  ) {
    throw new RangeError("occurredAt must be a valid Date");
  }
  const occurredAt = new Date(input.occurredAt.getTime());
  const payload = snapshotPayload(input.payload);

  // Keep this key construction semantically identical to the expression in
  // system.advance_outbox_aggregate_head(). Transaction advisory locks are
  // re-entrant, so the insert trigger can safely acquire the same lock again.
  await transaction`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'alphanet:outbox-aggregate:'
          || pg_catalog.octet_length(${aggregateType}::text)::text
          || ':'
          || ${aggregateType}::text
          || ':'
          || ${aggregateId}::text,
        0
      )
    )
  `;

  const sequenceRows = await transaction<AggregateSequenceRow[]>`
    select coalesce(
      (
        select head.last_sequence + 1
        from system.outbox_aggregate_heads as head
        where head.aggregate_type = ${aggregateType}
          and head.aggregate_id = ${aggregateId}
      ),
      1
    )::text as next_sequence
  `;
  const nextSequence = sequenceRows[0]?.next_sequence;
  if (!nextSequence || !POSITIVE_DECIMAL_PATTERN.test(nextSequence)) {
    throw new Error("Outbox aggregate sequence allocation returned an invalid value");
  }

  const insertedRows = await transaction<InsertedOutboxEventRow[]>`
    insert into system.outbox_events (
      aggregate_type,
      aggregate_id,
      aggregate_sequence,
      event_type,
      event_version,
      payload,
      occurred_at,
      available_at,
      max_attempts,
      created_at
    )
    values (
      ${aggregateType},
      ${aggregateId},
      ${nextSequence},
      ${eventType},
      ${eventVersion},
      ${transaction.json(payload)},
      ${occurredAt},
      ${occurredAt},
      ${maxAttempts},
      ${occurredAt}
    )
    returning id, aggregate_sequence::text as aggregate_sequence
  `;
  const inserted = insertedRows[0];
  if (
    !inserted ||
    typeof inserted.id !== "string" ||
    inserted.id.length === 0 ||
    inserted.aggregate_sequence !== nextSequence
  ) {
    throw new Error("Outbox event insert returned an invalid result");
  }

  return {
    aggregateSequence: inserted.aggregate_sequence,
    id: inserted.id,
  };
}
