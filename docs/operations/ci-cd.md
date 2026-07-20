# CI/CD and repository protection

## Workflow inventory

| Workflow            | Trigger                                   | Purpose                                                                                            |
| ------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `CI`                | pull requests to `main`, pushes to `main` | Audit, format, lint, type-check, test, build, build five images, publish digest manifest on `main` |
| `Manual Deploy`     | manual dispatch from `main`               | Validate a successful CI release manifest, then promote or roll back its exact digests             |
| `CodeQL`            | pull requests, `main`, weekly             | Opt-in GitHub Code Security analysis                                                               |
| `Dependency Review` | pull requests to `main`                   | Opt-in GitHub Code Security dependency diff review                                                 |

There is deliberately no `workflow_run` release workflow. Quality gates, image
publication, manifest generation, and optional staging deployment all run from
the same checked-out commit in one `CI` run. This removes the gap in which a
second workflow could load newer workflow code while releasing an older SHA.

External Actions are pinned to full commit SHAs. Only the container matrix gets
`packages: write`; deployment and all other jobs are read-only. Dependabot
proposes updates to Actions, npm packages, and Docker base images.

## CI and release behavior

The stable branch check is `CI / Required`.

- Quality runs `pnpm audit --prod --audit-level high`, formatting, linting,
  type-checking, and unit tests. The pnpm audit is the security gate available
  on the current GitHub plan.
- Integration uses disposable, digest-pinned PostgreSQL 17 + pgvector and Redis
  7.4 services. It applies the real migrations and seed.
- Build compiles the workspace.
- The container matrix waits for all three gates, then builds `web`, `api`,
  `mcp`, `worker`, and `migrate`.
- Every target is scanned with Trivy; fixable High or Critical OS/library
  vulnerabilities fail the job. Unfixed findings remain visible for review but
  do not create a permanently unresolvable gate.
- Pull requests never authenticate to GHCR and never publish.
- A `main` push publishes a `sha-<40-character-commit>` tag for each image and
  captures the registry-returned digest.
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
      "tag": "ghcr.io/songzhiyuan98/alphanet-web:sha-0123456789abcdef0123456789abcdef01234567",
      "digest": "sha256:...",
      "reference": "ghcr.io/songzhiyuan98/alphanet-web@sha256:..."
    }
  }
}
```

The actual manifest contains the same record for all five targets.

## CD scaffold

No hosting provider is selected. Leave `ENABLE_STAGING_DEPLOY` unset or set to
`false`; the staging job is then visibly skipped. After a real hook is ready:

1. Configure the four repository secrets listed below.
2. Set `ENABLE_STAGING_DEPLOY=true`.
3. Push a harmless change through CI and verify the hook contract end to end.

An enabled deployment with an empty secret, a non-HTTPS URL, failed HTTP
request, asynchronous response, or non-terminal response fails. The current hook
must complete rollout and verification synchronously and return terminal
`succeeded` within 15 minutes. When a provider is selected, replace the generic
hook with provider-native OIDC and an API integration that starts a deployment,
polls it to a terminal state, verifies digest placement, and performs smoke
tests.

Use distinct repository secrets while this is a private repository on GitHub
Free:

| Secret                         | Purpose                      |
| ------------------------------ | ---------------------------- |
| `STAGING_DEPLOY_HOOK_URL`      | Staging HTTPS endpoint       |
| `STAGING_DEPLOY_HOOK_TOKEN`    | Staging-only bearer token    |
| `PRODUCTION_DEPLOY_HOOK_URL`   | Production HTTPS endpoint    |
| `PRODUCTION_DEPLOY_HOOK_TOKEN` | Production-only bearer token |

Runtime database, Redis, OAuth, and MCP signing secrets belong in the hosting
platform's secret manager, not GitHub Actions.

## Manual promotion and rollback validation

`Manual Deploy` must be dispatched with workflow ref `main`. Its resolve job:

1. Requires a lowercase full commit SHA reachable from `main`.
2. Locates a successful `push`-originated `CI` run for that exact SHA.
3. Downloads that run's unexpired `release-manifest-<sha>` artifact through the
   GitHub API.
4. Verifies the artifact checksum and all five digest references.
5. Re-uploads the validated manifest into the manual run.

Deployment jobs consume only that validated artifact. They do not reconstruct
image names from user input or deploy mutable tags. Production additionally
requires the `confirm_production` input.

## Current GitHub Free limitations

AlphaNet is currently a private, user-owned repository on GitHub Free. On that
combination:

- Private-repository branch rulesets and protected-branch enforcement require a
  paid plan. Keep `CI / Required` as the intended gate and enable enforcement
  after upgrading or making the repository public.
- CodeQL uploads and Dependency Review for private repositories require GitHub
  Code Security on an eligible plan. Both workflows therefore run only when the
  repository variable `ENABLE_GITHUB_CODE_SECURITY` is exactly `true`; do not
  require their skipped checks.
- Environments, environment secrets, deployment branch restrictions, and
  required deployment reviewers are unavailable to this private repository on
  the current plan. Deployment jobs therefore avoid the `environment:` feature
  and use separate repository secrets; the production confirmation is an intent
  check, not two-person approval.
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

## GHCR access and retention

CI publishes with the short-lived `GITHUB_TOKEN`. A hosting platform pulling
private GHCR images needs its own least-privilege registry credential: currently
a revocable classic PAT with `read:packages` (and repository access when GitHub
requires it). Store it only in the provider secret manager and rotate it.

Do not delete a package version merely because its `sha-*` tag looks old.
Retain:

- every digest referenced by staging or production;
- the known-good rollback release;
- releases attached to an open incident;
- at least the ten most recent deployable SHAs.

After those holds, delete older unreferenced versions with a scheduled,
reviewable cleanup job once usage justifies it. Keep release-manifest artifacts
long enough to match the supported rollback window, monitor package storage and
bandwidth, and set billing alerts where GitHub exposes them. GitHub currently
notes special Container registry billing treatment, but that policy can change;
see [GitHub Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages).

## Security administration

- Default `GITHUB_TOKEN` permissions: read-only.
- Fork workflows: require approval from untrusted contributors.
- Secret scanning, push protection, dependency graph, Dependabot alerts, and
  security updates: enable where the plan permits.
- Deployment tokens: environment-specific and revocable; never reuse
  application credentials.
- Rotate any token that appears in logs, workflow inputs, artifacts, commits, or
  pull-request content. Rewriting Git history is not credential revocation.
- Restrict manual workflow dispatch to trusted collaborators.

Preview environments remain deferred until provider choice and per-PR database,
Redis, callback, secret, and cleanup isolation are designed.
