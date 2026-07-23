import { describe, expect, it } from "vitest";
import type { BetterAuthPlugin } from "better-auth";

import {
  createAlphaNetRemoteMcpOAuthLiveBoundary,
  createAlphaNetRemoteMcpOAuthSchemaOnlyPlugins,
  REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS,
  REMOTE_MCP_AUTHORIZATION_CODE_TTL_SECONDS,
  REMOTE_MCP_OAUTH_SCOPES,
  REMOTE_MCP_REFRESH_TOKEN_TTL_SECONDS,
  REMOTE_MCP_TOKEN_REQUEST_BODY_MAX_BYTES,
  type AlphaNetRemoteMcpOAuthSecurityHooks,
} from "./remote-mcp-oauth-provider.js";

const AUTH_USER_ID = "10000000-0000-4000-8000-000000000001";
const GRANT_ID = "20000000-0000-4000-8000-000000000002";
const CREDENTIAL_ID = "30000000-0000-4000-8000-000000000003";
const OWNER_SESSION_ID = "40000000-0000-4000-8000-000000000004";
const TOKEN_JTI_DIGEST = "A".repeat(43);
const CODE_CHALLENGE = "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
const CONTINUATION_HANDLE = "consent-continuation-v1";

function fakeEs256Token(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "ES256", kid: "test-v1", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    Buffer.alloc(64, 0x5a).toString("base64url"),
  ].join(".");
}

function successfulAccessToken(): string {
  return fakeEs256Token({
    aud: "https://mcp.alphanet.example/mcp",
    azp: "mcp-client-v1",
    credential_id: CREDENTIAL_ID,
    exp: 1_800,
    grant_epoch: 7,
    iat: 1_200,
    iss: "https://auth.alphanet.example/api/auth",
    jti: "50000000-0000-4000-8000-000000000005",
    nbf: 1_200,
    scope: "research:read offline_access",
    sub: GRANT_ID,
    token_jti_digest: TOKEN_JTI_DIGEST,
  });
}

