# CI/CD and repository protection

## Workflow inventory

| Workflow            | Trigger                                   | Purpose                                                                                                                   |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `CI`                | pull requests to `main`, pushes to `main` | Code/IaC/workflow gates and five container checks; ECR publication and a release manifest only when its switch is enabled |
| `Manual Deploy`     | manual dispatch from `main`               | Validate a successful CI release manifest, then deploy or roll back its exact ECR digests on ECS                          |
| `CodeQL`            | pull requests, `main`, weekly             | Opt-in GitHub Code Security analysis                                                                                      |
| `Dependency Review` | pull requests to `main`                   | Opt-in GitHub Code Security dependency diff review                                                                        |

There is deliberately no `workflow_run` release workflow. Quality gates, image
publication, manifest generation, and optional staging deployment all run from
the same checked-out commit in one `CI` run. This removes the gap in which a
second workflow could load newer workflow code while releasing an older SHA.

External Actions are pinned to full commit SHAs. Only ECR publication and ECS
deployment jobs receive `id-token: write`; repository contents remain read-only
and no workflow receives a package-registry write token. Dependabot proposes
updates to Actions, npm packages, and Docker base images.

## CI and release behavior

The stable branch check is `CI / Required`. It depends on Secret scan,
Infrastructure/workflow validation, Quality, Integration, Build, Web E2E, the
shared container build stage, and the event-appropriate container
publish/check matrix; a skipped or failed required gate cannot be hidden by the
aggregator.

- Secret scan runs digest-pinned Gitleaks directly in Docker, without a paid
  GitHub Code Security feature or a licensed GitHub Action. It scans both the
  complete checked-out Git history and current source tree. Allowlisting is
  limited to exact, public test/development fixture values.
- Infrastructure validation runs Actionlint, ShellCheck over every tracked
  shell script, `terraform fmt`, offline init/validate for all three Terraform
  roots, the mocked single-node Valkey/KMS/output regression, and a fail-closed
  Trivy High/Critical configuration scan.
- Quality runs `pnpm audit --prod --audit-level high`, formatting, linting,
  type-checking, unit tests, and the Web one-time-Credential component test.
- Integration uses disposable, digest-pinned PostgreSQL 17 + pgvector and Redis
  7.4 services. Before the normal migration and seed it proves three forward
  paths: empty schema, Owner schema, and the committed Agent-v1 `000004`
  snapshot containing a legacy static Credential, non-canonical handle/tag,
  and an ActionLog value accepted by the shipped audit rule. The last path
  proves those rows remain readable and editable where appropriate, then
  verifies `000005` rejects equivalent new writes and backfills
  `pepper_version=1`. Every path then reaches the current `000009` head, where
  CI verifies the canonical Community/Content/Revision, principal-scoped
  idempotency, encrypted PendingAction, catalog-only symbol candidate, stable
  Content read snapshots, independent Reaction facts and database guards,
  audit, and Outbox schema shape.
  The suite includes a real-auth API Credential lifecycle E2E and bounded,
  independent-pool concurrency consistency load.
- Build compiles the workspace.
- Web E2E builds the current production Next.js application and runs 17
  Chromium checks against a strict versioned public-API stub with Playwright
  1.61.1. The matching browser cache is version-keyed; Playwright still
  verifies browser and runner system dependencies every run.
- The container matrix waits for Quality, Integration, Build, Secret scan, and
  Web E2E, then builds `web`, `api`, `mcp`, `worker`, and `migrate`; a failed
  security or browser gate cannot publish a release image.
- Every built target is smoke-checked before scanning or manifest inclusion:
  Web is started and probed, API/MCP modules are loaded, Worker entry modules
  are parsed and loaded, and the migration entrypoint is syntax-checked.
- Every target is scanned with Trivy; fixable High or Critical OS/library
  vulnerabilities fail the job. Unfixed findings remain visible for review but
  do not create a permanently unresolvable gate.
- Pull requests never receive registry credentials and never publish.
- When `AWS_ECR_PUBLISH_ENABLED` is not exactly `true`, a `main` push follows
  the same credential-free local build/smoke/scan path and emits no deployable
  manifest. There is no GHCR fallback.
- When `AWS_ECR_PUBLISH_ENABLED=true`, a `main` push assumes the ECR-only OIDC
  role, publishes or safely reuses the immutable
  `sha-<40-character-commit>` tag for every target, and captures the
  registry-returned OCI digest.
