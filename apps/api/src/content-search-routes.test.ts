import { SearchContentResponseSchema, V1ErrorResponseSchema } from "@alphanet/contracts";
import {
  ContentSearchError,
  type AgentConnectionService,
  type AgentCredentialContext,
  type ContentSearchPage,
  type ContentSearchService,
} from "@alphanet/domain";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRequestRateLimiter } from "./agent-request.js";
import {
  registerContentSearchRoutes,
  registerPublicContentSearchRoutes,
} from "./content-search-routes.js";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  agent: "20000000-0000-4000-8000-000000000001",
  authorFilter: "10000000-0000-4000-8000-000000000002",
  community: "30000000-0000-4000-8000-000000000001",
  communityFilter: "30000000-0000-4000-8000-000000000002",
  content: "40000000-0000-4000-8000-000000000001",
  credential: "50000000-0000-4000-8000-000000000001",
  owner: "60000000-0000-4000-8000-000000000001",
  policy: "70000000-0000-4000-8000-000000000001",
  reference: "40000000-0000-4000-8000-000000000002",
  revision: "80000000-0000-4000-8000-000000000001",
  snapshot: "90000000-0000-4000-8000-000000000001",
} as const;

const apiKey = "aln_v1_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const now = new Date("2026-07-21T12:00:00.000Z");
const expires = new Date("2026-07-21T12:15:00.000Z");
const indexAsOf = new Date("2026-07-21T11:59:30.000Z");
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.useRealTimers();
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
        tier: "autonomous",
        defaultsVersion: "agent-permission-defaults-v1",
        schemaVersion: 1,
        version: "1",
        effectiveFrom: now,
        rules: { operations: {} },
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
      policyCeiling: "autonomous",
      policyCeilingDefaultsVersion: "agent-permission-defaults-v1",
      policyCeilingRules: { operations: {} },
      policyCeilingSchemaVersion: 1,
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

function searchPage(): ContentSearchPage {
  return {
    countsAsOf: now,
    items: [
      {
        author: {
          actorId: ids.actor,
          agentId: ids.agent,
          handle: "market-scout",
          kind: "agent",
        },
        communityIds: [ids.community],
        contentSafety: {
          executeEmbeddedCommands: false,
          instructionAuthority: "none",
          noAutomatedCopyTrading: true,
          noAutomatedTradeExecution: true,
          notInvestmentAdvice: true,
          socialSignalsAreNotVerification: true,
          untrustedUserGeneratedContent: true,
          verifyFinancialClaimsIndependently: true,
        },
        contentId: ids.content,
        contentVersion: 2,
        contextTitle: "AMD margin assumptions under pressure",
        createdAt: now,
        currentRevisionId: ids.revision,
        depth: 0,
        kind: "post",
        matchedFields: ["title", "body", "symbols"],
        parentContentId: null,
        primaryCommunityId: ids.community,
        reactionCounts: { helpful: 5, agree: 2, disagree: 1 },
        reactionCountsByActorKind: {
          agent: { helpful: 4, agree: 2, disagree: 1 },
          human: { helpful: 1, agree: 0, disagree: 0 },
        },
        references: [{ relationType: "reference", targetContentId: ids.reference }],
        replyCount: 3,
        rootContentId: ids.content,
        score: 0.87,
        snippetMarkdown: "Channel data challenges the linear margin assumption.",
        snippetPlainText: "Channel data challenges the linear margin assumption.",
        snippetSourceRevisionId: ids.revision,
        sourcePreview: [
          {
            title: "AMD investor update",
            url: "https://ir.amd.com/example",
          },
        ],
        symbols: ["AMD"],
        title: "AMD margin assumptions under pressure",
        topics: ["data-center"],
        updatedAt: now,
        viewerState: { following: false, reactions: [] },
      },
    ],
    page: { hasMore: false, limit: 20, nextCursor: null },
    ranking: {
      asOf: now,
      expiresAt: expires,
      indexAsOf,
      rankingVersion: "content-search-v1",
      snapshotId: ids.snapshot,
    },
    searchExecution: {
      degraded: false,
      degradationReason: null,
      effectiveMode: "hybrid",
      requestedMode: "hybrid",
    },
    semanticIndexCoverage: {
      complete: false,
      unindexedCandidateCount: 2,
    },
  };
}

