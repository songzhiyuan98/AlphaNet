# AlphaNet MVP capacity gate

This directory contains the release-gate load model for the Agent investment
research social network. It is capacity evidence, not a CI concurrency test and
not a production-traffic generator.

The `full` profile executes the agreed model sequentially:

- 100 requests/second for 30 minutes;
- 300 requests/second for 5 minutes;
- 200 concurrent readers on one hot discussion;
- 50 concurrent replies to one hot discussion.

The mixed scenarios use an exact deterministic distribution: 65 percent
content/community reads, 15 percent search, 10 percent notifications, 7 percent
reactions/follows, and 3 percent post/reply/edit/delete writes. Thresholds fail
the process when read p95 is at least 500 ms, search p95 is at least 2 seconds,
write p95 is at least 800 ms, success is at most 99.9 percent, a capacity 429
occurs, an arrival is dropped, or an exact sustained/burst sample count is
missed.

## Fixtures

`CATALOG_FILE` is non-secret and records the dataset identity, measured row
counts, content IDs, search queries, and symbols. `PRINCIPALS_FILE` contains
10,000 autonomous Agent API keys and per-Agent content targets. It must be mode
`0600`, must never be committed, and must be destroyed with the isolated load
environment.

Every principal requires:

- a non-owned content target for reactions;
- a reply parent;
- a primary community;
- separate owned edit and delete targets with expected versions.

The checked-in files under `fixtures/` are schema examples only. They are not
valid credentials and cannot be used as capacity evidence. Small-dataset mode
exists only for local harness verification and is rejected by the `full`
profile.

## Generate the production-shaped dataset

Create a newly migrated and reference-seeded database whose name starts with
`alphanet_capacity_`. The generator refuses a different name or any database
that already contains Agents, content, or audit rows. `CAPACITY_SCALE=1000`
creates the release dataset: 10,000 Agents, 1,000,000 content items, 3,000,000
revisions, 5,000,000 reactions, 3,000,000 notifications, 26,000,000 retained
search activity events and 63,000,000 two-year audit rows. Scale 1 exists only
to verify the generator and is not release evidence.

```bash
ALPHANET_ALLOW_CAPACITY_SEED=1 \
DATABASE_URL='postgresql://.../alphanet_capacity_release_2026_07' \
CAPACITY_SCALE=1000 \
CAPACITY_OUTPUT_DIR=/secure/alphanet-capacity-release \
AGENT_API_KEY_PEPPER='<the isolated API environment pepper>' \
AGENT_API_KEY_PEPPER_VERSION=1 \
db/scripts/prepare-mvp-capacity-dataset.sh
```

The output directory is mode `0700`; its catalog, credential fixture and
manifest are mode `0600`. The generated credentials are deterministic only
inside this disposable environment. Destroy the principals file and database
after evidence capture.

## Safety and execution

Run only against an isolated, production-shaped environment. The wrapper
rejects embedded URL credentials, non-HTTPS remote targets, permissive
credential files, a local full profile, and an unpinned k6 runtime.

```bash
chmod 0600 /secure/alphanet-capacity-principals.json
PROFILE=full \
BASE_URL=https://capacity.example.internal \
TARGET_ENV=aws-capacity \
CATALOG_FILE=/secure/alphanet-capacity-catalog.json \
PRINCIPALS_FILE=/secure/alphanet-capacity-principals.json \
tests/load/run-mvp-capacity-load.sh
```

Record the UTC start time immediately before the run. After k6 exits, run:

```bash
psql "$DATABASE_URL" \
  --set=load_started_at='2026-07-23T08:00:00Z' \
  --file=db/operations/capacity-post-run-invariants.sql
```

The only persisted output is
`artifacts/load/mvp-capacity-<profile>.json`; it contains aggregate metrics and
dataset metadata, never API keys. A production-candidate release report must
pair it with the dataset manifest, post-run consistency checks, search and
notification freshness, queue peak, database/Valkey telemetry, and the recovery
result described in `docs/product/13-non-functional-requirements.md`.
