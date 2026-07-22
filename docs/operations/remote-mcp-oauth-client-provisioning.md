# Remote MCP OAuth resource and client provisioning

Remote MCP OAuth does not expose dynamic client registration. Operators keep
one reviewed JSON allowlist per environment, pin its exact SHA-256 at execution,
and run the reconciler with the migration database identity. Terraform must not
store this mutable allowlist and the application runtime remains `SELECT`-only
on `auth.oauth_clients`.

## Manifest contract

The document has exactly three top-level fields. Each client has exactly five
fields; client secrets and all Better Auth extension metadata are intentionally
unrepresentable.

```json
{
  "schema_version": 1,
  "resource": "https://mcp.staging.alphanet.example/mcp",
  "clients": [
    {
      "client_id": "alphanet-staging-host",
      "name": "Reviewed staging MCP Host",
      "redirect_uris": [
        "http://127.0.0.1:43110/oauth/callback",
        "https://host.staging.example/oauth/callback"
      ],
      "scopes": ["research:read", "community:read", "offline_access"],
      "grant_types": ["authorization_code", "refresh_token"]
    }
  ]
}
```

The reconciler rejects duplicate JSON keys, unknown or missing fields,
duplicate values, noncanonical ordering, unsafe redirect URIs, unsupported
scopes or grants, and an `offline_access`/`refresh_token` mismatch. Clients and
redirect URIs use bytewise ascending order. Scopes use the order shown in
ARCH-0015: read scopes, write scopes, then `offline_access`. Grant types are
either `authorization_code` or `authorization_code`, `refresh_token`.
The reviewed UTF-8 document is limited to 48,000 bytes so its base64-wrapped
JSON remains below the Secrets Manager 65,536-byte value limit.

Every listed client is written as a public client with PKCE required, explicit
consent required, token endpoint authentication `none`, no secret, and response
type `code`. A reserved metadata marker distinguishes these rows from clients
owned by another operator path. A `client_id` collision never adopts or changes
an unmanaged row.

## AWS safety boundary

`mcp_oauth_provisioning_enabled` defaults to `false`. Setting it to `true`
creates only these default-idle resources:

- a dedicated Secrets Manager container with no Terraform-managed version;
- a dedicated ECS execution role that can read the application secret and the
  provisioning secret, pull the migrate image, and write the provisioning log;
- a task role with no permissions; and
- a digest-pinned Fargate task definition with no ECS Service or schedule and
  manifest JSON-key selectors fixed to the unique `ALPHANET_OAUTH_APPROVED`
  stage; and
- a trusted Step Functions launcher whose role alone may run that exact task
  revision and pass its two dedicated roles.

The flag creates the manual operator path; it never executes the reconciler.
Leave it enabled for an environment that operates Remote MCP OAuth so prior
digest-addressed versions remain available for rollback. Do not toggle it off
after each run, because that would schedule the dedicated secret for deletion.

The normal GitHub deploy role cannot run the `oauth-provision` family, invoke
the launcher, or pass either dedicated role. The OAuth task, secret, and
launcher are absent from `deployment_github_variables`, so ordinary CI/CD
cannot trigger this path.

This is a direct control-plane separation, not a claim that the release system
is outside the production database trust boundary. The protected GitHub deploy
environment deliberately runs reviewed forward migrations with the
`alphanet_migration` identity; like any database owner, that identity could
change OAuth schema or data if untrusted migration code were approved. Treat
production deployment approval, branch protection, artifact provenance, and
the operator provisioning review as one production trust chain. The dedicated
launcher still prevents a routine deploy job from silently substituting or
starting an OAuth manifest task.

## Staging workflow on AWS

1. Apply migrations `000018` through `000020`. Keep
   `MCP_PUBLIC_ENABLED=false`. API readiness deliberately rejects an OAuth
   server whose lifecycle queue, reconciliation ledger, or maintenance
   functions from `000020` are absent.
2. Choose the canonical staging Resource before creating a Grant. It must be the
   final HTTPS `/mcp` URL, not a generated CloudFront hostname.
3. Add or update the staging manifest in a reviewed pull request. Review every
   redirect URI, requested scope, and refresh grant. Do not use a downloaded or
   locally edited copy after approval.
4. On the approved revision, calculate the artifact digest without printing the
   document:

   ```bash
   manifest=/secure/reviewed/alphanet-staging-oauth-clients.json
   export ALPHANET_OAUTH_MANIFEST_SHA256="$(sha256sum "$manifest" | awk '{print $1}')"
   ```

   On macOS, use `shasum -a 256` instead of `sha256sum`.

