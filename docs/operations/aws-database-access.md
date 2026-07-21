# AWS PostgreSQL identities and release gate

AlphaNet uses separate PostgreSQL login identities for deployment and service
traffic. The application must never receive the RDS database-owner bootstrap
credential.

| Identity             | Purpose                                                            | Effective capability                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RDS database owner   | One-time bootstrap, extension installation, role/password rotation | Current owner of the application database and break-glass administrator; absent from normal ECS tasks                                                                                                              |
| `alphanet_migration` | One short-lived release database task                              | Owns AlphaNet schemas and objects; can create schema objects and temporary verification objects; cannot create databases, roles, replication slots, or bypass RLS                                                  |
| `alphanet_runtime`   | API, MCP, Worker, and auth connections                             | Reviewed table-level DML and pure CHECK-helper execution only; no schema/database creation, temporary tables, truncate, trigger management, references, role inheritance, or direct execution of trigger functions |

The role names can be changed through `ALPHANET_MIGRATION_ROLE` and
`ALPHANET_RUNTIME_ROLE`, but both must remain distinct and match the guarded
`alphanet_*` identifier pattern.

## Artifact contract

The release database image must contain all of the following paths:

```text
/opt/alphanet/db/migrations/*.up.sql
/opt/alphanet/db/aws/bootstrap.sql
/opt/alphanet/db/aws/runtime-privileges.sql
/opt/alphanet/db/aws/runtime-privileges-and-verify.sql
/opt/alphanet/db/aws/verify-runtime-privileges.sql
/opt/alphanet/db/aws/runtime-smoke.sql
/opt/alphanet/db/scripts/migrate.sh
/opt/alphanet/db/scripts/aws-bootstrap-database.sh
/opt/alphanet/db/scripts/aws-apply-runtime-privileges.sh
/opt/alphanet/db/scripts/aws-verify-runtime-privileges.sh
/opt/alphanet/db/scripts/aws-migrate-release.sh
/opt/alphanet/db/scripts/aws-smoke-runtime.sh
/opt/alphanet/db/scripts/aws-test-runtime-acl-reconciliation.sh
/opt/alphanet/db/scripts/aws-test-runtime-privilege-atomicity.sh
```

An image that contains only `migrate.sh` and `db/migrations` is insufficient.
CI must inspect the built image for this complete list before publishing it.
The ACL reconciliation regression is packaged because the migrate target copies
and syntax-checks the complete database script set; no production task invokes
that destructive entry point.

## Secret contract

Secrets Manager owns three secret containers with separate responsibilities:

- the RDS-managed database-owner/bootstrap secret;
- one multi-key AlphaNet application secret containing
  `ALPHANET_MIGRATION_PASSWORD`, `ALPHANET_RUNTIME_PASSWORD`, the runtime
  connection URLs, and application keys;
- the CloudFormation-generated Valkey AUTH secret.

The migration and runtime PostgreSQL passwords share the application-secret
container but must be distinct, random, and at least 32 bytes. ECS exposes only
the keys required by each task: normal services do not receive the migration
password or the RDS database-owner credential. The bootstrap wrapper receives
both role passwords as environment variables, validates them in-memory, and
feeds them to psql's `\password` prompt over stdin. psql derives the
SCRAM-SHA-256 verifier client-side; both verifier updates and role LOGIN
enables commit atomically. The SQL bootstrap file never receives a cleartext
password, and neither value is placed in command-line arguments or migration
files. Do not put a literal password in Terraform state, ECS task JSON, a shell
command, GitHub Actions output, or a generated `DATABASE_URL` log line.

The runtime application consumes a URL-encoded runtime connection string from
Secrets Manager. The release database task instead uses libpq `PG*` variables
with `PGPASSWORD` set from the migration secret. This avoids URL-encoding and
shell-interpolation mistakes in the privileged task.

IAM database authentication is deliberately not part of this first production
slice. Adding it requires token refresh and connection-pool lifecycle work; do
not grant `rds_iam` while services still use static URLs.

## TLS contract

Every RDS connection verifies both the certificate chain and the endpoint name.
The task image must contain the current AWS RDS root bundle and set:

```text
PGSSLMODE=verify-full
PGSSLROOTCERT=/opt/alphanet/certs/aws-rds-us-west-2-bundle.pem
```

The Node application connection configuration must provide equivalent
`verify-full` behavior and use the same checksum-pinned regional trust bundle
through `NODE_EXTRA_CA_CERTS`. `sslmode=require` without CA and hostname
verification is not sufficient. AWS documents this requirement in
[Using SSL with RDS for PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html)
and publishes the bundles through
[RDS certificate bundles](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html).

## First environment bootstrap

Run exactly once after the database is reachable in private subnets and again
only for an intentional idempotent repair or coordinated password rotation.
The task must connect as the database's current `pg_database.datdba` owner; a
separate `CREATEROLE` identity is deliberately unsupported and fails before
bootstrap starts. The task receives both AlphaNet password secrets:

```bash
/bin/bash /opt/alphanet/db/scripts/aws-bootstrap-database.sh
```

The bootstrap fails closed unless the caller is that owner and all secrets and
guarded role names are present. It then:

1. creates or hardens the two login roles without granting `rds_superuser` or
   `rds_extension`;
