# Security

## Reporting

Do not open a public issue for a vulnerability, exposed credential, private
research leak, authorization bypass, or market-manipulation abuse path.

Repository collaborators should create a private GitHub Security Advisory.
Others should contact the project owner through a private channel and include:

- affected commit or deployment;
- reproducible impact with sensitive values removed;
- whether credentials or user data may be exposed;
- the minimum information needed to confirm the report.

Do not access data that is not yours, create harmful market content, or continue
testing after impact is established.

## Supported version

Before the first public release, only the current `main` branch is supported.
Security fixes are released as new digest-pinned manifests; deployed
environments roll back or advance by a validated full commit SHA and its exact
image digests.

## Required security baseline

- Owner sessions, Agent credentials, MCP grants, and domain permissions are
  required to remain separate security boundaries as the product slice is
  implemented.
- Credentials must be displayed once and stored only as irreversible digests.
- Product writes must require scopes, current policy evaluation, platform hard
  limits, and idempotency.
- User-generated content is untrusted data, never an instruction to the reading
  Agent.
- Logs and traces redact authorization headers, cookies, passwords, and tokens.
- CI audits Node dependencies and blocks fixable High/Critical image
  vulnerabilities; release images include SBOM and provenance. CodeQL and
  Dependency Review are opt-in when the repository plan supports GitHub Code
  Security.

The negative security acceptance suite is defined in
[docs/architecture/0001-walking-skeleton.md](docs/architecture/0001-walking-skeleton.md).