function successfulTokenResponse(accessToken = successfulAccessToken()): Response {
  return Response.json(
    {
      access_token: accessToken,
      expires_at: 1_800,
      expires_in: 600,
      refresh_token: `aln_rt_v1_${"R".repeat(32)}`,
      scope: "offline_access research:read",
      token_type: "Bearer",
    },
    {
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    },
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readAuthorizationServerMetadata(
  plugins: readonly BetterAuthPlugin[],
  issuer: string,
): Promise<Record<string, unknown>> {
  const provider = plugins.find((plugin) => plugin.id === "oauth-provider");
  const result = await provider?.onRequest?.(
    new Request(`${issuer}/.well-known/oauth-authorization-server`),
    {
      baseURL: issuer,
      getPlugin: (id: string) => plugins.find((plugin) => plugin.id === id),
      options: { advanced: {} },
    } as never,
  );
  if (!result || !("response" in result)) {
    throw new Error("Expected OAuth authorization-server metadata response");
  }
  const metadata: unknown = await result.response.json();
  if (!isUnknownRecord(metadata)) {
    throw new Error("Expected OAuth authorization-server metadata object");
  }
  return metadata;
}

function streamingTokenRequest(chunks: readonly Uint8Array[]): Request {
  let nextChunk = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[nextChunk];
      if (!chunk) {
        controller.close();
        return;
      }
      nextChunk += 1;
      controller.enqueue(chunk);
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    body,
    duplex: "half",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  };
  return new Request("https://auth.alphanet.example/api/auth/oauth2/token", init);
}

function securityHooks(): AlphaNetRemoteMcpOAuthSecurityHooks {
  return {
    admitAuthorizationRequest: () => Promise.resolve({ allowed: true }),
    activateAuthorizationGrant: () => Promise.resolve(),
    compensateFailedAuthorizationGrantExchange: () => Promise.resolve(),
    executeDomainRevocationTransaction: () =>
      Promise.resolve(new Response(null, { status: 204 })),
    persistAccessTokenAuthority: () =>
      Promise.resolve({
        credentialId: CREDENTIAL_ID,
        grantEpoch: 7,
        tokenJtiDigest: TOKEN_JTI_DIGEST,
      }),
    persistAuthorizationRequestEnvelope: () => Promise.resolve(),
    postLogin: {
      page: "/oauth/select-agent",
      resolveGrantId: () => Promise.resolve(GRANT_ID),
      shouldRedirect: () => Promise.resolve(true),
    },
    signAccessToken: (payload) => Promise.resolve(fakeEs256Token(payload)),
    withAuthorizationCodeExchangeLock: async (_input, executeWhileLocked) =>
      executeWhileLocked({ grantId: GRANT_ID }),
    withOwnerClientRefreshLock: async (_input, executeWhileLocked) =>
      executeWhileLocked({
        clientEnabled: true,
        clientId: "unused-in-provider-unit-test",
        credentialResource: "https://mcp.alphanet.example/mcp",
        credentialScopes: ["research:read"],
        credentialExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
        credentialRevokedAt: null,
        credentialId: CREDENTIAL_ID,
        grantExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
        grantId: GRANT_ID,
        grantResource: "https://mcp.alphanet.example/mcp",
        grantStatus: "active",
        grantScopes: ["research:read", "offline_access"],
        originalRefreshTokenScopes: ["research:read", "offline_access"],
        ownerId: AUTH_USER_ID,
        refreshTokenExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
        refreshTokenIssuedAt: new Date("2026-07-21T00:00:00.000Z"),
        refreshTokenRevokedAt: null,
      }),
  };
}

function authorizationCodeTokenRequest(): Request {
  return new Request("https://auth.alphanet.example/api/auth/oauth2/token", {
    body: new URLSearchParams({
      client_id: "mcp-client-v1",
      code: "authorization-code-secret",
      code_verifier: "abcdefghijklmnopqrstuvwxyz0123456789-._~ABCDE",
      grant_type: "authorization_code",
      redirect_uri: "https://client.example/oauth/callback",
      resource: "https://mcp.alphanet.example/mcp",
    }),
    method: "POST",
  });
}

function authorizationCodeTokenFields() {
  return {
    grantType: "authorization_code" as const,
    scopes: ["offline_access", "research:read"],
    user: { id: AUTH_USER_ID },
    verificationValue: {
      query: {
        client_id: "mcp-client-v1",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256" as const,
        redirect_uri: "https://client.example/oauth/callback",
        resource: "https://mcp.alphanet.example/mcp",
        response_type: "code" as const,
        scope: "offline_access research:read",
      },
      referenceId: GRANT_ID,
      sessionId: OWNER_SESSION_ID,
      type: "authorization_code" as const,
      userId: AUTH_USER_ID,
    },
  };
}

describe("createAlphaNetRemoteMcpOAuthLiveBoundary", () => {
  it("locks the single-resource OAuth protocol profile", async () => {
    const { plugins } = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: securityHooks(),
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const boundary = plugins.find(
      (plugin) => plugin.id === "alphanet-remote-mcp-domain-boundary",
    );
    const jwtPlugin = plugins.find((plugin) => plugin.id === "jwt");
    const provider = plugins.find((plugin) => plugin.id === "oauth-provider");
    const providerOptions = provider?.options as
      | {
          customAccessTokenClaims?: (input: {
            referenceId?: string;
            resource?: string;
            scopes: string[];
            user?: { id: string } | null;
          }) => Promise<Record<string, unknown>>;
          customTokenResponseFields?: (input: {
            grantType: "refresh_token";
            scopes: string[];
            user: { id: string };
          }) => Promise<Record<string, unknown>>;
          postLogin?: {
            page: string;
            shouldRedirect(input: unknown): Promise<boolean>;
          };
          storeTokens?: {
            hash(token: string, type: string): Promise<string> | string;
          };
        }
      | undefined;

    expect(boundary).toBeDefined();
    expect(jwtPlugin?.id).toBe("jwt");
    expect(jwtPlugin?.endpoints).not.toHaveProperty("getJwks");
    expect(jwtPlugin?.endpoints).not.toHaveProperty("getToken");
    expect(jwtPlugin?.options).toMatchObject({
      disableSettingJwtHeader: true,
      jwks: {
        jwksPath: "/jwks",
        keyPairConfig: { alg: "ES256" },
      },
      jwt: { issuer: "https://auth.alphanet.example/api/auth" },
    });
    expect(provider?.id).toBe("oauth-provider");
    expect(provider?.endpoints).not.toHaveProperty("deleteOAuthConsent");
    expect(provider?.endpoints).not.toHaveProperty("updateOAuthConsent");
    expect(provider?.endpoints).not.toHaveProperty("oauth2Revoke");
    expect(provider?.options).toMatchObject({
      accessTokenExpiresIn: REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS,
      allowDynamicClientRegistration: false,
      allowUnauthenticatedClientRegistration: false,
      codeExpiresIn: REMOTE_MCP_AUTHORIZATION_CODE_TTL_SECONDS,
      grantTypes: ["authorization_code", "refresh_token"],
      rateLimit: { authorize: false },
      refreshTokenExpiresIn: REMOTE_MCP_REFRESH_TOKEN_TTL_SECONDS,
      scopes: [...REMOTE_MCP_OAUTH_SCOPES],
      validAudiences: ["https://mcp.alphanet.example/mcp"],
    });
    expect(providerOptions?.postLogin?.page).toBe("/oauth/select-agent");
    await expect(providerOptions?.postLogin?.shouldRedirect({})).resolves.toBe(true);
    expect(providerOptions?.storeTokens).toBeDefined();
    const refreshDigest = await Promise.resolve(
      providerOptions?.storeTokens?.hash("secret", "refresh_token"),
    );
    const accessDigest = await Promise.resolve(
      providerOptions?.storeTokens?.hash("secret", "access_token"),
    );
    expect(refreshDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(accessDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(refreshDigest).not.toBe(accessDigest);
    expect(refreshDigest).not.toContain("secret");
    await expect(
      providerOptions?.customTokenResponseFields?.({
        grantType: "refresh_token",
        scopes: ["research:read", "offline_access"],
        user: { id: AUTH_USER_ID },
      }),
    ).rejects.toThrow("token response authority is unavailable");
  });

  it("removes native introspection and its advertised metadata from the live boundary", async () => {
    const live = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: securityHooks(),
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const provider = live.plugins.find((plugin) => plugin.id === "oauth-provider");
    expect(provider?.endpoints).not.toHaveProperty("oauth2Introspect");
    expect(provider?.endpoints).not.toHaveProperty("getOAuthServerConfig");
    expect(provider?.endpoints).not.toHaveProperty("getOpenIdConfig");

    const metadata = await readAuthorizationServerMetadata(
      live.plugins,
      "https://auth.alphanet.example/api/auth",
    );
    expect(metadata).toMatchObject({
      issuer: "https://auth.alphanet.example/api/auth",
      revocation_endpoint_auth_methods_supported: ["none"],
      token_endpoint: "https://auth.alphanet.example/api/auth/oauth2/token",
      token_endpoint_auth_methods_supported: ["none"],
    });
    expect(metadata).not.toHaveProperty("introspection_endpoint");
    expect(metadata).not.toHaveProperty("introspection_endpoint_auth_methods_supported");
    expect(metadata).not.toHaveProperty(
      "introspection_endpoint_auth_signing_alg_values_supported",
    );
    await expect(
      live.plugins[0].onRequest?.(
        new Request("https://auth.alphanet.example/api/auth/oauth2/introspect", {
          method: "POST",
        }),
        {} as never,
      ),
    ).resolves.toMatchObject({ response: { status: 503 } });
  });

  it("blocks direct authorize handling and persists the one-shot envelope first", async () => {
    const events: string[] = [];
    const hooks = securityHooks();
    hooks.admitAuthorizationRequest = (input) => {
      expect(input).toEqual({
        clientId: "mcp-client-v1",
        clientIp: "2001:db8::10",
      });
      events.push("authorize:admitted");
      return Promise.resolve({ allowed: true });
    };
    hooks.persistAuthorizationRequestEnvelope = (authorization) => {
      expect(authorization).toMatchObject({
        clientId: "mcp-client-v1",
        codeChallenge: "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE",
        codeChallengeMethod: "S256",
        redirectUri: "https://client.example/oauth/callback",
        requestedScopes: ["research:read", "offline_access"],
        resource: "https://mcp.alphanet.example/mcp",
        responseType: "code",
      });
      events.push("envelope:persisted");
      return Promise.resolve();
    };
    const live = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: hooks,
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const boundary = live.plugins[0];
    const providerHandler = async (request: Request): Promise<Response> => {
      const guard = await boundary.onRequest?.(request, {} as never);
      if (guard && "response" in guard) {
        return guard.response;
      }
      events.push("provider");
      return new Response("authorize-continued");
    };
    const authorizeRequest = () => {
      const url = new URL("https://auth.alphanet.example/api/auth/oauth2/authorize");
      url.search = new URLSearchParams({
        client_id: "mcp-client-v1",
        code_challenge: "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE",
        code_challenge_method: "S256",
        redirect_uri: "https://client.example/oauth/callback",
        resource: "https://mcp.alphanet.example/mcp",
        response_type: "code",
        scope: "offline_access research:read",
        state: "state-high-entropy-value",
      }).toString();
      return new Request(url, {
        headers: { "x-alphanet-client-ip": "2001:db8::10" },
      });
    };

    expect((await providerHandler(authorizeRequest())).status).toBe(503);
    expect(events).toEqual([]);
    const response = await live.wrapProviderHandler(providerHandler)({
      authorizationHeaders: [],
      continuationHeaders: [],
      request: authorizeRequest(),
    });
    expect(response.status).toBe(200);
    expect(events).toEqual(["authorize:admitted", "envelope:persisted", "provider"]);
  });

  it("rate limits authorize before persistence and fails closed when admission is unavailable", async () => {
    const authorizeUrl = new URL(
      "https://auth.alphanet.example/api/auth/oauth2/authorize",
    );
    authorizeUrl.search = new URLSearchParams({
      client_id: "mcp-client-v1",
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
      redirect_uri: "https://client.example/oauth/callback",
      resource: "https://mcp.alphanet.example/mcp",
      response_type: "code",
      scope: "research:read",
    }).toString();
    const authorizeRequest = () =>
      new Request(authorizeUrl, {
        headers: { "x-alphanet-client-ip": "203.0.113.40" },
      });

    for (const unavailable of [false, true]) {
      let persistenceCalls = 0;
      let providerCalls = 0;
      const hooks = securityHooks();
      hooks.admitAuthorizationRequest = unavailable
        ? () => Promise.reject(new Error("Redis unavailable"))
        : () => Promise.resolve({ allowed: false, retryAfterSeconds: 37 });
      hooks.persistAuthorizationRequestEnvelope = () => {
        persistenceCalls += 1;
        return Promise.resolve();
      };
      const live = createAlphaNetRemoteMcpOAuthLiveBoundary({
        consentPage: "/oauth/consent",
        issuer: "https://auth.alphanet.example/api/auth",
        jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
        loginPage: "/login",
        resource: "https://mcp.alphanet.example/mcp",
        security: hooks,
        tokenStorageKey: Buffer.alloc(32, 0x77),
      });
      const handle = live.wrapProviderHandler(() => {
        providerCalls += 1;
        return Promise.resolve(new Response("must not run"));
      });
      const execution = handle({
        authorizationHeaders: [],
        continuationHeaders: [],
        request: authorizeRequest(),
      });

      if (unavailable) {
        await expect(execution).rejects.toThrow("Redis unavailable");
      } else {
        const response = await execution;
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("37");
        await expect(response.json()).resolves.toMatchObject({
          error: "temporarily_unavailable",
        });
      }
      expect(persistenceCalls).toBe(0);
      expect(providerCalls).toBe(0);
    }
  });

  it("requires one exact continuation header on continue and consent requests", async () => {
    const live = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: securityHooks(),
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    let providerCalls = 0;
    const handle = live.wrapProviderHandler(() => {
      providerCalls += 1;
      return Promise.resolve(new Response("continued"));
    });

    for (const path of ["/oauth2/continue", "/oauth2/consent"]) {
      const url = `https://auth.alphanet.example/api/auth${path}`;
      await expect(
        handle({
          authorizationHeaders: [],
          continuationHeaders: [],
          request: new Request(url, { method: "POST" }),
        }),
      ).rejects.toThrow("continuation header is required");

      await expect(
        handle({
          authorizationHeaders: [],
          continuationHeaders: [CONTINUATION_HANDLE, "second-continuation"],
          request: new Request(url, {
            headers: { "X-AlphaNet-OAuth-Continuation": CONTINUATION_HANDLE },
            method: "POST",
          }),
        }),
      ).rejects.toThrow("continuation header must not be repeated");

      await expect(
        handle({
          authorizationHeaders: [],
          continuationHeaders: ["raw-continuation"],
          request: new Request(url, {
            headers: { "X-AlphaNet-OAuth-Continuation": "fetch-continuation" },
            method: "POST",
          }),
        }),
      ).rejects.toThrow("raw continuation headers are unavailable");
    }
    expect(providerCalls).toBe(0);
  });

  it("claims consent once per request and leaves failed pre-token Grants pending", async () => {
    const phases: string[] = [];
    const continuationHandles: Array<string | undefined> = [];
    const compensations: unknown[] = [];
    const hooks = securityHooks();
    hooks.postLogin.resolveGrantId = (_context, phase, continuationHandle) => {
      phases.push(phase);
      continuationHandles.push(continuationHandle);
      return Promise.resolve(GRANT_ID);
    };
    hooks.compensateFailedAuthorizationGrantExchange = (input) => {
      compensations.push(input);
      return Promise.resolve();
    };
    const live = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: hooks,
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const provider = live.plugins.find((plugin) => plugin.id === "oauth-provider");
    const postLogin = (
      provider?.options as {
        postLogin: {
          consentReferenceId(input: unknown): Promise<string>;
          shouldRedirect(input: unknown): Promise<boolean>;
        };
      }
    ).postLogin;
    const consentContext = {
      scopes: ["research:read"],
      session: { id: OWNER_SESSION_ID },
      user: { id: AUTH_USER_ID },
    };
    const successfulConsent = await live.wrapProviderHandler(async () => {
      await expect(postLogin.consentReferenceId(consentContext)).resolves.toBe(GRANT_ID);
      await expect(postLogin.consentReferenceId(consentContext)).resolves.toBe(GRANT_ID);
      await expect(postLogin.shouldRedirect(consentContext)).resolves.toBe(false);
      return new Response("consent-complete");
    })({
      authorizationHeaders: [],
      continuationHeaders: [CONTINUATION_HANDLE],
      request: new Request("https://auth.alphanet.example/api/auth/oauth2/consent", {
        headers: { "X-AlphaNet-OAuth-Continuation": CONTINUATION_HANDLE },
        method: "POST",
      }),
    });
    expect(successfulConsent.status).toBe(200);
    expect(phases).toEqual(["claim"]);
    expect(compensations).toEqual([]);

    const failedConsent = await live.wrapProviderHandler(async () => {
      await expect(postLogin.consentReferenceId(consentContext)).resolves.toBe(GRANT_ID);
      await expect(postLogin.consentReferenceId(consentContext)).resolves.toBe(GRANT_ID);
      return new Response(null, { status: 500 });
    })({
      authorizationHeaders: [],
      continuationHeaders: [CONTINUATION_HANDLE],
      request: new Request("https://auth.alphanet.example/api/auth/oauth2/consent", {
        headers: { "X-AlphaNet-OAuth-Continuation": CONTINUATION_HANDLE },
        method: "POST",
      }),
    });
    expect(failedConsent.status).toBe(500);
    expect(phases).toEqual(["claim", "claim"]);
    expect(compensations).toEqual([]);

    const consentFailure = new Error("consent provider failed");
    await expect(
      live.wrapProviderHandler(async () => {
        await expect(postLogin.consentReferenceId(consentContext)).resolves.toBe(
          GRANT_ID,
        );
        throw consentFailure;
      })({
        authorizationHeaders: [],
        continuationHeaders: [CONTINUATION_HANDLE],
        request: new Request("https://auth.alphanet.example/api/auth/oauth2/consent", {
          headers: { "X-AlphaNet-OAuth-Continuation": CONTINUATION_HANDLE },
          method: "POST",
        }),
      }),
    ).rejects.toBe(consentFailure);
    expect(phases).toEqual(["claim", "claim", "claim"]);
    expect(compensations).toEqual([]);

    const authorizeUrl = new URL(
      "https://auth.alphanet.example/api/auth/oauth2/authorize",
    );
    authorizeUrl.search = new URLSearchParams({
      client_id: "mcp-client-v1",
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
      redirect_uri: "https://client.example/oauth/callback",
      resource: "https://mcp.alphanet.example/mcp",
      response_type: "code",
      scope: "research:read",
    }).toString();
    const boundary = live.plugins[0];
    const authorizeResponse = await live.wrapProviderHandler(async (request) => {
      const guard = await boundary.onRequest?.(request, {} as never);
      if (guard && "response" in guard) {
        return guard.response;
      }
      await expect(postLogin.consentReferenceId(consentContext)).resolves.toBe(GRANT_ID);
      return new Response("authorize-complete");
    })({
      authorizationHeaders: [],
      continuationHeaders: [],
      request: new Request(authorizeUrl, {
        headers: { "x-alphanet-client-ip": "2001:db8::11" },
      }),
    });
    expect(authorizeResponse.status).toBe(200);
    expect(phases).toEqual(["claim", "claim", "claim", "inspect"]);
    expect(continuationHandles).toEqual([
      CONTINUATION_HANDLE,
      CONTINUATION_HANDLE,
      CONTINUATION_HANDLE,
      undefined,
    ]);
    expect(compensations).toEqual([]);

    const continueResponse = await live.wrapProviderHandler(async () => {
      await expect(postLogin.shouldRedirect(consentContext)).resolves.toBe(false);
      await expect(postLogin.consentReferenceId(consentContext)).resolves.toBe(GRANT_ID);
      return new Response("continue-complete");
    })({
      authorizationHeaders: [],
      continuationHeaders: [CONTINUATION_HANDLE],
      request: new Request("https://auth.alphanet.example/api/auth/oauth2/continue", {
        headers: { "X-AlphaNet-OAuth-Continuation": CONTINUATION_HANDLE },
        method: "POST",
      }),
    });
    expect(continueResponse.status).toBe(200);
    expect(phases).toEqual(["claim", "claim", "claim", "inspect", "inspect"]);
    expect(continuationHandles.at(-1)).toBe(CONTINUATION_HANDLE);
  });

  it("does not infer pre-token authority from Provider redirect representations", async () => {
    const compensations: unknown[] = [];
    const hooks = securityHooks();
    hooks.compensateFailedAuthorizationGrantExchange = (input) => {
      compensations.push(input);
      return Promise.resolve();
    };
    const live = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: hooks,
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const provider = live.plugins.find((plugin) => plugin.id === "oauth-provider");
    const postLogin = (
      provider?.options as {
        postLogin: { consentReferenceId(input: unknown): Promise<string> };
      }
    ).postLogin;
    const consentContext = {
      scopes: ["research:read"],
      session: { id: OWNER_SESSION_ID },
      user: { id: AUTH_USER_ID },
    };
    const consentRequest = () =>
      new Request("https://auth.alphanet.example/api/auth/oauth2/consent", {
        headers: { "X-AlphaNet-OAuth-Continuation": CONTINUATION_HANDLE },
        method: "POST",
      });
    const runRedirect = (location: string) =>
      live.wrapProviderHandler(async () => {
        await postLogin.consentReferenceId(consentContext);
        return new Response(null, {
          headers: { Location: location },
          status: 302,
        });
      })({
        authorizationHeaders: [],
        continuationHeaders: [CONTINUATION_HANDLE],
        request: consentRequest(),
      });

    const success = new URL("https://client.example/oauth/callback");
    success.searchParams.set("code", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6");
    success.searchParams.set("state", "opaque-state");
    success.searchParams.set("iss", "https://auth.alphanet.example/api/auth");
    await expect(runRedirect(success.toString())).resolves.toMatchObject({
      status: 302,
    });
    expect(compensations).toEqual([]);

    const denied = new URL("https://client.example/oauth/callback");
    denied.searchParams.set("error", "access_denied");
    denied.searchParams.set("iss", "https://auth.alphanet.example/api/auth");
    await expect(runRedirect(denied.toString())).resolves.toMatchObject({ status: 302 });
    expect(compensations).toEqual([]);

    const offTarget = new URL("https://attacker.example/oauth/callback");
    offTarget.searchParams.set("code", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6");
    offTarget.searchParams.set("iss", "https://auth.alphanet.example/api/auth");
    await expect(runRedirect(offTarget.toString())).resolves.toMatchObject({
      status: 302,
    });
    expect(compensations).toEqual([]);
  });

  it("blocks direct token serving and completes refresh handling inside the lock", async () => {
    const events: string[] = [];
    const hooks = securityHooks();
    hooks.withOwnerClientRefreshLock = async (input, executeWhileLocked) => {
      expect(input).toEqual({
        clientId: "mcp-client-v1",
        refreshToken: "aln_rt_v1_test-secret",
        resource: "https://mcp.alphanet.example/mcp",
      });
      events.push("lock:enter");
      const now = Date.now();
      const value = await executeWhileLocked({
        clientEnabled: true,
        clientId: input.clientId,
        credentialResource: input.resource,
        credentialScopes: ["research:read"],
        credentialExpiresAt: new Date(now + 24 * 60 * 60 * 1_000),
        credentialRevokedAt: null,
        credentialId: CREDENTIAL_ID,
        grantExpiresAt: new Date(now + 24 * 60 * 60 * 1_000),
        grantId: GRANT_ID,
        grantResource: input.resource,
        grantStatus: "active",
        grantScopes: ["research:read", "offline_access"],
        originalRefreshTokenScopes: ["research:read", "offline_access"],
        ownerId: AUTH_USER_ID,
        refreshTokenExpiresAt: new Date(now + 24 * 60 * 60 * 1_000),
        refreshTokenIssuedAt: new Date(now - 60_000),
        refreshTokenRevokedAt: null,
      });
      events.push("lock:exit");
      return value;
    };
    const live = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: hooks,
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const boundary = live.plugins[0];
    const provider = live.plugins.find((plugin) => plugin.id === "oauth-provider");
    const providerOptions = provider?.options as {
      customTokenResponseFields(input: {
        grantType: "refresh_token";
        scopes: string[];
        user: { id: string };
      }): Promise<Record<string, unknown>> | Record<string, unknown>;
    };
    let boundedProviderRequest: Request | undefined;
    const providerHandler = async (request: Request): Promise<Response> => {
      const guard = await boundary.onRequest?.(request, {} as never);
      if (guard && "response" in guard) {
        return guard.response;
      }
      boundedProviderRequest = request;
      events.push("provider:start");
      await providerOptions.customTokenResponseFields({
        grantType: "refresh_token",
        scopes: ["offline_access", "research:read"],
        user: { id: AUTH_USER_ID },
      });
      events.push("provider:complete");
      const response = successfulTokenResponse();
      response.headers.delete("Cache-Control");
      response.headers.delete("Pragma");
      return response;
    };
    const tokenRequest = () =>
      new Request("https://auth.alphanet.example/api/auth/oauth2/token", {
        body: new URLSearchParams({
          client_id: "mcp-client-v1",
          grant_type: "refresh_token",
          refresh_token: "aln_rt_v1_test-secret",
          resource: "https://mcp.alphanet.example/mcp",
        }),
        method: "POST",
      });

    const direct = await providerHandler(tokenRequest());
    expect(direct.status).toBe(503);
    expect(events).toEqual([]);

    const admittedRequest = tokenRequest();
    const handle = live.wrapProviderHandler(providerHandler);
    const response = await handle({
      authorizationHeaders: [],
      continuationHeaders: [],
      request: admittedRequest,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    await expect(response.json()).resolves.toMatchObject({
      expires_in: 600,
      scope: "offline_access research:read",
      token_type: "Bearer",
    });
    expect(events).toEqual([
      "lock:enter",
      "provider:start",
      "provider:complete",
      "lock:exit",
    ]);
    expect(boundedProviderRequest).toBeInstanceOf(Request);
    expect(boundedProviderRequest).not.toBe(admittedRequest);
    if (!boundedProviderRequest) {
      throw new Error("Expected a bounded Provider request");
    }
    expect(boundedProviderRequest.headers.has("content-length")).toBe(false);
    await expect(boundedProviderRequest.clone().text()).resolves.toBe(
      new URLSearchParams({
        client_id: "mcp-client-v1",
        grant_type: "refresh_token",
        refresh_token: "aln_rt_v1_test-secret",
        resource: "https://mcp.alphanet.example/mcp",
      }).toString(),
    );

    const replayedRequestObject = await providerHandler(admittedRequest);
    expect(replayedRequestObject.status).toBe(503);
  });

  it("activates the exact authorization Grant before token signing and response", async () => {
    const events: string[] = [];
    const activationInputs: unknown[] = [];
    const codeLockInputs: unknown[] = [];
    const hooks = securityHooks();
    hooks.withAuthorizationCodeExchangeLock = async (input, executeWhileLocked) => {
      codeLockInputs.push(input);
      events.push("code:lock");
      const result = await executeWhileLocked({ grantId: GRANT_ID });
      events.push("code:unlock");
      return result;
    };
    hooks.activateAuthorizationGrant = (input) => {
      activationInputs.push(input);
      events.push("grant:activate");
      return Promise.resolve();
    };
    hooks.persistAccessTokenAuthority = () => {
      events.push("authority:persist");
      return Promise.resolve({
        credentialId: CREDENTIAL_ID,
        grantEpoch: 7,
        tokenJtiDigest: TOKEN_JTI_DIGEST,
      });
    };
    hooks.signAccessToken = (payload) => {
      events.push("token:sign");
      return Promise.resolve(fakeEs256Token(payload));
    };
    hooks.compensateFailedAuthorizationGrantExchange = () => {
      events.push("grant:compensate");
      return Promise.resolve();
    };
    const live = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: hooks,
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const boundary = live.plugins[0];
    const provider = live.plugins.find((plugin) => plugin.id === "oauth-provider");
    const providerOptions = provider?.options as {
      customTokenResponseFields(
        input: ReturnType<typeof authorizationCodeTokenFields>,
      ): Promise<Record<string, unknown>> | Record<string, unknown>;
    };
    const jwtOptions = (
      live.plugins.find((plugin) => plugin.id === "jwt")?.options as {
        jwt: { sign(payload: Record<string, unknown>): Promise<string> };
      }
    ).jwt;
    const providerHandler = async (request: Request): Promise<Response> => {
      const guard = await boundary.onRequest?.(request, {} as never);
      if (guard && "response" in guard) {
        return guard.response;
      }
      await providerOptions.customTokenResponseFields(authorizationCodeTokenFields());
      const accessToken = await jwtOptions.sign({
        aud: "https://mcp.alphanet.example/mcp",
        azp: "mcp-client-v1",
        exp: 1_800,
        grant_id: GRANT_ID,
        iat: 1_200,
        iss: "https://auth.alphanet.example/api/auth",
        jti: "50000000-0000-4000-8000-000000000005",
        scope: "research:read offline_access",
        sub: AUTH_USER_ID,
      });
      events.push("provider:response");
      return successfulTokenResponse(accessToken);
    };

    const response = await live.wrapProviderHandler(providerHandler)({
      authorizationHeaders: [],
      continuationHeaders: [],
      request: authorizationCodeTokenRequest(),
    });

    expect(response.status).toBe(200);
    expect(events).toEqual([
      "code:lock",
      "grant:activate",
      "authority:persist",
      "token:sign",
      "provider:response",
      "code:unlock",
    ]);
    expect(codeLockInputs).toEqual([
      {
        authorizationCode: "authorization-code-secret",
        clientId: "mcp-client-v1",
        codeVerifier: "abcdefghijklmnopqrstuvwxyz0123456789-._~ABCDE",
        redirectUri: "https://client.example/oauth/callback",
        resource: "https://mcp.alphanet.example/mcp",
      },
    ]);
    expect(activationInputs).toEqual([
      {
        authUserId: AUTH_USER_ID,
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: "S256",
        grantId: GRANT_ID,
        oauthClientId: "mcp-client-v1",
        ownerSessionId: OWNER_SESSION_ID,
        redirectUri: "https://client.example/oauth/callback",
        resource: "https://mcp.alphanet.example/mcp",
        scopes: ["research:read", "offline_access"],
      },
    ]);
    expect(JSON.stringify(activationInputs)).not.toContain("authorization-code-secret");
    expect(JSON.stringify(activationInputs)).not.toContain("code_verifier");
  });

  it("compensates an activated Grant before propagating a thrown token failure", async () => {
    const events: string[] = [];
    const hooks = securityHooks();
    hooks.activateAuthorizationGrant = () => {
      events.push("grant:activate");
      return Promise.resolve();
    };
    hooks.compensateFailedAuthorizationGrantExchange = (input) => {
      expect(input).toEqual({ grantId: GRANT_ID });
      events.push("grant:compensate");
      return Promise.resolve();
    };
    const live = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: hooks,
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const boundary = live.plugins[0];
    const provider = live.plugins.find((plugin) => plugin.id === "oauth-provider");
    const providerOptions = provider?.options as {
      customTokenResponseFields(
        input: ReturnType<typeof authorizationCodeTokenFields>,
      ): Promise<Record<string, unknown>> | Record<string, unknown>;
    };
    const providerFailure = new Error("provider failed without request values");
    const providerHandler = async (request: Request): Promise<Response> => {
      const guard = await boundary.onRequest?.(request, {} as never);
      if (guard && "response" in guard) {
        return guard.response;
      }
      await providerOptions.customTokenResponseFields(authorizationCodeTokenFields());
      events.push("provider:throw");
      throw providerFailure;
    };

    await expect(
      live.wrapProviderHandler(providerHandler)({
        authorizationHeaders: [],
        continuationHeaders: [],
        request: authorizationCodeTokenRequest(),
      }),
    ).rejects.toBe(providerFailure);
    expect(events).toEqual(["grant:activate", "provider:throw", "grant:compensate"]);
  });

  it("compensates a correlated pending Grant when Provider rejects before activation", async () => {
    const events: string[] = [];
    const hooks = securityHooks();
    hooks.withAuthorizationCodeExchangeLock = async (_input, executeWhileLocked) => {
      events.push("code:lock");
      const response = await executeWhileLocked({ grantId: GRANT_ID });
      events.push("code:unlock");
      return response;
    };
    hooks.compensateFailedAuthorizationGrantExchange = (input) => {
      expect(input).toEqual({ grantId: GRANT_ID });
      events.push("grant:compensate");
      return Promise.resolve();
    };
    const live = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: hooks,
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });

    const response = await live.wrapProviderHandler(() => {
      events.push("provider:reject");
      return Promise.resolve(new Response(null, { status: 400 }));
    })({
      authorizationHeaders: [],
      continuationHeaders: [],
      request: authorizationCodeTokenRequest(),
    });

    expect(response.status).toBe(400);
    expect(events).toEqual([
      "code:lock",
      "provider:reject",
      "grant:compensate",
      "code:unlock",
    ]);
  });

  it("compensates after Provider success when authorization-code lock completion fails", async () => {
    const events: string[] = [];
    const hooks = securityHooks();
    const lockFailure = new Error("authorization-code lock commit failed");
    hooks.withAuthorizationCodeExchangeLock = async (_input, executeWhileLocked) => {
      events.push("code:lock");
      await executeWhileLocked({ grantId: GRANT_ID });
      events.push("code:commit-failed");
      throw lockFailure;
    };
    hooks.compensateFailedAuthorizationGrantExchange = (input) => {
      expect(input).toEqual({ grantId: GRANT_ID });
      events.push("grant:compensate");
      return Promise.resolve();
    };
    const live = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: hooks,
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const boundary = live.plugins[0];
    const provider = live.plugins.find((plugin) => plugin.id === "oauth-provider");
    const providerOptions = provider?.options as {
      customTokenResponseFields(
        input: ReturnType<typeof authorizationCodeTokenFields>,
      ): Promise<Record<string, unknown>> | Record<string, unknown>;
    };

    await expect(
      live.wrapProviderHandler(async (request) => {
        const guard = await boundary.onRequest?.(request, {} as never);
        if (guard && "response" in guard) return guard.response;
        await providerOptions.customTokenResponseFields(authorizationCodeTokenFields());
        events.push("provider:success");
        return successfulTokenResponse();
      })({
        authorizationHeaders: [],
        continuationHeaders: [],
        request: authorizationCodeTokenRequest(),
      }),
    ).rejects.toBe(lockFailure);
    expect(events).toEqual([
      "code:lock",
      "provider:success",
      "code:commit-failed",
      "grant:compensate",
    ]);
  });

  it("compensates an activated Grant before returning a non-success token response", async () => {
    const events: string[] = [];
    const hooks = securityHooks();
    hooks.activateAuthorizationGrant = () => {
      events.push("grant:activate");
      return Promise.resolve();
    };
    hooks.compensateFailedAuthorizationGrantExchange = (input) => {
      expect(input).toEqual({ grantId: GRANT_ID });
      events.push("grant:compensate");
      return Promise.resolve();
    };
    const live = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: hooks,
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const boundary = live.plugins[0];
    const provider = live.plugins.find((plugin) => plugin.id === "oauth-provider");
    const providerOptions = provider?.options as {
      customTokenResponseFields(
        input: ReturnType<typeof authorizationCodeTokenFields>,
      ): Promise<Record<string, unknown>> | Record<string, unknown>;
    };
    const providerHandler = async (request: Request): Promise<Response> => {
      const guard = await boundary.onRequest?.(request, {} as never);
      if (guard && "response" in guard) {
        return guard.response;
      }
      await providerOptions.customTokenResponseFields(authorizationCodeTokenFields());
      events.push("provider:error-response");
      return new Response(null, { status: 500 });
    };

    const response = await live.wrapProviderHandler(providerHandler)({
      authorizationHeaders: [],
      continuationHeaders: [],
      request: authorizationCodeTokenRequest(),
    });
    expect(response.status).toBe(500);
    expect(events).toEqual([
      "grant:activate",
      "provider:error-response",
      "grant:compensate",
    ]);
  });

  it("compensates authority when Provider returns a malformed 2xx token response", async () => {
    const events: string[] = [];
    const hooks = securityHooks();
    hooks.activateAuthorizationGrant = () => {
      events.push("grant:activate");
      return Promise.resolve();
    };
    hooks.compensateFailedAuthorizationGrantExchange = () => {
      events.push("grant:compensate");
      return Promise.resolve();
    };
    const live = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: hooks,
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const boundary = live.plugins[0];
    const provider = live.plugins.find((plugin) => plugin.id === "oauth-provider");
    const providerOptions = provider?.options as {
      customTokenResponseFields(
        input: ReturnType<typeof authorizationCodeTokenFields>,
      ): Promise<Record<string, unknown>> | Record<string, unknown>;
    };

    await expect(
      live.wrapProviderHandler(async (request) => {
        const guard = await boundary.onRequest?.(request, {} as never);
        if (guard && "response" in guard) return guard.response;
        await providerOptions.customTokenResponseFields(authorizationCodeTokenFields());
        events.push("provider:malformed-success");
        return new Response("not-a-token-response", {
          headers: { "Content-Type": "text/plain" },
          status: 200,
        });
      })({
        authorizationHeaders: [],
        continuationHeaders: [],
        request: authorizationCodeTokenRequest(),
      }),
    ).rejects.toThrow("token success response is invalid");
    expect(events).toEqual([
      "grant:activate",
      "provider:malformed-success",
      "grant:compensate",
    ]);
  });

  it("rejects an oversized chunked token body by actual bytes read", async () => {
    let lockCalls = 0;
    let providerCalls = 0;
    const hooks = securityHooks();
    hooks.withOwnerClientRefreshLock = () => {
      lockCalls += 1;
      return Promise.reject(new Error("refresh lock must not run"));
    };
    const live = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: hooks,
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const request = streamingTokenRequest([
      new Uint8Array(REMOTE_MCP_TOKEN_REQUEST_BODY_MAX_BYTES / 2).fill(0x61),
      new Uint8Array(REMOTE_MCP_TOKEN_REQUEST_BODY_MAX_BYTES / 2).fill(0x62),
      new Uint8Array(1).fill(0x63),
    ]);
    expect(request.headers.has("content-length")).toBe(false);

    const response = await live.wrapProviderHandler(() => {
      providerCalls += 1;
      return Promise.resolve(new Response("provider must not run"));
    })({ authorizationHeaders: [], continuationHeaders: [], request });

    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "invalid_request",
      error_description: "The OAuth token request body is too large.",
    });
    expect(lockCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  it("preserves repeated raw Authorization rejection before Provider admission", async () => {
    let compensationCalls = 0;
    let lockCalls = 0;
    let providerCalls = 0;
    const hooks = securityHooks();
    hooks.compensateFailedAuthorizationGrantExchange = () => {
      compensationCalls += 1;
      return Promise.resolve();
    };
    hooks.withOwnerClientRefreshLock = () => {
      lockCalls += 1;
      return Promise.reject(new Error("refresh lock must not run"));
    };
    const live = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: hooks,
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const request = new Request("https://auth.alphanet.example/api/auth/oauth2/token", {
      body: new URLSearchParams({
        client_id: "mcp-client-v1",
        grant_type: "refresh_token",
        refresh_token: "aln_rt_v1_test-secret",
        resource: "https://mcp.alphanet.example/mcp",
      }),
      method: "POST",
    });

    const response = await live.wrapProviderHandler(() => {
      providerCalls += 1;
      return Promise.resolve(new Response("provider must not run"));
    })({
      authorizationHeaders: ["Basic first", "Basic second"],
      continuationHeaders: [],
      request,
    });

    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ error: "invalid_request" });
    expect(compensationCalls).toBe(0);
    expect(lockCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  it("rejects mutable public identifiers and weak storage keys", () => {
    const base = {
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: securityHooks(),
      tokenStorageKey: Buffer.alloc(32, 0x77),
    };

    expect(() =>
      createAlphaNetRemoteMcpOAuthLiveBoundary({
        ...base,
        resource: "https://mcp.alphanet.example/mcp?tenant=1",
      }),
    ).toThrow("query");
    expect(() =>
      createAlphaNetRemoteMcpOAuthLiveBoundary({
        ...base,
        resource: "https://mcp.alphanet.example/",
      }),
    ).toThrow("canonical /mcp path");
    expect(() =>
      createAlphaNetRemoteMcpOAuthLiveBoundary({
        ...base,
        resource: "https://MCP.alphanet.example/mcp",
      }),
    ).toThrow("canonical URL");
    expect(() =>
      createAlphaNetRemoteMcpOAuthLiveBoundary({
        ...base,
        tokenStorageKey: Buffer.alloc(16),
      }),
    ).toThrow("at least 32 bytes");
    expect(() =>
      createAlphaNetRemoteMcpOAuthLiveBoundary({
        ...base,
        issuer: "http://auth.alphanet.example/api/auth",
      }),
    ).toThrow("HTTPS");
  });

  it("persists exact Grant/JTI/Credential authority before signing", async () => {
    const persistenceInputs: unknown[] = [];
    const hooks = securityHooks();
    hooks.persistAccessTokenAuthority = (input) => {
      persistenceInputs.push(input);
      return Promise.resolve({
        credentialId: CREDENTIAL_ID,
        grantEpoch: 9,
        tokenJtiDigest: TOKEN_JTI_DIGEST,
      });
    };
    const { plugins } = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: hooks,
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const provider = plugins.find((plugin) => plugin.id === "oauth-provider");
    const jwtPlugin = plugins.find((plugin) => plugin.id === "jwt");
    const providerOptions = provider?.options as {
      customAccessTokenClaims(input: {
        referenceId?: string;
        resources?: string[];
        scopes: string[];
        user?: { id: string } | null;
      }): Promise<Record<string, unknown>>;
      postLogin: {
        consentReferenceId(input: unknown): Promise<string>;
      };
    };

    const claims = await providerOptions.customAccessTokenClaims({
      referenceId: GRANT_ID,
      resources: ["https://mcp.alphanet.example/mcp"],
      scopes: ["community:read", "offline_access"],
      user: { id: AUTH_USER_ID },
    });
    await expect(
      providerOptions.customAccessTokenClaims({
        referenceId: GRANT_ID,
        resources: ["https://mcp.alphanet.example/mcp", "https://untrusted.example/mcp"],
        scopes: ["community:read"],
        user: { id: AUTH_USER_ID },
      }),
    ).rejects.toThrow("token authority is unavailable");
    expect(claims).toMatchObject({
      grant_id: GRANT_ID,
    });
    expect(claims.jti).toEqual(
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    );
    expect(persistenceInputs).toEqual([]);
    const jwtOptions = (
      jwtPlugin?.options as {
        jwt: { sign(payload: Record<string, unknown>): Promise<string> };
      }
    ).jwt;
    await expect(
      jwtOptions.sign({
        ...claims,
        aud: "https://mcp.alphanet.example/mcp",
        azp: "mcp-client-v1",
        exp: 1_800,
        iat: 1_200,
        iss: "https://auth.alphanet.example/api/auth",
        scope: "community:read offline_access",
        sub: AUTH_USER_ID,
      }),
    ).resolves.toMatch(/^ey/);
    expect(persistenceInputs).toEqual([
      expect.objectContaining({
        authUserId: AUTH_USER_ID,
        expiresAt: new Date(1_800_000),
        grantId: GRANT_ID,
        issuedAt: new Date(1_200_000),
        jti: claims.jti,
        oauthClientId: "mcp-client-v1",
        protocolScopes: ["community:read", "offline_access"],
        resource: "https://mcp.alphanet.example/mcp",
        scopes: ["community:read"],
      }),
    ]);
    await expect(providerOptions.postLogin.consentReferenceId({})).rejects.toThrow(
      "consent Grant is unavailable",
    );

    await expect(
      providerOptions.customAccessTokenClaims({
        resources: ["https://mcp.alphanet.example/mcp"],
        scopes: ["community:read"],
        user: { id: AUTH_USER_ID },
      }),
    ).rejects.toThrow("authority is unavailable");
  });

  it("routes native consent and token revocation through the domain transaction", async () => {
    const operations: string[] = [];
    const hooks = securityHooks();
    hooks.executeDomainRevocationTransaction = ({ operation }) => {
      operations.push(operation);
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const { plugins } = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: hooks,
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const boundary = plugins.find(
      (plugin) => plugin.id === "alphanet-remote-mcp-domain-boundary",
    );

    for (const path of [
      "/oauth2/delete-consent",
      "/oauth2/update-consent",
      "/oauth2/revoke",
    ]) {
      const result = await boundary?.onRequest?.(
        new Request(`https://auth.alphanet.example/api/auth${path}`, {
          method: "POST",
        }),
        {} as never,
      );
      expect(result).toMatchObject({ response: { status: 204 } });
    }
    expect(operations).toEqual(["delete_consent", "update_consent", "revoke_token"]);
    await expect(
      boundary?.onRequest?.(
        new Request("https://auth.alphanet.example/api/auth/oauth2/token", {
          method: "POST",
        }),
        {} as never,
      ),
    ).resolves.toMatchObject({ response: { status: 503 } });
  });

  it("rewrites sub to the Grant and signs only the canonical access-token claims", async () => {
    const signedPayloads: Record<string, unknown>[] = [];
    const hooks = securityHooks();
    hooks.persistAccessTokenAuthority = () =>
      Promise.resolve({
        credentialId: CREDENTIAL_ID,
        grantEpoch: 11,
        tokenJtiDigest: TOKEN_JTI_DIGEST,
      });
    hooks.signAccessToken = (payload) => {
      expect(Object.isFrozen(payload)).toBe(true);
      signedPayloads.push(payload);
      return Promise.resolve(fakeEs256Token(payload));
    };
    const { plugins } = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: hooks,
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const jwtPlugin = plugins.find((plugin) => plugin.id === "jwt");
    const jwtOptions = (
      jwtPlugin?.options as {
        jwt: { sign(payload: Record<string, unknown>): Promise<string> };
      }
    ).jwt;
    const sign = (payload: Record<string, unknown>) => jwtOptions.sign(payload);
    const providerPayload = {
      aud: "https://mcp.alphanet.example/mcp",
      azp: "mcp-client-v1",
      exp: 1_800,
      grant_id: GRANT_ID,
      iat: 1_200,
      iss: "https://auth.alphanet.example/api/auth",
      jti: "40000000-0000-4000-8000-000000000004",
      scope: "research:read offline_access",
      sid: "provider-session-must-not-leak",
      sub: AUTH_USER_ID,
    };
    await expect(sign(providerPayload)).resolves.toMatch(/^ey/);
    expect(signedPayloads).toEqual([
      {
        aud: "https://mcp.alphanet.example/mcp",
        azp: "mcp-client-v1",
        credential_id: CREDENTIAL_ID,
        exp: 1_800,
        grant_epoch: 11,
        iat: 1_200,
        iss: "https://auth.alphanet.example/api/auth",
        jti: "40000000-0000-4000-8000-000000000004",
        nbf: 1_200,
        scope: "research:read offline_access",
        sub: GRANT_ID,
        token_jti_digest: TOKEN_JTI_DIGEST,
      },
    ]);
    expect(JSON.stringify(signedPayloads)).not.toContain(AUTH_USER_ID);
    expect(JSON.stringify(signedPayloads)).not.toContain("session-must-not-leak");
    await expect(sign({ ...providerPayload, exp: 1_799 })).rejects.toThrow(
      "signing payload is invalid",
    );

    hooks.signAccessToken = (payload) =>
      Promise.resolve(fakeEs256Token({ ...payload, owner_id: AUTH_USER_ID }));
    const { plugins: unsafePlugins } = createAlphaNetRemoteMcpOAuthLiveBoundary({
      consentPage: "/oauth/consent",
      issuer: "https://auth.alphanet.example/api/auth",
      jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
      loginPage: "/login",
      resource: "https://mcp.alphanet.example/mcp",
      security: hooks,
      tokenStorageKey: Buffer.alloc(32, 0x77),
    });
    const unsafeJwtOptions = (
      unsafePlugins.find((plugin) => plugin.id === "jwt")?.options as {
        jwt: { sign(payload: Record<string, unknown>): Promise<string> };
      }
    ).jwt;
    const unsafeSign = (payload: Record<string, unknown>) =>
      unsafeJwtOptions.sign(payload);
    await expect(unsafeSign(providerPayload)).rejects.toThrow("signer failed");
  });

  it("fails startup with incomplete live hooks and keeps schema-only plugins non-servable", async () => {
    expect(() =>
      createAlphaNetRemoteMcpOAuthLiveBoundary({
        consentPage: "/oauth/consent",
        issuer: "https://auth.alphanet.example/api/auth",
        jwksUrl: "https://keys.alphanet.example/remote-mcp/jwks.json",
        loginPage: "/login",
        resource: "https://mcp.alphanet.example/mcp",
        security: {} as ReturnType<typeof securityHooks>,
        tokenStorageKey: Buffer.alloc(32, 0x77),
      }),
    ).toThrow("security hooks are incomplete");

    const schemaOnly = createAlphaNetRemoteMcpOAuthSchemaOnlyPlugins({
      consentPage: "/oauth/consent",
      issuer: "http://[::1]:4000/api/auth",
      loginPage: "/login",
      resource: "http://[::1]:4100/mcp",
    });
    expect(schemaOnly.map((plugin) => plugin.id)).toEqual([
      "alphanet-remote-mcp-schema-only-do-not-serve",
      "jwt",
      "oauth-provider",
    ]);
    expect(schemaOnly[2].endpoints).not.toHaveProperty("oauth2Introspect");
    expect(schemaOnly[2].endpoints).not.toHaveProperty("getOAuthServerConfig");
    expect(schemaOnly[2].endpoints).not.toHaveProperty("getOpenIdConfig");
    const metadata = await readAuthorizationServerMetadata(
      schemaOnly,
      "http://[::1]:4000/api/auth",
    );
    expect(metadata).not.toHaveProperty("introspection_endpoint");
    expect(metadata).not.toHaveProperty("introspection_endpoint_auth_methods_supported");
    expect(metadata).not.toHaveProperty(
      "introspection_endpoint_auth_signing_alg_values_supported",
    );
    expect(metadata).toMatchObject({
      revocation_endpoint_auth_methods_supported: ["none"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    const blocked = await schemaOnly[0].onRequest?.(
      new Request("http://[::1]:4000/api/auth/oauth2/token"),
      {} as never,
    );
    expect(blocked).toMatchObject({ response: { status: 503 } });
    const blockedIntrospection = await schemaOnly[0].onRequest?.(
      new Request("http://[::1]:4000/api/auth/oauth2/introspect", {
        method: "POST",
      }),
      {} as never,
    );
    expect(blockedIntrospection).toMatchObject({ response: { status: 503 } });
  });
});
