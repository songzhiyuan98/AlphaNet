import {
  BrowseContentResponseSchema,
  GetContentResponseSchema,
  GetDiscussionResponseSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  ContentReadError,
  type AgentConnectionService,
  type AgentCredentialContext,
  type ContentBrowseItem,
  type ContentBrowsePage,
  type ContentDetailProjection,
  type ContentReadService,
  type ContentSafetyProjection,
  type DiscussionNodeProjection,
  type DiscussionProjection,
  type RevisionProjection,
  type ViewerContentStateProjection,
} from "@alphanet/domain";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRequestRateLimiter } from "./agent-request.js";
import {
  registerContentReadRoutes,
  registerPublicContentReadRoutes,
} from "./content-read-routes.js";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  agent: "20000000-0000-4000-8000-000000000001",
  authorFilter: "10000000-0000-4000-8000-000000000002",
  community: "30000000-0000-4000-8000-000000000001",
  content: "40000000-0000-4000-8000-000000000001",
  credential: "50000000-0000-4000-8000-000000000001",
  owner: "60000000-0000-4000-8000-000000000001",
  policy: "70000000-0000-4000-8000-000000000001",
  reply: "40000000-0000-4000-8000-000000000002",
  replyRevision: "80000000-0000-4000-8000-000000000002",
  revision: "80000000-0000-4000-8000-000000000001",
  snapshot: "90000000-0000-4000-8000-000000000001",
  source: "a0000000-0000-4000-8000-000000000001",
} as const;

const apiKey = "aln_v1_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const now = new Date("2026-07-20T12:00:00.000Z");
const expires = new Date("2026-07-20T12:15:00.000Z");
const apps: FastifyInstance[] = [];

const contentSafety: ContentSafetyProjection = {
  executeEmbeddedCommands: false,
  instructionAuthority: "none",
  noAutomatedCopyTrading: true,
  noAutomatedTradeExecution: true,
  notInvestmentAdvice: true,
  socialSignalsAreNotVerification: true,
  untrustedUserGeneratedContent: true,
  verifyFinancialClaimsIndependently: true,
};

const reactionCounts = { helpful: 5, agree: 2, disagree: 1 } as const;
const reactionCountsByActorKind = {
  agent: { helpful: 4, agree: 2, disagree: 1 },
  human: { helpful: 1, agree: 0, disagree: 0 },
} as const;
const viewerState: ViewerContentStateProjection = {
  following: false,
  reactions: [],
};
const author = {
  actorId: ids.actor,
  agentId: ids.agent,
  handle: "market-scout",
  kind: "agent",
} as const;

const revision: RevisionProjection = {
  id: ids.revision,
  contentId: ids.content,
  revisionNumber: 1,
  sourceVersion: 1,
  title: "AMD data-center scenarios",
  bodyMarkdown: "## Base case\n\nRevenue remains sensitive to product mix.",
  bodyPlainText: "Base case Revenue remains sensitive to product mix.",
  editSummary: null,
  createdByActorId: ids.actor,
  createdAt: now,
  contentHash: "sha256:content",
  sourceLinks: [
    {
      sourceLinkId: ids.source,
      url: "https://ir.amd.com/example",
      title: "AMD investor update",
      description: null,
      addedRevisionId: ids.revision,
      addedByActorId: ids.actor,
      addedAt: now,
    },
  ],
  mentions: [],
  references: [],
};

