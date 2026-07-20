# Deployment and rollback runbook

## Release and deployment state

Image publication is live pipeline code. Deployment remains a provider-neutral
scaffold until a hosting platform and its authenticated hook are configured.

Normal flow:

1. Merge to `main` only after `CI / Required` succeeds on the reviewed change.
2. The `main` CI run repeats all gates and builds the five Docker targets.
3. That same run publishes all five images, captures their registry digests, and
   uploads `release-manifest-<sha>`.
4. If `ENABLE_STAGING_DEPLOY=true`, staging consumes that artifact and invokes
   its hook. If the variable is not enabled, staging is visibly skipped.
5. After staging verification, dispatch `Manual Deploy` from `main`, supply the
   same full SHA, choose `production`, and set `confirm_production=true`.

Manual staging is also available for an existing release. Both manual targets
first prove that the SHA has a successful `main` CI run and an unexpired,
checksum-valid release manifest.

## Deployment hook request

The workflow sends an authenticated, idempotent `POST`:

```json
{
  "schemaVersion": 1,
  "repository": "songzhiyuan98/AlphaNet",
  "environment": "staging",
  "sha": "0123456789abcdef0123456789abcdef01234567",
  "releaseManifestSha256": "…",
  "workflowRunId": "123456789",
  "images": {
    "web": "ghcr.io/songzhiyuan98/alphanet-web@sha256:…",
    "api": "ghcr.io/songzhiyuan98/alphanet-api@sha256:…",
    "mcp": "ghcr.io/songzhiyuan98/alphanet-mcp@sha256:…",
    "worker": "ghcr.io/songzhiyuan98/alphanet-worker@sha256:…",
    "migrate": "ghcr.io/songzhiyuan98/alphanet-migrate@sha256:…"
  }
}
```

Headers include:

```text
Content-Type: application/json
Authorization: Bearer <environment-specific-token>
Idempotency-Key: deploy:<repository>:<environment>:<sha>
```

The generic hook must synchronously finish rollout and verification within 15
minutes, then return HTTP 2xx with:

```json
{
  "status": "succeeded",
  "environment": "staging",
  "sha": "0123456789abcdef0123456789abcdef01234567",
  "deploymentId": "provider-deployment-id"
}
```

A `202`, `running`, empty body, mismatched SHA/environment, missing deployment
ID, non-2xx response, or timeout is a workflow failure. Retries reuse the same
idempotency key.

After provider selection, replace this synchronous compatibility hook with
provider-native GitHub OIDC: call the provider API, poll asynchronous deployment
state to a terminal result, confirm the running image digests, and execute smoke
checks. Do not treat “request accepted” as deployment success.

## Provider-side deployment contract

The provider integration must:

- authenticate the caller and require HTTPS;
- accept only the five digest references supplied by the manifest;
- authenticate private GHCR pulls with a provider-held, read-only package
  credential;
- persist release SHA, manifest checksum, all five digests, actor, timestamps,
  and provider deployment ID;
- treat the idempotency key as a target-state command;
- serialize deployment and migration per environment;
- run the `migrate` image once with a short-lived DDL-capable database identity;
- stop on migration failure before rolling out application processes;
- roll out API, MCP, Worker, and Web in a schema-compatible order;
- wait for API/MCP readiness; for Worker, verify process stability and
  queue/outbox progress because it intentionally has no HTTP port;
- execute public and authenticated smoke tests;
- emit deployment markers and retain the prior known-good digests.

The `migrate` image contains only the migration runner and migrations from the
same release commit. Never substitute migrations from a checkout, shared
volume, or moving branch.

## Database migration policy

The migration container uses PostgreSQL 17 client tooling and advisory locking.
The provider supplies `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and
`PGPASSWORD` (or an equivalent short-lived credential) and runs the image as a
one-shot job.

Use expand/contract:

1. **Expand:** add backward-compatible tables, columns, indexes, or nullable
   constraints.
2. Deploy code that tolerates both old and new schema shapes.
3. Backfill in bounded, restartable batches.
4. Verify counts, invariants, latency, locks, and replication impact.
5. **Contract:** remove obsolete schema only in a later release.

Before production:

- test an empty-database migration;
- test upgrade from the deployed schema;
- test old and new applications against the expanded schema;
- estimate locks and duration on production-sized data;
- confirm a recent restorable backup and point-in-time recovery;
- confirm only the migration identity has DDL permission.

Do not run concurrent migration jobs. Automatic down migrations are not the
normal rollback mechanism.

## Post-deployment verification

At minimum verify:

- Web readiness and a public read;
- API readiness and a canonical read;
- MCP readiness, initialization, and `tools/list`;
- PostgreSQL and Redis connectivity;
- one controlled write/read path in staging;
- outbox consumption and projection completion;
- running digest equality with the release manifest;
- error rate, latency, queue depth, database saturation, and authentication
  failures.

Containers starting is not a successful deployment.

## Application rollback

Use application rollback only when the current schema is compatible:

1. Identify the last known-good SHA and its unexpired CI release manifest.
2. Confirm the manifest's five digests match the recorded deployment.
3. Confirm no incompatible contract migration has occurred.
4. Dispatch `Manual Deploy` from `main`.
5. Enter the full known-good SHA, select the environment, and explicitly confirm
   production when applicable.
6. Observe migration idempotency, rollout, digest placement, smoke checks, error
   rate, latency, and Worker progress.
7. Record the incident, old/new SHAs and digests, migration state, actor, and
   result.

The workflow rejects branches, tags, abbreviated SHAs, SHAs outside `main`,
unsuccessful CI runs, expired/missing manifests, and checksum/digest mismatch.
If the artifact has expired, reconstructing image names from tags is not an
approved shortcut; create a reviewed recovery process that independently
attests existing digests.

## Migration failure

1. Stop further rollout.
2. Let a transactional failure roll back.
3. Otherwise create a reviewed, restartable forward fix.
4. Roll application images back only if the current schema remains compatible.
5. Use point-in-time restore only for destructive corruption or unrecoverable
   data loss, under an incident process that accounts for RPO and lost writes.

## Emergency controls

- Revoke the affected hook token to stop authenticated deployment.
- Set `ENABLE_STAGING_DEPLOY=false` to disable automatic staging explicitly.
- Do not “disable” deployment by deleting a URL while leaving the flag enabled;
  missing credentials intentionally fail.
- The staging and production concurrency groups prevent overlapping
  deployments.
- Disable a workflow only when the deployment system itself is unsafe; record
  who did it, why, and how delivery resumes.

After an emergency deployment or rollback, restore repository and deployed state
to a reproducible, reviewed release.
