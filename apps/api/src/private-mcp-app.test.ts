import {
  createMcpActorContextAssertion,
  digestInboundMcpTokenJti,
  type McpActorAssertionKeyRing,
  type McpActorAssertionReplayStore,
} from "@alphanet/auth";
import {
  AgentContextResponseSchema,
  BrowseContentResponseSchema,
  CreatePostWriteResultSchema,
  FindCommunitiesResponseSchema,
  GetActionStatusResponseSchema,
  GetCommunityResponseSchema,
  GetContentResponseSchema,
  GetDiscussionResponseSchema,
  ListNotificationsResponseSchema,
  ReplyToContentWriteResultSchema,
  SearchContentResponseSchema,
} from "@alphanet/contracts";
import type {
  AgentCredentialContext,
  AgentPendingActionView,
  CommunityDetailProjection,
  ContentDetailProjection,
  RemoteMcpAuthorityService,
  ResearchWriteOutcome,
  ResearchWriteService,
} from "@alphanet/domain";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPrivateMcpApp,
  PRIVATE_MCP_ACTION_PATH,
  PRIVATE_MCP_AGENT_CONTEXT_PATH,
  PRIVATE_MCP_COMMUNITY_BY_SLUG_PATH,
  PRIVATE_MCP_COMMUNITY_PATH,
  PRIVATE_MCP_COMMUNITY_SEARCH_PATH,
  PRIVATE_MCP_CONTENT_BROWSE_PATH,
  PRIVATE_MCP_CONTENT_PATH,
  PRIVATE_MCP_CONTENT_SEARCH_PATH,
  PRIVATE_MCP_DISCUSSION_PATH,
  PRIVATE_MCP_NOTIFICATIONS_PATH,
  PRIVATE_MCP_POSTS_PATH,
  PRIVATE_MCP_REPLIES_PATH,
  type PrivateMcpAppOptions,
} from "./private-mcp-app.js";
import { registerResearchWriteRoutes } from "./research-write-routes.js";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  action: "70000000-0000-4000-8000-000000000007",
  agent: "20000000-0000-4000-8000-000000000002",
  community: "80000000-0000-4000-8000-000000000008",
  content: "90000000-0000-4000-8000-000000000009",
  credential: "30000000-0000-4000-8000-000000000003",
  grant: "40000000-0000-4000-8000-000000000004",
  owner: "50000000-0000-4000-8000-000000000005",
  policy: "60000000-0000-4000-8000-000000000006",
  revision: "a0000000-0000-4000-8000-00000000000a",
  reply: "d0000000-0000-4000-8000-00000000000d",
  replyRevision: "e0000000-0000-4000-8000-00000000000e",
  topic: "b0000000-0000-4000-8000-00000000000b",
} as const;
const now = new Date("2026-07-22T08:00:00.000Z");
const requestId = "req_private_mcp_context";
const apiKey = "aln_v1_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const keyRing: McpActorAssertionKeyRing = {
  currentVersion: 1,
  keys: {
    1: { key: Buffer.alloc(32, 0x21), verificationExpiresAt: null },
  },
};
const tokenJtiDigest = digestInboundMcpTokenJti(
  "remote-mcp-access-token-jti",
  Buffer.alloc(32, 0x31),
);
const context: AgentCredentialContext = {
  agent: {
    id: ids.agent,
    actorId: ids.actor,
    ownerId: ids.owner,
    handle: "market-scout",
    displayName: "Market Scout",
    bio: null,
    discoveryTags: ["semiconductors"],
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
      version: "7",
      effectiveFrom: now,
      rules: { operations: {} },
    },
  },
  credential: {
    id: ids.credential,
    ownerId: ids.owner,
    agentId: ids.agent,
    name: "Remote MCP grant",
    type: "oauth_grant",
    prefix: null,
    scopes: ["research:read", "community:read"],
    audience: "https://mcp.alphanet.test/mcp",
    policyCeiling: "assisted",
    policyCeilingDefaultsVersion: "agent-permission-defaults-v1",
    policyCeilingRules: { operations: {} },
    policyCeilingSchemaVersion: 1,
    issuedAt: now,
    expiresAt: new Date("2026-07-22T08:10:00.000Z"),
    lastUsedAt: null,
    revokedAt: null,
    replacesCredentialId: null,
    status: "active",
  },
  owner: { id: ids.owner },
};

function contextWithScopes(
  scopes: AgentCredentialContext["credential"]["scopes"],
): AgentCredentialContext {
  return {
    ...context,
    credential: { ...context.credential, scopes },
  };
}

function communityDetail(): CommunityDetailProjection {
  return {
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
    descriptionMarkdown: "Semiconductor company and supply-chain research.",
    version: 1,
    postingPolicy: {
      allowedContent: ["investment-research", "discussion"],
      maxPostsPerHour: 6,
      requiresSources: false,
    },
    viewerEligibility: {
      canRead: true,
      canPost: true,
      writeGate: "require_approval",
    },
    createdAt: now,
    updatedAt: now,
  };
}

function contentDetail(): ContentDetailProjection {
  return {
    content: {
      additionalCommunityIds: [],
      author: {
        actorId: ids.actor,
        agentId: ids.agent,
        handle: "market-scout",
        kind: "agent",
      },
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
      title: "AMD data-center scenarios",
      topics: ["data-center"],
      updatedAt: now,
      version: 1,
    },
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
    countsAsOf: now,
    effectiveCommunityIds: [ids.community],
    inboundReferenceCount: 0,
    reactionCounts: { agree: 2, disagree: 1, helpful: 5 },
    reactionCountsByActorKind: {
      agent: { agree: 2, disagree: 1, helpful: 4 },
      human: { agree: 0, disagree: 0, helpful: 1 },
    },
    replyCount: 1,
    resourceVersion: 1,
    revision: {
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
      sourceLinks: [],
      mentions: [],
      references: [],
    },
    viewerState: { following: false, reactions: [] },
  };
}

function emptyCommunitySearchPage(): Awaited<
  ReturnType<PrivateMcpAppOptions["communityDirectoryService"]["searchCommunities"]>
> {
  return {
    items: [],
    ordering: {
      asOf: now,
      orderingVersion: "community-directory-v1",
      snapshotId: "community-search-snapshot",
    },
    page: { hasMore: false, limit: 5, nextCursor: null },
  };
}

function emptyBrowsePage(): Awaited<
  ReturnType<PrivateMcpAppOptions["contentReadService"]["browseContent"]>
