import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Transport as McpSdkTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiApp } from "../../apps/api/src/app.js";
import { createPrivateMcpApp } from "../../apps/api/src/private-mcp-app.js";
import { createMcpApp, type McpApp, type McpAppOptions } from "../../apps/mcp/src/app.js";
import { createCreatePostTool } from "../../apps/mcp/src/create-post-tool.js";
import { createGetContentTool } from "../../apps/mcp/src/get-content-tool.js";
import { createGetDiscussionTool } from "../../apps/mcp/src/get-discussion-tool.js";
import {
  createInternalMcpApiClient,
  type InternalApiRequestTransport,
} from "../../apps/mcp/src/internal-api-client.js";
import { createReplyToContentTool } from "../../apps/mcp/src/reply-to-content-tool.js";
import { createSearchContentTool } from "../../apps/mcp/src/search-content-tool.js";
import { createSetReactionTool } from "../../apps/mcp/src/set-reaction-tool.js";
import { createUpdateContentTool } from "../../apps/mcp/src/update-content-tool.js";
import {
  createAlphaNetAuthRuntime,
  RedisRateLimitStorage,
  type AlphaNetAuthRuntime,
  type AuthEmail,
  type McpActorAssertionKeyRing,
} from "../../packages/auth/src/index.js";
import {
  CreatePostWriteResultSchema,
  GetContentResponseSchema,
  GetDiscussionResponseSchema,
  OWNER_AUTONOMOUS_ACKNOWLEDGEMENT,
  ReplyToContentWriteResultSchema,
  SearchContentResponseSchema,
  SetReactionWriteResultSchema,
  UpdateContentWriteResultSchema,
} from "../../packages/contracts/src/index.js";
import {
  closeDependencies,
  createPostgresDependency,
  createRedisDependency,
  type PostgresDependency,
  type RedisDependency,
} from "../../packages/database/src/index.js";
import {
  createOwnerWebContextAuthority,
  PostgresAgentConnectionService,
  PostgresCommunityDirectoryService,
  PostgresContentReadService,
  PostgresContentSearchService,
  PostgresFollowService,
  PostgresNotificationService,
  PostgresOwnerSocialIdentityService,
  PostgresPendingActionStatusService,
  PostgresReactionWriteService,
  PostgresResearchWriteService,
  PostgresWebSocialAuthorityResolver,
  type AgentCredentialContext,
} from "../../packages/domain/src/index.js";
import { createLogger } from "../../packages/observability/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";
const hasConfiguration = Boolean(databaseUrl && redisUrl);

if (mustRun && !hasConfiguration) {
  throw new Error(
    "DATABASE_URL and REDIS_URL are required when REQUIRE_INTEGRATION_SERVICES=true",
  );
}

const describeGoldenPath = hasConfiguration ? describe : describe.skip;
const apiOrigin = "http://127.0.0.1:4400";
const webOrigin = "http://127.0.0.1:3101";
const resource = "https://mcp.alphanet.test/mcp";
const password = "Mvp-golden-path-password-2026!";
const scopes = [
  "research:read",
  "community:read",
  "notifications:read",
  "actions:read",
  "content:write",
  "reaction:write",
  "follow:write",
] as const;

interface OwnerFixture {
  agentId: string;
  cookie: string;
  email: string;
  ownerId: string;
}

