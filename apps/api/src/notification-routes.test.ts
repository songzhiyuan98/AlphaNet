import type { AlphaNetAuthRuntime, OwnerSession } from "@alphanet/auth";
import {
  ListNotificationsResponseSchema,
  MarkAllNotificationsReadResponseSchema,
  MarkNotificationReadResponseSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import type {
  AgentConnectionService,
  AgentCredentialContext,
  NotificationListPage,
  NotificationProjection,
  NotificationService,
} from "@alphanet/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  registerAgentNotificationRoutes,
  registerOwnerNotificationRoutes,
} from "./notification-routes.js";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  agent: "20000000-0000-4000-8000-000000000001",
  community: "30000000-0000-4000-8000-000000000001",
  content: "40000000-0000-4000-8000-000000000001",
  credential: "50000000-0000-4000-8000-000000000001",
  notification: "60000000-0000-4000-8000-000000000001",
  owner: "70000000-0000-4000-8000-000000000001",
  policy: "80000000-0000-4000-8000-000000000001",
  session: "90000000-0000-4000-8000-000000000001",
  triggerActor: "a0000000-0000-4000-8000-000000000001",
  triggerAgent: "b0000000-0000-4000-8000-000000000001",
} as const;
const apiKey = "aln_v1_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const allowedOrigin = "https://app.alphanet.test";
const now = new Date("2026-07-21T20:00:00.000Z");
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  vi.restoreAllMocks();
});