2. rotates their SCRAM passwords from environment-only values;
3. installs `pgcrypto`, `citext`, `pg_trgm`, and `vector` as the administrator;
4. makes the migration identity owner of `auth`, `platform`, and `system`;
5. reduces the database ACL to its owner plus the two AlphaNet roles, and every
   `auth`, `platform`, and `system` schema/relation/sequence/routine ACL to the
   migration and runtime roles, revoking legacy explicit grantees and `PUBLIC`;
6. removes every role granted to either AlphaNet login, every inbound runtime
   member, and every inbound migration member except the database owner;
7. persists both `log_parameter_max_length=0` settings at database scope;
8. grants runtime only `CONNECT` and schema `USAGE` before the post-migration
   privilege reconciler classifies objects.

The current database owner is the migration role's sole member and retains
`ADMIN OPTION` so it can repair ownership in a break-glass run. The runtime
role has no members. Neither AlphaNet login may itself be a member of any role;
`NOINHERIT` is not treated as protection because a member can still `SET ROLE`.

## Every release

The CD database task connects as `alphanet_migration` and has a single entry
point:

```bash
/bin/bash /opt/alphanet/db/scripts/aws-migrate-release.sh
```

The entry point is a strict sequence:

1. `migrate.sh` applies checksummed, advisory-lock-serialized forward
   migrations;
2. `aws-apply-runtime-privileges.sh` uses one `psql --single-transaction`
   session to enumerate and revoke every non-owner schema/object ACL grantee,
   reapply the reviewed table/function inventory, and immediately run the
   complete ownership, bidirectional membership, actual-ACL allowlist,
   positive/negative grant, extension, parameter-log, and default-ACL verifier.

Any failure exits nonzero and prevents service deployment. If the inventory is
stale or incomplete, PostgreSQL rolls back every privilege mutation before the
task exits; the currently running application keeps its previous ACLs. Forward
migrations remain per-file committed and are not rolled back. Never split the
reconciler and verifier into independent tasks. Adding a migration that
introduces a new table or callable function intentionally fails the privilege
gate until the runtime inventory is reviewed and updated.

`aws-verify-runtime-privileges.sh` is a non-mutating standalone diagnostic. It
fails on database ACL or role-membership drift that only the database owner is
authorized to repair; rerun bootstrap instead of broadening the migration role.
CI also runs `aws-test-runtime-privilege-atomicity.sh`, which simulates an older
inventory encountering a newer table and proves that a failed reconciliation
restores the pre-existing runtime grant.

The CI-only `aws-test-runtime-acl-reconciliation.sh` requires an explicit
`ALPHANET_ALLOW_DESTRUCTIVE_ACL_TEST=1` opt-in, a disposable PostgreSQL 17
database, and its superuser owner. It injects legacy database/schema/table/
sequence/routine grants plus inbound and outbound memberships, proves bootstrap
and per-release cleanup, and separately proves that the verifier rejects each
owner-only drift class. Never run this destructive fixture in production.

After services deploy, a task connected with the runtime secret can execute the
rollback-only DML smoke test:

```bash
/bin/bash /opt/alphanet/db/scripts/aws-smoke-runtime.sh
```

It exercises Owner provisioning triggers, Agent identity constraints, CHECK
helpers, outbox sequencing, consumer delivery writes, and receipts, then rolls
the transaction back. It must not run with the migration or administrator
credential.

## Audited privilege inventory

The runtime grants are intentionally asymmetric:

- Better Auth tables: `SELECT`, `INSERT`, `UPDATE`, `DELETE` because Better Auth
  owns their row lifecycle.
- Platform tables: read access across the current domain; only tables written by
  current API/Worker SQL receive `INSERT` or `UPDATE`. `platform.reactions` is
  the sole current `DELETE` exception because `active=false` removes one
  `(actor_id, content_id, reaction_type)` target-state fact; no platform table
  receives `TRUNCATE`, `REFERENCES`, or `TRIGGER`.
- System tables: reads for readiness/outbox operation; write access only to the
  outbox head, event, consumer, delivery, and receipt tables.
- Functions: only seven pure validation helpers used by CHECK constraints are
  executable. Trigger functions, including every `SECURITY DEFINER` function,
  are not directly callable.
- New objects: no runtime privilege by default. A release must classify them.

This inventory reflects SQL in `packages/auth`, `packages/database`, and
`packages/domain`. Update the inventory and both verification paths whenever
runtime SQL changes.

## Rotation and recovery

Password changes invalidate future authentication but do not terminate existing
PostgreSQL sessions. Coordinate a runtime-secret rotation with a forced ECS
deployment and monitor pool reconnects; do not terminate old tasks until new
tasks pass readiness. A migration-secret rotation affects only short-lived
release tasks.

Database migration rollback remains forward-only. If the release database gate
fails after a migration commits, do not grant broader runtime access to make it
green. Fix the privilege inventory or add a compatible forward migration, rerun
the gate, and keep application deployment blocked.

The database-owner bootstrap identity is break-glass only. Store it separately
from application secrets and remove it from routine task definitions after
bootstrap. Before Production opens, enable Aurora connection logging, build and
test a low-noise successful-login alert for this exact role against the real log
format, and record the alert drill; the current foundation does not claim that
runtime detection is already active.

AWS background references:

- [RDS PostgreSQL `rds_superuser` and roles](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Roles.rds_superuser.html)
- [RDS delegated extension support](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/RDS_delegated_ext.html)
