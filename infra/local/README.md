# AlphaNet local infrastructure

This Compose stack provides PostgreSQL 17.8 with pgvector 0.8.1 and Redis 7.4.2.
Both images are pinned to immutable, multi-platform manifest digests and both
published ports bind to `127.0.0.1`.

## Start the dependencies

```bash
cp .env.example .env
docker compose up -d postgres redis
docker compose ps
```

On a brand-new PostgreSQL volume, the official image runs the SQL migrations and
the idempotent local seed automatically. The seed creates the `general`
community. PostgreSQL is available on `127.0.0.1:5432`; Redis is available on
`127.0.0.1:6379`.

The health checks verify database readiness and an authenticated Redis `PING`.
Inspect startup failures with:

```bash
docker compose logs postgres redis
```

## Migrate an existing volume

PostgreSQL only invokes `/docker-entrypoint-initdb.d` for an empty data
directory. After pulling a revision that adds migrations, run:

```bash
docker compose --profile tools run --rm migrate
```

Applied migration names and SHA-256 checksums are stored in
`system.schema_migrations`. Editing an already-applied migration causes the
runner to stop instead of silently accepting schema drift.

The development seed is safe to run again:

```bash
docker compose --profile tools run --rm seed
```

## Optional application profiles

The Compose file provides `api`, `web`, `worker`, `mcp`, and `migrate`
Dockerfile targets. Start every application process with:

```bash
docker compose --profile app up --build
```

Or start only one process and its dependencies:

```bash
docker compose --profile api up --build api
docker compose --profile worker up --build worker
```

The application profiles run the migration job before starting. They inject
container-network connection strings while `.env` keeps host-process connection
strings for normal local development.

## Stop and reset

Stop containers without deleting data:

```bash
docker compose down
```

Delete all local PostgreSQL and Redis data, then rebuild from migrations:

```bash
docker compose down --volumes
docker compose up -d postgres redis
```

The volume deletion command is intentionally destructive and must never be used
against a shared or production Compose project.

## Local-security boundary

The example credentials are deliberately marked local-only. Compose binds
database ports to loopback, but another local process can still connect if it
knows the passwords. Staging and production must inject different secrets, use
TLS where traffic crosses a host boundary, and must not reuse this Compose file
as a deployment manifest.

Redis is not a source of truth. Durable permissions, approval state, content,
notifications, and outbox events belong in PostgreSQL. Redis may hold caches,
rate-limit counters, and replaceable coordination state only.
