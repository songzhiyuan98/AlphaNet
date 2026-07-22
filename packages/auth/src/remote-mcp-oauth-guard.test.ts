import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createRemoteMcpAuthorizationBindingDigest,
  createRemoteMcpAuthorizationRequestEnvelope,
  executeRemoteMcpTokenEndpointBoundary,
  RemoteMcpOAuthGuardError,
  validateRemoteMcpAuthorizeQuery,
  validateRemoteMcpExactRefreshScopes,
  validateRemoteMcpTokenForm,
  validateRemoteMcpTokenRequest,
  type RemoteMcpOAuthGuardErrorCode,
  type RemoteMcpRefreshLockedAuthority,
} from "./remote-mcp-oauth-guard.js";

const RESOURCE = "https://mcp.alphanet.example/mcp";
const REDIRECT_URI = "https://client.example/oauth/callback?surface=mcp";
const CLIENT_ID = "alphanet-mcp-client-v1";
const CODE_VERIFIER =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const CODE_CHALLENGE = createHash("sha256")
  .update(CODE_VERIFIER, "ascii")
  .digest("base64url");
const BINDING_KEY = Buffer.alloc(32, 0x57);
const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const GRANT_ID = "20000000-0000-4000-8000-000000000002";
const CREDENTIAL_ID = "30000000-0000-4000-8000-000000000003";

function validLockedAuthority(): RemoteMcpRefreshLockedAuthority {
  return {
    clientEnabled: true,
    clientId: CLIENT_ID,
    credentialResource: RESOURCE,
    credentialScopes: ["research:read", "community:read"],
    credentialExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
    credentialId: CREDENTIAL_ID,
    credentialRevokedAt: null,
    grantExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
    grantId: GRANT_ID,
    grantResource: RESOURCE,
    grantScopes: ["research:read", "community:read", "offline_access"],
    grantStatus: "active",
    originalRefreshTokenScopes: ["community:read", "offline_access", "research:read"],
    ownerId: OWNER_ID,
    refreshTokenExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
    refreshTokenIssuedAt: new Date("2026-07-20T00:00:00.000Z"),
    refreshTokenRevokedAt: null,
  };
}

function validAuthorizeQuery(scope = "community:read research:read offline_access") {
  return new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
    response_type: "code",
    scope,
    state: "state_7H0u3shUiyl91JJJ",
  });
}

function expectGuardError(
  action: () => unknown,
  code: RemoteMcpOAuthGuardErrorCode,
  parameter?: string,
  statusCode: 400 | 401 | 500 = 400,
): RemoteMcpOAuthGuardError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteMcpOAuthGuardError);
    expect(error).toMatchObject({
      code,
      ...(parameter === undefined ? {} : { parameter }),
      statusCode,
    });
    return error as RemoteMcpOAuthGuardError;
  }
  throw new Error("Expected the OAuth guard to reject the request");
}

