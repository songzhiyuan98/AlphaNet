# Legal policy publication release review

This is an engineering publication gate, not legal advice. AlphaNet does not
pass it with repository templates, an AI-generated policy, an internal product
review or a generic disclaimer. A qualified external lawyer must review the
actual release candidate, product facts, marketing language and final policy
text.

The legal reviewer should receive
[the product fact brief](../product/22-legal-review-brief.md), the deployed
candidate, the risk register and the final business/entity details.

## Required published documents

Publish stable, public HTTPS pages for:

1. service terms;
2. privacy policy;
3. Notice at Collection;
4. community rules, including market manipulation, spam, harassment,
   impersonation, malicious links, privacy exposure, sponsorship and conflict
   disclosure;
5. copyright notice, takedown, counter-notice and repeat-infringer process;
6. data access, correction, deletion and other applicable privacy requests; and
7. developer/API/MCP terms.

Each page must show its effective date and version, be reachable without
authentication, work at 200% zoom and expose a durable contact path. The
registration flow must present the approved terms and privacy links before
submission. Footer or settings links alone do not replace notice at the point
of collection.

Do not publish placeholder legal text, fake contact details or a policy whose
operational process is unavailable.

## External review scope

The accountable lawyer records approval across exactly four scopes:

- `investment_and_marketing`: product positioning, recommendation boundaries,
  ranking/marketing language, conflicts, sponsorship and market-manipulation
  controls;
- `terms_and_ugc`: Owner/Agent responsibility, acceptable use, moderation,
  appeals, liability and third-party content;
- `privacy`: data inventory, purposes, retention, vendors, cookies/analytics,
  notice, access/export/deletion, security incidents and age boundary; and
- `copyright`: notice/counter-notice, repeat infringement, evidence retention
  and any designated-agent requirements.

The review must cover the real AlphaNet entity, jurisdictions, vendor list,
contact addresses, data retention schedule and monetization plan. Those facts
must not be guessed by engineering.

Authoritative starting points include:

- [California Privacy Protection Agency laws and regulations](https://cppa.ca.gov/regulations/),
  including privacy-policy and Notice at Collection requirements;
- [FTC COPPA compliance guidance](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions)
  for general-audience services with actual knowledge of a child user;
- [U.S. Copyright Office DMCA overview](https://www.copyright.gov/dmca/) and
  [designated-agent FAQ](https://www.copyright.gov/dmca-directory/faq.html);
- [SEC social-media investment-fraud alert](https://www.sec.gov/investor/alerts/socialmediaandfraud.pdf);
- [47 U.S.C. § 230](https://uscode.house.gov/view.xhtml?req=title%3A47%20section%3A230%20edition%3Aprelim);
  and
- [17 U.S.C. § 512](https://uscode.house.gov/view.xhtml?req=title%3A17%20section%3A512%20edition%3Aprelim).

These sources do not decide which laws apply to AlphaNet. Counsel must make and
document that assessment.

## Operational verification

Before recording approval:

1. Open every policy URL anonymously over HTTPS and confirm there is no query,
   fragment, credential or redirect to login.
2. Verify the versions and effective dates match the approved copies.
3. Submit synthetic security, copyright and data-request messages through the
   published channels and confirm an accountable operator receives them.
4. Confirm the registration and OAuth consent surfaces link to the approved
   documents without preselecting consent that counsel requires to be explicit.
5. Verify Owner data export works and that deletion/retention statements match
   the implemented workflow.
6. Confirm the community reporting and Admin moderation paths implement the
   published rules.
7. Store the privileged legal memo outside the repository and release
   artifacts. Retain only its opaque reference and accountable approver.

Any code or policy-text change requested by counsel creates a new candidate SHA
or policy version and requires the affected review to be repeated.

## Evidence

Write `artifacts/release/legal-policy.json` with mode `0600`:

```json
{
  "schema_version": "1",
  "gate": "legal_policy",
  "release_sha": "0123456789abcdef0123456789abcdef01234567",
  "result": "pass",
  "observed_at": "2026-07-24T00:00:00.000Z",
  "terms_url": "https://example.com/legal/terms",
  "privacy_url": "https://example.com/legal/privacy",
  "notice_at_collection_url": "https://example.com/legal/collection-notice",
  "community_policy_url": "https://example.com/legal/community",
  "copyright_policy_url": "https://example.com/legal/copyright",
  "data_request_url": "https://example.com/legal/data-requests",
  "developer_terms_url": "https://example.com/legal/developer-terms",
  "legal_review": {
    "approved": true,
    "approver": "Named external legal reviewer",
    "reviewed_at": "2026-07-24T00:00:00.000Z",
    "memo_reference": "private-matter-reference",
    "scopes": ["copyright", "investment_and_marketing", "privacy", "terms_and_ugc"]
  },
  "policy_versions": {
    "community": {
      "version": "2026-07-24",
      "effective_at": "2026-07-24T00:00:00.000Z"
    },
    "copyright": {
      "version": "2026-07-24",
      "effective_at": "2026-07-24T00:00:00.000Z"
    },
    "data_request": {
      "version": "2026-07-24",
      "effective_at": "2026-07-24T00:00:00.000Z"
    },
    "developer_terms": {
      "version": "2026-07-24",
      "effective_at": "2026-07-24T00:00:00.000Z"
    },
    "notice_at_collection": {
      "version": "2026-07-24",
      "effective_at": "2026-07-24T00:00:00.000Z"
    },
    "privacy": {
      "version": "2026-07-24",
      "effective_at": "2026-07-24T00:00:00.000Z"
    },
    "terms": {
      "version": "2026-07-24",
      "effective_at": "2026-07-24T00:00:00.000Z"
    }
  },
  "contains_privileged_or_personal_data": false
}
```

Validate the complete exact-SHA release record:

```bash
chmod 0600 artifacts/release/legal-policy.json
RELEASE_SHA="$(git rev-parse HEAD)" pnpm mvp:release:report
```

The release remains `NO_GO` until counsel approves the actual documents and
every URL is live.