- CI resolves the unique Linux/amd64 child digest from the authenticated OCI
  index and records it separately. ECS task definitions must use the top-level
  digest; running Fargate tasks must report the recorded runtime digest.
- Five per-image metadata artifacts are aggregated into
  `release-manifest-<sha>`. Validation rejects missing targets, unexpected image
  names, tag/SHA mismatches, or non-SHA-256 digests.
- The manifest and its checksum are retained for 90 days.

The release manifest is the deployment identity. Tags are included for
traceability, but deployment uses only `@sha256:...` references:

```json
{
  "schemaVersion": 1,
  "repository": "songzhiyuan98/AlphaNet",
  "sha": "0123456789abcdef0123456789abcdef01234567",
  "images": {
    "web": {
      "tag": "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-web:sha-0123456789abcdef0123456789abcdef01234567",
      "digest": "sha256:...",
      "runtimeDigest": "sha256:...",
      "reference": "123456789012.dkr.ecr.us-west-2.amazonaws.com/alphanet-web@sha256:..."
    }
  }
}
```

The actual manifest contains the same record for all five targets.

## AWS CD activation

AWS deployment is fail-closed and disabled until the infrastructure bootstrap
is complete. GitHub stores only non-secret coordinates as repository variables;
runtime database, Valkey, authentication, signing, encryption, OAuth, and email
values remain in AWS Secrets Manager.

The required global variables are:

| Variable                    | Purpose                                        |
| --------------------------- | ---------------------------------------------- |
| `AWS_ECR_PUBLISH_ENABLED`   | Enables ECR publication and manifest creation  |
| `AWS_DEPLOY_ENABLED`        | Separately enables ECS deployment              |
| `AWS_REGION`                | Initially `us-west-2`                          |
| `AWS_ECR_REGISTRY`          | Exact 12-digit-account private ECR registry    |
| `AWS_ECR_REPOSITORY_PREFIX` | Shared repository prefix, initially `alphanet` |
| `AWS_CI_PUBLISH_ROLE_ARN`   | Branch-bound, ECR-publish-only OIDC role       |

Each target environment also supplies its own deploy role, ECS cluster,
service names, task-definition families, private subnet IDs, migration security
group, public base URL, and smoke paths. Terraform emits the complete
`deployment_github_variables` map; do not transcribe resource identifiers from
memory.

Activation order is intentional:

1. read GitHub's live `sub_claim_prefix`, append
   `:ref:refs/heads/main`, and use that exact immutable claim in the shared,
   staging, and Production Terraform inputs;
2. create the remote-state and shared ECR/OIDC stacks;
3. set `AWS_ECR_PUBLISH_ENABLED=true` while keeping
   `AWS_DEPLOY_ENABLED=false`, then publish the first complete five-image
   release;
4. create the environment with service desired counts at zero;
5. populate Secrets Manager without placing values in Terraform state;
6. run database bootstrap, the release migration gate, and runtime SQL smoke;
7. launch the exact first-release digests and verify readiness;
8. set `AWS_DEPLOY_ENABLED=true` and `ENABLE_STAGING_DEPLOY=true`;
9. enable `AUTO_DEPLOY_PRODUCTION=true` only after repeated staging success.

Once enabled, missing or malformed coordinates fail readiness. GitHub OIDC
credentials are short-lived; no AWS access key is stored in GitHub. The
Terraform inputs reject an empty or wildcard subject instead of falling back to
the legacy name-only format.

## Manual promotion and rollback validation

`Manual Deploy` must be dispatched with workflow ref `main`. Its resolve job:

1. Requires a lowercase full commit SHA reachable from `main`.
2. Locates a completed, `push`-originated `CI` run for that exact SHA and
   independently proves that `Required`, `Release manifest`, and all five
   `Publish (...)` jobs succeeded. A later transient deploy failure does not
   invalidate the immutable build.
3. Downloads that run's unexpired `release-manifest-<sha>` artifact through the
   GitHub API.
4. Verifies the artifact checksum and all five digest references.
5. Re-uploads the validated manifest into the manual run.

Deployment jobs consume only that validated artifact. They do not reconstruct
image names from user input or deploy mutable tags. The three modes have
different proof requirements:

- `staging` deploys only to staging and writes a checksummed staging marker.
- `promote` requires `confirm_production=true`, deploys the exact release to
  staging in the same `Manual Deploy` workflow, and can enter Production only
  when that staging job and its smoke checks succeed. Its staging marker is an
  audit artifact, not reusable promotion authorization.
