import { createHash } from "node:crypto";

import type {
  AlphaNetAuthRuntime,
  OwnerSession,
  RemoteMcpOAuthConsentRequestView,
  RemoteMcpOAuthConsentService,
  RemoteMcpOAuthPreparedGrant,
  RemoteMcpOAuthResolvedContinuation,
} from "@alphanet/auth";
import { RemoteMcpOAuthConsentError } from "@alphanet/auth";
import {
  OwnerRemoteMcpOAuthConsentInspectResponseSchema,
  OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerOwnerRemoteMcpOAuthConsentRoutes } from "./owner-oauth-consent-routes.js";
import type { OwnerRequestRateLimiter } from "./owner-request.js";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  agent: "20000000-0000-4000-8000-000000000002",
  authorizationRequest: "30000000-0000-4000-8000-000000000003",
  credential: "40000000-0000-4000-8000-000000000004",
  grant: "50000000-0000-4000-8000-000000000005",
  otherAuthorizationRequest: "60000000-0000-4000-8000-000000000006",
  owner: "70000000-0000-4000-8000-000000000007",
  session: "80000000-0000-4000-8000-000000000008",
} as const;

const allowedOrigin = "https://app.alphanet.example";
const resource = "https://mcp.alphanet.example/mcp";
const redirectUri = "https://client.example/callback";
const continuationHandle = "continuation_handle-1";
const codeVerifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const codeChallenge = createHash("sha256")
  .update(codeVerifier, "ascii")
  .digest("base64url");
const expiresAt = new Date("2026-07-22T12:10:00.000Z");
const grantExpiresAt = new Date("2026-08-21T12:00:00.000Z");
const apps: FastifyInstance[] = [];

const ownerSession: OwnerSession = {
  owner: {
    email: "owner@alphanet.example",
    emailVerified: true,
    id: ids.owner,
    name: "Research Owner",
    status: "active",
  },
  session: {
    createdAt: new Date("2026-07-22T12:00:00.000Z"),
    expiresAt: new Date("2026-07-29T12:00:00.000Z"),
    id: ids.session,
  },
};

function signedConsentQuery(mutate?: (parameters: URLSearchParams) => void): string {
  const parameters = new URLSearchParams({
    response_type: "code",
    client_id: "alphanet-research-client",
    redirect_uri: redirectUri,
    scope: "offline_access research:read",
    state: "opaque-state",
    prompt: "consent",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    resource,
    exp: "1784722200",
    ba_iat: "1784721600123",
  });
  mutate?.(parameters);

  const signedNames = [...new Set([...parameters.keys(), "ba_param"])]
    .filter((name) => name !== "sig")
    .sort();
  parameters.delete("ba_param");
  for (const name of signedNames) parameters.append("ba_param", name);
  parameters.set("sig", `${"A".repeat(43)}=`);
  return parameters.toString();
}

function consentView(
  overrides: Partial<RemoteMcpOAuthConsentRequestView> = {},
): RemoteMcpOAuthConsentRequestView {
  return {
    agents: [
      {
        actorId: ids.actor,
        displayName: "Research Agent",
        handle: "research-agent",
        id: ids.agent,
        policy: {
          defaultsVersion: "agent-permission-defaults-v1",
          schemaVersion: 1,
          tier: "assisted",
          version: "9007199254740993",
        },
      },
    ],
    client: {
      id: "alphanet-research-client",
      name: "AlphaNet Research Client",
      redirectOrigin: "https://client.example",
    },
    expiresAt,
    id: ids.authorizationRequest,
    ownerId: ids.owner,
    requestedScopes: ["research:read", "offline_access"],
    resource,
    selectedAgentId: null,
    status: "pending",
    ...overrides,
  };
}

function preparedGrant(
  overrides: Partial<RemoteMcpOAuthPreparedGrant> = {},
): RemoteMcpOAuthPreparedGrant {
  return {
    authorizationRequestId: ids.authorizationRequest,
    continuationHandle,
    credentialId: ids.credential,
    expiresAt: grantExpiresAt,
    grantId: ids.grant,
    idempotent: false,
    credentialPolicyCeiling: {
      defaultsVersion: "agent-permission-defaults-v1",
      schemaVersion: 1,
      tier: "assisted",
    },
    scopes: ["research:read"],
    ...overrides,
  };
}

function resolvedContinuation(
  overrides: Partial<RemoteMcpOAuthResolvedContinuation> = {},
): RemoteMcpOAuthResolvedContinuation {
  return {
    authorizationRequestId: ids.authorizationRequest,
    credentialPolicyCeiling: {
      defaultsVersion: "agent-permission-defaults-v1",
      schemaVersion: 1,
      tier: "assisted",
    },
    grantId: ids.grant,
    ...overrides,
  };
}

