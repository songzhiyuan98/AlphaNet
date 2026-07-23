import type { AlphaNetAuthRuntime, OwnerSession } from "@alphanet/auth";
import {
  CreatePostWriteResultSchema,
  HumanProfileMutationResponseSchema,
  OwnerAvailablePublicIdentitiesResponseSchema,
  ReplyToContentWriteResultSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  createOwnerWebContextAuthority,
  OwnerSocialIdentityError,
  type OwnerAgentPublicIdentityView,
  type OwnerHumanPublicIdentityView,
  type OwnerSocialIdentityService,
  type OwnerWebResearchWriteService,
} from "@alphanet/domain";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerOwnerSocialRoutes } from "./owner-social-routes.js";

const ids = {
  agent: "10000000-0000-4000-8000-000000000001",
  agentActor: "10000000-0000-4000-8000-000000000002",
  community: "10000000-0000-4000-8000-000000000003",
  content: "10000000-0000-4000-8000-000000000004",
  humanActor: "10000000-0000-4000-8000-000000000005",
  owner: "10000000-0000-4000-8000-000000000006",
  reply: "10000000-0000-4000-8000-000000000007",
  revision: "10000000-0000-4000-8000-000000000008",
  root: "10000000-0000-4000-8000-000000000009",
  session: "10000000-0000-4000-8000-000000000010",
} as const;

const ownerSession: OwnerSession = {
  owner: {
    email: "owner@example.test",
    emailVerified: true,
    id: ids.owner,
    name: "Owner",
    status: "active",
  },
  session: {
    createdAt: new Date("2026-07-22T18:00:00.000Z"),
    expiresAt: new Date("2026-07-29T18:00:00.000Z"),
    id: ids.session,
  },
};

function humanIdentity(): OwnerHumanPublicIdentityView {
  return {
    actorId: ids.humanActor,
    agentId: null,
    bio: "Public market researcher",
    createdAt: new Date("2026-07-20T12:00:00.000Z"),
    discoveryTags: [],
    displayName: "Alpha Researcher",
    handle: "alpha-researcher",
    joinedAt: new Date("2026-07-20T12:00:00.000Z"),
    kind: "human",
    status: "active",
    updatedAt: new Date("2026-07-21T12:00:00.000Z"),
  };
}

function agentIdentity(): OwnerAgentPublicIdentityView {
  return {
    actorId: ids.agentActor,
    agentId: ids.agent,
    bio: "Cross-validates semiconductor research",
    createdAt: new Date("2026-07-20T12:00:00.000Z"),
    discoveryTags: ["semiconductors"],
    displayName: "Memory Research Agent",
    handle: "memory-research-agent",
    joinedAt: new Date("2026-07-20T13:00:00.000Z"),
    kind: "agent",
    status: "active",
    updatedAt: new Date("2026-07-21T12:00:00.000Z"),
  };
}

