import type {
  McpActorAssertionKeyRing,
  McpActorAssertionReplayStore,
} from "../../packages/auth/src/index.js";
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
} from "../../packages/contracts/src/index.js";
import type {
  AgentCredentialContext,
  AgentPendingActionView,
  CommunityDetailProjection,
  CommunityDirectoryPage,
  ContentBrowsePage,
  ContentDetailProjection,
  ContentSearchPage,
  DiscussionProjection,
  NotificationListPage,
  RemoteMcpAuthorityService,
  ResearchWriteOutcome,
} from "../../packages/domain/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPrivateMcpApp } from "../../apps/api/src/private-mcp-app.js";
import { createBrowseContentTool } from "../../apps/mcp/src/browse-content-tool.js";
import { createCreatePostTool } from "../../apps/mcp/src/create-post-tool.js";
import { createFindCommunitiesTool } from "../../apps/mcp/src/find-communities-tool.js";
import { createGetActionStatusTool } from "../../apps/mcp/src/get-action-status-tool.js";
import { createGetAgentContextTool } from "../../apps/mcp/src/get-agent-context-tool.js";
import { createGetCommunityTool } from "../../apps/mcp/src/get-community-tool.js";
import { createGetContentTool } from "../../apps/mcp/src/get-content-tool.js";
import { createGetDiscussionTool } from "../../apps/mcp/src/get-discussion-tool.js";
import {
  createInternalMcpApiClient,
  type InternalApiRequestTransport,
} from "../../apps/mcp/src/internal-api-client.js";
import { createListNotificationsTool } from "../../apps/mcp/src/list-notifications-tool.js";
import type { McpToolExecutionContext } from "../../apps/mcp/src/protocol.js";
import { createReplyToContentTool } from "../../apps/mcp/src/reply-to-content-tool.js";
import { createSearchContentTool } from "../../apps/mcp/src/search-content-tool.js";

const ids = {
  action: "action:pending@2026",
  actor: "20000000-0000-4000-8000-000000000002",
  agent: "30000000-0000-4000-8000-000000000003",
  community: "community:semiconductors@v1",
  content: "content:amd?case=base",
  credential: "60000000-0000-4000-8000-000000000006",
  grant: "70000000-0000-4000-8000-000000000007",
  owner: "80000000-0000-4000-8000-000000000008",
  policy: "90000000-0000-4000-8000-000000000009",
  revision: "revision:amd@1",
  reply: "content:amd-reply@1",
  replyRevision: "revision:amd-reply@1",
  topic: "b0000000-0000-4000-8000-00000000000b",
} as const;
const now = new Date("2026-07-22T12:00:00.000Z");
const keyRing: McpActorAssertionKeyRing = {
  currentVersion: 1,
  keys: {
    1: { key: Buffer.alloc(32, 0x42), verificationExpiresAt: null },
  },
};
const scopes = [
  "research:read",
  "community:read",
  "notifications:read",
  "actions:read",
  "content:write",
] as const;
const context: AgentCredentialContext = {
  agent: {
    id: ids.agent,
    actorId: ids.actor,
    ownerId: ids.owner,
    handle: "phase-b-researcher",
    displayName: "Phase B Researcher",
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
      version: "4",
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
    scopes: [...scopes],
    audience: "https://mcp.alphanet.test/mcp",
    policyCeiling: "assisted",
    policyCeilingDefaultsVersion: "agent-permission-defaults-v1",
    policyCeilingRules: { operations: {} },
    policyCeilingSchemaVersion: 1,
    issuedAt: now,
    expiresAt: new Date(now.valueOf() + 10 * 60_000),
    lastUsedAt: null,
    revokedAt: null,
    replacesCredentialId: null,
    status: "active",
  },
  owner: { id: ids.owner },
};

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
        handle: "phase-b-researcher",
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
      contentHash: "sha256:phase-b-content",
      sourceLinks: [],
      mentions: [],
      references: [],
    },
    revisionHistory: [
      {
        contentHash: "sha256:phase-b-content",
        createdAt: now,
        createdByActorId: ids.actor,
        editSummary: null,
        id: ids.revision,
        revisionNumber: 1,
        sourceVersion: 1,
      },
    ],
    revisionOrdering: {
      asOf: now,
      orderingVersion: "revision-history-desc-v1",
      snapshotId: "snapshot:phase-b-revisions",
    },
    revisionPage: { hasMore: false, limit: 1, nextCursor: null },
    viewerState: { following: false, reactions: [] },
  };
}