interface TestAppOptions {
  loadConsentRequest?: RemoteMcpOAuthConsentService["loadConsentRequest"];
  rateLimiter?: OwnerRequestRateLimiter;
  resolveContinuationHandle?: RemoteMcpOAuthConsentService["resolveContinuationHandle"];
  selectAgentAndPrepareGrant?: RemoteMcpOAuthConsentService["selectAgentAndPrepareGrant"];
  session?: OwnerSession | null;
}

function createApp(options: TestAppOptions = {}) {
  const loadConsentRequest = vi.fn<RemoteMcpOAuthConsentService["loadConsentRequest"]>(
    options.loadConsentRequest ?? (() => Promise.resolve(consentView())),
  );
  const resolveContinuationHandle = vi.fn<
    RemoteMcpOAuthConsentService["resolveContinuationHandle"]
  >(options.resolveContinuationHandle ?? (() => Promise.resolve(resolvedContinuation())));
  const selectAgentAndPrepareGrant = vi.fn<
    RemoteMcpOAuthConsentService["selectAgentAndPrepareGrant"]
  >(options.selectAgentAndPrepareGrant ?? (() => Promise.resolve(preparedGrant())));
  const getOwnerSession = vi.fn<AlphaNetAuthRuntime["getOwnerSession"]>(() =>
    Promise.resolve(options.session === undefined ? ownerSession : options.session),
  );
  const app = Fastify({ logger: false });
  registerOwnerRemoteMcpOAuthConsentRoutes(app, {
    allowedOrigins: [allowedOrigin],
    authRuntime: { getOwnerSession },
    resource,
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    resolveClientIp: () => "203.0.113.8",
    service: {
      loadConsentRequest,
      resolveContinuationHandle,
      selectAgentAndPrepareGrant,
    },
  });
  apps.push(app);
  return {
    app,
    getOwnerSession,
    loadConsentRequest,
    resolveContinuationHandle,
    selectAgentAndPrepareGrant,
  };
}

function mutationHeaders(origin = allowedOrigin) {
  return {
    "content-type": "application/json",
    cookie: "alphanet.session=opaque",
    origin,
    "sec-fetch-site": "same-origin",
  };
}

function inspectRequest(payload: Record<string, unknown>) {
  return {
    method: "POST" as const,
    url: "/v1/owner/remote-mcp/oauth/consent/inspect",
    headers: mutationHeaders(),
    payload,
  };
}

