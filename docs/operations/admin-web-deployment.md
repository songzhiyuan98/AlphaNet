# Workforce Admin Web deployment

The moderation console is a workforce control plane, not an Owner or Agent
surface. AWS keeps both `ADMIN_WEB_ENABLED` and `ADMIN_API_ENABLED` false until
one Terraform gate proves the browser client, API verifier, strong MFA,
fixed-domain, WAF, session-store, and secret prerequisites together.

Enabling the gate does not create an administrator. Migration `000015` creates
the deny-by-default roles and permissions, but a reviewed operator must
separately provision the exact workforce `(issuer, subject)` in
`platform.admins` and grant only the required role in
`platform.admin_assignments`. Do not reuse an Owner, Agent Credential, local
password, or request-header bypass.

## Deployed boundary

When `admin_web_enabled=false` (the default):

- no DynamoDB Admin session table or Admin Web task role exists;
- Web receives only `ADMIN_WEB_ENABLED=false` and API receives only
  `ADMIN_API_ENABLED=false`;
- no workforce OIDC tuple or Admin secret selector is placed in either ECS task
  definition.

When enabled:

- Web runs a server-side confidential OIDC authorization-code flow. It derives
  the sole callback as `https://<domain_name>/admin/auth/callback` and resolves
  authorization/token endpoints through issuer discovery; these endpoints are
  not Terraform variables;
- API verifies the resulting workforce access token against the same exact
  issuer and audience, the configured JWKS URI and asymmetric algorithm set,
  and either `amr=mfa` or one of the exact accepted `acr` values;
- encrypted, opaque browser sessions live in one on-demand DynamoDB table with
  native TTL. Production additionally enables table deletion protection and
  point-in-time recovery;
- the dedicated Web task role permits only ECS Exec channels and
  `dynamodb:GetItem`, `PutItem`, and `DeleteItem` on that exact table. It has no
  MCP, database, Secrets Manager, scan, query, or table-administration power;
- ECS obtains the client secret, session-encryption key, and API audit-subject
  digest key from named JSON fields in the existing application secret. No
  plaintext value enters tfvars, a plan, task-definition environment, or
  Terraform state.

`ADMIN_WEB_DYNAMODB_ENDPOINT` is local-development-only and is deliberately
never injected by AWS.

## 1. Register the workforce OIDC client

Use a dedicated confidential Web client in the workforce IdP:

1. Register exactly one redirect URI:
   `https://<domain_name>/admin/auth/callback`.
2. Permit authorization code flow and the scopes selected for
   `admin_web_oidc_scopes`; `openid` is mandatory.
3. Set the requested resource to the exact API audience. AlphaNet rejects an
   enabled plan unless `admin_web_oidc_resource == admin_oidc_audience`.
4. Require workforce MFA. Record whether the IdP proves it through `amr=mfa`,
   exact `acr` values, or both.
5. Record the canonical issuer, client ID, API audience, and JWKS URI. The
   issuer and JWKS endpoints must be HTTPS and must not contain query strings
   or fragments.

Verify the issuer discovery document and JWKS from a trusted operator machine.
Do not copy an endpoint from an unverified redirect or use a tenant-agnostic
issuer when tokens carry a tenant-specific `iss` claim.

## 2. Stage the three secret fields

The augmentation script preserves every existing application-secret field,
adds only absent Admin fields, stages an `AWSPENDING` version, and moves
`AWSCURRENT` with a version-ID compare-and-swap. It generates independent
32-byte session-encryption and audit-digest keys; the IdP client secret is never
accepted as a Terraform input.

From `infra/aws`, with the intended environment backend initialized:

```bash
read -r -s ADMIN_WEB_OIDC_CLIENT_SECRET
export ADMIN_WEB_OIDC_CLIENT_SECRET
./scripts/seed-application-secret.sh \
  --augment-admin-web \
  "$(./scripts/terraform.sh output -raw application_secret_arn)" \
  us-west-2
unset ADMIN_WEB_OIDC_CLIENT_SECRET
```