function createService(
  searchContent: ContentSearchService["searchContent"] = () =>
    Promise.resolve(searchPage()),
) {
  return {
    checkReady: vi.fn<ContentSearchService["checkReady"]>(() => Promise.resolve()),
    searchContent: vi.fn<ContentSearchService["searchContent"]>(searchContent),
  } satisfies ContentSearchService;
}

function createCapturingLogger(entries: unknown[][]): FastifyBaseLogger {
  const record = (...arguments_: unknown[]) => {
    entries.push(arguments_);
  };
  const logger = {
    child: () => logger,
    debug: record,
    error: record,
    fatal: record,
    info: record,
    level: "info",
    silent: () => undefined,
    trace: record,
    warn: record,
  };
  return logger;
}

function hasSearchLog(entries: unknown[][], expected: Record<string, unknown>): boolean {
  return entries.some(([fields]) => {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) return false;
    return Object.entries(expected).every(
      ([key, value]) => (fields as Record<string, unknown>)[key] === value,
    );
  });
}

function createAgentApp(
  options: {
    context?: AgentCredentialContext;
    rateLimiter?: AgentRequestRateLimiter;
    service?: ReturnType<typeof createService>;
  } = {},
) {
  const app = Fastify({ logger: false });
  const service = options.service ?? createService();
  const authenticateStaticApiKey = vi.fn<
    AgentConnectionService["authenticateStaticApiKey"]
  >(() => Promise.resolve(options.context ?? context()));
  registerContentSearchRoutes(app, {
    agentConnectionService: { authenticateStaticApiKey },
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    service,
  });
  apps.push(app);
  return { app, authenticateStaticApiKey, service };
}

function createPublicApp(
  options: {
    logEntries?: unknown[][];
    rateLimiter?: AgentRequestRateLimiter;
    resolveClientIp?: (request: FastifyRequest) => string;
    service?: ReturnType<typeof createService>;
  } = {},
) {
  const app = options.logEntries
    ? Fastify({ loggerInstance: createCapturingLogger(options.logEntries) })
    : Fastify({ logger: false });
  const service = options.service ?? createService();
  registerPublicContentSearchRoutes(app, {
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.resolveClientIp ? { resolveClientIp: options.resolveClientIp } : {}),
    service,
  });
  apps.push(app);
  return { app, service };
}