function selectRequest(payload: Record<string, unknown>) {
  return {
    method: "POST" as const,
    url: "/v1/owner/remote-mcp/oauth/consent/select-agent",
    headers: mutationHeaders(),
    payload,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

describe("Owner Remote MCP OAuth consent routes", () => {
  it("inspects a signed pending request through the authenticated Owner session", async () => {
    const { app, loadConsentRequest, resolveContinuationHandle } = createApp();
    const oauthQuery = signedConsentQuery();
    const response = await app.inject(
      inspectRequest({
        oauth_query: oauthQuery,
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    const body = OwnerRemoteMcpOAuthConsentInspectResponseSchema.parse(response.json());
    expect(body).toMatchObject({
      phase: "agent_selection",
      selected_agent_id: null,
      client: {
        id: "alphanet-research-client",
        redirect_origin: "https://client.example",
        redirect_uri: redirectUri,
      },
      credential_policy_ceiling: null,
      requested_scopes: ["research:read", "offline_access"],
      resource,
    });
    expect(loadConsentRequest).toHaveBeenCalledExactlyOnceWith({
      clientId: "alphanet-research-client",
      codeChallenge,
      ownerSessionId: ids.session,
      redirectUri,
      requestedScopes: ["research:read", "offline_access"],
      resource,
    });
    expect(resolveContinuationHandle).not.toHaveBeenCalled();

    for (const secret of [
      oauthQuery,
      ids.owner,
      ids.actor,
      ids.authorizationRequest,
      ids.grant,
      ids.credential,
    ]) {
      expect(response.body).not.toContain(secret);
    }
  });

  it("enters consent review only after the continuation matches the selected request", async () => {
    const selectedView = consentView({
      selectedAgentId: ids.agent,
      status: "selected",
    });
    const { app, resolveContinuationHandle } = createApp({
      loadConsentRequest: () => Promise.resolve(selectedView),
    });
    const response = await app.inject(
      inspectRequest({
        oauth_query: signedConsentQuery(),
        continuation_handle: continuationHandle,
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(
      OwnerRemoteMcpOAuthConsentInspectResponseSchema.parse(response.json()),
    ).toMatchObject({
      phase: "consent_review",
      selected_agent_id: ids.agent,
      credential_policy_ceiling: {
        defaults_version: "agent-permission-defaults-v1",
        schema_version: 1,
        tier: "assisted",
      },
    });
    expect(resolveContinuationHandle).toHaveBeenCalledExactlyOnceWith({
      continuationHandle,
      ownerSessionId: ids.session,
      phase: "inspect",
    });

    const noHandle = await app.inject(
      inspectRequest({ oauth_query: signedConsentQuery() }),
    );
    expect(noHandle.statusCode).toBe(200);
    expect(
      OwnerRemoteMcpOAuthConsentInspectResponseSchema.parse(noHandle.json()),
    ).toMatchObject({ phase: "agent_selection", selected_agent_id: null });
  });

  it("fails closed when a continuation resolves to another authorization request", async () => {
    const { app } = createApp({
      loadConsentRequest: () =>
        Promise.resolve(consentView({ selectedAgentId: ids.agent, status: "selected" })),
      resolveContinuationHandle: () =>
        Promise.resolve(
          resolvedContinuation({
            authorizationRequestId: ids.otherAuthorizationRequest,
          }),
        ),
    });
    const response = await app.inject(
      inspectRequest({
        oauth_query: signedConsentQuery(),
        continuation_handle: continuationHandle,
      }),
    );

    expect(response.statusCode).toBe(503);
    const body = V1ErrorResponseSchema.parse(response.json());
    expect(body.error.code).toBe("OWNER_OAUTH_CONSENT_UNAVAILABLE");
    expect(response.body).not.toContain(continuationHandle);
    expect(response.body).not.toContain(ids.otherAuthorizationRequest);
  });

  it("selects an owned Agent and returns the frozen Credential ceiling with an opaque continuation", async () => {
    const selectedView = consentView({
      selectedAgentId: ids.agent,
      status: "selected",
    });
    const { app, loadConsentRequest, selectAgentAndPrepareGrant } = createApp({
      loadConsentRequest: () => Promise.resolve(selectedView),
    });
    const oauthQuery = signedConsentQuery();
    const response = await app.inject(
      selectRequest({
        oauth_query: oauthQuery,
        agent_id: ids.agent,
      }),
    );

    expect(response.statusCode).toBe(200);
    const body = OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema.parse(
      response.json(),
    );
    expect(body).toMatchObject({
      phase: "consent_review",
      selected_agent_id: ids.agent,
      continuation_handle: continuationHandle,
      grant_expires_at: grantExpiresAt.toISOString(),
      idempotent: false,
      credential_policy_ceiling: {
        defaults_version: "agent-permission-defaults-v1",
        schema_version: 1,
        tier: "assisted",
      },
    });
    const expectedRequestInput = {
      clientId: "alphanet-research-client",
      codeChallenge,
      ownerSessionId: ids.session,
      redirectUri,
      requestedScopes: ["research:read", "offline_access"],
      resource,
    };
    expect(selectAgentAndPrepareGrant).toHaveBeenCalledExactlyOnceWith({
      ...expectedRequestInput,
      agentId: ids.agent,
    });
    expect(loadConsentRequest).toHaveBeenCalledExactlyOnceWith(expectedRequestInput);
    expect(selectAgentAndPrepareGrant.mock.invocationCallOrder[0]).toBeLessThan(
      loadConsentRequest.mock.invocationCallOrder[0]!,
    );

    for (const secret of [
      oauthQuery,
      ids.owner,
      ids.actor,
      ids.authorizationRequest,
      ids.grant,
      ids.credential,
    ]) {
      expect(response.body).not.toContain(secret);
    }
  });

  it("fails closed when the reloaded request and prepared Grant do not correlate", async () => {
    const { app } = createApp({
      loadConsentRequest: () =>
        Promise.resolve(consentView({ selectedAgentId: ids.agent, status: "selected" })),
      selectAgentAndPrepareGrant: () =>
        Promise.resolve(
          preparedGrant({ authorizationRequestId: ids.otherAuthorizationRequest }),
        ),
    });
    const response = await app.inject(
      selectRequest({ oauth_query: signedConsentQuery(), agent_id: ids.agent }),
    );

    expect(response.statusCode).toBe(503);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "OWNER_OAUTH_CONSENT_UNAVAILABLE",
    );
    expect(response.body).not.toContain(ids.otherAuthorizationRequest);
  });

  it("uses the shared Owner authentication and same-origin mutation boundary", async () => {
    const unauthenticated = createApp({ session: null });
    const unauthenticatedResponse = await unauthenticated.app.inject(
      inspectRequest({ oauth_query: signedConsentQuery() }),
    );
    expect(unauthenticatedResponse.statusCode).toBe(401);
    expect(unauthenticated.loadConsentRequest).not.toHaveBeenCalled();

    const crossOrigin = createApp();
    const crossOriginResponse = await crossOrigin.app.inject({
      ...selectRequest({ oauth_query: signedConsentQuery(), agent_id: ids.agent }),
      headers: mutationHeaders("https://attacker.invalid"),
    });
    expect(crossOriginResponse.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(crossOriginResponse.json()).error.code).toBe(
      "CSRF_VALIDATION_FAILED",
    );
    expect(crossOrigin.selectAgentAndPrepareGrant).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "unknown inspect body field",
      request: inspectRequest({
        oauth_query: signedConsentQuery(),
        owner_id: ids.owner,
      }),
    },
    {
      label: "malformed provider query",
      request: inspectRequest({ oauth_query: "client_id=unsigned" }),
    },
    {
      label: "inspect URL query parameters",
      request: {
        ...inspectRequest({ oauth_query: signedConsentQuery() }),
        url: "/v1/owner/remote-mcp/oauth/consent/inspect?debug=true",
      },
    },
    {
      label: "invalid selected Agent id",
      request: selectRequest({
        oauth_query: signedConsentQuery(),
        agent_id: "not-an-id",
      }),
    },
  ])("rejects $label before entering the consent service", async ({ request }) => {
    const { app, loadConsentRequest, selectAgentAndPrepareGrant } = createApp();
    const response = await app.inject(request);

    expect(response.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(loadConsentRequest).not.toHaveBeenCalled();
    expect(selectAgentAndPrepareGrant).not.toHaveBeenCalled();
  });

  it.each([
    ["AGENT_NOT_AVAILABLE", 404],
    ["CLIENT_NOT_AVAILABLE", 400],
    ["CONSENT_STATE_CONFLICT", 409],
    ["CONTINUATION_EXPIRED", 410],
    ["CONTINUATION_INVALID", 400],
    ["CONTINUATION_REPLAYED", 409],
    ["GRANT_CONFLICT", 409],
    ["OWNER_SESSION_INVALID", 401],
    ["REQUEST_EXPIRED", 410],
    ["REQUEST_NOT_FOUND", 404],
  ] as const)("maps %s to a stable V1 failure", async (code, statusCode) => {
    const { app } = createApp({
      loadConsentRequest: () => Promise.reject(new RemoteMcpOAuthConsentError(code)),
    });
    const response = await app.inject(
      inspectRequest({ oauth_query: signedConsentQuery() }),
    );

    expect(response.statusCode).toBe(statusCode);
    const body = V1ErrorResponseSchema.parse(response.json());
    expect(body.error).toMatchObject({ code, retryable: false });
  });

  it("redacts unknown service failures behind the stable unavailable envelope", async () => {
    const secret = `password=secret ${signedConsentQuery()} ${continuationHandle}`;
    const { app } = createApp({
      loadConsentRequest: () => Promise.reject(new Error(secret)),
    });
    const response = await app.inject(
      inspectRequest({ oauth_query: signedConsentQuery() }),
    );

    expect(response.statusCode).toBe(503);
    const body = V1ErrorResponseSchema.parse(response.json());
    expect(body.error).toMatchObject({
      code: "OWNER_OAUTH_CONSENT_UNAVAILABLE",
      retryable: true,
    });
    expect(response.body).not.toContain("password");
    expect(response.body).not.toContain(continuationHandle);
  });

  it("applies the dedicated 120/min IP and 20/min Owner mutation limits", async () => {
    const consume = vi.fn<OwnerRequestRateLimiter["consume"]>(() =>
      Promise.resolve({ allowed: true, retryAfter: null }),
    );
    const { app } = createApp({ rateLimiter: { consume } });
    const response = await app.inject(
      inspectRequest({ oauth_query: signedConsentQuery() }),
    );

    expect(response.statusCode).toBe(200);
    expect(consume).toHaveBeenNthCalledWith(1, "ip:203.0.113.8:owner-api", {
      max: 120,
      window: 60,
    });
    expect(consume).toHaveBeenNthCalledWith(2, `owner:${ids.owner}:mutation`, {
      max: 20,
      window: 60,
    });
  });
});
