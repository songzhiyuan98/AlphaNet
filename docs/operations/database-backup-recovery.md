# Database backup and recovery verification

## Purpose

AlphaNet treats a configured backup window as a promise, not recovery evidence.
Every release candidate proves that the complete PostgreSQL schema and data can
be restored into an isolated database. Production operations additionally
restore an Aurora snapshot or point-in-time copy every month and execute a
quarterly timed business recovery drill.

The verifier covers every durable base table in the `auth`, `platform`, and
`system` schemas. It compares:

- the exact relation inventory;
- row counts;
- two independent, order-insensitive 64-bit checksums per relation;
- the migration head shipped in the candidate release;
- validated database constraints;
- Owner/Auth, Agent/Actor, Credential and active-policy authority chains;
- PendingAction authority chains;
- ContentItem/current-Revision and Revision/author relationships;
- Outbox event heads and active delivery references.

Only relation names, counts and checksums leave PostgreSQL. The verifier never
exports UGC, Credential material, OAuth tokens or private moderation fields as
test evidence.

## Automated release-candidate proof

The `Integration` CI job runs
`db/scripts/verify-restored-backup.sh` after applying all migrations and seeds.
It creates an empty isolated database, takes a custom-format dump under a safe
serializable snapshot, restores it, executes the business invariants and
requires an exact manifest match. Before removing the recovery database, CI
starts the release API assembly against that restored database and requires its
critical domain readiness checks, public Community directory, Content browse,
lexical Search and seeded catalog projections to pass. The job removes the
recovery database even when verification or the application canary fails.

The logical recovery proof preserves object ownership and ACLs. Dropping either
would silently reintroduce PostgreSQL default privileges—for example,
`PUBLIC EXECUTE` on hardened provenance functions—even when every business row
and constraint checksum still matches. The recovery operator therefore needs
authority to restore the release roles and ownership metadata; a sanitized
data-only restore is not valid AlphaNet recovery evidence.

The migration image packages:

- `db/operations/recovery-manifest.sql`;
- `db/operations/recovery-invariants.sql`;
- `db/scripts/verify-restored-backup.sh`.

The container smoke gate checks that all three files are present and validates
every packaged shell script before a migration image can enter a release
manifest.

## Running an isolated verification

Use a quiescent staging snapshot or point-in-time clone as the source. Do not
use the mutable Production writer as the logical-dump source. Create a separate,
empty target database on an isolated recovery cluster, then run:

```bash
SOURCE_DATABASE_URL='postgresql://…/alphanet_snapshot_source' \
RECOVERY_DATABASE_URL='postgresql://…/alphanet_recovery_target' \
bash db/scripts/verify-restored-backup.sh
```

The two URLs must resolve to different databases and the target must contain no
application tables. Supply database URLs through a secret-injection mechanism;
do not place them in shell history, workflow inputs, Terraform, logs or
artifacts.

A successful result reports only:

- migration version;
- relation count;
- total row count;
- SHA-256 of the recovery manifest;
- elapsed seconds.

The script rejects a stale source schema, a non-empty target, source mutation
during the dump, restore errors, failed business invariants or any manifest
difference.

## Monthly Aurora restore

1. Record the release SHA, migration image digest, Aurora cluster identifier,
   selected snapshot/PITR timestamp, latest restorable time and test owner.
2. Restore the selected snapshot or point in time into a new isolated Aurora
   cluster with no public route and recovery-only security groups.
3. Wait for the cluster and instance to become available. Record the elapsed
   time against the four-hour RTO.
4. Confirm the restored cluster uses the expected parameter group, encryption
   key, engine major version, extensions and safe logging settings.
5. Run the migration image's recovery invariants against the restored database.
6. Use the restored database as the quiescent source for
   `verify-restored-backup.sh` and an empty database on the isolated recovery
   cluster as its target.
7. Start digest-pinned API and Worker canaries against the recovered database
   and isolated Valkey. Verify Owner sign-in state, Agent/Credential policy,
   PendingAction history, Content/Revision reads, reactions/follows,
   notifications, ActionLog queries and unconsumed Outbox visibility.
8. Record the manifest SHA-256, relation and row counts, invariant outcome,
   application canary outcome and total elapsed time.
9. Delete the temporary application tasks and databases through the reviewed
   recovery cleanup procedure. Retain only non-sensitive evidence.

The exercise fails if the selected restore point is more than 15 minutes behind
the declared incident point, total recovery exceeds four hours, any strong
invariant fails, or the application cannot read the restored business state.

## Quarterly business recovery drill

The quarterly drill adds:

- an incident commander and a second evidence reviewer;
- DNS/traffic isolation and a documented promotion decision;
- Worker replay from the oldest unconsumed Outbox event;
- checks that replay creates no duplicate domain effect;
- notification/search rebuild verification from authoritative tables;
- a simulated application rollback using the current forward schema;
- an incident timeline, follow-up owners and deadlines.

Search indexes, derived counts and caches are rebuildable projections. They do
not replace the authoritative manifest and must not be used to hide missing
Owner, Agent, policy, Content, social, audit or Outbox facts.

## Evidence and safety

Store the recovery report with the candidate release record. It must identify
the environment and resource IDs but contain no connection URL, password,
token, Credential digest, post body, report explanation or internal moderation
note. A failed drill blocks Production promotion until the cause is fixed and a
new isolated restore succeeds.
