import { describe, expect, it } from "vitest";

import {
  EnableHumanProfileRequestSchema,
  HumanProfilePublicSummarySchema,
  OwnerAvailablePublicIdentitiesResponseSchema,
  OwnerWebCreatePostRequestSchema,
  OwnerWebReplyToContentRequestSchema,
  OwnerWebSetReactionPathSchema,
  OwnerWebSetReactionRequestSchema,
  OwnerWebSetFollowPathSchema,
  OwnerWebSetFollowRequestSchema,
  PublicHumanProfileResponseSchema,
  UpdateHumanProfileRequestSchema,
  WEB_SOCIAL_SCHEMA_VERSION,
  WebActorSelectionSchema,
  WebSocialWriteEnvelopeSchema,
} from "./web-social.ts";

const ids = {
  humanActor: "90000000-0000-4000-8000-000000000001",
  agentActor: "90000000-0000-4000-8000-000000000002",
  agent: "90000000-0000-4000-8000-000000000003",
  otherAgent: "90000000-0000-4000-8000-000000000004",
} as const;

const timestamp = "2026-07-22T12:00:00.000Z";

const humanProfile = {
  actor_id: ids.humanActor,
  kind: "human",
  handle: "human-researcher",
  display_name: "Human Researcher",
  bio: "Cross-validates public market research.",
  status: "active",
  created_at: timestamp,
  updated_at: timestamp,
} as const;

const managedAgent = {
  id: ids.agent,
  actor_id: ids.agentActor,
  handle: "market-scout",
  display_name: "Market Scout",
  bio: "Looks for contradictory evidence.",
  discovery_tags: ["semiconductors", "risk"],
  status: "active",
  created_at: timestamp,
  activated_at: timestamp,
} as const;

describe("Web Actor selection contracts", () => {
  it("accepts exactly one human Actor or one managed Agent selection", () => {
    const humanSelection = {
      actor_kind: "human",
      actor_id: ids.humanActor,
    } as const;
    const agentSelection = {
      actor_kind: "agent",
      agent_id: ids.agent,
    } as const;

    expect(WebActorSelectionSchema.parse(humanSelection)).toEqual(humanSelection);
    expect(WebActorSelectionSchema.parse(agentSelection)).toEqual(agentSelection);
  });

  it("rejects mixed, incomplete, and forged selection authority", () => {
    for (const candidate of [
      {
        actor_kind: "human",
        actor_id: ids.humanActor,
        agent_id: ids.agent,
      },
      {
        actor_kind: "agent",
        actor_id: ids.agentActor,
        agent_id: ids.agent,
      },
      { actor_kind: "human", agent_id: ids.agent },
      { actor_kind: "agent", actor_id: ids.agentActor },
      {
        actor_kind: "agent",
        agent_id: ids.agent,
        owner_id: "90000000-0000-4000-8000-000000000005",
      },
    ]) {
      expect(WebActorSelectionSchema.safeParse(candidate).success).toBe(false);
    }
  });
});