> {
  return {
    countsAsOf: now,
    items: [],
    page: { hasMore: false, limit: 5, nextCursor: null },
    ranking: {
      asOf: now,
      expiresAt: new Date(now.valueOf() + 300_000),
      rankingVersion: "content-read-v1:latest",
      snapshotId: "content-browse-snapshot",
    },
  };
}

function emptySearchPage(): Awaited<
  ReturnType<PrivateMcpAppOptions["contentSearchService"]["searchContent"]>
> {
  return {
    countsAsOf: now,
    items: [],
    page: { hasMore: false, limit: 5, nextCursor: null },
    ranking: {
      asOf: now,
      expiresAt: new Date(now.valueOf() + 300_000),
      indexAsOf: now,
      rankingVersion: "content-search-v1",
      snapshotId: "content-search-snapshot",
    },
    searchExecution: {
      degraded: false,
      degradationReason: null,
      effectiveMode: "hybrid",
      requestedMode: "hybrid",
    },
    semanticIndexCoverage: {
      complete: true,
      unindexedCandidateCount: 0,
    },
  };
}

function discussionProjection(): Awaited<
  ReturnType<PrivateMcpAppOptions["contentReadService"]["getDiscussion"]>
> {
  const detail = contentDetail();
  if (detail.revision === null) throw new Error("Expected current revision");
  return {
    ancestorContext: [],
    countsAsOf: now,
    ordering: {
      asOf: now,
      expiresAt: new Date(now.valueOf() + 300_000),
      orderingVersion: "discussion-flat-v1:latest",
      snapshotId: "discussion-snapshot",
    },
    page: {
      hasMore: false,
      limit: 5,
      nextCursor: null,
      truncatedByByteBudget: false,
    },
    replies: [],
    root: {
      author: detail.content.author,
      contentSafety: detail.contentSafety,
      createdAt: detail.content.createdAt,
      currentRevisionId: detail.content.currentRevisionId,
      depth: detail.content.depth,
      distributionState: detail.content.distributionState,
      effectiveCommunityIds: detail.effectiveCommunityIds,
      id: detail.content.id,
      inboundReferenceCount: detail.inboundReferenceCount,
      kind: detail.content.kind,
      lastActivityAt: detail.content.lastActivityAt,
      lifecycleState: detail.content.lifecycleState,
      parentContentId: detail.content.parentContentId,
      reactionCounts: detail.reactionCounts,
      reactionCountsByActorKind: detail.reactionCountsByActorKind,
      replyCount: detail.replyCount,
      revision: detail.revision,
      rootContentId: detail.content.rootContentId,
      symbols: detail.content.symbols,
      topics: detail.content.topics,
      updatedAt: detail.content.updatedAt,
      version: detail.content.version,
      viewerState: detail.viewerState,
    },
  };
}

function emptyNotificationPage(): Awaited<
  ReturnType<PrivateMcpAppOptions["notificationService"]["listAgentNotifications"]>
> {
  return {
    filters: {
      communityIds: [],
      createdAfter: null,
      createdBefore: null,
      followingOnly: false,
      symbols: [],
      types: [],
      unreadOnly: false,
    },
    items: [],
    mode: "history",
    ordering: {
      asOf: now,
      orderingVersion: "notifications-created-at-v1",
      snapshotId: "nts_history_1",
    },
    page: { hasMore: false, limit: 5, nextCursor: null },
    poll: { hasMore: false, nextCursor: "npc_poll_1" },
  };
}

function pendingAction(): AgentPendingActionView {
  return {
    id: ids.action,
    operation: "create_post",
    expectedVersion: null,
    decision: "require_approval",
    status: "pending_approval",
    state: "pending_approval",
    decisionId: "c0000000-0000-4000-8000-00000000000c",
    policyVersion: `${ids.policy}:7`,
    requestedAt: now,
    expiresAt: new Date(now.valueOf() + 86_400_000),
    decidedAt: null,
    executingAt: null,
    completedAt: null,
    terminalAt: null,
    inputDigest: `sha256:${"a".repeat(64)}`,
    approvalSummary: "Create one post in the Semiconductors community.",
    approvalOutcome: null,
    approvalMethod: null,
    decidedByOwnerId: null,
    result: null,
    error: null,
  };
}

function pendingCreatePostOutcome(): Extract<
  ResearchWriteOutcome,
  { operation: "create_post" }
> {
  const action = pendingAction();
  return {
    decision: "require_approval",
    status: "pending_approval",
    operation: "create_post",
    result: null,
    error: null,
    replayed: false,
    pendingAction: {
      id: action.id,
      operation: "create_post",
      state: "pending_approval",
      expiresAt: action.expiresAt,
      inputDigest: action.inputDigest,
      requestedAt: action.requestedAt,
      decisionId: action.decisionId,
      policyVersion: action.policyVersion,
      approvalSummary: action.approvalSummary,
    },
  };
}

type CreatePostOutcome = Extract<ResearchWriteOutcome, { operation: "create_post" }>;

function successfulCreatePostOutcome(replayed = false): CreatePostOutcome {
  return {
    decision: "allow",
    error: null,
    operation: "create_post",
    pendingAction: null,
    replayed,
    result: {
      contentId: ids.content,
      resourceVersion: 1,
      revisionId: ids.revision,
    },
    status: "succeeded",
  };
}

function successfulReplyOutcome(): Extract<
  ResearchWriteOutcome,
  { operation: "reply_to_content" }
> {
  return {
    decision: "allow",
    error: null,
    operation: "reply_to_content",
    pendingAction: null,
    replayed: false,
    result: {
      contentId: ids.reply,
      resourceVersion: 1,
      revisionId: ids.replyRevision,
      rootContentId: ids.content,
    },
    status: "succeeded",
  };
}

function deniedCreatePostOutcome(): CreatePostOutcome {
  return {
    decision: "deny",
    error: {
      code: "POLICY_DENIED",
      details: { reason: "POLICY_READ_ONLY" },
      message: "The Agent policy does not permit this operation.",
      retryable: false,
      retryAfterMs: null,
    },
    operation: "create_post",
    pendingAction: null,
    replayed: false,
    result: null,
    status: "denied",
  };
}

function failedCreatePostOutcome(): CreatePostOutcome {
  return {
    decision: "allow",
    error: {
      code: "IDEMPOTENCY_CONFLICT",
      details: null,
      message: "The idempotency key is already bound to another request.",
      retryable: false,
      retryAfterMs: null,
    },
    operation: "create_post",
    pendingAction: null,
    replayed: false,
    result: null,
    status: "failed",
  };
}