- `break-glass-rollback` requires production confirmation, explicit schema
  compatibility confirmation, an audit reason of at least 20 characters, and
  a trusted successful Production marker for that exact prior release. It is
  application-only: it preserves the current forward-only schema and ACL gate,
  never runs the historical release's migration or runtime-smoke image, and
  proves compatibility through service readiness, public social-read smoke,
  and running-digest checks.

Markers bind repository, environment, SHA, source CI run, deployment run,
manifest hash, mode, and time. Only break-glass rollback reuses a historical
marker; its checksum and successful named Production job are independently
verified.

## Current GitHub Free limitations

AlphaNet is currently a private, user-owned repository on GitHub Free. On that
combination:

- Private-repository branch rulesets and protected-branch enforcement require a
  paid plan. Keep `CI / Required` as the intended gate and enable enforcement
  after upgrading or making the repository public.
- GitHub Free currently includes 2,000 hosted-runner minutes per month and
  500 MB of Actions artifact storage for a private user-owned repository. This
  pipeline deliberately spends minutes on PostgreSQL integration, Playwright,
  five container builds, smoke tests, and scans. Enable GitHub usage alerts and
  a budget, monitor billed minutes and artifact storage, and add a valid payment
  method or upgrade before the allowance becomes a release blocker. Do not
  remove required security or database gates merely to save minutes. See
  [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
- CodeQL uploads and Dependency Review for private repositories require GitHub
  Code Security on an eligible plan. Both workflows therefore run only when the
  repository variable `ENABLE_GITHUB_CODE_SECURITY` is exactly `true`; do not
  require their skipped checks.
- Environments, environment secrets, deployment branch restrictions, and
  required deployment reviewers are unavailable to this private repository on
  the current plan. Deployment jobs therefore avoid the `environment:` feature
  and use separate branch-bound AWS roles plus repository coordinates; the
  production confirmation is an intent check, not two-person approval.
- There is one maintainer. Requiring an approving review or preventing
  self-review would deadlock all changes. Add enforced approval only after a
  second accountable maintainer exists and the plan supports it.

Relevant GitHub documentation:

- [Ruleset availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [Code scanning availability](https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning-with-codeql)
- [Dependency Review availability](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/about-dependency-review)
- [Deployment environments](https://docs.github.com/en/actions/deployment/targeting-different-environments/managing-environments-for-deployment)

Until enforcement is available, use pull requests, wait for `CI / Required`, and
merge only the exact reviewed SHA. Block force pushes and deletion through
repository settings if the plan exposes those controls. When a second maintainer
and an eligible plan are available, require one non-author approval, resolve
conversations, dismiss stale approvals, and protect `CI / Required`.

## ECR access and retention

CI publishes to shared ECR through the short-lived OIDC publish role. ECS pulls
through an execution role scoped to the five repositories. Neither path uses a
long-lived registry password.

ECR tags are immutable. A repeated CI run for the same commit must reuse and
verify an existing `sha-*` image instead of attempting to mutate it. Do not
delete a release merely because its tag looks old. Retain:

- every digest referenced by staging or production;
- the known-good rollback release;
- releases attached to an open incident;
- at least the ten most recent deployable SHAs.

During the first-quarter operating period the shared Terraform stack keeps all
SHA-tagged releases and removes only untagged upload artifacts after 14 days.
Before adding tagged-image expiry, compare ECR references with both environments,
known-good rollback releases, and incident holds. Keep release-manifest and
deployment-marker artifacts for the documented rollback window and alert on
ECR storage growth. GHCR is not a publication or production dependency.

## Security administration

- Default `GITHUB_TOKEN` permissions: read-only.
- Fork workflows: require approval from untrusted contributors.
- Secret scanning, push protection, dependency graph, Dependabot alerts, and
  security updates: enable where the plan permits.
- Deployment roles: environment-specific, branch-bound, and revocable; never
  reuse the ECR publish role or application credentials.
- Rotate any token that appears in logs, workflow inputs, artifacts, commits, or
  pull-request content. Rewriting Git history is not credential revocation.
- Restrict manual workflow dispatch to trusted collaborators.

Preview environments remain deferred until per-PR database, Valkey, callback,
secret, cost, and cleanup isolation are designed.

The CI concurrency suite checks database-backed safety invariants; it is not a
production performance claim. Multi-process HTTP soak tests, latency SLO
measurement, and infrastructure fault injection run only in the isolated AWS
load environment after the first staging deployment.