The script refuses to overwrite existing Admin keys or to proceed while an
unresolved `AWSPENDING` version exists. Rotate an existing client secret or
session key only through a separately reviewed, coordinated secret rotation;
blindly rerunning augmentation is not rotation.

Confirm only the key names, never their values:

```bash
aws secretsmanager get-secret-value \
  --region us-west-2 \
  --secret-id "$(./scripts/terraform.sh output -raw application_secret_arn)" \
  --query SecretString \
  --output text |
  jq -e 'has("ADMIN_WEB_OIDC_CLIENT_SECRET") and
    has("ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64") and
    has("ADMIN_AUDIT_SUBJECT_DIGEST_KEY")' >/dev/null
```

Avoid commands that print `SecretString`, shell tracing, CI logs, or committed
local environment files while performing this check.

## 3. Enable the complete Terraform tuple

Keep the checked-in examples false. Copy the appropriate example to an
untracked tfvars file and set values equivalent to:

```hcl
admin_web_enabled             = true
admin_oidc_issuer             = "https://workforce.example/oidc"
admin_oidc_audience           = "https://app.alphanet.example/v1/admin"
admin_oidc_jwks_uri           = "https://workforce.example/oidc/jwks.json"
admin_oidc_allowed_algorithms = ["RS256"]
admin_oidc_allowed_acr_values = []
admin_oidc_allow_amr_mfa      = true

admin_web_oidc_client_id      = "alphanet-admin-web"
admin_web_oidc_scopes         = ["openid", "profile", "email"]
admin_web_oidc_resource       = "https://app.alphanet.example/v1/admin"
admin_web_session_store       = "dynamodb"
admin_web_session_ttl_seconds = 28800
admin_web_login_ttl_seconds   = 600
```

The same plan must retain a non-empty fixed `domain_name`, its us-east-1 viewer
certificate, and `enable_waf=true`. Terraform rejects an incomplete tuple,
HTTP issuer/JWKS, an in-memory AWS session store, resource/audience mismatch,
or a configuration with neither accepted `amr=mfa` nor an allowed `acr` value.

Run the normal plan review and apply. Then publish and deploy a digest-pinned
release through the existing workflow so Web and API both receive their new
task-definition revisions; do not hand-edit the ECS service as the launch
procedure.

## 4. Verify before granting access

Confirm the infrastructure without revealing secret values:

```bash
table_name="$(./scripts/terraform.sh output -raw admin_web_session_table_name)"
aws dynamodb describe-time-to-live \
  --region us-west-2 \
  --table-name "${table_name}"
aws dynamodb describe-continuous-backups \
  --region us-west-2 \
  --table-name "${table_name}"
```

For Production, verify `DeletionProtectionEnabled=true` and
`PointInTimeRecoveryStatus=ENABLED`. Also verify:

- the Web task definition selects the dedicated `*-web-admin-task` role and
  includes exactly the two Admin Web secret selectors;
- the API task definition includes the audit-digest selector and exact
  issuer/audience/JWKS/MFA configuration;
- an unauthenticated `/admin/moderation` request cannot read Case data;
- a valid workforce identity without a provisioned active Admin assignment is
  denied and audited;
- a read-only moderator can list/view but cannot decide; a moderator with
  `moderation:decide` can execute a version-bound, idempotent action;
- the IdP callback, logout/session expiry, CSRF/state/nonce rejection, and an
  actual MFA-authenticated login work through the public fixed domain;
- no bearer token, client secret, session token, private note, or raw workforce
  subject appears in browser storage, URLs, CloudWatch logs, or public API
  responses.

## Disable and recovery

For an active incident, first disable the workforce client or assignments at
the IdP/database authorization boundary and roll back to the last known-good
task definitions. This stops access without deleting recovery evidence.

Changing `admin_web_enabled` back to false removes the conditional table and
role from Terraform. Production table deletion protection intentionally blocks
that destructive apply until a reviewed session-data disposal step explicitly
turns protection off. Do not treat table deletion as an emergency logout
mechanism. Revoke IdP sessions/assignments and expire the session records; only
then perform a reviewed two-step Terraform disposal if the Admin surface is
being retired permanently.
