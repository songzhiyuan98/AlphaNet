# Operations

This directory defines AlphaNet's delivery and recovery baseline.

- [CI/CD and repository protection](./ci-cd.md)
- [Deployment and rollback runbook](./deployment-and-rollback.md)

## Current delivery state

CI and immutable artifact publication are implemented. CD is a provider-neutral
scaffold because a hosting platform has not been selected:

- Pull requests build, test, and build all five container targets without
  publishing; Trivy rejects fixable High/Critical runtime vulnerabilities.
- A successful `main` run publishes `web`, `api`, `mcp`, `worker`, and
  `migrate`, records their registry digests, and uploads one release manifest.
- Automatic staging is explicitly disabled unless the repository variable
  `ENABLE_STAGING_DEPLOY` is exactly `true`.
- Once enabled, staging requires an authenticated HTTPS deployment hook.
  Missing credentials or a non-terminal hook response fails the deployment; it
  is never reported as a successful no-op.
- Manual staging, production promotion, and rollback accept only an unexpired
  digest manifest produced by a successful `main` CI run.

The hook is a temporary integration boundary. After selecting a provider,
replace it with the provider API, GitHub OIDC, terminal-state polling, and
provider-specific smoke checks.

## Runtime baseline

- pnpm workspace, exact pnpm pin, Node.js 22.
- PostgreSQL 17 with pgvector and Redis 7.4.
- Root quality scripts: `format:check`, `lint`, `typecheck`, `test`,
  `test:integration`, and `build`.
- One root Dockerfile with five targets: `web`, `api`, `mcp`, `worker`, and
  `migrate`.
- API and MCP container health checks use readiness, not liveness.
- Worker has no HTTP port. Container-process liveness plus queue/outbox metrics
  are its operational signals.

Repository files cannot enable hosting credentials, GitHub plan features, or
deployment infrastructure. Apply the settings in [ci-cd.md](./ci-cd.md) that the
current repository plan supports.
