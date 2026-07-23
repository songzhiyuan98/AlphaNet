import {
  PublicHumanProfileResponseSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import type { PublicHumanProfile } from "@alphanet/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRequestRateLimiter } from "./agent-request.js";
import { registerPublicPeopleRoutes } from "./public-people-routes.js";

const profile: PublicHumanProfile = {
  actorId: "10000000-0000-4000-8000-000000000001",
  bio: "Cross-validates market research.",
  createdAt: new Date("2026-07-20T12:00:00.000Z"),
  displayName: "Alpha Researcher",
  followersCount: 12,
  followingCount: 4,
  handle: "alpha-researcher",
  postsCount: 7,
  repliesCount: 15,
  updatedAt: new Date("2026-07-21T12:00:00.000Z"),
};

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function createApp(options?: {
  result?: PublicHumanProfile | null;
  rateLimiter?: AgentRequestRateLimiter;
}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const getPublicHumanProfileByHandle = vi.fn(() =>
    Promise.resolve(options?.result === undefined ? profile : options.result),
  );
  registerPublicPeopleRoutes(app, {
    ...(options?.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    resolveClientIp: () => "203.0.113.20",
    service: { getPublicHumanProfileByHandle },
  });
  return { app, getPublicHumanProfileByHandle };
}

describe("public Human profile route", () => {
  it("returns an active Human profile and aggregate social counts", async () => {
    const { app, getPublicHumanProfileByHandle } = createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/public/people/alpha-researcher",
    });

    expect(response.statusCode).toBe(200);
    const parsed = PublicHumanProfileResponseSchema.parse(response.json());
    expect(parsed).toMatchObject({
      profile: {
        actor_id: profile.actorId,
        bio: profile.bio,
        created_at: profile.createdAt.toISOString(),
        display_name: profile.displayName,
        handle: profile.handle,
        kind: "human",
        status: "active",
        updated_at: profile.updatedAt.toISOString(),
      },
      schema_version: "1",
      stats: {
        followers_count: 12,
        following_count: 4,
        posts_count: 7,
        replies_count: 15,
      },
    });
    expect(typeof parsed.request_id).toBe("string");
    expect(getPublicHumanProfileByHandle).toHaveBeenCalledWith("alpha-researcher");
  });

  it("returns not found without exposing private identity data", async () => {
    const { app } = createApp({ result: null });
    const response = await app.inject({
      method: "GET",
      url: "/v1/public/people/missing-person",
    });

    expect(response.statusCode).toBe(404);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "HUMAN_PROFILE_NOT_FOUND",
    );
  });

  it("rejects invalid handles before querying the service", async () => {
    const { app, getPublicHumanProfileByHandle } = createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/public/people/INVALID_HANDLE",
    });

    expect(response.statusCode).toBe(422);
    expect(getPublicHumanProfileByHandle).not.toHaveBeenCalled();
  });

  it("applies a dedicated anonymous IP budget", async () => {
    const consume = vi.fn<AgentRequestRateLimiter["consume"]>(() =>
      Promise.resolve({ allowed: false, retryAfter: 9 }),
    );
    const { app, getPublicHumanProfileByHandle } = createApp({
      rateLimiter: { consume },
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/public/people/alpha-researcher",
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("9");
    expect(consume).toHaveBeenCalledWith("ip:203.0.113.20:public-person", {
      max: 120,
      window: 60,
    });
    expect(getPublicHumanProfileByHandle).not.toHaveBeenCalled();
  });
});