describe("validateRemoteMcpAuthorizeQuery", () => {
  it("accepts the fixed-resource authorization-code profile and canonicalizes scope order", () => {
    const result = validateRemoteMcpAuthorizeQuery(validAuthorizeQuery(), {
      resource: RESOURCE,
    });

    expect(result).toEqual({
      clientId: CLIENT_ID,
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: "S256",
      canonicalScope: "research:read community:read offline_access",
      redirectUri: REDIRECT_URI,
      requestedScopes: ["research:read", "community:read", "offline_access"],
      resource: RESOURCE,
      responseType: "code",
    });
    expect(Object.isFrozen(result.requestedScopes)).toBe(true);
  });

  it.each([
    ["missing", "PARAMETER_MISSING" as const],
    ["duplicate", "PARAMETER_DUPLICATE" as const],
    ["wrong", "RESOURCE_MISMATCH" as const],
  ])("rejects a %s resource", (scenario, expectedCode) => {
    const query = validAuthorizeQuery();
    if (scenario === "missing") {
      query.delete("resource");
    } else if (scenario === "duplicate") {
      query.append("resource", RESOURCE);
    } else {
      query.set("resource", "https://attacker.example/mcp");
    }

    const error = expectGuardError(
      () => validateRemoteMcpAuthorizeQuery(query, { resource: RESOURCE }),
      expectedCode,
      "resource",
    );
    expect(error.message).not.toContain("attacker.example");
  });

  it("requires response_type=code and S256 PKCE", () => {
    const responseQuery = validAuthorizeQuery();
    responseQuery.set("response_type", "token");
    expectGuardError(
      () => validateRemoteMcpAuthorizeQuery(responseQuery, { resource: RESOURCE }),
      "RESPONSE_TYPE_UNSUPPORTED",
      "response_type",
    );

    const methodQuery = validAuthorizeQuery();
    methodQuery.set("code_challenge_method", "plain");
    expectGuardError(
      () => validateRemoteMcpAuthorizeQuery(methodQuery, { resource: RESOURCE }),
      "PKCE_METHOD_UNSUPPORTED",
      "code_challenge_method",
    );

    const degenerateChallenge = validAuthorizeQuery();
    degenerateChallenge.set("code_challenge", "A".repeat(43));
    expectGuardError(
      () =>
        validateRemoteMcpAuthorizeQuery(degenerateChallenge, {
          resource: RESOURCE,
        }),
      "PKCE_CHALLENGE_INVALID",
      "code_challenge",
    );
  });

  it("rejects duplicate and unknown query pollution before provider parsing", () => {
    const duplicated = validAuthorizeQuery();
    duplicated.append("scope", "research:read");
    expectGuardError(
      () => validateRemoteMcpAuthorizeQuery(duplicated, { resource: RESOURCE }),
      "PARAMETER_DUPLICATE",
      "scope",
    );

    const unknown = validAuthorizeQuery();
    unknown.set("request_uri", "urn:ietf:params:oauth:request_uri:example");
    expectGuardError(
      () => validateRemoteMcpAuthorizeQuery(unknown, { resource: RESOURCE }),
      "PARAMETER_UNSUPPORTED",
      "request_uri",
    );
  });

  it.each([
    ["research:read  community:read", "scope"],
    ["research:read research:read", "scope"],
    ["offline_access", "scope"],
    ["openid research:read", "scope"],
  ])("rejects a malformed or unsupported scope set: %s", (scope, parameter) => {
    expectGuardError(
      () =>
        validateRemoteMcpAuthorizeQuery(validAuthorizeQuery(scope), {
          resource: RESOURCE,
        }),
      "SCOPE_INVALID",
      parameter,
    );
  });

  it("fails closed on unsafe public identifiers and redirect URIs", () => {
    const client = validAuthorizeQuery();
    client.set("client_id", "client id");
    expectGuardError(
      () => validateRemoteMcpAuthorizeQuery(client, { resource: RESOURCE }),
      "CLIENT_ID_INVALID",
      "client_id",
    );

    const redirect = validAuthorizeQuery();
    redirect.set("redirect_uri", "https://client.example/callback#fragment");
    expectGuardError(
      () => validateRemoteMcpAuthorizeQuery(redirect, { resource: RESOURCE }),
      "REDIRECT_URI_INVALID",
      "redirect_uri",
    );

    expectGuardError(
      () =>
        validateRemoteMcpAuthorizeQuery(validAuthorizeQuery(), {
          resource: "https://mcp.alphanet.example/other",
        }),
      "RESOURCE_INVALID",
      "resource",
    );
    expectGuardError(
      () =>
        validateRemoteMcpAuthorizeQuery(validAuthorizeQuery(), {
          resource: "https://MCP.alphanet.example/mcp",
        }),
      "RESOURCE_INVALID",
      "resource",
    );
  });
});

