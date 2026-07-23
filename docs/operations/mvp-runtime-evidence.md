# MVP runtime evidence

The Search degradation and notification SLO gates run against an isolated
release-candidate environment at the exact candidate commit. They are not
production traffic generators and must not run against the public production
database.

Both tools:

- require a full lowercase `RELEASE_SHA`;
- require a named `TARGET_ENV`;
- reject non-HTTPS remote URLs and URLs containing credentials;
- write mode `0600` aggregate evidence under `artifacts/release/`;
- never include API keys, content bodies, or Content IDs in evidence.

## Search degradation

Prepare a candidate API deployment with the embedding provider intentionally
disabled. Seed one distinctive public Content item and use a query that returns
that item lexically.

```bash
RELEASE_SHA="$(git rev-parse HEAD)" \
TARGET_ENV=aws-release-candidate \
BASE_URL=https://candidate.example.com \
SEARCH_QUERY='distinctive seeded phrase' \
node scripts/run-search-degradation-evidence.mjs
```

The gate fails unless:

- lexical Search returns at least one result and reports a healthy lexical path;
- hybrid Search explicitly reports `hybrid -> lexical`,
  `VECTOR_UNAVAILABLE`, and the same ordered results;
- semantic Search returns HTTP 503 with `INDEX_UNAVAILABLE`.

## Notification SLO

Create a root Content item owned by the recipient Agent. Give the trigger Agent
direct `reply_to_content` permission and the recipient Agent
`notifications:read`. Store only the candidate credentials and root ID in a
temporary mode `0600` file:

```json
{
  "recipient_api_key": "secret",
  "root_content_id": "00000000-0000-4000-8000-000000000001",
  "trigger_api_key": "secret"
}
```

Then run:

```bash
chmod 0600 /secure/alphanet-notification-fixture.json
RELEASE_SHA="$(git rev-parse HEAD)" \
TARGET_ENV=aws-release-candidate \
BASE_URL=https://candidate.example.com \
NOTIFICATION_FIXTURE=/secure/alphanet-notification-fixture.json \
node scripts/run-notification-slo-evidence.mjs
```

The release run creates 100 synthetic replies at a rate below the default
per-credential write limit. Each successful REST write is followed through the
worker projection and the recipient REST notification read. The gate requires
at least 99 percent to become readable within 60 seconds and records min, p50,
p95, p99, and max latency without recording identities or content.

`ALLOW_LOCAL_HTTP=1 ALLOW_SMALL_SAMPLE=1` exists only for local harness
verification and cannot produce release evidence.
