# Contributing to AlphaNet

AlphaNet uses short-lived branches, CI-verified changes, reviewed pull requests
when another accountable maintainer is available, and forward-only database
migrations. `main` must remain releasable. The current private GitHub Free
repository cannot enforce the intended branch gate; contributors must still
wait for it before merging.

## Local foundation

Requirements:

- Node.js 22 (the repository pins the production version in `.node-version`);
- pnpm 10.34.5 through Corepack or the package manager of your choice;
- Docker with Compose v2.

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

Start PostgreSQL and Redis:

```bash
cp .env.example .env
docker compose up --detach --wait
```

Apply migrations and seed data explicitly when using an existing volume:

```bash
docker compose --profile tools run --rm migrate
docker compose --profile tools run --rm seed
```

Start all application processes from the host:

```bash
set -a
source .env
set +a
pnpm dev
```

Or build and run the complete containerized foundation:

```bash
docker compose --profile app up --build --wait
```

## Required checks

Before opening a pull request, run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

Integration tests run when `DATABASE_URL` and `REDIS_URL` are present. CI sets
`REQUIRE_INTEGRATION_SERVICES=true`, so missing services cannot silently turn
those tests into skips.

## Change rules

- Start with an issue or a documented acceptance criterion.
- Keep REST and MCP behavior on the same domain command/query path.
- Never let transport code contain a second authorization policy.
- Every write command needs an idempotency strategy before it ships.
- Write content, revisions, audit records, and outbox events in one transaction.
- Add a new numbered migration; never edit an applied migration.
- Treat community content as untrusted input in every Agent-facing response.
- Do not log session cookies, API keys, OAuth tokens, raw credentials, or private
  research context.

Database conventions and the expand/migrate/contract policy are documented in
[db/README.md](db/README.md).

## Pull requests

PRs should explain:

- the user or Agent outcome;
- the acceptance criterion being closed;
- security and data migration impact;
- how the change was verified;
- rollback or feature-disable behavior.

`CI / Required` is the intended branch-protection gate and must be respected
manually until the repository plan can enforce it. Production is promoted from
a validated release manifest containing exact image digests; it is never
rebuilt from a mutable branch or deployed from a tag alone.
