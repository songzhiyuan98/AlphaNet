# 0020 — Admin Owner capacity governance v1

Status: accepted for MVP implementation

Scope: workforce Owner lookup, temporary active-Agent quota overrides, emergency
registration controls, immutable governance provenance and atomic activation
enforcement

## Decision

AlphaNet adds one small workforce surface for the two capacity controls that are
already authoritative in Agent activation:

1. the effective active-Agent limit of one Owner; and
2. the platform-wide `open | paused` registration mode and active-Agent
   operating/hard limits.

This closes AC-ID-03A and the operator side of AC-ID-03B. It does not add invite
codes, a waitlist, manual Owner approval, Agent-type exceptions, billing tiers,
or a way for an administrator to impersonate an Owner or Agent.

## Endpoints

```text
GET  /v1/admin/owners
GET  /v1/admin/owners/{owner_id}
POST /v1/admin/owners/{owner_id}/quota-actions

GET  /v1/admin/capacity
POST /v1/admin/capacity/actions
```

Every endpoint requires workforce OIDC with MFA and
`identity:quota_manage`. Mutations revalidate the exact permission and active
Admin assignment inside the database transaction.

Both action endpoints require:

```text
If-Match: "<positive version>"
Idempotency-Key: <16..128 printable non-secret characters>
```

The Owner ID, Admin identity, expected version and idempotency key are never
accepted from a JSON body.

## Owner projection and quota model

The Owner list is a bounded signed keyset ordered by
`created_at DESC, id DESC`, with optional exact lifecycle-state filters and a
normalized query over stable Owner ID and email. Email is visible only in this
workforce identity-capacity workspace and never appears in public, Agent or MCP
responses.

The detail projection contains:

- stable Owner ID, masked operational email, status and verification/lifecycle
  timestamps;
- `quota_version`;
- base, effective and currently used active-Agent counts;
- current unexpired override, when present;
- aggregate Agent and Credential counts;
- no password hash, OAuth token, session, API key, digest, pepper, research
  content or private moderation evidence.

`owners.base_active_agent_limit` remains the immutable product default for that
Owner. A new append-preserving `owner_agent_quota_overrides` relation stores
temporary changes. The effective limit at transaction time is:

```text
unrevoked override whose expires_at > transaction time
  ?? owners.base_active_agent_limit
```

At most one unrevoked override may exist per Owner. Replacing an override first
revokes the old row and then inserts the new row in the same transaction.
Expiration requires no cleanup job and automatically returns authority to the
base limit.

An override accepts `max_active_agents` from 1 through 1,000 and requires an
expiry more than one hour and no more than 90 days in the future. Increasing or
decreasing the quota never archives or activates an Agent by itself. A new
activation still locks the Owner, resolves the effective quota, locks the
global registration singleton and atomically reserves one global capacity
slot.

Supported quota actions are:

```text
set_override
revoke_override
```

Controlled reasons are:

```text
validated_operational_need
research_team_expansion
migration_support
abuse_mitigation
security_incident
```

No reason refers to model vendor, Agent type, automated trading or perceived
research quality.

## Registration control

The existing singleton remains authoritative:

```text
mode: open | paused
version: positive monotonic integer
active_agent_count
active_agent_operating_target
active_agent_hard_limit
```

Supported actions are:

```text
pause_registration
resume_registration
set_capacity_limits
```

Pause reasons are:

```text
capacity_threshold_reached
automated_abuse_incident
security_incident
infrastructure_degradation
```

Resume reasons are:

```text
capacity_available
incident_resolved
false_positive_corrected
```

Pausing requires a bounded human-readable recovery condition. It blocks only
new Auth User registration at the database guard; existing Owners can still
log in, read and manage existing identities. It does not create any queued
identity or waitlist record.

Capacity limits must satisfy:

```text
operating_target <= hard_limit <= 10,000
active_agent_count <= hard_limit
```

The 10,000 ceiling is the MVP validated design capacity. Raising it requires a
new load-test artifact and reviewed migration; an operator action cannot expand
an unvalidated safety boundary.

## Versioning and idempotency

`owners.quota_version` is a positive monotonic counter owned by quota
governance. Each successful, non-replayed quota action advances it exactly
once. The registration singleton's existing `version` advances exactly once
per successful control action.

`owner_capacity_admin_actions` is append-only and permanently unique on
`(admin_id, idempotency_key)`. It stores:

- action kind and target;
- canonical request digest;
- permission used;
- controlled reason and occurrence time;
- before/after versions and secret-free state;
- frozen response;
- corresponding ActionLog and Outbox IDs.

An exact replay returns the frozen response without applying the command again.
Reusing the key with a different target or request fails. Stale `If-Match`
fails without a partial state change.

## Provenance

Every successful mutation atomically:

1. locks and revalidates the Admin assignment and
   `identity:quota_manage`;
2. locks the target Owner or registration singleton;
3. checks the strong version and action transition;
4. updates the quota fact or registration control;
5. inserts one immutable governance ActionLog;
6. inserts one redacted Outbox event;
7. inserts one append-only Admin action fact.

Deferred database constraints require those records to share the same
transaction and exact target/version/action metadata.

Outbox event types are:

```text
owner.agent_quota_override_set
owner.agent_quota_override_revoked
registration.paused
registration.resumed
registration.capacity_limits_changed
```

Payloads contain only stable IDs, controlled reasons, versions, limits and
expiry. They never contain email or free-form recovery text.

## Runtime privileges

The application runtime receives:

- `SELECT` on both new tables;
- exact-column `INSERT` on the append-only action table and quota-override
  table;
- exact-column `UPDATE` on quota override revocation fields,
  `owners.quota_version`, and reviewed registration-control fields.

It receives no `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, schema creation,
or mutation access to Admin role tables.

## Web

The workforce Web adds a “容量治理” workspace using the existing Admin
navigation, OIDC session boundary and problem presentation. It supports:

- inspecting global registration mode and capacity;
- pausing/resuming registration and safely changing validated limits;
- finding an Owner and inspecting the effective quota;
- setting or revoking a temporary override;
- recovering from stale versions and displaying stable request IDs.

The UI never exposes a secret and never represents quota changes as a product
tier or endorsement.

## Acceptance

The slice is accepted only when tests prove:

1. list/detail are bounded, permission-protected and secret-free;
2. all actions, controlled reasons, ranges and stale versions are enforced;
3. permission is revalidated under lock at mutation time;
4. replay, conflicting keys and concurrent commands cannot double-apply;
5. override/control, ActionLog, Outbox and action fact are all present or absent
   together;
6. create and explicit activation both use the same effective temporary quota,
   including expiry and revocation;
7. parallel activation cannot exceed the effective Owner quota or global hard
   limit;
8. paused registration leaves no Auth User or Owner projection while existing
   authentication remains available;
9. the workforce Web can operate the complete slice through the API without
   direct database access;
10. forward migration, restored-backup verification, runtime least privilege,
    unit, integration and browser E2E gates all pass.
