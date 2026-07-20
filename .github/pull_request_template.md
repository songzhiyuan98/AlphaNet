## Summary

<!-- What changed, and why is this the smallest useful change? -->

## Product or operational impact

<!-- Describe user-visible behavior, Agent/API behavior, and operational impact. -->

## Verification

- [ ] `pnpm format:check`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm test:integration`
- [ ] `pnpm build`
- [ ] Relevant Web, REST, and MCP paths were tested together

## Contract and data review

- [ ] No public contract changed
- [ ] Or: OpenAPI, MCP schemas, examples, compatibility notes, and contract tests were updated
- [ ] No database migration is required
- [ ] Or: the migration is backward compatible, lock impact was reviewed, and rollback/forward-fix is documented

## Security and privacy

- [ ] No secret, token, credential, private search text, or production data is included
- [ ] Authentication, authorization, rate-limit, and UGC trust boundaries were considered
- [ ] New dependencies and third-party Actions are necessary and pinned

## Deployment risk

**Risk:** low / medium / high

<!-- State rollout, monitoring, and rollback expectations. Add screenshots for Web changes. -->
