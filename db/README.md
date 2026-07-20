# Database migrations

`db/migrations` is the source of truth for schema changes. Migration filenames
must use:

```text
NNNNNN_lower_snake_case.up.sql
```

The local runner applies files in bytewise filename order, wraps each file in a
transaction, serializes concurrent runners with a PostgreSQL advisory lock, and
records a SHA-256 checksum in `system.schema_migrations`.

## Rules

1. Never edit or renumber a migration after it has been applied anywhere shared.
   Add a new forward migration instead.
2. Keep migrations transactional. Do not put `CREATE INDEX CONCURRENTLY` or
   another transaction-forbidden operation in these files. Such operations need
   a separately reviewed deployment runbook.
3. Use expand/migrate/contract for changes consumed by running applications:
   add compatible schema first, deploy dual-read or dual-write code, backfill in
   bounded batches, then remove old schema in a later release.
4. Do not rely on a down migration for production rollback. Roll application
   code back only while the new schema remains backward-compatible; repair the
   database with a new forward migration.
5. Put deterministic, idempotent developer data in `db/seeds`. A seed must not
   be required for schema correctness and must not contain copied production
   data.
6. Extension creation belongs in migrations. Production roles must be prepared
   by infrastructure before deployment if the application migration role cannot
   create an extension.
7. Run exactly one migration job during deployment. Application replicas must
   not all attempt migrations during startup.

## Outbox contract

A command that changes durable business state must insert its corresponding
`system.outbox_events` row in the same PostgreSQL transaction. Producers start
each aggregate at sequence 1 and advance exactly by one. A transaction-scoped
advisory lock serializes concurrent producers for that aggregate, and
`system.outbox_aggregate_heads` preserves the last committed sequence even
after old events are compacted. A higher sequence waits for an in-flight lower
sequence; if that transaction rolls back and the higher sequence is no longer
valid, PostgreSQL rejects the insert and the producer must retry its entire
domain transaction with a freshly derived sequence.

Workers provide at-least-once delivery. Each named consumer owns an independent
`system.outbox_consumers` subscription and independent
`system.outbox_consumer_deliveries` rows with bounded leases, retry state, and
terminal status, then writes a unique receipt before acknowledging success.
The consumer name is versioned (for example, `search-indexer:v2`). Its
normalized event-type set and inclusive `replay_from` watermark over
`outbox_events.created_at` are immutable after first registration. Changing
either requires a new consumer version and an explicit watermark; this prevents
a rolling deployment from silently backfilling old events when it adds a
handler. A worker with no handlers remains idle and must not register or poison
events. Every replica of one consumer version must receive the same
`OUTBOX_CONSUMER_NAME` and `OUTBOX_REPLAY_FROM`; never derive the watermark from
process startup time.

Ordering is defined per `(aggregate_type, aggregate_id)` through
`aggregate_sequence`; a dead-lettered predecessor blocks later events for that
consumer until an explicit audited redrive or skip decision. There is no global
event ordering guarantee. Application code exposes this PostgreSQL `bigint` as
a decimal string and compares it with bigint-safe operations. External side
effects require the outbox event ID as their idempotency key. A worker renews
its lease while a handler is running. The claim returns PostgreSQL's actual
`lease_expires_at`; the worker must not reconstruct that first deadline from
local claim-return time. A transient renewal error is retried while the
conservative local deadline remains valid; an explicit rejection or local
expiry stops acknowledgement, and PostgreSQL ownership fencing remains
authoritative. Redis may wake workers but must never replace PostgreSQL polling
as the durable queue or a startup requirement.

Monitor these signals per consumer: oldest ready event, ready count, retry rate,
expired leases, and dead-letter count. Redrive tooling must clear a dead-letter
state explicitly and preserve the previous error in an audit log before
production use. Event compaction must not delete an event while any registered
consumer still has non-terminal delivery state.