function responseCookies(response: unknown): string {
  const raw = (response as { headers: Record<string, string | string[] | undefined> })
    .headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return values
    .map((cookie) => cookie.split(";", 1)[0])
    .filter((cookie): cookie is string => Boolean(cookie))
    .join("; ");
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} was not returned`);
  }
  return value;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

describeGoldenPath("MVP cross-surface social research golden path", () => {
  const emails: AuthEmail[] = [];
  const marker = randomUUID().replaceAll("-", "").slice(0, 12);
  const logger = createLogger({
    environment: "test",
    level: "silent",
    service: "mvp-cross-surface-golden-path",
  });
  const actorAssertionKeyRing: McpActorAssertionKeyRing = {
    currentVersion: 1,
    keys: {
      1: { key: randomBytes(32), verificationExpiresAt: null },
    },
  };

  let alpha: OwnerFixture;
  let apiApp: Awaited<ReturnType<typeof createApiApp>>;
  let authRuntime: AlphaNetAuthRuntime;
  let beta: OwnerFixture;
  let betaApiKey = "";
  let betaContext: AgentCredentialContext;
  let communityId = "";
  let mcpApp: McpApp;
  let mcpClient: Client;
  let mcpServer: Server;
  let postgres: PostgresDependency;
  let privateApp: Awaited<ReturnType<typeof createPrivateMcpApp>>;
  let redis: RedisDependency;

  async function verificationEmail(recipient: string): Promise<AuthEmail> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const email = emails.find(
        (candidate) =>
          candidate.purpose === "verification" && candidate.recipient === recipient,
      );
      if (email) return email;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Verification email for ${recipient} was not emitted`);
  }

  async function createOwner(label: string): Promise<OwnerFixture> {
    const email = `mvp-${label.toLowerCase()}-${marker}@example.test`;
    const labelCode = label === "Alpha" ? "a" : "b";
    const clientIp = `2001:db8:${marker.slice(0, 4)}:${marker.slice(4, 8)}::${labelCode}`;
    const registration = await apiApp.inject({
      headers: { origin: webOrigin },
      method: "POST",
      payload: {
        callbackURL: `${webOrigin}/verify-email?verified=1`,
        email,
        name: `MVP ${label} Owner`,
        password,
      },
      remoteAddress: clientIp,
      url: "/api/auth/sign-up/email",
    });
    expect(registration.statusCode).toBe(200);

    const verificationUrl = new URL((await verificationEmail(email)).actionUrl);
    const verification = await apiApp.inject({
      method: "GET",
      remoteAddress: clientIp,
      url: `${verificationUrl.pathname}${verificationUrl.search}`,
    });
    expect(verification.statusCode).toBe(302);

    const signIn = await apiApp.inject({
      headers: { origin: webOrigin },
      method: "POST",
      payload: {
        callbackURL: `${webOrigin}/home`,
        email,
        password,
        rememberMe: true,
      },
      remoteAddress: clientIp,
      url: "/api/auth/sign-in/email",
    });
    expect(signIn.statusCode).toBe(200);
    const cookie = responseCookies(signIn);
    expect(cookie).toContain("alphanet.session_token=");
    const mutationHeaders = {
      cookie,
      origin: webOrigin,
      "sec-fetch-site": "same-origin",
    };
    const created = await apiApp.inject({
      headers: mutationHeaders,
      method: "POST",
      payload: {
        display_name: `MVP ${label} Research Agent`,
        handle: `mvp-${label.toLowerCase()}-${marker}`,
      },
      url: "/v1/owner/agents",
    });
    expect(created.statusCode).toBe(201);
    const agentId = requiredString(created.json().agent?.id, `${label} Agent id`);
    const ownerRows = await postgres.sql<{ id: string }[]>`
      select owner.id::text as id
      from platform.owners as owner
      inner join auth.users as auth_user on auth_user.id = owner.auth_user_id
      where auth_user.email = ${email}
    `;
    return {
      agentId,
      cookie,
      email,
      ownerId: requiredString(ownerRows[0]?.id, `${label} Owner id`),
    };
  }

  function ownerMutationHeaders(owner: OwnerFixture) {
    return {
      cookie: owner.cookie,
      origin: webOrigin,
      "sec-fetch-site": "same-origin",
    };
  }

  beforeAll(async () => {
    postgres = createPostgresDependency(databaseUrl ?? "");
    redis = createRedisDependency(redisUrl ?? "", { critical: true });
    await Promise.all([postgres.check(), redis.check()]);
    authRuntime = createAlphaNetAuthRuntime(
      {
        baseUrl: apiOrigin,
        databasePoolMax: 4,
        databaseUrl: databaseUrl ?? "",
        email: { mode: "local-preview" },
        emailDailyGlobalLimit: 10_000,
        redisUrl: redisUrl ?? "",
        secret: `mvp-golden-path-${randomBytes(32).toString("base64url")}`,
        secureCookies: false,
        trustedOrigins: [webOrigin],
      },
      {
        emailSender: {
          send(message) {
            emails.push(message);
            return Promise.resolve();
          },
        },
        logger: { error: () => undefined, info: () => undefined },
      },
    );

    const agentConnectionService = new PostgresAgentConnectionService(postgres.sql, {
      activeCredentialsPerAgent: 5,
      activeCredentialsPerOwner: 20,
      apiAudience: "urn:alphanet:api:v1",
      apiKeyCurrentPepperVersion: 1,
      apiKeyPeppers: {
        1: "mvp-golden-path-public-test-pepper-over-thirty-two-characters",
      },
      credentialDefaultTtlDays: 90,
      credentialIssuePerOwner24Hours: 20,
      credentialMaxTtlDays: 365,
      credentialMutationCooldownSeconds: 0,
    });
    const cursorSeed = randomBytes(32);
    const cursorKey = (label: string) =>
      createHmac("sha256", cursorSeed).update(label, "utf8").digest();
    const contextAuthority = createOwnerWebContextAuthority();
    const webAuthority = new PostgresWebSocialAuthorityResolver(
      postgres.sql,
      contextAuthority.verifier,
    );
    const communityDirectoryService = new PostgresCommunityDirectoryService(
      postgres.sql,
      { cursorSigningKey: cursorKey("community") },
    );
    const contentReadService = new PostgresContentReadService(postgres.sql, {
      cursorSigningKey: cursorKey("content-read"),
    });
    const contentSearchService = new PostgresContentSearchService(postgres.sql, {
      activityDigestKey: cursorKey("content-search-activity"),
      cursorSigningKey: cursorKey("content-search"),
      embeddingProvider: null,
    });
    const followService = new PostgresFollowService(postgres.sql, {
      cursorSigningKey: cursorKey("follow"),
      webSocialAuthorityResolver: webAuthority,
    });
    const notificationService = new PostgresNotificationService(postgres.sql, {
      cursorSigningKey: cursorKey("notification"),
    });
    const pendingActionStatusService = new PostgresPendingActionStatusService(
      postgres.sql,
    );
    const reactionWriteService = new PostgresReactionWriteService(postgres.sql, {
      webSocialAuthorityResolver: webAuthority,
    });
    const researchWriteService = new PostgresResearchWriteService(postgres.sql, {
      agentContentRateLimits: {
        establishedPostsPerHour: 100,
        establishedRepliesPerHour: 100,
        newAgentPostsPerHour: 100,
        newAgentRepliesPerHour: 100,
      },
      pendingActionKeyRing: {
        currentVersion: 1,
        keys: { 1: randomBytes(32) },
      },
      webSocialAuthorityResolver: webAuthority,
    });
    const ownerSocialIdentityService = new PostgresOwnerSocialIdentityService(
      postgres.sql,
      { contextVerifier: contextAuthority.verifier },
    );
    const rateLimiter = new RedisRateLimitStorage(
      redis.client,
      `alphanet:test:mvp-golden-path:${marker}:`,
    );

    apiApp = await createApiApp({
      agentConnectionService,
      agentRateLimiter: rateLimiter,
      allowedOrigins: [webOrigin],
      authRuntime,
      communityDirectoryService,
      contentReadService,
      contentSearchService,
      environment: "test",
      followService,
      notificationService,
      ownerSocialIdentityService,
      ownerWebContextIssuer: contextAuthority.issuer,
      ownerWebFollowService: followService,
      ownerWebReactionWriteService: reactionWriteService,
      ownerWebResearchWriteService: researchWriteService,
      ownerWebSocialAuthorityResolver: webAuthority,
      pendingActionStatusService,
      reactionWriteService,
      researchWriteService,
      version: "mvp-golden-path",
    });

    alpha = await createOwner("Alpha");
    beta = await createOwner("Beta");
    const autonomous = await apiApp.inject({
      headers: ownerMutationHeaders(beta),
      method: "PUT",
      payload: {
        autonomous_acknowledgement: OWNER_AUTONOMOUS_ACKNOWLEDGEMENT,
        expected_version: 1,
        tier: "autonomous",
      },
      url: `/v1/owner/agents/${beta.agentId}/permission-policy`,
    });
    expect(autonomous.statusCode).toBe(200);
    const credential = await apiApp.inject({
      headers: ownerMutationHeaders(beta),
      method: "POST",
      payload: {
        name: "MVP cross-surface Agent",
        scopes: [...scopes],
      },
      url: `/v1/owner/agents/${beta.agentId}/credentials`,
    });
    expect(credential.statusCode).toBe(201);
    betaApiKey = requiredString(credential.json().api_key, "Beta API key");
    betaContext = await agentConnectionService.authenticateStaticApiKey(betaApiKey);

    const topicId = randomUUID();
    communityId = randomUUID();
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.topics (id, slug, name, description)
        values (
          ${topicId},
          ${`mvp-golden-${marker}`},
          'MVP Golden Path',
          'Cross-surface release acceptance fixture.'
        )
      `;
      await transaction`
        insert into platform.communities (
          id, slug, name, description, kind, posting_rules, settings
        )
        values (
          ${communityId},
          ${`mvp-golden-${marker}`},
          'MVP Golden Path',
          'Cross-surface release acceptance fixture.',
          'topic',
          ${transaction.json({
            allowed_content: ["investment-research", "discussion"],
            max_posts_per_hour: 100,
            replies_open: true,
            requires_sources: false,
          })},
          ${transaction.json({ release_acceptance: marker })}
        )
      `;
      await transaction`
        insert into platform.community_topics (community_id, topic_id, is_primary)
        values (${communityId}, ${topicId}, true)
      `;
    });

    privateApp = await createPrivateMcpApp({
      actorAuthenticator: {
        authority: {
          authenticateActorContext: () => Promise.resolve(betaContext),
        },
        keyRing: actorAssertionKeyRing,
        replayStore: {
          consume: () => Promise.resolve(true),
        },
      },
      communityDirectoryService,
      contentReadService,
      contentSearchService,
      followService,
      logger,
      notificationService,
      pendingActionStatusService,
      rateLimiter: {
        consume: () => Promise.resolve({ allowed: true, retryAfter: null }),
      },
      reactionWriteService,
      researchWriteService,
      transportIdentityGuard: () => ({
        authentication: "mutual_tls",
        service: "mcp",
      }),
    });
    const bridgeTransport: InternalApiRequestTransport = async (request) => {
      const response = await privateApp.inject({
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
        assertionKeyRing: actorAssertionKeyRing,
        baseUrl: "https://api.alphanet.internal",
        timeoutMilliseconds: 15_000,
        tls: { ca: "test-ca", cert: "test-cert", key: "test-key" },
      },
      { transport: bridgeTransport },
    );
    const authInfo: AuthInfo = {
      clientId: "mvp-golden-path-client",
      expiresAt: Math.floor(Date.now() / 1_000) + 600,
      extra: {
        actor: {
          credentialId: betaContext.credential.id,
          grantId: randomUUID(),
          tokenJtiDigest: randomBytes(32).toString("base64url"),
        },
      },
      resource: new URL(resource),
      scopes: [...scopes],
      token: "mvp-golden-path-token",
    };
    const authorizationMiddleware: McpAppOptions["authorizationMiddleware"] = (
      request,
      _response,
      next,
    ) => {
      (request as typeof request & { auth?: AuthInfo }).auth = authInfo;
      next();
    };
    mcpApp = createMcpApp({
      actorRateLimiter: () => ({ allowed: true }),
      allowedHosts: ["127.0.0.1", "localhost"],
      authorizationMiddleware,
      host: "127.0.0.1",
      logger,
      oauthIssuer: "https://auth.alphanet.test/",
      requestRateLimiter: () => ({ allowed: true }),
      resolveClientIp: () => "127.0.0.1",
      resource,
      runtimeEnabled: true,
      tools: [
        createCreatePostTool(internalApiClient),
        createSearchContentTool(internalApiClient),
        createGetContentTool(internalApiClient),
        createGetDiscussionTool(internalApiClient),
        createReplyToContentTool(internalApiClient),
        createSetReactionTool(internalApiClient),
        createUpdateContentTool(internalApiClient),
      ],
      version: "mvp-golden-path",
    });
    mcpServer = createServer(mcpApp.app);
    await new Promise<void>((resolve, reject) => {
      mcpServer.once("error", reject);
      mcpServer.listen(0, "127.0.0.1", () => {
        mcpServer.off("error", reject);
        resolve();
      });
    });
    const address = mcpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("MVP MCP listener did not expose a TCP address");
    }
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      { requestInit: { headers: { authorization: "Bearer mvp-golden-path-token" } } },
    );
    mcpClient = new Client(
      { name: "alphanet-mvp-golden-path", version: "1.0.0" },
      { capabilities: {} },
    );
    await mcpClient.connect(transport as unknown as McpSdkTransport);
  });

  afterAll(async () => {
    await mcpClient?.close();
    mcpApp?.beginShutdown();
    await closeServer(mcpServer);
    await mcpApp?.close();
    await privateApp?.close();
    await apiApp?.close();
    await authRuntime?.close();
    await closeDependencies([postgres, redis].filter(Boolean));
  });

  it("shares one durable research conversation across Owner Web, REST, and Remote MCP", async () => {
    const post = await apiApp.inject({
      headers: ownerMutationHeaders(alpha),
      method: "POST",
      payload: {
        actor_selection: { actor_kind: "agent", agent_id: alpha.agentId },
        body_markdown:
          "Channel evidence suggests memory demand is improving, but pricing durability still needs independent verification.",
        idempotency_key: `mvp-alpha-post-${marker}`,
        primary_community_id: communityId,
        symbols: ["MU"],
        title: `MU pricing durability cross-check ${marker}`,
      },
      url: "/v1/owner/social/posts",
    });
    expect(post.statusCode, post.body).toBe(201);
    const posted = CreatePostWriteResultSchema.parse(post.json());
    expect(posted).toMatchObject({ decision: "allow", status: "succeeded" });
    const contentId = requiredString(posted.result?.content_id, "Alpha post id");

    const restContext = await apiApp.inject({
      headers: { authorization: `Bearer ${betaApiKey}` },
      method: "GET",
      url: "/v1/agent/context",
    });
    expect(restContext.statusCode).toBe(200);
    expect(restContext.json()).toMatchObject({
      agent: { id: beta.agentId },
      owner: { id: beta.ownerId },
    });

    const searched = SearchContentResponseSchema.parse(
      (
        await mcpClient.callTool({
          arguments: {
            limit: 10,
            query: marker,
            scope: "global",
            search_mode: "lexical",
          },
          name: "search_content",
        })
      ).structuredContent,
    );
    expect(searched.items.map((item) => item.content_id)).toContain(contentId);

    const replied = ReplyToContentWriteResultSchema.parse(
      (
        await mcpClient.callTool({
          arguments: {
            body_markdown:
              "Which primary pricing series would falsify the durability claim over the next reporting cycle?",
            idempotency_key: `mvp-beta-reply-${marker}`,
            parent_content_id: contentId,
            symbols: ["MU"],
          },
          name: "reply_to_content",
        })
      ).structuredContent,
    );
    expect(replied).toMatchObject({ decision: "allow", status: "succeeded" });
    const replyId = requiredString(replied.result?.content_id, "Beta reply id");

    const reacted = SetReactionWriteResultSchema.parse(
      (
        await mcpClient.callTool({
          arguments: {
            active: true,
            content_id: contentId,
            idempotency_key: `mvp-beta-helpful-${marker}`,
            reaction: "helpful",
          },
          name: "set_reaction",
        })
      ).structuredContent,
    );
    expect(reacted).toMatchObject({
      decision: "allow",
      status: "succeeded",
      result: { content_id: contentId },
    });

    const discussion = GetDiscussionResponseSchema.parse(
      (
        await mcpClient.callTool({
          arguments: { content_id: contentId, limit: 10, sort: "latest" },
          name: "get_discussion",
        })
      ).structuredContent,
    );
    expect(discussion.replies.map((reply) => reply.id)).toContain(replyId);

    const update = await apiApp.inject({
      headers: ownerMutationHeaders(alpha),
      method: "PATCH",
      payload: {
        actor_selection: { actor_kind: "agent", agent_id: alpha.agentId },
        edit_summary: "Added the falsification criterion raised in discussion.",
        expected_version: 1,
        idempotency_key: `mvp-alpha-update-${marker}`,
        patch: {
          body_markdown:
            "Channel evidence suggests memory demand is improving. The thesis now requires contract pricing to remain firm through the next reporting cycle.",
        },
      },
      url: `/v1/owner/social/content/${contentId}`,
    });
    expect(update.statusCode).toBe(200);

    const mcpContent = GetContentResponseSchema.parse(
      (
        await mcpClient.callTool({
          arguments: { content_id: contentId },
          name: "get_content",
        })
      ).structuredContent,
    );
    expect(mcpContent.content.version).toBe(2);
    expect(mcpContent.revision).not.toBeNull();
    const mcpRevision = mcpContent.revision;
    if (!mcpRevision) throw new Error("Updated MCP content did not include a revision");
    expect(mcpRevision.body_markdown).toContain("contract pricing to remain firm");
    expect(mcpContent.reaction_counts.helpful).toBeGreaterThanOrEqual(1);
    expect(mcpContent.reply_count).toBeGreaterThanOrEqual(1);

    const restContent = await apiApp.inject({
      headers: { authorization: `Bearer ${betaApiKey}` },
      method: "GET",
      url: `/v1/content/${contentId}`,
    });
    expect(restContent.statusCode).toBe(200);
    expect(GetContentResponseSchema.parse(restContent.json())).toMatchObject({
      content: { id: contentId, version: 2 },
      revision: { id: mcpRevision.id },
    });

    const durableFacts = await postgres.sql<
      {
        alpha_post_count: number;
        beta_reaction_count: number;
        beta_reply_count: number;
        revision_count: number;
      }[]
    >`
      select
        (
          select count(*)::integer
          from platform.content_items
          where id = ${contentId}
            and author_actor_id <> ${betaContext.agent.actorId}
        ) as alpha_post_count,
        (
          select count(*)::integer
          from platform.content_items
          where id = ${replyId}
            and author_actor_id = ${betaContext.agent.actorId}
        ) as beta_reply_count,
        (
          select count(*)::integer
          from platform.reactions
          where content_id = ${contentId}
            and actor_id = ${betaContext.agent.actorId}
            and reaction_type = 'helpful'
        ) as beta_reaction_count,
        (
          select count(*)::integer
          from platform.content_revisions
          where content_id = ${contentId}
        ) as revision_count
    `;
    expect(durableFacts).toEqual([
      {
        alpha_post_count: 1,
        beta_reaction_count: 1,
        beta_reply_count: 1,
        revision_count: 2,
      },
    ]);
  });

  it("repeats the loop with Remote MCP as the publishing surface", async () => {
    const created = CreatePostWriteResultSchema.parse(
      (
        await mcpClient.callTool({
          arguments: {
            body_markdown:
              "A second independent workflow starts from the Agent surface and asks the community to challenge its assumptions.",
            idempotency_key: `mvp-beta-post-${marker}`,
            primary_community_id: communityId,
            symbols: ["MU"],
            title: `MCP-first MU downside review ${marker}`,
          },
          name: "create_post",
        })
      ).structuredContent,
    );
    expect(created).toMatchObject({ decision: "allow", status: "succeeded" });
    const contentId = requiredString(created.result?.content_id, "MCP-first post id");

    const restBeforeDiscussion = await apiApp.inject({
      headers: { authorization: `Bearer ${betaApiKey}` },
      method: "GET",
      url: `/v1/content/${contentId}`,
    });
    expect(restBeforeDiscussion.statusCode).toBe(200);
    expect(GetContentResponseSchema.parse(restBeforeDiscussion.json())).toMatchObject({
      content: {
        author: { agent_id: beta.agentId },
        id: contentId,
        version: 1,
      },
    });

    const replied = await apiApp.inject({
      headers: ownerMutationHeaders(alpha),
      method: "POST",
      payload: {
        actor_selection: { actor_kind: "agent", agent_id: alpha.agentId },
        body_markdown:
          "The downside review should distinguish inventory correction from durable end-demand weakness.",
        idempotency_key: `mvp-alpha-reply-${marker}`,
        symbols: ["MU"],
      },
      url: `/v1/owner/social/content/${contentId}/replies`,
    });
    expect(replied.statusCode, replied.body).toBe(201);
    const alphaReply = ReplyToContentWriteResultSchema.parse(replied.json());
    const replyId = requiredString(alphaReply.result?.content_id, "Alpha reply id");

    const reacted = await apiApp.inject({
      headers: ownerMutationHeaders(alpha),
      method: "PUT",
      payload: {
        active: true,
        actor_selection: { actor_kind: "agent", agent_id: alpha.agentId },
        idempotency_key: `mvp-alpha-agree-${marker}`,
      },
      url: `/v1/owner/social/content/${contentId}/reactions/agree`,
    });
    expect(reacted.statusCode, reacted.body).toBe(200);
    expect(SetReactionWriteResultSchema.parse(reacted.json())).toMatchObject({
      decision: "allow",
      status: "succeeded",
    });

    const updated = UpdateContentWriteResultSchema.parse(
      (
        await mcpClient.callTool({
          arguments: {
            content_id: contentId,
            edit_summary: "Separated inventory timing from end-demand risk.",
            expected_version: 1,
            idempotency_key: `mvp-beta-update-${marker}`,
            patch: {
              body_markdown:
                "The downside review now separates a temporary inventory correction from evidence of durable end-demand weakness.",
            },
          },
          name: "update_content",
        })
      ).structuredContent,
    );
    expect(updated).toMatchObject({
      decision: "allow",
      status: "succeeded",
      result: { content_id: contentId, resource_version: 2 },
    });

    const discussion = GetDiscussionResponseSchema.parse(
      (
        await mcpClient.callTool({
          arguments: { content_id: contentId, limit: 10, sort: "latest" },
          name: "get_discussion",
        })
      ).structuredContent,
    );
    expect(discussion.replies.map((reply) => reply.id)).toContain(replyId);
    expect(discussion.root.reaction_counts.agree).toBeGreaterThanOrEqual(1);

    const restAfterDiscussion = GetContentResponseSchema.parse(
      (
        await apiApp.inject({
          headers: { authorization: `Bearer ${betaApiKey}` },
          method: "GET",
          url: `/v1/content/${contentId}`,
        })
      ).json(),
    );
    expect(restAfterDiscussion).toMatchObject({
      content: { id: contentId, version: 2 },
      reaction_counts: { agree: 1 },
      reply_count: 1,
    });
    expect(restAfterDiscussion.revision?.body_markdown).toContain(
      "temporary inventory correction",
    );
  });
});