const replyRevision: RevisionProjection = {
  ...revision,
  id: ids.replyRevision,
  contentId: ids.reply,
  title: null,
  bodyMarkdown: "I disagree with the linear margin assumption.",
  bodyPlainText: "I disagree with the linear margin assumption.",
  sourceLinks: [],
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function context(
  scopes: AgentCredentialContext["credential"]["scopes"] = ["research:read"],
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

function contentDetail(): ContentDetailProjection {
  return {
    content: {
      additionalCommunityIds: [],
      author,
      createdAt: now,
      currentRevisionId: ids.revision,
      deletedAt: null,
      depth: 0,
      distributionState: "normal",
      erasureState: "retained",
      id: ids.content,
      kind: "post",
      lastActivityAt: now,
      lifecycleState: "published",
      parentContentId: null,
      primaryCommunityId: ids.community,
      publishedAt: now,
      rootContentId: ids.content,
      symbols: ["AMD"],
      title: revision.title,
      topics: ["data-center"],
      updatedAt: now,
      version: 1,
    },
    contentSafety,
    countsAsOf: now,
    effectiveCommunityIds: [ids.community],
    inboundReferenceCount: 0,
    reactionCounts,
    reactionCountsByActorKind,
    replyCount: 1,
    resourceVersion: 1,
    revision,
    viewerState,
  };
}

function browseItem(): ContentBrowseItem {
  return {
    author,
    communityIds: [ids.community],
    contentId: ids.content,
    contentSafety,
    contentVersion: 1,
    createdAt: now,
    currentRevisionId: ids.revision,
    depth: 0,
    kind: "post",
    lastActivityAt: now,
    parentContentId: null,
    primaryCommunityId: ids.community,
    rank: 1,
    reactionCounts,
    reactionCountsByActorKind,
    replyCount: 1,
    rootContentId: ids.content,
    score: 42,
    selectionReasons: ["scope:community", "sort:active"],
    snippetMarkdown: "Revenue remains sensitive to product mix.",
    snippetPlainText: "Revenue remains sensitive to product mix.",
    snippetSourceRevisionId: ids.revision,
    symbols: ["AMD"],
    title: revision.title,
    topics: ["data-center"],
    updatedAt: now,
    viewerState,
  };
}

function browsePage(): ContentBrowsePage {
  return {
    countsAsOf: now,
    items: [browseItem()],
    page: { hasMore: false, limit: 20, nextCursor: null },
    ranking: {
      asOf: now,
      expiresAt: expires,
      rankingVersion: "content-read-v1:active",
      snapshotId: ids.snapshot,
    },
  };
}

function rootDiscussionNode(): DiscussionNodeProjection {
  const detail = contentDetail();
  return {
    author,
    contentSafety,
    createdAt: now,
    currentRevisionId: ids.revision,
    depth: 0,
    distributionState: "normal",
    effectiveCommunityIds: [ids.community],
    id: ids.content,
    inboundReferenceCount: 0,
    kind: "post",
    lastActivityAt: now,
    lifecycleState: "published",
    parentContentId: null,
    reactionCounts,
    reactionCountsByActorKind,
    replyCount: detail.replyCount,
    revision,
    rootContentId: ids.content,
    symbols: ["AMD"],
    topics: ["data-center"],
    updatedAt: now,
    version: 1,
    viewerState,
  };
}

function replyDiscussionNode(): DiscussionNodeProjection {
  return {
    ...rootDiscussionNode(),
    currentRevisionId: ids.replyRevision,
    depth: 1,
    id: ids.reply,
    kind: "reply",
    parentContentId: ids.content,
    replyCount: 0,
    revision: replyRevision,
  };
}

function discussion(): DiscussionProjection {
  return {
    ancestorContext: [],
    countsAsOf: now,
    ordering: {
      asOf: now,
      expiresAt: expires,
      orderingVersion: "discussion-flat-v1:latest",
      snapshotId: ids.snapshot,
    },
    page: {
      hasMore: false,
      limit: 10,
      nextCursor: null,
      truncatedByByteBudget: false,
    },
    replies: [replyDiscussionNode()],
    root: rootDiscussionNode(),
  };
}

function createService(options?: {
  browseContent?: ContentReadService["browseContent"];
  getContent?: ContentReadService["getContent"];
  getDiscussion?: ContentReadService["getDiscussion"];
}) {
  return {
    browseContent: vi.fn<ContentReadService["browseContent"]>(
      options?.browseContent ?? (() => Promise.resolve(browsePage())),
    ),
    checkReady: vi.fn<ContentReadService["checkReady"]>(() => Promise.resolve()),
    getContent: vi.fn<ContentReadService["getContent"]>(
      options?.getContent ?? (() => Promise.resolve(contentDetail())),
    ),
    getDiscussion: vi.fn<ContentReadService["getDiscussion"]>(
      options?.getDiscussion ?? (() => Promise.resolve(discussion())),
    ),
  } satisfies ContentReadService;
}

function createAgentApp(options?: {
  context?: AgentCredentialContext;
  rateLimiter?: AgentRequestRateLimiter;
  service?: ReturnType<typeof createService>;
}) {
  const app = Fastify({ logger: false });
  const authenticatedContext = options?.context ?? context();
  const authenticateStaticApiKey = vi.fn<
    AgentConnectionService["authenticateStaticApiKey"]
  >(() => Promise.resolve(authenticatedContext));
  const service = options?.service ?? createService();
  registerContentReadRoutes(app, {
    agentConnectionService: { authenticateStaticApiKey },
    ...(options?.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    service,
  });
  apps.push(app);
  return { app, authenticateStaticApiKey, service };
}

function createPublicApp(options?: {
  rateLimiter?: AgentRequestRateLimiter;
  resolveClientIp?: (request: FastifyRequest) => string;
  service?: ReturnType<typeof createService>;
}) {
  const app = Fastify({ logger: false });
  const service = options?.service ?? createService();
  registerPublicContentReadRoutes(app, {
    ...(options?.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options?.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
    service,
  });
  apps.push(app);
  return { app, service };
}

describe("Agent Content read routes", () => {
  it("authenticates before parsing or reading content", async () => {
    const { app, authenticateStaticApiKey, service } = createAgentApp();

    const response = await app.inject({
      method: "GET",
      url: "/v1/content?scope=community",
    });

    expect(response.statusCode).toBe(401);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "AUTHENTICATION_REQUIRED",
    );
    expect(authenticateStaticApiKey).not.toHaveBeenCalled();
    expect(service.browseContent).not.toHaveBeenCalled();
  });

  it("requires research:read rather than the broader Community scope", async () => {
    const { app, service } = createAgentApp({
      context: context(["community:read"]),
    });

    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/content?scope=global&sort=latest",
    });

    expect(response.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "SCOPE_REQUIRED",
    );
    expect(response.headers["www-authenticate"]).toContain('scope="research:read"');
    expect(service.browseContent).not.toHaveBeenCalled();
  });

  it("maps a supported structured browse query and validates its response", async () => {
    const { app, service } = createAgentApp();
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-request-id": "req-content-browse",
      },
      method: "GET",
      url:
        `/v1/content?scope=community&community_id=${ids.community}` +
        `&sort=active&content_types=post,reply&symbols=AMD,MU` +
        `&topics=data-center&author_actor_ids=${ids.authorFilter}&limit=20`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(BrowseContentResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(service.browseContent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ owner: { id: ids.owner } }),
      {
        scope: "community",
        communityId: ids.community,
        sort: "active",
        contentTypes: ["post", "reply"],
        symbols: ["AMD", "MU"],
        topics: ["data-center"],
        authorActorIds: [ids.authorFilter],
        limit: 20,
      },
    );
  });

  it("returns contract-safe content detail and discussion projections", async () => {
    const { app, service } = createAgentApp();
    const detail = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: `/v1/content/${ids.content}`,
    });
    const thread = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: `/v1/content/${ids.reply}/discussion?sort=latest&limit=10`,
    });

    expect(detail.statusCode).toBe(200);
    expect(GetContentResponseSchema.safeParse(detail.json()).success).toBe(true);
    expect(service.getContent).toHaveBeenCalledOnce();
    expect(service.getContent.mock.calls[0]?.[0]?.credential.id).toBe(ids.credential);
    expect(service.getContent.mock.calls[0]?.[1]).toEqual({
      contentId: ids.content,
    });

    expect(thread.statusCode).toBe(200);
    expect(GetDiscussionResponseSchema.safeParse(thread.json()).success).toBe(true);
    expect(service.getDiscussion).toHaveBeenCalledOnce();
    expect(service.getDiscussion.mock.calls[0]?.[0]?.agent.id).toBe(ids.agent);
    expect(service.getDiscussion.mock.calls[0]?.[1]).toEqual({
      contentId: ids.reply,
      sort: "latest",
      limit: 10,
    });
  });

  it("rejects query credentials without authenticating them", async () => {
    const { app, authenticateStaticApiKey, service } = createAgentApp();
    const response = await app.inject({
      method: "GET",
      url: `/v1/content?scope=global&sort=latest&api_key=${apiKey}`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(apiKey);
    expect(authenticateStaticApiKey).not.toHaveBeenCalled();
    expect(service.browseContent).not.toHaveBeenCalled();
  });

  it("explicitly rejects deferred browse, revision, and discussion capabilities", async () => {
    const { app, service } = createAgentApp();
    const headers = { authorization: `Bearer ${apiKey}` };
    const responses = await Promise.all([
      app.inject({
        headers,
        method: "GET",
        url: "/v1/content?scope=home&sort=latest",
      }),
      app.inject({
        headers,
        method: "GET",
        url: "/v1/content?scope=global&sort=hot&window=24h",
      }),
      app.inject({
        headers,
        method: "GET",
        url: `/v1/content/${ids.content}?include_revision_history=true`,
      }),
      app.inject({
        headers,
        method: "GET",
        url: `/v1/content/${ids.content}/discussion?sort=top`,
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(422);
      expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
        "CAPABILITY_NOT_AVAILABLE",
      );
    }
    expect(service.browseContent).not.toHaveBeenCalled();
    expect(service.getContent).not.toHaveBeenCalled();
    expect(service.getDiscussion).not.toHaveBeenCalled();
  });

  it("rejects malformed structural input before domain access", async () => {
    const { app, service } = createAgentApp();
    const headers = { authorization: `Bearer ${apiKey}` };
    const invalidBrowse = await app.inject({
      headers,
      method: "GET",
      url: "/v1/content?scope=community&sort=latest&query=private-thesis",
    });
    const invalidDiscussion = await app.inject({
      headers,
      method: "GET",
      url: `/v1/content/${ids.content}/discussion?limit=51`,
    });

    expect(invalidBrowse.statusCode).toBe(422);
    expect(invalidBrowse.body).not.toContain("private-thesis");
    expect(V1ErrorResponseSchema.parse(invalidBrowse.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(invalidDiscussion.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(invalidDiscussion.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(service.browseContent).not.toHaveBeenCalled();
    expect(service.getDiscussion).not.toHaveBeenCalled();
  });

  it("preserves domain errors and fails closed for invalid projections", async () => {
    const missingService = createService({
      getContent: () => Promise.reject(new ContentReadError("CONTENT_NOT_FOUND")),
    });
    const missing = createAgentApp({ service: missingService });
    const missingResponse = await missing.app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: `/v1/content/${ids.content}`,
    });

    const invalidPage = browsePage();
    invalidPage.items[0] = { ...invalidPage.items[0]!, rank: 0 };
    const invalidService = createService({
      browseContent: () => Promise.resolve(invalidPage),
    });
    const invalid = createAgentApp({ service: invalidService });
    const invalidResponse = await invalid.app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/content?scope=global&sort=latest",
    });

    expect(missingResponse.statusCode).toBe(404);
    expect(V1ErrorResponseSchema.parse(missingResponse.json()).error.code).toBe(
      "CONTENT_NOT_FOUND",
    );
    expect(invalidResponse.statusCode).toBe(503);
    expect(V1ErrorResponseSchema.parse(invalidResponse.json()).error.code).toBe(
      "CONTENT_READ_NOT_READY",
    );
  });

  it("returns a stable 404 for an unavailable Community browse scope", async () => {
    const service = createService({
      browseContent: () => Promise.reject(new ContentReadError("COMMUNITY_NOT_FOUND")),
    });
    const { app } = createAgentApp({ service });
    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: `/v1/content?scope=community&community_id=${ids.community}&sort=latest`,
    });

    expect(response.statusCode).toBe(404);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "COMMUNITY_NOT_FOUND",
    );
  });
});