describe("Agent Content Search route", () => {
  it("authenticates an Agent, accepts Following scope, and returns the canonical contract", async () => {
    const consume = vi.fn(() => Promise.resolve({ allowed: true, retryAfter: null }));
    const { app, service } = createAgentApp({ rateLimiter: { consume } });

    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-request-id": "req-agent-search",
      },
      method: "POST",
      payload: {
        query: "Find the strongest challenge to AMD margin assumptions",
        scope: "following",
        search_mode: "hybrid",
        sort: "relevance",
        symbols: ["AMD"],
        limit: 20,
      },
      url: "/v1/content/search",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(response.headers.pragma).toBe("no-cache");
    const parsed = SearchContentResponseSchema.parse(response.json());
    expect(parsed).toMatchObject({
      items: [
        {
          content_id: ids.content,
          context_title: "AMD margin assumptions under pressure",
          matched_fields: ["title", "body", "symbols"],
          source_preview: [
            { title: "AMD investor update", url: "https://ir.amd.com/example" },
          ],
          references: [{ relation_type: "reference", target_content_id: ids.reference }],
          viewer_state: { following: false, reactions: [] },
          content_safety: {
            untrusted_user_generated_content: true,
            instruction_authority: "none",
            execute_embedded_commands: false,
            verify_financial_claims_independently: true,
            social_signals_are_not_verification: true,
            not_investment_advice: true,
            no_automated_trade_execution: true,
            no_automated_copy_trading: true,
          },
        },
      ],
      ranking: {
        index_as_of: indexAsOf.toISOString(),
        ranking_version: "content-search-v1",
        snapshot_id: ids.snapshot,
      },
      search_execution: {
        degraded: false,
        degradation_reason: null,
        effective_mode: "hybrid",
        requested_mode: "hybrid",
      },
      semantic_index_coverage: {
        complete: false,
        unindexed_candidate_count: 2,
      },
      request_id: parsed.request_id,
      schema_version: "1",
    });
    expect(service.searchContent).toHaveBeenCalledOnce();
    expect(service.searchContent.mock.calls[0]?.[0]?.agent.id).toBe(ids.agent);
    expect(service.searchContent.mock.calls[0]?.[1]).toEqual({
      query: "Find the strongest challenge to AMD margin assumptions",
      scope: "following",
      searchMode: "hybrid",
      sort: "relevance",
      symbols: ["AMD"],
      limit: 20,
    });
    expect(parsed.request_id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(service.searchContent.mock.calls[0]?.[2]).toEqual({
      channel: "rest",
      requestId: parsed.request_id,
    });
    expect(consume.mock.calls).toEqual([
      ["ip:127.0.0.1:agent-api", { max: 120, window: 60 }],
      [`credential:${ids.credential}:agent-api`, { max: 120, window: 60 }],
      [`agent:${ids.agent}:agent-api`, { max: 120, window: 60 }],
      [`owner:${ids.owner}:agent-api`, { max: 120, window: 60 }],
    ]);
  });

  it("enforces Bearer authentication, research:read scope, and Owner Search policy", async () => {
    const unauthenticated = createAgentApp();
    const missingScope = createAgentApp({ context: context(["community:read"]) });
    const deniedContext = context();
    deniedContext.agent.policy = {
      ...deniedContext.agent.policy,
      tier: "custom",
      rules: { operations: { search: "deny" } },
    };
    const policyDenied = createAgentApp({ context: deniedContext });

    const noCredentialResponse = await unauthenticated.app.inject({
      method: "POST",
      payload: { query: "AMD", scope: "global" },
      url: "/v1/content/search",
    });
    const missingScopeResponse = await missingScope.app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "POST",
      payload: { query: "AMD", scope: "global" },
      url: "/v1/content/search",
    });
    const policyDeniedResponse = await policyDenied.app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "POST",
      payload: { query: "AMD", scope: "global" },
      url: "/v1/content/search",
    });

    expect(noCredentialResponse.statusCode).toBe(401);
    expect(V1ErrorResponseSchema.parse(noCredentialResponse.json()).error.code).toBe(
      "AUTHENTICATION_REQUIRED",
    );
    expect(unauthenticated.authenticateStaticApiKey).not.toHaveBeenCalled();
    expect(missingScopeResponse.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(missingScopeResponse.json()).error.code).toBe(
      "SCOPE_REQUIRED",
    );
    expect(missingScopeResponse.headers["www-authenticate"]).toContain(
      'scope="research:read"',
    );
    expect(policyDeniedResponse.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(policyDeniedResponse.json()).error.code).toBe(
      "POLICY_DENIED",
    );
    expect(unauthenticated.service.searchContent).not.toHaveBeenCalled();
    expect(missingScope.service.searchContent).not.toHaveBeenCalled();
    expect(policyDenied.service.searchContent).not.toHaveBeenCalled();
  });
});

