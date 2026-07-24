# Operations

This directory defines AlphaNet's delivery and recovery baseline.

- [Database backup and recovery verification](./database-backup-recovery.md)
  defines the automated release proof, monthly isolated Aurora restore and
  quarterly business recovery drill.
- [MVP capacity gate](../../tests/load/README.md) defines the production-shaped
  dataset, exact traffic model, safety boundary, SLO thresholds and release
  evidence.

- [CI/CD and repository protection](./ci-cd.md)
- [Deployment and rollback runbook](./deployment-and-rollback.md)
- [AWS database identities and release gate](./aws-database-access.md)
- [AWS Valkey TLS contract](./aws-valkey-tls.md)
- [Workforce Admin Web deployment](./admin-web-deployment.md)
- [Community write emergency control](./community-write-emergency-control.md)
- [Manual accessibility release review](./manual-accessibility-review.md)
- [Operations readiness release review](./operations-readiness-review.md)
- [MCP Host interoperability release review](./mcp-host-interoperability.md)
- [Public MCP and OAuth edge release review](./public-mcp-edge-review.md)
- [Legal policy publication release review](./legal-policy-publication.md)
- [Paused lean AWS deployment handoff](./aws-deployment-pause-handoff.md)
- [AWS infrastructure bootstrap](../../infra/aws/README.md)

## Current delivery state

CI, immutable artifact publication, and AWS-native CD are implemented in the
repository. Cloud resources remain deliberately disabled until the AWS account,
state backend, runtime secrets, and first database bootstrap are complete:

- Pull requests build, test, and build all five container targets without
  publishing; Trivy rejects fixable High/Critical runtime vulnerabilities.
- Before shared ECR exists, a successful `main` run locally builds, smokes, and
  scans all five targets but publishes nothing and creates no release manifest.
  With `AWS_ECR_PUBLISH_ENABLED=true`, the same branch-bound GitHub OIDC
  identity publishes `web`, `api`, `mcp`, `worker`, and `migrate` to shared
  immutable ECR repositories. The release manifest records both the OCI index
  digest and the exact Linux/amd64 runtime digest.
- `AWS_DEPLOY_ENABLED` is independent of image publication. Once it is `true`
  and the complete environment coordinates are present, staging can deploy
  automatically. A missing coordinate fails readiness when deployment has been
  explicitly enabled; it is never reported as a successful no-op.
- Deployment runs the forward-only database gate first, then rolls API/MCP,
  Worker, and Web, executes a runtime-role SQL smoke test and public smoke
  checks, and verifies task definitions and running image digests.
- Production automation remains off until staging is proven. It is enabled only
  with `AUTO_DEPLOY_PRODUCTION=true`; manual exact-SHA staging, promotion, and
  rollback remain available.
- Application rollout failure restores the previous ECS task definitions in
  reverse order. Database migrations are not automatically reversed.

Staging and Production use separate VPC, ECS, Aurora, Valkey, secret, and state
boundaries while consuming the same ECR digest. The current private GitHub Free
repository does not depend on GitHub Environments; OIDC trust is restricted to
the repository API's exact immutable owner-ID/repository-ID `main` subject, and
staging/production use separate AWS roles.

## Runtime baseline

- pnpm workspace, exact pnpm pin, Node.js 22.
- Aurora PostgreSQL 17 with pgvector and TLS-verifying runtime URLs;
  ElastiCache Valkey uses TLS and remains reconstructable state.
- Root quality scripts: `format:check`, `lint`, `typecheck`, `test`,
  `test:integration`, and `build`.
- One root Dockerfile with five targets: `web`, `api`, `mcp`, `worker`, and
  `migrate`; runtime images include the checksum-pinned regional RDS CA bundle.
- API and MCP container health checks use readiness, not liveness.
- Worker has no HTTP port. Container-process liveness plus queue/outbox metrics
  are its operational signals.

Repository files cannot create an AWS account, accept billing terms, verify a
mail sender or OAuth client, or populate runtime secrets. Follow the explicit
bootstrap order in the infrastructure README before enabling repository CD
variables.