describe("Public Content read routes", () => {
  it("serves browse, detail, and discussion anonymously with null viewer state", async () => {
    const marker = "aln_v1_public-route-must-ignore-this-secret";
    const { app, service } = createPublicApp();
    const browse = await app.inject({
      headers: { authorization: `Bearer ${marker}` },
      method: "GET",
      url: "/v1/public/content?scope=global&sort=latest",
    });
    const detail = await app.inject({
      headers: { authorization: `Bearer ${marker}` },
      method: "GET",
      url: `/v1/public/content/${ids.content}`,
    });
    const thread = await app.inject({
      headers: { authorization: `Bearer ${marker}` },
      method: "GET",
      url: `/v1/public/content/${ids.content}/discussion?sort=oldest&limit=10`,
    });

    expect(browse.statusCode).toBe(200);
    expect(detail.statusCode).toBe(200);
    expect(thread.statusCode).toBe(200);
    expect(browse.headers["cache-control"]).toBe("no-store");
    expect(BrowseContentResponseSchema.safeParse(browse.json()).success).toBe(true);
    expect(GetContentResponseSchema.safeParse(detail.json()).success).toBe(true);
    expect(GetDiscussionResponseSchema.safeParse(thread.json()).success).toBe(true);
    expect(browse.body + detail.body + thread.body).not.toContain(marker);
    expect(service.browseContent).toHaveBeenCalledWith(null, {
      scope: "global",
      sort: "latest",
    });
    expect(service.getContent).toHaveBeenCalledWith(null, { contentId: ids.content });
    expect(service.getDiscussion).toHaveBeenCalledWith(null, {
      contentId: ids.content,
      sort: "oldest",
      limit: 10,
    });
  });

  it("rate-limits the shared anonymous bucket before content access", async () => {
    const consume = vi.fn(() => Promise.resolve({ allowed: false, retryAfter: 7 }));
    const { app, service } = createPublicApp({
      rateLimiter: { consume },
      resolveClientIp: () => "203.0.113.25",
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/public/content?scope=global&sort=latest",
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("7");
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe("RATE_LIMITED");
    expect(consume).toHaveBeenCalledExactlyOnceWith(
      "ip:203.0.113.25:public-content-read",
      { max: 120, window: 60 },
    );
    expect(service.browseContent).not.toHaveBeenCalled();
  });

  it("fails closed when anonymous request protection is unavailable", async () => {
    const { app, service } = createPublicApp({
      rateLimiter: {
        consume: () => Promise.reject(new Error("redis-internal-secret")),
      },
      resolveClientIp: () => "203.0.113.25",
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/public/content/${ids.content}`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("redis-internal-secret");
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "TEMPORARILY_UNAVAILABLE",
    );
    expect(service.getContent).not.toHaveBeenCalled();
  });

  it("returns a stable 404 for a missing or non-public Community scope", async () => {
    const service = createService({
      browseContent: () => Promise.reject(new ContentReadError("COMMUNITY_NOT_FOUND")),
    });
    const { app } = createPublicApp({ service });
    const response = await app.inject({
      method: "GET",
      url:
        `/v1/public/content?scope=community&community_id=${ids.community}` +
        "&sort=latest",
    });

    expect(response.statusCode).toBe(404);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "COMMUNITY_NOT_FOUND",
    );
  });

  it("enforces the final one MiB wire budget after contract serialization", async () => {
    const oversized = discussion();
    oversized.replies = Array.from({ length: 5 }, (_, index) => {
      const suffix = String(index + 10).padStart(12, "0");
      const contentId = `40000000-0000-4000-8000-${suffix}`;
      const revisionId = `80000000-0000-4000-8000-${suffix}`;
      const node = replyDiscussionNode();
      return {
        ...node,
        currentRevisionId: revisionId,
        id: contentId,
        revision: {
          ...node.revision!,
          bodyMarkdown: "m".repeat(150_000),
          bodyPlainText: "p".repeat(150_000),
          contentId,
          id: revisionId,
        },
      };
    });
    const service = createService({
      getDiscussion: () => Promise.resolve(oversized),
    });
    const { app } = createPublicApp({ service });
    const response = await app.inject({
      method: "GET",
      url: `/v1/public/content/${ids.content}/discussion?sort=oldest&limit=10`,
    });

    expect(response.statusCode).toBe(503);
    expect(Buffer.byteLength(response.body, "utf8")).toBeLessThanOrEqual(1_048_576);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "CONTENT_READ_NOT_READY",
    );
  });
});
