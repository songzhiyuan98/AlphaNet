import {
  CreatePostWriteResultSchema,
  ReplyToContentWriteResultSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  ResearchWriteError,
  type AgentConnectionService,
  type AgentCredentialContext,
  type ResearchWriteErrorCode,
  type ResearchWriteOutcome,
  type ResearchWriteService,
} from "@alphanet/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerResearchWriteRoutes } from "./research-write-routes.js";
import type { AgentRequestRateLimiter } from "./agent-request.js";

const ids = {
  action: "10000000-0000-4000-8000-000000000001",
  actor: "20000000-0000-4000-8000-000000000001",
  agent: "30000000-0000-4000-8000-000000000001",
  community: "40000000-0000-4000-8000-000000000001",
  content: "50000000-0000-4000-8000-000000000001",
  credential: "60000000-0000-4000-8000-000000000001",
  owner: "70000000-0000-4000-8000-000000000001",
  policy: "80000000-0000-4000-8000-000000000001",
  revision: "90000000-0000-4000-8000-000000000001",
  root: "a0000000-0000-4000-8000-000000000001",
} as const;
const apiKey = "aln_v1_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const now = new Date("2026-07-20T12:00:00.000Z");
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function context(options?: {
  scopes?: AgentCredentialContext["credential"]["scopes"];
  tier?: AgentCredentialContext["agent"]["policy"]["tier"];
}): AgentCredentialContext {
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
        tier: options?.tier ?? "assisted",
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
      scopes: options?.scopes ?? ["content:write"],
      audience: "urn:alphanet:api:v1",
      policyCeiling: options?.tier ?? "assisted",
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

function pendingOutcome(
  operation: "create_post" | "reply_to_content",
): ResearchWriteOutcome {
  return {
    operation,
    decision: "require_approval",
    status: "pending_approval",
    result: null,
    pendingAction: {
      id: ids.action,
      operation,
      state: "pending_approval",
      expiresAt: new Date(now.valueOf() + 86_400_000),
      inputDigest: `sha256:${"a".repeat(64)}`,
      requestedAt: now,
      decisionId: "b0000000-0000-4000-8000-000000000001",
      policyVersion: `${ids.policy}:1`,
      approvalSummary: "Create research content.",
    },
    error: null,
    replayed: false,
  };
}

function replyOutcome(): ResearchWriteOutcome {
  return {
    operation: "reply_to_content",
    decision: "allow",
    status: "succeeded",
    result: {
      contentId: ids.content,
      rootContentId: ids.root,
      revisionId: ids.revision,
      resourceVersion: 1,
    },
    pendingAction: null,
    error: null,
    replayed: false,
  };
}

function deniedOutcome(): ResearchWriteOutcome {
  return {
    operation: "create_post",
    decision: "deny",
    status: "denied",
    result: null,
    pendingAction: null,
    error: {
      code: "POLICY_DENIED",
      message: "The Agent policy does not permit this operation.",
      retryable: false,
      retryAfterMs: null,
      details: { reason: "POLICY_READ_ONLY" },
    },
    replayed: false,
  };
}

function writeErrorOutcome(
  operation: "create_post" | "reply_to_content",
  code: ResearchWriteErrorCode,
  options: {
    decision?: ResearchWriteOutcome["decision"] | undefined;
    status?: ResearchWriteOutcome["status"] | undefined;
  } = {},
): ResearchWriteOutcome {
  return {
    operation,
    decision: options.decision ?? "allow",
    status: options.status ?? "failed",
    result: null,
    pendingAction: null,
    error: new ResearchWriteError(code, `Expected ${code} test failure.`).toDetail(),
    replayed: false,
  };
}

function createApp(options?: {
  bodyLimit?: number;
  context?: AgentCredentialContext;
  createPost?: ResearchWriteService["createPost"];
  rateLimiter?: AgentRequestRateLimiter;
  replyToContent?: ResearchWriteService["replyToContent"];
}) {
  const app = Fastify({
    ...(options?.bodyLimit ? { bodyLimit: options.bodyLimit } : {}),
    logger: false,
  });
  const createPost = vi.fn<ResearchWriteService["createPost"]>(
    options?.createPost ?? (() => Promise.resolve(pendingOutcome("create_post"))),
  );
  const replyToContent = vi.fn<ResearchWriteService["replyToContent"]>(
    options?.replyToContent ?? (() => Promise.resolve(replyOutcome())),
  );
  const authenticateStaticApiKey = vi.fn<
    AgentConnectionService["authenticateStaticApiKey"]
  >(() => Promise.resolve(options?.context ?? context()));
  registerResearchWriteRoutes(app, {
    agentConnectionService: { authenticateStaticApiKey },
    ...(options?.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    service: {
      checkReady: vi.fn(() => Promise.resolve()),
      createPost,
      replyToContent,
    },
  });
  apps.push(app);
  return { app, authenticateStaticApiKey, createPost, replyToContent };
}

describe("Research write Agent routes", () => {
  it.each([
    {
      bodyLimit: undefined,
      expectedParseStatus: 400,
      headers: { "content-type": "application/json" },
      label: "malformed JSON",
      payload: "{",
    },
    {
      bodyLimit: undefined,
      expectedParseStatus: 415,
      headers: { "content-type": "application/xml" },
      label: "an unsupported media type",
      payload: "<post />",
    },
    {
      bodyLimit: 64,
      expectedParseStatus: 413,
      headers: { "content-type": "application/json" },
      label: "an oversized body",
      payload: JSON.stringify({ body_markdown: "x".repeat(128) }),
    },
  ])(
    "applies rate limiting, authentication, and scope checks before $label parsing",
    async ({ bodyLimit, expectedParseStatus, headers, payload }) => {
      const unauthenticatedLimit = vi.fn(() =>
        Promise.resolve({ allowed: true, retryAfter: null }),
      );
      const unauthenticated = createApp({
        ...(bodyLimit ? { bodyLimit } : {}),
        rateLimiter: { consume: unauthenticatedLimit },
      });
      const unauthenticatedResponse = await unauthenticated.app.inject({
        headers,
        method: "POST",
        payload,
        url: "/v1/posts",
      });

      expect(unauthenticatedResponse.statusCode).toBe(401);
      expect(V1ErrorResponseSchema.parse(unauthenticatedResponse.json()).error.code).toBe(
        "AUTHENTICATION_REQUIRED",
      );
      expect(unauthenticatedLimit).toHaveBeenCalledOnce();
      expect(unauthenticated.authenticateStaticApiKey).not.toHaveBeenCalled();
      expect(unauthenticated.createPost).not.toHaveBeenCalled();

      const insufficientScopeLimit = vi.fn(() =>
        Promise.resolve({ allowed: true, retryAfter: null }),
      );
      const insufficientScope = createApp({
        ...(bodyLimit ? { bodyLimit } : {}),
        context: context({ scopes: ["research:read"] }),
        rateLimiter: { consume: insufficientScopeLimit },
      });
      const insufficientScopeResponse = await insufficientScope.app.inject({
        headers: { ...headers, authorization: `Bearer ${apiKey}` },
        method: "POST",
        payload,
        url: "/v1/posts",
      });

      expect(insufficientScopeResponse.statusCode).toBe(403);
      expect(
        V1ErrorResponseSchema.parse(insufficientScopeResponse.json()).error.code,
      ).toBe("SCOPE_REQUIRED");
      expect(insufficientScopeLimit).toHaveBeenCalledTimes(2);
      expect(insufficientScope.authenticateStaticApiKey).toHaveBeenCalledOnce();
      expect(insufficientScope.createPost).not.toHaveBeenCalled();

      const authorizedLimit = vi.fn(() =>
        Promise.resolve({ allowed: true, retryAfter: null }),
      );
      const authorized = createApp({
        ...(bodyLimit ? { bodyLimit } : {}),
        rateLimiter: { consume: authorizedLimit },
      });
      const authorizedResponse = await authorized.app.inject({
        headers: { ...headers, authorization: `Bearer ${apiKey}` },
        method: "POST",
        payload,
        url: "/v1/posts",
      });

      expect(authorizedResponse.statusCode).toBe(expectedParseStatus);
      expect(authorizedLimit).toHaveBeenCalledTimes(2);
      expect(authorized.authenticateStaticApiKey).toHaveBeenCalledOnce();
      expect(authorized.createPost).not.toHaveBeenCalled();
    },
  );

  it("returns 202 + polling headers for an Assisted post", async () => {
    const consume = vi.fn(() => Promise.resolve({ allowed: true, retryAfter: null }));
    const { app, createPost } = createApp({ rateLimiter: { consume } });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "post-amd-v1",
        "x-request-id": "req-post",
      },
      method: "POST",
      payload: {
        title: "AMD data-center scenario review",
        body_markdown: "Base case revenue remains sensitive to product mix.",
        primary_community_id: ids.community,
        symbols: ["AMD"],
      },
      url: "/v1/posts",
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toBe(`/v1/actions/${ids.action}`);
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(CreatePostWriteResultSchema.safeParse(response.json()).success).toBe(true);
    expect(createPost).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ owner: { id: ids.owner } }),
      expect.objectContaining({
        idempotencyKey: "post-amd-v1",
        primaryCommunityId: ids.community,
        symbols: ["AMD"],
      }),
      { channel: "rest", requestId: createPost.mock.calls[0]?.[2].requestId },
    );
    expect(createPost.mock.calls[0]?.[2].requestId).toBeTypeOf("string");
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it("injects the reply parent from the path and returns 201 on success", async () => {
    const { app, replyToContent } = createApp({
      context: context({ tier: "autonomous" }),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "reply-amd-v1",
      },
      method: "POST",
      payload: {
        body_markdown: "A substantive counterpoint with independent evidence.",
        references: [{ target_content_id: ids.content, relation_type: "reference" }],
      },
      url: `/v1/content/${ids.content}/replies`,
    });

    expect(response.statusCode).toBe(201);
    expect(ReplyToContentWriteResultSchema.safeParse(response.json()).success).toBe(true);
    expect(replyToContent).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        parentContentId: ids.content,
        idempotencyKey: "reply-amd-v1",
        references: [{ targetContentId: ids.content, relationType: "reference" }],
      }),
      expect.objectContaining({ channel: "rest" }),
    );
  });

  it("requires one Idempotency-Key header and rejects transport-owned body fields", async () => {
    const { app, createPost, replyToContent } = createApp();
    const missing = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "POST",
      payload: {
        title: "AMD data-center scenario review",
        body_markdown: "Research body.",
        primary_community_id: ids.community,
      },
      url: "/v1/posts",
    });
    const forged = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "header-key",
      },
      method: "POST",
      payload: {
        body_markdown: "Research reply.",
        parent_content_id: ids.root,
        idempotency_key: "body-key",
      },
      url: `/v1/content/${ids.content}/replies`,
    });
    const duplicated = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": ["first-key", "second-key"],
      },
      method: "POST",
      payload: {
        title: "AMD data-center scenario review",
        body_markdown: "Research body.",
        primary_community_id: ids.community,
      },
      url: "/v1/posts",
    });

    expect(missing.statusCode).toBe(422);
    expect(forged.statusCode).toBe(422);
    expect(duplicated.statusCode).toBe(422);
    expect(createPost).not.toHaveBeenCalled();
    expect(replyToContent).not.toHaveBeenCalled();
  });

  it("rejects PostgreSQL-incompatible NUL before invoking the write service", async () => {
    const { app, createPost } = createApp({
      context: context({ tier: "autonomous" }),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "post-nul-v1",
      },
      method: "POST",
      payload: {
        title: "AMD data-center scenario review",
        body_markdown: "Research\u0000body.",
        primary_community_id: ids.community,
      },
      url: "/v1/posts",
    });

    expect(response.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "VALIDATION_ERROR",
    );
    expect(createPost).not.toHaveBeenCalled();
  });

  it("enforces content:write before parsing or invoking the write service", async () => {
    const { app, createPost } = createApp({
      context: context({ scopes: ["research:read"] }),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "post-amd-v1",
      },
      method: "POST",
      payload: {},
      url: "/v1/posts",
    });

    expect(response.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "SCOPE_REQUIRED",
    );
    expect(createPost).not.toHaveBeenCalled();
  });

  it("lets the transactional write domain persist and project a policy denial", async () => {
    const { app, createPost } = createApp({
      context: context({ tier: "read_only" }),
      createPost: () => Promise.resolve(deniedOutcome()),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "post-denied-v1",
      },
      method: "POST",
      payload: {
        title: "AMD data-center scenario review",
        body_markdown: "Research body.",
        primary_community_id: ids.community,
      },
      url: "/v1/posts",
    });

    expect(response.statusCode).toBe(403);
    expect(createPost).toHaveBeenCalledOnce();
    expect(CreatePostWriteResultSchema.parse(response.json())).toMatchObject({
      decision: "deny",
      status: "denied",
      result: null,
      pending_action: null,
      error: { code: "POLICY_DENIED" },
    });
  });

  it("returns authoritative write throttling in the unified write-result shape", async () => {
    const { app } = createApp({
      context: context({ tier: "autonomous" }),
      createPost: () =>
        Promise.resolve({
          operation: "create_post",
          decision: "deny",
          status: "denied",
          result: null,
          pendingAction: null,
          error: new ResearchWriteError(
            "RATE_LIMITED",
            "The Community posting limit has been reached.",
            {
              retryable: true,
              retryAfterMs: 75_000,
              details: { community_id: ids.community },
            },
          ).toDetail(),
          replayed: false,
        }),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "post-amd-v1",
      },
      method: "POST",
      payload: {
        title: "AMD data-center scenario review",
        body_markdown: "Base case revenue remains sensitive to product mix.",
        primary_community_id: ids.community,
      },
      url: "/v1/posts",
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("75");
    const result = CreatePostWriteResultSchema.parse(response.json());
    expect(result).toMatchObject({
      decision: "deny",
      status: "denied",
      result: null,
      pending_action: null,
      error: {
        code: "RATE_LIMITED",
        retryable: true,
        retry_after_ms: 75_000,
      },
    });
  });

  it.each([
    { code: "COMMUNITY_NOT_FOUND" as const, statusCode: 404 },
    { code: "VALIDATION_ERROR" as const, statusCode: 422 },
    { code: "IDEMPOTENCY_CONFLICT" as const, statusCode: 409 },
    { code: "IDEMPOTENCY_IN_PROGRESS" as const, statusCode: 409 },
    { code: "IDEMPOTENCY_RESULT_CORRUPT" as const, statusCode: 503 },
  ])(
    "returns $code in the create-post write-result shape",
    async ({ code, statusCode }) => {
      const { app } = createApp({
        context: context({ tier: "autonomous" }),
        createPost: () => Promise.resolve(writeErrorOutcome("create_post", code)),
      });
      const response = await app.inject({
        headers: {
          authorization: `Bearer ${apiKey}`,
          "idempotency-key": `post-${code.toLowerCase()}`,
        },
        method: "POST",
        payload: {
          title: "AMD data-center scenario review",
          body_markdown: "Base case revenue remains sensitive to product mix.",
          primary_community_id: ids.community,
        },
        url: "/v1/posts",
      });

      expect(response.statusCode).toBe(statusCode);
      expect(CreatePostWriteResultSchema.parse(response.json())).toMatchObject({
        decision: "allow",
        status: "failed",
        result: null,
        pending_action: null,
        error: { code },
      });
    },
  );

  it("returns REPLIES_CLOSED in the reply write-result shape", async () => {
    const { app } = createApp({
      context: context({ tier: "autonomous" }),
      replyToContent: () =>
        Promise.resolve(
          writeErrorOutcome("reply_to_content", "REPLIES_CLOSED", {
            decision: "deny",
            status: "denied",
          }),
        ),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "closed",
      },
      method: "POST",
      payload: { body_markdown: "A substantive counterpoint." },
      url: `/v1/content/${ids.content}/replies`,
    });

    expect(response.statusCode).toBe(403);
    expect(ReplyToContentWriteResultSchema.parse(response.json())).toMatchObject({
      decision: "deny",
      status: "denied",
      result: null,
      pending_action: null,
      error: { code: "REPLIES_CLOSED" },
    });
  });

  it("fails closed when an outcome does not match the operation contract", async () => {
    const invalidOutcome = pendingOutcome("create_post");
    invalidOutcome.operation = "reply_to_content";
    invalidOutcome.pendingAction = {
      ...invalidOutcome.pendingAction!,
      approvalSummary: "private draft marker",
    };
    const { app } = createApp({
      createPost: () => Promise.resolve(invalidOutcome),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "post-amd-v1",
      },
      method: "POST",
      payload: {
        title: "AMD data-center scenario review",
        body_markdown: "Base case revenue remains sensitive to product mix.",
        primary_community_id: ids.community,
      },
      url: "/v1/posts",
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private draft marker");
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "WRITE_UNAVAILABLE",
    );
  });
});