function rateLimitedCreatePostOutcome(): CreatePostOutcome {
  return {
    decision: "deny",
    error: {
      code: "RATE_LIMITED",
      details: { community_id: ids.community },
      message: "The Community posting limit has been reached.",
      retryable: true,
      retryAfterMs: 75_000,
    },
    operation: "create_post",
    pendingAction: null,
    replayed: false,
    result: null,
    status: "denied",
  };
}

const apps: Awaited<ReturnType<typeof createPrivateMcpApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  vi.restoreAllMocks();
});

async function actorAssertion(
  boundRequestId = requestId,
  scopes: readonly (typeof context.credential.scopes)[number][] = context.credential
    .scopes,
): Promise<string> {
  return createMcpActorContextAssertion(
    {
      credentialId: ids.credential,
      grantId: ids.grant,
      requestId: boundRequestId,
      scopes: [...scopes],
      tokenJtiDigest,
    },
    keyRing,
    { now, ttlSeconds: 20 },
  );
}

interface AppHarness {
  app: Awaited<ReturnType<typeof createPrivateMcpApp>>;
  authenticateActorContext: ReturnType<typeof vi.fn>;
  consumeLimit: ReturnType<typeof vi.fn>;
  consumeReplay: ReturnType<typeof vi.fn>;
  transportIdentityGuard: ReturnType<typeof vi.fn>;
}

async function createApp(options?: {
  authorityContext?: AgentCredentialContext;
  authorityFailure?: Error;
  communityDirectoryService?: Partial<PrivateMcpAppOptions["communityDirectoryService"]>;
  consumeLimit?: PrivateMcpAppOptions["rateLimiter"]["consume"];
  contentReadService?: Partial<PrivateMcpAppOptions["contentReadService"]>;
  contentSearchService?: Partial<PrivateMcpAppOptions["contentSearchService"]>;
  notificationService?: Partial<PrivateMcpAppOptions["notificationService"]>;
  order?: string[];
  pendingActionStatusService?: PrivateMcpAppOptions["pendingActionStatusService"];
  researchWriteService?: Partial<PrivateMcpAppOptions["researchWriteService"]>;
  transportIdentityGuard?: PrivateMcpAppOptions["transportIdentityGuard"];
}): Promise<AppHarness> {
  const order = options?.order;
  const consumeReplay = vi.fn<McpActorAssertionReplayStore["consume"]>(() => {
    order?.push("replay");
    return Promise.resolve(true);
  });
  const authenticateActorContext = vi.fn<
    RemoteMcpAuthorityService["authenticateActorContext"]
  >(() => {
    order?.push("authority");
    return options?.authorityFailure
      ? Promise.reject(options.authorityFailure)
      : Promise.resolve(options?.authorityContext ?? context);
  });
  const consumeLimit = vi.fn(
    options?.consumeLimit ??
      ((key: string) => {
        order?.push(`limit:${key.split(":", 1)[0]}`);
        return Promise.resolve({ allowed: true, retryAfter: null });
      }),
  );
  const transportIdentityGuard = vi.fn(
    options?.transportIdentityGuard ??
      (() => {
        order?.push("transport");
        return Promise.resolve({
          authentication: "mutual_tls" as const,
          service: "mcp" as const,
        });
      }),
  );
  const app = await createPrivateMcpApp({
    actorAuthenticator: {
      authority: { authenticateActorContext },
      keyRing,
      now: () => now,
      replayStore: { consume: consumeReplay },
    },
    communityDirectoryService: {
      getCommunity: () => Promise.reject(new Error("Unexpected Community request")),
      searchCommunities: () =>
        Promise.reject(new Error("Unexpected Community search request")),
      ...options?.communityDirectoryService,
    },
    contentReadService: {
      browseContent: () => Promise.reject(new Error("Unexpected Content browse")),
      getContent: () => Promise.reject(new Error("Unexpected Content request")),
      getDiscussion: () => Promise.reject(new Error("Unexpected Content discussion")),
      ...options?.contentReadService,
    },
    contentSearchService: {
      searchContent: () => Promise.reject(new Error("Unexpected Content search")),
      ...options?.contentSearchService,
    },
    notificationService: {
      listAgentNotifications: () =>
        Promise.reject(new Error("Unexpected Notification request")),
      ...options?.notificationService,
    },
    now: () => now,
    pendingActionStatusService: options?.pendingActionStatusService ?? {
      getActionStatus: () =>
        Promise.reject(new Error("Unexpected PendingAction request")),
    },
    rateLimiter: { consume: consumeLimit },
    researchWriteService: {
      createPost: () => Promise.reject(new Error("Unexpected research write")),
      replyToContent: () => Promise.reject(new Error("Unexpected reply write")),
      ...options?.researchWriteService,
    },
    transportIdentityGuard,
  });
  apps.push(app);
  return {
    app,
    authenticateActorContext,
    consumeLimit,
    consumeReplay,
    transportIdentityGuard,
  };
}

async function validHeaders(
  boundRequestId = requestId,
  scopes: readonly (typeof context.credential.scopes)[number][] = context.credential
    .scopes,
) {
  return {
    "x-alphanet-mcp-actor-context": await actorAssertion(boundRequestId, scopes),
    "x-request-id": boundRequestId,
  };
}

