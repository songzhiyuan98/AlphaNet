import type {
  McpActorAssertionKeyRing,
  McpActorAssertionReplayStore,
} from "../../packages/auth/src/index.js";
import {
  AgentContextResponseSchema,
  CreatePostWriteResultSchema,
  GetActionStatusResponseSchema,
  GetCommunityResponseSchema,
  GetContentResponseSchema,
} from "../../packages/contracts/src/index.js";
import type {
  AgentCredentialContext,
  AgentPendingActionView,
  CommunityDetailProjection,
  ContentDetailProjection,
  RemoteMcpAuthorityService,
  ResearchWriteOutcome,
} from "../../packages/domain/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPrivateMcpApp } from "../../apps/api/src/private-mcp-app.js";
import { createCreatePostTool } from "../../apps/mcp/src/create-post-tool.js";
import { createGetActionStatusTool } from "../../apps/mcp/src/get-action-status-tool.js";
import { createGetAgentContextTool } from "../../apps/mcp/src/get-agent-context-tool.js";
import { createGetCommunityTool } from "../../apps/mcp/src/get-community-tool.js";
import { createGetContentTool } from "../../apps/mcp/src/get-content-tool.js";
import {
  createInternalMcpApiClient,
  type InternalApiRequestTransport,
} from "../../apps/mcp/src/internal-api-client.js";
import type { McpToolExecutionContext } from "../../apps/mcp/src/protocol.js";

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

describe("Remote MCP Phase B private bridge", () => {
  it("runs all five tools through the real assertion client and private API", async () => {
    const consumeReplay = vi.fn<McpActorAssertionReplayStore["consume"]>(() =>
      Promise.resolve(true),
    );
    const authenticateActorContext = vi.fn<
      RemoteMcpAuthorityService["authenticateActorContext"]
    >(() => Promise.resolve(context));
    const getCommunity = vi.fn(() => Promise.resolve(communityDetail()));
    const getContent = vi.fn(() => Promise.resolve(contentDetail()));
    const getActionStatus = vi.fn(() => Promise.resolve(pendingAction()));
    const createPost = vi.fn(() => Promise.resolve(pendingCreatePostOutcome()));
    const app = await createPrivateMcpApp({
      actorAuthenticator: {
        authority: { authenticateActorContext },
        keyRing,
        now: () => now,
        replayStore: { consume: consumeReplay },
      },
      communityDirectoryService: { getCommunity },
      contentReadService: { getContent },
      now: () => now,
      pendingActionStatusService: { getActionStatus },
      rateLimiter: {
        consume: () => Promise.resolve({ allowed: true, retryAfter: null }),
      },
      researchWriteService: { createPost },
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
    const communityRequestId = "22222222-2222-4222-8222-222222222222";
    const communityResult = await createGetCommunityTool(internalApiClient).execute(
      { community_id: ids.community },
      executionContext(communityRequestId),
    );
    const createRequestId = "33333333-3333-4333-8333-333333333333";
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
    const actionRequestId = "44444444-4444-4444-8444-444444444444";
    const actionResult = await createGetActionStatusTool(internalApiClient).execute(
      { action_id: ids.action },
      executionContext(actionRequestId),
    );
    const contentRequestId = "55555555-5555-4555-8555-555555555555";
    const revisionCursor = "cursor:revision?page=2";
    const contentResult = await createGetContentTool(internalApiClient).execute(
      {
        content_id: ids.content,
        include_revision_history: true,
        revision_cursor: revisionCursor,
        revision_id: ids.revision,
        revision_limit: 1,
      },
      executionContext(contentRequestId),
    );

    expect(AgentContextResponseSchema.parse(agentResult.payload).request_id).toBe(
      agentRequestId,
    );
    expect(GetCommunityResponseSchema.parse(communityResult.payload)).toMatchObject({
      community: { id: ids.community },
      request_id: communityRequestId,
    });
    expect(CreatePostWriteResultSchema.parse(createResult.payload)).toMatchObject({
      request_id: createRequestId,
      status: "pending_approval",
      pending_action: { id: ids.action },
    });
    expect(GetActionStatusResponseSchema.parse(actionResult.payload)).toMatchObject({
      action: { id: ids.action },
      request_id: actionRequestId,
    });
    expect(GetContentResponseSchema.parse(contentResult.payload)).toMatchObject({
      content: { id: ids.content },
      request_id: contentRequestId,
    });
    expect(bridgedRequests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "POST",
      "GET",
      "GET",
    ]);
    expect(bridgedRequests.map((request) => request.url.pathname)).toEqual([
      "/internal/mcp/v1/agent/context",
      `/internal/mcp/v1/communities/${encodeURIComponent(ids.community)}`,
      "/internal/mcp/v1/posts",
      `/internal/mcp/v1/actions/${encodeURIComponent(ids.action)}`,
      `/internal/mcp/v1/content/${encodeURIComponent(ids.content)}`,
    ]);
    expect(bridgedRequests[4]?.url.searchParams.get("revision_id")).toBe(ids.revision);
    expect(bridgedRequests[4]?.url.searchParams.get("include_revision_history")).toBe(
      "true",
    );
    expect(bridgedRequests[4]?.url.searchParams.get("revision_limit")).toBe("1");
    expect(bridgedRequests[4]?.url.searchParams.get("revision_cursor")).toBe(
      revisionCursor,
    );
    for (const request of bridgedRequests) {
      expect(request.headers).not.toHaveProperty("authorization");
      expect(request.headers).not.toHaveProperty("cookie");
      expect(request.headers["x-alphanet-mcp-actor-context"]).toEqual(expect.any(String));
      expect(request.headers["x-request-id"]).toEqual(expect.any(String));
    }
    expect(JSON.parse(bridgedRequests[2]!.body!.toString("utf8"))).toEqual(
      createArguments,
    );
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
    expect(authenticateActorContext).toHaveBeenCalledTimes(5);
    expect(consumeReplay).toHaveBeenCalledTimes(5);
  });
});
