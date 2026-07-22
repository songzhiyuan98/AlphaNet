import {
  createMcpActorContextAssertion,
  digestInboundMcpTokenJti,
  type McpActorAssertionKeyRing,
  type McpActorAssertionReplayStore,
} from "@alphanet/auth";
import {
  AgentContextResponseSchema,
  CreatePostWriteResultSchema,
  GetActionStatusResponseSchema,
  GetCommunityResponseSchema,
  GetContentResponseSchema,
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
  PRIVATE_MCP_CONTENT_PATH,
  PRIVATE_MCP_POSTS_PATH,
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
  communityDirectoryService?: PrivateMcpAppOptions["communityDirectoryService"];
  consumeLimit?: PrivateMcpAppOptions["rateLimiter"]["consume"];
  contentReadService?: PrivateMcpAppOptions["contentReadService"];
  order?: string[];
  pendingActionStatusService?: PrivateMcpAppOptions["pendingActionStatusService"];
  researchWriteService?: PrivateMcpAppOptions["researchWriteService"];
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
    communityDirectoryService: options?.communityDirectoryService ?? {
      getCommunity: () => Promise.reject(new Error("Unexpected Community request")),
    },
    contentReadService: options?.contentReadService ?? {
      getContent: () => Promise.reject(new Error("Unexpected Content request")),
    },
    now: () => now,
    pendingActionStatusService: options?.pendingActionStatusService ?? {
      getActionStatus: () =>
        Promise.reject(new Error("Unexpected PendingAction request")),
    },
    rateLimiter: { consume: consumeLimit },
    researchWriteService: options?.researchWriteService ?? {
      createPost: () => Promise.reject(new Error("Unexpected research write")),
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
        find_communities: { available: false, default_decision: "allow" },
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
  ] as const)(
    "enforces $label scope before invoking a private domain adapter",
    async ({ method, missingScopes, payload, requiredScope, url }) => {
      const getCommunity = vi.fn(() => Promise.resolve(communityDetail()));
      const getContent = vi.fn(() => Promise.resolve(contentDetail()));
      const getActionStatus = vi.fn(() => Promise.resolve(pendingAction()));
      const createPost = vi.fn(() => Promise.resolve(pendingCreatePostOutcome()));
      const harness = await createApp({
        authorityContext: contextWithScopes([...missingScopes]),
        communityDirectoryService: { getCommunity },
        contentReadService: { getContent },
        pendingActionStatusService: { getActionStatus },
        researchWriteService: { createPost },
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
      expect(getContent).not.toHaveBeenCalled();
      expect(getActionStatus).not.toHaveBeenCalled();
      expect(createPost).not.toHaveBeenCalled();
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