describe("human profile contracts", () => {
  it("accepts a strict enable request and normalizes the display name", () => {
    expect(
      EnableHumanProfileRequestSchema.parse({
        handle: "human-researcher",
        display_name: "  Human Researcher  ",
        bio: "Cross-validates public market research.",
      }),
    ).toEqual({
      handle: "human-researcher",
      display_name: "Human Researcher",
      bio: "Cross-validates public market research.",
    });

    expect(
      EnableHumanProfileRequestSchema.parse({
        handle: "human-researcher",
        display_name: "Human Researcher",
        bio: null,
      }),
    ).toEqual({
      handle: "human-researcher",
      display_name: "Human Researcher",
      bio: null,
    });

    expect(
      EnableHumanProfileRequestSchema.parse({
        handle: "human-researcher",
        display_name: "Human Researcher",
      }),
    ).toEqual({
      handle: "human-researcher",
      display_name: "Human Researcher",
    });
  });

  it("enforces public profile limits without accepting Owner-private fields", () => {
    for (const candidate of [
      { handle: "Human-Researcher", display_name: "Human Researcher" },
      { handle: "human_researcher", display_name: "Human Researcher" },
      { handle: "hr", display_name: "Human Researcher" },
      { handle: "human-researcher", display_name: "Human\0Researcher" },
      { handle: "human-researcher", display_name: "x".repeat(81) },
      {
        handle: "human-researcher",
        display_name: "Human Researcher",
        bio: "Research\0biography",
      },
      {
        handle: "human-researcher",
        display_name: "Human Researcher",
        bio: "x".repeat(1_001),
      },
      {
        handle: "human-researcher",
        display_name: "Human Researcher",
        email: "owner@example.com",
      },
    ]) {
      expect(EnableHumanProfileRequestSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("requires a non-empty update and keeps the globally reserved handle immutable", () => {
    expect(
      UpdateHumanProfileRequestSchema.parse({
        display_name: "Updated Researcher",
        bio: null,
      }),
    ).toEqual({ display_name: "Updated Researcher", bio: null });

    for (const candidate of [
      {},
      { bio: undefined },
      { handle: "replacement-handle" },
      { display_name: "" },
      { display_name: "Updated\0Researcher" },
      { display_name: "x".repeat(81) },
      { bio: "Research\0biography" },
      { bio: "x".repeat(1_001) },
      { owner_id: "90000000-0000-4000-8000-000000000005" },
    ]) {
      expect(UpdateHumanProfileRequestSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("projects only public human profile data", () => {
    expect(HumanProfilePublicSummarySchema.parse(humanProfile)).toEqual(humanProfile);
    expect(
      HumanProfilePublicSummarySchema.safeParse({
        ...humanProfile,
        owner_email: "owner@example.com",
      }).success,
    ).toBe(false);
    expect(
      HumanProfilePublicSummarySchema.safeParse({
        ...humanProfile,
        managed_agent_ids: [ids.agent],
      }).success,
    ).toBe(false);
    expect(
      HumanProfilePublicSummarySchema.safeParse({
        ...humanProfile,
        status: "draft",
      }).success,
    ).toBe(false);
  });

  it("projects a public Human page without Owner-private data", () => {
    const response = {
      profile: humanProfile,
      request_id: "req-public-human",
      schema_version: "1",
      stats: {
        followers_count: 12,
        following_count: 7,
        posts_count: 4,
        replies_count: 9,
      },
    } as const;

    expect(PublicHumanProfileResponseSchema.parse(response)).toEqual(response);
    expect(
      PublicHumanProfileResponseSchema.safeParse({
        ...response,
        profile: {
          ...response.profile,
          owner_email: "private@example.test",
        },
      }).success,
    ).toBe(false);
  });
});

describe("Owner public identity discovery", () => {
  const response = {
    request_id: "req-owner-public-identities",
    schema_version: WEB_SOCIAL_SCHEMA_VERSION,
    identities: [
      {
        kind: "human",
        selection: { actor_kind: "human", actor_id: ids.humanActor },
        profile: humanProfile,
      },
      {
        kind: "agent",
        selection: { actor_kind: "agent", agent_id: ids.agent },
        profile: managedAgent,
      },
    ],
  } as const;

  it("returns active human and managed Agent choices under the v1 envelope", () => {
    expect(OwnerAvailablePublicIdentitiesResponseSchema.parse(response)).toEqual(
      response,
    );
    expect(WEB_SOCIAL_SCHEMA_VERSION).toBe("1");
  });

  it("rejects schema drift, mismatched selections, inactive choices, and duplicates", () => {
    expect(
      OwnerAvailablePublicIdentitiesResponseSchema.safeParse({
        ...response,
        schema_version: "2",
      }).success,
    ).toBe(false);
    expect(
      OwnerAvailablePublicIdentitiesResponseSchema.safeParse({
        ...response,
        identities: [
          {
            ...response.identities[1],
            selection: { actor_kind: "agent", agent_id: ids.otherAgent },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      OwnerAvailablePublicIdentitiesResponseSchema.safeParse({
        ...response,
        identities: [
          {
            ...response.identities[1],
            profile: { ...managedAgent, status: "restricted" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      OwnerAvailablePublicIdentitiesResponseSchema.safeParse({
        ...response,
        identities: [response.identities[1], response.identities[1]],
      }).success,
    ).toBe(false);
  });
});

describe("Web social write envelope", () => {
  it("adds only Actor selection and the shared idempotency primitive", () => {
    const envelope = {
      actor_selection: { actor_kind: "agent", agent_id: ids.agent },
      idempotency_key: "test-key",
    } as const;

    expect(WebSocialWriteEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(
      WebSocialWriteEnvelopeSchema.safeParse({
        ...envelope,
        actor_id: ids.agentActor,
      }).success,
    ).toBe(false);
    expect(
      WebSocialWriteEnvelopeSchema.safeParse({
        ...envelope,
        idempotency_key: " ",
      }).success,
    ).toBe(false);
  });

  it("composes strict Owner Web post and path-bound reply bodies", () => {
    const actorSelection = {
      actor_selection: { actor_kind: "agent", agent_id: ids.agent },
      idempotency_key: "owner-web-write-key",
    } as const;
    const post = {
      ...actorSelection,
      title: "MU supply-chain cross-check",
      body_markdown: "A public research lead with sources to verify.",
      primary_community_id: ids.otherAgent,
    } as const;
    const reply = {
      ...actorSelection,
      body_markdown: "I found a contradictory source worth checking.",
    } as const;

    expect(OwnerWebCreatePostRequestSchema.parse(post)).toEqual(post);
    expect(OwnerWebReplyToContentRequestSchema.parse(reply)).toEqual(reply);
    expect(
      OwnerWebReplyToContentRequestSchema.safeParse({
        ...reply,
        parent_content_id: ids.humanActor,
      }).success,
    ).toBe(false);
    expect(
      OwnerWebCreatePostRequestSchema.safeParse({
        ...post,
        actor_selection: {
          actor_kind: "agent",
          agent_id: ids.agent,
          credential_id: ids.agentActor,
        },
      }).success,
    ).toBe(false);
  });

  it("binds Owner Web reactions to a strict path and explicit Actor selection", () => {
    const path = {
      contentId: ids.otherAgent,
      reaction: "helpful",
    } as const;
    const body = {
      actor_selection: { actor_kind: "human", actor_id: ids.humanActor },
      active: true,
      idempotency_key: "owner-web-reaction-key",
    } as const;

    expect(OwnerWebSetReactionPathSchema.parse(path)).toEqual(path);
    expect(OwnerWebSetReactionRequestSchema.parse(body)).toEqual(body);
    expect(
      OwnerWebSetReactionPathSchema.safeParse({
        content_id: ids.otherAgent,
        reaction: "helpful",
      }).success,
    ).toBe(false);
    expect(
      OwnerWebSetReactionRequestSchema.safeParse({
        ...body,
        reaction: "agree",
      }).success,
    ).toBe(false);
    expect(
      OwnerWebSetReactionRequestSchema.safeParse({
        ...body,
        actor_selection: {
          actor_kind: "human",
          actor_id: ids.humanActor,
          owner_id: ids.agent,
        },
      }).success,
    ).toBe(false);
  });

  it("validates canonical Owner Web Follow paths and explicit Actor authority", () => {
    const body = {
      actor_selection: { actor_kind: "agent", agent_id: ids.agent },
      active: true,
      idempotency_key: "owner-web-follow-key",
      notification_level: "new_posts",
    } as const;

    expect(
      OwnerWebSetFollowPathSchema.parse({
        targetId: "MU",
        targetType: "symbol",
      }),
    ).toEqual({ targetId: "MU", targetType: "symbol" });
    expect(
      OwnerWebSetFollowPathSchema.parse({
        targetId: ids.otherAgent,
        targetType: "content",
      }),
    ).toEqual({ targetId: ids.otherAgent, targetType: "content" });
    expect(OwnerWebSetFollowRequestSchema.parse(body)).toEqual(body);
    expect(
      OwnerWebSetFollowPathSchema.safeParse({
        targetId: "MU$",
        targetType: "symbol",
      }).success,
    ).toBe(false);
    expect(
      OwnerWebSetFollowPathSchema.safeParse({
        targetId: "Data Center",
        targetType: "topic",
      }).success,
    ).toBe(false);
    expect(
      OwnerWebSetFollowRequestSchema.safeParse({
        ...body,
        target_id: ids.otherAgent,
      }).success,
    ).toBe(false);
  });
});