function communitySearchPage(): CommunityDirectoryPage {
  return {
    items: [],
    ordering: {
      asOf: now,
      orderingVersion: "community-directory-v1",
      snapshotId: "snapshot:phase-c-communities",
    },
    page: { hasMore: false, limit: 5, nextCursor: null },
  };
}

function browsePage(): ContentBrowsePage {
  return {
    countsAsOf: now,
    items: [],
    page: { hasMore: false, limit: 5, nextCursor: null },
    ranking: {
      asOf: now,
      expiresAt: new Date(now.valueOf() + 300_000),
      rankingVersion: "content-read-v1:latest",
      snapshotId: "snapshot:phase-c-browse",
    },
  };
}

function searchPage(): ContentSearchPage {
  return {
    countsAsOf: now,
    items: [],
    page: { hasMore: false, limit: 5, nextCursor: null },
    ranking: {
      asOf: now,
      expiresAt: new Date(now.valueOf() + 300_000),
      indexAsOf: now,
      rankingVersion: "content-search-v1",
      snapshotId: "snapshot:phase-c-search",
    },
    searchExecution: {
      degraded: false,
      degradationReason: null,
      effectiveMode: "hybrid",
      requestedMode: "hybrid",
    },
    semanticIndexCoverage: { complete: true, unindexedCandidateCount: 0 },
  };
}

function discussion(): DiscussionProjection {
  const detail = contentDetail();
  if (detail.revision === null) throw new Error("Expected current revision");
  return {
    ancestorContext: [],
    countsAsOf: now,
    ordering: {
      asOf: now,
      expiresAt: new Date(now.valueOf() + 300_000),
      orderingVersion: "discussion-flat-v1:latest",
      snapshotId: "snapshot:phase-c-discussion",
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

function notificationPage(): NotificationListPage {
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
      snapshotId: "nts_phase_c_history",
    },
    page: { hasMore: false, limit: 5, nextCursor: null },
    poll: { hasMore: false, nextCursor: "npc_phase_c_poll" },
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
    policyVersion: `${ids.policy}:4`,
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
      state: action.state,
      expiresAt: action.expiresAt,
      inputDigest: action.inputDigest,
      requestedAt: action.requestedAt,
      decisionId: action.decisionId,
      policyVersion: action.policyVersion,
      approvalSummary: action.approvalSummary,
    },
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

function executionContext(requestId: string): McpToolExecutionContext {
  return {
    authorization: {
      clientId: "phase-b-host",
      credentialId: ids.credential,
      expiresAt: Math.floor(now.valueOf() / 1_000) + 600,
      grantId: ids.grant,
      resource: "https://mcp.alphanet.test/mcp",
      scopes: [...scopes],
      tokenJtiDigest: "A".repeat(43),
    },
    requestId,
    signal: new AbortController().signal,
  };
}

const apps: Awaited<ReturnType<typeof createPrivateMcpApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  vi.restoreAllMocks();
});

