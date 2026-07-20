import {
  FindCommunitiesResponseSchema,
  GetCommunityResponseSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  CommunityDirectoryError,
  type AgentConnectionService,
  type AgentCredentialContext,
  type CommunityDetailProjection,
  type CommunityDirectoryPage,
  type CommunityDirectoryService,
} from "@alphanet/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerCommunityRoutes } from "./community-routes.js";
import type { AgentRequestRateLimiter } from "./agent-request.js";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  agent: "20000000-0000-4000-8000-000000000001",
  community: "30000000-0000-4000-8000-000000000001",
  credential: "40000000-0000-4000-8000-000000000001",
  owner: "50000000-0000-4000-8000-000000000001",
  policy: "60000000-0000-4000-8000-000000000001",
  topic: "70000000-0000-4000-8000-000000000001",
} as const;
const apiKey = "aln_v1_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const now = new Date("2026-07-20T12:00:00.000Z");
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function context(
  scopes: AgentCredentialContext["credential"]["scopes"] = [
    "community:read",
    "content:write",
  ],
): AgentCredentialContext {
  return {
    agent: {
      id: ids.agent,
      actorId: ids.actor,
      ownerId: ids.owner,
      handle: "market-scout",
      displayName: "Market Scout",
      bio: null,
      discoveryTags: [],
      status: "active",
      restrictionReasonCode: null,
      credentialCount: 1,
      createdAt: now,
      updatedAt: now,
      activatedAt: now,
      archivedAt: null,
      policy: {
        id: ids.policy,
        tier: "assisted",
        defaultsVersion: "agent-permission-defaults-v1",
        schemaVersion: 1,
        version: "1",
        effectiveFrom: now,
      },
    },
    credential: {
      id: ids.credential,
      ownerId: ids.owner,
      agentId: ids.agent,
      name: "Research runner",
      type: "static_api_key",
      prefix: "aln_v1_abcdefghijkl",
      scopes,
      audience: "urn:alphanet:api:v1",
      policyCeiling: "assisted",
      issuedAt: now,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      replacesCredentialId: null,
      status: "active",
    },
    owner: { id: ids.owner },
  };
}

function directoryPage(): CommunityDirectoryPage {
  return {
    items: [
      {
        id: ids.community,
        slug: "semiconductors",
        name: "Semiconductors",
        kind: "topic",
        canonicalTarget: {
          type: "topic",
          id: ids.topic,
          slug: "semiconductors",
        },
        state: "active",
        materializationState: "materialized",
        matchedFields: ["symbols"],
        matchReasons: ["symbol_filter_match"],
        postingPolicySummary: {
          maxPostsPerHour: 6,
          requiresSources: false,
        },
        viewerEligibility: {
          canRead: true,
          canPost: true,
          writeGate: "require_approval",
        },
      },
    ],
    page: { nextCursor: null, hasMore: false, limit: 20 },
    ordering: {
      snapshotId: "cms_0123456789abcdef0123456789abcdef",
      orderingVersion: "community-relevance-v1",
      asOf: now,
    },
  };
}

function communityDetail(): CommunityDetailProjection {
  const item = directoryPage().items[0]!;
  return {
    id: item.id,
    slug: item.slug,
    name: item.name,
    kind: item.kind,
    canonicalTarget: item.canonicalTarget,
    state: item.state,
    materializationState: item.materializationState,
    descriptionMarkdown: "Semiconductor company and supply-chain research.",
    version: 1,
    postingPolicy: {
      allowedContent: ["investment-research", "discussion"],
      maxPostsPerHour: 6,
      requiresSources: false,
    },
    viewerEligibility: item.viewerEligibility,
    createdAt: now,
    updatedAt: now,
  };
}