describe("validateRemoteMcpTokenForm", () => {
  it("accepts authorization_code and refresh_token forms without returning secrets", () => {
    const codeForm = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: "secret-not-returned",
      code: "aln_code_v1_w7mZaPQyD4",
      code_verifier: CODE_VERIFIER,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    });
    const codeResult = validateRemoteMcpTokenForm(codeForm, {
      resource: RESOURCE,
    });
    expect(codeResult).toEqual({
      clientId: CLIENT_ID,
      grantType: "authorization_code",
      redirectUri: REDIRECT_URI,
      resource: RESOURCE,
    });
    expect(JSON.stringify(codeResult)).not.toContain("secret-not-returned");
    expect(JSON.stringify(codeResult)).not.toContain(CODE_VERIFIER);

    const refreshResult = validateRemoteMcpTokenForm(
      new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: "aln_rt_v1_w7mZaPQyD4",
        resource: RESOURCE,
        scope: "community:read research:read",
      }),
      { resource: RESOURCE },
    );
    expect(refreshResult).toEqual({
      canonicalScope: "research:read community:read",
      clientId: CLIENT_ID,
      grantType: "refresh_token",
      requestedScopes: ["research:read", "community:read"],
      resource: RESOURCE,
    });
    expect(JSON.stringify(refreshResult)).not.toContain("aln_rt_v1");
  });

  it.each([
    ["missing", "PARAMETER_MISSING" as const],
    ["duplicate", "PARAMETER_DUPLICATE" as const],
    ["wrong", "RESOURCE_MISMATCH" as const],
  ])("rejects a %s token resource", (scenario, expectedCode) => {
    const form = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "aln_rt_v1_w7mZaPQyD4",
      resource: RESOURCE,
    });
    if (scenario === "missing") {
      form.delete("resource");
    } else if (scenario === "duplicate") {
      form.append("resource", RESOURCE);
    } else {
      form.set("resource", "https://attacker.example/mcp");
    }

    expectGuardError(
      () => validateRemoteMcpTokenForm(form, { resource: RESOURCE }),
      expectedCode,
      "resource",
    );
  });

  it.each(["client_credentials", "password", "urn:custom:grant"])(
    "rejects the %s grant",
    (grantType) => {
      const form = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: "secret",
        grant_type: grantType,
        resource: RESOURCE,
      });
      const error = expectGuardError(
        () => validateRemoteMcpTokenForm(form, { resource: RESOURCE }),
        "GRANT_TYPE_UNSUPPORTED",
        "grant_type",
      );
      expect(error.oauthError).toBe("unsupported_grant_type");
    },
  );

  it("rejects grant-field pollution and weak PKCE verifiers", () => {
    const mixed = new URLSearchParams({
      client_id: CLIENT_ID,
      code: "aln_code_v1_w7mZaPQyD4",
      code_verifier: CODE_VERIFIER,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      refresh_token: "aln_rt_v1_mixed-field",
      resource: RESOURCE,
    });
    expectGuardError(
      () => validateRemoteMcpTokenForm(mixed, { resource: RESOURCE }),
      "PARAMETER_UNSUPPORTED",
      "refresh_token",
    );

    const weakVerifier = new URLSearchParams({
      client_id: CLIENT_ID,
      code: "aln_code_v1_w7mZaPQyD4",
      code_verifier: "A".repeat(43),
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    });
    expectGuardError(
      () => validateRemoteMcpTokenForm(weakVerifier, { resource: RESOURCE }),
      "PKCE_VERIFIER_INVALID",
      "code_verifier",
    );
  });
});

