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
const TOKEN_JTI_DIGEST = "A".repeat(43);

function fakeEs256Token(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "ES256", kid: "test-v1", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    Buffer.alloc(64, 0x5a).toString("base64url"),
  ].join(".");
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
      refreshTokenExpiresIn: REMOTE_MCP_REFRESH_TOKEN_TTL_SECONDS,
      scopes: [...REMOTE_MCP_OAUTH_SCOPES],
      validAudiences: ["https://mcp.alphanet.example/mcp"],
    });
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
      token_endpoint: "https://auth.alphanet.example/api/auth/oauth2/token",
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
      return new Request(url);
    };

    expect((await providerHandler(authorizeRequest())).status).toBe(503);
    expect(events).toEqual([]);
    const response = await live.wrapProviderHandler(providerHandler)({
      authorizationHeaders: [],
      request: authorizeRequest(),
    });
    expect(response.status).toBe(200);
    expect(events).toEqual(["envelope:persisted", "provider"]);
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
    let boundedProviderRequest: Request | undefined;
    const providerHandler = async (request: Request): Promise<Response> => {
      const guard = await boundary.onRequest?.(request, {} as never);
      if (guard && "response" in guard) {
        return guard.response;
      }
      boundedProviderRequest = request;
      events.push("provider:start");
      await Promise.resolve();
      events.push("provider:complete");
      return new Response("provider-complete");
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
      request: admittedRequest,
    });
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("provider-complete");
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
    })({ authorizationHeaders: [], request });

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
      request,
    });

    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ error: "invalid_request" });
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
        resource?: string;
        scopes: string[];
        user?: { id: string } | null;
      }): Promise<Record<string, unknown>>;
      postLogin: {
        consentReferenceId(input: unknown): Promise<string>;
      };
    };

    const claims = await providerOptions.customAccessTokenClaims({
      referenceId: GRANT_ID,
      resource: "https://mcp.alphanet.example/mcp",
      scopes: ["community:read", "offline_access"],
      user: { id: AUTH_USER_ID },
    });
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
        resource: "https://mcp.alphanet.example/mcp",
        scopes: ["community:read"],
      }),
    ]);
    await expect(providerOptions.postLogin.consentReferenceId({})).resolves.toBe(
      GRANT_ID,
    );

    await expect(
      providerOptions.customAccessTokenClaims({
        resource: "https://mcp.alphanet.example/mcp",
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