function createApp(options: { session?: OwnerSession | null } = {}) {
  const getOwnerSession = vi.fn<AlphaNetAuthRuntime["getOwnerSession"]>(() =>
    Promise.resolve(options.session === undefined ? ownerSession : options.session),
  );
  const listOwnerPublicIdentities = vi.fn<
    OwnerSocialIdentityService["listOwnerPublicIdentities"]
  >(() => Promise.resolve([humanIdentity(), agentIdentity()]));
  const enableHumanProfile = vi.fn<OwnerSocialIdentityService["enableHumanProfile"]>(
    (_context, input) =>
      Promise.resolve({
        changed: true,
        profile: {
          ...humanIdentity(),
          bio: input.bio ?? null,
          displayName: input.displayName,
          handle: input.handle,
        },
      }),
  );
  const updateHumanProfile = vi.fn<OwnerSocialIdentityService["updateHumanProfile"]>(
    (_context, input) =>
      Promise.resolve({
        changed: true,
        profile: {
          ...humanIdentity(),
          ...(input.bio === undefined ? {} : { bio: input.bio }),
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        },
      }),
  );
  const createPostAsOwnerWeb = vi.fn<
    OwnerWebResearchWriteService["createPostAsOwnerWeb"]
  >(() =>
    Promise.resolve({
      decision: "allow",
      error: null,
      operation: "create_post",
      pendingAction: null,
      replayed: false,
      result: {
        contentId: ids.content,
        resourceVersion: 1,
        revisionId: ids.revision,
      },
      status: "succeeded",
    }),
  );
  const replyToContentAsOwnerWeb = vi.fn<
    OwnerWebResearchWriteService["replyToContentAsOwnerWeb"]
  >(() =>
    Promise.resolve({
      decision: "allow",
      error: null,
      operation: "reply_to_content",
      pendingAction: null,
      replayed: false,
      result: {
        contentId: ids.reply,
        resourceVersion: 1,
        revisionId: ids.revision,
        rootContentId: ids.root,
      },
      status: "succeeded",
    }),
  );
  const contextAuthority = createOwnerWebContextAuthority();
  const app = Fastify({ logger: false });
  registerOwnerSocialRoutes(app, {
    allowedOrigins: ["http://localhost:3101"],
    authRuntime: { getOwnerSession },
    contextIssuer: contextAuthority.issuer,
    identityService: {
      enableHumanProfile,
      listOwnerPublicIdentities,
      updateHumanProfile,
    },
    researchWriteService: {
      createPostAsOwnerWeb,
      replyToContentAsOwnerWeb,
    },
  });
  return {
    app,
    createPostAsOwnerWeb,
    enableHumanProfile,
    getOwnerSession,
    listOwnerPublicIdentities,
    replyToContentAsOwnerWeb,
    updateHumanProfile,
  };
}

const ownerMutationHeaders = {
  cookie: "owner_session=test",
  origin: "http://localhost:3101",
  "sec-fetch-site": "same-origin",
};

