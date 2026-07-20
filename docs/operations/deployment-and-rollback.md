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
- expose API only behind the private ingress path, set
  `API_TRUSTED_PROXY_CIDRS` to the actual ingress source ranges, and overwrite
  rather than pass through client-supplied forwarding headers;
- suppress query strings from all `/api/auth/*` access logs and traces, record
  authentication paths only as route templates, and verify CDN/APM/browser
  analytics do not collect one-time tokens or OAuth code/state values;
- wait for API/MCP readiness; for Worker, verify process stability and
  queue/outbox progress because it intentionally has no HTTP port;
- execute public and authenticated smoke tests;
- emit deployment markers and retain the prior known-good digests.

The `migrate` image contains only the migration runner and migrations from the
same release commit. Never substitute migrations from a checkout, shared
volume, or moving branch.

PendingAction commands contain unpublished research and are encrypted at rest
with application-layer AES-256-GCM. Supply the same
`PENDING_ACTION_ENCRYPTION_KEY`, version, and bounded previous-key ring to API
and Worker replicas. Keep these values in the deployment secret manager, never
in an image, build argument, browser variable, log, or database. Rotate by
deploying readers with the old key in
`PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS` before switching writers to the new
version; remove an old key only after every action encrypted with it is
terminal and beyond its retention window.

Set `COMMUNITY_CURSOR_SIGNING_KEY` from the deployment secret manager as well.
It signs the short-lived directory cursor and never carries raw proposed
research text. Rotating it intentionally invalidates cursors issued by the
previous release; clients restart the directory query.

Set PostgreSQL `log_parameter_max_length=0` and
`log_parameter_max_length_on_error=0` in every environment, including managed
production. Slow-query logging may retain statement templates and duration, but
must never retain bind values because Community searches can contain unpublished
research and authentication or write statements can contain secrets. Apply the
equivalent managed-database parameter group before traffic cutover and verify
both values with `SHOW`. API and MCP reject startup and readiness while either
setting is unsafe; Worker rejects startup before claiming work. Configure the
values at the server, database, or role level before starting AlphaNet. The
runtime identity needs permission to read the settings, not superuser permission
to change them. In particular, do not solve this by granting the application
role the superuser-only ability to set `log_parameter_max_length` in each
connection. AlphaNet also rejects client/session overrides of these settings:
an override could make its probe connection appear safe while an independent
pool, such as the Owner authentication pool, remained unsafe. Probe connections
are recycled within one second so database/role-default changes cannot remain
hidden in a long-lived session. API and MCP surface the next fresh failure
through readiness; Worker revalidates immediately before every outbox claim and
stops claiming when the invariant fails.

## SSR client identity and rate-limit boundary

Next.js server rendering reaches the API over the private service network, so
the API socket sees a Web replica rather than the browser. AlphaNet preserves
the browser's rate-limit identity with a signed, short-lived forwarding
assertion. The following are production deployment invariants:

- `SSR_INTERNAL_REQUEST_SECRET` is a server-only, environment-specific,
  high-entropy secret. Every Web and API replica in one environment must receive
  the same value; it must not use a `NEXT_PUBLIC_` name, enter an image build
  argument, or be exposed to the browser. Rotate it as a coordinated rollout so
  Web signers and API verifiers do not temporarily disagree.
- Production Web replicas must be private behind an ingress that removes or
  overwrites caller-supplied `X-Real-IP` and replaces or safely appends
  `X-Forwarded-For`. Do not expose a Web pod or container directly to the public
  network: Web signs the sanitized ingress chain for its internal API request.
- `API_TRUSTED_PROXY_CIDRS` must enumerate the exact source IPs or bounded CIDRs
  of every trusted ingress/proxy hop in the deployed chain, not only the final
  load balancer. Never use a catch-all network. This list governs both direct
  API requests and right-to-left resolution of signed SSR forwarding chains.
- `SSR_ALLOW_MISSING_CLIENT_IP=true` is permitted only for the repository's
  loopback-bound local Compose topology, where there is no ingress to add a
  forwarding header. It must be absent or `false` in staging and production.

Before opening traffic, issue public and authenticated SSR requests through
each Web replica and confirm that requests from the same test client consume
the same Redis IP bucket. Also verify that a forged, expired, or path-replayed
SSR assertion falls back to the API-validated socket/proxy address. A production
Web request without a trusted forwarding identity must fail closed; do not
restore availability by enabling the local-only exception.

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
- confirm only the migration identity has DDL permission;
- use a separate runtime identity with no schema ownership or DDL, no direct
  `INSERT`/`DELETE` on `platform.owners`, and only the table/column privileges
  required by the released application. Local Compose's shared database owner
  is a development convenience and is not a production role model;
- confirm every `SECURITY DEFINER` function has a fixed search path, a fixed
  trigger binding check, and no `PUBLIC EXECUTE`.

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