describe("Remote MCP token request boundary", () => {
  it("accepts exactly one client auth method without returning credentials", () => {
    const encoded = Buffer.from(`${CLIENT_ID}:client-secret`, "utf8").toString("base64");
    const parameters = new URLSearchParams({
      code: "aln_code_v1_w7mZaPQyD4",
      code_verifier: CODE_VERIFIER,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    });
    const result = validateRemoteMcpTokenRequest(
      {
        authorizationHeaders: [`Basic ${encoded}`],
        parameters,
      },
      { resource: RESOURCE },
    );
    expect(result).toMatchObject({
      clientAuthenticationMethod: "client_secret_basic",
      clientId: CLIENT_ID,
      grantType: "authorization_code",
    });
    expect(JSON.stringify(result)).not.toContain("client-secret");
    expect(JSON.stringify(result)).not.toContain(CODE_VERIFIER);

    const publicClient = validateRemoteMcpTokenRequest(
      {
        authorizationHeaders: [],
        parameters: new URLSearchParams({
          client_id: CLIENT_ID,
          code: "aln_code_v1_w7mZaPQyD4",
          code_verifier: CODE_VERIFIER,
          grant_type: "authorization_code",
          redirect_uri: REDIRECT_URI,
          resource: RESOURCE,
        }),
      },
      { resource: RESOURCE },
    );
    expect(publicClient.clientAuthenticationMethod).toBe("none");
  });

  it("rejects repeated, merged, mixed, and malformed client authentication", () => {
    const encoded = Buffer.from(`${CLIENT_ID}:client-secret`, "utf8").toString("base64");
    const form = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: "client-secret",
      grant_type: "refresh_token",
      refresh_token: "aln_rt_v1_w7mZaPQyD4",
      resource: RESOURCE,
    });
    expectGuardError(
      () =>
        validateRemoteMcpTokenRequest(
          { authorizationHeaders: [`Basic ${encoded}`], parameters: form },
          { resource: RESOURCE },
        ),
      "CLIENT_AUTH_AMBIGUOUS",
      "authorization",
    );
    expectGuardError(
      () =>
        validateRemoteMcpTokenRequest(
          {
            authorizationHeaders: [`Basic ${encoded}`, `Basic ${encoded}`],
            parameters: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: "aln_rt_v1_w7mZaPQyD4",
              resource: RESOURCE,
            }),
          },
          { resource: RESOURCE },
        ),
      "CLIENT_AUTH_REPEATED",
      "authorization",
    );
    expectGuardError(
      () =>
        validateRemoteMcpTokenRequest(
          {
            authorizationHeaders: [`Basic ${encoded}, Basic ${encoded}`],
            parameters: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: "aln_rt_v1_w7mZaPQyD4",
              resource: RESOURCE,
            }),
          },
          { resource: RESOURCE },
        ),
      "CLIENT_AUTH_INVALID",
      "authorization",
      401,
    );
    const malformed = expectGuardError(
      () =>
        validateRemoteMcpTokenRequest(
          {
            authorizationHeaders: ["Bearer not-client-auth"],
            parameters: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: "aln_rt_v1_w7mZaPQyD4",
              resource: RESOURCE,
            }),
          },
          { resource: RESOURCE },
        ),
      "CLIENT_AUTH_INVALID",
      "authorization",
      401,
    );
    expect(malformed.statusCode).toBe(401);

    const malformedBasicId = Buffer.from("bad client:client-secret", "utf8").toString(
      "base64",
    );
    expectGuardError(
      () =>
        validateRemoteMcpTokenRequest(
          {
            authorizationHeaders: [`Basic ${malformedBasicId}`],
            parameters: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: "aln_rt_v1_w7mZaPQyD4",
              resource: RESOURCE,
            }),
          },
          { resource: RESOURCE },
        ),
      "CLIENT_AUTH_INVALID",
      "authorization",
      401,
    );

    const overPadded = `${Buffer.from("abc:de", "utf8").toString("base64")}==`;
    expectGuardError(
      () =>
        validateRemoteMcpTokenRequest(
          {
            authorizationHeaders: [`Basic ${overPadded}`],
            parameters: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: "aln_rt_v1_w7mZaPQyD4",
              resource: RESOURCE,
            }),
          },
          { resource: RESOURCE },
        ),
      "CLIENT_AUTH_INVALID",
      "authorization",
      401,
    );
  });

  it("requires refresh scope equality with both the Grant and original token", () => {
    const omitted = validateRemoteMcpTokenForm(
      new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: "aln_rt_v1_w7mZaPQyD4",
        resource: RESOURCE,
      }),
      { resource: RESOURCE },
    );
    expect(omitted.grantType).toBe("refresh_token");
    if (omitted.grantType !== "refresh_token") {
      throw new Error("expected refresh token form");
    }
    expect(
      validateRemoteMcpExactRefreshScopes(
        omitted,
        ["research:read", "community:read", "offline_access"],
        ["offline_access", "community:read", "research:read"],
      ),
    ).toEqual(["research:read", "community:read", "offline_access"]);

    const narrowed = validateRemoteMcpTokenForm(
      new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: "aln_rt_v1_w7mZaPQyD4",
        resource: RESOURCE,
        scope: "research:read offline_access",
      }),
      { resource: RESOURCE },
    );
    if (narrowed.grantType !== "refresh_token") {
      throw new Error("expected refresh token form");
    }
    expectGuardError(
      () =>
        validateRemoteMcpExactRefreshScopes(
          narrowed,
          ["research:read", "community:read", "offline_access"],
          ["research:read", "community:read", "offline_access"],
        ),
      "SCOPE_INVALID",
      "scope",
    );

    expectGuardError(
      () =>
        validateRemoteMcpExactRefreshScopes(
          omitted,
          ["research:read", "community:read", "offline_access"],
          ["research:read", "actions:read", "offline_access"],
        ),
      "SCOPE_INVALID",
      "scope",
    );

    expectGuardError(
      () =>
        validateRemoteMcpExactRefreshScopes(
          omitted,
          ["research:read", "community:read"],
          ["research:read", "community:read"],
        ),
      "SCOPE_INVALID",
      "scope",
    );
  });

  it("holds the Owner+Client lock through exact-scope validation and provider execution", async () => {
    const events: string[] = [];
    const result = await executeRemoteMcpTokenEndpointBoundary(
      {
        authorizationHeaders: [],
        parameters: new URLSearchParams({
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: "aln_rt_v1_sensitive",
          resource: RESOURCE,
          scope: "community:read research:read offline_access",
        }),
      },
      { now: new Date("2026-07-21T00:00:00.000Z"), resource: RESOURCE },
      async (input, executeWhileLocked) => {
        events.push(`lock:${input.clientId}`);
        expect(input.refreshToken).toBe("aln_rt_v1_sensitive");
        const value = await executeWhileLocked(validLockedAuthority());
        events.push("unlock");
        return value;
      },
      () => {
        events.push("provider");
        return Promise.resolve("issued");
      },
    );
    expect(result).toBe("issued");
    expect(events).toEqual([`lock:${CLIENT_ID}`, "provider", "unlock"]);
  });

  it.each(["client_secret_basic", "client_secret_post"] as const)(
    "rejects %s before either public-client exchange lock",
    async (method) => {
      const encoded = Buffer.from(`${CLIENT_ID}:client-secret`, "utf8").toString(
        "base64",
      );
      const lock = vi.fn();
      const provider = vi.fn();
      const parameters = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "aln_rt_v1_sensitive",
        resource: RESOURCE,
      });
      const authorizationHeaders: string[] = [];
      if (method === "client_secret_basic") {
        authorizationHeaders.push(`Basic ${encoded}`);
      } else {
        parameters.set("client_id", CLIENT_ID);
        parameters.set("client_secret", "client-secret");
      }

      await expect(
        executeRemoteMcpTokenEndpointBoundary(
          { authorizationHeaders, parameters },
          { resource: RESOURCE },
          lock,
          provider,
        ),
      ).rejects.toMatchObject({ code: "CLIENT_AUTH_INVALID", statusCode: 401 });
      expect(lock).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
    },
  );

  it("fails closed when a refresh hook bypasses the locked provider callback", async () => {
    await expect(
      executeRemoteMcpTokenEndpointBoundary(
        {
          authorizationHeaders: [],
          parameters: new URLSearchParams({
            client_id: CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: "aln_rt_v1_sensitive",
            resource: RESOURCE,
          }),
        },
        { resource: RESOURCE },
        (() => Promise.resolve("not-the-provider-result")) as never,
        () => Promise.resolve("issued"),
      ),
    ).rejects.toMatchObject({ code: "REFRESH_LOCK_BYPASSED", statusCode: 500 });
  });

  it.each([
    [
      "revoked-token reuse",
      {
        refreshTokenRevokedAt: new Date("2026-07-20T12:00:00.000Z"),
      },
    ],
    [
      "absolute lifetime over 30 days",
      {
        credentialExpiresAt: new Date("2026-09-01T00:00:00.000Z"),
        grantExpiresAt: new Date("2026-09-01T00:00:00.000Z"),
        refreshTokenExpiresAt: new Date("2026-08-20T00:00:00.001Z"),
      },
    ],
    ["disabled client", { clientEnabled: false }],
    [
      "less than one access-token lifetime plus clock tolerance remains",
      {
        credentialExpiresAt: new Date("2026-07-21T00:10:04.999Z"),
        grantExpiresAt: new Date("2026-07-21T00:10:04.999Z"),
        refreshTokenExpiresAt: new Date("2026-07-21T00:10:04.999Z"),
      },
    ],
    ["Grant resource drift", { grantResource: "https://attacker.example/mcp" }],
    ["Credential resource drift", { credentialResource: "https://attacker.example/mcp" }],
    ["Credential scope drift", { credentialScopes: ["research:read"] }],
  ])("rejects %s before the Provider handler", async (_scenario, override) => {
    let providerCalls = 0;
    await expect(
      executeRemoteMcpTokenEndpointBoundary(
        {
          authorizationHeaders: [],
          parameters: new URLSearchParams({
            client_id: CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: "aln_rt_v1_sensitive",
            resource: RESOURCE,
          }),
        },
        { now: new Date("2026-07-21T00:00:00.000Z"), resource: RESOURCE },
        async (_input, executeWhileLocked) =>
          executeWhileLocked({ ...validLockedAuthority(), ...override }),
        () => {
          providerCalls += 1;
          return Promise.resolve("issued");
        },
      ),
    ).rejects.toMatchObject({
      code: "REFRESH_AUTHORITY_INVALID",
      statusCode: 500,
    });
    expect(providerCalls).toBe(0);
  });

  it("accepts authority at the exact token-lifetime-plus-clock-tolerance horizon", async () => {
    const horizon = new Date("2026-07-21T00:10:05.000Z");
    await expect(
      executeRemoteMcpTokenEndpointBoundary(
        {
          authorizationHeaders: [],
          parameters: new URLSearchParams({
            client_id: CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: "aln_rt_v1_sensitive",
            resource: RESOURCE,
          }),
        },
        { now: new Date("2026-07-21T00:00:00.000Z"), resource: RESOURCE },
        async (_input, executeWhileLocked) =>
          executeWhileLocked({
            ...validLockedAuthority(),
            credentialExpiresAt: horizon,
            grantExpiresAt: horizon,
            refreshTokenExpiresAt: horizon,
          }),
        () => Promise.resolve("issued"),
      ),
    ).resolves.toBe("issued");
  });

  it("accepts canonical IPv6 loopback resource and redirect URLs", () => {
    const resource = "http://[::1]:4100/mcp";
    const query = validAuthorizeQuery();
    query.set("redirect_uri", "http://[::1]:7777/callback");
    query.set("resource", resource);
    expect(validateRemoteMcpAuthorizeQuery(query, { resource })).toMatchObject({
      redirectUri: "http://[::1]:7777/callback",
      resource,
    });
  });
});

