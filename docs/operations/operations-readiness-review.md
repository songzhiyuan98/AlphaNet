# Operations readiness release review

This gate proves that AlphaNet can receive a report, assign an accountable
operator, contain an incident, communicate status, recover safely and retain a
non-sensitive record. Repository runbooks are preparation; they do not pass the
gate by themselves.

Run the review against the exact release-candidate SHA in the isolated staging
environment. Do not use a destructive scenario against Production.

## Required public surfaces

Before the drill:

1. Publish a public HTTPS status page outside the AlphaNet application failure
   domain. It must identify the Web, API, Remote MCP, asynchronous processing
   and authentication components and support timestamped incident updates.
2. Publish a monitored security contact as an email address or public HTTPS
   reporting page. `SECURITY.md` remains the handling policy; a repository-only
   contact is not sufficient for public launch.
3. Assign a named primary on-call owner and a backup. Confirm both can receive
   the configured AWS operations notification and reach the workforce Admin
   surface with MFA.
4. Confirm the current deployment manifest, rollback release, database restore
   path, community-write control and registration emergency control are known.

The status page must not expose internal resource identifiers, queue depth,
private research, credentials or security investigation details.

## MVP incident drill

Use the `platform_write_containment` scenario unless an equivalent real
release-candidate incident already exercised every check below.

1. A reviewer injects a synthetic integrity alarm into the candidate incident
   channel and records the start time.
2. The on-call owner acknowledges it, opens an incident record, assigns an
   incident commander and identifies the exact candidate SHA.
3. The commander verifies public reads and Admin governance remain healthy,
   then follows
   [Community write emergency control](./community-write-emergency-control.md)
   to pause public mutations.
4. Verify a new write fails with `PLATFORM_WRITE_PAUSED`, while public Search,
   notification reads, reporting and credential revocation still work.
5. Publish an investigating update on the public status page. Use only a
   synthetic incident description.
6. Satisfy the recorded recovery condition, resume mutations and run the
   idempotent write and social-action canaries.
7. Observe error rate, latency, queue age and write throughput for at least
   fifteen minutes. Publish a resolved status update.
8. Assign every follow-up action to a named owner with a deadline. A reviewer
   other than the incident commander confirms the timeline and evidence.

The drill fails when:

- no accountable on-call owner receives or acknowledges the alarm;
- containment disables reads, governance or credential revocation;
- the status page or security contact is unavailable;
- direct database edits are used;
- the recovery canary or fifteen-minute observation fails;
- the drill takes more than four hours; or
- follow-up work has no owner.

Fix the cause and rerun the complete drill. Do not change a failed record to
`pass`.

## Evidence

Write `artifacts/release/operations-readiness.json` with mode `0600` beside the
other exact-SHA release evidence:

```json
{
  "schema_version": "1",
  "gate": "operations_readiness",
  "release_sha": "0123456789abcdef0123456789abcdef01234567",
  "result": "pass",
  "observed_at": "2026-07-23T22:00:00.000Z",
  "status_url": "https://status.example.com",
  "security_contact": "security@example.com",
  "on_call_owner": "Named primary operator",
  "incident_drill": {
    "result": "pass",
    "scenario": "platform_write_containment",
    "commander": "Named incident commander",
    "reviewer": "Named independent reviewer",
    "started_at": "2026-07-23T21:00:00.000Z",
    "ended_at": "2026-07-23T21:35:00.000Z",
    "checks": {
      "detection": true,
      "triage": true,
      "containment": true,
      "stakeholder_update": true,
      "recovery": true,
      "follow_up_ownership": true
    }
  },
  "contains_credentials_or_content": false
}
```

Use real accountable names in the private release evidence. Do not include
access tokens, cookies, AWS account IDs, internal hostnames, user identifiers,
post bodies, moderation notes or vulnerability details.

Validate the complete release record:

```bash
chmod 0600 artifacts/release/operations-readiness.json
RELEASE_SHA="$(git rev-parse HEAD)" pnpm mvp:release:report
```

The release remains `NO_GO` until the exact candidate has a valid operations
record and every other release gate passes.
