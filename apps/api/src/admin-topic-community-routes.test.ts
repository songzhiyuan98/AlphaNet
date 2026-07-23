import type { OidcJwtVerifier, VerifiedOidcJwtIdentity } from "@alphanet/auth";
import {
  AdminTopicCommunityListResponseSchema,
  AdminTopicCommunityMutationResponseSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  TopicCommunityManagementError,
  type TopicCommunityManagementService,
  type TopicCommunityMutation,
  type TopicCommunityPage,
} from "@alphanet/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminRequestRateLimiter, AdminRequestRuntime } from "./admin-request.js";
import { registerAdminTopicCommunityRoutes } from "./admin-topic-community-routes.js";

const ids = {
  action: "20000000-0000-4000-8000-000000000001",
  admin: "20000000-0000-4000-8000-000000000002",
  community: "20000000-0000-4000-8000-000000000003",
  topic: "20000000-0000-4000-8000-000000000004",
} as const;
const token = "a.b.c";
const now = new Date("2026-07-23T18:00:00.000Z");
const apps: FastifyInstance[] = [];

const identity: VerifiedOidcJwtIdentity = {
  issuer: "https://login.alphanet.test/workforce",
  mfa: {
    amrMfa: true,
    matchedAcr: "urn:alphanet:assurance:mfa",
    method: "acr_and_amr_mfa",
  },
  subject: "community-manager-01",
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function allowAllLimiter(): AdminRequestRateLimiter {
  return {
    consume: vi.fn(() => Promise.resolve({ allowed: true, retryAfter: null })),
  };
}

function mutation(
  action: "create" | "update" | "archive" = "create",
  replayed = false,
): TopicCommunityMutation {
  const version = action === "create" ? 1 : 2;
  return {
    action: {
      action,
      actionId: ids.action,
      adminId: ids.admin,
      communityVersionAfter: version,
      communityVersionBefore: action === "create" ? null : 1,
      occurredAt: now,
      permissionUsed: "community:manage",
    },
    community: {
      canonicalTopic: { id: ids.topic, slug: "semiconductors" },
      contentCount: 0,
      createdAt: now,
      descriptionMarkdown: "Agent semiconductor research and discussion.",
      id: ids.community,
      kind: "topic",
      name: "Semiconductors",
      postingPolicy: {
        allowedContent: ["investment-research", "discussion"],
        maxPostsPerHour: 6,
        repliesOpen: true,
        requiresSources: false,
      },
      slug: "semiconductors",
      state: action === "archive" ? "archived" : "active",
      updatedAt: now,
      version,
    },
    replayed,
  };
}

function page(): TopicCommunityPage {
  return {
    asOf: now,
    hasMore: false,
    items: [{ ...mutation().community, contentCount: 12 }],
    limit: 25,
    nextCursor: null,
    orderingVersion: "topic-community-created-keyset-v1",
    snapshotId: "20000000-0000-4000-8000-000000000005",
  };
}

function createApp(
  options: {
    createError?: Error;
    createResult?: TopicCommunityMutation;
    listResult?: TopicCommunityPage;
    updateResult?: TopicCommunityMutation;
  } = {},
) {
  const verify = vi.fn<OidcJwtVerifier["verify"]>(() => Promise.resolve(identity));
  const runtime: AdminRequestRuntime = {
    audit: { recordSecurityRejection: vi.fn(() => Promise.resolve()) },
    identityVerifier: { verify },
    rateLimiter: allowAllLimiter(),
    repository: {
      resolveActiveAuthorization: vi.fn(() =>
        Promise.resolve({
          adminId: ids.admin,
          permissions: ["community:manage"] as const,
          roles: ["community_manager"] as const,
        }),
      ),
    },
    resolveClientIp: () => "203.0.113.20",
  };
  const create = vi.fn<TopicCommunityManagementService["create"]>(() => {
    if (options.createError) return Promise.reject(options.createError);
    return Promise.resolve(options.createResult ?? mutation());
  });
  const update = vi.fn<TopicCommunityManagementService["update"]>(() =>
    Promise.resolve(options.updateResult ?? mutation("update")),
  );
  const list = vi.fn<TopicCommunityManagementService["list"]>(() =>
    Promise.resolve(options.listResult ?? page()),
  );
  const app = Fastify({ logger: false });
  registerAdminTopicCommunityRoutes(app, {
    adminRuntime: runtime,
    service: { create, list, update },
  });
  apps.push(app);
  return { app, create, list, update, verify };
}

const authorization = { authorization: `Bearer ${token}` };

describe("Admin topic-community routes", () => {
  it("lists topic communities with exact filters and affected content counts", async () => {
    const { app, list, verify } = createApp();
    const response = await app.inject({
      headers: authorization,
      method: "GET",
      url: "/v1/admin/topic-communities?states=active,archived&query=semi&limit=25",
    });

    expect(response.statusCode).toBe(200);
    expect(AdminTopicCommunityListResponseSchema.parse(response.json())).toMatchObject({
      capabilities: { can_manage: true },
      items: [{ content_count: 12, id: ids.community }],
      page: { has_more: false, limit: 25, next_cursor: null },
    });
    expect(verify).toHaveBeenCalledExactlyOnceWith(token);
    expect(list).toHaveBeenCalledOnce();
    expect(list.mock.calls[0]?.[1]).toEqual({
      limit: 25,
      query: "semi",
      states: ["active", "archived"],
    });
  });

  it("rejects duplicate, unknown, and non-canonical list filters before the service", async () => {
    const { app, list } = createApp();
    for (const query of [
      "states=active&states=archived",
      "states=active,active",
      "limit=025",
      "limit=101",
      "query=",
      "cursor=",
      "unexpected=true",
    ]) {
      const response = await app.inject({
        headers: authorization,
        method: "GET",
        url: `/v1/admin/topic-communities?${query}`,
      });
      expect(response.statusCode).toBe(422);
      expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
        "INVALID_ARGUMENT",
      );
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("creates a topic community through workforce OIDC and projects a strict response", async () => {
    const { app, create, verify } = createApp();
    const response = await app.inject({
      headers: { ...authorization, "idempotency-key": "create-semiconductors" },
      method: "POST",
      payload: {
        description_markdown: "Agent semiconductor research and discussion.",
        name: "Semiconductors",
        slug: "semiconductors",
      },
      url: "/v1/admin/topic-communities",
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    expect(
      AdminTopicCommunityMutationResponseSchema.parse(response.json()),
    ).toMatchObject({
      action: { action: "create", admin_id: ids.admin },
      community: { id: ids.community, kind: "topic", version: 1 },
    });
    expect(verify).toHaveBeenCalledExactlyOnceWith(token);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      adminId: ids.admin,
      permission: "community:manage",
    });
    expect(create.mock.calls[0]?.[1]).toEqual({
      descriptionMarkdown: "Agent semiconductor research and discussion.",
      idempotencyKey: "create-semiconductors",
      name: "Semiconductors",
      slug: "semiconductors",
    });
  });

  it("requires an exact If-Match version and returns 200 for a replay", async () => {
    const { app, update } = createApp({
      updateResult: mutation("update", true),
    });
    const response = await app.inject({
      headers: {
        ...authorization,
        "idempotency-key": "update-semiconductors",
        "if-match": '"1"',
      },
      method: "PATCH",
      payload: { name: "Semiconductor Research" },
      url: `/v1/admin/topic-communities/${ids.community}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect(update.mock.calls[0]?.[1]).toEqual({
      communityId: ids.community,
      expectedVersion: 1,
      idempotencyKey: "update-semiconductors",
      name: "Semiconductor Research",
    });
  });

  it.each([
    {
      headers: { ...authorization, "idempotency-key": "create" },
      method: "POST",
      payload: { name: "Unknown field", slug: "unknown", extra: true },
      url: "/v1/admin/topic-communities",
    },
    {
      headers: { ...authorization, "idempotency-key": "update" },
      method: "PATCH",
      payload: { name: "Missing version" },
      url: `/v1/admin/topic-communities/${ids.community}`,
    },
    {
      headers: {
        ...authorization,
        "idempotency-key": "update",
        "if-match": '"1"',
      },
      method: "PATCH",
      payload: { name: "Unexpected query" },
      url: `/v1/admin/topic-communities/${ids.community}?force=true`,
    },
  ])("rejects non-canonical mutation transport", async (request) => {
    const { app, create, update } = createApp();
    const response = await app.inject({
      headers: request.headers,
      method: request.method as "PATCH" | "POST",
      payload: request.payload,
      url: request.url,
    });
    expect(response.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("exposes current version on optimistic-concurrency conflicts", async () => {
    const { app } = createApp({
      createError: new TopicCommunityManagementError("COMMUNITY_VERSION_CONFLICT", {
        currentVersion: 4,
      }),
    });
    const response = await app.inject({
      headers: { ...authorization, "idempotency-key": "conflict" },
      method: "POST",
      payload: { name: "Conflict", slug: "conflict" },
      url: "/v1/admin/topic-communities",
    });
    expect(response.statusCode).toBe(409);
    expect(V1ErrorResponseSchema.parse(response.json()).error).toMatchObject({
      code: "COMMUNITY_VERSION_CONFLICT",
      details: { current_version: 4 },
    });
  });
});
