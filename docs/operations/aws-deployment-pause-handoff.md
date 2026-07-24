# AWS deployment pause handoff

> Paused: 2026-07-23
>
> Branch: `feat/aws-lean-runtime`
>
> Authorization state: design and local implementation may be resumed later;
> **no Terraform apply, paid resource creation, or CD enablement is currently
> authorized**.

## Why this checkpoint exists

AlphaNet's functional MVP engineering baseline is substantially implemented,
but the Owner has chosen to defer AWS spending. This document preserves the
exact deployment direction without presenting the draft as a runnable or
validated production environment.

The selected first-environment design is documented in
[ADR-0024](../architecture/0024-lean-aws-runtime-v1.md):

- CloudFront-generated HTTPS endpoint;
- one replaceable `t3a.medium` EC2 application node;
- separate encrypted single-AZ RDS PostgreSQL 17 `db.t4g.micro`;
- authenticated local Redis as replaceable coordination state;
- the same digest-pinned Web, API, MCP, Worker and migration images used by the
  scale-out ECS architecture;
- Systems Manager deployments without SSH;
- an account budget target of USD 40.

The planning range is USD 40–60 per month while running under light traffic.
That is a planning estimate, not an AWS billing guarantee.

## Confirmed account state at pause

No AlphaNet paid AWS runtime was created or applied during this work.
The last authenticated AWS Console inventory showed:

- no EC2 instances or EBS volumes;
- no RDS databases;
- no ECS services, ECR repositories, load balancers, NAT gateways or
  ElastiCache clusters;
- no CloudFront distribution, WAF ACL, Route 53 hosted zone or ACM
  certificate;
- no AlphaNet S3 state bucket, CloudFormation stack, runtime secret, alarm or
  deployment role;
- only the account's default VPC and the configured account security/billing
  settings.

Default VPCs, root-account MFA configuration, GitHub OIDC provider
configuration and AWS Budget definitions do not themselves create the planned
runtime compute bill. GitHub Actions billing is separate from AWS.

The local environment at this checkpoint does not contain the AWS CLI, so a
future session must re-check the current AWS Console or install/use an
authenticated CLI before making a new cost claim. Never infer that the account
is still empty solely from this document.

## Repository state preserved

The branch contains a deliberately incomplete lean-runtime draft:

- `infra/aws/lean/runtime/compose.yaml`
- `infra/aws/lean/runtime/deploy-release.sh`
- `infra/aws/lean/runtime/nginx.conf.template`
- `infra/aws/lean/runtime/alphanet-proxy-headers.conf`
- `infra/aws/lean/runtime/runtime.env.example`
- `infra/aws/lean/versions.tf`
- `infra/aws/lean/variables.tf`
- `infra/aws/lean/locals.tf`
- `infra/aws/lean/network.tf`
- the lean Redis URL-scheme extension in
  `infra/aws/scripts/seed-application-secret.sh`

These files are a checkpoint, not an apply-ready stack. In particular:

1. `network.tf` still needs its cross-security-group rules converted to
   standalone rule resources to avoid a Terraform dependency cycle.
2. KMS, Secrets Manager, RDS, EC2, IAM, CloudFront, Systems Manager documents,
   logs, alarms, outputs and example variables are not implemented.
3. The deploy script must install/copy its runtime source bundle explicitly,
   and its first-bootstrap and rollback paths need dedicated tests.
4. Pause/resume automation, including RDS's seven-day automatic restart
   behavior, is not implemented.
5. Terraform lock files, format/validate/test evidence, policy-scanner
   exceptions and CI root discovery are not complete.
6. The existing ECS/Aurora release workflow has not been adapted to deploy this
   lean target.

Do not merge this branch into `main`, enable AWS deployment variables, or run
`terraform apply` until those items are complete and the Owner has approved a
fresh plan and current monthly estimate.

## Safe restart order

When the Owner resumes AWS deployment:

1. Rebase the checkpoint branch onto current `main`; preserve unrelated and
   duplicate-suffixed local files without staging them.
2. Re-inventory AWS and Billing in `us-west-2`; verify that no unexpected
   chargeable resources exist.
3. Review current AWS prices and regenerate the running and paused monthly
   estimates.
4. Complete the lean Terraform and deployment implementation locally.
5. Run Terraform format, init, validate, tests, security scans and a no-change
   repository secret scan.
6. Produce and review a Terraform plan. The plan must show every persistent
   paid resource, backup-retention setting and deletion-protection boundary.
7. Obtain explicit Owner confirmation for that plan and estimated recurring
   spend.
8. Apply the state/shared/runtime layers in the documented order, seed secrets
   through the approved scripts, publish the exact release images and deploy
   through Systems Manager.
9. Keep public MCP disabled until a stable owned domain, callback
   registrations, certificates and named-host interoperability evidence exist.
10. Execute the release-candidate gates below before describing the environment
    as an MVP release.

## What remains before online testing

The product is not waiting on another large social-feature build. Its
repository baseline already covers registration, Owner and Agent identity,
public community reads, research publishing and discussion, reactions,
follows, feeds, search, notifications, moderation, REST and the private
16-tool Remote MCP surface.

For a controlled online test, the remaining critical path is:

1. finish and deploy a release-candidate environment;
2. configure a real email sender/provider so open email/password registration
   can verify addresses;
3. seed realistic community data and run the cross-surface golden path;
4. verify search degradation and notification latency;
5. run the intended browser/mobile and operational smoke checks.

For a public MVP claim, the machine-readable release gate still requires six
release-candidate evidence groups and six external evidence groups. These
include capacity, recovery, browser compatibility, manual accessibility,
public MCP edge and named-host interoperability, operations readiness, legal
publication and real-user product-value evidence. See
[the P0 traceability matrix](../product/20-mvp-p0-traceability.md) and
`docs/product/mvp-release-gates.json`.

Legal-company formation is not a prerequisite for resuming engineering, but
public-facing terms, privacy, community and data-request materials still need
an accountable publisher and external review before the public release gate is
closed.