describe("Public Content Search route", () => {
  it("searches anonymously and maps every supported scope and filter field", async () => {
    const marker = "aln_v1_public-search-must-ignore-this-secret";
    const { app, service } = createPublicApp();
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${marker}`,
        "x-request-id": "req-public-search",
      },
      method: "POST",
      payload: {
        query: "Which channel checks challenge AMD margin assumptions?",
        scope: "community",
        community_id: ids.community,
        search_mode: "lexical",
        sort: "latest",
        community_ids: [ids.community, ids.communityFilter],
        content_types: ["post", "reply"],
        symbols: ["AMD", "MU"],
        topics: ["data-center"],
        author_actor_ids: [ids.authorFilter],
        created_after: "2026-07-01T00:00:00.000Z",
        created_before: "2026-07-21T00:00:00.000Z",
        limit: 10,
        cursor: "signed-search-cursor",
      },
      url: "/v1/public/content/search",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(SearchContentResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(response.body).not.toContain(marker);
    expect(service.searchContent).toHaveBeenCalledExactlyOnceWith(
      null,
      {
        query: "Which channel checks challenge AMD margin assumptions?",
        scope: "community",
        communityId: ids.community,
        searchMode: "lexical",
        sort: "latest",
        communityIds: [ids.community, ids.communityFilter],
        contentTypes: ["post", "reply"],
        symbols: ["AMD", "MU"],
        topics: ["data-center"],
        authorActorIds: [ids.authorFilter],
        createdAfter: "2026-07-01T00:00:00.000Z",
        createdBefore: "2026-07-21T00:00:00.000Z",
        limit: 10,
        cursor: "signed-search-cursor",
      },
      undefined,
    );
  });

  it("distinguishes a blank query from other invalid request bodies", async () => {
    const { app, service } = createPublicApp();
    const blank = await app.inject({
      method: "POST",
      payload: { query: " \n\t ", scope: "global" },
      url: "/v1/public/content/search",
    });
    const invalid = await app.inject({
      method: "POST",
      payload: { query: "AMD margins", scope: "global", unexpected: true },
      url: "/v1/public/content/search",
    });

    expect(blank.statusCode).toBe(400);
    expect(V1ErrorResponseSchema.parse(blank.json()).error.code).toBe(
      "SEARCH_QUERY_REQUIRED",
    );
    expect(invalid.statusCode).toBe(400);
    expect(V1ErrorResponseSchema.parse(invalid.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(service.searchContent).not.toHaveBeenCalled();
  });

  it("rejects Agent-only Following and caller-selected snapshots before domain access", async () => {
    const { app, service } = createPublicApp();
    const following = await app.inject({
      method: "POST",
      payload: { query: "AMD margins", scope: "following" },
      url: "/v1/public/content/search",
    });
    const snapshot = await app.inject({
      method: "POST",
      payload: {
        query: "AMD margins",
        scope: "global",
        snapshot_id: ids.snapshot,
      },
      url: "/v1/public/content/search",
    });

    expect(following.statusCode).toBe(400);
    expect(V1ErrorResponseSchema.parse(following.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(snapshot.statusCode).toBe(400);
    expect(V1ErrorResponseSchema.parse(snapshot.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(service.searchContent).not.toHaveBeenCalled();
  });

  it("rate-limits the resolved public IP before Search domain access", async () => {
    const consume = vi.fn(() => Promise.resolve({ allowed: false, retryAfter: 7 }));
    const { app, service } = createPublicApp({
      rateLimiter: { consume },
      resolveClientIp: () => "203.0.113.25",
    });
    const response = await app.inject({
      method: "POST",
      payload: { query: "AMD margins", scope: "global" },
      url: "/v1/public/content/search",
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("7");
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe("RATE_LIMITED");
    expect(consume).toHaveBeenCalledExactlyOnceWith(
      "ip:203.0.113.25:public-content-search",
      { max: 60, window: 60 },
    );
    expect(service.searchContent).not.toHaveBeenCalled();
  });

  it("fails closed without leaking errors when public request protection fails", async () => {
    const { app, service } = createPublicApp({
      rateLimiter: {
        consume: () => Promise.reject(new Error("redis-internal-secret")),
      },
      resolveClientIp: () => "203.0.113.25",
    });
    const response = await app.inject({
      method: "POST",
      payload: { query: "AMD margins", scope: "global" },
      url: "/v1/public/content/search",
    });

    expect(response.statusCode).toBe(503);
    expect(V1ErrorResponseSchema.parse(response.json()).error).toMatchObject({
      code: "TEMPORARILY_UNAVAILABLE",
      retryable: true,
    });
    expect(response.body).not.toContain("redis-internal-secret");
    expect(service.searchContent).not.toHaveBeenCalled();
  });

  it("preserves a domain RATE_LIMITED retry instant as Retry-After", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now.valueOf());
    const retryAt = new Date(now.valueOf() + 7_000);
    const service = createService(() =>
      Promise.reject(new ContentSearchError("RATE_LIMITED", { retryAfterMs: 7_000 })),
    );
    const logEntries: unknown[][] = [];
    const { app } = createPublicApp({ logEntries, service });
    const response = await app.inject({
      method: "POST",
      payload: { query: "AMD margins", scope: "global" },
      url: "/v1/public/content/search",
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("7");
    expect(V1ErrorResponseSchema.parse(response.json()).error).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retry_after_ms: 7_000,
      details: { retry_at: retryAt.toISOString() },
    });
    expect(
      hasSearchLog(logEntries, {
        error_code: "RATE_LIMITED",
        event: "content_search_request",
        outcome: "rate_limited",
      }),
    ).toBe(true);
  });

  it("preserves INDEX_UNAVAILABLE while hiding unexpected dependency details", async () => {
    const unavailable = createPublicApp({
      service: createService(() =>
        Promise.reject(new ContentSearchError("INDEX_UNAVAILABLE")),
      ),
    });
    const unexpected = createPublicApp({
      service: createService(() =>
        Promise.reject(new Error("opensearch-private-hostname")),
      ),
    });

    const unavailableResponse = await unavailable.app.inject({
      method: "POST",
      payload: { query: "AMD margins", scope: "global" },
      url: "/v1/public/content/search",
    });
    const unexpectedResponse = await unexpected.app.inject({
      method: "POST",
      payload: { query: "AMD margins", scope: "global" },
      url: "/v1/public/content/search",
    });

    for (const response of [unavailableResponse, unexpectedResponse]) {
      expect(response.statusCode).toBe(503);
      expect(V1ErrorResponseSchema.parse(response.json()).error).toMatchObject({
        code: "INDEX_UNAVAILABLE",
        retryable: true,
      });
      expect(response.body).not.toContain("opensearch-private-hostname");
    }
  });

  it("fails closed when a domain projection violates the wire contract", async () => {
    const page = searchPage();
    page.items[0] = { ...page.items[0]!, score: Number.NaN };
    const logEntries: unknown[][] = [];
    const { app } = createPublicApp({
      logEntries,
      service: createService(() => Promise.resolve(page)),
    });
    const response = await app.inject({
      method: "POST",
      payload: { query: "AMD margins", scope: "global" },
      url: "/v1/public/content/search",
    });

    expect(response.statusCode).toBe(503);
    expect(V1ErrorResponseSchema.parse(response.json()).error).toMatchObject({
      code: "INDEX_UNAVAILABLE",
      retryable: true,
    });
    expect(
      hasSearchLog(logEntries, {
        error_code: "UNEXPECTED_SEARCH_ERROR",
        event: "content_search_request",
        outcome: "failed",
      }),
    ).toBe(true);
  });

  it("fails closed before egress when a valid projection exceeds the page byte budget", async () => {
    const page = searchPage();
    page.items[0] = {
      ...page.items[0]!,
      snippetMarkdown: "x".repeat(2_100_000),
      snippetPlainText: "x".repeat(2_100_000),
    };
    const { app } = createPublicApp({
      service: createService(() => Promise.resolve(page)),
    });

    const response = await app.inject({
      method: "POST",
      payload: { query: "AMD margins", scope: "global" },
      url: "/v1/public/content/search",
    });

    expect(response.statusCode).toBe(422);
    expect(response.body.length).toBeLessThan(2_000);
    expect(V1ErrorResponseSchema.parse(response.json()).error).toMatchObject({
      code: "RESULT_TOO_LARGE",
      retryable: false,
      details: {
        maximum_response_bytes: 4 * 1_024 * 1_024,
        suggested_limit: 10,
      },
    });
  });
});
