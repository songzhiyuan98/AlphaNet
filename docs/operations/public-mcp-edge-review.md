# Public MCP and OAuth edge release review

This gate proves the exact release candidate through its real public AWS
endpoints. Local SDK, mocked OAuth, private load-balancer and direct ECS tests
remain repository evidence; none can substitute for this public-edge review.

Run the drill in an isolated candidate environment with synthetic Owners,
Agents and content. Do not perform certificate, key or token-family failure
injection against Production.

## Preconditions

- The candidate deploys the exact full release SHA and immutable image digests.
- Public MCP is enabled only for the isolated candidate and is protected by the
  intended CloudFront/WAF, OAuth and service boundaries.
- The OAuth issuer, JWKS and MCP resource URLs are public HTTPS URLs with no
  credentials, query strings or fragments.
- A reviewed public PKCE client has been provisioned through the operator
  workflow. Dynamic registration remains disabled.
- Candidate API and MCP tasks use the intended internal mTLS certificates and
  trust bundle. MCP has no business database credentials.
- Logs, traces and evidence sinks are ready to prove that authorization codes,
  verifiers, tokens, assertions, cookies and UGC are redacted.

## Positive chain

1. Discover the authorization server and protected-resource metadata from the
   public MCP endpoint.
2. Complete Authorization Code with PKCE S256, exact MCP resource binding,
   Owner login, consent and Agent selection.
3. Verify the ES256 access token against the public JWKS and call one real read
   and one idempotent write through public MCP → internal mTLS API → durable
   state.
4. Rotate the refresh token once and prove the replacement access token works.
5. Revoke the Grant and prove the next MCP call is rejected without waiting for
   token expiry.
6. Confirm public and internal request IDs correlate while sensitive values and
   research bodies do not appear in logs.

## Required negative checks

Each request must be rejected at the documented boundary:

- an access token or authorization request for the wrong resource;
- PKCE `plain` or a missing/incorrect verifier;
- an unregistered or mismatched redirect URI;
- an internal API request presenting an untrusted client certificate;
- a request after Grant revocation; and
- reuse of a rotated refresh token.

The negative tests must not create a public ContentItem, activate a Grant,
leave a valid token family or reveal a credential in the response.

## Rotation and failure drills

Run and timestamp four independent drills:

### mTLS rotation

Introduce the next trusted CA/client certificate in the candidate trust set,
roll the MCP/API tasks without downtime, verify both transition certificates
during the overlap, remove the retired trust and prove it is rejected.

### JWKS rotation

Publish the next signing key, issue and verify a token with it, preserve the
prior public key for the bounded overlap, then retire it only after all tokens
it signed have expired or been revoked.

### Grant revocation

Revoke one active candidate Grant and its Credential/JTI authority. The next
tool request must fail closed; other candidate Grants remain usable.

### Refresh reuse

Rotate one refresh token, then replay the old token. The provider and AlphaNet
authority must invalidate the affected family according to the documented
policy, and the next tool request must fail closed.

Any manual database edit, token copying into logs, broad trust bypass or
security-control disablement fails the gate.

## Evidence

Write `artifacts/release/public-mcp-edge.json` with mode `0600`:

```json
{
  "schema_version": "1",
  "gate": "public_mcp_edge",
  "release_sha": "0123456789abcdef0123456789abcdef01234567",
  "result": "pass",
  "observed_at": "2026-07-24T00:00:00.000Z",
  "mcp_url": "https://mcp.example.com/mcp",
  "issuer_url": "https://auth.example.com",
  "jwks_url": "https://auth.example.com/.well-known/jwks.json",
  "checks": {
    "public_mtls": true,
    "jwks": true,
    "authorization_code": true,
    "refresh": true,
    "revocation": true,
    "failure_drills": true
  },
  "negative_checks": {
    "wrong_resource_rejected": true,
    "pkce_plain_rejected": true,
    "invalid_redirect_rejected": true,
    "untrusted_client_certificate_rejected": true,
    "revoked_grant_rejected": true,
    "refresh_reuse_rejected": true
  },
  "drills": {
    "mtls_rotation": {
      "result": "pass",
      "observed_at": "2026-07-24T00:00:00.000Z"
    },
    "jwks_rotation": {
      "result": "pass",
      "observed_at": "2026-07-24T00:00:00.000Z"
    },
    "grant_revocation": {
      "result": "pass",
      "observed_at": "2026-07-24T00:00:00.000Z"
    },
    "refresh_reuse": {
      "result": "pass",
      "observed_at": "2026-07-24T00:00:00.000Z"
    }
  },
  "contains_credentials_or_content": false
}
```

Retain detailed redacted drill logs outside the repository. The aggregate file
contains no AWS account or resource identifier, certificate, private key,
authorization code, verifier, token, cookie, Owner/Agent ID, request body or
research content.

Validate the complete exact-SHA candidate record:

```bash
chmod 0600 artifacts/release/public-mcp-edge.json
RELEASE_SHA="$(git rev-parse HEAD)" pnpm mvp:release:report
```

Production public MCP remains disabled until this gate, the three-Host
interoperability gate and every other release gate pass.