function agentContext(
  scopes: AgentCredentialContext["credential"]["scopes"] = ["notifications:read"],
): AgentCredentialContext {
  return {
    agent: {
      id: ids.agent,
      actorId: ids.actor,
      ownerId: ids.owner,
      handle: "alpha-research",
      displayName: "Alpha Research",
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
        rules: { operations: {} },
      },
    },
    credential: {
      id: ids.credential,
      ownerId: ids.owner,
      agentId: ids.agent,
      name: "Notification reader",
      type: "static_api_key",
      prefix: "aln_v1_abcdefghijkl",
      scopes,
      audience: "urn:alphanet:api:v1",
      policyCeiling: "assisted",
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

function notification(readAt: Date | null = null): NotificationProjection {
  return {
    communityIds: [ids.community],
    context: {
      symbols: ["MU"],
      community_ids: [ids.community],
      matched_follow: {
        target_type: "symbol",
        target_id: "MU",
        notification_level: "new_posts",
      },
    },
    createdAt: new Date("2026-07-21T19:59:01.000Z"),
    dedupeKey: `content.published:event:${ids.actor}`,
    id: ids.notification,
    object: { id: ids.content, type: "content" },
    occurredAt: new Date("2026-07-21T19:59:00.000Z"),
    readAt,
    recipientActorId: ids.actor,
    schemaVersion: "notification-v1",
    stableTarget: {
      resourceId: ids.content,
      resourceType: "content",
      webPath: `/content/${ids.content}`,
    },
    summary: "A followed target has a new post.",
    symbols: ["MU"],
    triggerActor: {
      actorId: ids.triggerActor,
      agentId: ids.triggerAgent,
      handle: "beta-research",
      kind: "agent",
    },
    type: "content.published",
    updatedAt: new Date("2026-07-21T19:59:01.000Z"),
    version: 1,
  };
}

function historyPage(item = notification()): NotificationListPage {
  return {
    filters: {
      communityIds: [ids.community],
      createdAfter: null,
      createdBefore: null,
      followingOnly: true,
      symbols: ["MU"],
      types: ["content.published"],
      unreadOnly: true,
    },
    items: [item],
    mode: "history",
    ordering: {
      asOf: now,
      orderingVersion: "notifications-created-at-v1",
      snapshotId: "nts_history_1",
    },
    page: { hasMore: false, limit: 25, nextCursor: null },
    poll: { hasMore: false, nextCursor: "npc_poll_1" },
  };
}

function notificationService(): NotificationService & {
  listAgentNotifications: Mock<NotificationService["listAgentNotifications"]>;
  listOwnerAgentNotifications: Mock<NotificationService["listOwnerAgentNotifications"]>;
  markAllOwnerAgentNotificationsRead: Mock<
    NotificationService["markAllOwnerAgentNotificationsRead"]
  >;
  markOwnerAgentNotificationRead: Mock<
    NotificationService["markOwnerAgentNotificationRead"]
  >;
} {
  return {
    checkReady: vi.fn(() => Promise.resolve()),
    listAgentNotifications: vi.fn<NotificationService["listAgentNotifications"]>(() =>
      Promise.resolve(historyPage()),
    ),
    listOwnerAgentNotifications: vi.fn<
      NotificationService["listOwnerAgentNotifications"]
    >(() => Promise.resolve(historyPage())),
    markOwnerAgentNotificationRead: vi.fn<
      NotificationService["markOwnerAgentNotificationRead"]
    >(() =>
      Promise.resolve({
        changed: true,
        notification: notification(new Date("2026-07-21T20:01:00.000Z")),
        unreadCount: 0,
      }),
    ),
    markAllOwnerAgentNotificationsRead: vi.fn<
      NotificationService["markAllOwnerAgentNotificationsRead"]
    >(() => Promise.resolve({ markedCount: 3, readAt: now, unreadCount: 0 })),
  };
}

function ownerSession(): OwnerSession {
  return {
    owner: {
      email: "owner@alphanet.test",
      emailVerified: true,
      id: ids.owner,
      name: "Research Owner",
      status: "active",
    },
    session: {
      createdAt: new Date("2026-07-21T19:00:00.000Z"),
      expiresAt: new Date("2026-07-22T19:00:00.000Z"),
      id: ids.session,
    },
  };
}

describe("Notification routes", () => {
  it("lists the authenticated Agent Actor's filtered history without marking read", async () => {
    const app = Fastify({ logger: false });
    const service = notificationService();
    const authenticateStaticApiKey = vi.fn<
      AgentConnectionService["authenticateStaticApiKey"]
    >(() => Promise.resolve(agentContext()));
    registerAgentNotificationRoutes(app, {
      agentConnectionService: { authenticateStaticApiKey },
      service,
    });
    apps.push(app);

    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: `/v1/notifications?types=content.published&unread_only=true&symbols=MU&community_ids=${ids.community}&following_only=true&limit=25`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(ListNotificationsResponseSchema.parse(response.json())).toMatchObject({
      mode: "history",
      items: [{ id: ids.notification, read_at: null }],
      poll: { next_cursor: "npc_poll_1", has_more: false },
    });
    const listCall = service.listAgentNotifications.mock.calls[0];
    expect(listCall?.[0].agent.actorId).toBe(ids.actor);
    expect(listCall?.[1]).toEqual({
      communityIds: [ids.community],
      followingOnly: true,
      limit: 25,
      symbols: ["MU"],
      types: ["content.published"],
      unreadOnly: true,
    });
    expect(service.markOwnerAgentNotificationRead).not.toHaveBeenCalled();
  });

  it("requires the dedicated notifications:read scope", async () => {
    const app = Fastify({ logger: false });
    const service = notificationService();
    registerAgentNotificationRoutes(app, {
      agentConnectionService: {
        authenticateStaticApiKey: vi.fn(() =>
          Promise.resolve(agentContext(["research:read"])),
        ),
      },
      service,
    });
    apps.push(app);

    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/notifications",
    });

    expect(response.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "SCOPE_REQUIRED",
    );
    expect(service.listAgentNotifications).not.toHaveBeenCalled();
  });

  it("keeps Owner list and read state isolated to an explicitly selected Agent", async () => {
    const app = Fastify({ logger: false });
    const service = notificationService();
    const getOwnerSession = vi.fn<AlphaNetAuthRuntime["getOwnerSession"]>(() =>
      Promise.resolve(ownerSession()),
    );
    registerOwnerNotificationRoutes(app, {
      allowedOrigins: [allowedOrigin],
      authRuntime: { getOwnerSession },
      service,
    });
    apps.push(app);

    const list = await app.inject({
      method: "GET",
      url: `/v1/owner/agents/${ids.agent}/notifications?types=content.published&unread_only=true&symbols=MU&community_ids=${ids.community}&following_only=true`,
    });
    expect(list.statusCode).toBe(200);
    expect(ListNotificationsResponseSchema.parse(list.json()).items).toHaveLength(1);
    expect(service.listOwnerAgentNotifications).toHaveBeenCalledWith(
      ids.owner,
      ids.agent,
      expect.objectContaining({ unreadOnly: true }),
    );

    const markOne = await app.inject({
      headers: {
        origin: allowedOrigin,
        "sec-fetch-site": "same-origin",
      },
      method: "PUT",
      payload: {},
      url: `/v1/owner/agents/${ids.agent}/notifications/${ids.notification}/read`,
    });
    expect(markOne.statusCode).toBe(200);
    expect(MarkNotificationReadResponseSchema.parse(markOne.json())).toMatchObject({
      changed: true,
      unread_count: 0,
      notification: { id: ids.notification },
    });
    expect(service.markOwnerAgentNotificationRead).toHaveBeenCalledWith(
      ids.owner,
      ids.agent,
      ids.notification,
    );

    const markAll = await app.inject({
      headers: {
        origin: allowedOrigin,
        "sec-fetch-site": "same-origin",
      },
      method: "POST",
      payload: {},
      url: `/v1/owner/agents/${ids.agent}/notifications/read-all`,
    });
    expect(markAll.statusCode).toBe(200);
    expect(MarkAllNotificationsReadResponseSchema.parse(markAll.json())).toMatchObject({
      marked_count: 3,
      unread_count: 0,
    });
    expect(service.markAllOwnerAgentNotificationsRead).toHaveBeenCalledWith(
      ids.owner,
      ids.agent,
    );
  });

  it("rejects cross-mode cursors before the service", async () => {
    const app = Fastify({ logger: false });
    const service = notificationService();
    registerAgentNotificationRoutes(app, {
      agentConnectionService: {
        authenticateStaticApiKey: vi.fn(() => Promise.resolve(agentContext())),
      },
      service,
    });
    apps.push(app);

    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/notifications?cursor=nhc_history&poll_cursor=npc_poll",
    });

    expect(response.statusCode).toBe(422);
    expect(service.listAgentNotifications).not.toHaveBeenCalled();
  });
});