function createApp(options?: {
  context?: AgentCredentialContext;
  detail?: CommunityDetailProjection;
  getCommunity?: CommunityDirectoryService["getCommunity"];
  page?: CommunityDirectoryPage;
  rateLimiter?: AgentRequestRateLimiter;
}) {
  const app = Fastify({ logger: false });
  const authenticatedContext = options?.context ?? context();
  const listCommunities = vi.fn<CommunityDirectoryService["listCommunities"]>(() =>
    Promise.resolve(options?.page ?? directoryPage()),
  );
  const searchCommunities = vi.fn<CommunityDirectoryService["searchCommunities"]>(() =>
    Promise.resolve(options?.page ?? directoryPage()),
  );
  const getCommunity = vi.fn<CommunityDirectoryService["getCommunity"]>(
    options?.getCommunity ??
      (() => Promise.resolve(options?.detail ?? communityDetail())),
  );
  const authenticateStaticApiKey = vi.fn<
    AgentConnectionService["authenticateStaticApiKey"]
  >(() => Promise.resolve(authenticatedContext));
  registerCommunityRoutes(app, {
    agentConnectionService: { authenticateStaticApiKey },
    ...(options?.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    service: {
      checkReady: vi.fn(() => Promise.resolve()),
      listCommunities,
      searchCommunities,
      getCommunity,
    },
  });
  apps.push(app);
  return {
    app,
    authenticateStaticApiKey,
    getCommunity,
    listCommunities,
    searchCommunities,
  };
}

describe("Community Agent routes", () => {
  it("runs the Agent boundary before parsing the search JSON body", async () => {
    const consume = vi.fn(() => Promise.resolve({ allowed: true, retryAfter: null }));
    const { app, authenticateStaticApiKey, searchCommunities } = createApp({
      rateLimiter: { consume },
    });
    const response = await app.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: "{",
      url: "/v1/communities/search",
    });

    expect(response.statusCode).toBe(401);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "AUTHENTICATION_REQUIRED",
    );
    expect(consume).toHaveBeenCalledOnce();
    expect(authenticateStaticApiKey).not.toHaveBeenCalled();
    expect(searchCommunities).not.toHaveBeenCalled();
  });

  it("lists the directory with structured query arrays and a contract projection", async () => {
    const { app, listCommunities } = createApp();
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-request-id": "req-community-list",
      },
      method: "GET",
      url: "/v1/communities?states=active&symbols=AMD,MU&limit=20",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(FindCommunitiesResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(listCommunities).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ owner: { id: ids.owner } }),
      {
        states: ["active"],
        symbols: ["AMD", "MU"],
        limit: 20,
      },
    );
  });

  it("keeps proposed research in a POST body and maps it to domain search", async () => {
    const { app, searchCommunities } = createApp();
    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "POST",
      payload: {
        proposed_title: "AMD data-center scenarios",
        proposed_summary: "Semiconductor revenue and supply-chain assumptions.",
        symbols: ["AMD"],
      },
      url: "/v1/communities/search",
    });

    expect(response.statusCode).toBe(200);
    expect(searchCommunities).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        proposedTitle: "AMD data-center scenarios",
        proposedSummary: "Semiconductor revenue and supply-chain assumptions.",
        symbols: ["AMD"],
      }),
    );
  });

  it("returns one community through the stable detail contract", async () => {
    const { app, getCommunity } = createApp();
    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: `/v1/communities/${ids.community}`,
    });

    expect(response.statusCode).toBe(200);
    expect(GetCommunityResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(getCommunity).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ owner: { id: ids.owner } }),
      { communityId: ids.community },
    );
  });

  it("rejects natural-language GET query parameters before directory access", async () => {
    const { app, listCommunities } = createApp();
    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/communities?query=private-research",
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).not.toContain("private-research");
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(listCommunities).not.toHaveBeenCalled();
  });

  it("requires a community read scope before invoking the directory", async () => {
    const { app, listCommunities } = createApp({
      context: context(["content:write"]),
    });
    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/communities",
    });

    expect(response.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "SCOPE_REQUIRED",
    );
    expect(listCommunities).not.toHaveBeenCalled();
  });

  it("preserves directory errors and fails closed for an invalid projection", async () => {
    const missing = createApp({
      getCommunity: () =>
        Promise.reject(new CommunityDirectoryError("COMMUNITY_NOT_FOUND")),
    });
    const missingResponse = await missing.app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: `/v1/communities/${ids.community}`,
    });
    expect(missingResponse.statusCode).toBe(404);
    expect(V1ErrorResponseSchema.parse(missingResponse.json()).error.code).toBe(
      "COMMUNITY_NOT_FOUND",
    );

    const invalidPage = directoryPage();
    invalidPage.items[0] = {
      ...invalidPage.items[0]!,
      name: "",
    };
    const invalid = createApp({ page: invalidPage });
    const invalidResponse = await invalid.app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/communities",
    });
    expect(invalidResponse.statusCode).toBe(503);
    expect(V1ErrorResponseSchema.parse(invalidResponse.json()).error.code).toBe(
      "DIRECTORY_NOT_READY",
    );
  });
});
