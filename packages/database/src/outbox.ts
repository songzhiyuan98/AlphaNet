import type postgres from "postgres";

import type { PostgresClient } from "./index.js";

export interface OutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  aggregateSequence: string;
  eventType: string;
  eventVersion: number;
  leaseExpiresAt: Date;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  maxAttempts: number;
}

interface OutboxEventRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_sequence: string;
  event_type: string;
  event_version: number;
  lease_expires_at: Date;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
  max_attempts: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapOutboxEvent(row: OutboxEventRow): OutboxEvent {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateSequence: row.aggregate_sequence,
    eventType: row.event_type,
    eventVersion: row.event_version,
    leaseExpiresAt: row.lease_expires_at,
    payload: isRecord(row.payload) ? row.payload : {},
    occurredAt: row.occurred_at,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

export interface ClaimOutboxOptions {
  batchSize: number;
  eventTypes?: readonly string[];
  leaseOwner: string;
  leaseSeconds?: number;
  replayFrom: Date;
}

export class OutboxConsumerSubscriptionMismatchError extends Error {
  constructor(consumerName: string) {
    super(
      `Outbox consumer "${consumerName}" is already registered with a different event type set or replay watermark; use a new versioned consumer name`,
    );
    this.name = "OutboxConsumerSubscriptionMismatchError";
  }
}

function normalizeEventTypes(eventTypes: readonly string[] | undefined): string[] | null {
  if (eventTypes === undefined) {
    return null;
  }
  if (eventTypes.length === 0) {
    throw new RangeError("An outbox consumer event type set cannot be empty");
  }

  for (const eventType of eventTypes) {
    if (
      eventType.length === 0 ||
      eventType.length > 160 ||
      eventType !== eventType.trim()
    ) {
      throw new RangeError(
        "Outbox consumer event types must be trimmed strings between 1 and 160 characters",
      );
    }
  }

  return [...new Set(eventTypes)].sort();
}

export class PostgresOutboxRepository {
  constructor(
    private readonly sql: PostgresClient,
    private readonly consumerName: string,
  ) {}

  async claim(options: ClaimOutboxOptions): Promise<OutboxEvent[]> {
    const eventTypes = normalizeEventTypes(options.eventTypes);
    if (Number.isNaN(options.replayFrom.getTime())) {
      throw new RangeError("Outbox replayFrom must be a valid Date");
    }

    await this.registerSubscription(eventTypes, options.replayFrom);

    const leaseSeconds = options.leaseSeconds ?? 30;
    const registrationLimit = Math.max(options.batchSize * 4, options.batchSize);

    await this.sql`
      insert into system.outbox_consumer_deliveries (
        consumer_name,
        event_id,
        max_attempts,
        available_at
      )
      select
        ${this.consumerName},
        event.id,
        event.max_attempts,
        event.available_at
      from system.outbox_events as event
      join system.outbox_consumers as consumer
        on consumer.consumer_name = ${this.consumerName}
      where not exists (
        select 1
        from system.outbox_consumer_deliveries as delivery
        where delivery.consumer_name = ${this.consumerName}
          and delivery.event_id = event.id
      )
        and event.created_at >= consumer.replay_from
        and (
          consumer.event_types is null
          or event.event_type = any(consumer.event_types)
        )
      order by event.available_at, event.occurred_at, event.id
      limit ${registrationLimit}
      on conflict (consumer_name, event_id) do nothing
    `;

    const rows = await this.sql<OutboxEventRow[]>`
      with expired_final_attempts as (
        update system.outbox_consumer_deliveries as delivery
        set lease_owner = null,
            lease_expires_at = null,
            dead_lettered_at = clock_timestamp(),
            dead_letter_reason = 'lease_expired_after_max_attempts',
            last_error = 'lease_expired_after_max_attempts',
            updated_at = clock_timestamp()
        where delivery.consumer_name = ${this.consumerName}
          and delivery.delivered_at is null
          and delivery.dead_lettered_at is null
          and delivery.attempts >= delivery.max_attempts
          and (
            delivery.lease_expires_at is null
            or delivery.lease_expires_at <= clock_timestamp()
          )
        returning delivery.event_id
      ),
      candidates as (
        select delivery.event_id
        from system.outbox_consumer_deliveries as delivery
        join system.outbox_events as event
          on event.id = delivery.event_id
        join system.outbox_consumers as consumer
          on consumer.consumer_name = delivery.consumer_name
        where delivery.consumer_name = ${this.consumerName}
          and delivery.delivered_at is null
          and delivery.dead_lettered_at is null
          and delivery.attempts < delivery.max_attempts
          and delivery.available_at <= clock_timestamp()
          and (
            delivery.lease_expires_at is null
            or delivery.lease_expires_at <= clock_timestamp()
          )
          and not exists (
            select 1
            from system.outbox_events as earlier_event
            where earlier_event.aggregate_type = event.aggregate_type
              and earlier_event.aggregate_id = event.aggregate_id
              and earlier_event.aggregate_sequence < event.aggregate_sequence
              and earlier_event.created_at >= consumer.replay_from
              and (
                consumer.event_types is null
                or earlier_event.event_type = any(consumer.event_types)
              )
              and not exists (
                select 1
                from system.outbox_consumer_deliveries as earlier_delivery
                where earlier_delivery.consumer_name = ${this.consumerName}
                  and earlier_delivery.event_id = earlier_event.id
                  and earlier_delivery.delivered_at is not null
              )
          )
        order by delivery.available_at, event.occurred_at, event.id
        for update of delivery skip locked
        limit ${options.batchSize}
      )
      update system.outbox_consumer_deliveries as delivery
      set lease_owner = ${options.leaseOwner},
          lease_expires_at = clock_timestamp() + make_interval(secs => ${leaseSeconds}),
          attempts = delivery.attempts + 1,
          updated_at = clock_timestamp()
      from candidates, system.outbox_events as event
      where delivery.consumer_name = ${this.consumerName}
        and delivery.event_id = candidates.event_id
        and event.id = delivery.event_id
      returning
        event.id,
        event.aggregate_type,
        event.aggregate_id,
        event.aggregate_sequence,
        event.event_type,
        event.event_version,
        delivery.lease_expires_at,
        event.payload,
        event.occurred_at,
        delivery.attempts,
        delivery.max_attempts
    `;

    return rows.map(mapOutboxEvent);
  }

  private async registerSubscription(
    eventTypes: string[] | null,
    replayFrom: Date,
  ): Promise<void> {
    const eventTypesParameter = eventTypes === null ? null : this.sql.array(eventTypes);

    await this.sql`
      insert into system.outbox_consumers (
        consumer_name,
        event_types,
        replay_from
      )
      values (
        ${this.consumerName},
        ${eventTypesParameter},
        ${replayFrom}
      )
      on conflict (consumer_name) do nothing
    `;

    const matchingSubscription = await this.sql<{ consumer_name: string }[]>`
      select consumer_name
      from system.outbox_consumers
      where consumer_name = ${this.consumerName}
        and event_types is not distinct from ${eventTypesParameter}
        and replay_from = ${replayFrom}
    `;

    if (matchingSubscription.length !== 1) {
      throw new OutboxConsumerSubscriptionMismatchError(this.consumerName);
    }
  }

  async renewLease(
    eventId: string,
    leaseOwner: string,
    leaseSeconds = 30,
  ): Promise<boolean> {
    const renewed = await this.sql<{ event_id: string }[]>`
      update system.outbox_consumer_deliveries
      set lease_expires_at = clock_timestamp() + make_interval(secs => ${leaseSeconds}),
          updated_at = clock_timestamp()
      where consumer_name = ${this.consumerName}
        and event_id = ${eventId}
        and lease_owner = ${leaseOwner}
        and lease_expires_at > clock_timestamp()
        and delivered_at is null
        and dead_lettered_at is null
      returning event_id
    `;
    return renewed.length === 1;
  }

  async markDelivered(
    eventId: string,
    leaseOwner: string,
    result: Record<string, unknown> = {},
  ): Promise<boolean> {
    const claimed = await this.sql<{ id: string }[]>`
      with claimed as (
        update system.outbox_consumer_deliveries
        set delivered_at = clock_timestamp(),
            lease_owner = null,
            lease_expires_at = null,
            last_error = null,
            updated_at = clock_timestamp()
        where consumer_name = ${this.consumerName}
          and event_id = ${eventId}
          and lease_owner = ${leaseOwner}
          and lease_expires_at > clock_timestamp()
          and delivered_at is null
          and dead_lettered_at is null
        returning event_id
      ),
      receipt as (
        insert into system.outbox_consumer_receipts (
          consumer_name,
          event_id,
          result
        )
        select
          ${this.consumerName},
          claimed.event_id,
          ${this.sql.json(result as postgres.JSONValue)}
        from claimed
        on conflict (consumer_name, event_id) do nothing
      )
      select event_id from claimed
    `;

    return claimed.length === 1;
  }

  async markFailed(
    event: OutboxEvent,
    leaseOwner: string,
    errorCode: string,
  ): Promise<boolean> {
    const retryBaseSeconds = Math.min(300, 2 ** Math.min(event.attempts, 8));
    const retrySeconds = retryBaseSeconds * (0.75 + Math.random() * 0.5);
    const safeErrorCode = errorCode.slice(0, 500);
    const result = await this.sql<{ id: string }[]>`
      update system.outbox_consumer_deliveries
      set lease_owner = null,
          lease_expires_at = null,
          last_error = ${safeErrorCode},
          available_at = case
            when attempts >= max_attempts then available_at
            else clock_timestamp() + make_interval(secs => ${retrySeconds})
          end,
          dead_lettered_at = case
            when attempts >= max_attempts then clock_timestamp()
            else dead_lettered_at
          end,
          dead_letter_reason = case
            when attempts >= max_attempts then ${safeErrorCode}
            else dead_letter_reason
          end,
          updated_at = clock_timestamp()
      where consumer_name = ${this.consumerName}
        and event_id = ${event.id}
        and lease_owner = ${leaseOwner}
        and lease_expires_at > clock_timestamp()
        and delivered_at is null
        and dead_lettered_at is null
      returning event_id as id
    `;
    return result.length === 1;
  }
}