5. Resolve the trusted launcher and dedicated secret from the applied Terraform
   environment:

   ```bash
   LAUNCHER="$(cd infra/aws && ./scripts/terraform.sh output -raw oauth_provisioning_state_machine_arn)"
   SECRET="$(cd infra/aws && ./scripts/terraform.sh output -raw oauth_client_provisioning_secret_arn)"
   ```

6. Stage the exact reviewed bytes. The helper writes a JSON secret version with
   the SHA-256 as its immutable Secrets Manager VersionId, then moves the unique
   `ALPHANET_OAUTH_APPROVED` stage to it. The document travels through a
   mode-`0600` file reference and never enters AWS CLI arguments or normal
   output:

   ```bash
   bash infra/aws/scripts/stage-oauth-client-manifest.sh \
     "$manifest" "$SECRET" us-west-2
   ```

7. Launch the one-off task through the trusted state machine. The local helper
   verifies that the exact digest owns the unique approval stage, then starts
   only the supplied active `STANDARD` state machine. Its immutable definition
   fixes the exact Terraform task revision, command, image, roles, private
   networking, and approved-stage JSON-key selectors. The expected digest is
   passed as a non-secret value and rechecked in the task, so an approval-stage
   race fails before PostgreSQL:

   ```bash
   bash infra/aws/scripts/run-oauth-provisioning-job.sh \
     "$LAUNCHER" \
     "$SECRET" \
     "$ALPHANET_OAUTH_MANIFEST_SHA256" \
     us-west-2
   ```

   The task receives the migration password and manifest through ECS Secrets
   Manager injection, connects through the migration security group with public
   IP assignment disabled, and passes the manifest to PostgreSQL through
   `COPY STDIN`.

8. Verify OAuth readiness and the reviewed Host flow while the public MCP gate
   remains closed. Public exposure is a separate ARCH-0015 gate.

The wrapper sends the manifest through PostgreSQL `COPY STDIN`; it does not put
document values in process arguments, SQL text, or normal output. Any parse,
validation, collision, lock, resource, write, or verification failure rolls the
whole transaction back and emits only a generic operator error.

### Operator IAM

Keep this permission set outside GitHub Actions. The staging identity needs
`secretsmanager:DescribeSecret`, `secretsmanager:PutSecretValue`, and
`secretsmanager:UpdateSecretVersionStage` on the dedicated secret. The launch
identity needs `secretsmanager:DescribeSecret` on the dedicated secret plus
`states:DescribeStateMachine`, `states:StartExecution`,
`states:DescribeExecution`, and `states:StopExecution` on the exact launcher.
It must have no `ecs:RegisterTaskDefinition`, `ecs:RunTask`, or `iam:PassRole`.
Neither helper reads the manifest back with `GetSecretValue`; only the trusted
Fargate execution role can resolve the approved-stage JSON fields. The Step
Functions execution role—not the human operator—holds narrowly scoped
`ecs:RunTask` and `iam:PassRole` authority for one exact revision and two exact
roles.

## Direct local or emergency database path

Outside ECS, export libpq `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and
`PGPASSWORD` for the migration identity. Do not place a password-bearing
database URL on the command line and do not enable shell xtrace. Then run:

```bash
export ALPHANET_MIGRATION_ROLE=alphanet_migration
export ALPHANET_EXPECTED_OAUTH_RESOURCE=https://staging.alphanet.example/mcp
bash db/scripts/aws-reconcile-remote-mcp-oauth-clients.sh "$manifest"
```

This is not the normal AWS production path; it exists for isolated integration
environments and an explicitly approved database-operator recovery procedure.

## Disable and rollback

- Omitting a previously AlphaNet-managed client disables it atomically. Its
  reviewed public configuration remains for audit and a later rollback, but it
  cannot authorize, refresh, or pass current Client authority checks.
- An approved manifest with `"clients": []` is the emergency disable-all
  operation for AlphaNet-managed clients. It never changes unmanaged clients.
- To roll back a client change on AWS, recompute and verify the previously
  approved file's SHA-256, run `stage-oauth-client-manifest.sh` to move
  `ALPHANET_OAUTH_APPROVED` back to that immutable version, and launch
  `run-oauth-provisioning-job.sh` with that exact digest. The staging command is
  idempotent when the digest version already exists. Entries restored by that
  manifest are enabled; entries absent from it are disabled.
- The canonical Resource is an immutable singleton. Re-running the same value
  is idempotent; a different value is rejected before client writes. A mistaken
  Resource cannot be rolled back by this command and requires a reviewed
  forward migration before any Grant or token exists. Treat a mismatch as a
  deployment stop.

No manifest may contain a secret. OAuth client secrets, confidential clients,
dynamic registration, skip-consent, and PKCE opt-out are outside the v1
operator contract.
