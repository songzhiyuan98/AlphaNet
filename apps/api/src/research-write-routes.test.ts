import {
  CreatePostWriteResultSchema,
  DeleteContentWriteResultSchema,
  ReplyToContentWriteResultSchema,
  UpdateContentWriteResultSchema,
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
type CreatePostOutcome = Extract<ResearchWriteOutcome, { operation: "create_post" }>;
type ReplyOutcome = Extract<ResearchWriteOutcome, { operation: "reply_to_content" }>;
type UpdateOutcome = Extract<ResearchWriteOutcome, { operation: "update_content" }>;
type DeleteOutcome = Extract<ResearchWriteOutcome, { operation: "delete_content" }>;

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
      scopes: options?.scopes ?? ["content:write"],
      audience: "urn:alphanet:api:v1",
      policyCeiling: options?.tier ?? "assisted",
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

function pendingOutcome(operation: "create_post"): CreatePostOutcome;
function pendingOutcome(operation: "reply_to_content"): ReplyOutcome;
function pendingOutcome(operation: "update_content"): UpdateOutcome;
function pendingOutcome(operation: "delete_content"): DeleteOutcome;
function pendingOutcome(
  operation: ResearchWriteOutcome["operation"],
): ResearchWriteOutcome {
  const common = {
    decision: "require_approval",
    status: "pending_approval",
    result: null,
    error: null,
    replayed: false,
  } as const;
  const pending = {
    id: ids.action,
    state: "pending_approval" as const,
    expiresAt: new Date(now.valueOf() + 86_400_000),
    inputDigest: `sha256:${"a".repeat(64)}`,
    requestedAt: now,
    decisionId: "b0000000-0000-4000-8000-000000000001",
    policyVersion: `${ids.policy}:1`,
    approvalSummary: "Create research content.",
  };
  switch (operation) {
    case "create_post":
      return {
        ...common,
        operation,
        pendingAction: { ...pending, operation },
      };
    case "reply_to_content":
      return {
        ...common,
        operation,
        pendingAction: { ...pending, operation },
      };
    case "update_content":
      return {
        ...common,
        operation,
        pendingAction: { ...pending, operation, expectedVersion: 2 },
      };
    case "delete_content":
      return {
        ...common,
        operation,
        pendingAction: { ...pending, operation, expectedVersion: 2 },
      };
  }
}

function updateOutcome(): UpdateOutcome {
  return {
    operation: "update_content",
    decision: "allow",
    status: "succeeded",
    result: {
      contentId: ids.content,
      revisionId: ids.revision,
      resourceVersion: 3,
    },
    pendingAction: null,
    error: null,
    replayed: false,
  };
}

function replyOutcome(): ReplyOutcome {
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

function deleteOutcome(): DeleteOutcome {
  return {
    operation: "delete_content",
    decision: "allow",
    status: "succeeded",
    result: {
      contentId: ids.content,
      lifecycleState: "deleted",
      resourceVersion: 3,
    },
    pendingAction: null,
    error: null,
    replayed: false,
  };
}

function deniedOutcome(): CreatePostOutcome {
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

interface WriteErrorOutcomeOptions {
  decision?: ResearchWriteOutcome["decision"] | undefined;
  status?: ResearchWriteOutcome["status"] | undefined;
}

function writeErrorOutcome(
  operation: "create_post",
  code: ResearchWriteErrorCode,
  options?: WriteErrorOutcomeOptions,
): CreatePostOutcome;
function writeErrorOutcome(
  operation: "reply_to_content",
  code: ResearchWriteErrorCode,
  options?: WriteErrorOutcomeOptions,
): ReplyOutcome;
function writeErrorOutcome(
  operation: "update_content",
  code: ResearchWriteErrorCode,
  options?: WriteErrorOutcomeOptions,
): UpdateOutcome;
function writeErrorOutcome(
  operation: "delete_content",
  code: ResearchWriteErrorCode,
  options?: WriteErrorOutcomeOptions,
): DeleteOutcome;
function writeErrorOutcome(
  operation: ResearchWriteOutcome["operation"],
  code: ResearchWriteErrorCode,
  options: WriteErrorOutcomeOptions = {},
): ResearchWriteOutcome {
  const common = {
    decision: options.decision ?? "allow",
    status: options.status ?? "failed",
    result: null,
    pendingAction: null,
    error: new ResearchWriteError(code, `Expected ${code} test failure.`).toDetail(),
    replayed: false,
  };
  switch (operation) {
    case "create_post":
      return { ...common, operation };
    case "reply_to_content":
      return { ...common, operation };
    case "update_content":
      return { ...common, operation };
    case "delete_content":
      return { ...common, operation };
  }
}

function createApp(options?: {
  bodyLimit?: number;
  context?: AgentCredentialContext;
  createPost?: ResearchWriteService["createPost"];
  deleteContent?: ResearchWriteService["deleteContent"];
  rateLimiter?: AgentRequestRateLimiter;
  replyToContent?: ResearchWriteService["replyToContent"];
  updateContent?: ResearchWriteService["updateContent"];
}) {
  const app = Fastify({
    ...(options?.bodyLimit ? { bodyLimit: options.bodyLimit } : {}),
    logger: false,
  });
  const createPost = vi.fn<ResearchWriteService["createPost"]>(
    options?.createPost ?? (() => Promise.resolve(pendingOutcome("create_post"))),
  );
  const deleteContent = vi.fn<ResearchWriteService["deleteContent"]>(
    options?.deleteContent ?? (() => Promise.resolve(deleteOutcome())),
  );
  const replyToContent = vi.fn<ResearchWriteService["replyToContent"]>(
    options?.replyToContent ?? (() => Promise.resolve(replyOutcome())),
  );
  const updateContent = vi.fn<ResearchWriteService["updateContent"]>(
    options?.updateContent ?? (() => Promise.resolve(updateOutcome())),
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
      deleteContent,
      replyToContent,
      updateContent,
    },
  });
  apps.push(app);
  return {
    app,
    authenticateStaticApiKey,
    createPost,
    deleteContent,
    replyToContent,
    updateContent,
  };
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
      expect(insufficientScopeLimit).toHaveBeenCalledTimes(5);
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
      expect(authorizedLimit).toHaveBeenCalledTimes(5);
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
    expect(consume).toHaveBeenCalledTimes(5);
    expect(consume).toHaveBeenCalledWith(`credential:${ids.credential}:agent-api:write`, {
      max: 20,
      window: 60,
    });
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

  it("injects update transport fields, maps the patch, and returns 200", async () => {
    const { app, updateContent } = createApp({
      context: context({ tier: "autonomous" }),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "update-amd-v2",
        "if-match": '"2"',
      },
      method: "PATCH",
      payload: {
        edit_summary: "Refresh evidence and downside case",
        patch: {
          additional_community_ids: [ids.community],
          body_markdown: "Updated downside case with independently checked evidence.",
          references: [{ relation_type: "reference", target_content_id: ids.root }],
          source_links: [{ title: "Filing", url: "https://example.com/filing" }],
          symbols: ["AMD"],
          title: "Updated AMD data-center scenario review",
          topics: ["data-center"],
        },
      },
      url: `/v1/content/${ids.content}`,
    });

    expect(response.statusCode).toBe(200);
    expect(UpdateContentWriteResultSchema.safeParse(response.json()).success).toBe(true);
    expect(updateContent).toHaveBeenCalledOnce();
    expect(updateContent.mock.calls[0]?.[0]?.agent.id).toBe(ids.agent);
    expect(updateContent.mock.calls[0]?.[1]).toEqual({
      contentId: ids.content,
      editSummary: "Refresh evidence and downside case",
      expectedVersion: 2,
      idempotencyKey: "update-amd-v2",
      patch: {
        additionalCommunityIds: [ids.community],
        bodyMarkdown: "Updated downside case with independently checked evidence.",
        references: [{ relationType: "reference", targetContentId: ids.root }],
        sourceLinks: [{ title: "Filing", url: "https://example.com/filing" }],
        symbols: ["AMD"],
        title: "Updated AMD data-center scenario review",
        topics: ["data-center"],
      },
    });
    expect(updateContent.mock.calls[0]?.[2].channel).toBe("rest");
    expect(updateContent.mock.calls[0]?.[2].requestId).toBeTypeOf("string");
  });

  it("returns 202 with the expected version for an update awaiting approval", async () => {
    const { app, updateContent } = createApp({
      updateContent: () => Promise.resolve(pendingOutcome("update_content")),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "update-amd-assisted-v2",
        "if-match": '"2"',
      },
      method: "PATCH",
      payload: { patch: { symbols: ["AMD", "MU"] } },
      url: `/v1/content/${ids.content}`,
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toBe(`/v1/actions/${ids.action}`);
    expect(response.headers["retry-after"]).toBe("5");
    expect(UpdateContentWriteResultSchema.parse(response.json())).toMatchObject({
      decision: "require_approval",
      status: "pending_approval",
      result: null,
      pending_action: {
        operation: "update_content",
        expected_version: 2,
      },
    });
    expect(updateContent).toHaveBeenCalledOnce();
  });

  it("fails closed when an update result does not advance exactly one version", async () => {
    const corrupt = updateOutcome();
    corrupt.result = { ...corrupt.result!, resourceVersion: 4 };
    const { app } = createApp({
      updateContent: () => Promise.resolve(corrupt),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "update-corrupt-version",
        "if-match": '"2"',
      },
      method: "PATCH",
      payload: { patch: { symbols: ["AMD"] } },
      url: `/v1/content/${ids.content}`,
    });

    expect(response.statusCode).toBe(503);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "WRITE_UNAVAILABLE",
    );
  });

  it("injects delete transport fields, maps a soft-delete request, and returns 200", async () => {
    const { app, deleteContent } = createApp({
      context: context({ tier: "autonomous" }),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "delete-amd-v2",
        "if-match": '"2"',
      },
      method: "DELETE",
      payload: {
        mode: "soft",
        reason: "Superseded by independently verified evidence.",
      },
      url: `/v1/content/${ids.content}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(DeleteContentWriteResultSchema.parse(response.json())).toMatchObject({
      decision: "allow",
      status: "succeeded",
      result: {
        content_id: ids.content,
        lifecycle_state: "deleted",
        resource_version: 3,
      },
      pending_action: null,
      error: null,
    });
    expect(deleteContent).toHaveBeenCalledOnce();
    expect(deleteContent.mock.calls[0]?.[0].agent.id).toBe(ids.agent);
    expect(deleteContent.mock.calls[0]?.[1]).toEqual({
      contentId: ids.content,
      expectedVersion: 2,
      idempotencyKey: "delete-amd-v2",
      mode: "soft",
      reason: "Superseded by independently verified evidence.",
    });
    expect(deleteContent.mock.calls[0]?.[2].channel).toBe("rest");
    expect(deleteContent.mock.calls[0]?.[2].requestId).toBeTypeOf("string");
  });

  it("returns 202 and the optimistic version for a delete awaiting approval", async () => {
    const { app, deleteContent } = createApp({
      deleteContent: () => Promise.resolve(pendingOutcome("delete_content")),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "delete-amd-assisted-v2",
        "if-match": '"2"',
      },
      method: "DELETE",
      payload: { mode: "soft" },
      url: `/v1/content/${ids.content}`,
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toBe(`/v1/actions/${ids.action}`);
    expect(response.headers["retry-after"]).toBe("5");
    expect(DeleteContentWriteResultSchema.parse(response.json())).toMatchObject({
      decision: "require_approval",
      status: "pending_approval",
      result: null,
      pending_action: {
        operation: "delete_content",
        expected_version: 2,
      },
    });
    expect(deleteContent).toHaveBeenCalledOnce();
  });

  it("returns an approved delete replay as 200 with its terminal action", async () => {
    const approved = deleteOutcome();
    approved.decision = "require_approval";
    approved.pendingAction = {
      ...pendingOutcome("delete_content").pendingAction!,
      state: "succeeded",
    };
    const { app } = createApp({ deleteContent: () => Promise.resolve(approved) });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "delete-amd-approved-v2",
        "if-match": '"2"',
      },
      method: "DELETE",
      payload: { mode: "soft" },
      url: `/v1/content/${ids.content}`,
    });

    expect(response.statusCode).toBe(200);
    expect(DeleteContentWriteResultSchema.parse(response.json())).toMatchObject({
      decision: "require_approval",
      status: "succeeded",
      result: { resource_version: 3 },
      pending_action: {
        operation: "delete_content",
        expected_version: 2,
        state: "succeeded",
      },
    });
  });

  it.each([
    {
      headers: { "idempotency-key": "delete-missing-version" },
      label: "a missing If-Match",
      payload: { mode: "soft" },
    },
    {
      headers: { "idempotency-key": "delete-bare-version", "if-match": "2" },
      label: "a non-entity-tag If-Match",
      payload: { mode: "soft" },
    },
    {
      headers: { "idempotency-key": "delete-missing-mode", "if-match": '"2"' },
      label: "a missing mode",
      payload: {},
    },
    {
      headers: { "idempotency-key": "delete-invalid-mode", "if-match": '"2"' },
      label: "an unknown mode",
      payload: { mode: "archive" },
    },
    {
      headers: { "idempotency-key": "delete-private-field", "if-match": '"2"' },
      label: "a transport-owned expected_version body field",
      payload: { expected_version: 2, mode: "soft" },
    },
    {
      headers: { "idempotency-key": "delete-private-content", "if-match": '"2"' },
      label: "a transport-owned content_id body field",
      payload: { content_id: ids.root, mode: "soft" },
    },
    {
      headers: { "idempotency-key": "delete-private-key", "if-match": '"2"' },
      label: "a transport-owned idempotency_key body field",
      payload: { idempotency_key: "body-key", mode: "soft" },
    },
    {
      headers: { "idempotency-key": "delete-unknown-field", "if-match": '"2"' },
      label: "an unknown body field",
      payload: { mode: "soft", private_note: "must not be accepted" },
    },
    {
      headers: { "idempotency-key": "delete-untrimmed-reason", "if-match": '"2"' },
      label: "an untrimmed reason",
      payload: { mode: "soft", reason: " private reason " },
    },
    {
      headers: { "if-match": '"2"' },
      label: "a missing idempotency key",
      payload: { mode: "soft" },
    },
  ])("rejects $label before invoking delete", async ({ headers, payload }) => {
    const { app, deleteContent } = createApp();
    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}`, ...headers },
      method: "DELETE",
      payload,
      url: `/v1/content/${ids.content}`,
    });

    expect(response.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "VALIDATION_ERROR",
    );
    expect(deleteContent).not.toHaveBeenCalled();
  });

  it("requires exactly one If-Match and Idempotency-Key field line for delete", async () => {
    const { app, deleteContent } = createApp();
    const duplicateIfMatch: Record<string, string | string[]> = {
      "if-match": ['"2"', '"3"'],
    };
    const duplicatedVersion = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "delete-duplicate-version",
        ...duplicateIfMatch,
      },
      method: "DELETE",
      payload: { mode: "soft" },
      url: `/v1/content/${ids.content}`,
    });
    const duplicateIdempotencyKey: Record<string, string | string[]> = {
      "idempotency-key": ["delete-one", "delete-two"],
    };
    const duplicatedKey = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "if-match": '"2"',
        ...duplicateIdempotencyKey,
      },
      method: "DELETE",
      payload: { mode: "soft" },
      url: `/v1/content/${ids.content}`,
    });

    expect(duplicatedVersion.statusCode).toBe(422);
    expect(duplicatedKey.statusCode).toBe(422);
    expect(deleteContent).not.toHaveBeenCalled();
  });

  it.each([
    { code: "CONTENT_NOT_FOUND" as const, statusCode: 404 },
    { code: "NOT_CONTENT_AUTHOR" as const, statusCode: 403 },
    { code: "VERSION_CONFLICT" as const, statusCode: 409 },
    { code: "POLICY_DENIED" as const, statusCode: 403 },
  ])("maps delete $code into its write-result contract", async ({ code, statusCode }) => {
    const { app } = createApp({
      context: context({ tier: "autonomous" }),
      deleteContent: () =>
        Promise.resolve(
          writeErrorOutcome("delete_content", code, {
            ...(code === "POLICY_DENIED" ? { decision: "deny", status: "denied" } : {}),
          }),
        ),
    });
    const privateReason = "PRIVATE-DELETE-REASON-MARKER";
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": `delete-${code.toLowerCase()}`,
        "if-match": '"2"',
      },
      method: "DELETE",
      payload: { mode: "soft", reason: privateReason },
      url: `/v1/content/${ids.content}`,
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.body).not.toContain(privateReason);
    expect(DeleteContentWriteResultSchema.parse(response.json())).toMatchObject({
      status: code === "POLICY_DENIED" ? "denied" : "failed",
      result: null,
      pending_action: null,
      error: { code },
    });
  });

  it("fails closed when a delete projection targets another content version", async () => {
    const corrupt = deleteOutcome();
    corrupt.result = { ...corrupt.result!, resourceVersion: 4 };
    const { app } = createApp({ deleteContent: () => Promise.resolve(corrupt) });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "delete-corrupt-version",
        "if-match": '"2"',
      },
      method: "DELETE",
      payload: { mode: "soft" },
      url: `/v1/content/${ids.content}`,
    });

    expect(response.statusCode).toBe(503);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "WRITE_UNAVAILABLE",
    );
  });

  it.each<{
    headers: Record<string, string | string[]>;
    label: string;
  }>([
    { label: "missing If-Match", headers: {} },
    { label: "a weak tag", headers: { "if-match": 'W/"2"' } },
    { label: "a bare number", headers: { "if-match": "2" } },
    { label: "a zero version", headers: { "if-match": '"0"' } },
    { label: "a signed version", headers: { "if-match": '"+2"' } },
    { label: "a decimal version", headers: { "if-match": '"2.0"' } },
    {
      label: "an unsafe integer",
      headers: { "if-match": '"9007199254740992"' },
    },
    { label: "a comma list", headers: { "if-match": '"2", "3"' } },
    {
      label: "duplicate field lines",
      headers: { "if-match": ['"2"', '"3"'] },
    },
  ])("rejects $label as an update precondition", async ({ headers }) => {
    const { app, updateContent } = createApp();
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "update-invalid-precondition",
        ...headers,
      },
      method: "PATCH",
      payload: { patch: { symbols: ["AMD"] } },
      url: `/v1/content/${ids.content}`,
    });

    expect(response.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "VALIDATION_ERROR",
    );
    expect(updateContent).not.toHaveBeenCalled();
  });

  it.each([
    { expected_version: 2 },
    { content_id: ids.root },
    { idempotency_key: "forged-body-key" },
  ])("rejects transport-owned update body fields", async (forgedField) => {
    const { app, updateContent } = createApp();
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "update-forged-body",
        "if-match": '"2"',
      },
      method: "PATCH",
      payload: { ...forgedField, patch: { symbols: ["AMD"] } },
      url: `/v1/content/${ids.content}`,
    });

    expect(response.statusCode).toBe(422);
    expect(updateContent).not.toHaveBeenCalled();
  });

  it("requires exactly one transport Idempotency-Key for updates", async () => {
    const { app, updateContent } = createApp();
    const request = {
      method: "PATCH" as const,
      payload: { patch: { symbols: ["AMD"] } },
      url: `/v1/content/${ids.content}`,
    };
    const missing = await app.inject({
      ...request,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "if-match": '"2"',
      },
    });
    const duplicated = await app.inject({
      ...request,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": ["update-one", "update-two"],
        "if-match": '"2"',
      },
    });

    expect(missing.statusCode).toBe(422);
    expect(duplicated.statusCode).toBe(422);
    expect(updateContent).not.toHaveBeenCalled();
  });

  it.each([
    { code: "NOT_CONTENT_AUTHOR" as const, statusCode: 403 },
    { code: "VERSION_CONFLICT" as const, statusCode: 409 },
  ])("maps update $code without exposing request UGC", async ({ code, statusCode }) => {
    const { app } = createApp({
      context: context({ tier: "autonomous" }),
      updateContent: () => Promise.resolve(writeErrorOutcome("update_content", code)),
    });
    const privateMarker = "PRIVATE-UPDATE-DRAFT-MARKER";
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": `update-${code.toLowerCase()}`,
        "if-match": '"2"',
      },
      method: "PATCH",
      payload: { patch: { body_markdown: privateMarker } },
      url: `/v1/content/${ids.content}`,
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.body).not.toContain(privateMarker);
    expect(UpdateContentWriteResultSchema.parse(response.json())).toMatchObject({
      decision: "allow",
      status: "failed",
      result: null,
      pending_action: null,
      error: { code },
    });
  });

  it("fails closed on a mismatched update projection without leaking approval text", async () => {
    const invalidOutcome = pendingOutcome("update_content");
    invalidOutcome.pendingAction = {
      ...invalidOutcome.pendingAction!,
      approvalSummary: "PRIVATE-UPDATE-APPROVAL-MARKER",
      expectedVersion: 3,
    };
    const { app } = createApp({
      updateContent: () => Promise.resolve(invalidOutcome),
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "update-invalid-projection",
        "if-match": '"2"',
      },
      method: "PATCH",
      payload: { patch: { symbols: ["AMD"] } },
      url: `/v1/content/${ids.content}`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("PRIVATE-UPDATE-APPROVAL-MARKER");
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "WRITE_UNAVAILABLE",
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
    { code: "DUPLICATE_CONTENT" as const, statusCode: 409 },
  ])(
    "returns $code in the create-post write-result shape",
    async ({ code, statusCode }) => {
      const { app } = createApp({
        context: context({ tier: "autonomous" }),
        createPost: () =>
          Promise.resolve(
            writeErrorOutcome("create_post", code, {
              ...(code === "DUPLICATE_CONTENT"
                ? { decision: "deny", status: "denied" }
                : {}),
            }),
          ),
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
        decision: code === "DUPLICATE_CONTENT" ? "deny" : "allow",
        status: code === "DUPLICATE_CONTENT" ? "denied" : "failed",
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
    Reflect.set(invalidOutcome, "operation", "reply_to_content");
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