describe("Remote MCP social-loop private bridge", () => {
  it("runs all eleven tools through the real assertion client and private API", async () => {
    const consumeReplay = vi.fn<McpActorAssertionReplayStore["consume"]>(() =>
      Promise.resolve(true),
    );
    const authenticateActorContext = vi.fn<
      RemoteMcpAuthorityService["authenticateActorContext"]
    >(() => Promise.resolve(context));
    const searchCommunities = vi.fn(() => Promise.resolve(communitySearchPage()));
    const getCommunity = vi.fn(() => Promise.resolve(communityDetail()));
    const browseContent = vi.fn(() => Promise.resolve(browsePage()));
    const searchContent = vi.fn(() => Promise.resolve(searchPage()));
    const getContent = vi.fn(() => Promise.resolve(contentDetail()));
    const getDiscussion = vi.fn(() => Promise.resolve(discussion()));
    const listAgentNotifications = vi.fn(() => Promise.resolve(notificationPage()));
    const getActionStatus = vi.fn(() => Promise.resolve(pendingAction()));
    const createPost = vi.fn(() => Promise.resolve(pendingCreatePostOutcome()));
    const replyToContent = vi.fn(() => Promise.resolve(successfulReplyOutcome()));
    const app = await createPrivateMcpApp({
      actorAuthenticator: {
        authority: { authenticateActorContext },
        keyRing,
        now: () => now,
        replayStore: { consume: consumeReplay },
      },
      communityDirectoryService: {
        getCommunity,
        searchCommunities,
      },
      contentReadService: {
        browseContent,
        getContent,
        getDiscussion,
      },
      contentSearchService: { searchContent },
      notificationService: { listAgentNotifications },
      now: () => now,
      pendingActionStatusService: { getActionStatus },
      rateLimiter: {
        consume: () => Promise.resolve({ allowed: true, retryAfter: null }),
      },
      researchWriteService: {
        createPost,
        replyToContent,
      },
      transportIdentityGuard: () => ({
        authentication: "mutual_tls",
        service: "mcp",
      }),
    });
    apps.push(app);

    const bridgedRequests: Parameters<InternalApiRequestTransport>[0][] = [];
    const bridgeTransport: InternalApiRequestTransport = async (request) => {
      bridgedRequests.push(request);
      const response = await app.inject({
        headers: { ...request.headers },
        method: request.method,
        ...(request.body ? { payload: request.body } : {}),
        url: `${request.url.pathname}${request.url.search}`,
      });
      const body = Buffer.from(response.body, "utf8");
      return {
        body,
        headers: {
          "content-length": String(body.byteLength),
          "content-type": response.headers["content-type"] ?? "application/json",
        },
        statusCode: response.statusCode,
      };
    };
    const internalApiClient = createInternalMcpApiClient(
      {
        assertionKeyRing: keyRing,
        baseUrl: "https://api.alphanet.internal",
        timeoutMilliseconds: 15_000,
        tls: { ca: "test-ca", cert: "test-cert", key: "test-key" },
      },
      { now: () => now, transport: bridgeTransport },
    );

    const agentRequestId = "11111111-1111-4111-8111-111111111111";
    const agentResult = await createGetAgentContextTool(internalApiClient).execute(
      {},
      executionContext(agentRequestId),
    );
    const findRequestId = "22222222-2222-4222-8222-222222222222";
    const findArguments = { limit: 5, query: "semiconductors" };
    const findResult = await createFindCommunitiesTool(internalApiClient).execute(
      findArguments,
      executionContext(findRequestId),
    );
    const communityRequestId = "33333333-3333-4333-8333-333333333333";
    const communityResult = await createGetCommunityTool(internalApiClient).execute(
      { community_id: ids.community },
      executionContext(communityRequestId),
    );
    const browseRequestId = "44444444-4444-4444-8444-444444444444";
    const browseArguments = {
      author_actor_id: ids.actor,
      limit: 5,
      scope: "author" as const,
      sort: "latest" as const,
    };
    const browseResult = await createBrowseContentTool(internalApiClient).execute(
      browseArguments,
      executionContext(browseRequestId),
    );
    const searchRequestId = "55555555-5555-4555-8555-555555555555";
    const searchArguments = {
      author_actor_id: ids.actor,
      limit: 5,
      query: "AMD downside evidence",
      scope: "author" as const,
    };
    const searchResult = await createSearchContentTool(internalApiClient).execute(
      searchArguments,
      executionContext(searchRequestId),
    );
    const contentRequestId = "66666666-6666-4666-8666-666666666666";
    const revisionCursor = "cursor:revision?page=2";
    const contentArguments = {
      content_id: ids.content,
      include_revision_history: true,
      revision_cursor: revisionCursor,
      revision_id: ids.revision,
      revision_limit: 1,
    };
    const contentResult = await createGetContentTool(internalApiClient).execute(
      contentArguments,
      executionContext(contentRequestId),
    );
    const discussionRequestId = "77777777-7777-4777-8777-777777777777";
    const discussionArguments = {
      content_id: ids.content,
      limit: 5,
      sort: "latest" as const,
    };
    const discussionResult = await createGetDiscussionTool(internalApiClient).execute(
      discussionArguments,
      executionContext(discussionRequestId),
    );
    const notificationRequestId = "88888888-8888-4888-8888-888888888888";
    const notificationArguments = { limit: 5 };
    const notificationResult = await createListNotificationsTool(
      internalApiClient,
    ).execute(notificationArguments, executionContext(notificationRequestId));
    const actionRequestId = "99999999-9999-4999-8999-999999999999";
    const actionResult = await createGetActionStatusTool(internalApiClient).execute(
      { action_id: ids.action },
      executionContext(actionRequestId),
    );
    const createRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const createArguments = {
      title: "HBM supply update",
      body_markdown: "Channel checks suggest a tighter near-term supply range.",
      primary_community_id: ids.community,
      symbols: ["AMD"],
      topics: ["data-center"],
      idempotency_key: "phase-b-create-post",
    };
    const createResult = await createCreatePostTool(internalApiClient).execute(
      createArguments,
      executionContext(createRequestId),
    );
    const replyRequestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const replyArguments = {
      body_markdown: "Which primary source would falsify this claim?",
      idempotency_key: "phase-c-reply-to-content",
      parent_content_id: ids.content,
      symbols: ["AMD"],
    };
    const replyResult = await createReplyToContentTool(internalApiClient).execute(
      replyArguments,
      executionContext(replyRequestId),
    );

    expect(AgentContextResponseSchema.parse(agentResult.payload).request_id).toBe(
      agentRequestId,
    );
    expect(FindCommunitiesResponseSchema.parse(findResult.payload)).toMatchObject({
      items: [],
      request_id: findRequestId,
    });
    expect(GetCommunityResponseSchema.parse(communityResult.payload)).toMatchObject({
      community: { id: ids.community },
      request_id: communityRequestId,
    });
    expect(BrowseContentResponseSchema.parse(browseResult.payload)).toMatchObject({
      items: [],
      request_id: browseRequestId,
    });
    expect(SearchContentResponseSchema.parse(searchResult.payload)).toMatchObject({
      items: [],
      request_id: searchRequestId,
    });
    expect(GetContentResponseSchema.parse(contentResult.payload)).toMatchObject({
      content: { id: ids.content },
      request_id: contentRequestId,
    });
    expect(GetDiscussionResponseSchema.parse(discussionResult.payload)).toMatchObject({
      request_id: discussionRequestId,
      root: { id: ids.content },
    });
    expect(
      ListNotificationsResponseSchema.parse(notificationResult.payload),
    ).toMatchObject({
      mode: "history",
      request_id: notificationRequestId,
    });
    expect(GetActionStatusResponseSchema.parse(actionResult.payload)).toMatchObject({
      action: { id: ids.action },
      request_id: actionRequestId,
    });
    expect(CreatePostWriteResultSchema.parse(createResult.payload)).toMatchObject({
      request_id: createRequestId,
      status: "pending_approval",
      pending_action: { id: ids.action },
    });
    expect(ReplyToContentWriteResultSchema.parse(replyResult.payload)).toMatchObject({
      request_id: replyRequestId,
      result: { content_id: ids.reply, root_content_id: ids.content },
      status: "succeeded",
    });
    expect(bridgedRequests.map((request) => request.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "POST",
      "POST",
      "GET",
      "POST",
      "POST",
      "GET",
      "POST",
      "POST",
    ]);
    expect(bridgedRequests.map((request) => request.url.pathname)).toEqual([
      "/internal/mcp/v1/agent/context",
      "/internal/mcp/v1/communities/search",
      `/internal/mcp/v1/communities/${encodeURIComponent(ids.community)}`,
      "/internal/mcp/v1/content/browse",
      "/internal/mcp/v1/content/search",
      `/internal/mcp/v1/content/${encodeURIComponent(ids.content)}`,
      "/internal/mcp/v1/content/discussion",
      "/internal/mcp/v1/notifications/list",
      `/internal/mcp/v1/actions/${encodeURIComponent(ids.action)}`,
      "/internal/mcp/v1/posts",
      "/internal/mcp/v1/replies",
    ]);
    expect(bridgedRequests[5]?.url.searchParams.get("revision_id")).toBe(ids.revision);
    expect(bridgedRequests[5]?.url.searchParams.get("include_revision_history")).toBe(
      "true",
    );
    expect(bridgedRequests[5]?.url.searchParams.get("revision_limit")).toBe("1");
    expect(bridgedRequests[5]?.url.searchParams.get("revision_cursor")).toBe(
      revisionCursor,
    );
    for (const request of bridgedRequests) {
      expect(request.headers).not.toHaveProperty("authorization");
      expect(request.headers).not.toHaveProperty("cookie");
      expect(request.headers["x-alphanet-mcp-actor-context"]).toEqual(expect.any(String));
      expect(request.headers["x-request-id"]).toEqual(expect.any(String));
    }
    expect(JSON.parse(bridgedRequests[1]!.body!.toString("utf8"))).toEqual(findArguments);
    expect(JSON.parse(bridgedRequests[3]!.body!.toString("utf8"))).toEqual(
      browseArguments,
    );
    expect(JSON.parse(bridgedRequests[4]!.body!.toString("utf8"))).toEqual(
      searchArguments,
    );
    expect(JSON.parse(bridgedRequests[6]!.body!.toString("utf8"))).toEqual(
      discussionArguments,
    );
    expect(JSON.parse(bridgedRequests[7]!.body!.toString("utf8"))).toEqual(
      notificationArguments,
    );
    expect(JSON.parse(bridgedRequests[9]!.body!.toString("utf8"))).toEqual(
      createArguments,
    );
    expect(JSON.parse(bridgedRequests[10]!.body!.toString("utf8"))).toEqual(
      replyArguments,
    );
    expect(searchCommunities).toHaveBeenCalledWith(
      context,
      expect.objectContaining(findArguments),
    );
    expect(browseContent).toHaveBeenCalledWith(context, {
      authorActorId: ids.actor,
      limit: 5,
      scope: "author",
      sort: "latest",
    });
    expect(searchContent).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        authorActorId: ids.actor,
        limit: 5,
        query: "AMD downside evidence",
        scope: "author",
      }),
      { channel: "mcp", requestId: searchRequestId },
    );
    expect(getDiscussion).toHaveBeenCalledWith(context, {
      contentId: ids.content,
      limit: 5,
      sort: "latest",
    });
    expect(listAgentNotifications).toHaveBeenCalledWith(context, { limit: 5 });
    expect(createPost).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        idempotencyKey: "phase-b-create-post",
        primaryCommunityId: ids.community,
      }),
      { channel: "mcp", requestId: createRequestId },
    );
    expect(getContent).toHaveBeenCalledWith(context, {
      contentId: ids.content,
      includeRevisionHistory: true,
      revisionCursor,
      revisionId: ids.revision,
      revisionLimit: 1,
    });
    expect(replyToContent).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        bodyMarkdown: "Which primary source would falsify this claim?",
        idempotencyKey: "phase-c-reply-to-content",
        parentContentId: ids.content,
      }),
      { channel: "mcp", requestId: replyRequestId },
    );
    expect(authenticateActorContext).toHaveBeenCalledTimes(11);
    expect(consumeReplay).toHaveBeenCalledTimes(11);
  });
});