describe("authorization-request binding", () => {
  it("uses a keyed, deterministic, scope-order-independent 32-byte digest", () => {
    const first = createRemoteMcpAuthorizationBindingDigest(
      {
        clientId: CLIENT_ID,
        codeChallenge: CODE_CHALLENGE,
        redirectUri: REDIRECT_URI,
        requestedScopes: ["community:read", "offline_access", "research:read"],
      },
      BINDING_KEY,
    );
    const reordered = createRemoteMcpAuthorizationBindingDigest(
      {
        clientId: CLIENT_ID,
        codeChallenge: CODE_CHALLENGE,
        redirectUri: REDIRECT_URI,
        requestedScopes: ["research:read", "community:read", "offline_access"],
      },
      BINDING_KEY,
    );
    const otherRedirect = createRemoteMcpAuthorizationBindingDigest(
      {
        clientId: CLIENT_ID,
        codeChallenge: CODE_CHALLENGE,
        redirectUri: `${REDIRECT_URI}&exact=changed`,
        requestedScopes: ["research:read", "community:read", "offline_access"],
      },
      BINDING_KEY,
    );

    expect(first).toHaveLength(32);
    expect(first.equals(reordered)).toBe(true);
    expect(first.equals(otherRedirect)).toBe(false);
    expect(
      first.equals(
        createRemoteMcpAuthorizationBindingDigest(
          {
            clientId: CLIENT_ID,
            codeChallenge: CODE_CHALLENGE,
            redirectUri: REDIRECT_URI,
            requestedScopes: ["research:read", "community:read", "offline_access"],
          },
          Buffer.alloc(32, 0x58),
        ),
      ),
    ).toBe(false);
  });

  it("creates a DB-ready envelope without persisting verifier, state, or secrets", () => {
    const validated = validateRemoteMcpAuthorizeQuery(validAuthorizeQuery(), {
      resource: RESOURCE,
    });
    const envelope = createRemoteMcpAuthorizationRequestEnvelope(validated, BINDING_KEY);

    expect(envelope).toMatchObject({
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: "S256",
      oauthClientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      requestedScopes: ["research:read", "community:read", "offline_access"],
      resource: RESOURCE,
    });
    expect(envelope.bindingDigest).toHaveLength(32);
    expect(Object.keys(envelope).sort()).toEqual([
      "bindingDigest",
      "codeChallenge",
      "codeChallengeMethod",
      "oauthClientId",
      "redirectUri",
      "requestedScopes",
      "resource",
    ]);
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(CODE_VERIFIER);
    expect(serialized).not.toContain("state_7H0u3shUiyl91JJJ");
    expect(serialized).not.toContain("client_secret");
  });

  it("rejects weak digest keys", () => {
    expectGuardError(
      () =>
        createRemoteMcpAuthorizationBindingDigest(
          {
            clientId: CLIENT_ID,
            codeChallenge: CODE_CHALLENGE,
            redirectUri: REDIRECT_URI,
            requestedScopes: ["research:read"],
          },
          Buffer.alloc(31),
        ),
      "FLOW_DIGEST_KEY_INVALID",
    );
  });
});