describe("private MCP API application boundary", () => {
  it("authenticates transport then ActorContext and projects the shared Agent context", async () => {
    const order: string[] = [];
    const harness = await createApp({ order });
    const response = await harness.app.inject({
      headers: await validHeaders(),
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });
    const body = AgentContextResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(body).toMatchObject({
      request_id: requestId,
      schema_version: "1",
      agent: {
        id: ids.agent,
        actor_id: ids.actor,
        handle: "market-scout",
        display_name: "Market Scout",
      },
      owner: { id: ids.owner },
      credential: {
        id: ids.credential,
        name: "Remote MCP grant",
        scopes: ["research:read", "community:read"],
        audience: "https://mcp.alphanet.test/mcp",
        expires_at: "2026-07-22T08:10:00.000Z",
      },
      permission_tier: "assisted",
      policy_version: `${ids.policy}:7`,
      server_time: now.toISOString(),
      effective_capabilities: {
        get_agent_context: { available: true, default_decision: "allow" },
        find_communities: { available: true, default_decision: "allow" },
        create_post: {
          available: true,
          default_decision: "deny",
        },
      },
    });
    expect(order).toEqual([
      "transport",
      "replay",
      "authority",
      "limit:agent",
      "limit:owner",
    ]);
    expect(harness.consumeLimit.mock.calls).toEqual([
      [`agent:${ids.agent}:agent-api`, { max: 120, window: 60 }],
      [`owner:${ids.owner}:agent-api`, { max: 120, window: 60 }],
    ]);
  });

  it("serves the first private MCP research and write workflow through shared domain adapters", async () => {
    const scopes = [
      "research:read",
      "community:read",
      "actions:read",
      "content:write",
    ] as const;
    const authorityContext = contextWithScopes([...scopes]);
    const getCommunity = vi.fn(() => Promise.resolve(communityDetail()));
    const getContent = vi.fn(() => Promise.resolve(contentDetail()));
    const getActionStatus = vi.fn(() => Promise.resolve(pendingAction()));
    const createPost = vi.fn(() => Promise.resolve(pendingCreatePostOutcome()));
    const harness = await createApp({
      authorityContext,
      communityDirectoryService: { getCommunity },
      contentReadService: { getContent },
      pendingActionStatusService: { getActionStatus },
      researchWriteService: { createPost },
    });

    const communityRequestId = "req_private_mcp_community";
    const communityResponse = await harness.app.inject({
      headers: await validHeaders(communityRequestId, scopes),
      method: "GET",
      url: PRIVATE_MCP_COMMUNITY_BY_SLUG_PATH.replace(":slug", "semiconductors"),
    });
    const community = GetCommunityResponseSchema.parse(communityResponse.json());

    const communityIdRequestId = "req_private_mcp_community_id";
    const communityIdResponse = await harness.app.inject({
      headers: await validHeaders(communityIdRequestId, scopes),
      method: "GET",
      url: PRIVATE_MCP_COMMUNITY_PATH.replace(":communityId", ids.community),
    });
    GetCommunityResponseSchema.parse(communityIdResponse.json());

    const contentRequestId = "req_private_mcp_content";
    const contentResponse = await harness.app.inject({
      headers: await validHeaders(contentRequestId, scopes),
      method: "GET",
      url:
        PRIVATE_MCP_CONTENT_PATH.replace(":contentId", ids.content) +
        `?revision_id=${ids.revision}` +
        "&include_revision_history=true&revision_limit=1" +
        "&revision_cursor=signed-revision-cursor",
    });
    const content = GetContentResponseSchema.parse(contentResponse.json());

    const actionRequestId = "req_private_mcp_action";
    const actionResponse = await harness.app.inject({
      headers: await validHeaders(actionRequestId, scopes),
      method: "GET",
      url: PRIVATE_MCP_ACTION_PATH.replace(":actionId", ids.action),
    });
    const action = GetActionStatusResponseSchema.parse(actionResponse.json());

    const createRequestId = "req_private_mcp_create_post";
    const createResponse = await harness.app.inject({
      headers: await validHeaders(createRequestId, scopes),
      method: "POST",
      payload: {
        title: "HBM supply update",
        body_markdown: "Channel checks suggest a tighter near-term supply range.",
        primary_community_id: ids.community,
        symbols: ["AMD"],
        topics: ["data-center"],
        idempotency_key: "research-run-2026-07-22-001",
      },
      url: PRIVATE_MCP_POSTS_PATH,
    });
    const create = CreatePostWriteResultSchema.parse(createResponse.json());

    expect(communityResponse.statusCode).toBe(200);
    expect(communityIdResponse.statusCode).toBe(200);
    expect(community.community.slug).toBe("semiconductors");
    expect(getCommunity).toHaveBeenNthCalledWith(1, authorityContext, {
      slug: "semiconductors",
    });
    expect(getCommunity).toHaveBeenNthCalledWith(2, authorityContext, {
      communityId: ids.community,
    });
    expect(contentResponse.statusCode).toBe(200);
    expect(content.content.id).toBe(ids.content);
    expect(getContent).toHaveBeenCalledWith(authorityContext, {
      contentId: ids.content,
      includeRevisionHistory: true,
      revisionCursor: "signed-revision-cursor",
      revisionId: ids.revision,
      revisionLimit: 1,
    });
    expect(actionResponse.statusCode).toBe(200);
    expect(action.action.id).toBe(ids.action);
    expect(getActionStatus).toHaveBeenCalledWith(
      { agentId: ids.agent, ownerId: ids.owner },
      ids.action,
    );
    expect(createResponse.statusCode).toBe(202);
    expect(createResponse.headers.location).toBe(
      `/internal/mcp/v1/actions/${ids.action}`,
    );
    expect(create).toMatchObject({
      decision: "require_approval",
      status: "pending_approval",
      pending_action: { id: ids.action },
    });
    expect(createPost).toHaveBeenCalledWith(
      authorityContext,
      expect.objectContaining({
        idempotencyKey: "research-run-2026-07-22-001",
        primaryCommunityId: ids.community,
        title: "HBM supply update",
      }),
      { channel: "mcp", requestId: createRequestId },
    );
    expect(harness.consumeLimit).toHaveBeenCalledWith(
      `credential:${ids.credential}:agent-api:write`,
      { max: 20, window: 60 },
    );
  });

  it("serves the MCP social loop through contract-shaped private POST routes", async () => {
    const scopes = [
      "research:read",
      "community:read",
      "notifications:read",
      "content:write",
    ] as const;
    const authorityContext = contextWithScopes([...scopes]);
    const searchCommunities = vi.fn<
      PrivateMcpAppOptions["communityDirectoryService"]["searchCommunities"]
    >(() => Promise.resolve(emptyCommunitySearchPage()));
    const browseContent = vi.fn<
      PrivateMcpAppOptions["contentReadService"]["browseContent"]
    >(() => Promise.resolve(emptyBrowsePage()));
    const getDiscussion = vi.fn<
      PrivateMcpAppOptions["contentReadService"]["getDiscussion"]
    >(() => Promise.resolve(discussionProjection()));
    const searchContent = vi.fn<
      PrivateMcpAppOptions["contentSearchService"]["searchContent"]
    >(() => Promise.resolve(emptySearchPage()));
    const listAgentNotifications = vi.fn<
      PrivateMcpAppOptions["notificationService"]["listAgentNotifications"]
    >(() => Promise.resolve(emptyNotificationPage()));
    const replyToContent = vi.fn<
      PrivateMcpAppOptions["researchWriteService"]["replyToContent"]
    >(() => Promise.resolve(successfulReplyOutcome()));
    const harness = await createApp({
      authorityContext,
      communityDirectoryService: {
        getCommunity: () => Promise.reject(new Error("Unexpected Community read")),
        searchCommunities,
      },
      contentReadService: {
        browseContent,
        getContent: () => Promise.reject(new Error("Unexpected Content read")),
        getDiscussion,
      },
      contentSearchService: { searchContent },
      notificationService: { listAgentNotifications },
      researchWriteService: {
        createPost: () => Promise.reject(new Error("Unexpected post write")),
        replyToContent,
      },
    });

    const findRequestId = "req_private_mcp_find_communities";
    const findResponse = await harness.app.inject({
      headers: await validHeaders(findRequestId, scopes),
      method: "POST",
      payload: { limit: 5, query: "semiconductors" },
      url: PRIVATE_MCP_COMMUNITY_SEARCH_PATH,
    });
    const find = FindCommunitiesResponseSchema.parse(findResponse.json());

    const browseRequestId = "req_private_mcp_browse_content";
    const browseResponse = await harness.app.inject({
      headers: await validHeaders(browseRequestId, scopes),
      method: "POST",
      payload: {
        author_actor_id: ids.actor,
        limit: 5,
        scope: "author",
        sort: "latest",
      },
      url: PRIVATE_MCP_CONTENT_BROWSE_PATH,
    });
    const browse = BrowseContentResponseSchema.parse(browseResponse.json());

    const searchRequestId = "req_private_mcp_search_content";
    const searchResponse = await harness.app.inject({
      headers: await validHeaders(searchRequestId, scopes),
      method: "POST",
      payload: {
        author_actor_id: ids.actor,
        limit: 5,
        query: "AMD downside evidence",
        scope: "author",
      },
      url: PRIVATE_MCP_CONTENT_SEARCH_PATH,
    });
    const search = SearchContentResponseSchema.parse(searchResponse.json());

    const discussionRequestId = "req_private_mcp_get_discussion";
    const discussionResponse = await harness.app.inject({
      headers: await validHeaders(discussionRequestId, scopes),
      method: "POST",
      payload: {
        content_id: ids.content,
        limit: 5,
        sort: "latest",
      },
      url: PRIVATE_MCP_DISCUSSION_PATH,
    });
    const discussion = GetDiscussionResponseSchema.parse(discussionResponse.json());

    const notificationRequestId = "req_private_mcp_list_notifications";
    const notificationResponse = await harness.app.inject({
      headers: await validHeaders(notificationRequestId, scopes),
      method: "POST",
      payload: { limit: 5 },
      url: PRIVATE_MCP_NOTIFICATIONS_PATH,
    });
    const notifications = ListNotificationsResponseSchema.parse(
      notificationResponse.json(),
    );

    const replyRequestId = "req_private_mcp_reply_to_content";
    const replyResponse = await harness.app.inject({
      headers: await validHeaders(replyRequestId, scopes),
      method: "POST",
      payload: {
        body_markdown: "Which primary source would falsify this claim?",
        idempotency_key: "reply-falsification-source-20260722-v1",
        parent_content_id: ids.content,
        symbols: ["AMD"],
      },
      url: PRIVATE_MCP_REPLIES_PATH,
    });
    const reply = ReplyToContentWriteResultSchema.parse(replyResponse.json());

    expect(findResponse.statusCode).toBe(200);
    expect(find).toMatchObject({ request_id: findRequestId, items: [] });
    expect(searchCommunities).toHaveBeenCalledWith(
      authorityContext,
      expect.objectContaining({ limit: 5, query: "semiconductors" }),
    );
    expect(browseResponse.statusCode).toBe(200);
    expect(browse).toMatchObject({ request_id: browseRequestId, items: [] });
    expect(browseContent).toHaveBeenCalledWith(authorityContext, {
      authorActorId: ids.actor,
      limit: 5,
      scope: "author",
      sort: "latest",
    });
    expect(searchResponse.statusCode).toBe(200);
    expect(search).toMatchObject({ request_id: searchRequestId, items: [] });
    expect(searchContent).toHaveBeenCalledWith(
      authorityContext,
      expect.objectContaining({
        authorActorId: ids.actor,
        limit: 5,
        query: "AMD downside evidence",
        scope: "author",
      }),
      { channel: "mcp", requestId: searchRequestId },
    );
    expect(discussionResponse.statusCode).toBe(200);
    expect(discussion).toMatchObject({
      request_id: discussionRequestId,
      root: { id: ids.content },
    });
    expect(getDiscussion).toHaveBeenCalledWith(authorityContext, {
      contentId: ids.content,
      limit: 5,
      sort: "latest",
    });
    expect(notificationResponse.statusCode).toBe(200);
    expect(notifications).toMatchObject({
      mode: "history",
      request_id: notificationRequestId,
    });
    expect(listAgentNotifications).toHaveBeenCalledWith(authorityContext, {
      limit: 5,
    });
    expect(replyResponse.statusCode).toBe(201);
    expect(reply).toMatchObject({
      request_id: replyRequestId,
      result: { content_id: ids.reply, root_content_id: ids.content },
      status: "succeeded",
    });
    expect(replyToContent).toHaveBeenCalledWith(
      authorityContext,
      expect.objectContaining({
        bodyMarkdown: "Which primary source would falsify this claim?",
        idempotencyKey: "reply-falsification-source-20260722-v1",
        parentContentId: ids.content,
      }),
      { channel: "mcp", requestId: replyRequestId },
    );
  });

  it("allows author filters without accepting a caller-supplied Actor identity", async () => {
    const scopes = ["research:read"] as const;
    const harness = await createApp({
      authorityContext: contextWithScopes([...scopes]),
    });
    const response = await harness.app.inject({
      headers: await validHeaders("req_private_mcp_forged_actor", scopes),
      method: "POST",
      payload: {
        actor_id: ids.actor,
        author_actor_id: ids.actor,
        scope: "author",
        sort: "latest",
      },
      url: PRIVATE_MCP_CONTENT_BROWSE_PATH,
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(ids.actor);
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
  });

  it.each([
    {
      errorCode: null,
      label: "immediate success",
      outcome: successfulCreatePostOutcome(),
      replayed: false,
      statusCode: 201,
    },
    {
      errorCode: null,
      label: "pending approval",
      outcome: pendingCreatePostOutcome(),
      replayed: false,
      statusCode: 202,
    },
    {
      errorCode: "POLICY_DENIED",
      label: "policy denial",
      outcome: deniedCreatePostOutcome(),
      replayed: false,
      statusCode: 403,
    },
    {
      errorCode: "IDEMPOTENCY_CONFLICT",
      label: "terminal failure",
      outcome: failedCreatePostOutcome(),
      replayed: false,
      statusCode: 409,
    },
    {
      errorCode: "RATE_LIMITED",
      label: "authoritative rate limit",
      outcome: rateLimitedCreatePostOutcome(),
      replayed: false,
      statusCode: 429,
    },
    {
      errorCode: null,
      label: "idempotent replay",
      outcome: successfulCreatePostOutcome(true),
      replayed: true,
      statusCode: 201,
    },
  ] as const)(
    "keeps REST and private MCP create-post projections equivalent for $label",
    async ({ errorCode, outcome, replayed, statusCode }) => {
      const scopes = ["content:write"] as const;
      const authorityContext = contextWithScopes([...scopes]);
      const restCreatePost = vi.fn<ResearchWriteService["createPost"]>(() =>
        Promise.resolve(outcome),
      );
      const privateCreatePost = vi.fn<ResearchWriteService["createPost"]>(() =>
        Promise.resolve(outcome),
      );
      const restApp = Fastify({ logger: false });
      registerResearchWriteRoutes(restApp, {
        agentConnectionService: {
          authenticateStaticApiKey: () => Promise.resolve(authorityContext),
        },
        service: {
          checkReady: () => Promise.resolve(),
          createPost: restCreatePost,
          deleteContent: () => Promise.reject(new Error("Unexpected delete")),
          replyToContent: () => Promise.reject(new Error("Unexpected reply")),
          updateContent: () => Promise.reject(new Error("Unexpected update")),
        },
      });
      const harness = await createApp({
        authorityContext,
        researchWriteService: { createPost: privateCreatePost },
      });
      const body = {
        body_markdown: "Channel checks suggest a tighter near-term supply range.",
        primary_community_id: ids.community,
        symbols: ["AMD"],
        title: "HBM supply update",
        topics: ["data-center"],
      };
      const idempotencyKey = `adapter-equivalence-${statusCode}-${replayed}`;
      const privateRequestId = `req_private_equivalence_${statusCode}_${replayed}`;

      try {
        const restResponse = await restApp.inject({
          headers: {
            authorization: `Bearer ${apiKey}`,
            "idempotency-key": idempotencyKey,
          },
          method: "POST",
          payload: body,
          url: "/v1/posts",
        });
        const privateResponse = await harness.app.inject({
          headers: await validHeaders(privateRequestId, scopes),
          method: "POST",
          payload: { ...body, idempotency_key: idempotencyKey },
          url: PRIVATE_MCP_POSTS_PATH,
        });
        const restProjection = CreatePostWriteResultSchema.parse(restResponse.json());
        const privateProjection = CreatePostWriteResultSchema.parse(
          privateResponse.json(),
        );
        const { request_id: restProjectionRequestId, ...restComparable } = restProjection;
        const { request_id: privateProjectionRequestId, ...privateComparable } =
          privateProjection;

        expect(restResponse.statusCode).toBe(statusCode);
        expect(privateResponse.statusCode).toBe(statusCode);
        expect(restProjectionRequestId).toBeTypeOf("string");
        expect(privateProjectionRequestId).toBe(privateRequestId);
        expect(privateComparable).toEqual(restComparable);
        expect(outcome.replayed).toBe(replayed);
        expect(privateProjection.error?.code ?? null).toBe(errorCode);
        expect(privateCreatePost.mock.calls[0]?.[1]).toEqual(
          restCreatePost.mock.calls[0]?.[1],
        );
        expect(restCreatePost.mock.calls[0]?.[2]).toMatchObject({ channel: "rest" });
        expect(privateCreatePost.mock.calls[0]?.[2]).toEqual({
          channel: "mcp",
          requestId: privateRequestId,
        });

        if (statusCode === 202) {
          expect(restResponse.headers.location).toBe(`/v1/actions/${ids.action}`);
          expect(privateResponse.headers.location).toBe(
            `/internal/mcp/v1/actions/${ids.action}`,
          );
          expect(restResponse.headers["retry-after"]).toBe("5");
          expect(privateResponse.headers["retry-after"]).toBe("5");
        }
        if (statusCode === 429) {
          expect(restResponse.headers["retry-after"]).toBe("75");
          expect(privateResponse.headers["retry-after"]).toBe("75");
        }
      } finally {
        await restApp.close();
      }
    },
  );

  it.each([
    {
      label: "find communities",
      method: "POST",
      missingScopes: ["actions:read"],
      payload: { query: "semiconductors" },
      requiredScope: "community:read",
      url: PRIVATE_MCP_COMMUNITY_SEARCH_PATH,
    },
    {
      label: "get community",
      method: "GET",
      missingScopes: ["actions:read"],
      requiredScope: "community:read",
      url: PRIVATE_MCP_COMMUNITY_PATH.replace(":communityId", ids.community),
    },
    {
      label: "get content",
      method: "GET",
      missingScopes: ["actions:read"],
      requiredScope: "research:read",
      url: PRIVATE_MCP_CONTENT_PATH.replace(":contentId", ids.content),
    },
    {
      label: "browse content",
      method: "POST",
      missingScopes: ["actions:read"],
      payload: { scope: "global", sort: "latest" },
      requiredScope: "research:read",
      url: PRIVATE_MCP_CONTENT_BROWSE_PATH,
    },
    {
      label: "search content",
      method: "POST",
      missingScopes: ["actions:read"],
      payload: { query: "AMD", scope: "global" },
      requiredScope: "research:read",
      url: PRIVATE_MCP_CONTENT_SEARCH_PATH,
    },
    {
      label: "get discussion",
      method: "POST",
      missingScopes: ["actions:read"],
      payload: { content_id: ids.content },
      requiredScope: "research:read",
      url: PRIVATE_MCP_DISCUSSION_PATH,
    },
    {
      label: "list notifications",
      method: "POST",
      missingScopes: ["research:read"],
      payload: {},
      requiredScope: "notifications:read",
      url: PRIVATE_MCP_NOTIFICATIONS_PATH,
    },
    {
      label: "get action status",
      method: "GET",
      missingScopes: ["research:read"],
      requiredScope: "actions:read",
      url: PRIVATE_MCP_ACTION_PATH.replace(":actionId", ids.action),
    },
    {
      label: "create post",
      method: "POST",
      missingScopes: ["research:read"],
      payload: {
        body_markdown: "Research body.",
        idempotency_key: "missing-content-write-scope",
        primary_community_id: ids.community,
        title: "HBM supply update",
      },
      requiredScope: "content:write",
      url: PRIVATE_MCP_POSTS_PATH,
    },
    {
      label: "reply to content",
      method: "POST",
      missingScopes: ["research:read"],
      payload: {
        body_markdown: "Can you provide the primary source?",
        idempotency_key: "missing-content-write-scope-reply",
        parent_content_id: ids.content,
      },
      requiredScope: "content:write",
      url: PRIVATE_MCP_REPLIES_PATH,
    },
  ] as const)(
    "enforces $label scope before invoking a private domain adapter",
    async ({ method, missingScopes, payload, requiredScope, url }) => {
      const getCommunity = vi.fn(() => Promise.resolve(communityDetail()));
      const searchCommunities = vi.fn(() => Promise.resolve(emptyCommunitySearchPage()));
      const getContent = vi.fn(() => Promise.resolve(contentDetail()));
      const browseContent = vi.fn(() => Promise.resolve(emptyBrowsePage()));
      const getDiscussion = vi.fn(() => Promise.resolve(discussionProjection()));
      const searchContent = vi.fn(() => Promise.resolve(emptySearchPage()));
      const listAgentNotifications = vi.fn(() =>
        Promise.resolve(emptyNotificationPage()),
      );
      const getActionStatus = vi.fn(() => Promise.resolve(pendingAction()));
      const createPost = vi.fn(() => Promise.resolve(pendingCreatePostOutcome()));
      const replyToContent = vi.fn(() => Promise.resolve(successfulReplyOutcome()));
      const harness = await createApp({
        authorityContext: contextWithScopes([...missingScopes]),
        communityDirectoryService: { getCommunity, searchCommunities },
        contentReadService: { browseContent, getContent, getDiscussion },
        contentSearchService: { searchContent },
        notificationService: { listAgentNotifications },
        pendingActionStatusService: { getActionStatus },
        researchWriteService: { createPost, replyToContent },
      });
      const scopedRequestId = `req_private_mcp_missing_${requiredScope.replace(":", "_")}`;
      const response = await harness.app.inject({
        headers: await validHeaders(scopedRequestId, missingScopes),
        method,
        ...(payload === undefined ? {} : { payload }),
        url,
      });

      expect(response.statusCode).toBe(403);
      expect(response.headers["www-authenticate"]).toContain(requiredScope);
      expect(response.json()).toMatchObject({ error: { code: "SCOPE_REQUIRED" } });
      expect(getCommunity).not.toHaveBeenCalled();
      expect(searchCommunities).not.toHaveBeenCalled();
      expect(getContent).not.toHaveBeenCalled();
      expect(browseContent).not.toHaveBeenCalled();
      expect(getDiscussion).not.toHaveBeenCalled();
      expect(searchContent).not.toHaveBeenCalled();
      expect(listAgentNotifications).not.toHaveBeenCalled();
      expect(getActionStatus).not.toHaveBeenCalled();
      expect(createPost).not.toHaveBeenCalled();
      expect(replyToContent).not.toHaveBeenCalled();
    },
  );

  it("rejects identity-shaped create-post body fields before ActorContext replay", async () => {
    const createPost = vi.fn(() => Promise.resolve(pendingCreatePostOutcome()));
    const scopes = ["content:write"] as const;
    const harness = await createApp({
      authorityContext: contextWithScopes([...scopes]),
      researchWriteService: { createPost },
    });
    const createRequestId = "req_private_mcp_identity_body";
    const response = await harness.app.inject({
      headers: await validHeaders(createRequestId, scopes),
      method: "POST",
      payload: {
        title: "HBM supply update",
        body_markdown: "Research body.",
        primary_community_id: ids.community,
        idempotency_key: "research-run-identity-test",
        owner_id: ids.owner,
      },
      url: PRIVATE_MCP_POSTS_PATH,
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(ids.owner);
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(createPost).not.toHaveBeenCalled();
  });

  it("accepts a valid create-post body above the private app default limit", async () => {
    const createPost = vi.fn(() => Promise.resolve(pendingCreatePostOutcome()));
    const scopes = ["content:write"] as const;
    const harness = await createApp({
      authorityContext: contextWithScopes([...scopes]),
      researchWriteService: { createPost },
    });
    const largeRequestId = "req_private_mcp_large_valid_post";
    const response = await harness.app.inject({
      headers: await validHeaders(largeRequestId, scopes),
      method: "POST",
      payload: {
        title: "Large but valid research post",
        body_markdown: "x".repeat(70_000),
        primary_community_id: ids.community,
        idempotency_key: "large-valid-research-post",
      },
      url: PRIVATE_MCP_POSTS_PATH,
    });

    expect(response.statusCode).toBe(202);
    expect(CreatePostWriteResultSchema.safeParse(response.json()).success).toBe(true);
    expect(createPost).toHaveBeenCalledOnce();
  });

  it("rejects write-contract byte overflow before invoking the domain service", async () => {
    const createPost = vi.fn(() => Promise.resolve(pendingCreatePostOutcome()));
    const scopes = ["content:write"] as const;
    const harness = await createApp({
      authorityContext: contextWithScopes([...scopes]),
      researchWriteService: { createPost },
    });
    const overflowRequestId = "req_private_mcp_contract_overflow";
    const response = await harness.app.inject({
      headers: await validHeaders(overflowRequestId, scopes),
      method: "POST",
      payload: {
        title: "UTF-8 byte budget overflow",
        body_markdown: "😀".repeat(41_000),
        primary_community_id: ids.community,
        idempotency_key: "utf8-overflow-research-post",
      },
      url: PRIVATE_MCP_POSTS_PATH,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", retryable: false },
      request_id: overflowRequestId,
      schema_version: "1",
    });
    expect(createPost).not.toHaveBeenCalled();
  });

  it("preserves bounded V1 parser errors for oversized and malformed write bodies", async () => {
    const createPost = vi.fn(() => Promise.resolve(pendingCreatePostOutcome()));
    const harness = await createApp({ researchWriteService: { createPost } });
    const oversizedRequestId = "req_private_mcp_payload_too_large";
    const oversized = await harness.app.inject({
      headers: {
        ...(await validHeaders(oversizedRequestId)),
        "content-type": "application/json",
      },
      method: "POST",
      payload: JSON.stringify({ body_markdown: "x".repeat(1_100_000) }),
      url: PRIVATE_MCP_POSTS_PATH,
    });
    const malformedRequestId = "req_private_mcp_malformed_json";
    const malformed = await harness.app.inject({
      headers: {
        ...(await validHeaders(malformedRequestId)),
        "content-type": "application/json",
      },
      method: "POST",
      payload: "{",
      url: PRIVATE_MCP_POSTS_PATH,
    });

    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE", retryable: false },
      request_id: oversizedRequestId,
      schema_version: "1",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error: { code: "MALFORMED_REQUEST", retryable: false },
      request_id: malformedRequestId,
      schema_version: "1",
    });
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(createPost).not.toHaveBeenCalled();
  });

  it("has no Bearer or Cookie fallback, even beside a valid assertion", async () => {
    const harness = await createApp();
    const assertion = await actorAssertion();
    const attempts = [
      { authorization: "Bearer external-token", "x-request-id": requestId },
      {
        authorization: "Bearer external-token",
        "x-alphanet-mcp-actor-context": assertion,
        "x-request-id": requestId,
      },
      {
        cookie: "owner_session=must-not-cross-this-boundary",
        "x-alphanet-mcp-actor-context": assertion,
        "x-request-id": requestId,
      },
    ];

    for (const headers of attempts) {
      const response = await harness.app.inject({
        headers,
        method: "GET",
        url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: "REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED" },
      });
      expect(response.headers["www-authenticate"]).toBeUndefined();
    }
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
    expect(harness.consumeLimit).not.toHaveBeenCalled();
  });

  it("rejects duplicate request or assertion headers using raw header cardinality", async () => {
    const harness = await createApp();
    const assertion = await actorAssertion();
    const duplicateRequestId = await harness.app.inject({
      headers: {
        "x-alphanet-mcp-actor-context": assertion,
        "x-request-id": [requestId, requestId],
      },
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });
    const duplicateAssertion = await harness.app.inject({
      headers: {
        "x-alphanet-mcp-actor-context": [assertion, assertion],
        "x-request-id": requestId,
      },
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(duplicateRequestId.statusCode).toBe(401);
    expect(duplicateAssertion.statusCode).toBe(401);
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("runs transport authentication before looking at an assertion", async () => {
    const order: string[] = [];
    const harness = await createApp({
      order,
      transportIdentityGuard: () => {
        order.push("transport-denied");
        return null;
      },
    });
    const response = await harness.app.inject({
      headers: {
        authorization: "Bearer ignored",
        "x-alphanet-mcp-actor-context": "not-a-jwt",
        "x-request-id": requestId,
      },
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "REMOTE_MCP_TRANSPORT_AUTHENTICATION_FAILED" },
    });
    expect(order).toEqual(["transport-denied"]);
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("maps transport guard failure to 503 without trying assertion authentication", async () => {
    const harness = await createApp({
      transportIdentityGuard: () =>
        Promise.reject(new Error("certificate verifier unavailable")),
    });
    const response = await harness.app.inject({
      headers: await validHeaders(),
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: "REMOTE_MCP_TRANSPORT_AUTHENTICATION_UNAVAILABLE",
        retryable: true,
      },
    });
    expect(response.body).not.toContain("certificate verifier unavailable");
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("rejects identity in query or body before authenticating ActorContext", async () => {
    const harness = await createApp();
    const headers = await validHeaders();
    const queryResponse = await harness.app.inject({
      headers,
      method: "GET",
      url: `${PRIVATE_MCP_AGENT_CONTEXT_PATH}?accessToken=do-not-use`,
    });
    const bodyResponse = await harness.app.inject({
      headers: {
        ...headers,
        "content-length": "70",
        "content-type": "application/json",
      },
      method: "GET",
      payload: { nested: { owner_id: ids.owner } },
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(queryResponse.statusCode).toBe(401);
    expect(bodyResponse.statusCode).toBe(401);
    expect(queryResponse.body).not.toContain("do-not-use");
    expect(bodyResponse.body).not.toContain(ids.owner);
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("binds the signed assertion to the one accepted request ID", async () => {
    const harness = await createApp();
    const response = await harness.app.inject({
      headers: {
        "x-alphanet-mcp-actor-context": await actorAssertion("req_other_request"),
        "x-request-id": requestId,
      },
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(response.statusCode).toBe(401);
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("never reflects a secret-shaped request ID", async () => {
    const harness = await createApp();
    const secretRequestId =
      "aln_v1_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
    const response = await harness.app.inject({
      headers: {
        "x-alphanet-mcp-actor-context": await actorAssertion(secretRequestId),
        "x-request-id": secretRequestId,
      },
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(secretRequestId);
    expect(response.headers["x-request-id"]).not.toBe(secretRequestId);
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("maps current-authority and limiter dependencies without leaking details", async () => {
    const authorityUnavailable = await createApp({
      authorityFailure: new Error("database included private authority data"),
    });
    const authorityResponse = await authorityUnavailable.app.inject({
      headers: await validHeaders(),
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    const limiterUnavailable = await createApp({
      consumeLimit: () => Promise.reject(new Error("redis details")),
    });
    const limiterResponse = await limiterUnavailable.app.inject({
      headers: await validHeaders(),
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(authorityResponse.statusCode).toBe(503);
    expect(authorityResponse.body).not.toContain("database included");
    expect(limiterResponse.statusCode).toBe(503);
    expect(limiterResponse.body).not.toContain("redis details");
  });

  it("fails closed when the limiter returns a malformed truthy result", async () => {
    const harness = await createApp({
      consumeLimit: () => Promise.resolve({ allowed: "yes", retryAfter: null } as never),
    });
    const response = await harness.app.inject({
      headers: await validHeaders(),
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "TEMPORARILY_UNAVAILABLE", retryable: true },
    });
    expect(harness.consumeLimit).toHaveBeenCalledOnce();
  });

  it("returns the shared 429 envelope when the Agent budget is exhausted", async () => {
    const harness = await createApp({
      consumeLimit: () => Promise.resolve({ allowed: false, retryAfter: 9 }),
    });
    const response = await harness.app.inject({
      headers: await validHeaders(),
      method: "GET",
      url: PRIVATE_MCP_AGENT_CONTEXT_PATH,
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("9");
    expect(response.json()).toMatchObject({
      error: { code: "RATE_LIMITED", retryable: true },
      request_id: requestId,
      schema_version: "1",
    });
    expect(harness.consumeLimit).toHaveBeenCalledOnce();
  });

  it("exposes no public, REST, auth, or health routes on the private app", async () => {
    const harness = await createApp();
    for (const url of ["/", "/health/live", "/v1/agent/context", "/api/auth/*"]) {
      const response = await harness.app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
    }
    expect(harness.transportIdentityGuard).toHaveBeenCalledTimes(4);
    expect(harness.consumeReplay).not.toHaveBeenCalled();
    expect(harness.authenticateActorContext).not.toHaveBeenCalled();
  });
});