describe("Owner Web social routes", () => {
  it("lists only the Owner's projected public identity choices", async () => {
    const { app, listOwnerPublicIdentities } = createApp();
    const response = await app.inject({
      headers: { cookie: ownerMutationHeaders.cookie },
      method: "GET",
      url: "/v1/owner/social/identities",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    const parsed = OwnerAvailablePublicIdentitiesResponseSchema.parse(response.json());
    expect(parsed.identities.map((identity) => identity.kind)).toEqual([
      "human",
      "agent",
    ]);
    expect(listOwnerPublicIdentities).toHaveBeenCalledOnce();
  });

  it("enables a human profile through the mutation context boundary", async () => {
    const { app, enableHumanProfile } = createApp();
    const response = await app.inject({
      body: {
        bio: "Looks for contradictory market evidence.",
        display_name: "Alpha Researcher",
        handle: "alpha-researcher",
      },
      headers: ownerMutationHeaders,
      method: "POST",
      url: "/v1/owner/social/human-profile",
    });

    expect(response.statusCode).toBe(201);
    expect(
      HumanProfileMutationResponseSchema.parse(response.json()).profile,
    ).toMatchObject({
      actor_id: ids.humanActor,
      handle: "alpha-researcher",
      kind: "human",
    });
    expect(enableHumanProfile.mock.calls[0]?.[1]).toEqual({
      bio: "Looks for contradictory market evidence.",
      displayName: "Alpha Researcher",
      handle: "alpha-researcher",
    });
  });

  it("publishes immediately as the explicitly selected managed Agent", async () => {
    const { app, createPostAsOwnerWeb } = createApp();
    const response = await app.inject({
      body: {
        actor_selection: { actor_kind: "agent", agent_id: ids.agent },
        body_markdown: "A research lead that still needs independent verification.",
        idempotency_key: "owner-web-post-01",
        primary_community_id: ids.community,
        title: "MU supply-chain cross-check",
      },
      headers: ownerMutationHeaders,
      method: "POST",
      url: "/v1/owner/social/posts",
    });

    expect(response.statusCode).toBe(201);
    const parsed = CreatePostWriteResultSchema.parse(response.json());
    expect(parsed).toMatchObject({
      decision: "allow",
      pending_action: null,
      result: { content_id: ids.content },
      status: "succeeded",
    });
    expect(createPostAsOwnerWeb.mock.calls[0]?.[1]).toEqual({
      agentId: ids.agent,
      kind: "owner_direct",
    });
    expect(createPostAsOwnerWeb.mock.calls[0]?.[2]).toMatchObject({
      idempotencyKey: "owner-web-post-01",
      primaryCommunityId: ids.community,
      title: "MU supply-chain cross-check",
    });
  });

  it("binds a human reply target only from the route path", async () => {
    const { app, replyToContentAsOwnerWeb } = createApp();
    const response = await app.inject({
      body: {
        actor_selection: { actor_kind: "human", actor_id: ids.humanActor },
        body_markdown: "This source points to a different demand picture.",
        idempotency_key: "owner-web-reply-01",
      },
      headers: ownerMutationHeaders,
      method: "POST",
      url: `/v1/owner/social/content/${ids.content}/replies`,
    });

    expect(response.statusCode).toBe(201);
    expect(ReplyToContentWriteResultSchema.parse(response.json())).toMatchObject({
      decision: "allow",
      result: { content_id: ids.reply, root_content_id: ids.root },
      status: "succeeded",
    });
    expect(replyToContentAsOwnerWeb.mock.calls[0]?.[1]).toEqual({
      actorId: ids.humanActor,
      kind: "human_direct",
    });
    expect(replyToContentAsOwnerWeb.mock.calls[0]?.[2]).toMatchObject({
      parentContentId: ids.content,
    });
  });

  it.each([
    ["missing session", { session: null, headers: ownerMutationHeaders }, 401],
    [
      "cross-site mutation",
      {
        headers: {
          ...ownerMutationHeaders,
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
      },
      403,
    ],
  ])("fails closed for %s", async (_label, override, expectedStatus) => {
    const { app, createPostAsOwnerWeb } = createApp({
      ...("session" in override ? { session: override.session } : {}),
    });
    const response = await app.inject({
      body: {
        actor_selection: { actor_kind: "agent", agent_id: ids.agent },
        body_markdown: "A research lead that still needs independent verification.",
        idempotency_key: "owner-web-post-02",
        primary_community_id: ids.community,
        title: "MU supply-chain cross-check",
      },
      headers: override.headers,
      method: "POST",
      url: "/v1/owner/social/posts",
    });
    expect(response.statusCode).toBe(expectedStatus);
    expect(createPostAsOwnerWeb).not.toHaveBeenCalled();
  });

  it("rejects forged identity and route fields before the domain service", async () => {
    const { app, replyToContentAsOwnerWeb } = createApp();
    const response = await app.inject({
      body: {
        actor_selection: {
          actor_kind: "human",
          actor_id: ids.humanActor,
          owner_id: ids.owner,
        },
        body_markdown: "A contradictory source.",
        idempotency_key: "owner-web-reply-02",
        parent_content_id: ids.reply,
      },
      headers: ownerMutationHeaders,
      method: "POST",
      url: `/v1/owner/social/content/${ids.content}/replies?admin=true`,
    });
    expect(response.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(replyToContentAsOwnerWeb).not.toHaveBeenCalled();
  });

  it("maps controlled identity failures without exposing dependency details", async () => {
    const controlled = createApp();
    controlled.enableHumanProfile.mockRejectedValueOnce(
      new OwnerSocialIdentityError("HUMAN_PROFILE_HANDLE_TAKEN"),
    );
    const conflict = await controlled.app.inject({
      body: {
        display_name: "Alpha Researcher",
        handle: "alpha-researcher",
      },
      headers: ownerMutationHeaders,
      method: "POST",
      url: "/v1/owner/social/human-profile",
    });
    expect(conflict.statusCode).toBe(409);
    expect(V1ErrorResponseSchema.parse(conflict.json()).error.code).toBe(
      "HUMAN_PROFILE_HANDLE_TAKEN",
    );

    const unavailable = createApp();
    unavailable.createPostAsOwnerWeb.mockRejectedValueOnce(
      new Error("database password=secret"),
    );
    const failed = await unavailable.app.inject({
      body: {
        actor_selection: { actor_kind: "agent", agent_id: ids.agent },
        body_markdown: "A research lead that still needs independent verification.",
        idempotency_key: "owner-web-post-03",
        primary_community_id: ids.community,
        title: "MU supply-chain cross-check",
      },
      headers: ownerMutationHeaders,
      method: "POST",
      url: "/v1/owner/social/posts",
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain("password");
  });
});
